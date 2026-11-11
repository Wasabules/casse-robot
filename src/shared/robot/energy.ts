import { blockDef } from "../catalog/blocks";
import { COCKPIT_BATTERY, GENERATOR_POWER, STEP } from "../config";
import { clamp } from "../math/scalar";
import type { Bot } from "../sim/entities";

/*
 * Énergie. Les réacteurs et les propulseurs consomment de l'électricité (`ThrusterSpec.power`),
 * prise sur les batteries du morceau du cockpit ; le générateur du cockpit les recharge en
 * continu, mais moins vite qu'un robot volant ne les vide. Batteries vides, les moteurs ne
 * reçoivent plus que ce que produit le générateur : un drone doit se poser pour recharger. Les
 * moteurs des roues, eux, ne comptent pas.
 */

/** Capacité (kJ) : la batterie du cockpit et les batteries encore reliées au cockpit. */
export function energyCapacity(bot: Bot): number {
  const ck = bot.cockpit;
  if (!ck.alive) return 0;
  let capacity = COCKPIT_BATTERY;
  for (const b of ck.part.blocks) capacity += blockDef(b.type).battery?.capacity ?? 0;
  return capacity;
}

/** Charge des batteries, de 0 à 1. */
export function energyFraction(bot: Bot): number {
  const capacity = energyCapacity(bot);
  return capacity ? clamp(bot.energy / capacity, 0, 1) : 0;
}

/**
 * Part de la demande `demand` (kW) que l'alimentation peut fournir, de 0 à 1 : tout tant qu'il
 * reste de l'énergie, sinon seulement ce que produit le générateur.
 */
export function supply(bot: Bot, demand: number): number {
  if (demand <= 0 || bot.energy > 0) return 1;
  return Math.min(1, GENERATOR_POWER / demand);
}

/** Fin du pas : le générateur recharge, les moteurs ont consommé `bot.drawn` kW. */
export function settleEnergy(bot: Bot, generating: boolean): void {
  const gain = (generating ? GENERATOR_POWER : 0) - bot.drawn;
  bot.energy = clamp(bot.energy + gain * STEP, 0, energyCapacity(bot));
  bot.drawn = 0;
}
