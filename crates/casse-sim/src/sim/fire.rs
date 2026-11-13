//! Le feu (src/shared/combat/burning.ts, fire.ts). Un bloc en feu perd des points de structure
//! (dégâts `fire`) et peut gagner ses voisins ; il s'éteint au bout de quelques secondes s'il n'est
//! pas ravivé. On l'allume par une explosion (`Explosion.ignite`), quand une batterie est détruite,
//! ou au contact d'un accessoire en bois qui brûle. Le bois du décor brûle aussi : il perd des
//! points, noircit, gagne le bois voisin et les robots qui le frôlent. Et les flaques de feu au sol
//! (`GroundFire` : le napalm d'une explosion, le jet du lance-flammes) brûlent les blocs et les roues
//! qui s'y tiennent (sauf ceux du robot qui les a allumées), les enflamment parfois, et allument le
//! bois qu'elles touchent ; jamais sous l'eau, 40 au plus. Le tout par tranches de `TICK` s, avec les
//! tirages du hasard aux mêmes endroits que le TypeScript.

use super::catalog::{PropShape, Puddle, catalog};
use super::damage::{DamageBatch, Target, inflict};
use super::debris::block_world_pos;
use super::physics::groups;
use super::props::{prop, prop_distance, prop_mut, prop_nearest, present};
use super::structure::linked_neighbors;
use super::vec::{V3, len, v3};
use super::world::{STEP, Sim};
use super::events::{Writer, code};
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
/// Dégâts d'une flaque de feu (points par seconde, avant résistance) ; hauteur (m) au-dessus d'elle qu'elle atteint.
const GROUND_FIRE_DPS: f64 = 9.0;
const GROUND_FIRE_HEIGHT: f64 = 1.1;
/// Chance, par seconde, qu'une flaque enflamme un bloc qui s'y tient, ou un accessoire en bois qu'elle touche.
const GROUND_IGNITE: f64 = 0.5;
const GROUND_PROP_IGNITE: f64 = 1.2;
/// Flaques de feu à la fois, au plus (combat/burning.ts) : au-delà, un nouveau jet ne fait que raviver les flaques.
const MAX_GROUND_FIRES: usize = 40;
/// Une flaque à moins de cette part de son rayon d'une autre la ravive au lieu d'en faire une nouvelle.
const MERGE: f64 = 0.8;
/// Hauteur (m) au-dessus du sol en deçà de laquelle un jet ou une explosion trouve le sol.
pub const PUDDLE_REACH: f64 = 1.5;

/// Une flaque de feu au sol (`GroundFire`) : son centre (au sol), son rayon, jusqu'à quand elle
/// brûle, et le robot qui l'a allumée (ses flaques ne le brûlent pas).
#[derive(Clone, Copy, Debug)]
pub struct GroundFire {
    /// Son numéro d'entité (`id`, `sim.nextId()`).
    pub id: u64,
    pub pos: V3,
    pub radius: f64,
    pub until: f64,
    pub owner: Option<usize>,
}

/// Sensibilité d'un bloc au feu : son facteur de dégâts `fire` (`flammability`).
pub fn flammability(sim: &Sim, bot: usize, block: usize) -> f64 {
    catalog().blocks[&sim.bots[bot].blocks[block].kind].resistance("fire")
}

/// Allume (ou ravive) un feu sur un bloc (`ignite`) : un bloc qui résiste au feu brûle moins longtemps.
pub fn ignite(sim: &mut Sim, bot: usize, block: usize, duration: f64) {
    if !sim.bots[bot].blocks[block].alive {
        return;
    }
    let time = duration * jsmath::min(1.5, flammability(sim, bot, block));
    if sim.bots[bot].blocks[block].burn <= 0.0 {
        // (un `Set` : un bloc détruit en brûlant, qui repousse éteint avant le prochain passage du
        // feu, y est encore)
        if !sim.fires.contains(&(bot, block)) {
            sim.fires.push((bot, block));
        }
        sim.stats.fires_started += 1;
        sim.emit_block(code::FIRE_STARTED, bot, block);
    }
    let b = &mut sim.bots[bot].blocks[block];
    b.burn = jsmath::max(b.burn, time);
}

/// Éteint le feu d'un bloc (`extinguish`).
pub fn extinguish(sim: &mut Sim, bot: usize, block: usize) {
    let Some(i) = sim.fires.iter().position(|&f| f == (bot, block)) else { return };
    sim.fires.remove(i);
    let b = &mut sim.bots[bot].blocks[block];
    b.burn = 0.0;
    if b.alive {
        sim.stats.fires_ended += 1;
        sim.emit_block(code::FIRE_ENDED, bot, block);
    }
}

/// L'accessoire est-il en bois (`burnable`) ?
pub fn burnable(sim: &Sim, i: usize) -> bool {
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
    emit_prop_fire(sim, i);
}

/// Le feu d'un accessoire change (`propFire`) : son numéro, s'il brûle, sa part noircie.
pub fn emit_prop_fire(sim: &mut Sim, i: usize) {
    sim.emit(code::PROP_FIRE, |s, w| {
        let p = prop(s, i);
        w.id(Some(p.id)).flag(p.burn > 0.0).num(p.charred);
    });
}

/// Éteint le feu d'un accessoire, qui a fini de brûler (`extinguishProp`).
fn extinguish_prop(sim: &mut Sim, i: usize) {
    let Some(k) = sim.prop_fires.iter().position(|&p| p == i) else { return };
    sim.prop_fires.remove(k);
    prop_mut(sim, i).burn = 0.0;
    sim.stats.prop_fire_events += 1;
    emit_prop_fire(sim, i);
}

/// Un pas de vie des feux (`updateFires`) : dégâts, propagation, extinction, par tranches de TICK.
pub fn update_fires(sim: &mut Sim) {
    if (sim.time / TICK).floor() == ((sim.time - STEP) / TICK).floor() {
        return;
    }
    if sim.fires.is_empty() && sim.prop_fires.is_empty() && sim.ground_fires.is_empty() {
        return;
    }
    let mut batch = DamageBatch { fiery: true, cause: Some("fire"), ..DamageBatch::default() };
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
    let puddles = burn_ground(sim);
    if !batch.blocks.is_empty() {
        inflict(sim, &batch, UP, None);
    }
    for b in puddles {
        inflict(sim, &b, UP, None);
    }
    for (b, dir) in props {
        inflict(sim, &b, dir, None);
    }
}

/// Le sol ou le décor fixe sous `point`, à moins de `depth` m (un rayon qui ne voit qu'eux), ou
/// rien : un jet qui s'éteint en l'air ne laisse pas de flaque (`groundBelow`).
pub fn ground_below(sim: &Sim, point: V3, depth: f64) -> Option<V3> {
    let from = v3(point.x, point.y + 0.2, point.z);
    let toi = sim.phys.cast_ray(from, v3(0.0, -1.0, 0.0), depth + 0.2, true, groups::GROUND_RAY)?;
    Some(v3(point.x, from.y - toi, point.z))
}

/// Allume une flaque de feu au sol en `pos`, ou ravive celle qui y brûle déjà (sans l'agrandir)
/// (`spawnGroundFire`) ; `owner` : le robot qui l'a allumée. Rien sous l'eau, ni au-delà de
/// `MAX_GROUND_FIRES`. Vrai si une flaque brûle là (nouvelle ou ravivée).
pub fn spawn_ground_fire(sim: &mut Sim, pos: V3, spec: Puddle, owner: Option<usize>) -> bool {
    // L'eau l'éteint
    if let Some(water) = sim.water
        && pos.y < water
    {
        return false;
    }
    let time = sim.time;
    for f in sim.ground_fires.iter_mut() {
        if jsmath::hypot2(f.pos.x - pos.x, f.pos.z - pos.z) < f.radius * MERGE && (f.pos.y - pos.y).abs() < 1.0 {
            f.until = jsmath::max(f.until, time + spec.life);
            return true;
        }
    }
    if sim.ground_fires.len() >= MAX_GROUND_FIRES {
        return false;
    }
    let id = sim.next_id();
    sim.ground_fires.push(GroundFire { id, pos, radius: spec.radius, until: time + spec.life, owner });
    sim.stats.ground_fires_added += 1;
    sim.emit(code::GROUND_FIRE_ADDED, |s, w| write_ground_fire(w, s.ground_fires.last().expect("flaque")));
    true
}

/// Une flaque telle que l'encodeur la décrit : son numéro, son centre, son rayon, sa fin.
pub fn write_ground_fire(w: &mut Writer, f: &GroundFire) {
    w.id(Some(f.id)).vec(f.pos).num(f.radius).num(f.until);
}

/// Éteint une flaque de feu (`removeGroundFire`).
pub fn remove_ground_fire(sim: &mut Sim, k: usize) {
    let fire = sim.ground_fires.remove(k);
    sim.stats.ground_fires_removed += 1;
    sim.emit_gone(code::GROUND_FIRE_REMOVED, fire.id);
}

/// Ce point est-il dans la flaque : à moins de son rayon (dans le plan), et au plus `height` m
/// au-dessus d'elle (`inPuddle`) ?
fn in_puddle(fire: &GroundFire, p: V3, height: f64) -> bool {
    let dy = p.y - fire.pos.y;
    dy > -0.3 && dy < height && len(v3(p.x - fire.pos.x, 0.0, p.z - fire.pos.z)) < fire.radius
}

/// Les flaques de feu (`burnGround`) : celles qui ont fait leur temps s'éteignent ; les autres
/// brûlent les blocs et les roues qui s'y tiennent (sauf ceux du robot qui les a allumées), les
/// enflamment parfois, et allument le bois qu'elles touchent. Un lot par flaque (chacune a son
/// auteur : le dernier attaquant de ceux qu'elle brûle).
fn burn_ground(sim: &mut Sim) -> Vec<DamageBatch> {
    let time = sim.time;
    let mut k = 0;
    while k < sim.ground_fires.len() {
        if time >= sim.ground_fires[k].until {
            remove_ground_fire(sim, k);
        } else {
            k += 1;
        }
    }
    let mut out = Vec::new();
    for k in 0..sim.ground_fires.len() {
        let fire = sim.ground_fires[k];
        let mut batch = DamageBatch { attacker: fire.owner, fiery: true, cause: Some("fire"), ..DamageBatch::default() };
        for bot in sim.roster.clone() {
            let b = &sim.bots[bot];
            if Some(bot) == fire.owner || !b.cockpit_alive() {
                continue;
            }
            let ck = sim.phys.translation(sim.part(b.cockpit_part()).rb);
            if jsmath::hypot3(ck.x - fire.pos.x, ck.y - fire.pos.y, ck.z - fire.pos.z) > fire.radius + 6.0 {
                continue;
            }
            for block in sim.bots[bot].live.clone() {
                if !in_puddle(&fire, block_world_pos(sim, bot, block), GROUND_FIRE_HEIGHT) {
                    continue;
                }
                batch.add(sim, Some(Target::Block(bot, block)), GROUND_FIRE_DPS * TICK, "fire");
                if sim.bots[bot].blocks[block].burn <= 0.0 && sim.rng.rand(0.0, 1.0) < GROUND_IGNITE * TICK * flammability(sim, bot, block) {
                    ignite(sim, bot, block, BURN_TIME);
                }
            }
            for w in 0..sim.bots[bot].wheels.len() {
                let wheel = &sim.bots[bot].wheels[w];
                if wheel.part.is_some() && in_puddle(&fire, wheel.rb.pos, GROUND_FIRE_HEIGHT) {
                    batch.add(sim, Some(Target::Wheel(bot, w)), GROUND_FIRE_DPS * TICK, "fire");
                }
            }
        }
        for i in present(sim) {
            if prop(sim, i).burn > 0.0 || !burnable(sim, i) {
                continue;
            }
            if prop_distance(sim, i, fire.pos) < fire.radius && sim.rng.rand(0.0, 1.0) < GROUND_PROP_IGNITE * TICK {
                ignite_prop(sim, i);
            }
        }
        if !batch.blocks.is_empty() || !batch.wheels.is_empty() {
            out.push(batch);
        }
    }
    out
}

/// Les accessoires en feu (`burnProps`) : dégâts (chacun son lot : un arbre qui cède bascule d'un
/// côté au hasard), noircissement, propagation au bois voisin et aux robots qui les frôlent, extinction.
fn burn_props(sim: &mut Sim) -> Vec<(DamageBatch, V3)> {
    let mut out = Vec::new();
    for i in sim.prop_fires.clone() {
        let mut batch = DamageBatch { fiery: true, cause: Some("fire"), ..DamageBatch::default() };
        batch.add(sim, Some(Target::Prop(i)), PROP_FIRE_DPS * TICK, "fire");
        let angle = sim.rng.rand(0.0, std::f64::consts::PI * 2.0);
        out.push((batch, v3(dcos(angle), 0.0, dsin(angle))));
        let p = prop_mut(sim, i);
        let step = (p.charred * CHAR_STEPS).floor();
        p.charred = jsmath::min(1.0, p.charred + TICK / CHAR_TIME);
        if (p.charred * CHAR_STEPS).floor() != step {
            sim.stats.prop_fire_events += 1;
            emit_prop_fire(sim, i);
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
    for bot in sim.roster.clone() {
        let b = &sim.bots[bot];
        if !b.cockpit_alive() {
            continue;
        }
        let ck = sim.phys.translation(sim.part(b.cockpit_part()).rb);
        if jsmath::hypot3(ck.x - center.x, ck.y - center.y, ck.z - center.z) > size {
            continue;
        }
        for block in sim.bots[bot].live.clone() {
            if sim.bots[bot].blocks[block].burn > 0.0 {
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
