import type { GlbPrimitive } from "./glb";

/*
 * Un petit atelier pour faire des modèles d'exemple par le code (tools/models/crate.ts,
 * tools/models/parts.ts), comme les ferait un artiste dans Blender : des boîtes et des cylindres,
 * chacun d'une couleur de sommets (sRGB), réunis par matière. Faces en sens trigonométrique vues
 * de dehors (la convention du glTF).
 */

export type V3 = readonly [number, number, number];

/** Une couleur « #rrggbb » en trois composantes sRGB (0 à 1). */
export const hex = (h: string): V3 => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
/** Une couleur éclaircie ou assombrie (`k` > 1 : plus claire). */
export const shade = (c: V3, k: number): V3 => [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k)];

/** Les triangles d'une matière, qu'on remplit de boîtes et de cylindres. */
export class Builder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly colors: number[] = [];
  readonly indices: number[] = [];

  /**
   * Une boîte de demi-dimensions `half` autour de `center`, tournée de `angle` autour de l'axe
   * `axis` (0 : x, 1 : y, 2 : z), d'une couleur. Faces en sens trigonométrique vues de dehors (glTF).
   */
  box(center: V3, half: V3, color: V3 = [1, 1, 1], axis = 1, angle = 0): void {
    const turn = (v: V3): V3 => {
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const [a, b] = axis === 0 ? [1, 2] : axis === 1 ? [2, 0] : [0, 1];
      const out = [v[0], v[1], v[2]];
      out[a] = v[a] * c - v[b] * s;
      out[b] = v[a] * s + v[b] * c;
      return [out[0], out[1], out[2]];
    };
    for (let face = 0; face < 6; face++) {
      const k = face >> 1; // l'axe de la normale
      const sign = face & 1 ? -1 : 1;
      const [u, v] = [(k + 1) % 3, (k + 2) % 3];
      const normal: [number, number, number] = [0, 0, 0];
      normal[k] = sign;
      const base = this.positions.length / 3;
      // Quatre coins, dans le sens trigonométrique autour de la normale
      for (const [du, dv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const p: [number, number, number] = [0, 0, 0];
        p[k] = sign * half[k];
        p[u] = du * sign * half[u];
        p[v] = dv * half[v];
        const q = turn(p);
        this.positions.push(center[0] + q[0], center[1] + q[1], center[2] + q[2]);
        this.normals.push(...turn(normal));
        this.colors.push(...color);
      }
      this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  /**
   * Un cylindre (ou un tronc de cône) le long de l'axe `axis` (0 : x, 1 : y, 2 : z), centré en
   * `center`, de longueur `length`, de rayons `from` (côté −axe) et `to` (côté +axe), à `segments`
   * facettes, ses deux bouts fermés ; `phase` tourne les facettes (rad). Flancs lissés.
   */
  cylinder(center: V3, axis: number, length: number, from: number, to: number, color: V3 = [1, 1, 1], segments = 16, phase = 0): void {
    const [u, v] = [(axis + 1) % 3, (axis + 2) % 3];
    const point = (angle: number, radius: number, along: number): [number, number, number] => {
      const p: [number, number, number] = [center[0], center[1], center[2]];
      p[u] += radius * Math.cos(angle);
      p[v] += radius * Math.sin(angle);
      p[axis] += along;
      return p;
    };
    // La pente du flanc d'un tronc de cône penche ses normales vers le petit bout
    const slope = (from - to) / length;
    const side = this.positions.length / 3;
    for (let i = 0; i <= segments; i++) {
      const a = phase + (i / segments) * Math.PI * 2;
      const n: [number, number, number] = [0, 0, 0];
      n[u] = Math.cos(a);
      n[v] = Math.sin(a);
      n[axis] = slope;
      const len = Math.hypot(n[0], n[1], n[2]);
      for (const [radius, along] of [[from, -length / 2], [to, length / 2]]) {
        this.positions.push(...point(a, radius, along));
        this.normals.push(n[0] / len, n[1] / len, n[2] / len);
        this.colors.push(...color);
      }
    }
    for (let i = 0; i < segments; i++) {
      const [b0, t0, b1, t1] = [side + 2 * i, side + 2 * i + 1, side + 2 * i + 2, side + 2 * i + 3];
      this.indices.push(b0, b1, t1, b0, t1, t0);
    }
    // Les deux bouts : un éventail autour de leur centre
    for (const end of [-1, 1]) {
      const radius = end < 0 ? from : to;
      if (radius <= 0) continue;
      const n: [number, number, number] = [0, 0, 0];
      n[axis] = end;
      const centre = this.positions.length / 3;
      const c: [number, number, number] = [center[0], center[1], center[2]];
      c[axis] += (end * length) / 2;
      this.positions.push(...c);
      this.normals.push(...n);
      this.colors.push(...color);
      for (let i = 0; i < segments; i++) {
        this.positions.push(...point(phase + (i / segments) * Math.PI * 2, radius, (end * length) / 2));
        this.normals.push(...n);
        this.colors.push(...color);
      }
      for (let i = 0; i < segments; i++) {
        const [a, b] = [centre + 1 + i, centre + 1 + ((i + 1) % segments)];
        if (end > 0) this.indices.push(centre, a, b);
        else this.indices.push(centre, b, a);
      }
    }
  }

  primitive(material: number, colors: boolean): GlbPrimitive {
    return { positions: this.positions, normals: this.normals, ...(colors ? { colors: this.colors } : {}), indices: this.indices, material };
  }
}
