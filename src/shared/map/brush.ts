import { decodeTerrain, encodeTerrain } from "./codec";
import { MAP_LIMITS, type MapTerrain } from "./format";

/*
 * Pinceaux du relief (l'éditeur de cartes) : monter, creuser, lisser, aplanir à une hauteur donnée
 * ou à celle qu'on a cliquée. Une touche de pinceau (`applyBrush`) change les hauteurs d'un champ
 * qu'on garde pendant tout le coup (`HeightField`, celui du jeu : colonne par x, z croissants), dans
 * un disque, d'autant moins qu'on s'éloigne de son centre ; elle rend la zone touchée, pour que le
 * rendu ne refasse que ce morceau du maillage. Au relâchement, le champ redevient le relief de la
 * carte (`terrainOfField`). Des fonctions pures : tests/mapEditor.test.ts.
 */

/** Ce que fait un pinceau : monter, creuser, lisser, aplanir à `height`, aplanir à la hauteur cliquée (donnée de même). */
export type BrushKind = "raise" | "lower" | "smooth" | "flatten" | "level";
export const BRUSH_KINDS: readonly BrushKind[] = ["raise", "lower", "smooth", "flatten", "level"];

export interface Brush {
  readonly kind: BrushKind;
  /** Rayon (m). */
  readonly radius: number;
  /** Force, de 0 à 1. */
  readonly strength: number;
  /** Hauteur visée (m) : pour aplanir. */
  readonly height?: number;
}

/** Bornes des réglages d'un pinceau (le panneau de l'éditeur les reprend). */
export const BRUSH_LIMITS = { minRadius: 1, maxRadius: 60, minStrength: 0.05, maxStrength: 1 } as const;

/** Des hauteurs qu'on modifie (m), dans l'ordre de `Terrain.heights` : `cells + 1` sommets par côté, espacés de `step` m. */
export interface HeightField {
  readonly cells: number;
  readonly step: number;
  readonly heights: Float32Array;
}

/** Une zone du champ : les sommets de `ix0` à `ix1` et de `iz0` à `iz1` (compris). */
export interface Region {
  readonly ix0: number;
  readonly ix1: number;
  readonly iz0: number;
  readonly iz1: number;
}

/** Ce que fait une touche de pinceau à pleine force, par seconde : mètres montés ou creusés au centre ; part du chemin vers la moyenne ou la hauteur visée. */
const RAISE_RATE = 6;
const SMOOTH_RATE = 8;
const FLAT_RATE = 5;

/** Le champ de hauteurs d'un relief de carte (une copie : on peut la modifier). */
export function fieldOf(terrain: MapTerrain): HeightField | null {
  const t = decodeTerrain(terrain);
  return t ? { cells: t.cells, step: terrain.step, heights: new Float32Array(t.heights) } : null;
}

/** Le relief d'une carte d'après un champ (codé comme `encodeTerrain`). */
export const terrainOfField = (field: HeightField): MapTerrain => encodeTerrain(field.heights, field.cells, field.step);

/** Les sommets d'un disque de rayon `radius` m centré en (x, z) (null s'il est hors du champ). */
export function brushRegion(field: HeightField, x: number, z: number, radius: number): Region | null {
  const half = (field.cells * field.step) / 2;
  const n = field.cells;
  const at = (v: number): number => (v + half) / field.step;
  const ix0 = Math.max(0, Math.ceil(at(x - radius)));
  const ix1 = Math.min(n, Math.floor(at(x + radius)));
  const iz0 = Math.max(0, Math.ceil(at(z - radius)));
  const iz1 = Math.min(n, Math.floor(at(z + radius)));
  return ix0 > ix1 || iz0 > iz1 ? null : { ix0, ix1, iz0, iz1 };
}

/** Poids d'un sommet à `d` m du centre d'un pinceau de rayon `r` : 1 au centre, 0 au bord, en douceur. */
export function brushWeight(d: number, r: number): number {
  const t = 1 - d / r;
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}

/**
 * Une touche de pinceau en (x, z), pendant `dt` s : change `field` sur place, et rend la zone
 * touchée (null si rien n'a changé). Les hauteurs restent dans les bornes des cartes.
 */
export function applyBrush(field: HeightField, brush: Brush, x: number, z: number, dt: number): Region | null {
  const radius = Math.min(BRUSH_LIMITS.maxRadius, Math.max(BRUSH_LIMITS.minRadius, brush.radius));
  const strength = Math.min(BRUSH_LIMITS.maxStrength, Math.max(0, brush.strength));
  const region = brushRegion(field, x, z, radius);
  if (!region || strength <= 0 || dt <= 0) return null;
  const n = field.cells + 1;
  const h = field.heights;
  const half = (field.cells * field.step) / 2;
  // Lisser : la moyenne de chaque sommet et de ses voisins, d'après les hauteurs d'avant la touche
  const before = brush.kind === "smooth" ? h.slice() : null;
  const target = brush.height ?? 0;
  let changed = false;
  for (let ix = region.ix0; ix <= region.ix1; ix++) {
    const vx = -half + ix * field.step;
    for (let iz = region.iz0; iz <= region.iz1; iz++) {
      const w = brushWeight(Math.hypot(vx - x, -half + iz * field.step - z), radius);
      if (w <= 0) continue;
      const k = ix * n + iz;
      const old = h[k];
      let next = old;
      switch (brush.kind) {
        case "raise":
          next = old + RAISE_RATE * strength * dt * w;
          break;
        case "lower":
          next = old - RAISE_RATE * strength * dt * w;
          break;
        case "smooth": {
          let sum = 0;
          let count = 0;
          for (let a = Math.max(0, ix - 1); a <= Math.min(n - 1, ix + 1); a++) {
            for (let b = Math.max(0, iz - 1); b <= Math.min(n - 1, iz + 1); b++) {
              sum += before![a * n + b];
              count++;
            }
          }
          next = old + (sum / count - old) * Math.min(1, SMOOTH_RATE * strength * dt * w);
          break;
        }
        case "flatten":
        case "level":
          next = old + (target - old) * Math.min(1, FLAT_RATE * strength * dt * w);
          break;
      }
      next = Math.min(MAP_LIMITS.maxHeight, Math.max(MAP_LIMITS.minHeight, next));
      if (next !== old) {
        h[k] = next;
        changed = true;
      }
    }
  }
  return changed ? region : null;
}

/** La zone qui couvre deux zones. */
export function unionRegion(a: Region | null, b: Region | null): Region | null {
  if (!a) return b;
  if (!b) return a;
  return { ix0: Math.min(a.ix0, b.ix0), ix1: Math.max(a.ix1, b.ix1), iz0: Math.min(a.iz0, b.iz0), iz1: Math.max(a.iz1, b.iz1) };
}

/** Hauteur du champ en (x, z) (bilinéaire ; au bord, celle du bord). */
export function fieldHeight(field: HeightField, x: number, z: number): number {
  const half = (field.cells * field.step) / 2;
  const fx = Math.min(Math.max((x + half) / field.step, 0), field.cells - 1e-6);
  const fz = Math.min(Math.max((z + half) / field.step, 0), field.cells - 1e-6);
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const u = fx - ix;
  const v = fz - iz;
  const n = field.cells + 1;
  const h = field.heights;
  const a = h[ix * n + iz];
  const b = h[(ix + 1) * n + iz];
  const c = h[ix * n + iz + 1];
  const d = h[(ix + 1) * n + iz + 1];
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}
