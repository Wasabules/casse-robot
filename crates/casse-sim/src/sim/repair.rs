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
//! ailleurs).
//!
//! Pas encore porté : le rayon réparateur et les nanites (des projectiles), qui réparent un allié ;
//! la paralysie (IEM), qui arrête les modules.

use super::catalog::catalog;
use super::colliders::rebuild_dirty_parts;
use super::debris::block_world_pos;
use super::lifecycle::{attach_block, capture_part_motion, detach_block, refresh_wheels, split_part};
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
        Some(Owner::Wheel(bot, _)) | Some(Owner::Head(bot, _)) => Some(*bot),
        _ => None,
    }
}

/// Un pas des modules de réparation (`updateRepairs`), par tranches de TICK.
pub fn update_repairs(sim: &mut Sim) {
    if (sim.time / TICK).floor() == ((sim.time - STEP) / TICK).floor() {
        return;
    }
    let c = catalog();
    for bot in 0..sim.bots.len() {
        // (sans paralysie : l'IEM n'est pas porté)
        if !sim.bots[bot].cockpit_alive() {
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
    }
    let max = catalog().blocks[&sim.bots[bot].blocks[block].kind].hp;
    let b = &mut sim.bots[bot];
    b.blocks[block].hp = jsmath::max(1.0, jsmath::min(max, hp));
    let cell = b.blocks[block].cell();
    b.cuts.retain(|&(p, q)| p != cell && q != cell);
    attach_block(sim, bot, block, core);
    sim.stats.rebuilt += 1;
    refresh_wheels(sim, bot);
    rebuild_dirty_parts(sim, bot);
}
