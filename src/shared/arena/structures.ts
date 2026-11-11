import RAPIER from "@dimforge/rapier3d-compat";
import { propDef, propHp } from "../catalog/props";
import { clamp } from "../math/scalar";
import { add, cross, len, norm, qrot, qrotInv, scale, sub, vec3, type Vec3 } from "../math/vec";
import { COLLISION_GROUPS } from "../physics/groups";
import type { Prop } from "../sim/entities";
import type { Simulation } from "../sim/simulation";

/*
 * Structures : les accessoires ancrés (murs, toits, arbres, citernes) sont des corps fixes, que
 * rien ne pousse. Un toit dont tous les appuis ont disparu tombe ; un arbre qui cède bascule, puis
 * se brise s'il cède encore (arena/props.ts, combat/damage.ts).
 */

/** Vitesse de rotation d'un arbre qui commence à basculer (rad/s) ; la pesanteur fait le reste. */
const TOPPLE_SPIN = 0.5;
/** Un arbre couché par un robot lancé tombe au plus à cette vitesse de rotation (rad/s). */
const FELL_SPIN_MAX = 2.5;
/** Temps (s) pendant lequel un arbre couché par un robot ne heurte pas les robots : le temps de sa chute. */
const FELLED_PASS = 1.6;

/** Libère un accessoire ancré : son corps devient mobile, et tombe. */
export function releaseProp(sim: Simulation, prop: Prop): void {
  if (!prop.fixed) return;
  prop.fixed = false;
  prop.rb.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
  sim.emit({ type: "propReleased", prop });
}

/**
 * Un arbre qui cède bascule du côté de `dir` (la direction du coup) : libéré, il garde une part
 * de ses points de structure ; s'il cède encore, il se brise.
 */
export function toppleProp(sim: Simulation, prop: Prop, dir: Vec3): void {
  const def = propDef(prop.type);
  releaseProp(sim, prop);
  prop.hp = propHp(prop.type, prop.half) * (def.topples ?? 0);
  const flat = vec3(dir.x, 0, dir.z);
  const toward = len(flat) > 1e-3 ? norm(flat) : vec3(1, 0, 0);
  // Il pivote sur sa base : tourner autour de haut × direction penche la cime vers la direction,
  // et son centre (à mi-hauteur) part dans ce sens
  prop.rb.setAngvel(scale(cross(vec3(0, 1, 0), toward), TOPPLE_SPIN), true);
  prop.rb.setLinvel(scale(toward, TOPPLE_SPIN * prop.half.y), true);
}

/**
 * Un arbre (un lampadaire) qu'un robot vient d'abattre en passant au travers : il tombe dans le sens
 * de la course (`dir`), d'autant plus vite que le robot garde de vitesse (`speed`), et le laisse
 * passer le temps de sa chute (FELLED_PASS s, groupe `felled`) ; ensuite, couché, il redevient un
 * obstacle (`restoreFelled`).
 */
export function fellProp(sim: Simulation, prop: Prop, dir: Vec3, speed: number): void {
  const flat = vec3(dir.x, 0, dir.z);
  const toward = len(flat) > 1e-3 ? norm(flat) : vec3(1, 0, 0);
  const spin = clamp(speed / Math.max(1, prop.half.y), TOPPLE_SPIN, FELL_SPIN_MAX);
  prop.rb.setAngvel(scale(cross(vec3(0, 1, 0), toward), spin), true);
  prop.rb.setLinvel(scale(toward, spin * prop.half.y), true);
  prop.collider.setCollisionGroups(COLLISION_GROUPS.felled);
  prop.yielding = sim.time + FELLED_PASS;
}

/**
 * Un arbre couché qui laissait passer les robots redevient un obstacle, sa chute finie : pas tant
 * qu'un robot est dedans (la physique l'en chasserait d'un coup).
 */
export function restoreFelled(sim: Simulation, prop: Prop, robotInside: (prop: Prop) => boolean): void {
  if (!prop.yielding || sim.time < prop.yielding || robotInside(prop)) return;
  prop.yielding = 0;
  prop.collider.setCollisionGroups(COLLISION_GROUPS.prop);
}

/**
 * Accessoires ancrés qui reposaient sur celui qu'on vient de retirer (son emplacement `spot`) : ceux
 * dont plus aucun appui ne tient tombent.
 */
export function dropUnsupported(sim: Simulation, spot: number): void {
  const standing = new Set(sim.props.map((p) => p.spot));
  for (const prop of sim.props) {
    const rests = sim.arena.props[prop.spot]?.rests;
    if (!prop.fixed || !rests?.includes(spot)) continue;
    if (!rests.some((i) => standing.has(i))) releaseProp(sim, prop);
  }
}

/** Distance (m) d'un point à la surface d'un accessoire (0 dedans) : une explosion contre un grand mur le touche en plein. */
export function propDistance(prop: Prop, point: Vec3): number {
  const q = prop.rb.rotation();
  const local = qrotInv(q, sub(point, prop.rb.translation()));
  const h = prop.half;
  if (propDef(prop.type).shape.kind === "cylinder") {
    const radial = Math.hypot(local.x, local.z);
    const out = Math.max(0, radial - h.x);
    const dy = Math.max(0, Math.abs(local.y) - h.y);
    return Math.hypot(out, dy);
  }
  const nearest = vec3(clamp(local.x, -h.x, h.x), clamp(local.y, -h.y, h.y), clamp(local.z, -h.z, h.z));
  return len(sub(local, nearest));
}

/** Le point de l'accessoire le plus proche de `point`, dans le monde (pour pousser un corps au bon endroit). */
export function propNearest(prop: Prop, point: Vec3): Vec3 {
  const q = prop.rb.rotation();
  const center = prop.rb.translation();
  const local = qrotInv(q, sub(point, center));
  const h = prop.half;
  const nearest = vec3(clamp(local.x, -h.x, h.x), clamp(local.y, -h.y, h.y), clamp(local.z, -h.z, h.z));
  return add(center, qrot(q, nearest));
}
