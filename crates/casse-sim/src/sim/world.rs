//! Le monde de la simulation portée (`Simulation`, src/shared/sim/simulation.ts) : Rapier à pas
//! fixe, le sol commun à toutes les arènes (`buildGround`, src/shared/arena/arena.ts), le décor fixe
//! d'une arène (`buildScenery` : des boîtes, données par l'appelant), ses accessoires (`resetProps` :
//! leurs emplacements, donnés par l'appelant), les robots pilotés, leurs morceaux, les débris, les
//! feux, et le hasard (`Math.random` à graine fixe).
//!
//! Le pas fait ce que fait celui du TypeScript pour des robots au sol pilotés sans IA : leurs
//! commandes (`thinkBot`), leurs roues (`stepWheels`), le mouvement des corps avant la physique
//! (`captureMotions`), la physique (`world.step`), la pose des roues (`placeWheels`), les chocs et
//! leurs dégâts (`resolveCollisions` : blocs détruits, liaisons rompues, morceaux séparés, roues
//! arrachées, accessoires qui cèdent, percées), les feux (`updateFires`), les accessoires qui ont
//! cédé (`updateProps` : mèches, fuites de gaz, explosions en chaîne, éclats), la fin de vie des
//! débris et des épaves de roues. Le reste du pas du TypeScript (détection, air, armes,
//! réparations…) ne touche pas à de tels robots : tests/nativeSim.test.ts le vérifie par ses
//! événements. Ce qui arriverait sans être porté (une flaque de feu) est compté (`Stats.unported`).

use super::catalog::catalog;
use super::collisions::{capture_motions, resolve_collisions};
use super::debris::{Debris, expire_debris};
use super::drive::think;
use super::fire::update_fires;
use super::lifecycle::{expire_wheel_wrecks, spawn_bot};
use super::physics::{BodyDesc, ColliderDesc, Physics, ShapeDesc, groups};
use super::props::{Prop, add_prop, update_props};
use super::rng::Rng;
use super::robot::{Bot, Part};
use super::vec::{NO_ROTATION, Q, V3, v3};
use super::wheels::{place_wheels, step_wheels};
use rapier3d::prelude::ColliderHandle;
use std::collections::HashMap;

/// Pas fixe de la physique (s) et itérations du solveur (src/shared/config.ts).
pub const STEP: f64 = 1.0 / 60.0;
pub const SOLVER_ITERATIONS: usize = 4;
/// Le sol (src/shared/arena/arena.ts, layout.ts).
const GROUND_HALF: f64 = 220.0;
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
    /// Ce qui serait arrivé sans être porté (une flaque de feu laissée par une explosion).
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
}

pub struct Sim {
    pub phys: Physics,
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
            bots: Vec::new(),
            parts: Vec::new(),
            order: Vec::new(),
            owners: HashMap::new(),
            debris: Vec::new(),
            props: Vec::new(),
            fires: Vec::new(),
            prop_fires: Vec::new(),
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

    /// Une boîte du décor fixe (`buildScenery`) ; `round` : un cylindre debout inscrit dans la boîte.
    pub fn add_box(&mut self, pos: V3, half: V3, rot: Q, round: bool) {
        let rb = self.phys.create_body(&BodyDesc::fixed(pos, rot));
        let shape = if round { ShapeDesc::Cylinder(half.y, half.x) } else { ShapeDesc::Cuboid(half.x, half.y, half.z) };
        let desc = ColliderDesc { friction: STATIC_FRICTION, collision_groups: groups::STATIC_GROUP, ..ColliderDesc::new(shape) };
        self.phys.create_collider(&desc, rb);
    }

    /// Un robot préfabriqué, aux commandes d'un pilote (`spawnBot`, `takeControl`) ; son numéro.
    pub fn spawn(&mut self, id: &str, pos: V3, yaw: f64) -> Result<usize, String> {
        spawn_bot(self, id, pos, yaw)
    }

    /// L'accessoire de l'emplacement suivant de l'arène (`createProp`, appelé par `resetProps` dans
    /// l'ordre des emplacements) : son type, sa pose, ses dimensions (une dalle), son échelle (un
    /// cylindre) ; son numéro (celui de l'emplacement).
    pub fn add_prop(&mut self, kind: &str, pos: V3, rot: Option<Q>, half: Option<V3>, scale: Option<f64>) -> Result<usize, String> {
        add_prop(self, kind, pos, rot, half, scale)
    }

    /// Un pas fixe.
    pub fn step(&mut self) {
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
