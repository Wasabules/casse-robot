//! Les explosions (`explode` et `blast`, src/shared/combat/damage.ts) : dégâts de zone sur les blocs,
//! les roues et les accessoires, décroissant avec la distance (à la surface d'un accessoire :
//! `prop_distance`) ; des blocs enflammés au hasard ; puis le souffle, qui pousse tout ce qui est
//! proche et éprouve les liaisons des morceaux poussés. Les barils voisins s'allument et sautent à
//! leur tour (réaction en chaîne, props.rs).
//!
//! Il n'y a pas encore de projectiles ni de murs d'énergie (rien à abattre, rien qui arrête le
//! souffle) ; une explosion qui laisserait une flaque de feu (le napalm) est comptée dans
//! `Stats.unported`.

use super::catalog::{Explosion, catalog};
use super::damage::{DamageBatch, Target, resolve_damage};
use super::debris::block_world_pos;
use super::fire::{BURN_TIME, ignite, ignite_prop};
use super::props::{present, prop, prop_distance, prop_mass, prop_nearest};
use super::vec::{V3, add, len, norm, scale, sub, v3};
use super::world::Sim;
use crate::jsmath;
use rapier3d::prelude::RigidBodyHandle;

/// Dégâts d'une explosion à `distance` m de son centre (`explosionDamageAt`, catalog/weapons.ts).
fn damage_at(ex: &Explosion, distance: f64) -> f64 {
    if distance >= ex.radius {
        return 0.0;
    }
    ex.damage * (1.0 - distance / ex.radius)
}

fn distance(a: V3, b: V3) -> f64 {
    jsmath::hypot3(a.x - b.x, a.y - b.y, a.z - b.z)
}

/// Position d'une roue montée (sa pose calculée) ou arrachée (son corps) (`w.rb.translation()`).
fn wheel_pos(sim: &Sim, bot: usize, w: usize) -> V3 {
    let wheel = &sim.bots[bot].wheels[w];
    match wheel.body {
        Some(rb) => sim.phys.translation(rb),
        None => wheel.rb.pos,
    }
}

/// Explosion en `point` (`explode`), d'un accessoire qui saute (sans tireur) : `dir`, la direction
/// du coup (les débris partent de ce côté).
pub fn explode(sim: &mut Sim, point: V3, ex: &Explosion, dir: V3) {
    let mut batch = DamageBatch::default();
    for bot in 0..sim.bots.len() {
        for b in 0..sim.bots[bot].blocks.len() {
            if !sim.bots[bot].blocks[b].alive {
                continue;
            }
            let amount = damage_at(ex, distance(block_world_pos(sim, bot, b), point));
            batch.add(sim, Some(Target::Block(bot, b)), amount, "explosive");
        }
        for w in 0..sim.bots[bot].wheels.len() {
            let wheel = &sim.bots[bot].wheels[w];
            if wheel.part.is_some() || wheel.body.is_some() {
                let amount = damage_at(ex, distance(wheel_pos(sim, bot, w), point));
                batch.add(sim, Some(Target::Wheel(bot, w)), amount, "explosive");
            }
        }
    }
    for i in present(sim) {
        let amount = damage_at(ex, prop_distance(sim, i, point));
        batch.add(sim, Some(Target::Prop(i)), amount, "explosive");
    }
    sim.stats.explosions += 1;
    // (pas de projectiles : rien à abattre, pas de mines à faire sauter)
    resolve_damage(sim, &batch, dir);
    // Une explosion incendiaire enflamme une partie des blocs restés entiers dans sa zone, et du bois du décor
    if ex.ignite != 0.0 {
        for &((bot, b), _) in &batch.blocks {
            if sim.bots[bot].blocks[b].alive && sim.rng.rand(0.0, 1.0) < ex.ignite {
                ignite(sim, bot, b, BURN_TIME);
            }
        }
        for i in present(sim) {
            let p = prop(sim, i);
            if p.burn <= 0.0 && p.def().burns.is_some() && prop_distance(sim, i, point) < ex.radius && sim.rng.rand(0.0, 1.0) < ex.ignite {
                ignite_prop(sim, i);
            }
        }
    }
    // Le napalm laisserait une flaque de feu au sol (pas encore porté)
    if ex.puddle {
        sim.stats.unported += 1;
    }
    // Le souffle agit sur ce qui reste ; ses chocs peuvent rompre des liaisons
    let mut shocks = DamageBatch::default();
    blast(sim, point, dir, ex, &mut shocks);
    resolve_damage(sim, &shocks, dir);
    // (la réaction de l'IA ne sert pas à des robots pilotés ; un événement `damage`)
    sim.stats.damage += 1;
}

/// Pousse un corps proche du centre (`push`) ; l'impulsion donnée.
fn push(sim: &mut Sim, rb: RigidBodyHandle, at: V3, point: V3, dir: V3, ex: &Explosion, falloff: f64, mult: f64) -> V3 {
    let radial = norm(sub(at, point));
    let d = norm(add(add(scale(radial, 0.6), scale(dir, 0.4)), v3(0.0, ex.lift, 0.0)));
    let impulse = scale(d, ex.power * falloff * mult);
    sim.phys.apply_impulse_at_point(rb, impulse, at, true);
    impulse
}

/// Souffle (`blast`) : pousse les corps proches du centre. Le choc reçu par chaque morceau (somme des
/// poussées, au point moyen où elles s'appliquent) est ajouté à `shocks`.
fn blast(sim: &mut Sim, point: V3, dir: V3, ex: &Explosion, shocks: &mut DamageBatch) {
    for bot in 0..sim.bots.len() {
        for part in sim.bots[bot].parts.clone() {
            let mut total = v3(0.0, 0.0, 0.0);
            let mut where_ = v3(0.0, 0.0, 0.0);
            let mut weight = 0.0;
            let rb = sim.part(part).rb;
            for b in sim.part(part).blocks.clone() {
                let p = block_world_pos(sim, bot, b);
                let dist = distance(p, point);
                if dist < ex.blast_radius {
                    let f = 1.0 - dist / ex.blast_radius;
                    let impulse = push(sim, rb, p, point, dir, ex, f * f, 1.0);
                    total = add(total, impulse);
                    where_ = add(where_, scale(p, len(impulse)));
                    weight += len(impulse);
                }
            }
            if weight > 0.0 {
                shocks.shock(sim, part, scale(where_, 1.0 / weight), total, None);
            }
        }
        // Les roues arrachées ; celles qui sont montées suivent leur morceau, déjà poussé
        for w in 0..sim.bots[bot].wheels.len() {
            let wheel = &sim.bots[bot].wheels[w];
            let Some(body) = wheel.body else { continue };
            let reach = ex.blast_radius + wheel.def.radius;
            let p = sim.phys.translation(body);
            let dist = distance(p, point);
            if dist < reach {
                push(sim, body, p, point, dir, ex, jsmath::max(0.3, 1.0 - dist / reach), 2.0);
            }
        }
    }
    for i in present(sim) {
        let p = prop(sim, i);
        // (ancré : le souffle ne le pousse pas)
        if p.fixed {
            continue;
        }
        let reach = ex.blast_radius + 0.5;
        let dist = prop_distance(sim, i, point);
        if dist < reach {
            let (rb, mass) = (p.rb, prop_mass(&catalog().props[&p.kind], p.half));
            let at = prop_nearest(sim, i, point);
            push(sim, rb, at, point, dir, ex, 1.0 - dist / reach, mass / 2.0);
        }
    }
    for k in 0..sim.debris.len() {
        let rb = sim.debris[k].rb;
        let p = sim.phys.translation(rb);
        let dist = distance(p, point);
        if dist < ex.blast_radius {
            push(sim, rb, p, point, dir, ex, (1.0 - dist / ex.blast_radius) * 0.15, 1.0);
        }
    }
}
