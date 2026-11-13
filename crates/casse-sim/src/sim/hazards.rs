//! Les dangers du terrain (src/shared/sim/hazards.ts), dans les arènes qui en ont :
//! - la lave (`ArenaLayout.lava`) brûle les blocs et les roues qui s'y tiennent (à moins de
//!   `LAVA_HEIGHT` m au-dessus du sol), les enflamme, met le feu au bois et fait sauter un baril ;
//! - l'eau profonde (`ArenaLayout.deepWater`) noie un robot dont le cockpit y plonge (il cède en
//!   quelques secondes), et l'eau éteint les blocs en feu qu'elle recouvre.
//!
//! Une arène sans lave ni eau profonde n'a rien de tout cela. Par tranches de TICK, comme le feu.

use super::arena::{LAVA_HEIGHT, deep_water_at, ground_level, lava_at};
use super::damage::{DamageBatch, Target, inflict};
use super::debris::block_world_pos;
use super::fire::{BURN_TIME, burnable, extinguish, flammability, ignite, ignite_prop};
use super::props::{present, prop};
use super::vec::{V3, v3};
use super::world::{STEP, Sim};

/// Les dangers sont traités par tranches de cette durée (s).
const TICK: f64 = 0.25;
/// Dégâts de la lave (points par seconde, nature `fire`, avant résistance).
const LAVA_DPS: f64 = 40.0;
/// Chance, par seconde, qu'un bloc dans la lave s'enflamme (fois sa sensibilité au feu).
const LAVA_IGNITE: f64 = 1.2;
/// Dégâts (par seconde, nature `energy`) au cockpit d'un robot plongé dans l'eau profonde.
const DROWN_DPS: f64 = 160.0;
/// Le cockpit plonge quand il passe à plus de cette profondeur sous la surface (m).
const DROWN_DEPTH: f64 = 0.15;
const UP: V3 = v3(0.0, 1.0, 0.0);

/// Un pas des dangers du terrain (`updateHazards`).
pub fn update_hazards(sim: &mut Sim) {
    let lava = !sim.arena.lava.is_empty();
    let sea = sim.arena.deep_water.is_some() && sim.water.is_some();
    if !lava && !sea {
        return;
    }
    if (sim.time / TICK).floor() == ((sim.time - STEP) / TICK).floor() {
        return;
    }
    let in_lava = |sim: &Sim, p: V3, margin: f64| lava_at(sim, p.x, p.z, margin) > -margin && p.y - ground_level(sim, p.x, p.z) < LAVA_HEIGHT + margin;

    let mut burnt = DamageBatch { cause: Some("lava"), ..DamageBatch::default() };
    let mut drowned = DamageBatch { cause: Some("drown"), ..DamageBatch::default() };
    for b in sim.roster.clone() {
        if !sim.bots[b].cockpit_alive() {
            continue;
        }
        let cockpit = sim.bots[b].cockpit;
        let center = block_world_pos(sim, b, cockpit);
        if lava && in_lava(sim, center, sim.bots[b].radius + 2.0) {
            for k in sim.bots[b].live.clone() {
                if !in_lava(sim, block_world_pos(sim, b, k), 0.0) {
                    continue;
                }
                burnt.add(sim, Some(Target::Block(b, k)), LAVA_DPS * TICK, "fire");
                if sim.bots[b].blocks[k].burn <= 0.0 && sim.rng.rand(0.0, 1.0) < LAVA_IGNITE * TICK * flammability(sim, b, k) {
                    ignite(sim, b, k, BURN_TIME);
                }
            }
            for w in 0..sim.bots[b].wheels.len() {
                let wheel = &sim.bots[b].wheels[w];
                if wheel.part.is_some() && in_lava(sim, wheel.rb.pos, 0.0) {
                    burnt.add(sim, Some(Target::Wheel(b, w)), LAVA_DPS * TICK, "fire");
                }
            }
        }
        if sea && center.y < sim.water.expect("l'eau") - DROWN_DEPTH && deep_water_at(sim, center.x, center.z) {
            drowned.add(sim, Some(Target::Block(b, cockpit)), DROWN_DPS * TICK, "energy");
        }
    }
    if lava {
        for i in present(sim) {
            let p = prop(sim, i);
            let at = sim.phys.translation(p.rb);
            if !in_lava(sim, v3(at.x, at.y - p.half.y, at.z), 0.0) {
                continue;
            }
            if burnable(sim, i) {
                if p.burn <= 0.0 {
                    ignite_prop(sim, i);
                }
            } else if p.def().explosion.is_some() {
                burnt.add(sim, Some(Target::Prop(i)), LAVA_DPS * TICK, "fire");
            }
        }
    }
    // L'eau éteint ce qu'elle recouvre
    if sea {
        let water = sim.water.expect("l'eau");
        for (b, k) in sim.fires.clone() {
            // Un bloc détruit reste dans la liste jusqu'au prochain passage du feu : son corps a pu être libéré
            if !sim.bots[b].blocks[k].alive {
                continue;
            }
            let p = block_world_pos(sim, b, k);
            if p.y < water && ground_level(sim, p.x, p.z) < water {
                extinguish(sim, b, k);
            }
        }
    }
    // Tout est relevé : on peut infliger (des corps peuvent disparaître)
    if !burnt.blocks.is_empty() || !burnt.wheels.is_empty() || !burnt.props.is_empty() {
        inflict(sim, &burnt, UP, None);
    }
    if !drowned.blocks.is_empty() {
        inflict(sim, &drowned, UP, None);
    }
}
