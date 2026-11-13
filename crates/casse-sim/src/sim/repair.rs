//! La réparation (src/shared/combat/repair.ts) : un module de réparation relié au cockpit remet en
//! état les blocs abîmés de son robot autour de lui (et ses roues montées), quand le robot n'a pas été
//! touché depuis un moment, puis fait repousser ses blocs perdus, un à la fois.
//!
//! Un bloc perdu repousse à sa place dans le plan, sur le morceau du cockpit, s'il touche un bloc de
//! ce morceau et si sa case est libre (ni décor, ni accessoire, ni autre robot : une requête de Rapier,
//! `intersectionWithShape`) : un bloc détruit (`Bot::lost`), ou un bloc resté sur un morceau qui
//! s'est détaché ; il quitte alors ce morceau, qui se sépare à son tour (`splitPart`), ou disparaît
//! s'il n'en reste rien. Le bloc revient avec 30 % de ses points de structure ; ses liaisons rompues se
//! refont ; les colliders du robot sont refaits (Rapier les range dans l'ordre des appels, comme
//! ailleurs). Un robot paralysé (emp.rs) ne se répare pas.
//!
//! Les tirs réparateurs (projectiles.rs) font de même sur un allié : le rayon réparateur remet en
//! état ses blocs et ses roues autour du point touché et fait repousser un bloc perdu voisin
//! (`repairAt`) ; les nanites, ses blocs les plus abîmés, où qu'ils soient (`swarmOver`). Sur un
//! ennemi, le rayon vole de la vie (`drainAt`) : la part de ce que le bloc touché a perdu répare le
//! tireur, ses blocs les plus abîmés d'abord (`heal`).

use super::events::code;
use super::catalog::{RepairShot, catalog};
use super::colliders::rebuild_dirty_parts;
use super::damage::{Target, strike};
use super::debris::block_world_pos;
use super::emp::is_stunned;
use super::lifecycle::{capture_part_motion, detach_block, refresh_wheels, split_part};
use super::physics::ShapeDesc;
use super::robot::NEIGHBORS;
use super::vec::{V3, add, qrot};
use super::world::{Owner, STEP, Sim};
use crate::jsmath;
use rapier3d::prelude::ColliderHandle;

/// Part de ses points de structure avec laquelle un bloc repousse (la réparation fait le reste).
const REBUILD_SHARE: f64 = 0.3;
/// Un robot ne regagne pas plus d'un bloc tous les REBUILD_GAP s.
const REBUILD_GAP: f64 = 0.35;
/// Les réparations sont traitées par tranches de cette durée (s).
const TICK: f64 = 0.25;

/// Ce qu'un module répare : un bloc ou une roue du robot, et la part de ses points qu'il lui reste.
enum Damaged {
    Block(usize, f64),
    Wheel(usize, f64),
}

impl Damaged {
    fn ratio(&self) -> f64 {
        match *self {
            Damaged::Block(_, r) | Damaged::Wheel(_, r) => r,
        }
    }
}

fn distance(a: V3, b: V3) -> f64 {
    jsmath::hypot3(a.x - b.x, a.y - b.y, a.z - b.z)
}

/// Position dans le monde d'un point du repère du robot, porté par le morceau `part` (`onPart`).
fn on_part(sim: &Sim, part: usize, local: V3) -> V3 {
    let rb = sim.part(part).rb;
    add(sim.phys.translation(rb), qrot(sim.phys.rotation(rb), local))
}

/// Le robot auquel appartient un collider (`ownerBot`) : celui d'un morceau, d'une roue, d'une tête
/// de tourelle ; aucun pour un débris, un accessoire, le décor ou le sol.
fn owner_bot(sim: &Sim, owner: Option<&Owner>) -> Option<usize> {
    match owner {
        Some(Owner::Part(p)) => sim.parts[*p].as_ref().map(|part| part.bot),
        Some(Owner::Wheel(bot, _)) | Some(Owner::Head(bot, _)) | Some(Owner::Blade(bot, _)) => Some(*bot),
        _ => None,
    }
}

/// Un pas des modules de réparation (`updateRepairs`), par tranches de TICK.
pub fn update_repairs(sim: &mut Sim) {
    if (sim.time / TICK).floor() == ((sim.time - STEP) / TICK).floor() {
        return;
    }
    let c = catalog();
    for bot in sim.roster.clone() {
        if !sim.bots[bot].cockpit_alive() || is_stunned(sim, bot) {
            continue;
        }
        // Les blocs du morceau du cockpit, dans l'ordre de son `Set` : un bloc qui repousse y entre au
        // bout, et l'itération du TypeScript le voit encore
        let core = sim.bots[bot].cockpit_part();
        let mut i = 0;
        while i < sim.part(core).blocks.len() {
            let module = sim.part(core).blocks[i];
            i += 1;
            let Some(spec) = c.blocks[&sim.bots[bot].blocks[module].kind].repair else { continue };
            if sim.time - sim.bots[bot].last_hit < spec.delay {
                continue;
            }
            let center = block_world_pos(sim, bot, module);
            let mut damaged: Vec<Damaged> = Vec::new();
            for &b in &sim.bots[bot].live {
                let block = &sim.bots[bot].blocks[b];
                let max = c.blocks[&block.kind].hp;
                if block.hp < max && distance(block_world_pos(sim, bot, b), center) <= spec.radius {
                    damaged.push(Damaged::Block(b, block.hp / max));
                }
            }
            for (w, wheel) in sim.bots[bot].wheels.iter().enumerate() {
                let max = wheel.def.hp;
                if wheel.part.is_some() && wheel.hp < max && distance(wheel.rb.pos, center) <= spec.radius {
                    damaged.push(Damaged::Wheel(w, wheel.hp / max));
                }
            }
            // Les plus abîmés d'abord (un tri stable, comme celui de V8), jusqu'à épuiser la réparation de cette tranche
            damaged.sort_by(|a, b| a.ratio().partial_cmp(&b.ratio()).expect("part des points"));
            let mut budget = spec.rate * TICK;
            for d in damaged {
                if budget <= 0.0 {
                    break;
                }
                match d {
                    Damaged::Block(b, _) => {
                        let block = &mut sim.bots[bot].blocks[b];
                        let max = c.blocks[&block.kind].hp;
                        let gain = jsmath::min(budget, max - block.hp);
                        block.hp += gain;
                        budget -= gain;
                        sim.stats.repaired += 1;
                        sim.emit_block(code::BLOCK_REPAIRED, bot, b);
                    }
                    Damaged::Wheel(w, _) => {
                        let wheel = &mut sim.bots[bot].wheels[w];
                        let gain = jsmath::min(budget, wheel.def.hp - wheel.hp);
                        wheel.hp += gain;
                        budget -= gain;
                    }
                }
            }
            // Et il fait repousser ses blocs perdus autour de lui, un à la fois (ils se réparent ensuite)
            if sim.time >= sim.bots[bot].rebuild_at
                && let Some(lost) = regrowable(sim, bot, center, spec.radius)
            {
                let hp = c.blocks[&sim.bots[bot].blocks[lost].kind].hp * REBUILD_SHARE;
                rebuild_block(sim, bot, lost, hp);
                sim.bots[bot].rebuild_at = sim.time + REBUILD_GAP;
            }
        }
    }
}

/// Tir réparateur sur un allié (`repairAt`) : chaque bloc et chaque roue montée de `bot` à moins de
/// `radius` m de `point` regagne `amount` points, sans dépasser son maximum, et un de ses blocs perdus
/// voisins repousse ; des nanites (`swarm`) : ses blocs les plus abîmés, où qu'ils soient.
pub fn repair_at(sim: &mut Sim, bot: usize, point: V3, shot: &RepairShot) {
    if let Some(count) = shot.swarm {
        swarm_over(sim, bot, point, shot.amount, count);
        return;
    }
    let c = catalog();
    for i in 0..sim.bots[bot].live.len() {
        let b = sim.bots[bot].live[i];
        let max = c.blocks[&sim.bots[bot].blocks[b].kind].hp;
        if sim.bots[bot].blocks[b].hp >= max || distance(block_world_pos(sim, bot, b), point) > shot.radius {
            continue;
        }
        let block = &mut sim.bots[bot].blocks[b];
        block.hp = jsmath::min(max, block.hp + shot.amount);
        sim.stats.repaired += 1;
        sim.emit_block(code::BLOCK_REPAIRED, bot, b);
    }
    for w in sim.bots[bot].wheels.iter_mut() {
        let max = w.def.hp;
        if w.part.is_some() && w.hp < max && distance(w.rb.pos, point) <= shot.radius {
            w.hp = jsmath::min(max, w.hp + shot.amount);
        }
    }
    if sim.time < sim.bots[bot].rebuild_at {
        return;
    }
    let Some(lost) = regrowable(sim, bot, point, shot.radius + 0.5) else { return };
    let hp = c.blocks[&sim.bots[bot].blocks[lost].kind].hp * REBUILD_SHARE;
    rebuild_block(sim, bot, lost, hp);
    sim.bots[bot].rebuild_at = sim.time + REBUILD_GAP;
}

/// Nanites (`swarmOver`) : les `count` blocs les plus abîmés du robot regagnent `amount` points, et un
/// bloc perdu repousse, où qu'ils soient.
fn swarm_over(sim: &mut Sim, bot: usize, point: V3, amount: f64, count: f64) {
    let c = catalog();
    for (n, b) in damaged_blocks(sim, bot).into_iter().enumerate() {
        // (`slice(0, count)`)
        if n as f64 >= count {
            break;
        }
        let block = &mut sim.bots[bot].blocks[b];
        block.hp = jsmath::min(c.blocks[&block.kind].hp, block.hp + amount);
        sim.stats.repaired += 1;
        sim.emit_block(code::BLOCK_REPAIRED, bot, b);
    }
    let lost = if sim.time >= sim.bots[bot].rebuild_at { regrowable(sim, bot, point, f64::INFINITY) } else { None };
    let Some(lost) = lost else { return };
    let hp = c.blocks[&sim.bots[bot].blocks[lost].kind].hp * REBUILD_SHARE;
    rebuild_block(sim, bot, lost, hp);
    sim.bots[bot].rebuild_at = sim.time + REBUILD_GAP;
}

/// Tir réparateur sur un ennemi, le vol de vie (`drainAt`) : `drain` dégâts d'énergie au bloc touché
/// (`block` du robot `bot`), dont la part `steal` de ce qu'il a vraiment perdu répare le tireur, ses
/// blocs les plus abîmés d'abord ; `origin`, d'où vient le tir (l'IA touchée réagit).
#[allow(clippy::too_many_arguments)]
pub fn drain_at(sim: &mut Sim, bot: usize, block: usize, point: V3, dir: V3, shot: &RepairShot, shooter: usize, origin: V3, cause: &'static str) {
    if shot.drain == 0.0 {
        return;
    }
    let before = sim.bots[bot].blocks[block].hp;
    strike(sim, Some(Target::Block(bot, block)), shot.drain, "energy", point, dir, 0.0, origin, Some(shooter), Some(cause));
    let b = &sim.bots[bot].blocks[block];
    let taken = if b.alive { before - b.hp } else { before };
    heal(sim, shooter, taken * shot.steal);
}

/// Rend `amount` points au robot, à ses blocs les plus abîmés d'abord (`heal`).
fn heal(sim: &mut Sim, bot: usize, mut amount: f64) {
    if !sim.bots[bot].cockpit_alive() {
        return;
    }
    let c = catalog();
    for b in damaged_blocks(sim, bot) {
        if amount <= 0.0 {
            return;
        }
        let block = &mut sim.bots[bot].blocks[b];
        let gain = jsmath::min(amount, c.blocks[&block.kind].hp - block.hp);
        block.hp += gain;
        amount -= gain;
        sim.stats.repaired += 1;
        sim.emit_block(code::BLOCK_REPAIRED, bot, b);
    }
}

/// Ce qu'il manque à un robot pour être remis à neuf (`repairNeed`) : les points perdus par ses blocs
/// vivants, ses blocs perdus (dans l'ordre où ils l'ont été) et ses roues montées.
pub fn repair_need(sim: &Sim, bot: usize) -> f64 {
    let c = catalog();
    let b = &sim.bots[bot];
    let mut need = 0.0;
    for &k in &b.live {
        need += c.blocks[&b.blocks[k].kind].hp - b.blocks[k].hp;
    }
    for &k in &b.lost_order {
        need += c.blocks[&b.blocks[k].kind].hp;
    }
    for w in &b.wheels {
        if w.part.is_some() {
            need += w.def.hp - w.hp;
        }
    }
    need
}

/// Ses blocs vivants abîmés, les plus abîmés d'abord (le plus de points à regagner ; un tri stable, à
/// égalité dans l'ordre de `bot.blocks`) (`damagedBlocks`).
pub fn damaged_blocks(sim: &Sim, bot: usize) -> Vec<usize> {
    let c = catalog();
    let b = &sim.bots[bot];
    let missing = |k: usize| c.blocks[&b.blocks[k].kind].hp - b.blocks[k].hp;
    let mut list: Vec<usize> = b.live.iter().copied().filter(|&k| missing(k) > 0.0).collect();
    list.sort_by(|&x, &y| missing(y).partial_cmp(&missing(x)).expect("points manquants"));
    list
}

/// Bloc perdu de `bot` qui peut repousser à moins de `radius` m de `point` (`regrowable`) : à sa place
/// dans le plan, contre un bloc du morceau du cockpit, dans une case libre ; le plus proche. Jamais
/// le cockpit. Un bloc détruit n'a plus de corps sûr : on le place d'après le morceau du cockpit.
fn regrowable(sim: &Sim, bot: usize, point: V3, radius: f64) -> Option<usize> {
    let b = &sim.bots[bot];
    if !b.cockpit_alive() {
        return None;
    }
    let core = b.cockpit_part();
    let mut candidates: Vec<(usize, f64)> = Vec::new();
    // (les blocs du plan, dans son ordre : celui de `bot.blocks`)
    for (k, block) in b.blocks.iter().enumerate() {
        // Un bloc vivant resté sur un autre morceau, ou un bloc perdu
        if block.alive && block.part == core {
            continue;
        }
        if block.kind == "cockpit" {
            continue;
        }
        let d = distance(on_part(sim, core, block.local), point);
        if d >= radius {
            continue;
        }
        let (x, y, z) = block.cell();
        if !NEIGHBORS.iter().any(|&(dx, dy, dz)| b.cells.get(&(x + dx, y + dy, z + dz)).is_some_and(|&n| b.blocks[n].part == core)) {
            continue;
        }
        candidates.push((k, d));
    }
    // (un tri stable : à égalité, l'ordre du plan)
    candidates.sort_by(|a, b| a.1.partial_cmp(&b.1).expect("distance"));
    candidates.into_iter().find(|&(k, _)| cell_free(sim, bot, on_part(sim, core, b.blocks[k].local))).map(|(k, _)| k)
}

/// La case du robot centrée en `at` est-elle libre de tout ce qui n'est pas lui (ni débris)
/// (`cellFree`) ? Un cube de la taille d'une case, un peu réduit (des voisins qui se touchent ne
/// comptent pas), tourné comme le morceau du cockpit.
fn cell_free(sim: &Sim, bot: usize, at: V3) -> bool {
    let rot = sim.phys.rotation(sim.part(sim.bots[bot].cockpit_part()).rb);
    let half = catalog().constants.block_size * 0.45;
    let blocking = |h: ColliderHandle| {
        let owner = sim.owners.get(&h);
        !matches!(owner, Some(Owner::Debris)) && owner_bot(sim, owner) != Some(bot)
    };
    !sim.phys.intersects_shape(at, rot, &ShapeDesc::Cuboid(half, half, half), &blocking)
}

/// Fait repousser un bloc perdu sur le morceau du cockpit, avec `hp` points (`rebuildBlock`) : un
/// bloc détruit revient ; un bloc resté sur un morceau arraché le quitte. Ses liaisons rompues se
/// refont ; une roue qu'il portait sur le morceau arraché revient avec lui.
pub fn rebuild_block(sim: &mut Sim, bot: usize, block: usize, hp: f64) {
    let core = sim.bots[bot].cockpit_part();
    if sim.bots[bot].blocks[block].alive {
        // Le morceau arraché qui le portait se sépare, ou disparaît s'il n'en reste rien
        let from = sim.bots[bot].blocks[block].part;
        let motion = capture_part_motion(sim, from);
        detach_block(sim, bot, block);
        split_part(sim, from, &motion);
    } else {
        let b = &mut sim.bots[bot];
        let cell = b.blocks[block].cell();
        b.blocks[block].alive = true;
        b.blocks[block].burn = 0.0;
        b.cells.insert(cell, block);
        b.live.push(block);
        b.lost_order.retain(|&k| k != block);
    }
    let max = catalog().blocks[&sim.bots[bot].blocks[block].kind].hp;
    let b = &mut sim.bots[bot];
    b.blocks[block].hp = jsmath::max(1.0, jsmath::min(max, hp));
    let cell = b.blocks[block].cell();
    b.cuts.retain(|&(p, q)| p != cell && q != cell);
    b.cut_order.retain(|&(p, q)| p != cell && q != cell);
    // (sans `attachBlock` : pas d'événement `blockAttached`, mais `blockRebuilt`)
    b.blocks[block].part = core;
    let part = sim.part_mut(core);
    part.blocks.push(block);
    part.dirty = true;
    part.links = None;
    sim.stats.rebuilt += 1;
    sim.emit(code::BLOCK_REBUILT, |s, w| {
        let k = &s.bots[bot].blocks[block];
        w.id(Some(k.id)).id(Some(s.part(k.part).id)).num(k.x).num(k.y).num(k.z).num(k.hp).id(Some(s.bots[bot].id));
    });
    refresh_wheels(sim, bot);
    rebuild_dirty_parts(sim, bot);
}
