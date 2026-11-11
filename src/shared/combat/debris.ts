import RAPIER from "@dimforge/rapier3d-compat";
import { blockDensity } from "../catalog/blocks";
import { BLOCK_SIZE, MAX_DEBRIS } from "../config";
import { rand } from "../math/scalar";
import { add, scale, vec3, type Quat, type Vec3 } from "../math/vec";
import { blockWorldPos } from "../robot/queries";
import { COLLISION_GROUPS } from "../physics/groups";
import type { Block, Debris, DebrisLook } from "../sim/entities";
import type { Simulation } from "../sim/simulation";

/** Côté du collider d'un débris (m) : un peu moins de la moitié d'un bloc. */
export const DEBRIS_SIZE = BLOCK_SIZE * 0.46;

/** Remplace un bloc détruit par un petit cube projeté. `vel` : vitesse du bloc juste avant l'impact. */
export function spawnDebris(sim: Simulation, block: Block, vel: Vec3, dir: Vec3): void {
  const look: DebrisLook = { kind: "block", type: block.type, color: block.bot.profile.color };
  spawnFragment(sim, look, blockWorldPos(block), block.part.rb.rotation(), blockDensity(block.type), vel, dir);
}

/**
 * Un éclat projeté depuis `p` à la vitesse `vel`, poussé dans la direction `dir` avec un peu de
 * hasard : un petit cube, ou un morceau de mur du côté que donne son apparence.
 */
export function spawnFragment(sim: Simulation, look: DebrisLook, p: Vec3, rot: Quat, density: number, vel: Vec3, dir: Vec3): void {
  const half = (look.kind === "prop" && look.size ? look.size : DEBRIS_SIZE) / 2;
  const rb = sim.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z).setRotation(rot));
  const collider = sim.world.createCollider(
    RAPIER.ColliderDesc.cuboid(half, half, half).setDensity(density).setFriction(0.6).setRestitution(0.1)
      .setCollisionGroups(COLLISION_GROUPS.debris),
    rb,
  );
  const kick = add(scale(dir, 2 + Math.random() * 2), vec3(rand(-1.5, 1.5), rand(1.5, 4), rand(-1.5, 1.5)));
  rb.setLinvel(add(vel, kick), true);
  rb.setAngvel(vec3(rand(-6, 6), rand(-6, 6), rand(-6, 6)), true);
  sim.colliders.set(collider.handle, { kind: "debris" });

  const debris: Debris = { id: sim.nextId(), rb, collider, look, born: sim.time, life: rand(4, 6) };
  sim.debris.push(debris);
  sim.emit({ type: "debrisAdded", debris });
  while (sim.debris.length > MAX_DEBRIS) removeDebris(sim, sim.debris.shift()!);
}

/** Retire les débris arrivés en fin de vie. */
export function expireDebris(sim: Simulation): void {
  const alive: Debris[] = [];
  for (const d of sim.debris) {
    if (sim.time - d.born > d.life) removeDebris(sim, d);
    else alive.push(d);
  }
  sim.debris = alive;
}

export function clearDebris(sim: Simulation): void {
  for (const d of sim.debris) removeDebris(sim, d);
  sim.debris = [];
}

/** Retire un débris du monde (l'appelant le retire de `sim.debris`). */
function removeDebris(sim: Simulation, d: Debris): void {
  sim.colliders.delete(d.collider.handle);
  sim.world.removeRigidBody(d.rb);
  sim.emit({ type: "debrisRemoved", debris: d });
}
