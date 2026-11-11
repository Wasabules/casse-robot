import type { RigidBody } from "@dimforge/rapier3d-compat";
import { onHit } from "../ai/brain";
import { blockDef } from "../catalog/blocks";
import { propDef, propMass } from "../catalog/props";
import { propDistance, propNearest, toppleProp } from "../arena/structures";
import { explosionDamageAt, type DamageType, type Explosion, type KillCause, type Weapon } from "../catalog/weapons";
import { isArmId } from "../catalog/melee";
import { shieldDamage } from "./shield";
import { wheelDef } from "../catalog/wheels";
import { rand } from "../math/scalar";
import { add, distance, len, norm, qrot, scale, sub, vec3, type Vec3 } from "../math/vec";
import { capturePartMotion, pointVelocity, refreshWheels, splitPart, type PartMotion } from "../robot/destruction";
import { detachBlock, discardWheel, releaseWheel } from "../robot/lifecycle";
import { blockWorldPos, integrity } from "../robot/queries";
import { rebuildDirtyParts } from "../robot/colliders";
import { linkedNeighbors, stressLinks } from "../robot/structure";
import type { Block, Bot, HitTarget, Part, Prop, WeakLink, Wheel } from "../sim/entities";
import type { Simulation } from "../sim/simulation";
import { burnable, groundBelow, ignite, igniteProp, PUDDLE_REACH, spawnGroundFire } from "./burning";
import { spawnDebris } from "./debris";
import { blastProjectiles } from "./interception";
import { barrierBetween } from "./barriers";

/**
 * Part des blocs de départ que le morceau du cockpit doit garder (voir `integrity`) : en dessous,
 * le robot est hors de combat et son cockpit cède. Sans cette règle, un cockpit solide survit
 * seul, un bloc qui roule sans roues ni armes.
 */
export const WRECK_INTEGRITY = 0.25;

/**
 * Dégâts à infliger en une fois, par cible, après résistance. Une cible visée deux fois garde le
 * plus fort des deux. Le lot porte aussi les liaisons que les chocs ont rompues.
 */
export class DamageBatch {
  readonly blocks = new Map<Block, number>();
  readonly wheels = new Map<Wheel, number>();
  readonly props = new Map<Prop, number>();
  readonly cuts = new Map<Part, WeakLink[]>();
  /** Robot à l'origine des dégâts (crédité d'une destruction), s'il y en a un. */
  attacker: Bot | null = null;
  /** Arme ou phénomène qui inflige ces dégâts (annoncé si un robot en meurt). */
  cause: KillCause | null = null;

  /** `amount` dégâts de nature `type` sur `target`, multipliés par sa résistance. */
  add(target: HitTarget | undefined, amount: number, type: DamageType): void {
    if (!target || amount <= 0) return;
    const dealt = amount * resistance(target, type);
    if (target.kind === "block") keepMax(this.blocks, target.block, dealt);
    else if (target.kind === "wheel") keepMax(this.wheels, target.wheel, dealt);
    else if (target.kind === "prop") keepMax(this.props, target.prop, dealt);
  }

  /** Choc (impulsion en N·s, monde) reçu en `point` par un morceau : ses liaisons faibles trop sollicitées rompront. */
  shock(part: Part, point: Vec3, impulse: Vec3, hit: Block | null): void {
    const broken = stressLinks(part, point, impulse, hit);
    if (broken.length) this.cuts.set(part, [...(this.cuts.get(part) ?? []), ...broken]);
  }
}

/** Facteur des dégâts de nature `type` sur une cible (les roues n'ont pas de résistances). */
export function resistance(target: HitTarget, type: DamageType): number {
  if (target.kind === "block") return blockDef(target.block.type).resist?.[type] ?? 1;
  if (target.kind === "prop") return propDef(target.prop.type).resist?.[type] ?? 1;
  return 1;
}

function keepMax<K>(map: Map<K, number>, key: K, amount: number): void {
  if (amount > (map.get(key) ?? 0)) map.set(key, amount);
}

/**
 * Inflige un lot de dégâts. Blocs et roues perdent des points de structure ; les roues à 0
 * sont arrachées ; les blocs à 0 sont détruits (débris) ; les liaisons rompues sont coupées ;
 * puis les morceaux devenus indépendants se séparent. Les accessoires qui cèdent s'allument ou
 * se brisent (voir arena/props.ts). Renvoie les robots touchés.
 */
/** Un moteur sous cette part de ses points de structure, touché, prend feu avec la probabilité `ENGINE_FIRE_CHANCE`. */
export const ENGINE_FIRE_BELOW = 0.25;
export const ENGINE_FIRE_CHANCE = 0.2;

function resolveDamage(sim: Simulation, batch: DamageBatch, dir: Vec3): Set<Bot> {
  const hitBots = new Set<Bot>();

  // Une roue montée à 0 est arrachée ; l'épave d'une roue arrachée à 0 cède (retirée à la fin du lot)
  const brokenWheels: Wheel[] = [];
  for (const [w, amount] of batch.wheels) {
    if (w.part) {
      w.hp -= amount;
      hitBots.add(w.bot);
      if (w.hp <= 0) releaseWheel(sim, w);
    } else if (w.body) {
      w.hp -= amount;
      if (w.hp <= 0) brokenWheels.push(w);
    }
  }

  const doomed = new Set<Block>();
  const flashed = new Set<Block>();
  for (const [b, dealt] of batch.blocks) {
    if (!b.alive) continue;
    const amount = shieldDamage(b, dealt, flashed, sim.time);
    b.hp -= amount;
    hitBots.add(b.bot);
    if (b.hp <= 0) doomed.add(b);
    else sim.emit({ type: "blockDamaged", block: b });
  }

  for (const generator of flashed) sim.emit({ type: "shieldHit", block: generator });

  // Une batterie détruite met le feu à ses voisins
  const kindled = [...doomed].filter((b) => blockDef(b.type).battery).flatMap((b) => linkedNeighbors(b));
  // Un moteur à bout, touché encore, peut prendre feu (pas par le feu ni par un jet de flamme : il
  // brûlerait sans fin, et un jet a sa propre chance d'allumer ce qu'il chauffe, combat/scorch.ts)
  if (batch.cause !== "fire" && batch.cause !== "exhaust") {
    for (const b of batch.blocks.keys()) {
      const def = blockDef(b.type);
      if (def.thruster && b.alive && !doomed.has(b) && b.hp < def.hp * ENGINE_FIRE_BELOW && rand(0, 1) < ENGINE_FIRE_CHANCE) kindled.push(b);
    }
  }

  if (doomed.size || batch.cuts.size) {
    // On relève le mouvement des morceaux avant de toucher à leurs colliders
    const motions = new Map<Part, PartMotion>();
    for (const b of doomed) if (!motions.has(b.part)) motions.set(b.part, capturePartMotion(b.part));
    for (const part of batch.cuts.keys()) if (!motions.has(part)) motions.set(part, capturePartMotion(part));
    for (const b of doomed) {
      const before = motions.get(b.part)!;
      spawnDebris(sim, b, pointVelocity(before, blockWorldPos(b)), dir);
      detachBlock(b);
      b.alive = false;
      b.bot.blocks.delete(b.key);
      // Une réparation pourra le faire repousser (combat/repair.ts)
      if (b.type !== "cockpit") b.bot.lost.set(b.key, b);
      sim.emit({ type: "blockDestroyed", block: b });
      sim.destroyedCount++;
    }
    for (const [part, links] of batch.cuts) {
      for (const link of links) {
        if (!link.inner.alive || !link.outer.alive || part.bot.cuts.has(link.key)) continue;
        part.bot.cuts.add(link.key);
        part.links = null;
        hitBots.add(part.bot);
        sim.emit({ type: "linkBroken", point: add(part.rb.translation(), qrot(part.rb.rotation(), link.joint)) });
      }
    }
    for (const [part, before] of motions) if (part.bot.parts.has(part)) splitPart(sim, part, before);
    for (const bot of hitBots) {
      refreshWheels(sim, bot);
      rebuildDirtyParts(sim, bot); // les colliders suivent tout de suite (un projectile perforant continue)
    }
  }

  for (const b of kindled) if (b.alive) ignite(sim, b);
  for (const bot of hitBots) {
    bot.lastHit = sim.time;
    if (batch.attacker && batch.attacker.team !== bot.team) bot.lastAttacker = batch.attacker;
  }
  // Retour de tir : chaque robot touché par une arme, de tourelle ou de contact (pas le feu, les chocs ni les barils)
  if (batch.cause && isArmId(batch.cause)) {
    const lost = new Map<Bot, number>();
    for (const b of doomed) lost.set(b.bot, (lost.get(b.bot) ?? 0) + 1);
    for (const bot of hitBots) sim.emit({ type: "hit", victim: bot, attacker: batch.attacker, cause: batch.cause, destroyed: lost.get(bot) ?? 0 });
  }
  // Cockpits détruits : ces robots sont hors de combat
  for (const b of doomed) if (b === b.bot.cockpit) sim.emit({ type: "botKilled", bot: b.bot, killer: b.bot.lastAttacker, cause: batch.cause });
  // Un robot dont le cockpit ne tient plus qu'une petite part de la structure est hors de combat
  const wrecked = [...hitBots].filter((bot) => bot.cockpit.alive && integrity(bot) < WRECK_INTEGRITY);
  if (wrecked.length) {
    const finish = new DamageBatch();
    finish.attacker = batch.attacker;
    finish.cause = batch.cause;
    for (const bot of wrecked) finish.blocks.set(bot.cockpit, Infinity);
    for (const bot of resolveDamage(sim, finish, dir)) hitBots.add(bot);
  }
  for (const [prop, amount] of batch.props) damageProp(sim, prop, amount, dir);
  for (const w of brokenWheels) discardWheel(sim, w, true);
  return hitBots;
}

/**
 * Un accessoire perd des points de structure ; à 0, sa mèche s'allume (baril), son gaz fuit
 * (bouteille), il prend feu puis explose (voiture), il bascule (un arbre debout, du côté de `dir`)
 * ou il se brise (caisse, mur). Une bouteille qui fuit et qu'on touche encore saute aussitôt.
 */
function damageProp(sim: Simulation, prop: Prop, amount: number, dir: Vec3): void {
  const def = propDef(prop.type);
  prop.hp -= amount;
  if (prop.hp > 0) return;
  if (def.topples && prop.fixed) {
    toppleProp(sim, prop, dir);
    return;
  }
  if (prop.state.kind === "intact") {
    if (def.vent) {
      const angle = rand(0, Math.PI * 2); // le trou est quelque part sur le flanc
      prop.state = { kind: "venting", left: def.vent.duration, leak: vec3(Math.cos(angle), 0, Math.sin(angle)) };
    } else {
      prop.state = { kind: "fuse", left: def.fuse ?? 0 };
      // Ce qui brûle et a une longue mèche (une voiture) flambe en attendant d'exploser
      if (def.burns && (def.fuse ?? 0) > 0) igniteProp(sim, prop);
    }
  } else if (prop.state.kind === "venting") {
    prop.state = { kind: "fuse", left: 0 };
  }
}

/** Les robots touchés réagissent (s'il y a un tireur), puis on annonce la fin de l'impact. */
function react(sim: Simulation, hitBots: Set<Bot>, shooter: Vec3 | null): void {
  if (shooter) for (const bot of hitBots) onHit(sim, bot, shooter);
  sim.emit({ type: "damage", bots: [...hitBots] });
}

/**
 * Inflige un lot de dégâts préparé ailleurs (collisions, feu) : `dir`, direction du coup pour les
 * débris ; `source`, d'où il vient, pour la réaction de l'IA (null : pas de réaction, comme pour
 * le feu). Renvoie les robots touchés.
 */
export function inflict(sim: Simulation, batch: DamageBatch, dir: Vec3, source: Vec3 | null): Set<Bot> {
  const hitBots = resolveDamage(sim, batch, dir);
  react(sim, hitBots, source);
  return hitBots;
}

/**
 * Impact direct d'un projectile : `amount` dégâts de nature `type` sur `target`, et une impulsion
 * `impulse` (N·s) le long de `dir` au point d'impact, qui éprouve aussi les liaisons du morceau
 * touché. Renvoie les dégâts bruts que la cible a absorbés (avant résistance) et si elle a cédé,
 * pour la perforation.
 */
export function strike(
  sim: Simulation, target: HitTarget | undefined, amount: number, type: DamageType,
  point: Vec3, dir: Vec3, impulse: number, shooter: Vec3, attacker: Bot | null = null, cause: KillCause | null = null,
): { absorbed: number; destroyed: boolean } {
  const before = remainingHp(target);
  const body = bodyOf(target);
  if (body && impulse) body.applyImpulseAtPoint(scale(dir, impulse), point, true);
  if (!target || before <= 0) return { absorbed: 0, destroyed: false };
  const batch = new DamageBatch();
  batch.attacker = attacker;
  batch.cause = cause;
  batch.add(target, amount, type);
  if (impulse && target.kind === "block") batch.shock(target.block.part, point, scale(dir, impulse), target.block);
  inflict(sim, batch, dir, shooter);
  const factor = resistance(target, type);
  return { absorbed: Math.min(amount, before / factor), destroyed: amount * factor >= before };
}

/**
 * Explosion en `point` : dégâts de zone sur les blocs, les roues et les accessoires, décroissant
 * avec la distance, puis souffle qui pousse tout ce qui est proche et éprouve les liaisons des
 * morceaux poussés. Les barils voisins s'allument et sautent à leur tour (réaction en chaîne).
 */
export function explode(
  sim: Simulation, point: Vec3, explosion: Explosion, dir: Vec3, shooter: Vec3, attacker: Bot | null = null, cause: KillCause | null = null,
): void {
  const batch = new DamageBatch();
  batch.attacker = attacker;
  batch.cause = cause;
  // Un mur d'énergie hostile au tireur arrête le souffle (combat/barriers.ts)
  const team = attacker?.team ?? null;
  const reach = (at: Vec3): number => {
    const d = distance(at, point);
    return d < explosion.radius && barrierBetween(sim, point, at, team) ? 0 : explosionDamageAt(explosion, d);
  };
  for (const bot of sim.bots) {
    for (const b of bot.blocks.values()) {
      batch.add({ kind: "block", block: b }, reach(blockWorldPos(b)), "explosive");
    }
    for (const w of bot.wheels) {
      if (w.part || w.body) batch.add({ kind: "wheel", wheel: w }, reach(w.rb.translation()), "explosive");
    }
  }
  for (const prop of sim.props) {
    batch.add({ kind: "prop", prop }, explosionDamageAt(explosion, propDistance(prop, point)), "explosive");
  }
  sim.emit({ type: "explosion", point, radius: explosion.radius, look: explosion.look });
  // Les mines proches sautent au pas suivant, en chaîne (déminage) ; les missiles proches encaissent
  blastProjectiles(sim, point, explosion, attacker);
  const hitBots = resolveDamage(sim, batch, dir);
  // Une explosion incendiaire enflamme une partie des blocs restés entiers dans sa zone, et du bois du décor
  if (explosion.ignite) {
    for (const b of batch.blocks.keys()) if (b.alive && rand(0, 1) < explosion.ignite) ignite(sim, b);
    for (const prop of sim.props) {
      if (prop.burn <= 0 && burnable(prop) && propDistance(prop, point) < explosion.radius && rand(0, 1) < explosion.ignite) igniteProp(sim, prop);
    }
  }
  // Le napalm laisse une flaque de feu au sol, sous l'explosion
  if (explosion.puddle) {
    const ground = groundBelow(sim, point, PUDDLE_REACH);
    if (ground) spawnGroundFire(sim, ground, explosion.puddle, attacker);
  }
  // Le souffle agit sur ce qui reste ; ses chocs peuvent rompre des liaisons
  const shocks = new DamageBatch();
  shocks.attacker = attacker;
  shocks.cause = cause;
  for (const bot of blast(sim, point, dir, explosion, shocks)) hitBots.add(bot);
  for (const bot of resolveDamage(sim, shocks, dir)) hitBots.add(bot);
  react(sim, hitBots, shooter);
}

/**
 * Impact d'une arme sans projectile (débogage, tests) : dégâts directs sur `target`, puis
 * explosion éventuelle. `shooter` : d'où vient le tir (réaction de l'IA).
 */
export function applyDamage(
  sim: Simulation, point: Vec3, dir: Vec3, weapon: Weapon, target: HitTarget | undefined, shooter: Vec3,
): void {
  const p = weapon.projectile;
  strike(sim, target, p.damage, p.damageType, point, dir, p.impulse, shooter);
  if (p.explosion) explode(sim, point, p.explosion, dir, shooter);
}

function remainingHp(target: HitTarget | undefined): number {
  if (!target) return 0;
  if (target.kind === "block") return target.block.alive ? target.block.hp : 0;
  // Une roue montée, ou l'épave d'une roue arrachée (elle cède aussi sous les coups)
  if (target.kind === "wheel") return target.wheel.part || target.wheel.body ? target.wheel.hp : 0;
  return Math.max(0, target.prop.hp);
}

function bodyOf(target: HitTarget | undefined): RigidBody | null {
  if (!target) return null;
  if (target.kind === "block") return target.block.alive ? target.block.part.rb : null;
  // Une roue montée n'a pas de corps : c'est son morceau qui encaisse le choc
  if (target.kind === "wheel") return target.wheel.body ?? target.wheel.part?.rb ?? null;
  return target.prop.rb;
}

/**
 * Souffle : pousse les corps proches du centre. Le choc reçu par chaque morceau (somme des
 * poussées, au point moyen où elles s'appliquent) est ajouté à `shocks`. Renvoie les robots dont
 * un bloc a été poussé.
 */
function blast(sim: Simulation, point: Vec3, dir: Vec3, ex: Explosion, shocks: DamageBatch): Set<Bot> {
  const touched = new Set<Bot>();
  const push = (rb: RigidBody, at: Vec3, falloff: number, mult = 1): Vec3 => {
    const radial = norm(sub(at, point));
    const d = norm(add(add(scale(radial, 0.6), scale(dir, 0.4)), vec3(0, ex.lift, 0)));
    const impulse = scale(d, ex.power * falloff * mult);
    rb.applyImpulseAtPoint(impulse, at, true);
    return impulse;
  };

  for (const bot of sim.bots) {
    for (const part of [...bot.parts]) {
      let total = vec3(0, 0, 0);
      let where = vec3(0, 0, 0);
      let weight = 0;
      for (const b of part.blocks) {
        const p = blockWorldPos(b);
        const dist = distance(p, point);
        if (dist < ex.blastRadius) {
          const f = 1 - dist / ex.blastRadius;
          const impulse = push(part.rb, p, f * f);
          total = add(total, impulse);
          where = add(where, scale(p, len(impulse)));
          weight += len(impulse);
          touched.add(bot);
        }
      }
      if (weight > 0) shocks.shock(part, scale(where, 1 / weight), total, null);
    }
    // Les roues arrachées ; celles qui sont montées suivent leur morceau, déjà poussé
    for (const wh of bot.wheels) {
      if (!wh.body) continue;
      const reach = ex.blastRadius + wheelDef(wh.type).radius;
      const p = wh.body.translation();
      const dist = distance(p, point);
      if (dist < reach) push(wh.body, p, Math.max(0.3, 1 - dist / reach), 2);
    }
  }
  for (const prop of sim.props) {
    if (prop.fixed) continue; // ancré : le souffle ne le pousse pas
    const reach = ex.blastRadius + 0.5;
    const dist = propDistance(prop, point);
    if (dist < reach) push(prop.rb, propNearest(prop, point), 1 - dist / reach, propMass(prop.type, prop.half) / 2);
  }
  for (const d of sim.debris) {
    const p = d.rb.translation();
    const dist = distance(p, point);
    if (dist < ex.blastRadius) push(d.rb, p, (1 - dist / ex.blastRadius) * 0.15);
  }
  return touched;
}
