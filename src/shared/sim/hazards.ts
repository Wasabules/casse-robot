import { LAVA_HEIGHT, lavaAt } from "../arena/features";
import { deepWaterAt, groundLevel } from "../arena/layout";
import { propDef } from "../catalog/props";
import { burnable, extinguish, flammability, ignite, igniteProp } from "../combat/burning";
import { DamageBatch, inflict } from "../combat/damage";
import { STEP } from "../config";
import { rand } from "../math/scalar";
import { vec3, type Vec3 } from "../math/vec";
import { blockWorldPos } from "../robot/queries";
import type { Simulation } from "./simulation";

/*
 * Les dangers du terrain (arena/features.ts), dans les arènes qui en ont :
 * - la lave (`ArenaLayout.lava`) brûle les blocs et les roues qui s'y tiennent (à moins de
 *   `LAVA_HEIGHT` m au-dessus du sol), les enflamme, met le feu au bois et fait sauter un baril ;
 * - l'eau profonde (`ArenaLayout.deepWater`) noie un robot dont le cockpit y plonge (court-circuit :
 *   il cède en quelques secondes), et l'eau éteint les blocs en feu qu'elle recouvre.
 * Une arène sans lave ni eau profonde n'a rien de tout cela. Par tranches de TICK, comme le feu.
 */

/** Les dangers sont traités par tranches de cette durée (s). */
const TICK = 0.25;
/** Dégâts de la lave (points par seconde, nature `fire`, avant résistance) : une roue ordinaire y tient un peu plus d'une seconde. */
const LAVA_DPS = 40;
/** Chance, par seconde, qu'un bloc dans la lave s'enflamme (fois sa sensibilité au feu). */
const LAVA_IGNITE = 1.2;
/** Dégâts (par seconde, nature `energy`) au cockpit d'un robot plongé dans l'eau profonde : il se noie en 5 s. */
const DROWN_DPS = 160;
/** Le cockpit plonge quand il passe à plus de cette profondeur sous la surface (m). */
const DROWN_DEPTH = 0.15;
const UP = vec3(0, 1, 0);

/** Un pas des dangers du terrain. */
export function updateHazards(sim: Simulation): void {
  const arena = sim.arena;
  const lava = arena.lava;
  const sea = arena.deepWater !== undefined && arena.water !== undefined;
  if (!lava && !sea) return;
  if (Math.floor(sim.time / TICK) === Math.floor((sim.time - STEP) / TICK)) return;
  const inLava = (p: Vec3, margin = 0): boolean => lavaAt(lava, p.x, p.z, margin) > -margin && p.y - groundLevel(arena, p.x, p.z) < LAVA_HEIGHT + margin;

  const burnt = new DamageBatch();
  burnt.cause = "lava";
  const drowned = new DamageBatch();
  drowned.cause = "drown";
  for (const bot of sim.bots) {
    if (!bot.cockpit.alive) continue;
    const center = blockWorldPos(bot.cockpit);
    if (lava && inLava(center, bot.radius + 2)) {
      for (const block of bot.blocks.values()) {
        if (!inLava(blockWorldPos(block))) continue;
        burnt.add({ kind: "block", block }, LAVA_DPS * TICK, "fire");
        if (block.burn <= 0 && rand(0, 1) < LAVA_IGNITE * TICK * flammability(block)) ignite(sim, block);
      }
      for (const w of bot.wheels) {
        if (w.part && inLava(w.rb.translation())) burnt.add({ kind: "wheel", wheel: w }, LAVA_DPS * TICK, "fire");
      }
    }
    if (sea && center.y < arena.water! - DROWN_DEPTH && deepWaterAt(arena, center.x, center.z)) {
      drowned.add({ kind: "block", block: bot.cockpit }, DROWN_DPS * TICK, "energy");
    }
  }
  if (lava) {
    for (const prop of sim.props) {
      const at = prop.rb.translation();
      if (!inLava(vec3(at.x, at.y - prop.half.y, at.z))) continue;
      if (burnable(prop)) {
        if (prop.burn <= 0) igniteProp(sim, prop);
      } else if (propDef(prop.type).explosion) burnt.add({ kind: "prop", prop }, LAVA_DPS * TICK, "fire");
    }
  }
  // L'eau éteint ce qu'elle recouvre
  if (sea) {
    for (const block of [...sim.fires]) {
      // Un bloc détruit reste dans la liste jusqu'au prochain passage du feu : son corps a pu être libéré
      if (!block.alive) continue;
      const p = blockWorldPos(block);
      if (p.y < arena.water! && groundLevel(arena, p.x, p.z) < arena.water!) extinguish(sim, block);
    }
  }
  // Tout est relevé : on peut infliger (des corps peuvent disparaître)
  if (burnt.blocks.size || burnt.wheels.size || burnt.props.size) inflict(sim, burnt, UP, null);
  if (drowned.blocks.size) inflict(sim, drowned, UP, null);
}
