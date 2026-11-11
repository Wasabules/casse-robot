import { isWeaponId, weaponDef, type MineSpec } from "../catalog/weapons";
import { GRAVITY, STEP } from "../config";
import { add, distance, len, norm, qrot, qrotInv, scale, sub, vec3, type Vec3 } from "../math/vec";
import { blockWorldPos } from "../robot/queries";
import type { Block, Bot, Projectile } from "../sim/entities";
import type { Simulation } from "../sim/simulation";
import { areEnemies, detonate, nearestEnemy, spawnProjectile } from "./projectiles";

/*
 * Mines (voir `MineSpec`, catalog/weapons.ts). Une mine tombe comme un projectile, se pose (voir
 * combat/projectiles.ts), puis c'est ici qu'elle attend : elle s'arme, guette ce qui la déclenche,
 * et éclate, bondit, lance un missile ou se colle à sa cible. Une explosion proche la fait sauter
 * (`blowMines`). Un capteur ne se déclenche jamais : il fait repérer les ennemis proches à son
 * équipe (sim/detection.ts) et signale leur passage d'un bip.
 */

/** Une explosion fait sauter les mines à moins de son rayon plus cette marge (m). */
const BLOW_MARGIN = 0.6;
/** Une ventouse se pose à la surface du bloc qu'elle attrape : au plus à cette distance de son centre (m). */
const STICK_DEPTH = 0.35;
/** Un capteur signale le passage d'un ennemi au plus toutes les PING_PERIOD s. */
const PING_PERIOD = 2.5;
/** Mines télécommandées qu'un joueur fait sauter d'un coup : l'une après l'autre, à cet intervalle (s). */
const CHAIN_DELAY = 0.06;

/**
 * Un pas d'une mine posée, collée, en l'air après un bond, ou atteinte par une explosion. Renvoie
 * faux quand elle a fini (éclatée, missile lancé, capteur détruit).
 */
export function stepMine(sim: Simulation, p: Projectile, mine: MineSpec): boolean {
  if (p.blown) return burst(sim, p);
  if (p.stuck) {
    // Collée : elle suit son bloc ; s'il est détruit, elle éclate là où elle était
    const { block, offset } = p.stuck;
    if (!block.alive) return burst(sim, p);
    const rb = block.part.rb;
    p.pos = add(blockWorldPos(block), qrot(rb.rotation(), offset));
    p.vel = rb.linvel();
  } else if (!p.landed) {
    // Mine bondissante : elle monte, et éclate en haut de sa course
    p.vel = add(p.vel, vec3(0, -GRAVITY * STEP, 0));
    p.pos = add(p.pos, scale(p.vel, STEP));
  }
  if (p.fuse !== null) return sim.time < p.fuse ? true : burst(sim, p);
  if (p.age < mine.armDelay) return true;

  if (mine.sense && sim.time >= p.pingAt && enemyWithin(sim, p, mine.sense)) {
    p.pingAt = sim.time + PING_PERIOD;
    sim.emit({ type: "mine", projectile: p, action: "ping" });
  }
  const target = triggeredBy(sim, p, mine);
  return target ? trigger(sim, p, mine, target) : true;
}

/** Le robot qui déclenche la mine à ce pas, s'il y en a un. */
function triggeredBy(sim: Simulation, p: Projectile, mine: MineSpec): Bot | null {
  switch (mine.trigger) {
    case "ground":
      return nearestEnemy(sim, p, mine.radius, "ground");
    case "air":
      return nearestEnemy(sim, p, mine.radius, "air");
    case "remote":
      // L'IA fait sauter les siennes dès qu'un ennemi est dessus ; le joueur, quand il le décide
      return p.shooter && p.shooter.controller !== "player" ? nearestEnemy(sim, p, mine.radius, "ground") : null;
    case "none":
      return null;
  }
}

/** La mine est déclenchée par `target` : elle éclate, bondit, lance son missile ou se colle. */
function trigger(sim: Simulation, p: Projectile, mine: MineSpec, target: Bot): boolean {
  const action = mine.action;
  if (!action) return burst(sim, p);
  switch (action.kind) {
    case "bounce": {
      const up = Math.sqrt(2 * GRAVITY * action.height);
      p.landed = false;
      p.vel = vec3(0, up, 0);
      p.fuse = sim.time + up / GRAVITY;
      sim.emit({ type: "mine", projectile: p, action: "bounce" });
      return true;
    }
    case "launch": {
      if (!isWeaponId(action.weapon)) return false;
      const from = add(p.pos, vec3(0, 0.5, 0));
      const dir = norm(sub(target.cockpit.part.rb.worldCom(), from));
      spawnProjectile(sim, action.weapon, from, dir, { shooter: p.shooter, homing: target });
      return false;
    }
    case "stick": {
      const block = nearestBlock(target, p.pos);
      if (!block) return burst(sim, p);
      const local = qrotInv(block.part.rb.rotation(), sub(p.pos, blockWorldPos(block)));
      const depth = len(local);
      p.stuck = { block, offset: depth > STICK_DEPTH ? scale(local, STICK_DEPTH / depth) : local };
      p.landed = false;
      p.fuse = sim.time + action.fuse;
      sim.emit({ type: "mine", projectile: p, action: "stick" });
      return true;
    }
  }
}

/** Fin d'une mine : elle éclate (explosion, impulsion, fumée) si elle en porte une ; sinon elle disparaît. */
function burst(sim: Simulation, p: Projectile): boolean {
  const spec = weaponDef(p.weapon).projectile;
  if (spec.explosion || spec.emp || spec.smoke) detonate(sim, p, p.pos, vec3(0, 1, 0));
  return false;
}

/** Bloc vivant du robot le plus proche de ce point. */
function nearestBlock(bot: Bot, point: Vec3): Block | null {
  let best: Block | null = null;
  let bestDistance = Infinity;
  for (const b of bot.blocks.values()) {
    const d = distance(blockWorldPos(b), point);
    if (d < bestDistance) {
      best = b;
      bestDistance = d;
    }
  }
  return best;
}

/** Un ennemi du poseur, au sol ou en vol, à moins de `radius` m de la mine (d'après son cockpit). */
function enemyWithin(sim: Simulation, p: Projectile, radius: number): boolean {
  return sim.bots.some((b) => b.cockpit.alive && areEnemies(p.shooter, b) && distance(b.lastPos, p.pos) < radius);
}

/**
 * Déminage : une explosion en `point` fait sauter, au pas suivant, les mines posées ou collées à
 * moins de son rayon (plus une marge) : elles explosent à leur tour, en chaîne ; un capteur, une
 * mine anti-aérienne, sont détruits.
 */
export function blowMines(sim: Simulation, point: Vec3, radius: number): void {
  for (const p of sim.projectiles) {
    if ((p.landed || p.stuck) && weaponDef(p.weapon).projectile.mine && distance(p.pos, point) < radius + BLOW_MARGIN) p.blown = true;
  }
}

/** La mine a-t-elle été posée par ce robot, ou par le même joueur avant sa réapparition ? */
export function ownedBy(p: Projectile, bot: Bot): boolean {
  return p.shooter === bot || (bot.input !== null && p.shooter?.input === bot.input);
}

/**
 * Le joueur fait sauter ses mines télécommandées armées : l'une après l'autre, à un souffle
 * d'intervalle. Renvoie combien il en a fait sauter.
 */
export function detonateMines(sim: Simulation, bot: Bot): number {
  let count = 0;
  for (const p of sim.projectiles) {
    const mine = weaponDef(p.weapon).projectile.mine;
    if (!mine || mine.trigger !== "remote" || !p.landed || p.fuse !== null || p.age < mine.armDelay || !ownedBy(p, bot)) continue;
    p.fuse = sim.time + count * CHAIN_DELAY;
    count++;
  }
  return count;
}
