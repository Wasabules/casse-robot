//! Les débris (src/shared/combat/debris.ts) : un bloc détruit devient un petit cube projeté, qui ne
//! heurte que le décor fixe et disparaît au bout de quelques secondes. Ce sont des corps du monde :
//! leur création et leur retrait comptent dans l'ordre des corps de Rapier, et leur élan, tiré au
//! hasard, dans la suite des tirages ; ils sont donc portés aussi exactement que le reste.

use super::catalog::{BlockShape, catalog};
use super::physics::{BodyDesc, ColliderDesc, ShapeDesc, groups};
use super::shapes::shape_fraction;
use super::vec::{V3, add, qrot, scale, v3};
use super::world::{Owner, Sim};
use super::events::{Writer, code};
use rapier3d::prelude::{ColliderHandle, RigidBodyHandle};

/// Côté du collider d'un débris (m) : un peu moins de la moitié d'un bloc (`DEBRIS_SIZE`).
const DEBRIS_FACTOR: f64 = 0.46;
/// Nombre de débris au plus (`MAX_DEBRIS`) : au-delà, les plus vieux disparaissent.
const MAX_DEBRIS: usize = 220;

/// L'allure d'un débris (`DebrisLook`) : un bloc (son type, et le robot dont il vient : sa couleur),
/// ou l'éclat d'un accessoire (son type, son côté s'il en a un).
#[derive(Clone, Debug)]
pub enum DebrisLook {
    Block { kind: String, bot: usize },
    Prop { kind: String, size: Option<f64> },
}

pub struct Debris {
    /// Son numéro d'entité (`id`, `sim.nextId()`) et son allure.
    pub id: u64,
    pub look: DebrisLook,
    pub rb: RigidBodyHandle,
    pub collider: ColliderHandle,
    pub born: f64,
    pub life: f64,
}

/// Densité de la matière d'un bloc (`blockDensity`) : sa masse rapportée à son volume.
pub fn block_density(kind: &str) -> f64 {
    let c = catalog();
    let bs = c.constants.block_size;
    let def = &c.blocks[kind];
    let volume = match &def.shape {
        BlockShape::Plate => bs * bs * c.constants.plate_thickness,
        BlockShape::Shaped(s) => crate::det::dpow(bs, 3.0) * shape_fraction(s).unwrap_or(1.0),
        BlockShape::Cube => crate::det::dpow(bs, 3.0) * 1.0,
    };
    def.mass / volume
}

/// Position d'un bloc dans le monde, d'après le morceau qui le porte (`blockWorldPos`).
pub fn block_world_pos(sim: &Sim, bot: usize, block: usize) -> V3 {
    let b = &sim.bots[bot].blocks[block];
    let rb = sim.part(b.part).rb;
    add(sim.phys.translation(rb), qrot(sim.phys.rotation(rb), b.local))
}

/// Remplace un bloc détruit par un petit cube projeté (`spawnDebris`) : `vel`, la vitesse du bloc
/// juste avant le choc ; `dir`, la direction du coup.
pub fn spawn_debris(sim: &mut Sim, bot: usize, block: usize, vel: V3, dir: V3) {
    let p = block_world_pos(sim, bot, block);
    let b = &sim.bots[bot].blocks[block];
    let rot = sim.phys.rotation(sim.part(b.part).rb);
    let density = block_density(&b.kind);
    let look = DebrisLook::Block { kind: b.kind.clone(), bot };
    spawn_fragment(sim, look, p, rot, density, vel, dir);
}

/// Un éclat projeté depuis `p` à la vitesse `vel`, poussé dans la direction `dir` avec un peu de
/// hasard (`spawnFragment`) : un petit cube, ou un morceau de mur ou de tronc de côté `size`.
pub fn spawn_fragment(sim: &mut Sim, look: DebrisLook, p: V3, rot: super::vec::Q, density: f64, vel: V3, dir: V3) {
    let size = match look {
        DebrisLook::Prop { size, .. } => size.filter(|&s| s != 0.0),
        DebrisLook::Block { .. } => None,
    };
    let half = size.unwrap_or(catalog().constants.block_size * DEBRIS_FACTOR) / 2.0;
    let rb = sim.phys.create_body(&BodyDesc::dynamic(p, rot));
    let desc = ColliderDesc { density, friction: 0.6, restitution: 0.1, collision_groups: groups::DEBRIS_GROUP, ..ColliderDesc::new(ShapeDesc::Cuboid(half, half, half)) };
    let collider = sim.phys.create_collider(&desc, rb).expect("collider de débris refusé");
    // (les arguments se calculent de gauche à droite, comme en JavaScript)
    let push = 2.0 + sim.rng.random() * 2.0;
    let (kx, ky, kz) = (sim.rng.rand(-1.5, 1.5), sim.rng.rand(1.5, 4.0), sim.rng.rand(-1.5, 1.5));
    let kick = add(scale(dir, push), v3(kx, ky, kz));
    sim.phys.set_linvel(rb, add(vel, kick), true);
    let (ax, ay, az) = (sim.rng.rand(-6.0, 6.0), sim.rng.rand(-6.0, 6.0), sim.rng.rand(-6.0, 6.0));
    sim.phys.set_angvel(rb, v3(ax, ay, az), true);
    sim.owners.insert(collider, Owner::Debris);
    let id = sim.next_id();
    let life = sim.rng.rand(4.0, 6.0);
    let born = sim.time;
    sim.debris.push(Debris { id, look, rb, collider, born, life });
    sim.emit(code::DEBRIS_ADDED, |s, w| {
        write_debris(s, w, s.debris.last().expect("débris"));
    });
    while sim.debris.len() > MAX_DEBRIS {
        let d = sim.debris.remove(0);
        remove_debris(sim, &d);
    }
}

/// Retire un débris du monde (`removeDebris`).
fn remove_debris(sim: &mut Sim, d: &Debris) {
    sim.owners.remove(&d.collider);
    sim.phys.remove_body(d.rb);
    sim.emit_gone(code::DEBRIS_REMOVED, d.id);
}

/// Retire tous les débris (`clearDebris`).
pub fn clear_debris(sim: &mut Sim) {
    for d in std::mem::take(&mut sim.debris) {
        remove_debris(sim, &d);
    }
}

/// Un débris tel que l'encodeur le décrit (`debrisAdded`, et la description du monde) : son numéro,
/// son allure (un bloc : son type et le profil du robot dont il vient, d'où sa couleur ; un éclat : son
/// type et son côté, NaN s'il n'en a pas), sa naissance et sa durée.
pub fn write_debris(s: &Sim, w: &mut Writer, d: &Debris) {
    w.id(Some(d.id));
    match &d.look {
        DebrisLook::Block { kind, bot } => {
            w.num(0.0).text(kind).num(s.bots[*bot].profile as f64);
        }
        DebrisLook::Prop { kind, size } => {
            w.num(1.0).text(kind).num(size.unwrap_or(f64::NAN));
        }
    }
    w.num(d.born).num(d.life);
}

/// Retire les débris arrivés en fin de vie (`expireDebris`).
pub fn expire_debris(sim: &mut Sim) {
    let all = std::mem::take(&mut sim.debris);
    let mut alive = Vec::with_capacity(all.len());
    for d in all {
        if sim.time - d.born > d.life {
            remove_debris(sim, &d);
        } else {
            alive.push(d);
        }
    }
    sim.debris = alive;
}
