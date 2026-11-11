import type { WheelTypeDef } from "../../shared/catalog/wheels";
import { BLOCK_SIZE } from "../../shared/config";
import { vec3, type Vec3 } from "../../shared/math/vec";
import { FORK_TOP } from "./materials";

/*
 * Ferrures d'une roue, dessinées par le jeu (WorldView) et le garage : la fourche d'une roulette
 * ou d'une roue posée sous un bloc (elle pivote avec son porte-moyeu), et la potence qui relie le
 * pivot d'une roulette posée sur un flanc au bloc (fixe, avec le robot).
 */

/** Où une roue est posée sur son bloc : dessous, sur un flanc gauche ou droit, devant ou derrière. */
export type MountFace = "under" | "side" | "end";

/** D'après la place de la roue (`wheel`) et de son bloc (`support`), dans le repère du robot. */
export function mountFace(wheel: Vec3, support: Vec3): MountFace {
  const o = vec3(wheel.x - support.x, wheel.y - support.y, wheel.z - support.z);
  if (Math.abs(o.z) > BLOCK_SIZE / 2 + 0.01) return "end";
  return Math.abs(o.x) < 0.01 && o.y < -BLOCK_SIZE / 2 ? "under" : "side";
}

/** Tige d'une roulette posée sur un flanc, au-dessus de sa fourche (m). */
const CASTER_PIN = 0.08;

export interface Fittings {
  /** Fourche, et la longueur de sa tige (m) ; null : pas de fourche. */
  fork: number | null;
  /** Potence d'une roulette posée sur un flanc : son milieu (repère du robot), sa longueur, et si elle suit l'axe z. */
  stem: { center: Vec3; length: number; alongZ: boolean } | null;
}

export function wheelFittings(def: WheelTypeDef, wheel: Vec3, support: Vec3): Fittings {
  const face = mountFace(wheel, support);
  if (def.track || (!def.caster && face !== "under")) return { fork: null, stem: null };
  const top = wheel.y + def.radius + FORK_TOP;
  // Sous un bloc, la tige monte jusqu'à lui
  if (face === "under") return { fork: Math.max(0, support.y - BLOCK_SIZE / 2 - top), stem: null };
  const y = top + CASTER_PIN;
  // La potence part de la face du bloc et va jusqu'au-dessus du pivot
  if (face === "side") {
    const edge = support.x + Math.sign(wheel.x - support.x) * (BLOCK_SIZE / 2);
    return { fork: CASTER_PIN, stem: { center: vec3((edge + wheel.x) / 2, y, wheel.z), length: Math.abs(wheel.x - edge), alongZ: false } };
  }
  const edge = support.z + Math.sign(wheel.z - support.z) * (BLOCK_SIZE / 2);
  return { fork: CASTER_PIN, stem: { center: vec3(wheel.x, y, (edge + wheel.z) / 2), length: Math.abs(wheel.z - edge), alongZ: true } };
}
