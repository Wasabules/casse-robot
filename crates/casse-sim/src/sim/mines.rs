//! Les mines (src/shared/combat/mines.ts) : une mine tombe comme un projectile, se pose
//! (projectiles.rs), puis c'est ici qu'elle attend : elle s'arme, guette ce qui la déclenche (un
//! ennemi au sol ou en vol à portée, d'après ses blocs et ses roues), et éclate (explosion, impulsion
//! électromagnétique, fumée), bondit puis éclate en haut de sa course, ou se colle au bloc le plus
//! proche de sa cible, le suit et éclate au bout de sa mèche. Une mine télécommandée attend un ordre :
//! celle de l'IA saute dès qu'un ennemi est dessus, celle d'un joueur quand il tient sa touche
//! (`detonateMines`, l'une après l'autre). Un capteur ne se déclenche jamais : il fait repérer les
//! ennemis proches à son équipe (detection.rs) et signale leur passage. Une explosion proche fait
//! sauter les mines posées ou collées au pas suivant (`blowMines`), en chaîne ; une balle aussi
//! (interception.rs). La mine anti-aérienne, sous un robot en vol, lance un missile de flak qui le
//! poursuit (`launch`) et éclate près de lui (sa fusée de proximité : projectiles.rs).

use super::events::{MineAction as Action, Surface, code};
use super::catalog::{MineAction, MineSpec, Mobility, catalog};
use super::debris::block_world_pos;
use super::gunner::enemies;
use super::projectiles::{Launch, Stuck, detonate, spawn_projectile};
use super::vec::{V3, add, len, norm, qrot, qrot_inv, scale, sub, v3};
use super::world::{STEP, Sim};
use crate::jsmath;

/// Une explosion fait sauter les mines à moins de son rayon plus cette marge (m) (`BLOW_MARGIN`).
const BLOW_MARGIN: f64 = 0.6;
/// Une ventouse se pose à la surface du bloc qu'elle attrape : au plus à cette distance de son centre (m).
const STICK_DEPTH: f64 = 0.35;
/// Un capteur signale le passage d'un ennemi au plus toutes les PING_PERIOD s.
const PING_PERIOD: f64 = 2.5;
/// Mines télécommandées qu'un joueur fait sauter d'un coup : l'une après l'autre, à cet intervalle (s).
const CHAIN_DELAY: f64 = 0.06;
/// Rayon dans lequel un robot est pris en compte, au-delà de son cockpit (m) (`PROXIMITY_REACH`).
const PROXIMITY_REACH: f64 = 6.0;

fn distance(a: V3, b: V3) -> f64 {
    jsmath::hypot3(a.x - b.x, a.y - b.y, a.z - b.z)
}

/// Un robot ennemi du tireur dont un bloc (du morceau de son cockpit) ou une roue montée passe à moins
/// de `radius` du projectile : robots en vol seulement (`air`), au sol seulement (`ground`), ou tous
/// (`nearestEnemy`).
pub fn nearest_enemy(sim: &Sim, i: usize, radius: f64, kind: &str) -> Option<usize> {
    let p = &sim.projectiles[i];
    for b in sim.roster.clone() {
        let bot = &sim.bots[b];
        if !bot.cockpit_alive() || !enemies(sim, p.shooter, b) {
            continue;
        }
        let flying = bot.mobility != Mobility::Ground;
        if (kind == "air" && !flying) || (kind == "ground" && flying) {
            continue;
        }
        if distance(bot.last_pos, p.pos) > radius + PROXIMITY_REACH {
            continue;
        }
        for &k in &sim.part(bot.cockpit_part()).blocks {
            if distance(block_world_pos(sim, b, k), p.pos) < radius {
                return Some(b);
            }
        }
        for w in &bot.wheels {
            if w.part.is_some() && distance(w.rb.pos, p.pos) < radius {
                return Some(b);
            }
        }
    }
    None
}

/// Un pas d'une mine posée, collée, en l'air après un bond, ou atteinte par une explosion
/// (`stepMine`) ; faux quand elle a fini (éclatée, capteur détruit).
pub fn step_mine(sim: &mut Sim, i: usize, mine: &MineSpec) -> bool {
    if sim.projectiles[i].blown {
        return burst(sim, i);
    }
    if let Some(Stuck { bot, block, offset }) = sim.projectiles[i].stuck {
        // Collée : elle suit son bloc ; s'il est détruit, elle éclate là où elle était
        if !sim.bots[bot].blocks[block].alive {
            return burst(sim, i);
        }
        let rb = sim.part(sim.bots[bot].blocks[block].part).rb;
        let pos = add(block_world_pos(sim, bot, block), qrot(sim.phys.rotation(rb), offset));
        let vel = sim.phys.linvel(rb);
        let p = &mut sim.projectiles[i];
        p.pos = pos;
        p.vel = vel;
    } else if !sim.projectiles[i].landed {
        // Mine bondissante : elle monte, et éclate en haut de sa course
        let g = sim.gravity;
        let p = &mut sim.projectiles[i];
        p.vel = add(p.vel, v3(0.0, -g * STEP, 0.0));
        p.pos = add(p.pos, scale(p.vel, STEP));
    }
    if let Some(fuse) = sim.projectiles[i].fuse {
        return if sim.time < fuse { true } else { burst(sim, i) };
    }
    if sim.projectiles[i].age < mine.arm_delay {
        return true;
    }
    // Un capteur signale le passage d'un ennemi
    if mine.sense != 0.0 && sim.time >= sim.projectiles[i].ping_at && enemy_within(sim, i, mine.sense) {
        sim.projectiles[i].ping_at = sim.time + PING_PERIOD;
        sim.stats.mine_pings += 1;
        emit_mine(sim, i, Action::Ping);
    }
    match triggered_by(sim, i, mine) {
        Some(target) => trigger(sim, i, mine, target),
        None => true,
    }
}

/// Le robot qui déclenche la mine à ce pas, s'il y en a un (`triggeredBy`).
fn triggered_by(sim: &Sim, i: usize, mine: &MineSpec) -> Option<usize> {
    match mine.trigger.as_str() {
        "ground" => nearest_enemy(sim, i, mine.radius, "ground"),
        "air" => nearest_enemy(sim, i, mine.radius, "air"),
        // L'IA fait sauter les siennes dès qu'un ennemi est dessus ; le joueur, quand il le décide
        "remote" => match sim.projectiles[i].shooter {
            Some(s) if !sim.bots[s].piloted => nearest_enemy(sim, i, mine.radius, "ground"),
            _ => None,
        },
        _ => None,
    }
}

/// La mine est déclenchée par `target` (`trigger`) : elle éclate, bondit ou se colle.
fn trigger(sim: &mut Sim, i: usize, mine: &MineSpec, target: usize) -> bool {
    let Some(action) = &mine.action else { return burst(sim, i) };
    match action {
        MineAction::Bounce(height) => {
            let g = sim.gravity;
            let up = (2.0 * g * height).sqrt();
            let time = sim.time;
            let p = &mut sim.projectiles[i];
            p.landed = false;
            p.vel = v3(0.0, up, 0.0);
            p.fuse = Some(time + up / g);
            sim.stats.mine_bounces += 1;
            emit_mine(sim, i, Action::Bounce);
            true
        }
        MineAction::Launch(weapon) => {
            let Some(weapon) = catalog().weapons.get_key_value(weapon).map(|(k, _)| k.as_str()) else { return false };
            let from = add(sim.projectiles[i].pos, v3(0.0, 0.5, 0.0));
            let rb = sim.part(sim.bots[target].cockpit_part()).rb;
            let dir = norm(sub(sim.phys.world_com(rb), from));
            let launch = Launch { shooter: sim.projectiles[i].shooter, commander: None, homing: Some(target), inherit: v3(0.0, 0.0, 0.0), spread: None };
            spawn_projectile(sim, weapon, from, dir, launch);
            false
        }
        MineAction::Stick(fuse) => {
            let pos = sim.projectiles[i].pos;
            let Some(block) = nearest_block(sim, target, pos) else { return burst(sim, i) };
            let rb = sim.part(sim.bots[target].blocks[block].part).rb;
            let local = qrot_inv(sim.phys.rotation(rb), sub(pos, block_world_pos(sim, target, block)));
            let depth = len(local);
            let offset = if depth > STICK_DEPTH { scale(local, STICK_DEPTH / depth) } else { local };
            let time = sim.time;
            let p = &mut sim.projectiles[i];
            p.stuck = Some(Stuck { bot: target, block, offset });
            p.landed = false;
            p.fuse = Some(time + fuse);
            sim.stats.mine_sticks += 1;
            emit_mine(sim, i, Action::Stick);
            true
        }
    }
}

/// Fin d'une mine : elle éclate (explosion, impulsion, fumée) si elle en porte une ; sinon elle
/// disparaît (`burst`).
fn burst(sim: &mut Sim, i: usize) -> bool {
    let spec = &sim.projectiles[i].def().projectile;
    if spec.explosion.is_some() || spec.emp.is_some() || spec.smoke.is_some() {
        let pos = sim.projectiles[i].pos;
        detonate(sim, i, pos, v3(0.0, 1.0, 0.0), Surface::Scenery);
    }
    false
}

/// Une mine bondit, se colle ou signale un ennemi (`mine` : pour le son).
fn emit_mine(sim: &mut Sim, i: usize, action: Action) {
    let id = sim.projectiles[i].id;
    sim.emit(code::MINE, |_, w| {
        w.id(Some(id)).num(action as u8 as f64);
    });
}

/// Bloc vivant du robot le plus proche de ce point (`nearestBlock`).
fn nearest_block(sim: &Sim, bot: usize, point: V3) -> Option<usize> {
    let mut best = None;
    let mut best_distance = f64::INFINITY;
    for &k in &sim.bots[bot].live {
        let d = distance(block_world_pos(sim, bot, k), point);
        if d < best_distance {
            best = Some(k);
            best_distance = d;
        }
    }
    best
}

/// Un ennemi du poseur, au sol ou en vol, à moins de `radius` m de la mine, d'après son cockpit (`enemyWithin`).
fn enemy_within(sim: &Sim, i: usize, radius: f64) -> bool {
    let p = &sim.projectiles[i];
    sim.roster.iter().copied().any(|b| sim.bots[b].cockpit_alive() && enemies(sim, p.shooter, b) && distance(sim.bots[b].last_pos, p.pos) < radius)
}

/// Déminage (`blowMines`) : une explosion en `point` fait sauter, au pas suivant, les mines posées ou
/// collées à moins de son rayon (plus une marge).
pub fn blow_mines(sim: &mut Sim, point: V3, radius: f64) {
    for p in sim.projectiles.iter_mut() {
        if (p.landed || p.stuck.is_some()) && p.def().projectile.mine.is_some() && distance(p.pos, point) < radius + BLOW_MARGIN {
            p.blown = true;
        }
    }
}

/// Le pilote fait sauter ses mines télécommandées armées : l'une après l'autre, à un souffle
/// d'intervalle (`detonateMines`). Les siennes : celles qu'a posées son robot (`ownedBy` : un même
/// joueur qui réapparaît n'est pas porté).
pub fn detonate_mines(sim: &mut Sim, bot: usize) {
    let mut count = 0.0;
    let time = sim.time;
    for p in sim.projectiles.iter_mut() {
        let Some(mine) = &p.def().projectile.mine else { continue };
        if mine.trigger != "remote" || !p.landed || p.fuse.is_some() || p.age < mine.arm_delay || p.shooter != Some(bot) {
            continue;
        }
        p.fuse = Some(time + count * CHAIN_DELAY);
        count += 1.0;
    }
}
