import { wheelDef } from "../catalog/wheels";
import { GRAVITY, STEP } from "../config";
import { clamp } from "../math/scalar";
import { qrotInv, sub, type Vec3 } from "../math/vec";
import type { Bot, Wheel } from "../sim/entities";
import { drivenWheels } from "./queries";

/** En deçà de cet écart à la ligne du centre de rotation (m), une roue directrice n'a pas à braquer. */
const MIN_ARM = 0.05;

/**
 * Géométrie de direction d'un robot (épure d'Ackermann), d'après ses roues alimentées. Pour tourner
 * sans que les pneus ripent, toutes les roues doivent rouler autour d'un même centre de rotation.
 * Il se trouve sur la ligne des roues fixes (l'essieu arrière d'une voiture) ; sans roue fixe, à
 * hauteur du centre de masse : les roues de devant et de derrière braquent alors en sens opposés.
 */
export interface SteeringGeometry {
  /** Roues directrices alimentées. */
  readonly steered: readonly Wheel[];
  /** Position (z local) de la ligne qui porte le centre de rotation (m). */
  readonly pivotZ: number;
  /**
   * Courbure maximale (1/m, l'inverse du plus petit rayon de virage), celle où la roue la plus
   * braquée arrive en butée. 0 : le robot ne peut pas braquer et tourne en conduite différentielle.
   */
  readonly maxCurvature: number;
}

/** Centre de masse du morceau du cockpit, dans le repère local du robot. */
function localCom(bot: Bot): Vec3 {
  const rb = bot.cockpit.part.rb;
  return qrotInv(rb.rotation(), sub(rb.worldCom(), rb.translation()));
}

export function steeringGeometry(bot: Bot): SteeringGeometry {
  const wheels = drivenWheels(bot);
  const steered = wheels.filter((w) => w.steerable);
  if (!steered.length) return { steered, pivotZ: 0, maxCurvature: 0 };
  // Les roulettes suivent le virage où qu'il tourne : seules les roues fixes placent son centre
  const fixed = wheels.filter((w) => !w.steerable && !wheelDef(w.type).caster);
  const pivotZ = fixed.length ? fixed.reduce((s, w) => s + w.local.z, 0) / fixed.length : localCom(bot).z;
  let maxCurvature = Infinity;
  for (const w of steered) {
    const arm = Math.abs(w.local.z - pivotZ);
    if (arm < MIN_ARM) continue;
    // La roue du côté intérieur du virage braque le plus : tan a = k·arm / (1 − k·|x|)
    const t = Math.tan(wheelDef(w.type).steering?.maxAngle ?? 0);
    maxCurvature = Math.min(maxCurvature, t / (arm + Math.abs(w.local.x) * t));
  }
  return { steered, pivotZ, maxCurvature: Number.isFinite(maxCurvature) ? maxCurvature : 0 };
}

/**
 * Braquage d'une roue (rad, > 0 : vers la gauche) pour qu'elle roule autour du centre de rotation
 * d'un virage de courbure `k` (> 0 : à gauche) : perpendiculaire au rayon qui la relie à ce centre.
 * La roue intérieure braque plus que la roue extérieure.
 */
export function steerAngle(w: Wheel, k: number, pivotZ: number): number {
  const max = wheelDef(w.type).steering?.maxAngle ?? 0;
  return clamp(Math.atan2(k * (w.local.z - pivotZ), 1 - k * w.local.x), -max, max);
}

/**
 * Vitesse d'une roue dans un virage de courbure `k`, rapportée à celle du point de référence
 * (en x = 0 sur la ligne du centre de rotation) : son rayon de virage divisé par celui de ce point.
 */
export function cornerSpeedRatio(w: Wheel, k: number, pivotZ: number): number {
  return Math.hypot(1 - k * w.local.x, k * (w.local.z - pivotZ));
}

/**
 * Servomoteur de direction : le braquage rejoint `angle` à sa vitesse de braquage. `null` :
 * servomoteur non alimenté ; la roue garde son braquage et pivote librement (elle ne tient plus
 * la route de côté : voir robot/wheels.ts).
 */
export function aimWheel(w: Wheel, angle: number | null): void {
  if (!w.steerable || angle === null) return;
  const step = (wheelDef(w.type).steering?.rate ?? 0) * STEP;
  w.steer += clamp(angle - w.steer, -step, step);
}

/**
 * Décélération (m/s²) à laquelle le robot basculerait vers l'avant en freinant (`forward` : il
 * roule en marche avant ; sinon, vers l'arrière) : le poids passe sur les roues de devant, et il
 * pique du nez quand la résultante sort de leur ligne. Elle vaut g × (écart entre le centre de
 * masse et la roue la plus en avant) / (hauteur du centre de masse au-dessus du sol). Infinity
 * quand elle n'a pas de sens (moins de deux roues, centre de masse hors des roues).
 */
export function pitchoverAccel(bot: Bot, forward: boolean): number {
  const wheels = drivenWheels(bot);
  if (wheels.length < 2) return Infinity;
  const com = localCom(bot);
  let ground = Infinity;
  let edge = forward ? -Infinity : Infinity;
  for (const w of wheels) {
    ground = Math.min(ground, w.local.y - wheelDef(w.type).radius);
    edge = forward ? Math.max(edge, w.local.z) : Math.min(edge, w.local.z);
  }
  const margin = forward ? edge - com.z : com.z - edge;
  const height = com.y - ground;
  if (!(margin > 0) || !(height > 0)) return Infinity;
  return (GRAVITY * margin) / height;
}

/**
 * Accélération latérale (m/s²) à laquelle le robot se renverse en virage, en statique : la force
 * centrifuge fait basculer le poids sur les roues extérieures, et le robot se couche quand la
 * résultante sort du polygone d'appui de ses roues. Elle vaut g × (écart latéral entre le centre
 * de masse et le bord de ce polygone) / (hauteur du centre de masse au-dessus du sol).
 * Infinity quand elle n'a pas de sens (moins de 3 roues, centre de masse hors des roues).
 */
export function rolloverAccel(bot: Bot): number {
  const wheels = drivenWheels(bot);
  if (wheels.length < 3) return Infinity;
  const com = localCom(bot);
  let lo = Infinity;
  let hi = -Infinity;
  let ground = Infinity;
  // Largeur du polygone d'appui à hauteur du centre de masse : ses bords font partie des segments
  // qui relient deux roues, et les autres segments sont à l'intérieur
  for (const a of wheels) {
    ground = Math.min(ground, a.local.y - wheelDef(a.type).radius);
    for (const b of wheels) {
      const dz = b.local.z - a.local.z;
      const t = Math.abs(dz) < 1e-6 ? (Math.abs(com.z - a.local.z) < 1e-6 ? 0 : NaN) : (com.z - a.local.z) / dz;
      if (!(t >= 0 && t <= 1)) continue;
      const x = a.local.x + t * (b.local.x - a.local.x);
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
  }
  const margin = Math.min(hi - com.x, com.x - lo);
  const height = com.y - ground;
  if (!(margin > 0) || !(height > 0)) return Infinity;
  return (GRAVITY * margin) / height;
}
