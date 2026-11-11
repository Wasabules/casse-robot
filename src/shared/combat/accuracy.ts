import type { Weapon } from "../catalog/weapons";
import type { Bot } from "../sim/entities";
import { vibration } from "./melee";

/*
 * Précision d'un tir du joueur. Chaque arme a sa meilleure dispersion (`Weapon.spread`, au viseur,
 * robot immobile) et son maniement (`Weapon.handling`) : sans viseur, elle est multipliée ; le
 * mouvement du robot et ses rotations (il vire, il tangue sur ses suspensions, il rebondit)
 * l'élargissent. Un avion en vol est un support stable : sa vitesse ne compte pas, seules ses
 * rotations. L'IA, elle, tire avec la dispersion sans viseur (`hipSpread`) : son erreur de visée
 * grandit déjà avec les vitesses (voir ai/gunner.ts).
 */

/** Vitesse (m/s) et rotation (rad/s) en deçà desquelles un robot compte pour immobile et stable. */
const STILL_SPEED = 0.3;
const STEADY_TURN = 0.08;
/** Dispersion la plus large (rad). */
const MAX_SPREAD = 0.3;

/** Dispersion d'un tir sans viseur, sans tenir compte du mouvement : celle de l'IA et de la caméra libre. */
export const hipSpread = (weapon: Weapon): number => weapon.spread * weapon.handling.hip;

/**
 * Le balourd d'une arme de contact (combat/melee.ts) secoue le robot à la fréquence de son rotor :
 * une vibration entière compte comme une rotation de SHAKE_TURN rad/s (le sniper ne touche plus rien,
 * le fusil s'écarte de 1,4°).
 */
const SHAKE_TURN = 2;

/** Ce qui dégrade la visée en ce moment : la vitesse du robot (m/s) et ses rotations (rad/s), vibration comprise. */
export function unsteadiness(bot: Bot): { speed: number; turn: number } {
  if (!bot.cockpit.alive) return { speed: 0, turn: 0 };
  const rb = bot.cockpit.part.rb;
  const v = rb.linvel();
  const w = rb.angvel();
  return {
    speed: bot.profile.mobility === "plane" ? 0 : Math.max(0, Math.hypot(v.x, v.y, v.z) - STILL_SPEED),
    turn: Math.max(0, Math.hypot(w.x, w.y, w.z) - STEADY_TURN) + (bot.melee.length ? vibration(bot) * SHAKE_TURN : 0),
  };
}

/** Dispersion d'un tir du joueur (rad) : viseur ou non, et ce que son robot bouge. */
export function aimSpread(bot: Bot, weapon: Weapon, scoped: boolean): number {
  const h = weapon.handling;
  const base = weapon.spread * (scoped ? 1 : h.hip);
  const { speed, turn } = unsteadiness(bot);
  return Math.min(MAX_SPREAD, base + h.move * speed + h.turn * turn);
}
