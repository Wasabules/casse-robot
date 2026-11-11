import { explosionDamageAt, weaponDef, type Explosion, type ProjectileSpec } from "../catalog/weapons";
import { distance, dot, sub, type Vec3 } from "../math/vec";
import type { Bot, Projectile } from "../sim/entities";
import type { Simulation } from "../sim/simulation";
import { blowMines } from "./mines";

/*
 * Interception : les projectiles qu'on peut abattre (`ProjectileSpec.hull` : missiles, roquettes,
 * ogive, bombes, mines posées) sont des sphères que les balles touchent en passant
 * (`projectileOnPath`, combat/projectiles.ts) et que les explosions atteignent (`blastProjectiles`).
 * À 0 point de structure, ils éclatent au pas suivant, là où ils sont (`Projectile.blown`).
 */

/** Un projectile de ce genre touche-t-il ceux qu'on peut abattre ? Balles, obus, plombs, rayons, flammes ; pas un missile, une mine, un leurre, un rayon réparateur. */
export function strikesProjectiles(spec: ProjectileSpec): boolean {
  return spec.damage > 0 && !spec.guidance && !spec.mine && !spec.decoy && !spec.repair;
}

/**
 * Premier projectile abattable que coupe le segment parti de `from` (direction unitaire `dir`, sur
 * `length` m), et la distance où il le touche. Pas ceux du même tireur.
 */
export function projectileOnPath(sim: Simulation, p: Projectile, from: Vec3, dir: Vec3, length: number): { target: Projectile; distance: number } | null {
  let best: Projectile | null = null;
  let bestT = length;
  for (const q of sim.projectiles) {
    if (q === p || q.done || q.blown || (p.shooter && q.shooter === p.shooter)) continue;
    const hull = weaponDef(q.weapon).projectile.hull;
    if (!hull) continue;
    const t = sphereHit(from, dir, q.pos, hull.radius);
    if (t !== null && t < bestT) {
      best = q;
      bestT = t;
    }
  }
  return best ? { target: best, distance: bestT } : null;
}

/** Distance le long du rayon (origine, direction unitaire) où il entre dans la sphère ; 0 s'il part de dedans ; null s'il la manque. */
export function sphereHit(from: Vec3, dir: Vec3, center: Vec3, radius: number): number | null {
  const oc = sub(center, from);
  const along = dot(oc, dir);
  const miss = dot(oc, oc) - along * along;
  if (miss > radius * radius) return null;
  const t = along - Math.sqrt(radius * radius - miss);
  if (t >= 0) return t;
  return dot(oc, oc) <= radius * radius ? 0 : null;
}

/** Un projectile abattable encaisse `damage` points : à 0, il éclatera au pas suivant. */
export function damageProjectile(q: Projectile, damage: number): void {
  q.hp -= damage;
  if (q.hp <= 0) q.blown = true;
}

/**
 * Une explosion en `point` : les mines posées à portée sautent (déminage, voir `blowMines`), les
 * autres projectiles abattables encaissent ses dégâts à leur distance, sauf ceux du même tireur
 * (`attacker`) : une salve de missiles, un chapelet de bombes, ne s'abattent pas eux-mêmes.
 */
export function blastProjectiles(sim: Simulation, point: Vec3, explosion: Explosion, attacker: Bot | null): void {
  blowMines(sim, point, explosion.radius);
  for (const q of sim.projectiles) {
    const spec = weaponDef(q.weapon).projectile;
    if (!spec.hull || spec.mine || q.done || q.blown || (attacker && q.shooter === attacker)) continue;
    const damage = explosionDamageAt(explosion, Math.max(0, distance(q.pos, point) - spec.hull.radius));
    if (damage > 0) damageProjectile(q, damage);
  }
}
