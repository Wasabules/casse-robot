//! Le verrouillage (src/shared/combat/lock.ts, arme à `lock`) : il faut garder un ennemi dans le cône
//! de l'arme un moment avant de pouvoir tirer ; ses missiles poursuivent ensuite la cible verrouillée.
//! Une fois prise, la cible reste tenue dans un cône plus large ; sortie du cône, le verrou retombe,
//! puis passe à l'ennemi en vue le plus proche de la visée ; cachée par le décor, il ne progresse
//! plus, et il est perdu au bout de `LOCK_GRACE`.

use super::gunner::are_enemies;
use super::sight::sight_blocked;
use super::tactics::is_detected;
use super::turrets::weapon;
use super::vec::{V3, dot, norm, sub};
use super::world::Sim;
use crate::det::dcos;
use crate::jsmath;

/// Une fois la cible prise, elle reste tenue dans un cône plus large d'autant (`HOLD_CONE`).
const HOLD_CONE: f64 = 1.8;
/// Verrou acquis : il tient tant que la cible reste à moins de cet angle de la visée (rad) (`LOCKED_HOLD`).
const LOCKED_HOLD: f64 = 0.75;
/// Cible sortie du cône : le verrou retombe à cette vitesse (`DECAY`).
const DECAY: f64 = 2.0;
/// Cible cachée : le verrou est perdu au bout de ce temps (s) (`LOCK_GRACE`).
const LOCK_GRACE: f64 = 1.0;

/// Peut-on verrouiller ce robot (`lockable`) ? Ennemi vivant, repéré par son équipe, à portée de l'arme.
fn lockable(sim: &Sim, bot: usize, t: usize, target: usize, from: V3) -> bool {
    if !sim.bots[target].cockpit_alive() || !are_enemies(sim, bot, target) || !is_detected(sim, sim.bots[bot].team, target) {
        return false;
    }
    let com = sim.phys.world_com(sim.part(sim.bots[target].cockpit_part()).rb);
    jsmath::hypot3(com.x - from.x, com.y - from.y, com.z - from.z) <= weapon(sim, bot, t).range
}

/// Cosinus de l'angle entre `dir` et la direction de `from` vers le cockpit de `target` (`cosTo`).
fn cos_to(sim: &Sim, from: V3, dir: V3, target: usize) -> f64 {
    let com = sim.phys.world_com(sim.part(sim.bots[target].cockpit_part()).rb);
    dot(norm(sub(com, from)), dir)
}

/// La tourelle a verrouillé sa cible (`isLocked`) : elle peut tirer.
pub fn is_locked(sim: &Sim, bot: usize, t: usize) -> bool {
    let turret = &sim.bots[bot].turrets[t];
    // (`lockProgress` : 0 sans verrou)
    let progress = match (weapon(sim, bot, t).lock, turret.lock_on) {
        (Some((time, _)), Some(_)) => jsmath::min(1.0, turret.lock_time / time),
        _ => 0.0,
    };
    turret.lock_on.is_some() && progress >= 1.0
}

/// Oublie le verrou (`releaseLock`).
pub fn release_lock(sim: &mut Sim, bot: usize, t: usize) {
    let turret = &mut sim.bots[bot].turrets[t];
    turret.lock_on = None;
    turret.lock_time = 0.0;
    turret.lock_hidden = 0.0;
}

/// Un pas du verrouillage de la tourelle `t`, qui vise dans la direction unitaire `dir` depuis `from` (`updateLock`).
pub fn update_lock(sim: &mut Sim, bot: usize, t: usize, from: V3, dir: V3, dt: f64) {
    let Some((time, cone)) = weapon(sim, bot, t).lock else { return };
    let held = sim.bots[bot].turrets[t].lock_on;
    let hold = if is_locked(sim, bot, t) { LOCKED_HOLD } else { cone * HOLD_CONE };
    if let Some(h) = held
        && lockable(sim, bot, t, h, from)
        && cos_to(sim, from, dir, h) > dcos(hold)
    {
        if !sight_blocked(sim, from, h) {
            let turret = &mut sim.bots[bot].turrets[t];
            turret.lock_hidden = 0.0;
            turret.lock_time = jsmath::min(time, turret.lock_time + dt);
            return;
        }
        sim.bots[bot].turrets[t].lock_hidden += dt;
        if sim.bots[bot].turrets[t].lock_hidden < LOCK_GRACE {
            return;
        }
        // Cachée trop longtemps : la cible est perdue, on en cherche une autre en vue
        release_lock(sim, bot, t);
    } else {
        let turret = &mut sim.bots[bot].turrets[t];
        turret.lock_time = jsmath::max(0.0, turret.lock_time - DECAY * dt);
        if turret.lock_time > 0.0 {
            return;
        }
    }
    // Les ennemis dans le cône, du plus proche de la visée au plus loin : le premier en vue
    let min_cos = dcos(cone);
    let mut candidates: Vec<(usize, f64)> = Vec::new();
    for other in sim.roster.clone() {
        if !lockable(sim, bot, t, other, from) {
            continue;
        }
        let c = cos_to(sim, from, dir, other);
        if c > min_cos {
            candidates.push((other, c));
        }
    }
    // (un tri stable, comme celui de V8)
    candidates.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let lock_on = candidates.iter().find(|c| !sight_blocked(sim, from, c.0)).map(|c| c.0);
    let turret = &mut sim.bots[bot].turrets[t];
    turret.lock_on = lock_on;
    turret.lock_hidden = 0.0;
}
