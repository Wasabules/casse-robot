import type { SmokeSpec } from "../catalog/weapons";
import { clamp } from "../math/scalar";
import { add, dot, len, scale, sub, type Vec3 } from "../math/vec";
import type { SmokeCloud } from "../sim/entities";
import type { Simulation } from "../sim/simulation";

/*
 * Fumigènes. Un nuage grandit en une seconde, tient, puis se dissipe. Il n'arrête pas les
 * projectiles, mais il coupe la vue : une tourelle ne tire pas sur ce qu'elle ne voit pas, et la
 * détection (voir sim/detection.ts) ne voit pas à travers.
 */

/** Temps pour qu'un nuage atteigne sa taille (s), et durée de sa dissipation finale (s). */
const GROWTH = 1.2;
const FADE = 3;
/** Sous ce rayon (m), un nuage ne cache plus rien. */
const MIN_COVER = 0.8;

export function releaseSmoke(sim: Simulation, pos: Vec3, spec: SmokeSpec): SmokeCloud {
  const cloud: SmokeCloud = { id: sim.nextId(), pos, radius: spec.radius, born: sim.time, life: spec.duration };
  sim.smokes.push(cloud);
  sim.emit({ type: "smokeAdded", cloud });
  return cloud;
}

/** Rayon actuel d'un nuage (m) : il grandit, puis rétrécit en se dissipant. */
export function smokeRadius(cloud: SmokeCloud, time: number): number {
  const age = time - cloud.born;
  const grow = clamp(age / GROWTH, 0, 1);
  const fade = clamp((cloud.life - age) / FADE, 0, 1);
  return cloud.radius * grow * fade;
}

/** Retire les nuages dissipés. */
export function updateSmokes(sim: Simulation): void {
  if (!sim.smokes.length) return;
  const kept: SmokeCloud[] = [];
  for (const cloud of sim.smokes) {
    if (sim.time - cloud.born < cloud.life) kept.push(cloud);
    else sim.emit({ type: "smokeRemoved", cloud });
  }
  sim.smokes = kept;
}

/** La fumée cache-t-elle `to` quand on regarde depuis `from` ? Vrai si le segment traverse un nuage. */
export function smokeBlocks(sim: Simulation, from: Vec3, to: Vec3): boolean {
  const seg = sub(to, from);
  const length = len(seg);
  for (const cloud of sim.smokes) {
    const r = smokeRadius(cloud, sim.time);
    if (r < MIN_COVER) continue;
    const t = length ? clamp(dot(sub(cloud.pos, from), seg) / (length * length), 0, 1) : 0;
    if (len(sub(cloud.pos, add(from, scale(seg, t)))) < r) return true;
  }
  return false;
}
