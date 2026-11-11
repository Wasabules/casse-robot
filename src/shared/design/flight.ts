import { blockDef } from "../catalog/blocks";
import { wheelDef } from "../catalog/wheels";
import { BLOCK_SIZE, COCKPIT_BATTERY, GENERATOR_POWER, GRAVITY } from "../config";
import { vec3, type Vec3 } from "../math/vec";
import { AXES, DEFAULT_FACING, wheelLocalPos, type RobotDesign } from "./robotDesign";

/*
 * Caractéristiques de vol d'un plan, pour le garage : ce que peuvent porter ses rotors, ce que
 * poussent ses propulseurs, et combien de temps ses batteries le tiennent en l'air. C'est une
 * estimation à l'arrêt (le pilote de vol, lui, garde de la poussée pour l'assiette et le cap) : le
 * jeu mesure la portance réelle avec `liftToWeight` (robot/propulsion.ts).
 */

export interface FlightStats {
  /** Masse du robot, blocs et roues (kg). */
  mass: number;
  /** Poussée maximale des rotors de sustentation (vers le haut du robot) et des propulseurs (vers l'avant) (N). */
  lift: number;
  cruise: number;
  /** Poussée de sustentation rapportée au poids : au-dessus de 1, il décolle. */
  liftRatio: number;
  /** Poussée des propulseurs rapportée au poids. */
  thrustRatio: number;
  /** Capacité des batteries (kJ). */
  battery: number;
  /**
   * Autonomie en vol stationnaire (s) : Infinity si le générateur suffit, null s'il ne décolle pas.
   * Les rotors consomment en proportion de leur poussée.
   */
  hoverTime: number | null;
}

/** Masse d'un plan (kg). */
export function designMass(design: RobotDesign): number {
  return design.blocks.reduce((s, b) => s + blockDef(b.type).mass, 0) + design.wheels.reduce((s, w) => s + wheelDef(w.type).mass, 0);
}

/**
 * Centre de masse d'un plan (m, repère du robot) : blocs à leur case, roues à leur place. Le
 * garage le montre : un rotor d'hélicoptère doit être à son aplomb, un robot haut perché bascule.
 */
export function designCenterOfMass(design: RobotDesign): Vec3 {
  let mass = 0;
  let x = 0;
  let y = 0;
  let z = 0;
  const add = (m: number, p: Vec3): void => {
    mass += m;
    x += m * p.x;
    y += m * p.y;
    z += m * p.z;
  };
  for (const b of design.blocks) add(blockDef(b.type).mass, vec3(b.x * BLOCK_SIZE, b.y * BLOCK_SIZE, b.z * BLOCK_SIZE));
  for (const w of design.wheels) add(wheelDef(w.type).mass, wheelLocalPos(w));
  return mass > 0 ? vec3(x / mass, y / mass, z / mass) : vec3(0, 0, 0);
}

export function flightStats(design: RobotDesign): FlightStats {
  const mass = designMass(design);
  const weight = mass * GRAVITY;
  let lift = 0;
  let liftPower = 0;
  let cruise = 0;
  let battery = COCKPIT_BATTERY;
  for (const b of design.blocks) {
    const def = blockDef(b.type);
    battery += def.battery?.capacity ?? 0;
    const spec = def.thruster;
    if (!spec) continue;
    // Même partage que les moteurs d'un robot (addThrusters) : vers le haut, sustentation ; vers l'avant, propulsion
    const up = AXES[(b.facing ?? DEFAULT_FACING).up];
    if (up.y > 0.7) {
      lift += spec.maxThrust;
      liftPower += spec.power;
    } else if (up.z > 0.7) {
      cruise += spec.maxThrust;
    }
  }
  const liftRatio = weight > 0 ? lift / weight : 0;
  let hoverTime: number | null = null;
  if (liftRatio >= 1) {
    const draw = liftPower / liftRatio - GENERATOR_POWER;
    hoverTime = draw > 0 ? battery / draw : Infinity;
  }
  return { mass, lift, cruise, liftRatio, thrustRatio: weight > 0 ? cruise / weight : 0, battery, hoverTime };
}
