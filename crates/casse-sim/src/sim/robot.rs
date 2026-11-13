//! Les entités d'un robot (src/shared/sim/entities.ts) : ses blocs, ses morceaux (un corps chacun),
//! ses roues, ses tourelles, ses liaisons coupées ; et ce que l'on calcule d'après son plan
//! (`wheelLocalPos`, `groundHeight`, ce que la simulation portée ne sait pas encore faire marcher).
//!
//! Un robot naît d'un seul morceau (lifecycle.rs, `spawnBot`) ; les chocs (collisions.rs) et les
//! dégâts (damage.rs) le découpent : blocs détruits, liaisons faibles rompues (structure.rs), morceaux
//! séparés, roues arrachées ; ses modules de réparation le remettent en état (repair.rs). Les
//! morceaux vivent dans le monde (world.rs : `Sim.parts`), le robot garde leurs numéros dans l'ordre
//! où ils sont nés (`bot.parts`, un `Set` du TypeScript). Un robot est conduit par un pilote (ses
//! commandes : `Input`) ou par l'IA (brain.rs : son état, `AiState`). Ses organes : ses moteurs
//! (`Thruster`, propulsion.rs), ses appuis sans roue (`Support`, supports.rs), ses ailes et ses
//! gouvernes (`Surface`, aero.rs), ses armes de contact (`MeleeArm`, melee.rs, mechanics.rs).

use super::brain::AiState;
use super::melee::MeleeArm;
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
    /// Son numéro d'entité (`id`, `sim.nextId()`) : le jet de son moteur s'y règle (scorch.rs).
    pub id: u64,
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
    /// L'organe qu'il porte est coupé jusqu'à ce moment (paralysie locale, emp.rs).
    pub stunned_until: f64,
}

impl Block {
    pub fn cell(&self) -> Cell {
        (self.x as i64, self.y as i64, self.z as i64)
    }
}

/// État d'une arme (`ArmState`, combat/arsenal.ts) : temps avant le prochain tir possible (s),
/// chaleur (0 à 1) et surchauffe, coups dans le chargeur (∞ : pas de chargeur) et temps passé à
/// recharger le suivant (s).
#[derive(Clone, Copy, Debug)]
pub struct ArmState {
    pub cooldown: f64,
    pub heat: f64,
    pub overheated: bool,
    pub ammo: f64,
    pub restock: f64,
}

/// Une tourelle (`Turret`) : son bloc, son arme, le lacet et le site de sa tête, l'état de son
/// arme ; le robot qu'elle vise et le temps avant d'en changer (s), le point qu'elle vise, l'erreur
/// de visée de l'IA (une direction de la boule unité), l'heure de son dernier tir ; une arme à
/// verrouillage : l'ennemi en cours de verrouillage, depuis combien de temps (s), et depuis combien de
/// temps le décor le cache (s) (combat/lock.ts).
pub struct Turret {
    pub block: usize,
    pub weapon: &'static str,
    pub yaw: f64,
    pub pitch: f64,
    pub arm: ArmState,
    pub target: Option<usize>,
    pub retarget: f64,
    pub aim: Option<V3>,
    pub wobble: V3,
    pub fired_at: f64,
    pub lock_on: Option<usize>,
    pub lock_time: f64,
    pub lock_hidden: f64,
    /// Une tourelle de soin (gunner.rs, `operateSupport`) : le bloc de son patient qu'elle vise (robot,
    /// bloc ; `repairAims`, un `WeakMap` du TypeScript) et l'instant de son prochain choix de patient
    /// (`patientAt` ; -∞ : jamais encore).
    pub repair_aim: Option<(usize, usize)>,
    pub patient_at: f64,
}

/// Les salves de ses lance-leurres (`Bot.flares`) : celles qui restent, le temps passé à en regagner
/// une (s), et l'instant avant lequel il n'en lance pas d'autre.
#[derive(Clone, Copy, Debug, Default)]
pub struct Flares {
    pub charges: f64,
    pub restock: f64,
    pub ready_at: f64,
}

/// La zone touchable d'une tête de tourelle (`TurretHitbox`) : la tourelle (son rang dans
/// `bot.turrets`), le pavé de la tête et la capsule du canon, et le lacet et le site auxquels ils
/// ont été posés.
pub struct Head {
    pub turret: usize,
    pub head: Option<ColliderHandle>,
    pub barrel: Option<ColliderHandle>,
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
    /// Son numéro d'entité (`id`, `sim.nextId()`).
    pub id: u64,
    pub bot: usize,
    pub rb: RigidBodyHandle,
    pub blocks: Vec<usize>,
    pub colliders: Vec<ColliderHandle>,
    /// Ses colliders sont à refaire (des blocs y sont entrés ou en sont sortis).
    pub dirty: bool,
    /// Ses liaisons faibles, gardées jusqu'au prochain changement de ses blocs.
    pub links: Option<Vec<WeakLink>>,
    /// Les zones touchables des têtes de ses tourelles (`part.heads`) et des lames de ses armes de
    /// contact (`part.blades`).
    pub heads: Vec<Head>,
    pub blades: Vec<Blade>,
}

/// Ce que suit la zone touchable d'une arme de contact (`MeleeHitbox.moves`) : l'angle d'un rotor à
/// bras, l'angle d'un bras ; rien (un rotor plein, un anneau : elle ne bouge pas).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Moves {
    Still,
    Rotor,
    Swing,
}

/// La zone touchable de la lame ou de la tête d'une arme de contact (`MeleeHitbox`) : son arme (son
/// rang dans `bot.melee`), ses colliders (un pavé par bras d'un rotor, des pavés tout autour d'un
/// anneau, le cylindre d'un rotor plein, la boule de la tête d'un bras), ce qu'elle suit, et l'angle du
/// rotor et du bras auxquels elle a été posée.
pub struct Blade {
    pub arm: usize,
    pub colliders: Vec<ColliderHandle>,
    pub moves: Moves,
    pub angle: f64,
    pub swing: f64,
}

impl Part {
    pub fn has(&self, block: usize) -> bool {
        self.blocks.contains(&block)
    }
}

/// Une roue (`Wheel`, src/shared/sim/entities.ts) : montée sur un morceau (son état, ses poses
/// calculées), ou arrachée (un corps à elle), ou retirée (une pose figée).
pub struct Wheel {
    /// Son numéro d'entité (`id`, `sim.nextId()`).
    pub id: u64,
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
    /// Son moteur et sa direction coupés jusqu'à ce moment (paralysie locale, emp.rs).
    pub stunned_until: f64,
}

/// Le rôle d'un moteur (`Thruster.role`) : sustentation (il pousse vers le haut du robot), propulsion
/// (vers l'avant), ou autre orientation (rotor de queue, réacteur de côté).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Lift,
    Cruise,
    Trim,
}

/// Un moteur (`Thruster`, sim/entities.ts) : son bloc, son rôle, le sens de rotation de son hélice
/// (1 ou -1), sa poussée le long de l'axe de son bloc et l'inclinaison d'un rotor orientable (N), la
/// part de sa pleine poussée qu'il peut donner (1 intact, moins abîmé, 0 pendant un raté) et la fin
/// de son raté en cours (propulsion.rs).
#[derive(Clone, Copy, Debug)]
pub struct Thruster {
    pub block: usize,
    pub role: Role,
    pub spin: f64,
    pub thrust: f64,
    pub tilt_a: f64,
    pub tilt_b: f64,
    pub output: f64,
    pub misfire_until: f64,
}

/// Un appui sans roue (`Support`) : patin anti-gravité ou patte ; son bloc, la distance au sol sous
/// lui (∞ : pas de sol à portée), sa force d'appui, la phase de sa marche (supports.rs).
#[derive(Clone, Copy, Debug)]
pub struct Support {
    pub block: usize,
    pub contact: f64,
    pub force: f64,
    pub phase: f64,
}

/// Une surface portante (`AeroSurface`) : aile ou gouverne, son bloc et son braquage (aero.rs).
#[derive(Clone, Copy, Debug)]
pub struct Surface {
    pub block: usize,
    pub deflection: f64,
}

/// Les commandes du pilote (`PlayerInput`) : avancer et tourner (> 0 : à gauche ; un robot volant se
/// déplace ainsi par rapport à sa caméra), frein (0 à 1), boost, faire sauter ses mines télécommandées
/// (mines.rs) ; et en vol : monter ou descendre (en avion, cabrer ou piquer), lacet (> 0 : à gauche),
/// cap de la caméra (rad), conduite à la caméra (`relative`), pilotage manuel d'un avion (`manual`),
/// ses gaz (`power`, 0 à 1), la direction du regard (`look`, unitaire ; rien : au clavier) ; la
/// gâchette, le point visé (rien : ses tourelles ne visent pas), le viseur, les leurres (touche tenue)
/// et l'arme choisie (rien : toutes ; une arme de contact tourne tant qu'elle est choisie).
#[derive(Clone, Copy)]
pub struct Input {
    pub trigger: bool,
    pub aim: Option<V3>,
    pub scope: bool,
    pub flares: bool,
    pub weapon: Option<&'static str>,
    pub throttle: f64,
    pub steer: f64,
    pub brake: f64,
    pub boost: bool,
    pub detonate: bool,
    pub climb: f64,
    pub yaw: f64,
    pub heading: f64,
    pub relative: bool,
    pub manual: bool,
    pub power: f64,
    pub look: Option<V3>,
}

/// Le profil d'un robot qui n'en a pas (un robot du catalogue fait apparaître par les essais).
pub const NO_PROFILE: usize = usize::MAX;

/// Gaz d'un avion tant que le pilote n'y a pas touché (`CRUISE_POWER`).
pub const CRUISE_POWER: f64 = 0.4;

impl Default for Input {
    /// `newInput()`.
    fn default() -> Self {
        Input {
            trigger: false,
            aim: None,
            scope: false,
            flares: false,
            weapon: None,
            throttle: 0.0,
            steer: 0.0,
            brake: 0.0,
            boost: false,
            detonate: false,
            climb: 0.0,
            yaw: 0.0,
            heading: 0.0,
            relative: false,
            manual: false,
            power: CRUISE_POWER,
            look: None,
        }
    }
}

pub struct Bot {
    /// Son numéro d'entité (`id`, `sim.nextId()`) ; le profil dont il est né (un rang de
    /// `Sim.profiles`, que la session donne ; `NO_PROFILE` : un robot du catalogue fait apparaître par
    /// les essais), d'où naît le même robot quand il réapparaît.
    pub id: u64,
    pub profile: usize,
    /// Ses commandes viennent d'un pilote dont la session tient la place (`bot.input`, un objet que se
    /// passent les robots successifs d'un même joueur : un rang de `Sim.inputs`), recopiées dans `input`
    /// au début de chaque pas ; rien : `input` est donné directement (les essais).
    pub input_slot: Option<usize>,
    /// Ses liaisons rompues dans l'ordre où elles l'ont été (`bot.cuts`, un `Set` du TypeScript : la
    /// description d'un robot les donne dans cet ordre).
    pub cut_order: Vec<LinkKey>,
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
    /// Ses moteurs (`addThrusters` : les rotors de sustentation d'abord, en sens alternés), ses appuis
    /// et ses surfaces portantes (dans l'ordre du plan).
    pub thrusters: Vec<Thruster>,
    pub supports: Vec<Support>,
    pub surfaces: Vec<Surface>,
    /// Ses armes de contact (dans l'ordre du plan ; melee.rs).
    pub melee: Vec<MeleeArm>,
    pub turrets: Vec<Turret>,
    /// Le prochain tir de chacune de ses armes (`nextShot` : des armes identiques tirent à tour de
    /// rôle, sur un rythme commun ; combat/turrets.ts, `fireInTurn`).
    pub next_shot: Vec<(&'static str, f64)>,
    /// Hauteur de son bloc le plus haut au-dessus de son origine (`top`, m).
    pub top: f64,
    /// Le dernier ennemi qui l'a touché (`lastAttacker` : crédité de sa destruction).
    pub last_attacker: Option<usize>,
    /// Vulnérabilité moyenne des blocs du morceau de son cockpit, par nature de dégâts, et leur
    /// nombre quand elle a été calculée (`vulnerabilities`, ai/gunner.ts : recalculée quand il change).
    pub vulnerability: Option<(usize, Vec<(String, f64)>)>,
    /// Ses lance-leurres (`flareLaunchers`, dans l'ordre du plan) et leurs salves.
    pub flare_launchers: Vec<usize>,
    pub flares: Flares,
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
    /// Ses blocs perdus dans l'ordre où ils l'ont été (celui de la `Map` `bot.lost` du TypeScript :
    /// `repairNeed` les additionne dans cet ordre).
    pub lost_order: Vec<usize>,
    /// Paralysé par une impulsion électromagnétique jusqu'à ce moment (`stunnedUntil`, emp.rs).
    pub stunned_until: f64,
    /// Soulevé par un flipper (`thrownBy` : le robot qui l'a lancé, son arme, jusqu'à quand) : les
    /// dégâts de ses chocs en retombant sont crédités au flipper (collisions.rs, mechanics.rs).
    pub thrown_by: Option<(usize, &'static str, f64)>,
    /// La gâchette du pilote tenue au pas précédent (`triggerHeld` : un nouveau clic fait exploser son ogive).
    pub trigger_held: bool,
    /// Son équipe (`team` : 0 les rouges, 1 les bleus).
    pub team: usize,
    /// Rayon de son plan, autour de son origine, dans le plan horizontal (`radius` : `designRadius`).
    pub radius: f64,
    /// Demi-largeur de ce qui le porte (`halfWidth`, ai/navigation.ts : le bord extérieur de ses roues,
    /// de ses chenilles, de ses appuis ; sans rien de cela, la moitié de son rayon).
    pub half_width: f64,
    /// Ce que la navigation garde de lui d'un pas à l'autre (navigation.rs).
    pub nav: super::navigation::NavMemory,
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
/// ses blocs et ses roues, et l'anneau d'un anneau-coque (il fait le tour du robot).
pub fn design_radius(design: &Design) -> f64 {
    use super::vec::{add, cross, scale};
    let c = catalog();
    let bs = c.constants.block_size;
    let mut r: f64 = 0.0;
    for b in &design.blocks {
        r = crate::jsmath::max(r, crate::jsmath::hypot2(b.x, b.z) * bs + bs * 0.71);
        let spec = c.blocks.get(&b.kind).and_then(|d| d.melee.as_ref()).and_then(|m| c.melee.get(m));
        if let Some(spec) = spec
            && let Some(blade) = spec.blade
            && blade.inner >= super::melee::ALL_AROUND
        {
            let [hx, hy, hz] = spec.hub;
            let (Some(up), Some(forward)) = (super::catalog::axis(&b.up), super::catalog::axis(&b.forward)) else { continue };
            let up = v3(up[0], up[1], up[2]);
            let forward = v3(forward[0], forward[1], forward[2]);
            let hub = add(v3(b.x * bs, b.y * bs, b.z * bs), add(scale(cross(up, forward), hx), add(scale(up, hy), scale(forward, hz))));
            r = crate::jsmath::max(r, crate::jsmath::hypot2(hub.x, hub.z) + blade.outer);
        }
    }
    for m in &design.wheels {
        let def = &c.wheels[&m.kind];
        let p = wheel_local_pos(m, def, bs);
        r = crate::jsmath::max(r, crate::jsmath::hypot2(p.x, p.z) + def.radius);
    }
    r
}

/// Demi-largeur de ce qui porte un robot (m : `halfWidth`, ai/navigation.ts) : le bord extérieur de ses
/// roues, de ses chenilles, de ses appuis ; sans rien de cela, la moitié de son rayon (`radius`).
pub fn half_width(design: &Design, radius: f64) -> f64 {
    let c = catalog();
    let bs = c.constants.block_size;
    let mut w: f64 = 0.0;
    for m in &design.wheels {
        let def = &c.wheels[&m.kind];
        w = crate::jsmath::max(w, wheel_local_pos(m, def, bs).x.abs() + def.width / 2.0);
    }
    for b in &design.blocks {
        if c.blocks[&b.kind].support.is_some() {
            w = crate::jsmath::max(w, (b.x.abs() + 0.5) * bs);
        }
    }
    if w == 0.0 { radius * 0.5 } else { w }
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

/// Les armes dont l'IA sait se servir au combat dans la simulation portée : celles à tir direct (le
/// lance-flammes et ses flaques compris), les missiles guidés (téléguidés, roquettes en salve, à
/// verrouillage, l'ogive), qu'on peut abattre en vol et que les leurres détournent, le canon IEM qui
/// paralyse, le fumigène, les mines (qui éclatent sous un ennemi, la mine incendiaire, IEM, fumigène,
/// qui bondit, qui se colle, télécommandée, le capteur ; et la mine anti-aérienne de l'Éclaireur, qui
/// lance son missile sur les robots en vol), le rayon réparateur et les nanites, le projecteur de
/// bouclier, les bombes et la flak (sa fusée de proximité éclate près d'un robot en vol).
pub const PORTED_WEAPONS: [&str; 28] = [
    "rifle", "cannon", "sniper", "laser", "rail", "shotgun", "plasma", "missile", "rockets", "lockon", "warhead", "flamer", "mine", "sensorMine", "aaMine",
    "emp", "smoke", "empMine", "fireMine", "smokeMine", "bounceMine", "remoteMine", "stickyMine", "repair", "nanites", "barrier", "flak", "bombs",
];

/// L'arme d'une tourelle de ce robot dont l'IA ne sait pas encore se servir au combat, s'il en a une.
pub fn unported_weapon(c: &Catalog, robot: &Robot) -> Option<String> {
    for b in &robot.design.blocks {
        let Some(t) = c.blocks.get(&b.kind).and_then(|d| d.turret.as_ref()) else { continue };
        if !PORTED_WEAPONS.contains(&t.weapon.as_str()) {
            return Some(format!("l'arme {} au combat", t.weapon));
        }
    }
    None
}

/// Ce que la simulation portée ne sait pas encore faire marcher.
pub fn unsupported(c: &Catalog, robot: &Robot) -> Option<String> {
    for b in &robot.design.blocks {
        let def = c.blocks.get(&b.kind)?;
        if let BlockShape::Shaped(s) = &def.shape
            && shape_pieces(s).is_none()
        {
            return Some(format!("une forme inconnue ({s})"));
        }
        // (les mouvements d'arme de contact portés : melee.rs)
        if let Some(m) = &def.melee
            && c.melee.get(m).is_none_or(|spec| !super::melee::PORTED_MOTIONS.contains(&spec.motion.as_str()))
        {
            return Some(format!("le bloc {}", b.kind));
        }
    }
    None
}
