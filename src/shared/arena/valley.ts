import { axisAngle, qmul, vec3, type Quat } from "../math/vec";
import { barrier, box, zone } from "./builders";
import { house, PropList, seeded } from "./buildings";
import type { ArenaLayout, CaptureZone, PropSpot, StaticBox, TerrainPath } from "./layout";
import { makeTerrain, noise2, smoothstep } from "./terrain";
import { quantizeTerrain } from "../map/codec";
import { dcos, dsin } from "../math/det";

/*
 * La Vallée : une grande carte (±105 m de terrain de jeu, des montagnes tout autour), avec du
 * relief, une rivière qu'enjambe un pont de pierre, et des lieux : le village au nord-est, la
 * colline du fort à l'est, l'usine à l'ouest, l'aérodrome au sud-ouest, deux bois. Bâtiments et
 * arbres sont des accessoires ancrés : on abat un mur, un toit s'effondre, un arbre bascule.
 *
 * Nord = +z (les rouges partent du nord, les bleus du sud) et ouest = +x : le repère est direct,
 * comme celui d'un robot (tourné vers +z, il a +x à sa gauche). Les lieux sont à peu près
 * symétriques par rapport au centre (le fort et l'usine, le village et l'aérodrome) : aucun camp
 * n'est avantagé.
 */

/** Hauteur du fond de la vallée (m) : au-dessus du sol plat (y = 0), que le relief recouvre. */
const BASE = 2.4;
/** Rivière : ligne médiane (z selon x, symétrique par rapport au centre), lit, berges, profondeur (m). */
const riverZ = (x: number): number => 0.35 * x + 3 * dsin(x / 14);
const RIVER_BED = 4;
const RIVER_BANK = 18;
const RIVER_DEPTH = 1.9;
/** Niveau de l'eau (m) : peu profonde, on la traverse partout ; le pont est plus sûr et plus rapide. */
const WATER = 1.2;
/** Colline du fort : centre, plateau (rayon, hauteur), pied (m). */
const FORT = { x: -72, z: 20 };
const FORT_FLAT = 13;
const FORT_TOP = 9.5;
const FORT_FOOT = 34;
/** Montagnes : leur pied, leur crête (distance au centre le long d'un axe, m). */
const MOUNTAIN_FOOT = 112;
const MOUNTAIN_TOP = 150;
/** Pont : hauteur du tablier, demi-longueur (m). Assez haut pour qu'un robot passe dessous. */
const DECK = 3.6;
const DECK_HALF = 15;

/** Site aplani : un disque (`r`) ou un rectangle, à la hauteur `h`, raccordé au relief sur `fall` m. */
type Flat = { h: number; fall: number } & ({ x: number; z: number; r: number } | { minX: number; maxX: number; minZ: number; maxZ: number });

const VILLAGE = { x: -45, z: 58, h: 2.9 };
const FACTORY = { x: 72, z: -14, h: 2.6 };
const SAWMILL = { x: 48, z: 46, h: 2.7 };
const CABIN = { x: -48, z: -46, h: 2.5 };
const AIRFIELD = { h: 2.5 };
const SPAWN_H = 2.6;

const FLATS: readonly Flat[] = [
  { x: VILLAGE.x, z: VILLAGE.z, r: 24, h: VILLAGE.h, fall: 10 },
  { x: FACTORY.x, z: FACTORY.z, r: 24, h: FACTORY.h, fall: 8 },
  { minX: 16, maxX: 98, minZ: -72, maxZ: -40, h: AIRFIELD.h, fall: 10 },
  { x: SAWMILL.x, z: SAWMILL.z, r: 7, h: SAWMILL.h, fall: 6 },
  { x: CABIN.x, z: CABIN.z, r: 6, h: CABIN.h, fall: 6 },
  // Lignes de départ, et les abords du pont (le relief monte jusqu'au tablier)
  { minX: -40, maxX: 40, minZ: 76, maxZ: 96, h: SPAWN_H, fall: 12 },
  { minX: -40, maxX: 40, minZ: -96, maxZ: -76, h: SPAWN_H, fall: 12 },
  { minX: -5, maxX: 5, minZ: DECK_HALF - 1.5, maxZ: DECK_HALF + 4, h: DECK, fall: 12 },
  { minX: -5, maxX: 5, minZ: -DECK_HALF - 4, maxZ: -DECK_HALF + 1.5, h: DECK, fall: 12 },
];

function flatWeight(f: Flat, x: number, z: number): number {
  const out = "r" in f
    ? Math.max(0, Math.hypot(x - f.x, z - f.z) - f.r)
    : Math.hypot(Math.max(0, f.minX - x, x - f.maxX), Math.max(0, f.minZ - z, z - f.maxZ));
  return 1 - smoothstep(0, f.fall, out);
}

/** Relief de la vallée en (x, z) (m). */
function valleyHeight(x: number, z: number): number {
  // Une houle douce
  let h = BASE + 0.7 * noise2(x / 38, z / 38) + 0.35 * noise2(x / 16 + 40, z / 16 - 17);
  for (const f of FLATS) h += (f.h - h) * flatWeight(f, x, z);
  // La colline du fort : un plateau, des flancs en pente douce (moins de 30°) ; elle passe
  // par-dessus ce qui l'entoure (un site aplani à son pied ne l'entame pas en falaise)
  const rf = Math.hypot(x - FORT.x, z - FORT.z);
  h = Math.max(h, BASE + (FORT_TOP - BASE) * (1 - smoothstep(FORT_FLAT, FORT_FOOT, rf)));
  // La rivière creuse son lit (jusque dans le pied de la colline)
  h -= RIVER_DEPTH * (1 - smoothstep(RIVER_BED, RIVER_BANK, Math.abs(z - riverZ(x))));
  // Les montagnes, tout autour : trop raides pour qu'on y grimpe
  const edge = Math.max(Math.abs(x), Math.abs(z)) + 6 * noise2(x / 30 - 7, z / 30 + 2);
  h += smoothstep(MOUNTAIN_FOOT, MOUNTAIN_TOP, edge) * (34 + 12 * noise2(x / 45 + 9, z / 45 + 3));
  return Math.max(0.15, h);
}

const TERRAIN = quantizeTerrain(makeTerrain(440, 220, valleyHeight));

/** Hauteur du relief (celle du champ de hauteurs, qui interpole entre ses sommets). */
const ground = (x: number, z: number): number => valleyHeight(x, z);

const yaw = (a: number): Quat => axisAngle(vec3(0, 1, 0), a);

/** Un arbre posé sur le relief. */
function tree(P: PropList, type: "pine" | "oak", x: number, z: number, scale: number): void {
  const half = (type === "pine" ? 4.5 : 3.2) * scale;
  P.add({ type, pos: vec3(x, ground(x, z) + half, z), scale });
}

/** Distance d'un point au segment [a, b] du plan. */
function segmentDistance(x: number, z: number, a: readonly [number, number], b: readonly [number, number]): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t);
}

/** Chemins de terre (dessinés sur le relief ; on y roule comme ailleurs). */
const PATHS: readonly TerrainPath[] = [
  { width: 5, points: [[0, 78], [3, 50], [0, DECK_HALF + 2]] },
  { width: 5, points: [[0, -78], [-3, -50], [0, -DECK_HALF - 2]] },
  { width: 4, points: [[3, 48], [-20, 54], [-30, 58]] },
  { width: 4, points: [[-3, -48], [20, -54], [30, -58]] },
  { width: 4, points: [[-2, DECK_HALF + 2], [-28, 18], [-50, 14]] },
  { width: 4, points: [[2, -DECK_HALF - 2], [28, -18], [50, -14]] },
];

const onPath = (x: number, z: number, margin: number): boolean =>
  PATHS.some((p) => p.points.some((a, i) => i > 0 && segmentDistance(x, z, p.points[i - 1], a) < p.width / 2 + margin));

const ZONES: readonly CaptureZone[] = [
  zone("A", FORT.x + 2, FORT_TOP, FORT.z - 2, 5.5),
  zone("B", VILLAGE.x, VILLAGE.h, VILLAGE.z - 2, 7),
  zone("C", 0, DECK, 0, 6),
  zone("D", 58, AIRFIELD.h, -59, 6),
  zone("E", FACTORY.x, FACTORY.h, FACTORY.z, 7),
];

/** Rochers : des blocs posés de biais, à demi enterrés, pour s'abriter dans les champs. */
function rocks(): StaticBox[] {
  const random = seeded(11);
  const list: [number, number, number][] = [
    [24, 32, 1.6], [-24, -32, 1.6], [34, 4, 1.5], [-34, -4, 1.5], [14, -34, 1.2], [-14, 34, 1.2], [44, 22, 1.8], [-44, -22, 1.8],
    [-88, 62, 2.2], [88, -62, 2.2], [-94, -24, 2], [94, 24, 2], [-22, -66, 1.5], [22, 66, 1.5], [-54, 88, 1.8], [54, -88, 1.8],
    [-96, 90, 2.6], [96, -90, 2.6], [9, 26, 1.1], [-9, -26, 1.1], [-20, 8, 1.3], [20, -8, 1.3],
  ];
  return list.map(([x, z, size]) => {
    const half = vec3(size * (0.9 + random() * 0.5), size * (0.55 + random() * 0.3), size * (0.8 + random() * 0.4));
    const rot = qmul(yaw(random() * Math.PI), axisAngle(vec3(1, 0, 0), (random() - 0.5) * 0.25));
    return box("rock", x, ground(x, z) + half.y * 0.55, z, half.x, half.y, half.z, rot);
  });
}

/** Conteneurs de l'usine et de l'aérodrome : en rangées, parfois empilés. */
function containers(): StaticBox[] {
  const u = FACTORY;
  const a = AIRFIELD.h;
  const c = (x: number, z: number, level: number, along: "x" | "z", g: number): StaticBox =>
    along === "x" ? box("container", x, g + 1.3 + level * 2.6, z, 3, 1.3, 1.2) : box("container", x, g + 1.3 + level * 2.6, z, 1.2, 1.3, 3);
  return [
    c(u.x - 16, u.z - 2, 0, "z", u.h), c(u.x - 13.4, u.z - 2, 0, "z", u.h), c(u.x - 14.7, u.z - 2, 1, "z", u.h),
    c(u.x + 4, u.z + 12, 0, "x", u.h),
    c(88, -50, 0, "z", a), c(90.6, -50, 0, "z", a), c(89.3, -50, 1, "z", a),
  ];
}

/** Le pont de pierre : un tablier et ses parapets (des « tabliers » eux aussi : on ne s'abrite pas derrière), deux piles dans la rivière. */
function bridge(): StaticBox[] {
  const pier = (z: number): StaticBox => {
    const bottom = ground(0, z) - 0.6;
    const top = DECK - 0.5;
    return box("pillar", 0, (bottom + top) / 2, z, 2.4, (top - bottom) / 2, 0.7);
  };
  return [
    box("deck", 0, DECK - 0.3, 0, 4, 0.3, DECK_HALF),
    box("deck", -4.3, DECK + 0.45, 0, 0.4, 0.45, DECK_HALF - 0.5),
    box("deck", 4.3, DECK + 0.45, 0, 0.4, 0.45, DECK_HALF - 0.5),
    pier(-5),
    pier(5),
  ];
}

/** Le fort : des sacs de sable sur les flancs de la colline. */
function sandbags(): StaticBox[] {
  const list: [number, number, "x" | "z", number][] = [[FORT.x + 20, FORT.z + 4, "z", 5], [FORT.x + 8, FORT.z - 19, "x", 5], [FORT.x + 15, FORT.z + 15, "z", 4], [FORT.x - 18, FORT.z + 12, "x", 4]];
  return list.map(([x, z, along, length]) => barrier(x, z, along, length, 1.1, ground(x, z) - 0.2));
}

/** La piste de l'aérodrome et son bretelle, au ras du sol. */
function runway(): StaticBox[] {
  const a = AIRFIELD.h;
  return [box("road", 57, a - 0.08, -65, 38, 0.12, 6), box("road", 58, a - 0.08, -56.5, 7, 0.12, 2.5)];
}

/** Repères : la cheminée de l'usine, le clocher du village. */
function landmarks(): StaticBox[] {
  return [
    box("pillar", FACTORY.x - 12, FACTORY.h + 9, FACTORY.z + 10, 1.1, 9, 1.1),
    box("pillar", VILLAGE.x - 2, VILLAGE.h + 6, VILLAGE.z + 7, 1.4, 6, 1.4),
  ];
}

/**
 * Limites invisibles, au fond des montagnes (à ±BOUND_AT m, jusqu'à BOUND_TOP m de haut) : lancé à
 * pleine poussée, le Bolide sautait par-dessus les crêtes et sortait de la carte.
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

const BOXES: readonly StaticBox[] = [...bridge(), ...rocks(), ...containers(), ...sandbags(), ...runway(), ...landmarks(), ...bounds()];

function buildProps(): PropSpot[] {
  const P = new PropList();
  const v = VILLAGE;

  // Le village : des maisons de briques autour d'une place, une église et son clocher
  const home = (x: number, z: number, w: number, d: number, ridge: "x" | "z"): void =>
    house(P, { x, z, w, d, h: 3.2, ground: v.h, wall: "brick", roof: "roof", roofKind: "gable", ridge });
  home(v.x + 13, v.z + 12, 7, 6, "x");
  home(v.x + 10, v.z - 17, 8, 6, "x");
  home(v.x - 10, v.z - 17, 6, 6, "x");
  home(v.x - 17, v.z - 3, 7, 6, "z");
  home(v.x - 17, v.z + 12, 8, 6, "x");
  house(P, { x: v.x - 2, z: v.z + 15, w: 11, d: 7, h: 5, ground: v.h, wall: "brick", roof: "roof", roofKind: "gable", ridge: "z" });
  // Clôtures des jardins, en planches
  const fences: [number, number, "x" | "z", number][] = [[v.x + 13, v.z + 19, "x", 7], [v.x + 10, v.z - 24, "x", 8], [v.x - 24, v.z - 3, "z", 7]];
  for (const [x, z, along, length] of fences) {
    const n = Math.ceil(length / 2.5);
    for (let i = 0; i < n; i++) {
      const t = -length / 2 + (length / n) * (i + 0.5);
      const px = along === "x" ? x + t : x;
      const pz = along === "z" ? z + t : z;
      const half = along === "x" ? vec3(length / (2 * n), 0.55, 0.05) : vec3(0.05, 0.55, length / (2 * n));
      P.add({ type: "plank", pos: vec3(px, ground(px, pz) + 0.55, pz), half });
    }
  }
  for (const [x, z] of [[v.x + 8, v.z + 5], [v.x - 8, v.z + 6], [v.x + 3, v.z + 23]]) P.add({ type: "crate", pos: vec3(x, v.h + 0.5, z) });
  for (const [x, z] of [[v.x + 8.6, v.z + 6.1], [v.x - 9, v.z - 10]]) P.add({ type: "barrel", pos: vec3(x, v.h + 0.5, z) });

  // Le fort : un rempart de béton en carré sur la colline, ouvert au sud et à l'ouest (vers le pont), un blockhaus
  const f = FORT;
  const top = FORT_TOP;
  for (const [side, along] of [[1, "x"], [-1, "x"], [1, "z"], [-1, "z"]] as const) {
    const open = (along === "x" && side < 0) || (along === "z" && side > 0); // au sud, à l'ouest
    for (const t of open ? [-5, 5] : [-6, -2, 2, 6]) {
      const x = along === "x" ? f.x + t : f.x + side * 8;
      const z = along === "x" ? f.z + side * 8 : f.z + t;
      const half = along === "x" ? vec3(2, 1, 0.3) : vec3(0.3, 1, 2);
      P.add({ type: "concrete", pos: vec3(x, top + 1, z), half });
    }
  }
  house(P, { x: f.x - 4.5, z: f.z + 4.5, w: 5, d: 4.5, h: 2.6, ground: top, wall: "concrete", roof: "concrete", roofKind: "flat", ridge: "x", door: 1.8 });
  for (const [x, z] of [[f.x + 6, f.z + 5], [f.x + 6, f.z + 6.05]]) P.add({ type: "crate", pos: vec3(x, top + 0.5, z) });
  P.add({ type: "gas", pos: vec3(f.x - 5, top + 0.55, f.z - 4) });

  // L'usine : deux entrepôts, des citernes, des barils ; les conteneurs sont du décor fixe
  const u = FACTORY;
  house(P, { x: u.x - 6, z: u.z - 16, w: 14, d: 9, h: 5, ground: u.h, wall: "sheet", roof: "sheet", roofKind: "flat", ridge: "x", door: 7, flip: true });
  house(P, { x: u.x + 15, z: u.z + 2, w: 11, d: 8, h: 4.5, ground: u.h, wall: "brick", roof: "sheet", roofKind: "flat", ridge: "z", door: 5 });
  for (const [x, z] of [[u.x + 10, u.z - 13], [u.x + 14, u.z - 13], [u.x + 12, u.z - 17]]) P.add({ type: "tank", pos: vec3(x, u.h + 1.7, z) });
  for (const [x, z] of [[u.x + 6, u.z - 9], [u.x + 6.8, u.z - 9.8], [u.x - 8, u.z + 6], [u.x + 9, u.z + 7], [u.x - 12, u.z - 8], [u.x + 1, u.z + 9]]) {
    P.add({ type: "barrel", pos: vec3(x, u.h + 0.5, z) });
  }
  for (const [x, z] of [[u.x - 9, u.z + 8], [u.x - 9, u.z + 9.05], [u.x + 6, u.z + 9], [u.x - 16, u.z + 6]]) P.add({ type: "crate", pos: vec3(x, u.h + 0.5, z) });
  for (const [x, z] of [[u.x + 8, u.z + 4], [u.x - 10, u.z - 6]]) P.add({ type: "gas", pos: vec3(x, u.h + 0.55, z) });

  // L'aérodrome : un hangar ouvert sur la piste, une tour de contrôle, une citerne
  const a = AIRFIELD.h;
  house(P, { x: 58, z: -48, w: 18, d: 11, h: 5.5, ground: a, wall: "sheet", roof: "sheet", roofKind: "flat", ridge: "x", door: 12 });
  house(P, { x: 34, z: -50, w: 4.5, d: 4.5, h: 7, ground: a, wall: "concrete", roof: "concrete", roofKind: "flat", ridge: "x" });
  P.add({ type: "tank", pos: vec3(78, a + 1.7, -46) });
  for (const [x, z] of [[42, -57], [43.05, -57], [42.5, -56]]) P.add({ type: "crate", pos: vec3(x, a + 0.5, z) });
  for (const [x, z] of [[72, -52], [72.8, -52.8], [46, -54]]) P.add({ type: "barrel", pos: vec3(x, a + 0.5, z) });

  // La scierie, dans le bois du nord-ouest, et la cabane du bois du sud-est
  house(P, { x: SAWMILL.x, z: SAWMILL.z, w: 8, d: 6, h: 3.4, ground: SAWMILL.h, wall: "plank", roof: "sheet", roofKind: "gable", ridge: "x", door: 3 });
  house(P, { x: CABIN.x, z: CABIN.z, w: 5, d: 5, h: 2.8, ground: CABIN.h, wall: "plank", roof: "roof", roofKind: "gable", ridge: "z" });
  for (const [x, z] of [[SAWMILL.x + 6, SAWMILL.z - 6], [SAWMILL.x + 7.05, SAWMILL.z - 6], [SAWMILL.x + 6.5, SAWMILL.z - 5]]) {
    P.add({ type: "crate", pos: vec3(x, SAWMILL.h + 0.5, z) });
  }

  // Les bois, et des chênes épars : ni sur les chemins, les sites, les zones, la rivière, ni contre un rocher
  const random = seeded(7);
  const taken: [number, number][] = P.spots.map((s) => [s.pos.x, s.pos.z]);
  for (const b of BOXES) taken.push([b.pos.x, b.pos.z]);
  const clear = (x: number, z: number, spacing: number): boolean =>
    !onPath(x, z, 2) && Math.abs(z - riverZ(x)) > RIVER_BANK - 2 && taken.every(([tx, tz]) => Math.hypot(tx - x, tz - z) > spacing)
    && ZONES.every((zn) => Math.hypot(zn.pos.x - x, zn.pos.z - z) > zn.radius + 4)
    && !(Math.abs(x) < 46 && Math.abs(z) > 70) // lignes de départ
    && Math.hypot(x - v.x, z - v.z) > 26 && Math.hypot(x - u.x, z - u.z) > 26 && Math.hypot(x - f.x, z - f.z) > 12
    && Math.hypot(x - SAWMILL.x, z - SAWMILL.z) > 9 && Math.hypot(x - CABIN.x, z - CABIN.z) > 8
    && !(x > 12 && x < 102 && z > -76 && z < -36); // aérodrome
  const woods = [
    { x: 60, z: 56, r: 22, count: 22, oak: 0.2 },
    { x: -60, z: -56, r: 22, count: 22, oak: 0.4 },
    { x: 88, z: 76, r: 12, count: 9, oak: 0 },
    { x: -88, z: -76, r: 12, count: 9, oak: 0 },
    { x: -90, z: 40, r: 10, count: 6, oak: 0.5 },
    { x: 90, z: -30, r: 10, count: 6, oak: 0.5 },
  ];
  for (const w of woods) {
    let placed = 0;
    for (let k = 0; k < w.count * 8 && placed < w.count; k++) {
      const angle = random() * Math.PI * 2;
      const r = Math.sqrt(random()) * w.r;
      const x = w.x + dcos(angle) * r;
      const z = w.z + dsin(angle) * r;
      if (Math.max(Math.abs(x), Math.abs(z)) > 104 || !clear(x, z, 7)) continue;
      tree(P, random() < w.oak ? "oak" : "pine", x, z, 0.8 + random() * 0.45);
      taken.push([x, z]);
      placed++;
    }
  }
  for (let k = 0, placed = 0; k < 300 && placed < 22; k++) {
    const x = (random() * 2 - 1) * 96;
    const z = (random() * 2 - 1) * 96;
    if (!clear(x, z, 14)) continue;
    tree(P, "oak", x, z, 0.85 + random() * 0.4);
    taken.push([x, z]);
    placed++;
  }
  return P.spots;
}

export const VALLEY: ArenaLayout = {
  id: "valley",
  // Les avions de l'IA volent au-dessus de la cheminée de l'usine (20 m) et des arbres
  bounds: { half: 105, roam: 90, spawnLine: 84, spawnSpread: 30, circuit: 72, airFloor: 23 },
  boxes: BOXES,
  props: buildProps(),
  zones: ZONES,
  terrain: TERRAIN,
  water: WATER,
  paths: PATHS,
  sky: { color: "#bfd0db", fog: 0.0045 },
  places: [
    { place: "village", x: VILLAGE.x, z: VILLAGE.z + 4 },
    { place: "fort", x: FORT.x, z: FORT.z + 3 },
    { place: "factory", x: FACTORY.x, z: FACTORY.z - 6 },
    { place: "airfield", x: 58, z: -44 },
    { place: "bridge", x: 0, z: 0 },
    { place: "sawmill", x: SAWMILL.x, z: SAWMILL.z },
    { place: "cabin", x: CABIN.x, z: CABIN.z },
  ],
};
