//! Le monde de la simulation portée (`Simulation`, src/shared/sim/simulation.ts) : Rapier à pas
//! fixe, le sol commun à toutes les arènes (`buildGround`, src/shared/arena/arena.ts), le décor fixe
//! d'une arène (`buildScenery`, `clearScenery` : des boîtes, données par l'appelant, avec leur sorte,
//! dont la navigation se sert ; les rochers en enveloppe convexe ; le relief, un champ de hauteurs),
//! ses dimensions (`ArenaBounds` : son bord, la zone où rôde l'IA), le niveau de son eau, le reste de
//! l'arène (arena.rs : eau profonde, lave, grille et réseau de passage, ville, planchers de vol), ses
//! accessoires (`resetProps` : leurs emplacements, donnés par l'appelant), les robots, pilotés ou
//! conduits par l'IA, leurs morceaux, les projectiles, les débris, les feux et les flaques de feu, les
//! nuages de fumée, les murs d'énergie, ce que chaque équipe a repéré, et le hasard (`Math.random` à
//! graine fixe).
//!
//! Le pas fait ce que fait celui du TypeScript pour des robots au sol, volants ou avions, pilotés ou
//! conduits par l'IA, au combat ou non (`sim.combat` : hors combat, comme au stand de tir, l'IA
//! patrouille, contourne le décor, se dégage, fuit ou fonce sur qui la heurte, mais ses tourelles ne
//! visent ni ne tirent) : la détection (`updateDetection`), leurs commandes (`thinkBot` : celles du
//! pilote, ou la conduite, le vol, la tactique, les leurres et les tourelles de l'IA ; l'usure des
//! moteurs ; rien d'un robot paralysé), les zones touchables des têtes de tourelle et des pales
//! (`syncHeads`), l'air (`applyAerodynamics` : ailes et gouvernes ; les rafales sur les robots en vol),
//! leurs roues (`stepWheels`), le mouvement des corps avant la physique (`captureMotions`), la physique
//! (`world.step`), la pose des roues (`placeWheels`), les chocs et leurs dégâts (`resolveCollisions` :
//! blocs détruits, liaisons rompues, morceaux séparés, roues arrachées, accessoires qui cèdent,
//! percées), le contact (`updateMelee` : les armes de contact), les projectiles (`stepProjectiles` :
//! tirs, missiles, bombes, flak, mines, impulsions électromagnétiques, fumigènes, tirs réparateurs,
//! murs d'énergie), les jets de flamme des moteurs (`updateScorch`), les feux et les flaques de feu
//! (`updateFires`), les dangers du terrain (`updateHazards` : la lave, l'eau profonde), les nuages de
//! fumée (`updateSmokes`), les murs d'énergie (`updateBarriers`), les modules de réparation
//! (`updateRepairs` : blocs et roues réparés, blocs qui repoussent), les lance-leurres (`updateFlares`),
//! les accessoires qui ont cédé (`updateProps` : mèches, fuites de gaz, explosions en chaîne, éclats),
//! la fin de vie des débris et des épaves de roues. Le reste du pas du TypeScript (la partie : scores,
//! zones, réapparitions) ne touche pas à de tels robots hors d'une partie : tests/nativeSim.test.ts le
//! vérifie par ses événements. Ce qui arriverait sans être porté serait compté (`Stats.unported`).

use super::aero::apply_aerodynamics;
use super::air::buffet;
use super::barriers::{Barrier, update_barriers};
use super::catalog::{Mobility, catalog};
use super::collisions::{Motion, capture_motions, resolve_collisions};
use super::debris::{Debris, expire_debris};
use super::decoys::update_flares;
use super::detection::update_detection;
use super::drive::think;
use super::fire::{GroundFire, update_fires};
use super::lifecycle::{expire_wheel_wrecks, spawn_bot};
use super::melee::update_melee;
use super::physics::{BodyDesc, ColliderDesc, ContactForce, Physics, ShapeDesc, groups};
use super::projectiles::{Projectile, step_projectiles};
use super::props::{Prop, add_prop, update_props};
use super::repair::update_repairs;
use super::rng::Rng;
use super::robot::{Bot, Part};
use super::scorch::update_scorch;
use super::smoke::{SmokeCloud, update_smokes};
use super::vec::{NO_ROTATION, Q, V3, v3};
use super::arena::{Arena, rock_shape, survey_decks};
use super::hazards::update_hazards;
use super::navigation::{Obstacle, TallRamp, tall_ramps};
use super::turrets::sync_heads;
use super::wheels::{place_wheels, step_wheels};
use super::game::{read_inputs, update_match};
use crate::terrain::Terrain;
use rapier3d::prelude::{ColliderHandle, RigidBodyHandle};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

/// Pas fixe de la physique (s) et itérations du solveur (src/shared/config.ts).
pub const STEP: f64 = 1.0 / 60.0;
pub const SOLVER_ITERATIONS: usize = 4;
/// Le sol (src/shared/arena/arena.ts, layout.ts).
const GROUND_HALF: f64 = 220.0;
/// Les dimensions des petites arènes (`SMALL`, arena/sources.ts) : celles d'un monde neuf, le Dépôt.
const SMALL_HALF: f64 = 36.0;
const SMALL_ROAM: f64 = 29.0;
const SMALL_CIRCUIT: f64 = 35.0;
const SMALL_SPAWN_LINE: f64 = 29.0;
const SMALL_SPAWN_SPREAD: f64 = 24.0;
const GROUND_FRICTION: f64 = 0.9;
const STATIC_FRICTION: f64 = 0.8;

/// Ce que représente un collider (`ColliderOwner`) : un morceau, une roue (robot, roue), la tête
/// d'une tourelle (robot, tourelle), la lame d'une arme de contact (robot, arme), un débris, un
/// accessoire. Le décor et le sol n'en ont pas.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Owner {
    Part(usize),
    Wheel(usize, usize),
    Head(usize, usize),
    Blade(usize, usize),
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
    /// Un tablier sous lequel on passe (`underpass`), et où l'aborder au-delà de ses bouts (`approach`, m).
    pub underpass: bool,
    pub approach: Option<f64>,
    pub rb: RigidBodyHandle,
}

/// Les dimensions d'une arène (`ArenaBounds`) : la demi-largeur de son terrain (ses murs), celle de la
/// zone où rôde l'IA, et le rayon du circuit que tournent les avions (m).
#[derive(Clone, Copy)]
pub struct Bounds {
    pub half: f64,
    pub roam: f64,
    pub circuit: f64,
    /// Les lignes de départ (`spawnLine`, `spawnSpread`), et celles placées ailleurs (`spawns` : les
    /// rouges, les bleus ; une carte communautaire).
    pub spawn_line: f64,
    pub spawn_spread: f64,
    pub spawns: Option<[super::game::SpawnLine; 2]>,
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
    /// Ce qui serait arrivé sans être porté : une arme de contact d'un mouvement inconnu (melee.rs).
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
    /// Événements `shot` (un tir), `projectileAdded` et `projectileRemoved` (un projectile lancé, un
    /// projectile qui a fini sa course), `impact` (un projectile qui s'arrête sans exploser), `hit`
    /// (un robot touché par une arme : son retour de tir).
    pub shots: u32,
    pub projectiles_added: u32,
    pub projectiles_removed: u32,
    pub impacts: u32,
    pub hits: u32,
    /// Événements `mine` : un capteur qui signale un ennemi, une mine qui bondit, qui se colle.
    pub mine_pings: u32,
    pub mine_bounces: u32,
    pub mine_sticks: u32,
    /// Événements `empBurst` (une impulsion électromagnétique), `stunned` (un robot paralysé, ou
    /// paralysé plus longtemps).
    pub emp_bursts: u32,
    pub stuns: u32,
    /// Événements `smokeAdded`, `smokeRemoved` (un nuage de fumée lâché, dissipé).
    pub smokes_added: u32,
    pub smokes_removed: u32,
    /// Événements `barrierAdded`, `barrierHit`, `barrierRemoved` (un mur d'énergie déployé, touché,
    /// éteint ou brisé).
    pub barriers_added: u32,
    pub barrier_hits: u32,
    pub barriers_removed: u32,
    /// Événements `meleeHit` (un coup d'arme de contact) et `organsStunned` (une paralysie locale : la
    /// décharge d'une lance électrique).
    pub melee_hits: u32,
    pub organs_stunned: u32,
}

pub struct Sim {
    pub phys: Physics,
    /// Le décor fixe de l'arène, dans l'ordre de ses boîtes (`arena.boxes`), et ses dimensions.
    pub boxes: Vec<SceneryBox>,
    pub bounds: Bounds,
    /// Le reste de l'arène : son relief, son eau profonde, sa lave, sa grille et son réseau de
    /// passage… (arena.rs), et le corps de son relief (le dernier du décor, `buildScenery`).
    pub arena: Arena,
    pub terrain_rb: Option<RigidBodyHandle>,
    /// Ses hautes rampes (`tallRamps`, relevées avec le décor : navigation.rs).
    pub tall_ramps: Vec<TallRamp>,
    /// Les recherches de chemin du pas (son temps, leur nombre : `maySearch`, navigation.rs).
    pub searches: Option<(f64, u32)>,
    /// Les obstacles au sol du pas (`obstacles`, navigation.rs) : le temps où ils ont été relevés, le
    /// nombre d'accessoires ancrés d'alors, la liste.
    pub obstacle_cache: RefCell<Option<(f64, usize, Rc<Vec<Obstacle>>)>>,
    /// Les ennemis que chaque équipe a repérés (`sim.detected` : rouges, bleus ; rien tant que la
    /// détection n'a pas tourné), dans l'ordre de `sim.bots` (detection.rs).
    pub detected: [Option<Vec<usize>>; 2],
    pub bots: Vec<Bot>,
    /// Les robots présents (`sim.bots` du TypeScript), dans leur ordre : des rangs de `bots`, qui
    /// garde aussi les robots retirés (un projectile, une flaque gardent leur tireur, comme l'objet du
    /// TypeScript) ; un robot qui réapparaît prend la place de l'ancien.
    pub roster: Vec<usize>,
    /// D'où naissent les robots que fait apparaître la session (leurs profils), et les commandes des
    /// pilotes (`Sim.inputs[0]` : celles du joueur de la partie solo, `sim.input`).
    pub profiles: Vec<std::rc::Rc<super::catalog::Robot>>,
    pub inputs: Vec<super::robot::Input>,
    /// Le robot du joueur (`sim.player`), la partie en cours (`sim.match`), l'IA figée (`aiPaused`), le
    /// point que vise la caméra libre (`playerAim` : ses missiles téléguidés le suivent).
    pub player: Option<usize>,
    pub match_: Option<super::game::Match>,
    pub ai_paused: bool,
    pub player_aim: Option<V3>,
    /// Le journal des événements, s'il est tenu (events.rs).
    pub events: Option<Vec<u8>>,
    /// Les morceaux, par numéro (un morceau retiré laisse sa place vide), et le robot de chacun (gardé
    /// après son retrait : `part.bot` reste lisible dans le TypeScript).
    pub parts: Vec<Option<Part>>,
    pub part_bots: Vec<usize>,
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
    /// Les tourelles de l'IA tirent et sa tactique la mène au combat (`sim.combat` ; faux au stand de
    /// tir et à l'essai du garage).
    pub combat: bool,
    /// Les projectiles en vol, dans l'ordre où ils sont partis (`sim.projectiles`).
    pub projectiles: Vec<Projectile>,
    /// Le dernier numéro d'entité donné (`lastId`, `sim.nextId()`) : robots, morceaux, blocs, roues,
    /// accessoires, débris, projectiles, flaques, nuages, murs, dans l'ordre où le TypeScript les crée
    /// (un missile reconnaît les leurres qu'il a déjà vus ; le jet d'un moteur se règle sur son bloc).
    pub last_id: u64,
    /// Les nuages de fumée (`sim.smokes`) et les murs d'énergie déployés (`sim.barriers`), dans l'ordre
    /// où ils sont apparus.
    pub smokes: Vec<SmokeCloud>,
    pub barriers: Vec<Barrier>,
    /// Les forces de contact du pas de Rapier et le mouvement des corps d'avant lui, entre l'étape de
    /// la physique et celle des chocs (`Sim::stage`).
    pub pending: Option<(Vec<ContactForce>, HashMap<RigidBodyHandle, Motion>)>,
    pub rng: Rng,
    pub gravity: f64,
    pub time: f64,
    pub stats: Stats,
    /// Une erreur survenue pendant un pas (une réapparition impossible), que la session relit.
    pub failure: Option<String>,
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
            bounds: Bounds { half: SMALL_HALF, roam: SMALL_ROAM, circuit: SMALL_CIRCUIT, spawn_line: SMALL_SPAWN_LINE, spawn_spread: SMALL_SPAWN_SPREAD, spawns: None },
            arena: Arena::default(),
            terrain_rb: None,
            tall_ramps: Vec::new(),
            searches: None,
            obstacle_cache: RefCell::new(None),
            detected: [None, None],
            bots: Vec::new(),
            roster: Vec::new(),
            profiles: Vec::new(),
            inputs: vec![super::robot::Input::default()],
            player: None,
            match_: None,
            ai_paused: false,
            player_aim: None,
            events: None,
            parts: Vec::new(),
            part_bots: Vec::new(),
            order: Vec::new(),
            owners: HashMap::new(),
            debris: Vec::new(),
            props: Vec::new(),
            fires: Vec::new(),
            prop_fires: Vec::new(),
            ground_fires: Vec::new(),
            water: None,
            combat: false,
            projectiles: Vec::new(),
            last_id: 0,
            smokes: Vec::new(),
            barriers: Vec::new(),
            pending: None,
            rng: Rng::new(0),
            gravity,
            time: 0.0,
            stats: Stats::default(),
            failure: None,
        }
    }

    /// Un nouveau numéro d'entité (`nextId`).
    pub fn next_id(&mut self) -> u64 {
        self.last_id += 1;
        self.last_id
    }

    pub fn part(&self, p: usize) -> &Part {
        self.parts[p].as_ref().expect("morceau retiré")
    }

    pub fn part_mut(&mut self, p: usize) -> &mut Part {
        self.parts[p].as_mut().expect("morceau retiré")
    }

    /// Une boîte du décor fixe (`buildScenery`), de la sorte `kind` ; `round` : un cylindre debout
    /// inscrit dans la boîte ; un rocher a la forme qu'on voit (l'enveloppe convexe de `rockShape`).
    pub fn add_box(&mut self, kind: &str, pos: V3, half: V3, rot: Q, round: bool) {
        let rb = self.phys.create_body(&BodyDesc::fixed(pos, rot));
        let shape = if round { ShapeDesc::Cylinder(half.y, half.x) } else { ShapeDesc::Cuboid(half.x, half.y, half.z) };
        let collider = |shape| ColliderDesc { friction: STATIC_FRICTION, collision_groups: groups::STATIC_GROUP, ..ColliderDesc::new(shape) };
        // (une enveloppe qui ne se fait pas : la boîte, comme le `??` du TypeScript)
        if kind != "rock" || self.phys.create_collider(&collider(ShapeDesc::ConvexHull(rock_shape(half, pos.x, pos.z))), rb).is_none() {
            self.phys.create_collider(&collider(shape), rb);
        }
        self.boxes.push(SceneryBox { kind: kind.to_string(), pos, half, rot, round, underpass: false, approach: None, rb });
        self.surveyed();
    }

    /// Un tablier sous lequel on passe (`underpass`), où l'aborder au-delà de ses bouts (`approach`) :
    /// la boîte `i` du décor.
    pub fn set_deck(&mut self, i: usize, underpass: bool, approach: Option<f64>) {
        (self.boxes[i].underpass, self.boxes[i].approach) = (underpass, approach);
        self.surveyed();
    }

    /// Le relief de l'arène (`buildScenery`) : un champ de hauteurs, après les boîtes du décor.
    pub fn set_terrain(&mut self, terrain: Terrain) {
        let rb = self.phys.create_body(&BodyDesc::fixed(v3(0.0, 0.0, 0.0), NO_ROTATION));
        let shape = ShapeDesc::HeightField(terrain.cells, terrain.size, terrain.heights.clone());
        let desc = ColliderDesc { friction: GROUND_FRICTION, collision_groups: groups::STATIC_GROUP, ..ColliderDesc::new(shape) };
        self.phys.create_collider(&desc, rb);
        self.terrain_rb = Some(rb);
        self.arena.terrain = Some(terrain);
        self.surveyed();
    }

    /// Ce qui se déduit du décor et du relief : les tabliers et les ponts, les hautes rampes ; et les
    /// obstacles du pas, à refaire.
    pub fn surveyed(&mut self) {
        survey_decks(self);
        self.tall_ramps = tall_ramps(&self.boxes);
        *self.obstacle_cache.borrow_mut() = None;
    }

    /// Retire le décor fixe (`clearScenery` : ses corps, avec leurs colliders, dans l'ordre : les
    /// boîtes, puis le relief), comme quand on change d'arène (`loadArena`) : le monde neuf du
    /// TypeScript a le décor du Dépôt.
    pub fn clear_scenery(&mut self) {
        for b in std::mem::take(&mut self.boxes) {
            self.phys.remove_body(b.rb);
        }
        if let Some(rb) = self.terrain_rb.take() {
            self.phys.remove_body(rb);
        }
        self.arena.terrain = None;
        self.surveyed();
    }

    /// Un robot préfabriqué, aux commandes d'un pilote (`spawnBot`, `takeControl`), chez les rouges ; son numéro.
    pub fn spawn(&mut self, id: &str, pos: V3, yaw: f64) -> Result<usize, String> {
        let b = spawn_bot(self, id, pos, yaw, 0, true)?;
        self.roster.push(b);
        Ok(b)
    }

    /// Un robot préfabriqué que conduit l'IA, dans l'équipe `team` (0 : les rouges, 1 : les bleus) ; son numéro.
    pub fn spawn_ai(&mut self, id: &str, pos: V3, yaw: f64, team: usize) -> Result<usize, String> {
        let b = spawn_bot(self, id, pos, yaw, team, false)?;
        self.roster.push(b);
        Ok(b)
    }

    /// L'accessoire de l'emplacement suivant de l'arène (`createProp`, appelé par `resetProps` dans
    /// l'ordre des emplacements) : son type, sa pose, ses dimensions (une dalle), son échelle (un
    /// cylindre) ; son numéro (celui de l'emplacement).
    pub fn add_prop(&mut self, kind: &str, pos: V3, rot: Option<Q>, half: Option<V3>, scale: Option<f64>) -> Result<usize, String> {
        add_prop(self, kind, pos, rot, half, scale)
    }

    /// Un pas fixe : ses étapes, dans l'ordre.
    pub fn step(&mut self) {
        for stage in 0..STAGES {
            self.stage(stage);
        }
    }

    /// La dernière erreur d'une étape (l'apparition d'un robot qui réapparaît), gardée pour qui la lira.
    pub fn stage_error(&mut self, e: String) {
        self.failure.get_or_insert(e);
    }

    /// L'étape `k` du pas (`STAGES` en tout), comme les mesure `Simulation.measure` (« détection »,
    /// « ia », « air », « roues », « physique », « chocs », « projectiles », « jets », « feu, fumée,
    /// réparation », « accessoires, débris »), la physique coupée en deux : le pas de Rapier (avec le
    /// mouvement des corps relevé avant lui) et la pose des roues. Le pas entier les enchaîne ; la sonde
    /// les appelle une à une pour mesurer chacune (`sim_stage`) : le monde ne voit pas la différence.
    pub fn stage(&mut self, k: usize) {
        match k {
            0 => {
                // Les commandes des pilotes (`bot.input ?? sim.input`), lues pendant tout le pas
                read_inputs(self);
                update_detection(self);
            }
            1 => {
                for b in self.roster.clone() {
                    think(self, b);
                }
                // Les zones touchables des têtes suivent leur lacet et leur site
                sync_heads(self);
            }
            // L'air : portance et traînée des ailes et des gouvernes, et les rafales sur les robots en vol
            2 => {
                for b in self.roster.clone() {
                    if !self.bots[b].surfaces.is_empty() {
                        apply_aerodynamics(self, b);
                    }
                    if self.bots[b].mobility != Mobility::Ground && self.bots[b].cockpit_alive() {
                        let rb = self.part(self.bots[b].cockpit_part()).rb;
                        buffet(self, rb);
                    }
                }
            }
            3 => step_wheels(self),
            4 => {
                let motions = capture_motions(self);
                let events = self.phys.step();
                self.pending = Some((events, motions));
            }
            5 => {
                place_wheels(self);
                self.time += STEP;
            }
            6 => {
                let (events, motions) = self.pending.take().expect("le pas de Rapier avant les chocs");
                resolve_collisions(self, &events, &motions);
            }
            // Les armes de contact : régime, coups
            7 => update_melee(self),
            8 => step_projectiles(self),
            // Les jets de flamme des moteurs : avant le feu, qui brûle ce qu'ils allument
            9 => update_scorch(self),
            10 => {
                update_fires(self);
                update_hazards(self);
                update_smokes(self);
                update_barriers(self);
                update_repairs(self);
                update_flares(self);
            }
            11 => {
                update_props(self);
                expire_debris(self);
                expire_wheel_wrecks(self);
            }
            // La partie : réapparitions, sabordages, zones, fin de partie
            _ => {
                if let Err(e) = update_match(self) {
                    self.stage_error(e);
                }
            }
        }
    }
}

/// Le nombre d'étapes d'un pas (`Sim::stage`).
pub const STAGES: usize = 13;

impl Default for Sim {
    fn default() -> Self {
        Self::new()
    }
}
