import type { ProjectileSpec } from "../catalog/weapons";
import { GRAVITY, STEP } from "../config";
import { distance, dot, norm, scale, sub, vec3, type Vec3 } from "../math/vec";

/*
 * Tir en cloche pointé par le joueur (canon, obus IEM, fumigène) : le canon vise droit vers le
 * réticule, sans correction automatique de la chute. C'est le joueur qui lève le réticule pour
 * tirer plus loin : la hausse, donc la portée, est la sienne. Le HUD montre où l'obus tombera.
 */

/** Durée d'un tronçon de trajectoire suivi par `predictImpact` (s). */
const SEGMENT = 6 * STEP;

/**
 * Direction du canon pour que l'obus parte vers `aim` : la vitesse qu'il hérite du robot
 * (`inherit`) est retranchée, de sorte que sa vitesse de départ (`speed` le long du canon, plus
 * `inherit`) soit dirigée vers le point visé.
 */
export function lobDirection(muzzle: Vec3, aim: Vec3, inherit: Vec3, speed: number): Vec3 {
  const d = norm(sub(aim, muzzle));
  // k·d − inherit doit mesurer `speed` : k² − 2k (d·inherit) + |inherit|² − speed² = 0
  const along = dot(d, inherit);
  const k = along + Math.sqrt(Math.max(0, along * along - dot(inherit, inherit) + speed * speed));
  return norm(sub(scale(d, k), inherit));
}

/**
 * Position d'un projectile `t` s après son départ de `from` à la vitesse `vel`, soumis à la part
 * `gravity` de la pesanteur, telle que la calcule son intégration à pas fixe (combat/projectiles.ts :
 * la vitesse change avant le déplacement, d'où le `t + STEP`).
 */
export function ballisticPoint(from: Vec3, vel: Vec3, gravity: number, t: number): Vec3 {
  const drop = 0.5 * GRAVITY * gravity * t * (t + STEP);
  return vec3(from.x + vel.x * t, from.y + vel.y * t - drop, from.z + vel.z * t);
}

/**
 * Temps (s) que met un projectile lancé avec la vitesse verticale `vy` (m/s) pour descendre de
 * `drop` m, selon `ballisticPoint` ; null s'il n'y arrive jamais.
 */
export function fallTime(drop: number, vy: number, gravity: number): number | null {
  const g = GRAVITY * gravity;
  if (g <= 0) return null;
  // vy·t − g·t·(t + STEP)/2 = −drop
  const b = vy - 0.5 * g * STEP;
  const disc = b * b + 2 * g * drop;
  if (disc < 0) return null;
  const t = (b + Math.sqrt(disc)) / g;
  return t > 0 ? t : null;
}

/** Point de chute prévu, et temps de vol jusque-là (s). */
export interface Impact {
  point: Vec3;
  time: number;
}

/**
 * Point de chute d'un projectile lancé de `from` à la vitesse `vel` : on suit sa trajectoire par
 * tronçons jusqu'à ce que `cast` (le premier obstacle sur le segment de `a` à `b`, ou null) en
 * trouve un. Null : il arrive en fin de course en l'air.
 */
export function predictImpact(
  from: Vec3, vel: Vec3, spec: ProjectileSpec, cast: (a: Vec3, b: Vec3) => Vec3 | null,
): Impact | null {
  let a = from;
  let t0 = 0;
  while (t0 < spec.life) {
    const t1 = Math.min(t0 + SEGMENT, spec.life);
    const b = ballisticPoint(from, vel, spec.gravity, t1);
    const hit = cast(a, b);
    if (hit) {
      const length = distance(a, b);
      return { point: hit, time: t0 + (t1 - t0) * (length > 0 ? distance(a, hit) / length : 0) };
    }
    a = b;
    t0 = t1;
  }
  return null;
}
