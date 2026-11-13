//! Les appuis sans roue (src/shared/robot/supports.ts) : patins anti-gravité et pattes. Chaque appui
//! mesure la distance au sol sous lui (un rayon le long du bas de son bloc) et pousse comme un
//! ressort-amortisseur réglé pour sa charge nominale ; il pousse aussi à l'horizontale pour amener son
//! point du robot à la vitesse voulue (avancer, tourner), dans la limite de son adhérence : une patte
//! agrippe le sol, un patin glisse sur son coussin et consomme de l'électricité.
//!
//! L'eau d'une arène n'est réelle, et un patin ne glisse dessus, que si elle a une eau profonde
//! (`deepWater` : la mer d'une île) ; ailleurs, le patin s'appuie sur le fond.

use super::brain::owner_bot;
use super::catalog::{SupportSpec, catalog};
use super::debris::block_world_pos;
use super::drive::supply;
use super::vec::{V3, add, clamp, cross, dot, len, norm, qrot, scale, sub, v3};
use super::world::{Owner, STEP, Sim};
use crate::jsmath;

/// Réactivité de la traction (1/s), force d'appui maximale (en multiple du poids nominal), longueur
/// d'une foulée (m).
const TRACTION_GAIN: f64 = 4.0;
const MAX_LOAD: f64 = 3.0;
const STRIDE: f64 = 1.2;
/// Frein des appuis : la traction rattrape l'écart BRAKE_GAIN fois plus vite, un patin s'accroche
/// BRAKE_HOVER_TRACTION fois plus.
const BRAKE_GAIN: f64 = 3.0;
const BRAKE_HOVER_TRACTION: f64 = 2.0;

/// Distance le long de `down` jusqu'à la surface de l'eau, si elle est à portée (`reach`) et que l'eau
/// de l'arène est réelle (`deepWater`) ; ∞ sinon (`waterBelow`).
fn water_below(sim: &Sim, p: V3, down: V3, reach: f64) -> f64 {
    let (Some(water), Some(_)) = (sim.water, sim.arena.deep_water) else { return f64::INFINITY };
    if down.y > -0.5 || p.y < water {
        return f64::INFINITY;
    }
    let t = (p.y - water) / -down.y;
    if t <= reach { t } else { f64::INFINITY }
}

/// L'appui du bloc (`specOf`).
fn spec_of(sim: &Sim, b: usize, s: usize) -> SupportSpec {
    let block = sim.bots[b].supports[s].block;
    catalog().blocks[&sim.bots[b].blocks[block].kind].support.expect("appui sans réglage")
}

/// Appuis encore reliés au cockpit : les seuls commandés (`liveSupports`) ; leurs rangs.
pub fn live_supports(sim: &Sim, b: usize) -> Vec<usize> {
    let bot = &sim.bots[b];
    if !bot.cockpit_alive() {
        return Vec::new();
    }
    let ck = bot.cockpit_part();
    (0..bot.supports.len())
        .filter(|&i| {
            let k = &bot.blocks[bot.supports[i].block];
            k.alive && k.part == ck
        })
        .collect()
}

/// Appuis qui touchent le sol (`groundedSupports`).
pub fn grounded_supports(sim: &Sim, b: usize) -> Vec<usize> {
    live_supports(sim, b).into_iter().filter(|&i| sim.bots[b].supports[i].contact.is_finite()).collect()
}

/// Un pas des appuis (`driveSupports`) : sustentation, et traction vers la consigne `throttle` (avance,
/// de -1 à 1) et `steer` (lacet, > 0 : à gauche). `powered` faux (électronique coupée) : les patins
/// s'éteignent, les pattes restent debout et freinent. `overrun` (boost) : la traction ne retient
/// jamais le robot dans son sens de marche ; `speed_factor` : le sprint ; `brake` : le frein (0 à 1).
#[allow(clippy::too_many_arguments)]
pub fn drive_supports(sim: &mut Sim, b: usize, throttle: f64, steer: f64, powered: bool, overrun: bool, speed_factor: f64, brake: f64) {
    let supports = live_supports(sim, b);
    if supports.is_empty() {
        return;
    }
    let gravity = sim.gravity;
    let rb = sim.part(sim.bots[b].cockpit_part()).rb;
    let q = sim.phys.rotation(rb);
    let com = sim.phys.world_com(rb);
    let v = sim.phys.linvel(rb);
    let w = sim.phys.angvel(rb);
    let up = qrot(q, v3(0.0, 1.0, 0.0));
    let ahead = qrot(q, v3(0.0, 0.0, 1.0));
    let forward = norm(v3(ahead.x, 0.0, ahead.z));
    let share = sim.phys.mass(rb) / supports.len() as f64;
    let brake = clamp(brake, 0.0, 1.0);
    let go = 1.0 - brake;
    let bot = &sim.bots[b];
    let speed = if powered { throttle * bot.speed * speed_factor * go } else { 0.0 };
    let yaw = if powered { ((steer * bot.turn) / jsmath::max(1.0, bot.radius)) * go } else { 0.0 };
    let gain = TRACTION_GAIN * (1.0 + (BRAKE_GAIN - 1.0) * brake);
    // Les patins ne reçoivent que ce que l'alimentation peut fournir
    let demand = supports.iter().fold(0.0, |s, &i| s + spec_of(sim, b, i).power);
    let k = supply(bot, demand);
    let flat = jsmath::hypot2(v.x, v.z);

    for i in supports {
        let spec = spec_of(sim, b, i);
        sim.bots[b].supports[i].phase += (flat * STEP * 2.0 * std::f64::consts::PI) / STRIDE;
        let block = sim.bots[b].supports[i].block;
        let p = block_world_pos(sim, b, block);
        let down = scale(qrot(q, sim.bots[b].blocks[block].up), -1.0);
        let keep = |h| {
            let owner = sim.owners.get(&h);
            !matches!(owner, Some(Owner::Debris)) && owner_bot(sim, owner) != Some(b)
        };
        let hit = sim.phys.cast_ray_where(p, down, spec.reach, true, &keep);
        let hover = spec.hover;
        // Paralysé localement (lance électrique, emp.rs) : ce patin retombe, cette patte se fige
        let on = powered && sim.bots[b].blocks[block].stunned_until <= sim.time;
        // Un patin glisse sur l'eau d'une arène où elle est réelle (la mer d'une île : `deepWater`)
        let contact = jsmath::min(hit.unwrap_or(f64::INFINITY), if hover { water_below(sim, p, down, spec.reach) } else { f64::INFINITY });
        sim.bots[b].supports[i].contact = contact;
        if !contact.is_finite() || (hover && !on) {
            sim.bots[b].supports[i].force = 0.0;
            continue;
        }

        // Sustentation : ressort-amortisseur réglé pour la charge nominale
        let omega = 2.0 * std::f64::consts::PI * spec.frequency;
        let stiffness = spec.rated_load * omega * omega;
        let damping = 2.0 * spec.damping_ratio * (stiffness * spec.rated_load).sqrt();
        let vp = add(v, cross(w, sub(p, com)));
        let approach = dot(vp, down);
        let weight = spec.rated_load * gravity;
        let mut force = clamp(weight + stiffness * (spec.height - contact) + damping * approach, 0.0, MAX_LOAD * weight);
        if hover {
            force *= k;
            sim.bots[b].drawn += (spec.power * force) / weight;
        }
        sim.bots[b].supports[i].force = force;
        sim.phys.apply_impulse_at_point(rb, scale(down, -force * STEP), p, true);

        // Traction : amène la vitesse horizontale du point vers la consigne, sans dépasser l'adhérence
        let r = sub(p, com);
        let want = if on { add(scale(forward, speed), cross(scale(up, yaw), r)) } else { v3(0.0, 0.0, 0.0) };
        let slip = sub(want, vp);
        let mut push = scale(v3(slip.x, 0.0, slip.z), share * gain);
        // Boost : vers l'avant, l'appui ne pousse que dans le sens des gaz (sans gaz, le robot file librement)
        if overrun {
            let along = dot(push, forward);
            let allowed = if throttle > 0.0 {
                jsmath::max(0.0, along)
            } else if throttle < 0.0 {
                jsmath::min(0.0, along)
            } else {
                0.0
            };
            push = add(push, scale(forward, allowed - along));
        }
        let limit = spec.traction * force * (if hover { 1.0 + (BRAKE_HOVER_TRACTION - 1.0) * brake } else { 1.0 });
        if len(push) > limit {
            push = scale(push, limit / len(push));
        }
        sim.phys.apply_impulse_at_point(rb, scale(push, STEP), p, true);
    }
}
