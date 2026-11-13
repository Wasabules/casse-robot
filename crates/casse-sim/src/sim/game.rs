//! Ce qui fait d'un monde une partie (src/shared/sim/wave.ts, match.ts, robot/lifecycle.ts) : les
//! robots présents (`sim.bots`, que remplace un robot qui réapparaît), d'où naît chacun (son profil,
//! que donne la session), les commandes des pilotes, le retrait d'un robot (`removeBot`), l'arène vidée
//! et ses accessoires remis en place (`clearArena`, `resetProps`), les vagues et les équipes qui
//! apparaissent (`spawnWave`, `spawnTeams`, `respawnBot`), et la partie (`startMatch`, `updateMatch` :
//! réapparitions, sabordages, zones, roi de la colline, fin de partie).
//!
//! Le placement des robots est celui du TypeScript, nombre pour nombre (les mêmes tirages, les mêmes
//! fonctions trigonométriques déterministes, le même ordre des opérations) : une partie qui commence ici
//! met chaque robot exactement là où la met celle du TypeScript.

use super::barriers::remove_barrier;
use super::brain::Mode;
use super::catalog::{Mobility, Robot, catalog};
use super::damage::{DamageBatch, Target, inflict};
use super::debris::clear_debris;
use super::events::code;
use super::fire::remove_ground_fire;
use super::lifecycle::spawn_robot;
use super::props::{add_prop, prop_half, remove_prop};
use super::robot::{Input, design_radius, ground_height};
use super::arena::{ground_level, passable};
use super::vec::{Q, V3, v3};
use super::wheels::WheelPose;
use super::world::{STEP, Sim};
use crate::det::{dcos, dsin};
use crate::jsmath;
use std::f64::consts::PI;
use std::rc::Rc;

/// Les équipes (`Team`) : les rouges, les bleus.
pub const RED: usize = 0;
pub const BLUE: usize = 1;

/// Un emplacement d'accessoire de l'arène (`PropSpot`) : son type, sa place, sa rotation (rien :
/// debout), ses dimensions (une dalle), son échelle, ce sur quoi il repose.
#[derive(Clone, Debug)]
pub struct Spot {
    pub kind: String,
    pub pos: V3,
    pub rot: Option<Q>,
    pub half: Option<V3>,
    pub scale: Option<f64>,
    pub rests: Vec<usize>,
}

/// Une ligne de départ placée où l'on veut (`SpawnLine`) : son milieu, la direction où regarde l'équipe
/// (rad), sa demi-longueur (m).
#[derive(Clone, Copy, Debug)]
pub struct SpawnLine {
    pub x: f64,
    pub z: f64,
    pub facing: f64,
    pub spread: f64,
}

/// Une zone à capturer de l'arène (`CaptureZone`) : son centre, son rayon.
#[derive(Clone, Copy, Debug)]
pub struct Zone {
    pub pos: V3,
    pub radius: f64,
}

/// Capture de zones (`CaptureRules`).
#[derive(Clone, Copy, Debug)]
pub struct Capture {
    pub time: f64,
    pub rate: f64,
    pub hill: Option<f64>,
}

/// Les règles d'une partie (`MatchRules`) ; `respawn` rien : l'élimination.
#[derive(Clone, Copy, Debug)]
pub struct Rules {
    pub score_to_win: f64,
    pub time_limit: f64,
    pub respawn: Option<f64>,
    pub capture: Option<Capture>,
}

/// Le vainqueur d'une partie.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Winner {
    Team(usize),
    Draw,
}

/// L'état d'une zone (`ZoneState`).
#[derive(Clone, Copy, Debug)]
pub struct ZoneState {
    pub zone: Zone,
    pub owner: Option<usize>,
    pub progress: f64,
    pub contested: bool,
    pub active: bool,
}

/// Une partie (`Match`).
pub struct Match {
    pub rules: Rules,
    pub score: [f64; 2],
    pub elapsed: f64,
    pub winner: Option<Winner>,
    /// Robots détruits qui attendent de réapparaître, et quand.
    pub respawns: Vec<(usize, f64)>,
    /// Temps passé renversé ou immobilisé, par robot de l'IA.
    pub stuck: Vec<(usize, f64)>,
    pub zones: Vec<ZoneState>,
    pub next_hill: f64,
}

/// Au-delà de ce temps renversé ou immobilisé (s), un robot de l'IA se saborde (`STUCK_LIMIT`).
const STUCK_LIMIT: f64 = 12.0;
/// Un robot compte dans une zone jusqu'à cette hauteur au-dessus d'elle (m).
const ZONE_HEIGHT: f64 = 8.0;
/// Une zone que personne n'occupe revient vers son état à cette part de la vitesse de prise.
const ZONE_RECOVERY: f64 = 0.5;

/// Cercles d'apparition d'une vague, en part de la ligne de départ (`SPAWN_RINGS`).
const SPAWN_RINGS: [f64; 4] = [0.8, 0.52, 0.28, 1.03];
/// Altitude d'apparition des robots à rotors, et des avions, au-dessus du sol (m).
const HOVER_SPAWN_Y: f64 = 5.0;
const PLANE_SPAWN_Y: f64 = 12.0;
/// Écarts à l'apparition (m) : entre deux robots ou avec le décor ; avec le centre d'un accessoire.
const SPAWN_CLEARANCE: f64 = 1.0;
const PROP_CLEARANCE: f64 = 1.5;
/// Marge aux extrémités du demi-cercle d'une équipe (rad).
const SIDE_MARGIN: f64 = 0.35;

pub fn other_team(team: usize) -> usize {
    1 - team
}

fn team_sign(team: usize) -> f64 {
    if team == BLUE { 1.0 } else { -1.0 }
}

/// Le profil `p` (un rang de `Sim.profiles`).
pub fn profile(sim: &Sim, p: usize) -> Rc<Robot> {
    sim.profiles[p].clone()
}

/// Retire un robot entier du monde (`removeBot`) : ses blocs ne comptent plus pour personne, ses
/// feux s'éteignent, ses roues et ses morceaux disparaissent (une épave de roue garde une pose figée),
/// et ceux qui le visaient l'oublient. Il reste dans `sim.bots` (l'appelant le remplace ou vide la liste).
pub fn remove_bot(sim: &mut Sim, b: usize) {
    let cockpit = sim.bots[b].cockpit;
    sim.bots[b].blocks[cockpit].alive = false;
    for k in sim.bots[b].live.clone() {
        sim.fires.retain(|&f| f != (b, k));
        sim.bots[b].blocks[k].alive = false;
    }
    for w in 0..sim.bots[b].wheels.len() {
        let wheel = &sim.bots[b].wheels[w];
        // (une épave déjà retirée n'a plus rien à retirer)
        if wheel.part.is_none() && wheel.body.is_none() {
            continue;
        }
        let collider = wheel.collider;
        sim.owners.remove(&collider);
        // Une roue arrachée a son corps ; le collider d'une roue montée part avec le corps de son morceau
        if let Some(body) = sim.bots[b].wheels[w].body {
            let (at, rot) = (sim.phys.translation(body), sim.phys.rotation(body));
            sim.phys.remove_body(body);
            let still = v3(0.0, 0.0, 0.0);
            let wheel = &mut sim.bots[b].wheels[w];
            wheel.body = None;
            wheel.frozen = true;
            wheel.rb = WheelPose { pos: at, rot, vel: still, ang: still };
        }
        let wheel = &mut sim.bots[b].wheels[w];
        wheel.part = None;
        wheel.hub = None;
        let id = wheel.id;
        sim.emit(code::WHEEL_REMOVED, |s, wr| {
            wr.id(Some(id)).id(Some(s.bots[b].id));
        });
    }
    for p in sim.bots[b].parts.clone() {
        let Some(part) = sim.parts[p].take() else { continue };
        for c in part.colliders.iter().chain(part.heads.iter().flat_map(|h| h.head.iter().chain(h.barrel.iter()))) {
            sim.owners.remove(c);
        }
        for blade in &part.blades {
            for c in &blade.colliders {
                sim.owners.remove(c);
            }
        }
        sim.order.retain(|&x| x != p);
        sim.phys.remove_body(part.rb);
        sim.emit_part(code::PART_REMOVED, part.id, b);
    }
    // Les tourelles qui le visaient l'oublient, même celles d'un robot hors de combat ou paralysé
    for &o in &sim.roster {
        let other = &mut sim.bots[o];
        for t in other.turrets.iter_mut() {
            if t.target == Some(b) {
                t.target = None;
            }
            if t.lock_on == Some(b) {
                t.lock_on = None;
                t.lock_time = 0.0;
            }
        }
        if other.ai.tactics.foe == Some(b) {
            other.ai.tactics.foe = None;
        }
    }
    *sim.obstacle_cache.borrow_mut() = None;
    sim.emit(code::BOT_REMOVED, |s, w| {
        w.id(Some(s.bots[b].id));
    });
}

/// Remet les accessoires à leur place de départ, et éteint les flaques de feu (`resetProps`).
pub fn reset_props(sim: &mut Sim) -> Result<(), String> {
    while !sim.ground_fires.is_empty() {
        remove_ground_fire(sim, 0);
    }
    for i in 0..sim.props.len() {
        if sim.props[i].is_some() {
            remove_prop(sim, i, false);
        }
    }
    sim.props.clear();
    sim.prop_fires.clear();
    *sim.obstacle_cache.borrow_mut() = None;
    for spot in sim.arena.spots.clone() {
        let i = add_prop(sim, &spot.kind, spot.pos, spot.rot, spot.half, spot.scale)?;
        sim.props[i].as_mut().expect("accessoire").rests = spot.rests.clone();
    }
    Ok(())
}

/// Vide l'arène : robots, débris, projectiles, fumées, murs d'énergie ; remet les accessoires en place
/// (`clearArena`).
pub fn clear_arena(sim: &mut Sim) -> Result<(), String> {
    for b in sim.roster.clone() {
        remove_bot(sim, b);
    }
    sim.roster.clear();
    clear_debris(sim);
    for k in 0..sim.projectiles.len() {
        sim.projectiles[k].done = true;
        let id = sim.projectiles[k].id;
        sim.emit_gone(code::PROJECTILE_REMOVED, id);
    }
    sim.projectiles.clear();
    for c in std::mem::take(&mut sim.smokes) {
        sim.emit_gone(code::SMOKE_REMOVED, c.id);
    }
    while !sim.barriers.is_empty() {
        remove_barrier(sim, 0, false);
    }
    reset_props(sim)?;
    // Les blocs en feu des robots retirés : le TypeScript les garde dans `sim.fires` jusqu'à la
    // prochaine tranche des feux, qui les ôte sans rien faire (des blocs détruits) ; ils partent dès
    // maintenant, avant que leur robot ne rende ses blocs (une tranche lisait sinon un bloc qui n'est plus)
    let bots = &sim.bots;
    sim.fires.retain(|&(b, k)| bots[b].blocks.get(k).is_some_and(|block| block.alive));
    // Plus rien ne tient les robots retirés (projectiles, flaques, feux, débris : partis avec eux) : ils
    // ne gardent que leur numéro et leur cockpit éteint (ce que la détection d'avant, jusqu'à sa
    // prochaine tranche, en lit), et rendent le reste. Sans cela, un serveur qui enchaîne les parties
    // garderait chaque robot né (le TypeScript, lui, les laisse au ramasse-miettes).
    for bot in sim.bots.iter_mut() {
        shrink(bot);
    }
    Ok(())
}

/// Un robot retiré réduit à son numéro, son équipe, son profil et son cockpit éteint.
fn shrink(bot: &mut super::robot::Bot) {
    if bot.blocks.len() <= 1 {
        return;
    }
    let cockpit = bot.blocks.swap_remove(bot.cockpit);
    bot.blocks = vec![cockpit];
    bot.cockpit = 0;
    bot.cells = Default::default();
    bot.live = Vec::new();
    bot.parts = Vec::new();
    bot.wheels = Vec::new();
    bot.thrusters = Vec::new();
    bot.supports = Vec::new();
    bot.surfaces = Vec::new();
    bot.melee = Vec::new();
    bot.turrets = Vec::new();
    bot.next_shot = Vec::new();
    bot.vulnerability = None;
    bot.flare_launchers = Vec::new();
    bot.shields = Vec::new();
    bot.cuts = Default::default();
    bot.cut_order = Vec::new();
    bot.lost_order = Vec::new();
    bot.nav = Default::default();
}

/// La ligne de départ d'une équipe (`spawnLineOf`).
fn spawn_line_of(sim: &Sim, team: usize) -> SpawnLine {
    let b = &sim.bounds;
    if let Some(lines) = &b.spawns {
        return lines[team];
    }
    SpawnLine { x: 0.0, z: (if team == BLUE { -1.0 } else { 1.0 }) * b.spawn_line, facing: if team == BLUE { 0.0 } else { PI }, spread: b.spawn_spread }
}

/// Un point de la ligne de départ d'une équipe, à `along` m de son milieu et `back` m derrière elle (`spawnPoint`).
fn spawn_point(sim: &Sim, team: usize, along: f64, back: f64) -> (f64, f64) {
    let b = &sim.bounds;
    let Some(lines) = &b.spawns else { return (along, (if team == BLUE { -1.0 } else { 1.0 }) * (b.spawn_line + back)) };
    let placed = lines[team];
    let c = dcos(placed.facing);
    let s = dsin(placed.facing);
    (placed.x + c * along - s * back, placed.z - s * along - c * back)
}

/// Un disque de rayon `r` en (x, z) ne touche ni le décor (sauf ce sur quoi l'on roule), ni un
/// accessoire, ni un robot déjà placé, et l'IA peut y aller (`isClear`).
fn is_clear(sim: &Sim, x: f64, z: f64, r: f64, placed: &[(f64, f64, f64)]) -> bool {
    for (dx, dz) in [(0.0, 0.0), (r, 0.0), (-r, 0.0), (0.0, r), (0.0, -r)] {
        if !passable(sim, x + dx, z + dz) {
            return false;
        }
    }
    let clamp = |v: f64, lo: f64, hi: f64| jsmath::max(lo, jsmath::min(hi, v));
    for b in &sim.boxes {
        if b.kind == "road" || b.kind == "deck" || b.kind == "track" {
            continue;
        }
        let dx = x - clamp(x, b.pos.x - b.half.x, b.pos.x + b.half.x);
        let dz = z - clamp(z, b.pos.z - b.half.z, b.pos.z + b.half.z);
        if jsmath::hypot2(dx, dz) < r + SPAWN_CLEARANCE {
            return false;
        }
    }
    let c = catalog();
    for spot in &sim.arena.spots {
        let half = prop_half(&c.props[&spot.kind], spot.half, spot.scale);
        let reach = jsmath::hypot2(half.x, half.z);
        let dx = jsmath::max(0.0, (x - spot.pos.x).abs() - if spot.rot.is_some() { reach } else { half.x });
        let dz = jsmath::max(0.0, (z - spot.pos.z).abs() - if spot.rot.is_some() { reach } else { half.z });
        if jsmath::hypot2(dx, dz) < r + PROP_CLEARANCE - 0.5 {
            return false;
        }
    }
    placed.iter().all(|&(px, pz, pr)| jsmath::hypot2(x - px, z - pz) >= r + pr + SPAWN_CLEARANCE)
}

/// Hauteur où poser un robot en (x, z) : au ras du sol, ou en vol stationnaire au-dessus (`spawnHeight`).
fn spawn_height(sim: &Sim, robot: &Robot, x: f64, z: f64, r: f64) -> f64 {
    let mut ground = ground_level(sim, x, z);
    for i in 0..8 {
        let a = (i as f64 / 8.0) * PI * 2.0;
        ground = jsmath::max(ground, ground_level(sim, x + dcos(a) * r, z + dsin(a) * r));
    }
    ground + if robot.mobility == Mobility::Hover { HOVER_SPAWN_Y } else { ground_height(&robot.design) + 0.03 }
}

/// Fait naître un robot du profil `p` (`spawnBot`).
fn spawn(sim: &mut Sim, p: usize, pos: V3, yaw: f64, team: usize) -> Result<usize, String> {
    let robot = profile(sim, p);
    spawn_robot(sim, &robot, p, "profil", pos, yaw, team, false)
}

/// Lance tout le robot à la vitesse `v` (`setBotVelocity`).
pub fn set_bot_velocity(sim: &mut Sim, b: usize, v: V3) {
    for p in sim.bots[b].parts.clone() {
        if let Some(part) = &sim.parts[p] {
            let rb = part.rb;
            sim.phys.set_linvel(rb, v, true);
        }
    }
    for w in 0..sim.bots[b].wheels.len() {
        if let Some(body) = sim.bots[b].wheels[w].body {
            sim.phys.set_linvel(body, v, true);
        }
    }
}

/// Un avion en vol sur son circuit, à l'angle `a`, déjà à sa vitesse de croisière (`launchPlane`).
fn launch_plane(sim: &mut Sim, p: usize, team: usize, a: f64) -> Result<usize, String> {
    let cos = dcos(a);
    let sin = dsin(a);
    let r = sim.bounds.circuit;
    let floor = sim.arena.air_floor;
    let y = ground_level(sim, cos * r, sin * r) + jsmath::max(PLANE_SPAWN_Y, floor);
    let b = spawn(sim, p, v3(cos * r, y, sin * r), -a, team)?;
    let alt = sim.bots[b].ai.alt;
    sim.bots[b].ai.alt = jsmath::max(alt, floor);
    let speed = sim.profiles[p].speed;
    set_bot_velocity(sim, b, v3(-sin * speed, 0.0, cos * speed));
    Ok(b)
}

/// Angle sur le cercle d'apparition des avions, du côté de l'équipe (`sideAngle`).
fn side_angle(sim: &Sim, team: usize, t: f64) -> f64 {
    let mut from = if team == BLUE { PI + SIDE_MARGIN } else { SIDE_MARGIN };
    if sim.bounds.spawns.is_some() {
        let line = spawn_line_of(sim, team);
        let toward = if jsmath::hypot2(line.x, line.z) > 1.0 { line.z.atan2(line.x) } else { (-dcos(line.facing)).atan2(-dsin(line.facing)) };
        from = toward - PI / 2.0 + SIDE_MARGIN;
    }
    from + t * (PI - 2.0 * SIDE_MARGIN)
}

/// Un robot sur la ligne de départ de son équipe, tourné comme elle, à la première place libre en
/// partant de `t` (`placeInLine`).
fn place_in_line(sim: &mut Sim, p: usize, team: usize, t: f64, placed: &mut Vec<(f64, f64, f64)>) -> Result<usize, String> {
    let robot = profile(sim, p);
    let r = design_radius(&robot.design);
    let line = spawn_line_of(sim, team);
    let a0 = (t * 2.0 - 1.0) * line.spread;
    let (mut x, mut z) = spawn_point(sim, team, a0, 0.0);
    'search: for back in [0.0, 3.0, -3.0, 5.0] {
        for k in 0..40 {
            let sign = if k % 2 == 1 { 1.0 } else { -1.0 };
            let along = jsmath::max(-line.spread - 4.0, jsmath::min(line.spread + 4.0, a0 + sign * (k as f64 / 2.0).ceil() * 0.6));
            (x, z) = spawn_point(sim, team, along, back);
            if is_clear(sim, x, z, r, placed) {
                break 'search;
            }
        }
    }
    placed.push((x, z, r));
    let y = spawn_height(sim, &robot, x, z, r);
    spawn(sim, p, v3(x, y, z), line.facing, team)
}

/// Un robot à la première place libre du cercle, en partant de `start` (`placeOnCircle`).
fn place_on_circle(sim: &mut Sim, p: usize, team: usize, start: f64, placed: &mut Vec<(f64, f64, f64)>) -> Result<usize, String> {
    let robot = profile(sim, p);
    let r = design_radius(&robot.design);
    let mut a = start;
    let rings = SPAWN_RINGS.map(|f| f * sim.bounds.spawn_line);
    let mut radius = rings[0];
    'search: for ring in rings {
        for k in 0..72 {
            let sign = if k % 2 == 1 { 1.0 } else { -1.0 };
            a = start + sign * (k as f64 / 2.0).ceil() * 0.05;
            radius = ring;
            if is_clear(sim, dcos(a) * ring, dsin(a) * ring, r, placed) {
                break 'search;
            }
        }
    }
    let x = dcos(a) * radius;
    let z = dsin(a) * radius;
    placed.push((x, z, r));
    let y = spawn_height(sim, &robot, x, z, r);
    spawn(sim, p, v3(x, y, z), -a + PI, team)
}

/// Un robot de l'équipe à la place `t` de sa ligne ; un avion, sur son circuit (`spawnOnSide`).
fn spawn_on_side(sim: &mut Sim, p: usize, team: usize, t: f64, placed: &mut Vec<(f64, f64, f64)>) -> Result<usize, String> {
    if sim.profiles[p].mobility == Mobility::Plane {
        let a = side_angle(sim, team, t);
        launch_plane(sim, p, team, a)
    } else {
        place_in_line(sim, p, team, t, placed)
    }
}

/// Vide l'arène et fait apparaître les robots en cercle, les équipes alternées (`spawnWave`).
pub fn spawn_wave(sim: &mut Sim, profiles: &[usize]) -> Result<(), String> {
    clear_arena(sim)?;
    let planes: Vec<usize> = profiles.iter().copied().filter(|&p| sim.profiles[p].mobility == Mobility::Plane).collect();
    let others: Vec<usize> = profiles.iter().copied().filter(|&p| sim.profiles[p].mobility != Mobility::Plane).collect();
    let mut placed = Vec::new();
    for (i, &p) in others.iter().enumerate() {
        let start = (i as f64 / others.len() as f64) * PI * 2.0 + 0.3;
        let b = place_on_circle(sim, p, if i % 2 == 1 { BLUE } else { RED }, start, &mut placed)?;
        sim.roster.push(b);
    }
    for (i, &p) in planes.iter().enumerate() {
        let a = (i as f64 / planes.len() as f64) * PI * 2.0 + 0.3;
        let b = launch_plane(sim, p, if i % 2 == 1 { RED } else { BLUE }, a)?;
        sim.roster.push(b);
    }
    Ok(())
}

/// Vide l'arène et fait apparaître deux équipes sur leurs lignes de départ (`spawnTeams`) ; les
/// robots, dans l'ordre des entrées (profil, équipe).
pub fn spawn_teams(sim: &mut Sim, entries: &[(usize, usize)]) -> Result<Vec<usize>, String> {
    clear_arena(sim)?;
    let mut placed = Vec::new();
    let mut bots = Vec::new();
    for (k, &(p, team)) in entries.iter().enumerate() {
        let mates = entries.iter().filter(|e| e.1 == team).count();
        let i = entries[..k].iter().filter(|e| e.1 == team).count();
        bots.push(spawn_on_side(sim, p, team, (i as f64 + 0.5) / mates as f64, &mut placed)?);
    }
    sim.roster.extend(&bots);
    Ok(bots)
}

/// Nouveau robot de l'équipe, à une place libre de son côté (`respawnBot`) ; l'appelant le met dans `sim.bots`.
pub fn respawn_bot(sim: &mut Sim, p: usize, team: usize) -> Result<usize, String> {
    let mut placed: Vec<(f64, f64, f64)> = sim
        .roster
        .iter()
        .filter(|&&b| sim.bots[b].cockpit_alive())
        .map(|&b| (sim.bots[b].last_pos.x, sim.bots[b].last_pos.z, sim.bots[b].radius))
        .collect();
    let t = sim.rng.rand(0.0, 1.0);
    spawn_on_side(sim, p, team, t, &mut placed)
}

/// Le robot passe aux commandes d'un pilote (`takeControl`), dont les commandes sont au rang `slot`
/// de `Sim.inputs`.
pub fn take_control(sim: &mut Sim, b: usize, slot: usize) {
    if sim.inputs.len() <= slot {
        sim.inputs.resize(slot + 1, Input::default());
    }
    let bot = &mut sim.bots[b];
    bot.piloted = true;
    bot.input_slot = Some(slot);
}

/// Le robot repasse à l'IA (`releaseControl`).
pub fn release_control(sim: &mut Sim, b: usize) {
    let bot = &mut sim.bots[b];
    bot.piloted = false;
    bot.input_slot = None;
}

/// Les commandes des pilotes, recopiées dans leurs robots au début du pas (`bot.input ?? sim.input`).
pub fn read_inputs(sim: &mut Sim) {
    for &b in &sim.roster {
        if let Some(slot) = sim.bots[b].input_slot {
            sim.bots[b].input = sim.inputs[slot];
        }
    }
}

/// Commence une partie sur les robots déjà en place (`startMatch`) ; au roi de la colline, seule la
/// zone du milieu de la liste est d'abord en jeu.
pub fn start_match(sim: &mut Sim, rules: Rules) {
    let zones: Vec<ZoneState> = match rules.capture {
        None => Vec::new(),
        Some(c) => {
            let first = sim.arena.zones.len() / 2;
            sim.arena.zones.iter().enumerate().map(|(i, &zone)| ZoneState { zone, owner: None, progress: 0.0, contested: false, active: c.hill.is_none() || i == first }).collect()
        }
    };
    sim.match_ = Some(Match {
        rules,
        score: [0.0, 0.0],
        elapsed: 0.0,
        winner: None,
        respawns: Vec::new(),
        stuck: Vec::new(),
        zones,
        next_hill: rules.capture.and_then(|c| c.hill).unwrap_or(f64::INFINITY),
    });
}

pub fn end_match(sim: &mut Sim) {
    sim.match_ = None;
}

/// Un cockpit détruit (`botKilled`) : un point pour l'équipe adverse (hors capture de zones), et la
/// réapparition du robot, s'il est encore dans `sim.bots` (l'écouteur de `startMatch`).
pub fn on_bot_killed(sim: &mut Sim, b: usize) {
    let present = sim.roster.contains(&b);
    let team = sim.bots[b].team;
    let time = sim.time;
    let Some(m) = &mut sim.match_ else { return };
    if m.winner.is_some() || !present {
        return;
    }
    if m.rules.capture.is_none() {
        m.score[other_team(team)] += 1.0;
    }
    if let Some(delay) = m.rules.respawn {
        m.respawns.push((b, time + delay));
    }
}

/// Le robot se saborde : son cockpit est détruit (`selfDestruct`).
pub fn self_destruct(sim: &mut Sim, b: usize) {
    if !sim.bots[b].cockpit_alive() {
        return;
    }
    let mut batch = DamageBatch { cause: Some("self"), ..DamageBatch::default() };
    let cockpit = sim.bots[b].cockpit;
    batch.add(sim, Some(Target::Block(b, cockpit)), f64::INFINITY, "kinetic");
    inflict(sim, &batch, v3(0.0, 1.0, 0.0), None);
}

/// Robots de chaque équipe dans une zone (cockpit intact ; pas les avions) (`zoneOccupants`).
fn zone_occupants(sim: &Sim, zone: &Zone) -> [f64; 2] {
    let mut count = [0.0, 0.0];
    for &b in &sim.roster {
        let bot = &sim.bots[b];
        if !bot.cockpit_alive() || bot.mobility == Mobility::Plane {
            continue;
        }
        let p = sim.phys.translation(sim.part(bot.cockpit_part()).rb);
        let dy = p.y - zone.pos.y;
        if dy > -1.0 && dy < ZONE_HEIGHT && jsmath::hypot2(p.x - zone.pos.x, p.z - zone.pos.z) <= zone.radius {
            count[bot.team] += 1.0;
        }
    }
    count
}

/// La colline passe à une autre zone, tirée au hasard ; l'ancienne revient au neutre (`moveHill`).
fn move_hill(sim: &mut Sim) {
    let Some(m) = &sim.match_ else { return };
    let current = m.zones.iter().position(|z| z.active);
    let others: Vec<usize> = (0..m.zones.len()).filter(|&i| Some(i) != current).collect();
    if others.is_empty() {
        return;
    }
    let next = others[(sim.rng.rand(0.0, others.len() as f64)).floor() as usize];
    let m = sim.match_.as_mut().expect("partie");
    if let Some(c) = current {
        let old = &mut m.zones[c];
        (old.active, old.owner, old.progress, old.contested) = (false, None, 0.0, false);
    }
    m.zones[next].active = true;
}

/// Les zones (`updateZones`) : une équipe seule la fait basculer vers elle ; chaque zone tenue rapporte.
fn update_zones(sim: &mut Sim, rules: Capture) {
    let n = sim.match_.as_ref().map_or(0, |m| m.zones.len());
    for i in 0..n {
        let z = sim.match_.as_ref().expect("partie").zones[i];
        if !z.active {
            continue;
        }
        let count = zone_occupants(sim, &z.zone);
        let mut z = z;
        z.contested = count[BLUE] > 0.0 && count[RED] > 0.0;
        let mut changes: Vec<(Option<usize>, usize)> = Vec::new();
        if !z.contested && (count[BLUE] != 0.0 || count[RED] != 0.0) {
            let team = if count[BLUE] != 0.0 { BLUE } else { RED };
            let sign = team_sign(team);
            z.progress = jsmath::max(-1.0, jsmath::min(1.0, z.progress + (sign * count[team].sqrt() * STEP) / rules.time));
            if z.owner.is_some_and(|o| o != team) && sign * z.progress >= 0.0 {
                z.owner = None;
                changes.push((None, team));
            }
            if z.owner.is_none() && sign * z.progress >= 1.0 {
                z.owner = Some(team);
                changes.push((Some(team), team));
            }
        } else if !z.contested {
            // Personne : la zone revient vers son état
            let rest = z.owner.map_or(0.0, team_sign);
            let step = (ZONE_RECOVERY * STEP) / rules.time;
            z.progress = if z.progress < rest { jsmath::min(rest, z.progress + step) } else { jsmath::max(rest, z.progress - step) };
        }
        let m = sim.match_.as_mut().expect("partie");
        m.zones[i] = z;
        if let Some(owner) = z.owner {
            m.score[owner] += rules.rate * STEP;
        }
        for (owner, by) in changes {
            sim.emit(code::ZONE_CHANGED, |_, w| {
                w.num(i as f64).num(owner.map_or(-1.0, |o| o as f64)).num(by as f64);
            });
        }
    }
}

/// La partie est-elle finie, et qui a gagné (`decide`) ?
fn decide(sim: &Sim, m: &Match) -> Option<Winner> {
    let (rules, score) = (&m.rules, &m.score);
    if rules.score_to_win > 0.0 {
        if score[BLUE] >= rules.score_to_win {
            return Some(Winner::Team(BLUE));
        }
        if score[RED] >= rules.score_to_win {
            return Some(Winner::Team(RED));
        }
    }
    if rules.respawn.is_none() {
        let standing = |team: usize| sim.roster.iter().any(|&b| sim.bots[b].team == team && sim.bots[b].cockpit_alive());
        let (blue, red) = (standing(BLUE), standing(RED));
        if !blue || !red {
            return Some(if blue { Winner::Team(BLUE) } else if red { Winner::Team(RED) } else { Winner::Draw });
        }
    }
    if rules.time_limit > 0.0 && m.elapsed >= rules.time_limit {
        let blue = score[BLUE].floor();
        let red = score[RED].floor();
        return Some(if blue > red { Winner::Team(BLUE) } else if red > blue { Winner::Team(RED) } else { Winner::Draw });
    }
    None
}

/// Un pas de la partie (`updateMatch`) : réapparitions, sabordages, zones, fin de partie.
pub fn update_match(sim: &mut Sim) -> Result<(), String> {
    match &mut sim.match_ {
        Some(m) if m.winner.is_none() => m.elapsed += STEP,
        _ => return Ok(()),
    }
    let due: Vec<(usize, f64)> = sim.match_.as_ref().expect("partie").respawns.clone();
    for r in due {
        if sim.time < r.1 {
            continue;
        }
        let m = sim.match_.as_mut().expect("partie");
        if let Some(k) = m.respawns.iter().position(|x| *x == r) {
            m.respawns.remove(k);
        }
        let Some(i) = sim.roster.iter().position(|&b| b == r.0) else { continue };
        let old = r.0;
        remove_bot(sim, old);
        let fresh = respawn_bot(sim, sim.bots[old].profile, sim.bots[old].team)?;
        sim.bots[fresh].piloted = sim.bots[old].piloted;
        sim.bots[fresh].input_slot = sim.bots[old].input_slot;
        sim.roster[i] = fresh;
        if sim.player == Some(old) {
            sim.player = Some(fresh);
        }
    }

    for b in sim.roster.clone() {
        let bot = &sim.bots[b];
        let helpless = matches!(bot.ai.mode, Mode::Flipped | Mode::Stranded | Mode::Falling);
        let m = sim.match_.as_mut().expect("partie");
        if !bot.cockpit_alive() || bot.piloted || !helpless {
            m.stuck.retain(|s| s.0 != b);
            continue;
        }
        let t = m.stuck.iter().find(|s| s.0 == b).map_or(0.0, |s| s.1) + STEP;
        match m.stuck.iter_mut().find(|s| s.0 == b) {
            Some(s) => s.1 = t,
            None => m.stuck.push((b, t)),
        }
        if t > STUCK_LIMIT {
            self_destruct(sim, b);
        }
    }

    let m = sim.match_.as_ref().expect("partie");
    let capture = m.rules.capture;
    if let Some(c) = capture
        && let Some(hill) = c.hill
        && m.elapsed >= m.next_hill
    {
        move_hill(sim);
        sim.match_.as_mut().expect("partie").next_hill += hill;
    }
    if let Some(c) = capture {
        update_zones(sim, c);
    }
    let winner = decide(sim, sim.match_.as_ref().expect("partie"));
    if let Some(w) = winner {
        sim.match_.as_mut().expect("partie").winner = Some(w);
        sim.emit(code::MATCH_OVER, |_, wr| {
            wr.num(match w {
                Winner::Team(t) => t as f64,
                Winner::Draw => 2.0,
            });
        });
    }
    Ok(())
}
