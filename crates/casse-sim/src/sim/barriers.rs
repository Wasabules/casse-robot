//! Les murs d'énergie (src/shared/combat/barriers.ts) : le projecteur de bouclier lance un projectile
//! qui, au bout de sa course (ou sur ce qu'il touche), se déploie en un rectangle vertical posé au sol,
//! face au tireur (`deployBarrier`). Il arrête les tirs des ennemis de son équipe (leurs projectiles
//! s'y écrasent et lui retirent leurs dégâts : projectiles.rs, `barrierOnPath`) et le souffle de leurs
//! explosions (explosion.rs, `barrierBetween`) ; ses alliés tirent à travers, et les robots le
//! traversent (il n'a pas de collider). Il s'éteint au bout de sa durée, ou se brise à 0 point.
//! L'IA le déploie vers sa cible juste après avoir été touchée (gunner.rs, `barrierUseful`).
//!
//! Le mur se pose sur le sol (le relief : `groundLevel`, arena.rs).

use super::events::{Writer, code};
use super::arena::ground_level;
use super::catalog::BarrierSpec;
use super::vec::{V3, add, cross, dot, norm, scale, sub, v3};
use super::world::Sim;
use crate::jsmath;

/// Le mur descend un peu sous le sol : rien ne passe dessous (`SINK`).
const SINK: f64 = 0.2;

/// Un mur d'énergie déployé (`Barrier`) : son équipe, le centre du rectangle et sa normale
/// (horizontale, unitaire, vers l'ennemi), ses dimensions (m), ses points, jusqu'à quand il tient.
pub struct Barrier {
    /// Son numéro d'entité (`id`, `sim.nextId()`) et ses points de départ (`maxHp`).
    pub id: u64,
    pub max_hp: f64,
    pub team: usize,
    pub center: V3,
    pub normal: V3,
    pub width: f64,
    pub height: f64,
    pub hp: f64,
    pub until: f64,
}

/// Déploie le mur du projecteur qui a lancé le projectile `i`, en `point`, face à celui qui arrive par
/// `dir` (`deployBarrier`) ; sans tireur, rien.
pub fn deploy_barrier(sim: &mut Sim, i: usize, point: V3, dir: V3, spec: &BarrierSpec) {
    let Some(shooter) = sim.projectiles[i].shooter else { return };
    let team = sim.bots[shooter].team;
    let flat = norm(v3(dir.x, 0.0, dir.z));
    let normal = if jsmath::hypot2(flat.x, flat.z) > 0.5 { flat } else { v3(0.0, 0.0, 1.0) };
    // (le sol sous lui, ou le relief)
    let ground = ground_level(sim, point.x, point.z);
    let id = sim.next_id();
    sim.barriers.push(Barrier {
        id,
        max_hp: spec.hp,
        team,
        center: v3(point.x, ground - SINK + spec.height / 2.0, point.z),
        normal,
        width: spec.width,
        height: spec.height,
        hp: spec.hp,
        until: sim.time + spec.life,
    });
    sim.stats.barriers_added += 1;
    sim.emit(code::BARRIER_ADDED, |s, w| write_barrier(w, s.barriers.last().expect("mur")));
}

/// Un mur tel que l'encodeur le décrit : son numéro, son équipe, son centre, sa normale, ses
/// dimensions, ses points, ses points de départ, sa fin.
pub fn write_barrier(w: &mut Writer, b: &Barrier) {
    w.id(Some(b.id)).num(b.team as f64).vec(b.center).vec(b.normal).num(b.width).num(b.height).num(b.hp).num(b.max_hp).num(b.until);
}

/// Distance le long de `dir` (unitaire) où le rayon parti de `from` traverse le rectangle du mur, ou
/// rien (`crossing`).
fn crossing(b: &Barrier, from: V3, dir: V3) -> Option<f64> {
    let facing = dot(dir, b.normal);
    if facing.abs() < 1e-6 {
        return None;
    }
    let t = dot(sub(b.center, from), b.normal) / facing;
    if t < 0.0 {
        return None;
    }
    let at = sub(add(from, scale(dir, t)), b.center);
    let side = cross(v3(0.0, 1.0, 0.0), b.normal);
    if dot(at, side).abs() > b.width / 2.0 || at.y.abs() > b.height / 2.0 {
        return None;
    }
    Some(t)
}

/// Premier mur que coupe le segment de `from` à `from + dir × length` (`dir` unitaire), parmi ceux qui
/// arrêtent l'équipe `team` (tous sauf les siens ; sans équipe, tous) : son rang et la distance
/// (`barrierOnPath`).
pub fn barrier_on_path(sim: &Sim, from: V3, dir: V3, length: f64, team: Option<usize>) -> Option<(usize, f64)> {
    let mut best: Option<(usize, f64)> = None;
    for (k, b) in sim.barriers.iter().enumerate() {
        // (`stops` : il arrête tout ce qui n'est pas de son équipe)
        if Some(b.team) == team {
            continue;
        }
        if let Some(t) = crossing(b, from, dir)
            && t <= length
            && best.is_none_or(|(_, d)| t < d)
        {
            best = Some((k, t));
        }
    }
    best
}

/// Un mur hostile à `team` sépare-t-il `a` de `b` (le souffle d'une explosion ne le traverse pas)
/// (`barrierBetween`) ?
pub fn barrier_between(sim: &Sim, a: V3, b: V3, team: Option<usize>) -> bool {
    if sim.barriers.is_empty() {
        return false;
    }
    let d = sub(b, a);
    let length = jsmath::hypot3(d.x, d.y, d.z);
    if length < 1e-6 {
        return false;
    }
    barrier_on_path(sim, a, scale(d, 1.0 / length), length, team).is_some()
}

/// Un tir retire `damage` points au mur `k` ; à 0, il se brise (`damageBarrier`).
pub fn damage_barrier(sim: &mut Sim, k: usize, damage: f64, point: V3) {
    sim.barriers[k].hp -= damage;
    sim.stats.barrier_hits += 1;
    sim.emit(code::BARRIER_HIT, |s, w| {
        let b = &s.barriers[k];
        w.id(Some(b.id)).num(b.hp).vec(point);
    });
    if sim.barriers[k].hp <= 0.0 {
        remove_barrier(sim, k, true);
    }
}

/// Un mur disparaît, brisé ou éteint (`removeBarrier`).
pub fn remove_barrier(sim: &mut Sim, k: usize, broken: bool) {
    let b = sim.barriers.remove(k);
    sim.stats.barriers_removed += 1;
    sim.emit(code::BARRIER_REMOVED, |_, w| {
        w.id(Some(b.id)).flag(broken);
    });
}

/// Les murs arrivés au bout de leur durée s'éteignent (`updateBarriers`).
pub fn update_barriers(sim: &mut Sim) {
    let time = sim.time;
    let mut k = 0;
    while k < sim.barriers.len() {
        if time >= sim.barriers[k].until {
            remove_barrier(sim, k, false);
        } else {
            k += 1;
        }
    }
}
