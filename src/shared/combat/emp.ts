import type { EmpPulse } from "../catalog/weapons";
import { distance, type Vec3 } from "../math/vec";
import { blockWorldPos } from "../robot/queries";
import type { Block, Bot, Wheel } from "../sim/entities";
import type { Simulation } from "../sim/simulation";

/*
 * Impulsion électromagnétique. Un robot paralysé perd son électronique : les moteurs de ses roues
 * passent en roue libre et sa direction flotte, ses réacteurs et ses propulseurs s'éteignent (un
 * drone tombe, un avion plane), ses tourelles ne visent ni ne tirent plus. Voir `cutPower` et
 * `thinkBot`.
 *
 * Paralysie locale (lance électrique : `MeleeHit.stun`, combat/melee.ts) : une IEM ciblée, qui ne
 * coupe que les organes autour du point touché (`Block.stunnedUntil`, `Wheel.stunnedUntil`), le
 * reste du robot marche. Chaque organe la respecte : une roue passe en roue libre, direction
 * flottante (`cutStunnedOrgans`, après les commandes de chaque pas) ; un moteur ne pousse plus (sa
 * part de poussée tombe à 0, comme un raté : `wearEngines`) ; un appui retombe (`driveSupports`) ;
 * une tourelle se fige et se tait (ai/gunner.ts, sim/player.ts) ; une arme de contact n'est plus
 * alimentée ; un bouclier n'absorbe plus (combat/shield.ts). Elle passe par le réseau (événement
 * `organsStunned`, `NetEvent` `shock`).
 */

/** Impulsion en `point` : paralyse les robots dont un bloc alimenté est à portée, moins longtemps au bord. */
export function empPulse(sim: Simulation, point: Vec3, pulse: EmpPulse): void {
  sim.emit({ type: "empBurst", point, radius: pulse.radius });
  for (const bot of sim.bots) {
    if (!bot.cockpit.alive) continue;
    let d = Infinity;
    for (const b of bot.cockpit.part.blocks) d = Math.min(d, distance(blockWorldPos(b), point));
    if (d > pulse.radius) continue;
    const until = sim.time + pulse.duration * (1 - (0.5 * d) / pulse.radius);
    if (until > bot.stunnedUntil) {
      bot.stunnedUntil = until;
      sim.emit({ type: "stunned", bot, until });
    }
  }
}

/** Le robot est-il paralysé par une impulsion électromagnétique ? */
export const isStunned = (sim: { readonly time: number }, bot: Bot): boolean => bot.stunnedUntil > sim.time;

/** L'organe que porte ce bloc est-il coupé, par une paralysie locale ou celle de tout son robot ? */
export const organStunned = (world: { readonly time: number }, block: Block): boolean =>
  block.stunnedUntil > world.time || block.bot.stunnedUntil > world.time;

/** Le moteur et la direction de cette roue sont-ils coupés (paralysie locale, ou de tout son robot) ? */
export const wheelStunned = (world: { readonly time: number }, wheel: Wheel): boolean =>
  wheel.stunnedUntil > world.time || wheel.bot.stunnedUntil > world.time;

/** Le robot a-t-il un organe paralysé localement en ce moment ? (Le HUD, les effets.) */
export function localStuns(world: { readonly time: number }, bot: Bot): { blocks: Block[]; wheels: Wheel[]; until: number } {
  const blocks: Block[] = [];
  const wheels: Wheel[] = [];
  let until = 0;
  for (const b of bot.blocks.values()) {
    if (b.stunnedUntil > world.time) {
      blocks.push(b);
      until = Math.max(until, b.stunnedUntil);
    }
  }
  for (const w of bot.wheels) {
    if (w.part && w.stunnedUntil > world.time) {
      wheels.push(w);
      until = Math.max(until, w.stunnedUntil);
    }
  }
  return { blocks, wheels, until };
}

/**
 * Paralysie locale : les blocs de `bot` (sur ses morceaux) et ses roues montées à moins de `radius`
 * m de `point` sont coupés pendant `duration` s (une paralysie plus longue en cours reste). Lit les
 * poses de ses morceaux : à faire avant d'infliger les dégâts du coup.
 */
export function stunOrgans(sim: Simulation, bot: Bot, point: Vec3, radius: number, duration: number): void {
  const until = sim.time + duration;
  const blocks: Block[] = [];
  const wheels: Wheel[] = [];
  for (const b of bot.blocks.values()) {
    if (distance(blockWorldPos(b), point) > radius) continue;
    b.stunnedUntil = Math.max(b.stunnedUntil, until);
    blocks.push(b);
  }
  for (const w of bot.wheels) {
    if (!w.part || distance(w.rb.translation(), point) > radius) continue;
    w.stunnedUntil = Math.max(w.stunnedUntil, until);
    wheels.push(w);
  }
  if (blocks.length || wheels.length) sim.emit({ type: "organsStunned", bot, blocks, wheels, until, point });
}

/**
 * Les roues paralysées localement n'obéissent pas : roue libre, direction flottante (comme sous une
 * IEM, `cutPower`). À faire après les commandes du pas (IA ou joueur), avant les roues.
 */
export function cutStunnedOrgans(sim: Simulation, bot: Bot): void {
  for (const w of bot.wheels) {
    if (!w.part || w.stunnedUntil <= sim.time) continue;
    w.drive = 0;
    w.powered = false;
    w.engaged = false;
    w.overrun = false;
    w.brake = 0;
  }
}
