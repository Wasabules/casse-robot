//! Les accessoires du décor (src/shared/arena/props.ts, structures.ts ; leurs dimensions :
//! src/shared/catalog/props.ts) : des corps qu'on pousse, qu'on casse, et qui réagissent. Une caisse
//! se brise en éclats, un baril s'allume puis explose (et fait sauter ses voisins), une bouteille de
//! gaz percée fuit, s'envole en tournoyant puis saute. Les accessoires ancrés (murs, arbres) sont des
//! corps fixes : un arbre qui cède bascule, un toit dont les appuis ont disparu tombe, et un robot
//! lancé qui brise un accessoire ancré passe au travers (collisions.rs, `breach_of`).
//!
//! Comme les robots, les accessoires sont créés, poussés et retirés au même moment et dans le même
//! ordre que dans le TypeScript ; l'arène (ses emplacements) est donnée par l'appelant.

use super::catalog::{PropDef, PropShape, catalog};
use super::debris::{DebrisLook, spawn_fragment};
use super::events::code;
use super::explosion::explode;
use super::fire::ignite_prop;
use super::physics::{BodyDesc, CONTACT_FORCE_EVENTS, ColliderDesc, ShapeDesc, groups};
use super::robot::CONTACT_FORCE_THRESHOLD;
use super::vec::{NO_ROTATION, Q, V3, add, clamp, cross, len, norm, qrot, qrot_inv, scale, sub, v3};
use super::world::{Owner, STEP, Sim};
use crate::det::{dcos, dpow, dsin};
use crate::jsmath;
use rapier3d::prelude::{ColliderHandle, RigidBodyHandle};

/// Un accessoire ancré est enfoncé de SINK m dans le sol (`spotPose`, arena/layout.ts).
const SINK: f64 = 0.05;
/// Nombre d'éclats d'un accessoire qui se brise ; un grand pan de mur en donne davantage.
const SHARDS: f64 = 5.0;
const MAX_SHARDS: f64 = 14.0;
const SHARD_AREA: f64 = 1.2;
/// Vitesse de rotation d'un arbre qui commence à basculer, et au plus d'un arbre couché par un robot (rad/s).
const TOPPLE_SPIN: f64 = 0.5;
const FELL_SPIN_MAX: f64 = 2.5;
/// Temps (s) pendant lequel un arbre couché par un robot ne heurte pas les robots.
const FELLED_PASS: f64 = 1.6;
const UP: V3 = v3(0.0, 1.0, 0.0);

/// Après la rupture : intact, mèche qui brûle (baril), gaz qui fuit par un trou du flanc (bouteille).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PropState {
    Intact,
    Fuse { left: f64 },
    Venting { left: f64, leak: V3 },
}

/// Un accessoire (`Prop`, src/shared/sim/entities.ts).
pub struct Prop {
    /// Son numéro d'entité (`id`, `sim.nextId()`).
    pub id: u64,
    pub kind: String,
    pub rb: RigidBodyHandle,
    pub collider: ColliderHandle,
    /// Demi-dimensions : boîte ou dalle ; pour un cylindre, (rayon, demi-hauteur, rayon).
    pub half: V3,
    pub fixed: bool,
    pub hp: f64,
    pub state: PropState,
    /// Feu : secondes qu'il brûlera encore (0 : il ne brûle pas) ; part noircie.
    pub burn: f64,
    pub charred: f64,
    /// Brisé par un robot qui passe au travers : la vitesse de ses éclats.
    pub struck: Option<V3>,
    /// Couché par un robot : jusqu'à ce temps, il ne heurte pas les robots (0 : non).
    pub yielding: f64,
    /// Ce sur quoi il repose (`PropSpot.rests` : des emplacements).
    pub rests: Vec<usize>,
    /// Sa place dans l'arène (`spot.pos`) : un accessoire ancré ne bouge pas, une lame l'écarte d'après elle.
    pub spot: V3,
}

impl Prop {
    pub fn def(&self) -> &'static PropDef {
        &catalog().props[&self.kind]
    }

    pub fn cylinder(&self) -> bool {
        matches!(self.def().shape, PropShape::Cylinder { .. })
    }

    /// Forme de son collider (`ColliderDesc.cylinder(half.y, half.x)` ou `.cuboid(…)`).
    pub fn shape(&self) -> ShapeDesc {
        let h = self.half;
        if self.cylinder() { ShapeDesc::Cylinder(h.y, h.x) } else { ShapeDesc::Cuboid(h.x, h.y, h.z) }
    }
}

/// Demi-dimensions d'un accessoire posé debout (`propHalf`) : `half`, celles de son emplacement (une
/// dalle) ; `scale`, son échelle (un cylindre).
pub fn prop_half(def: &PropDef, half: Option<V3>, scale: Option<f64>) -> V3 {
    let s = scale.unwrap_or(1.0);
    match def.shape {
        PropShape::Box(h) => v3(h, h, h),
        PropShape::Cylinder { radius, half_height } => v3(radius * s, half_height * s, radius * s),
        PropShape::Slab => half.unwrap_or(v3(0.5, 0.5, 0.5)),
    }
}

/// Volume (m³) d'un accessoire de ces demi-dimensions (`propVolume`).
pub fn prop_volume(def: &PropDef, half: V3) -> f64 {
    match def.shape {
        PropShape::Cylinder { .. } => std::f64::consts::PI * half.x * half.x * 2.0 * half.y,
        _ => 8.0 * half.x * half.y * half.z,
    }
}

/// Masse (kg) d'un accessoire de ces demi-dimensions (`propMass`).
pub fn prop_mass(def: &PropDef, half: V3) -> f64 {
    match def.shape {
        PropShape::Slab => def.mass * prop_volume(def, half),
        PropShape::Box(nominal) | PropShape::Cylinder { radius: nominal, .. } => def.mass * dpow(half.x / nominal, 3.0),
    }
}

/// Les deux plus grandes demi-dimensions (`[x, y, z].sort((p, q) => q - p)`).
fn largest_two(h: V3) -> (f64, f64) {
    let mut s = [h.x, h.y, h.z];
    s.sort_by(|p, q| q.partial_cmp(p).unwrap_or(std::cmp::Ordering::Equal));
    (s[0], s[1])
}

/// Points de structure de départ d'un accessoire de ces demi-dimensions (`propHp`).
pub fn prop_hp(def: &PropDef, half: V3) -> f64 {
    match def.shape {
        PropShape::Slab => {
            let (a, b) = largest_two(half);
            jsmath::round(def.hp * 4.0 * a * b)
        }
        PropShape::Box(nominal) | PropShape::Cylinder { radius: nominal, .. } => jsmath::round(def.hp * dpow(half.x / nominal, 2.0)),
    }
}

/// Les accessoires présents, dans l'ordre de `sim.props` (celui de leurs emplacements).
pub fn present(sim: &Sim) -> Vec<usize> {
    (0..sim.props.len()).filter(|&i| sim.props[i].is_some()).collect()
}

/// Crée l'accessoire de l'emplacement suivant (`createProp`) : `kind`, son type ; `pos`, `rot`, sa
/// pose ; `half`, `scale`, ce que l'emplacement donne ; son numéro (celui de l'emplacement).
pub fn add_prop(sim: &mut Sim, kind: &str, pos: V3, rot: Option<Q>, half: Option<V3>, scale: Option<f64>) -> Result<usize, String> {
    let def = catalog().props.get(kind).ok_or_else(|| format!("accessoire inconnu : {kind}"))?;
    let half = prop_half(def, half, scale);
    let fixed = def.anchored;
    let at = if fixed { v3(pos.x, pos.y - SINK, pos.z) } else { pos };
    let rot = rot.unwrap_or(NO_ROTATION);
    let rb = sim.phys.create_body(&if fixed { BodyDesc::fixed(at, rot) } else { BodyDesc::dynamic(at, rot) });
    let shape = if matches!(def.shape, PropShape::Cylinder { .. }) { ShapeDesc::Cylinder(half.y, half.x) } else { ShapeDesc::Cuboid(half.x, half.y, half.z) };
    let desc = ColliderDesc {
        density: prop_mass(def, half) / prop_volume(def, half),
        friction: def.friction,
        collision_groups: groups::PROP_GROUP,
        active_events: CONTACT_FORCE_EVENTS,
        contact_force_event_threshold: CONTACT_FORCE_THRESHOLD,
        ..ColliderDesc::new(shape)
    };
    let collider = sim.phys.create_collider(&desc, rb).ok_or("collider d'accessoire refusé")?;
    let id = sim.next_id();
    let i = sim.props.len();
    sim.props.push(Some(Prop {
        id,
        kind: kind.to_string(),
        rb,
        collider,
        half,
        fixed,
        hp: prop_hp(def, half),
        state: PropState::Intact,
        burn: 0.0,
        charred: 0.0,
        struck: None,
        yielding: 0.0,
        rests: Vec::new(),
        spot: pos,
    }));
    sim.owners.insert(collider, Owner::Prop(i));
    sim.emit(code::PROP_ADDED, |_, w| {
        w.id(Some(id)).text(kind).num(i as f64).flag(fixed);
    });
    Ok(i)
}

pub fn prop(sim: &Sim, i: usize) -> &Prop {
    sim.props[i].as_ref().expect("accessoire retiré")
}

pub fn prop_mut(sim: &mut Sim, i: usize) -> &mut Prop {
    sim.props[i].as_mut().expect("accessoire retiré")
}

/// Retire un accessoire ; ce qui reposait sur lui tombe (`removeProp`).
pub fn remove_prop(sim: &mut Sim, i: usize, collapse: bool) {
    // (retiré en brûlant : son feu disparaît avec lui, sans extinction)
    sim.prop_fires.retain(|&p| p != i);
    let p = sim.props[i].take().expect("accessoire retiré");
    sim.owners.remove(&p.collider);
    sim.phys.remove_body(p.rb);
    sim.stats.props_removed += 1;
    sim.emit_gone(code::PROP_REMOVED, p.id);
    if collapse {
        drop_unsupported(sim, i);
    }
}

/// Un pas de vie des accessoires qui ont cédé (`updateProps`) : la mèche d'un baril brûle ; une
/// bouteille percée est propulsée par le jet de gaz qui fuit par un trou de son flanc, en
/// tournoyant, jusqu'à exploser. Et un arbre couché redevient un obstacle, sa chute finie.
pub fn update_props(sim: &mut Sim) {
    for i in present(sim) {
        if sim.props[i].is_none() {
            continue;
        }
        if prop(sim, i).yielding != 0.0 {
            restore_felled(sim, i);
        }
        let p = prop(sim, i);
        let left = match p.state {
            PropState::Intact => continue,
            PropState::Fuse { left } => left,
            PropState::Venting { left, leak } => {
                if let Some((thrust, _)) = p.def().vent {
                    // Le gaz jaillit par le trou du flanc : la bouteille part à l'opposé, un peu de
                    // biais (elle tournoie) et vers le haut (elle décolle)
                    let rb = p.rb;
                    let q = sim.phys.rotation(rb);
                    let hole = add(sim.phys.translation(rb), scale(qrot(q, leak), p.half.x));
                    let push = qrot(q, add(scale(leak, -0.8), add(scale(cross(UP, leak), 0.5), v3(0.0, 0.45, 0.0))));
                    sim.phys.apply_impulse_at_point(rb, scale(norm(push), thrust * STEP), hole, true);
                }
                left
            }
        };
        let left = left - STEP;
        let p = prop_mut(sim, i);
        match &mut p.state {
            PropState::Fuse { left: l } | PropState::Venting { left: l, .. } => *l = left,
            PropState::Intact => {}
        }
        if left <= 0.0 {
            detonate(sim, i);
        }
    }
}

/// Un robot est-il dans l'accessoire ? (son volume, à sa pose) (`robotInside`)
fn robot_inside(sim: &Sim, i: usize) -> bool {
    let p = prop(sim, i);
    let (pos, rot) = (sim.phys.translation(p.rb), sim.phys.rotation(p.rb));
    let owners = &sim.owners;
    let robot = |c: ColliderHandle| matches!(owners.get(&c), Some(Owner::Part(_) | Owner::Wheel(..) | Owner::Head(..) | Owner::Blade(..)));
    sim.phys.intersects_shape(pos, rot, &p.shape(), &robot)
}

/// Fin d'un accessoire (`detonate`) : il explose, se brise en éclats, ou les deux.
fn detonate(sim: &mut Sim, i: usize) {
    let p = prop(sim, i);
    let def = p.def();
    let (rb, h) = (p.rb, p.half);
    let at = sim.phys.translation(rb);
    let rot = sim.phys.rotation(rb);
    // Brisé par un robot qui passe au travers : ses éclats partent devant lui
    let vel = p.struck.unwrap_or_else(|| sim.phys.linvel(rb));
    let kind = p.kind.clone();
    remove_prop(sim, i, true);
    if def.shatters {
        let (a, b) = largest_two(h);
        let count = jsmath::round(clamp((4.0 * a * b) / SHARD_AREA, SHARDS, MAX_SHARDS)) as usize;
        let density = prop_mass(def, h) / prop_volume(def, h);
        for _ in 0..count {
            // Répartis dans tout le volume : un pan de mur s'effondre sur toute sa largeur
            let lx = sim.rng.rand(-h.x, h.x) * 0.9;
            let ly = sim.rng.rand(-h.y, h.y) * 0.9;
            let lz = sim.rng.rand(-h.z, h.z) * 0.9;
            let offset = qrot(rot, v3(lx, ly, lz));
            // Une dalle ou un tronc part en gros morceaux ; une caisse, en petits éclats
            let size = if matches!(def.shape, PropShape::Box(_)) { None } else { Some(sim.rng.rand(0.3, 0.6)) };
            let look = DebrisLook::Prop { kind: kind.clone(), size };
            spawn_fragment(sim, look, add(at, offset), rot, jsmath::min(density, 2000.0), vel, scale(norm(offset), 1.5));
        }
    }
    if let Some(ex) = def.explosion {
        explode(sim, at, &ex, UP, at, None, Some("blast"));
    }
}

/// Un accessoire perd des points de structure (`damageProp`) ; à 0, sa mèche s'allume (baril), son
/// gaz fuit (bouteille), il prend feu puis explose (voiture), il bascule (un arbre debout, du côté de
/// `dir`) ou il se brise (caisse, mur). Une bouteille qui fuit et qu'on touche encore saute aussitôt.
pub fn damage_prop(sim: &mut Sim, i: usize, amount: f64, dir: V3) {
    let p = prop_mut(sim, i);
    let def = p.def();
    p.hp -= amount;
    if p.hp > 0.0 {
        return;
    }
    if def.topples != 0.0 && p.fixed {
        topple_prop(sim, i, dir);
        return;
    }
    match p.state {
        PropState::Intact => {
            if let Some((_, duration)) = def.vent {
                // (le trou est quelque part sur le flanc)
                let angle = sim.rng.rand(0.0, std::f64::consts::PI * 2.0);
                prop_mut(sim, i).state = PropState::Venting { left: duration, leak: v3(dcos(angle), 0.0, dsin(angle)) };
            } else {
                p.state = PropState::Fuse { left: def.fuse };
                // Ce qui brûle et a une longue mèche (une voiture) flambe en attendant d'exploser
                if def.burns.is_some() && def.fuse > 0.0 {
                    ignite_prop(sim, i);
                }
            }
        }
        PropState::Venting { .. } => p.state = PropState::Fuse { left: 0.0 },
        PropState::Fuse { .. } => {}
    }
}

/// Libère un accessoire ancré : son corps devient mobile, et tombe (`releaseProp`).
pub fn release_prop(sim: &mut Sim, i: usize) {
    let p = prop_mut(sim, i);
    if !p.fixed {
        return;
    }
    p.fixed = false;
    let (rb, id) = (p.rb, p.id);
    sim.phys.set_dynamic(rb, true);
    sim.stats.props_released += 1;
    sim.emit_gone(code::PROP_RELEASED, id);
}

/// Un arbre qui cède bascule du côté de `dir` (`toppleProp`) : libéré, il garde une part de ses
/// points de structure ; s'il cède encore, il se brise.
fn topple_prop(sim: &mut Sim, i: usize, dir: V3) {
    release_prop(sim, i);
    let p = prop_mut(sim, i);
    let def = p.def();
    p.hp = prop_hp(def, p.half) * def.topples;
    let flat = v3(dir.x, 0.0, dir.z);
    let toward = if len(flat) > 1e-3 { norm(flat) } else { v3(1.0, 0.0, 0.0) };
    // Il pivote sur sa base : tourner autour de haut × direction penche la cime vers la direction
    let (rb, hy) = (p.rb, p.half.y);
    sim.phys.set_angvel(rb, scale(cross(UP, toward), TOPPLE_SPIN), true);
    sim.phys.set_linvel(rb, scale(toward, TOPPLE_SPIN * hy), true);
}

/// Un arbre qu'un robot vient d'abattre en passant au travers (`fellProp`) : il tombe dans le sens
/// de la course (`dir`), d'autant plus vite que le robot garde de vitesse (`speed`), et le laisse
/// passer le temps de sa chute.
pub fn fell_prop(sim: &mut Sim, i: usize, dir: V3, speed: f64) {
    let time = sim.time;
    let p = prop_mut(sim, i);
    let flat = v3(dir.x, 0.0, dir.z);
    let toward = if len(flat) > 1e-3 { norm(flat) } else { v3(1.0, 0.0, 0.0) };
    let spin = clamp(speed / jsmath::max(1.0, p.half.y), TOPPLE_SPIN, FELL_SPIN_MAX);
    p.yielding = time + FELLED_PASS;
    let (rb, collider, hy) = (p.rb, p.collider, p.half.y);
    sim.phys.set_angvel(rb, scale(cross(UP, toward), spin), true);
    sim.phys.set_linvel(rb, scale(toward, spin * hy), true);
    sim.phys.set_collision_groups(collider, groups::FELLED);
}

/// Un arbre couché qui laissait passer les robots redevient un obstacle, sa chute finie : pas tant
/// qu'un robot est dedans (`restoreFelled`).
fn restore_felled(sim: &mut Sim, i: usize) {
    let yielding = prop(sim, i).yielding;
    if yielding == 0.0 || sim.time < yielding || robot_inside(sim, i) {
        return;
    }
    let p = prop_mut(sim, i);
    p.yielding = 0.0;
    let collider = p.collider;
    sim.phys.set_collision_groups(collider, groups::PROP_GROUP);
}

/// Les accessoires ancrés qui reposaient sur l'emplacement `spot` et dont plus aucun appui ne tient
/// tombent (`dropUnsupported`).
fn drop_unsupported(sim: &mut Sim, spot: usize) {
    let standing = present(sim);
    for i in standing.clone() {
        let p = prop(sim, i);
        if !p.fixed || !p.rests.contains(&spot) {
            continue;
        }
        if !p.rests.iter().any(|r| standing.contains(r)) {
            release_prop(sim, i);
        }
    }
}

/// Distance (m) d'un point à la surface d'un accessoire, 0 dedans (`propDistance`).
pub fn prop_distance(sim: &Sim, i: usize, point: V3) -> f64 {
    let p = prop(sim, i);
    let q = sim.phys.rotation(p.rb);
    let local = qrot_inv(q, sub(point, sim.phys.translation(p.rb)));
    let h = p.half;
    if p.cylinder() {
        let radial = jsmath::hypot2(local.x, local.z);
        let out = jsmath::max(0.0, radial - h.x);
        let dy = jsmath::max(0.0, local.y.abs() - h.y);
        return jsmath::hypot2(out, dy);
    }
    let nearest = v3(clamp(local.x, -h.x, h.x), clamp(local.y, -h.y, h.y), clamp(local.z, -h.z, h.z));
    len(sub(local, nearest))
}

/// Le point de l'accessoire le plus proche de `point`, dans le monde (`propNearest`).
pub fn prop_nearest(sim: &Sim, i: usize, point: V3) -> V3 {
    let p = prop(sim, i);
    let q = sim.phys.rotation(p.rb);
    let center = sim.phys.translation(p.rb);
    let local = qrot_inv(q, sub(point, center));
    let h = p.half;
    let nearest = v3(clamp(local.x, -h.x, h.x), clamp(local.y, -h.y, h.y), clamp(local.z, -h.z, h.z));
    add(center, qrot(q, nearest))
}
