//! La tactique de l'IA en combat (src/shared/ai/tactics.ts) : où aller. Le robot choisit un adversaire
//! (celui que visent ses tourelles, sinon celui qu'il combattait encore en vue, sinon l'ennemi repéré
//! le plus proche contre lequel une de ses armes porte ; caché, il le garde `FOE_MEMORY` s), puis :
//! - il l'engage à sa portée préférée (`preferredRange`) : trop loin il approche, trop près il
//!   recule, à bonne distance il tourne autour de lui (`engagePoint`) ;
//! - un robot fait pour charger, dont les armes portent de près, le percute (armé pour le contact,
//!   seulement ses rotors lancés : avant, il tourne autour de lui à `STANDOFF` m ; une foreuse vise
//!   son cockpit) ;
//! - il se met à couvert derrière un pilier quand il a besoin d'un répit (chargeurs vides, batteries
//!   trop basses pour ses armes électriques, ou un module de réparation qui a de quoi faire) ;
//! - s'il porte un rayon réparateur, il va soigner l'allié le plus abîmé, avant tout le reste sauf un
//!   répit (`support` : il tourne autour de lui, son rayon n'atteignant qu'un côté à la fois) ;
//! - sans adversaire, il patrouille.
//! Le plan est revu toutes les `PLAN_PERIOD` s.
//!
//! Ses armes de contact comptent pour choisir un adversaire et sa portée préférée (brawl.rs). Il n'y a
//! ni partie (pas de zones à prendre), ni grille de passage (le couvert se cherche derrière les
//! obstacles du décor, comme dans les petites arènes).

use super::brain::{Mode, clamp_to_roam};
use super::brawl::{charge_point, melee_primed, melee_suits, offensive_melee};
use super::catalog::{Mobility, catalog};
use super::debris::block_world_pos;
use super::gunner::{are_enemies, suits};
use super::arena::ground_level;
use super::navigation::{at_level, flat_distance, obstacles};
use super::repair::repair_need;
use super::turrets::{live_turrets, weapon};
use super::vec::{V3, add, clamp, len, norm, qrot, scale, v3};
use super::world::Sim;
use crate::jsmath;

/// Intervalle entre deux révisions du plan (s).
const PLAN_PERIOD: f64 = 0.4;
/// Distance maximale à laquelle il cherche un adversaire (m).
const FOE_SEARCH: f64 = 100.0;
/// Temps pendant lequel il garde un adversaire qu'il ne voit plus (s).
const FOE_MEMORY: f64 = 4.0;
/// Distance devant lui du point vers lequel il roule en combat (m).
const LEAD: f64 = 12.0;
/// Écart à la portée préférée (m) pour lequel il s'en rapproche ou s'en écarte autant qu'il tourne autour.
const RANGE_SOFT: f64 = 6.0;
/// La portée préférée ne dépasse pas cette part de la portée de l'arme la plus courte.
const RANGE_MARGIN: f64 = 0.85;
/// Portée préférée sous laquelle un robot fait pour charger percute son adversaire (m).
const RAM_RANGE: f64 = 10.0;
/// Distance (m) à laquelle un robot armé pour le contact tourne autour de sa cible tant que ses rotors
/// ne sont pas lancés.
const STANDOFF: f64 = 7.0;
/// Points de structure à réparer qui valent qu'il se mette à couvert, et en deçà desquels il en ressort.
const REPAIR_WORTH: f64 = 150.0;
const REPAIR_DONE: f64 = 20.0;
/// Durée maximale à couvert (s), puis temps pendant lequel il ne s'y remet pas (s).
const MAX_COVER: f64 = 14.0;
const COVER_REST: f64 = 10.0;
/// Distance maximale d'un abri (m) ; écart entre l'abri et le robot caché derrière (m).
const COVER_SEARCH: f64 = 30.0;
const COVER_GAP: f64 = 0.8;
/// Sans abri à portée, il recule d'autant (m).
const RETREAT_DISTANCE: f64 = 20.0;
/// Soutien : un robot qui porte un rayon réparateur va soigner un allié qui a perdu au moins
/// SUPPORT_NEED points, à moins de SUPPORT_SEARCH m ; il tourne autour de lui à SUPPORT_DISTANCE m.
const SUPPORT_NEED: f64 = 60.0;
const SUPPORT_SEARCH: f64 = 70.0;
const SUPPORT_DISTANCE: f64 = 9.0;

/// L'état tactique d'un robot (`TacticsState`) : son adversaire et quand il l'a vu pour la dernière
/// fois, le sens dans lequel il tourne autour, le temps avant de revoir son plan, le temps passé à
/// couvert et l'instant avant lequel il ne s'y remet pas.
#[derive(Clone, Copy, Debug)]
pub struct Tactics {
    pub foe: Option<usize>,
    pub seen_at: f64,
    pub orbit: f64,
    pub plan_t: f64,
    pub cover_t: f64,
    pub cover_ban: f64,
    /// En capture de zones, il a une zone à prendre ou à tenir (`holding`) : il ne fuit pas quand on le touche.
    pub holding: bool,
}

/// Un coéquipier qui va déjà vers une zone l'éloigne d'autant (m) : l'équipe se répartit (`CROWD_COST`).
const CROWD_COST: f64 = 12.0;

/// Capture de zones : la zone où aller (`objectiveZone`). D'abord celles que son équipe ne tient pas
/// (ou qu'on lui dispute), la plus proche, chaque coéquipier qui y va déjà l'éloignant ; s'il les tient
/// toutes, la même règle entre toutes. Rien : pas de zones (au roi de la colline, seule la colline).
pub fn objective_zone(sim: &Sim, b: usize, pos: V3) -> Option<super::game::ZoneState> {
    let m = sim.match_.as_ref()?;
    let zones: Vec<super::game::ZoneState> = m.zones.iter().copied().filter(|z| z.active).collect();
    if zones.is_empty() {
        return None;
    }
    let team = sim.bots[b].team;
    let open: Vec<super::game::ZoneState> = zones.iter().copied().filter(|z| z.owner != Some(team) || z.contested).collect();
    let mut best = None;
    let mut best_cost = f64::INFINITY;
    for z in if open.is_empty() { &zones } else { &open } {
        let mut cost = flat_distance(z.zone.pos, pos);
        for &mate in &sim.roster {
            let m = &sim.bots[mate];
            if mate != b && m.team == team && m.cockpit_alive() && flat_distance(m.ai.target, z.zone.pos) <= z.zone.radius {
                cost += CROWD_COST;
            }
        }
        if cost < best_cost {
            best_cost = cost;
            best = Some(*z);
        }
    }
    best
}

impl Tactics {
    /// L'état d'un robot qui apparaît (`createTactics`).
    pub fn new() -> Self {
        Tactics { foe: None, seen_at: f64::NEG_INFINITY, orbit: 1.0, plan_t: 0.0, cover_t: 0.0, cover_ban: f64::NEG_INFINITY, holding: false }
    }
}

impl Default for Tactics {
    fn default() -> Self {
        Self::new()
    }
}

fn distance(a: V3, b: V3) -> f64 {
    jsmath::hypot3(a.x - b.x, a.y - b.y, a.z - b.z)
}

/// L'équipe `team` a-t-elle repéré ce robot (`isDetected`) ? Oui tant que la détection n'a pas tourné.
pub fn is_detected(sim: &Sim, team: usize, bot: usize) -> bool {
    sim.detected[team].as_ref().is_none_or(|seen| seen.contains(&bot))
}

/// Révise le plan de combat (`planCombat`), toutes les PLAN_PERIOD s : mode et destination.
pub fn plan_combat(sim: &mut Sim, b: usize, pos: V3, dt: f64) {
    let ai = &mut sim.bots[b].ai;
    if ai.mode == Mode::Cover {
        ai.tactics.cover_t += dt;
    }
    ai.tactics.plan_t -= dt;
    if ai.tactics.plan_t > 0.0 {
        return;
    }
    ai.tactics.plan_t = PLAN_PERIOD;

    let foe = choose_foe(sim, b);
    sim.bots[b].ai.tactics.foe = foe;
    // Soutien : un allié abîmé passe avant tout, sauf un répit pour recharger
    if let Some(patient) = support_target(sim, b)
        && !(sim.bots[b].ai.mode == Mode::Cover && needs_respite(sim, b, true))
    {
        let at = sim.bots[patient].last_pos;
        if sim.bots[b].ai.mode != Mode::Support {
            let side = orbit_side(sim, b, pos, at);
            sim.bots[b].ai.tactics.orbit = side;
        }
        sim.bots[b].ai.mode = Mode::Support;
        let target = engage_point(sim, b, pos, at, SUPPORT_DISTANCE);
        sim.bots[b].ai.target = target;
        return;
    }
    let objective = if sim.bots[b].mobility == Mobility::Plane { None } else { objective_zone(sim, b, pos) };
    sim.bots[b].ai.tactics.holding = objective.is_some();
    // Capture de zones : une patrouille qui ne mène pas à la zone visée se redirige
    if let Some(z) = objective
        && sim.bots[b].ai.mode == Mode::Patrol
        && flat_distance(sim.bots[b].ai.target, z.zone.pos) > z.zone.radius
    {
        sim.bots[b].ai.timer = 0.0;
    }
    let Some(foe) = foe else {
        let ai = &mut sim.bots[b].ai;
        if matches!(ai.mode, Mode::Engage | Mode::Cover | Mode::Charge | Mode::Support) {
            ai.mode = Mode::Patrol;
            ai.timer = 0.0;
        }
        return;
    };
    let threat = sim.bots[foe].last_pos;

    // Un répit derrière un pilier : chargeurs vides, ou réparations à faire
    let covering = sim.bots[b].ai.mode == Mode::Cover;
    if sim.time >= sim.bots[b].ai.tactics.cover_ban && needs_respite(sim, b, covering) {
        if !covering {
            let ai = &mut sim.bots[b].ai;
            ai.mode = Mode::Cover;
            ai.tactics.cover_t = 0.0;
        }
        if sim.bots[b].ai.tactics.cover_t < MAX_COVER {
            let spot = cover_spot(sim, b, pos, threat);
            sim.bots[b].ai.target = spot;
            return;
        }
        let time = sim.time;
        sim.bots[b].ai.tactics.cover_ban = time + COVER_REST;
    }

    // Capture de zones : une zone à prendre passe avant la poursuite (la patrouille l'y mène)
    if let Some(z) = objective
        && (z.owner != Some(sim.bots[b].team) || z.contested)
    {
        let ai = &mut sim.bots[b].ai;
        if ai.mode != Mode::Patrol {
            ai.mode = Mode::Patrol;
            ai.timer = 0.0;
        }
        return;
    }

    let Some(mut range) = preferred_range(sim, b, foe) else {
        // Aucune de ses armes ne porte sur lui : il continue sa patrouille
        let ai = &mut sim.bots[b].ai;
        if ai.mode != Mode::Patrol {
            ai.mode = Mode::Patrol;
            ai.timer = 0.0;
        }
        return;
    };
    if sim.bots[b].charges && range <= RAM_RANGE {
        // Une toupie ne charge qu'à plein régime : avant, il tourne autour de sa cible, à distance
        if melee_primed(sim, b) {
            // (une foreuse vise le cockpit de sa cible : `chargePoint`)
            let target = clamp_to_roam(sim, charge_point(sim, b, foe).unwrap_or(threat));
            let ai = &mut sim.bots[b].ai;
            ai.mode = Mode::Charge;
            ai.mode_t = PLAN_PERIOD * 2.0;
            ai.target = target;
            return;
        }
        range = jsmath::max(range, STANDOFF);
    }
    if sim.bots[b].ai.mode != Mode::Engage {
        // Nouvel engagement : il tourne du côté où il penche déjà
        let side = orbit_side(sim, b, pos, threat);
        let ai = &mut sim.bots[b].ai;
        ai.mode = Mode::Engage;
        ai.tactics.orbit = side;
    }
    let target = engage_point(sim, b, pos, threat, range);
    sim.bots[b].ai.target = target;
}

/// Adversaire (`chooseFoe`) : celui que visent le plus de ses tourelles ; sinon celui qu'il
/// combattait déjà, s'il le voit encore ; sinon l'ennemi repéré le plus proche contre lequel une de
/// ses armes porte ; à défaut, le dernier, encore FOE_MEMORY s. Pas un avion.
fn choose_foe(sim: &mut Sim, b: usize) -> Option<usize> {
    let turrets = live_turrets(sim, b);
    // (une `Map` : les cibles dans l'ordre où ses tourelles les visent)
    let mut aimed_at: Vec<(usize, u32)> = Vec::new();
    for &t in &turrets {
        let Some(target) = sim.bots[b].turrets[t].target else { continue };
        if sim.bots[target].cockpit_alive() && sim.bots[target].mobility != Mobility::Plane && are_enemies(sim, b, target) {
            match aimed_at.iter_mut().find(|e| e.0 == target) {
                Some(e) => e.1 += 1,
                None => aimed_at.push((target, 1)),
            }
        }
    }
    if !aimed_at.is_empty() {
        sim.bots[b].ai.tactics.seen_at = sim.time;
        // (`reduce((a, b) => (b[1] > a[1] ? b : a))` : la première des plus visées)
        let mut best = aimed_at[0];
        for &e in &aimed_at[1..] {
            if e.1 > best.1 {
                best = e;
            }
        }
        return Some(best.0);
    }
    // (un champ défend sa coque : il ne mène pas au contact)
    let melee = !offensive_melee(sim, b).is_empty();
    let fair = |sim: &Sim, other: usize| -> bool {
        let o = &sim.bots[other];
        o.cockpit_alive()
            && o.mobility != Mobility::Plane
            && are_enemies(sim, b, other)
            && (turrets.iter().any(|&t| suits(sim, weapon(sim, b, t), other)) || (melee && melee_suits(sim, other)))
    };
    let team = sim.bots[b].team;
    let last = sim.bots[b].ai.tactics.foe;
    if let Some(last) = last
        && fair(sim, last)
        && is_detected(sim, team, last)
        && distance(sim.bots[last].last_pos, sim.bots[b].last_pos) < FOE_SEARCH
    {
        sim.bots[b].ai.tactics.seen_at = sim.time;
        return Some(last);
    }
    let mut best = None;
    let mut best_dist = FOE_SEARCH;
    for other in sim.roster.clone() {
        if !fair(sim, other) || !is_detected(sim, team, other) {
            continue;
        }
        let d = distance(sim.bots[other].last_pos, sim.bots[b].last_pos);
        if d < best_dist {
            best_dist = d;
            best = Some(other);
        }
    }
    if best.is_some() {
        sim.bots[b].ai.tactics.seen_at = sim.time;
        return best;
    }
    match last {
        Some(last) if fair(sim, last) && sim.time - sim.bots[b].ai.tactics.seen_at < FOE_MEMORY => Some(last),
        _ => None,
    }
}

/// Allié à aller soigner, s'il porte un rayon réparateur (`supportTarget`) : le plus abîmé, préféré
/// proche ; pas un avion. Les nanites, qui poursuivent leur patient de loin, n'y obligent pas.
fn support_target(sim: &Sim, b: usize) -> Option<usize> {
    let beam = live_turrets(sim, b).into_iter().any(|t| {
        let p = &weapon(sim, b, t).projectile;
        p.repair.is_some() && p.guidance.is_none()
    });
    if !beam {
        return None;
    }
    let mut best = None;
    let mut best_score = 0.0;
    for other in sim.roster.clone() {
        let o = &sim.bots[other];
        if other == b || !o.cockpit_alive() || are_enemies(sim, b, other) || o.mobility == Mobility::Plane {
            continue;
        }
        let d = distance(o.last_pos, sim.bots[b].last_pos);
        let need = repair_need(sim, other);
        if d > SUPPORT_SEARCH || need < SUPPORT_NEED {
            continue;
        }
        let score = need / (1.0 + d / 30.0);
        if score > best_score {
            best_score = score;
            best = Some(other);
        }
    }
    best
}

/// Distance à laquelle il combat cet adversaire (`preferredRange`) : la moyenne des portées
/// préférées de ses armes qui portent sur lui, sans dépasser la portée de la plus courte ; rien :
/// aucune arme ne porte.
fn preferred_range(sim: &Sim, b: usize, foe: usize) -> Option<f64> {
    let mut sum = 0.0;
    let mut count = 0;
    let mut shortest = f64::INFINITY;
    for t in live_turrets(sim, b) {
        let w = weapon(sim, b, t);
        let Some(engage) = w.engage else { continue };
        if !suits(sim, w, foe) {
            continue;
        }
        sum += engage;
        count += 1;
        shortest = jsmath::min(shortest, w.range);
    }
    // Ses armes de contact : au contact (la portée de la plus courte de ses armes, aussi)
    if melee_suits(sim, foe) {
        for a in offensive_melee(sim, b) {
            let engage = sim.bots[b].melee[a].spec().engage;
            sum += engage;
            count += 1;
            shortest = jsmath::min(shortest, engage / RANGE_MARGIN);
        }
    }
    if count == 0 { None } else { Some(jsmath::min(sum / count as f64, shortest * RANGE_MARGIN)) }
}

/// Besoin d'un répit (`needsRespite`) : toutes ses armes à chargeur vides (une arme électrique sans
/// assez d'énergie compte comme un chargeur vide), ou ses modules de réparation ont de quoi faire. À
/// couvert, il y reste tant que ses chargeurs ne sont pas à moitié pleins ou que les réparations ne
/// sont pas presque finies.
fn needs_respite(sim: &Sim, b: usize, covering: bool) -> bool {
    let offensive: Vec<usize> = live_turrets(sim, b).into_iter().filter(|&t| weapon(sim, b, t).engage.is_some()).collect();
    if !offensive.is_empty() {
        let energy = sim.bots[b].energy;
        let drained = |t: usize, shots: f64| -> bool {
            let power = weapon(sim, b, t).power;
            power != 0.0 && energy < power * shots
        };
        let reloading = if covering {
            offensive.iter().all(|&t| {
                let ammo = sim.bots[b].turrets[t].arm.ammo;
                weapon(sim, b, t).ammo.is_some_and(|(capacity, _)| ammo < (capacity / 2.0).ceil()) || drained(t, 2.0)
            })
        } else {
            offensive.iter().all(|&t| weapon(sim, b, t).ammo.is_some() && sim.bots[b].turrets[t].arm.ammo < 1.0 || drained(t, 1.0))
        };
        if reloading {
            return true;
        }
    }
    let work = repair_work(sim, b);
    if covering { work > REPAIR_DONE } else { work > REPAIR_WORTH }
}

/// Points de structure qui manquent aux blocs à portée de ses modules de réparation (`repairWork`).
fn repair_work(sim: &Sim, b: usize) -> f64 {
    let bot = &sim.bots[b];
    if !bot.cockpit_alive() {
        return 0.0;
    }
    let c = catalog();
    let mut work = 0.0;
    for &module in &sim.part(bot.cockpit_part()).blocks {
        let Some(spec) = c.blocks[&bot.blocks[module].kind].repair else { continue };
        let center = block_world_pos(sim, b, module);
        for &k in &bot.live {
            let missing = c.blocks[&bot.blocks[k].kind].hp - bot.blocks[k].hp;
            if missing > 0.0 && distance(block_world_pos(sim, b, k), center) <= spec.radius {
                work += missing;
            }
        }
    }
    work
}

/// Abri contre une menace en `threat` (`coverSpot`) : derrière le pilier, le muret ou le conteneur le
/// plus proche, du côté opposé à la menace ; sans abri à portée, un point plus loin d'elle.
pub fn cover_spot(sim: &Sim, b: usize, pos: V3, threat: V3) -> V3 {
    let mut best = None;
    let mut best_dist = COVER_SEARCH;
    let roam = sim.bounds.roam;
    let radius = sim.bots[b].radius;
    for o in obstacles(sim).iter() {
        if !o.shelter {
            continue;
        }
        // Là où les niveaux se superposent, un abri à sa hauteur (pas au fond du canyon qu'il surplombe) ;
        // un robot volant, à celle du sol sous lui, où il va se poser
        if sim.arena.graph.is_some() && !at_level(o, if sim.bots[b].mobility == Mobility::Ground { pos.y } else { ground_level(sim, pos.x, pos.z) + 1.0 }) {
            continue;
        }
        let r = o.rect;
        let cx = (r.min_x + r.max_x) / 2.0;
        let cz = (r.min_z + r.max_z) / 2.0;
        let hx = (r.max_x - r.min_x) / 2.0;
        let hz = (r.max_z - r.min_z) / 2.0;
        let away = v3(cx - threat.x, 0.0, cz - threat.z);
        let gap = len(away);
        if gap < 1.0 {
            continue;
        }
        // Distance du centre à la face de sortie, dans la direction opposée à la menace
        let ex = if away.x.abs() > 1e-6 { hx / (away.x / gap).abs() } else { f64::INFINITY };
        let ez = if away.z.abs() > 1e-6 { hz / (away.z / gap).abs() } else { f64::INFINITY };
        let exit = jsmath::min(ex, ez);
        let spot = add(v3(cx, 0.0, cz), scale(away, (exit + radius + COVER_GAP) / gap));
        let d = flat_distance(spot, pos);
        if d < best_dist && spot.x.abs() <= roam && spot.z.abs() <= roam {
            best_dist = d;
            best = Some(spot);
        }
    }
    if let Some(spot) = best {
        return spot;
    }
    let away = v3(pos.x - threat.x, 0.0, pos.z - threat.z);
    let l = len(away);
    clamp_to_roam(sim, add(pos, scale(away, RETREAT_DISTANCE / if l == 0.0 || l.is_nan() { 1.0 } else { l })))
}

/// Sens de rotation autour de la menace le plus proche de son cap actuel (`orbitSide`).
fn orbit_side(sim: &Sim, b: usize, pos: V3, threat: V3) -> f64 {
    let heading = qrot(sim.phys.rotation(sim.part(sim.bots[b].cockpit_part()).rb), v3(0.0, 0.0, 1.0));
    let turn = (pos.z - threat.z) * heading.x - (pos.x - threat.x) * heading.z;
    if turn >= 0.0 { 1.0 } else { -1.0 }
}

/// Point vers lequel rouler pour combattre à la distance `range` d'une menace en `threat`, LEAD m
/// devant lui (`engagePoint`) : il tourne autour d'elle dans le sens de `orbit`, en s'en rapprochant
/// s'il est trop loin, en s'en écartant s'il est trop près ; contre un mur, il le longe ; acculé dans
/// un coin, il repart dans l'autre sens.
fn engage_point(sim: &mut Sim, b: usize, pos: V3, threat: V3, range: f64) -> V3 {
    let off = v3(pos.x - threat.x, 0.0, pos.z - threat.z);
    let l = len(off);
    let d = if l == 0.0 || l.is_nan() { 1.0 } else { l };
    let u = scale(off, 1.0 / d);
    let ahead = |sign: f64| -> V3 {
        let tangent = v3(-u.z * sign, 0.0, u.x * sign);
        let radial = clamp((range - d) / RANGE_SOFT, -3.0, 1.5);
        add(pos, scale(norm(add(tangent, scale(u, radial))), LEAD))
    };
    let orbit = sim.bots[b].ai.tactics.orbit;
    let mut p = clamp_to_roam(sim, ahead(orbit));
    if flat_distance(p, pos) < LEAD / 3.0 {
        let orbit = -orbit;
        sim.bots[b].ai.tactics.orbit = orbit;
        p = clamp_to_roam(sim, ahead(orbit));
    }
    p
}
