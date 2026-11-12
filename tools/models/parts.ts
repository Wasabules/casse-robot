import { blockDef } from "../../src/shared/catalog/blocks";
import { wheelDef } from "../../src/shared/catalog/wheels";
import { BLOCK_SIZE } from "../../src/shared/config";
import { Builder, hex, shade, type V3 } from "./builder";
import type { GlbModel } from "./glb";

/*
 * Les modèles d'exemple des pièces d'un robot, faits par le code comme le ferait un artiste dans
 * Blender (les conventions : docs/models.md) : un bloc de blindage (public/models/blocks/armor.glb),
 * une tête de canon (heads/cannonTurret.glb) et une roue (wheels/standard.glb). Ils montrent les
 * conventions de chaque famille : le repère d'un bloc (sa case, ±0,25 m autour de l'origine, haut
 * +y, avant +z) et sa matière `paint`, qui prend la couleur du robot ; l'axe d'une tête à
 * l'origine, son canon vers +z, sa bouche à `TurretSpec.barrel` m devant l'axe ; le moyeu d'une
 * roue à l'origine, son essieu le long de x, symétrique. Les tests les lisent (tests/models.test.ts,
 * tests/partModels.test.ts) ; `npm run models -- example` écrit dans public/ ceux qui y sont gardés
 * (`SHIPPED_EXAMPLES`, tools/models/build.ts).
 */

/** Demi-côté d'une case (m). */
const H = BLOCK_SIZE / 2;

/**
 * Un bloc de blindage (`armor`) : un cœur, une plaque rivetée sur chaque face, des cornières
 * d'acier aux huit coins. Deux matières : `paint` (blanche : elle prend la couleur du robot ; les
 * plaques plus claires que le cœur, en couleurs de sommets) et `steel`.
 */
export function armorModel(): GlbModel {
  const paint = new Builder();
  const steel = new Builder();
  // Le cœur, qu'on voit entre les plaques et les cornières
  paint.box([0, 0, 0], [H - 0.018, H - 0.018, H - 0.018], [0.72, 0.72, 0.72]);
  const plate = H - 0.045; // demi-côté d'une plaque
  const corner = 0.03;
  for (let k = 0; k < 3; k++) {
    const [u, v] = [(k + 1) % 3, (k + 2) % 3];
    for (const sign of [-1, 1]) {
      // La plaque, un peu en relief sur le cœur
      const center: [number, number, number] = [0, 0, 0];
      const half: [number, number, number] = [plate, plate, plate];
      center[k] = sign * (H - 0.011);
      half[k] = 0.007;
      paint.box(center, half, [1, 1, 1]);
      // Quatre rivets à ses coins
      for (const [du, dv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const at: [number, number, number] = [0, 0, 0];
        const size: [number, number, number] = [0.011, 0.011, 0.011];
        at[k] = sign * (H - 0.0035);
        at[u] = du * (plate - 0.035);
        at[v] = dv * (plate - 0.035);
        size[k] = 0.0035;
        steel.box(at, size, hex("#c3c8cc"));
      }
    }
  }
  // Les cornières, aux huit coins de la case
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) steel.box([x * (H - corner), y * (H - corner), z * (H - corner)], [corner, corner, corner]);
  return {
    generator: "Casse-Robot tools/models/parts.ts",
    meshes: [[paint.primitive(0, true), steel.primitive(1, true)]],
    materials: [
      { name: "paint", color: [1, 1, 1], roughness: 0.55 },
      { name: "steel", color: hex("#5b6066"), metallic: 0.85, roughness: 0.4 },
    ],
  };
}

/**
 * Une tête de canon (`cannonTurret`) : la caisse et son masque en biseau, les tourillons, un
 * tourelleau ; le tube, son évacuateur de fumées et son frein de bouche, qui finit à la bouche
 * (`TurretSpec.barrel` m devant l'axe), sombre. Deux matières : `hull` (blanche, les teintes en
 * couleurs de sommets) et `steel` (le tube).
 */
export function cannonHeadModel(): GlbModel {
  const turret = blockDef("cannonTurret").turret!;
  const [w, h, d] = turret.head;
  const z = turret.barrel;
  const hull = new Builder();
  const steel = new Builder();
  const body = hex("#58606a");
  const dark = shade(body, 0.75);
  // La caisse, centrée un peu en arrière de l'axe, et son toit
  hull.box([0, -0.01, -0.03], [w / 2, h * 0.4, d * 0.42], body);
  hull.box([0, h * 0.42, -0.06], [w * 0.42, h * 0.08, d * 0.36], shade(body, 1.08));
  // Le masque en biseau, à l'avant, penché de 17°
  hull.box([0, 0, d * 0.4], [w * 0.32, h * 0.36, 0.06], shade(body, 1.12), 0, -0.3);
  // Les jupes et le coffre arrière
  for (const s of [-1, 1]) hull.box([s * (w / 2 + 0.012), -0.03, -0.02], [0.012, h * 0.34, d * 0.36], dark);
  hull.box([0, -0.01, -d / 2 - 0.05], [w * 0.44, h * 0.3, 0.05], dark);
  hull.box([0, h * 0.22, -d / 2 - 0.05], [w * 0.445, 0.012, 0.052], hex("#f0bd2c"));
  // Les tourillons (l'axe du site) et le tourelleau
  hull.cylinder([0, 0, 0], 0, w + 0.06, 0.05, 0.05, dark, 12);
  hull.cylinder([w * 0.22, h * 0.52, -0.1], 1, 0.06, 0.07, 0.065, shade(body, 1.1), 12);
  // Le tube : collier, tube, évacuateur, frein de bouche (deux fentes), bouche sombre
  const gun = hex("#3a3f45");
  steel.cylinder([0, 0, 0.27], 2, 0.14, 0.09, 0.085, shade(gun, 1.2), 16);
  steel.cylinder([0, 0, (0.34 + z - 0.12) / 2], 2, z - 0.12 - 0.34, 0.06, 0.055, gun, 16);
  steel.cylinder([0, 0, 0.56], 2, 0.12, 0.08, 0.08, gun, 16);
  steel.cylinder([0, 0, z - 0.06], 2, 0.12, 0.075, 0.075, gun, 12);
  for (const at of [z - 0.09, z - 0.035]) steel.box([0, 0, at], [0.1, 0.026, 0.016], gun);
  steel.cylinder([0, 0, z - 0.002], 2, 0.004, 0.04, 0.04, hex("#0c0d0f"), 12);
  return {
    generator: "Casse-Robot tools/models/parts.ts",
    meshes: [[hull.primitive(0, true), steel.primitive(1, true)]],
    materials: [
      { name: "hull", color: [1, 1, 1], roughness: 0.6 },
      { name: "steel", color: [1, 1, 1], metallic: 0.8, roughness: 0.45 },
    ],
  };
}

/**
 * Une roue (`standard`) : le pneu et ses crampons en chevrons (deux rangs décalés), la jante, le
 * moyeu et ses écrous des deux côtés (la même roue se monte à gauche et à droite). Essieu le long
 * de x, au rayon et à la largeur du catalogue. Deux matières : `rubber` et `rim`.
 */
export function wheelModel(): GlbModel {
  const { radius: r, width: w } = wheelDef("standard");
  const rubber = new Builder();
  const rim = new Builder();
  const tire = hex("#24282c");
  // Le pneu, un peu en retrait de son rayon : les crampons le complètent
  rubber.cylinder([0, 0, 0], 0, w * 0.94, r * 0.93, r * 0.93, tire, 32);
  rubber.cylinder([0, 0, 0], 0, w, r * 0.86, r * 0.86, shade(tire, 0.85), 32);
  // Les crampons : deux rangs, l'un décalé d'un demi-pas, penchés en chevron
  const lugs = 18;
  for (let i = 0; i < lugs; i++) {
    for (const side of [-1, 1]) {
      const a = ((i + (side > 0 ? 0.5 : 0)) / lugs) * Math.PI * 2;
      const at: V3 = [side * w * 0.24, r * 0.955 * Math.cos(a), r * 0.955 * Math.sin(a)];
      rubber.box(at, [w * 0.22, r * 0.045, r * 0.07], shade(tire, 1.15), 0, a);
    }
  }
  // La jante, le moyeu et ses écrous, des deux côtés
  const steelGray = hex("#b9c3c9");
  rim.cylinder([0, 0, 0], 0, w + 0.02, r * 0.56, r * 0.56, steelGray, 24);
  rim.cylinder([0, 0, 0], 0, w + 0.05, r * 0.22, r * 0.2, shade(steelGray, 0.7), 16);
  for (const side of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      rim.cylinder([side * (w / 2 + 0.02), r * 0.32 * Math.cos(a), r * 0.32 * Math.sin(a)], 0, 0.03, 0.022, 0.022, hex("#5a6066"), 6);
    }
  }
  return {
    generator: "Casse-Robot tools/models/parts.ts",
    meshes: [[rubber.primitive(0, true), rim.primitive(1, true)]],
    materials: [
      { name: "rubber", color: [1, 1, 1], roughness: 0.95 },
      { name: "rim", color: [1, 1, 1], metallic: 0.7, roughness: 0.35 },
    ],
  };
}
