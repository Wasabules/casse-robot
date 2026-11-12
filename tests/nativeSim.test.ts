import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { navigate } from "../src/shared/ai/navigation";
import { ARENAS, type ArenaId, type ArenaLayout, type PropSpot, type StaticBox } from "../src/shared/arena/layout";
import { resetProps } from "../src/shared/arena/props";
import { blockDef } from "../src/shared/catalog/blocks";
import { propHalf, type PropType } from "../src/shared/catalog/props";
import { SHAPE_IDS, shapePieces } from "../src/shared/catalog/shapes";
import { WEAPONS } from "../src/shared/catalog/weapons";
import { groundBelow, PUDDLE_REACH, spawnGroundFire } from "../src/shared/combat/burning";
import { explode } from "../src/shared/combat/damage";
import { regrowable } from "../src/shared/combat/repair";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { cellKey, NEIGHBORS } from "../src/shared/design/robotDesign";
import { add, distance, qrot, vec3, type Vec3 } from "../src/shared/math/vec";
import { groundHeight, spawnBot } from "../src/shared/robot/lifecycle";
import { blockWorldPos } from "../src/shared/robot/queries";
import type { AiMode, Block, Bot, Prop, Team } from "../src/shared/sim/entities";
import type { SimEvent } from "../src/shared/sim/events";
import { newInput, takeControl, type PlayerInput } from "../src/shared/sim/player";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { probePath } from "./probe";
import { seedRandom } from "./seed";

/*
 * La simulation portée en Rust, propriétaire de son monde (crates/casse-sim/src/sim/, temps 4 du
 * plan moteur), contre celle du TypeScript : les mêmes robots préfabriqués, aux mêmes endroits du
 * Dépôt, pilotés sans IA avec les mêmes commandes (gaz, virage, boost, frein) et le même hasard
 * (`Math.random` à graine fixe), doivent faire exactement la même chose, au bit près, à chaque
 * seconde : la pose et la vitesse de chacun de leurs morceaux, la pose et l'état de chacune de leurs
 * roues (montée, arrachée ou retirée), les points de structure et le morceau de chacun de leurs
 * blocs, leurs liaisons rompues, la pose et la vitesse de chaque débris, et ce qui s'est passé
 * (chocs, lots de dégâts, blocs détruits, liaisons rompues, robots hors de combat, roues retirées,
 * tirages du hasard). Sautée si la sonde n'est pas construite (`npm run native -- --probe`).
 *
 * Trois sortes de parcours : rouler (sans heurter quoi que ce soit plus vite que `SAFE_SPEED`), se
 * heurter (un mur, un pilier, un autre robot, au-dessus de `SAFE_SPEED` : blocs détruits, liaisons
 * rompues, morceaux séparés, robots hors de combat), et heurter des accessoires (les caisses, les
 * barils et les bouteilles de gaz du Dépôt ; des arbres, des murs et un toit ancrés posés pour
 * l'essai : caisses brisées, barils qui explosent en chaîne, bouteilles qui fuient et s'envolent,
 * blocs et bois en feu, arbres abattus, murs percés, toit qui tombe). Là, on compare aussi l'état
 * de chaque accessoire (présent ou non, pose, vitesse, points de structure, état, feu…). Et la
 * réparation et les flaques de feu : le Camion, le Mécanicien et le Gardien abîmés par un choc ou
 * par le napalm d'une mine qui saute, puis qui se réparent et font repousser leurs blocs perdus ;
 * des flaques de feu au sol (napalm, jet du lance-flammes) sous des robots et des caisses, avec ou
 * sans eau. Là, on compare aussi les flaques (centre, rayon, fin, auteur), les blocs perdus, et ce
 * que la réparation regarde (le dernier coup reçu, le prochain bloc qui repousse, l'ordre des blocs
 * vivants). Et l'IA qui conduit, hors combat (`sim.combat` faux, comme au stand de tir et à l'essai
 * du garage : ni tactique, ni tourelles, pas encore portées) : des robots de deux équipes qui
 * patrouillent dans les petites arènes (Dépôt, Forteresse, Tranchées, Chantier), contournent les
 * piliers et les murets, montent sur les plateformes par leurs rampes, se coincent et se dégagent,
 * fuient ou foncent sur qui les heurte ; là, on compare aussi l'état de leur IA (mode, destination,
 * minuterie, compteurs de blocage, sens de la marche arrière, dernière position), le point vers
 * lequel la navigation les ferait rouler, et ce que chaque équipe a repéré (sim/detection.ts). Le
 * pas du TypeScript fait bien d'autres choses (air, armes) : le test vérifie, par ses événements,
 * qu'aucune d'elles n'est intervenue côté TypeScript, et que rien de ce que le Rust ne sait pas
 * encore faire ne serait arrivé de son côté (`unported`). `SIM_REPORT=1` : le coût d'un pas, ici et là.
 */

// (une sonde d'avant l'IA n'a pas `sim_ai_state`, et relève moins de choses : sautée)
const PROBE = probePath("sim_ai_state");

interface SimProbe {
  memory: { buffer: ArrayBuffer };
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  sim_new(): number;
  sim_free(id: number): void;
  sim_seed(id: number, seed: number): void;
  sim_add_box(
    id: number, kind: number, len: number, x: number, y: number, z: number, hx: number, hy: number, hz: number, qx: number, qy: number, qz: number, qw: number, round: number,
  ): void;
  sim_clear_scenery(id: number): void;
  sim_set_bounds(id: number, half: number, roam: number): void;
  sim_add_prop(
    id: number, name: number, len: number, x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number, hx: number, hy: number, hz: number, scale: number,
  ): number;
  sim_prop_rest(id: number, prop: number, on: number): void;
  sim_prop_count(id: number): number;
  sim_prop_state(id: number, i: number, out: number): void;
  sim_spawn(id: number, name: number, len: number, x: number, y: number, z: number, yaw: number): number;
  sim_spawn_ai(id: number, name: number, len: number, x: number, y: number, z: number, yaw: number, team: number): number;
  sim_ai_state(id: number, bot: number, out: number): void;
  sim_nav_goal(id: number, bot: number, out: number): void;
  sim_detected(id: number, team: number): number;
  sim_error(out: number, cap: number): number;
  sim_ground_height(name: number, len: number): number;
  sim_shape_piece(name: number, len: number, piece: number, out: number, cap: number): number;
  sim_control(id: number, bot: number, throttle: number, steer: number, brake: number, boost: number): void;
  sim_step(id: number, n: number): void;
  sim_part_count(id: number, bot: number): number;
  sim_part_state(id: number, bot: number, part: number, out: number): void;
  sim_wheel_count(id: number, bot: number): number;
  sim_wheel_state(id: number, bot: number, wheel: number, out: number): void;
  sim_block_count(id: number, bot: number): number;
  sim_block_state(id: number, bot: number, block: number, out: number): void;
  sim_cut_count(id: number, bot: number): number;
  sim_debris_count(id: number): number;
  sim_debris_state(id: number, i: number, out: number): void;
  sim_stats(id: number, out: number): void;
  sim_set_water(id: number, level: number): void;
  sim_explode(id: number, name: number, len: number, x: number, y: number, z: number, dx: number, dy: number, dz: number, owner: number): number;
  sim_puddle(id: number, name: number, len: number, x: number, y: number, z: number, owner: number): number;
  sim_bot_state(id: number, bot: number, out: number): void;
  sim_ground_fire_count(id: number): number;
  sim_ground_fire_state(id: number, i: number, out: number): void;
}

/** Un point où l'essai fait quelque chose (`y` : sa hauteur, 0,3 m par défaut), et le robot à qui on le doit (son rang ; aucun par défaut). */
interface Spot {
  x: number;
  z: number;
  y?: number;
  by?: number;
}

/**
 * Ce que l'essai fait au début d'une phase : faire sauter une mine incendiaire (l'explosion de son
 * projectile, comme `stepMine` : dégâts, blocs enflammés, flaque de napalm, souffle), ou laisser la
 * flaque du jet du lance-flammes là où il arrive (`groundBelow`, `spawnGroundFire`).
 */
interface Act {
  napalm?: readonly Spot[];
  flames?: readonly Spot[];
}

/** Des commandes tenues `seconds` s ; `act` : ce que l'essai fait au début de la phase. */
interface Phase {
  seconds: number;
  throttle: number;
  steer: number;
  brake?: number;
  boost?: boolean;
  act?: Act;
}

/**
 * D'où part un robot (tourné de `yaw`) ; `still` : il reste arrêté, sans commandes ; `ai` : l'IA le
 * conduit, dans cette équipe (sinon, un pilote, chez les rouges).
 */
interface Start {
  id: string;
  x: number;
  z: number;
  yaw: number;
  still?: boolean;
  ai?: Team;
}

/** Un parcours : d'où part le robot piloté (tourné de `yaw`), et ses commandes. */
interface Scenario {
  start: { x: number; z: number; yaw: number };
  phases: readonly Phase[];
}

const SCENARIOS: Readonly<Record<string, Scenario>> = {
  // Au bout de la longue allée dégagée du Dépôt, le long du mur sud, tourné vers -x (comme
  // tests/brake.test.ts) : il se pose, gaz à fond, virage à gauche, boost en contre-braquant, frein
  allée: {
    start: { x: 28, z: -27, yaw: -Math.PI / 2 },
    phases: [
      { seconds: 1, throttle: 0, steer: 0 },
      { seconds: 3, throttle: 1, steer: 0 },
      { seconds: 2, throttle: 1, steer: 0.6 },
      { seconds: 1, throttle: 1, steer: -0.3, boost: true },
      { seconds: 1, throttle: 0, steer: 0, brake: 1 },
    ],
  },
  // Au pied de la rampe ouest, tourné vers +x : il y monte (les rayons des roues touchent une boîte
  // tournée du décor), s'arrête au frein dans la pente, puis redescend en marche arrière
  rampe: {
    start: { x: -32, z: -8, yaw: Math.PI / 2 },
    phases: [
      { seconds: 1, throttle: 0, steer: 0 },
      { seconds: 3, throttle: 0.7, steer: 0 },
      { seconds: 2, throttle: 0, steer: 0, brake: 1 },
      { seconds: 3, throttle: -0.6, steer: 0 },
    ],
  },
  // Face au mur sud, tourné vers -z : il s'y appuie doucement (le solveur de contacts de Rapier, avec
  // les colliders fusionnés du robot, sans dégâts : sous SAFE_SPEED, le choc ne fait rien), puis recule
  mur: {
    start: { x: 0, z: -30, yaw: Math.PI },
    phases: [
      { seconds: 1, throttle: 0, steer: 0 },
      { seconds: 5, throttle: 0.35, steer: 0 },
      { seconds: 2, throttle: -0.4, steer: 0 },
    ],
  },
};

/**
 * Les robots préfabriqués que la simulation portée sait faire rouler : au sol, sur des roues ou des
 * chenilles, sans moteur, appui, aile ni arme de contact (les autres sont refusés).
 */
const PORTED = [
  "scarab", "stilt", "trike", "centi", "ram", "crane", "truck", "tank", "buggy", "bulwark", "lancer", "brawler", "swarm",
  "tracker", "furnace", "carrier", "sapper", "mechanic", "guardian", "scout", "bastion",
];

/** Lancé à fond (boost) après une seconde posé. */
const RUSH: readonly Phase[] = [
  { seconds: 1, throttle: 0, steer: 0 },
  { seconds: 8, throttle: 1, steer: 0, boost: true },
];

/** Le bélier lancé, puis arrêté assez longtemps pour que les épaves des roues arrachées disparaissent (30 s). */
const RUSH_AND_WAIT: readonly Phase[] = [...RUSH, { seconds: 27, throttle: 0, steer: 0 }];

/** Une cible arrêtée en travers de l'allée sud, et un robot lancé contre son flanc depuis l'est. */
const sideRam = (rammer: string, target: string): readonly Start[] => [
  { id: target, x: -8, z: -27, yaw: 0, still: true },
  { id: rammer, x: 20, z: -27, yaw: -Math.PI / 2 },
];

/**
 * Les chocs : un robot lancé contre le mur sud (25 m d'élan, tourné vers -z), contre le pilier
 * (14, -14), face au Char le long de l'allée sud, ou contre le flanc d'un robot arrêté ; chacun avec
 * ce qu'il y casse (vérifié côté TypeScript : des blocs détruits, des liaisons rompues et des
 * morceaux séparés, un robot hors de combat par la règle de structure, des roues arrachées, leurs
 * épaves retirées au bout de 30 s, des dégâts amortis par le bouclier du Rempart). Aucun de ces
 * robots n'a de module de réparation : ceux qui en ont un se heurtent plus bas (`REPAIRS`).
 */
const CRASHES: Readonly<Record<string, { bots: readonly Start[]; phases: readonly Phase[] }>> = {
  "rempart contre le pilier": { bots: [{ id: "bulwark", x: 14, z: 8, yaw: Math.PI }], phases: RUSH },
  "char contre le flanc du rempart": { bots: sideRam("tank", "bulwark"), phases: RUSH },
  "char contre le flanc du scarabée": { bots: sideRam("tank", "scarab"), phases: RUSH },
  "bastion contre le flanc du mille-pattes": { bots: sideRam("bastion", "centi"), phases: RUSH },
  "bélier contre le flanc de la grue": { bots: sideRam("ram", "crane"), phases: RUSH },
  "bélier contre le flanc de l'éclaireur, puis l'attente": { bots: sideRam("ram", "scout"), phases: RUSH_AND_WAIT },
  "mille-pattes contre le mur": { bots: [{ id: "centi", x: 0, z: 8, yaw: Math.PI }], phases: RUSH },
  "buggy contre le mur": { bots: [{ id: "buggy", x: 0, z: 8, yaw: Math.PI }], phases: RUSH },
  "sapeur contre le mur": { bots: [{ id: "sapper", x: 0, z: 8, yaw: Math.PI }], phases: RUSH },
  "tricycle contre le mur": { bots: [{ id: "trike", x: 0, z: 8, yaw: Math.PI }], phases: RUSH },
  "bélier contre le mur": { bots: [{ id: "ram", x: 0, z: 8, yaw: Math.PI }], phases: RUSH },
  "éclaireur contre le mur": { bots: [{ id: "scout", x: 0, z: 8, yaw: Math.PI }], phases: RUSH },
  "grue contre le pilier": { bots: [{ id: "crane", x: 14, z: 8, yaw: Math.PI }], phases: RUSH },
  "char contre le pilier": { bots: [{ id: "tank", x: 14, z: 8, yaw: Math.PI }], phases: RUSH },
  "cogneur contre le pilier": { bots: [{ id: "brawler", x: 14, z: 8, yaw: Math.PI }], phases: RUSH },
  "bastion contre le char": {
    bots: [{ id: "bastion", x: -14, z: -27, yaw: Math.PI / 2 }, { id: "tank", x: 14, z: -27, yaw: -Math.PI / 2 }],
    phases: RUSH,
  },
  "échassier contre le char": {
    bots: [{ id: "stilt", x: -14, z: -27, yaw: Math.PI / 2 }, { id: "tank", x: 14, z: -27, yaw: -Math.PI / 2 }],
    phases: RUSH,
  },
  "scarabée contre le char": {
    bots: [{ id: "scarab", x: -14, z: -27, yaw: Math.PI / 2 }, { id: "tank", x: 14, z: -27, yaw: -Math.PI / 2 }],
    phases: RUSH,
  },
};

/** Un emplacement d'accessoire posé sur le sol plat, centré en (`x`, `z`) (une dalle : `half` ; un cylindre : `scale`). */
function spot(type: PropType, x: number, z: number, more: { half?: Vec3; scale?: number; rests?: number[]; rot?: PropSpot["rot"] } = {}): PropSpot {
  const h = propHalf(type, more);
  return { type, pos: vec3(x, h.y, z), ...more };
}

/** Les arènes sans relief que la simulation portée sait construire (des boîtes, des accessoires). */
type SmallArena = Extract<ArenaId, "depot" | "fort" | "trenches" | "yard">;

/**
 * Un parcours : une arène (le Dépôt par défaut) ; des robots et leurs commandes ; des accessoires
 * (ceux de l'arène, `arena`, ou ceux d'un petit agencement posé pour l'essai, sur son sol) ; de l'eau
 * (son niveau : elle éteint les flaques de feu).
 */
interface Run {
  arena?: SmallArena;
  bots: readonly Start[];
  phases: readonly Phase[];
  props?: "arena" | readonly PropSpot[];
  water?: number;
}

/** Des accessoires heurtés. */
interface PropRun extends Run {
  props: "arena" | readonly PropSpot[];
}

/** Lancé plus doucement (pour pousser sans casser). */
const NUDGE: readonly Phase[] = [
  { seconds: 1, throttle: 0, steer: 0 },
  { seconds: 6, throttle: 0.5, steer: 0 },
];

/** Lancé à fond, puis arrêté : le temps que le feu brûle et que les épaves tombent. */
const RUSH_AND_BURN: readonly Phase[] = [...RUSH, { seconds: 6, throttle: 0, steer: 0 }];

/**
 * Les accessoires : ceux du Dépôt (des caisses en tas, des barils dont trois serrés au pied d'un
 * pilier, des bouteilles de gaz), où les robots partent face à un groupe ; et des agencements posés
 * pour l'essai sur le sol du Dépôt, droit devant un robot parti 12 m plus au sud : un sapin, une
 * palissade, un mur de briques portant un toit, un baril à côté d'un sapin.
 */
const PROP_RUNS: Readonly<Record<string, PropRun>> = {
  "bélier contre les caisses": { bots: [{ id: "ram", x: 20, z: -4, yaw: -Math.PI / 2 }], phases: RUSH, props: "arena" },
  "scarabée qui pousse une caisse": { bots: [{ id: "scarab", x: -20, z: 13, yaw: 0 }], phases: NUDGE, props: "arena" },
  "char contre un baril": { bots: [{ id: "tank", x: 1.5, z: -4, yaw: 0 }], phases: RUSH_AND_BURN, props: "arena" },
  // (son bouclier amortit une part de l'explosion)
  "rempart contre un baril": { bots: [{ id: "bulwark", x: 1.5, z: -4, yaw: 0 }], phases: RUSH_AND_BURN, props: "arena" },
  // (en marche arrière : ses batteries, à l'arrière, détruites par l'explosion, allument leurs voisines)
  "lancier à reculons contre un baril au pied du mur": {
    bots: [{ id: "lancer", x: 0, z: -22, yaw: 0 }],
    phases: [{ seconds: 1, throttle: 0, steer: 0 }, { seconds: 8, throttle: -1, steer: 0, boost: true }, { seconds: 6, throttle: 0, steer: 0 }],
    props: [spot("barrel", 0, -35.1)],
  },
  "bélier contre les barils du pilier": { bots: [{ id: "ram", x: 9.6, z: -2, yaw: 0 }], phases: RUSH_AND_BURN, props: "arena" },
  "buggy contre une bouteille de gaz": { bots: [{ id: "buggy", x: 4, z: -18, yaw: 0 }], phases: RUSH_AND_BURN, props: "arena" },
  "mille-pattes contre la bouteille et les caisses": { bots: [{ id: "centi", x: -5.5, z: -6, yaw: 0 }], phases: RUSH_AND_BURN, props: "arena" },
  "bélier contre un sapin": { bots: [{ id: "ram", x: 0, z: -12, yaw: 0 }], phases: RUSH_AND_BURN, props: [spot("pine", 0, 0)] },
  "buggy contre un sapin": { bots: [{ id: "buggy", x: 0, z: -12, yaw: 0 }], phases: RUSH, props: [spot("pine", 0, 0)] },
  // (le toit, posé sur la palissade, tombe quand elle cède)
  "bélier contre une palissade qui porte un toit": {
    bots: [{ id: "ram", x: 0, z: -12, yaw: 0 }],
    phases: RUSH_AND_BURN,
    props: [spot("plank", 0, 0, { half: vec3(1.2, 0.9, 0.08) }), { ...spot("roof", 0, 0.72, { half: vec3(1.2, 0.06, 0.8), rests: [0] }), pos: vec3(0, 1.86, 0.72) }],
  },
  "char contre un baril près d'un sapin": { bots: [{ id: "tank", x: 0, z: -12, yaw: 0 }], phases: RUSH_AND_BURN, props: [spot("barrel", 0, 0), spot("pine", 1.8, 0.5)] },
  // (le baril coincé contre le mur sud, qui ne peut pas fuir devant le char ; des caisses assez loin
  // pour tenir, assez près pour prendre feu, puis se gagner l'une l'autre et brûler le char)
  "char contre un baril au pied du mur, entre des caisses": {
    bots: [{ id: "tank", x: 0, z: -22, yaw: Math.PI }],
    phases: [...RUSH_AND_BURN, { seconds: 6, throttle: 0, steer: 0 }],
    props: [spot("barrel", 0, -35.1), spot("crate", 2.8, -35), spot("crate", -2.8, -35), spot("crate", 2.8, -33.6), spot("crate", -2.8, -33.6)],
  },
};

/** Lancé à fond, un peu de recul, puis arrêté : le temps de se réparer (la réparation attend 3 s sans coup). */
const RUSH_AND_REPAIR: readonly Phase[] = [...RUSH, { seconds: 2, throttle: -0.5, steer: 0 }, { seconds: 12, throttle: 0, steer: 0 }];

/**
 * La réparation : le Mécanicien, le Camion et le Gardien (un module de réparation chacun) lancés
 * contre le mur sud ou le pilier, ou heurtés au flanc ; puis, au calme, ils réparent leurs blocs et
 * leurs roues abîmés et font repousser leurs blocs perdus, sauf ceux qui ne peuvent pas (hors de
 * portée du module, sans voisin sur le morceau du cockpit, ou dont la case est prise par le robot qui
 * les a heurtés : vérifié côté TypeScript, sur l'ensemble).
 */
const REPAIRS: Readonly<Record<string, Run>> = {
  "mécanicien contre le mur, puis la réparation": { bots: [{ id: "mechanic", x: 0, z: -14, yaw: Math.PI }], phases: RUSH_AND_REPAIR },
  "camion contre le pilier, puis la réparation": { bots: [{ id: "truck", x: 15.5, z: 8, yaw: Math.PI }], phases: RUSH_AND_REPAIR },
  "gardien contre le mur, puis la réparation": { bots: [{ id: "guardian", x: 0, z: -14, yaw: Math.PI }], phases: RUSH_AND_REPAIR },
  "bélier contre le flanc du gardien, puis la réparation": {
    bots: [{ id: "guardian", x: -8, z: -27, yaw: Math.PI / 2, still: true }, { id: "ram", x: 20, z: -27, yaw: -Math.PI / 2 }],
    phases: RUSH_AND_REPAIR,
  },
  "rempart contre le flanc du camion, puis la réparation": {
    bots: [{ id: "truck", x: -8, z: -27, yaw: Math.PI / 2, still: true }, { id: "bulwark", x: 20, z: -27, yaw: -Math.PI / 2 }],
    phases: RUSH_AND_REPAIR,
  },
  // (ses roues touchées par les chenilles du char, qu'il répare)
  "char contre le flanc du mécanicien, puis la réparation": {
    bots: [{ id: "mechanic", x: -8, z: -27, yaw: 0, still: true }, { id: "tank", x: 20, z: -27, yaw: -Math.PI / 2 }],
    phases: RUSH_AND_REPAIR,
  },
  // Des cases prises : par le mur contre lequel il reste appuyé (sans le heurter : sous SAFE_SPEED),
  // par les blocs ou une roue d'un robot qui reste collé à lui
  "camion de biais contre le mur, qui y reste appuyé": {
    bots: [{ id: "truck", x: 0, z: -14, yaw: Math.PI - 0.3 }],
    phases: [...RUSH, { seconds: 14, throttle: 0.6, steer: 0 }],
  },
  "rempart contre le camion, qui y reste collé": {
    bots: [{ id: "truck", x: -8, z: -27, yaw: Math.PI / 2, still: true }, { id: "bulwark", x: 20, z: -27, yaw: -Math.PI / 2 }],
    phases: [...RUSH, { seconds: 14, throttle: 0.4, steer: 0 }],
  },
  "mille-pattes contre le flanc du mécanicien, qui y reste collé": {
    bots: [{ id: "mechanic", x: -8, z: -27, yaw: Math.PI / 2, still: true }, { id: "centi", x: 20, z: -27, yaw: -Math.PI / 2 }],
    phases: [...RUSH, { seconds: 14, throttle: 0.4, steer: 0 }],
  },
};

/** Posé une seconde, puis l'essai fait quelque chose, et on attend. */
const settleThen = (act: Act, seconds: number, ...more: Phase[]): Phase[] => [
  { seconds: 1, throttle: 0, steer: 0 },
  { seconds, throttle: 0, steer: 0, act },
  ...more,
];

/** Une grille de points du coin sud-ouest du Dépôt, sur le sol plat (2,2 m entre deux). */
const grid = (columns: number, rows: number): Spot[] =>
  Array.from({ length: columns * rows }, (_, i) => ({ x: -30 + (i % columns) * 2.2, z: -32 + Math.floor(i / columns) * 2.2 }));

/**
 * Les flaques de feu : une mine incendiaire qui saute près d'un robot réparateur (ses blocs en feu,
 * la flaque de napalm sous lui, puis la réparation, des blocs restés sur un morceau qui s'est
 * détaché qui y reviennent), ou entre un robot et celui qui l'a posée (sa flaque ne le brûle pas) ;
 * des jets de flammes sous des robots (dont un sous son auteur), contre des caisses, en l'air, en
 * grand nombre (au-delà de 40, refusés), là où une flaque brûle déjà (elle est ravivée) ; et de
 * l'eau, qui éteint ce qui tombe dedans (sur le sol, pas sur le pilier).
 */
const FIRES: Readonly<Record<string, Run>> = {
  "napalm près du mécanicien": { bots: [{ id: "mechanic", x: 0, z: -20, yaw: 0, still: true }], phases: settleThen({ napalm: [{ x: 1.5, z: -17.5 }] }, 30) },
  "napalm près du gardien": { bots: [{ id: "guardian", x: 0, z: -20, yaw: 0, still: true }], phases: settleThen({ napalm: [{ x: 2.5, z: -17.5 }] }, 30) },
  "napalm près du camion": { bots: [{ id: "truck", x: 0, z: -20, yaw: 0, still: true }], phases: settleThen({ napalm: [{ x: 2.5, z: -20 }] }, 30) },
  "napalm du scarabée, entre lui et le mécanicien": {
    bots: [{ id: "mechanic", x: -3, z: -20, yaw: 0, still: true }, { id: "scarab", x: 0, z: -20, yaw: 0, still: true }],
    phases: settleThen({ napalm: [{ x: -1.5, z: -20, by: 1 }] }, 16),
  },
  "jets de flammes sous des robots, contre des caisses, en nombre": {
    bots: [
      { id: "scarab", x: 0, z: -20, yaw: 0, still: true },
      { id: "trike", x: 3, z: -20, yaw: 0, still: true },
      { id: "mechanic", x: -4, z: -20, yaw: 0, still: true },
    ],
    props: "arena",
    phases: settleThen(
      {
        flames: [
          { x: 0, z: -20, by: 0 },
          { x: 3, z: -19.6, by: 0 },
          { x: -4, z: -20 },
          { x: 7.5, z: -3 },
          { x: -5, y: 3, z: -28 },
          { x: 0.3, z: -20, by: 1 },
          ...grid(9, 5),
        ],
      },
      3,
      { seconds: 5, throttle: 0, steer: 0, act: { flames: [{ x: 3.2, z: -19.6 }, { x: -20, z: -14 }] } },
      { seconds: 12, throttle: 0, steer: 0, act: { flames: [{ x: 3, z: -20.4, by: 2 }, { x: 7.5, z: -3.1 }] } },
    ),
  },
  "flaques et eau": {
    bots: [{ id: "trike", x: 3, z: -20, yaw: 0, still: true }],
    water: 0.4,
    phases: settleThen(
      {
        napalm: [{ x: -20, z: -28 }, { x: 14, y: 3.3, z: -14 }],
        flames: [{ x: 3, z: -20 }, { x: -10, y: 3.3, z: -18 }, { x: 0, y: 2, z: 23.5 }, { x: 0, y: 2, z: 16.7 }],
      },
      8,
    ),
  },
};

/**
 * Une ligne de départ de robots de l'IA, 8 m entre deux : les rouges au sud, tournés vers le nord ;
 * les bleus au nord, tournés vers le sud (comme `spawnTeams`).
 */
const line = (team: Team, ids: readonly string[]): Start[] =>
  ids.map((id, i) => ({ id, x: (i - (ids.length - 1) / 2) * 8, z: team === "red" ? -27 : 27, yaw: team === "red" ? 0 : Math.PI, ai: team }));

/** Une minute, sans commandes (l'IA conduit). */
const MINUTE: readonly Phase[] = [{ seconds: 60, throttle: 0, steer: 0 }];

/**
 * L'IA qui conduit, hors combat : deux équipes face à face dans chacune des petites arènes, avec
 * leurs accessoires (des robots à roues fixes, directrices, à chenilles ; qui fuient ou qui foncent
 * quand on les heurte ; avec un radar, un brouilleur) ; le pilote d'un char qui tourne au milieu de
 * l'IA (l'essai du garage) ; une mine incendiaire qui saute au milieu de robots de l'IA (ceux qui
 * foncent dessus, ceux qui fuient).
 */
const AI_RUNS: Readonly<Record<string, Run>> = {
  "dépôt, quatre contre quatre": {
    bots: [...line("red", ["tank", "trike", "scarab", "stilt"]), ...line("blue", ["buggy", "truck", "tracker", "ram"])],
    phases: MINUTE,
    props: "arena",
  },
  "forteresse, quatre contre quatre": {
    arena: "fort",
    bots: [...line("red", ["crane", "centi", "lancer", "bastion"]), ...line("blue", ["scout", "sapper", "bulwark", "brawler"])],
    phases: MINUTE,
    props: "arena",
  },
  "chantier, quatre contre quatre": {
    arena: "yard",
    bots: [...line("red", ["mechanic", "guardian", "swarm", "furnace"]), ...line("blue", ["carrier", "scarab", "trike", "tank"])],
    phases: MINUTE,
    props: "arena",
  },
  "tranchées, trois contre trois": {
    arena: "trenches",
    bots: [...line("red", ["tank", "buggy", "centi"]), ...line("blue", ["truck", "scout", "ram"])],
    phases: MINUTE,
    props: "arena",
  },
  // (l'essai du garage : un pilote parmi des robots de l'IA qui ne tirent pas)
  "le pilote d'un char tourne au milieu de l'IA": {
    bots: [
      { id: "tank", x: 0, z: -14, yaw: 0 },
      { id: "scarab", x: -6, z: -10, yaw: 0, ai: "red" },
      { id: "trike", x: 6, z: -10, yaw: 0, ai: "red" },
      { id: "ram", x: -4, z: -2, yaw: Math.PI, ai: "blue" },
      { id: "buggy", x: 4, z: -2, yaw: Math.PI, ai: "blue" },
    ],
    phases: [{ seconds: 1, throttle: 0, steer: 0 }, { seconds: 25, throttle: 1, steer: 0.5, boost: true }, { seconds: 10, throttle: 0, steer: 0 }],
    props: "arena",
  },
  "une mine incendiaire au milieu de l'IA": {
    bots: [
      { id: "tank", x: -2.5, z: -18, yaw: 0, ai: "red" },
      { id: "truck", x: 2.5, z: -18, yaw: 0, ai: "blue" },
      { id: "scarab", x: -2.5, z: -24, yaw: Math.PI, ai: "red" },
      { id: "trike", x: 2.5, z: -24, yaw: Math.PI, ai: "blue" },
    ],
    phases: [{ seconds: 1, throttle: 0, steer: 0 }, { seconds: 20, throttle: 0, steer: 0, act: { napalm: [{ x: 0, z: -21 }] } }],
  },
};

/** Les événements du TypeScript que la simulation portée sait produire ; un autre : quelque chose de pas porté. */
const PORTED_EVENTS = new Set<SimEvent["type"]>([
  "botAdded", "partAdded", "partRemoved", "wheelAdded", "wheelRemoved", "blockAttached", "blockDamaged", "blockDestroyed",
  "botKilled", "collision", "damage", "debrisAdded", "debrisRemoved", "linkBroken", "shieldHit",
  "propAdded", "propRemoved", "propReleased", "propFire", "explosion", "fireStarted", "fireEnded",
  "blockRebuilt", "blockRepaired", "groundFireAdded", "groundFireRemoved",
]);

/**
 * L'état d'un robot relevé chaque seconde : ses morceaux, ses roues, ses blocs, ses liaisons rompues,
 * ce que regarde la réparation (`sim_bot_state`), l'état de son IA (`sim_ai_state`, sans ses rayons
 * d'évitement, que le TypeScript garde pour lui) et le point vers lequel sa navigation le ferait
 * rouler, de sa dernière position à sa destination (`sim_nav_goal`, `navigate`).
 */
interface BotSample {
  parts: number[][];
  wheels: number[][];
  blocks: number[];
  cuts: number;
  state: number[];
  ai: number[];
  nav: number[];
}

/**
 * Les robots, les débris, les accessoires (par emplacement), les flaques de feu, ce que chaque équipe
 * a repéré (rouges, bleus : `sim_detected`), et ce qui s'est passé (comme `sim_stats`).
 */
interface Sample {
  bots: BotSample[];
  debris: number[][];
  props: number[][];
  groundFires: number[][];
  detected: number[];
  stats: number[];
}

const FIELDS_BODY = ["x", "y", "z", "qx", "qy", "qz", "qw", "vx", "vy", "vz", "wx", "wy", "wz"];
const FIELDS_WHEEL = ["x", "y", "z", "qx", "qy", "qz", "qw", "steer", "travel", "spin", "spinRate", "load", "drive", "hp", "où"];
const FIELDS_BLOCK = ["hp", "vivant", "morceau", "feu", "perdu"];
const FIELDS_BOT = ["dernier coup", "repousse après", "énergie", "ordre des blocs vivants"];
const FIELDS_PROP = [
  "présent", ...FIELDS_BODY, "ancré", "hp", "état", "reste", "fuite x", "fuite z", "feu", "noirci", "laisse passer", "éclats x", "éclats y", "éclats z",
];
const FIELDS_GROUND_FIRE = ["x", "y", "z", "rayon", "jusqu'à", "auteur"];
const FIELDS_AI = ["mode", "destination x", "destination y", "destination z", "minuterie", "reste du mode", "coincé", "bloqué", "sens", "x", "y", "z"];
const FIELDS_NAV = ["vers x", "vers y", "vers z"];
const FIELDS_DETECTED = ["repérés par les rouges", "repérés par les bleus"];
/** Les modes de l'IA (`AiMode`), dans l'ordre de `brain::Mode` (le Rust donne leur rang). */
const MODES: readonly AiMode[] = [
  "patrol", "engage", "cover", "flee", "charge", "reverse", "hover", "paused", "gliding", "landing", "stunned", "flipped", "stranded", "falling", "dead", "support",
];
const TEAMS: readonly Team[] = ["red", "blue"];
const FIELDS_STATS = [
  "chocs", "lots de dégâts", "blocs détruits", "liaisons rompues", "robots hors de combat", "roues arrachées", "roues retirées", "pas porté", "tirages",
  "explosions", "accessoires retirés", "accessoires libérés", "blocs allumés", "blocs éteints", "feu des accessoires",
  "blocs repoussés", "blocs réparés", "flaques allumées", "flaques éteintes",
];

let probe: SimProbe;

/** Un texte dans la mémoire du module, le temps d'un appel. */
function withText<T>(text: string, use: (ptr: number, len: number) => T): T {
  const bytes = new TextEncoder().encode(text);
  const ptr = probe.alloc(bytes.length);
  try {
    new Uint8Array(probe.memory.buffer, ptr, bytes.length).set(bytes);
    return use(ptr, bytes.length);
  } finally {
    probe.dealloc(ptr, bytes.length);
  }
}

function lastError(): string {
  const ptr = probe.alloc(512);
  const n = probe.sim_error(ptr, 512);
  const text = new TextDecoder().decode(new Uint8Array(probe.memory.buffer, ptr, n));
  probe.dealloc(ptr, 512);
  return text;
}

function profileOf(id: string) {
  const profile = PRESET_BOTS.find((p) => p.id === id);
  if (!profile) throw new Error(`robot inconnu : ${id}`);
  return profile;
}

const startHeight = (id: string): number => groundHeight(profileOf(id).design) + 0.03;

/** Un robot du TypeScript, aux commandes d'un pilote, et tous ses blocs (dans l'ordre du plan, vivants ou non). */
interface TsBot {
  bot: Bot;
  input: PlayerInput;
  blocks: Block[];
}

/**
 * Des robots dans une Simulation du TypeScript (avec le décor du Dépôt, ou celui d'une autre arène
 * qui le remplace, `loadArena`), aux commandes d'un pilote ou de l'IA ; et des accessoires (ceux de
 * l'arène, ou d'un agencement d'essai), créés avant les robots, comme le fait le jeu (`loadArena`,
 * `spawnWave`). `props` : tous ceux qui ont été créés (présents ou non). `water` : le niveau de l'eau
 * (ces arènes n'en ont pas ; elle n'y sert qu'à éteindre les flaques). L'IA est hors combat (le stand
 * de tir, l'essai du garage : `GameMode.combat`) : sa tactique et ses tourelles ne sont pas portées.
 */
function tsWorld(run: Pick<Run, "arena" | "bots" | "props" | "water">): { sim: Simulation; bots: TsBot[]; props: Prop[] } {
  const sim = new Simulation();
  sim.combat = false;
  const arrangement = run.props;
  const base = ARENAS[run.arena ?? "depot"];
  let arena: ArenaLayout = base;
  if (arrangement && arrangement !== "arena") arena = { ...arena, props: arrangement };
  if (run.water !== undefined) arena = { ...arena, water: run.water };
  if (run.arena) {
    // (une Simulation neuve a le décor du Dépôt : le changer d'arène le remplace, et crée ses accessoires)
    sim.loadArena(arrangement ? arena : { ...arena, props: [] });
  } else {
    if (arena !== base) sim.arena = arena;
    if (arrangement) resetProps(sim);
  }
  const props = [...sim.props];
  const bots = run.bots.map((s) => {
    const bot = spawnBot(sim, profileOf(s.id), vec3(s.x, startHeight(s.id), s.z), s.yaw, s.ai ?? "red");
    sim.bots.push(bot);
    const input = newInput();
    if (!s.ai) takeControl(bot, input);
    return { bot, input, blocks: [...bot.blocks.values()] };
  });
  return { sim, bots, props };
}

/** L'état de l'IA d'un robot, comme `sim_ai_state` (sans ses rayons d'évitement). */
function aiState(bot: Bot): number[] {
  const { ai, lastPos: p } = bot;
  return [MODES.indexOf(ai.mode), ai.target.x, ai.target.y, ai.target.z, ai.timer, ai.modeT, ai.stuckT, ai.blockedT, ai.flip, p.x, p.y, p.z];
}

/** Ce que l'équipe a repéré, comme `sim_detected` : la somme de 2 à la puissance du rang de chaque robot repéré (-1 : la détection n'a pas tourné). */
function detectedMask(sim: Simulation, bots: TsBot[], team: Team): number {
  const seen = sim.detected.get(team);
  return seen ? bots.reduce((sum, { bot }, i) => sum + (seen.has(bot) ? 2 ** i : 0), 0) : -1;
}

/** L'état d'un accessoire, comme `sim_prop_state` (retiré : des zéros). */
function propState(sim: Simulation, p: Prop): number[] {
  if (!sim.props.includes(p)) return new Array<number>(FIELDS_PROP.length).fill(0);
  const s = p.state;
  const kind = s.kind === "intact" ? 0 : s.kind === "fuse" ? 1 : 2;
  const left = s.kind === "intact" ? 0 : s.left;
  const leak = s.kind === "venting" ? s.leak : vec3(0, 0, 0);
  const struck = p.struck ?? vec3(0, 0, 0);
  return [1, ...bodyState(p.rb), p.fixed ? 1 : 0, p.hp, kind, left, leak.x, leak.z, p.burn, p.charred, p.yielding ?? 0, struck.x, struck.y, struck.z];
}

/** L'état d'un corps de Rapier, comme `body_state`. */
function bodyState(rb: { translation(): { x: number; y: number; z: number }; rotation(): { x: number; y: number; z: number; w: number }; linvel(): { x: number; y: number; z: number }; angvel(): { x: number; y: number; z: number } }): number[] {
  const [t, r, v, w] = [rb.translation(), rb.rotation(), rb.linvel(), rb.angvel()];
  return [t.x, t.y, t.z, r.x, r.y, r.z, r.w, v.x, v.y, v.z, w.x, w.y, w.z];
}

/** L'ordre des blocs vivants d'un robot (`bot.blocks`, une `Map`) résumé en un nombre, comme `sim_bot_state` : la somme des rangs des blocs dans le plan, pondérés par leur rang dans la `Map`. */
const liveOrder = (bot: Bot, blocks: readonly Block[]): number => [...bot.blocks.values()].reduce((s, b, rank) => s + (rank + 1) * (blocks.indexOf(b) + 1), 0);

/** L'état du monde du TypeScript, comme le relève le Rust. */
function tsSample(sim: Simulation, bots: TsBot[], props: Prop[], counts: Record<string, number>, draws: number): Sample {
  return {
    bots: bots.map(({ bot, blocks }) => {
      const parts = [...bot.parts];
      return {
        parts: parts.map((p) => bodyState(p.rb)),
        wheels: bot.wheels.map((w) => {
          const p = w.rb.translation();
          const q = w.rb.rotation();
          const at = w.part ? parts.indexOf(w.part) : w.body ? -1 : -2;
          return [p.x, p.y, p.z, q.x, q.y, q.z, q.w, w.steer, w.travel, w.spin, w.spinRate, w.load, w.drive, w.hp, at];
        }),
        blocks: blocks.flatMap((b) => [b.hp, b.alive ? 1 : 0, b.alive ? parts.indexOf(b.part) : -1, b.burn, bot.lost.get(b.key) === b ? 1 : 0]),
        cuts: bot.cuts.size,
        state: [bot.lastHit, bot.rebuildAt, bot.energy, liveOrder(bot, blocks)],
        ai: aiState(bot),
        nav: ((g) => [g.x, g.y, g.z])(navigate(sim, bot, bot.lastPos, bot.ai.target)),
      };
    }),
    debris: sim.debris.map((d) => bodyState(d.rb)),
    props: props.map((p) => propState(sim, p)),
    groundFires: sim.groundFires.map((f) => [f.pos.x, f.pos.y, f.pos.z, f.radius, f.until, f.owner ? bots.findIndex((b) => b.bot === f.owner) : -1]),
    detected: TEAMS.map((team) => detectedMask(sim, bots, team)),
    stats: [
      counts.collision ?? 0, counts.damage ?? 0, counts.blockDestroyed ?? 0, counts.linkBroken ?? 0, counts.botKilled ?? 0,
      // (une roue arrachée n'a pas d'événement : celles qui ont un corps, ou n'en ont plus)
      bots.reduce((s, { bot }) => s + bot.wheels.filter((w) => !w.part).length, 0),
      counts.wheelRemoved ?? 0, 0, draws,
      counts.explosion ?? 0, counts.propRemoved ?? 0, counts.propReleased ?? 0, counts.fireStarted ?? 0, counts.fireEnded ?? 0, counts.propFire ?? 0,
      counts.blockRebuilt ?? 0, counts.blockRepaired ?? 0, counts.groundFireAdded ?? 0, counts.groundFireRemoved ?? 0,
    ],
  };
}

/** Le point d'une action de l'essai (`y` : 0,3 m par défaut, une mine posée au sol). */
const spotAt = (s: Spot, shift = 0): Vec3 => vec3(s.x + shift, s.y ?? 0.3, s.z);
const UP = vec3(0, 1, 0);

/**
 * Ce que l'essai fait au début d'une phase, côté TypeScript (`act`), en comptant ce qui arrive aux
 * flaques : pas de sol dessous (`air`), refusée sous l'eau (`drowned`) ou faute de place (`full`),
 * une flaque qui brûlait déjà là ravivée (`merged`), une nouvelle (`lit`) ; et les blocs de son
 * auteur qui se tiennent dans une flaque de napalm qu'il a allumée (`ownerInside`, qu'elle ne brûle
 * pas). (`groundBelow` n'est qu'une requête à Rapier : la relancer pour compter ne change rien.)
 */
function actTs(sim: Simulation, bots: TsBot[], act: Act, counts: Record<string, number>): void {
  const bump = (what: string, n = 1): void => {
    counts[what] = (counts[what] ?? 0) + n;
  };
  const water = sim.arena.water;
  for (const n of act.napalm ?? []) {
    const point = spotAt(n);
    const owner = n.by === undefined ? null : bots[n.by].bot;
    const before = sim.groundFires.length;
    const ground = groundBelow(sim, point, PUDDLE_REACH);
    explode(sim, point, WEAPONS.fireMine.projectile.explosion!, UP, point, owner, null);
    if (ground && water !== undefined && ground.y < water) bump("drowned");
    const fire = sim.groundFires.length > before ? sim.groundFires[sim.groundFires.length - 1] : null;
    if (fire && owner) {
      const inside = [...owner.blocks.values()].filter((b) => {
        const p = blockWorldPos(b);
        return Math.hypot(p.x - fire.pos.x, p.z - fire.pos.z) < fire.radius && p.y - fire.pos.y < 1.1;
      });
      bump("ownerInside", inside.length);
    }
  }
  for (const f of act.flames ?? []) {
    const ground = groundBelow(sim, spotAt(f), PUDDLE_REACH);
    if (!ground) {
      bump("air");
      continue;
    }
    const known = new Set(sim.groundFires);
    const fire = spawnGroundFire(sim, ground, WEAPONS.flamer.projectile.puddle!, f.by === undefined ? null : bots[f.by].bot);
    if (!fire) bump(water !== undefined && ground.y < water ? "drowned" : "full");
    else bump(known.has(fire) ? "merged" : "lit");
  }
}

/**
 * Les blocs perdus d'un robot qu'un de ses modules de réparation ferait repousser (à sa portée, contre
 * un bloc du morceau du cockpit) si leur case n'était pas prise (par le décor, un accessoire, un autre
 * robot) : le module en a, mais `regrowable` (une requête, sans effet) n'en trouve aucun dont la case
 * soit libre.
 */
function blockedCells(sim: Simulation, bot: Bot): number {
  if (!bot.cockpit.alive) return 0;
  const core = bot.cockpit.part;
  let blocked = 0;
  for (const m of [...core.blocks].filter((b) => blockDef(b.type).repair)) {
    const center = blockWorldPos(m);
    const radius = blockDef(m.type).repair!.radius;
    const candidates = [...bot.lost.values()].filter((lost) => {
      const at = add(core.rb.translation(), qrot(core.rb.rotation(), lost.local));
      const touches = NEIGHBORS.some(([dx, dy, dz]) => bot.blocks.get(cellKey(lost.x + dx, lost.y + dy, lost.z + dz))?.part === core);
      return touches && distance(at, center) < radius;
    });
    if (candidates.length && !regrowable(sim, bot, center, radius)) blocked += candidates.length;
  }
  return blocked;
}

/** Ce que l'IA d'un robot était avant un pas : son mode, sa destination, son redressement. */
interface Mind {
  mode: AiMode;
  target: Vec3;
  righting: number;
}

/**
 * Ce que l'IA a fait pendant un pas (côté TypeScript, pour le bilan) : les modes où elle est entrée
 * (`mode:reverse`…), les destinations de patrouille tirées (`wander`), les bonds pour se dégager
 * (`unstick` : le gyroscope qui se met en marche sans que le robot soit renversé), les pas passés sur
 * une plateforme (`platform`, montée par une rampe).
 */
function watchAi(sim: Simulation, bots: TsBot[], minds: readonly Mind[], counts: Record<string, number>): void {
  const bump = (what: string): void => {
    counts[what] = (counts[what] ?? 0) + 1;
  };
  for (const [i, { bot }] of bots.entries()) {
    if (bot.controller !== "ai") continue;
    const before = minds[i];
    const ai = bot.ai;
    if (ai.mode !== before.mode) bump(`mode:${ai.mode}`);
    if (ai.mode === "patrol" && ai.target !== before.target) bump("wander");
    if (before.righting <= 0 && bot.righting > 0 && ai.mode !== "flipped") bump("unstick");
    const p = bot.lastPos;
    const aboard = sim.arena.boxes.some((b) => b.kind === "platform" && Math.abs(p.x - b.pos.x) < b.half.x && Math.abs(p.z - b.pos.z) < b.half.z && p.y > b.pos.y + b.half.y);
    if (aboard) bump("platform");
  }
}

/**
 * Ce que la détection a fait dans un relevé (pour le bilan) : des ennemis repérés (`spotted`) ; des
 * ennemis à moins de 60 m d'un robot vivant de l'équipe (de quoi le voir, même avec une position
 * vieille d'un quart de seconde) et pas repérés (`hidden` : le décor les cachait) ; et les relevés où
 * la navigation vise autre chose que la destination (`corner` : le coin d'un obstacle, le pied ou le
 * haut d'une rampe).
 */
function countSight(starts: readonly Start[], sample: Sample, counts: Record<string, number>): void {
  const DEAD = MODES.indexOf("dead");
  const at = (i: number): Vec3 => vec3(sample.bots[i].ai[9], sample.bots[i].ai[10], sample.bots[i].ai[11]);
  const alive = (i: number): boolean => sample.bots[i].ai[0] !== DEAD;
  for (const [t, team] of TEAMS.entries()) {
    const mask = sample.detected[t];
    for (const [e, enemy] of starts.entries()) {
      if ((enemy.ai ?? "red") === team || !alive(e)) continue;
      const spotted = mask >= 0 && Math.floor(mask / 2 ** e) % 2 === 1;
      if (spotted) counts.spotted = (counts.spotted ?? 0) + 1;
      const near = starts.some((o, i) => (o.ai ?? "red") === team && alive(i) && distance(at(i), at(e)) < 60);
      if (!spotted && near) counts.hidden = (counts.hidden ?? 0) + 1;
    }
  }
  for (const [i, s] of starts.entries()) {
    const b = sample.bots[i];
    if (s.ai && alive(i) && (b.nav[0] !== b.ai[1] || b.nav[2] !== b.ai[3])) counts.corner = (counts.corner ?? 0) + 1;
  }
}

/** Des robots (et des accessoires) dans la simulation du TypeScript, chaque seconde ; et les événements qui n'y sont pas portés. */
function runTs(run: Run, seed: number): { samples: Sample[]; unported: string[]; counts: Record<string, number> } {
  const { bots: starts, phases } = run;
  seedRandom(seed);
  const random = vi.mocked(Math.random);
  const drawn = random.mock.calls.length;
  const { sim, bots, props } = tsWorld(run);
  const counts: Record<string, number> = {};
  const unported = new Set<string>();
  // (les blocs détruits, pour reconnaître un bloc qui repousse d'un bloc resté sur un morceau arraché)
  const dead = new Set<Block>();
  sim.on((e) => {
    counts[e.type] = (counts[e.type] ?? 0) + 1;
    if (e.type === "propRemoved") {
      counts[`removed:${e.prop.type}`] = (counts[`removed:${e.prop.type}`] ?? 0) + 1;
      // (brisé par un robot qui passe au travers : ses éclats sont partis devant lui)
      if (e.prop.struck) counts.struck = (counts.struck ?? 0) + 1;
    }
    // (une batterie détruite met le feu à ses voisins)
    if (e.type === "blockDestroyed" && blockDef(e.block.type).battery) counts.battery = (counts.battery ?? 0) + 1;
    if (e.type === "blockDestroyed") dead.add(e.block);
    if (e.type === "blockRebuilt" && !dead.delete(e.block)) counts.rejoined = (counts.rejoined ?? 0) + 1;
    if (!PORTED_EVENTS.has(e.type)) unported.add(e.type);
  });
  const samples: Sample[] = [];
  for (const phase of phases) {
    for (const [i, { input }] of bots.entries()) {
      if (starts[i].still || starts[i].ai) continue;
      input.throttle = phase.throttle;
      input.steer = phase.steer;
      input.brake = phase.brake ?? 0;
      input.boost = phase.boost ?? false;
    }
    if (phase.act) {
      // (une explosion fait déjà réagir l'IA de ceux qu'elle touche)
      const minds = bots.map(({ bot }) => ({ mode: bot.ai.mode, target: bot.ai.target, righting: bot.righting }));
      actTs(sim, bots, phase.act, counts);
      watchAi(sim, bots, minds, counts);
    }
    for (let s = 0; s < phase.seconds; s++) {
      for (let i = 0; i < 60; i++) {
        // (une roue montée qui regagne des points : la réparation ; qui en perd pendant un pas sans
        // choc ni explosion : une flaque de feu, le feu des blocs ne touchant pas les roues)
        const before = bots.flatMap(({ bot }) => bot.wheels.map((w) => (w.part ? w.hp : NaN)));
        const blows = (counts.collision ?? 0) + (counts.explosion ?? 0);
        const minds = bots.map(({ bot }) => ({ mode: bot.ai.mode, target: bot.ai.target, righting: bot.righting }));
        sim.step();
        watchAi(sim, bots, minds, counts);
        const after = bots.flatMap(({ bot }) => bot.wheels.map((w) => w.hp));
        if (before.some((hp, k) => after[k] > hp)) counts.wheelRepaired = (counts.wheelRepaired ?? 0) + 1;
        if (blows === (counts.collision ?? 0) + (counts.explosion ?? 0) && before.some((hp, k) => after[k] < hp)) {
          counts.wheelBurnt = (counts.wheelBurnt ?? 0) + 1;
        }
      }
      samples.push(tsSample(sim, bots, props, counts, random.mock.calls.length - drawn));
    }
  }
  counts.lostLeft = bots.reduce((s, { bot }) => s + bot.lost.size, 0);
  for (const sample of samples) countSight(starts, sample, counts);
  counts.blockedCells = bots.reduce((s, { bot }) => s + blockedCells(sim, bot), 0);
  sim.dispose();
  return { samples, unported: [...unported], counts };
}

/** Les boîtes d'un décor, dans l'ordre, dans un monde de la simulation portée. */
function rustBoxes(sim: number, boxes: readonly StaticBox[]): void {
  for (const b of boxes) {
    if (b.kind === "rock") throw new Error("un rocher : pas encore porté");
    withText(b.kind, (ptr, len) =>
      probe.sim_add_box(sim, ptr, len, b.pos.x, b.pos.y, b.pos.z, b.half.x, b.half.y, b.half.z, b.rot.x, b.rot.y, b.rot.z, b.rot.w, b.round ? 1 : 0));
  }
}

/**
 * Un monde de la simulation portée, avec le décor du Dépôt (l'arène d'une Simulation neuve), dans le
 * même ordre, remplacé s'il le faut par celui d'une autre arène (comme `loadArena`), ses dimensions,
 * de l'eau, et des accessoires ; `propShift` : un décalage du premier accessoire (m, en x).
 */
function rustWorld(run: Pick<Run, "arena" | "props" | "water">, seed = 0, propShift = 0): number {
  const sim = probe.sim_new();
  probe.sim_seed(sim, seed);
  probe.sim_set_water(sim, run.water ?? NaN);
  rustBoxes(sim, ARENAS.depot.boxes);
  const arena = ARENAS[run.arena ?? "depot"];
  if (run.arena) {
    probe.sim_clear_scenery(sim);
    rustBoxes(sim, arena.boxes);
  }
  probe.sim_set_bounds(sim, arena.bounds.half, arena.bounds.roam);
  const arrangement = run.props;
  const spots = arrangement === "arena" ? arena.props : arrangement ?? [];
  for (const [i, s] of spots.entries()) {
    const r = s.rot;
    const h = s.half;
    const x = s.pos.x + (i === 0 ? propShift : 0);
    const prop = withText(s.type, (ptr, len) =>
      probe.sim_add_prop(sim, ptr, len, x, s.pos.y, s.pos.z, r?.x ?? NaN, r?.y ?? NaN, r?.z ?? NaN, r?.w ?? NaN, h?.x ?? NaN, h?.y ?? NaN, h?.z ?? NaN, s.scale ?? NaN));
    if (prop !== i) throw new Error(lastError());
  }
  for (const [i, s] of spots.entries()) for (const on of s.rests ?? []) probe.sim_prop_rest(sim, i, on);
  return sim;
}

function rustBot(sim: number, s: Start): number {
  const bot = withText(s.id, (ptr, len) =>
    s.ai
      ? probe.sim_spawn_ai(sim, ptr, len, s.x, startHeight(s.id), s.z, s.yaw, TEAMS.indexOf(s.ai))
      : probe.sim_spawn(sim, ptr, len, s.x, startHeight(s.id), s.z, s.yaw));
  if (bot < 0) throw new Error(lastError());
  return bot;
}

/** Taille du tampon des relevés (en nombres de 8 octets). */
const OUT = 32;

/** L'état du monde de la simulation portée. */
function rustSample(sim: number, bots: number[], out: number): Sample {
  const read = (n: number): number[] => Array.from(new Float64Array(probe.memory.buffer, out, n));
  const sample: Sample = { bots: [], debris: [], props: [], groundFires: [], detected: [], stats: [] };
  for (const bot of bots) {
    const parts: number[][] = [];
    for (let p = 0; p < probe.sim_part_count(sim, bot); p++) {
      probe.sim_part_state(sim, bot, p, out);
      parts.push(read(13));
    }
    const wheels: number[][] = [];
    for (let w = 0; w < probe.sim_wheel_count(sim, bot); w++) {
      probe.sim_wheel_state(sim, bot, w, out);
      wheels.push(read(15));
    }
    const blocks: number[] = [];
    for (let b = 0; b < probe.sim_block_count(sim, bot); b++) {
      probe.sim_block_state(sim, bot, b, out);
      blocks.push(...read(FIELDS_BLOCK.length));
    }
    probe.sim_bot_state(sim, bot, out);
    const state = read(FIELDS_BOT.length);
    probe.sim_ai_state(sim, bot, out);
    const ai = read(FIELDS_AI.length);
    probe.sim_nav_goal(sim, bot, out);
    const nav = read(FIELDS_NAV.length);
    sample.bots.push({ parts, wheels, blocks, cuts: probe.sim_cut_count(sim, bot), state, ai, nav });
  }
  for (let i = 0; i < probe.sim_debris_count(sim); i++) {
    probe.sim_debris_state(sim, i, out);
    sample.debris.push(read(13));
  }
  for (let i = 0; i < probe.sim_prop_count(sim); i++) {
    probe.sim_prop_state(sim, i, out);
    sample.props.push(read(FIELDS_PROP.length));
  }
  for (let i = 0; i < probe.sim_ground_fire_count(sim); i++) {
    probe.sim_ground_fire_state(sim, i, out);
    sample.groundFires.push(read(FIELDS_GROUND_FIRE.length));
  }
  sample.detected = TEAMS.map((_, team) => probe.sim_detected(sim, team));
  probe.sim_stats(sim, out);
  sample.stats = read(FIELDS_STATS.length);
  return sample;
}

/** Ce que l'essai fait au début d'une phase, côté Rust ; `shift` : un décalage de chaque point (m, en x). */
function actRust(sim: number, bots: number[], act: Act, shift: number): void {
  const owner = (s: Spot): number => (s.by === undefined ? -1 : bots[s.by]);
  for (const n of act.napalm ?? []) {
    const p = spotAt(n, shift);
    if (withText("fireMine", (ptr, len) => probe.sim_explode(sim, ptr, len, p.x, p.y, p.z, UP.x, UP.y, UP.z, owner(n))) < 0) throw new Error(lastError());
  }
  for (const f of act.flames ?? []) {
    const p = spotAt(f, shift);
    if (withText("flamer", (ptr, len) => probe.sim_puddle(sim, ptr, len, p.x, p.y, p.z, owner(f))) < 0) throw new Error(lastError());
  }
}

/** Des décalages côté Rust seulement (m, en x) : du départ du premier robot, du premier accessoire, des points des actions de l'essai. */
interface Shift {
  bot?: number;
  prop?: number;
  act?: number;
}

/** Les mêmes robots (et accessoires, et eau, et actions de l'essai) dans la simulation portée. */
function runRust(run: Run, seed: number, shift: Shift = {}): Sample[] {
  const { bots: starts, phases } = run;
  const sim = rustWorld(run, seed, shift.prop ?? 0);
  const out = probe.alloc(OUT * 8);
  try {
    const bots = starts.map((s, i) => rustBot(sim, i === 0 ? { ...s, x: s.x + (shift.bot ?? 0) } : s));
    const samples: Sample[] = [];
    for (const phase of phases) {
      for (const [i, bot] of bots.entries()) {
        if (!starts[i].still && !starts[i].ai) probe.sim_control(sim, bot, phase.throttle, phase.steer, phase.brake ?? 0, phase.boost ? 1 : 0);
      }
      if (phase.act) actRust(sim, bots, phase.act, shift.act ?? 0);
      for (let s = 0; s < phase.seconds; s++) {
        probe.sim_step(sim, 60);
        samples.push(rustSample(sim, bots, out));
      }
    }
    return samples;
  } finally {
    probe.dealloc(out, OUT * 8);
    probe.sim_free(sim);
  }
}

/** Le premier nombre qui diffère d'une liste (au bit près : `Object.is`), nommé ; null s'il n'y en a pas. */
function differ(what: string, fields: readonly string[], a: readonly number[], b: readonly number[]): string | null {
  if (a.length !== b.length) return `${what} : ${a.length} nombres (Rust) contre ${b.length} (TypeScript)`;
  const k = a.findIndex((v, i) => !Object.is(v, b[i]));
  if (k < 0) return null;
  const field = fields[k % fields.length];
  const index = a.length > fields.length ? ` n° ${Math.floor(k / fields.length)}` : "";
  return `${what}${index}, ${field} : ${a[k]} (Rust) contre ${b[k]} (TypeScript)`;
}

/** Le premier nombre qui diffère, pour comprendre ; null s'il n'y en a pas. */
function firstDifference(a: Sample[], b: Sample[]): string | null {
  for (let s = 0; s < Math.max(a.length, b.length); s++) {
    const [x, y] = [a[s], b[s]];
    if (!x || !y) return `seconde ${s + 1} : un relevé manque`;
    const at = `seconde ${s + 1}`;
    for (let r = 0; r < x.bots.length; r++) {
      const [p, q] = [x.bots[r], y.bots[r]];
      if (p.parts.length !== q.parts.length) return `${at}, robot ${r} : ${p.parts.length} morceaux (Rust) contre ${q.parts.length} (TypeScript)`;
      for (let i = 0; i < p.parts.length; i++) {
        const d = differ(`${at}, robot ${r}, morceau ${i}`, FIELDS_BODY, p.parts[i], q.parts[i]);
        if (d) return d;
      }
      if (p.wheels.length !== q.wheels.length) return `${at}, robot ${r} : ${p.wheels.length} roues contre ${q.wheels.length}`;
      for (let w = 0; w < p.wheels.length; w++) {
        const d = differ(`${at}, robot ${r}, roue ${w}`, FIELDS_WHEEL, p.wheels[w], q.wheels[w]);
        if (d) return d;
      }
      const d = differ(`${at}, robot ${r}, bloc`, FIELDS_BLOCK, p.blocks, q.blocks);
      if (d) return d;
      if (p.cuts !== q.cuts) return `${at}, robot ${r} : ${p.cuts} liaisons rompues (Rust) contre ${q.cuts} (TypeScript)`;
      const s = differ(`${at}, robot ${r}`, FIELDS_BOT, p.state, q.state);
      if (s) return s;
      const m = differ(`${at}, robot ${r}, IA`, FIELDS_AI, p.ai, q.ai);
      if (m) return m;
      const n = differ(`${at}, robot ${r}, navigation`, FIELDS_NAV, p.nav, q.nav);
      if (n) return n;
    }
    if (x.debris.length !== y.debris.length) return `${at} : ${x.debris.length} débris (Rust) contre ${y.debris.length} (TypeScript)`;
    for (let i = 0; i < x.debris.length; i++) {
      const d = differ(`${at}, débris ${i}`, FIELDS_BODY, x.debris[i], y.debris[i]);
      if (d) return d;
    }
    if (x.props.length !== y.props.length) return `${at} : ${x.props.length} accessoires (Rust) contre ${y.props.length} (TypeScript)`;
    for (let i = 0; i < x.props.length; i++) {
      const d = differ(`${at}, accessoire ${i}`, FIELDS_PROP, x.props[i], y.props[i]);
      if (d) return d;
    }
    if (x.groundFires.length !== y.groundFires.length) return `${at} : ${x.groundFires.length} flaques de feu (Rust) contre ${y.groundFires.length} (TypeScript)`;
    for (let i = 0; i < x.groundFires.length; i++) {
      const d = differ(`${at}, flaque ${i}`, FIELDS_GROUND_FIRE, x.groundFires[i], y.groundFires[i]);
      if (d) return d;
    }
    const seen = differ(at, FIELDS_DETECTED, x.detected, y.detected);
    if (seen) return seen;
    const d = differ(at, FIELDS_STATS, x.stats, y.stats);
    if (d) return d;
  }
  return null;
}

describe.skipIf(!PROBE)("Simulation portée en Rust : des robots qui roulent et se heurtent, au bit près", () => {
  beforeAll(async () => {
    await initPhysics();
    const { instance } = await WebAssembly.instantiate(readFileSync(PROBE!), {});
    probe = instance.exports as unknown as SimProbe;
  });

  it("le catalogue lu par le Rust donne les mêmes hauteurs de départ", () => {
    for (const p of PRESET_BOTS) {
      const native = withText(p.id, (ptr, len) => probe.sim_ground_height(ptr, len));
      expect(Object.is(native, groundHeight(p.design)), p.id).toBe(true);
    }
  });

  it("les formes de blocs : les mêmes morceaux convexes (sommets, volume), au bit près", () => {
    const cap = 64;
    const out = probe.alloc((3 * cap + 1) * 8);
    for (const shape of SHAPE_IDS) {
      const pieces = shapePieces(shape);
      for (let i = 0; i <= pieces.length; i++) {
        const n = withText(shape, (ptr, len) => probe.sim_shape_piece(ptr, len, i, out, cap));
        if (i === pieces.length) {
          expect(n, `${shape} : un morceau de trop`).toBe(-1);
          continue;
        }
        const native = Array.from(new Float64Array(probe.memory.buffer, out, 3 * n + 1));
        const ts = [...pieces[i].points.flatMap((p) => [p.x, p.y, p.z]), pieces[i].volume];
        expect(native.length, shape).toBe(ts.length);
        expect(native.every((v, k) => Object.is(v, ts[k])), shape).toBe(true);
      }
    }
    probe.dealloc(out, (3 * cap + 1) * 8);
  });

  it("les autres robots sont refusés, pour une raison dite (ce qui n'est pas encore porté)", () => {
    const sim = probe.sim_new();
    for (const p of PRESET_BOTS) {
      if (PORTED.includes(p.id)) continue;
      const bot = withText(p.id, (ptr, len) => probe.sim_spawn(sim, ptr, len, 0, 3, 0, 0));
      expect(bot, p.id).toBe(-1);
      expect(lastError()).toMatch(/pas encore porté/);
    }
    probe.sim_free(sim);
  });

  // Roues fixes (Scarabée), une directrice et deux fixes (Tricycle), de petites roues directrices
  // (Buggy), des chenilles (Char), de grosses roues (Camion), des blocs orientés et un poseur de
  // mines tourné vers l'arrière (Bélier), des blocs de forme (Bastion), toutes les tourelles des
  // robots au sol ; sur le plat, sur la rampe, contre un mur
  const cases = PORTED.flatMap((id) => Object.keys(SCENARIOS).map((name) => [id, name] as const));
  it.each(cases)("%s, %s : même chemin, mêmes roues", (id, name) => {
    const { start, phases } = SCENARIOS[name];
    const run = { bots: [{ id, ...start }], phases };
    const ts = runTs(run, 5);
    expect(ts.unported, "pas porté, côté TypeScript").toEqual([]);
    const last = ts.samples[ts.samples.length - 1];
    expect(last.stats[0], "le robot du TypeScript a heurté quelque chose").toBe(0);
    const rust = runRust(run, 5);
    expect(rust.length).toBe(phases.reduce((s, p) => s + p.seconds, 0));
    expect(firstDifference(rust, ts.samples)).toBeNull();
    // (il a bien roulé : à plus d'un mètre de son départ, à un moment ; cinq, sauf contre le mur)
    const far = Math.max(...rust.map((s) => Math.hypot(s.bots[0].parts[0][0] - start.x, s.bots[0].parts[0][2] - start.z)));
    expect(far).toBeGreaterThan(name === "mur" ? 1 : 5);
  });

  // Ce que les chocs ont fait, sur tous les parcours (côté TypeScript) : chaque sorte de dégât arrive
  const seen = { destroyed: 0, links: 0, split: 0, killed: 0, released: 0, removed: 0, shielded: 0 };
  it.each(Object.keys(CRASHES))("%s : mêmes chocs, mêmes dégâts", (name) => {
    const ts = runTs(CRASHES[name], 11);
    expect(ts.unported, "pas porté, côté TypeScript").toEqual([]);
    const last = ts.samples[ts.samples.length - 1];
    expect(last.stats[0], "un choc au-dessus de SAFE_SPEED").toBeGreaterThan(0);
    const rust = runRust(CRASHES[name], 11);
    expect(firstDifference(rust, ts.samples)).toBeNull();
    expect(rust[rust.length - 1].stats[7], "pas porté, côté Rust").toBe(0);
    const [collisions, , destroyed, links, killed, released, removed, , draws] = last.stats;
    seen.destroyed += destroyed;
    seen.links += links;
    seen.killed += killed;
    seen.released += released;
    seen.removed += removed;
    seen.shielded += ts.counts.shieldHit ?? 0;
    seen.split += last.bots.filter((b) => b.parts.length > 1).length;
    if (process.env.SIM_REPORT) {
      const parts = last.bots.map((b) => b.parts.length).join(" et ");
      console.log(
        `${name} : ${collisions} chocs, ${destroyed} blocs détruits, ${links} liaisons rompues, ${parts} morceaux, ${killed} hors de combat,`
          + ` ${released} roues arrachées (${removed} retirées), ${ts.counts.shieldHit ?? 0} coups amortis par un bouclier, ${last.debris.length} débris à la fin, ${draws} tirages`,
      );
    }
  });

  it("les chocs ont détruit des blocs, rompu des liaisons, séparé des morceaux, mis un robot hors de combat, arraché des roues ; un bouclier en a amorti", () => {
    expect(seen.destroyed).toBeGreaterThan(0);
    expect(seen.links).toBeGreaterThan(0);
    expect(seen.split).toBeGreaterThan(0);
    expect(seen.killed).toBeGreaterThan(0);
    expect(seen.released).toBeGreaterThan(0);
    expect(seen.removed).toBeGreaterThan(0);
    expect(seen.shielded).toBeGreaterThan(0);
  });

  // Ce que les accessoires ont fait, sur tous leurs parcours (côté TypeScript)
  const props = { crates: 0, exploded: 0, chain: 0, vented: 0, fires: 0, batteries: 0, woodFires: 0, felled: 0, struck: 0, released: 0 };
  /** Un relevé d'accessoire : `état` (2 : une fuite), `laisse passer` (voir FIELDS_PROP). */
  const STATE = FIELDS_PROP.indexOf("état");
  const YIELDING = FIELDS_PROP.indexOf("laisse passer");
  it.each(Object.keys(PROP_RUNS))("%s : mêmes accessoires, mêmes dégâts", (name) => {
    const ts = runTs(PROP_RUNS[name], 13);
    expect(ts.unported, "pas porté, côté TypeScript").toEqual([]);
    const rust = runRust(PROP_RUNS[name], 13);
    expect(firstDifference(rust, ts.samples)).toBeNull();
    expect(rust[rust.length - 1].stats[7], "pas porté, côté Rust").toBe(0);
    const last = ts.samples[ts.samples.length - 1];
    const [explosions, removed, released, fires, , woodFires] = last.stats.slice(9);
    const sampled = ts.samples.flatMap((s) => s.props);
    props.crates += ts.counts["removed:crate"] ?? 0;
    props.exploded += explosions;
    props.chain += explosions > 1 ? 1 : 0;
    props.vented += sampled.some((p) => p[STATE] === 2) ? 1 : 0;
    props.fires += fires;
    props.batteries += ts.counts.battery ?? 0;
    props.woodFires += woodFires;
    props.felled += sampled.some((p) => p[YIELDING] > 0) ? 1 : 0;
    props.struck += ts.counts.struck ?? 0;
    props.released += released;
    if (process.env.SIM_REPORT) {
      const [collisions, , destroyed, links, killed] = last.stats;
      console.log(
        `${name} : ${collisions} chocs, ${destroyed} blocs détruits, ${links} liaisons rompues, ${killed} hors de combat ; ${explosions} explosions,`
          + ` ${removed} accessoires retirés, ${released} libérés, ${fires} blocs allumés (${ts.counts.battery ?? 0} batteries détruites),`
          + ` ${woodFires} événements du feu du bois, ${ts.counts.shieldHit ?? 0} coups amortis par un bouclier,`
          + ` ${last.debris.length} débris à la fin, ${last.stats[8]} tirages`,
      );
    }
  });

  it("les accessoires ont cédé : caisses brisées, barils en chaîne, bouteille qui fuit, blocs, batteries et bois en feu, arbre abattu, mur percé, toit tombé", () => {
    // (ce qui n'est arrivé dans aucun parcours)
    expect(Object.entries(props).filter(([, n]) => !(n > 0)).map(([what]) => what)).toEqual([]);
  });

  // Ce que la réparation et les flaques de feu ont fait, sur tous leurs parcours (côté TypeScript)
  const mended = {
    rebuilt: 0, rejoined: 0, repaired: 0, wheels: 0, lostLeft: 0, blockedCells: 0, puddles: 0, puddlesOut: 0, ownerInside: 0,
    merged: 0, air: 0, full: 0, drowned: 0, woodLit: 0, wheelsBurnt: 0, killed: 0,
  };
  const BURN = FIELDS_PROP.indexOf("feu");
  const repairCase = (name: string, run: Run, seed: number): void => {
    const ts = runTs(run, seed);
    expect(ts.unported, "pas porté, côté TypeScript").toEqual([]);
    const rust = runRust(run, seed);
    expect(firstDifference(rust, ts.samples)).toBeNull();
    expect(rust[rust.length - 1].stats[7], "pas porté, côté Rust").toBe(0);
    const last = ts.samples[ts.samples.length - 1];
    const c = ts.counts;
    mended.rebuilt += c.blockRebuilt ?? 0;
    mended.rejoined += c.rejoined ?? 0;
    mended.repaired += c.blockRepaired ?? 0;
    mended.wheels += c.wheelRepaired ?? 0;
    mended.lostLeft += (c.blockRebuilt ?? 0) > 0 ? c.lostLeft : 0;
    mended.blockedCells += c.blockedCells;
    mended.puddles += c.groundFireAdded ?? 0;
    mended.puddlesOut += c.groundFireRemoved ?? 0;
    mended.ownerInside += c.ownerInside ?? 0;
    mended.merged += c.merged ?? 0;
    mended.air += c.air ?? 0;
    mended.full += c.full ?? 0;
    mended.drowned += c.drowned ?? 0;
    mended.woodLit += ts.samples.some((s) => s.props.some((p) => p[BURN] > 0)) ? 1 : 0;
    mended.killed += c.botKilled ?? 0;
    mended.wheelsBurnt += c.wheelBurnt ?? 0;
    if (process.env.SIM_REPORT) {
      const [collisions, , destroyed, links, killed] = last.stats;
      console.log(
        `${name} : ${collisions} chocs, ${destroyed} blocs détruits, ${links} liaisons rompues, ${killed} hors de combat, ${c.fireStarted ?? 0} blocs allumés ;`
          + ` ${c.blockRebuilt ?? 0} blocs repoussés (dont ${c.rejoined ?? 0} revenus d'un morceau détaché), ${c.blockRepaired ?? 0} réparations de blocs,`
          + ` ${c.wheelRepaired ?? 0} de roues, ${c.lostLeft} blocs encore perdus (${c.blockedCells} à portée, la case prise) ;`
          + ` ${c.groundFireAdded ?? 0} flaques allumées (${c.merged ?? 0} ravivées,`
          + ` ${c.full ?? 0} refusées faute de place, ${c.drowned ?? 0} sous l'eau, ${c.air ?? 0} sans sol), ${c.ownerInside ?? 0} blocs dans la flaque de`
          + ` leur auteur ; ${last.debris.length} débris à la fin, ${last.stats[8]} tirages`,
      );
    }
  };
  it.each(Object.keys(REPAIRS))("%s : mêmes chocs, mêmes réparations", (name) => repairCase(name, REPAIRS[name], 11));
  it.each(Object.keys(FIRES))("%s : mêmes flaques, mêmes feux, mêmes réparations", (name) => repairCase(name, FIRES[name], 11));

  it("la réparation a refait des blocs et des roues, fait repousser des blocs (dont des blocs restés sur un morceau détaché), en a laissé ; les flaques ont brûlé, se sont éteintes, ravivées, refusées", () => {
    // (ce qui n'est arrivé dans aucun parcours)
    expect(Object.entries(mended).filter(([, n]) => !(n > 0)).map(([what]) => what)).toEqual([]);
  });

  it("la comparaison voit un écart d'un micromètre sur un robot qui se répare, ou sur une flaque", () => {
    const repair = REPAIRS["mécanicien contre le mur, puis la réparation"];
    const ts = runTs(repair, 11);
    expect(firstDifference(runRust(repair, 11), ts.samples)).toBeNull();
    expect(firstDifference(runRust(repair, 11, { bot: 1e-6 }), ts.samples)).not.toBeNull();
    for (const name of ["napalm près du mécanicien", "jets de flammes sous des robots, contre des caisses, en nombre"]) {
      const run = FIRES[name];
      const fire = runTs(run, 11);
      expect(firstDifference(runRust(run, 11), fire.samples), name).toBeNull();
      expect(firstDifference(runRust(run, 11, { act: 1e-6 }), fire.samples), name).not.toBeNull();
    }
  });

  it("la comparaison voit un écart d'un micromètre sur un accessoire ou sur le robot qui le heurte", () => {
    for (const name of ["char contre un baril près d'un sapin", "bélier contre un sapin"]) {
      const run = PROP_RUNS[name];
      const ts = runTs(run, 13);
      expect(firstDifference(runRust(run, 13), ts.samples), name).toBeNull();
      expect(firstDifference(runRust(run, 13, { bot: 1e-6 }), ts.samples), name).not.toBeNull();
      expect(firstDifference(runRust(run, 13, { prop: 1e-6 }), ts.samples), name).not.toBeNull();
    }
  });

  it("la comparaison voit un écart d'un micromètre (le départ du robot décalé, côté Rust seulement)", () => {
    const run = CRASHES["mille-pattes contre le mur"];
    const ts = runTs(run, 11);
    expect(firstDifference(runRust(run, 11), ts.samples)).toBeNull();
    expect(firstDifference(runRust(run, 11, { bot: 1e-6 }), ts.samples)).not.toBeNull();
    // (et une autre graine : d'autres débris)
    expect(firstDifference(runRust(run, 12), ts.samples)).not.toBeNull();
  });

  // L'IA qui conduit, hors combat : chacun des robots portés patrouille seul au Dépôt (sans ses
  // accessoires), puis des équipes dans chacune des petites arènes
  const minds = {
    wander: 0, corner: 0, platform: 0, reverse: 0, unstick: 0, flee: 0, charge: 0, flipped: 0, spotted: 0, hidden: 0, collisions: 0, explosions: 0,
  };
  const aiCase = (name: string, run: Run, seed: number): void => {
    const ts = runTs(run, seed);
    expect(ts.unported, "pas porté, côté TypeScript").toEqual([]);
    const rust = runRust(run, seed);
    expect(firstDifference(rust, ts.samples)).toBeNull();
    expect(rust[rust.length - 1].stats[7], "pas porté, côté Rust").toBe(0);
    const c = ts.counts;
    const last = ts.samples[ts.samples.length - 1];
    minds.wander += c.wander ?? 0;
    minds.corner += c.corner ?? 0;
    minds.platform += c.platform ?? 0;
    minds.reverse += c["mode:reverse"] ?? 0;
    minds.unstick += c.unstick ?? 0;
    minds.flee += c["mode:flee"] ?? 0;
    minds.charge += c["mode:charge"] ?? 0;
    minds.flipped += c["mode:flipped"] ?? 0;
    minds.spotted += c.spotted ?? 0;
    minds.hidden += c.hidden ?? 0;
    minds.collisions += last.stats[0];
    minds.explosions += last.stats[9];
    if (process.env.SIM_REPORT) {
      const modes = Object.entries(c).filter(([k]) => k.startsWith("mode:")).map(([k, n]) => `${k.slice(5)} ${n}`).join(", ");
      console.log(
        `${name} : ${c.wander ?? 0} destinations de patrouille, ${c.corner ?? 0} relevés vers un coin ou une rampe, ${c.platform ?? 0} pas sur une plateforme,`
          + ` ${c.unstick ?? 0} bonds pour se dégager ; modes : ${modes || "aucun changement"} ; ${c.spotted ?? 0} ennemis repérés, ${c.hidden ?? 0} cachés ;`
          + ` ${last.stats[0]} chocs, ${last.stats[2]} blocs détruits, ${last.stats[9]} explosions ; ${last.stats[8]} tirages`,
      );
    }
  };
  it.each(PORTED)("%s patrouille seul au Dépôt : mêmes destinations, même chemin", (id) => {
    aiCase(`${id} seul`, { bots: [{ id, x: 0, z: -27, yaw: 0, ai: "red" }], phases: [{ seconds: 25, throttle: 0, steer: 0 }] }, 7);
  });
  // (une minute de huit robots : plus d'une minute de calcul sur une machine chargée)
  it.each(Object.keys(AI_RUNS))("%s : même IA, même détection, mêmes chocs", { timeout: 300_000 }, (name) => aiCase(name, AI_RUNS[name], 7));

  it("l'IA a patrouillé, contourné, pris les rampes, reculé, bondi, fui, foncé ; les équipes se sont repérées et cachées", () => {
    // (ce qui n'est arrivé dans aucun parcours)
    expect(Object.entries(minds).filter(([, n]) => !(n > 0)).map(([what]) => what)).toEqual([]);
  });

  it("la comparaison voit un écart d'un micromètre sur un robot de l'IA, ou une autre graine", { timeout: 300_000 }, () => {
    const run: Run = { ...AI_RUNS["dépôt, quatre contre quatre"], phases: [{ seconds: 20, throttle: 0, steer: 0 }] };
    const ts = runTs(run, 7);
    expect(firstDifference(runRust(run, 7), ts.samples)).toBeNull();
    expect(firstDifference(runRust(run, 7, { bot: 1e-6 }), ts.samples)).not.toBeNull();
    // (une autre graine : d'autres destinations)
    expect(firstDifference(runRust(run, 8), ts.samples)).not.toBeNull();
  });

  // (la machine peut être chargée : chaque mesure est refaite, en alternant, et on garde la meilleure)
  it.runIf(process.env.SIM_REPORT)("coût d'un pas (indicatif)", { timeout: 600_000 }, () => {
    const steps = 600;
    const ms = (n: number): string => n.toFixed(3);
    const report = (
      label: string, starts: readonly Start[], drive: (inputs: PlayerInput[]) => void, rustDrive: (sim: number, bots: number[]) => void,
      arrangement?: PropRun["props"], act?: Act, arena?: SmallArena,
    ): void => {
      const best = { whole: Infinity, same: Infinity, rust: Infinity, ai: Infinity, driving: Infinity, rays: Infinity };
      // (avec des accessoires, même aucun, le Rust fait aussi les feux, les flaques, la réparation et
      // les accessoires : « feu, fumée, réparation » et « accessoires, débris » du TypeScript)
      // (et la détection, que le Rust fait à chaque pas : de l'IA comme des pilotes)
      const stages = ["détection", "ia", "roues", "physique", "chocs", ...(arrangement ? ["feu, fumée, réparation", "accessoires, débris"] : [])];
      for (let run = 0; run < 4; run++) {
        // Le pas entier du TypeScript (il fait aussi tout le reste), et ses étapes « ia », « roues »,
        // « physique » et « chocs », ce que fait celui du Rust
        seedRandom(3);
        const { sim, bots } = tsWorld({ arena, bots: starts, props: arrangement });
        drive(bots.map((b) => b.input));
        for (let i = 0; i < 60; i++) sim.step();
        if (act) actTs(sim, bots, act, {});
        sim.profile = { now: () => performance.now(), times: {} };
        const t0 = performance.now();
        for (let i = 0; i < steps; i++) sim.step();
        best.whole = Math.min(best.whole, (performance.now() - t0) / steps);
        const times = sim.profile.times;
        best.same = Math.min(best.same, stages.reduce((s, stage) => s + (times[stage] ?? 0), 0) / steps);
        // (l'étape « ia », et ce qu'y coûtent la conduite de l'IA et ses rayons d'évitement)
        best.ai = Math.min(best.ai, (times.ia ?? 0) / steps);
        best.driving = Math.min(best.driving, (times["ia › conduite"] ?? 0) / steps);
        best.rays = Math.min(best.rays, (times["ia › rayons"] ?? 0) / steps);
        sim.dispose();
        const rs = rustWorld({ arena, props: arrangement }, 3);
        const rbots = starts.map((s) => rustBot(rs, s));
        rustDrive(rs, rbots);
        probe.sim_step(rs, 60);
        if (act) actRust(rs, rbots, act, 0);
        const t1 = performance.now();
        probe.sim_step(rs, steps);
        best.rust = Math.min(best.rust, (performance.now() - t1) / steps);
        probe.sim_free(rs);
      }
      const ai = best.driving > 0 ? `, dont « ia » ${ms(best.ai)} ms (sa conduite ${ms(best.driving)} ms, ses rayons ${ms(best.rays)} ms)` : "";
      console.log(
        `${label} : un pas du TypeScript ${ms(best.whole)} ms (${stages.join(", ")} : ${ms(best.same)} ms${ai}),`
          + ` du Rust ${ms(best.rust)} ms (${(best.same / best.rust).toFixed(1)} fois moins) ; sonde ${PROBE}`,
      );
    };
    const start = SCENARIOS.allée.start;
    for (const id of ["scarab", "tank", "truck"]) {
      report(`${id} qui roule`, [{ id, ...start }], ([input]) => {
        input.throttle = 0.4;
        input.steer = 0.5;
      }, (sim, [bot]) => probe.sim_control(sim, bot, 0.4, 0.5, 0, 0));
    }
    // Un choc : le mille-pattes lancé contre le mur (il s'y brise dans les 600 pas mesurés)
    const crash = CRASHES["mille-pattes contre le mur"].bots;
    report("mille-pattes contre le mur", crash, ([input]) => {
      input.throttle = 1;
      input.boost = true;
    }, (sim, [bot]) => probe.sim_control(sim, bot, 1, 0, 0, 1));
    // Les accessoires : le Dépôt et les siens, le char lancé contre un baril (une explosion, des
    // blocs en feu pendant les 600 pas mesurés) ; puis le baril coincé contre le mur entre des caisses
    const rush = ([input]: PlayerInput[]): void => {
      input.throttle = 1;
      input.boost = true;
    };
    const rustRush = (sim: number, [bot]: number[]): void => probe.sim_control(sim, bot, 1, 0, 0, 1);
    for (const name of ["char contre un baril", "char contre un baril au pied du mur, entre des caisses"]) {
      const { bots, props: arrangement } = PROP_RUNS[name];
      report(name, bots, rush, rustRush, arrangement);
    }
    // La réparation : le mécanicien lancé contre le mur, qui y reste appuyé (le choc, puis le module
    // au travail pendant les 600 pas mesurés) ; le napalm près du camion (ses blocs en feu, la flaque,
    // puis le module)
    report("mécanicien contre le mur, puis la réparation", REPAIRS["mécanicien contre le mur, puis la réparation"].bots, rush, rustRush, []);
    const napalm = FIRES["napalm près du camion"];
    report("napalm près du camion", napalm.bots, () => {}, () => {}, [], napalm.phases[1].act);
    // L'IA qui conduit : quatre contre quatre au Dépôt, avec ses accessoires (l'étape « ia » du
    // TypeScript est alors sa conduite, ses rayons et sa navigation), puis douze robots
    const depot = AI_RUNS["dépôt, quatre contre quatre"];
    report("l'IA, quatre contre quatre au Dépôt", depot.bots, () => {}, () => {}, "arena");
    const twelve = [...line("red", ["tank", "trike", "scarab", "stilt", "centi", "lancer"]), ...line("blue", ["buggy", "truck", "tracker", "ram", "scout", "sapper"])];
    report("l'IA, six contre six au Dépôt", twelve, () => {}, () => {}, "arena");
  });
});
