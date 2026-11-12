import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ARENAS, type PropSpot } from "../src/shared/arena/layout";
import { resetProps } from "../src/shared/arena/props";
import { blockDef } from "../src/shared/catalog/blocks";
import { propHalf, type PropType } from "../src/shared/catalog/props";
import { SHAPE_IDS, shapePieces } from "../src/shared/catalog/shapes";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { vec3, type Vec3 } from "../src/shared/math/vec";
import { groundHeight, spawnBot } from "../src/shared/robot/lifecycle";
import type { Block, Bot, Prop } from "../src/shared/sim/entities";
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
 * de chaque accessoire (présent ou non, pose, vitesse, points de structure, état, feu…). Le pas du
 * TypeScript fait bien d'autres choses (détection, air, armes, réparations) : le test vérifie, par
 * ses événements, qu'aucune d'elles n'est intervenue côté TypeScript, et que rien de ce que le Rust
 * ne sait pas encore faire ne serait arrivé de son côté (`unported`).
 * `SIM_REPORT=1` : le coût d'un pas, ici et là.
 */

// (une sonde d'avant les accessoires n'a pas `sim_add_prop`, et relève moins de choses : sautée)
const PROBE = probePath("sim_add_prop");

interface SimProbe {
  memory: { buffer: ArrayBuffer };
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  sim_new(): number;
  sim_free(id: number): void;
  sim_seed(id: number, seed: number): void;
  sim_add_box(id: number, x: number, y: number, z: number, hx: number, hy: number, hz: number, qx: number, qy: number, qz: number, qw: number, round: number): void;
  sim_add_prop(
    id: number, name: number, len: number, x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number, hx: number, hy: number, hz: number, scale: number,
  ): number;
  sim_prop_rest(id: number, prop: number, on: number): void;
  sim_prop_count(id: number): number;
  sim_prop_state(id: number, i: number, out: number): void;
  sim_spawn(id: number, name: number, len: number, x: number, y: number, z: number, yaw: number): number;
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
}

/** Des commandes tenues `seconds` s. */
interface Phase {
  seconds: number;
  throttle: number;
  steer: number;
  brake?: number;
  boost?: boolean;
}

/** D'où part un robot (tourné de `yaw`) ; `still` : il reste arrêté, sans commandes. */
interface Start {
  id: string;
  x: number;
  z: number;
  yaw: number;
  still?: boolean;
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
 * épaves retirées au bout de 30 s, des dégâts amortis par le bouclier du Rempart). Aucune batterie n'y
 * est détruite (elle allumerait ses voisins : le feu n'est pas porté), et aucun de ces robots n'a de
 * module de réparation (pas porté non plus).
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

/** Des accessoires heurtés : ceux du Dépôt (`depot`), ou ceux d'un petit agencement posé pour l'essai, sur le sol du Dépôt. */
interface PropRun {
  bots: readonly Start[];
  phases: readonly Phase[];
  props: "depot" | readonly PropSpot[];
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
  "bélier contre les caisses": { bots: [{ id: "ram", x: 20, z: -4, yaw: -Math.PI / 2 }], phases: RUSH, props: "depot" },
  "scarabée qui pousse une caisse": { bots: [{ id: "scarab", x: -20, z: 13, yaw: 0 }], phases: NUDGE, props: "depot" },
  "char contre un baril": { bots: [{ id: "tank", x: 1.5, z: -4, yaw: 0 }], phases: RUSH_AND_BURN, props: "depot" },
  // (son bouclier amortit une part de l'explosion)
  "rempart contre un baril": { bots: [{ id: "bulwark", x: 1.5, z: -4, yaw: 0 }], phases: RUSH_AND_BURN, props: "depot" },
  // (en marche arrière : ses batteries, à l'arrière, détruites par l'explosion, allument leurs voisines)
  "lancier à reculons contre un baril au pied du mur": {
    bots: [{ id: "lancer", x: 0, z: -22, yaw: 0 }],
    phases: [{ seconds: 1, throttle: 0, steer: 0 }, { seconds: 8, throttle: -1, steer: 0, boost: true }, { seconds: 6, throttle: 0, steer: 0 }],
    props: [spot("barrel", 0, -35.1)],
  },
  "bélier contre les barils du pilier": { bots: [{ id: "ram", x: 9.6, z: -2, yaw: 0 }], phases: RUSH_AND_BURN, props: "depot" },
  "buggy contre une bouteille de gaz": { bots: [{ id: "buggy", x: 4, z: -18, yaw: 0 }], phases: RUSH_AND_BURN, props: "depot" },
  "mille-pattes contre la bouteille et les caisses": { bots: [{ id: "centi", x: -5.5, z: -6, yaw: 0 }], phases: RUSH_AND_BURN, props: "depot" },
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

/** Les événements du TypeScript que la simulation portée sait produire ; un autre : quelque chose de pas porté. */
const PORTED_EVENTS = new Set<SimEvent["type"]>([
  "botAdded", "partAdded", "partRemoved", "wheelAdded", "wheelRemoved", "blockAttached", "blockDamaged", "blockDestroyed",
  "botKilled", "collision", "damage", "debrisAdded", "debrisRemoved", "linkBroken", "shieldHit",
  "propAdded", "propRemoved", "propReleased", "propFire", "explosion", "fireStarted", "fireEnded",
]);

/** L'état d'un robot relevé chaque seconde : ses morceaux, ses roues, ses blocs, ses liaisons rompues. */
interface BotSample {
  parts: number[][];
  wheels: number[][];
  blocks: number[];
  cuts: number;
}

/** Les robots, les débris, les accessoires (par emplacement), et ce qui s'est passé (comme `sim_stats`). */
interface Sample {
  bots: BotSample[];
  debris: number[][];
  props: number[][];
  stats: number[];
}

const FIELDS_BODY = ["x", "y", "z", "qx", "qy", "qz", "qw", "vx", "vy", "vz", "wx", "wy", "wz"];
const FIELDS_WHEEL = ["x", "y", "z", "qx", "qy", "qz", "qw", "steer", "travel", "spin", "spinRate", "load", "drive", "hp", "où"];
const FIELDS_BLOCK = ["hp", "vivant", "morceau", "feu"];
const FIELDS_PROP = [
  "présent", ...FIELDS_BODY, "ancré", "hp", "état", "reste", "fuite x", "fuite z", "feu", "noirci", "laisse passer", "éclats x", "éclats y", "éclats z",
];
const FIELDS_STATS = [
  "chocs", "lots de dégâts", "blocs détruits", "liaisons rompues", "robots hors de combat", "roues arrachées", "roues retirées", "pas porté", "tirages",
  "explosions", "accessoires retirés", "accessoires libérés", "blocs allumés", "blocs éteints", "feu des accessoires",
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
 * Des robots dans une Simulation du TypeScript (avec le décor du Dépôt), aux commandes d'un pilote ;
 * et des accessoires (ceux du Dépôt, ou d'un agencement d'essai), créés avant les robots, comme le
 * fait le jeu (`loadArena`, `spawnWave`). `props` : tous ceux qui ont été créés (présents ou non).
 */
function tsWorld(starts: readonly Start[], arrangement?: PropRun["props"]): { sim: Simulation; bots: TsBot[]; props: Prop[] } {
  const sim = new Simulation();
  if (arrangement) {
    if (arrangement !== "depot") sim.arena = { ...ARENAS.depot, props: arrangement };
    resetProps(sim);
  }
  const props = [...sim.props];
  const bots = starts.map((s) => {
    const bot = spawnBot(sim, profileOf(s.id), vec3(s.x, startHeight(s.id), s.z), s.yaw);
    sim.bots.push(bot);
    const input = newInput();
    takeControl(bot, input);
    return { bot, input, blocks: [...bot.blocks.values()] };
  });
  return { sim, bots, props };
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
        blocks: blocks.flatMap((b) => [b.hp, b.alive ? 1 : 0, b.alive ? parts.indexOf(b.part) : -1, b.burn]),
        cuts: bot.cuts.size,
      };
    }),
    debris: sim.debris.map((d) => bodyState(d.rb)),
    props: props.map((p) => propState(sim, p)),
    stats: [
      counts.collision ?? 0, counts.damage ?? 0, counts.blockDestroyed ?? 0, counts.linkBroken ?? 0, counts.botKilled ?? 0,
      // (une roue arrachée n'a pas d'événement : celles qui ont un corps, ou n'en ont plus)
      bots.reduce((s, { bot }) => s + bot.wheels.filter((w) => !w.part).length, 0),
      counts.wheelRemoved ?? 0, 0, draws,
      counts.explosion ?? 0, counts.propRemoved ?? 0, counts.propReleased ?? 0, counts.fireStarted ?? 0, counts.fireEnded ?? 0, counts.propFire ?? 0,
    ],
  };
}

/** Des robots (et des accessoires) dans la simulation du TypeScript, chaque seconde ; et les événements qui n'y sont pas portés. */
function runTs(
  starts: readonly Start[], phases: readonly Phase[], seed: number, arrangement?: PropRun["props"],
): { samples: Sample[]; unported: string[]; counts: Record<string, number> } {
  seedRandom(seed);
  const random = vi.mocked(Math.random);
  const drawn = random.mock.calls.length;
  const { sim, bots, props } = tsWorld(starts, arrangement);
  const counts: Record<string, number> = {};
  const unported = new Set<string>();
  sim.on((e) => {
    counts[e.type] = (counts[e.type] ?? 0) + 1;
    if (e.type === "propRemoved") {
      counts[`removed:${e.prop.type}`] = (counts[`removed:${e.prop.type}`] ?? 0) + 1;
      // (brisé par un robot qui passe au travers : ses éclats sont partis devant lui)
      if (e.prop.struck) counts.struck = (counts.struck ?? 0) + 1;
    }
    // (une batterie détruite met le feu à ses voisins)
    if (e.type === "blockDestroyed" && blockDef(e.block.type).battery) counts.battery = (counts.battery ?? 0) + 1;
    if (!PORTED_EVENTS.has(e.type)) unported.add(e.type);
  });
  const samples: Sample[] = [];
  for (const phase of phases) {
    for (const [i, { input }] of bots.entries()) {
      if (starts[i].still) continue;
      input.throttle = phase.throttle;
      input.steer = phase.steer;
      input.brake = phase.brake ?? 0;
      input.boost = phase.boost ?? false;
    }
    for (let s = 0; s < phase.seconds; s++) {
      for (let i = 0; i < 60; i++) sim.step();
      samples.push(tsSample(sim, bots, props, counts, random.mock.calls.length - drawn));
    }
  }
  sim.dispose();
  return { samples, unported: [...unported], counts };
}

/**
 * Un monde de la simulation portée, avec le décor du Dépôt (l'arène d'une Simulation neuve), dans le
 * même ordre, et des accessoires ; `propShift` : un décalage du premier accessoire (m, en x).
 */
function rustWorld(seed = 0, arrangement?: PropRun["props"], propShift = 0): number {
  const sim = probe.sim_new();
  probe.sim_seed(sim, seed);
  for (const b of ARENAS.depot.boxes) {
    if (b.kind === "rock") throw new Error("un rocher : pas encore porté");
    probe.sim_add_box(sim, b.pos.x, b.pos.y, b.pos.z, b.half.x, b.half.y, b.half.z, b.rot.x, b.rot.y, b.rot.z, b.rot.w, b.round ? 1 : 0);
  }
  const spots = arrangement === "depot" ? ARENAS.depot.props : arrangement ?? [];
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
  const bot = withText(s.id, (ptr, len) => probe.sim_spawn(sim, ptr, len, s.x, startHeight(s.id), s.z, s.yaw));
  if (bot < 0) throw new Error(lastError());
  return bot;
}

/** Taille du tampon des relevés (en nombres de 8 octets). */
const OUT = 32;

/** L'état du monde de la simulation portée. */
function rustSample(sim: number, bots: number[], out: number): Sample {
  const read = (n: number): number[] => Array.from(new Float64Array(probe.memory.buffer, out, n));
  const sample: Sample = { bots: [], debris: [], props: [], stats: [] };
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
    sample.bots.push({ parts, wheels, blocks, cuts: probe.sim_cut_count(sim, bot) });
  }
  for (let i = 0; i < probe.sim_debris_count(sim); i++) {
    probe.sim_debris_state(sim, i, out);
    sample.debris.push(read(13));
  }
  for (let i = 0; i < probe.sim_prop_count(sim); i++) {
    probe.sim_prop_state(sim, i, out);
    sample.props.push(read(FIELDS_PROP.length));
  }
  probe.sim_stats(sim, out);
  sample.stats = read(FIELDS_STATS.length);
  return sample;
}

/**
 * Les mêmes robots (et accessoires) dans la simulation portée ; `shift` : un décalage du départ du
 * premier robot (m, en x) ; `propShift` : du premier accessoire.
 */
function runRust(starts: readonly Start[], phases: readonly Phase[], seed: number, shift = 0, arrangement?: PropRun["props"], propShift = 0): Sample[] {
  const sim = rustWorld(seed, arrangement, propShift);
  const out = probe.alloc(OUT * 8);
  try {
    const bots = starts.map((s, i) => rustBot(sim, i === 0 ? { ...s, x: s.x + shift } : s));
    const samples: Sample[] = [];
    for (const phase of phases) {
      for (const [i, bot] of bots.entries()) {
        if (!starts[i].still) probe.sim_control(sim, bot, phase.throttle, phase.steer, phase.brake ?? 0, phase.boost ? 1 : 0);
      }
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
    const starts = [{ id, ...start }];
    const ts = runTs(starts, phases, 5);
    expect(ts.unported, "pas porté, côté TypeScript").toEqual([]);
    const last = ts.samples[ts.samples.length - 1];
    expect(last.stats[0], "le robot du TypeScript a heurté quelque chose").toBe(0);
    const rust = runRust(starts, phases, 5);
    expect(rust.length).toBe(phases.reduce((s, p) => s + p.seconds, 0));
    expect(firstDifference(rust, ts.samples)).toBeNull();
    // (il a bien roulé : à plus d'un mètre de son départ, à un moment ; cinq, sauf contre le mur)
    const far = Math.max(...rust.map((s) => Math.hypot(s.bots[0].parts[0][0] - start.x, s.bots[0].parts[0][2] - start.z)));
    expect(far).toBeGreaterThan(name === "mur" ? 1 : 5);
  });

  // Ce que les chocs ont fait, sur tous les parcours (côté TypeScript) : chaque sorte de dégât arrive
  const seen = { destroyed: 0, links: 0, split: 0, killed: 0, released: 0, removed: 0, shielded: 0 };
  it.each(Object.keys(CRASHES))("%s : mêmes chocs, mêmes dégâts", (name) => {
    const { bots, phases } = CRASHES[name];
    const ts = runTs(bots, phases, 11);
    expect(ts.unported, "pas porté, côté TypeScript").toEqual([]);
    const last = ts.samples[ts.samples.length - 1];
    expect(last.stats[0], "un choc au-dessus de SAFE_SPEED").toBeGreaterThan(0);
    const rust = runRust(bots, phases, 11);
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
    const { bots, phases, props: arrangement } = PROP_RUNS[name];
    const ts = runTs(bots, phases, 13, arrangement);
    expect(ts.unported, "pas porté, côté TypeScript").toEqual([]);
    const rust = runRust(bots, phases, 13, 0, arrangement);
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

  it("la comparaison voit un écart d'un micromètre sur un accessoire ou sur le robot qui le heurte", () => {
    for (const name of ["char contre un baril près d'un sapin", "bélier contre un sapin"]) {
      const { bots, phases, props: arrangement } = PROP_RUNS[name];
      const ts = runTs(bots, phases, 13, arrangement);
      expect(firstDifference(runRust(bots, phases, 13, 0, arrangement), ts.samples), name).toBeNull();
      expect(firstDifference(runRust(bots, phases, 13, 1e-6, arrangement), ts.samples), name).not.toBeNull();
      expect(firstDifference(runRust(bots, phases, 13, 0, arrangement, 1e-6), ts.samples), name).not.toBeNull();
    }
  });

  it("la comparaison voit un écart d'un micromètre (le départ du robot décalé, côté Rust seulement)", () => {
    const { bots, phases } = CRASHES["mille-pattes contre le mur"];
    const ts = runTs(bots, phases, 11);
    expect(firstDifference(runRust(bots, phases, 11), ts.samples)).toBeNull();
    expect(firstDifference(runRust(bots, phases, 11, 1e-6), ts.samples)).not.toBeNull();
    // (et une autre graine : d'autres débris)
    expect(firstDifference(runRust(bots, phases, 12), ts.samples)).not.toBeNull();
  });

  // (la machine peut être chargée : chaque mesure est refaite, en alternant, et on garde la meilleure)
  it.runIf(process.env.SIM_REPORT)("coût d'un pas (indicatif)", { timeout: 600_000 }, () => {
    const steps = 600;
    const ms = (n: number): string => n.toFixed(3);
    const report = (
      label: string, starts: readonly Start[], drive: (inputs: PlayerInput[]) => void, rustDrive: (sim: number, bots: number[]) => void,
      arrangement?: PropRun["props"],
    ): void => {
      const best = { whole: Infinity, same: Infinity, rust: Infinity };
      // (avec des accessoires, le Rust fait aussi les feux et les accessoires : « feu, fumée,
      // réparation » et « accessoires, débris » du TypeScript)
      const stages = ["ia", "roues", "physique", "chocs", ...(arrangement ? ["feu, fumée, réparation", "accessoires, débris"] : [])];
      for (let run = 0; run < 4; run++) {
        // Le pas entier du TypeScript (il fait aussi tout le reste), et ses étapes « ia », « roues »,
        // « physique » et « chocs », ce que fait celui du Rust
        seedRandom(3);
        const { sim, bots } = tsWorld(starts, arrangement);
        drive(bots.map((b) => b.input));
        for (let i = 0; i < 60; i++) sim.step();
        sim.profile = { now: () => performance.now(), times: {} };
        const t0 = performance.now();
        for (let i = 0; i < steps; i++) sim.step();
        best.whole = Math.min(best.whole, (performance.now() - t0) / steps);
        const times = sim.profile.times;
        best.same = Math.min(best.same, stages.reduce((s, stage) => s + (times[stage] ?? 0), 0) / steps);
        sim.dispose();
        const rs = rustWorld(3, arrangement);
        const rbots = starts.map((s) => rustBot(rs, s));
        rustDrive(rs, rbots);
        probe.sim_step(rs, 60);
        const t1 = performance.now();
        probe.sim_step(rs, steps);
        best.rust = Math.min(best.rust, (performance.now() - t1) / steps);
        probe.sim_free(rs);
      }
      console.log(
        `${label} : un pas du TypeScript ${ms(best.whole)} ms (${stages.join(", ")} : ${ms(best.same)} ms),`
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
  });
});
