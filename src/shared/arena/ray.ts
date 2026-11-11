import { qrotInv, sub, type Vec3 } from "../math/vec";
import type { ArenaLayout, StaticBox } from "./layout";
import { rayTerrain } from "./terrain";

/*
 * Lancer de rayon sur le décor fixe d'une arène, sans physique : le décor est fait de boîtes
 * orientées (données de l'arène). Il sert à la caméra, qui ne doit pas passer derrière un mur, et
 * marche de la même façon en local et en réseau (la réplique n'a pas de physique).
 */

/**
 * Distance le long du rayon (`dir` unitaire) où il entre dans la boîte, si c'est avant `maxDist` ;
 * null sinon, ou si le rayon part de l'intérieur de la boîte (on ne s'arrête pas sur ce qui nous
 * entoure). Méthode des plans : le rayon est ramené dans le repère de la boîte.
 */
function rayBox(box: StaticBox, origin: Vec3, dir: Vec3, maxDist: number): number | null {
  const o = qrotInv(box.rot, sub(origin, box.pos));
  const d = qrotInv(box.rot, dir);
  let near = -Infinity;
  let far = Infinity;
  for (const axis of ["x", "y", "z"] as const) {
    const h = box.half[axis];
    if (Math.abs(d[axis]) < 1e-9) {
      if (Math.abs(o[axis]) > h) return null;
      continue;
    }
    const t1 = (-h - o[axis]) / d[axis];
    const t2 = (h - o[axis]) / d[axis];
    near = Math.max(near, Math.min(t1, t2));
    far = Math.min(far, Math.max(t1, t2));
    if (near > far) return null;
  }
  return near >= 0 && near <= maxDist ? near : null;
}

/**
 * Distance le long du rayon jusqu'au premier élément du décor fixe (murs, piliers, rampes,
 * plateformes, relief ; pas le sol plat), au plus `maxDist` ; null : rien.
 */
export function rayArena(arena: ArenaLayout, origin: Vec3, dir: Vec3, maxDist: number, boxes: readonly StaticBox[] = arena.boxes): number | null {
  let best: number | null = null;
  // (`boxes` : seulement celles-là, déjà triées par l'appelant ; toutes par défaut)
  for (const box of boxes) {
    if (box.kind === "bound") continue; // invisible : la caméra passe au travers
    const t = rayBox(box, origin, dir, best ?? maxDist);
    if (t !== null) best = t;
  }
  if (arena.terrain) {
    const t = rayTerrain(arena.terrain, origin, dir, best ?? maxDist);
    if (t !== null) best = t;
  }
  return best;
}
