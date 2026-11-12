//! La conduite d'un robot au sol par son pilote (sans IA) : `thinkBot` et `thinkPlayer` pour un robot
//! au sol (src/shared/ai/brain.ts, src/shared/sim/player.ts), `drive` et `driveWheels`
//! (src/shared/robot/propulsion.ts), la géométrie de direction et la stabilité au freinage
//! (src/shared/robot/steering.ts), le redressement (src/shared/robot/righting.ts) et l'énergie
//! (src/shared/robot/energy.ts). Seules les roues du morceau du cockpit sont motorisées et dirigées ;
//! un robot hors de combat ne conduit plus.

use super::lifecycle::energy_capacity;
use super::physics::Physics;
use super::robot::{Bot, Wheel};
use super::vec::{V3, clamp, cross, dot, len, norm, qrot, qrot_inv, scale, sub, v3};
use super::world::{STEP, Sim};
use crate::jsmath;
use rapier3d::prelude::RigidBodyHandle;

/// Variateur des moteurs de roue : la tension suit la commande avec cette rampe (1/s) (config.ts).
const DRIVE_RAMP: f64 = 1.2;
/// Générateur du cockpit (kW).
const GENERATOR_POWER: f64 = 1.2;
/// Sprint (boost) : vitesse et tension multipliées, puissance tirée des batteries (kW).
const SPRINT: f64 = 1.3;
const SPRINT_POWER: f64 = 1.5;
/// Frein : part de l'adhérence, et marge de stabilité (propulsion.ts).
const BRAKE_GRIP: f64 = 0.85;
const PITCH_MARGIN: f64 = 0.85;
/// En deçà de cet écart à la ligne du centre de rotation (m), une roue directrice n'a pas à braquer.
const MIN_ARM: f64 = 0.05;
/// Redressement (righting.ts).
const FLIPPED_UP_Y: f64 = 0.55;
const RIGHTING_DELAY: f64 = 3.0;
const STILL_SPEED: f64 = 1.5;
const RIGHTING_TIME: f64 = 2.0;
const HOP_TIME: f64 = 0.15;
const HOP_SPEED: f64 = 3.0;
const TURN_RATE: f64 = 4.0;
const UPRIGHT_Y: f64 = 0.92;
const UP: V3 = v3(0.0, 1.0, 0.0);

/// Centre de masse du morceau du cockpit, dans le repère du robot (`localCom`).
fn local_com(phys: &Physics, rb: RigidBodyHandle) -> V3 {
    qrot_inv(phys.rotation(rb), sub(phys.world_com(rb), phys.translation(rb)))
}

/// Roues montées sur le morceau du cockpit : les seules qui sont motorisées (`drivenWheels`).
fn driven_wheels(bot: &Bot) -> Vec<&Wheel> {
    if !bot.cockpit_alive() {
        return Vec::new();
    }
    let ck = bot.cockpit_part();
    bot.wheels.iter().filter(|w| w.hub.is_some() && w.part == Some(ck)).collect()
}

/// Géométrie de direction (`steeringGeometry`) : la ligne du centre de rotation et la courbure
/// maximale (0 : pas de roue directrice alimentée, conduite différentielle).
struct Geometry {
    pivot_z: f64,
    max_curvature: f64,
}

fn steering_geometry(phys: &Physics, bot: &Bot, ck_rb: Option<RigidBodyHandle>) -> Geometry {
    let wheels = driven_wheels(bot);
    let steered: Vec<&&Wheel> = wheels.iter().filter(|w| w.steerable).collect();
    if steered.is_empty() {
        return Geometry { pivot_z: 0.0, max_curvature: 0.0 };
    }
    let fixed: Vec<&&Wheel> = wheels.iter().filter(|w| !w.steerable && w.def.caster.is_none()).collect();
    let pivot_z = if fixed.is_empty() {
        local_com(phys, ck_rb.expect("roues motrices sans cockpit")).z
    } else {
        fixed.iter().fold(0.0, |s, w| s + w.local.z) / fixed.len() as f64
    };
    let mut max_curvature = f64::INFINITY;
    for w in steered {
        let arm = (w.local.z - pivot_z).abs();
        if arm < MIN_ARM {
            continue;
        }
        let t = w.def.steering.map_or(0.0, |s| s.0).tan();
        max_curvature = jsmath::min(max_curvature, t / (arm + w.local.x.abs() * t));
    }
    Geometry { pivot_z, max_curvature: if max_curvature.is_finite() { max_curvature } else { 0.0 } }
}

/// Braquage d'une roue dans un virage de courbure `k` (`steerAngle`).
fn steer_angle(w: &Wheel, k: f64, pivot_z: f64) -> f64 {
    let max = w.def.steering.map_or(0.0, |s| s.0);
    clamp((k * (w.local.z - pivot_z)).atan2(1.0 - k * w.local.x), -max, max)
}

/// Vitesse d'une roue dans un virage, rapportée à celle du point de référence (`cornerSpeedRatio`).
fn corner_speed_ratio(w: &Wheel, k: f64, pivot_z: f64) -> f64 {
    jsmath::hypot2(1.0 - k * w.local.x, k * (w.local.z - pivot_z))
}

/// Le servomoteur de direction (`aimWheel`) ; rien : non alimenté, la roue garde son braquage.
fn aim_wheel(w: &mut Wheel, angle: Option<f64>) {
    let Some(angle) = angle else { return };
    if !w.steerable {
        return;
    }
    let step = w.def.steering.map_or(0.0, |s| s.1) * STEP;
    w.steer += clamp(angle - w.steer, -step, step);
}

/// Décélération à laquelle le robot basculerait en freinant (`pitchoverAccel`).
fn pitchover_accel(phys: &Physics, bot: &Bot, ck_rb: RigidBodyHandle, forward: bool, gravity: f64) -> f64 {
    let wheels = driven_wheels(bot);
    if wheels.len() < 2 {
        return f64::INFINITY;
    }
    let com = local_com(phys, ck_rb);
    let mut ground = f64::INFINITY;
    let mut edge = if forward { f64::NEG_INFINITY } else { f64::INFINITY };
    for w in wheels {
        ground = jsmath::min(ground, w.local.y - w.def.radius);
        edge = if forward { jsmath::max(edge, w.local.z) } else { jsmath::min(edge, w.local.z) };
    }
    let margin = if forward { edge - com.z } else { com.z - edge };
    let height = com.y - ground;
    if !(margin > 0.0) || !(height > 0.0) {
        return f64::INFINITY;
    }
    (gravity * margin) / height
}

/// Conduite des roues (`driveWheels`) : seules celles du morceau du cockpit vivant sont alimentées.
#[allow(clippy::too_many_arguments)]
fn drive_wheels(phys: &Physics, bot: &mut Bot, ck_rb: Option<RigidBodyHandle>, throttle: f64, steer: f64, boost: bool, sprint: f64, brake: f64, gravity: f64) {
    let (speed, turn) = (bot.speed, bot.turn);
    let max_step = DRIVE_RAMP * STEP;
    let geo = steering_geometry(phys, bot, ck_rb);
    let curvature = steer * geo.max_curvature;
    // Frein : jusqu'où peut-on décélérer sans basculer, dans le sens où roule le robot
    let mut tip = f64::INFINITY;
    if brake > 0.0
        && let Some(rb) = ck_rb
    {
        tip = pitchover_accel(phys, bot, rb, dot(phys.linvel(rb), qrot(phys.rotation(rb), v3(0.0, 0.0, 1.0))) >= 0.0, gravity);
    }
    let ck = if bot.cockpit_alive() { Some(bot.cockpit_part()) } else { None };
    for w in bot.wheels.iter_mut() {
        if w.part.is_none() {
            continue;
        }
        let powered = ck.is_some() && w.part == ck;
        w.powered = powered;
        let motor = powered && w.def.stall_torque > 0.0;
        w.engaged = motor && brake == 0.0;
        w.overrun = boost;
        w.brake = if motor {
            brake * BRAKE_GRIP * jsmath::min(1.0, (PITCH_MARGIN * tip) / (BRAKE_GRIP * w.def.grip * gravity))
        } else {
            0.0
        };
        let angle = if powered { Some(steer_angle(w, curvature, geo.pivot_z)) } else { None };
        aim_wheel(w, angle);
        if motor {
            let ground = if geo.max_curvature > 0.0 {
                throttle * speed * sprint * corner_speed_ratio(w, curvature, geo.pivot_z)
            } else {
                throttle * speed * sprint - w.side * steer * turn
            };
            let wanted = clamp(ground / (w.def.free_speed * w.def.radius), -sprint, sprint);
            w.drive += clamp(wanted - w.drive, -max_step, max_step);
        } else {
            w.drive = 0.0;
        }
    }
}

/// Part de la demande que l'alimentation peut fournir (`supply`).
fn supply(bot: &Bot, demand: f64) -> f64 {
    if demand <= 0.0 || bot.energy > 0.0 {
        return 1.0;
    }
    jsmath::min(1.0, GENERATOR_POWER / demand)
}

/// Le sprint (`sprintFactor`) : la surtension est décomptée de l'énergie du robot.
fn sprint_factor(bot: &mut Bot) -> f64 {
    let k = supply(bot, SPRINT_POWER);
    bot.drawn += SPRINT_POWER * k;
    1.0 + (SPRINT - 1.0) * k
}

/// Conduite au sol (`drive`) : roues seulement (ce jalon n'a ni appuis ni propulseurs).
#[allow(clippy::too_many_arguments)]
fn drive(phys: &Physics, bot: &mut Bot, ck_rb: Option<RigidBodyHandle>, throttle: f64, steer: f64, boost: bool, sprint: bool, brake: f64, gravity: f64) {
    let brake = clamp(brake, 0.0, 1.0);
    let boost = boost && brake == 0.0;
    let sprint = if sprint && brake == 0.0 && throttle != 0.0 && bot.cockpit_alive() { sprint_factor(bot) } else { 1.0 };
    drive_wheels(phys, bot, ck_rb, throttle, steer, boost, sprint, brake, gravity);
}

/// Un pas du gyroscope de redressement (`updateRighting`) : vrai tant qu'il redresse le robot.
fn update_righting(phys: &mut Physics, bot: &mut Bot, rb: RigidBodyHandle, dt: f64) -> bool {
    let q = phys.rotation(rb);
    let up = qrot(q, UP);
    if bot.righting > 0.0 {
        bot.righting -= dt;
        let hopping = bot.righting > RIGHTING_TIME - HOP_TIME;
        if !hopping && (up.y > UPRIGHT_Y || bot.righting <= 0.0) {
            bot.righting = 0.0;
            bot.flipped_for = 0.0;
            let w = phys.angvel(rb);
            phys.set_angvel(rb, scale(w, 0.2), true);
            return false;
        }
        if up.y <= UPRIGHT_Y {
            let mut axis = cross(up, UP);
            if len(axis) < 0.05 {
                axis = qrot(q, v3(0.0, 0.0, 1.0));
            }
            let angle = jsmath::max(-1.0, jsmath::min(1.0, up.y)).acos();
            phys.set_angvel(rb, scale(norm(axis), jsmath::min(TURN_RATE, angle * 5.0)), true);
        }
        if hopping {
            let v = phys.linvel(rb);
            phys.set_linvel(rb, v3(v.x * 0.5, jsmath::max(v.y, HOP_SPEED), v.z * 0.5), true);
        }
        return true;
    }
    if up.y >= FLIPPED_UP_Y {
        bot.flipped_for = 0.0;
        return false;
    }
    if len(phys.linvel(rb)) < STILL_SPEED {
        bot.flipped_for += dt;
    }
    if bot.flipped_for >= RIGHTING_DELAY {
        bot.righting = RIGHTING_TIME;
    }
    false
}

/// Un pas du robot `b`, piloté au sol (`thinkBot` puis `thinkPlayer`, sans tourelle qui vise : le
/// point visé est absent), puis son énergie (`settleEnergy`). Hors de combat (cockpit détruit), il
/// ne conduit plus : ses roues passent en roue libre.
pub fn think(sim: &mut Sim, b: usize) {
    let gravity = sim.gravity;
    let ck_rb = if sim.bots[b].cockpit_alive() { Some(sim.part(sim.bots[b].cockpit_part()).rb) } else { None };
    let bot = &mut sim.bots[b];
    let phys = &mut sim.phys;
    match ck_rb {
        None => drive(phys, bot, None, 0.0, 0.0, false, false, 0.0, gravity),
        Some(rb) => {
            if update_righting(phys, bot, rb, STEP) {
                drive(phys, bot, ck_rb, 0.0, 0.0, false, false, 0.0, gravity);
            } else {
                let input = bot.input;
                let brake = clamp(input.brake, 0.0, 1.0);
                drive(phys, bot, ck_rb, input.throttle, input.steer, input.boost, input.boost, brake, gravity);
            }
        }
    }
    let gain = GENERATOR_POWER - sim.bots[b].drawn;
    let capacity = energy_capacity(sim, b);
    let bot = &mut sim.bots[b];
    bot.energy = clamp(bot.energy + gain * STEP, 0.0, capacity);
    bot.drawn = 0.0;
}
