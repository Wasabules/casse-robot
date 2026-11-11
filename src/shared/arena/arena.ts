import RAPIER, { type RigidBody, type World } from "@dimforge/rapier3d-compat";
import { COLLISION_GROUPS } from "../physics/groups";
import { GROUND_HALF, type ArenaLayout } from "./layout";
import { rockShape } from "./rocks";

const GROUND_FRICTION = 0.9;
const STATIC_FRICTION = 0.8;

/** Crée le sol, commun à toutes les arènes. */
export function buildGround(world: World): void {
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(GROUND_HALF, 0.5, GROUND_HALF).setFriction(GROUND_FRICTION).setCollisionGroups(COLLISION_GROUPS.static), ground);
}

/**
 * Crée le décor fixe d'une arène, et son relief (un champ de hauteurs, au-dessus du sol plat) ;
 * renvoie ses corps, pour pouvoir le retirer (`clearScenery`).
 */
export function buildScenery(world: World, layout: ArenaLayout): RigidBody[] {
  const bodies = layout.boxes.map(({ kind, pos, half, rot, round }) => {
    const rb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(pos.x, pos.y, pos.z).setRotation(rot));
    // Un rocher a la forme qu'on voit (voir rocks.ts), pas celle de sa boîte ; un silo, un phare sont ronds
    const shape = (kind === "rock" ? RAPIER.ColliderDesc.convexHull(rockShape(half, pos.x, pos.z).vertices) : null)
      ?? (round ? RAPIER.ColliderDesc.cylinder(half.y, half.x) : RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z));
    world.createCollider(shape.setFriction(STATIC_FRICTION).setCollisionGroups(COLLISION_GROUPS.static), rb);
    return rb;
  });
  const terrain = layout.terrain;
  if (terrain) {
    const rb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    // Arêtes internes corrigées : sans cela, une caisse qui frotte le relief accroche l'arête entre
    // deux triangles comme une marche, et s'arrête net
    const desc = RAPIER.ColliderDesc.heightfield(terrain.cells, terrain.cells, terrain.heights, { x: terrain.size, y: 1, z: terrain.size }, RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES);
    world.createCollider(desc.setFriction(GROUND_FRICTION).setCollisionGroups(COLLISION_GROUPS.static), rb);
    bodies.push(rb);
  }
  return bodies;
}

/** Retire le décor fixe (avec ses colliders). */
export function clearScenery(world: World, bodies: readonly RigidBody[]): void {
  for (const rb of bodies) world.removeRigidBody(rb);
}
