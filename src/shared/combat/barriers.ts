import type { BarrierSpec } from "../catalog/weapons";
import { groundLevel } from "../arena/layout";
import { add, cross, dot, norm, scale, sub, vec3, type Vec3 } from "../math/vec";
import type { Barrier, Projectile, Team } from "../sim/entities";
import type { Simulation } from "../sim/simulation";

/*
 * Murs d'énergie. Un projecteur de bouclier (arme à `barrier`) lance un projectile qui, au bout de
 * sa course (ou sur ce qu'il touche), se déploie en un rectangle vertical posé au sol, face au
 * tireur. Il arrête les tirs des ennemis de son équipe (leurs projectiles s'y écrasent et lui
 * retirent leurs dégâts) et le souffle de leurs explosions ; ses alliés tirent à travers, et les
 * robots le traversent. Il s'éteint au bout de sa durée, ou se brise à 0 point.
 */

/** Le mur descend un peu sous le sol : rien ne passe dessous. */
const SINK = 0.2;

/** Déploie le mur d'un projecteur en `point`, face à celui qui arrive par `dir`. */
export function deployBarrier(sim: Simulation, p: Projectile, point: Vec3, dir: Vec3, spec: BarrierSpec): void {
  const team = p.shooter?.team;
  if (!team) return;
  const flat = norm(vec3(dir.x, 0, dir.z));
  const normal = Math.hypot(flat.x, flat.z) > 0.5 ? flat : vec3(0, 0, 1);
  const ground = groundLevel(sim.arena, point.x, point.z);
  const barrier: Barrier = {
    id: sim.nextId(),
    team,
    center: vec3(point.x, ground - SINK + spec.height / 2, point.z),
    normal,
    width: spec.width,
    height: spec.height,
    hp: spec.hp,
    maxHp: spec.hp,
    until: sim.time + spec.life,
  };
  sim.barriers.push(barrier);
  sim.emit({ type: "barrierAdded", barrier });
}

/** Le mur arrête-t-il ce qui vient de l'équipe `team` (null : la caméra libre, un accessoire) ? Tout sauf son équipe. */
const stops = (b: Barrier, team: Team | null): boolean => b.team !== team;

/**
 * Premier mur que coupe le segment de `from` à `from + dir × length` (`dir` unitaire), parmi ceux
 * qui arrêtent l'équipe `team` : le mur et la distance, ou null.
 */
export function barrierOnPath(sim: Simulation, from: Vec3, dir: Vec3, length: number, team: Team | null): { barrier: Barrier; distance: number } | null {
  let best: { barrier: Barrier; distance: number } | null = null;
  for (const b of sim.barriers) {
    if (!stops(b, team)) continue;
    const t = crossing(b, from, dir);
    if (t !== null && t <= length && (!best || t < best.distance)) best = { barrier: b, distance: t };
  }
  return best;
}

/** Un mur hostile à `team` sépare-t-il `a` de `b` (le souffle d'une explosion ne le traverse pas) ? */
export function barrierBetween(sim: Simulation, a: Vec3, b: Vec3, team: Team | null): boolean {
  if (!sim.barriers.length) return false;
  const d = sub(b, a);
  const length = Math.hypot(d.x, d.y, d.z);
  if (length < 1e-6) return false;
  return barrierOnPath(sim, a, scale(d, 1 / length), length, team) !== null;
}

/** Distance le long de `dir` (unitaire) où le rayon parti de `from` traverse le rectangle du mur, ou null. */
function crossing(b: Barrier, from: Vec3, dir: Vec3): number | null {
  const facing = dot(dir, b.normal);
  if (Math.abs(facing) < 1e-6) return null;
  const t = dot(sub(b.center, from), b.normal) / facing;
  if (t < 0) return null;
  const at = sub(add(from, scale(dir, t)), b.center);
  const side = cross(vec3(0, 1, 0), b.normal);
  if (Math.abs(dot(at, side)) > b.width / 2 || Math.abs(at.y) > b.height / 2) return null;
  return t;
}

/** Un tir retire `damage` points au mur ; à 0, il se brise. */
export function damageBarrier(sim: Simulation, b: Barrier, damage: number, point: Vec3): void {
  b.hp -= damage;
  sim.emit({ type: "barrierHit", barrier: b, point });
  if (b.hp <= 0) removeBarrier(sim, b, true);
}

/** Les murs arrivés au bout de leur durée s'éteignent. */
export function updateBarriers(sim: Simulation): void {
  for (const b of [...sim.barriers]) if (sim.time >= b.until) removeBarrier(sim, b, false);
}

function removeBarrier(sim: Simulation, b: Barrier, broken: boolean): void {
  const i = sim.barriers.indexOf(b);
  if (i < 0) return;
  sim.barriers.splice(i, 1);
  sim.emit({ type: "barrierRemoved", barrier: b, broken });
}
