import { WEAPONS, type Weapon } from "../src/shared/catalog/weapons";

/** Arme de test qui détruit à coup sûr ce qu'elle touche directement. */
export const LETHAL: Weapon = { ...WEAPONS.rifle, projectile: { ...WEAPONS.rifle.projectile, damage: 1e9 } };

/** Arme de test dont l'explosion détruit tout dans un rayon `radius` (m). */
export function lethalBlast(radius: number): Weapon {
  const cannon = WEAPONS.cannon;
  return {
    ...cannon,
    projectile: { ...cannon.projectile, damage: 1e9, explosion: { ...cannon.projectile.explosion, radius, damage: 1e9 } },
  };
}
