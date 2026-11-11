import type { RigidBody } from "@dimforge/rapier3d-compat";
import { STEP, TURBULENCE } from "../config";
import { randNormal } from "../math/scalar";
import { scale, vec3 } from "../math/vec";
import { inertiaTimes } from "../robot/propulsion";

/**
 * Rafales d'air sur un corps en vol : à chaque pas, de petites impulsions aléatoires font
 * dériver sa vitesse et sa rotation (marche aléatoire). Un pilote automatique qui contrôle tous
 * les axes les corrige sans peine ; s'il lui manque un axe, le robot part en dérive.
 */
export function buffet(rb: RigidBody): void {
  const k = Math.sqrt(STEP);
  const spin = vec3(randNormal(), randNormal(), randNormal());
  rb.applyTorqueImpulse(inertiaTimes(rb.effectiveAngularInertia(), scale(spin, TURBULENCE.angular * k)), true);
  const gust = vec3(randNormal(), 0.5 * randNormal(), randNormal());
  rb.applyImpulse(scale(gust, rb.mass() * TURBULENCE.linear * k), true);
}
