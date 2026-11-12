//! Le feu (src/shared/combat/burning.ts, fire.ts). Un bloc en feu perd des points de structure
//! (dégâts `fire`) et peut gagner ses voisins ; il s'éteint au bout de quelques secondes s'il n'est
//! pas ravivé. On l'allume par une explosion (`Explosion.ignite`), quand une batterie est détruite,
//! ou au contact d'un accessoire en bois qui brûle. Le bois du décor brûle aussi : il perd des
//! points, noircit, gagne le bois voisin et les robots qui le frôlent. Le tout par tranches de
//! `TICK` s, avec les tirages du hasard aux mêmes endroits que le TypeScript.
//!
//! Pas encore porté : les flaques de feu au sol (lance-flammes, napalm) : rien de ce qui est porté
//! n'en allume (une explosion qui en laisserait une est comptée dans `Stats.unported`).

use super::damage::{DamageBatch, Target, inflict};
use super::debris::block_world_pos;
use super::props::{prop, prop_distance, prop_mut, prop_nearest, present};
use super::catalog::{PropShape, catalog};
use super::structure::linked_neighbors;
use super::vec::{V3, v3};
use super::world::{STEP, Sim};
use crate::det::{dcos, dsin};
use crate::jsmath;

/// Durée d'un feu sur un bloc ordinaire (s), s'il n'est pas ravivé.
pub const BURN_TIME: f64 = 6.0;
/// Dégâts d'un feu (points par seconde, avant résistance).
const FIRE_DPS: f64 = 12.0;
/// Probabilité, par seconde, qu'un feu gagne chaque voisin (multipliée par sa sensibilité).
const SPREAD_RATE: f64 = 0.03;
/// Le feu est traité par tranches de cette durée (s).
const TICK: f64 = 0.25;
const UP: V3 = v3(0.0, 1.0, 0.0);
/// Dégâts d'un accessoire en feu (points par seconde, avant sa résistance au feu).
const PROP_FIRE_DPS: f64 = 10.0;
/// Temps de feu (s) pour qu'un accessoire soit tout noir ; il noircit par crans.
const CHAR_TIME: f64 = 8.0;
const CHAR_STEPS: f64 = 4.0;
/// Probabilité, par seconde, qu'un accessoire en feu gagne un voisin en bois à portée.
const PROP_SPREAD: f64 = 0.035;
const PROP_GAP: f64 = 1.5;
/// Un bloc à moins de cette distance (m) d'un accessoire en feu peut s'enflammer (chance par seconde).
const PROP_SCORCH: f64 = 0.5;
const PROP_SCORCH_CHANCE: f64 = 0.6;

/// Sensibilité d'un bloc au feu : son facteur de dégâts `fire` (`flammability`).
fn flammability(sim: &Sim, bot: usize, block: usize) -> f64 {
    catalog().blocks[&sim.bots[bot].blocks[block].kind].resistance("fire")
}

/// Allume (ou ravive) un feu sur un bloc (`ignite`) : un bloc qui résiste au feu brûle moins longtemps.
pub fn ignite(sim: &mut Sim, bot: usize, block: usize, duration: f64) {
    if !sim.bots[bot].blocks[block].alive {
        return;
    }
    let time = duration * jsmath::min(1.5, flammability(sim, bot, block));
    let b = &mut sim.bots[bot].blocks[block];
    if b.burn <= 0.0 {
        sim.fires.push((bot, block));
        sim.stats.fires_started += 1;
    }
    b.burn = jsmath::max(b.burn, time);
}

/// Éteint le feu d'un bloc (`extinguish`).
fn extinguish(sim: &mut Sim, bot: usize, block: usize) {
    let Some(i) = sim.fires.iter().position(|&f| f == (bot, block)) else { return };
    sim.fires.remove(i);
    let b = &mut sim.bots[bot].blocks[block];
    b.burn = 0.0;
    if b.alive {
        sim.stats.fires_ended += 1;
    }
}

/// L'accessoire est-il en bois (`burnable`) ?
fn burnable(sim: &Sim, i: usize) -> bool {
    prop(sim, i).def().burns.is_some()
}

/// Allume (ou ravive) le feu d'un accessoire en bois (`igniteProp`).
pub fn ignite_prop(sim: &mut Sim, i: usize) {
    let p = prop_mut(sim, i);
    let Some((time, _)) = p.def().burns else { return };
    let lit = p.burn <= 0.0;
    p.burn = jsmath::max(p.burn, time);
    if !lit {
        return;
    }
    sim.prop_fires.push(i);
    sim.stats.prop_fire_events += 1;
}

/// Éteint le feu d'un accessoire, qui a fini de brûler (`extinguishProp`).
fn extinguish_prop(sim: &mut Sim, i: usize) {
    let Some(k) = sim.prop_fires.iter().position(|&p| p == i) else { return };
    sim.prop_fires.remove(k);
    prop_mut(sim, i).burn = 0.0;
    sim.stats.prop_fire_events += 1;
}

/// Un pas de vie des feux (`updateFires`) : dégâts, propagation, extinction, par tranches de TICK.
pub fn update_fires(sim: &mut Sim) {
    if (sim.time / TICK).floor() == ((sim.time - STEP) / TICK).floor() {
        return;
    }
    if sim.fires.is_empty() && sim.prop_fires.is_empty() {
        return;
    }
    let mut batch = DamageBatch::default();
    for (bot, block) in sim.fires.clone() {
        if !sim.bots[bot].blocks[block].alive {
            sim.fires.retain(|&f| f != (bot, block));
            continue;
        }
        batch.add(sim, Some(Target::Block(bot, block)), FIRE_DPS * TICK, "fire");
        for n in linked_neighbors(&sim.bots[bot], block) {
            if sim.bots[bot].blocks[n].burn <= 0.0 && sim.rng.rand(0.0, 1.0) < SPREAD_RATE * TICK * flammability(sim, bot, n) {
                ignite(sim, bot, n, BURN_TIME);
            }
        }
        let b = &mut sim.bots[bot].blocks[block];
        b.burn -= TICK;
        if b.burn <= 0.0 {
            extinguish(sim, bot, block);
        }
    }
    // Tout ce qui se lit sur les corps se lit avant d'infliger quoi que ce soit
    let props = burn_props(sim);
    if !batch.blocks.is_empty() {
        inflict(sim, &batch, UP);
    }
    for (b, dir) in props {
        inflict(sim, &b, dir);
    }
}

/// Les accessoires en feu (`burnProps`) : dégâts (chacun son lot : un arbre qui cède bascule d'un
/// côté au hasard), noircissement, propagation au bois voisin et aux robots qui les frôlent, extinction.
fn burn_props(sim: &mut Sim) -> Vec<(DamageBatch, V3)> {
    let mut out = Vec::new();
    for i in sim.prop_fires.clone() {
        let mut batch = DamageBatch::default();
        batch.add(sim, Some(Target::Prop(i)), PROP_FIRE_DPS * TICK, "fire");
        let angle = sim.rng.rand(0.0, std::f64::consts::PI * 2.0);
        out.push((batch, v3(dcos(angle), 0.0, dsin(angle))));
        let p = prop_mut(sim, i);
        let step = (p.charred * CHAR_STEPS).floor();
        p.charred = jsmath::min(1.0, p.charred + TICK / CHAR_TIME);
        if (p.charred * CHAR_STEPS).floor() != step {
            sim.stats.prop_fire_events += 1;
        }
        spread_to_props(sim, i);
        scorch_robots(sim, i);
        let p = prop_mut(sim, i);
        p.burn -= TICK;
        if p.burn <= 0.0 {
            extinguish_prop(sim, i);
        }
    }
    out
}

/// Portée des flammes d'un accessoire en bois au-delà de sa surface (`flameReach`).
fn flame_reach(sim: &Sim, i: usize) -> f64 {
    let p = prop(sim, i);
    let def = p.def();
    let reach = def.burns.map_or(0.0, |b| b.1);
    match def.shape {
        PropShape::Cylinder { half_height, .. } => reach * (p.half.y / half_height),
        _ => reach * 1.0,
    }
}

/// Plus grand demi-côté d'un accessoire (`extent`).
fn extent(sim: &Sim, i: usize) -> f64 {
    let h = prop(sim, i).half;
    jsmath::max(jsmath::max(h.x, h.y), h.z)
}

/// Le feu gagne le bois voisin à portée (`spreadToProps`).
fn spread_to_props(sim: &mut Sim, i: usize) {
    let center = sim.phys.translation(prop(sim, i).rb);
    let reach = flame_reach(sim, i);
    for other in present(sim) {
        if other == i || prop(sim, other).burn > 0.0 || !burnable(sim, other) {
            continue;
        }
        let at = sim.phys.translation(prop(sim, other).rb);
        let span = reach + flame_reach(sim, other) + PROP_GAP;
        let d = jsmath::hypot3(center.x - at.x, center.y - at.y, center.z - at.z);
        if d - extent(sim, i) - extent(sim, other) > span {
            continue;
        }
        let gap = prop_distance(sim, other, prop_nearest(sim, i, at));
        if gap < span && sim.rng.rand(0.0, 1.0) < PROP_SPREAD * TICK {
            ignite_prop(sim, other);
        }
    }
}

/// Le feu d'un accessoire gagne les blocs des robots qui le frôlent (`scorchRobots`).
fn scorch_robots(sim: &mut Sim, i: usize) {
    let center = sim.phys.translation(prop(sim, i).rb);
    let size = extent(sim, i) + 4.0;
    for bot in 0..sim.bots.len() {
        let b = &sim.bots[bot];
        if !b.cockpit_alive() {
            continue;
        }
        let ck = sim.phys.translation(sim.part(b.cockpit_part()).rb);
        if jsmath::hypot3(ck.x - center.x, ck.y - center.y, ck.z - center.z) > size {
            continue;
        }
        for block in 0..sim.bots[bot].blocks.len() {
            let k = &sim.bots[bot].blocks[block];
            if !k.alive || k.burn > 0.0 {
                continue;
            }
            if prop_distance(sim, i, block_world_pos(sim, bot, block)) < PROP_SCORCH
                && sim.rng.rand(0.0, 1.0) < PROP_SCORCH_CHANCE * TICK * flammability(sim, bot, block)
            {
                ignite(sim, bot, block, BURN_TIME);
            }
        }
    }
}
