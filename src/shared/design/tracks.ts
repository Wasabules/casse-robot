import type { WheelTypeDef } from "../catalog/wheels";
import { BLOCK_SIZE } from "../config";
import type { Vec3 } from "../math/vec";

/*
 * Chenilles d'un plan (géométrie pure) : les galets voisins d'un même flanc forment une chenille,
 * dont la bande fait le tour. Le rendu en tire sa bande et ses patins (client/render/trackShape.ts),
 * l'encombrement la place qu'elle prend (design/clearance.ts).
 */

/**
 * Rayon du parcours de la bande au-delà de celui des galets (m) : c'est le bout des crampons de ses
 * patins, qui mordent un peu dans le sol où le galet, lui, se pose (sa roue par lancer de rayon a le
 * rayon du catalogue). Plaque des patins, bande de dessous et roues du galet sont en dedans
 * (client/render/models/tracks.ts).
 */
export const BELT_CLEARANCE = 0.01;
/** La bande déborde un peu des galets de chaque côté (m). */
export const BELT_MARGIN = 0.03;
/** Deux galets sont d'une même chenille à moins de deux cases l'un de l'autre le long du flanc, et d'une case en hauteur. */
const LINK_ALONG = BLOCK_SIZE * 2.1;
const LINK_HEIGHT = BLOCK_SIZE * 1.1;

/**
 * Groupes de galets qui forment chacun une chenille : du même côté du robot, voisins le long du
 * flanc, en hauteur, ou l'un sur l'autre vers l'extérieur (de proche en proche).
 */
export function trackGroups<T>(rollers: readonly T[], at: (roller: T) => Vec3, def: WheelTypeDef): T[][] {
  const parent = rollers.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  const pos = rollers.map(at);
  for (let i = 0; i < rollers.length; i++) {
    for (let j = i + 1; j < rollers.length; j++) {
      const [a, b] = [pos[i], pos[j]];
      if (Math.sign(a.x) !== Math.sign(b.x)) continue;
      if (Math.abs(a.x - b.x) > def.width + 0.01 || Math.abs(a.y - b.y) > LINK_HEIGHT || Math.abs(a.z - b.z) > LINK_ALONG) continue;
      parent[root(i)] = root(j);
    }
  }
  const groups = new Map<number, T[]>();
  rollers.forEach((r, i) => groups.set(root(i), [...(groups.get(root(i)) ?? []), r]));
  return [...groups.values()];
}
