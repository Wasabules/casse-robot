import type { Terrain } from "../../shared/arena/terrain";
import type { Vec3 } from "../../shared/math/vec";

/**
 * Tolérance des coordonnées barycentriques d'un triangle touché : celle de Babylon (`Ray.epsilon`,
 * la constante `Epsilon` de ses maths), pour viser le relief comme le faisait `scene.pickWithRay`.
 */
const EPSILON = 0.001;

/**
 * Distance le long du rayon (`dir` unitaire) où il touche le relief dessiné, au plus `length` m ;
 * null s'il ne le touche pas. Le même résultat que le lancer de rayon de Babylon sur le maillage du
 * relief (render/arenaView.ts : un sommet par point du champ, en flottants de 32 bits, chaque case
 * coupée le long de sa diagonale (ix+1, iz) – (ix, iz+1)), mais sans parcourir ses triangles : on ne
 * teste que ceux des cases que le rayon survole, de proche en proche. Babylon testait tous ceux des
 * morceaux du maillage dont la boîte croise le rayon : dans la Cité, viser le sol coûtait ~1,4 ms
 * par image (96 800 triangles, en 64 morceaux dont chacun était aussi un appel de dessin).
 */
export function pickTerrain(t: Terrain, origin: Vec3, dir: Vec3, length: number): number | null {
  const n = t.cells + 1;
  const step = t.size / t.cells;
  const half = t.size / 2;
  // Le rayon dans le carré du relief (en x et z) : de `enter` à `leave`
  let enter = 0;
  let leave = length;
  for (const [o, d] of [[origin.x, dir.x], [origin.z, dir.z]] as const) {
    if (Math.abs(d) < 1e-12) {
      if (o < -half || o > half) return null;
      continue;
    }
    const t1 = (-half - o) / d;
    const t2 = (half - o) / d;
    enter = Math.max(enter, Math.min(t1, t2));
    leave = Math.min(leave, Math.max(t1, t2));
  }
  if (enter > leave) return null;
  // Les cases survolées, dans l'ordre (parcours de grille) : leurs deux triangles
  const cellOf = (v: number): number => Math.min(t.cells - 1, Math.max(0, Math.floor((v + half) / step)));
  const sx = origin.x + dir.x * enter, sz = origin.z + dir.z * enter;
  let ix = cellOf(sx), iz = cellOf(sz);
  const stepX = dir.x > 0 ? 1 : -1, stepZ = dir.z > 0 ? 1 : -1;
  const across = (d: number): number => (Math.abs(d) < 1e-12 ? Infinity : step / Math.abs(d));
  const dtx = across(dir.x), dtz = across(dir.z);
  const boundary = (i: number, s: number, o: number, d: number): number => (Math.abs(d) < 1e-12 ? Infinity : (-half + (i + (s > 0 ? 1 : 0)) * step - o) / d);
  let nextX = boundary(ix, stepX, origin.x, dir.x);
  let nextZ = boundary(iz, stepZ, origin.z, dir.z);
  let best: number | null = null;
  // (une case à la fois ; on ne s'arrête qu'une fois au-delà du meilleur point touché : à la tolérance
  // près, un triangle voisin peut le prendre de peu)
  let cellEnter = enter;
  for (;;) {
    if (best !== null && cellEnter > best + step) break;
    const hit = cellHit(t, n, step, half, ix, iz, origin, dir, best ?? length);
    if (hit !== null && (best === null || hit < best)) best = hit;
    if (nextX < nextZ) {
      cellEnter = nextX;
      ix += stepX;
      nextX += dtx;
    } else {
      cellEnter = nextZ;
      iz += stepZ;
      nextZ += dtz;
    }
    if (ix < 0 || iz < 0 || ix >= t.cells || iz >= t.cells || cellEnter > leave) break;
  }
  return best;
}

/** Le plus proche des deux triangles de la case (ix, iz) que touche le rayon avant `length`. */
function cellHit(t: Terrain, n: number, step: number, half: number, ix: number, iz: number, origin: Vec3, dir: Vec3, length: number): number | null {
  // Les sommets comme le maillage les range : coordonnées en flottants de 32 bits
  const x0 = Math.fround(-half + ix * step), x1 = Math.fround(-half + (ix + 1) * step);
  const z0 = Math.fround(-half + iz * step), z1 = Math.fround(-half + (iz + 1) * step);
  const h = t.heights;
  const ya = h[ix * n + iz], yb = h[(ix + 1) * n + iz], yc = h[ix * n + iz + 1], yd = h[(ix + 1) * n + iz + 1];
  // a (ix, iz), b (ix+1, iz), c (ix, iz+1), d (ix+1, iz+1) : triangles (a, b, c) et (b, d, c)
  const first = triangle(origin, dir, length, x0, ya, z0, x1, yb, z0, x0, yc, z1);
  const second = triangle(origin, dir, length, x1, yb, z0, x1, yd, z1, x0, yc, z1);
  if (first === null) return second;
  if (second === null) return first;
  return Math.min(first, second);
}

/** Möller–Trumbore, des deux côtés, comme `Ray.intersectsTriangle` de Babylon : la distance, ou null. */
function triangle(o: Vec3, d: Vec3, length: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): number | null {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const px = d.y * e2z - d.z * e2y, py = d.z * e2x - d.x * e2z, pz = d.x * e2y - d.y * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det === 0) return null;
  const inv = 1 / det;
  const tx = o.x - ax, ty = o.y - ay, tz = o.z - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < -EPSILON || u > 1 + EPSILON) return null;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (d.x * qx + d.y * qy + d.z * qz) * inv;
  if (v < -EPSILON || u + v > 1 + EPSILON) return null;
  const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return dist > length || dist < 0 ? null : dist;
}
