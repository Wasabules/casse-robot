//! Les frappes à mécanique (src/shared/combat/mechanics.ts) : le flipper, le fléau et la mâchoire
//! broyeuse, trois mouvements de plus de l'étape « contact » (melee.rs, `updateMelee`). Comme les
//! autres armes de contact, ils mesurent tout avant d'infliger : leurs coups passent par les coups
//! planifiés (`PlannedHit`), infligés après que toutes les armes ont joué.
//!
//! - Flipper (`flip`) : le vérin relève le plateau ; le premier robot (ou accessoire mobile) qu'il
//!   rencontre au-dessus de lui est soulevé (`launch` : l'impulsion d'après la masse réduite, le sol qui
//!   retient le robot qui soulève, la vitesse du plateau), et marqué projeté (`Bot::thrown_by` : sa
//!   chute est créditée au flipper, collisions.rs).
//! - Fléau (`flail`) : la manivelle que mène le moteur, la boule au bout de sa chaîne (pesanteur, air,
//!   rebonds sur le décor par les rayons de Rapier, sur les robots dans leur grille), la chaîne qui la
//!   retient et tire le robot, qui s'enroule autour du moyeu ou d'un obstacle dressé (`updateWrap`).
//! - Mâchoire (`grip`) : elle se ferme, saisit le premier bloc ennemi dans sa gueule (`inMouth`), et
//!   le tient par des impulsions à chaque pas (`holdGrip` : une contrainte de point et une part de la
//!   rotation relative amortie, dans la limite de ce qu'elle tient), en l'écrasant par tranches.

use super::arena::ground_level;
use super::catalog::{FlailSpec, JawSpec, MeleeSpec, PlateSpec, catalog};
use super::damage::Target;
use super::drive::{FLIPPED_UP_Y, supply};
use super::emp::organ_stunned;
use super::linalg::solve_linear;
use super::melee::{
    Contact, Gyros, MOTOR_EFFICIENCY, MeleeFrame, Phase, PlannedHit, Plans, Surface, WHEEL_REACH, add_gyro, distance, effective_mass, melee_frame,
};
use super::props::{prop, prop_nearest, present};
use super::supports::grounded_supports;
use super::vec::{Q, V3, add, clamp, cross, dot, len, norm, qrot, qrot_inv, scale, sub, v3};
use super::world::{Owner, STEP, Sim};
use crate::det::{dcos, dpow, dsin};
use crate::jsmath;
use rapier3d::prelude::{ColliderHandle, RigidBodyHandle};
use std::f64::consts::PI;

/// Pas (rad) de la recherche du premier contact du plateau le long de sa levée.
const ARC_STEP: f64 = 0.06;
/// Rayon (m) des points qui sondent le plateau.
const PLATE_PROBE: f64 = 0.14;
/// Points du plateau qui sondent, en part de sa longueur et de sa demi-largeur.
const PLATE_ALONG: [f64; 4] = [0.3, 0.55, 0.8, 1.0];
const PLATE_ACROSS: [f64; 3] = [-0.85, 0.0, 0.85];
/// Le plateau ne lance pas plus vite que cette part de sa vitesse au point touché (au moins à PLATE_CARRY de sa longueur).
const PLATE_SPEED_SHARE: f64 = 1.2;
const PLATE_CARRY: f64 = 0.75;
/// Une cible soulevée reste « projetée » ce temps (s).
const THROWN_FOR: f64 = 3.0;
/// Un flipper posé ne s'enfonce pas plus vite que cela (m/s, au pivot) sous la réaction.
const REACTION_MAX: f64 = 2.5;
/// Les appuis au sol à moins de cela (m) du plus en avant forment la rangée autour de laquelle bascule un flipper.
const FRONT_ROW: f64 = 0.3;
/// Pesanteur (m/s²).
const GRAVITY: f64 = 9.81;
/// La manivelle d'un fléau passe de l'arrêt au plein régime (et inversement) en ce temps (s).
const CRANK_RAMP: f64 = 0.4;
/// Enroulement de la chaîne autour du moyeu.
const WIND_RATE: f64 = 0.5;
const WIND_LAG: f64 = 0.3;
const UNWIND_RATE: f64 = 0.4;
/// Une chaîne enroulée se déroule d'elle-même au bout de ce temps (s), ou si le robot tire plus fort que cela (N).
const WRAP_MAX: f64 = 4.0;
const WRAP_PULL: f64 = 4000.0;
/// Une chaîne ne s'enroule que sur une face assez dressée.
const WRAP_UPRIGHT: f64 = 0.6;
/// Ce qui reste de chaîne au-delà du point d'appui, au moins (m), pour qu'elle s'enroule.
const WRAP_MIN_FREE: f64 = 0.3;
/// Le décor se sonde au plus avec cette restitution.
const SCENERY_RESTITUTION: f64 = 0.35;
/// Posée, la boule roule : ce frottement-là est faible.
const ROLLING: f64 = 0.05;
/// Part de la rotation relative des deux robots qu'une prise de mâchoire amortit à chaque pas.
const GRIP_SPIN: f64 = 0.6;
/// Bras de levier (m) du couple que tient une prise, au plus.
const GRIP_ARM: f64 = 0.35;
/// Correction de l'écart entre les deux points d'une prise, par pas (part de l'écart).
const GRIP_BIAS: f64 = 0.25;
/// Le bloc saisi détruit, la mâchoire mord le bloc de la proie le plus proche de la prise, à moins de cela (m).
const REBITE: f64 = 0.8;
/// L'écrasement s'inflige par tranches de ce temps (s).
const CRUSH_TICK: f64 = 0.25;
/// Énergie (J) annoncée avec une tranche d'écrasement.
const CRUSH_ENERGY: f64 = 350.0;
const UP: V3 = v3(0.0, 1.0, 0.0);

/// La chaîne d'un fléau enroulée autour d'un obstacle (`FlailBall.wrap`) : le point d'appui, la
/// longueur de chaîne jusqu'à lui, l'axe autour duquel elle tourne, depuis quand.
#[derive(Clone, Copy, Debug)]
pub struct Wrap {
    pub point: V3,
    pub length: f64,
    pub axis: V3,
    pub since: f64,
}

/// La boule d'un fléau (`FlailBall`) : sa position et sa vitesse, sa chaîne enroulée autour d'un
/// obstacle, ce qui s'en est enroulé autour du moyeu (m).
#[derive(Clone, Copy, Debug)]
pub struct FlailBall {
    pub pos: V3,
    pub vel: V3,
    pub wrap: Option<Wrap>,
    pub wound: f64,
}

/// La prise d'une mâchoire (`JawGrip`) : le bloc saisi (robot, bloc), le point de la prise dans le
/// repère du robot saisi et dans celui de la mâchoire, depuis quand, le glissement, l'écrasement
/// accumulé.
#[derive(Clone, Copy, Debug)]
pub struct JawGrip {
    pub bot: usize,
    pub block: usize,
    pub local: V3,
    pub own: V3,
    pub since: f64,
    pub slip: f64,
    pub crush: f64,
}

/// Vitesse d'un point d'un corps (`velocityAt`, monde).
fn velocity_at(sim: &Sim, rb: RigidBodyHandle, p: V3) -> V3 {
    let v = sim.phys.linvel(rb);
    let w = sim.phys.angvel(rb);
    add(v, cross(w, sub(p, sim.phys.world_com(rb))))
}

/// Les morceaux des robots ennemis de `b` dont le centre est à moins de `reach` m de `at`
/// (`enemyParts`) : robot, morceau, pose.
fn enemy_parts(sim: &Sim, b: usize, at: V3, reach: f64) -> Vec<(usize, usize, V3, Q)> {
    let team = sim.bots[b].team;
    let mut near = Vec::new();
    for (o, other) in sim.roster.iter().map(|&o| (o, &sim.bots[o])) {
        if o == b || other.team == team || other.live.is_empty() || !other.cockpit_alive() {
            continue;
        }
        for &p in &other.parts {
            let rb = sim.part(p).rb;
            let t = sim.phys.translation(rb);
            if distance(t, at) < reach + other.radius + other.top {
                near.push((o, p, t, sim.phys.rotation(rb)));
            }
        }
    }
    near
}

/// Point d'un bloc (sa case) le plus proche de `local`, dans le repère de son morceau (`nearestOnBlock`).
fn nearest_on_block(block: V3, local: V3) -> V3 {
    let h = catalog().constants.block_size / 2.0;
    v3(clamp(local.x, block.x - h, block.x + h), clamp(local.y, block.y - h, block.y + h), clamp(local.z, block.z - h, block.z + h))
}

/// Ce qui touche une boule de rayon `r` en `p` sur un morceau (`probePart`) : le bloc le plus proche
/// dans sa grille, ou une de ses roues ; la cible, le point le plus proche (monde), la distance.
fn probe_part(sim: &Sim, o: usize, part: usize, t: V3, q: Q, p: V3, r: f64) -> Option<(Target, V3, f64)> {
    let bs = catalog().constants.block_size;
    let bot = &sim.bots[o];
    let local = qrot_inv(q, sub(p, t));
    let cx = jsmath::round(local.x / bs) as i64;
    let cy = jsmath::round(local.y / bs) as i64;
    let cz = jsmath::round(local.z / bs) as i64;
    let mut best: Option<(Target, V3, f64)> = None;
    for dx in -1..=1 {
        for dy in -1..=1 {
            for dz in -1..=1 {
                let Some(&k) = bot.cells.get(&(cx + dx, cy + dy, cz + dz)) else { continue };
                if bot.blocks[k].part != part {
                    continue;
                }
                let near = nearest_on_block(bot.blocks[k].local, local);
                let d = len(sub(local, near));
                if d < r && best.is_none_or(|bt| d < bt.2) {
                    best = Some((Target::Block(o, k), add(t, qrot(q, near)), d));
                }
            }
        }
    }
    for (w, wheel) in bot.wheels.iter().enumerate() {
        if wheel.part != Some(part) {
            continue;
        }
        let c = wheel.rb.pos;
        let rw = wheel.def.radius * WHEEL_REACH;
        let d = distance(c, p) - rw;
        if d < r && best.is_none_or(|bt| d < bt.2) {
            let out = norm(sub(p, c));
            best = Some((Target::Wheel(o, w), add(c, scale(out, rw)), d));
        }
    }
    best
}

/// Appui au sol d'un robot posé le plus près du pivot d'une arme (`frontContact`) : la moyenne des
/// points de contact de ses roues qui portent (ou de ses appuis au sol) les plus en avant.
fn front_contact(sim: &Sim, b: usize, hub: V3, forward: V3) -> Option<V3> {
    let bot = &sim.bots[b];
    if !bot.cockpit_alive() {
        return None;
    }
    let ck = bot.cockpit_part();
    let mut contacts: Vec<V3> = Vec::new();
    for w in &bot.wheels {
        if w.part != Some(ck) || w.load <= 0.0 {
            continue;
        }
        let c = w.rb.pos;
        contacts.push(v3(c.x, c.y - w.def.radius, c.z));
    }
    let rb = sim.part(ck).rb;
    for s in grounded_supports(sim, b) {
        let support = &bot.supports[s];
        let c = add(sim.phys.translation(rb), qrot(sim.phys.rotation(rb), bot.blocks[support.block].local));
        contacts.push(v3(c.x, c.y - support.contact, c.z));
    }
    if contacts.is_empty() {
        return None;
    }
    let along = |p: V3| dot(sub(p, hub), forward);
    let front = contacts.iter().fold(f64::NEG_INFINITY, |m, &p| jsmath::max(m, along(p)));
    let row: Vec<V3> = contacts.into_iter().filter(|&p| along(p) > front - FRONT_ROW).collect();
    let n = row.len() as f64;
    Some(scale(row.into_iter().fold(v3(0.0, 0.0, 0.0), add), 1.0 / n))
}

/// La mâchoire, le flipper : alimentés (`poweredArm`) ?
fn powered_arm(sim: &Sim, b: usize, block: usize) -> bool {
    let bot = &sim.bots[b];
    bot.cockpit_alive() && bot.blocks[block].alive && bot.blocks[block].part == bot.cockpit_part() && !organ_stunned(sim, b, block)
}

/// Robot renversé, ou que son gyroscope redresse (`capsized`).
fn capsized(sim: &Sim, b: usize) -> bool {
    let bot = &sim.bots[b];
    bot.righting > 0.0 || qrot(sim.phys.rotation(sim.part(bot.cockpit_part()).rb), UP).y < FLIPPED_UP_Y
}

// --- Flipper ---

/// Point du plateau à l'angle `angle` (`platePoint`).
fn plate_point(f: &MeleeFrame, plate: &PlateSpec, angle: f64, along: f64, across: f64) -> V3 {
    let dir = add(scale(f.e1, dcos(angle)), scale(f.e2, -dsin(angle)));
    add(f.hub, add(scale(dir, plate.length * along), scale(f.axis, plate.half * across)))
}

/// Sens où va le plateau à l'angle `angle` (`plateMotion` : il monte).
fn plate_motion(f: &MeleeFrame, angle: f64) -> V3 {
    norm(add(scale(f.e1, -dsin(angle)), scale(f.e2, -dcos(angle))))
}

/// Premier contact du plateau en montant de `from` à `to` (`plateContact`) : un bloc ou une roue d'un
/// robot ennemi au-dessus de lui (et, sauf `robots_only`, un accessoire mobile).
#[allow(clippy::too_many_arguments)]
fn plate_contact(sim: &Sim, b: usize, f: &MeleeFrame, plate: &PlateSpec, from: f64, to: f64, robots_only: bool, step: f64) -> Option<(Contact, f64)> {
    let near = enemy_parts(sim, b, f.hub, plate.length + 1.0);
    let props: Vec<usize> = if robots_only {
        Vec::new()
    } else {
        present(sim)
            .into_iter()
            .filter(|&i| {
                let p = prop(sim, i);
                !p.fixed && p.hp > 0.0 && distance(sim.phys.translation(p.rb), f.hub) < plate.length + 2.0
            })
            .collect()
    };
    if near.is_empty() && props.is_empty() {
        return None;
    }
    let steps = jsmath::max(1.0, ((to - from).abs() / step).ceil());
    let mut i = 1.0;
    while i <= steps {
        let angle = from + ((to - from) * i) / steps;
        let mut best: Option<Contact> = None;
        let mut nearest = f64::INFINITY;
        for along in PLATE_ALONG {
            for across in PLATE_ACROSS {
                let p = plate_point(f, plate, angle, along, across);
                for &(o, part, t, q) in &near {
                    if let Some((target, point, d)) = probe_part(sim, o, part, t, q, p, PLATE_PROBE)
                        && d < nearest
                    {
                        nearest = d;
                        best = Some(Contact::robot(target, sim.part(part).rb, point, along * plate.length));
                    }
                }
                for &pi in &props {
                    let c = prop_nearest(sim, pi, p);
                    let d = distance(c, p);
                    if d < PLATE_PROBE && d < nearest {
                        nearest = d;
                        best = Some(Contact {
                            surface: Surface::Prop,
                            target: Some(Target::Prop(pi)),
                            body: Some(prop(sim, pi).rb),
                            point: c,
                            radial: along * plate.length,
                            normal: None,
                            face: None,
                            floor: false,
                        });
                    }
                }
            }
        }
        if let Some(c) = best {
            return Some((c, angle));
        }
        i += 1.0;
    }
    None
}

/// Un plateau de flipper (`stepFlip`) : armé, levée (premier contact au-dessus de lui), redescente et
/// recharge du vérin.
pub fn step_flip(sim: &mut Sim, b: usize, a: usize, plans: &mut Plans) {
    let spec = sim.bots[b].melee[a].spec();
    let plate = spec.plate.expect("flipper sans plateau");
    sim.bots[b].melee[a].phase_t += STEP;
    let arc = plate.end - plate.rest;
    let arm = sim.bots[b].melee[a];
    match arm.phase {
        Phase::Ready | Phase::Hold => {
            let m = &mut sim.bots[b].melee[a];
            m.phase = Phase::Ready;
            m.swing = plate.rest;
            m.spin = 0.0;
            // Le vérin se vide d'un coup : il faut de quoi le recharger
            if arm.trigger && powered_arm(sim, b, arm.block) && sim.bots[b].energy >= plate.cost {
                sim.bots[b].energy -= plate.cost;
                let m = &mut sim.bots[b].melee[a];
                m.phase = Phase::Strike;
                m.phase_t = 0.0;
            }
        }
        Phase::Strike => {
            let t = jsmath::min(1.0, arm.phase_t / plate.strike);
            let prev = arm.swing;
            let next = plate.rest + arc * t * t;
            sim.bots[b].melee[a].spin = (2.0 * arc * t) / plate.strike;
            // Une seule cible par levée : la première que le plateau rencontre
            let struck = arm.hit_at >= sim.time - arm.phase_t - 1e-9;
            if !struck {
                let frame = melee_frame(sim, b, &arm);
                if let Some((contact, angle)) = plate_contact(sim, b, &frame, &plate, prev, next, false, ARC_STEP) {
                    launch(sim, b, a, spec, &frame, contact, angle, plans);
                }
            }
            let m = &mut sim.bots[b].melee[a];
            m.swing = next;
            if t >= 1.0 {
                m.phase = Phase::Recover;
                m.phase_t = 0.0;
                m.from = m.swing;
            }
        }
        Phase::Recover => {
            // Il redescend, puis le vérin se recharge
            let t = jsmath::min(1.0, arm.phase_t / plate.lower);
            let m = &mut sim.bots[b].melee[a];
            m.spin = 0.0;
            m.swing = m.from + (plate.rest - m.from) * t * t * (3.0 - 2.0 * t);
            if m.phase_t >= plate.reload {
                m.phase = Phase::Ready;
                m.phase_t = 0.0;
                m.swing = plate.rest;
            }
        }
    }
}

/// Matrice d'inertie inverse (monde) d'un corps (`invInertia`).
fn inv_inertia(sim: &Sim, rb: RigidBodyHandle) -> [[f64; 3]; 3] {
    let m = sim.phys.effective_world_inv_inertia(rb);
    [[m[0], m[1], m[2]], [m[1], m[3], m[4]], [m[2], m[4], m[5]]]
}

fn mul_mv(m: &[[f64; 3]; 3], v: V3) -> V3 {
    v3(m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z, m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z, m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z)
}

/// Le plateau soulève ce qu'il touche (`launch`) : l'impulsion (masse réduite, appui du sol, vitesse du
/// plateau), la réaction au pivot.
#[allow(clippy::too_many_arguments)]
fn launch(sim: &mut Sim, b: usize, a: usize, spec: &'static MeleeSpec, f: &MeleeFrame, contact: Contact, angle: f64, plans: &mut Plans) {
    let plate = spec.plate.expect("flipper sans plateau");
    let arc = plate.end - plate.rest;
    let energy = plate.energy * clamp((plate.end - angle) / arc, 0.0, 1.0);
    let p = &spec.hit.push;
    let dir = norm(add(scale(plate_motion(f, angle), p.tangent), v3(0.0, p.lift, 0.0)));
    let arm = sim.bots[b].melee[a];
    let part = sim.bots[b].blocks[arm.block].part;
    let rb = sim.part(part).rb;
    // Le robot qui soulève, au pivot : sa masse effective, et s'il est posé, son appui au sol le plus
    // en avant (il bascule autour de lui)
    let pivot = front_contact(sim, b, f.hub, f.e1);
    let com = sim.phys.world_com(rb);
    let inv = inv_inertia(sim, rb);
    let inv_mass = sim.phys.inv_mass(rb);
    let rh = sub(f.hub, com);
    // Vitesse le long de `n` du point `rx` pour une impulsion unité le long de `m` au point `ry`
    let k = |rx: V3, n: V3, ry: V3, m: V3| -> f64 { dot(n, add(scale(m, inv_mass), cross(mul_mv(&inv, cross(ry, m)), rx))) };
    let khh = k(rh, dir, rh, dir);
    let mut braced = khh;
    let mut ground: Option<(V3, f64, f64)> = None;
    if let Some(pivot) = pivot {
        let rc = sub(pivot, com);
        let kcc = k(rc, UP, rc, UP);
        let kch = k(rc, UP, rh, dir);
        // Une impulsion vers le bas au pivot n'appuie sur le sol que si elle y enfonce l'appui
        if kcc > 1e-9 && kch > 0.0 {
            braced = khh - (kch * kch) / kcc;
            ground = Some((pivot, kcc, kch));
        }
    }
    let mine = 1.0 / jsmath::max(braced, 1e-6);
    let theirs = contact.body.map_or(f64::INFINITY, |body| effective_mass(sim, body, contact.point, dir));
    let reduced = if theirs.is_finite() { 1.0 / (1.0 / mine + 1.0 / theirs) } else { mine };
    let mut impulse = (2.0 * reduced * energy * spec.hit.fling).sqrt();
    // Pas plus vite que le plateau ne va en fin de levée, là où elle porte
    let plate_speed = ((2.0 * arc) / plate.strike) * jsmath::max(contact.radial, PLATE_CARRY * plate.length);
    if theirs.is_finite() {
        impulse = jsmath::min(impulse, theirs * plate_speed * PLATE_SPEED_SHARE);
    }
    sim.bots[b].melee[a].hit_at = sim.time;
    let victim = match contact.target {
        Some(Target::Block(v, _)) | Some(Target::Wheel(v, _)) => Some(v),
        _ => None,
    };
    if let Some(v) = victim {
        sim.bots[v].thrown_by = Some((b, arm.weapon, sim.time + THROWN_FOR));
    }
    // La réaction au pivot ; posé, il ne s'y enfonce pas plus vite que REACTION_MAX, et son appui au sol
    // le retient : il bascule autour de lui, l'arrière se lève
    let mut reaction = impulse * spec.hit.recoil;
    if let Some((at, along, cross_k)) = ground {
        reaction = jsmath::min(reaction, REACTION_MAX / braced);
        sim.phys.apply_impulse_at_point(rb, scale(UP, (cross_k * reaction) / along), at, true);
    }
    let mut hit = PlannedHit::new(b, a, contact, energy, 1.0, dir, None, f.hub, part);
    hit.impulse = Some(impulse);
    hit.reaction = Some(reaction);
    plans.hits.push(hit);
}

/// Une levée de ce flipper soulèverait-elle un robot ennemi, là où il est (`flipWouldHit`) ?
pub fn flip_would_hit(sim: &Sim, b: usize, a: usize) -> bool {
    let arm = sim.bots[b].melee[a];
    let Some(plate) = arm.spec().plate else { return false };
    if !sim.bots[b].blocks[arm.block].alive {
        return false;
    }
    // Il faut qu'il reste assez de course pour soulever (la moitié de la levée)
    plate_contact(sim, b, &melee_frame(sim, b, &arm), &plate, plate.rest, (plate.rest + plate.end) / 2.0, true, ARC_STEP * 2.0).is_some()
}

// --- Fléau ---

/// Énergie d'un fléau à plein régime (`flailEnergy`, J).
fn flail_energy(fl: &FlailSpec) -> f64 {
    let r = fl.crank + fl.chain;
    0.5 * fl.mass * dpow(fl.speed * r, 2.0) + 0.5 * fl.inertia * dpow(fl.speed, 2.0)
}

/// Puissance du moteur d'un fléau (`flailPower`, kW).
fn flail_power(fl: &FlailSpec) -> f64 {
    flail_energy(fl) / fl.spin_up / MOTOR_EFFICIENCY / 1000.0
}

/// Bout de la manivelle d'un fléau à l'angle `angle` (`crankTip`, monde).
fn crank_tip(f: &MeleeFrame, fl: &FlailSpec, angle: f64) -> V3 {
    add(f.hub, scale(add(scale(f.e1, dcos(angle)), scale(f.e2, dsin(angle))), fl.crank))
}

/// Filtre des rayons de la boule et de sa chaîne (`fixedOnly`) : ce qui est fixe (décor, sol,
/// accessoires ancrés).
fn fixed_only(sim: &Sim, h: ColliderHandle) -> bool {
    match sim.owners.get(&h) {
        None => true,
        Some(Owner::Prop(i)) => sim.props[*i].as_ref().is_some_and(|p| p.fixed),
        Some(_) => false,
    }
}

/// Rebond sur une surface de normale `n` (`bounce`) : restitution, et frottement de Coulomb.
fn bounce(v: V3, n: V3, into: f64, restitution: f64, friction: f64) -> V3 {
    let tangent = add(v, scale(n, -dot(v, n)));
    let slide = len(tangent);
    let kept = if slide > 1e-9 { jsmath::max(0.0, 1.0 - (friction * into * (1.0 + restitution)) / slide) } else { 0.0 };
    add(scale(tangent, kept), scale(n, into * restitution))
}

/// Un fléau (`stepFlail`) : manivelle (moteur ou frein), boule (pesanteur, rebonds, coups), chaîne
/// (tension, enroulement).
pub fn step_flail(sim: &mut Sim, b: usize, a: usize, gyros: &mut Gyros, plans: &mut Plans) {
    let arm = sim.bots[b].melee[a];
    let spec = arm.spec();
    let fl = spec.flail.expect("fléau sans boule");
    let part = sim.bots[b].blocks[arm.block].part;
    let rb = sim.part(part).rb;
    let f = melee_frame(sim, b, &arm);
    let mut ball = match arm.ball {
        Some(ball) => ball,
        None => {
            // Elle part couchée au bout de sa chaîne, à hauteur du moyeu, devant lui
            let tip = crank_tip(&f, &fl, arm.angle);
            let at = add(tip, scale(f.e1, fl.chain * 0.9));
            FlailBall { pos: at, vel: velocity_at(sim, rb, at), wrap: None, wound: 0.0 }
        }
    };
    sim.bots[b].melee[a].ball = Some(ball);
    // Renversé (ou en train de se redresser), le moteur se coupe
    let powered = arm.wanted && powered_arm(sim, b, arm.block) && !capsized(sim, b);

    // La manivelle : son motoréducteur la mène à son régime en CRANK_RAMP s ; enroulée autour d'un
    // obstacle, la chaîne la bloque
    let power = flail_power(&fl);
    let share = if powered { supply(&sim.bots[b], power) } else { 0.0 };
    let goal = if ball.wrap.is_some() { 0.0 } else { fl.speed * share };
    let ramp = (fl.speed / CRANK_RAMP) * STEP;
    let omega = if ball.wrap.is_some() { 0.0 } else { arm.spin + clamp(goal - arm.spin, -ramp, ramp) };
    let used = (omega - arm.spin) * fl.inertia;
    let angle = (arm.angle + omega * STEP) % (PI * 2.0);
    sim.bots[b].melee[a].angle = angle;
    let tip = crank_tip(&f, &fl, angle);
    let arm0 = sub(tip, f.hub);
    let tip_vel = add(velocity_at(sim, rb, tip), scale(cross(f.axis, arm0), omega));

    // La boule : pesanteur, air, puis le décor sur son trajet
    let mut v = scale(add(ball.vel, v3(0.0, -GRAVITY * STEP, 0.0)), (-fl.drag * STEP).exp());
    let prev = ball.pos;
    let mut pos = add(prev, scale(v, STEP));
    let filter = |h: ColliderHandle| fixed_only(sim, h);
    let mv = sub(pos, prev);
    let moved = len(mv);
    let mut planned: Option<PlannedHit> = None;
    if moved > 1e-6 {
        let dir = scale(mv, 1.0 / moved);
        if let Some(hit) = sim.phys.cast_ray_and_get_normal_where(prev, dir, moved + fl.radius, true, &filter) {
            let n = hit.normal;
            let owner = sim.owners.get(&hit.collider).copied();
            pos = add(prev, scale(dir, jsmath::max(0.0, hit.time_of_impact - fl.radius)));
            let into = -dot(v, n);
            if into > 0.0 && len(n) > 0.5 {
                v = bounce(v, n, into, jsmath::min(fl.restitution, SCENERY_RESTITUTION), fl.friction);
                let point = add(prev, scale(dir, hit.time_of_impact));
                if into > spec.hit.min_speed && sim.time - sim.bots[b].melee[a].hit_at >= spec.hit.gap {
                    let prop_hit = match owner {
                        Some(Owner::Prop(i)) => Some(i),
                        _ => None,
                    };
                    let contact = Contact {
                        surface: if prop_hit.is_some() { Surface::Prop } else { Surface::Scenery },
                        target: prop_hit.map(Target::Prop),
                        body: None,
                        point,
                        radial: 0.0,
                        normal: None,
                        face: None,
                        floor: false,
                    };
                    let mut h = PlannedHit::new(b, a, contact, 0.5 * fl.mass * into * into, 1.0, scale(n, -1.0), None, f.hub, part);
                    h.impulse = Some(0.0);
                    h.reaction = Some(0.0);
                    planned = Some(h);
                }
            }
        }
    }
    if let Some(h) = planned {
        sim.bots[b].melee[a].hit_at = sim.time;
        plans.hits.push(h);
    }
    // Le dessus d'un décor sous elle (une plateforme), quand elle descend
    if v.y < 0.0
        && let Some(down) = sim.phys.cast_ray_where(pos, v3(0.0, -1.0, 0.0), fl.radius + 0.02, true, &|h| fixed_only(sim, h))
    {
        pos = v3(pos.x, pos.y + fl.radius - down, pos.z);
        v = bounce(v, UP, -v.y, 0.1, ROLLING);
    }

    // La chaîne : elle retient la boule (du bout de la manivelle, moins ce qui s'est enroulé autour du
    // moyeu ; ou de là où elle s'est enroulée autour d'un obstacle)
    let wrap = ball.wrap;
    if wrap.is_none() {
        let out = sub(pos, f.hub);
        let radial = sub(out, scale(f.axis, dot(out, f.axis)));
        let r2 = dot(radial, radial);
        let around = if r2 > 0.01 { dot(f.axis, cross(radial, sub(v, velocity_at(sim, rb, pos)))) / r2 } else { 0.0 };
        let winding = omega.abs() * fl.crank * WIND_RATE * STEP;
        if omega > 0.5 && around < omega * (1.0 - WIND_LAG) {
            ball.wound = jsmath::min(fl.chain - WRAP_MIN_FREE, ball.wound + winding);
        } else {
            ball.wound = jsmath::max(0.0, ball.wound - winding - UNWIND_RATE * STEP);
        }
    }
    let anchor = wrap.map_or(tip, |w| w.point);
    let free = match wrap {
        Some(w) => fl.chain - w.length,
        None => fl.chain - ball.wound,
    };
    let rel = sub(pos, anchor);
    let d = len(rel);
    let mut chain_impulse = v3(0.0, 0.0, 0.0);
    if d > free && d > 1e-6 {
        let n = scale(rel, 1.0 / d);
        pos = add(anchor, scale(n, free));
        let away = dot(sub(v, if wrap.is_some() { v3(0.0, 0.0, 0.0) } else { tip_vel }), n);
        if away > 0.0 {
            // Au bout de la chaîne : le robot (masse effective en ce point)
            let inv = if wrap.is_some() { 0.0 } else { 1.0 / effective_mass(sim, rb, tip, n) };
            let lambda = away / (1.0 / fl.mass + inv);
            v = sub(v, scale(n, lambda / fl.mass));
            if wrap.is_none() {
                chain_impulse = scale(n, lambda);
            }
        }
    }

    // Les robots : ses coups sur les ennemis ; son propre robot la repousse sans dégâts
    (pos, v) = ball_on_robots(sim, b, a, &f, &fl, pos, v, plans);
    // Pas sous le sol (ni le relief)
    let floor = ground_level(sim, pos.x, pos.z) + fl.radius;
    if pos.y < floor {
        pos = v3(pos.x, floor, pos.z);
        if v.y < 0.0 {
            v = bounce(v, UP, -v.y, 0.15, ROLLING);
        }
    }

    // Ce que la chaîne tire, le robot le reçoit tout au bout de la manivelle, plus la réaction de ce qui
    // l'a accélérée ; le moteur fournit le travail
    let turned = dot(f.axis, cross(arm0, chain_impulse));
    if len(chain_impulse) > 1e-9 {
        sim.phys.apply_impulse_at_point(rb, chain_impulse, tip, true);
    }
    if used.abs() > 1e-9 {
        sim.phys.apply_torque_impulse(rb, scale(f.axis, -used), true);
    }
    let work = (used - turned) * omega;
    if powered && work > 0.0 {
        sim.bots[b].drawn += work / STEP / 1000.0 / MOTOR_EFFICIENCY;
    }
    sim.bots[b].melee[a].spin = omega;
    // Gyroscope : le volant de la manivelle
    if omega.abs() > 0.01 {
        add_gyro(gyros, part, scale(f.axis, fl.inertia * omega));
    }
    ball.pos = pos;
    ball.vel = v;
    sim.bots[b].melee[a].ball = Some(ball);
    update_wrap(sim, b, a, &fl, tip);
}

/// La boule et les robots (`ballOnRobots`) : sur un ennemi, un coup ; un accessoire mobile de même ;
/// son propre robot la repousse sans dégâts.
#[allow(clippy::too_many_arguments)]
fn ball_on_robots(sim: &mut Sim, b: usize, a: usize, f: &MeleeFrame, fl: &FlailSpec, mut pos: V3, mut v: V3, plans: &mut Plans) -> (V3, V3) {
    let r = fl.radius;
    // Son propre robot
    for p in sim.bots[b].parts.clone() {
        let prb = sim.part(p).rb;
        let t = sim.phys.translation(prb);
        if distance(t, pos) > sim.bots[b].radius + sim.bots[b].top + 2.0 {
            continue;
        }
        let Some((target, point, d)) = probe_part(sim, b, p, t, sim.phys.rotation(prb), pos, r) else { continue };
        if !matches!(target, Target::Block(..)) {
            continue;
        }
        let n = if d > 1e-4 { norm(sub(pos, point)) } else { UP };
        pos = add(point, scale(n, r));
        let vp = velocity_at(sim, prb, point);
        let into = -dot(sub(v, vp), n);
        if into > 0.0 {
            let reduced = 1.0 / (1.0 / fl.mass + 1.0 / effective_mass(sim, prb, point, n));
            let lambda = (1.0 + 0.1) * reduced * into;
            v = add(vp, bounce(sub(v, vp), n, into, 0.1, ROLLING));
            sim.phys.apply_impulse_at_point(prb, scale(n, -lambda), point, true);
        }
    }
    // Les ennemis
    let spec = sim.bots[b].melee[a].spec();
    if sim.time - sim.bots[b].melee[a].hit_at < spec.hit.gap {
        return (pos, v);
    }
    let mut best: Option<(Target, V3, f64, RigidBodyHandle, Surface)> = None;
    for (o, p, t, q) in enemy_parts(sim, b, pos, r + 1.0) {
        if let Some((target, point, d)) = probe_part(sim, o, p, t, q, pos, r)
            && best.is_none_or(|bt| d < bt.2)
        {
            best = Some((target, point, d, sim.part(p).rb, Surface::Robot));
        }
    }
    for i in present(sim) {
        let pr = prop(sim, i);
        if pr.fixed || pr.hp <= 0.0 || distance(sim.phys.translation(pr.rb), pos) > jsmath::max(jsmath::max(pr.half.x, pr.half.y), pr.half.z) * 1.8 + r {
            continue;
        }
        let c = prop_nearest(sim, i, pos);
        let d = distance(c, pos);
        if d < r && best.is_none_or(|bt| d < bt.2) {
            best = Some((Target::Prop(i), c, d, pr.rb, Surface::Prop));
        }
    }
    let Some((target, point, d, body, surface)) = best else { return (pos, v) };
    let n = if d > 1e-4 { norm(sub(pos, point)) } else { norm(scale(v, -1.0)) };
    pos = add(point, scale(n, r));
    let vt = velocity_at(sim, body, point);
    let vrel = sub(v, vt);
    let into = -dot(vrel, n);
    if into <= 0.0 {
        return (pos, v);
    }
    let theirs = effective_mass(sim, body, point, n);
    let reduced = 1.0 / (1.0 / fl.mass + 1.0 / theirs);
    let impulse = (1.0 + fl.restitution) * reduced * into;
    v = add(vt, bounce(vrel, n, into, fl.restitution, fl.friction));
    let speed = len(vrel);
    if speed < spec.hit.min_speed {
        // Elle ne fait que le toucher : il est poussé, rien de plus
        sim.phys.apply_impulse_at_point(body, scale(n, -impulse), point, true);
        return (pos, v);
    }
    sim.bots[b].melee[a].hit_at = sim.time;
    let contact = Contact { surface, target: Some(target), body: Some(body), point, radial: 0.0, normal: None, face: None, floor: false };
    let part = sim.bots[b].blocks[sim.bots[b].melee[a].block].part;
    let mut h = PlannedHit::new(b, a, contact, 0.5 * reduced * speed * speed, 1.0, scale(n, -1.0), None, f.hub, part);
    h.impulse = Some(impulse);
    h.reaction = Some(0.0);
    plans.hits.push(h);
    (pos, v)
}

/// Enroulement de la chaîne d'un fléau (`updateWrap`) : libre, elle s'enroule si elle traverse un
/// obstacle fixe dressé ; enroulée, elle retient le robot à son point d'appui, et se déroule quand la
/// boule repasse de l'autre côté, s'il tire trop fort, ou au bout de WRAP_MAX s.
fn update_wrap(sim: &mut Sim, b: usize, a: usize, fl: &FlailSpec, tip: V3) {
    let mut ball = sim.bots[b].melee[a].ball.expect("fléau sans boule");
    let Some(wrap) = ball.wrap else {
        let span = sub(ball.pos, tip);
        let d = len(span);
        if d < 0.3 {
            return;
        }
        let dir = scale(span, 1.0 / d);
        let Some(hit) = sim.phys.cast_ray_and_get_normal_where(tip, dir, d - fl.radius * 1.2, true, &|h| fixed_only(sim, h)) else { return };
        if hit.normal.y.abs() > WRAP_UPRIGHT || hit.time_of_impact < 0.05 {
            return;
        }
        let n = hit.normal;
        let point = add(add(tip, scale(dir, hit.time_of_impact)), scale(n, 0.06));
        let length = distance(point, tip);
        if fl.chain - length < WRAP_MIN_FREE {
            return;
        }
        let axis = cross(sub(point, tip), sub(ball.pos, point));
        if len(axis) < 1e-4 {
            return;
        }
        ball.wrap = Some(Wrap { point, length, axis: norm(axis), since: sim.time });
        sim.bots[b].melee[a].ball = Some(ball);
        return;
    };
    // Déroulée : la boule est repassée de l'autre côté du point d'appui, ou c'est trop long
    let turn = dot(cross(sub(wrap.point, tip), sub(ball.pos, wrap.point)), wrap.axis);
    if turn < 0.0 || sim.time - wrap.since > WRAP_MAX {
        ball.wrap = None;
        sim.bots[b].melee[a].ball = Some(ball);
        return;
    }
    // La chaîne retient le robot à son point d'appui : on retire ce qui l'en éloigne
    let rb = sim.part(sim.bots[b].blocks[sim.bots[b].melee[a].block].part).rb;
    let out = sub(tip, wrap.point);
    let d = len(out);
    if d <= wrap.length || d < 1e-6 {
        return;
    }
    let n = scale(out, 1.0 / d);
    let away = dot(velocity_at(sim, rb, tip), n) + (GRIP_BIAS * (d - wrap.length)) / STEP;
    if away <= 0.0 {
        return;
    }
    let lambda = away * effective_mass(sim, rb, tip, n);
    if lambda > WRAP_PULL * STEP {
        // Il tire trop fort : la chaîne glisse de l'obstacle
        ball.wrap = None;
        sim.bots[b].melee[a].ball = Some(ball);
        return;
    }
    sim.phys.apply_impulse_at_point(rb, scale(n, -lambda), tip, true);
}

// --- Mâchoire ---

/// Le bloc ennemi qui est dans la gueule, entre les mâchoires ouvertes de `opening` (`inMouth`) : le
/// plus proche de l'axe de la gueule ; robot, bloc, et sa distance au pivot le long de e1.
fn in_mouth(sim: &Sim, b: usize, f: &MeleeFrame, jaw: &JawSpec, opening: f64) -> Option<(usize, usize, f64)> {
    let (near, far) = jaw.mouth;
    let h = catalog().constants.block_size / 2.0;
    let mut best: Option<(usize, usize, f64, f64)> = None;
    for (o, p, t, q) in enemy_parts(sim, b, f.hub, far + 1.0) {
        for &k in &sim.part(p).blocks {
            let c = sub(add(t, qrot(q, sim.bots[o].blocks[k].local)), f.hub);
            let along = dot(c, f.e1);
            if along < near - h || along > far + h * 0.5 {
                continue;
            }
            let side = dot(c, f.axis);
            if side.abs() > jaw.half + h {
                continue;
            }
            // Entre les mâchoires : sous la mâchoire du haut, au-dessus de celle du bas, à cette distance
            let up = -dot(c, f.e2);
            let gap = jsmath::max(0.05, clamp(along, near, far) * opening.tan());
            if up.abs() > gap + h * 0.6 {
                continue;
            }
            let score = up.abs() + side.abs() * 0.5 + (along - (near + far) / 2.0).abs() * 0.3;
            if best.is_none_or(|bt| score < bt.3) {
                best = Some((o, k, clamp(along, near, far), score));
            }
        }
    }
    best.map(|(o, k, along, _)| (o, k, along))
}

/// Point du repère d'un robot où se trouve le point monde `p`, d'après un de ses corps (`toLocal`), et l'inverse.
fn to_local(sim: &Sim, rb: RigidBodyHandle, p: V3) -> V3 {
    qrot_inv(sim.phys.rotation(rb), sub(p, sim.phys.translation(rb)))
}

fn to_world(sim: &Sim, rb: RigidBodyHandle, p: V3) -> V3 {
    add(sim.phys.translation(rb), qrot(sim.phys.rotation(rb), p))
}

/// Une mâchoire (`stepJaw`) : fermeture (saisie), prise (tenue, écrasement), réouverture.
pub fn step_jaw(sim: &mut Sim, b: usize, a: usize, plans: &mut Plans) {
    let spec = sim.bots[b].melee[a].spec();
    let jaw = spec.jaw.expect("mâchoire sans gueule");
    sim.bots[b].melee[a].phase_t += STEP;
    sim.bots[b].melee[a].spin = 0.0;
    let block = sim.bots[b].melee[a].block;
    let powered = powered_arm(sim, b, block);
    // La prise d'abord : avant de lire un corps, on vérifie que tout est encore là
    if sim.bots[b].melee[a].grip.is_some() && !holdable(sim, b, a, powered) {
        let_go(&mut sim.bots[b].melee[a]);
    }
    let arm = sim.bots[b].melee[a];
    match arm.phase {
        Phase::Ready => {
            let m = &mut sim.bots[b].melee[a];
            m.swing = jaw.open;
            if arm.trigger && powered {
                m.phase = Phase::Strike;
                m.phase_t = 0.0;
            }
        }
        Phase::Strike => {
            // Elle se ferme ; ce qui est dans la gueule ouverte de l'angle courant est saisi
            let t = jsmath::min(1.0, arm.phase_t / jaw.close);
            let swing = jaw.open + (jaw.shut - jaw.open) * t;
            sim.bots[b].melee[a].swing = swing;
            let f = melee_frame(sim, b, &sim.bots[b].melee[a]);
            if let Some((o, k, along)) = in_mouth(sim, b, &f, &jaw, swing) {
                bite(sim, b, a, &jaw, &f, o, k, along, plans);
            } else if t >= 1.0 {
                let_go(&mut sim.bots[b].melee[a]);
            }
        }
        Phase::Hold => {
            if arm.grip.is_none() || !arm.trigger || arm.phase_t >= jaw.hold {
                let_go(&mut sim.bots[b].melee[a]);
            } else {
                hold_grip(sim, b, a, &jaw, plans);
            }
        }
        Phase::Recover => {
            let t = jsmath::min(1.0, arm.phase_t / jaw.reopen);
            let m = &mut sim.bots[b].melee[a];
            m.swing = m.from + (jaw.open - m.from) * t * t * (3.0 - 2.0 * t);
            if m.phase_t >= jaw.reopen + jaw.cooldown {
                m.phase = Phase::Ready;
                m.phase_t = 0.0;
                m.swing = jaw.open;
            }
        }
    }
}

/// La prise tient-elle encore (`holdable`) ? La mâchoire alimentée, le bloc saisi vivant sur un morceau
/// encore là, son robot pas hors de combat. Un bloc saisi détruit : elle mord le suivant, au plus près.
fn holdable(sim: &mut Sim, b: usize, a: usize, powered: bool) -> bool {
    let arm = sim.bots[b].melee[a];
    let grip = arm.grip.expect("prise");
    if !powered || sim.parts[sim.bots[b].blocks[arm.block].part].is_none() {
        return false;
    }
    let prey = &sim.bots[grip.bot];
    if !prey.cockpit_alive() {
        return false;
    }
    let held = &prey.blocks[grip.block];
    if held.alive && sim.parts[held.part].is_some() {
        return true;
    }
    // Le bloc saisi est tombé : elle mord le plus proche de la prise, plus profond
    let mut next = None;
    let mut nearest = REBITE;
    for &k in &prey.live {
        if sim.parts[prey.blocks[k].part].is_none() {
            continue;
        }
        let d = distance(nearest_on_block(prey.blocks[k].local, grip.local), grip.local);
        if d < nearest {
            nearest = d;
            next = Some(k);
        }
    }
    let Some(next) = next else { return false };
    if let Some(g) = sim.bots[b].melee[a].grip.as_mut() {
        g.block = next;
    }
    true
}

/// Elle lâche (ou se rouvre à vide) : réouverture, puis répit (`letGo`).
fn let_go(m: &mut super::melee::MeleeArm) {
    m.grip = None;
    m.phase = Phase::Recover;
    m.phase_t = 0.0;
    m.from = m.swing;
}

/// La morsure (`bite`) : elle saisit le bloc `k` du robot `o`, au point de sa gueule à `along` m du
/// pivot, et y mord.
#[allow(clippy::too_many_arguments)]
fn bite(sim: &mut Sim, b: usize, a: usize, jaw: &JawSpec, f: &MeleeFrame, o: usize, k: usize, along: f64, plans: &mut Plans) {
    let point = add(f.hub, scale(f.e1, along));
    let prey_rb = sim.part(sim.bots[o].blocks[k].part).rb;
    let block = sim.bots[b].melee[a].block;
    let own_rb = sim.part(sim.bots[b].blocks[block].part).rb;
    let grip = JawGrip { bot: o, block: k, local: to_local(sim, prey_rb, point), own: to_local(sim, own_rb, point), since: sim.time, slip: 0.0, crush: 0.0 };
    let bs = catalog().constants.block_size;
    let m = &mut sim.bots[b].melee[a];
    m.grip = Some(grip);
    m.phase = Phase::Hold;
    m.phase_t = 0.0;
    m.hit_at = sim.time;
    // Les mâchoires se referment sur le bloc
    m.swing = clamp(((bs / 2.0) / jsmath::max(0.2, along)).atan(), jaw.shut, jaw.open);
    let part = sim.bots[b].blocks[block].part;
    let mut h = PlannedHit::new(b, a, Contact::robot(Target::Block(o, k), prey_rb, point, along), 1000.0, 1.0, f.e1, None, f.hub, part);
    h.impulse = Some(0.0);
    h.reaction = Some(0.0);
    h.damage = Some(jaw.bite);
    plans.hits.push(h);
}

/// Matrice de masse inverse d'un corps en un point (`pointCompliance`) : 1/m·I − [r]×·I⁻¹·[r]×.
fn point_compliance(inv_mass: f64, inv: &[[f64; 3]; 3], r: V3) -> [[f64; 3]; 3] {
    let axes = [v3(1.0, 0.0, 0.0), v3(0.0, 1.0, 0.0), v3(0.0, 0.0, 1.0)];
    let mut out = [[0.0; 3]; 3];
    for (j, e) in axes.into_iter().enumerate() {
        // Colonne j : la vitesse du point pour une impulsion unité le long de l'axe j
        let col = add(scale(e, inv_mass), cross(mul_mv(inv, cross(r, e)), r));
        out[j] = [col.x, col.y, col.z];
    }
    [[out[0][0], out[1][0], out[2][0]], [out[0][1], out[1][1], out[2][1]], [out[0][2], out[1][2], out[2][2]]]
}

/// La prise (`holdGrip`) : le point de la mâchoire et le point de la proie tenus ensemble par une
/// impulsion entre leurs deux corps, puis une part de leur rotation relative amortie ; au-delà de ce
/// que tient la mâchoire, elle glisse (puis lâche) ; trop écartés, ils s'arrachent. L'écrasement
/// s'accumule et part par tranches.
fn hold_grip(sim: &mut Sim, b: usize, a: usize, jaw: &JawSpec, plans: &mut Plans) {
    let arm = sim.bots[b].melee[a];
    let grip = arm.grip.expect("prise");
    let ra_body = sim.part(sim.bots[b].blocks[arm.block].part).rb;
    let rb_body = sim.part(sim.bots[grip.bot].blocks[grip.block].part).rb;
    let pa = to_world(sim, ra_body, grip.own);
    let pb = to_world(sim, rb_body, grip.local);
    let gap = sub(pa, pb);
    if len(gap) > jaw.tear {
        let_go(&mut sim.bots[b].melee[a]);
        return;
    }
    // Le vérin serre (sur les batteries) ; s'il manque d'énergie, il tient moins
    let share = supply(&sim.bots[b], jaw.power);
    sim.bots[b].drawn += jaw.power * share;
    let strength = jaw.strength * share;
    let ra = sub(pa, sim.phys.world_com(ra_body));
    let rb = sub(pb, sim.phys.world_com(rb_body));
    let ia = inv_inertia(sim, ra_body);
    let ib = inv_inertia(sim, rb_body);
    let ka = point_compliance(sim.phys.inv_mass(ra_body), &ia, ra);
    let kb = point_compliance(sim.phys.inv_mass(rb_body), &ib, rb);
    let k: Vec<Vec<f64>> = (0..3).map(|i| (0..3).map(|j| ka[i][j] + kb[i][j]).collect()).collect();
    let vrel = sub(velocity_at(sim, ra_body, pa), velocity_at(sim, rb_body, pb));
    let target = add(vrel, scale(gap, GRIP_BIAS / STEP));
    let Some(solved) = solve_linear(&k, &[-target.x, -target.y, -target.z]) else { return };
    let mut impulse = v3(solved[0], solved[1], solved[2]);
    let cap = strength * STEP;
    let size = len(impulse);
    if size > cap {
        // Elle ne tient pas tout : elle glisse ; trop longtemps, elle lâche
        impulse = scale(impulse, cap / size);
        let g = sim.bots[b].melee[a].grip.as_mut().expect("prise");
        g.slip += STEP;
        if g.slip >= jaw.slip {
            let_go(&mut sim.bots[b].melee[a]);
            return;
        }
    } else {
        let g = sim.bots[b].melee[a].grip.as_mut().expect("prise");
        g.slip = jsmath::max(0.0, g.slip - STEP * 0.5);
    }
    sim.phys.apply_impulse_at_point(ra_body, impulse, pa, true);
    sim.phys.apply_impulse_at_point(rb_body, scale(impulse, -1.0), pb, true);
    // Leur rotation relative : une part amortie, dans la limite du couple que tient la prise
    let spin = sub(sim.phys.angvel(ra_body), sim.phys.angvel(rb_body));
    let k_ang: Vec<Vec<f64>> = (0..3).map(|i| (0..3).map(|j| ia[i][j] + ib[i][j]).collect()).collect();
    if let Some(turn) = solve_linear(&k_ang, &[-spin.x * GRIP_SPIN, -spin.y * GRIP_SPIN, -spin.z * GRIP_SPIN]) {
        let mut torque = v3(turn[0], turn[1], turn[2]);
        let most = strength * GRIP_ARM * STEP;
        if len(torque) > most {
            torque = scale(torque, most / len(torque));
        }
        sim.phys.apply_torque_impulse(ra_body, torque, true);
        sim.phys.apply_torque_impulse(rb_body, scale(torque, -1.0), true);
    }
    // L'écrasement, par tranches
    let g = sim.bots[b].melee[a].grip.as_mut().expect("prise");
    g.crush += jaw.crush * STEP;
    if g.crush >= jaw.crush * CRUSH_TICK {
        let damage = g.crush;
        g.crush = 0.0;
        let held = Target::Block(g.bot, g.block);
        let f = melee_frame(sim, b, &sim.bots[b].melee[a]);
        let part = sim.bots[b].blocks[arm.block].part;
        let mut h = PlannedHit::new(b, a, Contact::robot(held, rb_body, pb, 0.0), CRUSH_ENERGY, 1.0, f.e1, None, f.hub, part);
        h.impulse = Some(0.0);
        h.reaction = Some(0.0);
        h.damage = Some(damage);
        plans.hits.push(h);
    }
}

/// Un bloc ennemi est-il dans la gueule ouverte de cette mâchoire (`jawWouldBite`) ?
pub fn jaw_would_bite(sim: &Sim, b: usize, a: usize) -> bool {
    let arm = sim.bots[b].melee[a];
    let Some(jaw) = arm.spec().jaw else { return false };
    if !sim.bots[b].blocks[arm.block].alive {
        return false;
    }
    in_mouth(sim, b, &melee_frame(sim, b, &arm), &jaw, jaw.open).is_some()
}

/// La mâchoire de ce robot qui tient une proie, s'il en a une (`gripping`).
pub fn gripping(sim: &Sim, b: usize) -> bool {
    sim.bots[b].melee.iter().any(|a| a.grip.is_some() && sim.bots[b].blocks[a.block].alive)
}
