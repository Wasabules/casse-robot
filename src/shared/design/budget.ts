import { blockDef } from "../catalog/blocks";
import { wheelDef } from "../catalog/wheels";
import type { RobotDesign } from "./robotDesign";

/*
 * Budget de construction (le « CPU » de Robocraft). Chaque bloc et chaque roue coûte des points ;
 * un robot ne dépasse pas le budget. Sans lui, le meilleur robot serait simplement le plus gros :
 * il oblige à choisir entre blindage, armes, mobilité et équipement.
 */

/** Points de construction d'un robot. Le Camion, le plus gros des robots prédéfinis, en coûte 598. */
export const ROBOT_BUDGET = 600;

/** Coût d'un plan : ses blocs et ses roues. */
export function designCost(design: RobotDesign): number {
  let cost = 0;
  for (const b of design.blocks) cost += blockDef(b.type).cost;
  for (const w of design.wheels) cost += wheelDef(w.type).cost;
  return cost;
}
