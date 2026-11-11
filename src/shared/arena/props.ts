import RAPIER from "@dimforge/rapier3d-compat";
import { propDef, propHalf, propHp, propMass, propVolume } from "../catalog/props";
import { CONTACT_FORCE_THRESHOLD } from "../combat/collisions";
import { removeGroundFire } from "../combat/burning";
import { explode } from "../combat/damage";
import { spawnFragment } from "../combat/debris";
import { STEP } from "../config";
import { clamp, rand } from "../math/scalar";
import { add, cross, norm, qrot, scale, vec3 } from "../math/vec";
import type { Prop } from "../sim/entities";
import type { Simulation } from "../sim/simulation";
import { COLLISION_GROUPS } from "../physics/groups";
import { ownerBot } from "../robot/colliders";
import { spotPose, type PropSpot } from "./layout";
import { dropUnsupported, restoreFelled } from "./structures";

/** Nombre d'éclats d'un accessoire qui se brise ; un grand pan de mur en donne davantage (un par SHARD_AREA m² de sa plus grande face). */
const SHARDS = 5;
const MAX_SHARDS = 14;
const SHARD_AREA = 1.2;

/** Remet les accessoires à leur place de départ (et éteint les flaques de feu). */
export function resetProps(sim: Simulation): void {
  for (const fire of [...sim.groundFires]) removeGroundFire(sim, fire);
  for (const prop of [...sim.props]) removeProp(sim, prop, false);
  sim.props = sim.arena.props.map((spot, i) => createProp(sim, spot, i));
}

function createProp(sim: Simulation, spot: PropSpot, index: number): Prop {
  const type = spot.type;
  const def = propDef(type);
  const half = propHalf(type, spot);
  const fixed = !!def.anchored;
  const { pos, rot } = spotPose(spot, fixed);
  const rb = sim.world.createRigidBody(
    (fixed ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic()).setTranslation(pos.x, pos.y, pos.z).setRotation(rot),
  );
  const desc = def.shape.kind === "cylinder" ? RAPIER.ColliderDesc.cylinder(half.y, half.x) : RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z);
  desc.setDensity(propMass(type, half) / propVolume(type, half)).setFriction(def.friction).setCollisionGroups(COLLISION_GROUPS.prop)
    .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(CONTACT_FORCE_THRESHOLD);
  const collider = sim.world.createCollider(desc, rb);
  const prop: Prop = { id: sim.nextId(), type, rb, collider, spot: index, half, fixed, hp: propHp(type, half), state: { kind: "intact" }, burn: 0, charred: 0 };
  sim.colliders.set(collider.handle, { kind: "prop", prop });
  sim.emit({ type: "propAdded", prop });
  return prop;
}

/** Retire un accessoire ; ce qui reposait sur lui tombe (`collapse`, sauf quand on remet l'arène en place). */
function removeProp(sim: Simulation, prop: Prop, collapse = true): void {
  // (retiré en brûlant : son feu disparaît avec lui, sans extinction)
  sim.propFires.delete(prop);
  sim.colliders.delete(prop.collider.handle);
  sim.world.removeRigidBody(prop.rb);
  sim.props = sim.props.filter((p) => p !== prop);
  sim.emit({ type: "propRemoved", prop });
  if (collapse) dropUnsupported(sim, prop.spot);
}

/**
 * Un pas de vie des accessoires qui ont cédé : la mèche d'un baril brûle ; une bouteille percée
 * est propulsée par le jet de gaz qui fuit par un trou de son flanc, en tournoyant, jusqu'à exploser.
 */
export function updateProps(sim: Simulation): void {
  for (const prop of [...sim.props]) {
    if (prop.yielding) restoreFelled(sim, prop, (p) => robotInside(sim, p));
    const state = prop.state;
    if (state.kind === "intact") continue;
    const def = propDef(prop.type);
    if (state.kind === "venting" && def.vent) {
      // Le gaz jaillit par le trou du flanc : la bouteille part à l'opposé, un peu de biais
      // (elle tournoie) et vers le haut (elle décolle)
      const rb = prop.rb;
      const q = rb.rotation();
      const hole = add(rb.translation(), scale(qrot(q, state.leak), prop.half.x));
      const push = qrot(q, add(scale(state.leak, -0.8), add(scale(cross(vec3(0, 1, 0), state.leak), 0.5), vec3(0, 0.45, 0))));
      rb.applyImpulseAtPoint(scale(norm(push), def.vent.thrust * STEP), hole, true);
    }
    state.left -= STEP;
    if (state.left <= 0) detonate(sim, prop);
  }
}

/** Un robot est-il dans l'accessoire ? (son volume, à sa pose) */
function robotInside(sim: Simulation, prop: Prop): boolean {
  return !!sim.world.intersectionWithShape(prop.rb.translation(), prop.rb.rotation(), prop.collider.shape, undefined, undefined, undefined, undefined, (c) => ownerBot(sim.colliders.get(c.handle)) !== null);
}

/** Fin d'un accessoire : il explose, se brise en éclats, ou les deux. */
function detonate(sim: Simulation, prop: Prop): void {
  const def = propDef(prop.type);
  const p = prop.rb.translation();
  const rot = prop.rb.rotation();
  // Brisé par un robot qui passe au travers : ses éclats partent devant lui
  const vel = prop.struck ?? prop.rb.linvel();
  const h = prop.half;
  removeProp(sim, prop);
  if (def.shatters) {
    const [a, b] = [h.x, h.y, h.z].sort((x, y) => y - x);
    const count = Math.round(clamp((4 * a * b) / SHARD_AREA, SHARDS, MAX_SHARDS));
    const density = propMass(prop.type, h) / propVolume(prop.type, h);
    for (let i = 0; i < count; i++) {
      // Répartis dans tout le volume : un pan de mur s'effondre sur toute sa largeur
      const local = vec3(rand(-h.x, h.x) * 0.9, rand(-h.y, h.y) * 0.9, rand(-h.z, h.z) * 0.9);
      const offset = qrot(rot, local);
      // Une dalle ou un tronc part en gros morceaux ; une caisse, en petits éclats
      const size = def.shape.kind === "box" ? undefined : rand(0.3, 0.6);
      spawnFragment(sim, { kind: "prop", type: prop.type, size }, add(p, offset), rot, Math.min(density, 2000), vel, scale(norm(offset), 1.5));
    }
  }
  if (def.explosion) explode(sim, p, def.explosion, vec3(0, 1, 0), p, null, "blast");
}
