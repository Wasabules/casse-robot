import type { Vec3 } from "../math/vec";
import { noise2 } from "./terrain";

/*
 * Forme d'un rocher : une boule à facettes, cabossée, à la taille de sa boîte (StaticBox de sorte
 * `rock`). La physique en fait une enveloppe convexe (arena.ts), le rendu la dessine (ArenaView) :
 * les deux ont la même forme. Une boîte comme collider laissait dépasser ses coins de plus d'un
 * demi-mètre autour du rocher visible : des obstacles invisibles, qu'un robot lancé percutait.
 */

/** Relief des bosses : chaque sommet est à ROCK_BUMP_MIN à 1 fois le rayon de la boule. */
const ROCK_BUMP_MIN = 0.86;

/** Sommets (x, y, z à la suite) et triangles d'une boule à facettes de rayon 1 (icosaèdre subdivisé). */
function icosphere(subdivisions: number): { vertices: number[]; faces: number[] } {
  const t = (1 + Math.sqrt(5)) / 2;
  const vertices: number[] = [];
  const add = (x: number, y: number, z: number): number => {
    const l = Math.hypot(x, y, z);
    vertices.push(x / l, y / l, z / l);
    return vertices.length / 3 - 1;
  };
  for (const [x, y, z] of [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]) add(x, y, z);
  let faces = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
  for (let s = 0; s < subdivisions; s++) {
    const middle = new Map<string, number>();
    const mid = (a: number, b: number): number => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let m = middle.get(key);
      if (m === undefined) {
        m = add(vertices[a * 3] + vertices[b * 3], vertices[a * 3 + 1] + vertices[b * 3 + 1], vertices[a * 3 + 2] + vertices[b * 3 + 2]);
        middle.set(key, m);
      }
      return m;
    };
    const next: number[] = [];
    for (let f = 0; f < faces.length; f += 3) {
      const [a, b, c] = [faces[f], faces[f + 1], faces[f + 2]];
      const [ab, bc, ca] = [mid(a, b), mid(b, c), mid(c, a)];
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    faces = next;
  }
  return { vertices, faces };
}

const SPHERE = icosphere(2);

/**
 * Le rocher d'une boîte de demi-dimensions `half`, placé en (x, z) (qui fixe ses bosses) : ses
 * sommets dans le repère de la boîte, et ses triangles.
 */
export function rockShape(half: Vec3, x: number, z: number): { vertices: Float32Array; faces: readonly number[] } {
  const v = SPHERE.vertices;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 3) {
    // Bosses fixes, d'après la direction du sommet et la place du rocher
    const bump = ROCK_BUMP_MIN + (1 - ROCK_BUMP_MIN) * (0.5 + 0.5 * noise2(v[i] * 2.3 + x * 0.7, v[i + 2] * 2.3 + v[i + 1] * 1.7 + z * 0.7));
    out[i] = v[i] * bump * half.x;
    out[i + 1] = v[i + 1] * bump * half.y;
    out[i + 2] = v[i + 2] * bump * half.z;
  }
  return { vertices: out, faces: SPHERE.faces };
}
