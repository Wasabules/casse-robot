//! Le jet de flamme des moteurs à flamme (src/shared/robot/exhaust.ts) : derrière la tuyère d'un
//! réacteur, d'un propulseur ou d'un turboréacteur, à l'opposé de sa poussée, un cône chaud dont la
//! longueur et la chaleur suivent le régime. De la géométrie, sans physique : ce que le jet brûle est
//! dans scorch.rs ; l'IA s'en sert pour ne pas allumer un propulseur qui brûlerait son propre robot
//! (`scorchesItself`) et pour allumer ceux qui brûleraient un ennemi collé à son arrière (`foeInJet`).

use super::catalog::{ExhaustSpec, catalog};
use super::debris::block_world_pos;
use super::propulsion::{live_thrusters, spec_of};
use super::robot::{Cell, Role};
use super::vec::{V3, add, clamp, dot, len, qrot, scale, sub, v3};
use super::world::Sim;
use crate::jsmath;
use std::collections::HashMap;

/// Régime sous lequel un moteur n'a pas de jet ; longueur du jet au ralenti (part de celle à plein
/// régime) ; chaleur qui reste au bout ; la postcombustion l'allonge et le chauffe d'autant de plus.
const JET_MIN: f64 = 0.05;
const IDLE_LENGTH: f64 = 0.25;
const TIP_HEAT: f64 = 0.3;
const BOOST_LENGTH: f64 = 0.5;
const BOOST_HEAT: f64 = 0.35;

/// Le jet d'un moteur à flamme de ce type et de ce rôle, s'il en a un (`exhaustSpec`) : pas un rotor,
/// une hélice, ni un réacteur couché de côté (dessiné en rotor de queue).
pub fn exhaust_spec(kind: &str, role: Role) -> Option<ExhaustSpec> {
    let spec = catalog().blocks[kind].thruster.as_ref()?;
    let exhaust = spec.exhaust?;
    if spec.look.is_none() && role == Role::Trim {
        return None;
    }
    Some(exhaust)
}

/// Longueur (m, au-delà de la tuyère), chaleur (dégâts par seconde à la tuyère) et postcombustion
/// d'un jet à ce régime (0 à 1) (`jetSize`).
fn jet_size(spec: &ExhaustSpec, ratio: f64) -> (f64, f64, f64) {
    // (`spec.afterburner && …` : 0 ou absent, pas de postcombustion)
    let boost = match spec.afterburner {
        Some(a) if a != 0.0 && ratio > a => (ratio - a) / (1.0 - a),
        _ => 0.0,
    };
    let length = spec.reach * (IDLE_LENGTH + (1.0 - IDLE_LENGTH) * ratio) * (1.0 + BOOST_LENGTH * boost);
    let dps = spec.dps * ratio * (1.0 + BOOST_HEAT * boost);
    (length, dps, boost)
}

/// Le jet d'un moteur en ce moment (`Jet`) : son robot et son moteur (son rang), son réglage, le bout
/// de la tuyère et la direction du jet (monde), sa longueur au-delà de la tuyère (m), sa chaleur à la
/// tuyère (dégâts par seconde, avant résistance).
#[derive(Clone, Copy)]
pub struct Jet {
    pub bot: usize,
    pub thruster: usize,
    pub spec: ExhaustSpec,
    pub origin: V3,
    pub dir: V3,
    pub length: f64,
    pub dps: f64,
}

/// Le jet d'un moteur, d'après son régime (`jetOf`) ; rien s'il n'a pas de flamme ou tourne au ralenti.
pub fn jet_of(sim: &Sim, b: usize, t: usize) -> Option<Jet> {
    let ratio = clamp(sim.bots[b].thrusters[t].thrust / spec_of(sim, b, t).max_thrust, 0.0, 1.0);
    if ratio < JET_MIN { None } else { jet_at(sim, b, t, ratio) }
}

/// Le jet du moteur à ce régime (0 à 1), ou rien s'il n'a pas de flamme (`jetAt`).
fn jet_at(sim: &Sim, b: usize, t: usize, ratio: f64) -> Option<Jet> {
    let th = &sim.bots[b].thrusters[t];
    let block = &sim.bots[b].blocks[th.block];
    let spec = exhaust_spec(&block.kind, th.role)?;
    if !block.alive {
        return None;
    }
    let dir = qrot(sim.phys.rotation(sim.part(block.part).rb), scale(block.up, -1.0));
    let origin = add(block_world_pos(sim, b, th.block), scale(dir, spec.nozzle));
    let (length, dps, _) = jet_size(&spec, ratio);
    Some(Jet { bot: b, thruster: t, spec, origin, dir, length, dps })
}

/// Rayon du jet (m) à `d` m de la tuyère (`jetRadius`).
pub fn jet_radius(jet: &Jet, d: f64) -> f64 {
    jet.spec.radius + jet.spec.flare * d
}

/// Chaleur du jet à `d` m de la tuyère : dégâts par seconde (avant résistance) (`jetHeat`).
pub fn jet_heat(jet: &Jet, d: f64) -> f64 {
    jet.dps * (1.0 - (1.0 - TIP_HEAT) * clamp(d / jet.length, 0.0, 1.0))
}

/// Ce que le jet touche de son propre robot (`OwnContact`) : un bloc (ou la tête d'une de ses
/// tourelles : le bloc de la tourelle), une roue, et sa distance à la tuyère (m).
#[derive(Clone, Copy)]
pub struct OwnContact {
    pub block: Option<usize>,
    pub wheel: Option<usize>,
    pub distance: f64,
}

/// La case d'un point du repère du robot (`Math.round` de chaque coordonnée, en cases).
fn cell_at(x: f64, y: f64, z: f64) -> Cell {
    (jsmath::round(x) as i64, jsmath::round(y) as i64, jsmath::round(z) as i64)
}

/// Cases des têtes des tourelles du morceau `part` (leur axe), et la tourelle (son bloc) de chacune
/// (`headCells` ; une `Map` : la dernière posée sur une case la garde).
fn head_cells(sim: &Sim, b: usize, part: usize) -> HashMap<Cell, usize> {
    let bs = catalog().constants.block_size;
    let bot = &sim.bots[b];
    let mut out = HashMap::new();
    for t in &bot.turrets {
        let k = &bot.blocks[t.block];
        if !k.alive || k.part != part {
            continue;
        }
        let height = catalog().blocks[&k.kind].turret.as_ref().map_or(0.0, |s| s.height);
        let pivot = add(k.local, qrot(k.rot, v3(0.0, height, 0.0)));
        out.insert(cell_at(pivot.x / bs, pivot.y / bs, pivot.z / bs), t.block);
    }
    out
}

/// Ce que le jet touche de son propre morceau (`ownContact`) : le premier bloc (ou la tête d'une de
/// ses tourelles) dans l'axe de la tuyère, case par case dans la grille du robot, ou une de ses roues.
pub fn own_contact(sim: &Sim, jet: &Jet) -> Option<OwnContact> {
    let bs = catalog().constants.block_size;
    let bot = &sim.bots[jet.bot];
    let block = &bot.blocks[bot.thrusters[jet.thruster].block];
    let part = block.part;
    // (`-Math.round(…)` : un zéro négatif, comme le TypeScript)
    let back = v3(-jsmath::round(block.up.x), -jsmath::round(block.up.y), -jsmath::round(block.up.z));
    let heads = head_cells(sim, jet.bot, part);
    let mut found: Option<OwnContact> = None;
    let mut k = 1.0;
    loop {
        // Distance de la tuyère au bord de la case : une case contre la nacelle d'un turboréacteur est à 0
        let near = k * bs - bs / 2.0 - jet.spec.nozzle;
        if near > jet.length {
            break;
        }
        let cell: Cell = ((block.x + k * back.x) as i64, (block.y + k * back.y) as i64, (block.z + k * back.z) as i64);
        let hit = bot.cells.get(&cell).copied().filter(|&h| bot.blocks[h].part == part);
        if let Some(target) = hit.or_else(|| heads.get(&cell).copied()) {
            found = Some(OwnContact { block: Some(target), wheel: None, distance: jsmath::max(0.0, near) });
            break;
        }
        k += 1.0;
    }
    // Ses roues : une sphère un peu plus petite que la roue, contre le cône du jet (repère du robot)
    let reach = found.map_or(jet.length, |f| f.distance);
    let origin = add(block.local, scale(back, jet.spec.nozzle));
    for (i, w) in bot.wheels.iter().enumerate() {
        if w.part != Some(part) {
            continue;
        }
        let rel = sub(w.local, origin);
        let along = dot(rel, back);
        let r = w.def.radius * 0.8;
        if along < -r || along - r > reach {
            continue;
        }
        let lateral = len(sub(rel, scale(back, along)));
        if lateral > r + jet_radius(jet, jsmath::max(0.0, along)) {
            continue;
        }
        let d = jsmath::max(0.0, along - r);
        if found.is_none_or(|f| d < f.distance) {
            found = Some(OwnContact { block: None, wheel: Some(i), distance: d });
        }
    }
    found
}

/// Un de ses moteurs de ce rôle brûlerait-il son propre robot à plein régime (`scorchesItself`) ?
pub fn scorches_itself(sim: &Sim, b: usize, role: Role) -> bool {
    live_thrusters(sim, b, Some(role)).into_iter().any(|t| jet_at(sim, b, t, 1.0).is_some_and(|jet| own_contact(sim, &jet).is_some()))
}

/// Un ennemi est-il dans le jet à plein régime d'un de ses moteurs de ce rôle (son cockpit à moins de
/// son rayon du cône) (`foeInJet`) ?
pub fn foe_in_jet(sim: &Sim, b: usize, role: Role) -> bool {
    let jets: Vec<Jet> = live_thrusters(sim, b, Some(role)).into_iter().filter_map(|t| jet_at(sim, b, t, 1.0)).collect();
    if jets.is_empty() {
        return false;
    }
    let team = sim.bots[b].team;
    for (o, other) in sim.roster.iter().map(|&o| (o, &sim.bots[o])) {
        if other.team == team || !other.cockpit_alive() {
            continue;
        }
        let at = block_world_pos(sim, o, other.cockpit);
        let r = jsmath::min(other.radius, 1.5);
        for jet in &jets {
            let rel = sub(at, jet.origin);
            let along = dot(rel, jet.dir);
            if along < -r || along - r > jet.length {
                continue;
            }
            if len(sub(rel, scale(jet.dir, along))) < r + jet_radius(jet, jsmath::max(0.0, along)) {
                return true;
            }
        }
    }
    false
}
