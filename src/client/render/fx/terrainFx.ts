import { lavaBounds, lavaDepth, type LavaShape, type Vent, type Waterfall } from "../../../shared/arena/features";
import { groundLevel, type ArenaLayout } from "../../../shared/arena/layout";
import { distance, vec3, type Vec3 } from "../../../shared/math/vec";
import { FX_RANGE, type FxContext, type FxSystem } from "./fx";
import { jitter } from "./layer";
import type { PuffSpec } from "./particles";
import { countOf } from "./tracking";

/*
 * Ce que le terrain d'une arène fait de lui-même (arena/features.ts), d'après ses données : les
 * fumerolles crachent leur panache (le grand panache du cratère, se voit de partout), la lave
 * bouillonne et fume, et les cascades soulèvent de l'embrun à leur pied. Des données fixes : en
 * réseau aussi, sans rien au protocole.
 */

/** Panache d'un cratère ou d'une fissure : une fumée grise qui monte haut et s'étale. */
const PLUME: PuffSpec = { color: "#77716a", kind: "smoke", size: 2.4, grow: 11, life: 14, alpha: 0.3, gravity: -0.9, drag: 0.3, fadeIn: 0.25 };
/** Vapeur de la lave qui se jette dans la mer : blanche, rapide. */
const STEAM: PuffSpec = { color: "#f2f4f5", kind: "vapor", size: 1.4, grow: 6, life: 4.5, alpha: 0.5, gravity: -1.6, drag: 0.5, fadeIn: 0.12 };
/** Bulle de lave qui éclate, et ses projections. */
const BUBBLE: PuffSpec = { color: "#ffb03a", kind: "glow", size: 0.35, grow: 0.7, life: 0.5, alpha: 0.9, fadeIn: 0.2 };
const SPATTER: PuffSpec = { color: "#ff7a1e", kind: "glow", size: 0.09, life: 0.9, alpha: 1, gravity: 9.8, drag: 0.3, stretch: 0.03 };
/** Fumée légère au-dessus de la lave. */
const LAVA_FUME: PuffSpec = { color: "#5b4b42", kind: "smoke", size: 0.8, grow: 3.4, life: 3.5, alpha: 0.22, gravity: -1.1, drag: 0.6, fadeIn: 0.2 };
/** Braise d'une fissure, qui monte. */
const EMBER: PuffSpec = { color: "#ffb347", kind: "glow", size: 0.08, life: 1.8, alpha: 0.95, gravity: -1.4, drag: 0.7, stretch: 0.04 };
/** Embrun au pied d'une cascade, et ses gouttes. */
const MIST: PuffSpec = { color: "#e8f0f2", kind: "vapor", size: 0.9, grow: 3.2, life: 2.2, alpha: 0.38, gravity: -0.25, drag: 1, fadeIn: 0.1 };
const DROP: PuffSpec = { color: "#dfeef3", kind: "vapor", size: 0.07, life: 0.7, alpha: 0.85, gravity: 9.8, drag: 0.2, stretch: 0.03, wind: 0 };

/** Panaches par seconde d'une fumerolle de taille 1 ; un panache se voit de loin (au-delà de FX_RANGE, la moitié). */
const PLUME_RATE = 0.7;
/** Bulles par seconde et par m² de lave, et au-delà de quelle distance (m) la lave ne bouillonne plus à l'œil. */
const BUBBLES_PER_M2 = 0.05;
const LAVA_NEAR = 90;
const FALL_NEAR = 110;

/** Une forme de lave, son emprise et sa surface (m²). */
interface Pool {
  shape: LavaShape;
  box: ReturnType<typeof lavaBounds>;
  area: number;
}

function areaOf(shape: LavaShape): number {
  if (shape.kind === "pool") return Math.PI * shape.r * shape.r;
  let length = 0;
  for (let i = 1; i < shape.points.length; i++) length += Math.hypot(shape.points[i][0] - shape.points[i - 1][0], shape.points[i][1] - shape.points[i - 1][1]);
  return length * shape.width;
}

/** Un point au hasard dans la lave (y : la hauteur du sol), ou null après quelques essais manqués. */
function pointIn(arena: ArenaLayout, pool: Pool): Vec3 | null {
  const b = pool.box;
  for (let i = 0; i < 6; i++) {
    const x = jitter(b.minX, b.maxX);
    const z = jitter(b.minZ, b.maxZ);
    // Pas au bord, où la croûte est figée ; pas sous la mer
    if (lavaDepth(pool.shape, x, z) < 0.6) continue;
    const y = groundLevel(arena, x, z);
    if (arena.water !== undefined && y < arena.water) continue;
    return vec3(x, y + 0.08, z);
  }
  return null;
}

/** Le terrain de l'arène affichée : fumerolles, lave, cascades. */
export function terrainFx(ctx: FxContext): FxSystem {
  let arena: ArenaLayout | null = null;
  let pools: Pool[] = [];
  const plumes = new Map<Vent, { acc: number }>();
  const ready = (): ArenaLayout => {
    const now = ctx.world.arena;
    if (now !== arena) {
      arena = now;
      pools = (now.lava ?? []).map((shape) => ({ shape, box: lavaBounds(shape), area: areaOf(shape) }));
      plumes.clear();
      for (const v of now.vents ?? []) plumes.set(v, { acc: Math.random() });
    }
    return now;
  };

  const vent = (v: Vent, carry: { acc: number }, dt: number): void => {
    const far = distance(vec3(v.x, v.y, v.z), ctx.eye);
    const thin = (far > FX_RANGE ? 0.5 : 1) * ctx.density;
    carry.acc += PLUME_RATE * v.size * thin * dt;
    for (; carry.acc >= 1; carry.acc--) {
      const at = vec3(v.x + jitter(-0.6, 0.6) * v.size, v.y + 0.3, v.z + jitter(-0.6, 0.6) * v.size);
      const up = v.steam ? jitter(2.5, 4) : jitter(2.2, 3.4) * Math.sqrt(v.size);
      ctx.particles.emit(at, v.steam ? STEAM : PLUME, vec3(jitter(-0.3, 0.3), up, jitter(-0.3, 0.3)), (v.steam ? 1 : 0.6) * Math.sqrt(v.size) * jitter(0.8, 1.25));
    }
    // Des braises montent d'une fissure (pas de la vapeur), de près seulement
    if (!v.steam && far < LAVA_NEAR) {
      for (let i = countOf(2.5 * v.size * ctx.density, dt); i > 0; i--) {
        ctx.particles.emit(vec3(v.x + jitter(-1, 1), v.y + 0.2, v.z + jitter(-1, 1)), EMBER, vec3(jitter(-0.8, 0.8), jitter(2, 5), jitter(-0.8, 0.8)));
      }
    }
  };

  const lava = (a: ArenaLayout, pool: Pool, dt: number): void => {
    const b = pool.box;
    const cx = Math.max(b.minX, Math.min(b.maxX, ctx.eye.x));
    const cz = Math.max(b.minZ, Math.min(b.maxZ, ctx.eye.z));
    if (Math.hypot(cx - ctx.eye.x, cz - ctx.eye.z) > LAVA_NEAR) return;
    for (let i = countOf(pool.area * BUBBLES_PER_M2 * ctx.density, dt); i > 0; i--) {
      const at = pointIn(a, pool);
      if (!at) continue;
      ctx.particles.emit(at, BUBBLE, vec3(0, jitter(0.2, 0.6), 0), jitter(0.6, 1.4));
      for (let k = Math.floor(jitter(0, 3)); k > 0; k--) ctx.particles.emit(at, SPATTER, vec3(jitter(-1.2, 1.2), jitter(2, 4), jitter(-1.2, 1.2)));
    }
    for (let i = countOf(pool.area * 0.008 * ctx.density, dt); i > 0; i--) {
      const at = pointIn(a, pool);
      if (at) ctx.particles.emit(at, LAVA_FUME, vec3(jitter(-0.2, 0.2), jitter(0.5, 1.1), jitter(-0.2, 0.2)), jitter(0.8, 1.4));
    }
  };

  const fall = (f: Waterfall, dt: number): void => {
    if (Math.hypot(f.x - ctx.eye.x, f.z - ctx.eye.z) > FALL_NEAR) return;
    // Le pied de la cascade : un peu en aval du rideau
    const ax = Math.sin(f.dir);
    const az = Math.cos(f.dir);
    const foot = (spread: number): Vec3 => {
      const s = jitter(-0.5, 0.5) * f.width;
      return vec3(f.x + az * s + ax * jitter(0.3, 1 + spread), f.bottom + 0.1, f.z - ax * s + az * jitter(0.3, 1 + spread));
    };
    for (let i = countOf(5 * f.width * ctx.density, dt); i > 0; i--) ctx.particles.emit(foot(1), MIST, vec3(ax * jitter(0.3, 1), jitter(0.3, 1.2), az * jitter(0.3, 1)), jitter(0.8, 1.4));
    for (let i = countOf(14 * f.width * ctx.density, dt); i > 0; i--) {
      ctx.particles.emit(foot(0), DROP, vec3(ax * jitter(0.5, 2.2) + jitter(-0.6, 0.6), jitter(1.5, 3.5), az * jitter(0.5, 2.2) + jitter(-0.6, 0.6)));
    }
  };

  return {
    update(dt) {
      const a = ready();
      for (const [v, carry] of plumes) vent(v, carry, dt);
      for (const pool of pools) lava(a, pool, dt);
      for (const f of a.falls ?? []) fall(f, dt);
    },
    dispose() {
      plumes.clear();
      pools = [];
    },
  };
}
