import type { BlockType } from "../../../shared/catalog/blocks";
import type { BlockModel, V3 } from "../modelKit";

/*
 * Modèles 3D des lumières que porte un robot : le phare, la balise, les feux d'avion (feu de
 * position, feu à éclats, feu anticollision), le gyrophare et la rampe de police. Leur verre qui luit
 * est à part (`LIGHT_LENSES`, `Assets.lightLensSource` : une matière émise, que le halo fait
 * rayonner), posé sur le modèle par WorldView tant que la lumière est alimentée, et au rythme de son
 * feu (render/lightSources.ts) ; dessous, le verre éteint est sombre. Une lumière éclaire le long du
 * haut de son bloc (+y), comme pousse un moteur : son verre est en haut. Les feux d'avion sont petits
 * (une platine et un culot) : posés au bout d'une aile, sous un fuselage, ils ne l'alourdissent pas
 * à l'œil.
 */

const DARK = "#2b3034";
const STEEL = "#8d959c";
const CHROME = "#d5dade";
const GLASS_OFF = "#3a4046";
const HAZARD = "#f0bd2c";

/**
 * Le verre qui luit d'une lumière (un ou deux par bloc : la rampe de police a ses deux feux), dans
 * le repère du bloc : un disque (le verre d'un phare, d'un feu à éclats), une perle (un feu de
 * position), un dôme (une balise, un feu anticollision, un gyrophare, du bas de la sphère au-dessus de
 * son centre), un pavé (les feux d'une rampe, le miroir qui tourne dans un gyrophare). `size` : ses
 * dimensions (x, y, z). Les feux d'un bloc à plusieurs verres sont dans l'ordre de ses couleurs (la
 * rampe : le bleu à gauche, en +x, puis le rouge) ; le miroir d'un gyrophare vient après son dôme.
 */
export interface LensShape {
  kind: "disc" | "bead" | "dome" | "box";
  at: V3;
  size: V3;
}

export const LIGHT_LENSES: Partial<Record<BlockType, readonly LensShape[]>> = {
  headlight: [{ kind: "disc", at: [0, 0.205, 0], size: [0.294, 0.012, 0.294] }],
  beacon: [{ kind: "bead", at: [0, 0.07, 0], size: [0.24, 0.24, 0.24] }],
  navLight: [{ kind: "bead", at: [0, -0.1, 0], size: [0.13, 0.13, 0.13] }],
  strobe: [{ kind: "disc", at: [0, -0.135, 0], size: [0.16, 0.03, 0.16] }],
  antiCollision: [{ kind: "dome", at: [0, -0.13, 0], size: [0.2, 0.15, 0.2] }],
  rotatingLight: [
    { kind: "dome", at: [0, -0.04, 0], size: [0.28, 0.24, 0.28] },
    { kind: "box", at: [0, 0.02, 0.05], size: [0.16, 0.12, 0.02] },
  ],
  policeBar: [
    { kind: "box", at: [0.115, -0.115, 0], size: [0.2, 0.09, 0.15] },
    { kind: "box", at: [-0.115, -0.115, 0], size: [0.2, 0.09, 0.15] },
  ],
};

/** Phare : une platine, un boîtier rond à ailettes, une couronne chromée autour du verre (en haut). */
const headlight: BlockModel = (kit, _color, name) => kit.fuse([
  kit.box(DARK, [0.46, 0.06, 0.46], [0, -0.22, 0]),
  kit.box(STEEL, [0.12, 0.14, 0.3], [0, -0.13, 0]),
  kit.cylinder(STEEL, 0.3, 0.3, 0.38, [0, 0.03, 0]),
  ...[-0.06, 0, 0.06].map((y) => kit.ring(DARK, 0.36 + y * 0.6, 0.025, [0, y - 0.03, 0])),
  kit.ring(CHROME, 0.37, 0.04, [0, 0.185, 0]),
  kit.cylinder(GLASS_OFF, 0.02, 0.3, 0.3, [0, 0.19, 0]),
  kit.box(HAZARD, [0.06, 0.04, 0.02], [0, -0.2, 0.23]),
], name, { specular: 0.6 });

/** Balise : une platine, un pied, un dôme de verre dans une cage de quatre arceaux (le dôme qui luit est à part). */
const beacon: BlockModel = (kit, _color, name) => kit.fuse([
  kit.box(DARK, [0.46, 0.06, 0.46], [0, -0.22, 0]),
  kit.cylinder(STEEL, 0.17, 0.26, 0.2, [0, -0.11, 0]),
  kit.cylinder(DARK, 0.04, 0.28, 0.28, [0, -0.02, 0]),
  kit.sphere(GLASS_OFF, 0.23, [0, 0.07, 0]),
  ...[0, 1, 2, 3].map((i) => kit.box(CHROME, [0.018, 0.2, 0.018], [Math.cos((i * Math.PI) / 2) * 0.135, 0.08, Math.sin((i * Math.PI) / 2) * 0.135])),
  kit.cylinder(CHROME, 0.03, 0.08, 0.08, [0, 0.19, 0]),
], name, { specular: 0.6 });

/** Feu de position : une petite platine, un culot, une perle de verre (rouge ou verte, selon son côté). */
const navLight: BlockModel = (kit, _color, name) => kit.fuse([
  kit.box(DARK, [0.3, 0.04, 0.3], [0, -0.23, 0]),
  kit.cylinder(STEEL, 0.07, 0.12, 0.09, [0, -0.18, 0]),
  kit.ring(CHROME, 0.12, 0.02, [0, -0.145, 0]),
  kit.sphere(GLASS_OFF, 0.12, [0, -0.1, 0]),
], name, { specular: 0.6 });

/** Feu à éclats : une platine, un boîtier plat, son verre rond sur le dessus. */
const strobe: BlockModel = (kit, _color, name) => kit.fuse([
  kit.box(DARK, [0.3, 0.04, 0.3], [0, -0.23, 0]),
  kit.cylinder(STEEL, 0.07, 0.22, 0.2, [0, -0.18, 0]),
  kit.ring(CHROME, 0.19, 0.02, [0, -0.145, 0]),
  kit.cylinder(GLASS_OFF, 0.02, 0.16, 0.16, [0, -0.14, 0]),
], name, { specular: 0.6 });

/** Feu anticollision : une platine, une embase, un petit dôme rouge. */
const antiCollision: BlockModel = (kit, _color, name) => kit.fuse([
  kit.box(DARK, [0.32, 0.04, 0.32], [0, -0.23, 0]),
  kit.cylinder(STEEL, 0.06, 0.24, 0.22, [0, -0.18, 0]),
  kit.ring(DARK, 0.22, 0.025, [0, -0.15, 0]),
  kit.sphere("#4a2a2a", 0.19, [0, -0.13, 0], [1, 0.75, 1]),
], name, { specular: 0.6 });

/** Gyrophare : une platine, une embase sombre, un haut dôme de verre orange (le miroir qui tourne est à part). */
const rotatingLight: BlockModel = (kit, _color, name) => kit.fuse([
  kit.box(DARK, [0.42, 0.05, 0.42], [0, -0.225, 0]),
  kit.cylinder(DARK, 0.1, 0.32, 0.3, [0, -0.15, 0]),
  kit.cylinder("#5a3a14", 0.14, 0.27, 0.27, [0, -0.04, 0]),
  kit.sphere("#5a3a14", 0.27, [0, 0.03, 0], [1, 0.7, 1]),
  kit.cylinder(STEEL, 0.03, 0.08, 0.06, [0, 0.11, 0]),
], name, { specular: 0.7 });

/** Rampe de police : une barre noire sur deux pieds, ses deux feux (bleu à gauche, rouge à droite) côte à côte, un haut-parleur au milieu. */
const policeBar: BlockModel = (kit, _color, name) => kit.fuse([
  kit.box(DARK, [0.46, 0.04, 0.3], [0, -0.23, 0]),
  ...[-0.17, 0.17].map((x) => kit.box(STEEL, [0.04, 0.06, 0.06], [x, -0.19, 0])),
  kit.box(DARK, [0.48, 0.03, 0.18], [0, -0.155, 0]),
  kit.box("#24304a", [0.2, 0.08, 0.14], [0.115, -0.115, 0]),
  kit.box("#4a2424", [0.2, 0.08, 0.14], [-0.115, -0.115, 0]),
  kit.box(CHROME, [0.04, 0.07, 0.12], [0, -0.115, 0]),
  kit.box(DARK, [0.48, 0.015, 0.18], [0, -0.065, 0]),
], name, { specular: 0.6 });

export const LIGHT_MODELS: Partial<Record<BlockType, BlockModel>> = { headlight, beacon, navLight, strobe, antiCollision, rotatingLight, policeBar };
