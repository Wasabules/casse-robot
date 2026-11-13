//! L'IA des armes de contact (src/shared/ai/brawl.ts), et la commande du pilote
//! (`operatePlayerMelee`, src/shared/sim/player.ts). L'IA lance ses rotors quand un ennemi repéré
//! approche (un rotor très déséquilibré ne tourne plus qu'au contact) ; elle frappe du marteau ou du
//! fouet quand sa tête toucherait un robot ennemi le long de son arc, de la lance quand sa pointe en
//! toucherait un, lève le flipper quand un ennemi est sur son plateau, mord de la mâchoire ce qui est
//! dans sa gueule ; un champ s'arme seul quand un ennemi approche (pour le pilote aussi). La tactique
//! (tactics.rs) la fait charger une fois ses rotors lancés (`meleePrimed`), son arme présentée à sa
//! cible (`meleeBearing`) ; une foreuse vise le cockpit (`chargePoint`), une scie qui mord longe sa
//! cible (`meleeSkim`) ; tant qu'une lame mord, la conduite ne se croit pas coincée (`meleeBiting`) ;
//! une mâchoire qui tient sa proie la traîne à reculons (`meleeDrive`).

use super::catalog::Mobility;
use super::debris::block_world_pos;
use super::gunner::are_enemies;
use super::brain::Mode;
use super::mechanics::{flip_would_hit, gripping, jaw_would_bite};
use super::robot::Input;
use super::melee::{Phase, Surface, all_around, distance, live_melee, melee_charge, melee_offensive, strike_would_hit, thrust_would_hit, unbalance_share, wielded};
use super::tactics::is_detected;
use super::vec::{V3, clamp, qrot_inv};
use super::world::Sim;
use crate::jsmath;

/// Un ennemi repéré à moins de cette distance (m) : les rotors montent en régime (au plus).
const SPIN_RANGE: f64 = 35.0;
/// Un rotor se lance quand l'ennemi est à moins de ce qu'il couvrira pendant sa montée en régime.
const CLOSING: f64 = 12.5;
const SPIN_MARGIN: f64 = 6.0;
/// Un rotor à ce balourd ou plus ne tourne plus qu'avec un ennemi à moins de SPIN_CLOSE m.
const SEVERE_UNBALANCE: f64 = 0.6;
const SPIN_CLOSE: f64 = 8.0;
/// Un ennemi à moins de cette distance (m) : on regarde si une frappe le toucherait.
const STRIKE_LOOK: f64 = 7.0;
/// Un ennemi repéré à moins de cette distance (m) : un champ s'arme.
const FIELD_RANGE: f64 = 15.0;
/// Régime à partir duquel un rotor est prêt à charger ; une lame qui mord, plus tôt.
const PRIMED: f64 = 0.85;
const BITE_PRIMED: f64 = 0.6;
/// Gaz quand il tient une proie dans sa mâchoire : il recule.
const DRAG_THROTTLE: f64 = -0.8;
/// En longeant sa cible, une scie la garde de ce côté de son avant (rad).
const SKIM: f64 = 0.55;

/// Distance du plus proche ennemi repéré (`nearestFoe`, m), ou ∞.
fn nearest_foe(sim: &Sim, b: usize) -> f64 {
    let team = sim.bots[b].team;
    let mut best = f64::INFINITY;
    for o in sim.roster.clone() {
        if !sim.bots[o].cockpit_alive() || !are_enemies(sim, b, o) || !is_detected(sim, team, o) {
            continue;
        }
        best = jsmath::min(best, distance(sim.bots[o].last_pos, sim.bots[b].last_pos));
    }
    best
}

/// Distance d'un ennemi à laquelle un rotor se lance (`spinRange`) : ce qu'il faut pour être à plein
/// régime au contact.
fn spin_range(spin_up: f64) -> f64 {
    clamp(CLOSING * spin_up + SPIN_MARGIN, SPIN_CLOSE, SPIN_RANGE)
}

/// Un champ doit-il s'armer (`fieldWanted`) ? Un ennemi repéré approche.
pub fn field_wanted(sim: &Sim, b: usize) -> bool {
    nearest_foe(sim, b) < FIELD_RANGE
}

/// Commandes de l'IA pour ses armes de contact, à ce pas (`operateMelee`).
pub fn operate_melee(sim: &mut Sim, b: usize) {
    let arms = live_melee(sim, b);
    if arms.is_empty() {
        return;
    }
    let near = nearest_foe(sim, b);
    let charging = sim.bots[b].ai.mode == Mode::Charge;
    for a in arms {
        let arm = sim.bots[b].melee[a];
        let spec = arm.spec();
        match spec.motion.as_str() {
            "spin" => {
                let spin = spec.spin.expect("rotor sans régime");
                sim.bots[b].melee[a].wanted =
                    if unbalance_share(sim, b, &arm) >= SEVERE_UNBALANCE { near < SPIN_CLOSE } else { charging || near < spin_range(spin.spin_up) };
            }
            "swing" => sim.bots[b].melee[a].trigger = arm.phase == Phase::Ready && near < STRIKE_LOOK && strike_would_hit(sim, b, a),
            "thrust" => sim.bots[b].melee[a].trigger = arm.phase == Phase::Ready && near < STRIKE_LOOK && thrust_would_hit(sim, b, a),
            "field" => sim.bots[b].melee[a].wanted = near < FIELD_RANGE,
            // Frappes à mécanique : le flipper lève quand un ennemi est sur son plateau ; le fléau tourne
            // comme un rotor ; la mâchoire mord ce qui est dans sa gueule et tient sa proie
            "flip" => sim.bots[b].melee[a].trigger = arm.phase == Phase::Ready && near < STRIKE_LOOK && flip_would_hit(sim, b, a),
            "flail" => {
                let flail = spec.flail.expect("fléau sans boule");
                sim.bots[b].melee[a].wanted = charging || near < spin_range(flail.spin_up);
            }
            "grip" => {
                sim.bots[b].melee[a].trigger = arm.phase == Phase::Hold || (arm.phase == Phase::Ready && near < STRIKE_LOOK && jaw_would_bite(sim, b, a));
            }
            // (une hélice : son moteur la mène)
            _ => {}
        }
    }
}

/// Une arme de contact peut-elle frapper ce robot (`meleeSuits`) ? Un robot au sol.
pub fn melee_suits(sim: &Sim, other: usize) -> bool {
    sim.bots[other].mobility == Mobility::Ground
}

/// Ses armes de contact offensives reliées au cockpit (`offensiveMelee`).
pub fn offensive_melee(sim: &Sim, b: usize) -> Vec<usize> {
    live_melee(sim, b).into_iter().filter(|&a| melee_offensive(sim.bots[b].melee[a].spec())).collect()
}

/// Ses rotors (et ses fléaux) sont-ils assez lancés pour charger (`meleePrimed`) ?
pub fn melee_primed(sim: &Sim, b: usize) -> bool {
    offensive_melee(sim, b).into_iter().all(|a| {
        let arm = &sim.bots[b].melee[a];
        let spec = arm.spec();
        if spec.motion == "flail" {
            return melee_charge(arm) >= PRIMED;
        }
        spec.motion != "spin" || arm.bite.is_some() || melee_charge(arm) >= (if spec.bite.is_some() { BITE_PRIMED } else { PRIMED })
    })
}

/// Conduite imposée par une arme de contact (`meleeDrive`) : à reculons, en traînant la proie que tient
/// sa mâchoire ; rien sinon.
pub fn melee_drive(sim: &Sim, b: usize) -> Option<(f64, f64)> {
    gripping(sim, b).then_some((DRAG_THROTTLE, 0.0))
}

/// Côté où est son arme de contact, vu de dessus (`meleeBearing`, rad, > 0 : à gauche de l'avant) ;
/// rien s'il n'en a pas, ou qu'elle n'est pas dans sa moitié avant.
pub fn melee_bearing(sim: &Sim, b: usize) -> Option<f64> {
    let bot = &sim.bots[b];
    // (un anneau-coque frappe de tous côtés : il n'a rien à présenter)
    let arms: Vec<usize> = offensive_melee(sim, b).into_iter().filter(|&a| !all_around(bot.melee[a].spec())).collect();
    if arms.is_empty() {
        return None;
    }
    let ck = bot.blocks[bot.cockpit].local;
    let mut x = 0.0;
    let mut z = 0.0;
    for a in arms {
        let l = bot.blocks[bot.melee[a].block].local;
        x += l.x - ck.x;
        z += l.z - ck.z;
    }
    if z <= 0.0 {
        return None;
    }
    Some(f64::atan2(x, z))
}

/// Une de ses lames mord-elle un robot (`meleeBiting`) ?
pub fn melee_biting(sim: &Sim, b: usize) -> bool {
    live_melee(sim, b).into_iter().any(|a| sim.bots[b].melee[a].bite.is_some_and(|bt| bt.surface == Surface::Robot))
}

/// En chargeant, une scie qui mord un robot le longe (`meleeSkim`) : un angle à ajouter à celui où il
/// présente son arme (rad), ou 0.
pub fn melee_skim(sim: &Sim, b: usize) -> f64 {
    let bot = &sim.bots[b];
    let q = sim.phys.rotation(sim.part(bot.cockpit_part()).rb);
    for a in live_melee(sim, b) {
        let arm = &bot.melee[a];
        let Some(bite) = arm.spec().bite else { continue };
        let Some(bt) = arm.bite else { continue };
        if bite.grab <= 0.0 || bt.surface != Surface::Robot {
            continue;
        }
        // La lame va vers sa gauche (x > 0) : la prise tire le robot vers sa droite, la cible reste à gauche
        let side = qrot_inv(q, bt.dir).x;
        if side.abs() > 0.2 {
            return jsmath::sign(side) * SKIM;
        }
    }
    0.0
}

/// Où charger une cible (`chargePoint`) : une mèche vise son cockpit ; sinon, la cible elle-même (rien).
pub fn charge_point(sim: &Sim, b: usize, foe: usize) -> Option<V3> {
    if !sim.bots[foe].cockpit_alive() {
        return None;
    }
    if !live_melee(sim, b).into_iter().any(|a| sim.bots[b].melee[a].spec().bite.is_some_and(|bt| bt.axial)) {
        return None;
    }
    Some(block_world_pos(sim, foe, sim.bots[foe].cockpit))
}

/// Les armes de contact du pilote (`operatePlayerMelee`) : un rotor, un fléau tourne tant qu'il est
/// l'arme choisie (ou qu'aucune ne l'est) ; un bras, une pointe, un flipper, une mâchoire frappe à la
/// gâchette ; un champ s'arme seul quand un ennemi approche ; une hélice, son moteur la mène.
/// `input` : les commandes de ce pas (une ogive pilotée en vol les remet à zéro).
pub fn operate_player_melee(sim: &mut Sim, b: usize, input: &Input) {
    for a in 0..sim.bots[b].melee.len() {
        let arm = sim.bots[b].melee[a];
        let spec = arm.spec();
        if !wielded(spec) {
            continue;
        }
        if !melee_offensive(spec) {
            let wanted = field_wanted(sim, b);
            sim.bots[b].melee[a].wanted = wanted;
            continue;
        }
        let chosen = input.weapon.is_none_or(|w| w == arm.weapon);
        let m = &mut sim.bots[b].melee[a];
        m.wanted = chosen;
        m.trigger = chosen && input.trigger;
    }
}
