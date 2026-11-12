//! La sonde de la physique (fonctionnalité `physics`, hors du module du jeu) : un monde Rapier 0.36
//! — la version de @dimforge/rapier3d-compat 0.21 — monté et avancé ici, pour le comparer au même
//! monde monté par le TypeScript avec le Rapier du jeu (tests/nativePhysics.test.ts). Si les deux
//! donnent les mêmes poses au bit près, la simulation portée en Rust pourra être vérifiée au bit près
//! contre celle du TypeScript, robots, roues et chocs compris.

use rapier3d::prelude::*;
use std::cell::RefCell;

pub struct Probe {
    world: PhysicsWorld,
    bodies: Vec<RigidBodyHandle>,
}

thread_local! {
    static PROBES: RefCell<Vec<Probe>> = const { RefCell::new(Vec::new()) };
}

fn with<T>(id: u32, f: impl FnOnce(&mut Probe) -> T) -> T {
    PROBES.with(|list| f(&mut list.borrow_mut()[id as usize - 1]))
}

/// Un monde : la pesanteur de -`gravity` en y, le pas `dt`, `iterations` itérations du solveur
/// (comme `new RAPIER.World`, `timestep`, `numSolverIterations`).
#[unsafe(no_mangle)]
pub extern "C" fn probe_new(gravity: f32, dt: f32, iterations: u32) -> u32 {
    let mut world = PhysicsWorld::new();
    world.gravity = Vector::new(0.0, -gravity, 0.0);
    world.integration_parameters.dt = dt;
    world.integration_parameters.num_solver_iterations = iterations as usize;
    PROBES.with(|list| {
        let mut list = list.borrow_mut();
        list.push(Probe { world, bodies: Vec::new() });
        list.len() as u32
    })
}

/// Un corps et sa forme : `kind` 0 fixe, 1 dynamique ; `shape` 0 boîte (demi-tailles `a`, `b`, `c`),
/// 1 boule (rayon `a`). Pose (position, quaternion), vitesses. Son numéro dans la sonde.
#[unsafe(no_mangle)]
pub extern "C" fn probe_add(
    id: u32,
    kind: u32,
    shape: u32,
    a: f32,
    b: f32,
    c: f32,
    x: f32,
    y: f32,
    z: f32,
    qx: f32,
    qy: f32,
    qz: f32,
    qw: f32,
    vx: f32,
    vy: f32,
    vz: f32,
    wx: f32,
    wy: f32,
    wz: f32,
) -> u32 {
    with(id, |p| {
        let pose = Pose::from_parts(Vector::new(x, y, z), Rotation::from_xyzw(qx, qy, qz, qw));
        let body = if kind == 0 { RigidBodyBuilder::fixed() } else { RigidBodyBuilder::dynamic() }
            .pose(pose)
            .linvel(Vector::new(vx, vy, vz))
            .angvel(Vector::new(wx, wy, wz));
        let collider = if shape == 0 { ColliderBuilder::cuboid(a, b, c) } else { ColliderBuilder::ball(a) };
        let (handle, _) = p.world.insert(body, collider);
        p.bodies.push(handle);
        p.bodies.len() as u32 - 1
    })
}

/// Avance de `n` pas.
#[unsafe(no_mangle)]
pub extern "C" fn probe_step(id: u32, n: u32) {
    with(id, |p| {
        for _ in 0..n {
            p.world.step();
        }
    })
}

/// La pose du corps `index` : position puis quaternion (x, y, z, w), sept nombres de 4 octets.
///
/// # Safety
/// `out` pointe sur 7 f32.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn probe_pose(id: u32, index: u32, out: *mut f32) {
    with(id, |p| {
        let body = &p.world.bodies[p.bodies[index as usize]];
        let t = body.translation();
        let r = body.rotation();
        let out = unsafe { std::slice::from_raw_parts_mut(out, 7) };
        out.copy_from_slice(&[t.x, t.y, t.z, r.x, r.y, r.z, r.w]);
    })
}
