//! Ce que brûle le jet de flamme d'un moteur (src/shared/combat/scorch.ts ; sa géométrie :
//! exhaust.rs) : derrière la tuyère d'un réacteur, d'un propulseur ou d'un turboréacteur qui pousse,
//! les blocs et les roues de n'importe quel robot (le sien compris, s'il est mal construit) chauffent
//! (dégâts `fire`, crédités au robot du moteur, cause `exhaust`) et peuvent s'enflammer ; le bois du
//! décor prend feu ; les autres accessoires chauffent selon leur résistance au feu. Pas de flaque.
//!
//! Son propre robot se lit dans sa grille (`ownContact`) ; le reste, par trois lancers de rayon dans le
//! cône du jet, qui tournent d'une tranche à l'autre et ignorent le morceau du moteur. Chaque moteur
//! est traité toutes les TICK s, à son tour (décalé d'après le numéro de son bloc).

use super::damage::{DamageBatch, Target, inflict};
use super::emp::is_stunned;
use super::exhaust::{Jet, jet_heat, jet_of, jet_radius, own_contact};
use super::fire::{BURN_TIME, flammability, ignite, ignite_prop};
use super::projectiles::hit_target_of;
use super::propulsion::live_thrusters;
use super::props::prop;
use super::vec::{V3, add, cross, norm, scale, v3};
use super::world::{Owner, STEP, Sim};
use crate::det::{dcos, dsin};
use crate::jsmath;

/// Chaque moteur est traité toutes les TICK s.
const TICK: f64 = 0.25;
/// Les rayons du bord du cône, à cette part de son rayon ; ils tournent de l'angle d'or d'une tranche à l'autre.
const RIM: f64 = 0.8;
const GOLDEN_ANGLE: f64 = 2.39996;
/// Chance par seconde qu'un bloc touché s'enflamme, par point de dégâts par seconde (fois sa
/// sensibilité au feu) ; que le bois touché s'enflamme.
const IGNITE_PER_DPS: f64 = 0.012;
const PROP_IGNITE_PER_DPS: f64 = 0.04;

/// Un pas des jets de flamme (`updateScorch`) : les moteurs dont c'est le tour.
pub fn update_scorch(sim: &mut Sim) {
    let tick_steps = jsmath::round(TICK / STEP);
    let step = jsmath::round(sim.time / STEP);
    for b in sim.roster.clone() {
        if sim.bots[b].thrusters.is_empty() || !sim.bots[b].cockpit_alive() || is_stunned(sim, b) {
            continue;
        }
        for t in live_thrusters(sim, b, None) {
            let block = sim.bots[b].thrusters[t].block;
            if (step + sim.bots[b].blocks[block].id as f64) % tick_steps != 0.0 {
                continue;
            }
            // Les dégâts d'un jet précédent ont pu détacher ou détruire ce moteur
            let bot = &sim.bots[b];
            if !bot.blocks[block].alive || !bot.cockpit_alive() || bot.blocks[block].part != bot.cockpit_part() {
                continue;
            }
            if let Some(jet) = jet_of(sim, b, t) {
                burn_jet(sim, &jet, (step / tick_steps).floor());
            }
        }
    }
}

/// Morceau qui porte ce collider (bloc, tête de tourelle, roue montée), s'il y en a un (`ownerPart`).
fn owner_part(sim: &Sim, owner: Owner) -> Option<usize> {
    match owner {
        Owner::Part(p) => Some(p),
        Owner::Head(bot, t) => Some(sim.bots[bot].blocks[sim.bots[bot].turrets[t].block].part),
        Owner::Blade(bot, a) => Some(sim.bots[bot].blocks[sim.bots[bot].melee[a].block].part),
        Owner::Wheel(bot, w) => sim.bots[bot].wheels[w].part,
        Owner::Debris | Owner::Prop(_) => None,
    }
}

/// Directions des rayons (`rayDirections`) : l'axe, et deux sur le bord du cône, opposés, qui tournent
/// d'une tranche à l'autre.
fn ray_directions(sim: &Sim, jet: &Jet, turn: f64) -> [V3; 3] {
    let dir = jet.dir;
    let side = norm(if dir.y.abs() < 0.9 { cross(dir, v3(0.0, 1.0, 0.0)) } else { cross(dir, v3(1.0, 0.0, 0.0)) });
    let other = cross(dir, side);
    let block = sim.bots[jet.bot].thrusters[jet.thruster].block;
    let angle = turn * GOLDEN_ANGLE + sim.bots[jet.bot].blocks[block].id as f64;
    let offset = (jet_radius(jet, jet.length) * RIM) / jet.length;
    let rim = |a: f64| {
        let radial = add(scale(side, dcos(a)), scale(other, dsin(a)));
        norm(add(dir, scale(radial, offset)))
    };
    [dir, rim(angle), rim(angle + std::f64::consts::PI)]
}

/// Ce qui chauffe à `d` m de la tuyère (`heat`) : ses dégâts entrent dans le lot ; un bloc a une
/// chance de s'enflammer, une fois par tranche.
fn heat(sim: &mut Sim, jet: &Jet, batch: &mut DamageBatch, tried: &mut Vec<(usize, usize)>, target: Target, d: f64) {
    let dps = jet_heat(jet, d);
    batch.add(sim, Some(target), dps * TICK, "fire");
    let Target::Block(bot, block) = target else { return };
    if tried.contains(&(bot, block)) {
        return;
    }
    tried.push((bot, block));
    if sim.bots[bot].blocks[block].burn <= 0.0 && sim.rng.rand(0.0, 1.0) < IGNITE_PER_DPS * dps * TICK * flammability(sim, bot, block) {
        ignite(sim, bot, block, BURN_TIME);
    }
}

/// Un jet, une tranche (`burnJet`) : ce qu'il touche chauffe (un lot de dégâts par moteur : plusieurs
/// jets sur une cible s'additionnent).
fn burn_jet(sim: &mut Sim, jet: &Jet, turn: f64) {
    let block = sim.bots[jet.bot].thrusters[jet.thruster].block;
    let part = sim.bots[jet.bot].blocks[block].part;
    let mut batch = DamageBatch { attacker: Some(jet.bot), fiery: true, cause: Some("exhaust"), ..DamageBatch::default() };
    let mut tried = Vec::new();

    // Son propre robot (sa grille) : un bloc derrière la tuyère arrête aussi le jet
    let own = own_contact(sim, jet);
    let reach = own.map_or(jet.length, |o| o.distance);
    if let Some(o) = own {
        if let Some(k) = o.block {
            heat(sim, jet, &mut batch, &mut tried, Target::Block(jet.bot, k), o.distance);
        } else if let Some(w) = o.wheel {
            heat(sim, jet, &mut batch, &mut tried, Target::Wheel(jet.bot, w), o.distance);
        }
    }

    // Le reste du monde : quelques rayons dans le cône, qui ignorent le morceau du moteur et les débris
    if reach > 0.05 {
        let mut lit: Vec<usize> = Vec::new();
        for dir in ray_directions(sim, jet, turn) {
            let hit = {
                let keep = |h| match sim.owners.get(&h) {
                    // (le décor, le sol)
                    None => true,
                    Some(&o) => o != Owner::Debris && owner_part(sim, o) != Some(part),
                };
                sim.phys.cast_ray_hit_where(jet.origin, dir, reach, true, &keep)
            };
            let Some((collider, d)) = hit else { continue };
            let point = add(jet.origin, scale(dir, d));
            let owner = sim.owners.get(&collider).copied();
            // (le décor, le sol : rien ne brûle)
            let Some(target) = hit_target_of(sim, owner, point, dir) else { continue };
            let Target::Prop(i) = target else {
                heat(sim, jet, &mut batch, &mut tried, target, d);
                continue;
            };
            if lit.contains(&i) {
                continue;
            }
            lit.push(i);
            // Le bois prend feu (son feu le ronge ensuite) ; le reste chauffe, selon sa résistance au feu
            if prop(sim, i).def().burns.is_some() {
                if prop(sim, i).burn <= 0.0 && sim.rng.rand(0.0, 1.0) < PROP_IGNITE_PER_DPS * jet_heat(jet, d) * TICK {
                    ignite_prop(sim, i);
                }
            } else if prop(sim, i).def().resist.get("fire") != Some(&0.0) {
                batch.add(sim, Some(target), jet_heat(jet, d) * TICK, "fire");
            }
        }
    }
    if !batch.blocks.is_empty() || !batch.wheels.is_empty() || !batch.props.is_empty() {
        inflict(sim, &batch, jet.dir, None);
    }
}
