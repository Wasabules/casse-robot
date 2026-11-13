//! Les leurres (src/shared/combat/decoys.ts) : un lance-leurres éjecte, quand l'IA voit un missile
//! ennemi guidé arriver sur elle, une salve de leurres (l'arme `flare`) qui brûlent en retombant ; ses
//! salves se regagnent une à une. Un missile ennemi guidé (tête chercheuse ou téléguidé, pas une ogive)
//! qui voit un leurre devant lui tente sa chance une fois par leurre (`seduce`) : détourné, il le suit,
//! éclate sur lui, ou file droit, perdu, quand il s'éteint (projectiles.rs, `steer`).

use super::catalog::catalog;
use super::debris::block_world_pos;
use super::emp::is_stunned;
use super::gunner::are_enemies;
use super::projectiles::{Launch, spawn_projectile};
use super::vec::{V3, add, dot, len, norm, qrot, scale, sub, v3};
use super::world::{STEP, Sim};
use crate::det::dpow;
use crate::jsmath;

/// Intervalle minimal entre deux salves (s) (`FLARE_GAP`).
const FLARE_GAP: f64 = 1.5;
/// Part de la vitesse du robot que gardent ses leurres (`FLARE_INHERIT`).
const FLARE_INHERIT: f64 = 0.35;
/// Les leurres partent un peu vers l'arrière du robot (`FLARE_BACK`).
const FLARE_BACK: f64 = 0.4;
/// Un missile voit un leurre à moins de DECOY_RANGE m, dans un cône de DECOY_CONE rad autour de sa course.
const DECOY_RANGE: f64 = 40.0;
const DECOY_CONE: f64 = 0.9;
/// Chance qu'une salve entière détourne un missile qui la voit : tête chercheuse, téléguidé.
const SALVO_HOMING: f64 = 0.65;
const SALVO_COMMAND: f64 = 0.4;
/// Un missile détourné éclate à moins de cette distance de son leurre (m) (`DECOY_BURST`).
pub const DECOY_BURST: f64 = 1.5;
/// Un missile qui file vers un robot : dans ce cône autour de sa course (cosinus) (`HEADING_COS`).
const HEADING_COS: f64 = 0.85;
/// L'IA lance ses leurres quand un missile ennemi arrive à moins de cette distance (m) (`FLARE_ALERT`).
const FLARE_ALERT: f64 = 35.0;

/// La chance de chaque leurre d'une salve, telle que la salve entière ait celle de son guidage (`DECOY_CHANCE`).
fn decoy_chance(mode: &str) -> f64 {
    let per_salvo = catalog().weapons["flare"].projectile.pellets.map_or(1.0, |p| p.0);
    let salvo = if mode == "homing" { SALVO_HOMING } else { SALVO_COMMAND };
    1.0 - dpow(1.0 - salvo, 1.0 / per_salvo)
}

/// Salves que peuvent tenir ses lance-leurres encore reliés au cockpit (`flareCapacity`).
fn flare_capacity(sim: &Sim, b: usize) -> f64 {
    let bot = &sim.bots[b];
    let c = catalog();
    let mut capacity = 0.0;
    for &k in &bot.flare_launchers {
        let block = &bot.blocks[k];
        if block.alive && block.part == bot.cockpit_part() {
            capacity += c.blocks[&block.kind].flares.map_or(0.0, |f| f.0);
        }
    }
    capacity
}

/// Lance une salve de leurres de chacun de ses lance-leurres encore reliés au cockpit, vers le haut
/// de leur bloc, un peu vers l'arrière, s'il lui en reste une et que la dernière est partie depuis
/// FLARE_GAP s (`launchFlares`).
pub fn launch_flares(sim: &mut Sim, b: usize) {
    let bot = &sim.bots[b];
    if bot.flares.charges < 1.0 || sim.time < bot.flares.ready_at || !bot.cockpit_alive() || is_stunned(sim, b) {
        return;
    }
    let ck = bot.cockpit_part();
    let launchers: Vec<usize> = bot.flare_launchers.iter().copied().filter(|&k| bot.blocks[k].alive && bot.blocks[k].part == ck).collect();
    if launchers.is_empty() {
        return;
    }
    let time = sim.time;
    let flares = &mut sim.bots[b].flares;
    flares.charges -= 1.0;
    flares.ready_at = time + FLARE_GAP;
    for k in launchers {
        let block = &sim.bots[b].blocks[k];
        let rb = sim.part(block.part).rb;
        let q = sim.phys.rotation(rb);
        let up = qrot(q, qrot(block.rot, v3(0.0, 1.0, 0.0)));
        let back = qrot(q, v3(0.0, 0.0, -1.0));
        let origin = add(block_world_pos(sim, b, k), scale(up, 0.4));
        let inherit = scale(sim.phys.linvel(rb), FLARE_INHERIT);
        spawn_projectile(sim, "flare", origin, norm(add(up, scale(back, FLARE_BACK))), Launch { shooter: Some(b), commander: None, homing: None, inherit, spread: None });
    }
}

/// Les lance-leurres regagnent leurs salves, une à une (`updateFlares`).
pub fn update_flares(sim: &mut Sim) {
    let c = catalog();
    for b in sim.roster.clone() {
        if sim.bots[b].flare_launchers.is_empty() || !sim.bots[b].cockpit_alive() {
            continue;
        }
        let capacity = flare_capacity(sim, b);
        let reload = c.blocks[&sim.bots[b].blocks[sim.bots[b].flare_launchers[0]].kind].flares.map_or(12.0, |f| f.1);
        let flares = &mut sim.bots[b].flares;
        flares.charges = jsmath::min(flares.charges, capacity);
        if flares.charges >= capacity {
            flares.restock = 0.0;
            continue;
        }
        flares.restock += STEP;
        if flares.restock >= reload {
            flares.restock = 0.0;
            flares.charges += 1.0;
        }
    }
}

/// Le missile ennemi guidé (ou l'ogive) le plus proche qui file vers ce robot à moins de `range` m
/// (`incomingMissile`) : un missile qu'un leurre a détourné ne compte plus. Son rang dans les projectiles.
pub fn incoming_missile(sim: &Sim, b: usize, range: f64) -> Option<usize> {
    let mut best = None;
    let mut best_distance = range;
    let at = sim.bots[b].last_pos;
    for (i, p) in sim.projectiles.iter().enumerate() {
        let spec = &p.def().projectile;
        // (pas de mine posée)
        if spec.hull.is_none() || spec.mine.is_some() || p.decoy.is_some() || p.lost || p.shooter.is_some_and(|s| !are_enemies(sim, s, b)) {
            continue;
        }
        let to = sub(at, p.pos);
        let d = len(to);
        if d >= best_distance {
            continue;
        }
        let speed = len(p.vel);
        if p.homing != Some(b) && (speed < 1.0 || dot(scale(p.vel, 1.0 / speed), norm(to)) < HEADING_COS) {
            continue;
        }
        best = Some(i);
        best_distance = d;
    }
    best
}

/// L'IA lance ses leurres quand un missile ennemi guidé arrive sur elle (`thinkFlares`).
pub fn think_flares(sim: &mut Sim, b: usize) {
    let bot = &sim.bots[b];
    if bot.flare_launchers.is_empty() || bot.flares.charges < 1.0 || sim.time < bot.flares.ready_at {
        return;
    }
    if let Some(threat) = incoming_missile(sim, b, FLARE_ALERT)
        && sim.projectiles[threat].def().projectile.guidance.is_some()
    {
        launch_flares(sim, b);
    }
}

/// Leurres : un missile guidé qui n'est pas encore détourné regarde les leurres ennemis devant lui ;
/// chacun ne le tente qu'une fois (`tried`), avec une chance selon son guidage (`seduce`).
pub fn seduce(sim: &mut Sim, i: usize) {
    let p = &sim.projectiles[i];
    let spec = &p.def().projectile;
    let Some(guidance) = &spec.guidance else { return };
    if guidance.mode == "piloted" || spec.repair.is_some() || p.decoy.is_some() || p.lost {
        return;
    }
    let speed = len(p.vel);
    if speed < 1.0 {
        return;
    }
    let course = scale(p.vel, 1.0 / speed);
    let chance = decoy_chance(&guidance.mode);
    for k in 0..sim.projectiles.len() {
        let (f, p) = (&sim.projectiles[k], &sim.projectiles[i]);
        if f.done || !f.def().projectile.decoy || p.tried.contains(&f.id) {
            continue;
        }
        let Some(fs) = f.shooter else { continue };
        if p.shooter.is_some_and(|s| !are_enemies(sim, s, fs)) {
            continue;
        }
        let to = sub(f.pos, p.pos);
        let d = len(to);
        if d > DECOY_RANGE || d < 1e-3 || jsmath::max(-1.0, jsmath::min(1.0, dot(course, scale(to, 1.0 / d)))).acos() > DECOY_CONE {
            continue;
        }
        let id = f.id;
        sim.projectiles[i].tried.push(id);
        if sim.rng.rand(0.0, 1.0) < chance {
            sim.projectiles[i].decoy = Some(id);
            return;
        }
    }
}

/// La position d'un projectile désigné par son numéro, s'il est encore en vol (pas fini).
pub fn live_projectile(sim: &Sim, id: u64) -> Option<V3> {
    sim.projectiles.iter().find(|q| q.id == id && !q.done).map(|q| q.pos)
}
