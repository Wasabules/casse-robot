import { mechanicsState } from "../combat/mechanics";
import { flapRuns } from "../robot/surfaces";
import type { Quat, Vec3 } from "../math/vec";
import type { AiMode, Bot, MeleeBite, SwingPhase, Team } from "../sim/entities";
import type { ImpactSurface } from "../sim/events";
import type { Simulation } from "../sim/simulation";
import { Reader, Writer } from "./binary";
import { MODE_CODES, MODES_BY_CODE } from "./protocol";

/*
 * Instantané binaire du monde, à chaque image : temps, état de la partie, ennemis repérés, état
 * des robots (énergie, mode, tourelles, moteurs, gouvernes, appuis), puis les poses des corps
 * (morceaux, roues et porte-moyeux, débris, accessoires) et des projectiles. Les identifiants sont
 * ceux des entités de la simulation ; le client ignore ceux qu'il ne connaît pas encore.
 */

export interface BodyPose {
  pos: Vec3;
  rot: Quat;
}

export interface PartState extends BodyPose {
  vel: Vec3;
  ang: Vec3;
  /** Centre de masse (monde), et masse (kg). */
  com: Vec3;
  mass: number;
}

export interface WheelState extends BodyPose {
  /** Morceau porteur (0 : roue arrachée). */
  part: number;
  /** Porte-moyeu, s'il existe encore. */
  hub: BodyPose | null;
  drive: number;
  steer: number;
}

export interface PropState extends BodyPose {
  /** 0 intact, 1 mèche allumée, 2 gaz qui fuit (par `leak`, direction dans le repère de l'accessoire). */
  state: number;
  leak: Vec3;
}

export interface ProjectileState {
  pos: Vec3;
  vel: Vec3;
  age: number;
}

export interface TurretState {
  yaw: number;
  pitch: number;
  ammo: number;
  heat: number;
  overheated: boolean;
  cooldown: number;
  /** Temps passé à recharger le coup suivant (s). */
  restock: number;
}

export interface BotState {
  player: boolean;
  energy: number;
  /** Salves de leurres prêtes. */
  flares: number;
  mode: AiMode;
  stunnedUntil: number;
  righting: number;
  flippedFor: number;
  /** Dernier ennemi qui l'a touché (0 : aucun). */
  lastAttacker: number;
  lastPos: Vec3;
  /** Par identifiant de bloc. */
  turrets: Map<number, TurretState>;
  thrusters: Map<number, { thrust: number; tiltA: number; tiltB: number }>;
  /** Braquage de chaque rang de gouvernes, par identifiant de l'un de ses blocs. */
  surfaces: Map<number, number>;
  supports: Map<number, { contact: number; force: number; phase: number }>;
  /**
   * Armes de contact, par identifiant de bloc : régime (rad/s), phase du bras (rang dans
   * `SWING_PHASES`) et son angle, la morsure en cours d'une lame qui mord (ou null) ; et ce qui est
   * propre à une frappe à mécanique (`mechanicsState`, combat/mechanics.ts) : le bloc que tient une
   * mâchoire (`link`, 0 : rien), et des nombres (`values` : la manivelle et la boule d'un fléau).
   */
  melee: Map<number, MeleeSnap>;
}

/** Phases d'un bras dans l'instantané (l'ordre importe). */
const SWING_PHASES: readonly SwingPhase[] = ["ready", "strike", "recover", "hold"];
/** Ce que mord une lame, dans l'instantané (rang + 1 ; 0 : rien ; l'ordre importe). */
const BITE_SURFACES: readonly ImpactSurface[] = ["robot", "prop", "scenery", "projectile"];
/** Drapeau d'une morsure qui glisse (ricochet), avec le rang de sa surface. */
const BITE_GLANCE = 0x80;

/** Une arme de contact dans l'instantané (voir `BotSnapshot.melee`). */
export interface MeleeSnap {
  spin: number;
  phase: SwingPhase;
  swing: number;
  bite: MeleeBite | null;
  link: number;
  values: number[];
}

export interface MatchState {
  score: Record<Team, number>;
  elapsed: number;
  winner: Team | "draw" | null;
  /** Robots qui attendent de réapparaître, et quand (temps simulé). */
  respawns: [bot: number, at: number][];
  /** Zones à capturer : équipe qui la tient, avancement de la prise, disputée. */
  zones: [owner: Team | null, progress: number, contested: boolean, active: boolean][];
}

export interface Snapshot {
  time: number;
  match: MatchState | null;
  detected: Record<Team, number[]>;
  bots: Map<number, BotState>;
  parts: Map<number, PartState>;
  wheels: Map<number, WheelState>;
  debris: Map<number, BodyPose>;
  props: Map<number, PropState>;
  projectiles: Map<number, ProjectileState>;
}

const TEAMS: readonly Team[] = ["red", "blue"];
const WINNERS: readonly (Team | "draw" | null)[] = [null, "red", "blue", "draw"];
const OWNERS: readonly (Team | null)[] = [null, "red", "blue"];
/** Munitions illimitées (armes sans chargeur). */
const NO_AMMO = 255;

export function writeSnapshot(sim: Simulation): Uint8Array {
  const w = new Writer();
  w.f64(sim.time);

  const match = sim.match;
  w.u8(match ? 1 : 0);
  if (match) {
    // En capture de zones, le score gagne des fractions de point : on envoie la partie entière
    w.u16(Math.floor(match.score.red));
    w.u16(Math.floor(match.score.blue));
    w.f32(match.elapsed);
    w.u8(WINNERS.indexOf(match.winner));
    w.u8(Math.min(255, match.respawns.length));
    for (const r of match.respawns.slice(0, 255)) {
      w.u32(r.bot.id);
      w.f32(r.at);
    }
    w.u8(match.zones.length);
    for (const z of match.zones) {
      w.u8(OWNERS.indexOf(z.owner));
      w.f32(z.progress);
      w.u8((z.contested ? 1 : 0) | (z.active ? 2 : 0));
    }
  }
  for (const team of TEAMS) {
    const seen = [...(sim.detected.get(team) ?? [])];
    w.u16(seen.length);
    for (const b of seen) w.u32(b.id);
  }

  w.u16(sim.bots.length);
  for (const bot of sim.bots) writeBot(w, bot);

  w.u16(sim.parts.size);
  for (const part of sim.parts) {
    const rb = part.rb;
    w.u32(part.id);
    w.vec3(rb.translation());
    w.quat(rb.rotation());
    w.vec3(rb.linvel());
    w.vec3(rb.angvel());
    w.vec3(rb.worldCom());
    w.f32(rb.mass());
  }

  // (une épave de roue retirée n'a plus de corps : elle n'est plus là)
  const wheels = sim.bots.flatMap((b) => b.wheels.filter((w) => w.part || w.body));
  w.u16(wheels.length);
  for (const wheel of wheels) {
    w.u32(wheel.id);
    w.vec3(wheel.rb.translation());
    w.quat(wheel.rb.rotation());
    w.u32(wheel.part?.id ?? 0);
    w.u8(wheel.hub ? 1 : 0);
    if (wheel.hub) {
      w.vec3(wheel.hub.translation());
      w.quat(wheel.hub.rotation());
    }
    w.f32(wheel.drive);
    w.f32(wheel.steer);
  }

  w.u16(sim.debris.length);
  for (const d of sim.debris) {
    w.u32(d.id);
    w.vec3(d.rb.translation());
    w.quat(d.rb.rotation());
  }

  // Un accessoire ancré ne bouge pas : la réplique le pose d'après son emplacement (voir replica.ts)
  const moving = sim.props.filter((p) => !p.fixed);
  w.u16(moving.length);
  for (const p of moving) {
    w.u32(p.id);
    w.vec3(p.rb.translation());
    w.quat(p.rb.rotation());
    const s = p.state;
    w.u8(s.kind === "intact" ? 0 : s.kind === "fuse" ? 1 : 2);
    w.f32(s.kind === "venting" ? s.leak.x : 0);
    w.f32(s.kind === "venting" ? s.leak.z : 0);
  }

  w.u16(sim.projectiles.length);
  for (const p of sim.projectiles) {
    w.u32(p.id);
    w.vec3(p.pos);
    w.vec3(p.vel);
    w.f32(p.age);
  }
  return w.finish();
}

function writeBot(w: Writer, bot: Bot): void {
  w.u32(bot.id);
  w.u8(bot.controller === "player" ? 1 : 0);
  w.f32(bot.energy);
  w.u8(Math.min(255, bot.flares.charges));
  w.u8(MODE_CODES[bot.ai.mode]);
  w.f32(bot.stunnedUntil);
  w.f32(bot.righting);
  w.f32(bot.flippedFor);
  w.u32(bot.lastAttacker?.id ?? 0);
  w.vec3(bot.lastPos);

  const turrets = bot.turrets.filter((t) => t.block.alive);
  w.u8(turrets.length);
  for (const t of turrets) {
    w.u32(t.block.id);
    w.f32(t.yaw);
    w.f32(t.pitch);
    w.u8(Number.isFinite(t.arm.ammo) ? Math.min(NO_AMMO - 1, t.arm.ammo) : NO_AMMO);
    w.f32(t.arm.heat);
    w.u8(t.arm.overheated ? 1 : 0);
    w.f32(t.arm.cooldown);
    w.f32(t.arm.restock);
  }
  const thrusters = bot.thrusters.filter((t) => t.block.alive);
  w.u8(thrusters.length);
  for (const t of thrusters) {
    w.u32(t.block.id);
    w.f32(t.thrust);
    w.f32(t.tiltA);
    w.f32(t.tiltB);
  }
  // Gouvernes : un braquage par rang (tous ses blocs braquent du même angle, voir robot/surfaces.ts),
  // nommé par l'un de ses blocs ; la réplique retrouve les mêmes rangs d'après ses blocs vivants
  const runs = flapRuns(bot);
  w.u8(runs.length);
  for (const run of runs) {
    w.u32(run[0].block.id);
    w.f32(run[0].deflection);
  }
  const supports = bot.supports.filter((s) => s.block.alive);
  w.u8(supports.length);
  for (const s of supports) {
    w.u32(s.block.id);
    w.f32(s.contact);
    w.f32(s.force);
    w.f32(s.phase);
  }
  const melee = bot.melee.filter((a) => a.block.alive);
  w.u8(melee.length);
  for (const a of melee) {
    w.u32(a.block.id);
    w.f32(a.spin);
    w.u8(SWING_PHASES.indexOf(a.phase));
    w.f32(a.swing);
    // La morsure en cours : où, dans quel sens, sur quoi, avec quelle puissance
    const bite = a.bite;
    w.u8(bite ? (BITE_SURFACES.indexOf(bite.surface) + 1) | (bite.glance ? BITE_GLANCE : 0) : 0);
    if (bite) {
      w.vec3(bite.point);
      w.vec3(bite.dir);
      w.f32(bite.power);
    }
    // Une frappe à mécanique : ce que tient une mâchoire, la boule d'un fléau
    const extra = mechanicsState(a);
    w.u32(extra.link);
    w.u8(extra.values.length);
    for (const x of extra.values) w.f32(x);
  }
}

export function readSnapshot(bytes: Uint8Array): Snapshot {
  const r = new Reader(bytes);
  const time = r.f64();

  let match: MatchState | null = null;
  if (r.u8()) {
    const red = r.u16();
    const blue = r.u16();
    const elapsed = r.f32();
    const winner = WINNERS[r.u8()] ?? null;
    const respawns: [number, number][] = [];
    for (let n = r.u8(); n > 0; n--) respawns.push([r.u32(), r.f32()]);
    const zones: [Team | null, number, boolean, boolean][] = [];
    for (let n = r.u8(); n > 0; n--) {
      const owner = OWNERS[r.u8()] ?? null;
      const progress = r.f32();
      const flags = r.u8();
      zones.push([owner, progress, (flags & 1) !== 0, (flags & 2) !== 0]);
    }
    match = { score: { red, blue }, elapsed, winner, respawns, zones };
  }
  const detected = { red: [] as number[], blue: [] as number[] };
  for (const team of TEAMS) for (let n = r.u16(); n > 0; n--) detected[team].push(r.u32());

  const bots = new Map<number, BotState>();
  for (let n = r.u16(); n > 0; n--) {
    const id = r.u32();
    bots.set(id, readBot(r));
  }

  const parts = new Map<number, PartState>();
  for (let n = r.u16(); n > 0; n--) {
    const id = r.u32();
    parts.set(id, { pos: r.vec3(), rot: r.quat(), vel: r.vec3(), ang: r.vec3(), com: r.vec3(), mass: r.f32() });
  }

  const wheels = new Map<number, WheelState>();
  for (let n = r.u16(); n > 0; n--) {
    const id = r.u32();
    const pos = r.vec3();
    const rot = r.quat();
    const part = r.u32();
    const hub = r.u8() ? { pos: r.vec3(), rot: r.quat() } : null;
    wheels.set(id, { pos, rot, part, hub, drive: r.f32(), steer: r.f32() });
  }

  const debris = new Map<number, BodyPose>();
  for (let n = r.u16(); n > 0; n--) {
    const id = r.u32();
    debris.set(id, { pos: r.vec3(), rot: r.quat() });
  }

  const props = new Map<number, PropState>();
  for (let n = r.u16(); n > 0; n--) {
    const id = r.u32();
    const pos = r.vec3();
    const rot = r.quat();
    const state = r.u8();
    const x = r.f32();
    const z = r.f32();
    props.set(id, { pos, rot, state, leak: { x, y: 0, z } });
  }

  const projectiles = new Map<number, ProjectileState>();
  for (let n = r.u16(); n > 0; n--) {
    const id = r.u32();
    projectiles.set(id, { pos: r.vec3(), vel: r.vec3(), age: r.f32() });
  }
  return { time, match, detected, bots, parts, wheels, debris, props, projectiles };
}

function readBot(r: Reader): BotState {
  const player = r.u8() === 1;
  const energy = r.f32();
  const flares = r.u8();
  const mode = MODES_BY_CODE[r.u8()] ?? "patrol";
  const stunnedUntil = r.f32();
  const righting = r.f32();
  const flippedFor = r.f32();
  const lastAttacker = r.u32();
  const lastPos = r.vec3();
  const turrets = new Map<number, TurretState>();
  for (let n = r.u8(); n > 0; n--) {
    const id = r.u32();
    const yaw = r.f32();
    const pitch = r.f32();
    const ammo = r.u8();
    turrets.set(id, { yaw, pitch, ammo: ammo === NO_AMMO ? Infinity : ammo, heat: r.f32(), overheated: r.u8() === 1, cooldown: r.f32(), restock: r.f32() });
  }
  const thrusters = new Map<number, { thrust: number; tiltA: number; tiltB: number }>();
  for (let n = r.u8(); n > 0; n--) {
    const id = r.u32();
    thrusters.set(id, { thrust: r.f32(), tiltA: r.f32(), tiltB: r.f32() });
  }
  const surfaces = new Map<number, number>();
  for (let n = r.u8(); n > 0; n--) {
    const id = r.u32();
    surfaces.set(id, r.f32());
  }
  const supports = new Map<number, { contact: number; force: number; phase: number }>();
  for (let n = r.u8(); n > 0; n--) {
    const id = r.u32();
    supports.set(id, { contact: r.f32(), force: r.f32(), phase: r.f32() });
  }
  const melee = new Map<number, MeleeSnap>();
  for (let n = r.u8(); n > 0; n--) {
    const id = r.u32();
    const spin = r.f32();
    const phase = SWING_PHASES[r.u8()] ?? "ready";
    const swing = r.f32();
    const flags = r.u8();
    let bite: MeleeBite | null = null;
    if (flags) {
      const point = r.vec3();
      const dir = r.vec3();
      bite = { point, dir, power: r.f32(), surface: BITE_SURFACES[(flags & ~BITE_GLANCE) - 1] ?? "robot", glance: (flags & BITE_GLANCE) !== 0 };
    }
    const link = r.u32();
    const values: number[] = [];
    for (let k = r.u8(); k > 0; k--) values.push(r.f32());
    melee.set(id, { spin, phase, swing, bite, link, values });
  }
  return { player, energy, flares, mode, stunnedUntil, righting, flippedFor, lastAttacker, lastPos, turrets, thrusters, surfaces, supports, melee };
}
