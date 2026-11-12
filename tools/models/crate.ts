import type { GlbModel, GlbPrimitive } from "./glb";

/*
 * Le modèle d'exemple : une caisse de 1 m (l'accessoire `crate`, une boîte de demi-côté 0,5),
 * faite par le code en boîtes, comme le ferait un artiste dans Blender. Un cadre de chevrons sur
 * les douze arêtes, des planches sur chaque face (chacune de sa teinte, en couleurs de sommets),
 * une écharpe en diagonale sur les quatre flancs, des cornières d'acier aux huit coins. Deux
 * matières : `wood` (blanche, la teinte vient des sommets) et `steel`. Origine au milieu du bas de
 * l'emprise, +y en haut (docs/models.md). `npm run models:example` l'écrit dans
 * public/models/props/crate.glb ; `npm run models` met ensuite le manifeste à jour.
 */

type V3 = readonly [number, number, number];

/** Une couleur « #rrggbb » en trois composantes sRGB (0 à 1). */
const hex = (h: string): V3 => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const shade = (c: V3, k: number): V3 => [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k)];

const PLANK = hex("#b98f5c");
const GAP = hex("#3b2817");
const FRAME = hex("#8a6537");
const BRACE = hex("#9c7442");

/** Les triangles d'une matière, qu'on remplit de boîtes. */
class Builder {
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

  primitive(material: number, colors: boolean): GlbPrimitive {
    return { positions: this.positions, normals: this.normals, ...(colors ? { colors: this.colors } : {}), indices: this.indices, material };
  }
}

/** Un petit hasard fixe : chaque planche a sa teinte, la même à chaque fois. */
function tints(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return 0.86 + 0.24 * (s / 2147483647);
  };
}

/** La caisse d'exemple. */
export function crateModel(): GlbModel {
  const wood = new Builder();
  const steel = new Builder();
  const tint = tints(4242);
  const H = 0.5; // demi-côté
  const BEAM = 0.1; // section des chevrons
  const inner = H - BEAM; // 0,4 : le bord intérieur du cadre
  // Le cœur sombre, qu'on voit entre les planches
  wood.box([0, H, 0], [H - 0.035, H - 0.035, H - 0.035], GAP);
  // Les planches de chaque face : quatre, séparées d'un jour, entre le cadre et le cœur
  const gap = 0.014;
  const width = (2 * inner - 3 * gap) / 4;
  for (let k = 0; k < 3; k++) {
    for (const sign of [-1, 1]) {
      // Sur un flanc, les planches sont couchées ; dessus et dessous, elles vont d'avant en arrière
      const along = k === 1 ? 2 : 1; // l'axe le long duquel on les empile
      for (let i = 0; i < 4; i++) {
        const center: [number, number, number] = [0, H, 0];
        const half: [number, number, number] = [inner, inner, inner];
        center[k] = (k === 1 ? H : 0) + sign * (H - 0.03);
        half[k] = 0.015;
        center[along] = (along === 1 ? H : 0) - inner + width / 2 + i * (width + gap);
        half[along] = width / 2;
        wood.box(center, half, shade(PLANK, tint()));
      }
    }
  }
  // Le cadre : douze chevrons sur les arêtes ; ceux de x vont d'un bout à l'autre, les autres
  // s'arrêtent contre eux (pas de faces confondues aux coins)
  for (const a of [-1, 1]) {
    for (const b of [-1, 1]) {
      const y = H + b * (H - BEAM / 2);
      wood.box([0, y, a * (H - BEAM / 2)], [H, BEAM / 2, BEAM / 2], shade(FRAME, tint()));
      wood.box([a * (H - BEAM / 2), y, 0], [BEAM / 2, BEAM / 2, inner], shade(FRAME, tint()));
      wood.box([a * (H - BEAM / 2), H, b * (H - BEAM / 2)], [BEAM / 2, inner, BEAM / 2], shade(FRAME, tint()));
    }
  }
  // Une écharpe en diagonale sur chaque flanc, sous le plan du cadre (ses bouts disparaissent dans les chevrons)
  const length = Math.SQRT2 * 2 * inner + 0.06;
  for (const sign of [-1, 1]) {
    wood.box([sign * (H - 0.012), H, 0], [0.01, length / 2, 0.045], shade(BRACE, tint()), 0, sign * Math.PI / 4);
    wood.box([0, H, sign * (H - 0.012)], [length / 2, 0.045, 0.01], shade(BRACE, tint()), 2, sign * Math.PI / 4);
  }
  // Les cornières d'acier, un peu plus larges que le cadre
  const corner = 0.065;
  for (const x of [-1, 1]) {
    for (const y of [0, 1]) {
      for (const z of [-1, 1]) {
        steel.box([x * (H + 0.008 - corner), y * 2 * H + (y ? -1 : 1) * (corner - 0.008), z * (H + 0.008 - corner)], [corner, corner, corner]);
      }
    }
  }
  return {
    generator: "Casse-Robot tools/models/crate.ts",
    meshes: [[wood.primitive(0, true), steel.primitive(1, false)]],
    materials: [
      { name: "wood", color: [1, 1, 1], roughness: 0.85 },
      { name: "steel", color: hex("#5b6066"), metallic: 0.85, roughness: 0.45 },
    ],
  };
}
