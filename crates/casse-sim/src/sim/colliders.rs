//! Les colliders d'un morceau (src/shared/robot/colliders.ts) : les cubes voisins de même type
//! fusionnés en boîtes (fusion gloutonne, dans un ordre fixe), les plaques et les blocs de forme
//! chacun les leurs, puis les zones touchables des têtes de tourelle ; refaits quand ses blocs
//! changent (`rebuildColliders`, `rebuildDirtyParts`). Et le bloc touché en un point (`blockAt`).

use super::catalog::{BlockShape, Fixed, catalog};
use super::physics::{CONTACT_FORCE_EVENTS, ColliderDesc, ShapeDesc, groups};
use super::robot::{BLOCK_FRICTION, BLOCK_RESTITUTION, CONTACT_FORCE_THRESHOLD, Cell};
use super::shapes::shape_pieces;
use super::vec::{NO_ROTATION, Q, V3, add, axis_angle, qmul, qrot, qrot_inv, scale, sub, v3};
use super::world::{Owner, Sim};
use std::collections::{HashMap, HashSet};

/// Zones touchables des têtes de tourelle (colliders.ts).
const HITBOX_SHARE: f64 = 0.9;
const MIN_CALIBER: f64 = 0.1;

/// Reconstruit les colliders d'un morceau (`rebuildColliders`) : les anciens retirés (sans réveiller
/// le corps), les nouveaux créés dans l'ordre du TypeScript, la masse recalculée tout de suite.
pub fn rebuild_colliders(sim: &mut Sim, p: usize) {
    let old = std::mem::take(&mut sim.part_mut(p).colliders);
    for c in old {
        sim.owners.remove(&c);
        sim.phys.remove_collider(c, false);
    }
    sim.part_mut(p).dirty = false;

    let c = catalog();
    let bs = c.constants.block_size;
    let block_half = bs * 0.49;
    let bot = sim.part(p).bot;
    let rb = sim.part(p).rb;

    let mut cubes: HashMap<Cell, usize> = HashMap::new();
    let mut order: Vec<usize> = Vec::new();
    for b in sim.part(p).blocks.clone() {
        let block = &sim.bots[bot].blocks[b];
        match &c.blocks[&block.kind].shape {
            BlockShape::Plate => add_plate(sim, p, b, block_half),
            BlockShape::Shaped(shape) => add_shape(sim, p, b, shape, block_half),
            BlockShape::Cube => {
                cubes.insert(block.cell(), b);
                order.push(b);
            }
        }
    }
    let blocks = &sim.bots[bot].blocks;
    let mut used: HashSet<usize> = HashSet::new();
    // (le tri du TypeScript : x, puis y, puis z ; les cases sont toutes différentes)
    order.sort_by(|&a, &b| {
        let (a, b) = (&blocks[a], &blocks[b]);
        (a.x, a.y, a.z).partial_cmp(&(b.x, b.y, b.z)).unwrap()
    });
    let free = |used: &HashSet<usize>, x: f64, y: f64, z: f64, kind: &str| -> bool {
        match cubes.get(&(x as i64, y as i64, z as i64)) {
            Some(&b) => blocks[b].kind == kind && !used.contains(&b),
            None => false,
        }
    };
    let mut boxes: Vec<(String, [f64; 3], [f64; 3])> = Vec::new();
    for &start in &order {
        if used.contains(&start) {
            continue;
        }
        let s = &blocks[start];
        let (x, y, z, kind) = (s.x, s.y, s.z, s.kind.as_str());
        let mut x1 = x;
        while free(&used, x1 + 1.0, y, z, kind) {
            x1 += 1.0;
        }
        let mut y1 = y;
        while range(x, x1).all(|i| free(&used, i, y1 + 1.0, z, kind)) {
            y1 += 1.0;
        }
        let mut z1 = z;
        while range(x, x1).all(|i| range(y, y1).all(|j| free(&used, i, j, z1 + 1.0, kind))) {
            z1 += 1.0;
        }
        for i in range(x, x1) {
            for j in range(y, y1) {
                for k in range(z, z1) {
                    used.insert(cubes[&(i as i64, j as i64, k as i64)]);
                }
            }
        }
        boxes.push((kind.to_string(), [x, y, z], [x1, y1, z1]));
    }
    for (kind, min, max) in boxes {
        add_box(sim, p, &kind, min, max, bs, block_half);
    }
    add_heads(sim, p);
    sim.phys.recompute_mass(rb);
}

/// Reconstruit les colliders des morceaux d'un robot qui ont changé (`rebuildDirtyParts`).
pub fn rebuild_dirty_parts(sim: &mut Sim, bot: usize) {
    for p in sim.bots[bot].parts.clone() {
        if sim.part(p).dirty {
            rebuild_colliders(sim, p);
        }
    }
}

/// Les entiers de `a` à `b` inclus (`range`).
fn range(a: f64, b: f64) -> impl Iterator<Item = f64> {
    let n = (b - a + 1.0) as i64;
    (0..n.max(0)).map(move |i| a + i as f64)
}

/// Les réglages communs des colliders des blocs (`attach`).
fn attach(sim: &mut Sim, p: usize, shape: ShapeDesc, translation: V3, rotation: Q, density: f64) {
    let desc = ColliderDesc {
        translation,
        rotation,
        density,
        friction: BLOCK_FRICTION,
        restitution: BLOCK_RESTITUTION,
        collision_groups: groups::ROBOT_GROUP,
        active_events: CONTACT_FORCE_EVENTS,
        contact_force_event_threshold: CONTACT_FORCE_THRESHOLD,
        ..ColliderDesc::new(shape)
    };
    let rb = sim.part(p).rb;
    if let Some(h) = sim.phys.create_collider(&desc, rb) {
        sim.owners.insert(h, Owner::Part(p));
        sim.part_mut(p).colliders.push(h);
    }
}

/// Boîte couvrant les cases de `min` à `max` (`addBox`).
fn add_box(sim: &mut Sim, p: usize, kind: &str, min: [f64; 3], max: [f64; 3], bs: f64, block_half: f64) {
    let gap = bs / 2.0 - block_half;
    let half: [f64; 3] = std::array::from_fn(|i| ((max[i] - min[i] + 1.0) * bs) / 2.0 - gap);
    let center: [f64; 3] = std::array::from_fn(|i| ((min[i] + max[i]) / 2.0) * bs);
    let cells = (max[0] - min[0] + 1.0) * (max[1] - min[1] + 1.0) * (max[2] - min[2] + 1.0);
    let density = (cells * catalog().blocks[kind].mass) / (8.0 * half[0] * half[1] * half[2]);
    attach(sim, p, ShapeDesc::Cuboid(half[0], half[1], half[2]), v3(center[0], center[1], center[2]), NO_ROTATION, density);
}

/// Plaque d'une case, orientée comme son bloc (`addPlate`).
fn add_plate(sim: &mut Sim, p: usize, b: usize, block_half: f64) {
    let c = catalog();
    let thickness = c.constants.plate_thickness;
    let block = &sim.bots[sim.part(p).bot].blocks[b];
    let (local, rot) = (block.local, block.rot);
    let density = c.blocks[&block.kind].mass / (8.0 * block_half * block_half * (thickness / 2.0));
    attach(sim, p, ShapeDesc::Cuboid(block_half, thickness / 2.0, block_half), local, rot, density);
}

/// Bloc de forme (`addShape`) : l'enveloppe convexe de chacun de ses morceaux, orientée comme lui ;
/// la densité répartie sur leur volume total, pour la masse nominale. Les sommets passent en nombres
/// de 4 octets comme dans le `Float32Array` du TypeScript (`shapeHulls`).
fn add_shape(sim: &mut Sim, p: usize, b: usize, shape: &str, block_half: f64) {
    let Some(pieces) = shape_pieces(shape) else { return };
    let hulls: Vec<(Vec<f32>, f64)> = pieces
        .iter()
        .map(|piece| {
            let points = piece.points.iter().flat_map(|v| [(v.x * block_half) as f32, (v.y * block_half) as f32, (v.z * block_half) as f32]).collect();
            (points, piece.volume * crate::det::dpow(block_half, 3.0))
        })
        .collect();
    let block = &sim.bots[sim.part(p).bot].blocks[b];
    let (local, rot) = (block.local, block.rot);
    let density = catalog().blocks[&block.kind].mass / hulls.iter().fold(0.0, |s, h| s + h.1);
    for (points, _) in hulls {
        attach(sim, p, ShapeDesc::ConvexHull(points), local, rot, density);
    }
}

/// Les zones touchables des têtes de tourelle du morceau (`addHeads`) : un pavé pour la tête, une
/// capsule pour le canon, sans masse ni contact, posés d'après le lacet et le site (`placeHead`).
fn add_heads(sim: &mut Sim, p: usize) {
    let c = catalog();
    let bot = sim.part(p).bot;
    let rb = sim.part(p).rb;
    for t in 0..sim.bots[bot].turrets.len() {
        let tb = sim.bots[bot].turrets[t].block;
        if sim.bots[bot].blocks[tb].part != p || !sim.part(p).has(tb) {
            continue;
        }
        let spec = c.blocks[&sim.bots[bot].blocks[tb].kind].turret.clone().expect("tourelle sans spécification");
        let hitbox = |shape: ShapeDesc| ColliderDesc { density: 0.0, collision_groups: groups::HITBOX_GROUP, ..ColliderDesc::new(shape) };
        let [w, h, d] = spec.head;
        let head = sim.phys.create_collider(&hitbox(ShapeDesc::Cuboid((w * HITBOX_SHARE) / 2.0, (h * HITBOX_SHARE) / 2.0, (d * HITBOX_SHARE) / 2.0)), rb);
        if let Some(h) = head {
            sim.owners.insert(h, Owner::Head(bot, t));
            sim.part_mut(p).colliders.push(h);
        }
        let radius = crate::jsmath::max(MIN_CALIBER, spec.caliber) / 2.0;
        let half = spec.barrel / 2.0 - radius;
        let barrel = if spec.fixed != Some(Fixed::Down) && half > 0.02 { sim.phys.create_collider(&hitbox(ShapeDesc::Capsule(half, radius)), rb) } else { None };
        if let Some(b) = barrel {
            sim.owners.insert(b, Owner::Head(bot, t));
            sim.part_mut(p).colliders.push(b);
        }
        // `placeHead`
        let turret = &sim.bots[bot].turrets[t];
        let block = &sim.bots[bot].blocks[tb];
        let turn = match spec.fixed {
            Some(Fixed::Back) => axis_angle(v3(0.0, 1.0, 0.0), std::f64::consts::PI),
            Some(Fixed::Down) => NO_ROTATION,
            None => qmul(axis_angle(v3(0.0, 1.0, 0.0), turret.yaw), axis_angle(v3(1.0, 0.0, 0.0), -turret.pitch)),
        };
        let q = qmul(block.rot, turn);
        let pivot = add(block.local, qrot(block.rot, v3(0.0, spec.height, 0.0)));
        if let Some(h) = head {
            sim.phys.set_translation_wrt_parent(h, pivot);
            sim.phys.set_rotation_wrt_parent(h, q);
        }
        if let Some(b) = barrel {
            let capsule_to_z = axis_angle(v3(1.0, 0.0, 0.0), std::f64::consts::PI / 2.0);
            sim.phys.set_translation_wrt_parent(b, add(pivot, qrot(q, v3(0.0, 0.0, spec.barrel / 2.0))));
            sim.phys.set_rotation_wrt_parent(b, qmul(q, capsule_to_z));
        }
    }
}

/// Bloc d'un morceau touché en `point` par un rayon de direction `dir` (`blockAt`) : la case de la
/// grille juste derrière le point ; à défaut, le bloc du morceau le plus proche du point.
pub fn block_at(sim: &Sim, p: usize, point: V3, dir: V3) -> Option<usize> {
    let part = sim.part(p);
    let b = &sim.bots[part.bot];
    let rb = part.rb;
    let bs = catalog().constants.block_size;
    let local = qrot_inv(sim.phys.rotation(rb), sub(add(point, scale(dir, 0.02)), sim.phys.translation(rb)));
    let round = |x: f64| crate::jsmath::round(x / bs) as i64;
    if let Some(&hit) = b.cells.get(&(round(local.x), round(local.y), round(local.z)))
        && b.blocks[hit].part == p
    {
        return Some(hit);
    }
    let mut best = None;
    let mut best_dist = f64::INFINITY;
    for &k in &part.blocks {
        let l = b.blocks[k].local;
        let d = crate::jsmath::hypot3(l.x - local.x, l.y - local.y, l.z - local.z);
        if d < best_dist {
            best_dist = d;
            best = Some(k);
        }
    }
    best
}
