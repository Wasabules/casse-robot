import { clamp } from "../math/scalar";

/*
 * Ce qu'une arène peut avoir en plus de son décor : de la lave qui brûle ce qui s'y tient, une eau
 * profonde qui noie (une vraie limite, que l'IA évite), une grille de passage pour l'IA (pentes
 * trop raides, lave, mer : voir arena/navgrid.ts), une palette de sol, des fumerolles et des
 * cascades (dessinées par le client). Tout est facultatif : une arène qui ne les déclare pas se
 * comporte comme avant. Des données pures, statiques : rien de tout cela ne passe par le réseau.
 */

/**
 * Lave : une coulée (une ligne brisée (x, z), large de `width` m) ou un lac (un disque). Sa surface
 * est le relief lui-même (le relief se creuse un peu sous elle) : elle brûle ce qui s'y tient à
 * moins de `LAVA_HEIGHT` m au-dessus (voir sim/hazards.ts).
 */
export type LavaShape =
  | { readonly kind: "flow"; readonly width: number; readonly points: readonly (readonly [number, number])[] }
  | { readonly kind: "pool"; readonly x: number; readonly z: number; readonly r: number };

/** Une fumerolle : un panache de fumée (le cratère d'un volcan, une fissure, la vapeur de la lave dans la mer). */
export interface Vent {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Taille du panache (1 : une fissure ; 4 : le cratère). */
  readonly size: number;
  /** Vapeur blanche (lave dans l'eau) plutôt que fumée grise. */
  readonly steam?: boolean;
}

/** Une cascade : un rideau d'eau de `width` m, de `top` à `bottom` (m), en (x, z), qui tombe vers `dir` (rad, autour de la verticale). */
export interface Waterfall {
  readonly x: number;
  readonly z: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly dir: number;
}

/**
 * Palette du sol d'une arène (couleurs « #rrggbb ») ; sans palette, celle de la Vallée (herbe,
 * terre, sable des berges, roche des pentes, neige des sommets : client/render/arenaView.ts,
 * `groundColor`).
 */
export interface GroundStyle {
  /** Le sol : deux teintes mêlées par un bruit (l'herbe, le sable du désert). */
  readonly base: readonly [string, string];
  /** Taches mêlées au sol, et les chemins. */
  readonly dirt: string;
  /** Berges, puis fond sous l'eau. */
  readonly sand: string;
  readonly mud: string;
  /** Pentes raides et hauteurs. */
  readonly rock: string;
  /** Au-dessus de `peakLine` m : la cendre d'un volcan, la neige d'une montagne. */
  readonly peak: string;
  /** Au-dessus de cette hauteur, la roche, puis le sommet (m). */
  readonly rockLine: number;
  readonly peakLine: number;
  /** Largeur de la plage au-dessus de l'eau (m de hauteur ; 0,6 sans elle). */
  readonly beach?: number;
  /** Sol figé autour de la lave (basalte noir), et sur quelle largeur (m). */
  readonly basalt?: string;
  readonly basaltWidth?: number;
  /**
   * Strates des falaises : sur les pentes raides, des bandes de roche selon la hauteur, une toutes
   * les `strataStep` m (les couches du grès sur une paroi de canyon).
   */
  readonly strata?: readonly string[];
  readonly strataStep?: number;
  /** Taches de couleur : un disque (`r` m) où le sol prend cette teinte, fondue vers son bord (l'herbe d'une oasis). */
  readonly patches?: readonly { readonly x: number; readonly z: number; readonly r: number; readonly color: string }[];
  /** Taille du motif des deux teintes du sol (m ; 9 sans elle) : les dalles d'une ville sont plus serrées. */
  readonly grain?: number;
  /** Part des taches de terre (0,25 sans elle) : la crasse d'une ville. */
  readonly stains?: number;
  /**
   * Les pentes : leur teinte (la roche sans elle ; les talus de terre d'une ville), à partir de
   * quelle composante verticale de la normale (0,82 sans elle) et sur quel écart (0,18).
   */
  readonly slope?: { readonly color?: string; readonly from: number; readonly span: number };
  /** Écart de hauteur (m) sur lequel le sol passe à la roche au-dessus de `rockLine` (10 sans lui). */
  readonly rockSpan?: number;
  /** Teinte des chemins d'herbe (une pelouse) ; sans elle, le sol éclairci (l'herbe rase d'une piste). */
  readonly lawn?: string;
}

/**
 * `peakLine` d'une arène sans sommets (ni neige ni cendre) : au-dessus de tout relief (une carte
 * monte à 250 m au plus, `MAP_LIMITS.maxHeight`). Un nombre fini, pour qu'elle s'écrive en carte
 * (JSON ne connaît pas l'infini).
 */
export const NO_PEAK = 300;

/** La palette par défaut, celle de la Vallée : herbe, terre, sable des berges, roche des pentes, neige des sommets. */
export const VALLEY_GROUND: GroundStyle = {
  base: ["#5f7f3b", "#7a8f46"], dirt: "#8a7456", sand: "#a39470", mud: "#5f5845", rock: "#7a766e", peak: "#eef1f3",
  rockLine: 12, peakLine: 36,
};

/**
 * Grille de passage de l'IA (voir arena/navgrid.ts) : des cases de `cell` m ; une case est
 * infranchissable si sa pente dépasse `maxSlope` (rad), si elle est dans la lave ou dans l'eau
 * profonde. Les tabliers (ponts, pontons) la franchissent.
 */
export interface NavGridSpec {
  readonly cell: number;
  readonly maxSlope: number;
}

/** Hauteur au-dessus de la lave jusqu'à laquelle elle brûle (m). */
export const LAVA_HEIGHT = 1.3;

/** Distance (m) d'un point au segment [a, b] du plan. */
export function segmentDistance(x: number, z: number, a: readonly [number, number], b: readonly [number, number]): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const t = clamp(((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1), 0, 1);
  return Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t);
}

/** Profondeur (m) d'un point dans une forme de lave : > 0 dedans (sa distance au bord), < 0 dehors. */
export function lavaDepth(shape: LavaShape, x: number, z: number): number {
  if (shape.kind === "pool") return shape.r - Math.hypot(x - shape.x, z - shape.z);
  let best = Infinity;
  for (let i = 1; i < shape.points.length; i++) best = Math.min(best, segmentDistance(x, z, shape.points[i - 1], shape.points[i]));
  return shape.width / 2 - best;
}

/** Emprise d'une forme de lave (m), pour écarter vite ce qui en est loin. */
export function lavaBounds(shape: LavaShape): { minX: number; maxX: number; minZ: number; maxZ: number } {
  if (shape.kind === "pool") return { minX: shape.x - shape.r, maxX: shape.x + shape.r, minZ: shape.z - shape.r, maxZ: shape.z + shape.r };
  const w = shape.width / 2;
  const xs = shape.points.map((p) => p[0]);
  const zs = shape.points.map((p) => p[1]);
  return { minX: Math.min(...xs) - w, maxX: Math.max(...xs) + w, minZ: Math.min(...zs) - w, maxZ: Math.max(...zs) + w };
}

/** Emprises des formes de lave, calculées une fois (les arènes sont des données fixes). */
const BOUNDS = new WeakMap<LavaShape, ReturnType<typeof lavaBounds>>();

/** Profondeur dans la lave la plus proche (m) : > 0 dans la lave ; -Infinity s'il n'y en a pas. `margin` élargit la recherche. */
export function lavaAt(lava: readonly LavaShape[] | undefined, x: number, z: number, margin = 0): number {
  if (!lava) return -Infinity;
  let best = -Infinity;
  for (const shape of lava) {
    let b = BOUNDS.get(shape);
    if (!b) {
      b = lavaBounds(shape);
      BOUNDS.set(shape, b);
    }
    if (x < b.minX - margin || x > b.maxX + margin || z < b.minZ - margin || z > b.maxZ + margin) continue;
    best = Math.max(best, lavaDepth(shape, x, z));
  }
  return best;
}
