import { terrainCodes, toBase64 } from "./codec";
import { MAP_LIMITS, type MapFile, type MapTerrain } from "./format";
import { decodePng, type HeightImage, type Inflate } from "./heightmap";
import { encodePng, type Deflate } from "./png";
import { readMap, type ReadResult } from "./read";

/*
 * Paquet de carte : un dossier plutôt qu'un fichier, que d'autres outils lisent et écrivent sans
 * décoder de base64. `map.json` : la carte, dont le relief nomme son image (`terrain.image`) au lieu
 * de porter ses hauteurs ; `terrain.png` : le relief en PNG gris 16 bits, chaque pixel le code de sa
 * hauteur (0 : `min`, 65 535 : `max`), le haut au nord et la gauche à l'ouest, comme une image de
 * relief qu'on importe ; `LICENSE.txt` : la licence (l'outil l'écrit). Un paquet et un fichier
 * .casse-map.json se convertissent l'un en l'autre sans rien perdre (`npm run map:pack`,
 * `npm run map:unpack`, tools/maps/) ; le jeu et le serveur ne lisent pas encore les paquets.
 */

/** Les fichiers d'un paquet. */
export const PACKAGE_FILES = { map: "map.json", terrain: "terrain.png", license: "LICENSE.txt" } as const;

/** Le relief d'un paquet : ses dimensions, et le nom de son image dans le paquet. */
export type PackedTerrain = Omit<MapTerrain, "heights"> & { readonly image: string };
/** La carte d'un paquet (`map.json`). */
export type PackedMap = Omit<MapFile, "terrain"> & { readonly terrain?: PackedTerrain };

/** Un paquet : sa carte, et l'image de son relief (null sans relief). */
export interface MapPackage {
  readonly map: PackedMap;
  readonly terrain: Uint8Array | null;
}

/** Le nom d'une image du paquet : un simple nom de fichier PNG, dans le dossier du paquet. */
const IMAGE_NAME = /^[\w.-]+\.png$/i;

/** L'image de relief que nomme la carte d'un paquet (un nom de fichier sûr), ou null. */
export function packageImage(json: unknown): string | null {
  const terrain = json && typeof json === "object" ? (json as { terrain?: unknown }).terrain : undefined;
  const image = terrain && typeof terrain === "object" ? (terrain as { image?: unknown }).image : undefined;
  return typeof image === "string" && IMAGE_NAME.test(image) && image !== ".png" ? image : null;
}

/** Sommet (ix, iz) du relief → pixel (ligne, colonne) de l'image : le nord en haut, l'ouest à gauche (voir `imageFromHeights`). */
const pixelOf = (cells: number, ix: number, iz: number): number => (cells - iz) * (cells + 1) + (cells - ix);

/** Une carte (déjà lue) en paquet : son relief en image, au code près. */
export async function packMap(map: MapFile, deflate: Deflate): Promise<MapPackage> {
  const { terrain, ...rest } = map;
  if (!terrain) return { map: rest, terrain: null };
  const codes = terrainCodes(terrain);
  if (!codes) throw new Error("Relief illisible : rien à mettre en paquet");
  const n = terrain.cells + 1;
  const data = new Float32Array(n * n);
  for (let ix = 0; ix < n; ix++) for (let iz = 0; iz < n; iz++) data[pixelOf(terrain.cells, ix, iz)] = codes[ix * n + iz] / 65535;
  const png = await encodePng({ width: n, height: n, data, bits: 16 }, deflate, 16);
  const packed: PackedTerrain = { cells: terrain.cells, step: terrain.step, min: terrain.min, max: terrain.max, image: PACKAGE_FILES.terrain };
  return { map: { ...rest, terrain: packed }, terrain: png };
}

/**
 * La carte d'un paquet : sa carte (`map.json`, déjà décodée) et l'image de son relief, relues et
 * vérifiées comme un fichier de carte (`readMap`). Une image illisible, qui n'a pas la taille du
 * relief ou pas 16 bits : `terrainData`. Un relief qui garde ses hauteurs (`heights`) se lit tel quel.
 */
export async function unpackMap(json: unknown, image: Uint8Array | null, inflate: Inflate): Promise<ReadResult> {
  if (!json || typeof json !== "object" || Array.isArray(json)) return { ok: false, issues: [{ code: "json" }] };
  const raw = json as Record<string, unknown>;
  const terrain = raw.terrain;
  if (!terrain || typeof terrain !== "object" || Array.isArray(terrain) || "heights" in terrain) return readMap(raw);
  const { image: _name, ...dims } = terrain as Record<string, unknown>;
  // (une taille hors des bornes : la lecture le dit, sans décoder l'image)
  const cells = dims.cells;
  if (typeof cells !== "number" || !Number.isInteger(cells) || cells < MAP_LIMITS.minCells || cells > MAP_LIMITS.maxCells) {
    return readMap({ ...raw, terrain: { ...dims, heights: "" } });
  }
  if (!image) return { ok: false, issues: [{ code: "terrainData" }] };
  let img: HeightImage;
  try {
    img = await decodePng(image, inflate);
  } catch {
    return { ok: false, issues: [{ code: "terrainData" }] };
  }
  const n = cells + 1;
  if (img.width !== n || img.height !== n || img.bits !== 16) return { ok: false, issues: [{ code: "terrainData" }] };
  const bytes = new Uint8Array(n * n * 2);
  const view = new DataView(bytes.buffer);
  for (let ix = 0; ix < n; ix++) {
    for (let iz = 0; iz < n; iz++) view.setUint16((ix * n + iz) * 2, Math.round(img.data[pixelOf(cells, ix, iz)] * 65535), true);
  }
  return readMap({ ...raw, terrain: { ...dims, heights: toBase64(bytes) } });
}
