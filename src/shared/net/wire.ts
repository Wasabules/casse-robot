import { add, qmul, qrot, sub, type Quat, type Vec3 } from "../math/vec";
import type { AiMode, MeleeBite, SwingPhase, Team } from "../sim/entities";
import { utf8Decode, utf8Encode } from "./binary";
import { MODE_CODES, MODES_BY_CODE, type FrameHeader } from "./protocol";
import {
  BITE_GLANCE, BITE_SURFACES, NO_AMMO, OWNERS, readSnapshot, SWING_PHASES, TEAMS, WINNERS,
  type BodyPose, type BotState, type MatchState, type MeleeSnap, type PartState, type ProjectileState, type PropState, type Snapshot,
  type TurretState, type WheelState,
} from "./snapshot";

/*
 * Le fil du multijoueur : ce qui passe vraiment par la WebSocket. Les simulations écrivent chaque image
 * comme avant (protocol.ts : un en-tête JSON, puis l'instantané binaire de snapshot.ts, octet pour octet
 * le même en TypeScript et en Rust) ; le serveur la transforme ici en une image compacte (`WireStream`),
 * que le client retransforme en un instantané (`WireDecoder`) avant de la donner à sa réplique, qui le
 * lit comme avant. Les images du Worker solo n'y passent pas : elles ne traversent aucun réseau.
 *
 * Trois choses rendent l'image compacte :
 * - la quantification : les positions au demi-millimètre (l'écart au plus 0,25 mm par axe), les
 *   rotations par leurs trois plus petites composantes (la plus grande s'en déduit) au 1/32768, les
 *   vitesses au 1/512 m/s ; une roue montée se donne dans le repère de son morceau (son porte-moyeu)
 *   et du porte-moyeu (la roue), le centre de masse d'un morceau dans son repère : ce qui ne bouge
 *   pas par rapport à son porteur ne change plus d'une image à l'autre. Le reste (énergie, chaleur,
 *   régimes…) garde ses flottants de 32 bits, exacts. Une valeur hors d'étendue (infinie, immense)
 *   fait passer son entité en flottants bruts : rien ne se perd. Les nombres réels des événements de
 *   l'en-tête sont arrondis au 1/10000 (`roundHeader`), sauf la description des robots ;
 * - le delta : chaque entité s'écrit par rapport à la même entité de l'image précédente du fil (la
 *   WebSocket est fiable et ordonnée : l'image précédente est arrivée), en entiers, donc sans erreur
 *   qui s'accumule ; une entité qui n'a pas bougé tient en un octet, et la position d'un corps qui
 *   bouge se prédit d'après sa vitesse (on n'envoie que l'écart à la prédiction). Le premier envoi à
 *   un joueur (il arrive) est une image complète ;
 * - la compression de la WebSocket (`permessage-deflate`, server/main.ts), par-dessus.
 *
 * Une image du fil : son genre (complète ou delta), son numéro (sur 8 bits : le client vérifie qu'il
 * suit le précédent), l'en-tête JSON tel quel, le temps (flottant de 64 bits, exact), puis les sections
 * (globales, robots, morceaux, roues, débris, accessoires, projectiles) : la liste des identifiants
 * (« la même que la précédente » le plus souvent), puis chaque entité, un vecteur d'entiers écrit en
 * entier, en écarts à l'entité précédente, ou en un octet si rien n'a changé. Tout ce qui se lit est
 * borné : une image tronquée ou corrompue lève `WireError`, sans boucler.
 */

/** Une image du fil illisible (tronquée, corrompue, ou qui ne suit pas la précédente). */
export class WireError extends Error {}

/** Positions : au 1/2048 m (l'écart au plus 0,25 mm par axe). */
const POS = 2048;
/** Composantes d'une rotation : au 1/32768 (l'écart d'angle au plus ~0,003°). */
const ROT = 32768;
/** Vitesses : au 1/512 m/s. */
const VEL = 512;
/** Vitesses angulaires : au 1/1024 rad/s. */
const SPIN = 1024;
/** Âge d'un projectile : au 1/4096 s. */
const AGE = 4096;
/** Angles des tourelles : au 1/16384 rad. */
const ANGLE = 16384;
/** Au-delà (une fois l'échelle appliquée), une valeur ne se quantifie plus : son entité passe en flottants bruts. */
const LIMIT = 0x80000000;
/** Au-delà, une prédiction n'en est plus une (un écart de temps aberrant) : on s'en passe. */
const PREDICT_LIMIT = 0x10000000000;
/** Nombres réels des événements : au 1/10000 (positions au dixième de millimètre, directions, temps, points de structure). */
const EVENT_PRECISION = 1e4;
/** Longueur au plus d'un vecteur d'entité (le plus long : un robot à seize moteurs tient en ~100). */
const MAX_VECTOR = 1 << 16;

/** Genre d'une image du fil. */
const KEY = 1;
const DELTA = 2;

// Ordre des sections (l'ordre de l'instantané : les roues après les morceaux qui les portent)
const GLOBAL = 0;
const BOTS = 1;
const PARTS = 2;
const WHEELS = 3;
const DEBRIS = 4;
const PROPS = 5;
const PROJECTILES = 6;
const SECTIONS = 7;

// --- Octets ---

/** Écriture d'octets : entiers variables (7 bits par octet), zigzag pour les signés. */
class ByteWriter {
  private buffer = new Uint8Array(4096);
  private at = 0;

  u8(v: number): void {
    this.need(1);
    this.buffer[this.at++] = v;
  }

  /** Entier positif (jusqu'à 2^53). */
  varint(v: number): void {
    this.need(8);
    while (v >= 128) {
      this.buffer[this.at++] = (v % 128) | 128;
      v = Math.floor(v / 128);
    }
    this.buffer[this.at++] = v;
  }

  /** Entier signé (|v| jusqu'à 2^52). */
  zigzag(v: number): void {
    this.varint(v >= 0 ? v * 2 : -v * 2 - 1);
  }

  f64(v: number): void {
    this.need(8);
    new DataView(this.buffer.buffer, this.at, 8).setFloat64(0, v, true);
    this.at += 8;
  }

  bytes(data: Uint8Array): void {
    this.need(data.length);
    this.buffer.set(data, this.at);
    this.at += data.length;
  }

  get length(): number {
    return this.at;
  }

  finish(): Uint8Array {
    return this.buffer.slice(0, this.at);
  }

  private need(n: number): void {
    if (this.at + n <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < this.at + n) size *= 2;
    const bigger = new Uint8Array(size);
    bigger.set(this.buffer.subarray(0, this.at));
    this.buffer = bigger;
  }
}

/** Lecture bornée : au-delà de la fin, ou d'un entier trop long, `WireError`. */
class ByteReader {
  private at = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get left(): number {
    return this.bytes.length - this.at;
  }

  u8(): number {
    if (this.at >= this.bytes.length) throw new WireError("image tronquée");
    return this.bytes[this.at++];
  }

  varint(): number {
    let v = 0;
    let mul = 1;
    for (let k = 0; k < 8; k++) {
      const b = this.u8();
      v += (b & 127) * mul;
      if (b < 128) {
        if (v > Number.MAX_SAFE_INTEGER) break;
        return v;
      }
      mul *= 128;
    }
    throw new WireError("entier trop long");
  }

  zigzag(): number {
    const v = this.varint();
    return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
  }

  /** Un nombre d'éléments qui tiennent chacun au moins `per` octets dans ce qui reste. */
  count(per: number, max = Infinity): number {
    const n = this.varint();
    if (n * per > this.left || n > max) throw new WireError("compte impossible");
    return n;
  }

  f64(): number {
    if (this.left < 8) throw new WireError("image tronquée");
    const v = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.at, 8).getFloat64(0, true);
    this.at += 8;
    return v;
  }

  take(n: number): Uint8Array {
    if (n > this.left) throw new WireError("image tronquée");
    const out = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
}

// --- Nombres ---

const scratch = new DataView(new ArrayBuffer(4));

/** Les 32 bits d'un flottant (exact : l'instantané les écrit en flottants de 32 bits). */
function bits(x: number): number {
  scratch.setFloat32(0, x, true);
  return scratch.getUint32(0, true);
}

function float(b: number): number {
  scratch.setUint32(0, b, true);
  return scratch.getFloat32(0, true);
}

const conj = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });

/** Rotation dans le repère de `frame` (le porteur) : ce qui bouge avec lui y reste immobile. */
const localRot = (frame: Quat, q: Quat): Quat => qmul(conj(frame), q);
const localPos = (frame: BodyPose, p: Vec3): Vec3 => qrot(conj(frame.rot), sub(p, frame.pos));

/** Vecteur d'entiers d'une entité, en construction : `ok` faux si une valeur ne se quantifie pas. */
class Ints {
  readonly out: number[] = [];
  ok = true;

  int(n: number): void {
    this.out.push(n);
  }

  q(x: number, scale: number): void {
    // (+ 0 : un zéro négatif devient un zéro, comme le client le relit)
    const v = Math.round(x * scale) + 0;
    if (!(Math.abs(v) < LIMIT)) this.ok = false;
    this.out.push(this.ok ? v : 0);
  }

  vec(v: Vec3, scale: number): void {
    this.q(v.x, scale);
    this.q(v.y, scale);
    this.q(v.z, scale);
  }

  /** Une rotation : le rang de sa plus grande composante (rendue positive), puis les trois autres. */
  rot(q: Quat): void {
    const c = [q.x, q.y, q.z, q.w];
    const n = Math.sqrt(c[0] * c[0] + c[1] * c[1] + c[2] * c[2] + c[3] * c[3]);
    if (!(n > 0.5 && n < 2)) {
      this.ok = false;
      this.out.push(0, 0, 0, 0);
      return;
    }
    let big = 0;
    for (let k = 1; k < 4; k++) if (Math.abs(c[k]) > Math.abs(c[big])) big = k;
    const s = (c[big] < 0 ? -1 : 1) / n;
    this.out.push(big);
    for (let k = 0; k < 4; k++) if (k !== big) this.out.push(Math.round(c[k] * s * ROT) + 0);
  }

  f32(x: number): void {
    this.out.push(bits(x));
  }

  f32s(v: Vec3): void {
    this.f32(v.x);
    this.f32(v.y);
    this.f32(v.z);
  }

  rot32(q: Quat): void {
    this.f32(q.x);
    this.f32(q.y);
    this.f32(q.z);
    this.f32(q.w);
  }
}

/** Lecture d'un vecteur d'entité reçu : bornée, `WireError` sinon. */
class Cursor {
  private at = 0;
  private readonly v: readonly number[];

  constructor(v: readonly number[]) {
    this.v = v;
  }

  int(): number {
    if (this.at >= this.v.length) throw new WireError("entité tronquée");
    return this.v[this.at++];
  }

  /** Un rang dans une liste de `n` choix. */
  index(n: number): number {
    const k = this.int();
    if (!(k >= 0 && k < n)) throw new WireError("choix inconnu");
    return k;
  }

  /** Un nombre d'éléments de `per` entiers chacun au moins, qui tiennent dans ce qui reste. */
  count(per: number): number {
    const n = this.int();
    if (!(n >= 0 && n * per <= this.v.length - this.at)) throw new WireError("compte impossible");
    return n;
  }

  q(scale: number): number {
    return this.int() / scale;
  }

  vec(scale: number): Vec3 {
    return { x: this.q(scale), y: this.q(scale), z: this.q(scale) };
  }

  rot(): Quat {
    const big = this.index(4);
    const c: number[] = [];
    let sum = 0;
    for (let k = 0; k < 3; k++) {
      const x = this.int() / ROT;
      c.push(x);
      sum += x * x;
    }
    c.splice(big, 0, Math.sqrt(Math.max(0, 1 - sum)));
    const n = Math.sqrt(c[0] * c[0] + c[1] * c[1] + c[2] * c[2] + c[3] * c[3]) || 1;
    return { x: c[0] / n, y: c[1] / n, z: c[2] / n, w: c[3] / n };
  }

  f32(): number {
    return float(this.int());
  }

  f32s(): Vec3 {
    return { x: this.f32(), y: this.f32(), z: this.f32() };
  }

  rot32(): Quat {
    return { x: this.f32(), y: this.f32(), z: this.f32(), w: this.f32() };
  }

  done(): void {
    if (this.at !== this.v.length) throw new WireError("entité trop longue");
  }
}

// --- Image quantifiée ---

/** Une section : les identifiants de ses entités, dans l'ordre de l'instantané, et leurs vecteurs d'entiers. */
interface Section {
  readonly ids: number[];
  readonly vecs: number[][];
  index?: Map<number, number>;
}

/** Une image quantifiée : ce que le serveur et le client gardent de la précédente, à l'identique. */
export interface WireFrame {
  readonly time: number;
  readonly sections: readonly Section[];
}

function vecOf(section: Section, id: number): number[] | undefined {
  section.index ??= new Map(section.ids.map((x, k) => [x, k]));
  const k = section.index.get(id);
  return k === undefined ? undefined : section.vecs[k];
}

/** La pose d'un corps telle que le client la reconstruit d'après son vecteur (mode quantifié), à partir de `at`. */
function poseAt(v: readonly number[], at: number): BodyPose {
  const c = new Cursor(v.slice(at, at + 7));
  return { pos: c.vec(POS), rot: c.rot() };
}

/** Pose quantifiée (3 + 4 entiers) ou brute (7 flottants) d'un corps libre. */
function quantizePose(p: BodyPose): Ints {
  const b = new Ints();
  b.int(0);
  b.vec(p.pos, POS);
  b.rot(p.rot);
  if (b.ok) return b;
  const raw = new Ints();
  raw.int(1);
  raw.f32s(p.pos);
  raw.rot32(p.rot);
  return raw;
}

function readPose(c: Cursor): BodyPose {
  const mode = c.index(2);
  return mode === 0 ? { pos: c.vec(POS), rot: c.rot() } : { pos: c.f32s(), rot: c.rot32() };
}

function quantizePart(s: PartState): { ints: number[]; pose: BodyPose } {
  const b = new Ints();
  b.int(0);
  b.vec(s.pos, POS);
  b.rot(s.rot);
  b.vec(s.vel, VEL);
  b.vec(s.ang, SPIN);
  if (b.ok) {
    // Le centre de masse dans le repère du morceau (tel que le client le verra) : il ne change pas
    const pose = poseAt(b.out, 1);
    b.vec(localPos(pose, s.com), POS);
    b.f32(s.mass);
    if (b.ok) return { ints: b.out, pose };
  }
  const raw = new Ints();
  raw.int(1);
  raw.f32s(s.pos);
  raw.rot32(s.rot);
  raw.f32s(s.vel);
  raw.f32s(s.ang);
  raw.f32s(s.com);
  raw.f32(s.mass);
  return { ints: raw.out, pose: { pos: s.pos, rot: s.rot } };
}

function readPart(c: Cursor): PartState {
  if (c.index(2) === 0) {
    const pos = c.vec(POS);
    const rot = c.rot();
    const vel = c.vec(VEL);
    const ang = c.vec(SPIN);
    const com = add(pos, qrot(rot, c.vec(POS)));
    return { pos, rot, vel, ang, com, mass: c.f32() };
  }
  return { pos: c.f32s(), rot: c.rot32(), vel: c.f32s(), ang: c.f32s(), com: c.f32s(), mass: c.f32() };
}

/**
 * Une roue. Montée (son morceau dans l'image, son porte-moyeu là) : le porte-moyeu dans le repère du
 * morceau (le braquage, le débattement), la roue dans celui du porte-moyeu (sa rotation sur l'essieu).
 * Sinon (arrachée), sa pose dans le monde, et celle de son porte-moyeu s'il reste.
 */
function quantizeWheel(s: WheelState, parts: ReadonlyMap<number, BodyPose>): number[] {
  const carrier = s.part ? parts.get(s.part) : undefined;
  if (carrier && s.hub) {
    const b = new Ints();
    b.int(0);
    b.int(s.part);
    b.vec(localPos(carrier, s.hub.pos), POS);
    b.rot(localRot(carrier.rot, s.hub.rot));
    if (b.ok) {
      const hub = hubPose(carrier, poseAt(b.out, 2));
      b.vec(localPos(hub, s.pos), POS);
      b.rot(localRot(hub.rot, s.rot));
      b.f32(s.drive);
      b.f32(s.steer);
      if (b.ok) return b.out;
    }
  }
  const b = new Ints();
  b.int(1);
  b.int(s.part);
  const pose = quantizePose(s);
  const hub = s.hub ? quantizePose(s.hub) : null;
  b.out.push(...pose.out, hub ? 1 : 0, ...(hub?.out ?? []));
  b.f32(s.drive);
  b.f32(s.steer);
  return b.out;
}

/** Le porte-moyeu d'après sa pose dans le repère de son morceau. */
function hubPose(carrier: BodyPose, local: BodyPose): BodyPose {
  return { pos: add(carrier.pos, qrot(carrier.rot, local.pos)), rot: qmul(carrier.rot, local.rot) };
}

function readWheel(c: Cursor, parts: ReadonlyMap<number, BodyPose>): WheelState {
  const mode = c.index(2);
  const part = c.int();
  if (mode === 0) {
    const carrier = parts.get(part);
    if (!carrier) throw new WireError("roue sans morceau");
    const hub = hubPose(carrier, { pos: c.vec(POS), rot: c.rot() });
    const wheel = hubPose(hub, { pos: c.vec(POS), rot: c.rot() });
    return { ...wheel, part, hub, drive: c.f32(), steer: c.f32() };
  }
  const pose = readPose(c);
  const hub = c.index(2) ? readPose(c) : null;
  return { ...pose, part, hub, drive: c.f32(), steer: c.f32() };
}

function quantizeProp(s: PropState): number[] {
  const b = quantizePose(s);
  b.int(s.state);
  b.f32(s.leak.x);
  b.f32(s.leak.z);
  return b.out;
}

function readProp(c: Cursor): PropState {
  const pose = readPose(c);
  const state = c.int();
  const x = c.f32();
  const z = c.f32();
  return { ...pose, state, leak: { x, y: 0, z } };
}

function quantizeProjectile(s: ProjectileState): number[] {
  const b = new Ints();
  b.int(0);
  b.vec(s.pos, POS);
  b.vec(s.vel, VEL);
  b.q(s.age, AGE);
  if (b.ok) return b.out;
  const raw = new Ints();
  raw.int(1);
  raw.f32s(s.pos);
  raw.f32s(s.vel);
  raw.f32(s.age);
  return raw.out;
}

function readProjectile(c: Cursor): ProjectileState {
  if (c.index(2) === 0) return { pos: c.vec(POS), vel: c.vec(VEL), age: c.q(AGE) };
  return { pos: c.f32s(), vel: c.f32s(), age: c.f32() };
}

/** L'état d'un robot : ses flottants bruts, sauf sa dernière position et les angles de ses tourelles (quantifiés, si possible). */
function quantizeBot(s: BotState): number[] {
  for (const mode of [0, 1]) {
    const b = new Ints();
    const angle = (a: number): void => (mode === 0 ? b.q(a, ANGLE) : b.f32(a));
    b.int(mode);
    b.int(s.player ? 1 : 0);
    b.f32(s.energy);
    b.int(s.flares);
    b.int(MODE_CODES[s.mode]);
    b.f32(s.stunnedUntil);
    b.f32(s.righting);
    b.f32(s.flippedFor);
    b.int(s.lastAttacker);
    if (mode === 0) b.vec(s.lastPos, POS);
    else b.f32s(s.lastPos);
    b.int(s.turrets.size);
    for (const [id, t] of s.turrets) {
      b.int(id);
      angle(t.yaw);
      angle(t.pitch);
      b.int(Number.isFinite(t.ammo) ? t.ammo : NO_AMMO);
      b.f32(t.heat);
      b.int(t.overheated ? 1 : 0);
      b.f32(t.cooldown);
      b.f32(t.restock);
    }
    b.int(s.thrusters.size);
    for (const [id, t] of s.thrusters) b.out.push(id, bits(t.thrust), bits(t.tiltA), bits(t.tiltB));
    b.int(s.surfaces.size);
    for (const [id, d] of s.surfaces) b.out.push(id, bits(d));
    b.int(s.supports.size);
    for (const [id, u] of s.supports) b.out.push(id, bits(u.contact), bits(u.force), bits(u.phase));
    b.int(s.melee.size);
    for (const [id, m] of s.melee) {
      b.out.push(id, bits(m.spin), SWING_PHASES.indexOf(m.phase), bits(m.swing));
      const bite = m.bite;
      b.int(bite ? (BITE_SURFACES.indexOf(bite.surface) + 1) | (bite.glance ? BITE_GLANCE : 0) : 0);
      if (bite) {
        b.f32s(bite.point);
        b.f32s(bite.dir);
        b.f32(bite.power);
      }
      b.int(m.link);
      b.int(m.values.length);
      for (const x of m.values) b.f32(x);
    }
    if (b.ok) return b.out;
  }
  throw new Error("inaccessible : le mode brut se quantifie toujours");
}

function readBot(c: Cursor): BotState {
  const mode = c.index(2);
  const angle = (): number => (mode === 0 ? c.q(ANGLE) : c.f32());
  const player = c.int() === 1;
  const energy = c.f32();
  const flares = c.int();
  const aiMode: AiMode = MODES_BY_CODE[c.index(MODES_BY_CODE.length)];
  const stunnedUntil = c.f32();
  const righting = c.f32();
  const flippedFor = c.f32();
  const lastAttacker = c.int();
  const lastPos = mode === 0 ? c.vec(POS) : c.f32s();
  const turrets = new Map<number, TurretState>();
  for (let n = c.count(8); n > 0; n--) {
    const id = c.int();
    const yaw = angle();
    const pitch = angle();
    const ammo = c.int();
    turrets.set(id, { yaw, pitch, ammo: ammo === NO_AMMO ? Infinity : ammo, heat: c.f32(), overheated: c.int() === 1, cooldown: c.f32(), restock: c.f32() });
  }
  const thrusters = new Map<number, { thrust: number; tiltA: number; tiltB: number }>();
  for (let n = c.count(4); n > 0; n--) {
    const id = c.int();
    thrusters.set(id, { thrust: c.f32(), tiltA: c.f32(), tiltB: c.f32() });
  }
  const surfaces = new Map<number, number>();
  for (let n = c.count(2); n > 0; n--) {
    const id = c.int();
    surfaces.set(id, c.f32());
  }
  const supports = new Map<number, { contact: number; force: number; phase: number }>();
  for (let n = c.count(4); n > 0; n--) {
    const id = c.int();
    supports.set(id, { contact: c.f32(), force: c.f32(), phase: c.f32() });
  }
  const melee = new Map<number, MeleeSnap>();
  for (let n = c.count(7); n > 0; n--) {
    const id = c.int();
    const spin = c.f32();
    const phase: SwingPhase = SWING_PHASES[c.index(SWING_PHASES.length)];
    const swing = c.f32();
    const flags = c.int();
    let bite: MeleeBite | null = null;
    if (flags) {
      const surface = BITE_SURFACES[(flags & ~BITE_GLANCE) - 1];
      if (!surface) throw new WireError("morsure inconnue");
      bite = { point: c.f32s(), dir: c.f32s(), power: c.f32(), surface, glance: (flags & BITE_GLANCE) !== 0 };
    }
    const link = c.int();
    const values: number[] = [];
    for (let k = c.count(1); k > 0; k--) values.push(c.f32());
    melee.set(id, { spin, phase, swing, bite, link, values });
  }
  return { player, energy, flares, mode: aiMode, stunnedUntil, righting, flippedFor, lastAttacker, lastPos, turrets, thrusters, surfaces, supports, melee };
}

/** La partie et la détection (petites, sans prédiction : elles changent peu). */
function quantizeGlobal(s: Snapshot): number[] {
  const b = new Ints();
  const m = s.match;
  b.int(m ? 1 : 0);
  if (m) {
    b.int(m.score.red);
    b.int(m.score.blue);
    b.f32(m.elapsed);
    b.int(WINNERS.indexOf(m.winner));
    b.int(m.respawns.length);
    for (const [bot, at] of m.respawns) b.out.push(bot, bits(at));
    b.int(m.zones.length);
    for (const [owner, progress, contested, active] of m.zones) b.out.push(OWNERS.indexOf(owner), bits(progress), (contested ? 1 : 0) | (active ? 2 : 0));
  }
  for (const team of TEAMS) {
    b.int(s.detected[team].length);
    b.out.push(...s.detected[team]);
  }
  return b.out;
}

function readGlobal(c: Cursor): Pick<Snapshot, "match" | "detected"> {
  let match: MatchState | null = null;
  if (c.index(2)) {
    const red = c.int();
    const blue = c.int();
    const elapsed = c.f32();
    const winner = WINNERS[c.index(WINNERS.length)];
    const respawns: [number, number][] = [];
    for (let n = c.count(2); n > 0; n--) respawns.push([c.int(), c.f32()]);
    const zones: [Team | null, number, boolean, boolean][] = [];
    for (let n = c.count(3); n > 0; n--) {
      const owner = OWNERS[c.index(OWNERS.length)];
      const progress = c.f32();
      const flags = c.int();
      zones.push([owner, progress, (flags & 1) !== 0, (flags & 2) !== 0]);
    }
    match = { score: { red, blue }, elapsed, winner, respawns, zones };
  }
  const detected = { red: [] as number[], blue: [] as number[] };
  for (const team of TEAMS) for (let n = c.count(1); n > 0; n--) detected[team].push(c.int());
  return { match, detected };
}

/** L'instantané en image quantifiée (le serveur, une fois par image pour tous les joueurs). */
export function quantize(s: Snapshot): WireFrame {
  const section = <T>(map: ReadonlyMap<number, T>, f: (x: T) => number[]): Section => ({ ids: [...map.keys()], vecs: [...map.values()].map(f) });
  // Les morceaux d'abord : leurs poses, telles que le client les reconstruira, portent les roues
  const poses = new Map<number, BodyPose>();
  const parts: Section = { ids: [], vecs: [] };
  for (const [id, p] of s.parts) {
    const q = quantizePart(p);
    parts.ids.push(id);
    parts.vecs.push(q.ints);
    poses.set(id, q.pose);
  }
  const sections: Section[] = [];
  sections[GLOBAL] = { ids: [0], vecs: [quantizeGlobal(s)] };
  sections[BOTS] = section(s.bots, quantizeBot);
  sections[PARTS] = parts;
  sections[WHEELS] = section(s.wheels, (w) => quantizeWheel(w, poses));
  sections[DEBRIS] = section(s.debris, (d) => quantizePose(d).out);
  sections[PROPS] = section(s.props, quantizeProp);
  sections[PROJECTILES] = section(s.projectiles, quantizeProjectile);
  return { time: s.time, sections };
}

/** L'instantané que lit la réplique, d'après une image quantifiée (le client). */
export function expand(q: WireFrame): Snapshot {
  const read = <T>(k: number, f: (c: Cursor) => T): Map<number, T> => {
    const out = new Map<number, T>();
    const section = q.sections[k];
    section.ids.forEach((id, i) => {
      const c = new Cursor(section.vecs[i]);
      out.set(id, f(c));
      c.done();
    });
    return out;
  };
  const global = new Cursor(q.sections[GLOBAL].vecs[0] ?? []);
  const { match, detected } = readGlobal(global);
  global.done();
  const bots = read(BOTS, readBot);
  const parts = read(PARTS, readPart);
  const poses = new Map<number, BodyPose>([...parts].map(([id, p]) => [id, { pos: p.pos, rot: p.rot }]));
  const wheels = read(WHEELS, (c) => readWheel(c, poses));
  const debris = read(DEBRIS, readPose);
  const props = read(PROPS, readProp);
  const projectiles = read(PROJECTILES, readProjectile);
  return { time: q.time, match, detected, bots, parts, wheels, debris, props, projectiles };
}

// --- Écarts entre deux images ---

/**
 * Ce qu'on attend d'une entité d'après la précédente, `dt` s plus tard : la position d'un morceau ou
 * d'un projectile avancée de sa vitesse (et l'âge d'un projectile) ; le reste, inchangé. Le serveur et
 * le client la calculent sur les mêmes entiers, avec les mêmes opérations : le même résultat.
 */
function predicted(section: number, base: readonly number[], dt: number): readonly number[] {
  if (base[0] !== 0 || !(dt > 0)) return base;
  // [0, position ×3, rotation ×4, vitesse ×3…] pour un morceau ; [0, position ×3, vitesse ×3, âge] pour un projectile
  const vel = section === PARTS ? 8 : section === PROJECTILES ? 4 : -1;
  if (vel < 0 || base.length < vel + 3) return base;
  const out = base.slice();
  for (let k = 0; k < 3; k++) {
    const p = base[1 + k] + Math.round((base[vel + k] / VEL) * dt * POS);
    if (Math.abs(p) < PREDICT_LIMIT) out[1 + k] = p;
  }
  if (section === PROJECTILES && base.length === 8) {
    const age = base[7] + Math.round(dt * AGE);
    if (Math.abs(age) < PREDICT_LIMIT) out[7] = age;
  }
  return out;
}

/** Les identifiants d'une section, la même liste que la précédente le plus souvent. */
function sameIds(a: readonly number[], b: readonly number[] | undefined): boolean {
  if (!b || a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
}

/** Entité inchangée (un octet), écarts aux seules valeurs qui changent (une carte de bits), ou entière. */
const SAME = 0;
const CHANGED = 1;
const WHOLE = 2;

function writeSection(w: ByteWriter, k: number, cur: Section, base: Section | undefined, dt: number): void {
  w.varint(cur.ids.length);
  const same = base !== undefined && sameIds(cur.ids, base.ids);
  w.u8(same ? 1 : 0);
  if (!same) {
    let prev = 0;
    for (const id of cur.ids) {
      w.zigzag(id - prev);
      prev = id;
    }
  }
  cur.ids.forEach((id, i) => {
    const v = cur.vecs[i];
    const old = base && vecOf(base, id);
    if (!old || old.length !== v.length) {
      w.u8(WHOLE);
      w.varint(v.length);
      for (const x of v) w.zigzag(x);
      return;
    }
    const p = predicted(k, old, dt);
    let changed = false;
    for (let j = 0; j < v.length && !changed; j++) changed = v[j] !== p[j];
    if (!changed) {
      w.u8(SAME);
      return;
    }
    w.u8(CHANGED);
    for (let j = 0; j < v.length; j += 8) {
      let mask = 0;
      for (let b = 0; b < 8 && j + b < v.length; b++) if (v[j + b] !== p[j + b]) mask |= 1 << b;
      w.u8(mask);
    }
    for (let j = 0; j < v.length; j++) if (v[j] !== p[j]) w.zigzag(v[j] - p[j]);
  });
}

function readSection(r: ByteReader, k: number, base: Section | undefined, dt: number): Section {
  const n = r.count(1);
  const same = r.u8();
  let ids: number[];
  if (same === 1) {
    if (!base || base.ids.length !== n) throw new WireError("pas la même liste");
    ids = base.ids.slice();
  } else if (same === 0) {
    ids = [];
    let prev = 0;
    for (let i = 0; i < n; i++) {
      prev += r.zigzag();
      if (!(prev >= 0 && prev <= 0xffffffff)) throw new WireError("identifiant impossible");
      ids.push(prev);
    }
  } else {
    throw new WireError("liste inconnue");
  }
  const vecs = ids.map((id): number[] => {
    const tag = r.u8();
    if (tag === WHOLE) {
      const v: number[] = [];
      for (let len = r.count(1, MAX_VECTOR); len > 0; len--) v.push(r.zigzag());
      return v;
    }
    const old = base && vecOf(base, id);
    if (!old) throw new WireError("entité sans base");
    const p = predicted(k, old, dt);
    if (tag === SAME) return p.slice();
    if (tag !== CHANGED) throw new WireError("entité inconnue");
    const masks = r.take(Math.ceil(p.length / 8));
    const v = p.slice();
    for (let j = 0; j < v.length; j++) {
      if (!(masks[j >> 3] & (1 << (j & 7)))) continue;
      v[j] = p[j] + r.zigzag();
      if (!Number.isSafeInteger(v[j])) throw new WireError("valeur impossible");
    }
    return v;
  });
  return { ids, vecs };
}

function writeBody(w: ByteWriter, cur: WireFrame, base: WireFrame | null, sizes: number[]): void {
  w.f64(cur.time);
  const dt = base ? cur.time - base.time : 0;
  for (let k = 0; k < SECTIONS; k++) {
    const at = w.length;
    writeSection(w, k, cur.sections[k], base?.sections[k], dt);
    sizes[k] = (sizes[k] ?? 0) + w.length - at;
  }
}

function readBody(r: ByteReader, base: WireFrame | null): WireFrame {
  const time = r.f64();
  if (!Number.isFinite(time)) throw new WireError("temps impossible");
  const dt = base ? time - base.time : 0;
  const sections: Section[] = [];
  for (let k = 0; k < SECTIONS; k++) sections.push(readSection(r, k, base?.sections[k], dt));
  if (r.left) throw new WireError("image trop longue");
  return { time, sections };
}

// --- Le fil ---

/** Mesure du travail du serveur sur le fil (ms) : quantifier les instantanés, écrire les images. */
export interface WireStats {
  frames: number;
  quantizeMs: number;
  writeMs: number;
  /** Les en-têtes (un par joueur et par image). */
  headerMs: number;
  /** Octets écrits par section (globales, robots, morceaux, roues, débris, accessoires, projectiles). */
  sections: number[];
}

/**
 * Côté serveur, une fois par salle : la quantification de chaque instantané, et ses écarts à
 * l'instantané précédent, calculés une fois pour tous les joueurs (ils ont tous reçu le précédent).
 */
export class WireEncoder {
  readonly stats: WireStats = { frames: 0, quantizeMs: 0, writeMs: 0, headerMs: 0, sections: [] };
  private last: { bytes: Uint8Array; frame: WireFrame } | null = null;
  private delta: { base: WireFrame; frame: WireFrame; body: Uint8Array } | null = null;
  private readonly keys = new WeakMap<WireFrame, Uint8Array>();
  /** Les événements des derniers en-têtes, et leur texte arrondi. */
  private readonly rounded = new Map<string, string>();
  private readonly clock: () => number;

  /** `clock` : une horloge en ms, pour mesurer le travail (`stats`) ; le serveur donne la sienne. */
  constructor(clock: () => number = () => 0) {
    this.clock = clock;
  }

  /** Un fil vers un joueur. */
  stream(): WireStream {
    return new WireStream(this);
  }

  /** L'image quantifiée de cet instantané (la même pour tous les joueurs d'un envoi). */
  frameOf(snapshot: Uint8Array): WireFrame {
    const last = this.last;
    if (last && equalBytes(last.bytes, snapshot)) return last.frame;
    const t0 = this.clock();
    const frame = quantize(readSnapshot(snapshot));
    this.last = { bytes: snapshot.slice(), frame };
    this.stats.frames++;
    this.stats.quantizeMs += this.clock() - t0;
    return frame;
  }

  /** L'en-tête d'une image, ses nombres arrondis (`roundHeader`). */
  header(json: Uint8Array): Uint8Array {
    const t0 = this.clock();
    // Les événements sont les mêmes pour tous les joueurs d'un envoi (seuls le robot et le verrou de
    // chacun changent) : arrondis une fois. Le texte d'un en-tête de la salle commence par eux.
    const text = utf8Decode(json);
    const cut = text.startsWith(EVENTS_KEY) ? text.lastIndexOf(YOU_KEY) : -1;
    let out: Uint8Array;
    if (cut > EVENTS_KEY.length) {
      const events = text.slice(EVENTS_KEY.length, cut);
      let rounded = this.rounded.get(events);
      if (rounded === undefined) {
        rounded = roundEvents(events);
        // (deux à la fois : ceux de l'image, et la description du monde pour qui arrive)
        if (this.rounded.size >= 2) this.rounded.clear();
        this.rounded.set(events, rounded);
      }
      out = utf8Encode(EVENTS_KEY + rounded + text.slice(cut));
    } else {
      out = roundHeader(json);
    }
    this.stats.headerMs += this.clock() - t0;
    return out;
  }

  /** Le corps d'une image : complète (sans base), ou en écarts à `base`. */
  body(frame: WireFrame, base: WireFrame | null): Uint8Array {
    if (!base) {
      let key = this.keys.get(frame);
      if (!key) {
        key = this.write(frame, null);
        this.keys.set(frame, key);
      }
      return key;
    }
    const d = this.delta;
    if (d && d.base === base && d.frame === frame) return d.body;
    const body = this.write(frame, base);
    this.delta = { base, frame, body };
    return body;
  }

  private write(frame: WireFrame, base: WireFrame | null): Uint8Array {
    const t0 = this.clock();
    const w = new ByteWriter();
    writeBody(w, frame, base, this.stats.sections);
    const out = w.finish();
    this.stats.writeMs += this.clock() - t0;
    return out;
  }
}

/**
 * L'en-tête JSON, les nombres réels de ses événements arrondis au 1/10000 : leurs chiffres au-delà,
 * presque aléatoires, la compression n'y peut rien (5 Ko/s d'en-têtes compressés en bataille au lieu
 * de 3). Pas la description d'un robot (`bot` : son plan, ses réglages) ni les règles d'une partie
 * (`match`), gardées exactes, ni un nombre entier (les identifiants), ni le reste de l'en-tête (le
 * verrouillage du joueur : un nombre par image).
 */
export function roundHeader(json: Uint8Array): Uint8Array {
  const header = JSON.parse(utf8Decode(json)) as Record<string, unknown>;
  const exact = new WeakSet<object>();
  for (const [key, value] of Object.entries(header)) if (key !== "events" && typeof value === "object" && value !== null) exact.add(value);
  return utf8Encode(JSON.stringify(header, rounding(exact)));
}

/** Le texte JSON d'une liste d'événements, arrondi comme dans `roundHeader`. */
function roundEvents(text: string): string {
  return JSON.stringify(JSON.parse(text), rounding(new WeakSet()));
}

/** Ce qui arrondit les nombres réels, sauf dans ce qui est exact (`exact`, et ce qu'il contient : on y ajoute au fil du parcours). */
function rounding(exact: WeakSet<object>): (this: unknown, key: string, v: unknown) => unknown {
  return function (this: unknown, _key: string, v: unknown): unknown {
    const inside = typeof this === "object" && this !== null && exact.has(this);
    if (typeof v === "object" && v !== null) {
      const t = (v as { t?: unknown }).t;
      if (inside || t === "bot" || t === "match") exact.add(v);
      return v;
    }
    return !inside && typeof v === "number" && Number.isFinite(v) && !Number.isInteger(v) ? Math.round(v * EVENT_PRECISION) / EVENT_PRECISION : v;
  };
}

/** Le début d'un en-tête de la salle, et ce qui suit ses événements (`{ events, you, lock }`, dans cet ordre). */
const EVENTS_KEY = '{"events":';
const YOU_KEY = ',"you":';

/** La fin de l'en-tête d'une image qui dit à la réplique d'oublier son monde (`FrameHeader.reset`, écrit en dernier par la salle). */
const RESET_TAIL = utf8Encode(',"reset":true}');

function endsWith(bytes: Uint8Array, tail: Uint8Array): boolean {
  if (bytes.length < tail.length) return false;
  const from = bytes.length - tail.length;
  for (let k = 0; k < tail.length; k++) if (bytes[from + k] !== tail[k]) return false;
  return true;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
}

/**
 * Le fil vers un joueur : chaque image de la salle (`encodeFrame`) devient une image du fil, en écarts
 * à la précédente qu'il a reçue (complète pour la première). Ne lui passer que ce qui part vraiment.
 */
export class WireStream {
  private base: WireFrame | null = null;
  private seq = 0;
  private readonly encoder: WireEncoder;

  constructor(encoder: WireEncoder) {
    this.encoder = encoder;
  }

  encode(frame: Uint8Array): Uint8Array {
    const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, true);
    const json = frame.subarray(4, 4 + length);
    // Une salle relancée après une erreur (server/roomHost.ts, `FrameHeader.reset`, la dernière clé de
    // l'en-tête) : un monde neuf, dont les entités ne suivent pas celles de l'image d'avant ; complète
    if (endsWith(json, RESET_TAIL)) this.base = null;
    const header = this.encoder.header(json);
    const current = this.encoder.frameOf(frame.subarray(4 + length));
    const body = this.encoder.body(current, this.base);
    const w = new ByteWriter();
    w.u8(this.base ? DELTA : KEY);
    this.seq = this.base ? (this.seq + 1) & 255 : 0;
    w.u8(this.seq);
    w.varint(header.length);
    w.bytes(header);
    w.bytes(body);
    this.base = current;
    return w.finish();
  }

  /** La prochaine image sera complète. */
  restart(): void {
    this.base = null;
  }
}

/** Une image du fil, décodée : son en-tête, et l'instantané que lit la réplique. */
export interface WireMessage {
  header: FrameHeader;
  snapshot: Snapshot;
}

/** Côté client : les images du fil, dans l'ordre où elles arrivent, en images que lit la réplique. */
export class WireDecoder {
  private base: WireFrame | null = null;
  private seq = 0;

  /** Un décodeur au même point du fil (les images gardées ne changent plus : elles se partagent). */
  fork(): WireDecoder {
    const copy = new WireDecoder();
    copy.base = this.base;
    copy.seq = this.seq;
    return copy;
  }

  /** Décode une image ; `WireError` si elle est illisible (le décodeur ne s'en sert alors pas de base). */
  decode(bytes: Uint8Array): WireMessage {
    try {
      const r = new ByteReader(bytes);
      const kind = r.u8();
      const seq = r.u8();
      if (kind === DELTA) {
        if (!this.base || seq !== ((this.seq + 1) & 255)) throw new WireError("image qui ne suit pas la précédente");
      } else if (kind !== KEY) {
        throw new WireError("genre d'image inconnu");
      }
      const header = JSON.parse(utf8Decode(r.take(r.count(1)))) as FrameHeader;
      if (!header || typeof header !== "object" || !Array.isArray(header.events)) throw new WireError("en-tête illisible");
      const frame = readBody(r, kind === DELTA ? this.base : null);
      const snapshot = expand(frame);
      this.base = frame;
      this.seq = seq;
      return { header, snapshot };
    } catch (e) {
      if (e instanceof WireError) throw e;
      throw new WireError(e instanceof Error ? e.message : String(e));
    }
  }
}
