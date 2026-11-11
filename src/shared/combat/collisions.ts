import type { Collider, EventQueue, RigidBody } from "@dimforge/rapier3d-compat";
import { fellProp } from "../arena/structures";
import { propDef, propMass } from "../catalog/props";
import { STEP } from "../config";
import { add, cross, dot, len, norm, qrot, scale, sub, vec3, type Vec3 } from "../math/vec";
import { blockAt, ownerBot } from "../robot/colliders";
import type { Block, ColliderOwner, HitTarget, Part, Prop } from "../sim/entities";
import type { Simulation } from "../sim/simulation";
import { DamageBatch, inflict } from "./damage";

/*
 * Dégâts de collision. Rapier signale les contacts dont la force dépasse un seuil ; pour chacun,
 * on retrouve la vitesse à laquelle les deux corps se rapprochaient juste avant le pas. Un choc
 * sous SAFE_SPEED ne fait rien (se frôler, se pousser, rouler l'un contre l'autre) ; au-delà, la
 * part de l'impulsion due à l'excès de vitesse devient des dégâts de choc (`impact`) sur les blocs
 * touchés des deux côtés, et éprouve les liaisons des morceaux. Un robot lourd qui percute un
 * robot léger le démolit ; une caisse projetée assez vite se brise ; un avion qui s'écrase perd
 * son nez et ses ailes.
 *
 * Percée : un accessoire ancré (arbre, pan de mur, cactus, lampadaire) est un corps fixe, qui a
 * arrêté net le robot pendant le pas. S'il cède sous le choc, le robot n'y reste pas : il reprend
 * sa vitesse d'avant, moins ce qu'il a fallu pour le briser (l'impulsion qui lui inflige ses points
 * de structure, et une part de sa masse emportée en passant, CARRIED) ; il n'encaisse que les dégâts
 * de ce qu'il a cédé. Un robot lourd et rapide traverse un arbre en ralentissant ; un robot léger ou
 * lent, ou un mur trop solide, l'arrête, comme avant.
 */

/** Vitesse de rapprochement encaissée sans dégâts (m/s). */
const SAFE_SPEED = 3;
/** Dégâts de choc par N·s d'impulsion au-delà de ce qu'encaisse un choc à SAFE_SPEED. */
const DAMAGE_PER_IMPULSE = 1;
/**
 * Force de contact (N) sous laquelle Rapier ne signale pas le contact : premier tri grossier,
 * bien en dessous de ce que produit un choc dangereux, au-dessus du poids d'un robot posé.
 */
export const CONTACT_FORCE_THRESHOLD = 1500;
/** Distance maximale d'un point au centre de masse, pour majorer sa vitesse de rotation (m). */
const REACH = 4;
/**
 * Part de la masse d'un obstacle brisé que le robot emporte en passant (les éclats qu'il pousse
 * devant lui) : un pan de mur (6 t) le ralentit davantage qu'un arbre (800 kg).
 */
const CARRIED = 0.02;
/** En dessous de cette vitesse gardée (m/s), il s'arrête contre ce qu'il vient de briser. */
const BREACH_MIN = 0.5;

/** Mouvement d'un corps juste avant le pas. */
interface Motion {
  linvel: Vec3;
  angvel: Vec3;
  com: Vec3;
}

/** Relève le mouvement des corps qui peuvent subir un choc (morceaux de robots et accessoires), avant le pas. */
export function captureMotions(sim: Simulation): Map<number, Motion> {
  const motions = new Map<number, Motion>();
  const capture = (rb: RigidBody): void => {
    motions.set(rb.handle, { linvel: rb.linvel(), angvel: rb.angvel(), com: rb.worldCom() });
  };
  for (const part of sim.parts) capture(part.rb);
  for (const prop of sim.props) if (!prop.fixed) capture(prop.rb); // un corps fixe est immobile
  return motions;
}

const velocityAt = (m: Motion | undefined, p: Vec3): Vec3 => (m ? add(m.linvel, cross(m.angvel, sub(p, m.com))) : vec3(0, 0, 0));

/** Contacts signalés entre deux corps pendant le pas. */
interface Clash {
  a: RigidBody;
  b: RigidBody;
  pairs: [Collider, Collider][];
  impulse: number;
}

/** Choc mesuré, prêt à infliger : tout ce qu'il faut lire de Rapier l'a été. */
interface Impact {
  owners: [ColliderOwner | undefined, ColliderOwner | undefined];
  points: { p: Vec3; w: number }[];
  total: number;
  normal: Vec3;
  center: Vec3;
  impulse: number;
  damage: number;
  /** Un robot qui brise un accessoire ancré et passe au travers (voir en tête). */
  breach: Breach | null;
}

/** Percée d'un robot à travers un accessoire ancré qu'il brise. */
interface Breach {
  /** Côté du robot dans le choc (0 : `a`, 1 : `b`), son morceau, l'accessoire. */
  side: 0 | 1;
  part: Part;
  prop: Prop;
  /** Vitesse et rotation du morceau après la percée : celles d'avant le choc, moins ce qu'il a cédé. */
  linvel: Vec3;
  angvel: Vec3;
  /** Sens de la course (vers l'obstacle) et vitesse qu'il y garde (m/s). */
  dir: Vec3;
  speed: number;
  /** Impulsion qu'il a vraiment cédée (N·s) et les dégâts qu'elle lui fait. */
  impulse: number;
  damage: number;
}

/**
 * Traite les contacts violents du dernier pas. `before` : mouvements relevés avant le pas. Tous les
 * chocs sont mesurés avant d'en infliger un seul : infliger reconstruit des colliders et en libère,
 * que les chocs suivants ne doivent plus lire.
 */
export function resolveCollisions(sim: Simulation, queue: EventQueue, before: Map<number, Motion>): void {
  const clashes = new Map<string, Clash>();
  queue.drainContactForceEvents((e) => {
    const c1 = sim.world.getCollider(e.collider1());
    const c2 = sim.world.getCollider(e.collider2());
    const a = c1?.parent();
    const b = c2?.parent();
    if (!a || !b) return;
    const key = a.handle < b.handle ? `${a.handle}:${b.handle}` : `${b.handle}:${a.handle}`;
    let clash = clashes.get(key);
    if (!clash) clashes.set(key, (clash = { a, b, pairs: [], impulse: 0 }));
    clash.pairs.push(a === clash.a ? [c1, c2] : [c2, c1]);
    clash.impulse += e.totalForceMagnitude() * STEP;
  });
  const impacts: Impact[] = [];
  for (const clash of clashes.values()) {
    const impact = measure(sim, clash, before);
    if (impact) impacts.push(impact);
  }
  for (const impact of impacts) strikeImpact(sim, impact);
}

/** Mesure un choc : points de contact, normale, vitesse de rapprochement ; null s'il est inoffensif. */
function measure(sim: Simulation, clash: Clash, before: Map<number, Motion>): Impact | null {
  const ma = before.get(clash.a.handle);
  const mb = before.get(clash.b.handle);
  // Majoration de la vitesse relative : trop lente, inutile d'examiner les points de contact
  const bound = (m: Motion | undefined): number => (m ? len(m.linvel) + len(m.angvel) * REACH : 0);
  if (bound(ma) + bound(mb) < SAFE_SPEED) return null;

  // Points de contact, pondérés par l'impulsion de chacun, et normale moyenne (de a vers b)
  const points: { p: Vec3; w: number }[] = [];
  let normal = vec3(0, 0, 0);
  for (const [ca, cb] of clash.pairs) {
    sim.world.contactPair(ca, cb, (manifold, flipped) => {
      const [first] = flipped ? [cb, ca] : [ca, cb];
      const n = manifold.normal();
      const toward = flipped ? scale(vec3(n.x, n.y, n.z), -1) : vec3(n.x, n.y, n.z);
      for (let i = 0; i < manifold.numContacts(); i++) {
        const w = manifold.contactImpulse(i);
        const local = manifold.localContactPoint1(i);
        if (w <= 0 || !local) continue;
        points.push({ p: add(first.translation(), qrot(first.rotation(), local)), w });
        normal = add(normal, scale(toward, w));
      }
    });
  }
  const total = points.reduce((s, x) => s + x.w, 0);
  if (!total || len(normal) < 1e-6) return null;
  const n = norm(normal);
  const center = scale(points.reduce((s, x) => add(s, scale(x.p, x.w)), vec3(0, 0, 0)), 1 / total);
  // Le sens de la normale importe peu : un contact aussi fort ne peut que freiner un rapprochement
  const closing = Math.abs(dot(sub(velocityAt(ma, center), velocityAt(mb, center)), n));
  if (closing <= SAFE_SPEED) return null;
  const owners: Impact["owners"] = [ownerOfBody(sim, clash.a, clash), ownerOfBody(sim, clash.b, clash)];
  const damage = DAMAGE_PER_IMPULSE * clash.impulse * (1 - SAFE_SPEED / closing);
  return { owners, points, total, normal: n, center, impulse: clash.impulse, damage, breach: breachOf(sim, clash, owners, [ma, mb], n, closing, damage) };
}

/**
 * Le choc brise-t-il un accessoire ancré (`damage` : ce qu'un arrêt net lui inflige) ? Alors le
 * robot passe au travers : ce qu'il garde de vitesse, s'il en garde assez. Null sinon (pas un robot
 * contre un accessoire ancré, l'accessoire tient, ou il ne cède qu'en explosant plus tard).
 */
function breachOf(
  sim: Simulation, clash: Clash, owners: Impact["owners"], motions: [Motion | undefined, Motion | undefined], n: Vec3, closing: number, damage: number,
): Breach | null {
  const propSide = owners[0]?.kind === "prop" ? 0 : 1;
  const owner = owners[propSide];
  if (owner?.kind !== "prop") return null;
  const prop = owner.prop;
  const def = propDef(prop.type);
  if (!prop.fixed || !(def.shatters || def.topples) || (def.fuse ?? 0) > 0) return null;
  const resist = def.resist?.impact ?? 1;
  if (damage * resist < prop.hp) return null;
  const side = propSide === 0 ? 1 : 0;
  const part = partOfBody(sim, side === 0 ? clash.a : clash.b);
  const motion = motions[side];
  if (!part || !motion) return null;
  // Sens de la course : de lui vers l'obstacle (la normale va de a vers b)
  const dir = side === 0 ? n : scale(n, -1);
  const along = dot(motion.linvel, dir);
  if (along <= SAFE_SPEED) return null;
  // L'impulsion qui inflige ses points de structure à l'obstacle, puis la masse qu'il emporte
  const efficiency = DAMAGE_PER_IMPULSE * (1 - SAFE_SPEED / closing);
  const mass = part.rb.mass();
  const speed = (mass * along - prop.hp / resist / efficiency) / (mass + CARRIED * propMass(prop.type, prop.half));
  if (speed < BREACH_MIN) return null;
  const impulse = mass * (along - speed);
  return {
    side, part, prop, dir, speed, impulse, damage: efficiency * impulse,
    linvel: sub(motion.linvel, scale(dir, along - speed)), angvel: motion.angvel,
  };
}

/** Le morceau de robot dont c'est le corps (aussi une épave), s'il en est un. */
function partOfBody(sim: Simulation, body: RigidBody): Part | null {
  for (const part of sim.parts) if (part.rb.handle === body.handle) return part;
  return null;
}

/** Inflige un choc mesuré aux deux corps : chaque point de contact reçoit sa part des dégâts. */
function strikeImpact(sim: Simulation, impact: Impact): void {
  const { points, total, normal: n, center, breach } = impact;
  const batch = new DamageBatch();
  batch.cause = "impact";
  // Un robot projeté par une arme (le plateau d'un flipper) qui retombe : sa chute est créditée à celle-ci
  const thrown = impact.owners.map((o) => ownerBot(o)?.thrownBy).find((t) => t && t.until > sim.time);
  if (thrown && !impact.owners.some((o) => ownerBot(o) === thrown.by)) {
    batch.attacker = thrown.by;
    batch.cause = thrown.cause;
  }
  // Un robot qui passe au travers d'un obstacle n'encaisse que ce qu'il a cédé pour le briser
  const felt = (side: 0 | 1): { impulse: number; damage: number } =>
    breach?.side === side ? { impulse: breach.impulse, damage: breach.damage } : { impulse: impact.impulse, damage: impact.damage };
  const sides: [ColliderOwner | undefined, Vec3, number][] = [
    [impact.owners[0], scale(n, -felt(0).impulse), felt(0).damage],
    [impact.owners[1], scale(n, felt(1).impulse), felt(1).damage],
  ];
  for (const [owner, impulse, damage] of sides) {
    // Un choc précédent du même pas a pu détruire ce morceau ou arracher cette roue
    if (!owner || !stillThere(owner)) continue;
    // Chaque point de contact reçoit sa part des dégâts
    const shares = new Map<string, { target: HitTarget; amount: number }>();
    for (const { p, w } of points) {
      const target = targetAt(owner, p, norm(impulse));
      if (!target) continue;
      const key = target.kind === "block" ? `b${target.block.id}` : target.kind === "wheel" ? `w${target.wheel.id}` : `p${target.prop.id}`;
      const entry = shares.get(key) ?? { target, amount: 0 };
      entry.amount += (damage * w) / total;
      shares.set(key, entry);
    }
    for (const { target, amount } of shares.values()) batch.add(target, amount, "impact");
    if (owner.kind === "part") {
      const hit = shares.size ? [...shares.values()][0].target : undefined;
      batch.shock(owner.part, center, impulse, hit?.kind === "block" ? hit.block : null);
    }
  }
  sim.emit({ type: "collision", point: center, strength: impact.damage });
  // Un robot ne réagit (fuite, charge) qu'à un choc avec un autre robot, pas contre un mur ou une caisse
  const robots = impact.owners.filter((o) => ownerBot(o)).length;
  inflict(sim, batch, n, robots === 2 ? center : null);
  if (breach) breakThrough(sim, breach);
}

/**
 * Après le choc : si l'accessoire a cédé (brisé, il disparaît à la fin du pas ; abattu, il tombe),
 * le robot repart avec la vitesse qu'il garde ; les éclats partent devant lui, un arbre tombe dans
 * le sens de sa course et le laisse passer.
 */
function breakThrough(sim: Simulation, breach: Breach): void {
  const { part, prop } = breach;
  const broken = prop.state.kind === "fuse" && prop.state.left <= 0;
  const felled = !prop.fixed;
  // (un choc précédent du même pas a pu détruire ce morceau)
  if ((!broken && !felled) || !sim.props.includes(prop) || !part.bot.parts.has(part)) return;
  part.rb.setLinvel(breach.linvel, true);
  part.rb.setAngvel(breach.angvel, true);
  if (broken) prop.struck = scale(breach.dir, breach.speed * 0.8);
  else fellProp(sim, prop, breach.dir, breach.speed);
}

/** Ce corps existe-t-il encore ? (morceau toujours rattaché à son robot, roue pas arrachée) */
function stillThere(owner: ColliderOwner): boolean {
  if (owner.kind === "part") return owner.part.bot.parts.has(owner.part);
  if (owner.kind === "wheel") return !!owner.wheel.part;
  if (owner.kind === "head") return owner.turret.block.alive;
  if (owner.kind === "blade") return owner.arm.block.alive;
  return true;
}

/** Ce que représente un corps pris dans un choc : on le retrouve par l'un de ses colliders. */
function ownerOfBody(sim: Simulation, body: RigidBody, clash: Clash): ColliderOwner | undefined {
  for (const [ca, cb] of clash.pairs) {
    const c = body === clash.a ? ca : cb;
    const owner = sim.colliders.get(c.handle);
    if (owner) return owner;
  }
  return undefined;
}

/** Ce qui est touché en `p` : le bloc du morceau à cet endroit, la roue, l'accessoire. */
function targetAt(owner: ColliderOwner, p: Vec3, into: Vec3): HitTarget | undefined {
  switch (owner.kind) {
    case "part": {
      const block: Block | undefined = blockAt(owner.part, p, into);
      return block ? { kind: "block", block } : undefined;
    }
    case "head":
      return owner.turret.block.alive ? { kind: "block", block: owner.turret.block } : undefined;
    case "blade":
      return owner.arm.block.alive ? { kind: "block", block: owner.arm.block } : undefined;
    case "wheel":
    case "prop":
      return owner;
    case "debris":
      return undefined;
  }
}
