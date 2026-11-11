import * as B from "../babylon";
import type { MapPoint } from "../../shared/map/format";

/*
 * Ce que l'éditeur de cartes dessine posé sur le sol (shared/map est la vérité, ceci n'est qu'un
 * dessin) : des rubans le long d'une ligne brisée (limites, lignes de départ, chemins, tracés, grille,
 * pinceau), des disques (zones, lacs de lave). Ils suivent le relief, un peu au-dessus de lui.
 */

/** Hauteur du sol (m). */
export type Ground = (x: number, z: number) => number;

/** Un point tous les `spacing` m le long d'une ligne brisée (ses sommets compris). */
export function densify(points: readonly MapPoint[], spacing: number, closed = false): MapPoint[] {
  const pts = closed && points.length > 2 ? [...points, points[0]] : points;
  const out: MapPoint[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / spacing));
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  if (pts.length) out.push(pts[pts.length - 1]);
  return out;
}

/** Les données d'un ruban de largeur `width` m le long d'une ligne brisée, `lift` m au-dessus du sol. */
export function ribbonData(points: readonly MapPoint[], width: number, ground: Ground, lift: number, closed = false, spacing = 2): B.VertexData | null {
  const pts = densify(points, spacing, closed);
  if (pts.length < 2) return null;
  const positions: number[] = [];
  const indices: number[] = [];
  const w = width / 2;
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    let tx = next[0] - prev[0];
    let tz = next[1] - prev[1];
    const len = Math.hypot(tx, tz) || 1;
    tx /= len;
    tz /= len;
    const [x, z] = pts[i];
    const lx = x - tz * w;
    const lz = z + tx * w;
    const rx = x + tz * w;
    const rz = z - tx * w;
    const y = Math.max(ground(x, z), ground(lx, lz), ground(rx, rz)) + lift;
    positions.push(lx, y, lz, rx, y, rz);
    if (i > 0) {
      const a = (i - 1) * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  return withNormals(positions, indices);
}

/** Les données d'un disque de rayon `r` m (`inner` > 0 : un anneau), posé sur le sol. */
export function discData(cx: number, cz: number, r: number, ground: Ground, lift: number, inner = 0, segments = 40): B.VertexData {
  const rings = Math.max(1, Math.ceil((r - inner) / 2));
  const positions: number[] = [];
  const indices: number[] = [];
  for (let ring = 0; ring <= rings; ring++) {
    const rr = inner + ((r - inner) * ring) / rings;
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      const x = cx + Math.cos(a) * rr;
      const z = cz + Math.sin(a) * rr;
      positions.push(x, ground(x, z) + lift, z);
    }
  }
  for (let ring = 0; ring < rings; ring++) {
    for (let s = 0; s < segments; s++) {
      const a = ring * segments + s;
      const b = ring * segments + ((s + 1) % segments);
      const c = a + segments;
      const d = b + segments;
      indices.push(a, c, b, b, c, d);
    }
  }
  return withNormals(positions, indices);
}

function withNormals(positions: number[], indices: number[]): B.VertexData {
  const data = new B.VertexData();
  data.positions = positions;
  data.indices = indices;
  // (dessiné des deux côtés, sans éclairage : les normales ne servent qu'à Babylon)
  data.normals = positions.map((_, i) => (i % 3 === 1 ? 1 : 0));
  return data;
}

/** Un mesh d'après des données (null : rien). */
export function meshOf(scene: B.Scene, name: string, data: B.VertexData | null, material: B.Material): B.Mesh | null {
  if (!data) return null;
  const mesh = new B.Mesh(name, scene);
  data.applyToMesh(mesh);
  mesh.material = material;
  mesh.isPickable = false;
  return mesh;
}
