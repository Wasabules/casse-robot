//! Les entités d'un robot (src/shared/sim/entities.ts) : ses blocs, ses morceaux (un corps chacun),
//! ses roues, ses tourelles, ses liaisons coupées ; et ce que l'on calcule d'après son plan
//! (`wheelLocalPos`, `groundHeight`, ce que la simulation portée ne sait pas encore faire marcher).
//!
//! Un robot naît d'un seul morceau (lifecycle.rs, `spawnBot`) ; les chocs (collisions.rs) et les
//! dégâts (damage.rs) le découpent : blocs détruits, liaisons faibles rompues (structure.rs), morceaux
//! séparés, roues arrachées ; ses modules de réparation le remettent en état (repair.rs). Les
//! morceaux vivent dans le monde (world.rs : `Sim.parts`), le robot garde leurs numéros dans l'ordre
//! où ils sont nés (`bot.parts`, un `Set` du TypeScript). Un robot est conduit par un pilote (ses
//! commandes : `Input`) ou par l'IA (brain.rs : son état, `AiState`).

use super::brain::AiState;
use super::catalog::{BlockShape, Catalog, Design, Mobility, Robot, WheelDef, WheelMount, catalog};
use super::shapes::shape_pieces;
use super::vec::{Q, V3, v3};
use super::wheels::WheelPose;
use crate::det::{dcos, dsin};
use rapier3d::prelude::{ColliderHandle, RigidBodyHandle};
use std::collections::{HashMap, HashSet};

/// Constantes de src/shared/config.ts que le catalogue ne donne pas.
pub const BLOCK_FRICTION: f64 = 0.45;
pub const BLOCK_RESTITUTION: f64 = 0.02;
pub const WHEEL_GAP: f64 = 0.06;
/// Seuil des événements de force de contact (src/shared/combat/collisions.ts).
pub const CONTACT_FORCE_THRESHOLD: f64 = 1500.0;
/// Capacité de la batterie du cockpit (kJ).
pub const COCKPIT_BATTERY: f64 = 20.0;
/// Amortissement angulaire d'une roue arrachée (`WHEEL_ANGULAR_DAMPING`).
pub const WHEEL_ANGULAR_DAMPING: f64 = 0.05;

/// Les six voisins d'une case (`NEIGHBORS`, src/shared/design/robotDesign.ts), dans cet ordre.
pub const NEIGHBORS: [(i64, i64, i64); 6] = [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)];

/// Amortissement d'un morceau selon la mobilité (`PART_DAMPING`) : linéaire, angulaire.
pub fn part_damping(m: Mobility) -> (f64, f64) {
    match m {
        Mobility::Ground => (0.05, 0.15),
        Mobility::Hover => (0.3, 0.3),
        Mobility::Plane => (0.01, 0.05),
    }
}

pub type Cell = (i64, i64, i64);

/// Clé d'une liaison entre deux blocs voisins, indépendante de l'ordre (`linkKey`).
pub type LinkKey = (Cell, Cell);

pub fn link_key(a: Cell, b: Cell) -> LinkKey {
    if a < b { (a, b) } else { (b, a) }
}

pub struct Block {
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub local: V3,
    pub up: V3,
    pub forward: V3,
    pub rot: Q,
    pub hp: f64,
    pub alive: bool,
    /// Le morceau qui le porte (un numéro de `Sim.parts`) ; détruit, il garde le dernier.
    pub part: usize,
    /// Feu : secondes qu'il brûlera encore s'il n'est pas ravivé (0 : il ne brûle pas ; fire.rs).
    pub burn: f64,
}

impl Block {
    pub fn cell(&self) -> Cell {
        (self.x as i64, self.y as i64, self.z as i64)
    }
}

/// Une tourelle : son bloc, son lacet et son site (pilotées sans visée, elles ne tournent pas).
pub struct Turret {
    pub block: usize,
    pub yaw: f64,
    pub pitch: f64,
}

/// Une liaison faible (`WeakLink`, robot/structure.ts) : un pont du graphe des blocs d'un morceau.
#[derive(Clone)]
pub struct WeakLink {
    pub key: LinkKey,
    pub inner: usize,
    pub outer: usize,
    /// Les blocs du côté détachable.
    pub beyond: HashSet<usize>,
    pub mass: f64,
    pub com: V3,
    pub joint: V3,
    pub strength: f64,
}

/// Un morceau d'un robot : son corps, ses blocs (dans l'ordre où ils y sont entrés), ses colliders
/// (blocs fusionnés et zones touchables des têtes ; pas ceux des roues, que garde chaque roue).
pub struct Part {
    pub bot: usize,
    pub rb: RigidBodyHandle,
    pub blocks: Vec<usize>,
    pub colliders: Vec<ColliderHandle>,
    /// Ses colliders sont à refaire (des blocs y sont entrés ou en sont sortis).
    pub dirty: bool,
    /// Ses liaisons faibles, gardées jusqu'au prochain changement de ses blocs.
    pub links: Option<Vec<WeakLink>>,
}

impl Part {
    pub fn has(&self, block: usize) -> bool {
        self.blocks.contains(&block)
    }
}

/// Une roue (`Wheel`, src/shared/sim/entities.ts) : montée sur un morceau (son état, ses poses
/// calculées), ou arrachée (un corps à elle), ou retirée (une pose figée).
pub struct Wheel {
    pub def: WheelDef,
    pub steerable: bool,
    /// 1 à gauche (x local > 0), -1 à droite, 0 au centre.
    pub side: f64,
    pub local: V3,
    /// La case de son bloc support (`mountKey`).
    pub mount: Cell,
    pub collider: ColliderHandle,
    /// Le morceau qui la porte ; aucun : arrachée.
    pub part: Option<usize>,
    /// Son corps, une fois arrachée ; aucun après son retrait.
    pub body: Option<RigidBodyHandle>,
    /// Retirée : `rb` est une pose figée.
    pub frozen: bool,
    pub hp: f64,
    pub released_at: f64,
    pub steer: f64,
    pub drive: f64,
    pub powered: bool,
    pub engaged: bool,
    pub overrun: bool,
    pub brake: f64,
    pub travel: f64,
    pub spin: f64,
    pub spin_rate: f64,
    pub load: f64,
    pub rb: WheelPose,
    /// Son porte-moyeu (rien une fois arrachée).
    pub hub: Option<WheelPose>,
}

/// Les commandes du pilote (`PlayerInput` : ce qui sert à un robot au sol).
#[derive(Clone, Copy, Default)]
pub struct Input {
    pub throttle: f64,
    pub steer: f64,
    pub brake: f64,
    pub boost: bool,
}

pub struct Bot {
    pub speed: f64,
    pub turn: f64,
    pub mobility: Mobility,
    /// Tous ses blocs, dans l'ordre du plan (vivants ou non).
    pub blocks: Vec<Block>,
    /// Ses blocs vivants, par case (`bot.blocks` du TypeScript).
    pub cells: HashMap<Cell, usize>,
    /// Ses blocs vivants dans l'ordre où les parcourt le TypeScript (celui de la `Map` `bot.blocks` :
    /// l'ordre du plan, un bloc qui repousse passant au bout).
    pub live: Vec<usize>,
    pub cockpit: usize,
    /// Ses morceaux, dans l'ordre où ils sont nés (numéros de `Sim.parts`).
    pub parts: Vec<usize>,
    pub wheels: Vec<Wheel>,
    pub turrets: Vec<Turret>,
    /// Ses générateurs de bouclier (`bot.shields`).
    pub shields: Vec<usize>,
    /// Ses liaisons rompues (`bot.cuts`).
    pub cuts: HashSet<LinkKey>,
    /// Nombre de blocs du plan (`bot.total`).
    pub total: usize,
    pub input: Input,
    /// Énergie des batteries (kJ), et ce que les moteurs en tirent pendant le pas (kW).
    pub energy: f64,
    pub drawn: f64,
    /// Redressement (src/shared/robot/righting.ts).
    pub flipped_for: f64,
    pub righting: f64,
    /// Quand il a été touché pour la dernière fois (`lastHit` ; -∞ : jamais) : ses modules de
    /// réparation attendent un moment sans coup.
    pub last_hit: f64,
    /// Pas de bloc repoussé avant ce moment (`rebuildAt`, combat/repair.ts).
    pub rebuild_at: f64,
    /// Son équipe (`team` : 0 les rouges, 1 les bleus).
    pub team: usize,
    /// Rayon de son plan, autour de son origine, dans le plan horizontal (`radius` : `designRadius`).
    pub radius: f64,
    /// Heurté, il fonce sur qui l'a heurté au lieu de fuir (`profile.behavior` « charge »).
    pub charges: bool,
    /// Centre de masse du morceau de son cockpit au dernier pas où il était vivant (`lastPos`) ; sa
    /// position de départ avant le premier pas.
    pub last_pos: V3,
    /// Aux commandes d'un pilote (`controller` « player ») ; sinon, l'IA le conduit.
    pub piloted: bool,
    /// L'état de son IA (même piloté : un choc le change, `onHit`, sans que rien ne le lise).
    pub ai: AiState,
}

impl Bot {
    pub fn cockpit_alive(&self) -> bool {
        self.blocks[self.cockpit].alive
    }

    /// Le bloc `k` est-il perdu (`bot.lost`) : détruit, et pas le cockpit (il ne repousse pas) ?
    pub fn lost(&self, k: usize) -> bool {
        !self.blocks[k].alive && k != self.cockpit
    }

    /// Le morceau du cockpit.
    pub fn cockpit_part(&self) -> usize {
        self.blocks[self.cockpit].part
    }
}

/// Position du centre d'une roue au repos, dans le repère du robot (`wheelLocalPos`).
pub fn wheel_local_pos(m: &WheelMount, def: &WheelDef, block_size: f64) -> V3 {
    let along = m.shift.unwrap_or(0.0) * (block_size / 2.0);
    // (`if (m.dy)` : un nombre non nul)
    if m.dy.is_some_and(|d| d != 0.0 && !d.is_nan()) {
        return v3(m.x * block_size, m.y * block_size - (block_size / 2.0 + WHEEL_GAP + def.radius), m.z * block_size + along);
    }
    let lateral = block_size / 2.0 + WHEEL_GAP + def.width / 2.0 + steer_clearance(def) + m.layer.unwrap_or(0.0) * def.width;
    v3(
        m.x * block_size + m.dx * lateral + (if m.dz != 0.0 { along } else { 0.0 }),
        m.y * block_size - def.drop.unwrap_or(0.0) + m.rise.unwrap_or(0.0) * block_size,
        m.z * block_size + m.dz * (block_size / 2.0 + WHEEL_GAP + def.radius) + (if m.dx != 0.0 { along } else { 0.0 }),
    )
}

/// Place à laisser entre une roue qui pivote et son bloc (`steerClearance`, catalog/wheels.ts).
pub fn steer_clearance(def: &WheelDef) -> f64 {
    let angle = if def.caster.is_some() { std::f64::consts::PI / 2.0 } else { def.steering.map_or(0.0, |s| s.0) };
    def.radius * dsin(angle) + (def.width / 2.0) * (dcos(angle) - 1.0)
}

/// Rayon d'un plan autour de son origine, dans le plan horizontal (`designRadius`, robot/lifecycle.ts) :
/// ses blocs et ses roues (un anneau-coque, qui l'agrandirait, est une arme de contact : refusé).
pub fn design_radius(design: &Design) -> f64 {
    let c = catalog();
    let bs = c.constants.block_size;
    let mut r: f64 = 0.0;
    for b in &design.blocks {
        r = crate::jsmath::max(r, crate::jsmath::hypot2(b.x, b.z) * bs + bs * 0.71);
    }
    for m in &design.wheels {
        let def = &c.wheels[&m.kind];
        let p = wheel_local_pos(m, def, bs);
        r = crate::jsmath::max(r, crate::jsmath::hypot2(p.x, p.z) + def.radius);
    }
    r
}

/// Hauteur de l'origine d'un robot posé au sol (`groundHeight`).
pub fn ground_height(design: &Design) -> f64 {
    let c = catalog();
    let bs = c.constants.block_size;
    if !design.wheels.is_empty() {
        let mut best = f64::NEG_INFINITY;
        for m in &design.wheels {
            let def = &c.wheels[&m.kind];
            best = crate::jsmath::max(best, def.radius - wheel_local_pos(m, def, bs).y);
        }
        return best;
    }
    let mut low = f64::INFINITY;
    for b in &design.blocks {
        low = crate::jsmath::min(low, b.y);
    }
    bs / 2.0 - low * bs
}

/// Ce que la simulation portée ne sait pas encore faire marcher.
pub fn unsupported(c: &Catalog, robot: &Robot) -> Option<String> {
    if robot.mobility != Mobility::Ground {
        return Some("un robot volant".into());
    }
    for b in &robot.design.blocks {
        let def = c.blocks.get(&b.kind)?;
        if let BlockShape::Shaped(s) = &def.shape
            && shape_pieces(s).is_none()
        {
            return Some(format!("une forme inconnue ({s})"));
        }
        if def.melee || def.thruster || def.support || def.aero {
            return Some(format!("le bloc {}", b.kind));
        }
    }
    None
}
