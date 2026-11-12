//! Le monde Rapier de la simulation portée, manié exactement comme le TypeScript manie le Rapier du
//! jeu (@dimforge/rapier3d-compat 0.21 : rapier3d 0.36, sa liaison TypeScript dans le dépôt de
//! Rapier, bindings/typescript, étiquette v0.36.0). Chaque fonction refait ce que fait la liaison :
//! `createRigidBody` (src/dynamics/rigid_body_set.rs) donne au corps tous les réglages de
//! `RigidBodyDesc` (et des propriétés de masse additionnelles nulles), `createCollider`
//! (src/geometry/collider_set.rs, `build_collider`) tous ceux de `ColliderDesc`, `castRayAndGetNormal`
//! (src/geometry/broad_phase.rs) le même filtre. Les nombres de 8 octets du TypeScript passent en
//! nombres de 4 octets à la frontière du WebAssembly (arrondis au plus proche, comme `as f32`), et
//! reviennent tels quels : mêmes appels, mêmes arguments, même monde au bit près
//! (tests/nativePhysics.test.ts, tests/nativeSim.test.ts).

use super::vec::{Q, V3, v3};
use rapier3d::prelude::*;
use std::sync::Mutex;

/// Les groupes de collision (src/shared/physics/groups.ts) : 16 bits d'appartenance, 16 de filtre.
pub mod groups {
    const STATIC: u32 = 0x0001;
    const ROBOT: u32 = 0x0002;
    const EVERYTHING: u32 = 0xffff;
    const HITBOX: u32 = 0x0010;
    const PROP: u32 = 0x0004;
    const DEBRIS: u32 = 0x0008;
    const fn groups(membership: u32, filter: u32) -> u32 {
        (membership << 16) | filter
    }
    pub const STATIC_GROUP: u32 = groups(STATIC, EVERYTHING);
    pub const ROBOT_GROUP: u32 = groups(ROBOT, EVERYTHING);
    pub const PROP_GROUP: u32 = groups(PROP, EVERYTHING);
    /// Un arbre qu'un robot vient de coucher : le temps de sa chute, il ne heurte plus les robots.
    pub const FELLED: u32 = groups(PROP, STATIC | PROP);
    pub const WHEEL: u32 = groups(ROBOT, ROBOT | PROP);
    pub const HITBOX_GROUP: u32 = groups(HITBOX, 0);
    pub const DEBRIS_GROUP: u32 = groups(DEBRIS, STATIC);
    pub const GROUND_RAY: u32 = groups(EVERYTHING, STATIC);
}

/// Un événement de force de contact (`ContactForceEvent` de la liaison) : les deux colliders de la
/// paire (dans l'ordre de la paire), et la somme des normes des forces (nombre de 4 octets).
#[derive(Clone, Copy, Debug)]
pub struct ContactForce {
    pub collider1: ColliderHandle,
    pub collider2: ColliderHandle,
    pub total_force_magnitude: f32,
}

/// Le collecteur d'événements de la liaison (`RawEventQueue`, un `ChannelEventCollector` : une file,
/// lue dans l'ordre d'arrivée) ; seuls les événements de force de contact servent.
struct ForceCollector(Mutex<Vec<ContactForce>>);

impl EventHandler for ForceCollector {
    fn handle_collision_event(&self, _: &RigidBodySet, _: &ColliderSet, _: CollisionEvent, _: Option<&ContactPair>) {}

    fn handle_contact_force_event(&self, _: Real, _: &RigidBodySet, _: &ColliderSet, pair: &ContactPair, total_force_magnitude: Real) {
        self.0.lock().expect("file des événements").push(ContactForce { collider1: pair.collider1, collider2: pair.collider2, total_force_magnitude });
    }

    fn handle_soft_body_tear_event(&self, _: &SoftBodySet, _: &SoftBodyTearEvent) {}
}

/// Une variété de contact (`TempContactManifold`), comme la lit le TypeScript : sa normale (repère
/// monde), et pour chaque point son impulsion et sa position dans le repère du premier collider de
/// la paire.
pub struct Manifold {
    pub normal: V3,
    pub points: Vec<(f64, V3)>,
}

/// `ActiveEvents.CONTACT_FORCE_EVENTS` de la liaison.
pub const CONTACT_FORCE_EVENTS: u32 = 0b0010;

/// Les groupes d'un nombre de 32 bits (`unpack_interaction_groups` de la liaison).
fn unpack(bits: u32) -> InteractionGroups {
    InteractionGroups::new(Group::from_bits_retain(bits >> 16), Group::from_bits_retain(bits & 0xffff), InteractionTestMode::And)
}

fn vector(v: V3) -> Vector {
    Vector::new(v.x as f32, v.y as f32, v.z as f32)
}

fn rotation(q: Q) -> Rotation {
    Rotation::from_xyzw(q.x as f32, q.y as f32, q.z as f32, q.w as f32)
}

fn back(v: Vector) -> V3 {
    v3(v.x as f64, v.y as f64, v.z as f64)
}

/// Un corps à créer (`RigidBodyDesc`) : ce que le TypeScript règle ; le reste à ses valeurs par défaut.
pub struct BodyDesc {
    pub dynamic: bool,
    pub translation: V3,
    pub rotation: Q,
    pub linvel: V3,
    pub angvel: V3,
    pub linear_damping: f64,
    pub angular_damping: f64,
}

impl BodyDesc {
    pub fn fixed(translation: V3, rotation: Q) -> Self {
        BodyDesc { dynamic: false, ..BodyDesc::dynamic(translation, rotation) }
    }

    /// `RigidBodyDesc.dynamic().setTranslation(…).setRotation(…)`, le reste par défaut.
    pub fn dynamic(translation: V3, rotation: Q) -> Self {
        let zero = v3(0.0, 0.0, 0.0);
        BodyDesc { dynamic: true, translation, rotation, linvel: zero, angvel: zero, linear_damping: 0.0, angular_damping: 0.0 }
    }
}

/// Forme d'un collider (`ColliderDesc.cuboid`, `.capsule`…), ses dimensions comme les passe le TypeScript.
pub enum ShapeDesc {
    Cuboid(f64, f64, f64),
    Ball(f64),
    /// Demi-hauteur, rayon (le long de y).
    Capsule(f64, f64),
    /// Demi-hauteur, rayon (debout selon y).
    Cylinder(f64, f64),
    /// Les sommets, déjà en nombres de 4 octets (un `Float32Array`).
    ConvexHull(Vec<f32>),
}

/// Un collider à créer (`ColliderDesc`) : ce que le TypeScript règle ; le reste à ses valeurs par défaut.
pub struct ColliderDesc {
    pub shape: ShapeDesc,
    pub translation: V3,
    pub rotation: Q,
    pub density: f64,
    pub friction: f64,
    pub restitution: f64,
    pub collision_groups: u32,
    pub active_events: u32,
    pub contact_force_event_threshold: f64,
}

impl ColliderDesc {
    /// Les valeurs par défaut de `ColliderDesc` (densité 1, frottement 0,5, tous les groupes…).
    pub fn new(shape: ShapeDesc) -> Self {
        ColliderDesc {
            shape,
            translation: v3(0.0, 0.0, 0.0),
            rotation: super::vec::NO_ROTATION,
            density: 1.0,
            friction: 0.5,
            restitution: 0.0,
            collision_groups: 0xffff_ffff,
            active_events: 0,
            contact_force_event_threshold: 0.0,
        }
    }
}

/// Ce que rend un rayon : la distance (nombre de 4 octets) et la normale.
pub struct RayHit {
    pub time_of_impact: f64,
    pub normal: V3,
}

pub struct Physics {
    pub world: PhysicsWorld,
}

impl Physics {
    /// `new RAPIER.World({ x: 0, y: -gravity, z: 0 })`, `timestep`, `numSolverIterations`.
    pub fn new(gravity: f64, dt: f64, iterations: usize) -> Self {
        let mut world = PhysicsWorld::new();
        world.gravity = Vector::new(0.0, -gravity as f32, 0.0);
        world.integration_parameters.dt = dt as f32;
        world.integration_parameters.num_solver_iterations = iterations;
        Physics { world }
    }

    /// `world.createRigidBody(desc)` (la liaison : `RawRigidBodySet.createRigidBody`).
    pub fn create_body(&mut self, d: &BodyDesc) -> RigidBodyHandle {
        let kind = if d.dynamic { RigidBodyType::Dynamic } else { RigidBodyType::Fixed };
        let pos = Pose::from_parts(vector(d.translation), rotation(d.rotation));
        let builder = RigidBodyBuilder::new(kind)
            .enabled(true)
            .pose(pos)
            .gravity_scale(1.0)
            .enabled_translations(true, true, true)
            .enabled_rotations(true, true, true)
            .linvel(vector(d.linvel))
            .angvel(vector(d.angvel))
            .linear_damping(d.linear_damping as f32)
            .angular_damping(d.angular_damping as f32)
            .can_sleep(true)
            .sleeping(false)
            .ccd_enabled(false)
            .dominance_group(0)
            .additional_solver_iterations(0)
            .additional_pgs_iterations(0)
            .soft_ccd_prediction(0.0);
        // (`massOnly` faux par défaut : des propriétés de masse additionnelles, nulles)
        let props = MassProperties::with_principal_inertia_frame(
            Vector::new(0.0, 0.0, 0.0),
            0.0,
            Vector::new(0.0, 0.0, 0.0),
            Rotation::from_xyzw(0.0, 0.0, 0.0, 1.0),
        );
        self.world.bodies.insert(builder.additional_mass_properties(props).build())
    }

    /// `world.createCollider(desc, parent)` (la liaison : `RawColliderSet.createCollider`, `build_collider`).
    pub fn create_collider(&mut self, d: &ColliderDesc, parent: RigidBodyHandle) -> Option<ColliderHandle> {
        let shape = match &d.shape {
            ShapeDesc::Cuboid(hx, hy, hz) => SharedShape::cuboid(*hx as f32, *hy as f32, *hz as f32),
            ShapeDesc::Ball(r) => SharedShape::ball(*r as f32),
            ShapeDesc::Capsule(half, r) => {
                let p2 = Vector::Y * (*half as f32);
                let p1 = -p2;
                SharedShape::capsule(p1, p2, *r as f32)
            }
            ShapeDesc::Cylinder(half, r) => SharedShape::cylinder(*half as f32, *r as f32),
            ShapeDesc::ConvexHull(points) => {
                let points: Vec<_> = points.chunks(3).map(Vector::from_slice).collect();
                SharedShape::convex_hull(&points)?
            }
        };
        let pos = Pose::from_parts(vector(d.translation), rotation(d.rotation));
        let builder = ColliderBuilder::new(shape)
            .enabled(true)
            .position(pos)
            .friction(d.friction as f32)
            .restitution(d.restitution as f32)
            .collision_groups(unpack(d.collision_groups))
            .solver_groups(unpack(0xffff_ffff))
            .active_hooks(ActiveHooks::empty())
            .active_events(ActiveEvents::from_bits(d.active_events).unwrap_or(ActiveEvents::empty()))
            .active_collision_types(ActiveCollisionTypes::default())
            .sensor(false)
            .friction_combine_rule(CoefficientCombineRule::Average)
            .restitution_combine_rule(CoefficientCombineRule::Average)
            .contact_force_event_threshold(d.contact_force_event_threshold as f32)
            .contact_skin(0.0)
            .density(d.density as f32);
        let w = &mut self.world;
        Some(w.colliders.insert_with_parent(builder.build(), parent, &mut w.bodies))
    }

    /// `collider.setTranslationWrtParent` (la liaison : `coSetTranslationWrtParent`).
    pub fn set_translation_wrt_parent(&mut self, h: ColliderHandle, t: V3) {
        if let Some(co) = self.world.colliders.get_mut(h) {
            co.set_translation_wrt_parent(vector(t));
        }
    }

    /// `collider.setRotationWrtParent` (la liaison : `coSetRotationWrtParent` : normalisé, puis
    /// donné en axe-angle).
    pub fn set_rotation_wrt_parent(&mut self, h: ColliderHandle, r: Q) {
        let q = rotation(r);
        if q.length_squared() != 0.0 {
            let q = q.normalize();
            if let Some(co) = self.world.colliders.get_mut(h) {
                co.set_rotation_wrt_parent(q.to_scaled_axis());
            }
        }
    }

    /// `rb.recomputeMassPropertiesFromColliders()`.
    pub fn recompute_mass(&mut self, h: RigidBodyHandle) {
        let w = &mut self.world;
        if let Some(rb) = w.bodies.get_mut(h) {
            rb.recompute_mass_properties_from_colliders(&w.colliders);
        }
    }

    /// `world.step(events)` : l'avance d'un pas (les événements ne changent rien au monde), et les
    /// événements de force de contact du pas, dans l'ordre où `drainContactForceEvents` les rend.
    pub fn step(&mut self) -> Vec<ContactForce> {
        let events = ForceCollector(Mutex::new(Vec::new()));
        self.world.step_with_events(&(), &events);
        events.0.into_inner().unwrap_or_default()
    }

    /// `world.removeCollider(collider, wakeUp)` (la liaison : `RawColliderSet.remove`).
    pub fn remove_collider(&mut self, h: ColliderHandle, wake_up: bool) {
        let w = &mut self.world;
        w.colliders.remove(h, &mut w.islands, &mut w.bodies, &mut w.soft_bodies, wake_up);
    }

    /// `world.removeRigidBody(body)` (la liaison : `RawRigidBodySet.remove`, ses colliders avec lui).
    pub fn remove_body(&mut self, h: RigidBodyHandle) {
        let w = &mut self.world;
        w.bodies.remove(h, &mut w.islands, &mut w.colliders, &mut w.impulse_joints, &mut w.multibody_joints, &mut w.soft_bodies, true);
    }

    /// `collider.parent()` : le corps qui porte le collider.
    pub fn collider_parent(&self, h: ColliderHandle) -> Option<RigidBodyHandle> {
        self.world.colliders.get(h).and_then(|c| c.parent())
    }

    /// `collider.translation()`, `collider.rotation()` : sa pose dans le monde.
    pub fn collider_pose(&self, h: ColliderHandle) -> (V3, Q) {
        let p = self.world.colliders[h].position();
        (back(p.translation), Q { x: p.rotation.x as f64, y: p.rotation.y as f64, z: p.rotation.z as f64, w: p.rotation.w as f64 })
    }

    /// `world.contactPair(c1, c2, f)` : le premier collider de la paire (la liaison : `collider1()`),
    /// et ses variétés de contact, chacune avec sa normale et ses points (`contactImpulse`,
    /// `localContactPoint1`) ; rien si les deux colliders ne sont pas en contact.
    pub fn contact_pair(&self, c1: ColliderHandle, c2: ColliderHandle) -> Option<(ColliderHandle, Vec<Manifold>)> {
        let pair = self.world.narrow_phase.contact_pair(c1, c2)?;
        let manifolds = pair
            .manifolds()
            .iter()
            .map(|m| Manifold {
                normal: back(m.data.normal),
                points: m.points.iter().map(|c| (c.data.impulse as f64, back(c.local_p1))).collect(),
            })
            .collect();
        Some((pair.collider1, manifolds))
    }

    /// `collider.setCollisionGroups(groups)` (la liaison : `coSetCollisionGroups`).
    pub fn set_collision_groups(&mut self, h: ColliderHandle, bits: u32) {
        if let Some(co) = self.world.colliders.get_mut(h) {
            co.set_collision_groups(unpack(bits));
        }
    }

    /// `rb.setBodyType(RigidBodyType.Dynamic, wakeUp)` (la liaison : `rbSetBodyType`).
    pub fn set_dynamic(&mut self, h: RigidBodyHandle, wake_up: bool) {
        if let Some(rb) = self.world.bodies.get_mut(h) {
            rb.set_body_type(RigidBodyType::Dynamic, wake_up);
        }
    }

    /// `rb.applyImpulseAtPoint(impulse, point, wakeUp)` (la liaison : `rbApplyImpulseAtPoint`).
    pub fn apply_impulse_at_point(&mut self, h: RigidBodyHandle, impulse: V3, point: V3, wake_up: bool) {
        if let Some(rb) = self.world.bodies.get_mut(h) {
            rb.apply_impulse_at_point(vector(impulse), vector(point), wake_up);
        }
    }

    /// `world.intersectionWithShape(pos, rot, shape, undefined, undefined, undefined, undefined,
    /// predicate)` : un collider que retient `keep` coupe-t-il la forme (une boîte ou un cylindre
    /// debout, comme `create_collider`) posée en `pos`, `rot` ? La liaison rend le premier trouvé
    /// (`intersect_shape(…).next()`) ; on n'en veut que l'existence.
    pub fn intersects_shape(&self, pos: V3, rot: Q, shape: &ShapeDesc, keep: &dyn Fn(ColliderHandle) -> bool) -> bool {
        let shape = match shape {
            ShapeDesc::Cuboid(hx, hy, hz) => SharedShape::cuboid(*hx as f32, *hy as f32, *hz as f32),
            ShapeDesc::Cylinder(half, r) => SharedShape::cylinder(*half as f32, *r as f32),
            ShapeDesc::Ball(r) => SharedShape::ball(*r as f32),
            _ => return false,
        };
        let w = &self.world;
        let predicate = |h: ColliderHandle, _: &Collider| keep(h);
        let filter = QueryFilter { flags: QueryFilterFlags::empty(), groups: None, exclude_collider: None, exclude_rigid_body: None, predicate: Some(&predicate) };
        let pipeline = w.broad_phase.as_query_pipeline(w.narrow_phase.query_dispatcher(), &w.bodies, &w.colliders, filter);
        pipeline.intersect_shape(Pose::from_parts(vector(pos), rotation(rot)), &*shape).next().is_some()
    }

    /// `world.castRayAndGetNormal(ray, maxToi, solid, undefined, groups)`.
    pub fn cast_ray_and_get_normal(&self, origin: V3, dir: V3, max_toi: f64, solid: bool, groups: u32) -> Option<RayHit> {
        let w = &self.world;
        let filter = QueryFilter {
            flags: QueryFilterFlags::empty(),
            groups: Some(unpack(groups)),
            exclude_collider: None,
            exclude_rigid_body: None,
            predicate: None,
        };
        let pipeline = w.broad_phase.as_query_pipeline(w.narrow_phase.query_dispatcher(), &w.bodies, &w.colliders, filter);
        let ray = Ray::new(vector(origin), vector(dir));
        let (_, hit) = pipeline.cast_ray_and_get_normal(&ray, max_toi as f32, solid)?;
        Some(RayHit { time_of_impact: hit.time_of_impact as f64, normal: back(hit.normal) })
    }

    fn body(&self, h: RigidBodyHandle) -> &RigidBody {
        &self.world.bodies[h]
    }

    pub fn translation(&self, h: RigidBodyHandle) -> V3 {
        back(self.body(h).position().translation)
    }

    pub fn rotation(&self, h: RigidBodyHandle) -> Q {
        let r = self.body(h).position().rotation;
        Q { x: r.x as f64, y: r.y as f64, z: r.z as f64, w: r.w as f64 }
    }

    pub fn linvel(&self, h: RigidBodyHandle) -> V3 {
        back(self.body(h).linvel())
    }

    pub fn angvel(&self, h: RigidBodyHandle) -> V3 {
        back(self.body(h).angvel())
    }

    pub fn world_com(&self, h: RigidBodyHandle) -> V3 {
        back(self.body(h).mass_properties().world_com)
    }

    pub fn mass(&self, h: RigidBodyHandle) -> f64 {
        self.body(h).mass() as f64
    }

    pub fn inv_mass(&self, h: RigidBodyHandle) -> f64 {
        self.body(h).mass_properties().local_mprops.inv_mass as f64
    }

    /// `rb.effectiveWorldInvInertia()` : m11, m12, m13, m22, m23, m33.
    pub fn effective_world_inv_inertia(&self, h: RigidBodyHandle) -> [f64; 6] {
        let m = self.body(h).mass_properties().effective_world_inv_inertia;
        [m.m11 as f64, m.m12 as f64, m.m13 as f64, m.m22 as f64, m.m23 as f64, m.m33 as f64]
    }

    pub fn apply_impulse(&mut self, h: RigidBodyHandle, v: V3, wake_up: bool) {
        if let Some(rb) = self.world.bodies.get_mut(h) {
            rb.apply_impulse(vector(v), wake_up);
        }
    }

    pub fn apply_torque_impulse(&mut self, h: RigidBodyHandle, v: V3, wake_up: bool) {
        if let Some(rb) = self.world.bodies.get_mut(h) {
            rb.apply_torque_impulse(vector(v), wake_up);
        }
    }

    pub fn set_linvel(&mut self, h: RigidBodyHandle, v: V3, wake_up: bool) {
        if let Some(rb) = self.world.bodies.get_mut(h) {
            rb.set_linvel(vector(v), wake_up);
        }
    }

    pub fn set_angvel(&mut self, h: RigidBodyHandle, v: V3, wake_up: bool) {
        if let Some(rb) = self.world.bodies.get_mut(h) {
            rb.set_angvel(vector(v), wake_up);
        }
    }
}
