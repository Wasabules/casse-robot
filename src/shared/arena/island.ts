import type { PropType } from "../catalog/props";
import { add, axisAngle, qmul, qrot, vec3, type Quat, type Vec3 } from "../math/vec";
import { barrier, box, zone } from "./builders";
import { segmentDistance, type LavaShape, type Vent, type Waterfall } from "./features";
import type { ArenaLayout, CaptureZone, PropSpot, StaticBox, TerrainPath } from "./layout";
import { makeTerrain, noise2, smoothstep, terrainHeight } from "./terrain";
import { house, PropList, seeded } from "./valley";
import { dcos, dpow, dsin } from "../math/det";

/*
 * L'Île volcanique : une île tropicale (la mer tout autour, une vraie limite : on s'y noie),
 * dominée par un volcan. Deux routes en lacets montent à son cratère, où bout un lac de lave (zone
 * A) ; deux coulées descendent vers la mer au sud-ouest et au nord-est, chacune coupée par un gué
 * de basalte figé ; deux gorges, à l'ouest et à l'est, où l'eau tombe en cascade, se passent sur
 * des ponts de bois. Autour : le village de pêcheurs et ses cases sur pilotis dans la lagune
 * (nord-ouest, zone B), les bunkers de la côte sud-est (zone C), la piste d'aviation en herbe
 * (sud-ouest, zone D), la plage de l'épave (nord-est, zone E), et la jungle.
 *
 * Nord = +z (les rouges partent de la plage du nord, les bleus de celle du sud), ouest = +x. Les
 * lieux se répondent par symétrie autour du volcan (le village et les bunkers, la piste et la
 * plage, chaque gorge et chaque coulée) : aucun camp n'est avantagé.
 */

/** Niveau de la mer (m), et au-delà de quelle profondeur l'eau noie (m). */
const WATER = 2;
const DEEP = 1.1;
/** Hauteur de l'intérieur des terres, du fond de la mer (m). */
const LAND = 3.4;
const SEABED = 0.15;
/** Les terres montent doucement vers le volcan : de `RISE` m de plus à son pied, rien à `RISE_END` m du centre. */
const RISE = 3.5;
const RISE_END = 95;
/** Côte : distance au centre (m) ; la plage descend jusqu'à elle sur `BEACH` m, puis le haut-fond jusqu'au large sur `SHELF` m. */
const COAST = 116;
const BEACH = 16;
const SHELF = 18;
/** Volcan : le haut de la lèvre du cratère (rayon, hauteur), le fond du cratère, le pied du cône (m). */
const RIM_R = 15;
const RIM_H = 31;
const FLOOR_R = 11;
const FLOOR_H = 26;
const FOOT_R = 52;
/**
 * Routes en lacets : largeur, rayon du pied, et rayon où elles finissent, dans le cratère ; elles
 * tournent de ROAD_TURN degrés autour du volcan, de moins en moins vite : leur fin est droite,
 * dans l'axe d'une brèche de la lèvre.
 */
const ROAD_W = 9;
const ROAD_FOOT = 47;
const ROAD_END = 8.5;
/** Largeur du talus d'une route (m) : le déblai, le remblai. */
const BANK = 3.5;
const ROAD_TURN = 250;
/** Gorges : largeur au fond et en haut, hauteur du fond (sous l'eau profonde : on ne la traverse qu'au pont) (m). */
const GORGE_BOTTOM = 2;
const GORGE_TOP = 5.5;
const GORGE_FLOOR = 0.4;
/** Ponts de bois : hauteur du tablier, demi-longueur (m). */
const DECK = 4.4;
const DECK_HALF = 9.5;
/** Coulées de lave : largeur, creux du relief sous elles (m). */
const LAVA_W = 7;
const LAVA_SINK = 0.5;
/** Lagune du village : le fond, peu profond (on y marche). */
const LAGOON_FLOOR = 1.3;
/**
 * Le fond du cratère : les routes y entrent par deux brèches qui se font face (à 340° et 160°) ;
 * le lac de lave et la zone A sont de part et d'autre de la ligne qui les joint.
 */
const POOL = { x: -2.05, z: -5.64, r: 3 };
const SUMMIT = { x: 1.54, z: 4.23, r: 4.5 };

const yaw = (a: number): Quat => axisAngle(vec3(0, 1, 0), a);
/** Le point symétrique (autour du volcan) : chaque lieu a son pendant de l'autre côté. */
const mirror = (p: readonly [number, number]): [number, number] => [-p[0], -p[1]];

// ─── Les routes en lacets ───────────────────────────────────────────────────────────────────

/** Point (x, z) d'une route : son angle (deg) autour du volcan, sa distance au centre. */
const polar = (deg: number, r: number): [number, number] => [r * dcos((deg * Math.PI) / 180), r * dsin((deg * Math.PI) / 180)];

/** Une route en lacets, de son pied (à l'angle `start`, deg) au cratère : ses points (x, z) et la hauteur de la chaussée en chacun. */
interface Road {
  readonly points: readonly (readonly [number, number])[];
  readonly line: Polyline;
  readonly heights: readonly number[];
}

/**
 * Une ligne brisée prête aux recherches de distance : ses segments par paquets de CHUNK, chacun
 * avec son emprise. Le relief se calcule en 83 000 points, la plupart loin d'elle : on écarte un
 * paquet entier d'un coup.
 */
interface Polyline {
  readonly xs: Float64Array;
  readonly zs: Float64Array;
  readonly chunks: readonly { from: number; to: number; minX: number; maxX: number; minZ: number; maxZ: number }[];
}
const CHUNK = 8;

function polyline(points: readonly (readonly [number, number])[]): Polyline {
  const xs = Float64Array.from(points, (q) => q[0]);
  const zs = Float64Array.from(points, (q) => q[1]);
  const chunks = [];
  for (let from = 0; from < points.length - 1; from += CHUNK) {
    const to = Math.min(points.length - 1, from + CHUNK);
    const px = xs.subarray(from, to + 1);
    const pz = zs.subarray(from, to + 1);
    chunks.push({ from, to, minX: Math.min(...px), maxX: Math.max(...px), minZ: Math.min(...pz), maxZ: Math.max(...pz) });
  }
  return { xs, zs, chunks };
}

/** Où tombe le point le plus proche trouvé par le dernier `nearest` : indice de son segment, plus la fraction parcourue. */
let nearestAt = 0;

/** Distance de (x, z) à la ligne si elle est de moins de `reach` m ; Infinity sinon. */
function nearest(line: Polyline, x: number, z: number, reach = Infinity): number {
  const { xs, zs } = line;
  let best = reach;
  let found = false;
  for (const c of line.chunks) {
    const ox = Math.max(0, c.minX - x, x - c.maxX);
    const oz = Math.max(0, c.minZ - z, z - c.maxZ);
    if (ox * ox + oz * oz >= best * best) continue;
    for (let i = c.from; i < c.to; i++) {
      const dx = xs[i + 1] - xs[i];
      const dz = zs[i + 1] - zs[i];
      const t = Math.max(0, Math.min(1, ((x - xs[i]) * dx + (z - zs[i]) * dz) / (dx * dx + dz * dz || 1)));
      const ex = x - xs[i] - dx * t;
      const ez = z - zs[i] - dz * t;
      const d = Math.sqrt(ex * ex + ez * ez);
      if (d < best) {
        best = d;
        nearestAt = i + t;
        found = true;
      }
    }
  }
  return found ? best : Infinity;
}

function spiralRoad(start: number): Road {
  const points: [number, number][] = [];
  const n = 90;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    // L'angle avance de moins en moins vite (sa dérivée s'annule au bout) : la fin de la route est radiale
    points.push(polar(start + ROAD_TURN * (2 * t - t * t), ROAD_FOOT + (ROAD_END - ROAD_FOOT) * t));
  }
  // Une pente régulière (d'après la longueur parcourue) du pied jusqu'au bord du cratère, puis à plat
  const along = [0];
  for (let k = 1; k <= n; k++) along.push(along[k - 1] + Math.hypot(points[k][0] - points[k - 1][0], points[k][1] - points[k - 1][1]));
  const rim = along[points.findIndex((q) => Math.hypot(q[0], q[1]) <= RIM_R + 1)];
  const foot = natural(...polar(start, ROAD_FOOT));
  const heights = along.map((d) => foot + (FLOOR_H - foot) * Math.min(1, d / rim));
  return { points, line: polyline(points), heights };
}

// ─── Le relief ──────────────────────────────────────────────────────────────────────────────

/** Le volcan en (r, θ) : la lèvre du cratère, son fond, le cône, ravinés par l'érosion. */
function volcano(r: number, theta: number): number {
  if (r < RIM_R) return FLOOR_H + (RIM_H - FLOOR_H) * smoothstep(FLOOR_R, RIM_R, r);
  const cone = LAND + (RIM_H - LAND) * dpow(1 - smoothstep(RIM_R, FOOT_R, r), 1.1);
  const gullies = 1.3 * noise2(theta * 4 + 3, r / 6) * smoothstep(RIM_R, RIM_R + 5, r) * (1 - smoothstep(FOOT_R - 12, FOOT_R, r));
  return cone + gullies;
}

/** L'île sans ses aménagements : l'intérieur des terres, la plage, le haut-fond, et le volcan. */
function natural(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const theta = Math.atan2(z, x);
  const coast = COAST + 7 * noise2(dcos(theta) * 2.3 + 11, dsin(theta) * 2.3 - 4);
  let h = LAND + RISE * (1 - smoothstep(FOOT_R - 2, RISE_END, r)) + 0.7 * noise2(x / 34, z / 34) + 0.35 * noise2(x / 13 + 31, z / 13 - 7);
  h += (WATER - 0.25 - h) * smoothstep(coast - BEACH, coast, r);
  h += (SEABED - h) * smoothstep(coast, coast + SHELF, r);
  return r < FOOT_R + 4 ? Math.max(h, volcano(r, theta)) : h;
}

/** Site aplani : un disque (`r`) ou un rectangle, à la hauteur `h`, raccordé au relief sur `fall` m. */
type Flat = { h: number; fall: number } & ({ x: number; z: number; r: number } | { minX: number; maxX: number; minZ: number; maxZ: number });

const VILLAGE = { x: 74, z: 62, h: 3 };
const BUNKERS = { x: -74, z: -62, h: 4.6 };
const STRIP = { minX: 30, maxX: 94, minZ: -74, maxZ: -60, h: 3.5 };
const BEACH_SITE = { x: -62, z: 66, h: 2.75 };
const SPAWN_H = 2.6;
const LAGOON = { x: 92, z: 78, r: 13 };

/** Gorges : leur cours, de la cascade à la mer (celle de l'est est le pendant de celle de l'ouest). */
const GORGE_WEST: readonly (readonly [number, number])[] = [[64, 25], [72, 28], [86, 30], [102, 36], [124, 45]];
const GORGE_EAST = GORGE_WEST.map(mirror);
/** Ponts de bois : sur la partie de chaque gorge qui court le long de x (un tablier dans l'axe z). */
const BRIDGE_WEST = { x: 78, z: 28.9 };
const BRIDGE_EAST = { x: -78, z: -28.9 };

/** Coulées de lave : de la fissure (au pied du volcan) à la mer, coupées par un gué de basalte figé. */
const LAVA_WEST_UP: readonly (readonly [number, number])[] = [[63, -21], [70, -24], [76, -26.5]];
const LAVA_WEST_DOWN: readonly (readonly [number, number])[] = [[94, -35], [106, -39], [118, -44.5]];
/** Le gué de basalte figé, entre les deux tronçons de chaque coulée (une douzaine de mètres sans lave). */
const FORD_WEST: readonly [number, number] = [85, -30.75];
const LAVA: readonly LavaShape[] = [
  { kind: "flow", width: LAVA_W, points: LAVA_WEST_UP },
  { kind: "flow", width: LAVA_W, points: LAVA_WEST_DOWN },
  { kind: "flow", width: LAVA_W, points: LAVA_WEST_UP.map(mirror) },
  { kind: "flow", width: LAVA_W, points: LAVA_WEST_DOWN.map(mirror) },
  // Le lac de lave, au fond du cratère
  { kind: "pool", ...POOL },
];

const FLATS: readonly Flat[] = [
  { x: VILLAGE.x, z: VILLAGE.z, r: 17, h: VILLAGE.h, fall: 9 },
  { x: BUNKERS.x, z: BUNKERS.z, r: 17, h: BUNKERS.h, fall: 9 },
  { ...STRIP, fall: 9 },
  { x: BEACH_SITE.x, z: BEACH_SITE.z, r: 13, h: BEACH_SITE.h, fall: 8 },
  // Plages de départ
  { minX: -42, maxX: 42, minZ: 78, maxZ: 97, h: SPAWN_H, fall: 10 },
  { minX: -42, maxX: 42, minZ: -97, maxZ: -78, h: SPAWN_H, fall: 10 },
  // Culées des ponts : le relief monte jusqu'au tablier, de part et d'autre de la gorge
  ...[BRIDGE_WEST, BRIDGE_EAST].flatMap((b) => [
    { minX: b.x - 3.5, maxX: b.x + 3.5, minZ: b.z + DECK_HALF - 2, maxZ: b.z + DECK_HALF + 3, h: DECK, fall: 8 },
    { minX: b.x - 3.5, maxX: b.x + 3.5, minZ: b.z - DECK_HALF - 3, maxZ: b.z - DECK_HALF + 2, h: DECK, fall: 8 },
  ]),
];

/** Emprise d'un site aplani, sa pente de raccord comprise : au-delà, il ne change rien. */
const flatBox = (f: Flat): { minX: number; maxX: number; minZ: number; maxZ: number } => "r" in f
  ? { minX: f.x - f.r - f.fall, maxX: f.x + f.r + f.fall, minZ: f.z - f.r - f.fall, maxZ: f.z + f.r + f.fall }
  : { minX: f.minX - f.fall, maxX: f.maxX + f.fall, minZ: f.minZ - f.fall, maxZ: f.maxZ + f.fall };
const FLAT_BOXES = FLATS.map(flatBox);

function flatWeight(f: Flat, x: number, z: number): number {
  const out = "r" in f
    ? Math.max(0, Math.hypot(x - f.x, z - f.z) - f.r)
    : Math.hypot(Math.max(0, f.minX - x, x - f.maxX), Math.max(0, f.minZ - z, z - f.maxZ));
  return 1 - smoothstep(0, f.fall, out);
}

const GORGES = [polyline(GORGE_WEST), polyline(GORGE_EAST)];
const LAVA_LINES = new Map(LAVA.flatMap((shape) => (shape.kind === "flow" ? [[shape, polyline(shape.points)] as const] : [])));

/** Le relief de l'île en (x, z) (m) : la nature, puis les sites aplanis, les routes, les gorges, la lave, la lagune. */
function islandHeight(x: number, z: number): number {
  let h = natural(x, z);
  for (let i = 0; i < FLATS.length; i++) {
    const b = FLAT_BOXES[i];
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
    const w = flatWeight(FLATS[i], x, z);
    if (w > 0) h += (FLATS[i].h - h) * w;
  }
  // Les routes en lacets : une chaussée taillée dans le cône (déblai en amont, remblai en aval)
  if (Math.hypot(x, z) < ROAD_FOOT + ROAD_W + 4) {
    for (const road of ROADS) {
      const d = nearest(road.line, x, z, ROAD_W / 2 + BANK);
      if (d === Infinity) continue;
      const i = Math.min(road.heights.length - 2, Math.floor(nearestAt));
      const hr = road.heights[i] + (road.heights[i + 1] - road.heights[i]) * (nearestAt - i);
      h += (hr - h) * (1 - smoothstep(ROAD_W / 2, ROAD_W / 2 + BANK, d));
    }
  }
  // Les gorges : un fond sous l'eau profonde, des parois raides ; à leur tête, une falaise (la cascade)
  for (const gorge of GORGES) {
    const d = nearest(gorge, x, z, GORGE_TOP);
    if (d < GORGE_TOP) h = Math.min(h, GORGE_FLOOR + (h - GORGE_FLOOR) * smoothstep(GORGE_BOTTOM, GORGE_TOP, d));
  }
  // La lave : un chenal un peu creusé ; le lac du cratère, une cuvette
  for (const shape of LAVA) {
    const d = shape.kind === "pool" ? Math.hypot(x - shape.x, z - shape.z) - shape.r : nearest(LAVA_LINES.get(shape)!, x, z, shape.width / 2 + 2) - shape.width / 2;
    if (d < 2) h -= LAVA_SINK * (1 - smoothstep(-1, 2, d));
  }
  // La lagune du village : peu profonde (on y marche), sous les cases sur pilotis
  const lagoon = Math.hypot(x - LAGOON.x, z - LAGOON.z) - LAGOON.r;
  if (lagoon < 7) h = Math.min(h, h + (LAGOON_FLOOR - h) * (1 - smoothstep(0, 7, lagoon)));
  return Math.max(SEABED, h);
}

const ROADS: readonly Road[] = [spiralRoad(90), spiralRoad(270)];

const TERRAIN = makeTerrain(360, 288, islandHeight);
/** Hauteur du sol telle que la voient la physique et le rendu (le relief échantillonné). */
const ground = (x: number, z: number): number => Math.max(0, terrainHeight(TERRAIN, x, z));

// ─── Les zones, les chemins ─────────────────────────────────────────────────────────────────

const ZONES: readonly CaptureZone[] = [
  zone("A", SUMMIT.x, FLOOR_H, SUMMIT.z, SUMMIT.r),
  zone("B", VILLAGE.x, VILLAGE.h, VILLAGE.z - 2, 7),
  zone("C", BUNKERS.x, BUNKERS.h, BUNKERS.z + 2, 7),
  zone("D", 62, STRIP.h, -66, 6),
  zone("E", BEACH_SITE.x, BEACH_SITE.h, BEACH_SITE.z, 6),
];

/** Pistes de terre (et la piste d'aviation, en herbe rase) : des plages de départ aux lieux, aux pieds des routes, aux ponts et aux gués. */
const PATHS: readonly TerrainPath[] = [
  { width: 5, points: [[0, 80], [2, 62], [0, 49]] },
  { width: 5, points: [[0, -80], [-2, -62], [0, -49]] },
  { width: 4, points: [[18, 82], [44, 70], [VILLAGE.x - 12, VILLAGE.z]] },
  { width: 4, points: [[-18, -82], [-44, -70], [BUNKERS.x + 12, BUNKERS.z]] },
  { width: 4, points: [[-18, 82], [-40, 74], [BEACH_SITE.x + 8, BEACH_SITE.z]] },
  { width: 4, points: [[18, -82], [40, -74], [STRIP.minX + 2, -66]] },
  // Le tour de l'île par l'ouest : du village au pont de bois, puis au gué de basalte et à la piste
  { width: 4, points: [[VILLAGE.x, VILLAGE.z - 10], [BRIDGE_WEST.x, BRIDGE_WEST.z + DECK_HALF + 4], [BRIDGE_WEST.x, BRIDGE_WEST.z - DECK_HALF - 4], FORD_WEST, [70, -56]] },
  { width: 4, points: [[BUNKERS.x, BUNKERS.z + 10], [BRIDGE_EAST.x, BRIDGE_EAST.z - DECK_HALF - 4], [BRIDGE_EAST.x, BRIDGE_EAST.z + DECK_HALF + 4], mirror(FORD_WEST), [-70, 56]] },
  { width: 10, surface: "grass", points: [[STRIP.minX + 3, -67], [STRIP.maxX - 3, -67]] },
  // Les routes en lacets du volcan (un point sur trois suffit au dessin)
  ...ROADS.map((road): TerrainPath => ({ width: ROAD_W - 1, surface: "road", points: road.points.filter((_, i) => i % 3 === 0 || i === road.points.length - 1) })),
];

const onPath = (x: number, z: number, margin: number): boolean =>
  PATHS.some((p) => p.points.some((a, i) => i > 0 && segmentDistance(x, z, p.points[i - 1], a) < p.width / 2 + margin));

// ─── Le décor fixe ──────────────────────────────────────────────────────────────────────────

/** Les ponts de bois, au-dessus des gorges : un tablier de planches et ses garde-corps (des tabliers bas, comme ceux de la Vallée). */
function bridges(): StaticBox[] {
  return [BRIDGE_WEST, BRIDGE_EAST].flatMap((b) => [
    { ...box("deck", b.x, DECK - 0.25, b.z, 2.6, 0.25, DECK_HALF), look: "wood" as const },
    { ...box("deck", b.x - 2.85, DECK + 0.4, b.z, 0.2, 0.4, DECK_HALF - 0.4), look: "wood" as const },
    { ...box("deck", b.x + 2.85, DECK + 0.4, b.z, 0.2, 0.4, DECK_HALF - 0.4), look: "wood" as const },
  ]);
}

/** Les cases sur pilotis de la lagune : un plancher (un tablier) sur des pilotis, et le ponton qui y mène depuis la plage. */
const STILTS: readonly { x: number; z: number; hx: number; hz: number }[] = [
  { x: 93, z: 73, hx: 3.6, hz: 3.2 },
  { x: 99, z: 82, hx: 3.2, hz: 3.6 },
  { x: 86, z: 86, hx: 3.4, hz: 3 },
];
const STILT_DECK = 3.3;
function stilts(): StaticBox[] {
  const list: StaticBox[] = [];
  for (const s of STILTS) {
    list.push({ ...box("deck", s.x, STILT_DECK - 0.2, s.z, s.hx, 0.2, s.hz), look: "wood" });
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const px = s.x + dx * (s.hx - 0.3);
      const pz = s.z + dz * (s.hz - 0.3);
      const bottom = ground(px, pz) - 0.3;
      list.push({ ...box("pillar", px, (bottom + STILT_DECK - 0.4) / 2, pz, 0.15, (STILT_DECK - 0.4 - bottom) / 2, 0.15), look: "wood" });
    }
  }
  // Pontons : de la plage du village à la première case, puis de case en case (le long des axes)
  list.push({ ...box("deck", 86.5, STILT_DECK - 0.2, 70.5, 3.5, 0.2, 1.1), look: "wood" });
  list.push({ ...box("deck", 96, STILT_DECK - 0.2, 77.5, 1, 0.2, 1.4), look: "wood" });
  list.push({ ...box("deck", 89.5, STILT_DECK - 0.2, 79.4, 1, 0.2, 3.6), look: "wood" });
  return list;
}

/** Rochers : des blocs de lave refroidie sur les pentes et dans les plaines, des écueils au large. */
function rocks(): StaticBox[] {
  const random = seeded(23);
  const half: [number, number, number][] = [
    // Pentes et pied du volcan
    [36, 34, 1.6], [26, -44, 1.4], [48, 6, 1.8], [44, -38, 1.5], [10, 50, 1.3], [-30, 46, 1.4],
    // Plaines, entre jungle et lieux
    [56, 50, 1.5], [96, 6, 2], [62, 4, 1.4], [40, -50, 1.6], [104, -14, 1.7], [30, 66, 1.3],
    // Écueils, au ras de l'eau
    [122, 20, 1.9], [118, -60, 2.2], [70, 104, 1.8], [-6, 121, 2.1], [112, 58, 1.6],
  ];
  const list = [...half, ...half.map(([x, z, s]) => [-x, -z, s] as [number, number, number])];
  return list.map(([x, z, size]) => {
    const h = vec3(size * (0.9 + random() * 0.5), size * (0.55 + random() * 0.3), size * (0.8 + random() * 0.4));
    const rot = qmul(yaw(random() * Math.PI), axisAngle(vec3(1, 0, 0), (random() - 0.5) * 0.25));
    return { ...box("rock", x, ground(x, z) + h.y * 0.55, z, h.x, h.y, h.z, rot), look: "basalt" as const };
  });
}

/** Les bunkers : des murets de sacs de sable et des tranchées bétonnées face à la mer, un canon côtier. */
function fortifications(): StaticBox[] {
  const b = BUNKERS;
  const list: StaticBox[] = [
    barrier(b.x - 4, b.z - 14, "x", 8, 1.2, b.h - 0.2),
    barrier(b.x + 9, b.z - 12, "x", 6, 1.2, b.h - 0.2),
    barrier(b.x - 14, b.z - 2, "z", 7, 1.2, b.h - 0.2),
    barrier(b.x + 14, b.z + 6, "z", 6, 1.2, b.h - 0.2),
    // Le canon côtier : un affût et son tube, pointé vers le large (le sud-est)
    box("pillar", b.x - 10, b.h + 0.7, b.z - 9, 1.3, 0.7, 1.3),
    { ...box("pillar", b.x - 11.5, b.h + 1.6, b.z - 10.5, 0.3, 0.3, 2.4, yaw(Math.PI / 4)), look: "rust" },
  ];
  return list;
}

/** La piste d'aviation : la manche à air, au bord de la plage, dans l'axe de la piste. */
function airstrip(): StaticBox[] {
  return [box("pillar", 66, ground(66, -79) + 2.5, -79, 0.12, 2.5, 0.12)];
}

/** L'épave de la plage : un cargo échoué (une coque couchée, ses conteneurs éparpillés). */
function wreck(): StaticBox[] {
  const s = BEACH_SITE;
  // Le cargo, couché sur le flanc dans le sable : coque, proue en pointe, château, cheminée, mât
  const at = { x: s.x - 12, z: s.z + 14 };
  const tilt = qmul(yaw(0.5), axisAngle(vec3(0, 0, 1), 0.28));
  const base = vec3(at.x, ground(at.x, at.z) + 1.1, at.z);
  const piece = (kind: StaticBox["kind"], local: Vec3, half: Vec3, turn: Quat | null = null): StaticBox => {
    const p = add(base, qrot(tilt, local));
    return { ...box(kind, p.x, p.y, p.z, half.x, half.y, half.z, turn ? qmul(tilt, turn) : tilt), look: "rust" };
  };
  return [
    piece("barrier", vec3(0, 0.5, 0), vec3(2.6, 1.9, 8.2)),
    piece("barrier", vec3(0, 0.7, 8.4), vec3(1.75, 1.7, 1.75), yaw(Math.PI / 4)),
    piece("barrier", vec3(0, 3.4, -4.6), vec3(2, 1.1, 2.2)),
    piece("pillar", vec3(0.3, 5.2, -5.4), vec3(0.6, 0.9, 0.6)),
    piece("pillar", vec3(0, 5.6, 3.5), vec3(0.14, 3.2, 0.14)),
    box("container", s.x - 4, s.h + 1.1, s.z + 11, 3, 1.3, 1.2, yaw(0.3)),
    box("container", s.x + 9, s.h + 1.2, s.z - 4, 1.2, 1.3, 3, yaw(-0.4)),
    box("container", s.x - 16, ground(s.x - 16, s.z + 3) + 0.9, s.z + 3, 3, 1.3, 1.2, qmul(yaw(1.1), axisAngle(vec3(1, 0, 0), 0.2))),
  ];
}

/** Limites invisibles, au large (à ±BOUND_AT m) : rien ne quitte la carte, pas même un robot projeté. */
const BOUND_AT = 172;
const BOUND_TOP = 110;
function bounds(): StaticBox[] {
  const t = 2;
  return [-1, 1].flatMap((s) => [
    box("bound", 0, BOUND_TOP / 2, s * (BOUND_AT + t), BOUND_AT + 2 * t, BOUND_TOP / 2, t),
    box("bound", s * (BOUND_AT + t), BOUND_TOP / 2, 0, t, BOUND_TOP / 2, BOUND_AT + 2 * t),
  ]);
}

const BOXES: readonly StaticBox[] = [...bridges(), ...stilts(), ...rocks(), ...fortifications(), ...airstrip(), ...wreck(), ...bounds()];

// ─── Les bâtiments et la jungle ─────────────────────────────────────────────────────────────

/** Un arbre posé sur le relief. */
function tree(P: PropList, type: "palm" | "kapok", x: number, z: number, scale: number): void {
  const half = (type === "palm" ? 4.2 : 5.5) * scale;
  P.add({ type, pos: vec3(x, ground(x, z) + half, z), scale });
}

function buildProps(): PropSpot[] {
  const P = new PropList();
  const v = VILLAGE;

  // Le village de pêcheurs : des cases de planches autour de la place, et dans la lagune, sur pilotis ;
  // un toit sur deux en tôle ondulée, les autres en tuiles
  let huts = 0;
  const hut = (x: number, z: number, w: number, d: number, ridge: "x" | "z", g = v.h, door?: number): void =>
    house(P, { x, z, w, d, h: 2.8, ground: g, wall: "plank", roof: huts++ % 2 ? "sheet" : "roof", roofKind: "gable", ridge, door });
  hut(v.x + 9, v.z + 9, 6, 5, "x", v.h, 2);
  hut(v.x - 10, v.z + 8, 5, 5, "z");
  hut(v.x - 12, v.z - 8, 6, 5, "x", v.h, 2);
  hut(v.x + 13, v.z - 5, 6, 5, "z");
  for (const s of STILTS) hut(s.x, s.z, s.hx * 2 - 1.4, s.hz * 2 - 1.4, s.hx > s.hz ? "x" : "z", STILT_DECK, 1.8);
  // Le séchoir à poissons, des barques de planches retournées, des caisses et des barils de carburant
  for (const [x, z] of [[v.x + 2, v.z + 3], [v.x - 3, v.z + 4], [v.x + 6, v.z - 3]]) P.add({ type: "crate", pos: vec3(x, v.h + 0.5, z) });
  for (const [x, z] of [[v.x + 7, v.z - 4.1], [v.x - 6, v.z - 4]]) P.add({ type: "barrel", pos: vec3(x, v.h + 0.5, z) });
  for (const [x, z, a] of [[v.x + 15, v.z + 14, 0.5], [v.x + 17, v.z + 10, 1.1]]) {
    P.add({ type: "plank", pos: vec3(x, ground(x, z) + 0.3, z), half: vec3(0.8, 0.3, 2.2), rot: yaw(a) });
  }

  // Les bunkers : deux casemates face au large, un poste de commandement, des caisses de munitions
  const b = BUNKERS;
  house(P, { x: b.x - 4, z: b.z - 8, w: 8, d: 5, h: 2.6, ground: b.h, wall: "concrete", roof: "concrete", roofKind: "flat", ridge: "x", door: 2 });
  house(P, { x: b.x + 9, z: b.z - 5, w: 6, d: 5, h: 2.6, ground: b.h, wall: "concrete", roof: "concrete", roofKind: "flat", ridge: "z", door: 2, flip: true });
  house(P, { x: b.x - 2, z: b.z + 10, w: 7, d: 6, h: 3, ground: b.h, wall: "concrete", roof: "concrete", roofKind: "flat", ridge: "x", door: 2.4, flip: true });
  for (const [x, z] of [[b.x + 4, b.z + 3], [b.x + 4, b.z + 4.05], [b.x - 9, b.z + 4]]) P.add({ type: "crate", pos: vec3(x, b.h + 0.5, z) });
  for (const [x, z] of [[b.x + 12, b.z + 2], [b.x + 12.8, b.z + 2.8], [b.x - 13, b.z + 8]]) P.add({ type: "barrel", pos: vec3(x, b.h + 0.5, z) });
  P.add({ type: "gas", pos: vec3(b.x - 6, b.h + 0.55, b.z + 1) });

  // La piste : un hangar de tôle ouvert sur la piste, un abri à carburant, la citerne
  const a = STRIP.h;
  house(P, { x: 60, z: -53, w: 16, d: 9, h: 5, ground: a, wall: "sheet", roof: "sheet", roofKind: "flat", ridge: "x", door: 11 });
  house(P, { x: 82, z: -55, w: 5, d: 4, h: 2.8, ground: a, wall: "plank", roof: "sheet", roofKind: "flat", ridge: "x", door: 2 });
  P.add({ type: "tank", pos: vec3(89, a + 1.7, -55) });
  for (const [x, z] of [[46, -57], [47.05, -57], [46.5, -56], [74, -57]]) P.add({ type: "crate", pos: vec3(x, a + 0.5, z) });
  for (const [x, z] of [[78, -57.5], [78.8, -58.3], [50, -76]]) P.add({ type: "barrel", pos: vec3(x, a + 0.5, z) });

  // La plage de l'épave : des paillotes, les caisses échouées
  const s = BEACH_SITE;
  hut(s.x + 6, s.z - 10, 5, 4, "x", s.h, 2);
  hut(s.x - 9, s.z - 9, 4, 4, "z", s.h);
  for (const [x, z] of [[s.x + 2, s.z + 8], [s.x + 3.05, s.z + 8], [s.x - 6, s.z + 6], [s.x + 11, s.z + 3]]) P.add({ type: "crate", pos: vec3(x, s.h + 0.5, z) });
  for (const [x, z] of [[s.x - 3, s.z - 3], [s.x + 7, s.z + 6]]) P.add({ type: "barrel", pos: vec3(x, s.h + 0.5, z) });
  P.add({ type: "gas", pos: vec3(s.x + 4, s.h + 0.55, s.z + 2) });

  // La jungle : des fromagers dans les terres, des palmiers vers la côte et autour des lieux ;
  // ni sur les chemins, les routes, les sites, les zones, les gorges, la lave, ni dans l'eau
  const random = seeded(31);
  const taken: [number, number][] = P.spots.map((p) => [p.pos.x, p.pos.z]);
  for (const bx of BOXES) if (bx.kind !== "bound") taken.push([bx.pos.x, bx.pos.z]);
  const clear = (x: number, z: number, spacing: number): boolean => {
    const r = Math.hypot(x, z);
    if (r < FOOT_R + 3 || ground(x, z) < WATER + 0.35) return false;
    if (onPath(x, z, 2.5)) return false;
    if (GORGES.some((g) => nearest(g, x, z, GORGE_TOP + 3) < Infinity)) return false;
    if (LAVA.some((l) => l.kind === "flow" && nearest(LAVA_LINES.get(l)!, x, z, l.width / 2 + 5) < Infinity)) return false;
    if (ZONES.some((zn) => Math.hypot(zn.pos.x - x, zn.pos.z - z) < zn.radius + 5)) return false;
    if (Math.abs(x) < 46 && Math.abs(z) > 74) return false; // plages de départ
    if (Math.hypot(x - v.x, z - v.z) < 21 || Math.hypot(x - b.x, z - b.z) < 21 || Math.hypot(x - s.x, z - s.z) < 17) return false;
    if (x > STRIP.minX - 5 && x < STRIP.maxX + 5 && z > STRIP.minZ - 5 && z < STRIP.maxZ + 10) return false;
    if (-x > STRIP.minX - 5 && -x < STRIP.maxX + 5 && -z > STRIP.minZ - 5 && -z < STRIP.maxZ + 10) return false;
    if ([BRIDGE_WEST, BRIDGE_EAST].some((br) => Math.abs(x - br.x) < 7 && Math.abs(z - br.z) < DECK_HALF + 7)) return false;
    return taken.every(([tx, tz]) => Math.hypot(tx - x, tz - z) > spacing);
  };
  const plant = (type: "palm" | "kapok", x: number, z: number, scale: number, spacing: number): boolean => {
    if (!clear(x, z, spacing)) return false;
    tree(P, type, x, z, scale);
    taken.push([x, z]);
    return true;
  };
  // Les bosquets de la jungle, chacun avec son pendant de l'autre côté du volcan
  const groves = [
    { x: 46, z: 48, r: 14, count: 12 }, { x: 98, z: 4, r: 14, count: 14 }, { x: 70, z: 4, r: 8, count: 7 }, { x: 82, z: -12, r: 9, count: 7 },
    { x: 18, z: 64, r: 10, count: 7 }, { x: 56, z: -42, r: 10, count: 10 }, { x: 110, z: -20, r: 7, count: 5 }, { x: 24, z: -62, r: 8, count: 6 },
  ];
  for (const g of groves) {
    for (const [cx, cz] of [[g.x, g.z], [-g.x, -g.z]]) {
      let placed = 0;
      for (let k = 0; k < g.count * 10 && placed < g.count; k++) {
        const angle = random() * Math.PI * 2;
        const r = Math.sqrt(random()) * g.r;
        const kapok = random() < 0.45;
        if (plant(kapok ? "kapok" : "palm", cx + dcos(angle) * r, cz + dsin(angle) * r, kapok ? 0.75 + random() * 0.35 : 0.85 + random() * 0.3, kapok ? 9 : 5.5)) placed++;
      }
    }
  }
  // Des palmiers le long de la côte, par paires symétriques
  for (let k = 0, placed = 0; k < 400 && placed < 40; k++) {
    const angle = random() * Math.PI * 2;
    const r = 96 + random() * 12;
    const x = dcos(angle) * r;
    const z = dsin(angle) * r;
    const scale = 0.85 + random() * 0.35;
    if (!clear(x, z, 6) || !clear(-x, -z, 6)) continue;
    plant("palm", x, z, scale, 6);
    plant("palm", -x, -z, scale, 6);
    placed += 2;
  }
  return P.spots;
}

// ─── Ce que dessine le client ───────────────────────────────────────────────────────────────

const fallTop = (g: readonly (readonly [number, number])[]): number => natural(g[0][0], g[0][1]);
/** Là où une coulée atteint la mer : le premier point de son axe sous le niveau de l'eau (ou son bout). */
function shoreOf(f: readonly (readonly [number, number])[]): readonly [number, number] {
  for (let i = 1; i < f.length; i++) {
    for (let t = 0; t <= 1; t += 0.05) {
      const x = f[i - 1][0] + (f[i][0] - f[i - 1][0]) * t;
      const z = f[i - 1][1] + (f[i][1] - f[i - 1][1]) * t;
      if (ground(x, z) < WATER) return [x, z];
    }
  }
  return f[f.length - 1];
}

const VENTS: readonly Vent[] = [
  // Le cratère et son lac de lave : le grand panache
  { x: POOL.x, y: FLOOR_H - LAVA_SINK, z: POOL.z, size: 4 },
  // Les fissures, en tête des coulées
  { x: LAVA_WEST_UP[0][0], y: ground(...LAVA_WEST_UP[0]), z: LAVA_WEST_UP[0][1], size: 1.5 },
  { x: -LAVA_WEST_UP[0][0], y: ground(...mirror(LAVA_WEST_UP[0])), z: -LAVA_WEST_UP[0][1], size: 1.5 },
  // La lave qui se jette dans la mer : de la vapeur
  { x: shoreOf(LAVA_WEST_DOWN)[0], y: WATER, z: shoreOf(LAVA_WEST_DOWN)[1], size: 2.2, steam: true },
  { x: -shoreOf(LAVA_WEST_DOWN)[0], y: WATER, z: -shoreOf(LAVA_WEST_DOWN)[1], size: 2.2, steam: true },
  // Des fumerolles sur les flancs
  { x: 20, y: ground(20, -14), z: -14, size: 0.8 },
  { x: -20, y: ground(-20, 14), z: 14, size: 0.8 },
];

/** Les cascades, à la tête de chaque gorge : l'eau tombe de la falaise vers l'aval. */
const FALLS: readonly Waterfall[] = [GORGE_WEST, GORGE_EAST].map((g) => {
  // Une résurgence : la rivière sort de la roche volcanique, au fond de la tête de la gorge
  const dir = Math.atan2(g[1][0] - g[0][0], g[1][1] - g[0][1]);
  const back = (GORGE_BOTTOM + GORGE_TOP) / 2;
  return { x: g[0][0] - dsin(dir) * back, z: g[0][1] - dcos(dir) * back, top: fallTop(g) - 0.6, bottom: WATER, width: 3.2, dir };
});

export const ISLAND: ArenaLayout = {
  id: "island",
  // Les avions de l'IA volent au-dessus des palmiers et des fromagers ; leur circuit contourne le volcan
  bounds: { half: 128, roam: 100, spawnLine: 86, spawnSpread: 30, circuit: 84, airFloor: 22 },
  boxes: BOXES,
  props: buildProps(),
  zones: ZONES,
  terrain: TERRAIN,
  water: WATER,
  deepWater: DEEP,
  lava: LAVA,
  navGrid: { cell: 2.5, maxSlope: 0.38 },
  paths: PATHS,
  sky: { color: "#a6d3ec", fog: 0.0032 },
  waterColor: "#2b8a9c",
  ground: {
    base: ["#4c8a32", "#6fa645"], dirt: "#8d6c47", sand: "#dccb94", mud: "#6f6c56", rock: "#665d55", peak: "#3e3936",
    rockLine: 9, peakLine: 21, beach: 1.5, basalt: "#2c2722", basaltWidth: 4,
  },
  vents: VENTS,
  falls: FALLS,
  places: [
    { place: "crater", x: 0, z: 0 },
    { place: "village", x: VILLAGE.x, z: VILLAGE.z + 4 },
    { place: "lagoon", x: LAGOON.x, z: LAGOON.z + 4 },
    { place: "bunkers", x: BUNKERS.x, z: BUNKERS.z - 4 },
    { place: "airstrip", x: 62, z: -72 },
    { place: "wreck", x: BEACH_SITE.x - 10, z: BEACH_SITE.z + 14 },
    { place: "waterfall", x: GORGE_WEST[0][0] + 2, z: GORGE_WEST[0][1] + 6 },
    { place: "waterfall", x: GORGE_EAST[0][0] - 2, z: GORGE_EAST[0][1] - 6 },
    { place: "lavaFlow", x: 92, z: -40 },
    { place: "lavaFlow", x: -92, z: 40 },
  ],
};

/** Pour les tests : les points clés de l'île (pieds des routes, ponts, gués de basalte). */
export const ISLAND_LANDMARKS = {
  roadFoot: { north: polar(90, ROAD_FOOT), south: polar(270, ROAD_FOOT) },
  crater: SUMMIT,
  pool: POOL,
  bridges: [BRIDGE_WEST, BRIDGE_EAST],
  fords: [FORD_WEST, mirror(FORD_WEST)],
  water: WATER,
} as const;

/** (Les types d'accessoires de l'île, pour mémoire : `palm`, `kapok`.) */
export type IslandTree = Extract<PropType, "palm" | "kapok">;
