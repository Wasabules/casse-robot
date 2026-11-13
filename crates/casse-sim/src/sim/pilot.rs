//! Le pilote d'avion (src/shared/ai/pilot.ts) : ses instruments, le pilote automatique de l'IA (le
//! circuit des avions par guidage L1, l'inclinaison bornée par ce que ses ailes portent, l'assiette, le
//! trim de profondeur, les gaz ; la fuite en montant ; le circuit d'attaque d'un bombardier ; plané sans
//! moteur, atterrissage forcé avec des moteurs trop faibles) et le pilotage du joueur (à la souris :
//! l'instructeur, qui s'incline vers où il regarde et tire ; au clavier ; en manuel : le manche, amorti).
//! Le manche braque les gouvernes (aero.rs), les gaz règlent les propulseurs (propulsion.rs) : c'est
//! l'aérodynamique qui fait voler l'avion. Au-delà de sa limite, le pilote automatique reprend la main.
//!
//! L'altitude se compte au-dessus du relief sous l'avion et devant lui (arena.rs, `groundLevel`) ; l'IA ne
//! vole pas plus bas que le plancher de l'arène (`airFloor`).

use super::aero::{AIR_DENSITY, aero_of, live_flaps, steer_surfaces};
use super::arena::ground_level;
use super::brain::{BombRun, Mode, RunPhase};
use super::propulsion::{live_thrusters, run_engines};
use super::robot::Role;
use super::turrets::{live_turrets, weapon};
use super::vec::{V3, add, clamp, cross, dot, norm, qrot, scale, sub, v3};
use super::world::{STEP, Sim};
use crate::det::{dcos, dsin};
use crate::jsmath;
use std::f64::consts::PI;

/// Guidage L1 : distance du point visé sur le circuit (m), et distance minimale prise en compte.
const L1_DISTANCE: f64 = 30.0;
const L1_MIN: f64 = 12.0;
/// Inclinaison maximale du pilote automatique (rad) ; pour ramener un avion piloté de sa limite.
const MAX_BANK: f64 = 0.75;
const RETURN_BANK: f64 = 1.05;
/// Pilotage manuel : amortissement du roulis, du tangage, du lacet ; trim automatique.
const ROLL_DAMP: f64 = 0.35;
const PITCH_DAMP: f64 = 0.5;
const YAW_DAMP: f64 = 0.6;
const AUTO_TRIM: f64 = 0.8;
/// Virage à plat (palonnier) : vitesse de lacet voulue (rad/s), raideur de la dérive ; l'aide contre
/// le dérapage (1/s, m/s², s).
const FLAT_TURN_RATE: f64 = 0.7;
const FLAT_TURN_GAIN: f64 = 3.0;
const SLIP_GRIP: f64 = 6.0;
const SLIP_MAX: f64 = 10.0;
const SLIP_FADE: f64 = 0.8;
/// L'inclinaison diminue à partir de LOW_START m sous l'altitude voulue, jusqu'au quart LOW_SPAN m plus bas.
const LOW_START: f64 = 2.0;
const LOW_SPAN: f64 = 6.0;
/// Profondeur tirée en virage, par unité de facteur de charge au-delà de 1.
const TURN_PULL: f64 = 0.5;
/// Marge sur la portance que ses ailes peuvent donner ; inclinaison au moins ; assiette au plus (rad).
const LIFT_MARGIN: f64 = 0.9;
const MIN_BANK: f64 = 0.3;
const MAX_PITCH: f64 = 0.3;
/// Plané sans moteur : assiette (rad), inclinaison au plus.
const GLIDE_PITCH: f64 = -0.1;
const GLIDE_BANK: f64 = 0.3;
/// Moteurs affaiblis : sous cette part de sa vitesse de croisière, la vitesse passe avant l'altitude.
const WEAK_SLOW: f64 = 0.9;
/// Atterrissage forcé : sous GROUNDED m, sans TAKEOFF_POWER de sa poussée ; le nez levé de FLARE rad.
const GROUNDED: f64 = 1.6;
const TAKEOFF_POWER: f64 = 0.9;
const FLARE: f64 = 0.06;
/// Près du sol (FLOOR + FLOOR_MARGIN m), ou quand il descend vite (SINK_RATE m/s), il s'incline moins.
const FLOOR: f64 = 3.0;
const FLOOR_MARGIN: f64 = 6.0;
const SINK_RATE: f64 = 3.0;
/// L'instructeur (à la souris).
const LEVEL_OFF: f64 = 0.08;
const BANK_SPAN: f64 = 0.22;
const PUSH_MAX: f64 = 0.8;
const ROLL_GAIN: f64 = 2.5;
const PITCH_GAIN: f64 = 2.5;
const RUDDER_AIM: f64 = 0.5;
const TRIM_OFF: f64 = 0.25;
const TRIM_RATE: f64 = 1.5;
const PATH_GAIN: f64 = 2.0;
const AOA_LIMIT: f64 = 0.24;
const AOA_GAIN: f64 = 4.0;
/// Au clavier, sans regard : virer, cabrer, piquer (rad).
const KEY_TURN: f64 = 0.9;
const KEY_PULL: f64 = 1.0;
const KEY_PUSH: f64 = 0.45;
const LEVEL_NOSE: f64 = 0.95;
const ROLL_FREE: f64 = 0.35;
const STEEP_DIVE: f64 = 0.5;
const MIN_HARD_BANK: f64 = 0.6;
const HARD_BANK: f64 = 1.3;
const SINK_SPAN: f64 = 0.2;
const MIN_SINK_BANK: f64 = 0.3;
/// À la souris, les gaz règlent une vitesse voulue (part de sa croisière) ; sous ENGINE_CUT, coupés.
const SLOW_SPEED: f64 = 0.6;
const FAST_SPEED: f64 = 1.6;
const ENGINE_CUT: f64 = 0.02;
/// En revenant de sa limite : altitude au moins (m), pente visée, gaz de la croisière.
const RETURN_ALT: f64 = 8.0;
const RETURN_CLIMB: f64 = 0.08;
const CRUISE_SETTING: f64 = 0.4;
/// La limite : reprise en main sur BOUNDARY_MARGIN m, anticipée de BOUNDARY_LEAD s, au moins
/// CIRCUIT_ROOM m au-delà du circuit.
const BOUNDARY_MARGIN: f64 = 14.0;
const BOUNDARY_LEAD: f64 = 2.0;
const CIRCUIT_ROOM: f64 = 18.0;
/// L'altitude se compte au-dessus du relief sous l'avion et devant lui, à ces temps de vol (s).
const LOOKAHEAD: [f64; 2] = [1.5, 3.0];
/// Circuit d'attaque d'un bombardier (m, rad, s).
const RUN_TRACK: f64 = 25.0;
const RUN_PASSED: f64 = 5.0;
const RUN_OUT: f64 = 45.0;
const RUN_CLOSE: f64 = 30.0;
const RUN_ALIGN: f64 = 0.25;
const BOMB_ALT: f64 = 16.0;
const ROLL_LEAD: f64 = 0.8;
const BEHIND: f64 = 2.6;

/// Ce que le pilote lit de ses instruments (`Instruments`).
struct Instruments {
    com: V3,
    ground: f64,
    height: f64,
    boundary: f64,
    circuit: f64,
    air_floor: f64,
    v: V3,
    w: V3,
    forward: V3,
    up: V3,
    left: V3,
    right: V3,
    airspeed: f64,
    engines: bool,
    power: f64,
    max_bank: f64,
    return_bank: f64,
    low: f64,
}

/// Les instruments de l'avion `b` (`instruments`) ; ils relèvent aussi sa position (`lastPos`).
fn instruments(sim: &mut Sim, b: usize) -> Instruments {
    let rb = sim.part(sim.bots[b].cockpit_part()).rb;
    let com = sim.phys.world_com(rb);
    sim.bots[b].last_pos = com;
    let v = sim.phys.linvel(rb);
    let below = ground_level(sim, com.x, com.z);
    let mut ground = below;
    for t in LOOKAHEAD {
        ground = jsmath::max(ground, ground_level(sim, com.x + v.x * t, com.z + v.z * t));
    }
    let q = sim.phys.rotation(rb);
    let forward = qrot(q, v3(0.0, 0.0, 1.0));
    let left = qrot(q, v3(1.0, 0.0, 0.0));
    let cruise = live_thrusters(sim, b, Some(Role::Cruise));
    let engines = !cruise.is_empty();
    let power = if engines { cruise.iter().fold(0.0, |s, &t| s + sim.bots[b].thrusters[t].output) / cruise.len() as f64 } else { 0.0 };
    // Près du sol (celui d'en dessous : le relief devant lui le fait monter, mais ne l'empêche pas de virer)
    let low = clamp((com.y - below - FLOOR) / FLOOR_MARGIN, 0.2, 1.0);
    let sinking = clamp(1.0 + (v.y + SINK_RATE) / SINK_RATE, 0.2, 1.0);
    let along = dot(v, forward);
    let sustainable = sustainable_bank(sim, b, along);
    let speed = sim.bots[b].speed;
    let bounds = sim.bounds;
    Instruments {
        com,
        ground,
        height: com.y - below,
        boundary: jsmath::max(bounds.half, bounds.circuit + CIRCUIT_ROOM),
        circuit: bounds.circuit,
        air_floor: sim.arena.air_floor,
        v,
        w: sim.phys.angvel(rb),
        forward,
        up: qrot(q, v3(0.0, 1.0, 0.0)),
        left,
        right: scale(left, -1.0),
        airspeed: jsmath::max(3.0, along),
        engines,
        power,
        max_bank: jsmath::min(if engines { MAX_BANK } else { GLIDE_BANK }, sustainable) * jsmath::min(low, sinking),
        low: jsmath::min(low, sinking),
        return_bank: jsmath::min(
            if engines { MAX_BANK + (RETURN_BANK - MAX_BANK) * clamp((along / speed - 1.0) * 2.0, 0.0, 1.0) } else { GLIDE_BANK },
            sustainable,
        ) * jsmath::min(low, sinking),
    }
}

/// Pilote automatique d'avion de l'IA (`thinkPlane`) : il choisit un cap et une altitude (le circuit
/// de l'arène, la passe d'un bombardier sur sa cible, ou fuir en montant), en déduit l'inclinaison et
/// l'assiette, puis pousse le manche et règle les gaz. Sans moteur, il plane ; des moteurs trop faibles
/// près du sol, il se pose.
pub fn think_plane(sim: &mut Sim, b: usize) {
    let dt = STEP;
    let f = instruments(sim, b);
    sim.bots[b].ai.mode_t -= dt;
    if f.engines && f.height < GROUNDED && f.power < TAKEOFF_POWER {
        sim.bots[b].ai.mode = Mode::Stranded;
        let bank = clamp(f.left.y, -1.0, 1.0).asin();
        let pitch = clamp(f.forward.y, -1.0, 1.0).asin();
        let trim = sim.bots[b].ai.trim;
        let stick = [-2.5 * bank - 1.2 * dot(f.w, f.forward), 2.5 * (FLARE - pitch) - 0.6 * dot(f.w, f.right) + trim, 0.0];
        apply_controls(sim, b, &f, &stick, 0.0);
        return;
    }
    let ai = &mut sim.bots[b].ai;
    if !f.engines {
        ai.mode = Mode::Gliding;
    } else if ai.mode != Mode::Flee || ai.mode_t <= 0.0 {
        ai.mode = Mode::Patrol;
    }
    // Navigation : tourner autour de l'arène, passer sur la cible de ses bombes, ou s'éloigner du tireur en fuite
    let fleeing = sim.bots[b].ai.mode == Mode::Flee;
    let prey = if fleeing { None } else { bombing_target(sim, b) };
    let target = if fleeing {
        sim.bots[b].ai.target
    } else if let Some(prey) = prey {
        bombing_run(&mut sim.bots[b].ai.bomb_run, &f, prey)
    } else {
        circuit_point(f.com, f.circuit)
    };
    let alt = sim.bots[b].ai.alt;
    let wanted = jsmath::max(if prey.is_some() { jsmath::max(alt, BOMB_ALT) } else { alt }, f.air_floor);
    let speed = sim.bots[b].speed;
    let bank = bank_toward(&f, target, f.max_bank);
    fly(sim, b, &f, dt, bank, wanted, speed);
}

/// Avion du pilote tenu par le pilote automatique (`holdPlane`), le temps du vol de son ogive : il
/// tourne sur le circuit des avions, à l'altitude visée (il ne peut pas s'arrêter en l'air).
pub fn hold_plane(sim: &mut Sim, b: usize) {
    let f = instruments(sim, b);
    sim.bots[b].ai.mode = if f.engines { Mode::Patrol } else { Mode::Gliding };
    let bank = bank_toward(&f, circuit_point(f.com, f.circuit), f.max_bank) * away_from(&f, false);
    let (alt, speed) = (sim.bots[b].ai.alt, sim.bots[b].speed);
    fly(sim, b, &f, STEP, bank, alt, speed);
}

/// Ce que le joueur commande à un avion piloté à la souris (`MouseFlight`) : la direction de son
/// regard (ou rien : au clavier), virer, cabrer ou piquer, le palonnier, les gaz.
pub struct MouseFlight {
    pub look: Option<V3>,
    pub turn: f64,
    pub pitch: f64,
    pub yaw: f64,
    pub power: f64,
}

/// Avion piloté à la souris (`flyMouse`) : il va là où regarde le joueur (l'instructeur s'incline et
/// tire), au clavier vire, cabre, pique ; le palonnier fait un virage à plat ; les gaz règlent une
/// vitesse voulue. Au-delà de sa limite, il revient vers le circuit des avions.
pub fn fly_mouse(sim: &mut Sim, b: usize, command: &MouseFlight) {
    let dt = STEP;
    let f = instruments(sim, b);
    sim.bots[b].ai.mode = if f.engines { Mode::Patrol } else { Mode::Gliding };
    let away = away_from(&f, true);
    let handover = clamp(away * 2.0, 0.0, 1.0);
    // (l'altitude que tiendra le pilote automatique s'il prend la main : celle où il vole)
    if away == 0.0 {
        sim.bots[b].ai.alt = jsmath::max(RETURN_ALT, f.height);
    }
    let mut want = mouse_target(&f, command);
    if handover > 0.0 {
        let goal = circuit_point(f.com, f.circuit);
        let h = jsmath::hypot2(goal.x - f.com.x, goal.z - f.com.z);
        let flat = if h == 0.0 || h.is_nan() { 1.0 } else { h };
        let back = norm(v3((goal.x - f.com.x) / flat, RETURN_CLIMB, (goal.z - f.com.z) / flat));
        want = norm(add(scale(want, 1.0 - handover), scale(back, handover)));
    }
    let mut stick = instructor(sim, b, &f, want, dt, handover == 0.0);
    // Palonnier : un virage à plat (la direction visée, la route, tourne avec lui)
    let yaw = clamp(command.yaw, -1.0, 1.0) * (1.0 - handover);
    if yaw.abs() > 0.05 {
        stick[2] = FLAT_TURN_GAIN * (yaw * FLAT_TURN_RATE - dot(f.w, f.up));
    }
    // Les gaz du joueur : une vitesse voulue, que les moteurs tiennent (plus en montée) ; à zéro, coupés
    let power = clamp(command.power, 0.0, 1.0);
    let speed = sim.bots[b].speed * (SLOW_SPEED + (FAST_SPEED - SLOW_SPEED) * (power + (CRUISE_SETTING - power) * handover));
    let throttle = if power < ENGINE_CUT && handover == 0.0 {
        0.0
    } else {
        clamp(0.4 + 0.3 * (speed - f.airspeed) + 1.2 * jsmath::max(0.0, f.forward.y), 0.0, 1.0)
    };
    apply_controls(sim, b, &f, &stick, throttle);
    slip_assist(sim, b, &f, yaw, dt);
}

/// Direction que vise l'instructeur (`mouseTarget`) : le regard du joueur ; sinon la route, à
/// l'horizontale, tournée du côté du virage demandé, levée ou baissée.
fn mouse_target(f: &Instruments, c: &MouseFlight) -> V3 {
    let turn = clamp(c.turn, -1.0, 1.0);
    let pitch = clamp(c.pitch, -1.0, 1.0);
    if let Some(look) = c.look
        && turn.abs() < 0.05
        && pitch.abs() < 0.05
    {
        let l = jsmath::hypot3(look.x, look.y, look.z);
        if l > 1e-6 {
            return scale(look, 1.0 / l);
        }
    }
    // La route (au palonnier aussi : elle tourne avec le nez, et l'instructeur juge sur elle)
    let track = if jsmath::hypot2(f.v.x, f.v.z) > 2.0 { v3(f.v.x, 0.0, f.v.z) } else { v3(f.forward.x, 0.0, f.forward.z) };
    let tl = jsmath::hypot2(track.x, track.z);
    let mut d = if tl > 1e-6 { scale(track, 1.0 / tl) } else { f.forward };
    if turn.abs() >= 0.05 {
        // Autour de la verticale, > 0 vers la gauche
        let a = turn * KEY_TURN;
        d = v3(d.x * dcos(a) + d.z * dsin(a), 0.0, -d.x * dsin(a) + d.z * dcos(a));
    }
    if pitch.abs() >= 0.05 {
        // Dans le plan du nez et du haut de l'avion : au-dessus pour cabrer, dessous pour piquer
        let a = pitch * (if pitch > 0.0 { KEY_PULL } else { KEY_PUSH });
        let nose = if turn.abs() >= 0.05 { norm(add(f.forward, scale(sub(d, f.forward), 0.5))) } else { f.forward };
        d = norm(add(scale(nose, dcos(a)), scale(f.up, dsin(a))));
    }
    d
}

/// Le manche de l'instructeur vers la direction `d` (unitaire) : roulis, tangage, lacet (`instructor`).
/// Il juge l'écart sur la trajectoire (la vitesse), pas sur le nez.
fn instructor(sim: &mut Sim, b: usize, f: &Instruments, d: V3, dt: f64, trimming: bool) -> [f64; 3] {
    let speed = jsmath::hypot3(f.v.x, f.v.y, f.v.z);
    let ahead = if speed > 3.0 { scale(f.v, 1.0 / speed) } else { f.forward };
    let lifted = sub(f.up, scale(ahead, dot(f.up, ahead)));
    let ll = jsmath::hypot3(lifted.x, lifted.y, lifted.z);
    let up = if ll > 0.2 { scale(lifted, 1.0 / ll) } else { f.up };
    let right = cross(ahead, up);
    let x = dot(d, right);
    let y = dot(d, up);
    let z = dot(d, ahead);
    // Écart à la trajectoire (0 à π), et part du virage incliné (rien presque droit devant)
    let off = jsmath::hypot2(x, y).atan2(z);
    let w = clamp((off - LEVEL_OFF) / BANK_SPAN, 0.0, 1.0);
    // Roulis qui met la direction au-dessus (> 0 : à droite) ; ou dessous, pour pousser
    let pull = x.atan2(y);
    let push = dsin(pull - PI).atan2(dcos(pull - PI));
    let pushing = off < PUSH_MAX && push.abs() < pull.abs();
    let mut roll_to = if pushing { push } else { pull };
    // Une direction à peu près à l'horizontale, de côté ou derrière : pas plus incliné que ses ailes ne portent
    let vertical = sub(v3(0.0, 1.0, 0.0), scale(ahead, ahead.y));
    let vl = jsmath::hypot3(vertical.x, vertical.y, vertical.z);
    if !pushing && roll_to.abs() > ROLL_FREE && d.y > -STEEP_DIVE && vl > 0.3 {
        let upright = scale(vertical, 1.0 / vl);
        let aside = cross(ahead, upright);
        let across = sub(d, scale(ahead, z));
        // Le côté de la direction (droit derrière : celui où elle penche, sinon la droite)
        let lean = dot(across, aside).atan2(dot(across, upright));
        // (et moins s'il s'enfonce sous la direction voulue : l'altitude d'abord)
        let sinking = clamp(1.0 - (clamp(d.y, -1.0, 1.0).asin() - clamp(ahead.y, -1.0, 1.0).asin()) / SINK_SPAN, MIN_SINK_BANK, 1.0);
        let limit = clamp(sustainable_bank(sim, b, f.airspeed), MIN_HARD_BANK, HARD_BANK) * f.low * sinking;
        if lean.abs() > limit {
            let bk = (if lean >= 0.0 { 1.0 } else { -1.0 }) * limit;
            let lift = add(scale(upright, dcos(bk)), scale(aside, dsin(bk)));
            roll_to = dot(lift, right).atan2(dot(lift, up));
        }
    }
    // Ailes à plat presque droit devant (inclinaison sur tout le tour, > 0 : à droite), sauf nez presque vertical
    let bank = f.left.y.atan2(f.up.y);
    let level = clamp((LEVEL_NOSE - f.forward.y.abs()) / 0.3, 0.0, 1.0);
    let roll_error = w * roll_to - (1.0 - w) * level * bank;
    // Profondeur ; le trim annule ce qui reste en vol presque droit
    let aligned = jsmath::max(0.0, dcos(roll_to));
    let direct = y.atan2(z);
    // Incidence : la vitesse sous le nez (> 0)
    let aoa = if speed > 3.0 { (-dot(f.v, f.up)).atan2(dot(f.v, f.forward)) } else { 0.0 };
    let elevator = w * (if pushing { -1.0 } else { 1.0 }) * off * aligned + (1.0 - w) * PATH_GAIN * direct;
    let ai = &mut sim.bots[b].ai;
    if trimming && off < TRIM_OFF {
        ai.trim = clamp(ai.trim + TRIM_RATE * direct * dt, -0.6, 0.6);
    }
    // Direction : le lacet d'un virage coordonné à son inclinaison, et presque droit devant, un peu vers la direction voulue
    let gravity = sim.gravity;
    let coordinated = if bank.abs() < 1.3 { (-gravity * bank.tan()) / f.airspeed } else { 0.0 };
    let rudder = 1.2 * (coordinated - dot(f.w, f.up)) + (1.0 - w) * RUDDER_AIM * (-x).atan2(z);
    let trim = sim.bots[b].ai.trim;
    [
        ROLL_GAIN * roll_error - 1.2 * dot(f.w, f.forward),
        // (pas au-delà de AOA_LIMIT d'incidence : tirer plus fait décrocher)
        clamp(PITCH_GAIN * elevator - 0.6 * dot(f.w, f.right), -AOA_GAIN * (AOA_LIMIT + aoa), AOA_GAIN * (AOA_LIMIT - aoa)) + trim,
        rudder,
    ]
}

/// Aide au virage à plat (`slipAssist`) : tant que le joueur tient le palonnier (et un moment après),
/// la vitesse horizontale de l'avion tourne vers son nez, sans changer de valeur.
fn slip_assist(sim: &mut Sim, b: usize, f: &Instruments, rudder: f64, dt: f64) {
    let ai = &mut sim.bots[b].ai;
    ai.slip = jsmath::max(rudder.abs(), ai.slip - dt / SLIP_FADE);
    if ai.slip <= 0.0 {
        return;
    }
    let slip = ai.slip;
    // À l'horizontale seulement
    let flat = jsmath::hypot2(f.forward.x, f.forward.z);
    if flat < 0.3 {
        return;
    }
    let nose = v3(f.forward.x / flat, 0.0, f.forward.z / flat);
    let side = v3(-nose.z, 0.0, nose.x);
    let along = dot(f.v, nose);
    let across = dot(f.v, side);
    let speed = jsmath::hypot2(along, across);
    if along <= 0.0 || speed < 1.0 {
        return;
    }
    // La vitesse de côté baisse, et ce qu'elle perd passe vers l'avant : la vitesse horizontale garde sa valeur
    let next_across = across + clamp(-SLIP_GRIP * across, -SLIP_MAX, SLIP_MAX) * slip * dt;
    let next_along = jsmath::max(0.0, speed * speed - next_across * next_across).sqrt();
    let rb = sim.part(sim.bots[b].cockpit_part()).rb;
    let m = sim.phys.mass(rb);
    let impulse = v3(
        (nose.x * (next_along - along) + side.x * (next_across - across)) * m,
        0.0,
        (nose.z * (next_along - along) + side.z * (next_across - across)) * m,
    );
    sim.phys.apply_impulse(rb, impulse, true);
}

/// Inclinaison la plus forte que ses ailes peuvent tenir à la vitesse `airspeed` (rad)
/// (`sustainableBank`) : la portance maximale de ses surfaces à plat, rapportée à son poids.
fn sustainable_bank(sim: &Sim, b: usize, airspeed: f64) -> f64 {
    let q = 0.5 * AIR_DENSITY * airspeed * airspeed;
    let bot = &sim.bots[b];
    let ck = bot.cockpit_part();
    let mut lift = 0.0;
    for s in &bot.surfaces {
        let k = &bot.blocks[s.block];
        if !k.alive || k.part != ck || k.up.y.abs() < 0.7 {
            continue;
        }
        let spec = aero_of(sim, b, s.block);
        lift += q * spec.area * spec.lift_slope * spec.stall_angle;
    }
    let load = (LIFT_MARGIN * lift) / (sim.phys.mass(sim.part(ck).rb) * sim.gravity);
    if load <= 1.0 { MIN_BANK } else { jsmath::max(MIN_BANK, (1.0 / load).acos()) }
}

/// Guidage L1 (`bankToward`) : viser un point de la route à quelque distance devant, et virer avec
/// l'accélération latérale 2·V²·sin(η)/distance ; l'inclinaison voulue (rad, > 0 : à droite).
fn bank_toward(f: &Instruments, target: V3, limit: f64) -> f64 {
    // Cap mesuré sur la trajectoire (la vitesse), plus fiable que le nez quand l'avion dérape
    let track = if jsmath::hypot2(f.v.x, f.v.z) > 2.0 { v3(f.v.x, 0.0, f.v.z) } else { f.forward };
    let h = jsmath::hypot2(track.x, track.z);
    let fl = if h == 0.0 || h.is_nan() { 1.0 } else { h };
    let tx = target.x - f.com.x;
    let tz = target.z - f.com.z;
    // (> 0 : le point est à gauche)
    let eta = bearing(track.x / fl, track.z / fl, tx, tz);
    let lateral = (2.0 * f.airspeed * f.airspeed * dsin(clamp(eta, -PI / 2.0, PI / 2.0))) / jsmath::max(L1_MIN, jsmath::hypot2(tx, tz));
    clamp(-(lateral / GRAVITY_TS).atan(), -limit, limit)
}

/// La gravité du TypeScript (`GRAVITY`, config.ts), que le pilote lit directement.
const GRAVITY_TS: f64 = 9.81;

/// Avion en pilotage manuel (`flyManual`) : le joueur tient le manche (tangage > 0 : cabrer ; roulis >
/// 0 : vers la droite ; lacet > 0 : vers la gauche) et les gaz ; un amortissement, rien d'autre.
/// Au-delà de sa limite, le pilote automatique reprend peu à peu la main.
pub fn fly_manual(sim: &mut Sim, b: usize, pitch: f64, roll: f64, yaw: f64, power: f64) {
    let dt = STEP;
    let f = instruments(sim, b);
    sim.bots[b].ai.mode = if f.engines { Mode::Patrol } else { Mode::Gliding };
    // (l'altitude que tiendra le pilote automatique s'il reprend la main : celle où il vole)
    if away_from(&f, true) == 0.0 {
        sim.bots[b].ai.alt = jsmath::max(RETURN_ALT, f.height);
    }
    let pitch_rate = dot(f.w, f.right);
    // Manche au neutre en tangage : le trim annule peu à peu la rotation
    let ai = &mut sim.bots[b].ai;
    if pitch.abs() < 0.05 {
        ai.trim = clamp(ai.trim - AUTO_TRIM * pitch_rate * dt, -0.6, 0.6);
    }
    let mut stick = [
        clamp(roll, -1.0, 1.0) - ROLL_DAMP * dot(f.w, f.forward),
        clamp(pitch, -1.0, 1.0) - PITCH_DAMP * pitch_rate + ai.trim,
        clamp(yaw, -1.0, 1.0) - YAW_DAMP * dot(f.w, f.up),
    ];
    let mut throttle = clamp(power, 0.0, 1.0);
    let away = away_from(&f, false);
    if away > 0.0 {
        // (aussi serré que ses ailes le permettent)
        let bank = bank_toward(&f, circuit_point(f.com, f.circuit), f.return_bank);
        let (alt, speed) = (sim.bots[b].ai.alt, sim.bots[b].speed);
        let (auto, auto_throttle) = flight_controls(sim, b, &f, dt, bank, alt, speed);
        for (i, s) in stick.iter_mut().enumerate() {
            *s += (auto[i] - *s) * away;
        }
        throttle += (auto_throttle - throttle) * away;
    }
    apply_controls(sim, b, &f, &stick, throttle);
    slip_assist(sim, b, &f, clamp(yaw, -1.0, 1.0) * (1.0 - away), dt);
}

/// Part (0 à 1) de la main que reprend le pilote automatique (`awayFrom`) : l'avion s'éloigne au-delà
/// de sa limite (`always` : il est au-delà, quoi qu'il fasse, ou y sera bientôt à sa vitesse).
fn away_from(f: &Instruments, always: bool) -> f64 {
    let h = jsmath::hypot2(f.com.x, f.com.z);
    let r = if h == 0.0 || h.is_nan() { 1.0 } else { h };
    let outward = (f.v.x * f.com.x + f.v.z * f.com.z) / (r * jsmath::max(1.0, jsmath::hypot2(f.v.x, f.v.z)));
    if !always {
        return clamp((r - f.boundary) / BOUNDARY_MARGIN, 0.0, 1.0) * clamp(outward * 3.0, 0.0, 1.0);
    }
    let ahead = r + jsmath::max(0.0, (f.v.x * f.com.x + f.v.z * f.com.z) / r) * BOUNDARY_LEAD;
    clamp((ahead - f.boundary) / BOUNDARY_MARGIN, 0.0, 1.0)
}

/// Manche et gaz (`applyControls`) : les gouvernes braquées d'après le manche, les moteurs réglés.
fn apply_controls(sim: &mut Sim, b: usize, f: &Instruments, stick: &[f64; 3], throttle: f64) {
    if !live_flaps(sim, b).is_empty() {
        steer_surfaces(sim, b, stick, &[f.forward, f.right, f.up], &[1.0, 1.0, 0.3]);
    }
    run_engines(sim, b, throttle);
}

/// Vol vers une inclinaison, une altitude au-dessus du relief et une vitesse voulues (`fly`).
fn fly(sim: &mut Sim, b: usize, f: &Instruments, dt: f64, bank_wanted: f64, alt: f64, speed: f64) {
    let (stick, throttle) = flight_controls(sim, b, f, dt, bank_wanted, alt, speed);
    apply_controls(sim, b, f, &stick, throttle);
}

/// Le manche et les gaz du pilote automatique (`flightControls`, sans virage à plat).
fn flight_controls(sim: &mut Sim, b: usize, f: &Instruments, dt: f64, bank_wanted: f64, alt: f64, speed: f64) -> ([f64; 3], f64) {
    let flat_turn = 0.0;
    // Trop bas sous l'altitude voulue : l'altitude passe avant le virage
    let deficit = f.ground + alt - f.com.y;
    let bank_wanted = bank_wanted * (1.0 - clamp((deficit - LOW_START) / LOW_SPAN, 0.0, 0.75));
    let mut pitch_wanted =
        if f.engines { clamp(0.1 * (f.ground + alt - f.com.y) - 0.15 * f.v.y + 0.05, -MAX_PITCH, MAX_PITCH) } else { GLIDE_PITCH };
    // Moteurs affaiblis et trop lent : la vitesse d'abord
    if f.engines && f.power < 1.0 {
        let slow = clamp((speed * WEAK_SLOW - f.airspeed) / (speed * 0.2), 0.0, 1.0);
        pitch_wanted += (jsmath::min(pitch_wanted, GLIDE_PITCH) - pitch_wanted) * slow;
    }
    let bank = clamp(f.left.y, -1.0, 1.0).asin();
    let pitch = clamp(f.forward.y, -1.0, 1.0).asin();
    // Manche : roulis, tangage (> 0 : cabrer), lacet qui accompagne le virage ; le trim s'ajuste lentement
    let pitch_error = pitch_wanted - pitch;
    let ai = &mut sim.bots[b].ai;
    ai.trim = clamp(ai.trim + 0.6 * pitch_error * dt, -0.6, 0.6);
    let turn_rate = (-GRAVITY_TS * bank.tan()) / f.airspeed;
    // En virage, l'aile doit porter 1/cos(inclinaison) fois le poids : le pilote tire d'autant
    let load_pull = TURN_PULL * (1.0 / jsmath::max(0.35, dcos(bank)) - 1.0);
    let stick = [
        2.5 * (bank_wanted - bank) - 1.2 * dot(f.w, f.forward),
        2.5 * pitch_error - 0.6 * dot(f.w, f.right) + ai.trim + load_pull,
        (if flat_turn != 0.0 { FLAT_TURN_GAIN } else { 1.2 }) * (turn_rate + flat_turn - dot(f.w, f.up)),
    ];
    // Gaz : tenir la vitesse voulue, avec un supplément pour monter
    let throttle = clamp(0.4 + 0.3 * (speed - f.airspeed) + 1.2 * pitch_wanted, 0.0, 1.0);
    (stick, throttle)
}

/// Ennemi que visent ses soutes à bombes encore chargées, s'il en a (`bombingTarget`) : sa position.
fn bombing_target(sim: &Sim, b: usize) -> Option<V3> {
    for t in live_turrets(sim, b) {
        let turret = &sim.bots[b].turrets[t];
        if weapon(sim, b, t).dropped
            && turret.arm.ammo > 0.0
            && let Some(target) = turret.target
            && sim.bots[target].cockpit_alive()
        {
            return Some(sim.bots[target].last_pos);
        }
    }
    None
}

/// Circuit d'attaque d'un bombardier (`bombingRun`) : la passe sur la cible, l'éloignement, le
/// demi-tour ; le point que vise son guidage.
fn bombing_run(state: &mut Option<BombRun>, f: &Instruments, target: V3) -> V3 {
    let to_x = target.x - f.com.x;
    let to_z = target.z - f.com.z;
    let h = jsmath::hypot2(to_x, to_z);
    let dist = if h == 0.0 || h.is_nan() { 1.0 } else { h };
    let toward = v3(to_x / dist, 0.0, to_z / dist);
    // Route suivie (la vitesse), ou le nez à très basse vitesse
    let track = if jsmath::hypot2(f.v.x, f.v.z) > 2.0 { v3(f.v.x, 0.0, f.v.z) } else { f.forward };
    let h = jsmath::hypot2(track.x, track.z);
    let tl = if h == 0.0 || h.is_nan() { 1.0 } else { h };
    let fx = track.x / tl;
    let fz = track.z / tl;
    let eta = bearing(fx, fz, to_x, to_z);
    let outward = f.v.x * f.com.x + f.v.z * f.com.z > 0.0 && jsmath::hypot2(f.com.x, f.com.z) > f.boundary;
    // Côté du demi-tour : celui de la cible, ou celui du centre de l'arène si elle est droit derrière
    let side = || if (if eta.abs() > BEHIND { bearing(fx, fz, -f.com.x, -f.com.z) } else { eta }) >= 0.0 { 1.0 } else { -1.0 };
    let run = state.get_or_insert_with(|| BombRun {
        phase: if eta.abs() < RUN_ALIGN {
            RunPhase::Pass
        } else if dist < RUN_OUT {
            RunPhase::Out
        } else {
            RunPhase::Turn
        },
        dir: toward,
        turn: side(),
    });
    if run.phase == RunPhase::Pass {
        let ahead = to_x * run.dir.x + to_z * run.dir.z;
        if ahead < -RUN_PASSED || outward {
            run.phase = RunPhase::Out;
        } else if ahead > RUN_TRACK {
            run.dir = toward;
        }
    }
    if run.phase == RunPhase::Out && (dist >= RUN_OUT || outward) {
        run.phase = RunPhase::Turn;
        run.turn = side();
    }
    // Fin du demi-tour : la cible presque dans l'axe, compte tenu de ce qu'il tournera encore
    if run.phase == RunPhase::Turn && eta * run.turn < RUN_ALIGN + f.w.y.abs() * ROLL_LEAD && !outward {
        run.phase = RunPhase::Pass;
        run.dir = toward;
    } else if run.phase == RunPhase::Turn && dist < RUN_CLOSE && !outward {
        // (trop près pour s'aligner : la cible est dans son virage)
        run.phase = RunPhase::Out;
    }
    match run.phase {
        RunPhase::Out => v3(f.com.x + fx * L1_DISTANCE, 0.0, f.com.z + fz * L1_DISTANCE),
        // Un point sur le côté choisi, à angle droit de la route (à gauche : (z, -x))
        RunPhase::Turn => v3(f.com.x + fz * L1_DISTANCE * run.turn, 0.0, f.com.z - fx * L1_DISTANCE * run.turn),
        RunPhase::Pass => {
            let along = L1_DISTANCE - (to_x * run.dir.x + to_z * run.dir.z);
            v3(target.x + run.dir.x * along, 0.0, target.z + run.dir.z * along)
        }
    }
}

/// Angle entre le cap horizontal (fx, fz) et la direction (x, z) : > 0 si elle est à gauche (`bearing`).
fn bearing(fx: f64, fz: f64, x: f64, z: f64) -> f64 {
    (fz * x - fx * z).atan2(fx * x + fz * z)
}

/// Point du circuit à la distance L1 de l'avion, en avant dans le sens où les avions tournent
/// (`circuitPoint`, loi des cosinus).
fn circuit_point(p: V3, r_circuit: f64) -> V3 {
    let h = jsmath::hypot2(p.x, p.z);
    let r = if h == 0.0 || h.is_nan() { 0.001 } else { h };
    let cos = clamp((r * r + r_circuit * r_circuit - L1_DISTANCE * L1_DISTANCE) / (2.0 * r * r_circuit), -1.0, 1.0);
    let angle = p.z.atan2(p.x) + jsmath::max(cos.acos(), 0.35);
    v3(dcos(angle) * r_circuit, 0.0, dsin(angle) * r_circuit)
}
