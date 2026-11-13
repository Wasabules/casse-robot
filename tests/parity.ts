import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARENA_IDS, type ArenaKey } from "../src/shared/arena/layout";
import { BLOCK_TYPES, blockDef, type BlockType } from "../src/shared/catalog/blocks";
import { MELEE_IDS, meleeDef, wielded, type ArmId } from "../src/shared/catalog/melee";
import { WEAPON_IDS, type WeaponId } from "../src/shared/catalog/weapons";
import { WHEEL_TYPES, wheelDef, type WheelType } from "../src/shared/catalog/wheels";
import { STEP } from "../src/shared/config";
import { profileFromDesign } from "../src/shared/design/custom";
import { PRESET_BOTS, type BotProfile } from "../src/shared/design/presets";
import { AXES, cellKey, NEIGHBORS, validateDesign, type Axis, type Facing, type RobotDesign, type WheelMount } from "../src/shared/design/robotDesign";
import type { MapFile } from "../src/shared/map/format";
import { mapKey } from "../src/shared/map/key";
import { readMapText } from "../src/shared/map/read";
import type { Vec3 } from "../src/shared/math/vec";
import { GAME_MODES, type GameModeId } from "../src/shared/modes";
import type { SimModule } from "../src/shared/native/simModule";
import { NativeSession } from "../src/shared/native/session";
import { decodeFrame, PROTOCOL_VERSION } from "../src/shared/net/protocol";
import { readSnapshot } from "../src/shared/net/snapshot";
import { LocalSession, type SessionCommand, type SessionLike } from "../src/shared/net/session";
import { blockWorldPos } from "../src/shared/robot/queries";
import type { Team } from "../src/shared/sim/entities";
import type { MatchRules } from "../src/shared/sim/match";
import { newInput, type PlayerInput } from "../src/shared/sim/player";
import { NativeRoom } from "../src/server/nativeRoom";
import { ProgressBook } from "../src/server/progressBook";
import { Room, type Connection, type Player, type RoomBase, type RoomOptions } from "../src/server/room";

/*
 * Parité longue et aléatoire de la simulation portée en Rust contre celle du TypeScript
 * (tests/nativeParity.test.ts). Chaque cas est tiré d'une graine : une session solo (`LocalSession`
 * contre `NativeSession`) dans un mode, une arène ou une carte de maps/, avec des robots
 * préfabriqués et des robots du garage (des plans valides tirés au hasard), des commandes de pilote
 * aléatoires, des tirs de la caméra libre, des vagues, des pauses, d'autres parties ; ou une salle du
 * serveur (`Room` contre `NativeRoom`) qui enchaîne des parties courtes dans une rotation d'arènes,
 * avec des joueurs qui arrivent (robots préfabriqués ou du garage, parfois refusés) et partent. Les
 * deux simulations avancent au même pas, commande par commande ; la première image qui diffère arrête
 * le cas, qui dit le premier événement ou champ de l'instantané qui diffère, et de quoi le rejouer :
 * la graine et le rang du cas (`PARITY_SEED`, `PARITY_CASE`), et ses commandes écrites dans un
 * fichier (`artifacts/parity/`, que `PARITY_REPLAY` rejoue). Le hasard du générateur est le sien
 * (jamais `Math.random`, celui des simulations).
 */

// --- Le hasard du générateur ---

/** Un tirage à graine fixe (mulberry32), à part de celui des simulations. */
export class Draw {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Un nombre dans [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  real(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(list: readonly T[]): T {
    return list[this.int(list.length)];
  }

  /** Une graine pour un sous-tirage. */
  seed(): number {
    return Math.floor(this.next() * 4294967296);
  }
}

/** La graine du cas `k` d'une série (un cas se rejoue seul d'après elle). */
export const caseSeed = (seed: number, k: number): number => (Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) + Math.imul(k + 1, 0xc2b2ae35)) >>> 0;

// --- Robots du garage tirés au hasard ---

const FACINGS: Facing[] = (Object.keys(AXES) as Axis[]).flatMap((up) =>
  (Object.keys(AXES) as Axis[]).filter((f) => AXES[up].x * AXES[f].x + AXES[up].y * AXES[f].y + AXES[up].z * AXES[f].z === 0).map((forward) => ({ up, forward })));
const BLOCKS = (Object.keys(BLOCK_TYPES) as BlockType[]).filter((t) => t !== "cockpit");
const WHEELS = Object.keys(WHEEL_TYPES) as WheelType[];

const copy = <T>(x: T): T => structuredClone(x);

/** Une retouche d'un plan : tentée, puis gardée si le plan reste jouable (`validateDesign`). */
function mutate(d: Draw, design: RobotDesign): RobotDesign {
  const next = copy(design);
  const blocks = next.blocks;
  const occupied = new Set(blocks.map((b) => cellKey(b.x, b.y, b.z)));
  const others = blocks.filter((b) => b.type !== "cockpit");
  switch (d.int(7)) {
    case 0:
    case 1: {
      // Un bloc de plus, contre un bloc du plan
      const base = d.pick(blocks);
      const [dx, dy, dz] = d.pick(NEIGHBORS);
      const at = { x: base.x + dx, y: base.y + dy, z: base.z + dz };
      if (occupied.has(cellKey(at.x, at.y, at.z))) return design;
      const facing = d.chance(0.5) ? d.pick(FACINGS) : undefined;
      blocks.push(facing && (facing.up !== "+y" || facing.forward !== "+z") ? { ...at, type: d.pick(BLOCKS), facing } : { ...at, type: d.pick(BLOCKS) });
      break;
    }
    case 2: {
      // Un bloc retiré (et les roues qu'il portait)
      if (!others.length) return design;
      const b = d.pick(others);
      next.blocks = blocks.filter((x) => x !== b);
      next.wheels = next.wheels.filter((w) => w.x !== b.x || w.y !== b.y || w.z !== b.z);
      break;
    }
    case 3: {
      // Un bloc d'un autre type, tourné ou non
      if (!others.length) return design;
      const b = d.pick(others);
      b.type = d.pick(BLOCKS);
      if (d.chance(0.4)) b.facing = d.pick(FACINGS);
      break;
    }
    case 4:
    case 5: {
      // Une roue de plus, sur une face d'un bloc
      const b = d.pick(blocks);
      const type = d.pick(WHEELS);
      const side = d.int(5);
      const w: WheelMount = side === 4 ? { x: b.x, y: b.y, z: b.z, dx: 0, dz: 0, dy: -1, type } : {
        x: b.x, y: b.y, z: b.z, dx: side === 0 ? 1 : side === 1 ? -1 : 0, dz: side === 2 ? 1 : side === 3 ? -1 : 0, type,
      };
      if (d.chance(0.4)) w.shift = d.int(3) - 1;
      if (wheelDef(type).track && w.dx !== 0 && d.chance(0.4)) {
        w.rise = d.int(3) - 1;
        w.layer = d.int(2);
      }
      next.wheels.push(w);
      break;
    }
    case 6: {
      // Une roue retirée, ou d'un autre type
      if (!next.wheels.length) return design;
      const w = d.pick(next.wheels);
      if (d.chance(0.5)) next.wheels = next.wheels.filter((x) => x !== w);
      else {
        w.type = d.pick(WHEELS);
        delete w.rise;
        delete w.layer;
      }
      break;
    }
  }
  return validateDesign(next).length ? design : next;
}

/** Un robot du garage : un robot préfabriqué retouché, ou un plan construit bloc à bloc depuis un cockpit. */
export function garageRobot(d: Draw, name: string): BotProfile {
  let design: RobotDesign;
  let tries: number;
  if (d.chance(0.6)) {
    design = copy(d.pick(PRESET_BOTS).design);
    tries = 2 + d.int(14);
  } else {
    design = { blocks: [{ x: 0, y: 0, z: 0, type: "cockpit" }], wheels: [] };
    tries = 20 + d.int(60);
  }
  for (let i = 0; i < tries; i++) design = mutate(d, design);
  const color = `#${d.int(0x1000000).toString(16).padStart(6, "0")}`;
  return profileFromDesign(name, color, design);
}

/** Un robot : préfabriqué, ou du garage. */
function anyRobot(d: Draw, name: string): BotProfile {
  return d.chance(0.45) ? garageRobot(d, name) : d.pick(PRESET_BOTS);
}

// --- Les arènes ---

/** Les cartes communautaires livrées (maps/) : on les joue comme le jeu, avec leur fichier. */
let maps: MapFile[] | null = null;
export function communityMaps(): MapFile[] {
  if (maps) return maps;
  const dir = new URL("../maps/", import.meta.url);
  maps = readdirSync(dir).filter((f) => f.endsWith(".casse-map.json")).map((f) => {
    const read = readMapText(readFileSync(new URL(f, dir), "utf8"));
    if (!read.ok) throw new Error(`carte illisible : ${f}`);
    return read.map;
  });
  return maps;
}

/** Une arène du jeu ou une carte, avec son fichier pour une carte. */
function anyArena(d: Draw, arenas?: readonly ArenaKey[]): { arena: ArenaKey; map?: MapFile } {
  const community = communityMaps();
  const choices: { arena: ArenaKey; map?: MapFile }[] = [
    ...ARENA_IDS.map((arena) => ({ arena })),
    ...community.map((map) => ({ arena: mapKey(map) as ArenaKey, map })),
  ];
  const allowed = arenas ? choices.filter((c) => arenas.includes(c.arena)) : choices;
  return d.pick(allowed.length ? allowed : choices);
}

// --- Les commandes du pilote ---

/** Les armes d'un plan (tourelles, armes de contact maniées) : celles que le pilote choisit. */
function armsOf(design: RobotDesign): ArmId[] {
  const arms = new Set<ArmId>();
  for (const b of design.blocks) {
    const def = blockDef(b.type);
    if (def.turret) arms.add(def.turret.weapon);
    if (def.melee && wielded(meleeDef(def.melee))) arms.add(def.melee);
  }
  return [...arms];
}

/** Ce que le pilote voit : sa position, et celle des robots (ennemis d'abord), d'après le monde du TypeScript. */
interface Sight {
  me: Vec3 | null;
  foes: Vec3[];
  all: Vec3[];
}

/** Des commandes de pilote nouvelles (un segment de conduite), d'après ce qu'il voit. */
function pilotInput(d: Draw, input: PlayerInput, arms: readonly ArmId[], sight: Sight): void {
  input.throttle = d.chance(0.2) ? 0 : d.real(-1, 1);
  input.steer = d.chance(0.4) ? 0 : d.real(-1, 1);
  input.climb = d.chance(0.5) ? 0 : d.real(-1, 1);
  input.brake = d.chance(0.8) ? 0 : d.real(0, 1);
  input.boost = d.chance(0.15);
  input.trigger = d.chance(0.6);
  input.scope = d.chance(0.25);
  input.detonate = d.chance(0.05);
  input.flares = d.chance(0.08);
  input.relative = d.chance(0.5);
  input.manual = d.chance(0.25);
  input.yaw = d.chance(0.6) ? 0 : d.real(-1, 1);
  input.power = d.chance(0.1) ? 0 : d.real(0, 1);
  input.heading = d.real(-Math.PI, Math.PI);
  const r = d.next();
  input.weapon = r < 0.2 ? null : r < 0.85 && arms.length ? d.pick(arms) : d.pick([...WEAPON_IDS, ...MELEE_IDS] as ArmId[]);
  const target = sight.foes.length && d.chance(0.7) ? d.pick(sight.foes) : sight.all.length ? d.pick(sight.all) : null;
  const jitter = (): number => d.real(-3, 3);
  input.aim = d.chance(0.1) ? null : target ? { x: target.x + jitter(), y: target.y + jitter() * 0.3, z: target.z + jitter() } : { x: d.real(-60, 60), y: d.real(0, 20), z: d.real(-60, 60) };
  if (input.aim && sight.me && d.chance(0.7)) {
    const dx = input.aim.x - sight.me.x;
    const dy = input.aim.y - sight.me.y;
    const dz = input.aim.z - sight.me.z;
    const l = Math.hypot(dx, dy, dz);
    input.look = l > 1e-3 ? { x: dx / l, y: dy / l, z: dz / l } : null;
  } else input.look = d.chance(0.5) ? null : unit(d);
}

function unit(d: Draw): Vec3 {
  for (;;) {
    const v = { x: d.real(-1, 1), y: d.real(-1, 1), z: d.real(-1, 1) };
    const l = Math.hypot(v.x, v.y, v.z);
    if (l > 0.1 && l <= 1) return { x: v.x / l, y: v.y / l, z: v.z / l };
  }
}

/** Ce que voit le pilote du robot `me` (ou la caméra libre), d'après le monde du TypeScript. */
function sightOf(session: LocalSession): Sight {
  const sim = session.sim;
  const player = sim.player;
  const me = player && player.cockpit.alive ? blockWorldPos(player.cockpit) : null;
  const team: Team | null = player?.team ?? null;
  const foes: Vec3[] = [];
  const all: Vec3[] = [];
  for (const b of sim.bots) {
    if (!b.cockpit.alive || b === player) continue;
    const p = blockWorldPos(b.cockpit);
    all.push(p);
    if (team && b.team !== team) foes.push(p);
  }
  return { me, foes, all };
}

// --- Comparer des images ---

/** La première différence entre deux suites d'images, dite lisiblement ; null s'il n'y en a pas. */
export function firstDifference(a: readonly Uint8Array[], b: readonly Uint8Array[]): string | null {
  if (a.length !== b.length) return `${a.length} images contre ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    const d = frameDifference(a[i], b[i]);
    if (d) return `image ${i} : ${d}`;
  }
  return null;
}

/** Ce qui diffère entre deux images : le premier événement, l'en-tête, ou le premier champ de l'instantané. */
export function frameDifference(x: Uint8Array, y: Uint8Array): string | null {
  if (x.length === y.length && x.every((v, k) => v === y[k])) return null;
  const fa = decodeFrame(x);
  const fb = decodeFrame(y);
  const ha = JSON.stringify(fa.header);
  const hb = JSON.stringify(fb.header);
  if (ha !== hb) {
    const ea = fa.header.events;
    const eb = fb.header.events;
    for (let k = 0; k < Math.max(ea.length, eb.length); k++) {
      const sa = JSON.stringify(ea[k]);
      const sb = JSON.stringify(eb[k]);
      if (sa !== sb) return `événement ${k} :\n  TS   ${sa?.slice(0, 900)}\n  Rust ${sb?.slice(0, 900)}`;
    }
    const { events: _a, ...ra } = fa.header;
    const { events: _b, ...rb } = fb.header;
    return `en-tête :\n  TS   ${JSON.stringify(ra).slice(0, 900)}\n  Rust ${JSON.stringify(rb).slice(0, 900)}`;
  }
  return diff(readSnapshot(fa.snapshot), readSnapshot(fb.snapshot), "instantané") ?? "instantanés différents (octets)";
}

/** Le premier champ qui diffère entre deux valeurs lues (instantanés), avec son chemin. */
function diff(a: unknown, b: unknown, path: string): string | null {
  if (Object.is(a, b)) return null;
  if (a instanceof Map && b instanceof Map) {
    const ka = [...a.keys()];
    const kb = [...b.keys()];
    if (JSON.stringify(ka) !== JSON.stringify(kb)) return `${path} : clés ${JSON.stringify(ka).slice(0, 300)} contre ${JSON.stringify(kb).slice(0, 300)}`;
    for (const k of ka) {
      const d = diff(a.get(k), b.get(k), `${path}[${String(k)}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return `${path} : ${String(a)} contre ${String(b)}`;
}

// --- Un cas de session solo ---

/** Ce qu'un cas a joué, et sa première différence s'il y en a une. */
export interface CaseResult {
  /** Ce que le cas a tiré (mode, arène, robots) : à lire quand il échoue. */
  readonly title: string;
  /** Temps simulé (s), images comparées, octets d'images. */
  readonly seconds: number;
  readonly frames: number;
  readonly bytes: number;
  /** La première différence (null : les mêmes images), et la commande à laquelle elle est apparue. */
  readonly difference: string | null;
  readonly at: number;
  /** Le fichier où ses commandes sont écrites (un cas qui échoue). */
  readonly dump: string | null;
  /** Ce que le cas a fait (événements vus) : pour le bilan d'une série. */
  readonly seen: Record<string, number>;
}

/** Une horloge qui ne compte rien (les images ne dépendent pas du temps de calcul). */
const clock = (): number => 0;

const MODES = Object.keys(GAME_MODES) as GameModeId[];

/** Un début de partie tiré au hasard. */
function startCommand(d: Draw, robots: Map<string, BotProfile>, k: number): Extract<SessionCommand, { t: "start" }> {
  const mode = d.pick(MODES);
  const { arena, map } = anyArena(d);
  const def = GAME_MODES[mode];
  const pilot = def.pilot ? anyRobot(d, `Pilote ${k}`) : null;
  const roster = !def.pilot && d.chance(0.5) ? Array.from({ length: 2 + d.int(11) }, (_, i) => anyRobot(d, `Libre ${k}-${i}`)) : null;
  if (pilot) robots.set(pilot.id, pilot);
  for (const r of roster ?? []) robots.set(r.id, r);
  const cmd: Extract<SessionCommand, { t: "start" }> = { t: "start", mode, arena, pilot, roster, seed: d.seed() };
  if (map) cmd.map = map;
  return cmd;
}

/** Le titre d'une partie (pour les rapports). */
function startTitle(cmd: Extract<SessionCommand, { t: "start" }>): string {
  const who = cmd.pilot ? `pilote ${cmd.pilot.id}` : cmd.roster ? `${cmd.roster.length} robots imposés` : "robots tirés";
  return `${cmd.mode} à ${cmd.arena}, ${who}, graine ${cmd.seed}`;
}

/** Les commandes qui suivent, image par image (tirées d'après le monde du TypeScript), et le cas qu'elles font. */
class SessionCase {
  readonly cmds: SessionCommand[] = [];
  private readonly ts = new LocalSession(clock);
  private readonly rs: NativeSession;
  private frames = 0;
  private bytes = 0;
  private time = 0;
  private readonly seen: Record<string, number> = {};
  private titles: string[] = [];
  readonly module: SimModule;

  constructor(module: SimModule, seed: number) {
    this.module = module;
    this.rs = new NativeSession(module, clock, seed);
  }

  /** Fait la commande dans les deux sessions ; la différence de leurs images, s'il y en a une. */
  play(cmd: SessionCommand): string | null {
    this.cmds.push(cmd);
    if (cmd.t === "start") this.titles.push(startTitle(cmd));
    const [a, b, error] = both(() => this.ts.handle(cmd), () => this.rs.handle(cmd), this.module);
    if (error) return error;
    for (const f of a!) {
      this.frames++;
      this.bytes += f.length;
      for (const e of decodeFrame(f).header.events) this.seen[e.t] = (this.seen[e.t] ?? 0) + 1;
    }
    if (cmd.t === "advance" || cmd.t === "steps") this.time = this.ts.sim.time;
    return firstDifference(a!, b!);
  }

  sight(): Sight {
    return sightOf(this.ts);
  }

  get player(): boolean {
    return this.ts.sim.player !== null;
  }

  result(difference: string | null, dump: string | null): CaseResult {
    return { title: this.titles.join(" ; puis "), seconds: this.time, frames: this.frames, bytes: this.bytes, difference, at: this.cmds.length - 1, dump, seen: this.seen };
  }

  dispose(): void {
    quietly(() => this.ts.dispose());
    quietly(() => this.rs.dispose());
  }
}

/** Fait `f`, sans laisser passer d'erreur (on libère ce qu'un cas qui a échoué laisse). */
function quietly(f: () => void): void {
  try {
    f();
  } catch {
    // (une simulation qui a échoué peut échouer encore en se libérant)
  }
}

/** Le message d'une erreur, et pour le module (une panique : « unreachable »), son dernier message. */
function errorText(e: unknown, module: SimModule | null): string {
  const text = e instanceof Error ? `${e.message}\n${(e.stack ?? "").split("\n").slice(1, 6).join("\n")}` : String(e);
  let last = "";
  if (module) quietly(() => void (last = module.lastError()));
  return last ? `${text}\n  (dernier message du module : ${last})` : text;
}

/** Fait la même chose des deux côtés ; leurs résultats, ou ce qui a levé une erreur d'un côté (ou des deux). */
function both<T>(ts: () => T, rust: () => T, module: SimModule): [T | null, T | null, string | null] {
  let a: T | null = null;
  let b: T | null = null;
  let ea: string | null = null;
  let eb: string | null = null;
  try {
    a = ts();
  } catch (e) {
    ea = errorText(e, null);
  }
  try {
    b = rust();
  } catch (e) {
    eb = errorText(e, module);
  }
  if (ea || eb) return [a, b, `${ea ? `le TypeScript a levé une erreur : ${ea}` : "le TypeScript n'a pas levé d'erreur"}\n  ${eb ? `le Rust a levé une erreur : ${eb}` : "le Rust n'a pas levé d'erreur"}`];
  return [a, b, null];
}

/** Écrit les commandes d'un cas qui échoue (pour `PARITY_REPLAY`), et rend le chemin du fichier. */
function dumpCase(name: string, data: unknown): string {
  const dir = join(process.cwd(), "artifacts", "parity");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify(data));
  return path;
}

/**
 * Un cas de session solo, d'environ `seconds` s de jeu : une partie tirée au hasard, des commandes
 * de pilote, des tirs et des vagues de la caméra libre, parfois une autre partie ; les deux sessions
 * au même pas. `replay` : les commandes d'un cas écrit, rejouées telles quelles.
 */
export function sessionCase(module: SimModule, seed: number, seconds: number, replay?: SessionCommand[]): CaseResult {
  const d = new Draw(seed);
  const robots = new Map<string, BotProfile>();
  const c = new SessionCase(module, d.seed());
  const name = `session-${seed}`;
  const finish = (difference: string | null): CaseResult => {
    const dump = difference ? dumpCase(name, { kind: "session", seed, cmds: c.cmds }) : null;
    const r = c.result(difference, dump);
    c.dispose();
    return r;
  };
  if (replay) {
    for (const cmd of replay) {
      const diff = c.play(cmd);
      if (diff) return finish(diff);
    }
    return finish(null);
  }
  let start = startCommand(d, robots, 0);
  let diff = c.play(start);
  if (diff) return finish(diff);
  const input = newInput();
  let arms = start.pilot ? armsOf(start.pilot.design) : [];
  let segment = 0;
  let paused = false;
  let starts = 1;
  // Une autre partie en cours de route (parfois deux) : changement d'arène, de mode, de robots
  const restartAt = d.chance(0.5) ? d.real(0.3, 0.8) * seconds : Infinity;
  for (let t = 0; t < seconds;) {
    if (t >= restartAt * starts && starts < 3) {
      start = startCommand(d, robots, starts++);
      arms = start.pilot ? armsOf(start.pilot.design) : [];
      paused = false;
      diff = c.play(start);
      if (diff) return finish(diff);
    }
    if (segment <= 0) {
      pilotInput(d, input, arms, c.sight());
      segment = d.real(0.2, 3);
    }
    const cmds: SessionCommand[] = [];
    const free = !GAME_MODES[start.mode].pilot;
    const sight = c.sight();
    cmds.push({ t: "input", input: { ...input }, aim: free && input.aim ? { ...input.aim } : null });
    if (free && d.chance(0.12) && sight.all.length) {
      // Un tir de la caméra libre, vers un robot, parfois à tête chercheuse
      const target = d.pick(sight.all);
      const origin = { x: target.x + d.real(-25, 25), y: target.y + d.real(3, 20), z: target.z + d.real(-25, 25) };
      const dx = target.x - origin.x;
      const dy = target.y - origin.y;
      const dz = target.z - origin.z;
      const l = Math.hypot(dx, dy, dz) || 1;
      // (une direction unitaire, comme le rayon de la caméra du jeu)
      const ax = dx / l + d.real(-0.05, 0.05);
      const az = dz / l + d.real(-0.05, 0.05);
      const al = Math.hypot(ax, dy / l, az);
      const dir = { x: ax / al, y: dy / l / al, z: az / al };
      const homing = d.chance(0.3) ? { from: origin, dir, airOnly: d.chance(0.3) } : null;
      cmds.push({ t: "fire", weapon: d.pick(WEAPON_IDS) as WeaponId, origin, dir, free: d.chance(0.5), homing });
    }
    if (free && d.chance(0.004)) cmds.push({ t: "spawn", profiles: Array.from({ length: 2 + d.int(9) }, (_, i) => anyRobot(d, `Vague ${Math.round(t)}-${i}`)) });
    if (free && d.chance(0.01)) {
      paused = !paused;
      cmds.push({ t: "pause", ai: paused });
    }
    if (d.chance(0.006) && sight.all.length) {
      const p = d.pick(sight.all);
      cmds.push({ t: "damage", point: { x: p.x + d.real(-1, 1), y: p.y + d.real(-0.5, 1), z: p.z + d.real(-1, 1) }, dir: unit(d), weapon: d.pick(WEAPON_IDS) as WeaponId, shooter: { x: p.x, y: p.y + 6, z: p.z - 10 } });
    }
    if (!free && c.player && d.chance(0.003)) cmds.push({ t: "selfDestruct" });
    // Le temps : des images de deux à trois pas, parfois plus, parfois aucun ; parfois des pas d'un coup (la console)
    let dt = d.chance(0.9) ? 2.5 * STEP : d.real(0, 5.5) * STEP;
    if (d.chance(0.01)) {
      const n = 1 + d.int(30);
      cmds.push({ t: "steps", n });
      dt = n * STEP;
    } else cmds.push({ t: "advance", dt });
    for (const cmd of cmds) {
      diff = c.play(cmd);
      if (diff) return finish(diff);
    }
    t += dt;
    segment -= dt;
  }
  return finish(null);
}

// --- Un cas de salle du serveur ---

/** Une salle dont les parties sont courtes : elles finissent, et la suivante change d'arène. */
function shortRules(d: Draw): MatchRules {
  return { scoreToWin: 1 + d.int(6), timeLimit: 10 + d.int(25), respawn: d.chance(0.2) ? null : 1 + d.int(5) };
}

/**
 * Les règles des salles d'essai qu'on construit : la salle commence sa première partie dans son
 * constructeur, avant que ses propres champs n'existent.
 */
let roomRules: MatchRules = { scoreToWin: 3, timeLimit: 20, respawn: 2 };

class ShortRoom extends Room {
  protected override startMatchWorld(_: MatchRules): void {
    super.startMatchWorld(roomRules);
  }
}

class ShortNativeRoom extends NativeRoom {
  protected override startMatchWorld(_: MatchRules): void {
    super.startMatchWorld(roomRules);
  }
}

/** Ce qu'une salle d'essai reçoit : arrivée, départ, commandes, sabordage, un pas. */
type RoomAction =
  | { t: "join"; who: number; name: string; robot: unknown; token: string; maps?: string[] }
  | { t: "leave"; who: number }
  | { t: "say"; who: number; text: string }
  | { t: "tick" };

/** Une salle d'essai : elle et ses connexions (chaque joueur reçoit ses messages dans sa liste). */
class TestRoom<B> {
  readonly players = new Map<number, Player<B>>();
  readonly inbox = new Map<number, (string | Uint8Array)[]>();
  readonly room: RoomBase<B>;

  constructor(room: RoomBase<B>) {
    this.room = room;
  }

  act(a: RoomAction): void {
    switch (a.t) {
      case "join": {
        const box: (string | Uint8Array)[] = [];
        const conn: Connection = { send: (data) => void box.push(data) };
        const player = this.room.connect(conn);
        this.players.set(a.who, player);
        this.inbox.set(a.who, box);
        this.room.receive(player, JSON.stringify({ t: "join", version: PROTOCOL_VERSION, name: a.name, robot: a.robot, token: a.token, maps: a.maps }));
        break;
      }
      case "leave": {
        const p = this.players.get(a.who);
        if (p) this.room.disconnect(p);
        this.players.delete(a.who);
        break;
      }
      case "say": {
        const p = this.players.get(a.who);
        if (p) this.room.receive(p, a.text);
        break;
      }
      case "tick":
        this.room.tick();
        break;
    }
  }

  /** Les messages reçus depuis la dernière fois, par joueur. */
  take(): Map<number, (string | Uint8Array)[]> {
    const out = new Map<number, (string | Uint8Array)[]>();
    for (const [who, box] of this.inbox) out.set(who, box.splice(0));
    return out;
  }
}

/** La différence entre ce que deux salles ont envoyé à leurs joueurs ; null si c'est la même chose. */
function roomDifference(a: Map<number, (string | Uint8Array)[]>, b: Map<number, (string | Uint8Array)[]>): string | null {
  for (const [who, la] of a) {
    const lb = b.get(who) ?? [];
    if (la.length !== lb.length) return `joueur ${who} : ${la.length} messages contre ${lb.length}`;
    for (let i = 0; i < la.length; i++) {
      const x = la[i];
      const y = lb[i];
      if (typeof x === "string" || typeof y === "string") {
        if (x !== y) return `joueur ${who}, message ${i} :\n  TS   ${String(x).slice(0, 900)}\n  Rust ${String(y).slice(0, 900)}`;
        continue;
      }
      const d = frameDifference(x, y);
      if (d) return `joueur ${who}, image : ${d}`;
    }
  }
  return null;
}

/** Remplace Math.random par un tirage à graine fixe (mulberry32) : le hasard de la salle du TypeScript. */
function seedMathRandom(seed: number): () => number {
  const saved = Math.random;
  let a = seed >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return saved;
}

/**
 * Un cas de salle du serveur, d'environ `seconds` s : une rotation d'arènes (et de cartes) tirée au
 * hasard, des parties courtes qui s'enchaînent, des joueurs qui arrivent et partent, leurs commandes,
 * leurs sabordages. Les deux salles au même pas ; leurs messages (texte et images) comparés à chaque pas.
 */
export function roomCase(module: SimModule, seed: number, seconds: number, replay?: { options: { arenas: string[]; maps: number }; rules: MatchRules; roomSeed: number; actions: RoomAction[] }): CaseResult {
  const d = new Draw(seed);
  const community = communityMaps();
  const all: ArenaKey[] = [...ARENA_IDS];
  const arenas = replay?.options.arenas ?? Array.from({ length: 1 + d.int(4) }, () => d.pick(all)).filter((a, i, list) => list.indexOf(a) === i);
  const mapCount = replay?.options.maps ?? (d.chance(0.35) ? community.length : 0);
  const options: RoomOptions = { arenas: arenas as RoomOptions["arenas"], maps: community.slice(0, mapCount) };
  const rules = replay?.rules ?? shortRules(d);
  const roomSeed = replay?.roomSeed ?? d.seed();
  // Des crédits pour tout débloquer (les robots du garage passent) ; deux livres identiques
  const credits = (): ProgressBook => {
    const book = new ProgressBook();
    book.load(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`jeton-de-parite-${String(i).padStart(4, "0")}`, { credits: 1e7, unlocked: [] }])));
    return book;
  };
  // Le hasard de la salle du TypeScript, pour tout le cas (sa simulation s'en sert à chaque pas) ;
  // celui de la salle du Rust est dans son module (ce qu'il tire en TypeScript, `NativeWorld.draw`,
  // remet `Math.random` comme il l'a trouvé)
  roomRules = rules;
  const saved = seedMathRandom(roomSeed);
  const tsRoom = new ShortRoom(credits(), options);
  const ts = new TestRoom(tsRoom);
  const rs = new TestRoom(new ShortNativeRoom(module, credits(), options, roomSeed));
  const actions: RoomAction[] = [];
  const seen: Record<string, number> = {};
  let frames = 0;
  let bytes = 0;
  let ticks = 0;
  const title = `salle : ${arenas.join(", ")}${mapCount ? ` + ${mapCount} carte(s)` : ""}, parties de ${rules.timeLimit} s à ${rules.scoreToWin} points, réapparition ${rules.respawn ?? "aucune"}, graine ${roomSeed}`;
  const finish = (difference: string | null): CaseResult => {
    Math.random = saved;
    const dump = difference ? dumpCase(`room-${seed}`, { kind: "room", seed, options: { arenas, maps: mapCount }, rules, roomSeed, actions }) : null;
    quietly(() => ts.room.dispose());
    quietly(() => rs.room.dispose());
    return { title, seconds: ticks / 60, frames, bytes, difference, at: actions.length - 1, dump, seen };
  };
  const play = (a: RoomAction): string | null => {
    actions.push(a);
    const [, , error] = both(() => ts.act(a), () => rs.act(a), module);
    if (error) return error;
    if (a.t === "tick") ticks++;
    const ma = ts.take();
    const mb = rs.take();
    for (const list of ma.values()) {
      for (const m of list) {
        if (typeof m === "string") {
          const t = (JSON.parse(m) as { t: string }).t;
          seen[`message ${t}`] = (seen[`message ${t}`] ?? 0) + 1;
        } else {
          frames++;
          bytes += m.length;
          for (const e of decodeFrame(m).header.events) seen[e.t] = (seen[e.t] ?? 0) + 1;
        }
      }
    }
    return roomDifference(ma, mb);
  };
  if (replay) {
    for (const a of replay.actions) {
      const diff = play(a);
      if (diff) return finish(diff);
    }
    return finish(null);
  }
  const present = new Map<number, { input: PlayerInput; arms: ArmId[]; segment: number }>();
  let next = 0;
  // (au moins une partie finie et la suivante commencée, dans l'arène suivante : 8 s après la fin)
  const steps = Math.round(Math.max(seconds, rules.timeLimit + 12) * 60);
  for (let i = 0; i < steps; i++) {
    // Arrivées et départs (au plus huit joueurs, au moins un la plupart du temps)
    if (present.size < 8 && (present.size === 0 ? d.chance(0.02) : d.chance(0.0015))) {
      const who = next++;
      const garage = d.chance(0.5);
      const profile = garage ? garageRobot(d, `Garage ${who}`) : d.pick(PRESET_BOTS);
      // Parfois un robot refusé : un plan invalide, une version ou un jeton faux
      const r = d.next();
      const robot = r < 0.03 ? { design: { blocks: [], wheels: [] }, color: "#ffffff", name: "Rien" } : garage ? { design: profile.design, color: profile.color, name: profile.name } : { preset: profile.id };
      const token = r > 0.97 ? "court" : `jeton-de-parite-${String(who % 8).padStart(4, "0")}`;
      const diff = play({ t: "join", who, name: d.chance(0.2) ? "" : `Joueur ${who}`, robot, token, maps: d.chance(0.5) ? community.map((m) => mapKey(m)) : undefined });
      if (diff) return finish(diff);
      present.set(who, { input: newInput(), arms: armsOf(profile.design), segment: 0 });
    } else if (present.size > 0 && d.chance(0.0008)) {
      const who = d.pick([...present.keys()]);
      present.delete(who);
      const diff = play({ t: "leave", who });
      if (diff) return finish(diff);
    }
    for (const [who, p] of present) {
      if (p.segment <= 0) {
        // (les robots de la salle du TypeScript : sa simulation)
        const all: Vec3[] = tsRoom.sim.bots.filter((b) => b.cockpit.alive).map((b) => blockWorldPos(b.cockpit));
        pilotInput(d, p.input, p.arms, { me: null, foes: all, all });
        p.segment = d.real(0.2, 3);
        const diff = play({ t: "say", who, text: JSON.stringify({ t: "input", input: p.input }) });
        if (diff) return finish(diff);
      }
      p.segment -= 1 / 60;
      if (d.chance(0.0004)) {
        const diff = play({ t: "say", who, text: JSON.stringify({ t: "selfDestruct" }) });
        if (diff) return finish(diff);
      }
    }
    const diff = play({ t: "tick" });
    if (diff) return finish(diff);
  }
  return finish(null);
}

/**
 * Rejoue le seul côté TypeScript d'un cas écrit de salle, ses `count` premières actions : la salle telle
 * qu'elle est alors (pour regarder, au plus près de l'écart, ce que le Rust a fait autrement).
 */
export function replayRoomTs(dump: Extract<ReturnType<typeof readDump>, { kind: "room" }>, count = dump.actions.length): Room {
  const community = communityMaps();
  roomRules = dump.rules;
  seedMathRandom(dump.roomSeed);
  const credits = new ProgressBook();
  credits.load(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`jeton-de-parite-${String(i).padStart(4, "0")}`, { credits: 1e7, unlocked: [] }])));
  const room = new ShortRoom(credits, { arenas: dump.options.arenas as RoomOptions["arenas"], maps: community.slice(0, dump.options.maps) });
  const test = new TestRoom(room);
  for (const a of dump.actions.slice(0, count)) {
    test.act(a);
    test.take();
  }
  return room;
}

/** Les commandes d'un cas écrit (`artifacts/parity/<nom>.json`), pour le rejouer. */
export function readDump(path: string): { kind: "session"; seed: number; cmds: SessionCommand[] } | { kind: "room"; seed: number; options: { arenas: string[]; maps: number }; rules: MatchRules; roomSeed: number; actions: RoomAction[] } {
  return JSON.parse(readFileSync(path, "utf8"));
}

export type { SessionLike };
