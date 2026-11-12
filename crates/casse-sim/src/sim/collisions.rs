//! Les dégâts de collision (src/shared/combat/collisions.ts). Rapier signale les contacts dont la
//! force dépasse un seuil (`CONTACT_FORCE_EVENTS`) ; pour chacun, on retrouve la vitesse à laquelle
//! les deux corps se rapprochaient juste avant le pas. Un choc sous `SAFE_SPEED` ne fait rien ;
//! au-delà, la part de l'impulsion due à l'excès de vitesse devient des dégâts de choc (`impact`) sur
//! les blocs touchés des deux côtés, et éprouve les liaisons des morceaux. Tous les chocs d'un pas
//! sont mesurés avant d'en infliger un seul : infliger reconstruit des colliders et en libère.
//!
//! Percée : un accessoire ancré (arbre, pan de mur) est un corps fixe, qui a arrêté net le robot
//! pendant le pas. S'il cède sous le choc, le robot n'y reste pas : il reprend sa vitesse d'avant,
//! moins ce qu'il a fallu pour le briser ; un arbre abattu tombe dans le sens de sa course.
//!
//! Pas encore porté : le robot projeté par un flipper (pas d'armes de contact).

use super::colliders::block_at;
use super::damage::{DamageBatch, Target, inflict};
use super::physics::ContactForce;
use super::props::{PropState, fell_prop, present, prop, prop_mass, prop_mut};
use super::vec::{V3, add, cross, dot, len, norm, qrot, scale, sub, v3};
use super::world::{Owner, STEP, Sim};
use rapier3d::prelude::{ColliderHandle, RigidBodyHandle};
use std::collections::HashMap;

/// Vitesse de rapprochement encaissée sans dégâts (m/s).
const SAFE_SPEED: f64 = 3.0;
/// Dégâts de choc par N·s d'impulsion au-delà de ce qu'encaisse un choc à SAFE_SPEED.
const DAMAGE_PER_IMPULSE: f64 = 1.0;
/// Distance maximale d'un point au centre de masse, pour majorer sa vitesse de rotation (m).
const REACH: f64 = 4.0;
/// Part de la masse d'un obstacle brisé que le robot emporte en passant.
const CARRIED: f64 = 0.02;
/// En dessous de cette vitesse gardée (m/s), il s'arrête contre ce qu'il vient de briser.
const BREACH_MIN: f64 = 0.5;

/// Mouvement d'un corps juste avant le pas (`Motion`).
#[derive(Clone, Copy)]
pub struct Motion {
    linvel: V3,
    angvel: V3,
    com: V3,
}

/// Relève le mouvement des corps qui peuvent subir un choc, avant le pas (`captureMotions`) : les
/// morceaux de robots et les accessoires (pas un corps fixe : il est immobile).
pub fn capture_motions(sim: &Sim) -> HashMap<RigidBodyHandle, Motion> {
    let mut motions = HashMap::new();
    let capture = |motions: &mut HashMap<RigidBodyHandle, Motion>, rb: RigidBodyHandle| {
        motions.insert(rb, Motion { linvel: sim.phys.linvel(rb), angvel: sim.phys.angvel(rb), com: sim.phys.world_com(rb) });
    };
    for &p in &sim.order {
        capture(&mut motions, sim.part(p).rb);
    }
    for i in present(sim) {
        let p = prop(sim, i);
        if !p.fixed {
            capture(&mut motions, p.rb);
        }
    }
    motions
}

fn velocity_at(m: Option<&Motion>, p: V3) -> V3 {
    match m {
        Some(m) => add(m.linvel, cross(m.angvel, sub(p, m.com))),
        None => v3(0.0, 0.0, 0.0),
    }
}

/// Contacts signalés entre deux corps pendant le pas (`Clash`).
struct Clash {
    a: RigidBodyHandle,
    b: RigidBodyHandle,
    pairs: Vec<(ColliderHandle, ColliderHandle)>,
    impulse: f64,
}

/// Choc mesuré, prêt à infliger : tout ce qu'il faut lire de Rapier l'a été (`Impact`).
struct Impact {
    owners: [Option<Owner>; 2],
    /// Combien de ses deux côtés sont des robots (relevé à la mesure, quand tous les morceaux sont là).
    robots: usize,
    points: Vec<(V3, f64)>,
    total: f64,
    normal: V3,
    center: V3,
    impulse: f64,
    damage: f64,
    /// Un robot qui brise un accessoire ancré et passe au travers.
    breach: Option<Breach>,
}

/// Percée d'un robot à travers un accessoire ancré qu'il brise (`Breach`).
struct Breach {
    /// Côté du robot dans le choc (0 : `a`, 1 : `b`), son morceau, l'accessoire.
    side: usize,
    part: usize,
    prop: usize,
    /// Vitesse et rotation du morceau après la percée.
    linvel: V3,
    angvel: V3,
    /// Sens de la course et vitesse qu'il y garde (m/s).
    dir: V3,
    speed: f64,
    /// Impulsion qu'il a vraiment cédée (N·s) et les dégâts qu'elle lui fait.
    impulse: f64,
    damage: f64,
}

/// Traite les contacts violents du dernier pas (`resolveCollisions`). `events` : les forces de
/// contact du pas, dans l'ordre de la file ; `before` : les mouvements relevés avant le pas.
pub fn resolve_collisions(sim: &mut Sim, events: &[ContactForce], before: &HashMap<RigidBodyHandle, Motion>) {
    let mut clashes: Vec<Clash> = Vec::new();
    for e in events {
        let (Some(a), Some(b)) = (sim.phys.collider_parent(e.collider1), sim.phys.collider_parent(e.collider2)) else { continue };
        let i = match clashes.iter().position(|c| (c.a == a && c.b == b) || (c.a == b && c.b == a)) {
            Some(i) => i,
            None => {
                clashes.push(Clash { a, b, pairs: Vec::new(), impulse: 0.0 });
                clashes.len() - 1
            }
        };
        let clash = &mut clashes[i];
        clash.pairs.push(if a == clash.a { (e.collider1, e.collider2) } else { (e.collider2, e.collider1) });
        clash.impulse += e.total_force_magnitude as f64 * STEP;
    }
    let impacts: Vec<Impact> = clashes.iter().filter_map(|clash| measure(sim, clash, before)).collect();
    for impact in impacts {
        strike_impact(sim, &impact);
    }
}

/// Mesure un choc (`measure`) : points de contact, normale, vitesse de rapprochement ; rien s'il est inoffensif.
fn measure(sim: &Sim, clash: &Clash, before: &HashMap<RigidBodyHandle, Motion>) -> Option<Impact> {
    let ma = before.get(&clash.a);
    let mb = before.get(&clash.b);
    // Majoration de la vitesse relative : trop lente, inutile d'examiner les points de contact
    let bound = |m: Option<&Motion>| m.map_or(0.0, |m| len(m.linvel) + len(m.angvel) * REACH);
    if bound(ma) + bound(mb) < SAFE_SPEED {
        return None;
    }

    // Points de contact, pondérés par l'impulsion de chacun, et normale moyenne (de a vers b)
    let mut points: Vec<(V3, f64)> = Vec::new();
    let mut normal = v3(0.0, 0.0, 0.0);
    for &(ca, cb) in &clash.pairs {
        let Some((collider1, manifolds)) = sim.phys.contact_pair(ca, cb) else { continue };
        let flipped = collider1 != ca;
        let first = if flipped { cb } else { ca };
        let (ft, fr) = sim.phys.collider_pose(first);
        for m in manifolds {
            let n = m.normal;
            let toward = if flipped { scale(n, -1.0) } else { n };
            for (w, local) in m.points {
                if w <= 0.0 {
                    continue;
                }
                points.push((add(ft, qrot(fr, local)), w));
                normal = add(normal, scale(toward, w));
            }
        }
    }
    let total = points.iter().fold(0.0, |s, x| s + x.1);
    // (`!total` : 0, -0 ou NaN)
    if total == 0.0 || total.is_nan() || len(normal) < 1e-6 {
        return None;
    }
    let n = norm(normal);
    let center = scale(points.iter().fold(v3(0.0, 0.0, 0.0), |s, x| add(s, scale(x.0, x.1))), 1.0 / total);
    // Le sens de la normale importe peu : un contact aussi fort ne peut que freiner un rapprochement
    let closing = dot(sub(velocity_at(ma, center), velocity_at(mb, center)), n).abs();
    if closing <= SAFE_SPEED {
        return None;
    }
    let owners = [owner_of_body(sim, clash.a, clash), owner_of_body(sim, clash.b, clash)];
    let robots = owners.iter().filter(|o| owner_is_bot(sim, **o)).count();
    let damage = DAMAGE_PER_IMPULSE * clash.impulse * (1.0 - SAFE_SPEED / closing);
    let breach = breach_of(sim, clash, &owners, [ma, mb], n, closing, damage);
    Some(Impact { owners, robots, points, total, normal: n, center, impulse: clash.impulse, damage, breach })
}

/// Le choc brise-t-il un accessoire ancré (`damage` : ce qu'un arrêt net lui inflige) ? Alors le
/// robot passe au travers : ce qu'il garde de vitesse, s'il en garde assez (`breachOf`).
fn breach_of(sim: &Sim, clash: &Clash, owners: &[Option<Owner>; 2], motions: [Option<&Motion>; 2], n: V3, closing: f64, damage: f64) -> Option<Breach> {
    let prop_side = if matches!(owners[0], Some(Owner::Prop(_))) { 0 } else { 1 };
    let Some(Owner::Prop(i)) = owners[prop_side] else { return None };
    let p = prop(sim, i);
    let def = p.def();
    if !p.fixed || !(def.shatters || def.topples != 0.0) || def.fuse > 0.0 {
        return None;
    }
    let resist = def.resistance("impact");
    if damage * resist < p.hp {
        return None;
    }
    let side = if prop_side == 0 { 1 } else { 0 };
    let body = if side == 0 { clash.a } else { clash.b };
    let part = sim.order.iter().copied().find(|&q| sim.part(q).rb == body)?;
    let motion = motions[side]?;
    // Sens de la course : de lui vers l'obstacle (la normale va de a vers b)
    let dir = if side == 0 { n } else { scale(n, -1.0) };
    let along = dot(motion.linvel, dir);
    if along <= SAFE_SPEED {
        return None;
    }
    // L'impulsion qui inflige ses points de structure à l'obstacle, puis la masse qu'il emporte
    let efficiency = DAMAGE_PER_IMPULSE * (1.0 - SAFE_SPEED / closing);
    let mass = sim.phys.mass(sim.part(part).rb);
    let speed = (mass * along - p.hp / resist / efficiency) / (mass + CARRIED * prop_mass(def, p.half));
    if speed < BREACH_MIN {
        return None;
    }
    let impulse = mass * (along - speed);
    Some(Breach {
        side,
        part,
        prop: i,
        dir,
        speed,
        impulse,
        damage: efficiency * impulse,
        linvel: sub(motion.linvel, scale(dir, along - speed)),
        angvel: motion.angvel,
    })
}

/// Ce côté du choc est-il un robot (`ownerBot` : un morceau, une roue, une tête de tourelle) ?
fn owner_is_bot(sim: &Sim, owner: Option<Owner>) -> bool {
    match owner {
        Some(Owner::Part(p)) => sim.parts[p].is_some(),
        Some(Owner::Wheel(..)) | Some(Owner::Head(..)) => true,
        _ => false,
    }
}

/// Ce que représente un corps pris dans un choc : on le retrouve par l'un de ses colliders (`ownerOfBody`).
fn owner_of_body(sim: &Sim, body: RigidBodyHandle, clash: &Clash) -> Option<Owner> {
    for &(ca, cb) in &clash.pairs {
        let c = if body == clash.a { ca } else { cb };
        if let Some(&owner) = sim.owners.get(&c) {
            return Some(owner);
        }
    }
    None
}

/// Ce corps existe-t-il encore ? (morceau toujours rattaché à son robot, roue pas arrachée) (`stillThere`)
fn still_there(sim: &Sim, owner: Owner) -> bool {
    match owner {
        Owner::Part(p) => sim.parts[p].as_ref().is_some_and(|part| sim.bots[part.bot].parts.contains(&p)),
        Owner::Wheel(bot, w) => sim.bots[bot].wheels[w].part.is_some(),
        Owner::Head(bot, t) => sim.bots[bot].blocks[sim.bots[bot].turrets[t].block].alive,
        Owner::Debris | Owner::Prop(_) => true,
    }
}

/// Ce qui est touché en `p` : le bloc du morceau à cet endroit, la roue (`targetAt`).
fn target_at(sim: &Sim, owner: Owner, p: V3, into: V3) -> Option<Target> {
    match owner {
        Owner::Part(part) => block_at(sim, part, p, into).map(|b| Target::Block(sim.part(part).bot, b)),
        Owner::Head(bot, t) => {
            let b = sim.bots[bot].turrets[t].block;
            sim.bots[bot].blocks[b].alive.then_some(Target::Block(bot, b))
        }
        Owner::Wheel(bot, w) => Some(Target::Wheel(bot, w)),
        Owner::Prop(i) => Some(Target::Prop(i)),
        Owner::Debris => None,
    }
}

/// Inflige un choc mesuré aux deux corps : chaque point de contact reçoit sa part des dégâts (`strikeImpact`).
fn strike_impact(sim: &mut Sim, impact: &Impact) {
    let n = impact.normal;
    let mut batch = DamageBatch::default();
    // Un robot qui passe au travers d'un obstacle n'encaisse que ce qu'il a cédé pour le briser
    let felt = |side: usize| match &impact.breach {
        Some(b) if b.side == side => (b.impulse, b.damage),
        _ => (impact.impulse, impact.damage),
    };
    let sides = [(impact.owners[0], scale(n, -felt(0).0), felt(0).1), (impact.owners[1], scale(n, felt(1).0), felt(1).1)];
    for (owner, impulse, damage) in sides {
        // Un choc précédent du même pas a pu détruire ce morceau ou arracher cette roue
        let Some(owner) = owner else { continue };
        if !still_there(sim, owner) {
            continue;
        }
        // Chaque point de contact reçoit sa part des dégâts
        let mut shares: Vec<(Target, f64)> = Vec::new();
        for &(p, w) in &impact.points {
            let Some(target) = target_at(sim, owner, p, norm(impulse)) else { continue };
            let amount = (damage * w) / impact.total;
            match shares.iter_mut().find(|s| s.0 == target) {
                Some(s) => s.1 += amount,
                None => shares.push((target, 0.0 + amount)),
            }
        }
        for &(target, amount) in &shares {
            batch.add(sim, Some(target), amount, "impact");
        }
        if let Owner::Part(part) = owner {
            let hit = match shares.first() {
                Some((Target::Block(_, b), _)) => Some(*b),
                _ => None,
            };
            batch.shock(sim, part, impact.center, impulse, hit);
        }
    }
    sim.stats.collisions += 1;
    // Un robot ne réagit (fuite, charge) qu'à un choc avec un autre robot, pas contre un mur ou une caisse
    inflict(sim, &batch, n, if impact.robots == 2 { Some(impact.center) } else { None });
    if let Some(breach) = &impact.breach {
        break_through(sim, breach);
    }
}

/// Après le choc (`breakThrough`) : si l'accessoire a cédé (brisé, il disparaît à la fin du pas ;
/// abattu, il tombe), le robot repart avec la vitesse qu'il garde ; les éclats partent devant lui,
/// un arbre tombe dans le sens de sa course et le laisse passer.
fn break_through(sim: &mut Sim, breach: &Breach) {
    let i = breach.prop;
    // (un choc précédent du même pas a pu détruire ce morceau)
    let Some(p) = sim.props[i].as_ref() else { return };
    let broken = matches!(p.state, PropState::Fuse { left } if left <= 0.0);
    let felled = !p.fixed;
    let part = breach.part;
    let attached = sim.parts[part].as_ref().is_some_and(|q| sim.bots[q.bot].parts.contains(&part));
    if (!broken && !felled) || !attached {
        return;
    }
    let rb = sim.part(part).rb;
    sim.phys.set_linvel(rb, breach.linvel, true);
    sim.phys.set_angvel(rb, breach.angvel, true);
    if broken {
        prop_mut(sim, i).struck = Some(scale(breach.dir, breach.speed * 0.8));
    } else {
        fell_prop(sim, i, breach.dir, breach.speed);
    }
}
