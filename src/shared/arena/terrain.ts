import { clamp } from "../math/scalar";
import type { Vec3 } from "../math/vec";

/*
 * Relief d'une arène : un carré de `size` m de côté, centré sur l'origine, découpé en `cells` cases
 * par côté, avec une hauteur à chaque sommet. La physique en fait un champ de hauteurs Rapier
 * (arena.ts), le client un maillage (client/render/arenaView.ts) ; la caméra, l'IA et les
 * apparitions lisent la hauteur du sol ici, sans physique (elle marche aussi en réseau).
 */

export interface Terrain {
  readonly size: number;
  readonly cells: number;
  /**
   * Hauteurs aux sommets (m), dans l'ordre qu'attend Rapier : colonne par colonne, une colonne par
   * x (de -size/2 à size/2), et dans chacune les z croissants (indice ix·(cells+1) + iz).
   */
  readonly heights: Float32Array;
}

/** Relief d'après une fonction de hauteur pure, échantillonnée à chaque sommet. */
export function makeTerrain(size: number, cells: number, height: (x: number, z: number) => number): Terrain {
  const n = cells + 1;
  const heights = new Float32Array(n * n);
  const step = size / cells;
  for (let ix = 0; ix < n; ix++) {
    for (let iz = 0; iz < n; iz++) heights[ix * n + iz] = height(-size / 2 + ix * step, -size / 2 + iz * step);
  }
  return { size, cells, heights };
}

/** Hauteur d'un sommet (indices bornés à la grille). */
function vertex(t: Terrain, ix: number, iz: number): number {
  const n = t.cells + 1;
  return t.heights[clamp(ix, 0, t.cells) * n + clamp(iz, 0, t.cells)];
}

/**
 * Hauteur du sol en (x, z) (m), interpolée comme le fait Rapier : chaque case est coupée en deux
 * triangles le long de sa diagonale. Hors du carré, celle de son bord.
 */
export function terrainHeight(t: Terrain, x: number, z: number): number {
  const step = t.size / t.cells;
  const fx = clamp((x + t.size / 2) / step, 0, t.cells - 1e-6);
  const fz = clamp((z + t.size / 2) / step, 0, t.cells - 1e-6);
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const u = fx - ix;
  const v = fz - iz;
  const h00 = vertex(t, ix, iz);
  const h10 = vertex(t, ix + 1, iz);
  const h01 = vertex(t, ix, iz + 1);
  const h11 = vertex(t, ix + 1, iz + 1);
  // Diagonale de (ix+1, iz) à (ix, iz+1)
  return u + v < 1 ? h00 + (h10 - h00) * u + (h01 - h00) * v : h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
}

/**
 * Distance le long du rayon (`dir` unitaire) où il entre dans le relief, au plus `maxDist` m ; null
 * s'il ne le touche pas. Par pas d'un mètre, puis affiné : assez pour la caméra.
 */
export function rayTerrain(t: Terrain, origin: Vec3, dir: Vec3, maxDist: number): number | null {
  const below = (d: number): boolean => origin.y + dir.y * d < terrainHeight(t, origin.x + dir.x * d, origin.z + dir.z * d);
  if (below(0)) return null;
  const STEP = 1;
  for (let d = STEP; d <= maxDist + STEP; d += STEP) {
    const end = Math.min(d, maxDist);
    if (!below(end)) {
      if (end >= maxDist) return null;
      continue;
    }
    // Entre end - STEP (au-dessus) et end (dessous) : dichotomie
    let lo = end - STEP;
    let hi = end;
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) / 2;
      if (below(mid)) hi = mid;
      else lo = mid;
    }
    return lo;
  }
  return null;
}

/** Lissage d'Hermite de 0 (en `a`) à 1 (en `b`). */
export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Hasard fixe d'un point entier du plan, de -1 à 1 (le même partout, sans `rand` : c'est une donnée). */
function hash2(ix: number, iz: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

/** Bruit de valeur lissé, de -1 à 1, dont les bosses font à peu près une unité de large. */
export function noise2(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const u = smoothstep(0, 1, x - ix);
  const v = smoothstep(0, 1, z - iz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
