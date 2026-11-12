//! Le monde de la simulation portée (`Simulation`, src/shared/sim/simulation.ts) : Rapier à pas
//! fixe, le sol commun à toutes les arènes (`buildGround`, src/shared/arena/arena.ts), le décor fixe
//! d'une arène (`buildScenery`, `clearScenery` : des boîtes, données par l'appelant, avec leur sorte,
//! dont la navigation se sert), ses dimensions (`ArenaBounds` : son bord, la zone où rôde l'IA), le
//! niveau de son eau, ses accessoires (`resetProps` : leurs emplacements, donnés par l'appelant), les
//! robots, pilotés ou conduits par l'IA, leurs morceaux, les débris, les feux et les flaques de feu,
//! ce que chaque équipe a repéré, et le hasard (`Math.random` à graine fixe).
//!
//! Le pas fait ce que fait celui du TypeScript pour des robots au sol, pilotés ou conduits par l'IA
//! hors combat (`sim.combat` faux, comme au stand de tir : l'IA patrouille, contourne le décor, se
//! dégage, fuit ou fonce sur qui la heurte, mais ses tourelles ne visent ni ne tirent) : la détection
//! (`updateDetection`), leurs commandes (`thinkBot` : celles du pilote, ou la conduite de l'IA),
//! leurs roues (`stepWheels`), le mouvement des corps avant la physique (`captureMotions`), la
//! physique (`world.step`), la pose des roues (`placeWheels`), les chocs et leurs dégâts
//! (`resolveCollisions` : blocs détruits, liaisons rompues, morceaux séparés, roues arrachées,
//! accessoires qui cèdent, percées), les feux et les flaques de feu (`updateFires`), les modules de
//! réparation (`updateRepairs` : blocs et roues réparés, blocs qui repoussent), les accessoires qui
//! ont cédé (`updateProps` : mèches, fuites de gaz, explosions en chaîne, éclats), la fin de vie des
//! débris et des épaves de roues. Le reste du pas du TypeScript (air, armes…) ne touche pas à de tels
//! robots : tests/nativeSim.test.ts le vérifie par ses événements. Ce qui arriverait sans être porté
//! serait compté (`Stats.unported`).

use super::catalog::catalog;
use super::collisions::{capture_motions, resolve_collisions};
use super::debris::{Debris, expire_debris};
use super::detection::update_detection;
use super::drive::think;
use super::fire::{GroundFire, update_fires};
use super::lifecycle::{expire_wheel_wrecks, spawn_bot};
use super::physics::{BodyDesc, ColliderDesc, Physics, ShapeDesc, groups};
use super::props::{Prop, add_prop, update_props};
use super::repair::update_repairs;
use super::rng::Rng;
use super::robot::{Bot, Part};
use super::vec::{NO_ROTATION, Q, V3, v3};
use super::navigation::nav_gaps;
use super::wheels::{place_wheels, step_wheels};
use rapier3d::prelude::{ColliderHandle, RigidBodyHandle};
use std::collections::HashMap;

/// Pas fixe de la physique (s) et itérations du solveur (src/shared/config.ts).
pub const STEP: f64 = 1.0 / 60.0;
pub const SOLVER_ITERATIONS: usize = 4;
/// Le sol (src/shared/arena/arena.ts, layout.ts).
const GROUND_HALF: f64 = 220.0;
/// Les dimensions des petites arènes (`SMALL`, arena/sources.ts) : celles d'un monde neuf, le Dépôt.
const SMALL_HALF: f64 = 36.0;
const SMALL_ROAM: f64 = 29.0;
const GROUND_FRICTION: f64 = 0.9;
const STATIC_FRICTION: f64 = 0.8;

/// Ce que représente un collider (`ColliderOwner`) : un morceau, une roue (robot, roue), la tête
/// d'une tourelle (robot, tourelle), un débris, un accessoire. Le décor et le sol n'en ont pas.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Owner {
    Part(usize),
    Wheel(usize, usize),
    Head(usize, usize),
    Debris,
    Prop(usize),
}

/// Une boîte du décor fixe (`StaticBox`) : sa sorte (`kind` : mur, rampe, pilier, plateforme, muret…),
/// sa pose et ses demi-dimensions telles que les donne l'arène (en nombres de 8 octets : la navigation
/// les lit, pas Rapier), si c'est un cylindre (`round`), et son corps.
pub struct SceneryBox {
    pub kind: String,
    pub pos: V3,
    pub half: V3,
    pub rot: Q,
    pub round: bool,
    pub rb: RigidBodyHandle,
}

/// Les dimensions d'une arène (`ArenaBounds`) : la demi-largeur de son terrain (ses murs), et celle
/// de la zone où rôde l'IA (m).
#[derive(Clone, Copy)]
pub struct Bounds {
    pub half: f64,
    pub roam: f64,
}

/// Ce qui s'est passé depuis la création du monde : de quoi comparer avec les événements du TypeScript.
#[derive(Default, Clone, Copy)]
pub struct Stats {
    /// Événements `collision` (un choc infligé, une épave de roue qui cède).
    pub collisions: u32,
    /// Événements `damage` (un lot de dégâts infligé).
    pub damage: u32,
    /// Blocs détruits (`destroyedCount`).
    pub destroyed: u32,
    /// Événements `linkBroken`.
    pub links_broken: u32,
    /// Événements `botKilled`.
    pub killed: u32,
    /// Roues arrachées (`releaseWheel`) et retirées (`wheelRemoved`).
    pub wheels_released: u32,
    pub wheels_removed: u32,
    /// Ce qui serait arrivé sans être porté : la navigation dans une arène qui a un pont ou une
    /// haute rampe (navigation.rs).
    pub unported: u32,
    /// Événements `explosion`, `propRemoved`, `propReleased`.
    pub explosions: u32,
    pub props_removed: u32,
    pub props_released: u32,
    /// Événements `fireStarted`, `fireEnded` (un bloc), `propFire` (un accessoire : allumé, éteint,
    /// un cran de plus noirci).
    pub fires_started: u32,
    pub fires_ended: u32,
    pub prop_fire_events: u32,
    /// Événements `blockRebuilt` (un bloc qui repousse) et `blockRepaired` (un bloc réparé par un
    /// module), `groundFireAdded` et `groundFireRemoved` (une flaque de feu allumée, éteinte).
    pub rebuilt: u32,
    pub repaired: u32,
    pub ground_fires_added: u32,
    pub ground_fires_removed: u32,
}

pub struct Sim {
    pub phys: Physics,
    /// Le décor fixe de l'arène, dans l'ordre de ses boîtes (`arena.boxes`), et ses dimensions.
    pub boxes: Vec<SceneryBox>,
    pub bounds: Bounds,
    /// Ce que la navigation ne sait pas encore faire dans ce décor : des ponts, de hautes rampes
    /// (leur nombre ; navigation.rs).
    pub nav_gaps: u32,
    /// Les ennemis que chaque équipe a repérés (`sim.detected` : rouges, bleus ; rien tant que la
    /// détection n'a pas tourné), dans l'ordre de `sim.bots` (detection.rs).
    pub detected: [Option<Vec<usize>>; 2],
    pub bots: Vec<Bot>,
    /// Les morceaux, par numéro (un morceau retiré laisse sa place vide).
    pub parts: Vec<Option<Part>>,
    /// Les morceaux présents, dans l'ordre de `sim.parts` (un `Set` : l'ordre d'arrivée).
    pub order: Vec<usize>,
    /// Ce que représente chaque collider (`sim.colliders`).
    pub owners: HashMap<ColliderHandle, Owner>,
    pub debris: Vec<Debris>,
    /// Les accessoires, par emplacement (un accessoire retiré laisse sa place vide) : les présents,
    /// dans cet ordre, sont `sim.props`.
    pub props: Vec<Option<Prop>>,
    /// Les blocs en feu (robot, bloc) et les accessoires en feu, dans l'ordre où ils ont pris (des `Set`).
    pub fires: Vec<(usize, usize)>,
    pub prop_fires: Vec<usize>,
    /// Les flaques de feu au sol, dans l'ordre où elles ont pris (`sim.groundFires`).
    pub ground_fires: Vec<GroundFire>,
    /// Le niveau de l'eau de l'arène (`arena.water`), s'il y en a : elle éteint les flaques.
    pub water: Option<f64>,
    pub rng: Rng,
    pub gravity: f64,
    pub time: f64,
    pub stats: Stats,
}

impl Sim {
    /// Le monde et son sol (le constructeur de `Simulation`, sans le décor de l'arène : `add_box`).
    pub fn new() -> Self {
        let gravity = catalog().constants.gravity;
        let mut phys = Physics::new(gravity, STEP, SOLVER_ITERATIONS);
        let ground = phys.create_body(&BodyDesc::fixed(v3(0.0, -0.5, 0.0), NO_ROTATION));
        let desc = ColliderDesc { friction: GROUND_FRICTION, collision_groups: groups::STATIC_GROUP, ..ColliderDesc::new(ShapeDesc::Cuboid(GROUND_HALF, 0.5, GROUND_HALF)) };
        phys.create_collider(&desc, ground);
        Sim {
            phys,
            boxes: Vec::new(),
            bounds: Bounds { half: SMALL_HALF, roam: SMALL_ROAM },
            nav_gaps: 0,
            detected: [None, None],
            bots: Vec::new(),
            parts: Vec::new(),
            order: Vec::new(),
            owners: HashMap::new(),
            debris: Vec::new(),
            props: Vec::new(),
            fires: Vec::new(),
            prop_fires: Vec::new(),
            ground_fires: Vec::new(),
            water: None,
            rng: Rng::new(0),
            gravity,
            time: 0.0,
            stats: Stats::default(),
        }
    }

    pub fn part(&self, p: usize) -> &Part {
        self.parts[p].as_ref().expect("morceau retiré")
    }

    pub fn part_mut(&mut self, p: usize) -> &mut Part {
        self.parts[p].as_mut().expect("morceau retiré")
    }

    /// Une boîte du décor fixe (`buildScenery`), de la sorte `kind` ; `round` : un cylindre debout
    /// inscrit dans la boîte.
    pub fn add_box(&mut self, kind: &str, pos: V3, half: V3, rot: Q, round: bool) {
        let rb = self.phys.create_body(&BodyDesc::fixed(pos, rot));
        let shape = if round { ShapeDesc::Cylinder(half.y, half.x) } else { ShapeDesc::Cuboid(half.x, half.y, half.z) };
        let desc = ColliderDesc { friction: STATIC_FRICTION, collision_groups: groups::STATIC_GROUP, ..ColliderDesc::new(shape) };
        self.phys.create_collider(&desc, rb);
        self.boxes.push(SceneryBox { kind: kind.to_string(), pos, half, rot, round, rb });
        self.nav_gaps = nav_gaps(&self.boxes);
    }

    /// Retire le décor fixe (`clearScenery` : ses corps, avec leurs colliders, dans l'ordre), comme
    /// quand on change d'arène (`loadArena`) : le monde neuf du TypeScript a le décor du Dépôt.
    pub fn clear_scenery(&mut self) {
        for b in std::mem::take(&mut self.boxes) {
            self.phys.remove_body(b.rb);
        }
        self.nav_gaps = 0;
    }

    /// Un robot préfabriqué, aux commandes d'un pilote (`spawnBot`, `takeControl`), chez les rouges ; son numéro.
    pub fn spawn(&mut self, id: &str, pos: V3, yaw: f64) -> Result<usize, String> {
        spawn_bot(self, id, pos, yaw, 0, true)
    }

    /// Un robot préfabriqué que conduit l'IA, dans l'équipe `team` (0 : les rouges, 1 : les bleus) ; son numéro.
    pub fn spawn_ai(&mut self, id: &str, pos: V3, yaw: f64, team: usize) -> Result<usize, String> {
        spawn_bot(self, id, pos, yaw, team, false)
    }

    /// L'accessoire de l'emplacement suivant de l'arène (`createProp`, appelé par `resetProps` dans
    /// l'ordre des emplacements) : son type, sa pose, ses dimensions (une dalle), son échelle (un
    /// cylindre) ; son numéro (celui de l'emplacement).
    pub fn add_prop(&mut self, kind: &str, pos: V3, rot: Option<Q>, half: Option<V3>, scale: Option<f64>) -> Result<usize, String> {
        add_prop(self, kind, pos, rot, half, scale)
    }

    /// Un pas fixe.
    pub fn step(&mut self) {
        update_detection(self);
        for b in 0..self.bots.len() {
            think(self, b);
        }
        step_wheels(self);
        let motions = capture_motions(self);
        let events = self.phys.step();
        place_wheels(self);
        self.time += STEP;
        resolve_collisions(self, &events, &motions);
        update_fires(self);
        update_repairs(self);
        update_props(self);
        expire_debris(self);
        expire_wheel_wrecks(self);
    }
}

impl Default for Sim {
    fn default() -> Self {
        Self::new()
    }
}
