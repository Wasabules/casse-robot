//! L'IA qui conduit un robot au sol (src/shared/ai/brain.ts), hors combat (`sim.combat` faux, comme au
//! stand de tir : ni tactique, ni tourelles, ni armes de contact) : elle patrouille vers des
//! destinations tirées au hasard (`wander`), contourne le décor (navigation.rs), évite ce qu'elle a
//! devant elle (trois rayons relancés toutes les 50 ms : `avoidObstacles`), ne prend pas de virage
//! plus serré que sa stabilité ne le permet (`limitCornering`), recule en contre-braquant quand elle
//! est coincée, et fait bondir le robot (`unstick`) quand ni l'avant ni l'arrière ne l'en sortent.
//! Heurtée par un autre robot ou soufflée par une explosion, elle fuit, ou fonce sur ce qui l'a
//! heurtée si le robot est fait pour charger (`onHit`).
//!
//! Le robot n'a ni propulseur (pas de boost), ni appui, ni arme de contact : ceux qui en ont sont
//! refusés (robot.rs). Il n'y a ni partie (pas de zones à prendre : la patrouille va au hasard), ni
//! pause de l'IA, ni lave, ni eau profonde, ni mines (rien à contourner que le décor).

use super::drive::{FLIPPED_UP_Y, RIGHTING_TIME, drive, driven_wheels, local_com, steering_geometry};
use super::navigation::{flat_distance, navigate};
use super::robot::Bot;
use super::vec::{V3, add, clamp, norm, qrot, scale, v3};
use super::world::{Owner, STEP, Sim};
use crate::det::{dcos, dsin};
use crate::jsmath;

/// Distance à laquelle une destination est considérée comme atteinte (m).
const ARRIVED: f64 = 3.0;
/// Tension moyenne des moteurs au-delà de laquelle un robot immobile est considéré comme coincé.
const STUCK_DRIVE: f64 = 0.12;
/// Temps coincé malgré les manœuvres avant que le gyroscope ne le fasse bondir (s).
const UNSTICK_DELAY: f64 = 6.0;
/// Gaz quand la cible est derrière : en conduite différentielle ; avec des roues directrices.
const PIVOT_THROTTLE: f64 = 0.25;
const U_TURN_THROTTLE: f64 = 0.5;
/// Part de l'accélération latérale de renversement que le pilote s'autorise en virage.
const CORNER_SAFETY: f64 = 0.5;
/// Anticipation des obstacles : durée de trajet regardée devant (s), portée minimale au-delà du
/// robot (m), écart des rayons de côté (rad), hauteur des rayons au-dessus du sol (m).
const LOOKAHEAD: f64 = 1.3;
const LOOKAHEAD_MIN: f64 = 3.0;
const PROBE_SPREAD: f64 = 0.5;
const PROBE_HEIGHT: f64 = 0.6;
/// Les rayons d'évitement se relancent à cet intervalle (s).
const PROBE_PERIOD: f64 = 0.05;
/// Au-dessus de ce cosinus, une surface touchée est une pente praticable (rampe), pas un obstacle.
const SLOPE_UP_Y: f64 = 0.6;
/// Distance du point vers lequel fuit un robot au sol (m) (`onHit`).
const FLEE_DISTANCE: f64 = 22.0;

/// Le mode de l'IA (`AiMode`), dans l'ordre de sa déclaration (le rang sert de code aux tests).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Patrol,
    Engage,
    Cover,
    Flee,
    Charge,
    Reverse,
    Hover,
    Paused,
    Gliding,
    Landing,
    Stunned,
    Flipped,
    Stranded,
    Falling,
    Dead,
    Support,
}

/// Les distances mesurées par les rayons d'évitement (devant, à gauche, à droite), et jusqu'à quand elles valent.
#[derive(Clone, Copy)]
pub struct Probes {
    pub ahead: f64,
    pub left: f64,
    pub right: f64,
    pub until: f64,
}

/// L'état de l'IA d'un robot (`AiState` : ce qui sert au sol, hors combat).
pub struct AiState {
    pub mode: Mode,
    /// Destination (seuls x et z comptent).
    pub target: V3,
    /// Temps restant avant de changer de destination de patrouille (s).
    pub timer: f64,
    /// Temps restant dans le mode en cours (fuite, charge, dégagement) (s).
    pub mode_t: f64,
    /// Temps passé à l'arrêt, moteurs poussant, pour détecter un robot coincé (s) ; et malgré les
    /// manœuvres, marche arrière comprise : au-delà, le bond (s).
    pub stuck_t: f64,
    pub blocked_t: f64,
    /// Sens du braquage en marche arrière (-1 ou 1).
    pub flip: f64,
    /// Ses rayons d'évitement (`probes`, un `WeakMap` du TypeScript : rien avant le premier).
    pub probes: Option<Probes>,
}

impl AiState {
    /// L'état d'un robot qui apparaît en `pos` (`createAiState`) : sa destination est là où il est,
    /// il en choisit une à sa première décision.
    pub fn new(pos: V3) -> Self {
        AiState { mode: Mode::Patrol, target: pos, timer: 0.0, mode_t: 0.0, stuck_t: 0.0, blocked_t: 0.0, flip: 1.0, probes: None }
    }
}

/// Le robot à qui appartient un collider (`ownerBot`) : celui d'un morceau, d'une roue, d'une tête de tourelle.
fn owner_bot(sim: &Sim, owner: Option<&Owner>) -> Option<usize> {
    match owner {
        Some(Owner::Part(p)) => sim.parts[*p].as_ref().map(|part| part.bot),
        Some(Owner::Wheel(bot, _)) | Some(Owner::Head(bot, _)) => Some(*bot),
        _ => None,
    }
}

/// Point ramené dans la zone où circulent les robots (`clampToRoam` ; sans grille de passage, il
/// n'y a ni mer, ni lave, ni flanc trop raide où ne pas aller).
fn clamp_to_roam(sim: &Sim, p: V3) -> V3 {
    let roam = sim.bounds.roam;
    v3(clamp(p.x, -roam, roam), 0.0, clamp(p.z, -roam, roam))
}

/// Une destination au hasard dans la zone où rôde l'IA, à plus de 10 m de `from` (`wander` ; sans
/// grille ni réseau de passage, et hors d'une ville : partout).
fn wander(sim: &mut Sim, b: usize, from: V3) {
    let roam = sim.bounds.roam - 3.0;
    for _ in 0..12 {
        let x = sim.rng.rand(-roam, roam);
        let z = sim.rng.rand(-roam, roam);
        let t = v3(x, 0.0, z);
        if flat_distance(t, from) > 10.0 {
            sim.bots[b].ai.target = t;
            break;
        }
    }
    sim.bots[b].ai.timer = sim.rng.rand(10.0, 16.0);
}

/// Une destination de patrouille (`pickPatrolTarget` ; sans partie, pas de zone à prendre : au hasard).
fn pick_patrol_target(sim: &mut Sim, b: usize, from: V3) {
    wander(sim, b, from);
}

/// Réaction à un coup venu de `shooter` (`onHit`) : un choc avec un autre robot, une explosion. Il
/// fuit, ou charge s'il est fait pour ça (en combat, il ne romprait pas : hors combat, il n'y est pas).
pub fn on_hit(sim: &mut Sim, b: usize, shooter: V3) {
    if !sim.bots[b].cockpit_alive() {
        return;
    }
    let pos = sim.bots[b].last_pos;
    // (`tactics.holding` : une zone à prendre, qu'il n'y a pas sans partie)
    if matches!(sim.bots[b].ai.mode, Mode::Engage | Mode::Cover | Mode::Support) {
        return;
    }
    if sim.bots[b].charges {
        let target = clamp_to_roam(sim, shooter);
        let ai = &mut sim.bots[b].ai;
        ai.mode = Mode::Charge;
        ai.target = target;
        ai.mode_t = 5.0;
    } else {
        let away = norm(v3(pos.x - shooter.x, 0.0, pos.z - shooter.z));
        let target = clamp_to_roam(sim, add(pos, scale(away, FLEE_DISTANCE)));
        let ai = &mut sim.bots[b].ai;
        ai.mode = Mode::Flee;
        ai.mode_t = 4.0;
        ai.target = target;
    }
}

/// Les robots touchés réagissent, s'il y a un tireur (`react` : un choc entre deux robots, une explosion).
pub fn react(sim: &mut Sim, hit: &[usize], source: Option<V3>) {
    if let Some(shooter) = source {
        for &b in hit {
            on_hit(sim, b, shooter);
        }
    }
}

/// Tension moyenne appliquée aux moteurs des roues motrices (0 à 1) (`averageDrive`).
fn average_drive(bot: &Bot) -> f64 {
    let wheels = driven_wheels(bot);
    if wheels.is_empty() {
        return 0.0;
    }
    wheels.iter().fold(0.0, |s, w| s + w.drive.abs()) / wheels.len() as f64
}

/// Hauteur du sol sous le robot : sous ses roues motrices, sinon sous son centre de masse (`groundUnder`).
fn ground_under(bot: &Bot, pos: V3) -> f64 {
    let mut ground = f64::INFINITY;
    for w in driven_wheels(bot) {
        ground = jsmath::min(ground, w.rb.pos.y - w.def.radius);
    }
    if ground.is_finite() { ground } else { pos.y - 1.0 }
}

/// Accélération latérale (m/s²) à laquelle le robot se renverse en virage, en statique (`rolloverAccel`).
fn rollover_accel(sim: &Sim, b: usize) -> f64 {
    let bot = &sim.bots[b];
    let wheels = driven_wheels(bot);
    if wheels.len() < 3 {
        return f64::INFINITY;
    }
    let com = local_com(&sim.phys, sim.part(bot.cockpit_part()).rb);
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    let mut ground = f64::INFINITY;
    for a in &wheels {
        ground = jsmath::min(ground, a.local.y - a.def.radius);
        for c in &wheels {
            let dz = c.local.z - a.local.z;
            let t = if dz.abs() < 1e-6 {
                if (com.z - a.local.z).abs() < 1e-6 { 0.0 } else { f64::NAN }
            } else {
                (com.z - a.local.z) / dz
            };
            if !(t >= 0.0 && t <= 1.0) {
                continue;
            }
            let x = a.local.x + t * (c.local.x - a.local.x);
            lo = jsmath::min(lo, x);
            hi = jsmath::max(hi, x);
        }
    }
    let margin = jsmath::min(hi - com.x, com.x - lo);
    let height = com.y - ground;
    if !(margin > 0.0) || !(height > 0.0) {
        return f64::INFINITY;
    }
    (sim.gravity * margin) / height
}

/// Virages d'un robot à roues directrices (`limitCornering`) : pas plus serré que ce que sa
/// stabilité permet à sa vitesse, et plus lentement pour pouvoir le serrer ensuite.
fn limit_cornering(sim: &Sim, b: usize, max_curvature: f64, throttle: f64, steer: f64, speed: f64) -> (f64, f64) {
    let lateral = CORNER_SAFETY * rollover_accel(sim, b);
    let wanted = steer.abs() * max_curvature;
    if wanted == 0.0 || !lateral.is_finite() {
        return (throttle, steer);
    }
    let safe_speed = (lateral / wanted).sqrt();
    let allowed = lateral / jsmath::max(speed * speed, 1e-6) / max_curvature;
    (jsmath::min(throttle, safe_speed / sim.bots[b].speed), clamp(steer, -allowed, allowed))
}

/// Évitement des obstacles (`avoidObstacles`) : trois rayons horizontaux partent du robot, droit
/// devant et de biais, aussi loin qu'il roulera dans LOOKAHEAD s (relancés toutes les PROBE_PERIOD s,
/// gardés entre deux). Un obstacle droit devant (décor, accessoire, autre robot) le fait ralentir et
/// braquer du côté le plus dégagé ; un obstacle de biais l'en écarte un peu. En charge, il ne
/// s'écarte pas des ennemis : il les percute. (Sans lave, sans eau profonde, sans falaise.)
fn avoid_obstacles(sim: &mut Sim, b: usize, pos: V3, forward: V3, speed: f64, throttle: f64, steer: f64) -> (f64, f64) {
    let bot = &sim.bots[b];
    let reach = bot.radius + jsmath::max(LOOKAHEAD_MIN, speed * LOOKAHEAD);
    let from = v3(pos.x, ground_under(bot, pos) + PROBE_HEIGHT, pos.z);
    let ramming = bot.ai.mode == Mode::Charge;
    let team = bot.team;
    let fresh = match bot.ai.probes {
        Some(seen) if sim.time < seen.until => None,
        _ => {
            let s = &*sim;
            let probe = |angle: f64| -> f64 {
                let c = dcos(angle);
                let sn = dsin(angle);
                let dir = v3(forward.x * c + forward.z * sn, 0.0, -forward.x * sn + forward.z * c);
                let keep = |h| {
                    let owner = s.owners.get(&h);
                    if matches!(owner, Some(Owner::Debris)) {
                        return false;
                    }
                    let other = owner_bot(s, owner);
                    // (`areEnemies` : un autre robot, d'une autre équipe)
                    other != Some(b) && !(ramming && other.is_some_and(|o| s.bots[o].team != team))
                };
                let hit = s.phys.cast_ray_and_get_normal_where(from, dir, reach, true, &keep);
                // (`Math.min(…, hazardDistance(…))` : sans lave ni eau profonde, Infinity)
                match hit {
                    Some(h) if !(h.normal.y > SLOPE_UP_Y) => h.time_of_impact,
                    _ => f64::INFINITY,
                }
            };
            let ahead = probe(0.0);
            let left = probe(PROBE_SPREAD);
            let right = probe(-PROBE_SPREAD);
            Some(Probes { ahead, left, right, until: sim.time + PROBE_PERIOD })
        }
    };
    if let Some(p) = fresh {
        sim.bots[b].ai.probes = Some(p);
    }
    let Probes { ahead, left, right, .. } = sim.bots[b].ai.probes.expect("rayons relevés");
    // > 0 : le côté gauche est plus dégagé
    let side = if left >= right { 1.0 } else { -1.0 };
    if ahead < reach {
        let closeness = 1.0 - ahead / reach;
        return (jsmath::min(throttle, jsmath::max(0.2, 1.0 - closeness)), clamp(steer + side * (0.5 + closeness), -1.0, 1.0));
    }
    if jsmath::min(left, right) < reach * 0.6 {
        return (throttle, clamp(steer + side * 0.4, -1.0, 1.0));
    }
    (throttle, steer)
}

/// Le gyroscope fait bondir un robot coincé (`unstick`, robot/righting.ts).
fn unstick(bot: &mut Bot) {
    if bot.righting <= 0.0 {
        bot.righting = RIGHTING_TIME;
    }
}

/// Conduite au sol de l'IA, hors combat (`thinkGround`), le robot vivant, d'aplomb (son gyroscope ne
/// le redresse pas), son centre de masse en `pos`. (Sans propulseur : pas de boost, `runEngines` ne
/// fait rien.)
pub fn think_ground(sim: &mut Sim, b: usize, pos: V3) {
    let dt = STEP;
    let gravity = sim.gravity;
    let rb = sim.part(sim.bots[b].cockpit_part()).rb;
    let q = sim.phys.rotation(rb);
    let up = qrot(q, v3(0.0, 1.0, 0.0));
    if up.y < FLIPPED_UP_Y {
        sim.bots[b].ai.mode = Mode::Flipped;
        drive(&sim.phys, &mut sim.bots[b], Some(rb), 0.0, 0.0, false, false, 0.0, gravity);
        return;
    }
    // (ni appui : ses roues motrices seulement)
    if driven_wheels(&sim.bots[b]).is_empty() {
        sim.bots[b].ai.mode = Mode::Stranded;
        return;
    }
    // (pas de pause de l'IA)
    let ai = &mut sim.bots[b].ai;
    if matches!(ai.mode, Mode::Flipped | Mode::Stranded | Mode::Paused) {
        ai.mode = Mode::Patrol;
    }
    ai.mode_t -= dt;
    ai.timer -= dt;
    if matches!(ai.mode, Mode::Flee | Mode::Charge | Mode::Reverse) && ai.mode_t <= 0.0 {
        ai.mode = Mode::Patrol;
        pick_patrol_target(sim, b, pos);
    }
    // (hors combat : ni engagement, ni couvert, ni charge planifiée)
    let ai = &sim.bots[b].ai;
    if ai.mode == Mode::Patrol && (ai.timer <= 0.0 || flat_distance(ai.target, pos) < ARRIVED) {
        pick_patrol_target(sim, b, pos);
    }

    let fwd = qrot(q, v3(0.0, 0.0, 1.0));
    let f = norm(v3(fwd.x, 0.0, fwd.z));
    // Autour du décor : le coin d'un muret, le pied d'une rampe (navigation.rs) ; pas de mines à éviter
    let target = sim.bots[b].ai.target;
    let goal = navigate(sim, b, pos, target);
    let d = norm(v3(goal.x - pos.x, 0.0, goal.z - pos.z));
    // > 0 : la cible est à gauche ; (sans arme de contact, rien à présenter en chargeant)
    let ang = (f.z * d.x - f.x * d.z).atan2(f.x * d.x + f.z * d.z);

    let max_curvature = steering_geometry(&sim.phys, &sim.bots[b], Some(rb)).max_curvature;
    let steered = max_curvature > 0.0;
    let mode = sim.bots[b].ai.mode;
    let (mut throttle, mut steer);
    if mode == Mode::Reverse {
        throttle = -0.7;
        steer = sim.bots[b].ai.flip;
    } else {
        steer = clamp(ang * 1.6, -1.0, 1.0);
        throttle = if ang.abs() > 1.3 {
            if steered { U_TURN_THROTTLE } else { PIVOT_THROTTLE }
        } else {
            1.0 - 0.45 * ang.abs()
        };
        if mode == Mode::Flee || mode == Mode::Charge {
            throttle = jsmath::min(1.0, throttle * 1.25);
        }
    }
    // (pas de mâchoire qui tienne une proie)

    // Coincé contre un mur ou un obstacle (les moteurs poussent mais le robot n'avance ni ne tourne) :
    // marche arrière en braquant ; avec des roues directrices, en contre-braquant
    let v = sim.phys.linvel(rb);
    let speed = jsmath::hypot2(v.x, v.z);
    let spin = sim.phys.angvel(rb).y.abs();
    let pushing = average_drive(&sim.bots[b]) > STUCK_DRIVE;
    let ai = &mut sim.bots[b].ai;
    if ai.mode != Mode::Reverse && pushing && speed < 0.5 && spin < 0.35 {
        ai.stuck_t += dt;
    } else {
        ai.stuck_t = jsmath::max(0.0, ai.stuck_t - dt);
    }
    if ai.stuck_t > 1.6 {
        ai.mode = Mode::Reverse;
        ai.mode_t = 1.3;
        // (sans roue directrice, le sens importe peu : `randSign`)
        ai.flip = if steered {
            if ang > 0.0 { -1.0 } else { 1.0 }
        } else if sim.rng.random() < 0.5 {
            -1.0
        } else {
            1.0
        };
        ai.stuck_t = 0.0;
    }
    // Ni l'avant ni l'arrière ne le sortent de là : le gyroscope le fait bondir
    let bot = &mut sim.bots[b];
    if pushing && speed < 0.5 {
        bot.ai.blocked_t += dt;
    } else if speed > 1.0 {
        bot.ai.blocked_t = 0.0;
    }
    if bot.ai.blocked_t > UNSTICK_DELAY {
        unstick(bot);
        bot.ai.blocked_t = 0.0;
    }

    if throttle > 0.0 {
        (throttle, steer) = avoid_obstacles(sim, b, pos, f, speed, throttle, steer);
    }
    if steered && throttle > 0.0 {
        (throttle, steer) = limit_cornering(sim, b, max_curvature, throttle, steer, speed);
    }
    // (sans propulseur : ni fuite ni charge au boost)
    drive(&sim.phys, &mut sim.bots[b], Some(rb), throttle, steer, false, false, 0.0, gravity);
}
