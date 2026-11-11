import { groundLevel } from "../../../shared/arena/layout";
import { blockDef } from "../../../shared/catalog/blocks";
import { meleeDef } from "../../../shared/catalog/melee";
import { meleeFrame } from "../../../shared/combat/melee";
import { add, distance, len, scale, sub, vec3, type Vec3 } from "../../../shared/math/vec";
import type { Bot, MeleeArm } from "../../../shared/sim/entities";
import type { SimEvent } from "../../../shared/sim/events";
import { emissions, FX_RANGE, type FxContext, type FxSystem } from "./fx";
import { jitter } from "./layer";
import { surfaceAt } from "./marks";
import type { PuffSpec } from "./particles";
import { groundRgb, LiveSet, toHex } from "./tracking";

/*
 * Frappes à mécanique (shared/combat/mechanics.ts), à l'écran, en plus du coup lui-même (meleeFx) :
 * - le flipper : un souffle de poussière sous son plateau quand il se relève sous un robot ; la
 *   cible part en l'air en perdant des éclats, et sa chute soulève un anneau de poussière à la
 *   couleur du sol et laisse une marque (on suit le robot touché d'après l'événement `hit`, qui passe
 *   par le réseau, et sa vitesse : il retombe quand elle remonte d'un coup) ;
 * - le fléau : une traînée derrière la boule lancée, et des étincelles quand elle racle le sol ;
 * - la mâchoire qui serre : des étincelles et des éclats de tôle à sa gueule, et des bouffées de
 *   vapeur de son vérin.
 * Tout se lit dans le monde affiché (la réplique en réseau), à travers un `LiveSet`.
 */

/** Poussière soulevée (sous le plateau, à l'atterrissage), à la couleur du sol. */
const DUST: PuffSpec = { color: "#b9a888", kind: "smoke", size: 0.5, grow: 2.2, life: 1.8, alpha: 0.6, fadeIn: 0.06, drag: 2, gravity: -0.2 };
/** Éclats de tôle qui tombent d'un robot jeté en l'air ou d'une mâchoire qui écrase. */
const CHIP: PuffSpec = { color: "#2a2d30", kind: "smoke", size: 0.06, life: 1, alpha: 1, drag: 0.3, gravity: 9.8, wind: 0 };
/** Étincelles d'une mâchoire, d'une boule qui racle. */
const SPARK: PuffSpec = { color: "#ffd38a", kind: "glow", size: 0.045, life: 0.35, alpha: 1, drag: 1.4, gravity: 6, stretch: 0.04 };
/** Vapeur du vérin d'une mâchoire qui serre. */
const STEAM: PuffSpec = { color: "#e8edf0", kind: "vapor", size: 0.18, grow: 0.7, life: 0.7, alpha: 0.4, fadeIn: 0.1, drag: 2, gravity: -1 };
/** Trace d'une chute au sol. */
const SCUFF = { color: "#3a3127", life: 30, fade: 0.3, alpha: 0.3 };
/** Traînée de la boule d'un fléau lancée. */
const TRAIL = { color: "#cfd6dc", kind: "vapor" as const, width: 0.05, widen: 0.12, life: 0.18, alpha: 0.35 };

/** Une cible soulevée, suivie jusqu'à ce qu'elle retombe (s). */
const WATCH_FOR = 3.5;
/** Elle retombe quand sa vitesse verticale remonte au-dessus de cela, après être descendue sous FALLING (m/s). */
const FALLING = -2.5;
const LANDED = -0.8;
/** La boule laisse une traînée au-delà de cette vitesse (m/s), et racle le sol à moins de cela au-dessus de lui (m). */
const TRAIL_SPEED = 6;
const SCRAPE = 0.06;

export function mechanicsFx(ctx: FxContext): FxSystem {
  const live = new LiveSet(ctx.world);
  /** Robots soulevés par un flipper : depuis quand, et s'ils sont en train de retomber. */
  const thrown = new Map<Bot, { since: number; falling: boolean; chips: { acc: number } }>();
  /** Fléaux : position précédente de la boule (vitesse, traînée) ; mâchoires : cadence des étincelles. */
  const balls = new Map<MeleeArm, Vec3>();
  const jaws = new Map<MeleeArm, { sparks: { acc: number }; steam: { acc: number } }>();

  const dustAt = (at: Vec3, count: number, spread: number, scaleBy = 1): void => {
    const c = groundRgb(ctx.world.arena, at.x, at.y, at.z);
    const dust = { ...DUST, color: toHex(c.r * 0.9 + 0.08, c.g * 0.9 + 0.07, c.b * 0.9 + 0.05) };
    const n = Math.round(count * ctx.density);
    for (let i = 0; i < n; i++) {
      const a = (i / Math.max(1, n)) * Math.PI * 2 + jitter(-0.2, 0.2);
      const out = vec3(Math.cos(a), 0, Math.sin(a));
      ctx.particles.emit(add(at, scale(out, spread * 0.3)), dust, add(scale(out, jitter(1.5, 4) * scaleBy), vec3(0, jitter(0.2, 1.2), 0)), scaleBy);
    }
  };

  const onEvent = (e: SimEvent): void => {
    if (e.type === "meleeHit") {
      const weapon = blockDef(e.block.type).melee;
      if (!weapon || meleeDef(weapon).motion !== "flip" || distance(e.point, ctx.eye) > FX_RANGE) return;
      // Le plateau se relève : un souffle de poussière dessous
      const ground = vec3(e.point.x, groundLevel(ctx.world.arena, e.point.x, e.point.z) + 0.05, e.point.z);
      dustAt(ground, 12, 0.6, 0.8);
    } else if (e.type === "hit" && e.cause === "flipper") {
      thrown.set(e.victim, { since: ctx.now, falling: false, chips: { acc: 0 } });
    } else if (e.type === "botRemoved") {
      thrown.delete(e.bot);
      for (const arm of e.bot.melee) {
        balls.delete(arm);
        jaws.delete(arm);
      }
    }
  };
  const off = ctx.world.on(onEvent);

  return {
    update(dt) {
      if (dt <= 0) return;
      // Les robots jetés en l'air : des éclats en vol, la poussière de leur chute
      for (const [bot, state] of thrown) {
        const ck = bot.cockpit;
        if (ctx.now - state.since > WATCH_FOR || !ck.alive || !live.parts.has(ck.part)) {
          thrown.delete(bot);
          continue;
        }
        const rb = ck.part.rb;
        const v = rb.linvel();
        const at = rb.translation();
        if (distance(at, ctx.eye) > FX_RANGE) continue;
        for (let i = emissions(state.chips, 10 * ctx.density, dt); i > 0; i--) {
          ctx.particles.emit(add(at, vec3(jitter(-0.6, 0.6), jitter(-0.3, 0.3), jitter(-0.6, 0.6))), CHIP, add(scale(vec3(v.x, v.y, v.z), 0.6), vec3(jitter(-1, 1), jitter(0, 1.5), jitter(-1, 1))), jitter(0.6, 1.2));
        }
        if (v.y < FALLING) state.falling = true;
        else if (state.falling && v.y > LANDED) {
          // Il retombe : un anneau de poussière, des éclats, une trace au sol
          const ground = vec3(at.x, groundLevel(ctx.world.arena, at.x, at.z) + 0.05, at.z);
          dustAt(ground, 22, bot.radius, 1.2);
          for (let i = Math.round(12 * ctx.density); i > 0; i--) {
            ctx.particles.emit(add(ground, vec3(jitter(-1, 1), 0.3, jitter(-1, 1))), CHIP, vec3(jitter(-3, 3), jitter(2, 5), jitter(-3, 3)), jitter(0.6, 1.4));
          }
          const surface = surfaceAt(ctx.world.arena, at.x, at.z, at.y);
          if (surface) ctx.marks.disc(surface.point, surface.normal, Math.min(1.6, bot.radius * 0.8), SCUFF);
          thrown.delete(bot);
        }
      }
      for (const bot of ctx.world.bots) {
        if (bot === ctx.inside) continue;
        for (const arm of bot.melee) {
          const spec = meleeDef(arm.weapon);
          if (spec.flail) flail(arm, dt);
          else if (spec.jaw) jaw(arm, dt);
        }
      }
    },
    dispose() {
      off();
      live.dispose();
      thrown.clear();
      balls.clear();
      jaws.clear();
    },
  };

  /** La boule d'un fléau : sa traînée quand elle va vite, des étincelles quand elle racle le sol. */
  function flail(arm: MeleeArm, dt: number): void {
    const ball = arm.ball;
    if (!ball || !live.blockOk(arm.block) || distance(ball.pos, ctx.eye) > FX_RANGE) {
      balls.delete(arm);
      return;
    }
    const prev = balls.get(arm);
    balls.set(arm, ball.pos);
    if (!prev) return;
    const move = sub(ball.pos, prev);
    const speed = len(move) / dt;
    if (speed > TRAIL_SPEED && len(move) < 3) ctx.streaks.line(prev, ball.pos, { ...TRAIL, alpha: Math.min(0.5, 0.2 + speed * 0.02) });
    const r = meleeDef(arm.weapon).flail!.radius;
    if (speed > 3 && ball.pos.y - r - groundLevel(ctx.world.arena, ball.pos.x, ball.pos.z) < SCRAPE) {
      const under = vec3(ball.pos.x, ball.pos.y - r, ball.pos.z);
      for (let i = Math.round(3 * ctx.density); i > 0; i--) {
        ctx.particles.emit(under, SPARK, add(scale(move, (1 / dt) * jitter(0.3, 0.7)), vec3(jitter(-1.5, 1.5), jitter(0.5, 2.5), jitter(-1.5, 1.5))));
      }
    }
  }

  /** Une mâchoire qui serre : étincelles et éclats à sa gueule, vapeur de son vérin. */
  function jaw(arm: MeleeArm, dt: number): void {
    if (!arm.grip || !live.blockOk(arm.block)) {
      jaws.delete(arm);
      return;
    }
    const f = meleeFrame(arm);
    if (distance(f.hub, ctx.eye) > FX_RANGE) return;
    let state = jaws.get(arm);
    if (!state) jaws.set(arm, (state = { sparks: { acc: 0 }, steam: { acc: 0 } }));
    const spec = meleeDef(arm.weapon).jaw!;
    const mouth = add(f.hub, scale(f.e1, (spec.mouth[0] + spec.mouth[1]) / 2));
    for (let i = emissions(state.sparks, 26 * ctx.density, dt); i > 0; i--) {
      const out = add(scale(f.axis, jitter(-3, 3)), add(scale(f.e1, jitter(-1, 2)), vec3(0, jitter(0.5, 3), 0)));
      ctx.particles.emit(add(mouth, scale(f.axis, jitter(-spec.half, spec.half))), i % 3 ? SPARK : CHIP, out, i % 3 ? 1 : jitter(0.5, 1));
    }
    for (let i = emissions(state.steam, 5 * ctx.density, dt); i > 0; i--) {
      ctx.particles.emit(add(f.hub, scale(f.e1, -0.25)), STEAM, vec3(jitter(-0.6, 0.6), jitter(0.6, 1.4), jitter(-0.6, 0.6)));
    }
  }
}
