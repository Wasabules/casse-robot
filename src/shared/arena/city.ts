import { CAR_HALF, type PropType } from "../catalog/props";
import { axisAngle, NO_ROTATION, qmul, vec3, type Quat, type Vec3 } from "../math/vec";
import { barrier, box, incline, zone } from "./builders";
import { NO_PEAK } from "./features";
import type { ArenaLayout, ArenaPlace, CaptureZone, PropSpot, StaticBox, TerrainPath } from "./layout";
import { makeTerrain, noise2, smoothstep } from "./terrain";
import { PropList } from "./valley";
import { dcos, dsin } from "../math/det";

/*
 * La Cité : une ville en ruines (±94 m de rues entre les remblais de gravats et les immeubles
 * éventrés du bord), pour le combat urbain. Un quadrillage de rues autour d'une grande place et
 * de son monument ; à l'est, une voie rapide surélevée sur ses piles, où l'on monte par les remblais
 * de ses deux bouts ; à l'ouest, la gare, ses voies au fond d'une tranchée et son quai ; au
 * nord-est un parc et sa butte, au sud-ouest une tour en ruine et un parking à étage. Les immeubles
 * sont des pans de façade ancrés, un par étage : on abat un pan, ce qui le surmonte s'effondre, et
 * le toit tombe quand plus rien ne le porte.
 *
 * Nord = +z (les rouges partent du nord, les bleus du sud), ouest = +x, comme dans la Vallée. La
 * carte est symétrique par rapport au centre (la voie rapide et la gare, le parc et le parking,
 * chaque îlot et le sien) : aucun camp n'est avantagé. Les avenues sont longues (des lignes de tir
 * de 160 m), les îlots et les barricades donnent de quoi s'abriter partout.
 */

/** Niveau des rues (m) : au-dessus du sol plat, pour creuser la tranchée de la gare. */
const BASE = 3.5;
/** Demi-côté de la ville (m) : au-delà, les immeubles du bord et les remblais de gravats. */
const PLAY = 94;

/** Voie rapide : axe (x), demi-largeur du tablier, dessus du tablier, demi-longueur (m). */
const HW_X = -60;
const HW_HALF_W = 7;
const HW_TOP = BASE + 6;
const HW_HALF = 34;
/** Remblais : leur bout contre le tablier (une culée de béton), pleine hauteur jusqu'à HW_FULL, pied à HW_FOOT (m). */
const HW_INNER = 32;
const HW_FULL = 38;
const HW_FOOT = 60;
/** Talus des remblais, de chaque côté du dessus (m). */
const HW_SIDE = 10;

/** Gare : axe des voies (x), demi-largeur du fond de la tranchée, largeur des talus (m). */
const RAIL_X = 60;
const RAIL_FLOOR = 8;
const RAIL_BANK = 9;
/** Fond de la tranchée (m) ; il remonte en trémie de RAIL_FULL à RAIL_FULL + RAIL_RAMP m du centre. */
const FLOOR = 0.5;
const RAIL_FULL = 28;
const RAIL_RAMP = 18;
/** Les deux voies (x), et le quai central entre elles. */
const TRACKS = [54, 66];
const QUAY = { x: 60, half: 2.6, length: 16, top: FLOOR + 1, side: 2.2, end: 5 };

/** Butte du parc : centre, plateau, pied, hauteur (m). */
const BUTTE = { x: -27, z: 48, flat: 5.5, foot: 12, rise: 1.8 };
/** Parking à étage : son toit (une plateforme), à cette hauteur au-dessus des rues (m). */
const PARKING = { minX: 27, maxX: 42, minZ: -62, maxZ: -44, rise: 2.6 };
/** La tour en ruine : son emprise et sa hauteur au-dessus des rues (m). */
const TOWER = { x: 11, z: -55, half: 4, height: 26 };

/** Remblais de gravats au bord de la ville : leur pied, leur crête (distance au centre le long d'un axe, m). */
const EDGE_FOOT = 97;
const EDGE_TOP = 112;

/** Un immeuble effondré : un tas de gravats sur son îlot (rectangle), qui monte de `rise` m en `run` m. */
interface Heap {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  rise: number;
  run: number;
}
const HEAPS: readonly Heap[] = [
  { minX: 31, maxX: 43, minZ: 33, maxZ: 61, rise: 3, run: 6 },
  { minX: -43, maxX: -31, minZ: -61, maxZ: -33, rise: 3, run: 6 },
];

/** Relief de la ville en (x, z) (m) : des rues à plat, et ce qui s'en écarte. */
function cityHeight(x: number, z: number): number {
  let h = BASE;
  // Remblais de la voie rapide, aux deux bouts du tablier (un plan incliné : pas de bosse)
  const az = Math.abs(z);
  if (az >= HW_INNER) {
    const along = az <= HW_FULL ? 1 : Math.max(0, 1 - (az - HW_FULL) / (HW_FOOT - HW_FULL));
    const ax = Math.abs(x - HW_X);
    const across = ax <= HW_HALF_W ? 1 : Math.max(0, 1 - (ax - HW_HALF_W) / HW_SIDE);
    // Un peu sous le tablier, là où ils se recouvrent : pas deux surfaces au même niveau
    h = Math.max(h, BASE + (HW_TOP - 0.03 - BASE) * along * across);
  }
  // Tranchée de la gare : fond plat, talus, trémies aux deux bouts (des plans : les rails y sont droits)
  const cx = Math.abs(x - RAIL_X);
  const acrossCut = cx <= RAIL_FLOOR ? 1 : Math.max(0, 1 - (cx - RAIL_FLOOR) / RAIL_BANK);
  const alongCut = az <= RAIL_FULL ? 1 : Math.max(0, 1 - (az - RAIL_FULL) / RAIL_RAMP);
  h -= (BASE - FLOOR) * acrossCut * alongCut;
  // Le quai : un bombement d'un mètre entre les deux voies, aux talus doux (on y monte de partout)
  const qx = Math.max(0, Math.abs(x - QUAY.x) - QUAY.half) / QUAY.side;
  const qz = Math.max(0, az - QUAY.length) / QUAY.end;
  h += (QUAY.top - FLOOR) * Math.max(0, 1 - Math.max(qx, qz));
  // Butte du parc (sur un sol plat : elle s'ajoute)
  h += BUTTE.rise * (1 - smoothstep(BUTTE.flat, BUTTE.foot, Math.hypot(x - BUTTE.x, z - BUTTE.z)));
  // Tas de gravats des immeubles effondrés
  for (const p of HEAPS) {
    const inside = Math.min(x - p.minX, p.maxX - x, z - p.minZ, p.maxZ - z);
    if (inside > 0) h = Math.max(h, BASE + p.rise * Math.min(1, inside / p.run) * (0.85 + 0.15 * noise2(x / 4, z / 4)));
  }
  // Remblais de gravats au bord de la ville : trop raides pour qu'on y grimpe
  const edge = Math.max(Math.abs(x), Math.abs(z)) + 2.5 * noise2(x / 21 + 3, z / 21 - 5);
  h += smoothstep(EDGE_FOOT, EDGE_TOP, edge) * (13 + 6 * noise2(x / 33 - 4, z / 33 + 8));
  return h;
}

const TERRAIN = makeTerrain(440, 220, cityHeight);

/** Tirage fixe (générateur congruentiel) : la carte est une donnée, la même à chaque partie. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const yaw = (a: number): Quat => axisAngle(vec3(0, 1, 0), a);

/** Rectangle du plan (m). */
export interface Area {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}
const area = (minX: number, maxX: number, minZ: number, maxZ: number): Area => ({ minX, maxX, minZ, maxZ });
/** L'image d'un rectangle par la symétrie de centre l'origine. */
const mirror = (a: Area): Area => area(-a.maxX, -a.minX, -a.maxZ, -a.minZ);

// --- Décor fixe ---

/** Une chaussée (une dalle au ras de la rue, à bandes blanches). */
const road = (a: Area): StaticBox => box("road", (a.minX + a.maxX) / 2, BASE - 0.08, (a.minZ + a.maxZ) / 2, (a.maxX - a.minX) / 2, 0.12, (a.maxZ - a.minZ) / 2);

/**
 * Les chaussées : boulevards du nord et du sud (coupés par la voie ferrée), avenue centrale, rues
 * autour de la place et entre les îlots, et l'avenue sous la voie rapide. Elles ne se recouvrent
 * pas : à un carrefour, une seule passe.
 */
function roads(): StaticBox[] {
  // Ce qui se répond par la symétrie de la carte
  const half: Area[] = [
    area(-7, 7, 24, 63), // avenue centrale, au nord de la place
    area(7, 43, 24, 31), area(-43, -7, 24, 31), // rues au nord de la place
    area(24, 31, -24, 24), area(22, 31, 31, 63), // rue à l'ouest de la place, et au-delà
    area(31, 43, -5, 5), // rue de la gare
  ];
  return [
    ...half, ...half.map(mirror),
    // Les boulevards, coupés par la voie ferrée ; l'avenue sous la voie rapide
    ...[63, -81].flatMap((z) => [area(-PLAY, RAIL_X - 10, z, z + 18), area(RAIL_X + 10, PLAY, z, z + 18)]),
    area(-77, -43, -30, 30),
  ].map(road);
}

/** La voie rapide : tablier sur ses piles, chaussée, parapets, et les deux culées contre les remblais. */
function highway(): StaticBox[] {
  const deckY = HW_TOP - 0.4;
  const list: StaticBox[] = [
    { ...box("deck", HW_X, deckY, 0, HW_HALF_W, 0.4, HW_HALF), underpass: true, approach: HW_FOOT - HW_HALF + 3 },
    box("road", HW_X, HW_TOP - 0.02, 0, HW_HALF_W - 0.6, 0.06, HW_HALF),
    box("deck", HW_X - HW_HALF_W + 0.25, HW_TOP + 0.45, 0, 0.3, 0.45, HW_HALF - 0.5),
    box("deck", HW_X + HW_HALF_W - 0.25, HW_TOP + 0.45, 0, 0.3, 0.45, HW_HALF - 0.5),
  ];
  // Culées : le bout des remblais, un mur de béton sous le bout du tablier
  const top = HW_TOP - 0.8;
  for (const s of [-1, 1]) {
    list.push(box("pillar", HW_X, (BASE - 0.5 + top) / 2, s * (HW_INNER - 1.4), HW_HALF_W + HW_SIDE + 0.5, (top - BASE + 0.5) / 2, 1));
  }
  // Piles, par paires
  for (const z of [-24, -12, 0, 12, 24]) {
    for (const s of [-1, 1]) list.push(box("pillar", HW_X + s * 4.2, (BASE - 0.5 + top) / 2, z, 0.9, (top - BASE + 0.5) / 2, 0.9));
  }
  return list;
}

/** Hauteur du fond de la tranchée en z, le long des voies (fond plat, puis trémie). */
const railBed = (z: number): number => FLOOR + (BASE - FLOOR) * Math.min(1, Math.max(0, Math.abs(z) - RAIL_FULL) / RAIL_RAMP);

/**
 * La gare : deux voies au fond de la tranchée, qui remontent par les trémies et filent jusqu'au
 * bord de la ville (le quai central est un bombement du relief, voir `cityHeight`).
 */
function station(): StaticBox[] {
  const list: StaticBox[] = [];
  const angle = Math.atan2(BASE - FLOOR, RAIL_RAMP);
  for (const x of TRACKS) {
    // Au fond, à plat
    list.push(box("track", x, FLOOR - 0.02, 0, 1.3, 0.08, RAIL_FULL));
    for (const s of [-1, 1]) {
      // Dans la trémie, inclinée comme elle ; puis au niveau des rues jusqu'au bord
      const mid = s * (RAIL_FULL + RAIL_RAMP / 2);
      const run = RAIL_RAMP / dcos(angle) / 2;
      list.push(box("track", x, railBed(mid) - 0.02, mid, 1.3, 0.08, run, axisAngle(vec3(1, 0, 0), -s * angle)));
      const from = RAIL_FULL + RAIL_RAMP;
      const to = PLAY - 6;
      list.push(box("track", x, BASE - 0.02, s * (from + to) / 2, 1.3, 0.08, (to - from) / 2));
    }
  }
  return list;
}

/** Le parking à étage (son toit, une plateforme où l'on monte par deux rampes) et la tour en ruine. */
function towerAndParking(): StaticBox[] {
  const p = PARKING;
  const cx = (p.minX + p.maxX) / 2;
  const cz = (p.minZ + p.maxZ) / 2;
  const top = BASE + p.rise;
  const t = TOWER;
  const g = BASE - 0.5;
  return [
    box("platform", cx, (g + top) / 2, cz, (p.maxX - p.minX) / 2, (top - g) / 2, (p.maxZ - p.minZ) / 2),
    incline(cx, p.maxZ + 6, "z", -1, 9, 12, p.rise, BASE),
    incline(cx, p.minZ - 6, "z", 1, 9, 12, p.rise, BASE),
    // La tour : un fût de béton, sa tête éventrée (des pans de murs qui montent plus ou moins haut)
    box("tower", t.x, g + (t.height + 0.5) / 2, t.z, t.half, (t.height + 0.5) / 2, t.half),
    box("tower", t.x + t.half - 1, BASE + t.height + 3, t.z - 1.5, 1, 3, t.half - 1.5),
    box("tower", t.x - 1.5, BASE + t.height + 1.8, t.z - t.half + 1, t.half - 1.5, 1.8, 1),
    box("tower", t.x - t.half + 1.2, BASE + t.height + 3, t.z + t.half - 1.2, 1.2, 3, 1.2),
  ];
}

/** Le monument de la place : un socle à degrés, une colonne, sa statue. */
function monument(): StaticBox[] {
  return [
    box("pillar", 0, BASE + 0.4, 0, 3.2, 0.9, 3.2),
    box("pillar", 0, BASE + 1.8, 0, 2.2, 0.6, 2.2),
    box("pillar", 0, BASE + 6, 0, 0.75, 3.6, 0.75),
    box("pillar", 0, BASE + 10.2, 0, 1.1, 0.6, 1.1),
    box("pillar", 0.2, BASE + 11.6, 0, 0.45, 0.8, 0.6, yaw(0.4)),
  ];
}

/**
 * Sacs de sable qu'on ne déplace pas : des abris bas au bout de la rue de la gare, dans les ruelles,
 * sous la voie rapide. Pas au milieu d'une rue : il y laisserait deux passages trop étroits.
 */
function sandbags(): StaticBox[] {
  const half: [number, number, "x" | "z", number][] = [
    [-84, 19, "x", 4], // ruelles du bord
  ];
  // Sous la voie rapide (la gare, en face, est en tranchée)
  const below: [number, number, "x" | "z", number][] = [[-48, 14, "z", 4], [-72, -6, "x", 5], [-50, -20, "z", 3]];
  return [
    ...half.flatMap(([x, z, along, length]) => [barrier(x, z, along, length, 1.1, BASE - 0.1), barrier(-x, -z, along, length, 1.1, BASE - 0.1)]),
    ...below.map(([x, z, along, length]) => barrier(x, z, along, length, 1.1, BASE - 0.1)),
  ];
}

/**
 * Gravats : des blocs de béton tombés sur les tas des immeubles effondrés, et au pied de la tour.
 * Pas dans les rues : un robot y monterait, ou s'y coincerait contre un mur.
 */
function rubble(): StaticBox[] {
  const random = seeded(23);
  const half: [number, number, number][] = [
    [33.5, 41, 1.4], [37.5, 48.5, 1.2], [34, 50.5, 1.5],
  ];
  return half.flatMap(([x, z, size]) => [[x, z], [-x, -z]].map(([px, pz]) => {
    const h = vec3(size * (0.9 + random() * 0.6), size * (0.45 + random() * 0.3), size * (0.8 + random() * 0.5));
    const rot = qmul(yaw(random() * Math.PI), axisAngle(vec3(1, 0, 0), (random() - 0.5) * 0.3));
    return box("rock", px, cityHeight(px, pz) + h.y * 0.45, pz, h.x, h.y, h.z, rot);
  }));
}

/**
 * Le bord de la ville : une rangée continue d'immeubles éventrés (des blocs qu'on ne détruit pas),
 * de hauteurs inégales, derrière les boulevards et les îlots du bord ; plus loin, des tours dans la
 * brume, et les limites invisibles (rien ne quitte la carte, pas même un robot qui s'envole).
 */
function skyline(): StaticBox[] {
  const random = seeded(31);
  const list: StaticBox[] = [];
  // Le long de chaque côté : de -105 à 105, des blocs de 12 à 20 m de large
  for (const side of [0, 1, 2, 3]) {
    let u = -106;
    while (u < 106) {
      const w = 12 + random() * 8;
      const depth = 10 + random() * 4;
      const height = 9 + random() * 22;
      const inner = side < 2 ? 85 : 95; // derrière les boulevards (nord, sud), derrière les îlots du bord (est, ouest)
      const c = inner + depth / 2;
      const along = u + w / 2;
      const [x, z, hx, hz] = side === 0 ? [along, c, w / 2, depth / 2] : side === 1 ? [-along, -c, w / 2, depth / 2]
        : side === 2 ? [c, -along, depth / 2, w / 2] : [-c, along, depth / 2, w / 2];
      list.push(box("tower", x, BASE - 1 + height / 2, z, hx, height / 2 + 0.5, hz));
      u += w;
    }
  }
  // Au loin, dans la brume
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2 + random() * 0.15;
    const r = 135 + random() * 55;
    const s = 7 + random() * 9;
    const height = 18 + random() * 40;
    list.push(box("tower", dcos(a) * r, 12 + height / 2, dsin(a) * r, s, height / 2, s * (0.7 + random() * 0.6), yaw(random() * 0.6)));
  }
  const at = 124;
  const t = 2;
  for (const s of [-1, 1]) {
    list.push(box("bound", 0, 60, s * (at + t), at + 2 * t, 60, t));
    list.push(box("bound", s * (at + t), 60, 0, t, 60, at + 2 * t));
  }
  return list;
}

const BOXES: readonly StaticBox[] = [...roads(), ...highway(), ...station(), ...towerAndParking(), ...monument(), ...sandbags(), ...rubble(), ...skyline()];

// --- Accessoires ---

/** Distance d'un point au segment [a, b] du plan. */
function segmentDistance(x: number, z: number, a: readonly [number, number], b: readonly [number, number]): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t);
}

/** Revêtements dessinés sur le relief : pelouses et allées du parc, ballast des voies, chaussée des remblais. */
const PATHS: readonly TerrainPath[] = [
  // Pelouses du parc et allées en croix
  ...[36.5, 47, 57.5].map((z): TerrainPath => ({ width: 11, points: [[-40, z], [-10, z]], surface: "grass" })),
  { width: 3, points: [[-41, 33], [-9, 61]], surface: "gravel" },
  { width: 3, points: [[-9, 33], [-41, 61]], surface: "gravel" },
  // Le ballast des voies : la tranchée, puis les voies au niveau des rues jusqu'au bord
  { width: 17, points: [[RAIL_X, -46], [RAIL_X, 46]], surface: "ballast" },
  { width: 16, points: [[RAIL_X, 44], [RAIL_X, 96]], surface: "ballast" },
  { width: 16, points: [[RAIL_X, -44], [RAIL_X, -96]], surface: "ballast" },
  // Le dessus du quai, bitumé ; la chaussée sur les remblais de la voie rapide
  { width: QUAY.half * 2 - 0.4, points: [[QUAY.x, -QUAY.length], [QUAY.x, QUAY.length]], surface: "asphalt" },
  { width: 12, points: [[HW_X, 33], [HW_X, 63]], surface: "asphalt" },
  { width: 12, points: [[HW_X, -33], [HW_X, -63]], surface: "asphalt" },
];


/** Épaisseur d'une façade, d'un toit (m) ; hauteur d'un étage ; largeur maximale d'un pan (m). */
const WALL = 0.3;
const ROOF = 0.3;
const STOREY = 3.6;
const PANEL = 6;

/** Un côté d'un immeuble : nord (+z), sud, ouest (+x), est. */
export type Side = "n" | "s" | "w" | "e";

export interface BuildingSpec {
  /** Emprise (m). */
  at: Area;
  /** Sol de l'immeuble (m) : la rue de la Cité, sans lui (une carte communautaire le donne). */
  ground?: number;
  floors: number;
  wall: PropType;
  /** Ouvertures au rez-de-chaussée : le côté, et le rang du pan (depuis l'est ou le sud). */
  doors?: readonly [Side, number][];
  /** Part des colonnes de pans dont les étages du haut se sont effondrés (0 à 1). */
  ruin?: number;
  seed: number;
}

/**
 * Un immeuble en pans de façade ancrés, un par étage et par colonne : chaque pan repose sur celui
 * du dessous (il tombe quand celui-ci disparaît), et le toit plat, en bandes, sur les pans du haut.
 * Une ouverture au rez-de-chaussée (une porte cochère, une vitrine soufflée) laisse un linteau, qui
 * repose sur ses voisins. Une ruine a perdu le haut de quelques colonnes, et le toit au-dessus.
 */
export function building(P: PropList, s: BuildingSpec): void {
  const id = P.newBuilding();
  const random = seeded(s.seed);
  const base = s.ground ?? BASE;
  const { minX, maxX, minZ, maxZ } = s.at;
  const alongX = maxX - minX >= maxZ - minZ; // le faîte, le long du plus grand côté
  // Repère local : u le long du grand côté, v en travers
  const [u0, u1, v0, v1] = alongX ? [minX, maxX, minZ, maxZ] : [minZ, maxZ, minX, maxX];
  const place = (u: number, y: number, v: number): Vec3 => (alongX ? vec3(u, y, v) : vec3(v, y, u));
  const size = (hu: number, hy: number, hv: number): Vec3 => (alongX ? vec3(hu, hy, hv) : vec3(hv, hy, hu));
  const sideOf = (long: boolean, k: number): Side => (long === alongX ? (k ? "n" : "s") : (k ? "w" : "e"));
  const door = (side: Side, i: number): boolean => !!s.doors?.some(([d, j]) => d === side && j === i);

  const n = Math.ceil((u1 - u0) / PANEL);
  const pw = (u1 - u0) / n;
  const inner = v1 - v0 - 2 * WALL;
  const m = Math.ceil(inner / PANEL);
  const pd = inner / m;
  // Hauteur de chaque colonne (en étages) : une ruine en a perdu
  const height = (): number => (random() < (s.ruin ?? 0) ? Math.max(1, s.floors - 1 - (random() < 0.4 ? 1 : 0)) : s.floors);
  /** Pans par côté (0 : u ou v bas, 1 : haut), par colonne, par étage. */
  const long: (number | undefined)[][][] = [[], []];
  const ends: (number | undefined)[][][] = [[], []];
  const raise = (cols: (number | undefined)[][][], k: number, count: number, isLong: boolean, at: (i: number, y: number) => Vec3, half: Vec3): void => {
    for (let i = 0; i < count; i++) {
      const top = height();
      const column: (number | undefined)[] = [];
      for (let f = 0; f < top; f++) {
        const y = base + STOREY * (f + 0.5);
        if (f === 0 && door(sideOf(isLong, k), i)) {
          column.push(undefined);
          continue;
        }
        // Sur le pan du dessous ; un linteau, sur ses voisins du même étage
        const below = f > 0 ? column[f - 1] : undefined;
        const rests = f === 0 ? undefined : below !== undefined ? [below] : [cols[k][i - 1]?.[f], undefined].filter((r): r is number => r !== undefined);
        column.push(P.add({ type: s.wall, pos: at(i, y), half, building: id, rests }));
      }
      cols[k][i] = column;
    }
  };
  for (const k of [0, 1]) {
    const v = k ? v1 - WALL / 2 : v0 + WALL / 2;
    raise(long, k, n, true, (i, y) => place(u0 + pw * (i + 0.5), y, v), size(pw / 2, STOREY / 2, WALL / 2));
    const u = k ? u1 - WALL / 2 : u0 + WALL / 2;
    raise(ends, k, m, false, (j, y) => place(u, y, v0 + WALL + pd * (j + 0.5)), size(WALL / 2, STOREY / 2, pd / 2));
  }
  // Un linteau dont le voisin de droite n'existait pas encore : il repose aussi sur lui
  for (const cols of [long, ends]) {
    for (const k of [0, 1]) {
      cols[k].forEach((column, i) => {
        if (column[0] !== undefined) return;
        const lintel = column[1];
        const right = cols[k][i + 1]?.[1];
        if (lintel === undefined || right === undefined) return;
        const spot = P.spots[lintel];
        spot.rests = [...(spot.rests ?? []), right];
      });
    }
  }
  // Toit plat en bandes : chacune sur les pans du dernier étage de sa colonne (et des pignons au bout) ;
  // pas de bande là où les deux côtés se sont effondrés
  const roofY = base + STOREY * s.floors + ROOF / 2;
  for (let i = 0; i < n; i++) {
    const rests = [long[0][i]?.[s.floors - 1], long[1][i]?.[s.floors - 1]].filter((r): r is number => r !== undefined);
    if (!rests.length) continue;
    if (i === 0) rests.push(...ends[0].map((c) => c[s.floors - 1]).filter((r): r is number => r !== undefined));
    if (i === n - 1) rests.push(...ends[1].map((c) => c[s.floors - 1]).filter((r): r is number => r !== undefined));
    P.add({ type: "concrete", pos: place(u0 + pw * (i + 0.5), roofY, (v0 + v1) / 2), half: size(pw / 2, ROOF / 2, (v1 - v0) / 2), building: id, rests });
  }
}

/** Un accessoire posé sur la rue (ou sur ce qui est à `ground` m). */
function put(P: PropList, type: PropType, x: number, z: number, half: Vec3, rot: Quat = NO_ROTATION, ground = BASE): number {
  return P.add({ type, pos: vec3(x, ground + half.y, z), half, rot });
}

/** Une voiture (`car` : elle peut flamber et exploser ; `wreck` : une carcasse brûlée), tournée de `a`. */
function car(P: PropList, type: "car" | "wreck", x: number, z: number, a: number, ground = BASE): void {
  // Une voiture n'est pas ancrée : posée un peu au-dessus, elle se pose d'elle-même
  P.add({ type, pos: vec3(x, ground + CAR_HALF.y + (type === "car" ? 0.03 : 0), z), half: CAR_HALF, rot: yaw(a) });
}

/** Un abribus : une vitre au fond, deux côtés, un toit qui repose sur eux. */
function busShelter(P: PropList, x: number, z: number, a: number): void {
  const turn = yaw(a);
  const at = (lx: number, ly: number, lz: number): Vec3 => {
    const c = dcos(a);
    const s = dsin(a);
    return vec3(x + lx * c + lz * s, ly, z - lx * s + lz * c);
  };
  const back = P.add({ type: "sheet", pos: at(0, BASE + 1.15, -0.6), half: vec3(1.6, 1.15, 0.04), rot: turn });
  const left = P.add({ type: "sheet", pos: at(-1.56, BASE + 1.15, 0), half: vec3(0.04, 1.15, 0.56), rot: turn });
  const right = P.add({ type: "sheet", pos: at(1.56, BASE + 1.15, 0), half: vec3(0.04, 1.15, 0.56), rot: turn });
  P.add({ type: "sheet", pos: at(0, BASE + 2.35, 0), half: vec3(1.8, 0.05, 0.8), rot: turn, rests: [back, left, right] });
}

/** Un lampadaire. */
function lamp(P: PropList, x: number, z: number, ground = BASE): void {
  P.add({ type: "lamppost", pos: vec3(x, ground + 3.2, z), rot: yaw(x > 0 ? 0 : Math.PI) });
}

/** Ce qu'on pose au nord-est (x < 0) se pose aussi, tourné d'un demi-tour, au sud-ouest : la carte reste symétrique. */
function twice(f: (sx: number, sz: number, turn: number) => void): void {
  f(1, 1, 0);
  f(-1, -1, Math.PI);
}

function buildProps(): PropList {
  const P = new PropList();

  // Les îlots autour de la place (trois étages), et ceux du nord et du sud
  twice((s, _t, flip) => {
    const mx = (a: Area): Area => (s > 0 ? a : mirror(a));
    const door: Side = s > 0 ? "e" : "w";
    building(P, { at: mx(area(31, 43, 5, 24)), floors: 3, wall: "facade", doors: [[door, 1]], ruin: 0.25, seed: 1 + flip });
    building(P, { at: mx(area(31, 43, -24, -5)), floors: 3, wall: "tenement", doors: [[s > 0 ? "s" : "n", 0]], ruin: 0.35, seed: 2 + flip });
    building(P, { at: mx(area(7, 22, 33, 61)), floors: 3, wall: "tenement", doors: [[door, 2], [s > 0 ? "n" : "s", 1]], ruin: 0.3, seed: 3 + flip });
    // Les immeubles du bord : à l'est (au nord), à l'ouest (au sud), en face de la gare et de la voie rapide
    building(P, { at: mx(area(-92, -80, 22, 60)), floors: 2, wall: "facade", doors: [[s > 0 ? "w" : "e", 3]], ruin: 0.3, seed: 4 + flip });
  });
  // La gare, à l'ouest des voies, et les bureaux, à l'est de la voie rapide
  building(P, { at: area(80, 92, -16, 16), floors: 2, wall: "tenement", doors: [["e", 2], ["e", 3]], seed: 7 });
  building(P, { at: area(-92, -80, -16, 16), floors: 3, wall: "facade", doors: [["w", 2]], ruin: 0.2, seed: 8 });

  // Les immeubles effondrés : un tas de gravats, quelques pans encore debout
  for (const h of HEAPS) {
    const s = h.minX > 0 ? 1 : -1;
    // (bien à l'intérieur du tas : la rue qui le longe reste dégagée)
    for (const [u, v, along] of [[0.5, 0.12, "x"], [0.85, 0.4, "z"], [0.45, 0.8, "x"], [0.7, 0.93, "x"]] as const) {
      const x = h.minX + (h.maxX - h.minX) * (s > 0 ? u : 1 - u);
      const z = h.minZ + (h.maxZ - h.minZ) * (s > 0 ? v : 1 - v);
      const half = along === "x" ? vec3(2.6, STOREY / 2, WALL / 2) : vec3(WALL / 2, STOREY / 2, 2.6);
      P.add({ type: "facade", pos: vec3(x, cityHeight(x, z) - 0.4 + STOREY / 2, z), half });
    }
  }

  // La place : deux kiosques à journaux, un arbre à chaque coin, deux épaves à distance du monument
  // (de la place entre eux, qu'on y manœuvre, même en camion)
  twice((s) => {
    building(P, { at: s > 0 ? area(15, 19, -20, -16) : area(-19, -15, 16, 20), floors: 1, wall: "sheet", seed: 11 + s });
    for (const [x, z] of [[21.5, 21.5], [-21.5, 21.5]]) P.add({ type: "oak", pos: vec3(s * x, BASE + 3.2 * 0.8, s * z), scale: 0.8 });
  });
  car(P, "wreck", 16, -4, 0.5);
  car(P, "wreck", -16, 4, 0.5 + Math.PI);

  // Le parc (au nord-est) : un kiosque à musique sur la butte ; des arbres sur son pourtour, assez
  // espacés pour qu'on passe entre eux, le milieu dégagé
  const top = BASE + BUTTE.rise;
  const posts: number[] = [];
  for (const [dx, dz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) {
    posts.push(P.add({ type: "plank", pos: vec3(BUTTE.x + dx, top + 1.4 - 0.05, BUTTE.z + dz), half: vec3(0.1, 1.4, 0.1) }));
  }
  P.add({ type: "roof", pos: vec3(BUTTE.x, top + 2.85, BUTTE.z), half: vec3(2.6, 0.1, 2.6), rests: posts });
  const random = seeded(5);
  const allees = PATHS.filter((p) => p.surface === "gravel");
  const ring: [number, number][] = [
    [-11, 35], [-20, 34.5], [-38, 35], [-40.5, 44], [-40, 53], [-37.5, 60.5], [-28, 60], [-19, 60.5], [-11, 59], [-10.5, 49], [-15, 41],
  ];
  for (const [x0, z0] of ring) {
    const x = x0 + (random() - 0.5) * 2;
    const z = z0 + (random() - 0.5) * 2;
    if (allees.some((p) => segmentDistance(x, z, p.points[0], p.points[1]) < p.width / 2 + 1.2)) continue;
    const oak = random() < 0.7;
    const scale = 0.75 + random() * 0.35;
    P.add({ type: oak ? "oak" : "pine", pos: vec3(x, cityHeight(x, z) + (oak ? 3.2 : 4.5) * scale, z), scale });
  }

  // Le parking à étage (au sud-ouest) : parapets, voitures sur le toit ; un parking à ciel ouvert devant la tour
  const p = PARKING;
  const roof = BASE + p.rise;
  for (const x of [p.minX + 0.2, p.maxX - 0.2]) {
    for (const z of [-58, -53, -48]) put(P, "concrete", x, z, vec3(0.15, 0.5, 2.4), NO_ROTATION, roof);
  }
  // (le milieu des côtés nord et sud reste ouvert : les rampes y arrivent)
  for (const z of [p.minZ + 0.2, p.maxZ - 0.2]) {
    for (const x of [p.minX + 1.6, p.maxX - 1.6]) put(P, "concrete", x, z, vec3(1.4, 0.5, 0.15), NO_ROTATION, roof);
  }
  // (deux rangées de voitures, l'allée du milieu libre entre les deux rampes)
  for (const [x, z, a, type] of [[p.minX + 1.6, -58.5, 0.05, "wreck"], [p.minX + 1.6, -49, -0.1, "car"], [p.maxX - 1.6, -57.5, 0.1, "car"], [p.maxX - 1.6, -48, 0, "wreck"]] as const) {
    car(P, type, x, z, Math.PI / 2 + a, roof);
  }
  // Devant la tour, une rangée serrée : on en fait le tour
  for (let i = 0; i < 4; i++) car(P, i === 2 ? "car" : "wreck", 9.5 + i * 3.5, -36, Math.PI / 2 + (i % 2 ? 0.12 : -0.08));

  // Les parkings à ciel ouvert des bords (nord-ouest, sud-est) : des rangées d'épaves
  twice((s, _t, flip) => {
    for (let i = 0; i < 5; i++) {
      const z = s * (26 + i * 3);
      car(P, i === 3 ? "car" : "wreck", s * 84, z, flip + (i % 2 ? 0.08 : -0.06));
      if (i % 2 === 0) car(P, "wreck", s * 89.5, z + s * 1.5, flip + Math.PI + 0.1);
    }
    for (let i = 0; i < 3; i++) car(P, "wreck", s * (84 + i * 0.3), s * (44 + i * 6.2), flip + Math.PI / 2 + i * 0.2);
  });

  // La voie rapide : des voitures abandonnées sur le tablier (hors de la zone, sur les voies de côté), des épaves dessous
  for (const [x, z, a, type] of [[-56.8, -25, 0.12, "wreck"], [-63.3, -14, -0.15, "car"], [-56.8, 14, 0.08, "car"], [-63.2, 24, 0.3, "wreck"]] as const) {
    car(P, type, x, z, Math.PI / 2 + a, HW_TOP + 0.04);
  }
  for (const [x, z, a] of [[-50, -14, 0.4], [-70, 20, -0.3], [-71, -24, 1.2]] as const) car(P, "wreck", x, z, a);
  car(P, "car", -48, 6, 1.4);
  // Barricade sous la voie rapide : blocs de béton, caisses, barils
  for (const [x, z, a] of [[-74, 26, Math.PI / 2], [-46, -26, 0.3]] as const) put(P, "concrete", x, z, vec3(1.6, 0.55, 0.3), yaw(a));
  P.add({ type: "crate", pos: vec3(-62, BASE + 0.5, -27) });
  for (const [x, z] of [[-52.5, 12.5], [-52.4, 13.5], [-68, -10]]) P.add({ type: "barrel", pos: vec3(x, BASE + 0.5, z) });

  // La gare : l'auvent du quai (des poteaux minces, un toit de tôle sur chacun), des caisses
  for (const z of [-12, -6, 0, 6, 12]) {
    const post = P.add({ type: "concrete", pos: vec3(QUAY.x, QUAY.top + 1.75 - 0.05, z), half: vec3(0.12, 1.75, 0.12) });
    P.add({ type: "sheet", pos: vec3(QUAY.x, QUAY.top + 3.55, z), half: vec3(QUAY.half + 0.3, 0.05, 3), rests: [post] });
  }
  for (const [x, z] of [[59, 9], [61, 9.05], [60, -8]]) P.add({ type: "crate", pos: vec3(x, QUAY.top + 0.5, z) });

  // Barricades : la rue qui longe la place fermée par des blocs de béton bord à bord (on passe par
  // la place) ; des barils contre les façades ; une chicane devant la gare et devant les bureaux.
  // Jamais un obstacle isolé au milieu d'une rue : il y laisserait deux passages trop étroits
  twice((s, _t, flip) => {
    // (bord à bord, un seul obstacle pour l'IA, comme un bâtiment)
    const barricade = P.newBuilding();
    for (const x of [-29.25, -25.75]) P.add({ type: "concrete", pos: vec3(s * x, BASE + 0.55, s * 12), half: vec3(1.75, 0.55, 0.3), rot: yaw(flip), building: barricade });
    put(P, "concrete", s * 78.5, s * 4, vec3(1.6, 0.55, 0.3), yaw(flip + Math.PI / 2));
    P.add({ type: "crate", pos: vec3(s * -22.8, BASE + 0.5, s * 12.6) });
    for (const [x, z] of [[-22.6, 11.2], [-30.4, 6.2], [-30.5, 7.3]]) P.add({ type: "barrel", pos: vec3(s * x, BASE + 0.5, s * z) });
    P.add({ type: "gas", pos: vec3(s * -30.4, BASE + 0.55, s * -6.3) });
  });

  // Abribus et lampadaires : au bord des boulevards (pas sur les lignes de départ) et dans le parc ;
  // jamais contre une façade ni près d'un autre obstacle, où un robot se coincerait entre eux
  twice((s, _t, flip) => {
    busShelter(P, s * 38, s * 82, flip + Math.PI);
    for (const x of [-88, -70, -52, -36, 36, 52, 76, 88]) lamp(P, s * x, s * 81.6);
  });
  for (const [x, z] of [[-24, 37], [-36, 47], [-23, 57]]) lamp(P, x, z, cityHeight(x, z));
  return P;
}

const PROPS = buildProps().spots;

/** Un accessoire debout (lampadaire, mât d'éclairage) en (x, z), sur ce qui est à `ground` m, son bras tourné de `a`. */
function upright(P: PropList, type: "lamppost" | "floodlight", x: number, z: number, a: number, ground = BASE): void {
  const halfHeight = type === "lamppost" ? 3.2 : 4.6;
  P.add({ type, pos: vec3(x, ground + halfHeight, z), rot: yaw(a) });
}

/** L'angle dont tourner un accessoire pour que son bras (son +x) regarde vers (tx, tz). */
const facing = (x: number, z: number, tx: number, tz: number): number => Math.atan2(-(tz - z), tx - x);

/**
 * La Cité de nuit : les mêmes rues, et de quoi les éclairer. Des mâts d'éclairage aux coins de la
 * place (zone C), au bout du quai de la gare (zone A) et sur le toit du parking (zone D), des
 * lampadaires le long de l'avenue centrale et sur la voie rapide (zone E) ; le parc (zone B) a déjà
 * les siens, et les boulevards. Jamais sur une ligne de départ ni contre une façade. Les
 * lampadaires et les mâts se couchent et se brisent : on peut plonger une zone dans le noir.
 */
function buildNightProps(): PropSpot[] {
  const P = new PropList();
  for (const spot of PROPS) P.add(spot);
  // La place : quatre mâts tournés vers le monument
  for (const [x, z] of [[22.5, 10], [-22.5, -10], [-10, 22.5], [10, -22.5]] as const) upright(P, "floodlight", x, z, facing(x, z, 0, 0));
  // Le quai de la gare, à ses deux bouts (sur le bombement du relief)
  for (const z of [-18.5, 18.5]) upright(P, "floodlight", QUAY.x, z, facing(QUAY.x, z, QUAY.x, 0), cityHeight(QUAY.x, z));
  // Le toit du parking, à deux coins opposés (le milieu des côtés nord et sud reste aux rampes)
  const roof = BASE + PARKING.rise;
  upright(P, "floodlight", PARKING.minX + 0.6, PARKING.minZ + 0.6, facing(PARKING.minX, PARKING.minZ, 34.5, -53), roof);
  upright(P, "floodlight", PARKING.maxX - 0.6, PARKING.maxZ - 0.6, facing(PARKING.maxX, PARKING.maxZ, 34.5, -53), roof);
  // L'avenue centrale : côté parc au nord, et son pendant au sud (le bras au-dessus de la chaussée)
  for (const z of [38, 50, 61]) {
    upright(P, "lamppost", -6.3, z, facing(-6.3, z, 0, z));
    upright(P, "lamppost", 6.3, -z, facing(6.3, -z, 0, -z));
  }
  // La voie rapide : contre les parapets, le bras au-dessus des voies, loin des voitures abandonnées
  for (const [x, z] of [[HW_X + 6.1, -8], [HW_X - 6.1, 8], [HW_X + 6.1, 28], [HW_X - 6.1, -28]] as const) {
    upright(P, "lamppost", x, z, facing(x, z, HW_X, z), HW_TOP);
  }
  return P.spots;
}

const ZONES: readonly CaptureZone[] = [
  zone("A", QUAY.x, QUAY.top, 0, 5.5),
  zone("B", BUTTE.x, BASE + BUTTE.rise, BUTTE.z, 6),
  zone("C", 0, BASE, 0, 8),
  zone("D", (PARKING.minX + PARKING.maxX) / 2, BASE + PARKING.rise, (PARKING.minZ + PARKING.maxZ) / 2, 6),
  zone("E", HW_X, HW_TOP, 0, 6),
];

const PLACES: readonly ArenaPlace[] = [
  { place: "station", x: 84, z: 0 },
  { place: "tracks", x: RAIL_X, z: -22 },
  { place: "expressway", x: HW_X, z: 20 },
  { place: "offices", x: -86, z: 0 },
  { place: "square", x: 0, z: -10 },
  { place: "park", x: -25, z: 58 },
  { place: "tower", x: TOWER.x, z: TOWER.z },
  { place: "carPark", x: 33, z: -50 },
  { place: "northBoulevard", x: 0, z: 76 },
  { place: "southBoulevard", x: 0, z: -76 },
];

export const CITY: ArenaLayout = {
  id: "city",
  // Les avions de l'IA volent au-dessus de la tour (30 m), les robots volants au-dessus des toits (11 m)
  bounds: { half: PLAY, roam: 80, spawnLine: 72, spawnSpread: 24, circuit: 64, airFloor: 34, hoverFloor: 14 },
  boxes: BOXES,
  props: PROPS,
  zones: ZONES,
  terrain: TERRAIN,
  paths: PATHS,
  // Dalles et pavés tachés de crasse, talus de terre sèche sur les pentes, gravats au-dessus de 10,5 m
  ground: {
    base: ["#8d8980", "#a09a8e"], dirt: "#6d675c", sand: "#8d8980", mud: "#6d675c", rock: "#726c64", peak: "#726c64",
    rockLine: 10.5, rockSpan: 3, peakLine: NO_PEAK, grain: 7, stains: 0.35,
    slope: { color: "#77705d", from: 0.985, span: 0.04 }, lawn: "#5d7a3e",
  },
  urban: true,
  sky: { color: "#aaa59a", fog: 0.0065, dust: 14 },
  places: PLACES,
};

/**
 * La Cité de nuit : la même ville sous la lune, ses lampadaires et ses mâts d'éclairage allumés,
 * des fenêtres éclairées (client/render/nightLights.ts) ; la même ambiance sonore.
 */
export const CITY_NIGHT: ArenaLayout = {
  ...CITY,
  id: "cityNight",
  ambience: "city",
  props: buildNightProps(),
  // (un bleu de nuit, la brume plus épaisse : on voit à une centaine de mètres sous la lune)
  sky: { color: "#141b2b", fog: 0.0095, night: true },
};
