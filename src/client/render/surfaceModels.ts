import { BLOCK_SIZE, PLATE_THICKNESS } from "../../shared/config";
import { qrot, type Quat, type Vec3 } from "../../shared/math/vec";
import { CLOSED_LEFT, CLOSED_RIGHT, SEAMLESS_FRONT, SEAMLESS_REAR, SIDE_FRONT, SIDE_LEFT, SIDE_REAR, SIDE_RIGHT } from "../../shared/robot/surfaces";

/*
 * Ailes et gouvernes : la géométrie d'une case, selon son profil (bits `SIDE_*`, `SEAMLESS_*` et
 * `CLOSED_*`, voir `surfaceSides`, shared/robot/surfaces.ts). Repère du bloc : envergure le long de x (gauche
 * +x), haut +y, corde le long de z (l'air arrive par +z). Une case va d'un bord à l'autre de sa
 * case, de toute son épaisseur : posées côte à côte, des cases font une seule aile, sans jour ni
 * arête entre elles. Un côté façonné finit l'aile : bord d'attaque arrondi devant (l'axe de la
 * charnière d'une gouverne, au centre de son arrondi), bord de fuite effilé derrière, saumon arrondi
 * au bout de l'envergure. Là où la case continue dans sa voisine (une aile derrière une aile, la
 * case suivante d'un rang, du même profil), rien n'est dessiné entre elles ; ailleurs, une face
 * droite ferme le côté. Pas de Babylon ici : des tableaux, que materials.ts et worldView.ts
 * mettent en meshes.
 */

export interface SurfaceGeometry {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

const H = BLOCK_SIZE / 2;
/** Demi-épaisseur de la plaque (celle des collisions). */
const T = PLATE_THICKNESS / 2;
/** Rayon du bord d'attaque, longueur et demi-épaisseur finale du bord de fuite, longueur du saumon (m). */
const NOSE = T;
const TAPER = 0.18;
const EDGE = 0.008;
const TIP = 0.07;
/** Facettes de l'arrondi du bord d'attaque, et anneaux du saumon. */
const NOSE_STEPS = 6;
const TIP_RINGS = 4;

/**
 * Un point du profil (coupe dans le plan z, y) ; `nz`, `ny` : sa normale s'il est sur l'arrondi du
 * bord d'attaque ; `open` : le côté qui part de lui n'est pas dessiné (l'aile continue par là).
 */
interface ProfilePoint {
  z: number;
  y: number;
  arc: boolean;
  nz: number;
  ny: number;
  open: boolean;
}

/**
 * Profil d'une case, parcouru de façon que la normale sortante d'un côté (p → q) ait pour
 * composantes y = -(q.z - p.z) et z = q.y - p.y : le dessus de l'avant vers l'arrière, l'arrière
 * vers le bas, le dessous vers l'avant, puis l'avant vers le haut.
 */
function profile(sides: number): ProfilePoint[] {
  const front = (sides & SIDE_FRONT) !== 0;
  const rear = (sides & SIDE_REAR) !== 0;
  const pt = (z: number, y: number, arc = false, nz = 0, ny = 0, open = false): ProfilePoint => ({ z, y, arc, nz, ny, open });
  const zFront = front ? H - NOSE : H;
  const out = [pt(zFront, T, front, 0, 1)];
  if (rear) {
    const zRear = -H + TAPER;
    out.push(pt(zRear, T), pt(-H, EDGE), pt(-H, -EDGE), pt(zRear, -T));
  } else {
    out.push(pt(-H, T, false, 0, 0, (sides & SEAMLESS_REAR) !== 0), pt(-H, -T));
  }
  out.push(pt(zFront, -T, front, 0, -1, !front && (sides & SEAMLESS_FRONT) !== 0));
  if (front) {
    for (let i = 1; i < NOSE_STEPS; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / NOSE_STEPS;
      out.push(pt(H - NOSE + NOSE * Math.cos(a), NOSE * Math.sin(a), true, Math.cos(a), Math.sin(a)));
    }
  }
  return out;
}

type V3 = [number, number, number];
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function unit(v: V3, fallback: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l < 1e-9 ? fallback : [v[0] / l, v[1] / l, v[2] / l];
}

/** Sommets et triangles ; un triangle est tourné pour être vu de son côté `outward`. */
class Builder {
  readonly g: SurfaceGeometry = { positions: [], normals: [], uvs: [], indices: [] };
  private readonly points: V3[] = [];

  /** Un sommet ; sa texture, vue d'au-dessus : une case par motif, qui se raccorde à la voisine. */
  vertex(p: V3, n: V3, uv: [number, number] = [(p[0] + H) / (2 * H), (p[2] + H) / (2 * H)]): number {
    this.g.positions.push(...p);
    this.g.normals.push(...n);
    this.g.uvs.push(...uv);
    this.points.push(p);
    return this.points.length - 1;
  }

  normalOf(i: number): V3 {
    const n = this.g.normals;
    return [n[3 * i], n[3 * i + 1], n[3 * i + 2]];
  }

  /**
   * Triangle vu de dehors du côté `outward`. Comme les blocs de forme (materials.ts), les sommets
   * vont dans le sens des aiguilles d'une montre vu de dehors : c'est la face avant de Babylon dans
   * nos scènes en repère main droite.
   */
  tri(a: number, b: number, c: number, outward: V3): void {
    const n = cross3(sub3(this.points[b], this.points[a]), sub3(this.points[c], this.points[a]));
    if (dot3(n, outward) < 0) this.g.indices.push(a, b, c);
    else this.g.indices.push(a, c, b);
  }

  quad(a: number, b: number, c: number, d: number, outward: V3): void {
    this.tri(a, b, c, outward);
    this.tri(a, c, d, outward);
  }
}

/** Géométrie d'une case selon son profil (bits `SIDE_*`, `SEAMLESS_*`, `CLOSED_*`), dans le repère du bloc. */
function buildSegment(sides: number): SurfaceGeometry {
  const tipLeft = (sides & SIDE_LEFT) !== 0;
  const tipRight = (sides & SIDE_RIGHT) !== 0;
  const loop = profile(sides);
  const n = loop.length;
  const b = new Builder();
  const x0 = tipRight ? -H + TIP : -H;
  const x1 = tipLeft ? H - TIP : H;

  // Peau : chaque côté du profil (à plat, ou les normales de l'arrondi), d'un bout à l'autre de l'envergure
  for (let i = 0; i < n; i++) {
    const p = loop[i];
    const q = loop[(i + 1) % n];
    if (p.open) continue;
    const flat = unit([0, -(q.z - p.z), q.y - p.y], [0, 1, 0]);
    const np: V3 = p.arc && q.arc ? [0, p.ny, p.nz] : flat;
    const nq: V3 = p.arc && q.arc ? [0, q.ny, q.nz] : flat;
    const a0 = b.vertex([x0, p.y, p.z], np);
    const a1 = b.vertex([x1, p.y, p.z], np);
    const b1 = b.vertex([x1, q.y, q.z], nq);
    const b0 = b.vertex([x0, q.y, q.z], nq);
    b.quad(a0, a1, b1, b0, [0, (np[1] + nq[1]) / 2, (np[2] + nq[2]) / 2]);
  }

  // Bouts de l'envergure : un saumon arrondi, une face droite, ou rien (la case continue dans sa voisine)
  for (const side of [1, -1]) {
    const tip = side === 1 ? tipLeft : tipRight;
    const xe = side === 1 ? x1 : x0;
    if (!tip) {
      if (!(sides & (side === 1 ? CLOSED_LEFT : CLOSED_RIGHT))) continue;
      const normal: V3 = [side, 0, 0];
      const uv = (y: number, z: number): [number, number] => [(z + H) / (2 * H), (y + H) / (2 * H)];
      const center = b.vertex([xe, 0, 0], normal, uv(0, 0));
      const ring = loop.map((p) => b.vertex([xe, p.y, p.z], normal, uv(p.y, p.z)));
      for (let i = 0; i < n; i++) b.tri(center, ring[i], ring[(i + 1) % n], normal);
      continue;
    }
    // Saumon : le profil s'aplatit en quart d'ellipse jusqu'au bout de la case
    const rings: number[][] = [];
    for (let j = 0; j <= TIP_RINGS; j++) {
      const phi = (j * Math.PI) / 2 / TIP_RINGS;
      const c = Math.cos(phi);
      const s = Math.sin(phi);
      rings.push(loop.map((p, i) => {
        // Normale : produit des tangentes le long de l'anneau et du profil (différences centrées)
        const prev = loop[(i + n - 1) % n];
        const next = loop[(i + 1) % n];
        const dy = next.y - prev.y;
        const dz = next.z - prev.z;
        const along: V3 = [side * TIP * c, -p.y * s, 0];
        const around: V3 = [0, dy * c, dz];
        let normal = unit(cross3(along, around), [side, 0, 0]);
        // Tournée vers le dehors : du côté du bout, ou du profil (sa normale à plat)
        const outward: V3 = [side * s, -dz * c, dy * c];
        if (dot3(normal, outward) < 0) normal = [-normal[0], -normal[1], -normal[2]];
        return b.vertex([xe + side * TIP * s, p.y * c, p.z], normal);
      }));
    }
    for (let j = 0; j < TIP_RINGS; j++) {
      for (let i = 0; i < n; i++) {
        if (loop[i].open) continue;
        const k = (i + 1) % n;
        const corners = [rings[j][i], rings[j + 1][i], rings[j + 1][k], rings[j][k]] as const;
        // (le dehors : la moyenne des normales des quatre coins)
        const outward = corners.map((v) => b.normalOf(v)).reduce((s, v): V3 => [s[0] + v[0], s[1] + v[1], s[2] + v[2]]);
        b.quad(...corners, outward);
      }
    }
  }
  return b.g;
}

const segments = new Map<number, SurfaceGeometry>();

/** Géométrie d'une case (gardée par profil : quelques dizaines au plus). */
export function surfaceSegment(sides: number): SurfaceGeometry {
  let g = segments.get(sides);
  if (!g) segments.set(sides, (g = buildSegment(sides)));
  return g;
}

/** Une case à poser dans une pièce : son profil, sa rotation et sa place dans le repère de la pièce. */
export interface PlacedSegment {
  sides: number;
  rot: Quat;
  pos: Vec3;
}

/** Arrondi des positions (m) : deux cases voisines ont exactement les mêmes sommets sur leur bord commun. */
const snap = (v: number): number => Math.round(v * 1e5) / 1e5;

/**
 * Fusionne des cases en une seule géométrie (une aile, un rang de gouvernes) ; rend aussi, pour
 * chaque case, son premier sommet et son nombre de sommets (sa couleur d'usure).
 */
export function mergeSegments(cells: readonly PlacedSegment[]): { geometry: SurfaceGeometry; ranges: [number, number][] } {
  const out: SurfaceGeometry = { positions: [], normals: [], uvs: [], indices: [] };
  const ranges: [number, number][] = [];
  for (const cell of cells) {
    const g = surfaceSegment(cell.sides);
    const first = out.positions.length / 3;
    const count = g.positions.length / 3;
    for (let i = 0; i < count; i++) {
      const p = qrot(cell.rot, { x: g.positions[3 * i], y: g.positions[3 * i + 1], z: g.positions[3 * i + 2] });
      const nn = qrot(cell.rot, { x: g.normals[3 * i], y: g.normals[3 * i + 1], z: g.normals[3 * i + 2] });
      out.positions.push(snap(p.x + cell.pos.x), snap(p.y + cell.pos.y), snap(p.z + cell.pos.z));
      out.normals.push(nn.x, nn.y, nn.z);
    }
    out.uvs.push(...g.uvs);
    for (const i of g.indices) out.indices.push(i + first);
    ranges.push([first, count]);
  }
  return { geometry: out, ranges };
}
