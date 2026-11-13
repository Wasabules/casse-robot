//! Les catalogues du jeu, lus dans content/catalog.json (incorporé au module) : ce qu'il faut à la
//! simulation portée des blocs (masse, forme, tourelle, réparation…), des roues, des robots
//! préfabriqués (leurs plans), des accessoires (forme, masse, résistances, explosion, mèche, fuite,
//! bois…) et des armes (cadence, portée, chargeur, chaleur, et leur projectile : guidage, explosion,
//! flaque de feu, impulsion électromagnétique, fumée, mine, tir réparateur, mur d'énergie…). Le
//! catalogue est fait par `npm run schemas` depuis les catalogues du TypeScript
//! (src/shared/catalog/) : ses nombres sont les leurs, au bit près (json.rs) ; seuls les sommets des
//! formes y sont arrondis (ils sont recalculés, comme le fait shapes.ts, quand on les porte).

use super::json::Json;
use std::collections::HashMap;
use std::sync::OnceLock;

/// Le catalogue, incorporé au module à la construction.
const CATALOG: &str = include_str!("../../../../content/catalog.json");

/// Constantes de content/catalog.json (`constants`) : celles de src/shared/config.ts.
pub struct Constants {
    pub block_size: f64,
    pub plate_thickness: f64,
    pub gravity: f64,
}

/// Forme d'un bloc : un cube, une plaque (aile, gouverne), ou une forme découpée (biseau, coin…).
#[derive(Clone, Debug, PartialEq)]
pub enum BlockShape {
    Cube,
    Plate,
    Shaped(String),
}

/// Une tourelle tournée vers l'arrière (poseur de mines) ou vers le bas (soute à bombes).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Fixed {
    Back,
    Down,
}

/// Tourelle (`TurretSpec`) : son arme, ses vitesses de rotation en lacet et en site (rad/s), son
/// débattement en site (rad), la hauteur de l'axe de sa tête au-dessus du centre de son bloc et la
/// longueur de son canon (m), et ce qu'il faut pour ses zones touchables (colliders.ts, `addHeads`).
#[derive(Clone, Debug)]
pub struct TurretSpec {
    pub weapon: String,
    pub yaw_rate: f64,
    pub pitch_rate: f64,
    pub min_pitch: f64,
    pub max_pitch: f64,
    pub height: f64,
    pub barrel: f64,
    pub head: [f64; 3],
    pub caliber: f64,
    pub fixed: Option<Fixed>,
}

#[derive(Clone, Debug)]
pub struct BlockDef {
    pub mass: f64,
    pub hp: f64,
    pub shape: BlockShape,
    pub turret: Option<TurretSpec>,
    /// L'arme de contact que porte le bloc (son identifiant, `melee`), que la simulation portée ne
    /// sait pas encore faire marcher : un robot qui en a une est refusé (robot.rs).
    pub melee: Option<String>,
    /// Moteur (`thruster`), appui sans roue (`support`), surface portante (`aero`).
    pub thruster: Option<ThrusterSpec>,
    pub support: Option<SupportSpec>,
    pub aero: Option<AeroSpec>,
    pub battery: f64,
    /// Solidité de ses liaisons (`bond`, robot/structure.ts).
    pub bond: f64,
    /// Facteurs des dégâts par nature (`resist` ; absent : 1).
    pub resist: HashMap<String, f64>,
    /// Générateur de bouclier (`shield`) : rayon (m), part absorbée, coût (kJ par point).
    pub shield: Option<Shield>,
    /// Module de réparation (`repair`, combat/repair.ts).
    pub repair: Option<RepairSpec>,
    /// Portée de son radar (`radar.range`, m ; 0 : il n'en est pas un) et de son brouilleur
    /// (`jammer.range` : au-delà, les radars ennemis ne repèrent plus son robot) (sim/detection.ts).
    pub radar: f64,
    pub jammer: Option<f64>,
    /// Lance-leurres (`flares`) : salves qu'il tient, temps pour en regagner une (s).
    pub flares: Option<(f64, f64)>,
}

/// Moteur (`ThrusterSpec`) : poussée maximale (N), temps de réponse (s), couple de réaction de
/// l'hélice par newton de poussée (N·m/N), puissance à pleine poussée (kW), inclinaison d'un rotor
/// orientable (`gimbal`, rad), son allure (`look` : rien, une flamme ; « rotor », « propeller »,
/// « jet »), la vitesse à laquelle une hélice ne pousse plus (`topSpeed`, m/s), et son jet de flamme.
#[derive(Clone, Debug)]
pub struct ThrusterSpec {
    pub max_thrust: f64,
    pub spool_time: f64,
    pub torque_ratio: f64,
    pub power: f64,
    pub gimbal: Option<f64>,
    pub look: Option<String>,
    pub top_speed: Option<f64>,
    pub exhaust: Option<ExhaustSpec>,
}

/// Jet de flamme d'un moteur (`ExhaustSpec`, robot/exhaust.ts) : distance du centre du bloc au bout
/// de la tuyère, longueur du jet à plein régime au-delà d'elle (m), dégâts par seconde à la tuyère,
/// rayon du jet à la tuyère (m) et ce qu'il gagne par mètre, régime de la postcombustion.
#[derive(Clone, Copy, Debug)]
pub struct ExhaustSpec {
    pub nozzle: f64,
    pub reach: f64,
    pub dps: f64,
    pub radius: f64,
    pub flare: f64,
    pub afterburner: Option<f64>,
}

/// Appui sans roue (`SupportSpec`, robot/supports.ts) : un patin (`hover`) ou une patte ; hauteur de
/// sustentation et portée de son rayon (m), charge nominale (kg), fréquence propre (Hz) et taux
/// d'amortissement, adhérence (part de la force d'appui), puissance sous la charge nominale (kW).
#[derive(Clone, Copy, Debug)]
pub struct SupportSpec {
    pub hover: bool,
    pub height: f64,
    pub reach: f64,
    pub rated_load: f64,
    pub frequency: f64,
    pub damping_ratio: f64,
    pub traction: f64,
    pub power: f64,
}

/// Surface portante (`AeroSpec`, robot/aero.ts) : surface (m²), pente de portance (par rad),
/// incidence de décrochage (rad), traînée à portance nulle, traînée induite, braquage maximal d'une
/// gouverne (rad ; rien : une aile fixe).
#[derive(Clone, Copy, Debug)]
pub struct AeroSpec {
    pub area: f64,
    pub lift_slope: f64,
    pub stall_angle: f64,
    pub drag_min: f64,
    pub induced_drag: f64,
    pub max_deflection: Option<f64>,
}

/// Module de réparation (`RepairSpec`) : points rendus par seconde, rayon (m), et le temps sans
/// être touché (s) au bout duquel il se met au travail.
#[derive(Clone, Copy, Debug)]
pub struct RepairSpec {
    pub rate: f64,
    pub radius: f64,
    pub delay: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Shield {
    pub radius: f64,
    pub absorb: f64,
    pub cost: f64,
}

impl BlockDef {
    /// `resist?.[type] ?? 1`.
    pub fn resistance(&self, kind: &str) -> f64 {
        self.resist.get(kind).copied().unwrap_or(1.0)
    }
}

/// Type de roue (`WheelTypeDef`, src/shared/catalog/wheels.ts).
#[derive(Clone, Debug)]
pub struct WheelDef {
    pub radius: f64,
    pub width: f64,
    pub mass: f64,
    pub hp: f64,
    pub grip: f64,
    pub stall_torque: f64,
    pub free_speed: f64,
    pub rated_load: f64,
    pub travel_up: f64,
    pub travel_down: f64,
    pub frequency: f64,
    pub damping_ratio: f64,
    /// Roue directrice : braquage maximal (rad) et vitesse de braquage (rad/s).
    pub steering: Option<(f64, f64)>,
    /// Roulette : sa chasse (m).
    pub caster: Option<f64>,
    pub track: bool,
    pub drop: Option<f64>,
}

/// Un des six axes du repère du robot (`Axis`, src/shared/design/robotDesign.ts).
pub fn axis(name: &str) -> Option<[f64; 3]> {
    Some(match name {
        "+x" => [1.0, 0.0, 0.0],
        "-x" => [-1.0, 0.0, 0.0],
        "+y" => [0.0, 1.0, 0.0],
        "-y" => [0.0, -1.0, 0.0],
        "+z" => [0.0, 0.0, 1.0],
        "-z" => [0.0, 0.0, -1.0],
        _ => return None,
    })
}

/// Bloc d'un plan (`BlockPlacement`) : coordonnées entières (des nombres, comme en JavaScript).
#[derive(Clone, Debug)]
pub struct BlockPlacement {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub kind: String,
    /// Son haut et son avant (`Facing` ; absent : "+y", "+z").
    pub up: String,
    pub forward: String,
}

/// Roue d'un plan (`WheelMount`).
#[derive(Clone, Debug)]
pub struct WheelMount {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub dx: f64,
    pub dz: f64,
    pub dy: Option<f64>,
    pub kind: String,
    pub shift: Option<f64>,
    pub rise: Option<f64>,
    pub layer: Option<f64>,
}

#[derive(Clone, Debug)]
pub struct Design {
    pub blocks: Vec<BlockPlacement>,
    pub wheels: Vec<WheelMount>,
}

/// Mobilité d'un robot : au sol, en vol stationnaire, en avion.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mobility {
    Ground,
    Hover,
    Plane,
}

/// Robot préfabriqué (`BotProfile`, src/shared/design/presets.ts).
#[derive(Clone, Debug)]
pub struct Robot {
    pub speed: f64,
    pub turn: f64,
    pub mobility: Mobility,
    /// Heurté, il fonce sur qui l'a heurté (`behavior` « charge ») au lieu de fuir.
    pub charges: bool,
    pub design: Design,
}

/// Forme d'un accessoire (`PropTypeDef.shape`) : une boîte (demi-côté), un cylindre debout, ou une
/// dalle dont chaque emplacement donne les dimensions.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PropShape {
    Box(f64),
    Cylinder { radius: f64, half_height: f64 },
    Slab,
}

/// Explosion (`Explosion`, catalog/weapons.ts) : ce qu'il en faut à la simulation, et son allure
/// (`look`, que dit l'événement `explosion`).
#[derive(Clone, Copy, Debug)]
pub struct Explosion {
    pub look: &'static str,
    pub radius: f64,
    pub damage: f64,
    pub blast_radius: f64,
    pub power: f64,
    pub lift: f64,
    /// Part des blocs touchés qu'elle enflamme (`ignite` ; absent : 0).
    pub ignite: f64,
    /// La flaque de feu qu'elle laisse au sol (le napalm).
    pub puddle: Option<Puddle>,
}

/// Flaque de feu au sol (`GroundFireSpec`) : son rayon (m), sa durée (s).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Puddle {
    pub radius: f64,
    pub life: f64,
}

/// Guidage d'un projectile (`Guidance`) : son mode (« command », « homing », « piloted »), s'il ne
/// vise que des robots en vol (`airOnly`), sa vitesse de virage (rad/s), le temps qu'il file droit
/// au départ (s), son accélération latérale (m/s²), la vitesse qu'un virage lui coûte (par radian)
/// et celle que son moteur lui rend (1/s) ; 0 : absent.
#[derive(Clone, Debug)]
pub struct Guidance {
    pub mode: String,
    pub air_only: bool,
    pub turn_rate: f64,
    pub launch: f64,
    pub max_accel: f64,
    pub bleed: f64,
    pub recover: f64,
}

/// Ce que fait une mine déclenchée, au lieu d'éclater (`MineAction`) : bondir à cette hauteur (m),
/// lancer le projectile d'une arme sur sa cible, se coller à elle et éclater au bout de sa mèche (s).
#[derive(Clone, Debug, PartialEq)]
pub enum MineAction {
    Bounce(f64),
    Launch(String),
    Stick(f64),
}

/// Mine (`MineSpec`) : ce qui la déclenche (« ground », « air », « remote », « none »), le temps
/// qu'elle met à s'armer (s), le rayon où elle se déclenche (m), celui où elle repère les ennemis (un
/// capteur ; 0 : aucun), et ce qu'elle fait d'autre qu'éclater (`action`).
#[derive(Clone, Debug)]
pub struct MineSpec {
    pub trigger: String,
    pub arm_delay: f64,
    pub radius: f64,
    pub sense: f64,
    pub action: Option<MineAction>,
}

/// Impulsion électromagnétique (`EmpPulse`) : son rayon (m), la durée de la paralysie à son centre (s).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EmpPulse {
    pub radius: f64,
    pub duration: f64,
}

/// Fumigène (`SmokeSpec`) : le rayon final du nuage (m), sa durée (s).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SmokeSpec {
    pub radius: f64,
    pub duration: f64,
}

/// Tir réparateur (`RepairShot`) : points rendus à chaque bloc et roue d'un allié dans `radius` m du
/// point touché ; sur un ennemi, les dégâts qu'il vole (`drain` ; 0 : aucun) et la part de ce qu'il a
/// pris qui répare le tireur (`steal`) ; des nanites : le nombre de blocs les plus abîmés qu'elles
/// réparent, où qu'ils soient (`swarm`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RepairShot {
    pub amount: f64,
    pub radius: f64,
    pub drain: f64,
    pub steal: f64,
    pub swarm: Option<f64>,
}

/// Mur d'énergie (`BarrierSpec`) : sa largeur et sa hauteur (m), ses points, sa durée (s), et la
/// distance au bout de laquelle le projectile qui le porte se déploie (m).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BarrierSpec {
    pub width: f64,
    pub height: f64,
    pub hp: f64,
    pub life: f64,
    pub reach: f64,
}

/// Projectile d'une arme (`ProjectileSpec`) : vitesse (m/s), part de la gravité, durée de vol (s),
/// dégâts et leur nature, perforant, impulsion (N·s), chance d'enflammer ce qu'il touche, et ce
/// qu'il emporte : une explosion, une flaque de feu (et sa chance), une impulsion électromagnétique,
/// de la fumée, un guidage, une mine, une coque qu'on peut abattre (rayon, points), une gerbe de
/// plombs (nombre, écart), un éventail (écart), un leurre, un tir réparateur, un mur d'énergie, une
/// fusée de proximité.
#[derive(Clone, Debug)]
pub struct ProjectileSpec {
    pub speed: f64,
    pub gravity: f64,
    pub life: f64,
    pub damage: f64,
    pub damage_type: String,
    pub penetrating: bool,
    pub impulse: f64,
    pub ignite: f64,
    pub explosion: Option<Explosion>,
    pub puddle: Option<Puddle>,
    pub puddle_chance: f64,
    pub emp: Option<EmpPulse>,
    pub smoke: Option<SmokeSpec>,
    pub guidance: Option<Guidance>,
    pub mine: Option<MineSpec>,
    pub hull: Option<(f64, f64)>,
    pub pellets: Option<(f64, f64)>,
    pub fan: Option<f64>,
    pub decoy: bool,
    pub repair: Option<RepairShot>,
    pub barrier: Option<BarrierSpec>,
    pub proximity: Option<f64>,
}

/// Arme (`Weapon`, catalog/weapons.ts) : cadence (s), automatique, dispersion au viseur (rad),
/// recul (N·s), portée et portée préférée de l'IA (m), portée minimale, énergie tirée par coup (kJ ;
/// 0 : aucune), maniement (sans viseur, en mouvement, en rotation), chaleur (par coup, refroidissement
/// par seconde), chargeur (capacité, rechargement d'un coup en s ; jamais : ∞), larguée, à
/// verrouillage, de soin automatique, et son projectile. `explosion` et `puddle` : ceux du projectile.
#[derive(Clone, Debug)]
pub struct WeaponDef {
    pub cooldown: f64,
    pub automatic: bool,
    pub spread: f64,
    pub recoil: f64,
    pub range: f64,
    pub engage: Option<f64>,
    pub min_range: Option<f64>,
    pub power: f64,
    pub hip: f64,
    /// Ce que la dispersion d'un tir du pilote gagne par m/s de vitesse et par rad/s de rotation du robot
    /// (`handling.move`, `handling.turn`) ; une arme de précision ne tire qu'au viseur (`scopeOnly`).
    pub sway: (f64, f64),
    pub scope_only: bool,
    pub heat: Option<(f64, f64)>,
    pub ammo: Option<(f64, f64)>,
    pub dropped: bool,
    /// Verrouillage : le temps à tenir la cible (s), le cône (rad).
    pub lock: Option<(f64, f64)>,
    pub auto_support: bool,
    pub projectile: ProjectileSpec,
    pub explosion: Option<Explosion>,
    pub puddle: Option<Puddle>,
}

/// Volume que balaie la lame d'un rotor (`SweptRing`) : ses rayons (m), sa demi-épaisseur le long de
/// l'axe, ses bras (nombre, largeur) s'il en a, et la toile des rayons d'un anneau-coque (hauteur
/// depuis le moyeu, demi-épaisseur : réservée, elle ne frappe pas).
#[derive(Clone, Copy, Debug)]
pub struct SweptRing {
    pub inner: f64,
    pub outer: f64,
    pub half: f64,
    pub arms: Option<(f64, f64)>,
    pub web: Option<(f64, f64)>,
}

impl SweptRing {
    /// Une lame plus longue le long de son axe que large : une mèche (`isBit`).
    pub fn is_bit(&self) -> bool {
        self.half > self.outer
    }
}

/// Bras déclenché (`SwingSpec`) : portée et rayon de sa tête (m), angles de repos et de fin (rad),
/// durées de la frappe et du retour (s), énergie de la tête au bout de l'arc (J), coût d'une frappe (kJ).
#[derive(Clone, Copy, Debug)]
pub struct SwingSpec {
    pub reach: f64,
    pub radius: f64,
    pub rest: f64,
    pub end: f64,
    pub strike: f64,
    pub recover: f64,
    pub energy: f64,
    pub cost: f64,
}

/// Pointe (`ThrustSpec`) : rentrée et sortie (m du moyeu), rayon de la pointe, durées de la sortie et
/// du retour (s), énergie de la décharge (J), coût (kJ).
#[derive(Clone, Copy, Debug)]
pub struct ThrustSpec {
    pub retracted: f64,
    pub reach: f64,
    pub radius: f64,
    pub strike: f64,
    pub recover: f64,
    pub energy: f64,
    pub cost: f64,
}

/// Plateau de flipper (`PlateSpec`) : longueur et demi-largeur (m), angles de repos et de fin (rad),
/// durées de la levée, de la redescente et de la recharge (s), travail du vérin (J), coût (kJ).
#[derive(Clone, Copy, Debug)]
pub struct PlateSpec {
    pub length: f64,
    pub half: f64,
    pub rest: f64,
    pub end: f64,
    pub strike: f64,
    pub lower: f64,
    pub reload: f64,
    pub energy: f64,
    pub cost: f64,
}

/// Champ broyeur (`FieldSpec`) : marge autour de la coque (m), rayon couvert depuis le projecteur (m),
/// contacts par coup, part de l'énergie d'un rotor ennemi qu'il lui prend, impulsion qui repousse une
/// arme ennemie (N·s).
#[derive(Clone, Copy, Debug)]
pub struct FieldSpec {
    pub margin: f64,
    pub radius: f64,
    pub contacts: f64,
    pub drain: f64,
    pub repel: f64,
}

/// Fléau (`FlailSpec`) : rayon et inertie de la manivelle, régime (rad/s) et lancée (s), longueur de
/// la chaîne, masse et rayon de la boule, restitution et frottement de ses rebonds, freinage de l'air.
#[derive(Clone, Copy, Debug)]
pub struct FlailSpec {
    pub crank: f64,
    pub inertia: f64,
    pub speed: f64,
    pub spin_up: f64,
    pub chain: f64,
    pub mass: f64,
    pub radius: f64,
    pub restitution: f64,
    pub friction: f64,
    pub drag: f64,
}

/// Mâchoire (`JawSpec`) : longueur et demi-largeur (m), angles ouvert et fermé (rad), durées de la
/// fermeture, de la réouverture et du répit (s), sa gueule (m du pivot), ce qu'elle tient (N), son
/// glissement toléré (s), l'écart qui l'arrache (m), l'écrasement (par s) et la morsure, le vérin
/// (kW), la prise au plus (s).
#[derive(Clone, Copy, Debug)]
pub struct JawSpec {
    pub length: f64,
    pub half: f64,
    pub open: f64,
    pub shut: f64,
    pub close: f64,
    pub reopen: f64,
    pub cooldown: f64,
    pub mouth: (f64, f64),
    pub strength: f64,
    pub slip: f64,
    pub tear: f64,
    pub crush: f64,
    pub bite: f64,
    pub power: f64,
    pub hold: f64,
}

/// Une lame qui mord en continu (`BiteSpec`) : puissance de coupe (kW), le long de son axe (une mèche)
/// ou de son bord, entraînement, réducteur, profondeur (m).
#[derive(Clone, Copy, Debug)]
pub struct BiteSpec {
    pub power: f64,
    pub axial: bool,
    pub grab: f64,
    pub gear: f64,
    pub depth: f64,
}

/// Régime d'un rotor (`SpinSpec`) : inertie (kg·m²), régime plein (rad/s), temps de lancée et de
/// ralentissement (s), gyroscope, balourd, masse tournante, sens de rotation (1 par défaut), réaction
/// de son moteur (1 par défaut).
#[derive(Clone, Copy, Debug)]
pub struct SpinSpec {
    pub inertia: f64,
    pub speed: f64,
    pub spin_up: f64,
    pub spin_down: f64,
    pub gyro: f64,
    pub unbalance: f64,
    pub mass: f64,
    pub direction: f64,
    pub reaction: f64,
}

/// Le sens de l'impulsion d'un coup (`MeleeHit.push`) : le long du mouvement de la lame, vers
/// l'extérieur, le long de l'axe, vers le haut.
#[derive(Clone, Copy, Debug)]
pub struct Push {
    pub tangent: f64,
    pub radial: f64,
    pub axial: f64,
    pub lift: f64,
}

/// Un coup d'arme de contact (`MeleeHit`) : nature et dégâts par kJ, part de l'énergie que prend un
/// coup franc, part qui projette, sens de l'impulsion, réaction au moyeu, part des dégâts aux voisins,
/// facteur sur une roue, usure par kJ, temps entre deux coups (s), régime au moins (part du plein),
/// part que prend le sol.
#[derive(Clone, Debug)]
pub struct MeleeHit {
    pub damage_type: String,
    pub damage: f64,
    pub bite: f64,
    pub fling: f64,
    pub push: Push,
    pub recoil: f64,
    pub spread: f64,
    pub wheels: Option<f64>,
    pub wear: f64,
    pub gap: f64,
    pub min_speed: f64,
    pub ground: Option<f64>,
    /// Le coup allume ce qu'il touche (chance) ; il paralyse les organes autour du point touché
    /// (rayon, durée : `LocalStun`).
    pub ignite: Option<f64>,
    pub stun: Option<(f64, f64)>,
}

/// Arme de contact (`MeleeSpec`, catalog/melee.ts) : son allure, son mouvement (rotor, rotor mené,
/// bras, pointe, champ, plateau, fléau, mâchoire), son axe, son moyeu, sa lame, son régime, le moteur
/// qui la mène, sa morsure, son bras, sa pointe, son plateau, son champ, son fléau, sa mâchoire, ses
/// coups, si elle s'éteint sans courant (`quench`), et la distance où l'IA combat avec elle.
#[derive(Clone, Debug)]
pub struct MeleeSpec {
    pub look: String,
    pub motion: String,
    pub axis: String,
    pub hub: [f64; 3],
    pub blade: Option<SweptRing>,
    pub spin: Option<SpinSpec>,
    /// Mené par le moteur de son bloc : régime au ralenti, poussée sous laquelle il s'arrête.
    pub drive: Option<(f64, f64)>,
    pub bite: Option<BiteSpec>,
    pub swing: Option<SwingSpec>,
    pub thrust: Option<ThrustSpec>,
    pub plate: Option<PlateSpec>,
    pub field: Option<FieldSpec>,
    pub flail: Option<FlailSpec>,
    pub jaw: Option<JawSpec>,
    pub hit: MeleeHit,
    pub quench: bool,
    pub engage: f64,
}

/// Type d'accessoire (`PropTypeDef`, src/shared/catalog/props.ts).
#[derive(Clone, Debug)]
pub struct PropDef {
    pub shape: PropShape,
    /// Masse (kg) ; pour une dalle, masse volumique (kg/m³).
    pub mass: f64,
    pub friction: f64,
    pub hp: f64,
    pub resist: HashMap<String, f64>,
    pub explosion: Option<Explosion>,
    /// Délai entre la rupture et l'explosion (`fuse ?? 0`).
    pub fuse: f64,
    /// Fuite de gaz : poussée (N), durée (s).
    pub vent: Option<(f64, f64)>,
    pub shatters: bool,
    pub anchored: bool,
    /// Part de ses points de structure qu'il garde en basculant (`topples ?? 0` ; 0 : il ne bascule pas).
    pub topples: f64,
    /// Du bois : durée de son feu (s), portée de ses flammes (m).
    pub burns: Option<(f64, f64)>,
}

impl PropDef {
    /// `resist?.[type] ?? 1`.
    pub fn resistance(&self, kind: &str) -> f64 {
        self.resist.get(kind).copied().unwrap_or(1.0)
    }
}

pub struct Catalog {
    pub constants: Constants,
    pub blocks: HashMap<String, BlockDef>,
    pub wheels: HashMap<String, WheelDef>,
    pub robots: HashMap<String, Robot>,
    pub props: HashMap<String, PropDef>,
    pub weapons: HashMap<String, WeaponDef>,
    pub melee: HashMap<String, MeleeSpec>,
}

/// Le catalogue, lu une fois.
pub fn catalog() -> &'static Catalog {
    static ONCE: OnceLock<Catalog> = OnceLock::new();
    ONCE.get_or_init(|| read(CATALOG).expect("content/catalog.json illisible"))
}

fn num(j: &Json, key: &str) -> Result<f64, String> {
    j.get(key).and_then(Json::num).ok_or_else(|| format!("catalogue : « {key} » manque"))
}

fn opt(j: &Json, key: &str) -> Option<f64> {
    j.get(key).and_then(Json::num)
}

fn read_block(j: &Json) -> Result<BlockDef, String> {
    let shape = match j.get("shape").and_then(Json::str) {
        None | Some("cube") => BlockShape::Cube,
        Some("plate") => BlockShape::Plate,
        Some(other) => BlockShape::Shaped(other.to_string()),
    };
    let turret = match j.get("turret") {
        Some(t) => {
            let head = t.get("head").map(Json::arr).unwrap_or(&[]);
            if head.len() != 3 {
                return Err("catalogue : tête de tourelle sans ses trois dimensions".into());
            }
            Some(TurretSpec {
                weapon: t.get("weapon").and_then(Json::str).ok_or("catalogue : tourelle sans arme")?.to_string(),
                yaw_rate: num(t, "yawRate")?,
                pitch_rate: num(t, "pitchRate")?,
                min_pitch: num(t, "minPitch")?,
                max_pitch: num(t, "maxPitch")?,
                height: num(t, "height")?,
                barrel: num(t, "barrel")?,
                head: [head[0].num().unwrap_or(0.0), head[1].num().unwrap_or(0.0), head[2].num().unwrap_or(0.0)],
                caliber: num(t, "caliber")?,
                fixed: match t.get("fixed").and_then(Json::str) {
                    Some("back") => Some(Fixed::Back),
                    Some("down") => Some(Fixed::Down),
                    _ => None,
                },
            })
        }
        None => None,
    };
    Ok(BlockDef {
        mass: num(j, "mass")?,
        hp: num(j, "hp")?,
        shape,
        turret,
        melee: j.get("melee").and_then(Json::str).map(str::to_string),
        thruster: match j.get("thruster") {
            Some(t) => Some(ThrusterSpec {
                max_thrust: num(t, "maxThrust")?,
                spool_time: num(t, "spoolTime")?,
                torque_ratio: num(t, "torqueRatio")?,
                power: num(t, "power")?,
                gimbal: opt(t, "gimbal"),
                look: t.get("look").and_then(Json::str).map(str::to_string),
                top_speed: opt(t, "topSpeed"),
                exhaust: match t.get("exhaust") {
                    Some(e) => Some(ExhaustSpec {
                        nozzle: num(e, "nozzle")?,
                        reach: num(e, "reach")?,
                        dps: num(e, "dps")?,
                        radius: num(e, "radius")?,
                        flare: num(e, "flare")?,
                        afterburner: opt(e, "afterburner"),
                    }),
                    None => None,
                },
            }),
            None => None,
        },
        support: match j.get("support") {
            Some(s) => Some(SupportSpec {
                hover: s.get("kind").and_then(Json::str) == Some("hover"),
                height: num(s, "height")?,
                reach: num(s, "reach")?,
                rated_load: num(s, "ratedLoad")?,
                frequency: num(s, "frequency")?,
                damping_ratio: num(s, "dampingRatio")?,
                traction: num(s, "traction")?,
                power: num(s, "power")?,
            }),
            None => None,
        },
        aero: match j.get("aero") {
            Some(a) => Some(AeroSpec {
                area: num(a, "area")?,
                lift_slope: num(a, "liftSlope")?,
                stall_angle: num(a, "stallAngle")?,
                drag_min: num(a, "dragMin")?,
                induced_drag: num(a, "inducedDrag")?,
                max_deflection: opt(a, "maxDeflection"),
            }),
            None => None,
        },
        battery: j.get("battery").and_then(|b| opt(b, "capacity")).unwrap_or(0.0),
        bond: num(j, "bond")?,
        resist: j.get("resist").map(Json::fields).unwrap_or(&[]).iter().filter_map(|(k, v)| Some((k.clone(), v.num()?))).collect(),
        shield: match j.get("shield") {
            Some(s) => Some(Shield { radius: num(s, "radius")?, absorb: num(s, "absorb")?, cost: num(s, "cost")? }),
            None => None,
        },
        repair: match j.get("repair") {
            Some(r) => Some(RepairSpec { rate: num(r, "rate")?, radius: num(r, "radius")?, delay: num(r, "delay")? }),
            None => None,
        },
        radar: match j.get("radar") {
            Some(r) => num(r, "range")?,
            None => 0.0,
        },
        jammer: match j.get("jammer") {
            Some(r) => Some(num(r, "range")?),
            None => None,
        },
        flares: pair(j, "flares", "charges", "reload")?,
    })
}

fn read_wheel(j: &Json) -> Result<WheelDef, String> {
    let s = j.get("suspension").ok_or("catalogue : roue sans suspension")?;
    Ok(WheelDef {
        radius: num(j, "radius")?,
        width: num(j, "width")?,
        mass: num(j, "mass")?,
        hp: num(j, "hp")?,
        grip: num(j, "grip")?,
        stall_torque: num(j, "stallTorque")?,
        free_speed: num(j, "freeSpeed")?,
        rated_load: num(j, "ratedLoad")?,
        travel_up: num(s, "travelUp")?,
        travel_down: num(s, "travelDown")?,
        frequency: num(s, "frequency")?,
        damping_ratio: num(s, "dampingRatio")?,
        steering: match j.get("steering") {
            Some(st) => Some((num(st, "maxAngle")?, num(st, "rate")?)),
            None => None,
        },
        caster: match j.get("caster") {
            Some(c) => Some(num(c, "trail")?),
            None => None,
        },
        track: j.get("track").is_some_and(Json::is_true),
        drop: opt(j, "drop"),
    })
}

fn read_explosion(j: &Json) -> Result<Explosion, String> {
    // (le catalogue est lu une fois, pour toute la vie du module : son texte peut y rester)
    let look: &'static str = Box::leak(j.get("look").and_then(Json::str).unwrap_or("shell").to_string().into_boxed_str());
    Ok(Explosion {
        look,
        radius: num(j, "radius")?,
        damage: num(j, "damage")?,
        blast_radius: num(j, "blastRadius")?,
        power: num(j, "power")?,
        lift: num(j, "lift")?,
        ignite: opt(j, "ignite").unwrap_or(0.0),
        puddle: read_puddle(j)?,
    })
}

/// La flaque de feu d'une explosion ou d'un projectile (`puddle`), s'il y en a une.
fn read_puddle(j: &Json) -> Result<Option<Puddle>, String> {
    match j.get("puddle") {
        Some(p) => Ok(Some(Puddle { radius: num(p, "radius")?, life: num(p, "life")? })),
        None => Ok(None),
    }
}

/// Une paire de nombres d'un objet (`key` : ses champs `a` et `b`), s'il y est.
fn pair(j: &Json, key: &str, a: &str, b: &str) -> Result<Option<(f64, f64)>, String> {
    match j.get(key) {
        Some(o) => Ok(Some((num(o, a)?, num(o, b)?))),
        None => Ok(None),
    }
}

fn read_projectile(p: &Json) -> Result<ProjectileSpec, String> {
    let explosion = match p.get("explosion") {
        Some(e) => Some(read_explosion(e)?),
        None => None,
    };
    Ok(ProjectileSpec {
        speed: num(p, "speed")?,
        gravity: num(p, "gravity")?,
        life: num(p, "life")?,
        damage: num(p, "damage")?,
        damage_type: p.get("damageType").and_then(Json::str).ok_or("catalogue : projectile sans nature de dégâts")?.to_string(),
        penetrating: p.get("penetrating").is_some_and(Json::is_true),
        impulse: num(p, "impulse")?,
        ignite: opt(p, "ignite").unwrap_or(0.0),
        explosion,
        puddle: read_puddle(p)?,
        puddle_chance: p.get("puddle").and_then(|q| opt(q, "chance")).unwrap_or(0.0),
        emp: match p.get("emp") {
            Some(e) => Some(EmpPulse { radius: num(e, "radius")?, duration: num(e, "duration")? }),
            None => None,
        },
        smoke: match p.get("smoke") {
            Some(e) => Some(SmokeSpec { radius: num(e, "radius")?, duration: num(e, "duration")? }),
            None => None,
        },
        guidance: match p.get("guidance") {
            Some(g) => Some(Guidance {
                mode: g.get("mode").and_then(Json::str).unwrap_or("").to_string(),
                air_only: g.get("airOnly").is_some_and(Json::is_true),
                turn_rate: num(g, "turnRate")?,
                launch: opt(g, "launch").unwrap_or(0.0),
                max_accel: opt(g, "maxAccel").unwrap_or(0.0),
                bleed: opt(g, "bleed").unwrap_or(0.0),
                recover: opt(g, "recover").unwrap_or(0.0),
            }),
            None => None,
        },
        mine: match p.get("mine") {
            Some(m) => Some(MineSpec {
                trigger: m.get("trigger").and_then(Json::str).unwrap_or("").to_string(),
                arm_delay: num(m, "armDelay")?,
                radius: num(m, "radius")?,
                sense: opt(m, "sense").unwrap_or(0.0),
                action: match m.get("action") {
                    Some(a) => Some(match a.get("kind").and_then(Json::str) {
                        Some("bounce") => MineAction::Bounce(num(a, "height")?),
                        Some("launch") => MineAction::Launch(a.get("weapon").and_then(Json::str).ok_or("catalogue : mine qui lance sans arme")?.to_string()),
                        Some("stick") => MineAction::Stick(num(a, "fuse")?),
                        _ => return Err("catalogue : action de mine inconnue".into()),
                    }),
                    None => None,
                },
            }),
            None => None,
        },
        hull: pair(p, "hull", "radius", "hp")?,
        pellets: pair(p, "pellets", "count", "spread")?,
        fan: opt(p, "fan"),
        decoy: p.get("decoy").is_some_and(Json::is_true),
        repair: match p.get("repair") {
            Some(r) => Some(RepairShot {
                amount: num(r, "amount")?,
                radius: num(r, "radius")?,
                drain: opt(r, "drain").unwrap_or(0.0),
                steal: opt(r, "steal").unwrap_or(0.0),
                swarm: opt(r, "swarm"),
            }),
            None => None,
        },
        barrier: match p.get("barrier") {
            Some(b) => Some(BarrierSpec { width: num(b, "width")?, height: num(b, "height")?, hp: num(b, "hp")?, life: num(b, "life")?, reach: num(b, "reach")? }),
            None => None,
        },
        proximity: opt(p, "proximity"),
    })
}

fn read_weapon(j: &Json) -> Result<WeaponDef, String> {
    let projectile = read_projectile(j.get("projectile").ok_or("catalogue : arme sans projectile")?)?;
    let handling = j.get("handling").ok_or("catalogue : arme sans maniement")?;
    Ok(WeaponDef {
        cooldown: num(j, "cooldown")?,
        automatic: j.get("automatic").is_some_and(Json::is_true),
        spread: num(j, "spread")?,
        recoil: num(j, "recoil")?,
        range: num(j, "range")?,
        engage: opt(j, "engage"),
        min_range: opt(j, "minRange"),
        power: opt(j, "power").unwrap_or(0.0),
        hip: num(handling, "hip")?,
        sway: (num(handling, "move")?, num(handling, "turn")?),
        scope_only: j.get("scopeOnly").is_some_and(Json::is_true),
        heat: pair(j, "heat", "perShot", "cooling")?,
        // (un chargeur qui ne se recharge jamais, l'ogive : `"reload": null`, ∞ dans le jeu)
        ammo: match j.get("ammo") {
            Some(a) => Some((num(a, "capacity")?, opt(a, "reload").unwrap_or(f64::INFINITY))),
            None => None,
        },
        dropped: j.get("dropped").is_some_and(Json::is_true),
        lock: pair(j, "lock", "time", "cone")?,
        auto_support: j.get("autoSupport").is_some_and(Json::is_true),
        explosion: projectile.explosion,
        puddle: projectile.puddle,
        projectile,
    })
}

fn read_prop(j: &Json) -> Result<PropDef, String> {
    let s = j.get("shape").ok_or("catalogue : accessoire sans forme")?;
    let shape = match s.get("kind").and_then(Json::str) {
        Some("box") => PropShape::Box(num(s, "half")?),
        Some("cylinder") => PropShape::Cylinder { radius: num(s, "radius")?, half_height: num(s, "halfHeight")? },
        Some("slab") => PropShape::Slab,
        _ => return Err("catalogue : forme d'accessoire inconnue".into()),
    };
    Ok(PropDef {
        shape,
        mass: num(j, "mass")?,
        friction: num(j, "friction")?,
        hp: num(j, "hp")?,
        resist: j.get("resist").map(Json::fields).unwrap_or(&[]).iter().filter_map(|(k, v)| Some((k.clone(), v.num()?))).collect(),
        explosion: match j.get("explosion") {
            Some(e) => Some(read_explosion(e)?),
            None => None,
        },
        fuse: opt(j, "fuse").unwrap_or(0.0),
        vent: match j.get("vent") {
            Some(v) => Some((num(v, "thrust")?, num(v, "duration")?)),
            None => None,
        },
        shatters: j.get("shatters").is_some_and(Json::is_true),
        anchored: j.get("anchored").is_some_and(Json::is_true),
        topples: opt(j, "topples").unwrap_or(0.0),
        burns: match j.get("burns") {
            Some(b) => Some((num(b, "time")?, num(b, "reach")?)),
            None => None,
        },
    })
}

fn read_melee(j: &Json) -> Result<MeleeSpec, String> {
    let hub = j.get("hub").map(Json::arr).unwrap_or(&[]);
    if hub.len() != 3 {
        return Err("catalogue : moyeu d'arme de contact sans ses trois coordonnées".into());
    }
    let h = j.get("hit").ok_or("catalogue : arme de contact sans coup")?;
    let p = h.get("push").ok_or("catalogue : coup sans sens")?;
    let jaw = match j.get("jaw") {
        Some(w) => {
            let mouth = w.get("mouth").map(Json::arr).unwrap_or(&[]);
            if mouth.len() != 2 {
                return Err("catalogue : gueule de mâchoire sans ses deux bornes".into());
            }
            Some(JawSpec {
                length: num(w, "length")?,
                half: num(w, "half")?,
                open: num(w, "open")?,
                shut: num(w, "shut")?,
                close: num(w, "close")?,
                reopen: num(w, "reopen")?,
                cooldown: num(w, "cooldown")?,
                mouth: (mouth[0].num().unwrap_or(0.0), mouth[1].num().unwrap_or(0.0)),
                strength: num(w, "strength")?,
                slip: num(w, "slip")?,
                tear: num(w, "tear")?,
                crush: num(w, "crush")?,
                bite: num(w, "bite")?,
                power: num(w, "power")?,
                hold: num(w, "hold")?,
            })
        }
        None => None,
    };
    Ok(MeleeSpec {
        look: j.get("look").and_then(Json::str).unwrap_or("").to_string(),
        motion: j.get("motion").and_then(Json::str).unwrap_or("").to_string(),
        axis: j.get("axis").and_then(Json::str).unwrap_or("up").to_string(),
        hub: [hub[0].num().unwrap_or(0.0), hub[1].num().unwrap_or(0.0), hub[2].num().unwrap_or(0.0)],
        blade: match j.get("blade") {
            Some(b) => Some(SweptRing {
                inner: num(b, "inner")?,
                outer: num(b, "outer")?,
                half: num(b, "half")?,
                arms: pair(b, "arms", "count", "width")?,
                web: pair(b, "web", "at", "half")?,
            }),
            None => None,
        },
        bite: match j.get("bite") {
            Some(b) => Some(BiteSpec {
                power: num(b, "power")?,
                axial: b.get("feed").and_then(Json::str) == Some("axial"),
                grab: num(b, "grab")?,
                gear: num(b, "gear")?,
                depth: num(b, "depth")?,
            }),
            None => None,
        },
        swing: match j.get("swing") {
            Some(w) => Some(SwingSpec {
                reach: num(w, "reach")?,
                radius: num(w, "radius")?,
                rest: num(w, "rest")?,
                end: num(w, "end")?,
                strike: num(w, "strike")?,
                recover: num(w, "recover")?,
                energy: num(w, "energy")?,
                cost: num(w, "cost")?,
            }),
            None => None,
        },
        thrust: match j.get("thrust") {
            Some(t) => Some(ThrustSpec {
                retracted: num(t, "retracted")?,
                reach: num(t, "reach")?,
                radius: num(t, "radius")?,
                strike: num(t, "strike")?,
                recover: num(t, "recover")?,
                energy: num(t, "energy")?,
                cost: num(t, "cost")?,
            }),
            None => None,
        },
        plate: match j.get("plate") {
            Some(t) => Some(PlateSpec {
                length: num(t, "length")?,
                half: num(t, "half")?,
                rest: num(t, "rest")?,
                end: num(t, "end")?,
                strike: num(t, "strike")?,
                lower: num(t, "lower")?,
                reload: num(t, "reload")?,
                energy: num(t, "energy")?,
                cost: num(t, "cost")?,
            }),
            None => None,
        },
        field: match j.get("field") {
            Some(f) => Some(FieldSpec {
                margin: num(f, "margin")?,
                radius: num(f, "radius")?,
                contacts: num(f, "contacts")?,
                drain: num(f, "drain")?,
                repel: num(f, "repel")?,
            }),
            None => None,
        },
        flail: match j.get("flail") {
            Some(f) => Some(FlailSpec {
                crank: num(f, "crank")?,
                inertia: num(f, "inertia")?,
                speed: num(f, "speed")?,
                spin_up: num(f, "spinUp")?,
                chain: num(f, "chain")?,
                mass: num(f, "mass")?,
                radius: num(f, "radius")?,
                restitution: num(f, "restitution")?,
                friction: num(f, "friction")?,
                drag: num(f, "drag")?,
            }),
            None => None,
        },
        jaw,
        spin: match j.get("spin") {
            Some(s) => Some(SpinSpec {
                inertia: num(s, "inertia")?,
                speed: num(s, "speed")?,
                spin_up: num(s, "spinUp")?,
                spin_down: num(s, "spinDown")?,
                gyro: num(s, "gyro")?,
                unbalance: num(s, "unbalance")?,
                mass: num(s, "mass")?,
                direction: opt(s, "direction").unwrap_or(1.0),
                reaction: opt(s, "reaction").unwrap_or(1.0),
            }),
            None => None,
        },
        drive: pair(j, "drive", "idle", "stop")?,
        hit: MeleeHit {
            damage_type: h.get("damageType").and_then(Json::str).ok_or("catalogue : coup sans nature de dégâts")?.to_string(),
            damage: num(h, "damage")?,
            bite: num(h, "bite")?,
            fling: num(h, "fling")?,
            push: Push { tangent: num(p, "tangent")?, radial: num(p, "radial")?, axial: num(p, "axial")?, lift: num(p, "lift")? },
            recoil: num(h, "recoil")?,
            spread: num(h, "spread")?,
            wheels: opt(h, "wheels"),
            wear: num(h, "wear")?,
            gap: num(h, "gap")?,
            min_speed: num(h, "minSpeed")?,
            ground: opt(h, "ground"),
            ignite: opt(h, "ignite"),
            stun: pair(h, "stun", "radius", "duration")?,
        },
        quench: j.get("quench").is_some_and(Json::is_true),
        engage: num(j, "engage")?,
    })
}

pub fn read_design(j: &Json) -> Result<Design, String> {
    let mut blocks = Vec::new();
    for b in j.get("blocks").map(Json::arr).unwrap_or(&[]) {
        let facing = b.get("facing");
        let side = |key: &str, default: &str| -> String {
            facing.and_then(|f| f.get(key)).and_then(Json::str).unwrap_or(default).to_string()
        };
        blocks.push(BlockPlacement {
            x: num(b, "x")?,
            y: num(b, "y")?,
            z: num(b, "z")?,
            kind: b.get("type").and_then(Json::str).ok_or("catalogue : bloc sans type")?.to_string(),
            up: side("up", "+y"),
            forward: side("forward", "+z"),
        });
    }
    let mut wheels = Vec::new();
    for w in j.get("wheels").map(Json::arr).unwrap_or(&[]) {
        wheels.push(WheelMount {
            x: num(w, "x")?,
            y: num(w, "y")?,
            z: num(w, "z")?,
            dx: num(w, "dx")?,
            dz: num(w, "dz")?,
            dy: opt(w, "dy"),
            kind: w.get("type").and_then(Json::str).ok_or("catalogue : roue sans type")?.to_string(),
            shift: opt(w, "shift"),
            rise: opt(w, "rise"),
            layer: opt(w, "layer"),
        });
    }
    Ok(Design { blocks, wheels })
}

fn read(text: &str) -> Result<Catalog, String> {
    let root = Json::parse(text)?;
    let c = root.get("constants").ok_or("catalogue : pas de constantes")?;
    let constants = Constants { block_size: num(c, "blockSize")?, plate_thickness: num(c, "plateThickness")?, gravity: num(c, "gravity")? };
    let mut blocks = HashMap::new();
    for (id, b) in root.get("blocks").map(Json::fields).unwrap_or(&[]) {
        blocks.insert(id.clone(), read_block(b)?);
    }
    let mut wheels = HashMap::new();
    for (id, w) in root.get("wheels").map(Json::fields).unwrap_or(&[]) {
        wheels.insert(id.clone(), read_wheel(w)?);
    }
    let mut robots = HashMap::new();
    for (id, r) in root.get("robots").map(Json::fields).unwrap_or(&[]) {
        let mobility = match r.get("mobility").and_then(Json::str) {
            Some("hover") => Mobility::Hover,
            Some("plane") => Mobility::Plane,
            _ => Mobility::Ground,
        };
        let design = read_design(r.get("design").ok_or("catalogue : robot sans plan")?)?;
        let charges = r.get("behavior").and_then(Json::str) == Some("charge");
        robots.insert(id.clone(), Robot { speed: num(r, "speed")?, turn: num(r, "turn")?, mobility, charges, design });
    }
    let mut props = HashMap::new();
    for (id, p) in root.get("props").map(Json::fields).unwrap_or(&[]) {
        props.insert(id.clone(), read_prop(p)?);
    }
    let mut weapons = HashMap::new();
    for (id, w) in root.get("weapons").map(Json::fields).unwrap_or(&[]) {
        weapons.insert(id.clone(), read_weapon(w)?);
    }
    let mut melee = HashMap::new();
    for (id, m) in root.get("melee").map(Json::fields).unwrap_or(&[]) {
        melee.insert(id.clone(), read_melee(m)?);
    }
    Ok(Catalog { constants, blocks, wheels, robots, props, weapons, melee })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lit_le_catalogue() {
        let c = catalog();
        assert_eq!(c.constants.block_size, 0.5);
        assert_eq!(c.constants.gravity, 9.81);
        assert_eq!(c.blocks["cockpit"].mass, 1.0);
        assert_eq!(c.blocks["wing"].shape, BlockShape::Plate);
        assert!(c.blocks["cannonTurret"].turret.is_some());
        assert_eq!(c.wheels["steered"].steering, Some((0.6, 1.6)));
        assert!(c.wheels["track"].track);
        let tank = &c.robots["tank"];
        assert_eq!(tank.design.wheels.len(), 10);
        assert_eq!(tank.mobility, Mobility::Ground);
        assert!(tank.charges && !c.robots["scarab"].charges);
        assert_eq!(c.blocks["radar"].radar, 120.0);
        assert_eq!(c.blocks["jammer"].jammer, Some(25.0));
        assert_eq!((c.blocks["cockpit"].radar, c.blocks["cockpit"].jammer), (0.0, None));
        let barrel = &c.props["barrel"];
        assert_eq!(barrel.shape, PropShape::Cylinder { radius: 0.35, half_height: 0.5 });
        assert_eq!(barrel.fuse, 0.25);
        assert_eq!(barrel.explosion.map(|e| e.ignite), Some(0.5));
        assert_eq!(c.props["gas"].vent, Some((600.0, 1.6)));
        assert!(c.props["pine"].anchored && c.props["pine"].topples == 0.5);
        assert_eq!(c.props["crate"].burns, Some((9.0, 0.2)));
        let repair = c.blocks["repairModule"].repair.expect("module de réparation");
        assert_eq!((repair.rate, repair.radius, repair.delay), (20.0, 3.0, 3.0));
        let napalm = c.weapons["fireMine"].explosion.expect("explosion de la mine incendiaire");
        assert_eq!(napalm.puddle, Some(Puddle { radius: 2.4, life: 7.0 }));
        assert_eq!(c.weapons["flamer"].puddle, Some(Puddle { radius: 0.9, life: 4.0 }));
        assert_eq!(c.weapons["emp"].projectile.emp, Some(EmpPulse { radius: 4.5, duration: 4.0 }));
        assert_eq!(c.weapons["smokeMine"].projectile.smoke, Some(SmokeSpec { radius: 7.0, duration: 14.0 }));
        let action = |w: &str| c.weapons[w].projectile.mine.as_ref().and_then(|m| m.action.clone());
        assert_eq!(action("bounceMine"), Some(MineAction::Bounce(1.6)));
        assert_eq!(action("stickyMine"), Some(MineAction::Stick(2.0)));
        assert_eq!(action("aaMine"), Some(MineAction::Launch("flak".into())));
        let beam = c.weapons["repair"].projectile.repair.expect("rayon réparateur");
        assert_eq!((beam.amount, beam.radius, beam.drain, beam.steal, beam.swarm), (7.0, 1.2, 6.0, 0.8, None));
        assert_eq!(c.weapons["nanites"].projectile.repair.and_then(|r| r.swarm), Some(8.0));
        assert_eq!(c.weapons["barrier"].projectile.barrier.map(|b| (b.width, b.hp, b.reach)), Some((4.5, 700.0, 5.0)));
        // (aucun accessoire ne laisse de flaque : c'est l'affaire des armes)
        assert!(c.props.values().all(|p| p.explosion.is_none_or(|e| e.puddle.is_none())));
    }
}
