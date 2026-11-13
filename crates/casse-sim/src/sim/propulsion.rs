//! Les moteurs (src/shared/robot/propulsion.ts, robot/lifecycle.ts) : réacteurs, propulseurs, rotors,
//! hélice d'avion, turboréacteur. Leur recensement d'après le plan (`addThrusters` : les rotors de
//! sustentation d'abord, en sens alternés autour de leur centre, puis les autres), leur usure et leurs
//! ratés (`wearEngines`), les gaz des propulseurs (`runEngines`) et le moteur qui rattrape sa consigne
//! puis pousse son bloc, avec le couple de réaction de son hélice (`runMotor`), les moteurs coupés
//! (`idleThrusters`).
//!
//! L'électricité qu'ils consomment est décomptée des batteries (`bot.drawn`, drive.rs) ; batteries
//! vides, ils n'ont que ce que produit le générateur (`supply`).

use super::catalog::{Design, ThrusterSpec, axis, catalog};
use super::debris::block_world_pos;
use super::drive::supply;
use super::robot::{Role, Thruster};
use super::vec::{V3, add, clamp, cross, dot, len, norm, qrot, scale, sub, v3};
use super::linalg::bounded_least_squares;
use super::world::{STEP, Sim};
use crate::det::{dcos, dpow, dsin};
use crate::jsmath;

/// Temps de réponse de l'inclinaison d'un rotor orientable (s).
const TILT_TIME: f64 = 0.06;
/// Inclinaison maximale en vol (rad).
const MAX_TILT: f64 = 0.42;
/// Pilote automatique : raideur et amortissement de l'assiette (1/s², 1/s), amortissement du lacet
/// (1/s), plus fort avec un rotor de queue ; part de la poussée que le lacet peut déséquilibrer entre
/// les hélices ; priorités de la répartition (l'assiette, la poussée, le lacet).
const ATTITUDE_KP: f64 = 30.0;
const ATTITUDE_KD: f64 = 9.0;
const YAW_KD: f64 = 1.0;
const YAW_KD_TAIL: f64 = 4.0;
const WEIGHT_YAW_TAIL: f64 = 0.5;
const YAW_SHARE: f64 = 0.12;
const WEIGHT_ATTITUDE: f64 = 10.0;
const WEIGHT_THRUST: f64 = 1.0;
const WEIGHT_YAW: f64 = 0.001;
/// Lacet piloté par le joueur : raideur (1/s), part de la poussée, priorité.
const YAW_KP_PILOT: f64 = 3.0;
const YAW_SHARE_PILOT: f64 = 0.35;
const WEIGHT_YAW_PILOT: f64 = 0.5;
/// Gyroscope de lacet du cockpit (robot volant piloté) : raideur (1/s), accélération angulaire au
/// plus (rad/s²).
const GYRO_KP: f64 = 4.0;
const GYRO_ACCEL: f64 = 3.0;
/// Usure d'un moteur : sous `ENGINE_WORN` de ses points de structure, il perd de sa poussée, jusqu'à
/// `WORN_OUTPUT` de sa pleine poussée à bout, et il a des ratés (par seconde, à bout ; leur durée, s).
pub const ENGINE_WORN: f64 = 0.5;
const WORN_OUTPUT: f64 = 0.6;
const MISFIRE_RATE: f64 = 0.8;
const MISFIRE_MIN: f64 = 0.18;
const MISFIRE_MAX: f64 = 0.5;

/// Le moteur d'un bloc (`specOf`).
pub fn spec_of(sim: &Sim, b: usize, t: usize) -> &'static ThrusterSpec {
    let block = sim.bots[b].thrusters[t].block;
    catalog().blocks[&sim.bots[b].blocks[block].kind].thruster.as_ref().expect("moteur sans réacteur")
}

/// Ordre, rôle et sens de rotation des moteurs d'un plan (`thrusterPlan`) : les rotors de
/// sustentation (qui poussent vers le haut) triés par l'angle autour de leur centre, en sens alternés,
/// puis les autres (vers l'avant : propulsion ; sinon : rotor de queue, réacteur de côté). Chacun : le
/// rang de son bloc dans le plan, son rôle, son sens.
fn thruster_plan(design: &Design) -> Vec<(usize, Role, f64)> {
    let c = catalog();
    // (`AXES[facing.up]`)
    let engines: Vec<(usize, f64, f64, [f64; 3])> = design
        .blocks
        .iter()
        .enumerate()
        .filter(|(_, b)| c.blocks.get(&b.kind).is_some_and(|d| d.thruster.is_some()))
        .map(|(i, b)| (i, b.x, b.z, axis(&b.up).unwrap_or([0.0, 1.0, 0.0])))
        .collect();
    let mut lift: Vec<&(usize, f64, f64, [f64; 3])> = engines.iter().filter(|e| e.3[1] > 0.7).collect();
    // (`lift.length || 1`)
    let n = if lift.is_empty() { 1.0 } else { lift.len() as f64 };
    let cx = lift.iter().fold(0.0, |s, e| s + e.1) / n;
    let cz = lift.iter().fold(0.0, |s, e| s + e.2) / n;
    let angle = |e: &(usize, f64, f64, [f64; 3])| (e.2 - cz).atan2(e.1 - cx);
    // (le tri de V8 est stable, comme `sort_by`)
    lift.sort_by(|a, b| (angle(a) - angle(b)).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut plan: Vec<(usize, Role, f64)> = lift.iter().enumerate().map(|(i, e)| (e.0, Role::Lift, if i % 2 == 0 { 1.0 } else { -1.0 })).collect();
    for e in engines.iter().filter(|e| e.3[1] <= 0.7) {
        plan.push((e.0, if e.3[2] > 0.7 { Role::Cruise } else { Role::Trim }, 1.0));
    }
    plan
}

/// Recense les moteurs d'un robot qui vient de naître (`addThrusters`) : ses blocs sont dans l'ordre
/// du plan, tous vivants.
pub fn add_thrusters(sim: &mut Sim, b: usize, design: &Design) {
    for (block, role, spin) in thruster_plan(design) {
        sim.bots[b].thrusters.push(Thruster { block, role, spin, thrust: 0.0, tilt_a: 0.0, tilt_b: 0.0, output: 1.0, misfire_until: 0.0 });
    }
}

/// Moteurs encore reliés au cockpit (les seuls alimentés), éventuellement d'un seul rôle
/// (`liveThrusters`) : leurs rangs dans `bot.thrusters`.
pub fn live_thrusters(sim: &Sim, b: usize, role: Option<Role>) -> Vec<usize> {
    let bot = &sim.bots[b];
    if !bot.cockpit_alive() {
        return Vec::new();
    }
    let ck = bot.cockpit_part();
    (0..bot.thrusters.len())
        .filter(|&i| {
            let t = &bot.thrusters[i];
            let k = &bot.blocks[t.block];
            k.alive && k.part == ck && role.is_none_or(|r| t.role == r)
        })
        .collect()
}

/// Un axe de poussée (`ThrustAxis`) : sa direction (monde), ses bornes (N), le couple autour du centre
/// de masse par newton de poussée, réaction de l'hélice comprise.
#[derive(Clone, Copy)]
pub struct ThrustAxis {
    pub dir: V3,
    pub lo: f64,
    pub hi: f64,
    pub torque: V3,
}

/// Un moteur vu du centre de masse (`ThrusterArm`) : son rang, son moteur, sa position, ses axes.
pub struct ThrusterArm {
    pub t: usize,
    pub spec: &'static ThrusterSpec,
    pub p: V3,
    pub axes: Vec<ThrustAxis>,
}

/// Les moteurs `thrusters` vus du centre de masse `com` (`thrusterArms`).
pub fn thruster_arms(sim: &Sim, b: usize, thrusters: &[usize], com: V3) -> Vec<ThrusterArm> {
    let bot = &sim.bots[b];
    thrusters
        .iter()
        .map(|&t| {
            let spec = spec_of(sim, b, t);
            let th = &bot.thrusters[t];
            let block = &bot.blocks[th.block];
            let p = block_world_pos(sim, b, th.block);
            let q = sim.phys.rotation(sim.part(block.part).rb);
            let r = sub(p, com);
            let axis = |local: V3, lo: f64, hi: f64, reaction: f64| {
                let dir = qrot(q, local);
                ThrustAxis { dir, lo, hi, torque: add(cross(r, dir), scale(dir, reaction)) }
            };
            // Un moteur abîmé ne donne qu'une part de sa pleine poussée (rien pendant un raté) : le pilote le sait
            let max = spec.max_thrust * th.output;
            let mut axes = vec![axis(block.up, 0.0, max, -th.spin * spec.torque_ratio)];
            // (`if (spec.gimbal)`)
            if let Some(g) = spec.gimbal
                && g != 0.0
            {
                let side = max * dsin(g);
                axes.push(axis(cross(block.up, block.forward), -side, side, 0.0));
                axes.push(axis(block.forward, -side, side, 0.0));
            }
            ThrusterArm { t, spec, p, axes }
        })
        .collect()
}

/// Part de sa poussée que garde une hélice quand l'air arrive à `axial` m/s le long de son axe
/// (`propellerFactor`) : toute à l'arrêt, rien à `top_speed`.
fn propeller_factor(top_speed: f64, axial: f64) -> f64 {
    clamp(1.0 - axial / top_speed, 0.0, 1.0)
}

/// Part de sa poussée que garde une hélice, selon la vitesse de l'air le long de son axe (1 pour un
/// autre moteur) (`propellerEfficiency`).
fn propeller_efficiency(sim: &Sim, b: usize, a: &ThrusterArm) -> f64 {
    // (`if (!top)`)
    let Some(top) = a.spec.top_speed.filter(|&t| t != 0.0) else { return 1.0 };
    let block = sim.bots[b].thrusters[a.t].block;
    let rb = sim.part(sim.bots[b].blocks[block].part).rb;
    let v = add(sim.phys.linvel(rb), cross(sim.phys.angvel(rb), sub(a.p, sim.phys.world_com(rb))));
    propeller_factor(top, dot(v, a.axes[0].dir))
}

/// Le moteur rattrape sa consigne (N, par axe) avec son temps de réponse, puis pousse le corps ; son
/// hélice renvoie un couple opposé (`runMotor`). Un rotor orientable ne s'incline pas au-delà de son
/// cône ; une hélice d'avion pousse d'autant moins que l'air arrive vite le long de son axe.
pub fn run_motor(sim: &mut Sim, b: usize, a: &ThrusterArm, command: &[f64]) {
    let spec = a.spec;
    let k = 1.0 - (-STEP / spec.spool_time).exp();
    let th = &mut sim.bots[b].thrusters[a.t];
    th.thrust += (command.first().copied().unwrap_or(0.0) - th.thrust) * k;
    let thrust = th.thrust;
    let mut force = scale(a.axes[0].dir, thrust * propeller_efficiency(sim, b, a));
    if a.axes.len() > 1 {
        let cone = jsmath::max(0.0, thrust) * spec.gimbal.unwrap_or(0.0).tan();
        let kt = 1.0 - (-STEP / TILT_TIME).exp();
        let th = &mut sim.bots[b].thrusters[a.t];
        th.tilt_a += (clamp(command.get(1).copied().unwrap_or(0.0), -cone, cone) - th.tilt_a) * kt;
        th.tilt_b += (clamp(command.get(2).copied().unwrap_or(0.0), -cone, cone) - th.tilt_b) * kt;
        force = add(force, add(scale(a.axes[1].dir, th.tilt_a), scale(a.axes[2].dir, th.tilt_b)));
    }
    let th = sim.bots[b].thrusters[a.t];
    let rb = sim.part(sim.bots[b].blocks[th.block].part).rb;
    sim.bots[b].drawn += (spec.power * len(force)) / spec.max_thrust;
    sim.phys.apply_impulse_at_point(rb, scale(force, STEP), a.p, true);
    // (`if (spec.torqueRatio)`)
    if spec.torque_ratio != 0.0 && !spec.torque_ratio.is_nan() {
        sim.phys.apply_torque_impulse(rb, scale(a.axes[0].dir, -th.spin * spec.torque_ratio * th.thrust * STEP), true);
    }
}

/// Gaz des propulseurs (de 0 à 1), dans la limite de l'énergie disponible (`runEngines`).
pub fn run_engines(sim: &mut Sim, b: usize, throttle: f64) {
    let engines = live_thrusters(sim, b, Some(Role::Cruise));
    if engines.is_empty() {
        return;
    }
    let com = sim.phys.world_com(sim.part(sim.bots[b].cockpit_part()).rb);
    let arms = thruster_arms(sim, b, &engines, com);
    let gas = clamp(throttle, 0.0, 1.0);
    let k = supply(&sim.bots[b], arms.iter().fold(0.0, |s, a| s + a.spec.power * gas));
    for a in &arms {
        run_motor(sim, b, a, &[gas * k * a.axes[0].hi]);
    }
}

/// Réacteurs et propulseurs coupés : leur poussée retombe à leur rythme (`idleThrusters`).
pub fn idle_thrusters(sim: &mut Sim, b: usize) {
    let engines = live_thrusters(sim, b, None);
    if engines.is_empty() {
        return;
    }
    let com = sim.phys.world_com(sim.part(sim.bots[b].cockpit_part()).rb);
    for a in thruster_arms(sim, b, &engines, com) {
        run_motor(sim, b, &a, &[]);
    }
}

/// État d'un bloc moteur : part de ses points de structure qui lui reste (`engineHealth`).
fn engine_health(sim: &Sim, b: usize, block: usize) -> f64 {
    let k = &sim.bots[b].blocks[block];
    clamp(k.hp / catalog().blocks[&k.kind].hp, 0.0, 1.0)
}

/// Une fois par pas et par robot : la poussée que peut donner chacun de ses moteurs, ses ratés
/// (`wearEngines`) ; paralysé localement (lance électrique, emp.rs), il ne pousse plus, comme pendant
/// un raté.
pub fn wear_engines(sim: &mut Sim, b: usize) {
    for i in 0..sim.bots[b].thrusters.len() {
        let block = sim.bots[b].thrusters[i].block;
        if sim.bots[b].blocks[block].stunned_until > sim.time {
            sim.bots[b].thrusters[i].output = 0.0;
            continue;
        }
        let health = engine_health(sim, b, block);
        if !sim.bots[b].blocks[block].alive || health >= ENGINE_WORN {
            sim.bots[b].thrusters[i].output = 1.0;
            continue;
        }
        let wear = (ENGINE_WORN - health) / ENGINE_WORN;
        let time = sim.time;
        if time >= sim.bots[b].thrusters[i].misfire_until && sim.rng.rand(0.0, 1.0) < MISFIRE_RATE * wear * STEP {
            sim.bots[b].thrusters[i].misfire_until = time + sim.rng.rand(MISFIRE_MIN, MISFIRE_MAX);
        }
        let t = &mut sim.bots[b].thrusters[i];
        t.output = if time < t.misfire_until { 0.0 } else { WORN_OUTPUT + (1.0 - WORN_OUTPUT) * (1.0 - wear) };
    }
}

/// Produit de la matrice d'inertie (symétrique, repère monde : m11, m12, m13, m22, m23, m33) par un
/// vecteur (`inertiaTimes`).
pub fn inertia_times(i: [f64; 6], v: V3) -> V3 {
    v3(i[0] * v.x + i[1] * v.y + i[2] * v.z, i[1] * v.x + i[3] * v.y + i[4] * v.z, i[2] * v.x + i[4] * v.y + i[5] * v.z)
}

/// Réacteurs que pilote le vol stationnaire : sustentation, et rotors de queue ou de côté (`hoverThrusters`).
fn hover_thrusters(sim: &Sim, b: usize) -> Vec<usize> {
    live_thrusters(sim, b, None).into_iter().filter(|&t| sim.bots[b].thrusters[t].role != Role::Cruise).collect()
}

/// Répartit une poussée totale `thrust` et un couple `tau` entre les axes de poussée des réacteurs,
/// dans leurs limites, par moindres carrés pondérés (`allocateThrust`) : la consigne de chaque axe de
/// chaque réacteur (N).
#[allow(clippy::too_many_arguments)]
fn allocate_thrust(sim: &Sim, b: usize, arms: &[ThrusterArm], up: V3, thrust: f64, tau: V3, piloted: bool) -> Vec<Vec<f64>> {
    let tail = arms.iter().any(|a| sim.bots[b].thrusters[a.t].role == Role::Trim);
    let e1 = norm(cross(up, if up.x.abs() < 0.9 { v3(1.0, 0.0, 0.0) } else { v3(0.0, 0.0, 1.0) }));
    let e2 = cross(up, e1);
    let cols: Vec<&ThrustAxis> = arms.iter().flat_map(|a| a.axes.iter()).collect();
    let n = arms.len() as f64;
    let reach = jsmath::max(0.5, (arms.iter().fold(0.0, |s, a| s + dpow(len(a.axes[0].torque), 2.0)) / n).sqrt());
    let kappa = jsmath::max(0.01, arms.iter().fold(0.0, |s, a| s + a.spec.torque_ratio) / n);
    let total_max = arms.iter().fold(0.0, |s, a| s + a.axes[0].hi);
    // Sans rotor de queue, le lacet ne peut déséquilibrer qu'un peu les hélices ; avec, il a toute la poussée
    let yaw_limit = (if tail {
        1.0
    } else if piloted {
        YAW_SHARE_PILOT
    } else {
        YAW_SHARE
    }) * total_max;
    let yaw_target = clamp(dot(tau, up) / kappa, -yaw_limit, yaw_limit);
    let rows: Vec<Vec<f64>> = vec![
        cols.iter().map(|c| dot(c.dir, up)).collect(),
        cols.iter().map(|c| dot(c.torque, e1) / reach).collect(),
        cols.iter().map(|c| dot(c.torque, e2) / reach).collect(),
        cols.iter().map(|c| dot(c.torque, up) / kappa).collect(),
    ];
    let yaw_weight = if tail {
        WEIGHT_YAW_TAIL
    } else if piloted {
        WEIGHT_YAW_PILOT
    } else {
        WEIGHT_YAW
    };
    let x = bounded_least_squares(
        &rows,
        &[thrust, dot(tau, e1) / reach, dot(tau, e2) / reach, yaw_target],
        &[WEIGHT_THRUST, WEIGHT_ATTITUDE, WEIGHT_ATTITUDE, yaw_weight],
        &cols.iter().map(|c| c.lo).collect::<Vec<_>>(),
        &cols.iter().map(|c| c.hi).collect::<Vec<_>>(),
        1e-6,
    );
    let mut i = 0;
    let mut out = Vec::with_capacity(arms.len());
    for a in arms {
        out.push(x[i..i + a.axes.len()].to_vec());
        i += a.axes.len();
    }
    out
}

/// Le lacet que commande le pilote d'un robot volant (`flyToward`, `yaw`) : la vitesse de lacet voulue
/// (rad/s, autour de son haut ; > 0 : vers la gauche) et l'aide du gyroscope du cockpit (0 à 1).
#[derive(Clone, Copy)]
pub struct Yaw {
    pub rate: f64,
    pub assist: f64,
}

/// Pilote automatique de vol vers `target` (x, z), à l'altitude `target.y` (`flyToward`) : la force
/// voulue, puis l'inclinaison et le couple nécessaires (inertie réelle du corps) ; la poussée répartie
/// entre les réacteurs alimentés, dans leurs limites (l'assiette avant l'altitude, l'altitude avant le
/// lacet) ; chaque moteur rattrape sa consigne. `yaw` : le lacet tenu par un pilote, avec l'aide du
/// gyroscope du cockpit ; sans (l'IA), le lacet n'est qu'amorti.
pub fn fly_toward(sim: &mut Sim, b: usize, target: V3, yaw: Option<Yaw>) {
    let powered = hover_thrusters(sim, b);
    if !powered.iter().any(|&t| sim.bots[b].thrusters[t].role == Role::Lift) {
        return;
    }
    let gravity = sim.gravity;
    let rb = sim.part(sim.bots[b].cockpit_part()).rb;
    let m = sim.phys.mass(rb);
    let com = sim.phys.world_com(rb);
    let v = sim.phys.linvel(rb);
    let w = sim.phys.angvel(rb);
    let up = qrot(sim.phys.rotation(rb), v3(0.0, 1.0, 0.0));

    // Force voulue : aller vers la cible, à l'altitude voulue
    let mut v_des = scale(v3(target.x - com.x, 0.0, target.z - com.z), 0.45);
    let vl = jsmath::hypot2(v_des.x, v_des.z);
    let speed = sim.bots[b].speed;
    if vl > speed {
        v_des = scale(v_des, speed / vl);
    }
    let ah = v3(clamp((v_des.x - v.x) * 1.2, -3.0, 3.0), 0.0, clamp((v_des.z - v.z) * 1.2, -3.0, 3.0));
    let ay = clamp((target.y - com.y) * 2.2 - v.y * 2.4, -5.0, 6.0);
    let f = v3(m * ah.x, m * (gravity + ay), m * ah.z);

    // Direction de poussée voulue, inclinaison limitée
    let mut u_des = norm(f);
    if u_des.y < dcos(MAX_TILT) {
        let h = norm(v3(u_des.x, 0.0, u_des.z));
        u_des = v3(h.x * dsin(MAX_TILT), dcos(MAX_TILT), h.z * dsin(MAX_TILT));
    }
    let thrust = jsmath::max(0.0, dot(f, up));

    // Couple voulu : redresser vers u_des et amortir les rotations, avec l'inertie réelle du corps
    let w_up = dot(w, up);
    let w_tilt = sub(w, scale(up, w_up));
    let yaw_kd = if powered.iter().any(|&t| sim.bots[b].thrusters[t].role == Role::Trim) { YAW_KD_TAIL } else { YAW_KD };
    let piloted = yaw.is_some();
    let yaw_rate = yaw.map_or(0.0, |y| y.rate);
    let yaw_gain = if piloted { jsmath::max(yaw_kd, YAW_KP_PILOT) } else { yaw_kd };
    let alpha = add(sub(scale(cross(up, u_des), ATTITUDE_KP), scale(w_tilt, ATTITUDE_KD)), scale(up, yaw_gain * (yaw_rate - w_up)));
    let inertia = sim.phys.effective_angular_inertia(rb);
    let tau = inertia_times(inertia, alpha);
    // Le gyroscope du cockpit fait pivoter le robot
    if let Some(y) = yaw
        && y.assist > 0.0
    {
        let spin = clamp(GYRO_KP * (yaw_rate - w_up), -GYRO_ACCEL, GYRO_ACCEL) * y.assist;
        sim.phys.apply_torque_impulse(rb, scale(inertia_times(inertia, scale(up, spin)), STEP), true);
    }

    // Répartition de la poussée, puis moteurs (batteries vides : rien que le générateur)
    let arms = thruster_arms(sim, b, &powered, com);
    let command = allocate_thrust(sim, b, &arms, up, thrust, tau, piloted);
    let demand = arms
        .iter()
        .enumerate()
        .fold(0.0, |s, (i, a)| s + (a.spec.power * command[i].iter().fold(0.0, |u, f| u + f.abs())) / a.spec.max_thrust);
    let k = supply(&sim.bots[b], demand);
    for (i, a) in arms.iter().enumerate() {
        let scaled: Vec<f64> = command[i].iter().map(|f| f * k).collect();
        run_motor(sim, b, a, &scaled);
    }
}
