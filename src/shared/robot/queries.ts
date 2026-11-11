import { wheelDef } from "../catalog/wheels";
import { add, qrot, type Vec3 } from "../math/vec";
import type { Block, Bot, Thruster, Wheel } from "../sim/entities";

/** Position d'un bloc dans le monde. */
export function blockWorldPos(block: Block): Vec3 {
  const rb = block.part.rb;
  return add(rb.translation(), qrot(rb.rotation(), block.local));
}

/** Moteurs encore reliés au cockpit (les seuls alimentés), éventuellement d'un seul rôle. */
export function liveThrusters(bot: Bot, role?: Thruster["role"]): Thruster[] {
  const ck = bot.cockpit;
  if (!ck.alive) return [];
  return bot.thrusters.filter((t) => t.block.alive && t.block.part === ck.part && (!role || t.role === role));
}

/** Roues montées sur le morceau du cockpit : les seules qui sont motorisées. */
export function drivenWheels(bot: Bot): Wheel[] {
  const ck = bot.cockpit;
  if (!ck.alive) return [];
  return bot.wheels.filter((w) => w.hub && w.part === ck.part);
}

export const drivenWheelCount = (bot: Bot): number => drivenWheels(bot).length;

/** Part des blocs de départ encore reliés au cockpit, de 0 à 1. */
export function integrity(bot: Bot): number {
  const ck = bot.cockpit;
  return ck.alive ? ck.part.blocks.size / bot.total : 0;
}

/**
 * Charge des roues motrices par rapport à leur charge nominale (1 = 100 %), d'après la masse
 * actuelle du morceau du cockpit, sans celle des roues elles-mêmes (elle compte dans ce morceau,
 * mais ne pèse pas sur leurs ressorts). Au-delà de 1, les suspensions s'affaissent et les moteurs peinent.
 */
export function wheelLoad(bot: Bot): number {
  const wheels = drivenWheels(bot);
  if (!wheels.length) return 0;
  const rated = wheels.reduce((s, w) => s + wheelDef(w.type).ratedLoad, 0);
  const own = bot.wheels.reduce((s, w) => s + (w.hub && w.part === bot.cockpit.part ? wheelDef(w.type).mass : 0), 0);
  return (bot.cockpit.part.rb.mass() - own) / rated;
}
