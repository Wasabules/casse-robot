//! La conduite d'un robot : `thinkBot` (src/shared/ai/brain.ts : le pilote, `thinkPlayer` de
//! src/shared/sim/player.ts, au sol, en vol stationnaire ou en avion ; ou l'IA, brain.rs), `drive` et
//! `driveWheels` (src/shared/robot/propulsion.ts : les roues, puis les appuis, supports.rs ; le boost
//! et le sprint), la géométrie de direction et la stabilité au freinage (src/shared/robot/steering.ts),
//! le redressement (src/shared/robot/righting.ts) et l'énergie (src/shared/robot/energy.ts). Seules
//! les roues du morceau du cockpit sont motorisées et dirigées ; un robot hors de combat ne conduit
//! plus.

use super::player::{camera_drive, operate_player_turrets};
use super::arena::{flight_level, ground_level};
use super::brain::{Mode, think_flying, think_ground};
use super::catalog::Mobility;
use super::decoys::{launch_flares, think_flares};
use super::brawl::{operate_melee, operate_player_melee};
use super::emp::{cut_power, cut_stunned_organs, is_stunned};
use super::gunner::operate_turrets;
use super::lifecycle::energy_capacity;
use super::mines::detonate_mines;
use super::propulsion::{Yaw, fly_toward, idle_thrusters, run_engines, wear_engines};
use super::supports::drive_supports;
use super::projectiles::piloted_warhead;
use super::physics::Physics;
use super::pilot::{MouseFlight, fly_manual, fly_mouse, hold_plane, think_plane};
use super::robot::{Bot, Input, Wheel};
use super::vec::{V3, add, clamp, cross, dot, len, norm, qrot, qrot_inv, scale, sub, v3};
use super::world::{STEP, Sim};
use crate::det::{dcos, dsin};
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
pub const FLIPPED_UP_Y: f64 = 0.55;
const RIGHTING_DELAY: f64 = 3.0;
const STILL_SPEED: f64 = 1.5;
pub const RIGHTING_TIME: f64 = 2.0;
const HOP_TIME: f64 = 0.15;
const HOP_SPEED: f64 = 3.0;
const TURN_RATE: f64 = 4.0;
const UPRIGHT_Y: f64 = 0.92;
/// Robot volant piloté (sim/player.ts) : vitesse de montée et de descente (m/s), altitudes permises
/// (m), avance au plus de l'altitude visée (m), distance du point vers lequel il vole (m) ; à la
/// caméra, il se tourne vers où elle regarde (rad/s par radian d'écart, au plus HOVER_YAW_RATE), aidé
/// du gyroscope d'autant plus qu'il en est loin (tout à FACE_ASSIST rad), et encore HOVER_YAW_FADE s
/// après le lacet lâché.
const CLIMB_RATE: f64 = 3.0;
const MIN_ALT: f64 = 2.0;
const MAX_ALT: f64 = 18.0;
const CLIMB_LEAD: f64 = 3.0;
const FLY_REACH: f64 = 15.0;
const FACE_GAIN: f64 = 2.5;
const FACE_ASSIST: f64 = 0.5;
const HOVER_YAW_RATE: f64 = 1.4;
const HOVER_YAW_FADE: f64 = 1.0;
/// Délai après le tir avant qu'un clic puisse faire exploser une ogive pilotée (s).
const DETONATE_AFTER: f64 = 0.4;
const UP: V3 = v3(0.0, 1.0, 0.0);

/// Centre de masse du morceau du cockpit, dans le repère du robot (`localCom`).
pub fn local_com(phys: &Physics, rb: RigidBodyHandle) -> V3 {
    qrot_inv(phys.rotation(rb), sub(phys.world_com(rb), phys.translation(rb)))
}

/// Roues montées sur le morceau du cockpit : les seules qui sont motorisées (`drivenWheels`).
pub fn driven_wheels(bot: &Bot) -> Vec<&Wheel> {
    if !bot.cockpit_alive() {
        return Vec::new();
    }
    let ck = bot.cockpit_part();
    bot.wheels.iter().filter(|w| w.hub.is_some() && w.part == Some(ck)).collect()
}

/// Géométrie de direction (`steeringGeometry`) : la ligne du centre de rotation et la courbure
/// maximale (0 : pas de roue directrice alimentée, conduite différentielle).
pub struct Geometry {
    pivot_z: f64,
    pub max_curvature: f64,
}

pub fn steering_geometry(phys: &Physics, bot: &Bot, ck_rb: Option<RigidBodyHandle>) -> Geometry {
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
pub fn supply(bot: &Bot, demand: f64) -> f64 {
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

/// Conduite au sol, tous organes confondus (`drive`) : roues (et chenilles), puis appuis (patins,
/// pattes) ; `boost` : roue libre à cliquet ; `sprint` : surtension des moteurs ; `brake` : le frein.
#[allow(clippy::too_many_arguments)]
pub fn drive(sim: &mut Sim, b: usize, throttle: f64, steer: f64, boost: bool, sprint: bool, brake: f64) {
    let gravity = sim.gravity;
    let ck_rb = if sim.bots[b].cockpit_alive() { Some(sim.part(sim.bots[b].cockpit_part()).rb) } else { None };
    let brake = clamp(brake, 0.0, 1.0);
    let boost = boost && brake == 0.0;
    let bot = &mut sim.bots[b];
    let sprint = if sprint && brake == 0.0 && throttle != 0.0 && bot.cockpit_alive() { sprint_factor(bot) } else { 1.0 };
    drive_wheels(&sim.phys, &mut sim.bots[b], ck_rb, throttle, steer, boost, sprint, brake, gravity);
    drive_supports(sim, b, throttle, steer, true, boost, sprint, brake);
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

/// Un pas du robot piloté (`thinkPlayer`) : ses mines télécommandées sautent tant qu'il tient la
/// touche, ses lance-leurres tirent ; son ogive pilotée en vol, il la dirige (son robot s'arrête, un
/// avion tourne sur le circuit, `holdPlane`), et un nouveau clic la fait exploser ; au sol, il conduit
/// (à la caméra, ou en char ; le boost : propulseurs à fond, moteurs des roues et des appuis au sprint ;
/// le frein prime) ; puis ses tourelles (`operatePlayerTurrets`, player.rs) et ses armes de contact
/// (`operatePlayerMelee`, brawl.rs).
fn think_player(sim: &mut Sim, b: usize, rb: RigidBodyHandle) {
    if sim.bots[b].input.detonate {
        detonate_mines(sim, b);
    }
    if sim.bots[b].input.flares {
        launch_flares(sim, b);
    }
    // Son ogive pilotée en vol : un nouveau clic (gâchette relâchée depuis le tir) la fait exploser
    let warhead = piloted_warhead(sim, b);
    let trigger = sim.bots[b].input.trigger;
    if let Some(i) = warhead
        && trigger
        && !sim.bots[b].trigger_held
        && sim.projectiles[i].age > DETONATE_AFTER
    {
        // (`fuseNow` : elle éclate au pas suivant, là où elle est, comme en fin de course)
        sim.projectiles[i].age = f64::INFINITY;
    }
    sim.bots[b].trigger_held = trigger;
    let mut input = sim.bots[b].input;
    // (pendant son vol, son robot s'arrête et ses tourelles ne visent plus)
    if warhead.is_some() {
        input = Input { throttle: 0.0, steer: 0.0, climb: 0.0, yaw: 0.0, boost: false, brake: 1.0, trigger: false, aim: None, ..input };
    }
    // (le mode de son IA dit seulement s'il est renversé ; un avion s'incline en virage sans l'être)
    let mobility = sim.bots[b].mobility;
    let up = qrot(sim.phys.rotation(rb), UP);
    if mobility != Mobility::Plane {
        sim.bots[b].ai.mode = if up.y < FLIPPED_UP_Y { Mode::Flipped } else { Mode::Patrol };
    }
    let brake = clamp(input.brake, 0.0, 1.0);
    match mobility {
        Mobility::Ground => {
            let (throttle, steer) = if input.relative { camera_drive(sim, b, &input) } else { (input.throttle, input.steer) };
            drive(sim, b, throttle, steer, input.boost, input.boost, brake);
            run_engines(sim, b, if input.boost && brake == 0.0 { 1.0 } else { 0.0 });
        }
        Mobility::Hover => {
            let pos = sim.phys.world_com(rb);
            // Monter, descendre tant qu'on tient la touche : l'altitude visée file devant lui, sans plus
            // de CLIMB_LEAD m d'avance ; relâchée, il s'arrête aussitôt
            if input.climb.abs() > 0.05 {
                let height = pos.y - ground_level(sim, pos.x, pos.z);
                let next = clamp(sim.bots[b].ai.alt + input.climb * CLIMB_RATE * STEP, height - CLIMB_LEAD, height + CLIMB_LEAD);
                sim.bots[b].ai.alt = clamp(next, MIN_ALT, MAX_ALT);
            }
            let forward = v3(dsin(input.heading), 0.0, dcos(input.heading));
            let left = v3(forward.z, 0.0, -forward.x);
            // Le frein l'arrête sur place (il ne vole plus vers où on le pousse)
            let go = 1.0 - brake;
            let target = add(pos, scale(add(scale(forward, input.throttle * go), scale(left, input.steer * go)), FLY_REACH));
            // Le lacet : il pivote sur place, à plat ; à la caméra, sans lacet, il se tourne vers où
            // elle regarde (le lacet tenu passe avant)
            let mut yaw = clamp(input.yaw, -1.0, 1.0);
            let mut assist = yaw.abs();
            if input.relative && assist < 0.05 {
                let nose = qrot(sim.phys.rotation(rb), v3(0.0, 0.0, 1.0));
                let a = input.heading - nose.x.atan2(nose.z);
                let gap = dsin(a).atan2(dcos(a));
                yaw = clamp((gap * FACE_GAIN) / HOVER_YAW_RATE, -1.0, 1.0);
                assist = clamp(gap.abs() / FACE_ASSIST, 0.0, 1.0);
            }
            let ai = &mut sim.bots[b].ai;
            ai.slip = jsmath::max(assist, ai.slip - STEP / HOVER_YAW_FADE);
            let slip = ai.slip;
            let alt = ai.alt;
            let level = flight_level(sim, pos, target, alt);
            fly_toward(sim, b, v3(target.x, level, target.z), Some(Yaw { rate: yaw * HOVER_YAW_RATE, assist: slip }));
        }
        // Le pilote automatique, pendant le vol de l'ogive ; manuel : le manche (tangage, roulis,
        // palonnier) ; sinon, il va là où regarde le pilote. Les gaz à part
        Mobility::Plane => {
            if warhead.is_some() {
                hold_plane(sim, b);
            } else if input.manual {
                fly_manual(sim, b, input.climb, -input.steer, input.yaw, input.power);
            } else {
                let command = MouseFlight { look: input.look, turn: input.steer, pitch: input.climb, yaw: input.yaw, power: input.power };
                fly_mouse(sim, b, &command);
            }
        }
    }
    operate_player_turrets(sim, b, &input);
    operate_player_melee(sim, b, &input);
}

/// Un pas du robot `b` (`thinkBot`), puis son énergie (`settleEnergy`). Hors de combat (cockpit
/// détruit), il ne conduit plus : ses roues passent en roue libre. Paralysé (emp.rs), son électronique
/// est coupée : roue libre, direction lâche, rien d'autre (ni conduite, ni tourelles, ni leurres), et
/// son générateur ne recharge pas ses batteries. Renversé, son gyroscope le redresse. Sinon, piloté
/// (`thinkPlayer` : sa conduite, ses tourelles qui visent et tirent, son ogive, ses leurres, ses mines
/// télécommandées, ses armes de contact), ou conduit par l'IA (brain.rs, `thinkGround`, puis ses tourelles et
/// ses armes de contact), et ses roues paralysées localement n'obéissent pas. Sa position (`lastPos`) est
/// relevée à chaque pas où il est vivant : la détection et la réaction aux coups la lisent.
pub fn think(sim: &mut Sim, b: usize) {
    // L'usure de ses moteurs et leurs ratés (`wearEngines`), avant ses décisions
    if !sim.bots[b].thrusters.is_empty() {
        wear_engines(sim, b);
    }
    let ck_rb = if sim.bots[b].cockpit_alive() { Some(sim.part(sim.bots[b].cockpit_part()).rb) } else { None };
    match ck_rb {
        None => {
            sim.bots[b].ai.mode = Mode::Dead;
            drive(sim, b, 0.0, 0.0, false, false, 0.0);
        }
        Some(_) if is_stunned(sim, b) => {
            let pos = sim.phys.world_com(ck_rb.expect("cockpit vivant"));
            let bot = &mut sim.bots[b];
            bot.last_pos = pos;
            bot.ai.mode = Mode::Stunned;
            cut_power(sim, b);
        }
        Some(rb) => {
            let pos = sim.phys.world_com(rb);
            sim.bots[b].last_pos = pos;
            if sim.bots[b].ai.mode == Mode::Stunned {
                sim.bots[b].ai.mode = Mode::Patrol;
            }
            // Renversé : le gyroscope du cockpit le redresse (un avion, lui, n'en a pas)
            let plane = sim.bots[b].mobility == Mobility::Plane;
            if !plane && update_righting(&mut sim.phys, &mut sim.bots[b], rb, STEP) {
                sim.bots[b].ai.mode = Mode::Flipped;
                drive(sim, b, 0.0, 0.0, false, false, 0.0);
                idle_thrusters(sim, b);
            } else if sim.bots[b].piloted {
                think_player(sim, b, rb);
            } else {
                // Un missile ennemi arrive : leurres (pas quand l'IA est figée)
                let paused = sim.ai_paused;
                if !paused {
                    think_flares(sim, b);
                }
                match sim.bots[b].mobility {
                    Mobility::Ground => {
                        let gas = think_ground(sim, b, pos);
                        run_engines(sim, b, gas);
                    }
                    Mobility::Hover => think_flying(sim, b, pos),
                    // (un avion ne peut pas s'arrêter en l'air)
                    Mobility::Plane => think_plane(sim, b),
                }
                // Ses tourelles (`operateTurrets`), au combat seulement
                if !paused && sim.combat && !sim.bots[b].turrets.is_empty() {
                    operate_turrets(sim, b, STEP);
                }
                // Ses armes de contact : lancer les rotors, frapper (`operateMelee`, brawl.rs)
                if !paused && sim.combat && !sim.bots[b].melee.is_empty() {
                    operate_melee(sim, b);
                }
            }
        }
    }
    // Paralysie locale (lance électrique) : les roues coupées n'obéissent pas aux commandes
    cut_stunned_organs(sim, b);
    // (paralysé, son générateur ne recharge pas ses batteries)
    let gain = (if is_stunned(sim, b) { 0.0 } else { GENERATOR_POWER }) - sim.bots[b].drawn;
    let capacity = energy_capacity(sim, b);
    let bot = &mut sim.bots[b];
    bot.energy = clamp(bot.energy + gain * STEP, 0.0, capacity);
    bot.drawn = 0.0;
}
