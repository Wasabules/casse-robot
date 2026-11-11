import * as B from "../../babylon";
import { meleeDef } from "../../../shared/catalog/melee";
import type { BlockModel, ModelKit } from "../modelKit";
import type { MeleeModel } from "./melee";

/*
 * Armes de contact d'énergie (catalog/melee.ts : lame laser, fouet plasma, lance électrique, champ
 * broyeur), à l'écran. Comme les autres armes de contact (render/models/melee.ts) : le socle (le
 * bloc) dans le repère du bloc, et la partie qui bouge, son origine au moyeu, à l'angle 0, le long de
 * `e1` (l'avant du bloc pour un axe `up`). En plus, ce qui brille (`MELEE_GLOWS`) : l'arc de la lame,
 * le filament du fouet, la pointe de la lance, le halo du champ, dans le même repère que la partie
 * qui bouge (le rendu les pose ensemble) ; des matières émissives sans éclairage, que le halo
 * lumineux (render/lighting.ts) fait rayonner. Leurs cotes sont celles du catalogue.
 */

const STEEL = "#9aa2a8";
const DARK = "#2b3034";
const GUNMETAL = "#3b4147";
const HAZARD = "#f0bd2c";
const CYAN = "#46d6ff";
const VIOLET = "#a05cff";
const BLUE = "#2e6fd6";
const PORCELAIN = "#d9d2c0";

/** Longueur de la tête d'une lance (m) : de sa bague à sa pointe ; derrière, la hampe. */
export const LANCE_HEAD = 0.45;
/** Diamètre de la hampe d'une lance (m). */
export const LANCE_SHAFT = 0.06;

/** Quatre boulons aux coins d'une platine horizontale, à la hauteur `y`. */
const bolts = (kit: ModelKit, y: number, spread = 0.17): B.Mesh[] =>
  [-1, 1].flatMap((sx) => [-1, 1].map((sz) => kit.cylinder(STEEL, 0.03, 0.045, 0.045, [sx * spread, y, sz * spread], "y", 8)));

/** La platine commune des socles : une plaque sombre boulonnée sous le bloc. */
const plate = (kit: ModelKit): B.Mesh[] => [kit.box(DARK, [0.48, 0.08, 0.48], [0, -0.21, 0]), ...bolts(kit, -0.16)];

/** Lame laser, le socle : le boîtier de l'émetteur, ses ailettes de refroidissement, l'anneau cyan, le mât jusqu'au moyeu. */
const laserBase: BlockModel = (kit, _color, name) => {
  const hub = meleeDef("laserBlade").hub[1];
  return kit.fuse([
    ...plate(kit),
    kit.cylinder(GUNMETAL, 0.24, 0.38, 0.32, [0, -0.05, 0], "y", 20),
    ...[0, 1, 2, 3, 4, 5].map((i) => kit.box(DARK, [0.03, 0.18, 0.08], [0.19 * Math.cos((i * Math.PI) / 3), -0.06, 0.19 * Math.sin((i * Math.PI) / 3)], [0, -(i * Math.PI) / 3, 0])),
    kit.ring(CYAN, 0.32, 0.03, [0, 0.07, 0], "y", 24),
    kit.cylinder(STEEL, hub - 0.06, 0.1, 0.1, [0, (hub + 0.07) / 2, 0], "y", 12),
  ], name, { specular: 0.5 });
};

/** Fouet plasma, le socle : un condensateur à bandes violettes, et le mât du pivot. */
const whipBase: BlockModel = (kit, _color, name) => {
  const [, y, z] = meleeDef("plasmaWhip").hub;
  return kit.fuse([
    ...plate(kit),
    kit.cylinder(GUNMETAL, 0.3, 0.3, 0.3, [0, -0.02, -0.05], "y", 18),
    kit.ring(VIOLET, 0.3, 0.035, [0, -0.08, -0.05], "y", 20),
    kit.ring(VIOLET, 0.3, 0.035, [0, 0.04, -0.05], "y", 20),
    kit.cylinder(STEEL, y - 0.1, 0.11, 0.11, [0, (y + 0.1) / 2, z], "y", 12),
    kit.box(DARK, [0.2, 0.08, 0.22], [0, 0.15, z - 0.02]),
  ], name, { specular: 0.45 });
};

/** Lance électrique, le socle : un fourreau le long de l'avant, ses condensateurs bleus, la bague d'où sort la lance. */
const lanceBase: BlockModel = (kit, _color, name) => {
  const [, y] = meleeDef("shockLance").hub;
  return kit.fuse([
    ...plate(kit),
    kit.box(GUNMETAL, [0.3, 0.26, 0.48], [0, y - 0.03, 0]),
    kit.box(HAZARD, [0.305, 0.265, 0.06], [0, y - 0.03, 0.1]),
    kit.box(DARK, [0.305, 0.265, 0.03], [0, y - 0.03, 0.14]),
    ...[-1, 1].map((s) => kit.cylinder(BLUE, 0.4, 0.09, 0.09, [s * 0.19, -0.08, -0.02], "z", 12)),
    kit.ring(STEEL, 0.14, 0.04, [0, y, 0.24], "z", 16),
    kit.ring(PORCELAIN, 0.1, 0.03, [0, y, 0.21], "z", 14),
  ], name, { specular: 0.45 });
};

/** Champ broyeur, le socle : un dôme d'émetteur à ailettes (le projecteur d'un bouclier) et sa colonne. */
const fieldBase: BlockModel = (kit, _color, name) => {
  const hub = meleeDef("crusherField").hub[1];
  return kit.fuse([
    ...plate(kit),
    kit.sphere(GUNMETAL, 0.36, [0, -0.08, 0], [1, 0.7, 1], 14),
    ...[0, 1, 2, 3].map((i) => kit.box(DARK, [0.04, 0.16, 0.12], [0.17 * Math.cos((i * Math.PI) / 2 + Math.PI / 4), -0.1, 0.17 * Math.sin((i * Math.PI) / 2 + Math.PI / 4)], [0, -((i * Math.PI) / 2 + Math.PI / 4), 0])),
    kit.ring(VIOLET, 0.3, 0.025, [0, 0.01, 0], "y", 22),
    kit.cylinder(STEEL, hub - 0.02, 0.09, 0.07, [0, hub / 2, 0], "y", 12),
  ], name, { specular: 0.5 });
};

/** L'émetteur de la lame laser, qui tourne : un moyeu et deux bras courts, d'où partent les deux arcs (`MELEE_GLOWS`). */
const laserRotor: MeleeModel = (kit, name) => {
  const inner = meleeDef("laserBlade").blade!.inner;
  return kit.fuse([
    kit.cylinder(GUNMETAL, 0.08, 0.26, 0.26, [0, 0, 0], "y", 18),
    kit.cylinder(DARK, 0.1, 0.1, 0.1, [0, 0, 0], "y", 10),
    ...[-1, 1].flatMap((s) => [
      kit.box(STEEL, [0.08, 0.05, inner - 0.06], [0, 0, s * (inner / 2 + 0.02)]),
      kit.cylinder(CYAN, 0.07, 0.07, 0.07, [0, 0, s * inner], "y", 10),
    ]),
  ], name, { specular: 0.55 });
};

/** La poignée du fouet, au pivot : la tête du pivot et la buse d'où sort le filament (le long de +z). */
const whipHandle: MeleeModel = (kit, name) =>
  kit.fuse([
    kit.cylinder(STEEL, 0.12, 0.16, 0.16, [0, 0, 0], "y", 14),
    kit.box(GUNMETAL, [0.1, 0.08, 0.22], [0, 0, 0.11]),
    kit.ring(VIOLET, 0.11, 0.03, [0, 0, 0.2], "z", 14),
  ], name, { specular: 0.45 });

/** La tête de la lance : bague, isolateurs de porcelaine, pointe d'acier, de `reach` − LANCE_HEAD à `reach` le long de +z. */
const lanceHead: MeleeModel = (kit, name) => {
  const reach = meleeDef("shockLance").thrust!.reach;
  const back = reach - LANCE_HEAD;
  return kit.fuse([
    kit.cylinder(STEEL, 0.06, 0.11, 0.11, [0, 0, back + 0.03], "z", 14),
    ...[0, 1, 2].map((i) => kit.cylinder(PORCELAIN, 0.035, 0.1, 0.1, [0, 0, back + 0.1 + i * 0.06], "z", 12)),
    kit.cylinder(GUNMETAL, 0.12, 0.07, 0.07, [0, 0, back + 0.3], "z", 10),
    // (le « haut » d'un cylindre couché le long de z est vers +z : la pointe)
    kit.cylinder(STEEL, 0.1, 0.08, 0.01, [0, 0, reach - 0.05], "z", 8),
  ], name, { specular: 0.6 });
};

/** L'anneau du champ broyeur, qui tourne lentement : un tore d'acier et trois émetteurs. */
const fieldRing: MeleeModel = (kit, name) =>
  kit.fuse([
    kit.ring(STEEL, 0.44, 0.05, [0, 0, 0], "y", 28),
    ...[0, 1, 2].map((i) => kit.box(CYAN, [0.07, 0.07, 0.1], [0.22 * Math.sin((i * 2 * Math.PI) / 3), 0, 0.22 * Math.cos((i * 2 * Math.PI) / 3)], [0, (i * 2 * Math.PI) / 3, 0])),
    kit.cylinder(GUNMETAL, 0.05, 0.12, 0.12, [0, 0, 0], "y", 12),
  ], name, { specular: 0.55 });

/** Socles des armes d'énergie (réunis dans `MELEE_BASES`, render/models/melee.ts). */
export const ENERGY_BASES = { laserBlade: laserBase, plasmaWhip: whipBase, shockLance: lanceBase, crusherField: fieldBase } as const;

/** Partie mobile de chaque arme d'énergie (réunie dans `MELEE_MODELS`). */
export const ENERGY_MODELS: Record<keyof typeof ENERGY_BASES, MeleeModel> = {
  laserBlade: laserRotor, plasmaWhip: whipHandle, shockLance: lanceHead, crusherField: fieldRing,
};

/** Une pièce lumineuse : sa forme (peinte en blanc), sa couleur émise, son opacité. */
interface GlowPiece {
  mesh: B.Mesh;
  color: string;
  alpha: number;
}

/** Ce qui brille d'une arme d'énergie, dans le repère de sa partie mobile. */
export type GlowModel = (kit: ModelKit, scene: B.Scene, name: string) => B.Mesh;

/**
 * Fusionne des pièces lumineuses en un seul mesh à plusieurs matières (une par couleur) : émises,
 * sans éclairage, translucides si leur opacité est sous 1 ; le halo les fait rayonner de leur couleur.
 */
function glow(scene: B.Scene, pieces: GlowPiece[], name: string): B.Mesh {
  const mats = new Map<string, B.StandardMaterial>();
  for (const p of pieces) {
    const key = `${p.color}-${p.alpha}`;
    let mat = mats.get(key);
    if (!mat) {
      mat = new B.StandardMaterial(`${name}-${key}`, scene);
      mat.emissiveColor = B.Color3.FromHexString(p.color);
      mat.diffuseColor = B.Color3.Black();
      mat.specularColor = B.Color3.Black();
      mat.disableLighting = true;
      if (p.alpha < 1) {
        mat.alpha = p.alpha;
        mat.disableDepthWrite = true;
      }
      mat.backFaceCulling = false;
      mats.set(key, mat);
    }
    p.mesh.material = mat;
  }
  const merged = B.Mesh.MergeMeshes(pieces.map((p) => p.mesh), true, true, undefined, false, true);
  if (!merged) throw new Error(`Impossible de construire la lueur ${name}`);
  merged.name = name;
  merged.isVisible = false;
  merged.isPickable = false;
  return merged;
}

/**
 * Un filament courbe dans le plan horizontal (x, z) du repère, de `from` à `to` m de l'origine le
 * long de +z, rejeté en arrière (vers -x) de l'angle `trail(s)` (rad, s de 0 à 1) : des segments
 * bout à bout (des pavés de `width` × `height`), et son bout.
 */
function filament(kit: ModelKit, from: number, to: number, trail: (s: number) => number, width: number, height: number, segments: number): { parts: B.Mesh[]; end: [number, number, number] } {
  const at = (s: number): [number, number] => {
    const r = from + (to - from) * s;
    const a = trail(s);
    return [r * Math.sin(-a), r * Math.cos(a)];
  };
  const parts: B.Mesh[] = [];
  let [px, pz] = at(0);
  for (let i = 1; i <= segments; i++) {
    const [x, z] = at(i / segments);
    const dx = x - px;
    const dz = z - pz;
    const length = Math.hypot(dx, dz) + width * 0.5;
    parts.push(kit.box("#ffffff", [width, height, length], [(x + px) / 2, 0, (z + pz) / 2], [0, Math.atan2(dx, dz), 0]));
    px = x;
    pz = z;
  }
  return { parts, end: [px, 0, pz] };
}

/** Les deux arcs de la lame laser, rejetés en arrière de leur course : un cœur blanc et un halo cyan. */
const laserGlow: GlowModel = (kit, scene, name) => {
  const { inner, outer } = meleeDef("laserBlade").blade!;
  const trail = (s: number): number => 0.45 * s ** 1.5;
  const pieces: GlowPiece[] = [];
  for (const side of [0, Math.PI]) {
    const turn = (m: B.Mesh): B.Mesh => {
      m.rotation.y = side;
      m.bakeCurrentTransformIntoVertices();
      return m;
    };
    pieces.push(...filament(kit, inner, outer, trail, 0.035, 0.03, 8).parts.map((mesh) => ({ mesh: turn(mesh), color: "#e8fbff", alpha: 1 })));
    pieces.push(...filament(kit, inner, outer, trail, 0.1, 0.07, 8).parts.map((mesh) => ({ mesh: turn(mesh), color: "#38c8ff", alpha: 0.42 })));
  }
  return glow(scene, pieces, name);
};

/** Le filament du fouet, de la buse à sa tête (à `swing.reach`), courbé en arrière de sa course : cœur rose, halo violet, et sa tête. */
const whipGlow: GlowModel = (kit, scene, name) => {
  const reach = meleeDef("plasmaWhip").swing!.reach;
  const trail = (s: number): number => 0.55 * s * s;
  const core = filament(kit, 0.22, reach, trail, 0.028, 0.028, 10);
  const halo = filament(kit, 0.22, reach, trail, 0.085, 0.085, 10);
  return glow(scene, [
    ...core.parts.map((mesh) => ({ mesh, color: "#ffe6ff", alpha: 1 })),
    ...halo.parts.map((mesh) => ({ mesh, color: "#c45cff", alpha: 0.45 })),
    { mesh: kit.sphere("#ffffff", 0.13, core.end, [1, 1, 1], 10), color: "#ffd0ff", alpha: 1 },
    { mesh: kit.sphere("#ffffff", 0.3, core.end, [1, 1, 1], 10), color: "#d070ff", alpha: 0.35 },
  ], name);
};

/** L'étincelle au bout de la lance chargée : un point blanc-bleu et son halo. */
const lanceGlow: GlowModel = (kit, scene, name) => {
  const reach = meleeDef("shockLance").thrust!.reach;
  return glow(scene, [
    { mesh: kit.sphere("#ffffff", 0.07, [0, 0, reach + 0.01], [1, 1, 1], 8), color: "#e8f6ff", alpha: 1 },
    { mesh: kit.sphere("#ffffff", 0.18, [0, 0, reach + 0.01], [1, 1, 1], 8), color: "#5ab4ff", alpha: 0.4 },
    { mesh: kit.ring("#ffffff", 0.1, 0.012, [0, 0, reach - 0.2], "z", 12), color: "#8fd0ff", alpha: 0.8 },
  ], name);
};

/** Le halo du champ armé, autour de son anneau : un tore violet, un cœur pâle, et l'orbe du projecteur. */
const fieldGlow: GlowModel = (kit, scene, name) =>
  glow(scene, [
    { mesh: kit.ring("#ffffff", 0.52, 0.1, [0, 0, 0], "y", 28), color: "#7a5cff", alpha: 0.45 },
    { mesh: kit.ring("#ffffff", 0.44, 0.022, [0, 0, 0], "y", 28), color: "#d8ccff", alpha: 1 },
    { mesh: kit.sphere("#ffffff", 0.15, [0, 0.02, 0], [1, 0.8, 1], 10), color: "#b8a8ff", alpha: 0.85 },
  ], name);

/** Ce qui brille de chaque arme d'énergie (posé avec sa partie mobile ; montré quand elle est allumée, voir render/meleeView.ts). */
export const MELEE_GLOWS: Record<keyof typeof ENERGY_BASES, GlowModel> = {
  laserBlade: laserGlow, plasmaWhip: whipGlow, shockLance: lanceGlow, crusherField: fieldGlow,
};

/** Teinte du disque flou d'un rotor qui tourne vite : une lame d'énergie brille (émise), l'acier non. */
export const MELEE_BLURS: Partial<Record<keyof typeof ENERGY_BASES, { color: string; alpha: number }>> = {
  laserBlade: { color: "#5fd8ff", alpha: 0.16 },
};
