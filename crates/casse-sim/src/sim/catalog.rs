//! Les catalogues du jeu, lus dans content/catalog.json (incorporé au module) : ce qu'il faut à la
//! simulation portée des blocs (masse, forme, tourelle…), des roues, des robots préfabriqués (leurs
//! plans) et des accessoires (forme, masse, résistances, explosion, mèche, fuite, bois…). Le
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

/// Tourelle (`TurretSpec`) : ce qu'il faut pour ses zones touchables (colliders.ts, `addHeads`).
#[derive(Clone, Debug)]
pub struct TurretSpec {
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
    /// Les organes que la simulation portée ne sait pas encore faire marcher : un robot qui en a
    /// est refusé (robot.rs).
    pub melee: bool,
    pub thruster: bool,
    pub support: bool,
    pub aero: bool,
    pub battery: f64,
    /// Solidité de ses liaisons (`bond`, robot/structure.ts).
    pub bond: f64,
    /// Facteurs des dégâts par nature (`resist` ; absent : 1).
    pub resist: HashMap<String, f64>,
    /// Générateur de bouclier (`shield`) : rayon (m), part absorbée, coût (kJ par point).
    pub shield: Option<Shield>,
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

/// Explosion (`Explosion`, catalog/weapons.ts) : ce qu'il en faut à la simulation (pas son allure).
#[derive(Clone, Copy, Debug)]
pub struct Explosion {
    pub radius: f64,
    pub damage: f64,
    pub blast_radius: f64,
    pub power: f64,
    pub lift: f64,
    /// Part des blocs touchés qu'elle enflamme (`ignite` ; absent : 0).
    pub ignite: f64,
    /// Elle laisse une flaque de feu (le napalm) : pas encore portée.
    pub puddle: bool,
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
        melee: j.get("melee").is_some(),
        thruster: j.get("thruster").is_some(),
        support: j.get("support").is_some(),
        aero: j.get("aero").is_some(),
        battery: j.get("battery").and_then(|b| opt(b, "capacity")).unwrap_or(0.0),
        bond: num(j, "bond")?,
        resist: j.get("resist").map(Json::fields).unwrap_or(&[]).iter().filter_map(|(k, v)| Some((k.clone(), v.num()?))).collect(),
        shield: match j.get("shield") {
            Some(s) => Some(Shield { radius: num(s, "radius")?, absorb: num(s, "absorb")?, cost: num(s, "cost")? }),
            None => None,
        },
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
    Ok(Explosion {
        radius: num(j, "radius")?,
        damage: num(j, "damage")?,
        blast_radius: num(j, "blastRadius")?,
        power: num(j, "power")?,
        lift: num(j, "lift")?,
        ignite: opt(j, "ignite").unwrap_or(0.0),
        puddle: j.get("puddle").is_some(),
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

fn read_design(j: &Json) -> Result<Design, String> {
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
        robots.insert(id.clone(), Robot { speed: num(r, "speed")?, turn: num(r, "turn")?, mobility, design });
    }
    let mut props = HashMap::new();
    for (id, p) in root.get("props").map(Json::fields).unwrap_or(&[]) {
        props.insert(id.clone(), read_prop(p)?);
    }
    Ok(Catalog { constants, blocks, wheels, robots, props })
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
        let barrel = &c.props["barrel"];
        assert_eq!(barrel.shape, PropShape::Cylinder { radius: 0.35, half_height: 0.5 });
        assert_eq!(barrel.fuse, 0.25);
        assert_eq!(barrel.explosion.map(|e| e.ignite), Some(0.5));
        assert_eq!(c.props["gas"].vent, Some((600.0, 1.6)));
        assert!(c.props["pine"].anchored && c.props["pine"].topples == 0.5);
        assert_eq!(c.props["crate"].burns, Some((9.0, 0.2)));
    }
}
