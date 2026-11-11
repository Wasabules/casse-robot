import type { WheelTypeDef } from "../../shared/catalog/wheels";
import type { Vec3 } from "../../shared/math/vec";
import { BELT_CLEARANCE, BELT_MARGIN } from "../../shared/design/tracks";

// Groupes de galets et cotes de la bande : dans shared (l'encombrement d'une chenille s'en sert aussi)
export { BELT_CLEARANCE, BELT_MARGIN, trackGroups } from "../../shared/design/tracks";

/*
 * Forme des chenilles (géométrie pure, sans Babylon) : les galets voisins d'un même flanc forment
 * une chenille, et sa bande fait le tour de tous. Ils peuvent se suivre le long du flanc, s'empiler
 * (une chenille plus haute : la bande suit l'enveloppe convexe des galets) ou se poser l'un sur
 * l'autre vers l'extérieur (une chenille plus large). Le mesh est fait par render/belts.ts.
 */

/** Segments d'un demi-tour de la bande. */
const BELT_ARC = 10;
/** Pas des patins le long de la bande (m) : une chenille en a un nombre entier, répartis sur toute sa boucle. */
export const SHOE_PITCH = 0.12;

/** Forme d'une bande : sa largeur autour de `x`, et le contour (z, y) des centres des galets qu'elle enveloppe. */
export interface BeltShape {
  x: number;
  width: number;
  /** Enveloppe convexe des centres, dans le plan (z, y), dans le sens trigonométrique (z à droite, y en haut). */
  hull: [number, number][];
  /** Rayon du tour de la bande autour de chaque centre (m). */
  radius: number;
}

export function beltShape(centers: readonly Vec3[], def: WheelTypeDef): BeltShape {
  const xs = centers.map((c) => c.x);
  const lo = Math.min(...xs) - def.width / 2 - BELT_MARGIN;
  const hi = Math.max(...xs) + def.width / 2 + BELT_MARGIN;
  return { x: (lo + hi) / 2, width: hi - lo, hull: convexHull(centers.map((c) => [c.z, c.y])), radius: def.radius + BELT_CLEARANCE };
}

/** Enveloppe convexe (chaîne monotone), dans le sens trigonométrique, sans point en double ni aligné. */
function convexHull(points: [number, number][]): [number, number][] {
  const pts = [...new Map(points.map((p) => [`${p[0].toFixed(3)}:${p[1].toFixed(3)}`, p])).values()]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const chain = (list: [number, number][]): [number, number][] => {
    const out: [number, number][] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 1e-9) out.pop();
      out.push(p);
    }
    return out;
  };
  const lower = chain(pts);
  const upper = chain([...pts].reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * Parcours de la bande : le contour des galets écarté de `radius` (des droites d'un galet à
 * l'autre, des arcs autour de ceux des coins), dans le sens trigonométrique : le dessous va de
 * l'arrière vers l'avant, le dessus de l'avant vers l'arrière. Chaque point : (z, y) et sa normale
 * vers l'extérieur (nz, ny) ; le dernier point referme la boucle sur le premier.
 */
export function beltPath(shape: BeltShape): [number, number, number, number][] {
  const { hull, radius } = shape;
  const path: [number, number, number, number][] = [];
  const at = (c: [number, number], a: number): [number, number, number, number] =>
    [c[0] + radius * Math.cos(a), c[1] + radius * Math.sin(a), Math.cos(a), Math.sin(a)];
  if (hull.length === 1) {
    for (let i = 0; i <= 2 * BELT_ARC; i++) path.push(at(hull[0], -Math.PI / 2 + (i / BELT_ARC) * Math.PI));
    return path;
  }
  // Direction de la normale vers l'extérieur de chaque côté (sens trigonométrique : à droite du côté)
  const normals = hull.map((p, i) => {
    const q = hull[(i + 1) % hull.length];
    return Math.atan2(-(q[0] - p[0]), q[1] - p[1]);
  });
  for (let i = 0; i < hull.length; i++) {
    // Arc autour du coin i, de la normale du côté qui y mène à celle du côté qui en part ; son
    // premier point finit le côté droit qui y mène
    const from = normals[(i + hull.length - 1) % hull.length];
    let to = normals[i];
    while (to < from - 1e-9) to += 2 * Math.PI;
    const steps = Math.max(1, Math.ceil((BELT_ARC * (to - from)) / Math.PI));
    for (let k = 0; k <= steps; k++) path.push(at(hull[i], from + ((to - from) * k) / steps));
  }
  path.push(path[0]);
  return path;
}

/** Parcours d'une bande mesuré pour y poser ses patins : l'abscisse de chacun de ses points le long de la boucle. */
export interface ShoeLoop {
  path: [number, number, number, number][];
  along: number[];
  /** Tour complet (m), et nombre de patins. */
  length: number;
  count: number;
}

export function shoeLoop(shape: BeltShape): ShoeLoop {
  const path = beltPath(shape);
  const along = [0];
  for (let k = 1; k < path.length; k++) along.push(along[k - 1] + Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1]));
  const length = along[along.length - 1];
  return { path, along, length, count: Math.max(4, Math.round(length / SHOE_PITCH)) };
}

/**
 * Pose les patins : le i-ième à `offset + i × tour / nombre` le long de la boucle, le bout de son
 * crampon sur le parcours, tourné selon la normale du parcours (dans les arcs, chaque patin pivote
 * autour du galet, comme un maillon qui s'articule). Écrit dans `out` la matrice de chacun (16
 * nombres, convention de Babylon : les images de ses axes x, y, z puis sa position) dans le repère
 * de la bande, x depuis son milieu : son x en travers de la bande, son y vers l'extérieur, son z le
 * long de la bande. Faire croître `offset` fait avancer les patins dans le sens du parcours (le
 * dessous vers l'avant, le dessus vers l'arrière).
 */
export function placeShoes(loop: ShoeLoop, offset: number, out: Float32Array): void {
  const { path, along, length, count } = loop;
  const step = length / count;
  let s = ((offset % length) + length) % length;
  // Segment du premier patin, par dichotomie ; les suivants, rangés le long de la boucle, en avançant
  let k = 0;
  for (let hi = path.length - 2; k < hi; ) {
    const mid = (k + hi + 1) >> 1;
    if (along[mid] <= s) k = mid;
    else hi = mid - 1;
  }
  for (let i = 0; i < count; i++, s += step) {
    if (s >= length) {
      s -= length;
      k = 0;
    }
    while (k < path.length - 2 && s >= along[k + 1]) k++;
    const [z0, y0, nz0, ny0] = path[k];
    const [z1, y1, nz1, ny1] = path[k + 1];
    const span = along[k + 1] - along[k];
    const t = span > 1e-9 ? (s - along[k]) / span : 0;
    const nzRaw = nz0 + (nz1 - nz0) * t;
    const nyRaw = ny0 + (ny1 - ny0) * t;
    const n = Math.hypot(nzRaw, nyRaw) || 1;
    const nz = nzRaw / n;
    const ny = nyRaw / n;
    // (écrit en place, sans tableau intermédiaire : c'est fait à chaque image pour chaque patin)
    const o = i * 16;
    out[o] = 1;
    out[o + 1] = out[o + 2] = out[o + 3] = out[o + 4] = out[o + 7] = out[o + 8] = out[o + 11] = out[o + 12] = 0;
    out[o + 5] = ny;
    out[o + 6] = nz;
    out[o + 9] = -nz;
    out[o + 10] = ny;
    out[o + 13] = y0 + (y1 - y0) * t;
    out[o + 14] = z0 + (z1 - z0) * t;
    out[o + 15] = 1;
  }
}

/** Place des guides des patins (en x, depuis le milieu de la bande) : un au milieu de chaque rangée de galets. */
export function shoeHorns(shape: BeltShape, centers: readonly Vec3[]): number[] {
  return [...new Set(centers.map((c) => Math.round((c.x - shape.x) * 1000) / 1000))].sort((a, b) => a - b);
}

/**
 * Galets qui portent le barbotin (la roue dentée qui entraîne la bande) : ceux du bout arrière de la
 * chenille, le plus haut s'ils sont empilés (un barbotin relevé, comme sur un char), tous ceux de
 * ce coin si elle est plus large.
 */
export function sprocketRollers<T>(rollers: readonly T[], at: (roller: T) => Vec3): T[] {
  const rearZ = Math.min(...rollers.map((r) => at(r).z));
  const rear = rollers.filter((r) => at(r).z < rearZ + 0.01);
  const topY = Math.max(...rear.map((r) => at(r).y));
  return rear.filter((r) => at(r).y > topY - 0.01);
}
