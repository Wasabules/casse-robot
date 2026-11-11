import { groundLevel } from "../../../shared/arena/layout";
import { vec3 } from "../../../shared/math/vec";
import { emissions, type FxContext, type FxSystem } from "./fx";
import { jitter } from "./layer";
import type { PuffSpec } from "./particles";

/*
 * Poussière en suspension (`ArenaSky.dust`, la Cité) : autour de la caméra, des grains fins qui
 * dérivent au vent, et plus loin des voiles de poussière pâles qui passent lentement. Rien dans
 * une arène qui n'en a pas.
 */

/** Grain : un point clair, qui flotte et retombe à peine. */
const MOTE: PuffSpec = { color: "#d2c6ad", kind: "smoke", size: 0.05, life: 6, alpha: 0.65, fadeIn: 0.2, drag: 0.2, gravity: 0.05, wind: 1 };
/** Voile : une grande bouffée presque transparente, qui s'étale. */
const VEIL: PuffSpec = { color: "#b9ae98", kind: "vapor", size: 3, grow: 7, life: 9, alpha: 0.07, fadeIn: 0.3, drag: 0.1, gravity: -0.05, wind: 1.5 };
/** Grains autour de la caméra (m) ; voiles, entre VEIL_NEAR et VEIL_FAR m. */
const MOTE_RANGE = 9;
const VEIL_NEAR = 12;
const VEIL_FAR = 45;

export function dustFx(ctx: FxContext): FxSystem {
  const motes = { acc: 0 };
  const veils = { acc: 0 };
  return {
    update(dt) {
      const rate = ctx.world.arena.sky?.dust ?? 0;
      if (!rate) return;
      const eye = ctx.eye;
      for (let i = emissions(motes, rate * 1.5 * ctx.density, dt); i > 0; i--) {
        const at = vec3(eye.x + jitter(-MOTE_RANGE, MOTE_RANGE), eye.y + jitter(-3, 3), eye.z + jitter(-MOTE_RANGE, MOTE_RANGE));
        ctx.particles.emit(at, MOTE, vec3(jitter(-0.3, 0.3), jitter(-0.1, 0.15), jitter(-0.3, 0.3)), jitter(0.6, 1.4));
      }
      for (let i = emissions(veils, rate * 0.35 * ctx.density, dt); i > 0; i--) {
        const a = Math.random() * Math.PI * 2;
        const r = jitter(VEIL_NEAR, VEIL_FAR);
        const x = eye.x + Math.cos(a) * r;
        const z = eye.z + Math.sin(a) * r;
        const at = vec3(x, groundLevel(ctx.world.arena, x, z) + jitter(0.5, 4), z);
        ctx.particles.emit(at, VEIL, vec3(jitter(-0.4, 0.4), 0, jitter(-0.4, 0.4)), jitter(0.7, 1.3));
      }
    },
    dispose() {},
  };
}
