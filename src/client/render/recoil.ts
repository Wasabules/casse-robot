import { weaponDef, type WeaponId } from "../../shared/catalog/weapons";
import { liveTurrets, turretFrame } from "../../shared/combat/turrets";
import { clamp } from "../../shared/math/scalar";
import { distance, type Vec3 } from "../../shared/math/vec";
import type { Turret } from "../../shared/sim/entities";
import type { World } from "../../shared/sim/world";

/*
 * Recul visible d'un tir. La simulation pousse déjà le robot à l'opposé du tir (`Weapon.recoil`,
 * combat/turrets.ts), mais un fusil sur un robot de 50 kg ne le fait bouger que de quelques cm/s :
 * rien ne se voit. Le client montre donc le coup : la tête de la tourelle recule puis revient
 * (`WorldView`), et la vue du joueur saute vers le haut puis retombe (`CameraRig.kick`). Les deux
 * se déduisent de `Weapon.recoil` : une arme sans recul (laser, plasma, lance-flammes, mines,
 * bombes) ne bouge pas.
 */

/** Une tourelle tire depuis la bouche de son canon : au-delà de cette distance (m), ce n'est pas elle. */
const MUZZLE_MATCH = 0.6;

/** La tourelle qui vient de tirer ce coup : parmi celles de l'arme, celle dont la bouche est au départ du tir. */
export function firingTurret(world: World, weapon: WeaponId, origin: Vec3): Turret | null {
  let best: Turret | null = null;
  let bestDistance = MUZZLE_MATCH;
  for (const bot of world.bots) {
    for (const t of liveTurrets(bot)) {
      if (t.weapon !== weapon) continue;
      const d = distance(turretFrame(t).muzzle, origin);
      if (d < bestDistance) {
        best = t;
        bestDistance = d;
      }
    }
  }
  return best;
}

/**
 * Recul d'une arme à l'écran : de combien sa tête recule (m) et de combien la vue du tireur saute
 * vers le haut (rad, au viseur ; moitié moins de dos). Fusil : 2,5 cm et 0,3° ; sniper : 9 cm et
 * 1,3° ; canon : 16 cm et 2,5°.
 */
export function recoilKick(weapon: WeaponId): { back: number; view: number } {
  const recoil = weaponDef(weapon).recoil;
  if (recoil < 1) return { back: 0, view: 0 };
  return { back: clamp(0.02 + recoil * 0.0018, 0, 0.18), view: clamp(0.003 + recoil * 0.0005, 0, 0.045) };
}
