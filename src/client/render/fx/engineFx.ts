import { groundLevel, type ArenaLayout } from "../../../shared/arena/layout";
import { rayArena } from "../../../shared/arena/ray";
import { blockDef } from "../../../shared/catalog/blocks";
import { wheelDef } from "../../../shared/catalog/wheels";
import { GRAVITY } from "../../../shared/config";
import { isStunned, localStuns } from "../../../shared/combat/emp";
import { clamp } from "../../../shared/math/scalar";
import { add, cross, distance, dot, len, norm, qrot, scale, sub, vec3, type Vec3 } from "../../../shared/math/vec";
import { energyCapacity, energyFraction } from "../../../shared/robot/energy";
import { ENGINE_WORN, engineHealth } from "../../../shared/robot/propulsion";
import { blockWorldPos, liveThrusters } from "../../../shared/robot/queries";
import type { Block, Bot, Part, Thruster } from "../../../shared/sim/entities";
import { groundColor } from "../arenaView";
import { emissions, FX_RANGE, type FxContext, type FxSystem } from "./fx";
import { jitter } from "./layer";
import type { PuffSpec } from "./particles";
import type { StreakSpec } from "./streaks";
import { LiveSet } from "./tracking";
import { JET_NACELLE } from "../../../shared/design/clearance";

/*
 * Effets des moteurs et du vol : moteur abîmé qui fume, aile touchée, postcombustion et traînées
 * de condensation des turboréacteurs, tourbillons de bout d'aile, souffle des rotors au sol,
 * patins anti-gravité, échappement des robots à roues, paralysie, avion abattu. Tout se lit dans
 * le monde affiché (la poussée, les points de structure, les vitesses) : en réseau aussi.
 */

/** Au viseur, pas de fumée de ses propres moteurs à moins de cette distance de l'objectif (m) : elle boucherait la vue. */
const OWN_NEAR = 5;
/** Distance du centre d'un turboréacteur au bout de sa tuyère (m), comme sa flamme (WorldView) : la cote de sa nacelle. */
const JET_NOZZLE = JET_NACELLE.nozzle;

type Carry = { acc: number };
/** Reste de cadence de chaque source d'effet (voir `emissions`). */
class Rates {
  private readonly carries = new WeakMap<object, Carry>();
  count(key: object, rate: number, dt: number): number {
    let c = this.carries.get(key);
    if (!c) {
      c = { acc: Math.random() };
      this.carries.set(key, c);
    }
    return emissions(c, rate, dt);
  }
}

const spread = (r: number): Vec3 => vec3(jitter(-r, r), jitter(-r, r), jitter(-r, r));

/** Un point de ce robot à ne pas couvrir de fumée au viseur (voir `OWN_NEAR`). */
function tooClose(ctx: FxContext, bot: Bot, at: Vec3): boolean {
  return ctx.inside === bot && distance(at, ctx.eye) < OWN_NEAR;
}

/** Hauteur du sol ou du décor sous (x, z), en cherchant jusqu'à `depth` m sous `y`. */
function floorUnder(arena: ArenaLayout, x: number, y: number, z: number, depth: number): number {
  const hit = rayArena(arena, vec3(x, y, z), vec3(0, -1, 0), depth);
  const ground = groundLevel(arena, x, z);
  return hit !== null ? Math.max(y - hit, ground) : ground;
}

/** Poussière soulevée : la couleur du sol de l'arène (relief), un peu éclaircie ; béton clair sur une arène plate. */
const DUST_CACHE = new Map<string, string>();
function dustColor(arena: ArenaLayout, x: number, h: number, z: number): string {
  if (!arena.terrain) return "#8c8578";
  const key = `${arena.id}:${Math.round(x / 3)}:${Math.round(z / 3)}`;
  let c = DUST_CACHE.get(key);
  if (!c) {
    const g = groundColor(x, h, z, 1, arena.water ?? -Infinity, arena.paths ?? [], arena);
    const lift = (v: number): number => Math.min(1, v * 0.7 + 0.28);
    const hex = (v: number): string => Math.round(lift(v) * 255).toString(16).padStart(2, "0");
    c = `#${hex(g.r)}${hex(g.g)}${hex(g.b)}`;
    DUST_CACHE.set(key, c);
  }
  return c;
}

// --- 13, 17 : moteur abîmé, aile touchée ---

const WORN_SMOKE: PuffSpec = { color: "#8d9296", kind: "smoke", size: 0.3, grow: 1.5, life: 2.2, alpha: 0.5, fadeIn: 0.08, drag: 1.2, gravity: -0.7 };
const DEAD_SMOKE: PuffSpec = { color: "#26282b", kind: "smoke", size: 0.4, grow: 2, life: 3, alpha: 0.65, fadeIn: 0.06, drag: 1.2, gravity: -0.9 };
const ENGINE_SPARK: PuffSpec = { color: "#ffb347", kind: "glow", size: 0.07, life: 0.4, alpha: 1, drag: 0.8, gravity: 9.8, stretch: 0.03 };
const WING_SMOKE: PuffSpec = { color: "#a4a8ac", kind: "smoke", size: 0.2, grow: 1.1, life: 1.6, alpha: 0.4, fadeIn: 0.1, drag: 1.5, gravity: -0.4 };
const SHARD: PuffSpec = { color: "#3a3d40", kind: "smoke", size: 0.09, life: 1.3, alpha: 1, drag: 0.4, gravity: 9.8, stretch: 0.015, wind: 0 };
const CHIP: PuffSpec = { color: "#c9ccce", kind: "smoke", size: 0.06, life: 1.1, alpha: 1, drag: 0.6, gravity: 7, wind: 0.5 };
const HIT_SPARK: PuffSpec = { color: "#ffd27a", kind: "glow", size: 0.06, life: 0.25, alpha: 1, drag: 1, gravity: 6, stretch: 0.025 };

/**
 * Moteur abîmé (sous `ENGINE_WORN` de ses points) : il fume, gris, puis noir et épais sous 25 %,
 * avec des étincelles ; une aile ou une gouverne abîmée fume un peu. Un coup sur l'un d'eux en fait
 * sauter des éclats et des étincelles.
 */
export function engineDamage(ctx: FxContext): FxSystem {
  const rates = new Rates();
  const off = ctx.world.on((e) => {
    if (e.type !== "blockDamaged") return;
    const b = e.block;
    const def = blockDef(b.type);
    if (!b.alive || (!def.thruster && !def.aero)) return;
    const at = blockWorldPos(b);
    if (distance(at, ctx.eye) > FX_RANGE) return;
    const v = b.part.rb.linvel();
    const n = Math.round((def.aero ? 6 : 4) * ctx.density);
    for (let i = 0; i < n; i++) {
      const out = add(v, spread(4.5));
      ctx.particles.emit(add(at, spread(0.2)), def.aero ? (i % 2 ? CHIP : SHARD) : SHARD, add(out, vec3(0, 2, 0)));
      ctx.particles.emit(at, HIT_SPARK, add(v, spread(6)));
    }
  });
  return {
    update(dt) {
      for (const bot of ctx.world.bots) {
        for (const t of bot.thrusters) {
          if (!t.block.alive) continue;
          const health = engineHealth(t);
          if (health >= ENGINE_WORN) continue;
          const at = blockWorldPos(t.block);
          if (distance(at, ctx.eye) > FX_RANGE || tooClose(ctx, bot, at)) continue;
          const black = health < 0.25;
          const up = qrot(t.block.part.rb.rotation(), t.block.up);
          const v = t.block.part.rb.linvel();
          // La fumée part vers l'échappement, puis monte ; elle reste en arrière d'un robot qui file
          const puff = add(scale(v, 0.15), add(scale(up, -1.2), vec3(0, 0.8, 0)));
          for (let i = rates.count(t, (black ? 16 : 7) * ctx.density, dt); i > 0; i--) {
            ctx.particles.emit(add(at, spread(0.15)), black ? DEAD_SMOKE : WORN_SMOKE, add(puff, spread(0.4)));
          }
          if (black) for (let i = rates.count(t.block, 3 * ctx.density, dt); i > 0; i--) ctx.particles.emit(at, ENGINE_SPARK, add(v, add(spread(3), vec3(0, 2.5, 0))));
        }
        for (const s of bot.surfaces) {
          const b = s.block;
          if (!b.alive) continue;
          const health = b.hp / blockDef(b.type).hp;
          if (health >= 0.5) continue;
          const at = blockWorldPos(b);
          if (distance(at, ctx.eye) > FX_RANGE || tooClose(ctx, bot, at)) continue;
          const v = b.part.rb.linvel();
          for (let i = rates.count(s, (health < 0.25 ? 7 : 3) * ctx.density, dt); i > 0; i--) {
            ctx.particles.emit(add(at, spread(0.2)), WING_SMOKE, add(scale(v, 0.1), spread(0.3)));
          }
        }
      }
    },
    dispose() {
      off();
    },
  };
}

// --- 18 : postcombustion et traînées de condensation ---

/** Régime (part de la poussée maximale) au-delà duquel un turboréacteur passe en postcombustion : plein gaz, sprint. */
export const AFTERBURNER = 0.85;
/** Anneaux de choc de la postcombustion : distance derrière la tuyère (m) et diamètre (m). */
const DIAMONDS: readonly [number, number][] = [[0.35, 0.36], [0.75, 0.3], [1.15, 0.24], [1.55, 0.17]];
const DIAMOND: PuffSpec = { color: "#cfe6ff", kind: "glow", size: 1, life: 0.05, alpha: 0.9 };
const CORE: PuffSpec = { color: "#7fb4ff", kind: "glow", size: 1, life: 0.05, alpha: 0.55 };
/** Traînée de condensation : au-delà de cette vitesse (m/s) ou de cette hauteur au-dessus du sol (m). */
const CONTRAIL_SPEED = 16;
const CONTRAIL_HEIGHT = 18;
const CONTRAIL_STEP = 2.2;
const CONTRAIL: StreakSpec = { color: "#f4f7fa", kind: "vapor", width: 0.12, widen: 0.75, life: 4.5, alpha: 0.3 };

/**
 * Turboréacteurs : en postcombustion (déduite du régime : les commandes des autres ne passent pas
 * par le réseau), un cœur bleuté et des anneaux de choc dans la flamme ; en vol rapide ou haut,
 * une traînée de condensation blanche derrière chaque tuyère.
 */
export function jetFx(ctx: FxContext): FxSystem {
  const trails = new Map<Thruster, Vec3>();
  const off = ctx.world.on((e) => {
    if (e.type === "blockDestroyed") for (const t of trails.keys()) if (t.block === e.block) trails.delete(t);
    if (e.type === "botRemoved") for (const t of e.bot.thrusters) trails.delete(t);
  });
  return {
    update() {
      for (const bot of ctx.world.bots) {
        if (!bot.thrusters.length) continue;
        const powered = new Set(liveThrusters(bot));
        const stunned = isStunned(ctx.world, bot);
        for (const t of bot.thrusters) {
          const spec = blockDef(t.block.type).thruster;
          if (!t.block.alive || spec?.look !== "jet") continue;
          const ratio = powered.has(t) && !stunned ? clamp(t.thrust / spec.maxThrust, 0, 1) : 0;
          const q = t.block.part.rb.rotation();
          const back = qrot(q, scale(t.block.up, -1));
          const nozzle = add(blockWorldPos(t.block), scale(back, JET_NOZZLE));
          const far = distance(nozzle, ctx.eye) > FX_RANGE;
          if (!far && ratio > AFTERBURNER && !tooClose(ctx, bot, nozzle)) {
            const k = (ratio - AFTERBURNER) / (1 - AFTERBURNER);
            for (const [d, size] of DIAMONDS) {
              const at = add(nozzle, scale(back, d * (0.8 + 0.2 * k)));
              ctx.particles.emit(at, CORE, undefined, size * 1.5 * (0.6 + 0.4 * k));
              ctx.particles.emit(at, DIAMOND, undefined, size * (0.7 + 0.3 * k) * (0.9 + 0.2 * Math.random()));
            }
          }
          // Condensation : vite ou haut, et le moteur qui pousse
          const v = t.block.part.rb.linvel();
          const speed = len(v);
          const height = nozzle.y - floorUnder(ctx.world.arena, nozzle.x, nozzle.y, nozzle.z, 60);
          const tail = add(nozzle, scale(back, 1.2));
          if (far || ratio < 0.3 || (speed < CONTRAIL_SPEED && height < CONTRAIL_HEIGHT)) {
            trails.delete(t);
            continue;
          }
          const last = trails.get(t);
          if (!last) {
            trails.set(t, tail);
            continue;
          }
          if (distance(last, tail) < CONTRAIL_STEP / ctx.density) continue;
          ctx.streaks.line(last, tail, CONTRAIL);
          trails.set(t, tail);
        }
      }
    },
    dispose() {
      off();
      trails.clear();
    },
  };
}

// --- 19 : tourbillons de bout d'aile ---

/** Facteur de charge (g) au-delà duquel les bouts d'aile laissent un tourbillon de vapeur, et vitesse minimale (m/s). */
const VORTEX_LOAD = 1.15;
const VORTEX_SPEED = 9;
const VORTEX_STEP = 0.9;
const VORTEX: StreakSpec = { color: "#ffffff", kind: "vapor", width: 0.04, widen: 0.26, life: 1.1, alpha: 0.45 };

interface WingTips {
  left: Block | null;
  right: Block | null;
  lastLeft: Vec3 | null;
  lastRight: Vec3 | null;
}

/**
 * Tourbillons de bout d'aile : quand l'avion tire fort (virage serré, ressource), un trait de
 * vapeur part de chaque bout d'aile, d'autant plus net que le facteur de charge est fort. Le
 * facteur de charge se lit sur la rotation et la vitesse du morceau du cockpit (|ω × v| / g).
 */
export function wingtipVortices(ctx: FxContext): FxSystem {
  const tips = new Map<Bot, WingTips>();
  const off = ctx.world.on((e) => {
    if (e.type === "botRemoved") tips.delete(e.bot);
    if (e.type === "blockDestroyed") {
      const w = tips.get(e.block.bot);
      if (w && (w.left === e.block || w.right === e.block)) tips.delete(e.block.bot);
    }
  });
  /** Les ailes les plus à gauche et à droite du morceau du cockpit (dans le repère du robot). */
  const findTips = (bot: Bot): WingTips => {
    let left: Block | null = null;
    let right: Block | null = null;
    for (const s of bot.surfaces) {
      const b = s.block;
      if (!b.alive || b.part !== bot.cockpit.part) continue;
      if (!left || b.x > left.x) left = b;
      if (!right || b.x < right.x) right = b;
    }
    return { left, right: right === left ? null : right, lastLeft: null, lastRight: null };
  };
  return {
    update() {
      for (const bot of ctx.world.bots) {
        if (bot.profile.mobility !== "plane" || !bot.cockpit.alive || bot.surfaces.length < 2) continue;
        let w = tips.get(bot);
        if (!w) {
          w = findTips(bot);
          tips.set(bot, w);
        }
        if (!w.left || !w.right) continue;
        const rb = bot.cockpit.part.rb;
        const v = rb.linvel();
        const speed = len(v);
        const load = len(cross(rb.angvel(), v)) / GRAVITY;
        const strength = clamp((load - VORTEX_LOAD) / 0.8, 0, 1);
        const q = rb.rotation();
        const leftAt = add(blockWorldPos(w.left), qrot(q, vec3(0.25, 0, -0.1)));
        const rightAt = add(blockWorldPos(w.right), qrot(q, vec3(-0.25, 0, -0.1)));
        if (speed < VORTEX_SPEED || strength <= 0 || distance(leftAt, ctx.eye) > FX_RANGE) {
          w.lastLeft = w.lastRight = null;
          continue;
        }
        const spec = { ...VORTEX, alpha: VORTEX.alpha! * (0.35 + 0.65 * strength) };
        if (w.lastLeft && distance(w.lastLeft, leftAt) >= VORTEX_STEP) {
          ctx.streaks.line(w.lastLeft, leftAt, spec);
          w.lastLeft = leftAt;
        } else if (!w.lastLeft) w.lastLeft = leftAt;
        if (w.lastRight && distance(w.lastRight, rightAt) >= VORTEX_STEP) {
          ctx.streaks.line(w.lastRight, rightAt, spec);
          w.lastRight = rightAt;
        } else if (!w.lastRight) w.lastRight = rightAt;
      }
    },
    dispose() {
      off();
      tips.clear();
    },
  };
}

// --- 21, 22 : souffle des rotors au sol, patins ---

/** Hauteur du moteur (m) sous laquelle son souffle, s'il porte, soulève la poussière (ou l'eau). */
const DOWNWASH_HEIGHT = 9;
const SPRAY: PuffSpec = { color: "#e9f3f7", kind: "vapor", size: 0.2, grow: 0.7, life: 0.9, alpha: 0.55, drag: 1.4, gravity: 4 };
const PAD_SPARK: PuffSpec = { color: "#7fe8ff", kind: "glow", size: 0.06, life: 0.3, alpha: 1, drag: 1.5, gravity: 2, stretch: 0.03 };
const SCRAPE: PuffSpec = { color: "#ffc061", kind: "glow", size: 0.06, life: 0.35, alpha: 1, drag: 0.5, gravity: 9.8, stretch: 0.03 };

/**
 * Souffle au sol : sous un moteur qui porte (rotor, réacteur ou turboréacteur tourné vers le
 * bas), près du sol, la poussière part en couronne, à la couleur du sol de l'arène ; sur l'eau de
 * la Vallée, des embruns blancs. Sous un patin anti-gravité qui avance, un peu de poussière et
 * de petites étincelles bleues ; qui racle le sol, des étincelles orange.
 */
export function downwash(ctx: FxContext): FxSystem {
  const rates = new Rates();
  return {
    update(dt) {
      const arena = ctx.world.arena;
      const water = arena.water ?? -Infinity;
      for (const bot of ctx.world.bots) {
        if (isStunned(ctx.world, bot)) continue;
        const powered = new Set(liveThrusters(bot));
        for (const t of bot.thrusters) {
          if (!powered.has(t)) continue;
          const spec = blockDef(t.block.type).thruster!;
          const ratio = clamp(t.thrust / spec.maxThrust, 0, 1);
          if (ratio < 0.12) continue;
          const up = qrot(t.block.part.rb.rotation(), t.block.up);
          if (up.y < 0.55) continue;
          const at = blockWorldPos(t.block);
          if (distance(at, ctx.eye) > FX_RANGE) continue;
          const floor = floorUnder(arena, at.x, at.y, at.z, DOWNWASH_HEIGHT + 1);
          const onWater = floor < water;
          const surface = onWater ? water : floor;
          const h = at.y - surface;
          if (h > DOWNWASH_HEIGHT || h < 0) continue;
          // Plus fort près du sol, et pour un gros moteur
          const size = clamp(spec.maxThrust / 540, 0.35, 1.3);
          const strength = ratio * Math.sqrt(1 - h / DOWNWASH_HEIGHT) * size;
          const reach = 0.5 + 0.35 * size;
          const color = dustColor(arena, at.x, surface, at.z);
          for (let i = rates.count(t, 70 * strength * ctx.density, dt); i > 0; i--) {
            const a = Math.random() * Math.PI * 2;
            const dir = vec3(Math.cos(a), 0, Math.sin(a));
            const from = vec3(at.x + dir.x * reach * jitter(0.6, 1.2), surface + 0.15, at.z + dir.z * reach * jitter(0.6, 1.2));
            const out = add(scale(dir, jitter(3, 6.5) * (0.5 + strength)), vec3(0, jitter(0.2, 0.9), 0));
            if (onWater) ctx.particles.emit(from, SPRAY, add(out, vec3(0, jitter(1, 2.5), 0)), 0.8 + size * 0.5);
            else ctx.particles.emit(from, { color, kind: "smoke", size: 0.3, grow: 1.5, life: 1.4, alpha: 0.55, fadeIn: 0.1, drag: 1.6, gravity: -0.2 }, out, 0.7 + size * 0.5);
          }
        }
        // Patins anti-gravité
        for (const s of bot.supports) {
          const def = blockDef(s.block.type).support;
          if (!s.block.alive || def?.kind === "leg" || s.contact > 1.4) continue;
          const at = blockWorldPos(s.block);
          if (distance(at, ctx.eye) > FX_RANGE) continue;
          const v = s.block.part.rb.linvel();
          const speed = Math.hypot(v.x, v.z);
          const ground = at.y - s.contact - 0.25;
          const color = dustColor(arena, at.x, ground, at.z);
          const moving = clamp(speed / 6, 0, 1);
          for (let i = rates.count(s, (2 + 9 * moving) * ctx.density, dt); i > 0; i--) {
            const from = vec3(at.x + jitter(-0.3, 0.3), ground + 0.1, at.z + jitter(-0.3, 0.3));
            ctx.particles.emit(from, { color, kind: "smoke", size: 0.22, grow: 0.9, life: 1, alpha: 0.35, drag: 2, gravity: -0.15 }, add(scale(v, -0.2), spread(1)));
          }
          for (let i = rates.count(s.block, 4 * ctx.density, dt); i > 0; i--) {
            ctx.particles.emit(vec3(at.x + jitter(-0.25, 0.25), ground + 0.12, at.z + jitter(-0.25, 0.25)), PAD_SPARK, spread(1.5));
          }
          // Il racle le sol en filant
          if (s.contact < 0.12 && speed > 3) {
            for (let i = rates.count(s.block.part, 20 * ctx.density, dt); i > 0; i--) ctx.particles.emit(vec3(at.x, ground + 0.05, at.z), SCRAPE, add(scale(v, -0.4), add(spread(2), vec3(0, 2.5, 0))));
          }
        }
      }
    },
    dispose() {},
  };
}

// --- 23 : échappement des robots à roues et à chenilles ---

const EXHAUST: PuffSpec = { color: "#34363a", kind: "smoke", size: 0.22, grow: 1.2, life: 1.5, alpha: 0.6, fadeIn: 0.05, drag: 1.4, gravity: -0.8 };
/** Accélération (m/s²) au-delà de laquelle un robot à roues crache une bouffée d'échappement. */
const EXHAUST_ACCEL = 1.2;

/**
 * Échappement : un robot à roues ou à chenilles qui accélère crache des bouffées sombres par le
 * haut de son arrière (le bloc le plus haut du fond de son morceau du cockpit).
 */
export function exhaustPuffs(ctx: FxContext): FxSystem {
  const rates = new Rates();
  const pipes = new Map<Bot, { block: Block; speed: number }>();
  const off = ctx.world.on((e) => {
    if (e.type === "botRemoved") pipes.delete(e.bot);
  });
  /** Le pot d'échappement : parmi les blocs du morceau du cockpit, le plus en arrière, puis le plus haut. */
  const pipeOf = (bot: Bot): Block | null => {
    let best: Block | null = null;
    for (const b of bot.cockpit.part.blocks) {
      if (!b.alive) continue;
      if (!best || b.z < best.z || (b.z === best.z && b.y > best.y)) best = b;
    }
    return best;
  };
  return {
    update(dt) {
      if (dt <= 0) return;
      for (const bot of ctx.world.bots) {
        if (bot.profile.mobility !== "ground" || !bot.cockpit.alive || !bot.wheels.some((w) => w.part)) continue;
        let pipe = pipes.get(bot);
        if (!pipe || !pipe.block.alive || pipe.block.part !== bot.cockpit.part) {
          const block = pipeOf(bot);
          if (!block) continue;
          pipe = { block, speed: 0 };
          pipes.set(bot, pipe);
        }
        const rb = bot.cockpit.part.rb;
        const forward = qrot(rb.rotation(), vec3(0, 0, 1));
        const speed = dot(rb.linvel(), forward);
        const accel = (Math.abs(speed) - Math.abs(pipe.speed)) / dt;
        pipe.speed = speed;
        if (accel < EXHAUST_ACCEL || isStunned(ctx.world, bot)) continue;
        const at = add(blockWorldPos(pipe.block), qrot(rb.rotation(), vec3(0, 0.3, -0.25)));
        if (distance(at, ctx.eye) > FX_RANGE || tooClose(ctx, bot, at)) continue;
        const k = clamp(accel / 5, 0.3, 1);
        for (let i = rates.count(bot, 18 * k * ctx.density, dt); i > 0; i--) {
          ctx.particles.emit(add(at, spread(0.08)), EXHAUST, add(scale(forward, -0.8), vec3(jitter(-0.2, 0.2), 1.2, jitter(-0.2, 0.2))));
        }
      }
    },
    dispose() {
      off();
      pipes.clear();
    },
  };
}

// --- 24 : paralysie ---

const CHOKE: PuffSpec = { color: "#4a4e53", kind: "smoke", size: 0.3, grow: 1.4, life: 1.6, alpha: 0.6, drag: 2, gravity: -0.6 };
const ARC: StreakSpec = { color: "#d9f6ff", kind: "glow", width: 0.05, life: 0.11, alpha: 1 };
const ARC_HALO: StreakSpec = { color: "#6fcfff", kind: "glow", width: 0.14, life: 0.11, alpha: 0.35 };
const ARC_GLOW: PuffSpec = { color: "#9fe3ff", kind: "glow", size: 0.22, life: 0.12, alpha: 0.8 };

/**
 * Robot paralysé (impulsion électromagnétique) : ses moteurs s'éteignent dans une bouffée de
 * fumée, et des arcs électriques en zigzag courent d'un bloc à un voisin tant que dure la
 * paralysie. Paralysie locale (lance électrique, shared/combat/emp.ts) : les arcs ne courent que
 * sur les blocs coupés, et autour des roues coupées (de leur moyeu à leur bandage) ; un moteur coupé
 * crache sa bouffée. Lu sur les blocs et les roues (`stunnedUntil`), en réseau aussi.
 */
export function stunArcs(ctx: FxContext): FxSystem {
  const rates = new Rates();
  const stunned = new Set<Bot>();
  const live = new LiveSet(ctx.world);
  /** Moteurs déjà vus coupés localement (leur bouffée n'est crachée qu'une fois). */
  const choked = new Set<Block>();
  /** Les arcs d'une paralysie locale : entre ses blocs coupés, et autour de ses roues coupées. */
  const local = (bot: Bot, dt: number): void => {
    const { blocks, wheels } = localStuns(ctx.world, bot);
    const shown = blocks.filter((b) => live.blockOk(b));
    if (!shown.length && !wheels.length) return;
    const middle = bot.cockpit.alive && live.blockOk(bot.cockpit) ? bot.cockpit.part.rb.worldCom() : null;
    if (!middle || distance(middle, ctx.eye) > FX_RANGE) return;
    for (const t of bot.thrusters) {
      if (!shown.includes(t.block)) {
        choked.delete(t.block);
        continue;
      }
      if (choked.has(t.block)) continue;
      choked.add(t.block);
      const at = blockWorldPos(t.block);
      for (let i = 0; i < 4; i++) ctx.particles.emit(add(at, spread(0.2)), CHOKE, add(vec3(0, 1, 0), spread(1)));
    }
    const surface = (p: Vec3): Vec3 => add(p, scale(norm(sub(p, middle)), 0.34));
    for (let i = rates.count(bot, (4 + 2 * shown.length + 6 * wheels.length) * ctx.density, dt); i > 0; i--) {
      const wheel = wheels.length && Math.random() < (6 * wheels.length) / (2 * shown.length + 6 * wheels.length) ? wheels[Math.floor(Math.random() * wheels.length)] : null;
      if (wheel) {
        if (!live.wheelOk(wheel) || !wheel.part) continue;
        // Du moyeu au bandage : un arc qui court sur le flanc de la roue
        const c = wheel.rb.translation();
        const q = wheel.rb.rotation();
        const { radius, width } = wheelDef(wheel.type);
        const a = jitter(0, Math.PI * 2);
        // (le flanc extérieur : l'essieu de la roue est son axe x, du côté où elle est montée)
        const out = wheel.side || 1;
        const rim = add(c, qrot(q, vec3(out * width * 0.6, Math.cos(a) * radius, Math.sin(a) * radius)));
        zigzag(ctx, add(c, qrot(q, vec3(out * width * 0.6, 0, 0))), rim, c);
        continue;
      }
      if (shown.length < 2) {
        const a = blockWorldPos(shown[0]);
        zigzag(ctx, surface(a), surface(add(a, spread(0.4))), middle);
        continue;
      }
      const a = shown[Math.floor(Math.random() * shown.length)];
      const pa = blockWorldPos(a);
      let b: Block | null = null;
      for (let k = 0; k < 6 && !b; k++) {
        const c = shown[Math.floor(Math.random() * shown.length)];
        if (c !== a && distance(blockWorldPos(c), pa) < 1.2) b = c;
      }
      if (b) zigzag(ctx, surface(pa), surface(blockWorldPos(b)), middle);
    }
  };
  return {
    update(dt) {
      for (const bot of ctx.world.bots) {
        const now = isStunned(ctx.world, bot) && bot.cockpit.alive;
        if (!now) {
          stunned.delete(bot);
          if (bot.cockpit.alive) local(bot, dt);
          continue;
        }
        const part = bot.cockpit.part;
        const center = part.rb.translation();
        if (distance(center, ctx.eye) > FX_RANGE) continue;
        // Il vient d'être paralysé : ses moteurs s'éteignent
        if (!stunned.has(bot)) {
          stunned.add(bot);
          for (const t of bot.thrusters) {
            if (!t.block.alive) continue;
            const at = blockWorldPos(t.block);
            for (let i = 0; i < 5; i++) ctx.particles.emit(add(at, spread(0.2)), CHOKE, add(vec3(0, 1, 0), spread(1)));
          }
        }
        const blocks = [...part.blocks];
        if (blocks.length < 2) continue;
        for (let i = rates.count(bot, 16 * ctx.density, dt); i > 0; i--) {
          const a = blocks[Math.floor(Math.random() * blocks.length)];
          // Un bloc voisin, à moins de 1,6 m
          const pa = blockWorldPos(a);
          let b: Block | null = null;
          for (let k = 0; k < 6 && !b; k++) {
            const c = blocks[Math.floor(Math.random() * blocks.length)];
            if (c !== a && distance(blockWorldPos(c), pa) < 1.6) b = c;
          }
          if (!b) continue;
          // En surface : chaque bout rejeté vers l'extérieur du robot (d'un centre de bloc à l'autre, l'arc passait dans la coque)
          const middle = part.rb.worldCom();
          const surface = (p: Vec3): Vec3 => add(p, scale(norm(sub(p, middle)), 0.34));
          zigzag(ctx, surface(pa), surface(blockWorldPos(b)), middle);
        }
      }
    },
    dispose() {
      stunned.clear();
      choked.clear();
      live.dispose();
    },
  };
}

/** Un arc électrique de `a` à `b` : trois segments, les coudes écartés au hasard (et vers l'extérieur, loin de `middle`). */
function zigzag(ctx: FxContext, a: Vec3, b: Vec3, middle: Vec3): void {
  const d = sub(b, a);
  const size = len(d);
  let last = add(a, spread(0.08));
  for (let i = 1; i <= 3; i++) {
    const on = add(a, scale(d, i / 3));
    const next = i === 3 ? add(b, spread(0.08)) : add(add(on, scale(norm(sub(on, middle)), jitter(0.05, 0.2))), spread(0.1 + size * 0.08));
    ctx.streaks.line(last, next, ARC);
    ctx.streaks.line(last, next, ARC_HALO);
    last = next;
  }
  ctx.particles.emit(a, ARC_GLOW);
  ctx.particles.emit(b, ARC_GLOW);
}

// --- 16 : avion abattu ---

const WRECK_SMOKE: PuffSpec = { color: "#1d1e20", kind: "smoke", size: 0.5, grow: 2.8, life: 4.5, alpha: 0.7, fadeIn: 0.04, drag: 0.9, gravity: -0.5 };
const WRECK_FIRE: PuffSpec = { color: "#ff7a1f", kind: "fire", size: 0.6, grow: 0.15, life: 0.35, alpha: 0.95, drag: 2, heat: 0.8 };
const WRECK_FLAME: PuffSpec = { color: "#ffd27a", kind: "fire", size: 0.35, grow: 0.1, life: 0.2, alpha: 1, heat: 1 };
/** Un robot volant abattu fume au plus ce temps (s), et s'arrête posé au sol. */
const FALL_TIME = 14;

/**
 * Avion (ou robot volant) abattu : ses morceaux tombent en crachant une longue traînée de fumée
 * noire et du feu, jusqu'au sol. On les suit depuis `botKilled`, et on les oublie dès qu'ils sont
 * retirés (`partRemoved` : on ne relit jamais un corps libéré).
 */
export function fallingWrecks(ctx: FxContext): FxSystem {
  const rates = new Rates();
  const falling = new Map<Part, number>();
  const off = ctx.world.on((e) => {
    if (e.type === "partRemoved") falling.delete(e.part);
    else if (e.type === "botRemoved") {
      for (const p of [...falling.keys()]) if (p.bot === e.bot) falling.delete(p);
    } else if (e.type === "botKilled") {
      const bot = e.bot;
      if (bot.profile.mobility === "ground") return;
      for (const part of bot.parts) {
        if (![...part.blocks].some((b) => b.alive)) continue;
        falling.set(part, ctx.now + FALL_TIME);
      }
    }
  });
  return {
    update(dt) {
      const arena = ctx.world.arena;
      for (const [part, until] of falling) {
        if (ctx.now > until || !part.bot.parts.has(part)) {
          falling.delete(part);
          continue;
        }
        const at = part.rb.translation();
        const v = part.rb.linvel();
        const floor = floorUnder(arena, at.x, at.y, at.z, 80);
        // Posé : il a fini de tomber
        if (at.y - floor < 1.2 && len(v) < 1.5) {
          falling.delete(part);
          continue;
        }
        if (distance(at, ctx.eye) > FX_RANGE * 1.3) continue;
        const heavy = part.blocks.size > 6 ? 1 : 0.6;
        for (let i = rates.count(part, 26 * heavy * ctx.density, dt); i > 0; i--) {
          ctx.particles.emit(add(at, spread(0.35)), WRECK_SMOKE, add(scale(v, 0.1), spread(0.5)), heavy);
        }
        for (let i = rates.count(part.blocks, 20 * heavy * ctx.density, dt); i > 0; i--) {
          ctx.particles.emit(add(at, spread(0.3)), i % 2 ? WRECK_FLAME : WRECK_FIRE, add(scale(v, 0.4), spread(0.8)), heavy);
        }
      }
    },
    dispose() {
      off();
      falling.clear();
    },
  };
}

/** Lueur d'un patin anti-gravité : de 35 % (batteries vides) à 100 %, et elle vacille quand elles sont presque vides. */
export function padGlow(bot: Bot, now: number): number {
  const level = energyCapacity(bot) > 0 ? energyFraction(bot) : 1;
  const base = 0.35 + 0.65 * level;
  return level < 0.2 ? base * (0.7 + 0.3 * Math.abs(Math.sin(now * 23 + bot.id))) : base;
}
