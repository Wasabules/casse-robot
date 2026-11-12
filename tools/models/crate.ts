import { Builder, hex, shade } from "./builder";
import type { GlbModel } from "./glb";

/*
 * Le modèle d'exemple : une caisse de 1 m (l'accessoire `crate`, une boîte de demi-côté 0,5),
 * faite par le code en boîtes, comme le ferait un artiste dans Blender. Un cadre de chevrons sur
 * les douze arêtes, des planches sur chaque face (chacune de sa teinte, en couleurs de sommets),
 * une écharpe en diagonale sur les quatre flancs, des cornières d'acier aux huit coins. Deux
 * matières : `wood` (blanche, la teinte vient des sommets) et `steel`. Origine au milieu du bas de
 * l'emprise, +y en haut (docs/models.md). `npm run models -- example` l'écrit dans
 * public/models/props/crate.glb et met le manifeste à jour.
 */

const PLANK = hex("#b98f5c");
const GAP = hex("#3b2817");
const FRAME = hex("#8a6537");
const BRACE = hex("#9c7442");

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
