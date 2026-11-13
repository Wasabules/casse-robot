//! Les armes de contact (src/shared/combat/melee.ts), une étape du pas (« contact », après les chocs) :
//! le socle commun à toutes, et chaque mouvement.
//!
//! - Régime (`stepRegime`). Un rotor garde son énergie E = ½·I·ω² ; commandé (`wanted`) et alimenté
//!   (relié au cockpit, ni lui ni son robot paralysés, une arme d'énergie hors de l'eau : `powerOk`),
//!   son moteur la lui rend dans la limite des batteries (`supply`, compté dans `bot.drawn`) ; il perd
//!   en roue libre ; une arme d'énergie sans courant s'éteint d'un coup (`quench`). Ce que le rotor
//!   gagne en moment cinétique, le robot le perd (réaction du moteur) ; un rotor à gyroscope ajoute
//!   son moment à celui de son morceau, qui précesse (`precess`) ; sous la moitié de ses points, un
//!   rotor se déséquilibre (balourd : une force tournante au moyeu, et la fatigue qui l'use). Un rotor
//!   mené par un moteur (l'hélice tranchante, `driven`) suit la poussée de son bloc (`drivenSpeed`).
//! - Coup d'un rotor (`stepRotor`) : sa lame, sans collider, cherche ce qui entre dans le volume
//!   qu'elle balaie (`rotorContact` : les blocs et les roues des robots ennemis dans leur grille, les
//!   accessoires, le décor et le sol), frappe le plus proche de son axe ; un bloc de forme peut la
//!   faire glisser (`shapeFace`, `incidence`, `slide`).
//! - Morsure continue (`biteRotor` : scie, foreuse) : la lame mord à chaque pas ce qu'elle rencontre en
//!   venant de son bloc, prend à son rotor la puissance de coupe, tire et tord (`PlannedBite`), et ses
//!   dégâts, accumulés (`Gnaw`), tombent par tranches (`landGnaw`) qui percent case par case
//!   (`gnawChain`).
//! - Bras déclenché (`stepSwing` : marteau, fouet) et pointe (`stepThrust` : lance) : le premier contact
//!   de la tête le long de son arc ou de sa course (`pathContact`).
//! - Champ (`stepField` : champ broyeur) : sa charge, et ce qui entre dans sa marge (`fieldContacts`).
//! - Frappes à mécanique (mechanics.rs) : flipper, fléau, mâchoire.
//!
//! Tous les coups d'un pas sont mesurés avant qu'aucun ne soit infligé (`landHits`) : les impulsions
//! d'abord, puis les dégâts coup par coup (un coup allume ce qu'il touche, une décharge paralyse les
//! organes autour du point touché : emp.rs), puis les tranches de morsure ; enfin la fatigue des
//! rotors déséquilibrés.

use super::events::code;
use super::arena::{ground_level, in_water, ray_arena, ray_boxes};
use super::catalog::{MeleeSpec, SpinSpec, SweptRing, SwingSpec, ThrustSpec, catalog};
use super::damage::{DamageBatch, Target, inflict, resistance};
use super::debris::block_world_pos;
use super::drive::{FLIPPED_UP_Y, supply};
use super::emp::{organ_stunned, stun_organs};
use super::fire::{BURN_TIME, burnable, flammability, ignite, ignite_prop};
use super::linalg::solve_linear;
use super::mechanics::{FlailBall, JawGrip, step_flail, step_flip, step_jaw};
use super::props::{prop, prop_nearest, present};
use super::robot::{Cell, NEIGHBORS, link_key};
use super::shapes::shape_faces;
use super::vec::{Q, V3, add, clamp, cross, dot, len, norm, qmul, qrot, qrot_inv, scale, sub, v3};
use super::world::{STEP, Sim};
use crate::det::{dcos, dpow, dsin};
use crate::jsmath;
use rapier3d::prelude::RigidBodyHandle;
use std::f64::consts::PI;

/// Les mouvements d'arme de contact que la simulation portée sait faire (robot.rs refuse les autres).
pub const PORTED_MOTIONS: [&str; 8] = ["driven", "spin", "swing", "thrust", "field", "flip", "flail", "grip"];

/// Un bloc compte, pour une lame, comme une boule de ce rayon (m) ; une roue, comme une boule de cette
/// part de son rayon.
pub const BLOCK_REACH: f64 = 0.28;
pub const WHEEL_REACH: f64 = 0.85;
/// Le décor et les accessoires ne se cherchent qu'un pas sur SCENERY_EVERY.
const SCENERY_EVERY: f64 = 3.0;
/// Un robot plus loin que sa taille et cette marge (m) : on ne lit pas ses corps.
const FAR_PART: f64 = 3.0;
const SCENERY_RAYS: usize = 8;
/// Le décor prend moins qu'un robot.
const SCENERY_BITE: f64 = 0.4;
/// Le balourd naît sous cette part des points de structure de l'arme.
pub const UNBALANCE_FROM: f64 = 0.5;
/// Force tournante du balourd, au plus (N).
const MAX_UNBALANCE: f64 = 6000.0;
/// Fatigue du balourd (part des points perdue par seconde, balourd entier, à plein régime), infligée par tranches.
const FATIGUE: f64 = 0.05;
const FATIGUE_CHUNK: f64 = 3.0;
/// Pas (rad) de la recherche du premier contact de la tête d'un bras le long de son arc.
const ARC_STEP: f64 = 0.06;
/// Pas (m) de la recherche du premier contact d'une pointe le long de sa course.
const THRUST_STEP: f64 = 0.05;
/// Un contact avec une arme de contact ennemie pèse d'autant plus, dans ce que prend le champ à sa charge.
const FIELD_WEAPON_WEIGHT: f64 = 1.5;
/// Morsure : ses dégâts tombent par tranches de BITE_TICK s.
pub const BITE_TICK: f64 = 0.1;
/// Une mèche cherche le sol en ce nombre de points le long de sa longueur.
const BIT_SAMPLES: usize = 4;
/// Frottement d'une lame sur ce qui ne bouge pas.
const SCRAPE: f64 = 0.5;
/// Rendement du moteur d'une arme de contact (`MOTOR_EFFICIENCY`, catalog/melee.ts).
pub const MOTOR_EFFICIENCY: f64 = 0.8;
/// Rayon intérieur (m) au-delà duquel une lame entoure le robot (anneau-coque : `allAround`).
pub const ALL_AROUND: f64 = 0.8;
const UP: V3 = v3(0.0, 1.0, 0.0);

/// La phase d'un bras, d'une pointe, d'un plateau ou d'une mâchoire (`SwingPhase`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Ready,
    Strike,
    Recover,
    Hold,
}

/// Ce qu'une lame ou une tête touche (`ImpactSurface`) : un robot, un accessoire, le décor ou le sol.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Surface {
    Robot,
    Prop,
    Scenery,
}

/// Ce que mord une lame en ce moment (`MeleeBite`) : où, le sens de la lame, ce qu'elle mord, la
/// puissance qu'elle y met (kW), si elle glisse.
#[derive(Clone, Copy, Debug)]
pub struct MeleeBite {
    pub point: V3,
    pub dir: V3,
    pub surface: Surface,
    pub power: f64,
    pub glance: bool,
}

/// Le bloc mordu d'une morsure (`Gnaw.cell`) : son robot, son morceau (un numéro, jamais relu s'il a
/// disparu), sa case, et le sens d'avance dans le repère du robot.
#[derive(Clone, Copy, Debug)]
pub struct GnawCell {
    pub bot: usize,
    pub part: usize,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub feed: V3,
}

/// Dégâts d'une morsure accumulés depuis la dernière tranche (`Gnaw`) ; et la résistance de
/// l'accessoire mordu (son type ne change pas : on la garde, il peut avoir disparu à la tranche).
#[derive(Clone, Copy, Debug)]
pub struct Gnaw {
    pub target: Option<Target>,
    pub damage: f64,
    pub cut: f64,
    pub cell: Option<GnawCell>,
    pub point: V3,
    pub dir: V3,
    pub hub: V3,
    pub since: f64,
    pub prop_resist: f64,
}

/// Une arme de contact (`MeleeArm`) : son bloc, son arme, le régime de son rotor (rad/s ; la vitesse
/// d'un bras, d'une pointe), l'angle du rotor, la phase d'un bras (depuis combien de temps, son angle
/// ou sa sortie, d'où il revient), les commandes du pas, l'instant de son dernier coup, la fatigue
/// d'un rotor déséquilibré, la boule d'un fléau, la prise d'une mâchoire, la morsure de ce pas et ce
/// qu'elle a accumulé, et le contact avec le décor qu'une lame qui mord garde trois pas (`SCENERY_MEMO`).
#[derive(Clone, Copy, Debug)]
pub struct MeleeArm {
    pub block: usize,
    pub weapon: &'static str,
    pub spin: f64,
    pub angle: f64,
    pub phase: Phase,
    pub phase_t: f64,
    pub swing: f64,
    pub from: f64,
    pub wanted: bool,
    pub trigger: bool,
    pub hit_at: f64,
    pub fatigue: f64,
    pub ball: Option<FlailBall>,
    pub grip: Option<JawGrip>,
    pub bite: Option<MeleeBite>,
    pub gnaw: Option<Gnaw>,
    pub memo: Option<(Option<Contact>, f64)>,
}

impl MeleeArm {
    /// Une arme qui apparaît (`newMeleeArm`) : rotor à l'arrêt, bras armé, pointe rentrée, mâchoire ouverte.
    pub fn new(block: usize, weapon: &'static str) -> Self {
        let rest = rest_swing(&catalog().melee[weapon]);
        MeleeArm {
            block,
            weapon,
            spin: 0.0,
            angle: 0.0,
            phase: Phase::Ready,
            phase_t: 0.0,
            swing: rest,
            from: rest,
            wanted: false,
            trigger: false,
            hit_at: f64::NEG_INFINITY,
            fatigue: 0.0,
            ball: None,
            grip: None,
            bite: None,
            gnaw: None,
            memo: None,
        }
    }

    pub fn spec(&self) -> &'static MeleeSpec {
        &catalog().melee[self.weapon]
    }
}

/// Position de repos (`restSwing`) : l'angle armé d'un bras, la sortie rentrée d'une pointe, le
/// plateau en coin, la mâchoire ouverte.
pub fn rest_swing(spec: &MeleeSpec) -> f64 {
    spec.swing.map(|s| s.rest).or(spec.thrust.map(|t| t.retracted)).or(spec.plate.map(|p| p.rest)).or(spec.jaw.map(|j| j.open)).unwrap_or(0.0)
}

/// Une arme qu'on manie (`wielded`) : pas une hélice, que mène son moteur.
pub fn wielded(spec: &MeleeSpec) -> bool {
    spec.motion != "driven"
}

/// Arme offensive (`meleeOffensive`) : ni un champ, ni une hélice.
pub fn melee_offensive(spec: &MeleeSpec) -> bool {
    spec.motion != "field" && wielded(spec)
}

/// La lame entoure-t-elle son robot (`allAround` : un anneau-coque) ?
pub fn all_around(spec: &MeleeSpec) -> bool {
    spec.blade.map_or(0.0, |b| b.inner) >= ALL_AROUND
}

/// Énergie d'un rotor à ce régime (`spinEnergy`, J).
pub fn spin_energy(spin: &SpinSpec, omega: f64) -> f64 {
    0.5 * spin.inertia * omega * omega
}

/// Puissance du moteur d'un rotor (`motorPower`, kW).
pub fn motor_power(spin: &SpinSpec) -> f64 {
    spin_energy(spin, spin.speed) / spin.spin_up / MOTOR_EFFICIENCY / 1000.0
}

/// Portée d'une arme depuis son moyeu (`meleeReach`, m).
pub fn melee_reach(spec: &MeleeSpec) -> f64 {
    if let Some(b) = spec.blade {
        return if b.is_bit() { b.half } else { b.outer };
    }
    if let Some(s) = spec.swing {
        return s.reach + s.radius;
    }
    if let Some(t) = spec.thrust {
        return t.reach + t.radius;
    }
    if let Some(f) = spec.field {
        return f.margin;
    }
    if let Some(p) = spec.plate {
        return p.length;
    }
    if let Some(f) = spec.flail {
        return f.crank + f.chain + f.radius;
    }
    if let Some(jaw) = spec.jaw {
        return jaw.length;
    }
    0.0
}

/// Régime d'un rotor, d'un fléau (`meleeCharge`, 0 à 1 du plein régime) ; un bras armé : 1.
pub fn melee_charge(arm: &MeleeArm) -> f64 {
    let spec = arm.spec();
    if let Some(spin) = spec.spin {
        return clamp(arm.spin / spin.speed, 0.0, 1.0);
    }
    if let Some(f) = spec.flail {
        return clamp(arm.spin / f.speed, 0.0, 1.0);
    }
    if let Some(jaw) = spec.jaw {
        if arm.phase == Phase::Hold {
            return clamp(1.0 - arm.phase_t / jaw.hold, 0.0, 1.0);
        }
        return if arm.phase == Phase::Recover { clamp(arm.phase_t / (jaw.reopen + jaw.cooldown), 0.0, 1.0) } else { 1.0 };
    }
    let recover = spec.swing.map(|s| s.recover).or(spec.thrust.map(|t| t.recover)).or(spec.plate.map(|p| p.reload));
    match recover {
        Some(r) => match arm.phase {
            Phase::Ready => 1.0,
            Phase::Strike => 0.0,
            _ => clamp(arm.phase_t / r, 0.0, 1.0),
        },
        None => 0.0,
    }
}

/// Part du balourd d'un rotor (`unbalanceShare`, 0 à 1) : rien au-dessus d'UNBALANCE_FROM, entier à 0.
pub fn unbalance_share(sim: &Sim, b: usize, arm: &MeleeArm) -> f64 {
    if arm.spec().spin.is_none_or(|s| s.unbalance == 0.0 || s.unbalance.is_nan()) {
        return 0.0;
    }
    let block = &sim.bots[b].blocks[arm.block];
    let health = block.hp / catalog().blocks[&block.kind].hp;
    clamp((UNBALANCE_FROM - health) / UNBALANCE_FROM, 0.0, 1.0)
}

/// Vibration d'un robot (`vibration`, 0 à 1) : celle de son rotor le plus déséquilibré.
pub fn vibration(sim: &Sim, b: usize) -> f64 {
    let mut v: f64 = 0.0;
    for arm in &sim.bots[b].melee {
        let Some(spin) = arm.spec().spin else { continue };
        if !sim.bots[b].blocks[arm.block].alive || arm.spin <= 0.0 {
            continue;
        }
        v = jsmath::max(v, unbalance_share(sim, b, arm) * dpow(arm.spin / spin.speed, 2.0));
    }
    jsmath::min(1.0, v)
}

/// Les armes de contact maniées reliées au cockpit (`liveMelee`) : leurs rangs dans `bot.melee`.
pub fn live_melee(sim: &Sim, b: usize) -> Vec<usize> {
    let bot = &sim.bots[b];
    if !bot.cockpit_alive() {
        return Vec::new();
    }
    let ck = bot.cockpit_part();
    (0..bot.melee.len())
        .filter(|&a| {
            let arm = &bot.melee[a];
            let block = &bot.blocks[arm.block];
            block.alive && block.part == ck && wielded(arm.spec())
        })
        .collect()
}

/// L'axe d'un rotor et deux directions de son plan, dans le repère de son bloc (`meleeAxes`).
pub fn melee_axes(axis: &str) -> (V3, V3, V3) {
    let a = match axis {
        "up" => v3(0.0, 1.0, 0.0),
        "left" => v3(1.0, 0.0, 0.0),
        _ => v3(0.0, 0.0, 1.0),
    };
    let e1 = if axis == "forward" { v3(0.0, 1.0, 0.0) } else { v3(0.0, 0.0, 1.0) };
    (a, e1, cross(a, e1))
}

/// Position de la tête d'un bras à l'angle `angle`, depuis le pivot, dans le repère du bloc (`headOffset`).
pub fn head_offset(axis: &str, swing: &SwingSpec, angle: f64) -> V3 {
    let (_, e1, e2) = melee_axes(axis);
    add(scale(e1, swing.reach * dcos(angle)), scale(e2, -swing.reach * dsin(angle)))
}

/// Repère d'une arme de contact dans le monde (`meleeFrame`) : la rotation de son bloc, son moyeu, son
/// axe, deux directions de son plan de rotation.
#[derive(Clone, Copy, Debug)]
pub struct MeleeFrame {
    pub q: Q,
    pub hub: V3,
    pub axis: V3,
    pub e1: V3,
    pub e2: V3,
}

pub fn melee_frame(sim: &Sim, b: usize, arm: &MeleeArm) -> MeleeFrame {
    let spec = arm.spec();
    let block = &sim.bots[b].blocks[arm.block];
    let rb = sim.part(block.part).rb;
    let pq = sim.phys.rotation(rb);
    let q = qmul(pq, block.rot);
    let [hx, hy, hz] = spec.hub;
    let hub = add(sim.phys.translation(rb), qrot(pq, add(block.local, qrot(block.rot, v3(hx, hy, hz)))));
    let (axis, e1, e2) = melee_axes(&spec.axis);
    MeleeFrame { q, hub, axis: qrot(q, axis), e1: qrot(q, e1), e2: qrot(q, e2) }
}

/// Direction du bras à l'angle `angle` (monde), du pivot vers la tête (`armDir`).
fn arm_dir(f: &MeleeFrame, angle: f64) -> V3 {
    add(scale(f.e1, dcos(angle)), scale(f.e2, -dsin(angle)))
}

/// Centre de la tête d'un bras à l'angle `angle` (`headAt`, monde).
pub fn head_at(f: &MeleeFrame, swing: &SwingSpec, angle: f64) -> V3 {
    add(f.hub, scale(arm_dir(f, angle), swing.reach))
}

/// Pointe d'une lance sortie de `extension` m (`tipAt`, monde).
pub fn tip_at(f: &MeleeFrame, extension: f64) -> V3 {
    add(f.hub, scale(f.e1, extension))
}

/// Ce que touche une lame ou une tête (`Contact`) : sa surface, la cible (rien : le décor, le sol), le
/// corps à pousser (rien : fixe), le point, la distance à l'axe de la surface touchée, la face touchée
/// d'un bloc de forme, ce qui ne bouge pas (la normale de sa surface, vers l'arme), le sol lui-même.
#[derive(Clone, Copy, Debug)]
pub struct Contact {
    pub surface: Surface,
    pub target: Option<Target>,
    pub body: Option<RigidBodyHandle>,
    pub point: V3,
    pub radial: f64,
    pub normal: Option<V3>,
    pub face: Option<V3>,
    pub floor: bool,
}

impl Contact {
    pub fn robot(target: Target, body: RigidBodyHandle, point: V3, radial: f64) -> Self {
        Contact { surface: Surface::Robot, target: Some(target), body: Some(body), point, radial, normal: None, face: None, floor: false }
    }
}

/// Un coup mesuré, prêt à être infligé (`PlannedHit`) : ce qu'une arme a déjà calculé elle-même
/// (l'impulsion donnée à la cible, la réaction au moyeu, les dégâts bruts) l'emporte sur le calcul
/// commun ; `quiet` : sans événement `meleeHit`.
pub struct PlannedHit {
    pub bot: usize,
    pub arm: usize,
    pub contact: Contact,
    pub energy: f64,
    pub grip: f64,
    pub dir: V3,
    pub motion: Option<V3>,
    pub hub: V3,
    pub part: usize,
    pub quiet: bool,
    pub impulse: Option<f64>,
    pub reaction: Option<f64>,
    pub damage: Option<f64>,
}

impl PlannedHit {
    /// Un coup sans rien de calculé d'avance.
    #[allow(clippy::too_many_arguments)]
    pub fn new(bot: usize, arm: usize, contact: Contact, energy: f64, grip: f64, dir: V3, motion: Option<V3>, hub: V3, part: usize) -> Self {
        PlannedHit { bot, arm, contact, energy, grip, dir, motion, hub, part, quiet: false, impulse: None, reaction: None, damage: None }
    }
}

/// Ce qu'une morsure pousse et tord à ce pas (`PlannedBite`).
struct PlannedBite {
    part: usize,
    hub: V3,
    body: Option<RigidBodyHandle>,
    point: V3,
    axis: V3,
    force: V3,
    torque: f64,
    twist: f64,
}

/// Ce que mesure un pas des armes de contact, avant d'infliger quoi que ce soit (`MeleePlans`) : les
/// coups, les morsures, les tranches de morsure à infliger (robot, arme, tranche).
#[derive(Default)]
pub struct Plans {
    pub hits: Vec<PlannedHit>,
    bites: Vec<PlannedBite>,
    due: Vec<(usize, usize, Gnaw)>,
}

/// Le moment cinétique propre des morceaux (`gyros`, une `Map` : l'ordre où ils y sont entrés).
pub type Gyros = Vec<(usize, V3)>;

/// Ajoute un moment cinétique à celui d'un morceau (`gyros.set(part, add(gyros.get(part) ?? 0, l))`).
pub fn add_gyro(gyros: &mut Gyros, part: usize, l: V3) {
    match gyros.iter_mut().find(|g| g.0 == part) {
        Some(g) => g.1 = add(g.1, l),
        None => gyros.push((part, add(v3(0.0, 0.0, 0.0), l))),
    }
}

/// Un pas des armes de contact (`updateMelee`) : chaque arme selon son mouvement, puis le gyroscope de
/// chaque morceau, puis les coups et les morsures (impulsions, puis dégâts), enfin la fatigue des
/// rotors déséquilibrés. Les commandes du pas sont ensuite remises à zéro.
pub fn update_melee(sim: &mut Sim) {
    let mut plans = Plans::default();
    let mut gyros: Gyros = Vec::new();
    let mut tired: Vec<(usize, usize)> = Vec::new();
    for b in sim.roster.clone() {
        for a in 0..sim.bots[b].melee.len() {
            sim.bots[b].melee[a].bite = None;
            let arm = sim.bots[b].melee[a];
            let spec = arm.spec();
            if !sim.bots[b].blocks[arm.block].alive {
                let rest = rest_swing(spec);
                let m = &mut sim.bots[b].melee[a];
                m.spin = 0.0;
                m.phase = Phase::Ready;
                m.swing = rest;
                m.from = rest;
                // (`dropMechanics` : sa boule disparaît, sa prise lâche)
                m.ball = None;
                m.grip = None;
            } else {
                match spec.motion.as_str() {
                    "spin" | "driven" => {
                        step_rotor(sim, b, a, &mut gyros, &mut plans);
                        if sim.bots[b].melee[a].fatigue >= FATIGUE_CHUNK {
                            tired.push((b, a));
                        }
                    }
                    "swing" => step_swing(sim, b, a, &mut plans),
                    "thrust" => step_thrust(sim, b, a, &mut plans),
                    "field" => step_field(sim, b, a, &mut gyros, &mut plans),
                    "flip" => step_flip(sim, b, a, &mut plans),
                    "flail" => step_flail(sim, b, a, &mut gyros, &mut plans),
                    "grip" => step_jaw(sim, b, a, &mut plans),
                    _ => sim.stats.unported += 1,
                }
            }
            // Une morsure qui cesse : ce qu'elle a accumulé tombe tout de suite
            let m = &mut sim.bots[b].melee[a];
            if m.bite.is_none()
                && let Some(g) = m.gnaw.take()
            {
                plans.due.push((b, a, g));
            }
            m.wanted = false;
            m.trigger = false;
        }
    }
    // (pendant que le gyroscope du cockpit redresse un robot renversé, il l'emporte sur ses rotors)
    for (part, momentum) in gyros {
        if sim.bots[sim.part(part).bot].righting <= 0.0 {
            precess(sim, part, momentum);
        }
    }
    if !plans.hits.is_empty() || !plans.bites.is_empty() || !plans.due.is_empty() {
        land_hits(sim, plans);
    }
    for (b, a) in tired {
        // (un coup de ce pas a pu l'emporter)
        let arm = sim.bots[b].melee[a];
        if !sim.bots[b].blocks[arm.block].alive {
            continue;
        }
        let mut batch = DamageBatch::default();
        batch.add(sim, Some(Target::Block(b, arm.block)), arm.fatigue, "impact");
        sim.bots[b].melee[a].fatigue = 0.0;
        inflict(sim, &batch, UP, None);
    }
}

/// L'arme est-elle alimentée (`powerOk`) ? Reliée au cockpit, ni elle ni son robot paralysés, et
/// (une arme d'énergie) son moyeu hors de l'eau. `frame` : son repère, s'il est déjà calculé.
fn power_ok(sim: &Sim, b: usize, arm: &MeleeArm, spec: &MeleeSpec, frame: Option<&MeleeFrame>) -> bool {
    let bot = &sim.bots[b];
    if !bot.cockpit_alive() || bot.blocks[arm.block].part != bot.cockpit_part() || organ_stunned(sim, b, arm.block) {
        return false;
    }
    !spec.quench || !in_water(sim, frame.map_or_else(|| melee_frame(sim, b, arm).hub, |f| f.hub))
}

/// Ce que laisse à une arme son régime d'un pas (`Regime`) : son énergie (J), son repère, son sens.
struct Regime {
    energy: f64,
    frame: MeleeFrame,
    sense: f64,
}

/// Le régime d'une arme à `spin` (`stepRegime`) : pertes, moteur, réaction du moteur, moment cinétique,
/// balourd. Rien : elle ne tourne pas.
fn step_regime(sim: &mut Sim, b: usize, a: usize, gyros: &mut Gyros) -> Option<Regime> {
    let arm = sim.bots[b].melee[a];
    let spec = arm.spec();
    let spin = spec.spin.as_ref().expect("arme sans régime");
    // (une arme d'énergie a besoin de son repère pour savoir si elle est dans l'eau)
    let mut frame = if spec.quench { Some(melee_frame(sim, b, &arm)) } else { None };
    let before = arm.spin;
    let energy;
    if spec.drive.is_some() {
        // Mené par le moteur de son bloc (une hélice) : il rejoint le régime que donne la poussée
        let now = driven_speed(sim, b, &arm, spec);
        sim.bots[b].melee[a].spin = now;
        energy = spin_energy(spin, now);
    } else {
        let powered = arm.wanted && power_ok(sim, b, &arm, spec, frame.as_ref());
        let full = spin_energy(spin, spin.speed);
        // Pertes de la roue libre, puis le moteur (dans la limite de ce que donnent les batteries)
        let mut e = spin_energy(spin, before) * ((-2.0 * STEP) / spin.spin_down).exp();
        // Une arme d'énergie sans courant s'éteint d'un coup
        if spec.quench && !powered {
            e = 0.0;
        }
        if powered && e < full {
            let power = motor_power(spin);
            let gain = jsmath::min(full - e, power * 1000.0 * MOTOR_EFFICIENCY * supply(&sim.bots[b], power) * STEP);
            e += gain;
            sim.bots[b].drawn += gain / MOTOR_EFFICIENCY / STEP / 1000.0;
        }
        sim.bots[b].melee[a].spin = ((2.0 * e) / spin.inertia).sqrt();
        energy = e;
    }
    let sense = spin.direction;
    let m = &mut sim.bots[b].melee[a];
    m.angle = (m.angle + sense * m.spin * STEP) % (2.0 * PI);
    if m.spin < 0.01 && before < 0.01 {
        return None;
    }
    let now = m.spin;
    let angle = m.angle;
    let frame = *frame.get_or_insert_with(|| melee_frame(sim, b, &arm));
    let part = sim.bots[b].blocks[arm.block].part;
    let rb = sim.part(part).rb;
    // Ce que le rotor gagne en moment cinétique, le robot le perd (réaction du moteur) ; une arme
    // d'énergie, un champ : rien (`reaction` 0) ; un rotor mené : c'est le couple de son moteur
    let gained = spin.inertia * (now - before) * sense * (if spec.drive.is_some() { 0.0 } else { spin.reaction });
    if gained.abs() > 1e-6 {
        sim.phys.apply_torque_impulse(rb, scale(frame.axis, -gained), true);
    }
    if spin.gyro > 0.0 {
        add_gyro(gyros, part, scale(frame.axis, spin.inertia * now * sense * spin.gyro));
    }
    // Balourd : une force qui tourne avec le rotor, au moyeu ; et la fatigue qu'il impose à l'arme
    let unbalance = unbalance_share(sim, b, &arm);
    if unbalance > 0.0 && spin.unbalance > 0.0 {
        let force = jsmath::min(MAX_UNBALANCE, spin.mass * spin.unbalance * unbalance * dpow(now, 2.0));
        let out = add(scale(frame.e1, dcos(angle)), scale(frame.e2, dsin(angle)));
        sim.phys.apply_impulse_at_point(rb, scale(out, force * STEP), frame.hub, true);
        let hp = catalog().blocks[&sim.bots[b].blocks[arm.block].kind].hp;
        sim.bots[b].melee[a].fatigue += FATIGUE * unbalance * dpow(now / spin.speed, 2.0) * hp * STEP;
    }
    Some(Regime { energy, frame, sense })
}

/// Régime d'un rotor mené par le moteur de son bloc (`drivenSpeed`) : au ralenti dès que le moteur est
/// alimenté, plus vite avec sa poussée, arrêté sous `stop` de la poussée maximale.
fn driven_speed(sim: &Sim, b: usize, arm: &MeleeArm, spec: &MeleeSpec) -> f64 {
    let spin = spec.spin.as_ref().expect("rotor sans régime");
    let (idle, stop) = spec.drive.expect("rotor mené sans moteur");
    let bot = &sim.bots[b];
    let block = &bot.blocks[arm.block];
    let engine = catalog().blocks[&block.kind].thruster.as_ref();
    let t = engine.and(bot.thrusters.iter().find(|th| th.block == arm.block));
    let powered = t.is_some() && bot.cockpit_alive() && block.part == bot.cockpit_part() && !organ_stunned(sim, b, arm.block);
    let ratio = match (t, engine) {
        (Some(t), Some(e)) if powered => clamp(t.thrust / e.max_thrust, 0.0, 1.0),
        _ => 0.0,
    };
    let target = if ratio < stop { 0.0 } else { spin.speed * (idle + (1.0 - idle) * ratio) };
    let tau = if target > arm.spin { spin.spin_up } else { spin.spin_down };
    arm.spin + (target - arm.spin) * (1.0 - (-STEP / tau).exp())
}

/// Un rotor (`stepRotor`) : son régime, puis un coup de sa lame, ou sa morsure (une lame qui mord).
fn step_rotor(sim: &mut Sim, b: usize, a: usize, gyros: &mut Gyros, plans: &mut Plans) {
    let Some(regime) = step_regime(sim, b, a, gyros) else { return };
    let Regime { energy, frame, sense } = regime;
    let arm = sim.bots[b].melee[a];
    let spec = arm.spec();
    let spin = spec.spin.as_ref().expect("rotor sans régime");
    let part = sim.bots[b].blocks[arm.block].part;
    let scenery = (sim.time / STEP + sim.bots[b].blocks[arm.block].id as f64) % SCENERY_EVERY < 1.0;
    // Une lame qui mord en continu (scie, foreuse)
    if spec.bite.is_some() {
        if arm.spin >= spec.hit.min_speed * spin.speed {
            bite_rotor(sim, b, a, &frame, energy, scenery, plans);
        }
        return;
    }
    // Un coup, si la lame tourne assez vite et qu'elle est revenue depuis le dernier
    if arm.spin < spec.hit.min_speed * spin.speed || sim.time - arm.hit_at < spec.hit.gap {
        return;
    }
    let blade = spec.blade.expect("rotor sans lame");
    let Some(mut contact) = rotor_contact(sim, b, &frame, &blade, scenery, None) else { return };
    // Le sens de la lame au point touché : tangent au cercle, dans le sens de rotation
    let rel = sub(contact.point, frame.hub);
    let radial_dir = norm(sub(rel, scale(frame.axis, dot(rel, frame.axis))));
    let tangent = scale(norm(cross(frame.axis, radial_dir)), sense);
    if let Some(Target::Block(tb, tk)) = contact.target {
        contact.normal = shape_face(sim, tb, tk, cross(frame.axis, radial_dir));
    }
    let grip = contact.normal.map_or(1.0, |n| incidence(n, tangent));
    // Le décor prend moins qu'un robot ; le sol, selon l'arme (un disque debout y mord)
    let fixed = if contact.surface != Surface::Scenery {
        1.0
    } else if contact.floor {
        spec.hit.ground.unwrap_or(SCENERY_BITE)
    } else {
        SCENERY_BITE
    };
    let bite = spec.hit.bite * (0.35 + 0.65 * grip) * fixed;
    let hit_energy = energy * bite;
    let m = &mut sim.bots[b].melee[a];
    m.spin = ((2.0 * (energy - hit_energy)) / spin.inertia).sqrt();
    m.hit_at = sim.time;
    // Son morceau renversé, la lame racle le sol sans renvoyer son robot
    if contact.floor && qrot(sim.phys.rotation(sim.part(part).rb), UP).y < FLIPPED_UP_Y {
        return;
    }
    let p = &spec.hit.push;
    let push = add(add(add(scale(tangent, p.tangent), scale(radial_dir, p.radial)), scale(frame.axis, p.axial * sense)), v3(0.0, p.lift, 0.0));
    let dir = slide(norm(push), contact.normal, grip);
    plans.hits.push(PlannedHit::new(b, a, contact, hit_energy, grip, dir, Some(tangent), frame.hub, part));
}

/// `Math.sign(x) || 1`.
fn sign_or_one(x: f64) -> f64 {
    let s = jsmath::sign(x);
    if s == 0.0 || s.is_nan() { 1.0 } else { s }
}

/// Deux cibles de morsure sont-elles la même (`sameTarget` : le décor compte pour une) ?
fn same_target(a: Option<Target>, b: Option<Target>) -> bool {
    a == b
}

/// Une lame qui mord (`biteRotor`) : ce qu'elle mord à ce pas, ce qu'elle prend à son rotor, la force
/// et le couple qu'elle exerce, et les dégâts qu'elle accumule. `energy` : celle du rotor après son
/// moteur, à ce pas.
#[allow(clippy::too_many_arguments)]
fn bite_rotor(sim: &mut Sim, b: usize, a: usize, frame: &MeleeFrame, energy: f64, scenery: bool, plans: &mut Plans) {
    let arm = sim.bots[b].melee[a];
    let spec = arm.spec();
    let spin = spec.spin.as_ref().expect("rotor sans régime");
    let bite = spec.bite.expect("lame qui ne mord pas");
    let blade = spec.blade.expect("rotor sans lame");
    let axial = bite.axial;
    let base = block_world_pos(sim, b, arm.block);
    // Les robots et les accessoires à chaque pas ; le décor un pas sur trois, gardé entre-temps
    let mut contact = rotor_contact(sim, b, frame, &blade, false, Some(base));
    let ground;
    match arm.memo {
        Some((memo, time)) if !(scenery || sim.time - time > SCENERY_EVERY * STEP + 1e-9) => ground = memo,
        _ => {
            ground = scenery_contact(sim, frame, &blade);
            sim.bots[b].melee[a].memo = Some((ground, sim.time));
        }
    }
    if let Some(g) = ground
        && contact.is_none_or(|c| distance(g.point, base) < distance(c.point, base))
    {
        contact = Some(g);
    }
    let Some(mut contact) = contact else { return };
    let sense = spin.direction;
    // Le sens de la lame au point mordu : le long du bord du disque, ou de l'axe d'une mèche
    let rel = sub(contact.point, frame.hub);
    let flat = sub(rel, scale(frame.axis, dot(rel, frame.axis)));
    let radial_dir = if len(flat) > 1e-4 { norm(flat) } else { frame.e1 };
    let tangent = scale(norm(cross(frame.axis, radial_dir)), sense);
    let tip = scale(frame.axis, sign_or_one(dot(sub(frame.hub, base), frame.axis)));
    let motion = if axial { tip } else { tangent };
    // Le sens où elle avance dans la cible : le long de l'axe d'une mèche, ou de son bloc vers ce
    // qu'elle mord, dans le plan du disque. Une pente se juge sur lui
    let mut feed = tip;
    if !axial {
        let out = sub(contact.point, base);
        let in_plane = sub(out, scale(frame.axis, dot(out, frame.axis)));
        feed = if len(in_plane) > 1e-3 { norm(in_plane) } else { radial_dir };
    }
    if let Some(Target::Block(tb, tk)) = contact.target {
        contact.normal = shape_face(sim, tb, tk, feed);
    }
    let grip = contact.normal.map_or(1.0, |n| incidence(n, feed));
    // Ce qu'elle prend au rotor : la puissance de coupe (couple constant × régime), moins sur une
    // pente et sur le décor
    let omega = arm.spin;
    let torque = ((bite.power * 1000.0) / spin.speed) * (0.35 + 0.65 * grip) * (if contact.surface == Surface::Scenery { SCENERY_BITE } else { 1.0 });
    let drained = jsmath::min(energy, torque * omega * STEP);
    if drained <= 0.0 {
        return;
    }
    sim.bots[b].melee[a].spin = ((2.0 * (energy - drained)) / spin.inertia).sqrt();
    // (le couple qu'elle a vraiment opposé)
    let held = drained / (omega * STEP);
    let dir = slide(motion, contact.normal, grip);
    sim.bots[b].melee[a].bite = Some(MeleeBite { point: contact.point, dir, surface: contact.surface, power: drained / STEP / 1000.0, glance: grip < 0.6 });
    // La force de coupe tire la cible le long de la lame ; le couple de l'outil tord la cible
    let tool = held * bite.gear;
    let radius = jsmath::max(0.05, blade.outer);
    plans.bites.push(PlannedBite {
        part: sim.bots[b].blocks[arm.block].part,
        hub: frame.hub,
        body: contact.body,
        point: contact.point,
        axis: scale(frame.axis, sense),
        force: if axial { v3(0.0, 0.0, 0.0) } else { scale(dir, (bite.grab * tool) / radius) },
        torque: if axial { tool } else { 0.0 },
        twist: held * (bite.gear - 1.0),
    });
    // Les dégâts qu'elle accumule : une tranche par cible
    let damage = if contact.surface == Surface::Scenery { 0.0 } else { (drained / 1000.0) * spec.hit.damage * (0.2 + 0.8 * grip) };
    if let Some(g) = sim.bots[b].melee[a].gnaw
        && !same_target(g.target, contact.target)
    {
        plans.due.push((b, a, g));
        sim.bots[b].melee[a].gnaw = None;
    }
    let target = contact.target;
    let cell = match target {
        Some(Target::Block(tb, tk)) => {
            let k = &sim.bots[tb].blocks[tk];
            let feed_l = qrot_inv(sim.phys.rotation(sim.part(k.part).rb), feed);
            Some(GnawCell { bot: tb, part: k.part, x: k.x, y: k.y, z: k.z, feed: feed_l })
        }
        _ => None,
    };
    let prop_resist = match target {
        Some(Target::Prop(i)) => prop(sim, i).def().resistance(&spec.hit.damage_type),
        _ => 1.0,
    };
    let time = sim.time;
    let m = &mut sim.bots[b].melee[a];
    let gnaw = m.gnaw.get_or_insert(Gnaw { target, damage: 0.0, cut: 0.0, cell, point: contact.point, dir, hub: frame.hub, since: time, prop_resist });
    gnaw.damage += damage;
    gnaw.cut += drained;
    gnaw.cell = cell.or(gnaw.cell);
    gnaw.point = contact.point;
    gnaw.dir = dir;
    gnaw.hub = frame.hub;
    if time - gnaw.since + STEP / 2.0 >= BITE_TICK {
        let g = *gnaw;
        plans.due.push((b, a, g));
        m.gnaw = None;
    }
}

/// Qualité d'un coup sur une face de normale `normal` d'une lame qui va selon `motion` (`incidence`) :
/// 1 de face, 0 au-delà de 70°.
fn incidence(normal: V3, motion: V3) -> f64 {
    let ricochet = dcos((70.0 * PI) / 180.0);
    let c = -dot(normal, motion);
    clamp((c - ricochet) / (1.0 - ricochet), 0.0, 1.0)
}

/// Sens de l'impulsion d'un coup qui glisse sur une pente (`slide`).
fn slide(dir: V3, normal: Option<V3>, grip: f64) -> V3 {
    let Some(normal) = normal else { return dir };
    if grip >= 1.0 {
        return dir;
    }
    let into = -dot(dir, normal);
    if into <= 0.0 {
        return dir;
    }
    norm(add(dir, scale(normal, into * (1.0 - grip))))
}

pub fn distance(a: V3, b: V3) -> f64 {
    jsmath::hypot3(a.x - b.x, a.y - b.y, a.z - b.z)
}

/// `Math.max(prop.half.x, prop.half.y, prop.half.z)`.
fn prop_size(half: V3) -> f64 {
    jsmath::max(jsmath::max(half.x, half.y), half.z)
}

/// Ce que touche la lame d'un rotor (`rotorContact`) : parmi les blocs et les roues des robots ennemis,
/// les accessoires, et (quand `scenery`) le décor et le sol au bord de la lame, le plus proche du
/// moyeu ; ou, pour une lame qui mord (`base` : le centre de son bloc), le plus proche de son bloc.
fn rotor_contact(sim: &Sim, b: usize, f: &MeleeFrame, blade: &SweptRing, scenery: bool, base: Option<V3>) -> Option<Contact> {
    let mut best: Option<Contact> = None;
    let mut best_key = f64::INFINITY;
    let key_of = |radial: f64, at: V3| -> f64 {
        match base {
            Some(bs) => distance(at, bs),
            None => radial,
        }
    };
    let inside = |rel: V3, axis: V3, reach: f64| -> Option<(f64, f64)> {
        let along = dot(rel, axis);
        if along.abs() > blade.half + reach {
            return None;
        }
        let radial = len(sub(rel, scale(axis, along)));
        if radial > blade.outer + reach || radial < blade.inner - reach {
            return None;
        }
        Some((along, radial))
    };
    let extent = jsmath::max(blade.outer, blade.half);
    let bs = catalog().constants.block_size;
    let team = sim.bots[b].team;
    for (o, other) in sim.roster.iter().map(|&o| (o, &sim.bots[o])) {
        if o == b || other.team == team || other.live.is_empty() {
            continue;
        }
        // (un robot loin de là : on ne lit pas ses corps)
        if distance(other.last_pos, f.hub) > extent + 2.0 * (other.radius + other.top) + FAR_PART {
            continue;
        }
        for &p in &other.parts {
            let rb = sim.part(p).rb;
            let t = sim.phys.translation(rb);
            if distance(t, f.hub) > extent + other.radius + other.top + 1.0 {
                continue;
            }
            let q = sim.phys.rotation(rb);
            let hub_l = qrot_inv(q, sub(f.hub, t));
            let axis_l = qrot_inv(q, f.axis);
            let base_l = base.map(|bs| qrot_inv(q, sub(bs, t)));
            for &k in &sim.part(p).blocks {
                let local = other.blocks[k].local;
                let rel = sub(local, hub_l);
                let Some((along, radial)) = inside(rel, axis_l, BLOCK_REACH) else { continue };
                // Rang : la distance à l'axe de sa surface, ou à la base d'une lame qui mord
                let key = match base_l {
                    Some(bl) => len(sub(local, bl)),
                    None => radial - BLOCK_REACH,
                };
                if key >= best_key {
                    continue;
                }
                // Le point de la lame le plus proche du bloc ; pour une lame qui mord, là où elle y entre
                let point_l = match base_l {
                    Some(bl) => entry_point(local, bl, hub_l, axis_l, blade, bs),
                    None => {
                        let out = if radial > 1e-3 { scale(sub(rel, scale(axis_l, along)), 1.0 / radial) } else { qrot_inv(q, f.e1) };
                        add(hub_l, add(scale(axis_l, clamp(along, -blade.half, blade.half)), scale(out, clamp(radial - bs / 2.0, blade.inner, blade.outer))))
                    }
                };
                best = Some(Contact::robot(Target::Block(o, k), rb, add(t, qrot(q, point_l)), radial - BLOCK_REACH));
                best_key = key;
            }
        }
        for (w, wheel) in other.wheels.iter().enumerate() {
            let Some(wp) = wheel.part else { continue };
            let c = wheel.rb.pos;
            let reach = wheel.def.radius * WHEEL_REACH;
            let Some((_, radial)) = inside(sub(c, f.hub), f.axis, reach) else { continue };
            // (le pneu dépasse du flanc : une lame basse le rencontre avant la caisse)
            let key = key_of(radial - reach, c);
            if key >= best_key {
                continue;
            }
            best = Some(Contact::robot(Target::Wheel(o, w), sim.part(wp).rb, c, radial - reach));
            best_key = key;
        }
    }
    // Les accessoires : à chaque pas pour une lame qui mord, un pas sur trois pour un coup
    if scenery || base.is_some() {
        for i in present(sim) {
            let pr = prop(sim, i);
            if pr.hp <= 0.0 {
                continue;
            }
            let size = prop_size(pr.half);
            // Un accessoire ancré ne bouge pas : sa place dans l'arène suffit pour l'écarter
            if pr.fixed && distance(pr.spot, f.hub) > extent + size * 2.8 + 0.5 {
                continue;
            }
            if distance(sim.phys.translation(pr.rb), f.hub) > extent + size * 1.8 + 0.5 {
                continue;
            }
            let p = prop_nearest(sim, i, base.unwrap_or(f.hub));
            let Some((_, radial)) = inside(sub(p, f.hub), f.axis, 0.02) else { continue };
            let key = key_of(radial, p);
            if key >= best_key {
                continue;
            }
            best = Some(Contact {
                surface: Surface::Prop,
                target: Some(Target::Prop(i)),
                body: if pr.fixed { None } else { Some(pr.rb) },
                point: p,
                radial,
                normal: None,
                face: if pr.fixed { Some(towards(p, f.hub)) } else { None },
                floor: false,
            });
            best_key = key;
        }
    }
    if scenery && let Some(ground) = scenery_contact(sim, f, blade) {
        let key = key_of(ground.radial, ground.point);
        if key < best_key {
            best = Some(ground);
        }
    }
    best
}

/// Point où une lame qui mord entre dans un bloc (`entryPoint`, repère du robot mordu) : sur sa face
/// tournée vers la base de la lame, ramené dans le volume de la lame (sur l'axe d'une mèche).
fn entry_point(center: V3, base: V3, hub: V3, axis: V3, blade: &SweptRing, bs: f64) -> V3 {
    if blade.is_bit() {
        let toward = sign_or_one(dot(sub(hub, base), axis));
        let along = clamp(dot(sub(center, hub), axis) - (toward * bs) / 2.0, -blade.half, blade.half);
        return add(hub, scale(axis, along));
    }
    let back = sub(base, center);
    let flat = sub(back, scale(axis, dot(back, axis)));
    let d = len(flat);
    let p = if d > 1e-3 { add(center, scale(flat, jsmath::min(bs / 2.0, d) / d)) } else { center };
    // Dans l'épaisseur de la lame
    let along = dot(sub(p, hub), axis);
    sub(p, scale(axis, along - clamp(along, -blade.half, blade.half)))
}

/// La direction de `from` vers `to` (`towards`), ou le haut s'ils se confondent.
pub fn towards(from: V3, to: V3) -> V3 {
    if distance(from, to) > 1e-6 { norm(sub(to, from)) } else { UP }
}

/// Le décor et le sol que touche une lame (`sceneryContact`) : au bord d'un disque (huit rayons du
/// moyeu dans son plan, sur les boîtes à portée et le relief, et le sol sous son bord), ou le long d'une
/// mèche (un rayon de sa base à sa pointe, et le sol en quelques points de sa longueur).
fn scenery_contact(sim: &Sim, f: &MeleeFrame, blade: &SweptRing) -> Option<Contact> {
    if blade.is_bit() {
        // La mèche, de sa base (côté -axe) à sa pointe
        let start = sub(f.hub, scale(f.axis, blade.half));
        let length = 2.0 * blade.half;
        let mut best = ray_arena(sim, start, f.axis, length);
        for k in 1..=BIT_SAMPLES {
            let s = (length * k as f64) / BIT_SAMPLES as f64;
            if best.is_some_and(|b| s >= b) {
                break;
            }
            let p = add(start, scale(f.axis, s));
            if p.y - blade.outer <= ground_level(sim, p.x, p.z) {
                best = Some(s);
            }
        }
        let best = best?;
        let p = add(start, scale(f.axis, best));
        let ground = ground_level(sim, p.x, p.z);
        return Some(Contact {
            surface: Surface::Scenery,
            target: None,
            body: None,
            point: v3(p.x, clamp(ground, p.y - blade.outer, p.y), p.z),
            radial: best,
            normal: None,
            face: None,
            floor: false,
        });
    }
    // Les boîtes du décor à portée de la lame (une grande arène en a des centaines)
    let near: Vec<usize> = (0..sim.boxes.len())
        .filter(|&i| {
            let bx = &sim.boxes[i];
            bx.kind != "bound" && distance(bx.pos, f.hub) <= blade.outer + len(bx.half)
        })
        .collect();
    let mut best: Option<Contact> = None;
    for i in 0..SCENERY_RAYS {
        let a = (i as f64 / SCENERY_RAYS as f64) * PI * 2.0;
        let out = add(scale(f.e1, dcos(a)), scale(f.e2, dsin(a)));
        let hit = if !near.is_empty() || sim.arena.terrain.is_some() { ray_boxes(sim, &near, f.hub, out, blade.outer) } else { None };
        let reach = hit.unwrap_or(blade.outer);
        let rim = add(f.hub, scale(out, reach));
        // Le sol (ou le relief) sous le bord de la lame, plus haut que son tranchant
        let ground = ground_level(sim, rim.x, rim.z);
        let low = rim.y - blade.half * f.axis.y.abs() - (1.0 - f.axis.y.abs()) * 0.05;
        if (hit.is_some() || low <= ground) && best.is_none_or(|b| reach < b.radial) {
            best = Some(Contact {
                surface: Surface::Scenery,
                target: None,
                body: None,
                point: if hit.is_some() { rim } else { v3(rim.x, ground, rim.z) },
                radial: reach,
                normal: None,
                // Le mur fait face au moyeu ; le sol renvoie vers le haut
                face: Some(if hit.is_some() { scale(out, -1.0) } else { UP }),
                floor: hit.is_none(),
            });
        }
    }
    best
}

/// Face d'un bloc de forme que frappe une lame qui va selon `motion` (`shapeFace`) : parmi celles qui
/// lui font face, celle qui offre le plus de surface ; rien pour un cube, ou une face du cube.
fn shape_face(sim: &Sim, b: usize, k: usize, motion: V3) -> Option<V3> {
    let block = &sim.bots[b].blocks[k];
    let super::catalog::BlockShape::Shaped(shape) = &catalog().blocks[&block.kind].shape else { return None };
    let bq = qmul(sim.phys.rotation(sim.part(block.part).rb), block.rot);
    let local = qrot_inv(bq, norm(motion));
    let mut best_face: Option<V3> = None;
    let mut best_area = 0.0;
    for (normal, area) in shape_faces(shape) {
        let facing = -dot(normal, local);
        if facing <= 0.02 {
            continue;
        }
        let projected = area * facing;
        if projected > best_area {
            best_area = projected;
            best_face = Some(normal);
        }
    }
    let face = best_face?;
    let aligned = jsmath::max(jsmath::max(face.x.abs(), face.y.abs()), face.z.abs()) > 0.999;
    if aligned { None } else { Some(qrot(bq, face)) }
}

/// Un bras déclenché (`stepSwing`) : armement, frappe le long de son arc (premier contact), retour.
fn step_swing(sim: &mut Sim, b: usize, a: usize, plans: &mut Plans) {
    let spec = sim.bots[b].melee[a].spec();
    let swing = spec.swing.expect("bras sans arc");
    sim.bots[b].melee[a].phase_t += STEP;
    let arc = swing.rest - swing.end;
    let arm = sim.bots[b].melee[a];
    match arm.phase {
        Phase::Ready => {
            let m = &mut sim.bots[b].melee[a];
            m.swing = swing.rest;
            m.spin = 0.0;
            // Le vérin se charge sur les batteries (alimenté ; un fouet, hors de l'eau)
            if arm.trigger && sim.bots[b].energy >= swing.cost && power_ok(sim, b, &arm, spec, None) {
                sim.bots[b].energy -= swing.cost;
                let m = &mut sim.bots[b].melee[a];
                m.phase = Phase::Strike;
                m.phase_t = 0.0;
            }
        }
        Phase::Strike => {
            // La tête accélère d'un bout à l'autre de l'arc : son énergie croît avec l'angle parcouru
            let t = jsmath::min(1.0, arm.phase_t / swing.strike);
            let prev = arm.swing;
            let next = swing.rest - arc * t * t;
            sim.bots[b].melee[a].spin = (2.0 * arc * t) / swing.strike;
            let frame = melee_frame(sim, b, &arm);
            let found = head_contact(sim, b, &frame, &swing, prev, next, false);
            if let Some((contact, angle)) = found {
                let energy = swing.energy * clamp((swing.rest - angle) / arc, 0.0, 1.0);
                // Sens de la tête à cet angle, vers l'extérieur le long du bras, le long du pivot
                let motion = norm(add(scale(frame.e1, dsin(angle)), scale(frame.e2, dcos(angle))));
                let outward = arm_dir(&frame, angle);
                let p = &spec.hit.push;
                let dir = norm(add(add(add(scale(motion, p.tangent), scale(outward, p.radial)), scale(frame.axis, p.axial)), v3(0.0, p.lift, 0.0)));
                let part = sim.bots[b].blocks[arm.block].part;
                let m = &mut sim.bots[b].melee[a];
                m.swing = angle;
                m.hit_at = sim.time;
                plans.hits.push(PlannedHit::new(b, a, contact, energy, 1.0, dir, Some(motion), frame.hub, part));
                recover(m);
            } else {
                let m = &mut sim.bots[b].melee[a];
                m.swing = next;
                if t >= 1.0 {
                    recover(m);
                }
            }
        }
        Phase::Recover => {
            let t = jsmath::min(1.0, arm.phase_t / swing.recover);
            let m = &mut sim.bots[b].melee[a];
            m.spin = 0.0;
            m.swing = m.from + (swing.rest - m.from) * t * t * (3.0 - 2.0 * t);
            if t >= 1.0 {
                m.phase = Phase::Ready;
                m.phase_t = 0.0;
                m.swing = swing.rest;
            }
        }
        Phase::Hold => {}
    }
}

/// Le bras repart vers sa position d'armement (`recover`).
pub fn recover(m: &mut MeleeArm) {
    m.phase = Phase::Recover;
    m.phase_t = 0.0;
    m.from = m.swing;
}

/// Une pointe (`stepThrust`) : rentrée, elle sort sur ordre si les batteries ont de quoi, sa pointe
/// cherchant le premier contact le long de sa course ; touchée ou au bout, elle rentre.
fn step_thrust(sim: &mut Sim, b: usize, a: usize, plans: &mut Plans) {
    let spec = sim.bots[b].melee[a].spec();
    let thrust = spec.thrust.expect("pointe sans course");
    sim.bots[b].melee[a].phase_t += STEP;
    let course = thrust.reach - thrust.retracted;
    let arm = sim.bots[b].melee[a];
    match arm.phase {
        Phase::Ready => {
            let m = &mut sim.bots[b].melee[a];
            m.swing = thrust.retracted;
            m.spin = 0.0;
            if arm.trigger && sim.bots[b].energy >= thrust.cost && power_ok(sim, b, &arm, spec, None) {
                sim.bots[b].energy -= thrust.cost;
                let m = &mut sim.bots[b].melee[a];
                m.phase = Phase::Strike;
                m.phase_t = 0.0;
            }
        }
        Phase::Strike => {
            let t = jsmath::min(1.0, arm.phase_t / thrust.strike);
            let prev = arm.swing;
            let next = thrust.retracted + course * t * t;
            sim.bots[b].melee[a].spin = (2.0 * course * t) / thrust.strike;
            let frame = melee_frame(sim, b, &arm);
            let found = tip_contact(sim, b, &frame, &thrust, prev, next, false);
            if let Some((contact, extension)) = found {
                let p = &spec.hit.push;
                let dir = norm(add(scale(frame.e1, p.tangent + p.radial), add(scale(frame.axis, p.axial), v3(0.0, p.lift, 0.0))));
                let part = sim.bots[b].blocks[arm.block].part;
                let m = &mut sim.bots[b].melee[a];
                m.swing = extension;
                m.hit_at = sim.time;
                plans.hits.push(PlannedHit::new(b, a, contact, thrust.energy, 1.0, dir, Some(dir), frame.hub, part));
                recover(m);
            } else {
                let m = &mut sim.bots[b].melee[a];
                m.swing = next;
                if t >= 1.0 {
                    recover(m);
                }
            }
        }
        Phase::Recover => {
            let t = jsmath::min(1.0, arm.phase_t / thrust.recover);
            let m = &mut sim.bots[b].melee[a];
            m.spin = 0.0;
            m.swing = m.from + (thrust.retracted - m.from) * t * t * (3.0 - 2.0 * t);
            if t >= 1.0 {
                m.phase = Phase::Ready;
                m.phase_t = 0.0;
                m.swing = thrust.retracted;
            }
        }
        Phase::Hold => {}
    }
}

/// Premier contact de la pointe d'une lance le long de sa course (`tipContact`), de la sortie `from`
/// à `to` (m) : le contact et la sortie où il a lieu. `robots_only` : ne compte que les robots (l'IA).
pub fn tip_contact(sim: &Sim, b: usize, f: &MeleeFrame, thrust: &ThrustSpec, from: f64, to: f64, robots_only: bool) -> Option<(Contact, f64)> {
    let steps = jsmath::max(1.0, ((to - from).abs() / THRUST_STEP).ceil());
    let at = |s: f64| tip_at(f, from + (to - from) * s);
    path_contact(sim, b, f.hub, thrust.reach + thrust.radius + 1.0, thrust.radius, steps, &at, robots_only).map(|(c, s)| (c, from + (to - from) * s))
}

/// Premier contact de la tête d'un bras sur son arc (`headContact`), de l'angle `from` à `to` : le
/// contact et l'angle où il a lieu. `robots_only` : ne compte que les robots (l'IA).
pub fn head_contact(sim: &Sim, b: usize, f: &MeleeFrame, swing: &SwingSpec, from: f64, to: f64, robots_only: bool) -> Option<(Contact, f64)> {
    let steps = jsmath::max(1.0, ((from - to).abs() / ARC_STEP).ceil());
    let at = |s: f64| head_at(f, swing, from + (to - from) * s);
    path_contact(sim, b, f.hub, swing.reach + swing.radius + 1.0, swing.radius, steps, &at, robots_only).map(|(c, s)| (c, from + (to - from) * s))
}

/// Premier contact d'une tête de rayon `r` le long d'un chemin (`pathContact`, `at(s)` de s = 0 à 1 en
/// `steps` pas), qui ne s'éloigne pas de `reach` m de `center` : un bloc ou une roue d'un robot ennemi,
/// un accessoire, le décor (entre deux positions de la tête) ou le sol. Le contact et la part `s`.
#[allow(clippy::too_many_arguments)]
fn path_contact(sim: &Sim, b: usize, center: V3, reach: f64, r: f64, steps: f64, at: &dyn Fn(f64) -> V3, robots_only: bool) -> Option<(Contact, f64)> {
    let bs = catalog().constants.block_size;
    let team = sim.bots[b].team;
    // Les morceaux ennemis à portée du chemin (robot, morceau, pose)
    let mut near: Vec<(usize, usize, V3, Q)> = Vec::new();
    for (o, other) in sim.roster.iter().map(|&o| (o, &sim.bots[o])) {
        if o == b || other.team == team || other.live.is_empty() {
            continue;
        }
        for &p in &other.parts {
            let rb = sim.part(p).rb;
            let t = sim.phys.translation(rb);
            if distance(t, center) < reach + other.radius + other.top {
                near.push((o, p, t, sim.phys.rotation(rb)));
            }
        }
    }
    let mut prev_head = at(0.0);
    let mut i = 1.0;
    while i <= steps {
        let s = i / steps;
        let head = at(s);
        let mut found: Option<Contact> = None;
        let mut nearest = f64::INFINITY;
        for &(o, p, t, q) in &near {
            let other = &sim.bots[o];
            let rb = sim.part(p).rb;
            let hl = qrot_inv(q, sub(head, t));
            let cx = jsmath::round(hl.x / bs) as i64;
            let cy = jsmath::round(hl.y / bs) as i64;
            let cz = jsmath::round(hl.z / bs) as i64;
            for dx in -1..=1 {
                for dy in -1..=1 {
                    for dz in -1..=1 {
                        let Some(&k) = other.cells.get(&(cx + dx, cy + dy, cz + dz)) else { continue };
                        let block = &other.blocks[k];
                        if block.part != p {
                            continue;
                        }
                        let d = len(v3(
                            jsmath::max(0.0, (hl.x - block.local.x).abs() - bs / 2.0),
                            jsmath::max(0.0, (hl.y - block.local.y).abs() - bs / 2.0),
                            jsmath::max(0.0, (hl.z - block.local.z).abs() - bs / 2.0),
                        ));
                        if d < r && d < nearest {
                            nearest = d;
                            found = Some(Contact::robot(Target::Block(o, k), rb, head, 0.0));
                        }
                    }
                }
            }
            for (w, wheel) in other.wheels.iter().enumerate() {
                if wheel.part != Some(p) {
                    continue;
                }
                let d = distance(wheel.rb.pos, head) - wheel.def.radius * WHEEL_REACH;
                if d < r && d < nearest {
                    nearest = d;
                    found = Some(Contact::robot(Target::Wheel(o, w), rb, head, 0.0));
                }
            }
        }
        if found.is_none() && !robots_only {
            for i in present(sim) {
                let pr = prop(sim, i);
                if pr.hp <= 0.0 || distance(sim.phys.translation(pr.rb), head) > prop_size(pr.half) * 1.8 + r {
                    continue;
                }
                let p = prop_nearest(sim, i, head);
                if distance(p, head) < r {
                    found = Some(Contact {
                        surface: Surface::Prop,
                        target: Some(Target::Prop(i)),
                        body: if pr.fixed { None } else { Some(pr.rb) },
                        point: p,
                        radial: 0.0,
                        normal: None,
                        face: if pr.fixed { Some(towards(p, head)) } else { None },
                        floor: false,
                    });
                    break;
                }
            }
            // Le sol sous la tête (ou le relief), ou le décor entre deux positions de la tête
            let ground = ground_level(sim, head.x, head.z);
            let seg = sub(head, prev_head);
            let length = len(seg);
            let wall = if length > 1e-4 { ray_arena(sim, prev_head, scale(seg, 1.0 / length), length + r) } else { None };
            if found.is_none() && (head.y - r <= ground || wall.is_some()) {
                let point = match wall {
                    Some(w) => add(prev_head, scale(seg, jsmath::min(1.0, w / jsmath::max(length, 1e-4)))),
                    None => v3(head.x, ground, head.z),
                };
                let face = if wall.is_some() { scale(seg, -1.0 / jsmath::max(length, 1e-4)) } else { UP };
                found = Some(Contact { surface: Surface::Scenery, target: None, body: None, point, radial: 0.0, normal: None, face: Some(face), floor: false });
            }
        }
        if let Some(c) = found {
            return Some((c, s));
        }
        prev_head = head;
        i += 1.0;
    }
    None
}

/// Un contact du champ (`FieldContact`) : ce qu'il frappe, le sens où il repousse, à quelle profondeur,
/// le rotor ennemi qu'il freine (robot, arme), si c'est une arme ennemie.
struct FieldContact {
    contact: Contact,
    dir: V3,
    depth: f64,
    rotor: Option<(usize, usize)>,
    weapon: bool,
}

/// Un champ (`stepField`) : sa charge, puis, tous les `gap` s, un coup sur ce qui entre dans sa marge.
fn step_field(sim: &mut Sim, b: usize, a: usize, gyros: &mut Gyros, plans: &mut Plans) {
    let Some(regime) = step_regime(sim, b, a, gyros) else { return };
    let arm = sim.bots[b].melee[a];
    let spec = arm.spec();
    let spin = spec.spin.expect("champ sans charge");
    let field = spec.field.expect("champ sans marge");
    if arm.spin < spec.hit.min_speed * spin.speed || sim.time - arm.hit_at < spec.hit.gap {
        return;
    }
    let mut contacts = field_contacts(sim, b, &arm, spec);
    if contacts.is_empty() {
        return;
    }
    sim.bots[b].melee[a].hit_at = sim.time;
    let mut energy = regime.energy;
    let charge = regime.energy;
    // (`sort` : stable)
    contacts.sort_by(|x, y| y.depth.partial_cmp(&x.depth).unwrap_or(std::cmp::Ordering::Equal));
    let part = sim.bots[b].blocks[arm.block].part;
    for (i, c) in contacts.iter().take(field.contacts as usize).enumerate() {
        let hit_energy = jsmath::min(energy, charge * spec.hit.bite * (if c.weapon { FIELD_WEAPON_WEIGHT } else { 1.0 }));
        if hit_energy <= 0.0 {
            continue;
        }
        energy -= hit_energy;
        // Un rotor ennemi qui s'y frotte : son régime chute
        if let Some((ob, oa)) = c.rotor {
            sim.bots[ob].melee[oa].spin *= (1.0 - field.drain).sqrt();
        }
        let mut hit = PlannedHit::new(b, a, c.contact, hit_energy, 1.0, c.dir, Some(c.dir), c.contact.point, part);
        hit.quiet = i > 0;
        // Une arme ennemie est repoussée franchement (`repel`) ; ce qui touche la coque, d'après `fling`
        hit.impulse = if c.weapon { Some(field.repel) } else { None };
        plans.hits.push(hit);
    }
    sim.bots[b].melee[a].spin = ((2.0 * jsmath::max(0.0, energy)) / spin.inertia).sqrt();
}

/// Ce qui entre dans la marge d'un champ (`fieldContacts`), autour des blocs de son morceau à moins de
/// `field.radius` m du projecteur : les blocs et les roues des ennemis proches, la lame d'un de leurs
/// rotors qui y passe, la tête d'un bras ou la pointe d'une lance qui y entre ; chacun une fois.
fn field_contacts(sim: &Sim, b: usize, arm: &MeleeArm, spec: &MeleeSpec) -> Vec<FieldContact> {
    let field = spec.field.expect("champ sans marge");
    let bs = catalog().constants.block_size;
    let bot = &sim.bots[b];
    let part = bot.blocks[arm.block].part;
    let rb = sim.part(part).rb;
    let t = sim.phys.translation(rb);
    let q = sim.phys.rotation(rb);
    let own_local = bot.blocks[arm.block].local;
    // Les blocs couverts, et leur encombrement dans le repère du robot
    let mut covered: Vec<usize> = Vec::new();
    let mut lo = v3(f64::INFINITY, f64::INFINITY, f64::INFINITY);
    let mut hi = v3(f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for &k in &sim.part(part).blocks {
        let l = bot.blocks[k].local;
        if distance(l, own_local) > field.radius {
            continue;
        }
        covered.push(k);
        lo.x = jsmath::min(lo.x, l.x);
        lo.y = jsmath::min(lo.y, l.y);
        lo.z = jsmath::min(lo.z, l.z);
        hi.x = jsmath::max(hi.x, l.x);
        hi.y = jsmath::max(hi.y, l.y);
        hi.z = jsmath::max(hi.z, l.z);
    }
    if covered.is_empty() {
        return Vec::new();
    }
    let to_local = |w: V3| qrot_inv(q, sub(w, t));
    let to_world = |l: V3| add(t, qrot(q, l));
    // Le bloc couvert le plus proche d'un point (repère du robot) à moins de `reach` m de sa surface
    let hull = |l: V3, reach: f64| -> Option<(V3, f64)> {
        let pad = reach + bs / 2.0;
        if l.x < lo.x - pad || l.y < lo.y - pad || l.z < lo.z - pad || l.x > hi.x + pad || l.y > hi.y + pad || l.z > hi.z + pad {
            return None;
        }
        let n = (pad / bs).ceil() as i64;
        let cx = jsmath::round(l.x / bs) as i64;
        let cy = jsmath::round(l.y / bs) as i64;
        let cz = jsmath::round(l.z / bs) as i64;
        let mut best: Option<(V3, f64)> = None;
        for dx in -n..=n {
            for dy in -n..=n {
                for dz in -n..=n {
                    let Some(&k) = bot.cells.get(&(cx + dx, cy + dy, cz + dz)) else { continue };
                    if !covered.contains(&k) {
                        continue;
                    }
                    let bl = bot.blocks[k].local;
                    let h = bs / 2.0;
                    let surface = v3(clamp(l.x, bl.x - h, bl.x + h), clamp(l.y, bl.y - h, bl.y + h), clamp(l.z, bl.z - h, bl.z + h));
                    let d = distance(surface, l);
                    if d < reach && best.is_none_or(|(_, bd)| d < bd) {
                        best = Some((surface, d));
                    }
                }
            }
        }
        best
    };
    let p = &spec.hit.push;
    // Le sens où le champ repousse ce qui est en `at`, depuis le point `from` de sa coque
    let repel = |from: V3, at: V3| -> V3 {
        let mut out = sub(at, from);
        if len(out) < 1e-4 {
            out = sub(at, to_world(own_local));
        }
        norm(add(scale(norm(out), p.radial), scale(UP, p.lift)))
    };
    let mut out: Vec<FieldContact> = Vec::new();
    let block_reach = BLOCK_REACH + field.margin;
    for (o, other) in sim.roster.iter().map(|&o| (o, &sim.bots[o])) {
        if o == b || other.team == bot.team || other.live.is_empty() {
            continue;
        }
        for &op in &other.parts {
            let orb = sim.part(op).rb;
            let ot = sim.phys.translation(orb);
            if distance(ot, t) > bot.radius + other.radius + bot.top + other.top + field.margin + 1.0 {
                continue;
            }
            let oq = sim.phys.rotation(orb);
            for &k in &sim.part(op).blocks {
                let w = add(ot, qrot(oq, other.blocks[k].local));
                let Some((h, d)) = hull(to_local(w), block_reach) else { continue };
                let surface = to_world(h);
                out.push(FieldContact { contact: Contact::robot(Target::Block(o, k), orb, surface, 0.0), dir: repel(surface, w), depth: block_reach - d, rotor: None, weapon: false });
            }
        }
        for (wi, wheel) in other.wheels.iter().enumerate() {
            let Some(wp) = wheel.part else { continue };
            let c = wheel.rb.pos;
            let reach = wheel.def.radius * WHEEL_REACH + field.margin;
            let Some((h, d)) = hull(to_local(c), reach) else { continue };
            let surface = to_world(h);
            out.push(FieldContact { contact: Contact::robot(Target::Wheel(o, wi), sim.part(wp).rb, surface, 0.0), dir: repel(surface, c), depth: reach - d, rotor: None, weapon: false });
        }
        // Leurs armes de contact qui s'y frottent : la lame d'un rotor, la tête d'un bras, une pointe
        for (ea, enemy) in other.melee.iter().enumerate() {
            if !other.blocks[enemy.block].alive {
                continue;
            }
            let es = enemy.spec();
            let ef = melee_frame(sim, o, enemy);
            if distance(ef.hub, t) > bot.radius + bot.top + melee_reach(es) + field.margin + 1.0 {
                continue;
            }
            let mut at: Option<V3> = None;
            let mut rotor = None;
            if let (Some(blade), Some(espin)) = (es.blade, es.spin)
                && enemy.spin >= es.hit.min_speed * espin.speed
            {
                // Un bloc couvert dans l'anneau que balaie la lame (élargi de la marge)
                for &k in &covered {
                    let rel = sub(to_world(bot.blocks[k].local), ef.hub);
                    let along = dot(rel, ef.axis);
                    if along.abs() > blade.half + block_reach {
                        continue;
                    }
                    let radial = len(sub(rel, scale(ef.axis, along)));
                    if radial > blade.outer + block_reach || radial < blade.inner - block_reach {
                        continue;
                    }
                    at = Some(to_world(bot.blocks[k].local));
                    rotor = Some((o, ea));
                    break;
                }
            } else if let Some(swing) = es.swing
                && enemy.phase == Phase::Strike
            {
                let head = head_at(&ef, &swing, enemy.swing);
                if hull(to_local(head), swing.radius + field.margin).is_some() {
                    at = Some(head);
                }
            } else if let Some(thrust) = es.thrust
                && enemy.phase == Phase::Strike
            {
                let tip = tip_at(&ef, enemy.swing);
                if hull(to_local(tip), thrust.radius + field.margin).is_some() {
                    at = Some(tip);
                }
            }
            let Some(at) = at else { continue };
            // Le point de la coque face à l'arme, et le sens qui l'en écarte (vers son moyeu)
            let toward = norm(sub(ef.hub, at));
            let surface = if rotor.is_some() { add(at, scale(toward, bs / 2.0)) } else { at };
            let erb = sim.part(other.blocks[enemy.block].part).rb;
            out.push(FieldContact {
                contact: Contact::robot(Target::Block(o, enemy.block), erb, surface, 0.0),
                dir: norm(add(scale(toward, p.radial), scale(UP, p.lift))),
                depth: 10.0,
                rotor,
                weapon: true,
            });
        }
    }
    // Un même bloc n'est frappé qu'une fois par coup (le contact le plus fort)
    out.sort_by(|x, y| y.depth.partial_cmp(&x.depth).unwrap_or(std::cmp::Ordering::Equal));
    let mut seen: Vec<Target> = Vec::new();
    out.retain(|c| {
        let Some(target) = c.contact.target else { return true };
        if seen.contains(&target) {
            return false;
        }
        seen.push(target);
        true
    });
    out
}

/// Gyroscope d'un morceau (`precess`) : son moment cinétique propre le fait précesser, intégré
/// implicitement : Ω' = (1 − dt·I⁻¹·[L]×)⁻¹·Ω.
fn precess(sim: &mut Sim, p: usize, l: V3) {
    let rb = sim.part(p).rb;
    if sim.phys.inv_mass(rb) <= 0.0 {
        return;
    }
    let w = sim.phys.angvel(rb);
    let m = sim.phys.effective_world_inv_inertia(rb);
    let inv = [[m[0], m[1], m[2]], [m[1], m[3], m[4]], [m[2], m[4], m[5]]];
    // [L]× : la matrice de v ↦ L × v
    let k = [[0.0, -l.z, l.y], [l.z, 0.0, -l.x], [-l.y, l.x, 0.0]];
    let a: Vec<Vec<f64>> = (0..3)
        .map(|i| (0..3).map(|j| (if i == j { 1.0 } else { 0.0 }) - STEP * (inv[i][0] * k[0][j] + inv[i][1] * k[1][j] + inv[i][2] * k[2][j])).collect())
        .collect();
    if let Some(s) = solve_linear(&a, &[w.x, w.y, w.z]) {
        sim.phys.set_angvel(rb, v3(s[0], s[1], s[2]), true);
    }
}

/// Masse effective d'un corps au point `at`, dans la direction `dir` (kg) ; ∞ pour un corps fixe
/// (`effectiveMass`).
pub fn effective_mass(sim: &Sim, rb: RigidBodyHandle, at: V3, dir: V3) -> f64 {
    let inv = sim.phys.inv_mass(rb);
    if inv <= 0.0 {
        return f64::INFINITY;
    }
    let u = cross(sub(at, sim.phys.world_com(rb)), dir);
    let m = sim.phys.effective_world_inv_inertia(rb);
    let iu = v3(m[0] * u.x + m[1] * u.y + m[2] * u.z, m[1] * u.x + m[3] * u.y + m[4] * u.z, m[2] * u.x + m[4] * u.y + m[5] * u.z);
    1.0 / (inv + dot(u, iu))
}

/// Voisins liés d'un bloc, sur son morceau (`neighbors`).
fn neighbors(sim: &Sim, b: usize, k: usize) -> Vec<usize> {
    let bot = &sim.bots[b];
    let block = &bot.blocks[k];
    let here = block.cell();
    let mut out = Vec::new();
    for (dx, dy, dz) in NEIGHBORS {
        let cell: Cell = (here.0 + dx, here.1 + dy, here.2 + dz);
        if let Some(&n) = bot.cells.get(&cell)
            && bot.blocks[n].part == block.part
            && !bot.cuts.contains(&link_key(here, cell))
        {
            out.push(n);
        }
    }
    out
}

/// `x` vaut-il vrai en JavaScript (non nul, pas NaN) ?
fn truthy(x: f64) -> bool {
    x != 0.0 && !x.is_nan()
}

/// Les coups et les morsures du pas, mesurés (`landHits`) : les poussées des morsures et les
/// impulsions des coups d'abord, puis les dégâts, coup par coup (un coup peut allumer ce qu'il
/// touche, une décharge paralyser autour du point touché) ; l'arme s'use ; enfin les tranches de morsure.
fn land_hits(sim: &mut Sim, plans: Plans) {
    let Plans { hits, bites, due } = plans;
    for bt in &bites {
        let pushes = truthy(bt.force.x) || truthy(bt.force.y) || truthy(bt.force.z);
        if let Some(body) = bt.body
            && pushes
        {
            sim.phys.apply_impulse_at_point(body, scale(bt.force, STEP), bt.point, true);
        }
        if pushes {
            let rb = sim.part(bt.part).rb;
            sim.phys.apply_impulse_at_point(rb, scale(bt.force, -STEP), bt.hub, true);
        }
        if let Some(body) = bt.body
            && truthy(bt.torque)
        {
            sim.phys.apply_torque_impulse(body, scale(bt.axis, bt.torque * STEP), true);
        }
        if truthy(bt.twist) {
            let rb = sim.part(bt.part).rb;
            sim.phys.apply_torque_impulse(rb, scale(bt.axis, -bt.twist * STEP), true);
        }
    }
    let mut lots: Vec<(DamageBatch, DamageBatch, V3, V3)> = Vec::new();
    for h in &hits {
        let arm = sim.bots[h.bot].melee[h.arm];
        let spec = arm.spec();
        let hit = &spec.hit;
        let contact = &h.contact;
        let dir = h.dir;
        // Ce qui ne bouge pas renvoie l'arme le long de sa surface (et du frottement contre son sens de passage)
        let away = match contact.face {
            Some(face) => norm(sub(face, scale(h.motion.unwrap_or(dir), SCRAPE))),
            None => scale(dir, -1.0),
        };
        let theirs = contact.body.map_or(f64::INFINITY, |body| effective_mass(sim, body, contact.point, dir));
        let rb = sim.part(h.part).rb;
        // (une arme d'énergie ne pousse ni ne recule : `fling` et `recoil` à 0)
        let impulse = match h.impulse {
            Some(i) => i,
            None => {
                let mine = effective_mass(sim, rb, h.hub, away);
                let reduced = if theirs.is_finite() { 1.0 / (1.0 / mine + 1.0 / theirs) } else { mine };
                if hit.fling > 0.0 { (2.0 * reduced * h.energy * hit.fling).sqrt() } else { 0.0 }
            }
        };
        if impulse > 0.0
            && let Some(body) = contact.body
            && theirs.is_finite()
        {
            sim.phys.apply_impulse_at_point(body, scale(dir, impulse), contact.point, true);
        }
        let back = h.reaction.unwrap_or(impulse * hit.recoil);
        let kick = scale(away, back);
        if back > 0.0 {
            sim.phys.apply_impulse_at_point(rb, kick, h.hub, true);
        }

        let mut batch = DamageBatch { attacker: Some(h.bot), armed: true, cause: Some(arm.weapon), ..DamageBatch::default() };
        let damage = h.damage.unwrap_or((h.energy / 1000.0) * hit.damage * (0.2 + 0.8 * h.grip));
        let mut toughness = 1.0;
        match contact.target {
            Some(Target::Block(tb, tk)) => {
                batch.add(sim, contact.target, damage, &hit.damage_type);
                // Les voisins encaissent une part du coup
                let around = neighbors(sim, tb, tk);
                if hit.spread > 0.0 {
                    for &n in &around {
                        batch.add(sim, Some(Target::Block(tb, n)), damage * hit.spread, &hit.damage_type);
                    }
                }
                if impulse > 0.0 {
                    let tp = sim.bots[tb].blocks[tk].part;
                    batch.shock(sim, tp, contact.point, scale(dir, impulse), Some(tk));
                }
                toughness = resistance(sim, Target::Block(tb, tk), &hit.damage_type);
                // Le plasma allume ce qu'il touche (et parfois ses voisins)
                if let Some(chance) = hit.ignite
                    && truthy(chance)
                {
                    if sim.rng.rand(0.0, 1.0) < chance * flammability(sim, tb, tk) {
                        ignite(sim, tb, tk, BURN_TIME);
                    }
                    for &n in &around {
                        if sim.rng.rand(0.0, 1.0) < 0.5 * chance * flammability(sim, tb, n) {
                            ignite(sim, tb, n, BURN_TIME);
                        }
                    }
                }
            }
            Some(Target::Wheel(..)) => batch.add(sim, contact.target, damage * hit.wheels.unwrap_or(1.0), &hit.damage_type),
            Some(t) => {
                batch.add(sim, contact.target, damage, &hit.damage_type);
                toughness = resistance(sim, t, &hit.damage_type);
                if let (Some(chance), Target::Prop(i)) = (hit.ignite, t)
                    && truthy(chance)
                    && burnable(sim, i)
                    && sim.rng.rand(0.0, 1.0) < chance
                {
                    ignite_prop(sim, i);
                }
            }
            // (le décor)
            None => toughness = 0.5,
        }
        // Une décharge : les organes autour du point touché sont paralysés (lit les poses : avant d'infliger)
        let victim = match contact.target {
            Some(Target::Block(tb, _)) | Some(Target::Wheel(tb, _)) => Some(tb),
            _ => None,
        };
        if let (Some((radius, duration)), Some(v)) = (hit.stun, victim) {
            stun_organs(sim, v, contact.point, radius, duration);
        }
        // Sa propre arme : le choc au moyeu éprouve ses liaisons, et elle s'use
        let mut own = DamageBatch::default();
        if back > 0.0 {
            own.shock(sim, h.part, h.hub, kick, Some(arm.block));
        }
        if hit.wear > 0.0 {
            own.add(sim, Some(Target::Block(h.bot, arm.block)), ((h.energy / 1000.0) * hit.wear) / jsmath::max(0.25, toughness), "impact");
        }
        if !h.quiet {
            sim.stats.melee_hits += 1;
            let surface = match contact.surface {
                Surface::Robot => 0.0,
                Surface::Prop => 1.0,
                Surface::Scenery => 2.0,
            };
            let (point, energy, glance) = (contact.point, h.energy, h.grip < 0.6);
            sim.emit(code::MELEE_HIT, |s, w| {
                w.id(Some(s.bots[h.bot].blocks[arm.block].id)).vec(point).vec(dir).num(energy).num(surface).flag(glance);
            });
        }
        lots.push((batch, own, dir, h.hub));
    }
    for (mut batch, mut own, dir, hub) in lots {
        // Un morceau libéré par un coup précédent de ce pas ne se relit pas
        batch.cuts.retain(|(p, _)| sim.parts[*p].is_some());
        own.cuts.retain(|(p, _)| sim.parts[*p].is_some());
        inflict(sim, &batch, dir, Some(hub));
        // (sans réaction de l'IA : c'est son propre coup)
        inflict(sim, &own, scale(dir, -1.0), None);
    }
    for (b, a, gnaw) in due {
        land_gnaw(sim, b, a, &gnaw);
    }
}

/// Une tranche de morsure (`landGnaw`) : ses dégâts sur ce qu'elle mordait ; sur un bloc, ce qui reste
/// quand il cède passe au suivant dans le sens où la lame avance (`gnawChain`), jusqu'à `depth` m ; ses
/// voisins en reçoivent une part. La lame s'use d'autant.
fn land_gnaw(sim: &mut Sim, b: usize, a: usize, gnaw: &Gnaw) {
    let arm = sim.bots[b].melee[a];
    let spec = arm.spec();
    let hit = &spec.hit;
    let kind = hit.damage_type.as_str();
    let mut batch = DamageBatch { attacker: Some(b), armed: true, cause: Some(arm.weapon), ..DamageBatch::default() };
    let target = gnaw.target;
    // (le décor)
    let mut toughness = 0.5;
    if let Some(cell) = gnaw.cell
        && gnaw.damage > 0.0
    {
        let first = match target {
            Some(Target::Block(_, k)) => Some(k),
            _ => None,
        };
        let chain = gnaw_chain(sim, &cell, first, spec.bite.map_or(0.0, |bt| bt.depth));
        let mut left = gnaw.damage;
        for (i, &k) in chain.iter().enumerate() {
            let r = resistance(sim, Target::Block(cell.bot, k), kind);
            if i == 0 {
                toughness = r;
                // Les voisins du premier bloc encaissent une part de la tranche
                if hit.spread > 0.0 {
                    for n in neighbors(sim, cell.bot, k) {
                        batch.add(sim, Some(Target::Block(cell.bot, n)), gnaw.damage * hit.spread, kind);
                    }
                }
            }
            batch.add(sim, Some(Target::Block(cell.bot, k)), left, kind);
            let hp = sim.bots[cell.bot].blocks[k].hp;
            if left * r < hp {
                break;
            }
            // Percé : le reste passe au suivant
            left -= hp / jsmath::max(r, 1e-3);
            if left <= 1e-6 {
                break;
            }
        }
    } else if let Some(Target::Wheel(wb, w)) = target {
        let wheel = &sim.bots[wb].wheels[w];
        if wheel.part.is_some() || wheel.body.is_some() {
            batch.add(sim, target, gnaw.damage * hit.wheels.unwrap_or(1.0), kind);
        }
        toughness = 1.0;
    } else if let Some(Target::Prop(i)) = target {
        if sim.props[i].as_ref().is_some_and(|p| p.hp > 0.0) {
            batch.add(sim, target, gnaw.damage, kind);
        }
        toughness = gnaw.prop_resist;
    }
    if !batch.blocks.is_empty() || !batch.wheels.is_empty() || !batch.props.is_empty() {
        inflict(sim, &batch, gnaw.dir, Some(gnaw.hub));
    }
    // La lame s'use (son bloc a pu céder entre-temps)
    if sim.bots[b].blocks[arm.block].alive && hit.wear > 0.0 && gnaw.cut > 0.0 {
        let mut own = DamageBatch::default();
        own.add(sim, Some(Target::Block(b, arm.block)), ((gnaw.cut / 1000.0) * hit.wear) / jsmath::max(0.25, toughness), "impact");
        inflict(sim, &own, scale(gnaw.dir, -1.0), None);
    }
}

/// Blocs que traverse une morsure, dans l'ordre (`gnawChain`) : le bloc mordu (s'il est encore là),
/// puis ceux qui suivent dans le sens d'avance, sur le même morceau, jusqu'à `depth` m de la case
/// mordue. Ne lit que la grille du robot.
fn gnaw_chain(sim: &Sim, cell: &GnawCell, first: Option<usize>, depth: f64) -> Vec<usize> {
    let bot = &sim.bots[cell.bot];
    let part = match first {
        Some(k) if bot.blocks[k].alive => bot.blocks[k].part,
        _ => cell.part,
    };
    let bs = catalog().constants.block_size;
    let step = bs / 2.0;
    let feed = cell.feed;
    let x0 = cell.x * bs;
    let y0 = cell.y * bs;
    let z0 = cell.z * bs;
    let mut out = Vec::new();
    let mut last = None;
    let mut s = 0.0;
    while s <= depth + 1e-6 {
        let key = (
            jsmath::round((x0 + feed.x * s) / bs) as i64,
            jsmath::round((y0 + feed.y * s) / bs) as i64,
            jsmath::round((z0 + feed.z * s) / bs) as i64,
        );
        if let Some(&k) = bot.cells.get(&key)
            && Some(k) != last
            && bot.blocks[k].part == part
        {
            last = Some(k);
            out.push(k);
        }
        s += step;
    }
    out
}

/// Une frappe de ce bras toucherait-elle un robot ennemi, depuis là où il est jusqu'au bout de son
/// arc (`strikeWouldHit`) ?
pub fn strike_would_hit(sim: &Sim, b: usize, a: usize) -> bool {
    let arm = sim.bots[b].melee[a];
    let Some(swing) = arm.spec().swing else { return false };
    if !sim.bots[b].blocks[arm.block].alive {
        return false;
    }
    head_contact(sim, b, &melee_frame(sim, b, &arm), &swing, arm.swing, swing.end, true).is_some()
}

/// Une pointe sortie de là où elle est jusqu'au bout de sa course toucherait-elle un robot ennemi
/// (`thrustWouldHit`) ?
pub fn thrust_would_hit(sim: &Sim, b: usize, a: usize) -> bool {
    let arm = sim.bots[b].melee[a];
    let Some(thrust) = arm.spec().thrust else { return false };
    if !sim.bots[b].blocks[arm.block].alive {
        return false;
    }
    tip_contact(sim, b, &melee_frame(sim, b, &arm), &thrust, arm.swing, thrust.reach, true).is_some()
}
