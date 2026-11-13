//! L'aérodynamique (src/shared/robot/aero.ts, robot/surfaces.ts) : portance et traînée d'une plaque
//! plane par aile ou gouverne, appliquées au morceau qui la porte (une aile arrachée plane encore) ;
//! les gouvernes reliées au cockpit, par rangs (des gouvernes bout à bout le long de leur envergure,
//! liées entre elles, braquent d'un seul angle : `flapRuns`) ; le mélangeur, qui braque les gouvernes
//! d'après la position du manche et l'effet réel de chacune (`steerSurfaces`, moindres carrés bornés).

use super::catalog::{AeroSpec, catalog};
use super::debris::block_world_pos;
use super::linalg::bounded_least_squares;
use super::robot::{Cell, link_key};
use super::vec::{V3, add, clamp, cross, dot, qrot, scale, sub, v3};
use super::world::{STEP, Sim};
use crate::det::{dcos, dsin};
use crate::jsmath;

/// Masse volumique de l'air (kg/m³) (config.ts).
pub const AIR_DENSITY: f64 = 1.225;
/// Vitesse de braquage des gouvernes (rad/s).
const SERVO_RATE: f64 = 3.0;

/// La surface portante d'un bloc (`aeroOf`).
pub fn aero_of(sim: &Sim, b: usize, block: usize) -> AeroSpec {
    catalog().blocks[&sim.bots[b].blocks[block].kind].aero.expect("bloc sans surface portante")
}

/// Coefficients de portance et de traînée d'une plaque à l'incidence α (rad) (`aeroCoefficients`).
fn aero_coefficients(spec: &AeroSpec, alpha: f64) -> (f64, f64) {
    // (ramené dans ]-π, π])
    let a = dsin(alpha).atan2(dcos(alpha));
    if a.abs() <= spec.stall_angle {
        let cl = spec.lift_slope * a;
        return (cl, spec.drag_min + spec.induced_drag * cl * cl);
    }
    // Décroché : l'écoulement décolle, la plaque ne porte presque plus et freine beaucoup
    let s = dsin(a);
    (0.9 * dsin(2.0 * a), spec.drag_min + 1.2 * s * s)
}

/// Écoulement de l'air sur une surface (`Flow`) : position, carré de la vitesse dans le plan de la
/// corde, incidence, directions de la portance et de la traînée.
pub struct Flow {
    pub p: V3,
    pub speed2: f64,
    alpha: f64,
    pub lift_dir: V3,
    drag_dir: V3,
}

/// L'écoulement sur la surface `s` du robot `b` (`flowAt`) ; rien s'il est presque nul.
pub fn flow_at(sim: &Sim, b: usize, s: usize) -> Option<Flow> {
    let surface = sim.bots[b].surfaces[s];
    let block = &sim.bots[b].blocks[surface.block];
    let rb = sim.part(block.part).rb;
    let q = sim.phys.rotation(rb);
    let p = block_world_pos(sim, b, surface.block);
    // (la vitesse du bloc dans l'air immobile)
    let v = add(sim.phys.linvel(rb), cross(sim.phys.angvel(rb), sub(p, sim.phys.world_com(rb))));
    let n = qrot(q, block.up);
    let f = qrot(q, block.forward);
    let vn = dot(v, n);
    let vf = dot(v, f);
    // (on ignore l'écoulement le long de l'envergure)
    let speed2 = vn * vn + vf * vf;
    if speed2 < 0.04 {
        return None;
    }
    let speed = speed2.sqrt();
    Some(Flow {
        p,
        speed2,
        alpha: (-vn).atan2(vf) + surface.deflection,
        // Portance : perpendiculaire au vent relatif, du côté du haut de la surface
        lift_dir: scale(sub(scale(n, vf), scale(f, vn)), 1.0 / speed),
        drag_dir: scale(add(scale(n, vn), scale(f, vf)), -1.0 / speed),
    })
}

/// Portance et traînée de toutes les surfaces d'un robot, appliquées sur le morceau qui porte chacune
/// (`applyAerodynamics`).
pub fn apply_aerodynamics(sim: &mut Sim, b: usize) {
    for s in 0..sim.bots[b].surfaces.len() {
        let block = sim.bots[b].surfaces[s].block;
        if !sim.bots[b].blocks[block].alive {
            continue;
        }
        let Some(flow) = flow_at(sim, b, s) else { continue };
        let spec = aero_of(sim, b, block);
        let (cl, cd) = aero_coefficients(&spec, flow.alpha);
        let q = 0.5 * AIR_DENSITY * flow.speed2 * spec.area;
        let force = add(scale(flow.lift_dir, q * cl), scale(flow.drag_dir, q * cd));
        let rb = sim.part(sim.bots[b].blocks[block].part).rb;
        sim.phys.apply_impulse_at_point(rb, scale(force, STEP), flow.p, true);
    }
}

/// Gouvernes encore reliées au cockpit (`liveFlaps`) : leurs rangs dans `bot.surfaces`.
pub fn live_flaps(sim: &Sim, b: usize) -> Vec<usize> {
    let bot = &sim.bots[b];
    if !bot.cockpit_alive() {
        return Vec::new();
    }
    let ck = bot.cockpit_part();
    (0..bot.surfaces.len())
        .filter(|&s| {
            let k = &bot.blocks[bot.surfaces[s].block];
            // (`maxDeflection` : absent ou nul, une aile fixe)
            k.alive && k.part == ck && aero_of(sim, b, bot.surfaces[s].block).max_deflection.is_some_and(|d| d != 0.0)
        })
        .collect()
}

/// Voisin lié d'un bloc en jeu (`linkedAt`) : le bloc vivant de la case décalée, sur le même morceau,
/// liaison intacte.
fn linked_at(sim: &Sim, b: usize, block: usize, d: (i64, i64, i64)) -> Option<usize> {
    let bot = &sim.bots[b];
    let k = &bot.blocks[block];
    let here = k.cell();
    let cell: Cell = (here.0 + d.0, here.1 + d.1, here.2 + d.2);
    let &n = bot.cells.get(&cell)?;
    let other = &bot.blocks[n];
    (other.alive && other.part == k.part && (bot.cuts.is_empty() || !bot.cuts.contains(&link_key(here, cell)))).then_some(n)
}

/// Décalages de grille des côtés gauche et droit d'une case (envergure : ±x du bloc) (`sideOffsets`).
fn span_offsets(sim: &Sim, b: usize, block: usize) -> [(i64, i64, i64); 2] {
    let k = &sim.bots[b].blocks[block];
    let l = cross(k.up, k.forward);
    let left = (l.x as i64, l.y as i64, l.z as i64);
    [left, (-left.0, -left.1, -left.2)]
}

/// Deux surfaces de la même sorte : même type, même haut, même avant (`joinable`).
fn joinable(sim: &Sim, b: usize, a: usize, c: usize) -> bool {
    let (x, y) = (&sim.bots[b].blocks[a], &sim.bots[b].blocks[c]);
    x.kind == y.kind && x.up == y.up && x.forward == y.forward
}

/// Rangs de gouvernes d'un robot parmi `flaps` (`flapRuns`, `surfaceGroups`) : celles qui se suivent
/// le long de leur envergure, liées entre elles ; chaque rang dans l'ordre de `flaps`.
pub fn flap_runs(sim: &Sim, b: usize, flaps: &[usize]) -> Vec<Vec<usize>> {
    let bot = &sim.bots[b];
    let blocks: Vec<usize> = flaps.iter().map(|&s| bot.surfaces[s].block).collect();
    let index = |block: usize| blocks.iter().position(|&k| k == block);
    let mut seen = vec![false; blocks.len()];
    let mut groups = Vec::new();
    for i in 0..blocks.len() {
        if seen[i] {
            continue;
        }
        seen[i] = true;
        let mut members = vec![i];
        let mut k = 0;
        while k < members.len() {
            let cell = blocks[members[k]];
            for d in span_offsets(sim, b, cell) {
                let Some(n) = linked_at(sim, b, cell, d) else { continue };
                let Some(j) = index(n) else { continue };
                if seen[j] || !joinable(sim, b, cell, n) {
                    continue;
                }
                seen[j] = true;
                members.push(j);
            }
            k += 1;
        }
        members.sort_unstable();
        groups.push(members.into_iter().map(|m| flaps[m]).collect());
    }
    groups
}

/// Mélangeur de commandes (`steerSurfaces`) : braque les gouvernes selon la position du manche `stick`
/// (de -1 à 1 par axe de `axes`, positive : rotation positive autour de l'axe), avec les priorités
/// `weights` ; l'effet de chaque gouverne (un rang) d'après l'écoulement que voit chacun de ses blocs.
pub fn steer_surfaces(sim: &mut Sim, b: usize, stick: &[f64], axes: &[V3], weights: &[f64]) {
    let flaps = live_flaps(sim, b);
    let groups = flap_runs(sim, b, &flaps);
    if groups.is_empty() {
        return;
    }
    let com = sim.phys.world_com(sim.part(sim.bots[b].cockpit_part()).rb);
    let bot = &sim.bots[b];
    let limits: Vec<f64> = groups.iter().map(|g| aero_of(sim, b, bot.surfaces[g[0]].block).max_deflection.unwrap_or(0.0)).collect();
    let effects: Vec<V3> = groups
        .iter()
        .map(|g| {
            let mut effect = v3(0.0, 0.0, 0.0);
            for &s in g {
                let Some(flow) = flow_at(sim, b, s) else { continue };
                let spec = aero_of(sim, b, bot.surfaces[s].block);
                // (N par rad ; l'effet en N·m par rad)
                let k = 0.5 * AIR_DENSITY * flow.speed2 * spec.area * spec.lift_slope;
                effect = add(effect, scale(cross(sub(flow.p, com), flow.lift_dir), k));
            }
            effect
        })
        .collect();
    // Mise à l'échelle pour que le système reste bien conditionné à toutes les vitesses
    let unit = effects.iter().fold(1e-6, |m, e| jsmath::max(m, jsmath::hypot3(e.x, e.y, e.z)));
    let rows: Vec<Vec<f64>> = axes.iter().map(|&a| effects.iter().map(|&e| dot(e, a) / unit).collect()).collect();
    // Couple visé sur chaque axe : la part `stick` de ce que les gouvernes peuvent produire au maximum
    let targets: Vec<f64> = rows
        .iter()
        .enumerate()
        .map(|(k, row)| clamp(stick[k], -1.0, 1.0) * row.iter().enumerate().fold(0.0, |s, (i, c)| s + c.abs() * limits[i]))
        .collect();
    let lo: Vec<f64> = limits.iter().map(|l| -l).collect();
    let command = bounded_least_squares(&rows, &targets, weights, &lo, &limits, 1e-3);
    for (i, g) in groups.iter().enumerate() {
        // Toute la gouverne braque du même angle (un rang qui vient de se former part de la moyenne des siens)
        let bot = &mut sim.bots[b];
        let now = g.iter().fold(0.0, |s, &f| s + bot.surfaces[f].deflection) / g.len() as f64;
        let next = now + clamp(command[i] - now, -SERVO_RATE * STEP, SERVO_RATE * STEP);
        for &s in g {
            bot.surfaces[s].deflection = next;
        }
    }
}
