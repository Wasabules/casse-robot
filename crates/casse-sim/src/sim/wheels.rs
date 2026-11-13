//! Les roues par lancer de rayon (src/shared/robot/wheels.ts) : une roue montée n'a ni corps ni
//! liaison ; à chaque pas, un rayon part du haut de sa suspension ; s'il touche le sol ou le décor
//! fixe, un ressort-amortisseur (implicite) pousse le morceau, et le pneu y exerce la traction de son
//! moteur et son adhérence latérale, dans la limite de son cercle d'adhérence. Les roues d'un morceau
//! sont résolues l'une après l'autre, comme les contraintes d'un solveur, et leurs poussées données
//! à Rapier en une fois. Mêmes opérations, dans le même ordre, que le TypeScript.

use super::catalog::WheelDef;
use super::melee::vibration;
use super::physics::{ColliderDesc, Physics, ShapeDesc, groups};
use super::robot::Wheel;
use super::vec::{NO_ROTATION, Q, V3, add, axis_angle, clamp, cross, dot, norm, qmul, qrot, qrot_inv, scale, sub, v3};
use super::world::{STEP, Sim};
use crate::det::{dcos, dsin};
use crate::jsmath;
use rapier3d::prelude::RigidBodyHandle;

/// Adhérence latérale : le glissement de côté est rattrapé en 1 / LATERAL_GAIN s.
const LATERAL_GAIN: f64 = 12.0;
/// Force d'appui maximale, en multiple du poids nominal de la roue.
const MAX_LOAD: f64 = 4.0;
/// Raideur de la butée, en multiple de celle de la suspension.
const BUMP_STIFFNESS: f64 = 8.0;
/// Un rayon qui touche à moins de cette distance est parti de l'intérieur d'un obstacle.
const INSIDE: f64 = 1e-3;
/// En l'air, la roue rejoint la vitesse de son moteur à ce rythme (1/s).
const SPIN_RESPONSE: f64 = 3.0;
/// Roulette : vitesse en deçà de laquelle elle ne pivote plus (m/s), vitesse de pivotement maximale (rad/s).
const SWIVEL_MIN_SPEED: f64 = 0.05;
const SWIVEL_RATE: f64 = 14.0;
/// Constantes de src/shared/config.ts.
const FREEWHEEL_DRAG: f64 = 0.5;
const LOOSE_STEER_GRIP: f64 = 0.5;
const CASTER_SIDE_GRIP: f64 = 0.1;
/// Une vibration entière (balourd d'une arme de contact) retire cette part de l'adhérence des roues.
const VIBRATION_GRIP: f64 = 0.3;
/// Le cylindre de Rapier est vertical : on le couche sur l'essieu (x).
const WHEEL_ROTATION: Q = Q { x: 0.0, y: 0.0, z: std::f64::consts::FRAC_1_SQRT_2, w: std::f64::consts::FRAC_1_SQRT_2 };
const UP: V3 = v3(0.0, 1.0, 0.0);
const AXLE: V3 = v3(1.0, 0.0, 0.0);

/// Pose calculée d'une roue montée (ou de son porte-moyeu) : on la lit comme celle d'un corps.
#[derive(Clone, Copy, Debug)]
pub struct WheelPose {
    pub pos: V3,
    pub rot: Q,
    pub vel: V3,
    pub ang: V3,
}

impl Default for WheelPose {
    fn default() -> Self {
        WheelPose { pos: v3(0.0, 0.0, 0.0), rot: NO_ROTATION, vel: v3(0.0, 0.0, 0.0), ang: v3(0.0, 0.0, 0.0) }
    }
}

/// Réglage du ressort d'une suspension (`springTuning`, catalog/wheels.ts).
struct Spring {
    stiffness: f64,
    damping: f64,
    rest: f64,
}

fn spring_of(def: &WheelDef, gravity: f64) -> Spring {
    let omega = 2.0 * std::f64::consts::PI * def.frequency;
    let stiffness = def.rated_load * omega * omega;
    Spring { stiffness, damping: 2.0 * def.damping_ratio * (stiffness * def.rated_load).sqrt(), rest: -gravity / (omega * omega) }
}

/// Collider de la roue, couché sur l'essieu, de la masse de la roue (`wheelCollider`).
pub fn wheel_collider(def: &WheelDef, grip: f64) -> ColliderDesc {
    ColliderDesc {
        rotation: WHEEL_ROTATION,
        density: def.mass / (std::f64::consts::PI * def.radius * def.radius * def.width),
        friction: grip,
        restitution: 0.0,
        ..ColliderDesc::new(ShapeDesc::Cylinder(def.width / 2.0, def.radius))
    }
}

fn lateral_grip(w: &Wheel) -> f64 {
    let def = &w.def;
    if def.caster.is_some() {
        return def.grip * CASTER_SIDE_GRIP;
    }
    if w.steerable && !w.powered { LOOSE_STEER_GRIP } else { def.grip }
}

/// Une roulette pivote vers la vitesse `v` de son point de contact (repère du robot) (`swivel`).
fn swivel(w: &mut Wheel, trail: f64, v: V3) {
    let speed = jsmath::hypot2(v.x, v.z);
    if speed < SWIVEL_MIN_SPEED {
        return;
    }
    let heading = v.x.atan2(v.z);
    let gap = dsin(heading - w.steer).atan2(dcos(heading - w.steer));
    let step = clamp(gap * jsmath::min(1.0, (speed * STEP) / trail), -SWIVEL_RATE * STEP, SWIVEL_RATE * STEP);
    w.steer = dsin(w.steer + step).atan2(dcos(w.steer + step));
}

/// L'état du morceau qui porte les roues, lu une fois par pas (`Carrier`).
struct Carrier {
    q: Q,
    pos: V3,
    vel: V3,
    ang: V3,
    com: V3,
    up: V3,
    share: f64,
}

fn carrier_of(phys: &Physics, rb: RigidBodyHandle, wheels: usize) -> Carrier {
    let q = phys.rotation(rb);
    Carrier {
        q,
        pos: phys.translation(rb),
        vel: phys.linvel(rb),
        ang: phys.angvel(rb),
        com: phys.world_com(rb),
        up: qrot(q, UP),
        share: phys.mass(rb) / wheels as f64,
    }
}

/// Un morceau que ses roues poussent (`Pushed`).
struct Pushed {
    c: Carrier,
    inv_mass: f64,
    inv_inertia: [f64; 6],
    lin: V3,
    torque: V3,
    grip: f64,
}

fn mul_sym(m: &[f64; 6], u: V3) -> V3 {
    v3(m[0] * u.x + m[1] * u.y + m[2] * u.z, m[1] * u.x + m[3] * u.y + m[4] * u.z, m[2] * u.x + m[4] * u.y + m[5] * u.z)
}

/// Inverse de la masse effective du morceau en `r` (depuis son centre de masse), dans la direction `dir`.
fn inverse_mass(p: &Pushed, r: V3, dir: V3) -> f64 {
    let u = cross(r, dir);
    p.inv_mass + dot(u, mul_sym(&p.inv_inertia, u))
}

/// Les roues montées, par morceau (`mountedWheels`) : les robots dans l'ordre de leur premier
/// morceau dans `sim.parts`, et pour chacun ses roues dans l'ordre, groupées par morceau (dans
/// l'ordre de la première roue de chacun). Morceau, robot, roues.
fn mounted_wheels(sim: &Sim) -> Vec<(usize, usize, Vec<usize>)> {
    let mut groups: Vec<(usize, usize, Vec<usize>)> = Vec::new();
    let mut seen: Vec<usize> = Vec::new();
    for &p in &sim.order {
        let b = sim.part(p).bot;
        if seen.contains(&b) {
            continue;
        }
        seen.push(b);
        for (i, w) in sim.bots[b].wheels.iter().enumerate() {
            let Some(wp) = w.part else { continue };
            match groups.iter_mut().find(|g| g.0 == wp) {
                Some(g) => g.2.push(i),
                None => groups.push((wp, b, vec![i])),
            }
        }
    }
    groups
}

/// Un pas des roues montées de tous les robots (`stepWheels`) : suspension, traction, adhérence,
/// puis leur rotation ; les roues d'un morceau l'une après l'autre.
pub fn step_wheels(sim: &mut Sim) {
    let gravity = sim.gravity;
    for (part, bot, wheels) in mounted_wheels(sim) {
        let rb = sim.part(part).rb;
        // (le balourd d'une arme de contact secoue les pneus, melee.rs)
        let grip = if sim.bots[bot].melee.is_empty() { 1.0 } else { 1.0 - VIBRATION_GRIP * vibration(sim, bot) };
        let phys = &mut sim.phys;
        let inv_inertia = phys.effective_world_inv_inertia(rb);
        let mut p = Pushed {
            c: carrier_of(phys, rb, wheels.len()),
            inv_inertia,
            inv_mass: phys.inv_mass(rb),
            lin: v3(0.0, 0.0, 0.0),
            torque: v3(0.0, 0.0, 0.0),
            grip,
        };
        for w in wheels {
            step_wheel(phys, &mut sim.bots[bot].wheels[w], &mut p, gravity);
        }
        // (`if (c.lin.x || c.lin.y || c.lin.z)` : un nombre non nul, et pas NaN)
        let truthy = |x: f64| x != 0.0 && !x.is_nan();
        if truthy(p.lin.x) || truthy(p.lin.y) || truthy(p.lin.z) {
            phys.apply_impulse(rb, p.lin, true);
            phys.apply_torque_impulse(rb, p.torque, true);
        }
    }
}

fn step_wheel(phys: &Physics, w: &mut Wheel, p: &mut Pushed, gravity: f64) {
    let def = w.def.clone();
    let (q, up) = (p.c.q, p.c.up);
    let down = scale(up, -1.0);
    let (travel_up, travel_down) = (def.travel_up, def.travel_down);
    let top = add(add(p.c.pos, qrot(q, w.local)), scale(up, travel_up));
    let cast = phys.cast_ray_and_get_normal(top, down, travel_up + travel_down + def.radius, true, groups::GROUND_RAY);
    let hit = cast.filter(|c| c.time_of_impact > INSIDE);
    let raw = match &hit {
        Some(h) => travel_up - (h.time_of_impact - def.radius),
        None => -travel_down,
    };
    let travel = clamp(raw, -travel_down, travel_up);
    w.travel = travel;

    match hit {
        None => {
            w.load = 0.0;
            let target = if w.engaged { w.drive * def.free_speed } else { 0.0 };
            w.spin_rate += (target - w.spin_rate) * (1.0 - (-SPIN_RESPONSE * STEP).exp());
        }
        Some(hit) => {
            let contact = add(top, scale(down, hit.time_of_impact));
            let r = sub(contact, p.c.com);
            let vp = add(p.c.vel, cross(p.c.ang, r));

            let spring = spring_of(&def, gravity);
            let bump_stiffness = if raw > travel_up { BUMP_STIFFNESS * spring.stiffness } else { 0.0 };
            let held = spring.stiffness * (travel - spring.rest) + def.mass * gravity + bump_stiffness * (raw - travel_up);
            let give = (spring.stiffness + bump_stiffness) * STEP + spring.damping;
            let load = clamp(
                (held + give * dot(vp, down)) / (1.0 + give * STEP * inverse_mass(p, r, up)),
                0.0,
                MAX_LOAD * (def.rated_load + def.mass) * gravity,
            );
            w.load = load;

            if let Some(trail) = def.caster {
                swivel(w, trail, qrot_inv(q, vp));
            }
            let n = norm(hit.normal);
            let wheel_rot = qmul(q, axis_angle(UP, w.steer));
            let forward = qrot(wheel_rot, v3(0.0, 0.0, 1.0));
            let lateral = qrot(wheel_rot, AXLE);
            let fwd = norm(sub(forward, scale(n, dot(forward, n))));
            let lat = norm(sub(lateral, scale(n, dot(lateral, n))));
            let v_long = dot(vp, fwd);
            let v_lat = dot(vp, lat);

            let omega = v_long / def.radius;
            let mut torque = if w.engaged && def.stall_torque > 0.0 {
                clamp(def.stall_torque * (w.drive - omega / def.free_speed), -def.stall_torque, def.stall_torque)
            } else {
                -FREEWHEEL_DRAG * omega
            };
            if w.overrun && !(torque * w.drive > 0.0) {
                torque = -FREEWHEEL_DRAG * omega;
            }
            let mut f_long = torque / def.radius;
            if w.brake > 0.0 {
                let cap = w.brake * def.grip * load;
                f_long = clamp(-v_long / (STEP * inverse_mass(p, r, fwd)), -cap, cap);
            }
            let lateral_gain = p.c.share * LATERAL_GAIN * (lateral_grip(w) / def.grip);
            let mut f_lat = -v_lat * lateral_gain / (1.0 + lateral_gain * STEP * inverse_mass(p, r, lat));
            let demand = jsmath::hypot2(f_long, f_lat);
            let limit = def.grip * load * p.grip;
            if demand > limit {
                f_long *= limit / demand;
                f_lat *= limit / demand;
            }

            let impulse = scale(add(add(scale(up, load), scale(fwd, f_long)), scale(lat, f_lat)), STEP);
            let torque_impulse = cross(r, impulse);
            p.lin = add(p.lin, impulse);
            p.torque = add(p.torque, torque_impulse);
            p.c.vel = add(p.c.vel, scale(impulse, p.inv_mass));
            p.c.ang = add(p.c.ang, mul_sym(&p.inv_inertia, torque_impulse));
            w.spin_rate = omega;
        }
    }
    w.spin = (w.spin + w.spin_rate * STEP) % (2.0 * std::f64::consts::PI);
}

/// Pose d'une roue montée et de son porte-moyeu, d'après la pose de son morceau (`placeOn`) ; rien
/// pour une roue arrachée (sa pose est celle de son corps) ou retirée (une pose figée).
fn place_on(w: &mut Wheel, c: &Carrier) {
    if w.body.is_some() || w.frozen || w.hub.is_none() {
        return;
    }
    let q = c.q;
    let center = add(c.pos, qrot(q, add(w.local, v3(0.0, w.travel, 0.0))));
    let hub_rot = qmul(q, axis_angle(UP, w.steer));
    let vel = add(c.vel, cross(c.ang, sub(center, c.com)));
    let ang = c.ang;
    w.hub = Some(WheelPose { pos: center, rot: hub_rot, vel, ang });
    w.rb = WheelPose { pos: center, rot: qmul(hub_rot, axis_angle(AXLE, w.spin)), vel, ang: add(ang, scale(qrot(hub_rot, AXLE), w.spin_rate)) };
}

/// Pose d'une roue qu'on vient de monter sur le morceau de corps `rb` (`placeWheel`).
pub fn place_wheel(phys: &Physics, rb: RigidBodyHandle, w: &mut Wheel) {
    place_on(w, &carrier_of(phys, rb, 1));
}

/// Pose de toutes les roues montées, une fois les morceaux déplacés par la physique (`placeWheels`).
pub fn place_wheels(sim: &mut Sim) {
    for (part, bot, wheels) in mounted_wheels(sim) {
        let c = carrier_of(&sim.phys, sim.part(part).rb, wheels.len());
        for w in wheels {
            place_on(&mut sim.bots[bot].wheels[w], &c);
        }
    }
}
