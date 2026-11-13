//! L'interception (src/shared/combat/interception.ts) : les projectiles qu'on peut abattre (une coque :
//! missiles, roquettes, ogive) sont des sphères que les balles, les obus, les rayons touchent en
//! passant (`projectileOnPath`, projectiles.rs) et que les explosions atteignent (`blastProjectiles`).
//! À 0 point de structure, ils éclatent au pas suivant, là où ils sont (`blown`) ; une mine posée
//! aussi, et une explosion fait sauter celles qui sont proches (mines.rs, `blowMines`).

use super::catalog::{Explosion, ProjectileSpec};
use super::mines::blow_mines;
use super::projectiles::Projectile;
use super::vec::{V3, dot, sub};
use super::world::Sim;
use crate::jsmath;

/// Un projectile de ce genre touche-t-il ceux qu'on peut abattre (`strikesProjectiles`) ? Balles,
/// obus, plombs, rayons, flammes ; pas un missile, une mine, un leurre, un rayon réparateur.
pub fn strikes_projectiles(spec: &ProjectileSpec) -> bool {
    spec.damage > 0.0 && spec.guidance.is_none() && spec.mine.is_none() && !spec.decoy && spec.repair.is_none()
}

/// Distance le long du rayon (origine, direction unitaire) où il entre dans la sphère ; 0 s'il part
/// de dedans ; rien s'il la manque (`sphereHit`).
fn sphere_hit(from: V3, dir: V3, center: V3, radius: f64) -> Option<f64> {
    let oc = sub(center, from);
    let along = dot(oc, dir);
    let miss = dot(oc, oc) - along * along;
    if miss > radius * radius {
        return None;
    }
    let t = along - (radius * radius - miss).sqrt();
    if t >= 0.0 {
        return Some(t);
    }
    if dot(oc, oc) <= radius * radius { Some(0.0) } else { None }
}

/// Premier projectile abattable que coupe le segment parti de `from` (direction unitaire `dir`, sur
/// `length` m), et la distance où il le touche ; pas `i` lui-même, ni ceux du même tireur (`projectileOnPath`).
pub fn projectile_on_path(sim: &Sim, i: usize, from: V3, dir: V3, length: f64) -> Option<(usize, f64)> {
    let shooter = sim.projectiles[i].shooter;
    let mut best = None;
    let mut best_t = length;
    for (k, q) in sim.projectiles.iter().enumerate() {
        if k == i || q.done || q.blown || (shooter.is_some() && q.shooter == shooter) {
            continue;
        }
        let Some((radius, _)) = q.def().projectile.hull else { continue };
        if let Some(t) = sphere_hit(from, dir, q.pos, radius)
            && t < best_t
        {
            best = Some(k);
            best_t = t;
        }
    }
    best.map(|k| (k, best_t))
}

/// Un projectile abattable encaisse `damage` points : à 0, il éclatera au pas suivant (`damageProjectile`).
pub fn damage_projectile(q: &mut Projectile, damage: f64) {
    q.hp -= damage;
    if q.hp <= 0.0 {
        q.blown = true;
    }
}

/// Une explosion en `point` : les projectiles abattables encaissent ses dégâts à leur distance, sauf
/// ceux du même tireur, `attacker` (`blastProjectiles`).
pub fn blast_projectiles(sim: &mut Sim, point: V3, ex: &Explosion, attacker: Option<usize>) {
    // Les mines posées proches sautent au pas suivant, en chaîne (déminage)
    blow_mines(sim, point, ex.radius);
    for q in sim.projectiles.iter_mut() {
        let spec = &q.def().projectile;
        let Some((radius, _)) = spec.hull else { continue };
        if spec.mine.is_some() || q.done || q.blown || (attacker.is_some() && q.shooter == attacker) {
            continue;
        }
        let d = jsmath::hypot3(q.pos.x - point.x, q.pos.y - point.y, q.pos.z - point.z);
        // (`explosionDamageAt`)
        let at = jsmath::max(0.0, d - radius);
        let damage = if at >= ex.radius { 0.0 } else { ex.damage * (1.0 - at / ex.radius) };
        if damage > 0.0 {
            damage_projectile(q, damage);
        }
    }
}
