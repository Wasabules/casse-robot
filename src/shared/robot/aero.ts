import { blockDef, type AeroSpec } from "../catalog/blocks";
import { AIR_DENSITY, STEP } from "../config";
import { boundedLeastSquares } from "../math/linalg";
import { clamp } from "../math/scalar";
import { add, cross, dot, qrot, scale, sub, vec3, type Vec3 } from "../math/vec";
import type { AeroSurface, Bot } from "../sim/entities";
import { blockWorldPos } from "./queries";
import { flapRuns } from "./surfaces";
import { dcos, dsin } from "../math/det";

/** Vitesse de braquage des gouvernes (rad/s) : ce sont des servomoteurs, pas des interrupteurs. */
const SERVO_RATE = 3;

const aeroOf = (s: AeroSurface): AeroSpec => blockDef(s.block.type).aero!;

/** Coefficients de portance et de traînée d'une plaque à l'incidence α (rad). */
export function aeroCoefficients(spec: AeroSpec, alpha: number): { cl: number; cd: number } {
  const a = Math.atan2(dsin(alpha), dcos(alpha)); // ramené dans ]-π, π]
  if (Math.abs(a) <= spec.stallAngle) {
    const cl = spec.liftSlope * a;
    return { cl, cd: spec.dragMin + spec.inducedDrag * cl * cl };
  }
  // Décroché : l'écoulement décolle, la plaque ne porte presque plus et freine beaucoup
  const s = dsin(a);
  return { cl: 0.9 * dsin(2 * a), cd: spec.dragMin + 1.2 * s * s };
}

/** Écoulement de l'air sur une surface : position, vitesse dans le plan de la corde, incidence, directions des forces. */
interface Flow {
  p: Vec3;
  speed2: number;
  alpha: number;
  liftDir: Vec3;
  dragDir: Vec3;
}

function flowAt(s: AeroSurface): Flow | null {
  const rb = s.block.part.rb;
  const q = rb.rotation();
  const p = blockWorldPos(s.block);
  const v = add(rb.linvel(), cross(rb.angvel(), sub(p, rb.worldCom()))); // vitesse du bloc dans l'air immobile
  const n = qrot(q, s.block.up);
  const f = qrot(q, s.block.forward);
  const vn = dot(v, n);
  const vf = dot(v, f);
  const speed2 = vn * vn + vf * vf; // on ignore l'écoulement le long de l'envergure
  if (speed2 < 0.04) return null;
  const speed = Math.sqrt(speed2);
  return {
    p,
    speed2,
    alpha: Math.atan2(-vn, vf) + s.deflection,
    // Portance : perpendiculaire au vent relatif, du côté du haut de la surface
    liftDir: scale(sub(scale(n, vf), scale(f, vn)), 1 / speed),
    dragDir: scale(add(scale(n, vn), scale(f, vf)), -1 / speed),
  };
}

/**
 * Portance et traînée de toutes les surfaces d'un robot, appliquées sur le morceau qui porte
 * chacune : une aile arrachée continue de planer ou de tournoyer.
 */
export function applyAerodynamics(bot: Bot): void {
  for (const s of bot.surfaces) {
    if (!s.block.alive) continue;
    const flow = flowAt(s);
    if (!flow) continue;
    const spec = aeroOf(s);
    const { cl, cd } = aeroCoefficients(spec, flow.alpha);
    const q = 0.5 * AIR_DENSITY * flow.speed2 * spec.area;
    const force = add(scale(flow.liftDir, q * cl), scale(flow.dragDir, q * cd));
    s.block.part.rb.applyImpulseAtPoint(scale(force, STEP), flow.p, true);
  }
}

/** Gouvernes encore reliées au cockpit. */
export function liveFlaps(bot: Bot): AeroSurface[] {
  const ck = bot.cockpit;
  if (!ck.alive) return [];
  return bot.surfaces.filter((s) => s.block.alive && s.block.part === ck.part && aeroOf(s).maxDeflection);
}

/**
 * Gouvernes reliées au cockpit, par rang (voir robot/surfaces.ts) : des gouvernes bout à bout le
 * long de leur envergure font une seule gouverne, qui braque d'un seul angle.
 */
export const flapGroups = (bot: Bot): AeroSurface[][] => flapRuns(bot, liveFlaps(bot));

/**
 * Mélangeur de commandes : braque les gouvernes selon la position du manche `stick` (une valeur
 * de -1 à 1 par axe de `axes`, positive = rotation positive autour de l'axe), avec les
 * priorités `weights`. Comme sur un vrai avion, manche à fond = gouvernes à fond, quelle que
 * soit la vitesse. L'effet d'un braquage sur chaque axe est estimé d'après l'écoulement que
 * voit chaque bloc (pression dynamique, bras de levier depuis le centre de masse), cumulé sur
 * chaque gouverne (un rang de blocs, qui braquent du même angle : voir `flapGroups`), puis
 * les braquages sont répartis par moindres carrés bornés. Deux gouvernes de part et d'autre se
 * braquent donc en sens opposés pour rouler (ailerons), une gouverne de queue horizontale sert
 * à cabrer (profondeur), une verticale à tourner (direction), sans rien déclarer à l'avance.
 */
export function steerSurfaces(bot: Bot, stick: readonly number[], axes: readonly Vec3[], weights: readonly number[]): void {
  const groups = flapGroups(bot);
  if (!groups.length) return;
  const com = bot.cockpit.part.rb.worldCom();
  const limits = groups.map((g) => aeroOf(g[0]).maxDeflection ?? 0);
  const effects = groups.map((g) => {
    let effect = vec3(0, 0, 0);
    for (const s of g) {
      const flow = flowAt(s);
      if (!flow) continue;
      const spec = aeroOf(s);
      const k = 0.5 * AIR_DENSITY * flow.speed2 * spec.area * spec.liftSlope; // N par rad
      effect = add(effect, scale(cross(sub(flow.p, com), flow.liftDir), k)); // N·m par rad
    }
    return effect;
  });
  // Mise à l'échelle pour que le système reste bien conditionné à toutes les vitesses
  const unit = Math.max(1e-6, ...effects.map((e) => Math.hypot(e.x, e.y, e.z)));
  const rows = axes.map((a) => effects.map((e) => dot(e, a) / unit));
  // Couple visé sur chaque axe : la part `stick` de ce que les gouvernes peuvent produire au maximum
  const targets = rows.map((row, k) => clamp(stick[k], -1, 1) * row.reduce((s, c, i) => s + Math.abs(c) * limits[i], 0));
  const command = boundedLeastSquares(rows, targets, weights, limits.map((l) => -l), limits, 1e-3);
  groups.forEach((g, i) => {
    // Toute la gouverne braque du même angle (un rang qui vient de se former part de la moyenne des siens)
    const now = g.reduce((s, f) => s + f.deflection, 0) / g.length;
    const next = now + clamp(command[i] - now, -SERVO_RATE * STEP, SERVO_RATE * STEP);
    for (const s of g) s.deflection = next;
  });
}
