//! Les ressources d'une arme (src/shared/combat/arsenal.ts) : sa cadence, sa chaleur (une arme
//! automatique surchauffe, puis se tait jusqu'à être redescendue à `RESUME_HEAT`), son chargeur (un
//! coup regagné à la fois) ; et le rythme commun d'armes identiques (`stackRate`).

use super::catalog::WeaponDef;
use super::robot::ArmState;
use crate::det::dpow;
use crate::jsmath;

/// Chaleur à laquelle une arme en surchauffe tire de nouveau (`RESUME_HEAT`, catalog/weapons.ts).
const RESUME_HEAT: f64 = 0.35;
/// Chaque arme identique de plus ajoute cette part de ce qu'ajoutait la précédente (`STACK_FALLOFF`).
const STACK_FALLOFF: f64 = 0.8;

/// État d'une arme prête à tirer, chargeur plein (`newArmState`).
pub fn new_arm_state(weapon: &WeaponDef) -> ArmState {
    ArmState { cooldown: 0.0, heat: 0.0, overheated: false, ammo: weapon.ammo.map_or(f64::INFINITY, |a| a.0), restock: 0.0 }
}

/// Le temps passe : cadence, refroidissement, rechargement (`tickArm`).
pub fn tick_arm(state: &mut ArmState, weapon: &WeaponDef, dt: f64) {
    state.cooldown = jsmath::max(0.0, state.cooldown - dt);
    if let Some((_, cooling)) = weapon.heat {
        state.heat = jsmath::max(0.0, state.heat - cooling * dt);
        if state.overheated && state.heat <= RESUME_HEAT {
            state.overheated = false;
        }
    }
    if let Some((capacity, reload)) = weapon.ammo
        && state.ammo < capacity
    {
        state.restock += dt;
        if state.restock >= reload {
            state.restock = 0.0;
            state.ammo += 1.0;
        }
    }
}

/// n armes identiques tirent `stack_rate(n)` fois plus vite qu'une seule (`stackRate`).
pub fn stack_rate(count: usize) -> f64 {
    (1.0 - dpow(STACK_FALLOFF, count as f64)) / (1.0 - STACK_FALLOFF)
}

/// L'arme est-elle prête : sa cadence (à une tolérance près), ni surchauffe, au moins un coup (`canFire`) ?
pub fn can_fire(state: &ArmState) -> bool {
    state.cooldown <= 1e-9 && !state.overheated && state.ammo >= 1.0
}

/// Un tir : l'arme attend sa cadence, chauffe, et consomme une munition (`useArm`).
pub fn use_arm(state: &mut ArmState, weapon: &WeaponDef) {
    state.cooldown = weapon.cooldown;
    if let Some((per_shot, _)) = weapon.heat {
        state.heat = jsmath::min(1.0, state.heat + per_shot);
        if state.heat >= 1.0 {
            state.overheated = true;
        }
    }
    if weapon.ammo.is_some() {
        state.ammo -= 1.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deux_armes_tirent_1_8_fois_plus_vite() {
        assert_eq!(stack_rate(1), 1.0);
        assert!((stack_rate(2) - 1.8).abs() < 1e-12);
    }
}
