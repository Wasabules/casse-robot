import RAPIER from "@dimforge/rapier3d-compat";
import { add, len, scale, sub, vec3, type Vec3 } from "../math/vec";
import type { Bot } from "../sim/entities";
import type { Simulation } from "../sim/simulation";
import { smokeBlocks } from "./smoke";

/*
 * Ligne de vue d'une arme ou d'une tête chercheuse vers un robot (verrouillage, missiles à tête
 * chercheuse) : le décor, les accessoires et la fumée la coupent, pas les robots.
 */

/** On vise le centre de masse du cockpit, ou ce point au-dessus (un robot dont seul le haut dépasse d'un muret reste en vue). */
const SIGHT_RISE = 0.8;

/**
 * Le décor (sol, relief, boîtes), un accessoire (mur, toit, arbre) ou la fumée cachent-ils `target`
 * vu de `from` ? Les robots ne cachent pas (une tête chercheuse les voit autour). Il est en vue si
 * son cockpit, ou un point un peu au-dessus, l'est.
 */
export function sightBlocked(sim: Simulation, from: Vec3, target: Bot): boolean {
  const com = target.cockpit.part.rb.worldCom();
  return blockedTo(sim, from, com) && blockedTo(sim, from, add(com, vec3(0, SIGHT_RISE, 0)));
}

function blockedTo(sim: Simulation, from: Vec3, to: Vec3): boolean {
  if (smokeBlocks(sim, from, to)) return true;
  const seg = sub(to, from);
  const d = len(seg);
  if (d < 0.5) return false;
  const hit = sim.world.castRay(new RAPIER.Ray(from, scale(seg, 1 / d)), d - 0.3, true, undefined, undefined, undefined, undefined, (c) => {
    const owner = sim.colliders.get(c.handle);
    return !owner || owner.kind === "prop";
  });
  return hit !== null;
}
