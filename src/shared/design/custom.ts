import { blockDef } from "../catalog/blocks";
import { meleeDef, meleeOffensive } from "../catalog/melee";
import { wheelDef } from "../catalog/wheels";
import { clamp } from "../math/scalar";
import { flightStats } from "./flight";
import { AXES, DEFAULT_FACING, type RobotDesign } from "./robotDesign";
import type { BotProfile, Mobility } from "./presets";

/*
 * Robots construits au garage : on en fait un profil jouable. Leur façon de se déplacer se déduit
 * de leurs organes, et leur vitesse de croisière de ceux qui les portent.
 */

/** Vitesse de croisière d'un robot sur patins, sur pattes, ou volant (m/s). */
const HOVER_PAD_SPEED = 6;
const LEG_SPEED = 3;
const FLYING_SPEED = 5;
/**
 * Vitesse de croisière d'un avion (m/s) : PLANE_SPEED.base, plus PLANE_SPEED.perThrust par unité
 * de poussée rapportée au poids, entre PLANE_SPEED.min et PLANE_SPEED.max (l'Avion prédéfini, qui
 * pousse 0,4 fois son poids, vole à 12 m/s ; trop lent, un avion décroche ; trop vite, il ne tient
 * plus dans l'arène en virage).
 */
const PLANE_SPEED = { base: 8, perThrust: 10, min: 11, max: 20 };

/**
 * Mobilité d'un plan : volant s'il a des moteurs qui poussent vers le haut (rotors) ; avion s'il
 * a des ailes et un propulseur vers l'avant ; au sol sinon (roues, chenilles, patins, pattes).
 */
export function inferMobility(design: RobotDesign): Mobility {
  let lift = false;
  let push = false;
  let wings = false;
  for (const b of design.blocks) {
    const def = blockDef(b.type);
    const up = AXES[(b.facing ?? DEFAULT_FACING).up];
    if (def.thruster && up.y > 0.7) lift = true;
    if (def.thruster && up.z > 0.7) push = true;
    if (def.aero) wings = true;
  }
  if (lift) return "hover";
  if (wings && push) return "plane";
  return "ground";
}

/** Vitesse de croisière (m/s) : la plus lente de ses roues à vide, ou celle de ses appuis ; un avion, d'après sa poussée. */
export function cruiseSpeed(design: RobotDesign, mobility: Mobility): number {
  if (mobility === "plane") return clamp(PLANE_SPEED.base + PLANE_SPEED.perThrust * flightStats(design).thrustRatio, PLANE_SPEED.min, PLANE_SPEED.max);
  if (mobility !== "ground") return FLYING_SPEED;
  // Les roulettes, sans moteur, suivent
  const driven = design.wheels.map((w) => wheelDef(w.type)).filter((def) => def.stallTorque > 0);
  if (driven.length) return 0.85 * Math.min(...driven.map((def) => def.freeSpeed * def.radius));
  const supports = design.blocks.map((b) => blockDef(b.type).support).filter((s) => s !== undefined);
  if (supports.some((s) => s.kind === "leg")) return LEG_SPEED;
  return supports.length ? HOVER_PAD_SPEED : 0;
}

/** Profil jouable d'un robot du garage. */
export function profileFromDesign(name: string, color: string, design: RobotDesign): BotProfile {
  const mobility = inferMobility(design);
  const speed = cruiseSpeed(design, mobility);
  return {
    id: `garage:${name}`,
    name,
    color,
    speed,
    turn: speed * 0.6,
    // Une arme de contact ne frappe qu'au contact : son IA charge (voir ai/tactics.ts) ; un champ, qui défend sa coque, ne compte pas
    behavior: design.blocks.some((b) => {
      const melee = blockDef(b.type).melee;
      return melee !== undefined && meleeOffensive(meleeDef(melee));
    }) ? "charge" : "flee",
    mobility,
    design,
  };
}
