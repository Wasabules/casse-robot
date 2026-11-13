//! Les fumigènes (src/shared/combat/smoke.ts) : un nuage, lâché par l'obus ou la mine fumigène qui
//! éclate (projectiles.rs, `detonate`), grandit en une seconde, tient, puis se dissipe. Il n'arrête
//! pas les projectiles, mais il coupe la vue : une tourelle ne tire pas sur ce qu'elle ne voit pas
//! (gunner.rs, `clearShot`), la détection (detection.rs) et les têtes chercheuses ou le verrouillage
//! (sight.rs) ne voient pas à travers.

use super::events::{Writer, code};
use super::catalog::SmokeSpec;
use super::vec::{V3, add, clamp, dot, len, scale, sub};
use super::world::Sim;

/// Temps pour qu'un nuage atteigne sa taille (s), et durée de sa dissipation finale (s).
const GROWTH: f64 = 1.2;
const FADE: f64 = 3.0;
/// Sous ce rayon (m), un nuage ne cache plus rien (`MIN_COVER`).
const MIN_COVER: f64 = 0.8;

/// Un nuage de fumée (`SmokeCloud`) : son centre, son rayon final (m), quand il est né et sa durée (s).
pub struct SmokeCloud {
    /// Son numéro d'entité (`id`, `sim.nextId()`).
    pub id: u64,
    pub pos: V3,
    pub radius: f64,
    pub born: f64,
    pub life: f64,
}

/// Lâche un nuage en `pos` (`releaseSmoke`).
pub fn release_smoke(sim: &mut Sim, pos: V3, spec: &SmokeSpec) {
    let id = sim.next_id();
    sim.smokes.push(SmokeCloud { id, pos, radius: spec.radius, born: sim.time, life: spec.duration });
    sim.stats.smokes_added += 1;
    sim.emit(code::SMOKE_ADDED, |s, w| write_smoke(w, s.smokes.last().expect("nuage")));
}

/// Rayon actuel d'un nuage (m) : il grandit, puis rétrécit en se dissipant (`smokeRadius`).
pub fn smoke_radius(cloud: &SmokeCloud, time: f64) -> f64 {
    let age = time - cloud.born;
    let grow = clamp(age / GROWTH, 0.0, 1.0);
    let fade = clamp((cloud.life - age) / FADE, 0.0, 1.0);
    cloud.radius * grow * fade
}

/// Retire les nuages dissipés (`updateSmokes`).
pub fn update_smokes(sim: &mut Sim) {
    if sim.smokes.is_empty() {
        return;
    }
    let time = sim.time;
    let mut k = 0;
    while k < sim.smokes.len() {
        let c = &sim.smokes[k];
        if time - c.born < c.life {
            k += 1;
        } else {
            let id = sim.smokes.remove(k).id;
            sim.stats.smokes_removed += 1;
            sim.emit_gone(code::SMOKE_REMOVED, id);
        }
    }
}

/// Un nuage tel que l'encodeur le décrit : son numéro, son centre, son rayon, sa naissance, sa durée.
pub fn write_smoke(w: &mut Writer, c: &SmokeCloud) {
    w.id(Some(c.id)).vec(c.pos).num(c.radius).num(c.born).num(c.life);
}

/// La fumée cache-t-elle `to` quand on regarde depuis `from` (`smokeBlocks`) ? Vrai si le segment
/// traverse un nuage.
pub fn smoke_blocks(sim: &Sim, from: V3, to: V3) -> bool {
    let seg = sub(to, from);
    let length = len(seg);
    for cloud in &sim.smokes {
        let r = smoke_radius(cloud, sim.time);
        if r < MIN_COVER {
            continue;
        }
        // (`length ? … : 0` : 0 et NaN sont « faux »)
        let t = if length != 0.0 && !length.is_nan() { clamp(dot(sub(cloud.pos, from), seg) / (length * length), 0.0, 1.0) } else { 0.0 };
        if len(sub(cloud.pos, add(from, scale(seg, t)))) < r {
            return true;
        }
    }
    false
}
