import RAPIER from "@dimforge/rapier3d-compat";
import { blockDef } from "../catalog/blocks";
import { propDef } from "../catalog/props";
import type { GroundFireSpec } from "../catalog/weapons";
import { vec3, type Vec3 } from "../math/vec";
import { COLLISION_GROUPS } from "../physics/groups";
import type { Block, Bot, GroundFire, Prop } from "../sim/entities";
import type { Simulation } from "../sim/simulation";

/*
 * Allumer et éteindre un feu : sur un bloc, sur un accessoire en bois, ou au sol (flaque). Les
 * dégâts et la propagation sont dans fire.ts ; ce module n'en dépend pas, pour que les dégâts
 * (damage.ts) et les projectiles puissent allumer des feux.
 */

/** Durée d'un feu sur un bloc ordinaire (s), s'il n'est pas ravivé. */
export const BURN_TIME = 6;

/** Sensibilité d'un bloc au feu : son facteur de dégâts `fire` (1 par défaut). */
export const flammability = (block: Block): number => blockDef(block.type).resist?.fire ?? 1;

/** Allume (ou ravive) un feu sur un bloc. Un bloc qui résiste au feu brûle moins longtemps. */
export function ignite(sim: Simulation, block: Block, duration = BURN_TIME): void {
  if (!block.alive) return;
  const time = duration * Math.min(1.5, flammability(block));
  if (block.burn <= 0) {
    sim.fires.add(block);
    sim.emit({ type: "fireStarted", block });
  }
  block.burn = Math.max(block.burn, time);
}

/** Éteint le feu d'un bloc. */
export function extinguish(sim: Simulation, block: Block): void {
  if (!sim.fires.delete(block)) return;
  block.burn = 0;
  if (block.alive) sim.emit({ type: "fireEnded", block });
}

/** L'accessoire est-il en bois (il peut brûler) ? */
export const burnable = (prop: Prop): boolean => !!propDef(prop.type).burns;

/**
 * Allume (ou ravive) le feu d'un accessoire en bois encore présent (`sim.props`) : il brûlera
 * `PropTypeDef.burns.time` s s'il n'est pas ravivé. Rien sur la brique, le béton, la tôle.
 */
export function igniteProp(sim: Simulation, prop: Prop): void {
  const burns = propDef(prop.type).burns;
  if (!burns) return;
  const lit = prop.burn <= 0;
  prop.burn = Math.max(prop.burn, burns.time);
  if (!lit) return;
  sim.propFires.add(prop);
  sim.emit({ type: "propFire", prop });
}

/** Éteint le feu d'un accessoire (il a fini de brûler). */
export function extinguishProp(sim: Simulation, prop: Prop): void {
  if (!sim.propFires.delete(prop)) return;
  prop.burn = 0;
  sim.emit({ type: "propFire", prop });
}

/** Flaques de feu à la fois, au plus : au-delà, un nouveau jet ne fait que raviver les flaques. */
const MAX_GROUND_FIRES = 40;
/** Une flaque à moins de cette part de son rayon d'une autre la ravive au lieu d'en faire une nouvelle. */
const MERGE = 0.8;
/** Hauteur (m) au-dessus du sol en deçà de laquelle un jet ou une explosion trouve le sol. */
export const PUDDLE_REACH = 1.5;

/**
 * Le sol ou le décor fixe sous `point`, à moins de `depth` m (un rayon qui ne voit qu'eux), ou
 * null : un jet qui s'éteint en l'air ne laisse pas de flaque.
 */
export function groundBelow(sim: Simulation, point: Vec3, depth: number): Vec3 | null {
  const from = vec3(point.x, point.y + 0.2, point.z);
  const hit = sim.world.castRay(new RAPIER.Ray(from, vec3(0, -1, 0)), depth + 0.2, true, undefined, COLLISION_GROUPS.groundRay);
  return hit ? vec3(point.x, from.y - hit.timeOfImpact, point.z) : null;
}

/**
 * Allume une flaque de feu au sol en `pos` (voir `GroundFireSpec`), ou ravive celle qui y brûle
 * déjà (sans l'agrandir) ; `owner` : le robot qui l'a allumée. Rien sous l'eau.
 */
export function spawnGroundFire(sim: Simulation, pos: Vec3, spec: GroundFireSpec, owner: Bot | null): GroundFire | null {
  // L'eau l'éteint (la rivière de la Vallée)
  const water = sim.arena.water;
  if (water !== undefined && pos.y < water) return null;
  for (const f of sim.groundFires) {
    if (Math.hypot(f.pos.x - pos.x, f.pos.z - pos.z) < f.radius * MERGE && Math.abs(f.pos.y - pos.y) < 1) {
      f.until = Math.max(f.until, sim.time + spec.life);
      return f;
    }
  }
  if (sim.groundFires.length >= MAX_GROUND_FIRES) return null;
  const fire: GroundFire = { id: sim.nextId(), pos, radius: spec.radius, until: sim.time + spec.life, owner };
  sim.groundFires.push(fire);
  sim.emit({ type: "groundFireAdded", fire });
  return fire;
}

/** Éteint une flaque de feu. */
export function removeGroundFire(sim: Simulation, fire: GroundFire): void {
  const i = sim.groundFires.indexOf(fire);
  if (i < 0) return;
  sim.groundFires.splice(i, 1);
  sim.emit({ type: "groundFireRemoved", fire });
}
