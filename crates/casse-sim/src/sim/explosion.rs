//! Les explosions (`explode` et `blast`, src/shared/combat/damage.ts) : dégâts de zone sur les blocs,
//! les roues et les accessoires, décroissant avec la distance (à la surface d'un accessoire :
//! `prop_distance`) ; des blocs enflammés au hasard ; puis le souffle, qui pousse tout ce qui est
//! proche et éprouve les liaisons des morceaux poussés. Les barils voisins s'allument et sautent à
//! leur tour (réaction en chaîne, props.rs).
//!
//! Une explosion de napalm laisse une flaque de feu au sol, sous elle (fire.rs). Elle atteint les
//! projectiles qu'on peut abattre, et fait sauter les mines proches (interception.rs). Les explosions
//! sont celles des accessoires qui sautent, des projectiles qui éclatent (projectiles.rs), et celles
//! que l'essai fait partir (`sim_explode` : celle d'une mine qui saute, avec le robot qui l'a posée).
//! Un mur d'énergie hostile à celui qui la fait partir protège les blocs et les roues qu'il sépare de
//! son centre (barriers.rs, `barrierBetween`) ; pas les accessoires, ni du souffle.

use super::barriers::barrier_between;
use super::brain::react;
use super::catalog::{Explosion, catalog};
use super::damage::{DamageBatch, Target, is_arm, resolve_damage};
use super::events::code;
use super::debris::block_world_pos;
use super::interception::blast_projectiles;
use super::fire::{BURN_TIME, PUDDLE_REACH, ground_below, ignite, ignite_prop, spawn_ground_fire};
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

/// Explosion en `point` (`explode`) : `dir`, la direction du coup (les débris partent de ce côté) ;
/// `shooter`, d'où elle vient (l'IA des robots touchés réagit : ils fuient, ou foncent dessus) ;
/// `attacker`, le robot à l'origine de l'explosion (aucun pour un accessoire qui saute) : la flaque
/// de feu qu'elle laisse est la sienne, et il est le dernier attaquant de ceux qu'elle touche ;
/// `cause`, sa cause (`KillCause`) : une arme (l'obus d'un canon ; pas un baril, « blast », ni la mine de
/// l'essai, qui n'en nomme pas) donne à chaque robot touché un retour de tir.
pub fn explode(sim: &mut Sim, point: V3, ex: &Explosion, dir: V3, shooter: V3, attacker: Option<usize>, cause: Option<&'static str>) {
    let armed = is_arm(cause);
    let mut batch = DamageBatch { attacker, armed, cause, ..DamageBatch::default() };
    // Un mur d'énergie hostile au tireur arrête le souffle (barriers.rs)
    let team = attacker.map(|a| sim.bots[a].team);
    let reach = |sim: &Sim, at: V3| -> f64 {
        let d = distance(at, point);
        if d < ex.radius && barrier_between(sim, point, at, team) { 0.0 } else { damage_at(ex, d) }
    };
    for bot in sim.roster.clone() {
        for b in sim.bots[bot].live.clone() {
            let amount = reach(sim, block_world_pos(sim, bot, b));
            batch.add(sim, Some(Target::Block(bot, b)), amount, "explosive");
        }
        for w in 0..sim.bots[bot].wheels.len() {
            let wheel = &sim.bots[bot].wheels[w];
            if wheel.part.is_some() || wheel.body.is_some() {
                let amount = reach(sim, wheel_pos(sim, bot, w));
                batch.add(sim, Some(Target::Wheel(bot, w)), amount, "explosive");
            }
        }
    }
    for i in present(sim) {
        let amount = damage_at(ex, prop_distance(sim, i, point));
        batch.add(sim, Some(Target::Prop(i)), amount, "explosive");
    }
    sim.stats.explosions += 1;
    sim.emit(code::EXPLOSION, |_, w| {
        w.vec(point).num(ex.radius).text(ex.look);
    });
    // Les projectiles qu'on peut abattre encaissent (pas ceux du même tireur ; pas de mine à faire sauter)
    blast_projectiles(sim, point, ex, attacker);
    let mut hit = resolve_damage(sim, &batch, dir);
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
    // Le napalm laisse une flaque de feu au sol, sous l'explosion
    if let Some(puddle) = ex.puddle
        && let Some(ground) = ground_below(sim, point, PUDDLE_REACH)
    {
        spawn_ground_fire(sim, ground, puddle, attacker);
    }
    // Le souffle agit sur ce qui reste ; ses chocs peuvent rompre des liaisons
    let mut shocks = DamageBatch { attacker, armed, cause, ..DamageBatch::default() };
    // (un `Set` : un robot touché par les dégâts et par le souffle ne réagit qu'une fois ; un robot
    // volant monte d'autant à chaque réaction)
    let blasted = blast(sim, point, dir, ex, &mut shocks);
    let shocked = resolve_damage(sim, &shocks, dir);
    for b in blasted.into_iter().chain(shocked) {
        if !hit.contains(&b) {
            hit.push(b);
        }
    }
    // Les robots touchés réagissent, chacun une fois ; un événement `damage`
    react(sim, &hit, Some(shooter));
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
/// poussées, au point moyen où elles s'appliquent) est ajouté à `shocks`. Les robots poussés.
fn blast(sim: &mut Sim, point: V3, dir: V3, ex: &Explosion, shocks: &mut DamageBatch) -> Vec<usize> {
    let mut touched = Vec::new();
    for bot in sim.roster.clone() {
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
                    if !touched.contains(&bot) {
                        touched.push(bot);
                    }
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
    touched
}
