import { cross, len, norm, qrot, scale, vec3 } from "../math/vec";
import type { Bot } from "../sim/entities";

/*
 * Redressement : le cockpit embarque un gyroscope qui remet d'aplomb un robot renversé. Il ne
 * s'enclenche qu'après RIGHTING_DELAY s couché et presque immobile : le robot fait un petit bond,
 * pivote vers la verticale, puis reprend la route. Un renversement coûte donc quelques secondes
 * de combat (et on reste une cible), mais il n'immobilise plus un robot pour de bon. Le même bond
 * dégage un robot resté longtemps coincé, le ventre sur une arête (`unstick`). Les avions n'en
 * ont pas : ils volent ou ils s'écrasent.
 */

/** Au-dessous de ce cosinus d'inclinaison, le robot est considéré comme renversé. */
export const FLIPPED_UP_Y = 0.55;
/** Temps passé renversé et presque immobile avant le redressement (s). */
export const RIGHTING_DELAY = 3;
/** Vitesse (m/s) au-dessus de laquelle le robot roule ou tombe encore : on attend qu'il se pose. */
const STILL_SPEED = 1.5;
/** Durée maximale d'un redressement (s), et durée du bond du début (s). */
const RIGHTING_TIME = 2;
const HOP_TIME = 0.15;
/** Vitesse verticale du bond (m/s), et vitesse de rotation maximale (rad/s). */
const HOP_SPEED = 3;
const TURN_RATE = 4;
/** Cosinus d'inclinaison à partir duquel le robot est d'aplomb. */
const UPRIGHT_Y = 0.92;

const UP = vec3(0, 1, 0);

/**
 * Un pas du gyroscope du robot. Renvoie vrai tant qu'il le redresse : le robot ne conduit pas
 * et ne tire pas pendant ce temps.
 */
export function updateRighting(bot: Bot, dt: number): boolean {
  const rb = bot.cockpit.part.rb;
  const q = rb.rotation();
  const up = qrot(q, UP);
  if (bot.righting > 0) {
    bot.righting -= dt;
    const hopping = bot.righting > RIGHTING_TIME - HOP_TIME;
    if (!hopping && (up.y > UPRIGHT_Y || bot.righting <= 0)) {
      bot.righting = 0;
      bot.flippedFor = 0;
      rb.setAngvel(scale(rb.angvel(), 0.2), true); // on amortit pour ne pas repartir de l'autre côté
      return false;
    }
    if (up.y <= UPRIGHT_Y) {
      // Rotation qui amène le haut du robot vers la verticale ; à l'envers, on roule sur le flanc
      let axis = cross(up, UP);
      if (len(axis) < 0.05) axis = qrot(q, vec3(0, 0, 1));
      const angle = Math.acos(Math.max(-1, Math.min(1, up.y)));
      rb.setAngvel(scale(norm(axis), Math.min(TURN_RATE, angle * 5)), true);
    }
    if (hopping) {
      const v = rb.linvel();
      rb.setLinvel(vec3(v.x * 0.5, Math.max(v.y, HOP_SPEED), v.z * 0.5), true);
    }
    return true;
  }
  if (up.y >= FLIPPED_UP_Y) {
    bot.flippedFor = 0;
    return false;
  }
  if (len(rb.linvel()) < STILL_SPEED) bot.flippedFor += dt;
  if (bot.flippedFor >= RIGHTING_DELAY) bot.righting = RIGHTING_TIME;
  return false;
}

/** Un robot coincé (roues dans le vide, ventre sur une arête) : le gyroscope le fait bondir. */
export function unstick(bot: Bot): void {
  if (bot.righting <= 0) bot.righting = RIGHTING_TIME;
}
