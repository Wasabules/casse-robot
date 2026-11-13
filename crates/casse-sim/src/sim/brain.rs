//! L'IA qui conduit un robot (src/shared/ai/brain.ts) : au sol, elle patrouille vers des
//! destinations tirées au hasard (`wander`), contourne le décor (navigation.rs), évite ce qu'elle a
//! devant elle (trois rayons relancés toutes les 50 ms : `avoidObstacles`), ne prend pas de virage
//! plus serré que sa stabilité ne le permet (`limitCornering`), recule en contre-braquant quand elle
//! est coincée, et fait bondir le robot (`unstick`) quand ni l'avant ni l'arrière ne l'en sortent.
//! Heurtée par un autre robot ou soufflée par une explosion, elle fuit, ou fonce sur ce qui l'a
//! heurtée si le robot est fait pour charger (`onHit`). Ses propulseurs s'allument en fuite ou en
//! charge, ou sur un ennemi collé à son arrière, jamais s'ils brûleraient son propre robot. En vol
//! stationnaire (`thinkFlying`), elle patrouille à son altitude, fuit en montant, se pose pour
//! recharger ses batteries (`land`) ; un avion suit le pilote d'avion (pilot.rs).
//!
//! Il n'y a ni partie (pas de zones à prendre : la patrouille va au hasard), ni pause de l'IA, ni
//! lave, ni eau profonde ; elle contourne les mines ennemies que son équipe a repérées
//! (navigation.rs, `avoidMines`). Au combat, sa tactique (tactics.rs) choisit où aller, ses tourelles
//! visent et tirent (gunner.rs), ses armes de contact tournent et frappent (brawl.rs) : en chargeant,
//! elle présente son arme à sa cible ; une mâchoire qui tient sa proie la traîne à reculons ; une lame
//! qui mord un robot ne se croit pas coincée.

use super::arena::{deep_water_at, edge_ahead, flight_level, lava_at, nearest_passable, on_bridge, on_nav, passable, surface_height};
use super::brawl::{melee_bearing, melee_biting, melee_drive, melee_skim};
use super::debris::block_world_pos;
use super::drive::{FLIPPED_UP_Y, RIGHTING_TIME, drive, driven_wheels, local_com, steering_geometry};
use super::exhaust::{foe_in_jet, scorches_itself};
use super::catalog::Mobility;
use super::lifecycle::energy_capacity;
use super::propulsion::{fly_toward, idle_thrusters, live_thrusters};
use super::robot::Role;
use super::supports::{grounded_supports, live_supports};
use super::navigation::{avoid_mines, flat_distance, inside_obstacle, navigate};
use super::robot::Bot;
use super::tactics::{Tactics, cover_spot, plan_combat};
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
/// Vitesse au-delà de laquelle un robot à roues n'allume plus son propulseur (m/s).
const BOOST_MAX_SPEED: f64 = 11.0;
/// Distance du point vers lequel fuit un avion (m), et sa limite (part de la demi-largeur de l'arène).
const PLANE_FLEE_DISTANCE: f64 = 80.0;
const PLANE_FLEE_REACH: f64 = 1.25;
/// Altitude d'un robot volant qui se cache derrière un pilier, ou qui va s'y poser (m).
const COVER_ALT: f64 = 1.8;
/// Sous cette charge, un robot volant se pose pour recharger ; il repart au-dessus de RECHARGED.
const LOW_ENERGY: f64 = 0.15;
const RECHARGED: f64 = 0.9;
/// Posé : hauteur (m) et vitesse (m/s) sous lesquelles il coupe ses moteurs pour finir de se poser.
const TOUCHDOWN_HEIGHT: f64 = 1.3;
const TOUCHDOWN_SPEED: f64 = 1.5;

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
    /// Altitude visée en vol (m) ; le trim de profondeur d'un avion (le terme intégral de son pilote
    /// automatique) ; le lacet piloté (l'aide, de 0 à 1, qui retombe peu à peu : contre le dérapage d'un
    /// avion en virage à plat, ou du gyroscope d'un robot volant qui pivote) ; le circuit d'attaque d'un
    /// bombardier (pilot.rs).
    pub alt: f64,
    pub trim: f64,
    pub slip: f64,
    pub bomb_run: Option<BombRun>,
    /// Sa tactique en combat (tactics.rs).
    pub tactics: Tactics,
}

/// Où en est un bombardier de son circuit d'attaque (`AiState.bombRun`) : sa phase, la direction de sa
/// passe (horizontale, unitaire), le côté de son demi-tour (1 : à gauche, -1 : à droite).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BombRun {
    pub phase: RunPhase,
    pub dir: V3,
    pub turn: f64,
}

/// Les phases du circuit d'attaque : la passe sur la cible, l'éloignement, le demi-tour.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunPhase {
    Pass,
    Out,
    Turn,
}

impl AiState {
    /// L'état d'un robot qui apparaît en `pos` (`createAiState`) : sa destination est là où il est,
    /// il en choisit une à sa première décision ; `alt`, l'altitude qu'il vise en vol (tirée au hasard
    /// par l'appelant pour un robot volant ou un avion, avant le reste du robot).
    pub fn new(pos: V3, alt: f64) -> Self {
        AiState {
            mode: Mode::Patrol,
            target: pos,
            timer: 0.0,
            mode_t: 0.0,
            stuck_t: 0.0,
            blocked_t: 0.0,
            flip: 1.0,
            probes: None,
            alt,
            trim: 0.0,
            slip: 0.0,
            bomb_run: None,
            tactics: Tactics::new(),
        }
    }
}

/// Le robot à qui appartient un collider (`ownerBot`) : celui d'un morceau, d'une roue, d'une tête de tourelle.
pub fn owner_bot(sim: &Sim, owner: Option<&Owner>) -> Option<usize> {
    match owner {
        Some(Owner::Part(p)) => sim.parts[*p].as_ref().map(|part| part.bot),
        Some(Owner::Wheel(bot, _)) | Some(Owner::Head(bot, _)) | Some(Owner::Blade(bot, _)) => Some(*bot),
        _ => None,
    }
}

/// Point ramené dans la zone où circulent les robots (`clampToRoam`), et pas dans la mer, la lave, ni
/// sur un flanc trop raide (la grille de passage).
pub fn clamp_to_roam(sim: &Sim, p: V3) -> V3 {
    let roam = sim.bounds.roam;
    nearest_passable(sim, v3(clamp(p.x, -roam, roam), 0.0, clamp(p.z, -roam, roam)))
}

/// Une destination au hasard dans la zone où rôde l'IA, à plus de 10 m de `from`, là où l'on peut
/// aller (`wander`) : ni dans la mer, la lave ou sur un flanc trop raide (la grille de passage), ni sur
/// une butte qu'aucun sentier ne relie (le réseau de passage) ; en ville, dans la rue.
fn wander(sim: &mut Sim, b: usize, from: V3) {
    let roam = sim.bounds.roam - 3.0;
    let mobility = sim.bots[b].mobility;
    let street = sim.arena.urban && mobility != Mobility::Hover && mobility != Mobility::Plane;
    let radius = sim.bots[b].radius;
    for _ in 0..12 {
        let x = sim.rng.rand(-roam, roam);
        let z = sim.rng.rand(-roam, roam);
        let t = v3(x, 0.0, z);
        let reached = |s: &Sim| match (&s.arena.graph, &s.arena.terrain) {
            (Some(graph), Some(terrain)) => on_nav(terrain, &graph.points, t.x, t.z),
            _ => true,
        };
        if flat_distance(t, from) > 10.0 && passable(sim, t.x, t.z) && reached(sim) && !(street && inside_obstacle(sim, t, radius + 1.0)) {
            sim.bots[b].ai.target = t;
            break;
        }
    }
    sim.bots[b].ai.timer = sim.rng.rand(10.0, 16.0);
}

/// Une destination de patrouille (`pickPatrolTarget` ; sans partie, pas de zone à prendre : au hasard).
fn pick_patrol_target(sim: &mut Sim, b: usize, from: V3) {
    let Some(objective) = super::tactics::objective_zone(sim, b, from) else {
        wander(sim, b, from);
        return;
    };
    // En capture de zones : un point de la zone à prendre ou à tenir, à sa hauteur
    let (pos, radius) = (objective.zone.pos, objective.zone.radius);
    let a = sim.rng.rand(0.0, std::f64::consts::PI * 2.0);
    let r = sim.rng.rand(0.0, radius * 0.6);
    let timer = sim.rng.rand(6.0, 10.0);
    let ai = &mut sim.bots[b].ai;
    ai.target = v3(pos.x + dcos(a) * r, pos.y, pos.z + dsin(a) * r);
    ai.timer = timer;
}

/// Réaction à un coup venu de `shooter` (`onHit`) : un choc avec un autre robot, une explosion. Il
/// fuit, ou charge s'il est fait pour ça (en combat, il ne romprait pas : hors combat, il n'y est pas).
pub fn on_hit(sim: &mut Sim, b: usize, shooter: V3) {
    if !sim.bots[b].cockpit_alive() {
        return;
    }
    let pos = sim.bots[b].last_pos;
    // (en capture de zones, sur le chemin d'une zone : il ne rompt pas)
    if matches!(sim.bots[b].ai.mode, Mode::Engage | Mode::Cover | Mode::Support) || sim.bots[b].ai.tactics.holding {
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
        let mobility = sim.bots[b].mobility;
        let half = sim.bounds.half;
        let ai = &mut sim.bots[b].ai;
        ai.mode = Mode::Flee;
        ai.mode_t = 4.0;
        if mobility == Mobility::Plane {
            // Un avion vire large : un point proche le ferait tourner en rond en perdant de l'altitude
            let flee = add(pos, scale(away, PLANE_FLEE_DISTANCE));
            let reach = jsmath::hypot2(flee.x, flee.z);
            let limit = half * PLANE_FLEE_REACH;
            ai.target = if reach > limit { scale(flee, limit / reach) } else { flee };
            ai.alt = jsmath::min(ai.alt + 3.0, 20.0);
        } else {
            let target = clamp_to_roam(sim, add(pos, scale(away, FLEE_DISTANCE)));
            let ai = &mut sim.bots[b].ai;
            ai.target = target;
            if mobility == Mobility::Hover {
                ai.alt = jsmath::min(ai.alt + 1.5, 9.0);
            }
        }
    }
}

/// Les robots touchés réagissent, s'il y a un tireur (`react` : un choc entre deux robots, une explosion).
pub fn react(sim: &mut Sim, hit: &[usize], source: Option<V3>) {
    if let Some(shooter) = source {
        for &b in hit {
            on_hit(sim, b, shooter);
        }
    }
    sim.emit_damage(hit);
}

/// Tension moyenne appliquée aux moteurs des roues motrices (0 à 1) (`averageDrive`).
fn average_drive(bot: &Bot) -> f64 {
    let wheels = driven_wheels(bot);
    if wheels.is_empty() {
        return 0.0;
    }
    wheels.iter().fold(0.0, |s, w| s + w.drive.abs()) / wheels.len() as f64
}

/// Hauteur du sol sous le robot : sous ses roues, ou sous ses appuis, sinon sous son centre de masse
/// (`groundUnder`).
fn ground_under(sim: &Sim, b: usize, pos: V3) -> f64 {
    let bot = &sim.bots[b];
    let mut ground = f64::INFINITY;
    for w in driven_wheels(bot) {
        ground = jsmath::min(ground, w.rb.pos.y - w.def.radius);
    }
    for s in grounded_supports(sim, b) {
        let support = bot.supports[s];
        ground = jsmath::min(ground, block_world_pos(sim, b, support.block).y - support.contact);
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

/// La lave et l'eau profonde comptent comme un obstacle à moins de HAZARD_MARGIN m de leur bord ; on
/// les cherche par pas de HAZARD_STEP m.
const HAZARD_MARGIN: f64 = 1.5;
const HAZARD_STEP: f64 = 1.0;

/// Distance (m) le long de `dir` (horizontal, unitaire) à laquelle on entre dans la lave ou l'eau
/// profonde (avec une marge), au plus `reach` ; ∞ s'il n'y en a pas, ou si l'arène n'a ni l'une ni
/// l'autre (`hazardDistance`). Le robot qui y est déjà n'en est pas empêché d'en sortir.
fn hazard_distance(sim: &Sim, from: V3, dir: V3, reach: f64) -> f64 {
    if sim.arena.lava.is_empty() && sim.arena.deep_water.is_none() {
        return f64::INFINITY;
    }
    // Un pont passe au-dessus de l'eau : ce n'est pas un danger
    let danger = |x: f64, z: f64| (lava_at(sim, x, z, HAZARD_MARGIN) > -HAZARD_MARGIN || deep_water_at(sim, x, z)) && !on_bridge(sim, x, z);
    if danger(from.x, from.z) {
        return f64::INFINITY;
    }
    let mut d = HAZARD_STEP;
    while d <= reach {
        if danger(from.x + dir.x * d, from.z + dir.z * d) {
            return d;
        }
        d += HAZARD_STEP;
    }
    f64::INFINITY
}

/// Évitement des obstacles (`avoidObstacles`) : trois rayons horizontaux partent du robot, droit
/// devant et de biais, aussi loin qu'il roulera dans LOOKAHEAD s (relancés toutes les PROBE_PERIOD s,
/// gardés entre deux). Un obstacle droit devant (décor, accessoire, autre robot) le fait ralentir et
/// braquer du côté le plus dégagé ; un obstacle de biais l'en écarte un peu. En charge, il ne
/// s'écarte pas des ennemis : il les percute. (Sans lave, sans eau profonde, sans falaise.)
fn avoid_obstacles(sim: &mut Sim, b: usize, pos: V3, forward: V3, speed: f64, throttle: f64, steer: f64) -> (f64, f64) {
    let bot = &sim.bots[b];
    let reach = bot.radius + jsmath::max(LOOKAHEAD_MIN, speed * LOOKAHEAD);
    let from = v3(pos.x, ground_under(sim, b, pos) + PROBE_HEIGHT, pos.z);
    let ramming = bot.ai.mode == Mode::Charge;
    let team = bot.team;
    let level = from.y - PROBE_HEIGHT;
    let surface = sim.arena.graph.is_some() && sim.arena.terrain.is_some();
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
                // La lave et la mer arrêtent aussi le robot, sans qu'aucun rayon ne les voie
                let seen = match hit {
                    Some(h) if !(h.normal.y > SLOPE_UP_Y) => h.time_of_impact,
                    _ => f64::INFINITY,
                };
                let at = jsmath::min(seen, hazard_distance(s, from, dir, reach));
                // Là où le relief a des falaises (arène à réseau de passage), le bord d'où il tomberait,
                // ou la pente qu'il ne monterait pas, compte comme un obstacle
                if surface { jsmath::min(at, edge_ahead(|x, z| surface_height(s, x, z, level), pos.x, pos.z, dir.x, dir.z, reach)) } else { at }
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
pub fn think_ground(sim: &mut Sim, b: usize, pos: V3) -> f64 {
    let dt = STEP;
    let rb = sim.part(sim.bots[b].cockpit_part()).rb;
    let q = sim.phys.rotation(rb);
    let up = qrot(q, v3(0.0, 1.0, 0.0));
    if up.y < FLIPPED_UP_Y {
        sim.bots[b].ai.mode = Mode::Flipped;
        drive(sim, b, 0.0, 0.0, false, false, 0.0);
        return 0.0;
    }
    if driven_wheels(&sim.bots[b]).is_empty() && live_supports(sim, b).is_empty() {
        sim.bots[b].ai.mode = Mode::Stranded;
        return 0.0;
    }
    // L'IA figée (`aiPaused` : la console, l'arène libre)
    if sim.ai_paused {
        sim.bots[b].ai.mode = Mode::Paused;
        drive(sim, b, 0.0, 0.0, false, false, 0.0);
        return 0.0;
    }
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
    // En combat : engager, se mettre à couvert, charger (sauf pendant une fuite ou un dégagement)
    if sim.combat && !matches!(sim.bots[b].ai.mode, Mode::Flee | Mode::Reverse) {
        plan_combat(sim, b, pos, dt);
    }
    let ai = &sim.bots[b].ai;
    if ai.mode == Mode::Patrol && (ai.timer <= 0.0 || flat_distance(ai.target, pos) < ARRIVED) {
        pick_patrol_target(sim, b, pos);
    }

    let fwd = qrot(q, v3(0.0, 0.0, 1.0));
    let f = norm(v3(fwd.x, 0.0, fwd.z));
    // Autour du décor : le coin d'un muret, le pied d'une rampe (navigation.rs) ; pas de mines à éviter
    let target = sim.bots[b].ai.target;
    let goal = navigate(sim, b, pos, target);
    let goal = avoid_mines(sim, b, pos, goal);
    let d = norm(v3(goal.x - pos.x, 0.0, goal.z - pos.z));
    // > 0 : la cible est à gauche
    let mut ang = (f.z * d.x - f.x * d.z).atan2(f.x * d.x + f.z * d.z);
    // En chargeant, il présente son arme de contact à sa cible (une scie qui mord longe sa cible)
    if sim.bots[b].ai.mode == Mode::Charge {
        let bearing = melee_bearing(sim, b).unwrap_or(0.0) + melee_skim(sim, b);
        if bearing != 0.0 {
            ang = dsin(ang - bearing).atan2(dcos(ang - bearing));
        }
    }

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
    // Sa mâchoire tient une proie : il recule en la traînant ; ni coincé, ni à dégager
    let held = if sim.bots[b].melee.is_empty() { None } else { melee_drive(sim, b) };
    if let Some((throttle, steer)) = held {
        drive(sim, b, throttle, steer, false, false, 0.0);
        let ai = &mut sim.bots[b].ai;
        ai.stuck_t = 0.0;
        ai.blocked_t = 0.0;
        return 0.0;
    }

    // Coincé contre un mur ou un obstacle (les moteurs poussent mais le robot n'avance ni ne tourne) :
    // marche arrière en braquant ; avec des roues directrices, en contre-braquant
    let v = sim.phys.linvel(rb);
    let speed = jsmath::hypot2(v.x, v.z);
    let spin = sim.phys.angvel(rb).y.abs();
    // (une lame qui mord un robot : il pousse dedans, il n'est pas coincé)
    let pushing = average_drive(&sim.bots[b]) > STUCK_DRIVE && !(!sim.bots[b].melee.is_empty() && melee_biting(sim, b));
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
    // Propulseur éventuel : à fond en fuite ou en charge, bien aligné et sous la vitesse limite ; les
    // roues aident alors sans jamais retenir (roue libre à cliquet). Un ennemi collé à son arrière,
    // dans le jet de ses propulseurs : il les allume aussi, le jet le brûle (exhaust.rs). Jamais s'ils
    // brûleraient son propre robot
    let engines = !live_thrusters(sim, b, Some(Role::Cruise)).is_empty();
    let mode = sim.bots[b].ai.mode;
    let rushing = (mode == Mode::Flee || mode == Mode::Charge) && ang.abs() < 0.35 && speed < BOOST_MAX_SPEED;
    let scorching = engines && !rushing && mode != Mode::Reverse && throttle > 0.0 && foe_in_jet(sim, b, Role::Cruise);
    let boost = engines && (rushing || scorching) && !scorches_itself(sim, b, Role::Cruise);
    drive(sim, b, throttle, steer, boost, false, 0.0);
    if boost { 1.0 } else { 0.0 }
}

/// Charge des batteries, de 0 à 1 (`energyFraction`).
fn energy_fraction(sim: &Sim, b: usize) -> f64 {
    let capacity = energy_capacity(sim, b);
    if capacity != 0.0 { clamp(sim.bots[b].energy / capacity, 0.0, 1.0) } else { 0.0 }
}

/// Au-dessus des toits (`hoverFloor`), il ne descend qu'à moins de cette distance de sa destination (m).
const DESCENT: f64 = 6.0;

/// Altitude de croisière d'un robot volant de l'IA au-dessus du relief : la sienne, mais au-dessus
/// des toits d'une ville (`cruiseAlt`, `hoverFloor`).
fn cruise_alt(sim: &Sim, ai: &AiState) -> f64 {
    jsmath::max(ai.alt, sim.arena.hover_floor)
}

/// Altitude où il descend pour s'abriter ou se poser (`lowAlt`) : COVER_ALT, mais seulement une fois
/// arrivé au-dessus de sa destination quand il y a des toits à survoler.
fn low_alt(sim: &Sim, ai: &AiState, pos: V3) -> f64 {
    if sim.arena.hover_floor != 0.0 && flat_distance(ai.target, pos) > DESCENT { cruise_alt(sim, ai) } else { COVER_ALT }
}

/// Descend à la verticale jusqu'au sol, puis coupe les moteurs (`land`).
fn land(sim: &mut Sim, b: usize, pos: V3) {
    let keep = |h| {
        let owner = sim.owners.get(&h);
        !matches!(owner, Some(Owner::Debris)) && owner_bot(sim, owner) != Some(b)
    };
    let hit = sim.phys.cast_ray_where(pos, v3(0.0, -1.0, 0.0), 50.0, true, &keep);
    let height = hit.unwrap_or(pos.y);
    let v = sim.phys.linvel(sim.part(sim.bots[b].cockpit_part()).rb);
    if height < TOUCHDOWN_HEIGHT && jsmath::hypot3(v.x, v.y, v.z) < TOUCHDOWN_SPEED {
        idle_thrusters(sim, b);
    } else {
        fly_toward(sim, b, v3(pos.x, pos.y - height + TOUCHDOWN_HEIGHT * 0.6, pos.z), None);
    }
}

/// Un robot volant de l'IA (`thinkFlying`) : sans moteur, il tombe ; batteries presque vides, il se
/// pose (à l'abri s'il est en combat), recharge, puis repart ; sinon, il patrouille, fuit, ou suit sa
/// tactique, à son altitude de croisière (plus bas, derrière un pilier, à couvert).
pub fn think_flying(sim: &mut Sim, b: usize, pos: V3) {
    let dt = STEP;
    if live_thrusters(sim, b, None).is_empty() {
        sim.bots[b].ai.mode = Mode::Falling;
        return;
    }
    // L'IA figée : il tient sa place, à son altitude de croisière
    if sim.ai_paused {
        sim.bots[b].ai.mode = Mode::Hover;
        let alt = cruise_alt(sim, &sim.bots[b].ai);
        let level = flight_level(sim, pos, pos, alt);
        fly_toward(sim, b, v3(pos.x, level, pos.z), None);
        return;
    }
    // Batteries presque vides : il se pose (à l'abri s'il est en combat), recharge, puis repart
    let charge = energy_fraction(sim, b);
    let landing = sim.bots[b].ai.mode == Mode::Landing;
    if if landing { charge < RECHARGED } else { charge < LOW_ENERGY } {
        if !landing {
            let target = match sim.bots[b].ai.tactics.foe {
                Some(foe) => {
                    let threat = sim.bots[foe].last_pos;
                    cover_spot(sim, b, pos, threat)
                }
                None => pos,
            };
            sim.bots[b].ai.target = nearest_passable(sim, target);
        }
        sim.bots[b].ai.mode = Mode::Landing;
        let target = sim.bots[b].ai.target;
        if flat_distance(target, pos) > ARRIVED {
            let level = flight_level(sim, pos, target, low_alt(sim, &sim.bots[b].ai, pos));
            fly_toward(sim, b, v3(target.x, level, target.z), None);
        } else {
            land(sim, b, pos);
        }
        return;
    }
    if landing {
        sim.bots[b].ai.mode = Mode::Patrol;
        pick_patrol_target(sim, b, pos);
    }
    let ai = &mut sim.bots[b].ai;
    ai.mode_t -= dt;
    ai.timer -= dt;
    if ai.mode == Mode::Flee && ai.mode_t <= 0.0 {
        ai.mode = Mode::Patrol;
        pick_patrol_target(sim, b, pos);
        let ai = &mut sim.bots[b].ai;
        ai.alt = jsmath::max(4.5, ai.alt - 1.5);
    }
    if sim.combat && sim.bots[b].ai.mode != Mode::Flee {
        plan_combat(sim, b, pos, dt);
    }
    let ai = &sim.bots[b].ai;
    if ai.mode == Mode::Patrol && (ai.timer <= 0.0 || flat_distance(ai.target, pos) < ARRIVED) {
        pick_patrol_target(sim, b, pos);
    }
    // À couvert, il descend derrière le pilier (en ville, une fois au-dessus de lui)
    let ai = &sim.bots[b].ai;
    let alt = if ai.mode == Mode::Cover { low_alt(sim, ai, pos) } else { cruise_alt(sim, ai) };
    let target = ai.target;
    let level = flight_level(sim, pos, target, alt);
    fly_toward(sim, b, v3(target.x, level, target.z), None);
}
