import type { PropType } from "../catalog/props";
import { add, axisAngle, NO_ROTATION, qrot, vec3, type Quat, type Vec3 } from "../math/vec";
import type { CaptureZone, PropSpot, StaticBox, StaticKind } from "./layout";

/*
 * Briques des arènes : boîtes du décor, rampes, accessoires, zones. Les arènes (layout.ts,
 * valley.ts) s'écrivent avec elles.
 */

/** Demi-épaisseur des rampes (m) : assez pour que leur dessous passe sous le sol jusqu'au bord haut. */
const RAMP_HALF_THICKNESS = 0.9;
/** Demi-épaisseur de la dalle qui décrit le dessus d'une rampe (m). */
const RAMP_TOP = 0.25;

/**
 * Rampe : une dalle inclinée, de dessus `(pos, half, rot)`, épaissie vers le bas pour être pleine
 * jusqu'au sol. Une dalle mince laisserait du vide sous son bord haut, où un robot bas se coincerait.
 */
export function ramp(pos: Vec3, half: Vec3, rot: Quat): StaticBox {
  return {
    kind: "ramp",
    pos: add(pos, qrot(rot, vec3(0, half.y - RAMP_HALF_THICKNESS, 0))),
    half: vec3(half.x, RAMP_HALF_THICKNESS, half.z),
    rot,
  };
}

/**
 * Rampe qui monte de `rise` m sur `run` m, centrée en (x, z), large de `width` m, orientée le long
 * de `axis` et montant vers ses valeurs croissantes (`toward` = 1) ou décroissantes (-1) : son bas
 * est à `base` m (le sol), son haut à `base + rise` m (le dessus d'une plateforme).
 */
export function incline(x: number, z: number, axis: "x" | "z", toward: 1 | -1, width: number, run: number, rise: number, base = 0): StaticBox {
  const angle = Math.atan2(rise, run);
  const halfLength = Math.hypot(run, rise) / 2;
  // Autour de x, un angle négatif lève le côté +z ; autour de z, un angle positif lève le côté +x
  const rot = axis === "z" ? axisAngle(vec3(1, 0, 0), -toward * angle) : axisAngle(vec3(0, 0, 1), toward * angle);
  const top = vec3(x, base + rise / 2, z);
  const half = axis === "z" ? vec3(width / 2, RAMP_TOP, halfLength) : vec3(halfLength, RAMP_TOP, width / 2);
  return ramp(add(top, qrot(rot, vec3(0, -RAMP_TOP, 0))), half, rot);
}

export const box = (kind: StaticKind, x: number, y: number, z: number, hx: number, hy: number, hz: number, rot: Readonly<Quat> = NO_ROTATION): StaticBox =>
  ({ kind, pos: vec3(x, y, z), half: vec3(hx, hy, hz), rot });
export const pillar = (x: number, z: number): StaticBox => box("pillar", x, 1.5, z, 0.8, 1.5, 0.8);
/** Muret de 2,2 m de haut, le long de x (`along` = "x") ou de z, posé à `base` m. */
export const barrier = (x: number, z: number, along: "x" | "z", length: number, height = 2.2, base = 0): StaticBox =>
  along === "x"
    ? box("barrier", x, base + height / 2, z, length / 2, height / 2, 0.4)
    : box("barrier", x, base + height / 2, z, 0.4, height / 2, length / 2);

/** Murs d'enceinte d'une arène carrée de ±half m. */
export function enclosure(half: number): StaticBox[] {
  const walls: StaticBox[] = [];
  for (const s of [-1, 1]) {
    walls.push(box("wall", 0, 0.6, s * half, half + 0.5, 0.6, 0.5));
    walls.push(box("wall", s * half, 0.6, 0, 0.5, 0.6, half + 0.5));
  }
  return walls;
}

export const spots = (type: PropType, list: number[][]): PropSpot[] => list.map(([x, y, z]) => ({ type, pos: vec3(x, y, z) }));
export const zone = (label: string, x: number, y: number, z: number, radius: number): CaptureZone => ({ label, pos: vec3(x, y, z), radius });
