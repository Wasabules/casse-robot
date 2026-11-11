/*
 * Munitions visibles sur la tête d'une tourelle (missiles, roquettes, ogive, bombes, capsules) :
 * combien en montrer, d'après ce qui reste dans le chargeur. Une tête montre `slots` coups pour un
 * chargeur de `capacity` : on en montre la même part, au moins un tant qu'il en reste un.
 */

/** Nombre de coups à montrer sur `slots` places, pour `ammo` coups restants sur `capacity`. */
export function visibleRounds(slots: number, ammo: number, capacity: number): number {
  if (ammo <= 0 || capacity <= 0) return 0;
  return Math.min(slots, Math.max(1, Math.round((slots * Math.min(ammo, capacity)) / capacity)));
}

/** Durée (s) pendant laquelle un coup revenu (rechargé) se glisse dans son logement. */
export const ROUND_RETURN = 0.35;

/** Recul (m) d'un coup qui revient : il sort de l'arrière de son logement, puis avance à sa place. */
export const ROUND_SLIDE = 0.12;
