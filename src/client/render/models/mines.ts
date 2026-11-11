import type * as B from "../../babylon";
import type { MineWeaponId } from "../../../shared/catalog/weapons";
import type { ModelKit, V3 } from "../modelKit";

/*
 * Modèles 3D des mines, au sol comme en vol : chacune se reconnaît d'un coup d'œil. L'origine est
 * là où la mine s'est posée : sa base descend un peu dessous (elle s'enfonce dans le sol). Son
 * voyant est à part (`light`) : le rendu le fait clignoter une fois la mine posée, à son rythme
 * (render/projectiles.ts). Chaque sorte a le sien : TypeScript refuse une mine sans.
 */

/** Rythme du voyant : un éclat bref (mine qui guette), une pulsation lente (capteur), un double éclat (télécommandée), rapide (ventouse). */
export type Blink = "blip" | "pulse" | "double" | "fast";

export interface MineModel {
  /** Le corps de la mine (voir `ModelKit.fuse`). */
  body: (kit: ModelKit, name: string) => B.Mesh;
  /** Son voyant : sa couleur, sa place, son rythme, et son diamètre (m ; 6 cm par défaut). */
  light: { color: string; at: V3; blink: Blink; size?: number };
}

const STEEL = "#8d959c";
const DARK = "#1e2226";
const BRASS = "#b08d3a";
const HAZARD = "#f0bd2c";
const DIRT = "#4a3f30";

/** Nervures verticales régulières autour d'une mine ronde (rayon `r`, hauteur `h`, à la hauteur `y`). */
function ribs(kit: ModelKit, color: string, count: number, r: number, h: number, y: number): B.Mesh[] {
  return Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2;
    return kit.box(color, [0.03, h, 0.05], [Math.sin(a) * r, y, Math.cos(a) * r], [0, a, 0]);
  });
}

/** Mine classique : une galette nervurée, son plateau de pression, la fusée en laiton, une bande jaune. */
const mine: MineModel = {
  body: (kit, name) => kit.fuse([
    kit.cylinder("#2f3a2a", 0.11, 0.5, 0.46, [0, -0.005, 0], "y", 20),
    ...ribs(kit, "#26301f", 12, 0.245, 0.08, -0.01),
    kit.ring(HAZARD, 0.5, 0.02, [0, -0.035, 0], "y", 24),
    kit.cylinder("#3c4735", 0.03, 0.3, 0.28, [0, 0.06, 0], "y", 18),
    kit.cylinder(DARK, 0.02, 0.2, 0.2, [0, 0.08, 0], "y", 16),
    kit.cylinder(BRASS, 0.035, 0.08, 0.06, [0, 0.1, 0], "y", 10),
  ], name, { specular: 0.3 }),
  light: { color: "#ff3b30", at: [0.16, 0.06, 0], blink: "blip" },
};

/** Mine IEM : des bobines de cuivre autour d'un mât, quatre condensateurs, le dôme émetteur. */
const empMine: MineModel = {
  body: (kit, name) => kit.fuse([
    kit.cylinder("#24384a", 0.08, 0.46, 0.42, [0, -0.02, 0], "y", 18),
    kit.cylinder(DARK, 0.18, 0.1, 0.1, [0, 0.1, 0], "y", 10),
    ...[0.05, 0.09, 0.13].map((y) => kit.ring("#c07a3a", 0.18, 0.035, [0, y, 0], "y", 14)),
    ...[0, 1, 2, 3].map((i) => {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      return kit.cylinder("#5d7890", 0.09, 0.06, 0.06, [Math.sin(a) * 0.15, 0.06, Math.cos(a) * 0.15], "y", 8);
    }),
    kit.sphere("#9fe3ff", 0.12, [0, 0.2, 0], [1, 0.8, 1], 10),
  ], name, { specular: 0.45 }),
  // (le voyant enveloppe le dôme : c'est lui qui s'allume)
  light: { color: "#7fd8ff", at: [0, 0.2, 0], blink: "pulse", size: 0.13 },
};

/** Mine incendiaire : deux réservoirs rouges cerclés sur un berceau, la buse d'allumage devant. */
const fireMine: MineModel = {
  body: (kit, name) => kit.fuse([
    kit.box("#3a2218", [0.46, 0.05, 0.36], [0, -0.03, 0]),
    ...[-0.085, 0.085].flatMap((z) => [
      kit.cylinder("#c4462a", 0.38, 0.14, 0.14, [0, 0.06, z], "x", 12),
      ...[-0.19, 0.19].map((x) => kit.sphere("#c4462a", 0.14, [x, 0.06, z], [0.4, 1, 1], 8)),
      ...[-0.1, 0.1].map((x) => kit.ring(HAZARD, 0.145, 0.02, [x, 0.06, z], "x", 12)),
    ]),
    kit.box(DARK, [0.05, 0.1, 0.3], [-0.05, 0.06, 0]),
    kit.cylinder(DARK, 0.08, 0.05, 0.05, [0.25, 0.1, 0], "x", 8),
    kit.cylinder("#ff8a2a", 0.05, 0.05, 0.02, [0.3, 0.1, 0], "x", 8),
  ], name, { specular: 0.35 }),
  light: { color: "#ff8a2a", at: [-0.05, 0.13, 0], blink: "blip" },
};

/** Mine fumigène : un bidon à évents sur sa collerette, le couvercle clair et sa goupille. */
const smokeMine: MineModel = {
  body: (kit, name) => kit.fuse([
    kit.cylinder(DARK, 0.05, 0.42, 0.4, [0, -0.035, 0], "y", 18),
    kit.cylinder("#4b5057", 0.2, 0.3, 0.3, [0, 0.07, 0], "y", 16),
    ...Array.from({ length: 6 }, (_, i) => {
      const a = (i / 6) * Math.PI * 2;
      return kit.box(DARK, [0.02, 0.05, 0.06], [Math.sin(a) * 0.15, 0.12, Math.cos(a) * 0.15], [0, a, 0]);
    }),
    kit.cylinder("#e0e4e8", 0.04, 0.24, 0.26, [0, 0.19, 0], "y", 16),
    kit.ring(STEEL, 0.08, 0.015, [0.06, 0.22, 0], "z", 10),
  ], name, { specular: 0.3 }),
  light: { color: "#e0e4e8", at: [-0.07, 0.215, 0], blink: "blip" },
};

/** Mine bondissante : à demi enterrée dans sa butte de terre, ses trois antennes de déclenchement. */
const bounceMine: MineModel = {
  body: (kit, name) => kit.fuse([
    kit.cylinder(DIRT, 0.05, 0.46, 0.3, [0, -0.03, 0], "y", 14),
    kit.cylinder("#4a4228", 0.16, 0.2, 0.2, [0, 0.04, 0], "y", 14),
    kit.ring(HAZARD, 0.205, 0.025, [0, 0.07, 0], "y", 16),
    kit.cylinder("#3a3420", 0.03, 0.22, 0.16, [0, 0.13, 0], "y", 14),
    ...[0, 1, 2].map((i) => {
      const a = (i / 3) * Math.PI * 2;
      return kit.cylinder(STEEL, 0.14, 0.015, 0.01, [Math.sin(a) * 0.04, 0.21, Math.cos(a) * 0.04], "y", 6);
    }),
  ], name, { specular: 0.3 }),
  light: { color: "#f0bd2c", at: [0.08, 0.14, 0], blink: "blip" },
};

/** Mine anti-aérienne : son tube lance-missile, pointe rouge, penché vers le ciel, et un petit radar. */
const aaMine: MineModel = {
  body: (kit, name) => kit.fuse([
    kit.cylinder("#3a3046", 0.08, 0.46, 0.42, [0, -0.02, 0], "y", 18),
    kit.box(DARK, [0.14, 0.08, 0.14], [0, 0.06, 0]),
    // Le tube (dressé, penché de 20°), cerclé de violet, la coiffe du missile qui en sort
    kit.cylinder("#e0e4e8", 0.36, 0.12, 0.12, [0, 0.25, 0.06], "y", 12),
    ...[0.14, 0.34].map((y) => kit.ring("#c792ea", 0.125, 0.02, [0, y, 0.06], "y", 12)),
    kit.cylinder("#d8433a", 0.1, 0.1, 0, [0, 0.48, 0.06], "y", 10),
    // Le radar : une parabole sur un mât
    kit.cylinder(STEEL, 0.14, 0.02, 0.02, [-0.15, 0.08, -0.08], "y", 6),
    kit.cylinder("#c792ea", 0.02, 0.12, 0.08, [-0.15, 0.16, -0.06], "z", 12),
  ], name, { specular: 0.35 }),
  light: { color: "#c792ea", at: [0.15, 0.03, -0.1], blink: "blip" },
};

/** Mine télécommandée : un caisson bombé sur ses pieds, son boîtier de mise à feu et son antenne. */
const remoteMine: MineModel = {
  body: (kit, name) => kit.fuse([
    ...[-0.12, 0.12].map((x) => kit.box(DARK, [0.03, 0.08, 0.12], [x, -0.03, 0])),
    kit.box("#3a3526", [0.36, 0.2, 0.09], [0, 0.07, 0]),
    kit.box("#4a4432", [0.34, 0.18, 0.02], [0, 0.07, 0.05]),
    kit.box(HAZARD, [0.36, 0.02, 0.1], [0, 0.16, 0]),
    kit.box(DARK, [0.1, 0.07, 0.07], [0.1, 0.205, -0.01]),
    kit.cylinder(STEEL, 0.4, 0.015, 0.008, [0.13, 0.43, -0.01], "y", 6),
    kit.sphere(DARK, 0.03, [0.13, 0.63, -0.01]),
  ], name, { specular: 0.3 }),
  light: { color: "#ffcf5a", at: [0.07, 0.245, -0.01], blink: "double" },
};

/** Capteur : un trépied planté au sol, la tête à lentille verte, une longue antenne. */
const sensorMine: MineModel = {
  body: (kit, name) => kit.fuse([
    kit.cylinder(DIRT, 0.03, 0.3, 0.2, [0, -0.03, 0], "y", 12),
    ...[0, 1, 2].map((i) => {
      const a = (i / 3) * Math.PI * 2;
      return kit.box(STEEL, [0.025, 0.3, 0.025], [Math.sin(a) * 0.08, 0.12, Math.cos(a) * 0.08], [Math.cos(a) * -0.35, 0, Math.sin(a) * 0.35]);
    }),
    kit.cylinder(DARK, 0.1, 0.05, 0.05, [0, 0.24, 0], "y", 8),
    kit.sphere("#233a2c", 0.16, [0, 0.33, 0], [1, 0.8, 1], 12),
    kit.cylinder("#1a1c1e", 0.04, 0.09, 0.09, [0, 0.33, 0.065], "z", 12),
    kit.cylinder(STEEL, 0.34, 0.012, 0.008, [0.04, 0.55, -0.03], "y", 6),
  ], name, { specular: 0.4 }),
  light: { color: "#57d38c", at: [0, 0.33, 0.09], blink: "pulse" },
};

/** Mine ventouse : un dôme sur quatre ventouses roses et un anneau magnétique, un minuteur dessus. */
const stickyMine: MineModel = {
  body: (kit, name) => kit.fuse([
    ...[0, 1, 2, 3].map((i) => {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      return kit.cylinder("#ff6b8a", 0.03, 0.12, 0.08, [Math.sin(a) * 0.16, -0.04, Math.cos(a) * 0.16], "y", 12);
    }),
    kit.ring(STEEL, 0.32, 0.035, [0, -0.01, 0], "y", 20),
    kit.sphere("#3e2029", 0.34, [0, 0.02, 0], [1, 0.55, 1], 14),
    kit.box(DARK, [0.1, 0.03, 0.07], [0, 0.11, 0]),
    kit.box("#ff9eb0", [0.07, 0.01, 0.03], [0, 0.126, 0.005]),
  ], name, { specular: 0.4 }),
  light: { color: "#ff6b8a", at: [0.04, 0.13, -0.02], blink: "fast" },
};

export const MINE_MODELS: Record<MineWeaponId, MineModel> = {
  mine, empMine, fireMine, smokeMine, bounceMine, aaMine, remoteMine, sensorMine, stickyMine,
};

/** Le voyant est-il allumé à l'instant `t` (s), pour une mine posée de numéro `id` (les mines ne clignotent pas ensemble) ? */
export function blinkOn(blink: Blink, t: number, id: number): boolean {
  const phase = (t + (id % 17) * 0.13) % 1.2;
  switch (blink) {
    case "blip": return phase < 0.12;
    case "pulse": return phase < 0.5;
    case "double": return phase < 0.08 || (phase > 0.2 && phase < 0.28);
    case "fast": return phase % 0.3 < 0.15;
  }
}
