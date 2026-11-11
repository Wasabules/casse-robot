import { MAP_FORMAT, type MapFile } from "./format";
import { terrainFromImage, type HeightImage } from "./heightmap";

/*
 * Une carte de départ, valide : un terrain plat entouré de montagnes, trois zones, les lignes de
 * départ par défaut. L'éditeur part de là (ou d'un relief importé, `withTerrain`).
 */

export interface BlankMapOptions {
  readonly name: string;
  readonly author: string;
  readonly license?: string;
  /** Demi-côté de la zone de jeu (m) ; le relief la déborde de ses montagnes. */
  readonly half?: number;
  /** Hauteur du sol (m). */
  readonly level?: number;
}

/** Le côté du relief (m, multiple de 4 : un nombre pair de cases de 2 m) pour une zone de jeu de ±`half` m et ses montagnes. */
export const terrainSideFor = (half: number): number => Math.min(440, 4 * Math.ceil((half + 45) / 2));

export function blankMap(options: BlankMapOptions): MapFile {
  const half = options.half ?? 80;
  const level = options.level ?? 2;
  const step = 2;
  const cells = terrainSideFor(half) / step;
  const flat: HeightImage = { width: 2, height: 2, data: new Float32Array(4), bits: 16 };
  return {
    format: MAP_FORMAT,
    meta: { name: options.name, author: options.author, license: options.license ?? "CC-BY-4.0" },
    terrain: terrainFromImage(flat, { cells, step, low: level, high: level, mountains: { from: half + 6, height: 30 } }),
    bounds: { half },
    zones: [
      { label: "A", x: half * 0.5, z: 0, radius: 6 },
      { label: "B", x: 0, z: 0, radius: 6 },
      { label: "C", x: -half * 0.5, z: 0, radius: 6 },
    ],
  };
}
