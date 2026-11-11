import { axisAngle, vec3, type Quat } from "../math/vec";
import { box, incline, zone } from "./builders";
import type { ArenaLayout, BoxLook, CaptureZone, StaticBox, StaticKind, TerrainPath } from "./layout";
import { makeTerrain, noise2, smoothstep } from "./terrain";
import { house, PropList, seeded } from "./valley";

/*
 * Le Port : une grande carte (±100 m de terrain de jeu) au bord de la mer, qui est à l'est. Au
 * milieu, un bassin où est amarré un cargo (on monte à bord par ses passerelles), un chenal
 * qu'enjambe un pont tournant, une darse au bout. De part et d'autre (la carte est symétrique par
 * rapport à l'axe est-ouest : aucun camp n'est avantagé), les portiques à conteneurs le long du
 * bassin, un terminal à conteneurs (un dédale, une pile où l'on monte), des entrepôts, un dépôt
 * pétrolier (ses citernes sautent en chaîne), la voie ferrée ; à l'ouest, la capitainerie et les
 * silos ; à l'est, le quai bas des pêcheurs, plus près de l'eau, et les jetées des phares.
 *
 * L'eau est profonde (`deepWater`) : un robot qui y tombe se noie (sim/hazards.ts), des parapets
 * bordent les quais, et l'IA au sol ne s'y aventure pas : sa grille de passage (`navGrid`,
 * arena/navgrid.ts) la fait passer par le pont, les passerelles du cargo ou le tour de la darse. Les
 * entrepôts, les piles de conteneurs, les citernes serrées : l'IA les contourne comme en ville
 * (`urban`), et ressort d'un entrepôt par une porte.
 *
 * Nord = +z (les rouges partent du nord, les bleus du sud) et ouest = +x, comme la Vallée.
 */

/** Niveau des quais, du quai bas des pêcheurs, de l'eau, du fond (m). */
const Q = 6;
const Q_LOW = 4.5;
const WATER = 3;
const BED = 0.2;
/** Le pont du cargo (m). */
const DECK = 7.2;

/**
 * Eau profonde, sa surface : la mer, le bassin du cargo, le chenal du pont tournant, la darse. Leurs
 * bords tombent sur les sommets du relief (des coordonnées paires) ; au-delà, sur QUAY m, le relief
 * remonte jusqu'au quai, sous un mur de quai qui fait la rive verticale.
 */
interface Area {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}
const SEA: Area = { minX: -400, maxX: -70, minZ: -400, maxZ: 400 };
const BASIN: Area = { minX: -72, maxX: 0, minZ: -12, maxZ: 12 };
const CHANNEL: Area = { minX: -2, maxX: 18, minZ: -6, maxZ: 6 };
const DOCK: Area = { minX: 16, maxX: 40, minZ: -14, maxZ: 14 };
const WATERS: readonly Area[] = [SEA, BASIN, CHANNEL, DOCK];
/** Au-delà de cette profondeur (m), l'eau est profonde : on s'y noie (le bassin a 2,8 m d'eau). */
const DEEP = 1.5;
const QUAY = 2;
/** Le quai bas des pêcheurs : à l'est de LOW_X, au-delà de LOW_Z du centre (m). */
const LOW_X = -60;
const LOW_Z = 32;
/** Collines au nord, au sud et à l'ouest : leur pied, leur crête (distance au centre le long d'un axe, m). */
const HILL_FOOT = 101;
const HILL_TOP = 136;

/** Relief du port en (x, z) (m) : les quais à plat, le fond sous l'eau, le quai bas, les collines. */
function portHeight(x: number, z: number): number {
  if (WATERS.some((w) => x > w.minX - QUAY && x < w.maxX + QUAY && z > w.minZ - QUAY && z < w.maxZ + QUAY)) return BED;
  const h = x < LOW_X + 1 && Math.abs(z) > LOW_Z - 1 ? Q_LOW : Q;
  const edge = Math.max(Math.abs(z), x) + 4 * noise2(x / 26 + 3, z / 26 - 8);
  return h + smoothstep(HILL_FOOT, HILL_TOP, edge) * (11 + 4 * noise2(x / 40 - 2, z / 40 + 6));
}

const TERRAIN = makeTerrain(440, 220, portHeight);

const yaw = (a: number): Quat => axisAngle(vec3(0, 1, 0), a);

/** Une boîte du décor avec son allure (et, `round`, un cylindre). */
function part(kind: StaticKind, look: BoxLook, x: number, y: number, z: number, hx: number, hy: number, hz: number, rot?: Quat, round?: boolean): StaticBox {
  return { ...box(kind, x, y, z, hx, hy, hz, rot), look, ...(round ? { round } : {}) };
}

/** Une boîte et son reflet de l'autre côté de l'axe est-ouest (z → -z). */
function mirrored(list: readonly StaticBox[]): StaticBox[] {
  return list.flatMap((b) => [b, { ...b, pos: vec3(b.pos.x, b.pos.y, -b.pos.z), rot: { x: -b.rot.x, y: -b.rot.y, z: b.rot.z, w: b.rot.w } }]);
}

/**
 * Murs de quai : du fond jusqu'au quai, sur la bande où le relief remonte (voir `portHeight`) ; on
 * roule dessus comme sur le quai. Et les parapets, au bord de l'eau, sauf au pied des passerelles
 * et à la racine des jetées : un robot ne tombe pas à l'eau en frôlant la rive. Ce sont des murets
 * pour l'IA : elle en contourne le bout (au coin du bassin et du pont) au lieu de buter dessus.
 */
function quays(): StaticBox[] {
  const wall = (minX: number, maxX: number, minZ: number, maxZ: number, top: number): StaticBox =>
    part("road", "quay", (minX + maxX) / 2, top / 2, (minZ + maxZ) / 2, (maxX - minX) / 2, top / 2, (maxZ - minZ) / 2);
  const rail = (minX: number, maxX: number, minZ: number, maxZ: number, base: number): StaticBox =>
    part("barrier", "quay", (minX + maxX) / 2, base + 0.45, (minZ + maxZ) / 2, (maxX - minX) / 2, 0.45, (maxZ - minZ) / 2);
  const north = [
    // Le bassin, sa tête (contre le chenal), le chenal, la darse
    wall(-70, 2, 12, 14, Q),
    wall(0, 2, 6, 14, Q),
    wall(2, 14, 6, 8, Q),
    wall(14, 16, 6, 16, Q),
    wall(14, 42, 14, 16, Q),
    // La mer : le quai haut, puis le quai bas des pêcheurs
    wall(-70, -68, 12, 30, Q),
    wall(-70, -68, 30, 106, Q_LOW),
    // Parapets (ouverts au pied de la passerelle du cargo, à x = -20, et à la racine de la jetée)
    // Près de la passerelle, le parapet n'est pas un muret pour l'IA : il ne repousse pas son chemin
    rail(-70, GANGWAY_X - GANGWAY_HALF - 6.6, 12, 12.4, Q),
    { ...rail(GANGWAY_X - GANGWAY_HALF - 6.6, GANGWAY_X - GANGWAY_HALF - 0.6, 12, 12.4, Q), kind: "wall" as const },
    { ...rail(GANGWAY_X + GANGWAY_HALF + 0.6, GANGWAY_X + GANGWAY_HALF + 6.6, 12, 12.4, Q), kind: "wall" as const },
    rail(GANGWAY_X + GANGWAY_HALF + 6.6, 0, 12, 12.4, Q),
    rail(0, 0.4, 6, 12, Q),
    rail(0, 2, 6, 6.4, Q),
    rail(15.6, 16, 6, 14, Q),
    rail(16, 40, 14, 14.4, Q),
    rail(-70, -69.6, 12.4, 30, Q),
    rail(-70, -69.6, 30, 67, Q_LOW),
    rail(-70, -69.6, 73, 104, Q_LOW),
  ];
  return [...mirrored(north), wall(40, 42, -16, 16, Q), rail(39.6, 40, -14, 14, Q)];
}

/**
 * Le quai bas des pêcheurs : un mur de soutènement le sépare du quai haut, qu'il dépasse d'un
 * parapet (pour l'IA, un muret : elle le contourne par une rampe ; on ne saute pas du bord), et
 * deux rampes y descendent.
 */
function lowQuay(): StaticBox[] {
  const hy = (Q + 0.9 - Q_LOW + 0.3) / 2;
  const y = Q + 0.9 - hy;
  const along = (minZ: number, maxZ: number): StaticBox => part("barrier", "quay", LOW_X + 1, y, (minZ + maxZ) / 2, 1, hy, (maxZ - minZ) / 2);
  const north = [
    along(LOW_Z - 2, 35),
    along(45, 80),
    along(90, 106),
    part("barrier", "quay", -65, y, LOW_Z - 1, 5, hy, 1),
    incline(-62, 40, "x", 1, 10, 8, Q - Q_LOW, Q_LOW),
    incline(-62, 85, "x", 1, 10, 8, Q - Q_LOW, Q_LOW),
  ].map((b) => ({ ...b, look: b.look ?? ("quay" as const) }));
  return mirrored(north);
}

/**
 * Le cargo : une coque (une plateforme : on y monte par les passerelles, larges : on s'y croise),
 * son pont, une étrave en pointe, le château et sa cheminée à l'arrière, des conteneurs à l'avant,
 * un panneau de cale, des pavois le long du bord (des « tabliers » minces : ni abri ni obstacle
 * pour l'IA).
 */
const GANGWAY_X = -20;
const GANGWAY_HALF = 3.5;
function ship(): StaticBox[] {
  const run = 9;
  const rise = DECK - Q;
  const angle = Math.atan2(rise, run);
  const halfLength = Math.hypot(run, rise) / 2;
  const gangway = (side: 1 | -1): StaticBox[] => {
    const rot = axisAngle(vec3(1, 0, 0), side * angle);
    const z = side * 9;
    return [
      { ...incline(GANGWAY_X, z, "z", side === 1 ? -1 : 1, 2 * GANGWAY_HALF, run, rise, Q), look: "steel" },
      ...[-1, 1].map((k) => part("deck", "steel", GANGWAY_X + k * (GANGWAY_HALF - 0.1), Q + rise / 2 + 0.6, z, 0.1, 0.45, halfLength - 1.2, rot)),
    ];
  };
  const bulwarks = mirrored([
    part("deck", "hull", (-50 + GANGWAY_X - GANGWAY_HALF - 1.2) / 2, DECK + 0.45, 4.85, (GANGWAY_X - GANGWAY_HALF - 1.2 + 50) / 2, 0.45, 0.15),
    part("deck", "hull", (-6 + GANGWAY_X + GANGWAY_HALF + 1.2) / 2, DECK + 0.45, 4.85, (-6 - GANGWAY_X - GANGWAY_HALF - 1.2) / 2, 0.45, 0.15),
  ]);
  return [
    // La coque arrive au niveau du haut des passerelles ; le pont peint dépasse d'un centimètre (une
    // marche de quelques centimètres arrête un petit robot)
    part("platform", "hull", -29, DECK / 2, 0, 23, DECK / 2, 5),
    part("road", "hatch", -29.5, DECK - 0.01, 0, 22.4, 0.02, 4.85),
    part("wall", "hull", -52, (DECK + 0.6) / 2, 0, 3.6, (DECK + 0.6) / 2, 3.6, yaw(Math.PI / 4)),
    part("wall", "superstructure", -9.5, DECK + 3.4, 0, 3.5, 3.4, 4.2),
    part("wall", "superstructure", -10.5, DECK + 7.6, 0, 2.5, 0.8, 5.4),
    part("wall", "funnel", -7.5, DECK + 9.4, 0, 1.5, 2.6, 1.5, undefined, true),
    part("wall", "steel", -47, DECK + 4, 0, 0.25, 4, 0.25),
    box("container", -43, DECK + 1.3, 1.25, 3, 1.3, 1.2),
    box("container", -43, DECK + 1.3, -1.25, 3, 1.3, 1.2),
    box("container", -43, DECK + 3.9, -1.25, 3, 1.3, 1.2),
    part("barrier", "hatch", -37, DECK + 0.6, 0, 1.8, 0.6, 2.2),
    ...bulwarks,
    ...gangway(1),
    ...gangway(-1),
  ];
}

/**
 * Les portiques à conteneurs, le long du bassin : quatre pieds sur leurs rails (ceux de devant au
 * bord du quai, contre le parapet : on ne passe pas entre eux et l'eau), une poutre, une flèche
 * au-dessus du cargo, la cabine du grutier.
 */
function gantries(): StaticBox[] {
  const legs = [13, 27];
  const one = (c: number): StaticBox[] => [
    ...legs.flatMap((z) => [-6, 6].map((dx) => part("pillar", "steel", c + dx, Q + 8, z, 0.6, 8, 0.6))),
    ...[-6, 6].map((dx) => part("wall", "steel", c + dx, Q + 16.6, 20, 0.5, 0.6, 7.6)),
    ...legs.map((z) => part("wall", "steel", c, Q + 16.6, z, 6.6, 0.6, 0.5)),
    part("wall", "steel", c, Q + 18.1, 16.5, 1, 0.5, 19.5),
    part("wall", "steel", c, Q + 18.8, 25, 2.6, 1.2, 3.2),
    part("wall", "superstructure", c, Q + 16.6, 6, 1.1, 0.9, 1.3),
  ];
  // Les rails des portiques, le long du quai
  // Les rails, à fleur du quai (une marche de quelques centimètres arrête un petit robot)
  const rails = legs.map((z) => box("track", -34, Q, z, 34, 0.02, 1.3));
  // Au-dessus de l'avant du cargo, loin des abords du pont et de la passerelle
  return mirrored([...one(-50), ...one(-35), ...rails]);
}

/**
 * Le pont tournant sur le chenal : un tablier entre deux poutres en treillis (ses garde-corps, des
 * « tabliers » minces), des entretoises et la cabine du pontier au-dessus de la chaussée, la pile
 * sur laquelle il pivote au milieu de l'eau. Rien aux abords : on y entre de front.
 */
function swingBridge(): StaticBox[] {
  return [
    box("deck", 8, Q - 0.4, 0, 6, 0.5, 8),
    part("deck", "steel", 2.25, Q + 2.6, 0, 0.25, 2.5, 7.5),
    part("deck", "steel", 13.75, Q + 2.6, 0, 0.25, 2.5, 7.5),
    ...[-6, 0, 6].map((z) => part("wall", "steel", 8, Q + 5.5, z, 5.9, 0.3, 0.3)),
    part("wall", "superstructure", 8, Q + 6.8, 0, 2, 1, 2),
    part("wall", "quay", 8, 2.5, 0, 2.4, 2.5, 2.4, undefined, true),
  ];
}

/**
 * Le terminal à conteneurs : des piles de un à trois conteneurs en blocs, avec des allées entre eux ;
 * la place du milieu est une zone. Au coin de la voie ferrée, une pile où l'on monte par une rampe.
 */
function terminal(): StaticBox[] {
  const random = seeded(23);
  const list: StaticBox[] = [];
  // Des allées de neuf mètres, dix entre le terminal et le quai bas : le Camion y passe
  for (const bx of [-45, -30, -15]) {
    for (const bz of [37, 50, 63]) {
      if (bx === -30 && bz === 50) continue; // la zone
      if (bx === -15 && bz === 63) continue; // la pile où l'on monte
      for (const dz of [-1.25, 1.25]) {
        const levels = 1 + Math.floor(random() * 3);
        for (let level = 0; level < levels; level++) list.push(box("container", bx, Q + 1.3 + level * 2.6, bz + dz, 3, 1.3, 1.2));
      }
    }
  }
  list.push(part("platform", "container", -15, Q + 1.3, 63, 3, 1.3, 2.45));
  list.push({ ...incline(-7, 63, "x", -1, 4.5, 10, 2.6, Q), look: "steel" });
  return mirrored(list);
}

/** La darse : une péniche à quai ; un remorqueur dans le bassin ; des barques le long du quai bas. */
function boats(): StaticBox[] {
  return [
    part("wall", "hull", 28, 3.6, 0, 9, 1, 3.2),
    part("wall", "hatch", 28, 4.8, 0, 7, 0.2, 2.4),
    part("wall", "hull", -63, 3.5, 7.5, 4, 0.9, 1.8),
    part("wall", "superstructure", -62, 5.2, 7.5, 1.5, 0.8, 1.2),
    ...mirrored([
      part("wall", "hull", -73.5, 3.3, 48, 1.5, 0.6, 3.6),
      part("wall", "superstructure", -73.5, 4.4, 49.2, 1, 0.6, 1.1),
      part("wall", "hull", -73.5, 3.3, 88, 1.5, 0.6, 3.2),
      part("wall", "superstructure", -73.5, 4.4, 89, 1, 0.6, 1),
    ]),
  ];
}

/** Les jetées, au bout desquelles se dressent les phares, et leurs garde-corps. */
function jetties(): StaticBox[] {
  const top = Q_LOW + 0.1;
  return mirrored([
    part("road", "quay", -83, top / 2, 70, 13, top / 2, 3),
    part("barrier", "quay", -83, top + 0.45, 67.2, 13, 0.45, 0.2),
    part("barrier", "quay", -83, top + 0.45, 72.8, 13, 0.45, 0.2),
    part("barrier", "quay", -95.8, top + 0.45, 70, 0.2, 0.45, 2.6),
    part("pillar", "lighthouse", -92.5, top + 7, 70, 1.6, 7, 1.6, undefined, true),
    part("wall", "lamp", -92.5, top + 15, 70, 1.25, 1, 1.25, undefined, true),
    part("wall", "funnel", -92.5, top + 16.4, 70, 1.6, 0.4, 1.6, undefined, true),
  ]);
}

/** La voie ferrée, de part et d'autre (deux voies), ses wagons, ses heurtoirs. */
function railway(): StaticBox[] {
  const wagon = (x: number, z: number): StaticBox => part("container", "wagon", x, Q + 1.65, z, 5.5, 1.4, 1.3);
  return mirrored([
    box("track", 20.5, Q, 70, 77.5, 0.02, 1.3),
    box("track", 20.5, Q, 74, 77.5, 0.02, 1.3),
    // Sur une seule voie, bien espacés, pas devant le terminal : deux wagons voisins, ou un wagon
    // contre une pile de conteneurs, feraient un piège
    wagon(20, 70), wagon(56, 70), wagon(82, 70),
    part("barrier", "steel", -57.4, Q + 0.6, 72, 0.5, 0.6, 3.2),
  ]);
}

/**
 * L'ouest : les silos et leur galerie jusqu'à la tour de chargement, au bout de la darse ; les
 * grues à tour au bord de la darse. (Le dépôt pétrolier n'a pas de murets de rétention : un robot
 * entré entre eux et les citernes ne savait plus en sortir.)
 */
function westSide(): StaticBox[] {
  return [
    ...[-9, 0, 9].map((z) => part("pillar", "silo", 88, Q + 11, z, 4, 11, 4, undefined, true)),
    part("wall", "steel", 70, Q + 17, 0, 16, 0.9, 1.1),
    part("pillar", "steel", 52, Q + 9, 0, 1.6, 9, 1.6),
    ...mirrored([
      // La grue à tour : son mât en retrait du quai, sa flèche au-dessus de la darse
      part("pillar", "steel", 30, Q + 9.75, 24, 0.7, 9.75, 0.7),
      part("wall", "steel", 30, Q + 20.1, 16, 0.5, 0.5, 14),
      part("wall", "quay", 30, Q + 19.4, 28, 0.9, 0.8, 2),
      part("wall", "superstructure", 30, Q + 19, 24, 1, 0.9, 1),
    ]),
  ];
}

/**
 * Limites invisibles : au fond des collines et loin en mer, jusqu'à BOUND_TOP m de haut, à 100 m du
 * bord du terrain de jeu (à 35 m, comme dans la Vallée, les avions qui fuyaient au-dessus de la mer
 * ou des collines s'y écrasaient souvent).
 */
const BOUND_AT = 200;
const BOUND_TOP = 110;
function bounds(): StaticBox[] {
  const t = 2;
  return [-1, 1].flatMap((s) => [
    box("bound", 0, BOUND_TOP / 2, s * (BOUND_AT + t), BOUND_AT + 2 * t, BOUND_TOP / 2, t),
    box("bound", s * (BOUND_AT + t), BOUND_TOP / 2, 0, t, BOUND_TOP / 2, BOUND_AT + 2 * t),
  ]);
}

const BOXES: readonly StaticBox[] = [
  ...quays(), ...lowQuay(), ...ship(), ...gantries(), ...swingBridge(), ...terminal(), ...boats(), ...jetties(), ...railway(), ...westSide(), ...bounds(),
];

const ZONES: readonly CaptureZone[] = [
  zone("A", 64, Q, 44, 5.5),
  zone("B", -30, Q, 50, 6.5),
  zone("C", -30, DECK, 0, 5.5),
  zone("D", -30, Q, -50, 6.5),
  zone("E", 64, Q, -44, 5.5),
];


/** Le sol où poser un accessoire : la jetée, le quai bas ou le quai. */
const floor = (x: number, z: number): number => (x < -70 ? Q_LOW + 0.1 : x < LOW_X && Math.abs(z) > LOW_Z ? Q_LOW : Q);

/**
 * Les routes du port, en asphalte : la route du quai sous les portiques, celle qui longe le
 * terminal, l'accès au pont, la route de l'ouest.
 */
const PATHS: readonly TerrainPath[] = [
  ...[1, -1].flatMap((s): TerrainPath[] => [
    { width: 8, surface: "asphalt", points: [[-58, s * 20], [44, s * 20]] },
    { width: 5, surface: "asphalt", points: [[-58, s * 31.5], [42, s * 31.5]] },
    { width: 8, surface: "asphalt", points: [[8, s * 8], [8, s * 20]] },
  ]),
  { width: 7, surface: "asphalt", points: [[46, -84], [46, 84]] },
];

function buildProps(): PropList {
  const P = new PropList();
  for (const s of [1, -1] as const) {
    const z = (v: number): number => s * v;
    // Les entrepôts, qu'on traverse : un grand hangar de tôle ouvert sur le quai et sur l'arrière, un entrepôt de briques
    house(P, { x: 8, z: z(42), w: 22, d: 12, h: 7, ground: Q, wall: "sheet", roof: "sheet", roofKind: "flat", ridge: "x", door: 9, flip: s < 0, through: true });
    house(P, { x: 34, z: z(58), w: 14, d: 10, h: 6, ground: Q, wall: "brick", roof: "sheet", roofKind: "flat", ridge: "z", door: 5, through: true });
    // Le dépôt pétrolier : deux rangées de citernes, assez proches pour sauter en chaîne
    // Serrées : on ne se glisse pas entre deux citernes
    for (const tx of [59, 64, 69]) {
      for (const tz of [36, 52]) P.add({ type: "tank", pos: vec3(tx, Q + 1.7 * 1.6, z(tz)), scale: 1.6 });
    }
    // L'atelier, près de la capitainerie
    house(P, { x: 76, z: z(24), w: 10, d: 7, h: 4.5, ground: Q, wall: "brick", roof: "sheet", roofKind: "flat", ridge: "x", door: 5, flip: s < 0 });
    // La cabane des pêcheurs, sur le quai bas, ouverte sur la mer
    house(P, { x: -64, z: z(58), w: 7, d: 4, h: 3, ground: Q_LOW, wall: "plank", roof: "roof", roofKind: "gable", ridge: "z", door: 2.5 });

    const crates: [number, number, number][] = [
      // Le terminal, ses allées
      [-39.5, 44, 0], [-39.5, 45.05, 0], [-39.5, 44.5, 1], [-25, 56, 0], [-24, 56.2, 0], [-54, 44, 0],
      // Les quais, au pied des portiques
      [-58, 20, 0], [-57, 20.3, 0], [-30, 31, 0], [-29, 31, 0], [-29.5, 31, 1], [-2, 31, 0],
      // Les entrepôts, la voie ferrée
      [24, 42, 0], [24.6, 43, 0], [90, 78, 0],
      // Le quai des pêcheurs, la jetée
      [-66, 47, 0], [-66.2, 48.05, 0], [-62, 66, 0], [-78, 69, 0],
    ];
    for (const [x, cz, level] of crates) P.add({ type: "crate", pos: vec3(x, floor(x, cz) + 0.5 + level, z(cz)) });
    const barrels: [number, number][] = [
      [51, 33], [51.8, 33.6], [77, 55], [76.4, 55.8], [60, 60], [-45, 31], [-44.2, 31.5], [-12, 20],
      [22, 48], [22.8, 48.4], [-60.5, 64], [-67, 63], [-66.3, 63.6], [44, 66], [84, 30],
    ];
    for (const [x, cz] of barrels) P.add({ type: "barrel", pos: vec3(x, floor(x, cz) + 0.5, z(cz)) });
    const gas: [number, number][] = [[83, 19], [83.5, 19.6], [-67, 55], [-24, 66], [44, 40]];
    for (const [x, cz] of gas) P.add({ type: "gas", pos: vec3(x, floor(x, cz) + 0.55, z(cz)) });
  }
  // La capitainerie, face à la darse ; des chênes autour
  house(P, { x: 64, z: 0, w: 12, d: 8, h: 6.5, ground: Q, wall: "brick", roof: "roof", roofKind: "gable", ridge: "z", door: 3 });
  for (const [x, z] of [[58, 12], [58, -12], [72, 12], [72, -12]]) P.add({ type: "oak", pos: vec3(x, Q + 3.2 * 0.9, z), scale: 0.9 });
  return P;
}

const PROPS = buildProps();

export const PORT: ArenaLayout = {
  id: "port",
  // Les avions de l'IA volent au-dessus des portiques et des grues (24 à 27 m au-dessus de l'eau)
  bounds: { half: 100, roam: 86, spawnLine: 84, spawnSpread: 30, circuit: 74, airFloor: 28 },
  boxes: BOXES,
  props: PROPS.spots,
  zones: ZONES,
  terrain: TERRAIN,
  water: WATER,
  deepWater: DEEP,
  navGrid: { cell: 2, maxSlope: 0.45 },
  paths: PATHS,
  waterColor: "#2c5a6b",
  // Le béton des quais, ses taches ; l'herbe des collines au-dessus des quais
  ground: {
    base: ["#8a8984", "#7e7d78"], dirt: "#5d5f61", sand: "#6f6d66", mud: "#3c4846", rock: "#6c7d47", peak: "#77736b",
    rockLine: Q + 1.5, rockSpan: 2, peakLine: 30, stains: 0.15, grain: 6, slope: { color: "#6c7d47", from: 0.82, span: 0.18 },
  },
  sky: { color: "#c4d3dd", fog: 0.0042 },
  // Les noms sont posés là où ils ne se chevauchent pas sur la carte (la zone garde sa lettre)
  places: [
    { place: "freighter", x: -30, z: 8 },
    { place: "swingBridge", x: 8, z: -11 },
    { place: "basin", x: 30, z: 8 },
    { place: "harbourOffice", x: 64, z: 10 },
    { place: "silos", x: 88, z: -18 },
    { place: "terminal", x: -24, z: 72 },
    { place: "terminal", x: -24, z: -72 },
    { place: "fuelDepot", x: 64, z: 62 },
    { place: "fuelDepot", x: 64, z: -62 },
    { place: "warehouses", x: 8, z: 42 },
    { place: "warehouses", x: 8, z: -42 },
    { place: "fishermen", x: -64, z: 50 },
    { place: "fishermen", x: -64, z: -50 },
    { place: "lighthouse", x: -88, z: 78 },
    { place: "lighthouse", x: -88, z: -78 },
    { place: "railway", x: 30, z: 78 },
    { place: "railway", x: 30, z: -78 },
  ],
};
