import { blockDef } from "../catalog/blocks";
import { distance } from "../math/vec";
import type { Block } from "../sim/entities";

/*
 * Bouclier. Un générateur relié au cockpit (sur son morceau) absorbe une part des dégâts reçus
 * par les blocs du robot qui l'entourent, tant que les batteries ont de quoi payer : chaque point
 * absorbé coûte de l'énergie. Plusieurs générateurs ne s'additionnent pas : le bloc touché
 * profite du plus proche. Le générateur lui-même se protège (il est à distance nulle de lui-même).
 */

/**
 * Dégâts `amount` reçus par `block`, une fois le bouclier passé : la part absorbée est payée sur
 * les batteries du robot. Les générateurs qui ont absorbé quelque chose rejoignent `flashed`
 * (pour l'éclat à l'écran). `time` : l'instant (temps simulé), pour qu'un générateur paralysé
 * localement (lance électrique, combat/emp.ts) n'absorbe rien.
 */
export function shieldDamage(block: Block, amount: number, flashed: Set<Block>, time = -Infinity): number {
  const bot = block.bot;
  if (!bot.shields.length || amount <= 0 || bot.energy <= 0 || !bot.cockpit.alive) return amount;
  let generator: Block | null = null;
  let nearest = Infinity;
  for (const g of bot.shields) {
    if (!g.alive || g.part !== bot.cockpit.part || g.stunnedUntil > time) continue;
    const d = distance(g.local, block.local);
    if (d <= blockDef(g.type).shield!.radius && d < nearest) {
      nearest = d;
      generator = g;
    }
  }
  if (!generator) return amount;
  const spec = blockDef(generator.type).shield!;
  const absorbed = Math.min(amount * spec.absorb, bot.energy / spec.cost);
  bot.energy -= absorbed * spec.cost;
  flashed.add(generator);
  return amount - absorbed;
}
