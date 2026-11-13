import type { ArenaKey } from "../arena/layout";
import type { ExplosionLook, KillCause, WeaponId } from "../catalog/weapons";
import type { PropType } from "../catalog/props";
import type { BlockType } from "../catalog/blocks";
import { cellKey } from "../design/robotDesign";
import type { BotProfile } from "../design/presets";
import type { Vec3 } from "../math/vec";
import type { BotDesc, NetEvent } from "../net/protocol";
import { utf8Decode } from "../net/binary";
import type { Team } from "../sim/entities";
import type { ImpactSurface, MineAction } from "../sim/events";

/*
 * Le journal des événements de la simulation portée (crates/casse-sim/src/sim/events.rs), lu et
 * traduit en événements réseau comme l'encodeur du TypeScript traduit ceux de `Simulation`
 * (src/shared/net/encoder.ts) : mêmes champs, dans le même ordre (les images doivent être les mêmes,
 * octet pour octet), et un robot apparu depuis la dernière image décrit en entier au moment de
 * l'envoi, les événements qui le concernent entre-temps laissés de côté.
 */

/** Les codes des événements du journal (crates/casse-sim/src/sim/events.rs : l'ordre importe). */
export const CODE = {
  botAdded: 1, botRemoved: 2, partAdded: 3, partRemoved: 4, blockAttached: 5, blockDamaged: 6, blockRepaired: 7, blockDestroyed: 8,
  blockRebuilt: 9, wheelRemoved: 10, debrisAdded: 11, debrisRemoved: 12, propAdded: 13, propRemoved: 14, propReleased: 15, propFire: 16,
  groundFireAdded: 17, groundFireRemoved: 18, projectileAdded: 19, projectileRemoved: 20, shot: 21, mine: 22, impact: 23, explosion: 24,
  meleeHit: 25, collision: 26, linkBroken: 27, fireStarted: 28, fireEnded: 29, empBurst: 30, stunned: 31, organsStunned: 32, shieldHit: 33,
  barrierAdded: 34, barrierHit: 35, barrierRemoved: 36, smokeAdded: 37, smokeRemoved: 38, hit: 39, botKilled: 40, arenaChanged: 41,
  zoneChanged: 42, matchOver: 43, damage: 44, wheelAdded: 45,
} as const;

const TEAMS: readonly Team[] = ["red", "blue"];
const SURFACES: readonly ImpactSurface[] = ["robot", "prop", "scenery", "projectile"];
const MINE_ACTIONS: readonly MineAction[] = ["bounce", "stick", "ping"];

/** Un événement du journal : son code, le robot qu'il concerne (`subjectOf`), et ce qu'il devient sur le réseau. */
export interface LoggedEvent {
  code: number;
  /** Le robot concerné (un robot apparu dans l'image : l'événement n'est pas transmis). */
  subject: number | null;
  /** L'événement réseau (null : rien, ou fait par l'encodeur : un robot, sa disparition, les robots touchés). */
  net: NetEvent | null;
  /** Un robot qui apparaît, disparaît, est détruit : son numéro ; et (apparition) l'instant et son profil. */
  bot?: number;
  time?: number;
  profile?: number;
  /** Les robots touchés (`damage`), un tueur (`botKilled`). */
  bots?: number[];
  killer?: number | null;
  cause?: KillCause | null;
  /** Un robot détruit : son équipe, celle de son tueur, et le pilote aux commandes de son tueur (son rang). */
  team?: Team;
  killerTeam?: Team | null;
  killerSlot?: number | null;
}

/** Lecture du journal : des nombres de 8 octets et des textes (longueur sur 4 octets, puis UTF-8). */
class LogReader {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  at = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get done(): boolean {
    return this.at >= this.bytes.length;
  }

  code(): number {
    return this.bytes[this.at++];
  }

  num(): number {
    const v = this.view.getFloat64(this.at, true);
    this.at += 8;
    return v;
  }

  /** Un numéro d'entité, ou null (-1). */
  id(): number | null {
    const v = this.num();
    return v < 0 ? null : v;
  }

  flag(): boolean {
    return this.num() !== 0;
  }

  vec(): Vec3 {
    return { x: this.num(), y: this.num(), z: this.num() };
  }

  maybe(): string | null {
    const n = this.view.getUint32(this.at, true);
    this.at += 4;
    if (n === 0xffffffff) return null;
    const text = utf8Decode(this.bytes.subarray(this.at, this.at + n));
    this.at += n;
    return text;
  }

  text(): string {
    return this.maybe() ?? "";
  }
}

/** Ce que la lecture du journal doit savoir de la partie : l'arène en place, les profils (la couleur d'un débris). */
export interface LogContext {
  arena: ArenaKey;
  profiles: readonly BotProfile[];
}

/** Lit un journal, événement par événement. */
export function readLog(bytes: Uint8Array, ctx: LogContext): LoggedEvent[] {
  const r = new LogReader(bytes);
  const out: LoggedEvent[] = [];
  while (!r.done) out.push(readEvent(r, r.code(), ctx));
  return out;
}

function readEvent(r: LogReader, code: number, ctx: LogContext): LoggedEvent {
  const ev = (net: NetEvent | null, subject: number | null = null): LoggedEvent => ({ code, subject, net });
  switch (code) {
    case CODE.botAdded: {
      const bot = r.num();
      const time = r.num();
      const profile = r.num();
      return { code, subject: null, net: null, bot, time, profile };
    }
    case CODE.botRemoved: {
      const bot = r.num();
      return { code, subject: bot, net: { t: "botGone", id: bot }, bot };
    }
    case CODE.partAdded: {
      const id = r.num();
      const bot = r.num();
      return ev({ t: "part", id, bot }, bot);
    }
    case CODE.partRemoved: {
      const id = r.num();
      return ev({ t: "partGone", id }, r.num());
    }
    case CODE.blockAttached: {
      const block = r.num();
      const part = r.num();
      return ev({ t: "attach", block, part }, r.num());
    }
    case CODE.blockDamaged:
    case CODE.blockRepaired: {
      const block = r.num();
      const hp = r.num();
      return ev({ t: "hp", block, hp, repaired: code === CODE.blockRepaired }, r.num());
    }
    case CODE.blockDestroyed: {
      const block = r.num();
      return ev({ t: "destroyed", block }, r.num());
    }
    case CODE.blockRebuilt: {
      const block = r.num();
      const part = r.num();
      const key = cellKey(r.num(), r.num(), r.num());
      const hp = r.num();
      return ev({ t: "rebuilt", block, part, key, hp }, r.num());
    }
    case CODE.wheelAdded: {
      r.num();
      return ev(null, r.num());
    }
    case CODE.wheelRemoved: {
      const id = r.num();
      return ev({ t: "wheelGone", id }, r.num());
    }
    case CODE.debrisAdded:
      return ev(readDebris(r, ctx));
    case CODE.debrisRemoved:
      return ev({ t: "debrisGone", id: r.num() });
    case CODE.propAdded: {
      const id = r.num();
      const type = r.text() as PropType;
      const spot = r.num();
      return ev({ t: "prop", id, type, spot, fixed: r.flag() });
    }
    case CODE.propRemoved:
      return ev({ t: "propGone", id: r.num() });
    case CODE.propReleased:
      return ev({ t: "propFree", id: r.num() });
    case CODE.propFire: {
      const id = r.num();
      const burning = r.flag();
      return ev({ t: "propFire", id, burning, charred: r.num() });
    }
    case CODE.groundFireAdded:
      return ev(readGroundFire(r));
    case CODE.groundFireRemoved:
      return ev({ t: "groundFireGone", id: r.num() });
    case CODE.projectileAdded: {
      const id = r.num();
      const weapon = r.text() as WeaponId;
      return ev({ t: "projectile", id, weapon, shooter: r.id() });
    }
    case CODE.projectileRemoved:
      return ev({ t: "projectileGone", id: r.num() });
    case CODE.shot: {
      const weapon = r.text() as WeaponId;
      const origin = r.vec();
      return ev({ t: "shot", weapon, origin, dir: r.vec() });
    }
    case CODE.mine: {
      const id = r.num();
      return ev({ t: "mine", id, action: MINE_ACTIONS[r.num()] });
    }
    case CODE.impact: {
      const point = r.vec();
      return ev({ t: "impact", point, surface: SURFACES[r.num()] });
    }
    case CODE.explosion: {
      const point = r.vec();
      const radius = r.num();
      return ev({ t: "explosion", point, radius, look: r.text() as ExplosionLook });
    }
    case CODE.meleeHit: {
      const block = r.num();
      const point = r.vec();
      const dir = r.vec();
      const energy = r.num();
      const surface = SURFACES[r.num()];
      return ev({ t: "melee", block, point, dir, energy, surface, glance: r.flag() });
    }
    case CODE.collision: {
      const point = r.vec();
      return ev({ t: "collision", point, strength: r.num() });
    }
    case CODE.linkBroken:
      return ev({ t: "link", point: r.vec() });
    case CODE.fireStarted: {
      const block = r.num();
      return ev({ t: "fire", block }, r.num());
    }
    case CODE.fireEnded: {
      const block = r.num();
      return ev({ t: "fireOut", block }, r.num());
    }
    case CODE.empBurst: {
      const point = r.vec();
      return ev({ t: "emp", point, radius: r.num() });
    }
    case CODE.stunned: {
      const bot = r.num();
      return ev({ t: "stunned", bot, until: r.num() }, bot);
    }
    case CODE.organsStunned:
      return readShock(r, code);
    case CODE.shieldHit: {
      const block = r.num();
      return ev({ t: "shield", block }, r.num());
    }
    case CODE.barrierAdded:
      return ev(readBarrier(r));
    case CODE.barrierHit: {
      const id = r.num();
      const hp = r.num();
      return ev({ t: "barrierHit", id, hp, point: r.vec() });
    }
    case CODE.barrierRemoved: {
      const id = r.num();
      return ev({ t: "barrierGone", id, broken: r.flag() });
    }
    case CODE.smokeAdded:
      return ev(readSmoke(r));
    case CODE.smokeRemoved:
      return ev({ t: "smokeGone", id: r.num() });
    case CODE.hit: {
      const victim = r.num();
      const attacker = r.id();
      const cause = r.maybe() as KillCause | null;
      return ev({ t: "hit", victim, attacker, cause, destroyed: r.num() }, victim);
    }
    case CODE.botKilled: {
      const bot = r.num();
      const killer = r.id();
      const cause = r.maybe() as KillCause | null;
      const time = r.num();
      const team = TEAMS[r.num()];
      const killerTeam = r.num();
      const slot = r.num();
      return {
        code, subject: bot, net: { t: "killed", bot, killer, cause }, bot, killer, cause, time, team,
        killerTeam: killerTeam < 0 ? null : TEAMS[killerTeam], killerSlot: slot < 0 ? null : slot,
      };
    }
    case CODE.arenaChanged:
      return ev({ t: "arena", id: ctx.arena });
    case CODE.zoneChanged: {
      const zone = r.num();
      const owner = r.num();
      return ev({ t: "zone", zone, owner: owner < 0 ? null : TEAMS[owner], by: TEAMS[r.num()] });
    }
    case CODE.matchOver: {
      const w = r.num();
      return ev({ t: "over", winner: w === 2 ? "draw" : TEAMS[w] });
    }
    case CODE.damage: {
      const bots: number[] = [];
      for (let n = r.num(); n > 0; n--) bots.push(r.num());
      return { code, subject: null, net: null, bots };
    }
    default:
      throw new Error(`journal de la simulation illisible : code ${code}`);
  }
}

function readDebris(r: LogReader, ctx: LogContext): NetEvent {
  const id = r.num();
  const kind = r.num();
  const type = r.text();
  const look = kind === 0
    ? { kind: "block" as const, type: type as BlockType, color: ctx.profiles[r.num()]?.color ?? "#888888" }
    : { kind: "prop" as const, type: type as PropType, size: sized(r.num()) };
  const born = r.num();
  return { t: "debris", id, look, born, life: r.num() };
}

/** Le côté d'un éclat (NaN : il n'en a pas ; la clé reste, comme celle d'un `undefined` que JSON ignore). */
const sized = (size: number): number | undefined => (Number.isNaN(size) ? undefined : size);

function readGroundFire(r: LogReader): NetEvent {
  const id = r.num();
  const pos = r.vec();
  const radius = r.num();
  return { t: "groundFire", id, pos, radius, until: r.num() };
}

function readSmoke(r: LogReader): NetEvent {
  const id = r.num();
  const pos = r.vec();
  const radius = r.num();
  const born = r.num();
  return { t: "smoke", id, pos, radius, born, life: r.num() };
}

function readBarrier(r: LogReader): NetEvent {
  const id = r.num();
  const team = TEAMS[r.num()];
  const center = r.vec();
  const normal = r.vec();
  const width = r.num();
  const height = r.num();
  const hp = r.num();
  const maxHp = r.num();
  return { t: "barrier", id, team, center, normal, width, height, hp, maxHp, until: r.num() };
}

function readShock(r: LogReader, code: number): LoggedEvent {
  const bot = r.num();
  const blocks: number[] = [];
  for (let n = r.num(); n > 0; n--) blocks.push(r.num());
  const wheels: number[] = [];
  for (let n = r.num(); n > 0; n--) wheels.push(r.num());
  const until = r.num();
  const point = r.flag() ? r.vec() : null;
  return { code, subject: bot, net: { t: "shock", bot, blocks, wheels, until, point } };
}

/**
 * Description d'un robot (`describeBot`), d'après celle du module (crates/casse-sim/src/sim/net.rs) :
 * son profil est celui que la session lui a donné (`profiles`).
 */
export function readBotDesc(id: number, bytes: Uint8Array, profiles: readonly BotProfile[]): BotDesc {
  const r = new LogReader(bytes);
  const team = TEAMS[r.num()];
  const controller = r.flag() ? "player" : "ai";
  const profile = profiles[r.num()];
  const parts: number[] = [];
  for (let n = r.num(); n > 0; n--) parts.push(r.num());
  const blocks: BotDesc["blocks"] = [];
  for (let n = r.num(); n > 0; n--) {
    const key = cellKey(r.num(), r.num(), r.num());
    blocks.push([key, r.num(), r.num(), r.num(), r.num()]);
  }
  const cockpit = r.num();
  const wheels: BotDesc["wheels"] = [];
  const count = r.num();
  for (let i = 0; i < count; i++) wheels.push([i, r.num(), r.num()]);
  const cuts: string[] = [];
  for (let n = r.num(); n > 0; n--) {
    const a = cellKey(r.num(), r.num(), r.num());
    const b = cellKey(r.num(), r.num(), r.num());
    // (`linkKey` : les deux clés dans l'ordre des textes)
    cuts.push(a < b ? `${a}|${b}` : `${b}|${a}`);
  }
  return { id, profile, team, controller, parts, blocks, cockpit, wheels, cuts };
}

/**
 * Les événements réseau d'une image (l'encodeur, src/shared/net/encoder.ts) : un robot apparu est
 * décrit au moment de l'envoi (`describe`), et ce qui le concerne entre-temps n'est pas transmis ; un
 * robot apparu et retiré dans la même image, on n'en parle pas.
 */
export class NativeEncoder {
  /** Événements de l'image en cours ; un robot apparu tient la place de sa description (son numéro). */
  private events: (NetEvent | number)[] = [];
  private readonly fresh = new Set<number>();

  /** Un événement qui ne vient pas de la simulation (début ou fin d'une partie). */
  push(event: NetEvent): void {
    this.events.push(event);
  }

  record(e: LoggedEvent): void {
    if (e.subject !== null && this.fresh.has(e.subject) && e.code !== CODE.botRemoved) return;
    switch (e.code) {
      case CODE.botAdded:
        this.fresh.add(e.bot!);
        this.events.push(e.bot!);
        return;
      case CODE.botRemoved:
        if (this.fresh.has(e.bot!)) {
          this.fresh.delete(e.bot!);
          this.events = this.events.filter((x) => x !== e.bot);
        } else {
          this.events.push(e.net!);
        }
        return;
      case CODE.damage:
        this.events.push({ t: "damage", bots: e.bots!.filter((b) => !this.fresh.has(b)) });
        return;
      default:
        if (e.net) this.events.push(e.net);
    }
  }

  /** Les événements depuis la dernière image, les robots apparus décrits dans leur état actuel. */
  take(describe: (bot: number) => BotDesc): NetEvent[] {
    const out = this.events.map((e): NetEvent => (typeof e === "number" ? { t: "bot", bot: describe(e) } : e));
    this.events = [];
    this.fresh.clear();
    return out;
  }
}
