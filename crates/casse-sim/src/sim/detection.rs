//! La détection (src/shared/sim/detection.ts) : ce que chaque équipe sait de l'ennemi. Un robot ennemi
//! est repéré s'il est à portée de vue d'un robot de l'équipe, sans décor ni accessoire entre eux (les
//! robots ne cachent pas), ou à portée de l'un de ses radars (qui voient à travers) ; un brouilleur
//! réduit la portée des radars ennemis sur lui. Mise à jour par tranches de TICK s, d'après la position
//! de chaque robot au dernier pas où il a réfléchi (`lastPos`).
//!
//! Un capteur posé et armé repère aussi les ennemis proches, à travers tout ; et chaque équipe repère
//! les mines ennemies posées qu'un de ses robots voit de près (son IA les évitera : brain.rs). La
//! fumée cache la vue comme le décor (smoke.rs) ; le radar d'un robot paralysé (emp.rs) ne voit rien.
//! L'IA s'en sert au combat : ses tourelles et sa tactique ne visent que ce qui est repéré.

use super::emp::is_stunned;
use super::projectiles::Projectile;
use super::smoke::smoke_blocks;
use super::vec::{V3, add, len, scale, sub, v3};
use super::world::{Owner, STEP, Sim};
use super::catalog::catalog;
use crate::jsmath;

/// La détection est mise à jour par tranches de cette durée (s).
const TICK: f64 = 0.25;
/// Portée de vue d'un robot (m) (`SIGHT_RANGE`, config.ts).
const SIGHT_RANGE: f64 = 70.0;
/// Un robot repère une mine ennemie à moins de cette distance (m), s'il la voit (`MINE_SPOT`).
const MINE_SPOT: f64 = 10.0;

/// Met à jour ce que chaque équipe a repéré (`updateDetection`), au début du pas.
pub fn update_detection(sim: &mut Sim) {
    // (`sim.detected.size` : la détection a déjà tourné)
    if sim.detected[0].is_some() && (sim.time / TICK).floor() == ((sim.time - STEP) / TICK).floor() {
        return;
    }
    for team in 0..2 {
        let observers: Vec<usize> = sim.roster.iter().copied().filter(|&o| sim.bots[o].team == team && sim.bots[o].cockpit_alive()).collect();
        // Les capteurs posés et armés de l'équipe : ils repèrent à travers tout
        let sensors: Vec<(V3, f64)> = sim
            .projectiles
            .iter()
            .filter(|p| p.landed && p.shooter.is_some_and(|s| sim.bots[s].team == team))
            .map(|p| (p.pos, sensor_range(p)))
            .filter(|s| s.1 > 0.0)
            .collect();
        let mut seen = Vec::new();
        for enemy in sim.roster.clone() {
            if sim.bots[enemy].team == team || !sim.bots[enemy].cockpit_alive() {
                continue;
            }
            let at = sim.bots[enemy].last_pos;
            if observers.iter().any(|&o| spots(sim, o, enemy)) || sensors.iter().any(|&(pos, range)| distance(pos, at) < range) {
                seen.push(enemy);
            }
        }
        sim.detected[team] = Some(seen);
        spot_mines(sim, team, &observers);
    }
}

fn distance(a: V3, b: V3) -> f64 {
    jsmath::hypot3(a.x - b.x, a.y - b.y, a.z - b.z)
}

/// Portée d'un capteur posé et armé (`sensorRange`) ; 0 pour une autre mine.
fn sensor_range(p: &Projectile) -> f64 {
    match &p.def().projectile.mine {
        Some(m) if m.sense != 0.0 && p.age >= m.arm_delay => m.sense,
        _ => 0.0,
    }
}

/// Les robots de `team` repèrent les mines ennemies posées qu'ils voient à moins de MINE_SPOT m : leur
/// IA les évitera (`spotMines`).
fn spot_mines(sim: &mut Sim, team: usize, observers: &[usize]) {
    for i in 0..sim.projectiles.len() {
        let p = &sim.projectiles[i];
        if !p.landed || p.spotted.contains(&team) || p.shooter.is_some_and(|s| sim.bots[s].team == team) || p.def().projectile.mine.is_none() {
            continue;
        }
        let top = add(p.pos, v3(0.0, 0.3, 0.0));
        let pos = p.pos;
        if observers.iter().any(|&o| distance(sim.bots[o].last_pos, pos) < MINE_SPOT && in_sight(sim, sim.bots[o].last_pos, top)) {
            sim.projectiles[i].spotted.push(team);
        }
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

/// Portée du meilleur radar d'un robot, sur le morceau de son cockpit (0 s'il n'en a pas, ou s'il est
/// paralysé) (`radarRange`).
fn radar_range(sim: &Sim, bot: usize) -> f64 {
    if is_stunned(sim, bot) {
        return 0.0;
    }
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

/// Ligne de vue : ni décor ni accessoire entre les deux (les robots ne cachent pas), ni fumée (`inSight`).
fn in_sight(sim: &Sim, from: V3, to: V3) -> bool {
    if smoke_blocks(sim, from, to) {
        return false;
    }
    let seg = sub(to, from);
    let length = len(seg);
    if length < 1e-3 {
        return true;
    }
    let keep = |h| matches!(sim.owners.get(&h), None | Some(Owner::Prop(_)));
    sim.phys.cast_ray_where(from, scale(seg, 1.0 / length), length, true, &keep).is_none()
}
