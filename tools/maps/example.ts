import { noise2, smoothstep } from "../../src/shared/arena/terrain";
import {
  decodePng, encodePng, MAP_FORMAT, terrainFromImage, type Deflate, type HeightImage, type Inflate, type MapFile, type MapPrefab, type MapProp,
} from "../../src/shared/map";

/*
 * La carte d'exemple, « Val du Lac », faite par le format comme le ferait un auteur : un relief
 * dessiné en image PNG 16 bits (ici calculé : des collines, un lac, une rivière), importé au pas de
 * 2 m avec des montagnes au bord, puis des éléments de jeu. `npm run map:example` la refait
 * (maps/val-du-lac.casse-map.json, et son relief source tools/maps/val-du-lac.png).
 *
 * Nord = +z (les rouges partent du nord), ouest = +x. La carte est symétrique par rapport à l'axe
 * est-ouest (z → -z) : chaque équipe a son village (le village au nord, la ferme au sud), et les
 * mêmes distances au lac (à l'ouest), au vieux pont (au centre) et à la ruine (à l'est).
 */

/** Côté du relief (m) et de l'image source (pixels), hauteur du blanc de l'image (m). */
const SIDE = 320;
const PIXELS = 257;
const WHITE = 12;
/** Le fond du val, l'eau (m). */
const BASE = 3.2;
const WATER = 2;
/** Le lac, à l'ouest ; la colline au-delà ; la butte de la ruine, à l'est. */
const LAKE = { x: 50, z: 0, r: 24 };
const HILL = { x: 95, z: 0, top: 9.5, flat: 9, foot: 30 };
const MOUND = { x: -95, z: 0, top: 5, flat: 7, foot: 20 };
/** Le village (nord-est), la ferme (sud-est). */
const VILLAGE = { x: -55, z: 45, h: 3.6 };
const FARM = { x: -55, z: -45, h: 3.6 };
/** Le vieux pont : son axe (x), son tablier (m). */
const BRIDGE_X = -20;
const DECK = 3.4;

/** La rivière : elle sort du lac vers l'est, en méandres (ligne médiane z selon x). */
const riverZ = (x: number): number => 5 * Math.sin((x - 30) / 22);

type Flat = { h: number; fall: number } & ({ x: number; z: number; r: number } | { minX: number; maxX: number; minZ: number; maxZ: number });

const FLATS: readonly Flat[] = [
  // Les lignes de départ
  { minX: -40, maxX: 40, minZ: 70, maxZ: 94, h: BASE, fall: 12 },
  { minX: -40, maxX: 40, minZ: -94, maxZ: -70, h: BASE, fall: 12 },
  { x: VILLAGE.x, z: VILLAGE.z, r: 20, h: VILLAGE.h, fall: 10 },
  { x: FARM.x, z: FARM.z, r: 20, h: FARM.h, fall: 10 },
];

function flatWeight(f: Flat, x: number, z: number): number {
  const out = "r" in f
    ? Math.max(0, Math.hypot(x - f.x, z - f.z) - f.r)
    : Math.hypot(Math.max(0, f.minX - x, x - f.maxX), Math.max(0, f.minZ - z, z - f.maxZ));
  return 1 - smoothstep(0, f.fall, out);
}

/** Le relief (m), avant les montagnes du bord (ajoutées à l'import). Symétrique par rapport à z = 0. */
function height(x: number, zz: number): number {
  const z = Math.abs(zz);
  let h = BASE + 0.6 * noise2(x / 40, z / 40) + 0.3 * noise2(x / 15 + 30, z / 15 - 12);
  for (const f of FLATS) h += (f.h - h) * flatWeight(f, x, z);
  // La colline de l'ouest : un plateau, des flancs doux (moins de 20°)
  h = Math.max(h, BASE + (HILL.top - BASE) * (1 - smoothstep(HILL.flat, HILL.foot, Math.hypot(x - HILL.x, z - HILL.z))));
  // La butte de la ruine, à l'est
  h = Math.max(h, BASE + (MOUND.top - BASE) * (1 - smoothstep(MOUND.flat, MOUND.foot, Math.hypot(x - MOUND.x, z - MOUND.z))));
  // Le lac : profond en son milieu (on s'y noie), des berges en pente douce
  h -= 3 * (1 - smoothstep(9, LAKE.r, Math.hypot(x - LAKE.x, z - LAKE.z)));
  // La rivière, peu profonde : on la passe à gué partout, le pont est plus sûr
  if (x < LAKE.x - 14) h -= 1.9 * (1 - smoothstep(3, 11, Math.abs(zz - riverZ(x)))) * (1 - smoothstep(LAKE.x - 20, LAKE.x - 14, x));
  // Les culées du pont : le sol monte jusqu'au tablier, à ses deux bouts
  const abut = 1 - smoothstep(0, 6, Math.hypot(Math.max(0, Math.abs(x - BRIDGE_X) - 4), Math.max(0, 11 - z, z - 17)));
  h += (DECK - h) * abut;
  return Math.max(0.2, h);
}

/** L'image de hauteurs : le haut au nord (+z), la gauche à l'ouest (+x). */
function reliefImage(): HeightImage {
  const data = new Float32Array(PIXELS * PIXELS);
  for (let row = 0; row < PIXELS; row++) {
    for (let col = 0; col < PIXELS; col++) {
      const x = SIDE / 2 - (col / (PIXELS - 1)) * SIDE;
      const z = SIDE / 2 - (row / (PIXELS - 1)) * SIDE;
      data[row * PIXELS + col] = Math.min(1, height(x, z) / WHITE);
    }
  }
  return { width: PIXELS, height: PIXELS, data, bits: 16 };
}

/** Ce qu'on pose au nord se pose aussi au sud, en miroir (z → -z). */
const mirrored = <T extends { z: number; yaw?: number }>(list: readonly T[]): T[] =>
  list.flatMap((item) => [item, { ...item, z: -item.z, ...(item.yaw !== undefined ? { yaw: 180 - item.yaw } : {}) }]);

function prefabs(): MapPrefab[] {
  const v = VILLAGE;
  const f = FARM;
  return [
    // Le village (nord-est) : des maisons de briques autour d'une place, l'église et son clocher
    { kind: "house", x: v.x + 11, z: v.z + 8, width: 8, depth: 6, height: 3.2, wall: "brick", roof: "roof", door: 2, yaw: 180 },
    { kind: "house", x: v.x - 11, z: v.z + 8, width: 7, depth: 6, height: 3.2, wall: "brick", roof: "roof", door: 2, yaw: 180 },
    { kind: "house", x: v.x + 12, z: v.z - 8, width: 7, depth: 6, height: 3.2, wall: "brick", roof: "roof" },
    { kind: "house", x: v.x - 13, z: v.z - 7, width: 8, depth: 6, height: 3.2, wall: "plank", roof: "roof", yaw: 90 },
    { kind: "house", x: v.x, z: v.z + 15, width: 11, depth: 7, height: 5, wall: "brick", roof: "roof", door: 3, yaw: 180 },
    { kind: "fence", points: [[v.x + 17, v.z - 14], [v.x + 9, v.z - 14], [v.x + 9, v.z - 5]], material: "plank" },
    // La ferme (sud-est) : la grange qu'on traverse, la maison, un hangar, l'enclos
    { kind: "house", x: f.x + 8, z: f.z - 14, width: 13, depth: 8, height: 4.5, wall: "plank", roof: "sheet", door: 5, through: true, yaw: 90 },
    { kind: "house", x: f.x - 11, z: f.z + 8, width: 8, depth: 6, height: 3.2, wall: "brick", roof: "roof", door: 2 },
    { kind: "house", x: f.x - 13, z: f.z - 10, width: 6, depth: 5, height: 3, wall: "sheet", roof: "sheet", roofKind: "flat", door: 3 },
    { kind: "fence", points: [[f.x + 16, f.z + 2], [f.x + 16, f.z + 12], [f.x + 4, f.z + 12]], material: "plank" },
    // La colline de l'ouest : un blockhaus de béton et des sacs de sable (zone A)
    { kind: "house", x: HILL.x + 6, z: HILL.z + 6, width: 5, depth: 4.5, height: 2.6, wall: "concrete", roof: "concrete", roofKind: "flat", door: 1.8, yaw: 90 },
    // La ruine de l'est : un immeuble éventré sur sa butte (zone E)
    { kind: "tenement", x: MOUND.x - 6, z: MOUND.z, width: 12, depth: 8, floors: 2, wall: "facade", doors: [["w", 1], ["s", 0]], ruin: 0.5, seed: 3, yaw: 90 },
    // Le vieux pont de pierre, dans l'axe nord-sud (zone C)
    { kind: "bridge", from: [BRIDGE_X, -15], to: [BRIDGE_X, 15], width: 7, y: DECK, piers: 2 },
    // Les bois de l'ouest, de part et d'autre du lac, des bosquets, des rochers
    ...mirrored<MapPrefab & { kind: "woods" }>([
      { kind: "woods", x: 48, z: 52, radius: 24, count: 26, trees: ["pine", "pine", "oak"], seed: 11 },
      { kind: "woods", x: -100, z: 62, radius: 14, count: 10, trees: ["pine"], seed: 12 },
      { kind: "woods", x: 8, z: 38, radius: 8, count: 5, trees: ["oak"], seed: 13 },
    ]).map((w, i) => ({ ...w, seed: (w.seed ?? 0) + (i % 2) * 100 })),
    ...mirrored<MapPrefab & { kind: "rocks" }>([
      { kind: "rocks", x: 22, z: 28, radius: 10, count: 4, seed: 21 },
      { kind: "rocks", x: 78, z: 22, radius: 7, count: 3, size: [1.2, 2.2], seed: 22 },
      { kind: "rocks", x: -78, z: 20, radius: 8, count: 3, seed: 23 },
    ]),
  ];
}

function props(): MapProp[] {
  const v = VILLAGE;
  const f = FARM;
  return [
    // La place du village : des caisses, deux barils ; le clocher est une boîte (plus bas)
    { type: "crate", x: v.x + 3, z: v.z + 2 }, { type: "crate", x: v.x + 4.05, z: v.z + 2 }, { type: "barrel", x: v.x - 4, z: v.z - 2 },
    // La ferme : du fourrage en caisses, une citerne de carburant, des barils
    { type: "crate", x: f.x + 9, z: f.z + 6 }, { type: "crate", x: f.x + 9, z: f.z + 7.05 }, { type: "crate", x: f.x + 9.5, z: f.z + 6.5, y: f.h + 1 },
    { type: "tank", x: f.x - 2, z: f.z - 16 }, { type: "barrel", x: f.x - 5, z: f.z - 14 }, { type: "barrel", x: f.x - 4.2, z: f.z - 14.8 },
    // Le blockhaus : une bouteille de gaz
    { type: "gas", x: HILL.x - 3, z: HILL.z - 3 },
    // Des chênes isolés dans les champs
    ...mirrored([{ type: "oak", x: -20, z: 55, scale: 1.1 }, { type: "oak", x: 30, z: 72, scale: 0.9 }, { type: "oak", x: -78, z: 75, scale: 1 }] as MapProp[]),
  ];
}

/** La carte d'exemple, et son relief source en PNG 16 bits (décodé puis importé comme le ferait un auteur). */
export async function exampleMap(deflate: Deflate, inflate: Inflate): Promise<{ map: MapFile; png: Uint8Array }> {
  const png = await encodePng(reliefImage(), deflate, 16);
  const image = await decodePng(png, inflate);
  const terrain = terrainFromImage(image, { cells: 160, step: 2, low: 0, high: WHITE, mountains: { from: 108, height: 38 } });
  const map: MapFile = {
    format: MAP_FORMAT,
    meta: {
      name: "Val du Lac",
      names: { en: "Lake Vale" },
      author: "Casse-Robot",
      description: "Un val entre les montagnes : un lac profond à l'ouest et sa colline, une rivière qu'enjambe un vieux pont, un village au nord, une ferme au sud, une ruine à l'est.",
      descriptions: { en: "A vale among mountains: a deep lake to the west and its hill, a river spanned by an old bridge, a village to the north, a farm to the south, a ruin to the east." },
      license: "CC0-1.0",
    },
    terrain,
    bounds: { half: 100, roam: 88, spawnLine: 80, spawnSpread: 26, circuit: 70 },
    limits: { bound: 140 },
    water: { level: WATER, deep: 1.2 },
    ambience: "valley",
    paths: [
      // Des lignes de départ au vieux pont, et du pont au village, à la ferme, à la ruine, à la colline
      ...[1, -1].map((s) => ({ width: 5, points: [[0, s * 76], [-8, s * 46], [BRIDGE_X, s * 18]] as [number, number][] })),
      ...[1, -1].map((s) => ({ width: 4, points: [[-8, s * 46], [-30, s * 44], [VILLAGE.x + 6, s * VILLAGE.z]] as [number, number][] })),
      ...[1, -1].map((s) => ({ width: 4, points: [[BRIDGE_X + 2, s * 20], [20, s * 26], [60, s * 30], [HILL.x - 6, s * 8]] as [number, number][] })),
      { width: 4, points: [[BRIDGE_X - 4, 18], [-60, 20], [MOUND.x + 6, 4]] },
      { width: 4, points: [[BRIDGE_X - 4, -18], [-60, -20], [MOUND.x + 6, -4]] },
    ],
    boxes: [
      // Le clocher de l'église du village, et la cheminée de la ferme : des repères
      { kind: "pillar", x: VILLAGE.x, z: VILLAGE.z + 21, size: [2.6, 13, 2.6] },
      { kind: "pillar", x: FARM.x - 15, z: FARM.z - 4, size: [1, 7, 1] },
      // Les sacs de sable autour du blockhaus
      { kind: "barrier", x: HILL.x - 7, z: HILL.z + 5, size: [0.8, 1.1, 5] },
      { kind: "barrier", x: HILL.x - 7, z: HILL.z - 5, size: [0.8, 1.1, 5] },
      { kind: "barrier", x: HILL.x + 2, z: HILL.z - 8, size: [5, 1.1, 0.8] },
    ],
    props: props(),
    prefabs: prefabs(),
    zones: [
      { label: "A", x: HILL.x - 2, z: HILL.z, radius: 6 },
      { label: "B", x: VILLAGE.x, z: VILLAGE.z, radius: 7 },
      { label: "C", x: BRIDGE_X, z: 0, y: DECK, radius: 5 },
      { label: "D", x: FARM.x, z: FARM.z, radius: 7 },
      { label: "E", x: MOUND.x + 5, z: MOUND.z, radius: 6 },
    ],
    places: [
      { name: "Le lac", names: { en: "The lake" }, x: LAKE.x, z: LAKE.z },
      { name: "La colline", names: { en: "The hill" }, x: HILL.x, z: HILL.z + 8 },
      { name: "Le village", names: { en: "The village" }, x: VILLAGE.x, z: VILLAGE.z + 4 },
      { name: "La ferme", names: { en: "The farm" }, x: FARM.x, z: FARM.z - 4 },
      { name: "Le vieux pont", names: { en: "The old bridge" }, x: BRIDGE_X, z: 4 },
      { name: "La ruine", names: { en: "The ruin" }, x: MOUND.x, z: MOUND.z + 6 },
    ],
  };
  return { map, png };
}
