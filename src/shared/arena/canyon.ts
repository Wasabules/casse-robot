import type { PropType } from "../catalog/props";
import { propHalf } from "../catalog/props";
import { axisAngle, qmul, vec3, type Quat } from "../math/vec";
import { box, zone } from "./builders";
import type { ArenaLayout, BoxLook, CaptureZone, NavGraph, PropSpot, StaticBox, StaticKind, TerrainPath } from "./layout";
import { linkNav, walkable } from "./navGraph";
import { makeTerrain, noise2, smoothstep, terrainHeight } from "./terrain";
import { house, PropList, seeded } from "./valley";

/*
 * Le Canyon : une grande carte de désert rouge (±105 m de terrain de jeu, des montagnes tout
 * autour), coupée d'est en ouest par un canyon sinueux au lit sec, aux parois à pic. On n'y descend
 * que par quatre sentiers taillés dans ses parois et par les deux ravines de l'oasis ; on le
 * franchit par le viaduc de la voie ferrée, au centre, ou par l'arche naturelle de la Table, une
 * mesa que la gorge fend en deux à l'ouest. La voie ferrée traverse deux buttes en tunnel ; au
 * nord-est, une ville de l'Ouest en bois (saloon, église, château d'eau, gare) ; au sud-ouest, une
 * mine (chevalement, terrils, wagonnets) ; à l'est, au fond du canyon, une oasis.
 *
 * Nord = +z (les rouges partent du nord, les bleus du sud) et ouest = +x, comme la Vallée. La carte
 * est à peu près symétrique par rapport au centre : la ville et la mine, les deux buttes, les
 * sentiers ; l'oasis et la Table se font face de part et d'autre du viaduc.
 *
 * Les falaises coupent les routes : l'IA au sol suit le réseau de passage de la carte (`NavGraph`,
 * ai/navigation.ts), qui passe par les sentiers, le viaduc, l'arche et les tunnels.
 */

/** Hauteur du plateau, du lit du canyon, du dessus de la Table et des buttes (m). */
const PLATEAU = 12;
const FLOOR = 2.6;
const MESA_TOP = 24;
const BUTTE_TOP = 20;
/** Largeur horizontale d'une paroi du canyon (m) : 9,4 m de dénivelé, des falaises. */
const WALL_RUN = 4;
/** Niveau de l'eau (m) : seulement la mare de l'oasis, sous le lit du canyon. */
const WATER = 2.05;
/** Montagnes : leur pied, leur crête (distance au centre le long d'un axe, m). */
const MOUNTAIN_FOOT = 112;
const MOUNTAIN_TOP = 150;

/** Ligne médiane du canyon (z selon x), et sa pente : elle passe par le centre, symétrique par rapport à lui. */
const canyonZ = (x: number): number => 10 * Math.sin(x / 34) + 3 * Math.sin(x / 12);
const canyonSlope = (x: number): number => (10 / 34) * Math.cos(x / 34) + (3 / 12) * Math.cos(x / 12);
const bump = (u: number): number => Math.exp(-u * u);
/** Demi-largeur du lit (m) : il s'évase à l'est en un bassin (l'oasis) et se resserre à l'ouest dans la gorge de la Table. */
const floorHalf = (x: number): number => 9.5 + 16 * bump((x + 72) / 16) - 3.5 * bump((x - 72) / 12);
/** Distance à la ligne médiane, à peu près perpendiculaire (m). */
const canyonDistance = (x: number, z: number): number => Math.abs(z - canyonZ(x)) / Math.sqrt(1 + canyonSlope(x) ** 2);
/** Point à `d` m de la ligne médiane, au nord (`side` = 1) ou au sud (-1). */
const besideCanyon = (x: number, side: number, d: number): [number, number] => [x, canyonZ(x) + side * d * Math.hypot(1, canyonSlope(x))];

/** La Table : une mesa en ellipse (demi-axes ax, az), que le canyon fend en deux. */
const TABLE = { x: 72, z: canyonZ(72), ax: 26, az: 30 };
/** L'arche naturelle par-dessus la gorge : demi-largeur, demi-longueur (m). */
const ARCH_WIDTH = 6;
const ARCH_HALF = 13.5;
/** Les buttes que la voie traverse en tunnel : centre, rayon (m). */
const BUTTE_R = 18;
const OASIS = { x: -72, z: canyonZ(-72) };
const POND = { x: -79, z: -12, r: 6 };
const TOWN = { x: -60, z: 72 };
const MINE = { x: 60, z: -72 };
/** Viaduc : demi-longueur, demi-largeur du tablier (m) ; son dessus est au niveau du plateau. */
const DECK_HALF = 22;
const DECK_WIDTH = 3.5;
/** Voie ferrée : demi-largeur de sa plateforme aplanie (m) ; dans les buttes, la tranchée du tunnel. */
const RAIL_HALF = 3.5;
/** Un tablier (viaduc, arche) affleure 4 cm sous le sol qu'il rejoint (m). */
const SINK = 0.04;
const RAIL_FALL = 2;

type Point = readonly [number, number];

/** La voie ferrée : du bout nord du viaduc à la ville, puis aux montagnes ; au sud, son image par le centre. */
const RAIL_N: readonly Point[] = [[0, DECK_HALF], [-6, 24], [-46, 48], [-64, 57], [-86, 67], [-103, 74]];
const RAIL_S: readonly Point[] = RAIL_N.map(([x, z]) => [-x, -z] as const);
/** Les buttes, sur le tronçon droit de la voie qui sort du viaduc : au milieu de son deuxième segment. */
const BUTTES: readonly Point[] = [RAIL_N, RAIL_S].map((r) => [(r[1][0] + r[2][0]) / 2, (r[1][1] + r[2][1]) / 2] as const);

/** Terrils de la mine : des cônes de déblais (centre, rayon, hauteur ; m). */
const SLAG = [{ x: 84, z: -88, r: 9, h: 5 }, { x: 94, z: -52, r: 7, h: 4 }];

/** Site aplani : un disque (`r`) ou un rectangle, à la hauteur `h`, raccordé au relief sur `fall` m. */
type Flat = { h: number; fall: number } & ({ x: number; z: number; r: number } | { minX: number; maxX: number; minZ: number; maxZ: number });

const FLATS: readonly Flat[] = [
  { minX: -40, maxX: 40, minZ: 76, maxZ: 96, h: PLATEAU, fall: 10 },
  { minX: -40, maxX: 40, minZ: -96, maxZ: -76, h: PLATEAU, fall: 10 },
  { minX: -6, maxX: 6, minZ: DECK_HALF - 5, maxZ: DECK_HALF + 6, h: PLATEAU, fall: 8 },
  { minX: -6, maxX: 6, minZ: -DECK_HALF - 6, maxZ: -DECK_HALF + 5, h: PLATEAU, fall: 8 },
  { x: TOWN.x, z: TOWN.z, r: 20, h: PLATEAU, fall: 8 },
  { x: MINE.x, z: MINE.z, r: 20, h: PLATEAU, fall: 8 },
];

function flatWeight(f: Flat, x: number, z: number): number {
  const out = "r" in f
    ? Math.max(0, length(x - f.x, z - f.z) - f.r)
    : length(Math.max(0, f.minX - x, x - f.maxX), Math.max(0, f.minZ - z, z - f.maxZ));
  return 1 - smoothstep(0, f.fall, out);
}

/** Longueur d'un vecteur du plan (Math.hypot est bien plus lent : le relief en fait des centaines de milliers). */
const length = (x: number, z: number): number => Math.sqrt(x * x + z * z);

/** Part (0 à 1) du segment [a, b] du plan où tombe le projeté de (x, z). */
function projection(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  return Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
}

/** Distance d'un point à une ligne brisée. */
function lineDistance(x: number, z: number, line: readonly (readonly number[])[]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const [ax, az] = line[i - 1];
    const [bx, bz] = line[i];
    const u = projection(x, z, ax, az, bx, bz);
    best = Math.min(best, length(x - ax - (bx - ax) * u, z - az - (bz - az) * u));
  }
  return best;
}

/** Rectangle qui contient une ligne brisée, élargi de `margin` m : au-delà, elle ne change rien au relief. */
interface Bounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}
function boundsOf(line: readonly (readonly number[])[], margin: number): Bounds {
  const xs = line.map((p) => p[0]);
  const zs = line.map((p) => p[1]);
  return { minX: Math.min(...xs) - margin, maxX: Math.max(...xs) + margin, minZ: Math.min(...zs) - margin, maxZ: Math.max(...zs) + margin };
}
const within = (b: Bounds, x: number, z: number): boolean => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;

/**
 * Sentier : une ligne brisée de points (x, z) et leur hauteur, une rampe large de `width` m
 * raccordée au relief sur `fall` m (taillée dans la falaise d'un côté, en remblai de l'autre).
 */
interface Trail {
  readonly width: number;
  readonly fall: number;
  readonly points: readonly (readonly [number, number, number])[];
  /** Le rectangle hors duquel il ne touche pas au relief. */
  readonly bounds: Bounds;
}

const trail = (width: number, fall: number, points: readonly (readonly [number, number, number])[]): Trail =>
  ({ width, fall, points, bounds: boundsOf(points, width / 2 + fall) });

/** Une ligne brisée prolongée de `extra` m à chaque bout, dans l'axe de son premier et de son dernier segment. */
function extended(points: readonly Point[], extra: number): Point[] {
  const out = (a: Point, b: Point): Point => {
    const dx = a[0] - b[0];
    const dz = a[1] - b[1];
    const l = Math.hypot(dx, dz) || 1;
    return [a[0] + (dx / l) * extra, a[1] + (dz / l) * extra];
  };
  const n = points.length;
  return [out(points[0], points[1]), ...points, out(points[n - 1], points[n - 2])];
}

/** Les points d'une ligne brisée, et d'autres entre eux, tous les `step` m au plus. */
function densified(points: readonly Point[], step: number): Point[] {
  const out: Point[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1];
    const [bx, bz] = points[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  return out;
}

/** Longueur sur laquelle la pente d'un sentier s'adoucit à chaque bout (m) : il quitte le plateau et rejoint le lit sans pli. */
const EASE = 5;

/**
 * Hauteurs le long d'une ligne, de `from` à son premier point à `to` au dernier : une pente
 * constante, qui s'adoucit jusqu'à plat sur EASE m à chaque bout (une rampe sans arête où un robot
 * bas accrocherait son nez).
 */
function graded(points: readonly Point[], from: number, to: number): [number, number, number][] {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  const total = lengths[lengths.length - 1] || 1;
  const e = Math.min(EASE, total / 3);
  const slope = 1 / (total - e);
  const part = (s: number): number =>
    s < e ? (slope * s * s) / (2 * e) : s > total - e ? 1 - (slope * (total - s) ** 2) / (2 * e) : slope * (s - e / 2);
  return points.map(([x, z], i) => [x, z, from + (to - from) * part(lengths[i])]);
}

/**
 * Sentier le long d'une ligne (prolongée de 4 m à chaque bout, pour qu'il commence et finisse à
 * plat), de la hauteur `from` à `to` ; `nodes` : ses points de passage, pour l'IA et la carte.
 */
function makeTrail(width: number, fall: number, line: readonly Point[], from: number, to: number): Trail & { nodes: readonly Point[] } {
  const nodes = extended(line, 4);
  return { ...trail(width, fall, graded(densified(nodes, 2), from, to)), nodes };
}

/**
 * Sentier taillé dans la paroi du canyon, du côté `side` (1 : nord) : il part du plateau en `x0`,
 * juste derrière le rebord, et descend en biais le long de la paroi jusqu'au pied de celle-ci en `x1`.
 */
function wallTrail(x0: number, x1: number, side: number): Trail & { nodes: readonly Point[] } {
  const line: Point[] = [];
  for (let i = 0; i <= 4; i++) {
    const x = x0 + ((x1 - x0) * i) / 4;
    line.push(besideCanyon(x, side, floorHalf(x) + WALL_RUN + 1 - ((WALL_RUN + 1.5) * i) / 4));
  }
  return makeTrail(7, 2.5, line, PLATEAU, FLOOR);
}

/**
 * Sentier en corniche autour de la Table, du plateau à son dessus : il longe la falaise de sa moitié
 * nord (l'ellipse un peu au-delà de son bord), d'est en ouest, et entre peu à peu sur le dessus, sans
 * lacet. `mirror` : son image de l'autre côté de la gorge.
 */
function ledgeTrail(mirror: boolean): Trail & { nodes: readonly Point[] } {
  // Angle sur l'ellipse (degrés, côté nord) et distance au centre (en rayons de l'ellipse)
  const along: [number, number][] = [[140, 1.06], [118, 1.05], [96, 1.03], [74, 0.9]];
  const line: Point[] = along.map(([deg, k]) => {
    const a = (deg * Math.PI) / 180;
    return [TABLE.x + TABLE.ax * k * Math.cos(a), TABLE.z + TABLE.az * k * Math.sin(a)];
  });
  return makeTrail(6.5, 2.5, line.map(([x, z]) => [x, mirror ? 2 * TABLE.z - z : z]), PLATEAU, MESA_TOP);
}

/** Ravine qui descend du plateau au bassin de l'oasis, large et en pente douce (côté nord, ou son image au sud). */
function wash(mirror: boolean): Trail & { nodes: readonly Point[] } {
  const line: Point[] = [[-58, 38], [-64, 8]];
  return makeTrail(8, 3, line.map(([x, z]) => [x, mirror ? 2 * OASIS.z - z : z]), PLATEAU, FLOOR);
}

/**
 * Sentiers du canyon : de chaque côté du viaduc, un dans chaque paroi, en X (l'un descend quand
 * l'autre monte : ils ne resserrent pas le lit l'un en face de l'autre) ; les ravines de l'oasis.
 */
const CANYON_TRAILS = [wallTrail(-12, -36, 1), wallTrail(-36, -12, -1), wallTrail(12, 36, -1), wallTrail(36, 12, 1), wash(false), wash(true)];
const TABLE_TRAILS = [ledgeTrail(false), ledgeTrail(true)];

function applyTrails(h: number, x: number, z: number, trails: readonly Trail[]): number {
  for (const t of trails) {
    if (!within(t.bounds, x, z)) continue;
    let best = Infinity;
    let height = 0;
    for (let i = 1; i < t.points.length; i++) {
      const [ax, az, ah] = t.points[i - 1];
      const [bx, bz, bh] = t.points[i];
      const u = projection(x, z, ax, az, bx, bz);
      const d = length(x - ax - (bx - ax) * u, z - az - (bz - az) * u);
      if (d < best) {
        best = d;
        height = ah + (bh - ah) * u;
      }
    }
    h += (height - h) * (1 - smoothstep(t.width / 2, t.width / 2 + t.fall, best));
  }
  return h;
}

const RAIL_BOUNDS = [RAIL_N, RAIL_S].map((line) => [line, boundsOf(line, RAIL_HALF + RAIL_FALL)] as const);

/** Relief du canyon en (x, z) (m). */
function canyonHeight(x: number, z: number): number {
  // Le plateau : de longues dunes basses
  let h = PLATEAU + 0.5 * noise2(x / 40 + 3, z / 40 - 5) + 0.25 * noise2(x / 14 - 8, z / 14 + 2);
  for (const f of FLATS) h += (f.h - h) * flatWeight(f, x, z);
  // La Table : une mesa en ellipse, cerclée de falaises
  const rt = length((x - TABLE.x) / TABLE.ax, (z - TABLE.z) / TABLE.az);
  h = Math.max(h, PLATEAU + (MESA_TOP - PLATEAU) * (1 - smoothstep(0.97, 1.12, rt)));
  // Les buttes, puis les terrils de la mine
  for (const [bx, bz] of BUTTES) h = Math.max(h, PLATEAU + (BUTTE_TOP - PLATEAU) * (1 - smoothstep(BUTTE_R - 2.5, BUTTE_R + 1.5, length(x - bx, z - bz))));
  for (const s of SLAG) h = Math.max(h, PLATEAU + s.h * Math.max(0, 1 - length(x - s.x, z - s.z) / s.r));
  // La voie ferrée, aplanie au niveau du plateau : une tranchée à travers les buttes
  for (const [line, bounds] of RAIL_BOUNDS) {
    if (within(bounds, x, z)) h += (PLATEAU - h) * (1 - smoothstep(RAIL_HALF, RAIL_HALF + RAIL_FALL, lineDistance(x, z, line)));
  }
  h = applyTrails(h, x, z, TABLE_TRAILS);
  // Le canyon : un lit sec, des parois à pic (jusqu'au dessus de la Table, dans la gorge)
  const bed = FLOOR + 0.18 * noise2(x / 9 + 11, z / 9 - 4);
  const w = floorHalf(x);
  h = bed + (h - bed) * smoothstep(w, w + WALL_RUN, canyonDistance(x, z));
  h = applyTrails(h, x, z, CANYON_TRAILS);
  // La mare de l'oasis
  h -= 1.3 * (1 - smoothstep(POND.r - 2, POND.r + 2, length(x - POND.x, z - POND.z)));
  // Les montagnes, tout autour : trop raides pour qu'on y grimpe ; le canyon s'y perd
  const edge = Math.max(Math.abs(x), Math.abs(z)) + 6 * noise2(x / 30 - 7, z / 30 + 2);
  h += smoothstep(MOUNTAIN_FOOT, MOUNTAIN_TOP, edge) * (30 + 14 * noise2(x / 45 + 9, z / 45 + 3));
  return Math.max(0.15, h);
}

/**
 * Un sommet tous les mètres (deux fois plus serrés que dans la Vallée) : les sentiers, larges de
 * 7 m, ont ainsi plusieurs rangées de sommets à plat d'un bord à l'autre, et les falaises leurs
 * arêtes. Le pas reste une puissance de deux : à 1,375 m, les rayons de Rapier tombant pile sur
 * certaines lignes de sommets traversaient le champ de hauteurs (une roue y perdait le sol).
 */
const terrain = lazy(() => makeTerrain(440, 440, canyonHeight));

/** Hauteur du sol telle que la voit la physique (le champ de hauteurs interpole entre ses sommets). */
const ground = (x: number, z: number): number => terrainHeight(terrain(), x, z);

/** Une valeur calculée à sa première lecture, puis gardée. */
function lazy<T>(build: () => T): () => T {
  let value: { v: T } | null = null;
  return () => (value ??= { v: build() }).v;
}

const yaw = (a: number): Quat => axisAngle(vec3(0, 1, 0), a);
const looked = (look: BoxLook, b: StaticBox): StaticBox => ({ ...b, look });
/** Boîte de `kind`, centrée sur le segment [a, b] du plan et tournée dans son axe (`half.z` : le long). */
function along(kind: StaticKind, a: Point, b: Point, y: number, hx: number, hy: number, extra = 0): StaticBox {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  return box(kind, (a[0] + b[0]) / 2, y, (a[1] + b[1]) / 2, hx, hy, Math.hypot(dx, dz) / 2 + extra, yaw(Math.atan2(dx, dz)));
}

/** Point d'une ligne brisée à `s` m de son début, sa direction (unitaire) et sa gauche (vers +z pour une voie qui file vers -x). */
function pointAlong(line: readonly Point[], s: number): { x: number; z: number; dx: number; dz: number } {
  let rest = s;
  for (let i = 1; i < line.length; i++) {
    const [ax, az] = line[i - 1];
    const [bx, bz] = line[i];
    const l = Math.hypot(bx - ax, bz - az);
    if (rest <= l || i === line.length - 1) {
      return { x: ax + ((bx - ax) * rest) / l, z: az + ((bz - az) * rest) / l, dx: (bx - ax) / l, dz: (bz - az) / l };
    }
    rest -= l;
  }
  return { x: line[0][0], z: line[0][1], dx: 0, dz: 1 };
}

/** Le viaduc à tréteaux : un tablier de rails, des garde-corps, des pieds de bois sur le lit et les parois, des moises. */
function viaduct(): StaticBox[] {
  const list: StaticBox[] = [
    // Le dessus un peu sous le plateau : là où le tablier s'y enfonce, ils ne se disputent pas l'image
    looked("rail", box("deck", 0, PLATEAU - SINK - 0.3, 0, DECK_WIDTH, 0.3, DECK_HALF)),
    looked("timber", box("deck", DECK_WIDTH + 0.2, PLATEAU + 0.45, 0, 0.2, 0.45, DECK_HALF - 0.5)),
    looked("timber", box("deck", -DECK_WIDTH - 0.2, PLATEAU + 0.45, 0, 0.2, 0.45, DECK_HALF - 0.5)),
    // Longerons sous le tablier
    looked("timber", box("deck", 2.6, PLATEAU - 0.85, 0, 0.25, 0.25, DECK_HALF - 2)),
    looked("timber", box("deck", -2.6, PLATEAU - 0.85, 0, 0.25, 0.25, DECK_HALF - 2)),
  ];
  const top = PLATEAU - 1.1;
  for (const z of [-16, -5.5, 5.5, 16]) {
    for (const x of [-2.6, 2.6]) {
      const g = ground(x, z) - 0.4;
      if (top - g < 1.5) continue;
      list.push(looked("timber", box("pillar", x, (g + top) / 2, z, 0.3, (top - g) / 2, 0.3)));
    }
    // Une moise entre les deux pieds, au-dessus des robots qui passent dessous
    if (Math.max(ground(-2.6, z), ground(2.6, z)) < 6.5) list.push(looked("timber", box("deck", 0, 9, z, 2.9, 0.15, 0.15)));
  }
  return list;
}

/** L'arche de la Table : un tablier de grès au-dessus de la gorge, bordé de lèvres de roche, et ses retombées. */
function arch(): StaticBox[] {
  const { x, z } = TABLE;
  return [
    looked("sandstone", box("deck", x, MESA_TOP - SINK - 1.5, z, ARCH_WIDTH, 1.5, ARCH_HALF)),
    looked("sandstone", box("deck", x + ARCH_WIDTH - 0.35, MESA_TOP + 0.25, z, 0.35, 0.25, ARCH_HALF - 3)),
    looked("sandstone", box("deck", x - ARCH_WIDTH + 0.35, MESA_TOP + 0.25, z, 0.35, 0.25, ARCH_HALF - 3)),
    looked("sandstone", box("rock", x, MESA_TOP - 4.2, z - 7.2, ARCH_WIDTH + 0.4, 2.4, 3)),
    looked("sandstone", box("rock", x, MESA_TOP - 4.2, z + 7.2, ARCH_WIDTH + 0.4, 2.4, 3)),
  ];
}

/** Le toit de grès de chaque tunnel, posé sur la tranchée de la voie au cœur de sa butte (un peu au-dessus de son sommet). */
function tunnels(): StaticBox[] {
  return [RAIL_N, RAIL_S].map((line) => {
    const [a, b] = [line[1], line[2]];
    const c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as const;
    const roof = along("platform", a, b, 0, RAIL_HALF + RAIL_FALL + 1, 1.575);
    return looked("sandstone", { ...roof, pos: vec3(c[0], BUTTE_TOP + 0.15 - 1.575, c[1]), half: vec3(roof.half.x, roof.half.y, BUTTE_R - 6) });
  });
}

/** La voie : des traverses et des rails au ras du sol (des « pistes »), un butoir à chaque bout. */
function railway(): StaticBox[] {
  const list: StaticBox[] = [];
  for (const line of [RAIL_N, RAIL_S]) {
    for (let i = 1; i < line.length; i++) list.push(looked("rail", along("road", line[i - 1], line[i], PLATEAU - 0.08, 1.3, 0.12, 0.6)));
    const [a, b] = [line[line.length - 2], line[line.length - 1]];
    list.push(looked("timber", along("barrier", b, [b[0] + (b[0] - a[0]) * 0.02, b[1] + (b[1] - a[1]) * 0.02], PLATEAU + 0.5, 1.5, 0.5, 0.2)));
  }
  return list;
}

/** Une voie de garage parallèle à la ligne, à `offset` m de côté (> 0 : à sa gauche), de `s0` à `s1` m de son début, et ses wagons. */
function siding(line: readonly Point[], s0: number, s1: number, offset: number, cars: readonly number[], small: boolean): StaticBox[] {
  const at = (s: number): Point => {
    const p = pointAlong(line, s);
    return [p.x - p.dz * offset, p.z + p.dx * offset];
  };
  const list: StaticBox[] = [looked("rail", along("road", at(s0), at(s1), PLATEAU - 0.07, 1.3, 0.12))];
  for (const s of cars) {
    const [hx, hy, hz] = small ? [0.8, 0.6, 1.1] : [1.35, 1.45, 3.4];
    list.push(looked("wagon", along("container", at(s - hz), at(s + hz), PLATEAU + 0.25 + hy, hx, hy)));
  }
  return list;
}

/** Rochers de grès : blocs dans le lit, sur le plateau et sur la Table, et cheminées de fée près des buttes. */
function rocks(): StaticBox[] {
  const random = seeded(23);
  const list: [number, number, number, number][] = [
    // Dans le lit du canyon : de quoi s'abriter (x, z, taille, élancement)
    [-22, -9, 1.5, 1], [22, 9, 1.5, 1], [-48, -6, 1.7, 1], [48, 6, 1.7, 1], [-88, -4, 1.8, 1], [88, 4, 1.8, 1],
    [-8, -7, 1.1, 1], [8, 7, 1.1, 1], [-56, -14, 1.6, 1], [-54, 2, 1.4, 1], [60, 8.5, 1.3, 1],
    // Sur le plateau
    [30, 56, 1.8, 1], [-30, -56, 1.8, 1], [16, 34, 1.4, 1], [-16, -34, 1.4, 1], [-86, 40, 2.2, 1], [86, -40, 2.2, 1],
    [-36, 64, 1.5, 1], [36, -64, 1.5, 1], [94, 64, 2.4, 1], [-94, -64, 2.4, 1], [56, 70, 1.6, 1], [-56, -70, 1.6, 1],
    // Cheminées de fée : des aiguilles de grès
    [-6, 50, 1.2, 3.2], [6, -50, 1.2, 3.2], [-50, 26, 1.1, 2.8], [50, -26, 1.1, 2.8], [100, 30, 1.3, 3.4], [-100, -30, 1.3, 3.4],
  ];
  const out = list.map(([x, z, size, tall]) => {
    const half = vec3(size * (0.9 + random() * 0.4), size * tall * (0.55 + random() * 0.25), size * (0.8 + random() * 0.4));
    const rot = qmul(yaw(random() * Math.PI), axisAngle(vec3(1, 0, 0), (random() - 0.5) * (tall > 1 ? 0.08 : 0.25)));
    return looked("sandstone", box("rock", x, ground(x, z) + half.y * (tall > 1 ? 0.85 : 0.55), z, half.x, half.y, half.z, rot));
  });
  // Sur la Table, quelques blocs au bord
  for (const [x, z] of [[62, 26], [60, -12], [88, 24]]) out.push(looked("sandstone", box("rock", x, MESA_TOP + 0.6, z, 1.6, 1.1, 1.3, yaw(random() * Math.PI))));
  return out;
}

/** La ville : le quai de la gare, le château d'eau sur pilotis, le clocher. */
function townScenery(): StaticBox[] {
  const p = pointAlong(RAIL_N, 70);
  const platform = { x: p.x + p.dz * 3.6, z: p.z - p.dx * 3.6 };
  return [
    looked("timber", box("platform", platform.x, PLATEAU + 0.3, platform.z, 1.1, 0.3, 7, yaw(Math.atan2(p.dx, p.dz)))),
    // Château d'eau : quatre pieds et une plateforme (le réservoir est un accessoire)
    ...[[-1, -1], [-1, 1], [1, -1], [1, 1]].map(([sx, sz]) => looked("timber", box("pillar", WATER_TOWER.x + sx * 1.4, PLATEAU + 3, WATER_TOWER.z + sz * 1.4, 0.22, 3, 0.22))),
    looked("timber", box("platform", WATER_TOWER.x, PLATEAU + 6.15, WATER_TOWER.z, 2, 0.15, 2)),
    // Le clocher de l'église
    looked("timber", box("pillar", CHURCH.x, PLATEAU + 7, CHURCH.z + 7, 1.3, 7, 1.3)),
  ];
}

/** La mine : le chevalement (quatre pieds, sa cage, sa plateforme et la molette), la voie des wagonnets. */
function mineScenery(): StaticBox[] {
  const h = HEADFRAME;
  return [
    ...[[-1, -1], [-1, 1], [1, -1], [1, 1]].map(([sx, sz]) => looked("timber", box("pillar", h.x + sx * 1.6, PLATEAU + 5.5, h.z + sz * 1.6, 0.25, 5.5, 0.25))),
    looked("timber", box("barrier", h.x, PLATEAU + 1.2, h.z, 1.9, 1.2, 1.9)),
    looked("timber", box("platform", h.x, PLATEAU + 11.15, h.z, 2.3, 0.2, 2.3)),
    looked("timber", box("platform", h.x, PLATEAU + 12.6, h.z, 0.25, 1.25, 1.4)),
    // Une jambe de force vers le treuil
    looked("timber", box("pillar", h.x, PLATEAU + 5.2, h.z + 4.5, 0.22, 5.8, 0.22, axisAngle(vec3(1, 0, 0), -0.55))),
  ];
}

/**
 * Limites invisibles, au fond des montagnes (à ±BOUND_AT m, jusqu'à BOUND_TOP m de haut), comme
 * dans la Vallée.
 */
const BOUND_AT = 140;
const BOUND_TOP = 110;
function bounds(): StaticBox[] {
  const t = 2;
  return [-1, 1].flatMap((s) => [
    box("bound", 0, BOUND_TOP / 2, s * (BOUND_AT + t), BOUND_AT + 2 * t, BOUND_TOP / 2, t),
    box("bound", s * (BOUND_AT + t), BOUND_TOP / 2, 0, t, BOUND_TOP / 2, BOUND_AT + 2 * t),
  ]);
}

const WATER_TOWER = { x: -44, z: 59 };
const CHURCH = { x: -78, z: 64 };
const HEADFRAME = { x: 70, z: -79 };

const boxes = lazy((): readonly StaticBox[] => [
  ...viaduct(), ...arch(), ...tunnels(), ...railway(),
  ...siding(RAIL_N, 60, 84, 4.6, [66, 76], false),
  ...siding(RAIL_S, 66, 88, 4.6, [72, 82], false),
  ...siding([[64, -60], [69, -74.5]], 0, 15.3, 0, [5, 10.5], true),
  ...rocks(), ...townScenery(), ...mineScenery(), ...bounds(),
]);

/** Chemins de terre (dessinés ; on y roule comme ailleurs), et les sentiers. */
const PATHS: readonly TerrainPath[] = [
  { width: 5, points: [[0, 78], [2, 50], [0, DECK_HALF + 4]] },
  { width: 5, points: [[0, -78], [-2, -50], [0, -DECK_HALF - 4]] },
  { width: 4, points: [[-22, 80], [-38, 74], [-46, 72]] },
  { width: 4, points: [[22, -80], [38, -74], [46, -72]] },
  { width: 6, points: [[-46, 72], [-84, 72]] },
  { width: 4, points: [[20, 78], [42, 52], [TABLE.x - 23, TABLE.z + 18]] },
  { width: 4, points: [[-20, -78], [-42, -60], [-57.2, -57.3]] },
  { width: 4, points: [[-56, 64], [-58, 42]] },
  { width: 4, points: [[56, -64], [52.7, -14]] },
  ...[...CANYON_TRAILS, ...TABLE_TRAILS].map((t) => ({ width: t.width - 1, points: t.nodes })),
];

const ZONES: readonly CaptureZone[] = [
  zone("A", TABLE.x, MESA_TOP, TABLE.z, 5.5),
  zone("B", TOWN.x, PLATEAU, TOWN.z + 0.5, 6.5),
  zone("C", 0, PLATEAU, 0, 6),
  zone("D", MINE.x, PLATEAU, MINE.z, 7),
  zone("E", -64, FLOOR, -4, 7),
];

/** Un arbre, un cactus posé sur le relief (à l'échelle `scale`). */
function plant(P: PropList, type: "oak" | "cactus", x: number, z: number, scale: number): void {
  const half = propHalf(type, { scale });
  P.add({ type, pos: vec3(x, ground(x, z) + half.y, z), scale });
}

/** Des planches debout le long d'une ligne (une clôture, une barre d'attache), en pans de 2,5 m au plus. */
function fence(P: PropList, x: number, z: number, along: "x" | "z", length: number, height = 0.55): void {
  const n = Math.ceil(length / 2.5);
  for (let i = 0; i < n; i++) {
    const t = -length / 2 + (length / n) * (i + 0.5);
    const px = along === "x" ? x + t : x;
    const pz = along === "z" ? z + t : z;
    const half = along === "x" ? vec3(length / (2 * n), height, 0.05) : vec3(0.05, height, length / (2 * n));
    P.add({ type: "plank", pos: vec3(px, ground(px, pz) + height, pz), half });
  }
}

const on = (P: PropList, type: PropType, list: readonly (readonly number[])[], y = PLATEAU): void => {
  const lift = type === "gas" ? 0.55 : 0.5;
  for (const [x, z, dy = 0] of list) P.add({ type, pos: vec3(x, y + lift + dy, z) });
};

function buildProps(): PropSpot[] {
  const P = new PropList();
  const t = TOWN;
  const g = PLATEAU;

  // La ville : une grand-rue d'est en ouest ; au nord, le saloon (et sa fausse façade), l'épicerie,
  // le bureau du shérif ; au sud, deux maisons et la gare ; à l'est, l'église et son clocher
  const saloonFirst = P.spots.length;
  house(P, { x: t.x, z: t.z + 8, w: 10, d: 8, h: 5.5, ground: g, wall: "plank", roof: "plank", roofKind: "flat", ridge: "x", door: 2.4 });
  const front = P.spots.slice(saloonFirst).map((s, i) => ({ s, i: saloonFirst + i })).filter(({ s }) => s.type === "plank" && Math.abs(s.pos.z - (t.z + 4.15)) < 0.1 && Math.abs(s.pos.y - (g + 2.75)) < 0.1);
  P.add({ type: "plank", pos: vec3(t.x, g + 6.6, t.z + 4.15), half: vec3(5.6, 1.1, 0.15), rests: front.map((f) => f.i), building: P.spots[saloonFirst].building });
  house(P, { x: t.x - 13, z: t.z + 7, w: 8, d: 6, h: 4, ground: g, wall: "plank", roof: "sheet", roofKind: "gable", ridge: "x", door: 2 });
  house(P, { x: t.x + 11, z: t.z + 7, w: 6, d: 6, h: 3.6, ground: g, wall: "brick", roof: "plank", roofKind: "flat", ridge: "x", door: 1.6 });
  house(P, { x: -66, z: t.z - 8, w: 7, d: 6, h: 3.2, ground: g, wall: "plank", roof: "roof", roofKind: "gable", ridge: "x", flip: true });
  house(P, { x: -49, z: t.z - 7, w: 6, d: 5, h: 3, ground: g, wall: "plank", roof: "sheet", roofKind: "gable", ridge: "x", flip: true });
  house(P, { x: -58, z: 62, w: 7, d: 4.5, h: 3.4, ground: g, wall: "plank", roof: "roof", roofKind: "gable", ridge: "x", door: 2 });
  house(P, { x: CHURCH.x, z: CHURCH.z, w: 10, d: 7, h: 4.5, ground: g, wall: "plank", roof: "roof", roofKind: "gable", ridge: "z", door: 2.2, flip: true });
  // Le réservoir du château d'eau, sur sa plateforme
  P.add({ type: "watertank", pos: vec3(WATER_TOWER.x, PLATEAU + 6.3 + 1.5, WATER_TOWER.z) });
  // Barres d'attache et clôtures, caisses, barils, bouteilles de gaz
  fence(P, t.x + 4, t.z + 2.6, "x", 5, 0.5);
  fence(P, t.x - 13, t.z + 2.8, "x", 5, 0.5);
  fence(P, -66, t.z - 11, "x", 7);
  fence(P, -70, t.z - 6, "z", 6);
  on(P, "crate", [[t.x + 7, t.z + 3], [t.x + 7, t.z + 4.05], [t.x - 18, t.z + 2], [-53, 59], [-53, 60.05], [-53, 59.5, 1]]);
  on(P, "barrel", [[t.x - 6, t.z + 3.2], [t.x - 6.8, t.z + 3.6], [-41.5, 62], [-52, t.z - 2.6], [-83, t.z - 2]]);
  on(P, "gas", [[t.x + 14, t.z + 3], [-62, t.z - 2.5]]);

  // La mine : la baraque du treuil, le hangar du concasseur, le dortoir ; des caisses d'explosifs et des barils
  const m = MINE;
  house(P, { x: HEADFRAME.x + 9, z: HEADFRAME.z + 9, w: 6, d: 5, h: 3.5, ground: g, wall: "plank", roof: "sheet", roofKind: "gable", ridge: "x", door: 2 });
  house(P, { x: 46, z: -82, w: 10, d: 7, h: 5, ground: g, wall: "sheet", roof: "sheet", roofKind: "gable", ridge: "x", door: 5, flip: true });
  house(P, { x: 48, z: -63, w: 8, d: 5, h: 3, ground: g, wall: "plank", roof: "roof", roofKind: "gable", ridge: "x", door: 1.8 });
  P.add({ type: "tank", pos: vec3(80, g + 1.7, -64) });
  on(P, "crate", [[m.x - 4, m.z - 6], [m.x - 2.95, m.z - 6], [m.x - 3.5, m.z - 6, 1], [m.x + 6, m.z + 5], [HEADFRAME.x - 4, HEADFRAME.z + 3]]);
  on(P, "barrel", [[HEADFRAME.x - 3, HEADFRAME.z - 3], [HEADFRAME.x - 3.8, HEADFRAME.z - 2.4], [m.x - 8, m.z + 2], [52, -76], [73, -74], [76, -66]]);
  on(P, "gas", [[m.x + 4, m.z - 2], [54, -60]]);
  fence(P, 58, -88, "x", 10);

  // L'oasis : des chênes autour de la mare, une ruine de pisé (trois pans de brique, sans toit)
  const ruin = P.newBuilding();
  for (const [x, z, hx, hz] of [[-76, -24.5, 2.5, 0.25], [-78.25, -22, 0.25, 2.3], [-73.75, -23, 0.25, 1.3]]) {
    P.add({ type: "brick", pos: vec3(x, ground(x, z) + 1.1, z), half: vec3(hx, 1.1, hz), building: ruin });
  }
  for (const [x, z, s] of [[-86, -10, 1.05], [-85, -17, 0.9], [-70, -14, 1], [-80, -3, 1.1], [-88, -1, 0.9], [-73, 0, 0.95], [-92, -12, 1], [-78, 4, 0.85]]) {
    plant(P, "oak", x, z, s);
  }
  on(P, "crate", [[-60, -12], [-60, -10.95]], ground(-60, -12));

  // Des cactus sur le plateau : ni sur les chemins, les voies, les sites, les zones, ni au bord d'une pente
  const random = seeded(41);
  const taken: [number, number][] = P.spots.map((s) => [s.pos.x, s.pos.z]);
  for (const b of boxes()) if (b.kind !== "road" && b.kind !== "bound") taken.push([b.pos.x, b.pos.z]);
  const steep = (x: number, z: number): boolean =>
    Math.max(Math.abs(ground(x + 2, z) - ground(x - 2, z)), Math.abs(ground(x, z + 2) - ground(x, z - 2))) > 0.6;
  const clear = (x: number, z: number, spacing: number): boolean =>
    !steep(x, z) && Math.min(lineDistance(x, z, RAIL_N), lineDistance(x, z, RAIL_S)) > 6
    && PATHS.every((p) => lineDistance(x, z, p.points) > p.width / 2 + 2)
    && taken.every(([tx, tz]) => Math.hypot(tx - x, tz - z) > spacing)
    && ZONES.every((zn) => Math.hypot(zn.pos.x - x, zn.pos.z - z) > zn.radius + 4)
    && !(Math.abs(x) < 44 && Math.abs(z) > 70) // lignes de départ
    && Math.hypot(x - t.x, z - t.z) > 26 && Math.hypot(x - m.x, z - m.z) > 26
    && canyonDistance(x, z) > floorHalf(x) + WALL_RUN + 3;
  for (let k = 0, placed = 0; k < 900 && placed < 46; k++) {
    const x = (random() * 2 - 1) * 98;
    const z = (random() * 2 - 1) * 98;
    if (!clear(x, z, 9)) continue;
    plant(P, "cactus", x, z, 0.8 + random() * 0.5);
    taken.push([x, z]);
    placed++;
  }
  // Et quelques-uns dans le lit, à l'abri des parois
  for (let k = 0, placed = 0; k < 400 && placed < 10; k++) {
    const x = (random() * 2 - 1) * 96;
    const [px, pz] = besideCanyon(x, random() < 0.5 ? 1 : -1, floorHalf(x) - 1.5);
    if (steep(px, pz) || taken.some(([tx, tz]) => Math.hypot(tx - px, tz - pz) < 8) || Math.abs(px) < 8) continue;
    if (ZONES.some((zn) => Math.hypot(zn.pos.x - px, zn.pos.z - pz) < zn.radius + 3) || Math.hypot(px - POND.x, pz - POND.z) < POND.r + 3) continue;
    plant(P, "cactus", px, pz, 0.75 + random() * 0.4);
    taken.push([px, pz]);
    placed++;
  }
  return P.spots;
}

const props = lazy(buildProps);

/** Ce qui arrête un robot au sol, pour placer le réseau de passage à l'écart : décor, bâtiments. */
function blocked(x: number, z: number, margin: number): boolean {
  for (const b of boxes()) {
    if (b.kind === "road" || b.kind === "deck" || b.kind === "bound") continue;
    const reach = Math.hypot(b.half.x, b.half.z);
    if (Math.hypot(x - b.pos.x, z - b.pos.z) < reach + margin) return true;
  }
  return props().some((s) => {
    const half = propHalf(s.type, s);
    return Math.hypot(x - s.pos.x, z - s.pos.z) < Math.max(half.x, half.z) + margin;
  });
}

/**
 * Réseau de passage de l'IA au sol : une grille sur le plateau, le lit et le dessus de la Table, la
 * ligne médiane du canyon, les sentiers, les tunnels, et les abords du viaduc et de l'arche (reliés
 * par-dessus le vide).
 */
function navGraph(): NavGraph {
  const points: [number, number][] = [];
  const add = (x: number, z: number): number => {
    points.push([x, z]);
    return points.length - 1;
  };
  const t = terrain();
  const flat = (x: number, z: number): boolean => walkable(t, x - 2.5, z, x + 2.5, z) && walkable(t, x, z - 2.5, x, z + 2.5);
  // Grille : un point tous les 14 m, déplacé un peu s'il tombe sur un obstacle ou une pente
  for (let x = -98; x <= 98; x += 14) {
    for (let z = -98; z <= 98; z += 14) {
      const spot = [[0, 0], [5, 0], [-5, 0], [0, 5], [0, -5]].map(([dx, dz]) => [x + dx, z + dz]).find(([px, pz]) => flat(px, pz) && !blocked(px, pz, 2.5));
      if (spot) add(spot[0], spot[1]);
    }
  }
  // Le lit du canyon
  for (let x = -98; x <= 98; x += 9) {
    const z = canyonZ(x);
    const spot = [0, 2.5, -2.5].map((dz) => z + dz).find((pz) => !blocked(x, pz, 2));
    if (spot !== undefined) add(x, spot);
  }
  // Les sentiers (et leurs paliers)
  for (const t of [...CANYON_TRAILS, ...TABLE_TRAILS]) for (const [x, z] of t.nodes) add(x, z);
  // Les tunnels, le long de la voie
  for (const line of [RAIL_N, RAIL_S]) {
    const [a, b] = [line[1], line[2]];
    for (let k = 0; k <= 6; k++) {
      const u = 0.12 + (0.76 * k) / 6;
      add(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u);
    }
  }
  // Abords du viaduc et de l'arche, reliés l'un à l'autre par-dessus le vide
  const deckN = add(0, DECK_HALF + 5);
  const deckS = add(0, -DECK_HALF - 5);
  const archN = add(TABLE.x, TABLE.z + ARCH_HALF + 5);
  const archS = add(TABLE.x, TABLE.z - ARCH_HALF - 5);
  return { points, links: linkNav(t, points, [[deckN, deckS], [archN, archS]]) };
}
const nav = lazy(navGraph);

export const CANYON: ArenaLayout = {
  id: "canyon",
  // Les avions de l'IA volent au-dessus du clocher, du chevalement et des buttes ; le relief (la Table) les fait monter
  bounds: { half: 105, roam: 90, spawnLine: 84, spawnSpread: 30, circuit: 72, airFloor: 18 },
  // Relief, décor, accessoires et réseau de passage se construisent à la première lecture : une
  // seconde de calcul que ne paie que la partie jouée ici (pas le chargement de la page)
  get boxes() {
    return boxes();
  },
  get props() {
    return props();
  },
  zones: ZONES,
  get terrain() {
    return terrain();
  },
  water: WATER,
  paths: PATHS,
  sky: { color: "#e6c39b", fog: 0.0042 },
  places: [
    { place: "town", x: TOWN.x, z: TOWN.z + 3 },
    { place: "mine", x: MINE.x + 4, z: MINE.z - 4 },
    { place: "mesa", x: TABLE.x + 8, z: TABLE.z + 22 },
    { place: "arch", x: TABLE.x, z: TABLE.z },
    { place: "oasis", x: OASIS.x - 6, z: OASIS.z - 6 },
    { place: "viaduct", x: 0, z: 0 },
    { place: "northTunnel", x: BUTTES[0][0], z: BUTTES[0][1] },
    { place: "southTunnel", x: BUTTES[1][0], z: BUTTES[1][1] },
  ],
  ground: {
    base: ["#c98f5b", "#d6a46c"],
    dirt: "#a8714a",
    sand: "#dcc391",
    mud: "#6a5a40",
    rock: "#a4573a",
    strata: ["#9a4a2e", "#b8653f", "#cf8f5f", "#a95536", "#dcae7c", "#8f4430"],
    strataStep: 1.7,
    rockLine: 34,
    peak: "#eef1f3",
    peakLine: Infinity,
    patches: [{ x: POND.x, z: POND.z, r: 15, color: "#7f8f45" }, { x: -66, z: -4, r: 8, color: "#a99a5a" }],
  },
  get nav() {
    return nav();
  },
};
