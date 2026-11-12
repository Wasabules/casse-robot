//! La détection (src/shared/sim/detection.ts) : ce que chaque équipe sait de l'ennemi. Un robot ennemi
//! est repéré s'il est à portée de vue d'un robot de l'équipe, sans décor ni accessoire entre eux (les
//! robots ne cachent pas), ou à portée de l'un de ses radars (qui voient à travers) ; un brouilleur
//! réduit la portée des radars ennemis sur lui. Mise à jour par tranches de TICK s, d'après la position
//! de chaque robot au dernier pas où il a réfléchi (`lastPos`).
//!
//! Il n'y a encore ni fumée (rien ne cache la vue que le décor), ni projectiles (ni mines à repérer,
//! ni capteurs posés), ni impulsion électromagnétique (aucun radar paralysé). L'IA hors combat ne se
//! sert pas de ce qui est repéré : ses tourelles et sa tactique (pas encore portées) le feront.

use super::vec::{V3, len, scale, sub};
use super::world::{Owner, STEP, Sim};
use super::catalog::catalog;
use crate::jsmath;

/// La détection est mise à jour par tranches de cette durée (s).
const TICK: f64 = 0.25;
/// Portée de vue d'un robot (m) (`SIGHT_RANGE`, config.ts).
const SIGHT_RANGE: f64 = 70.0;

/// Met à jour ce que chaque équipe a repéré (`updateDetection`), au début du pas.
pub fn update_detection(sim: &mut Sim) {
    // (`sim.detected.size` : la détection a déjà tourné)
    if sim.detected[0].is_some() && (sim.time / TICK).floor() == ((sim.time - STEP) / TICK).floor() {
        return;
    }
    for team in 0..2 {
        let observers: Vec<usize> = (0..sim.bots.len()).filter(|&o| sim.bots[o].team == team && sim.bots[o].cockpit_alive()).collect();
        let mut seen = Vec::new();
        for enemy in 0..sim.bots.len() {
            if sim.bots[enemy].team == team || !sim.bots[enemy].cockpit_alive() {
                continue;
            }
            if observers.iter().any(|&o| spots(sim, o, enemy)) {
                seen.push(enemy);
            }
        }
        sim.detected[team] = Some(seen);
    }
}

/// `observer` repère-t-il `enemy`, de ses yeux ou de son radar (`spots`) ?
fn spots(sim: &Sim, observer: usize, enemy: usize) -> bool {
    // (`areEnemies` : deux robots distincts d'équipes différentes, ce qu'ils sont ici)
    let eye = sim.bots[observer].last_pos;
    let there = sim.bots[enemy].last_pos;
    let d = jsmath::hypot3(eye.x - there.x, eye.y - there.y, eye.z - there.z);
    let radar = radar_range(sim, observer);
    if radar > 0.0 && d <= jsmath::min(radar, jammer_range(sim, enemy)) {
        return true;
    }
    d <= SIGHT_RANGE && in_sight(sim, eye, there)
}

/// Portée du meilleur radar d'un robot, sur le morceau de son cockpit (0 s'il n'en a pas) (`radarRange`).
fn radar_range(sim: &Sim, bot: usize) -> f64 {
    let b = &sim.bots[bot];
    let c = catalog();
    let mut range: f64 = 0.0;
    for &k in &sim.part(b.cockpit_part()).blocks {
        range = jsmath::max(range, c.blocks[&b.blocks[k].kind].radar);
    }
    range
}

/// Portée au-delà de laquelle les radars ennemis ne repèrent plus ce robot (`jammerRange`).
fn jammer_range(sim: &Sim, bot: usize) -> f64 {
    let b = &sim.bots[bot];
    let c = catalog();
    let mut range = f64::INFINITY;
    for &k in &sim.part(b.cockpit_part()).blocks {
        range = jsmath::min(range, c.blocks[&b.blocks[k].kind].jammer.unwrap_or(f64::INFINITY));
    }
    range
}

/// Ligne de vue : ni décor ni accessoire entre les deux (les robots ne cachent pas) (`inSight`).
fn in_sight(sim: &Sim, from: V3, to: V3) -> bool {
    let seg = sub(to, from);
    let length = len(seg);
    if length < 1e-3 {
        return true;
    }
    let keep = |h| matches!(sim.owners.get(&h), None | Some(Owner::Prop(_)));
    sim.phys.cast_ray_where(from, scale(seg, 1.0 / length), length, true, &keep).is_none()
}
