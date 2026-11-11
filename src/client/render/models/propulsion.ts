import type { BlockType } from "../../../shared/catalog/blocks";
import type { BlockModel, ModelKit } from "../modelKit";
import type * as B from "../../babylon";

/*
 * Modèles 3D des blocs de propulsion. Un moteur pousse vers le haut de son bloc (+y) : sa tuyère,
 * d'où sort la flamme (render/worldView.ts), est en bas (-y). Les pales d'un rotor ou d'une hélice,
 * la nacelle d'un turboréacteur, la lueur d'un patin et les jambes d'une patte sont dessinées à part
 * (LocomotionView, WorldView) : le bloc en est le support. Chacun garde une bride ou une platine
 * de la largeur de sa case, pour qu'on le voie tenir à ses voisins.
 */

const STEEL = "#8d959c";
const LIGHT = "#c3c9ce";
const DARK = "#2b3034";
const SOOT = "#1a1c1e";
const HAZARD = "#f0bd2c";
const COPPER = "#b0673a";
const CYAN = "#5fe0ff";
const DEEP = "#1d4a5a";

/** Quatre boulons aux coins d'une platine horizontale, à la hauteur `y`. */
function bolts(kit: ModelKit, y: number, spread = 0.17): B.Mesh[] {
  return [-1, 1].flatMap((sx) => [-1, 1].map((sz) => kit.cylinder(STEEL, 0.03, 0.045, 0.045, [sx * spread, y, sz * spread], "y", 8)));
}

/** Réacteur : un petit moteur-fusée, sa bride de fixation en haut, sa tuyère en cloche en bas. */
const thruster: BlockModel = (kit, _color, name) => kit.fuse([
  kit.box(DARK, [0.46, 0.07, 0.46], [0, 0.2, 0]),
  ...bolts(kit, 0.24),
  kit.cylinder(STEEL, 0.24, 0.3, 0.34, [0, 0.05, 0]),
  kit.ring(HAZARD, 0.34, 0.035, [0, 0.1, 0]),
  kit.cylinder(DARK, 0.05, 0.22, 0.26, [0, -0.095, 0]),
  kit.cylinder(COPPER, 0.14, 0.44, 0.22, [0, -0.19, 0]),
  kit.cylinder(SOOT, 0.02, 0.36, 0.36, [0, -0.255, 0]),
], name, { specular: 0.4 });

/**
 * Propulseur : une turbine. L'entrée d'air en haut (lèvre claire, soufflante sombre, cône), le
 * carter tenu par une platine carrée, la tuyère qui se resserre en bas.
 */
const engine: BlockModel = (kit, _color, name) => kit.fuse([
  kit.box(DARK, [0.48, 0.05, 0.48], [0, 0.04, 0]),
  ...bolts(kit, 0.075, 0.2),
  kit.cylinder(STEEL, 0.34, 0.42, 0.42, [0, 0.02, 0]),
  kit.ring(LIGHT, 0.42, 0.05, [0, 0.19, 0]),
  kit.cylinder(SOOT, 0.02, 0.36, 0.36, [0, 0.185, 0]),
  kit.cylinder(LIGHT, 0.07, 0.12, 0, [0, 0.225, 0], "y", 10),
  ...[0, 1, 2, 3, 4, 5].map((i) => kit.box(DARK, [0.3, 0.012, 0.04], [0, 0.19, 0], [0, (i * Math.PI) / 6, 0.35])),
  kit.ring(COPPER, 0.43, 0.03, [0, -0.07, 0]),
  kit.cylinder(DARK, 0.1, 0.3, 0.4, [0, -0.2, 0]),
  kit.cylinder(SOOT, 0.02, 0.26, 0.26, [0, -0.255, 0]),
], name, { specular: 0.45 });

/**
 * Rotor orientable : la boîte de transmission sur sa platine, le plateau cyclique (anneau jaune)
 * et ses biellettes, le mât qui monte jusqu'au moyeu des pales (dessinées au-dessus du bloc).
 */
const rotor: BlockModel = (kit, _color, name) => kit.fuse([
  kit.box(DARK, [0.48, 0.1, 0.48], [0, -0.19, 0]),
  ...bolts(kit, -0.13, 0.19),
  kit.box(STEEL, [0.36, 0.2, 0.34], [0, -0.04, 0]),
  kit.cylinder(STEEL, 0.1, 0.26, 0.2, [0, 0.11, 0]),
  kit.ring(HAZARD, 0.28, 0.04, [0, 0.17, 0]),
  ...[-1, 1].map((s) => kit.cylinder(LIGHT, 0.2, 0.025, 0.025, [s * 0.09, 0.26, 0], "y", 6)),
  kit.cylinder(LIGHT, 0.34, 0.09, 0.08, [0, 0.33, 0], "y", 12),
], name, { specular: 0.4 });

/**
 * Moteur d'hélice : un moteur en étoile (cylindres en couronne) sous son capot, l'arbre qui sort
 * vers les pales et le cône (dessinés devant le bloc, vers +y), et deux pipes d'échappement.
 */
const propeller: BlockModel = (kit, _color, name) => {
  const radial = [0, 1, 2, 3, 4, 5, 6].map((i) => {
    const a = (i * Math.PI * 2) / 7;
    return kit.cylinder(STEEL, 0.12, 0.1, 0.08, [Math.cos(a) * 0.17, 0.05, Math.sin(a) * 0.17], "y", 8);
  });
  return kit.fuse([
    kit.box(DARK, [0.48, 0.08, 0.48], [0, -0.2, 0]),
    ...bolts(kit, -0.145, 0.19),
    kit.cylinder(DARK, 0.26, 0.44, 0.4, [0, -0.04, 0]),
    ...radial,
    kit.ring(LIGHT, 0.44, 0.05, [0, 0.12, 0]),
    kit.cylinder(STEEL, 0.1, 0.2, 0.14, [0, 0.16, 0]),
    kit.cylinder(LIGHT, 0.14, 0.07, 0.07, [0, 0.27, 0], "y", 10),
    ...[-1, 1].map((s) => kit.cylinder(SOOT, 0.2, 0.05, 0.05, [s * 0.23, -0.06, 0.12], "z", 8)),
  ], name, { specular: 0.45 });
};

/**
 * Turboréacteur : sa nacelle (dessinée à part) l'enveloppe ; le bloc en est la cage de fixation,
 * quatre longerons et deux cadres qui la tiennent, et un fût sombre au cœur.
 */
const jet: BlockModel = (kit, _color, name) => {
  const rails = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => kit.box(DARK, [0.05, 0.5, 0.05], [sx * 0.22, 0, sz * 0.22])));
  const frames = [-0.22, 0.22].flatMap((y) => [
    kit.box(STEEL, [0.48, 0.04, 0.05], [0, y, 0.22]), kit.box(STEEL, [0.48, 0.04, 0.05], [0, y, -0.22]),
    kit.box(STEEL, [0.05, 0.04, 0.48], [0.22, y, 0]), kit.box(STEEL, [0.05, 0.04, 0.48], [-0.22, y, 0]),
  ]);
  return kit.fuse([...rails, ...frames, kit.cylinder(SOOT, 0.48, 0.4, 0.4, [0, 0, 0])], name, { specular: 0.4 });
};

/**
 * Patin anti-gravité : une platine en haut, un carter, et en dessous l'émetteur, un cône qui se
 * resserre sur un anneau et un disque lumineux (la lueur au sol est dessinée à part).
 */
const hoverPad: BlockModel = (kit, _color, name) => kit.fuse([
  kit.box(DARK, [0.48, 0.07, 0.48], [0, 0.2, 0]),
  ...bolts(kit, 0.24),
  kit.cylinder(STEEL, 0.16, 0.46, 0.4, [0, 0.08, 0]),
  kit.ring(HAZARD, 0.44, 0.03, [0, 0.03, 0]),
  kit.cylinder(DARK, 0.12, 0.32, 0.44, [0, -0.08, 0]),
  kit.ring(CYAN, 0.34, 0.05, [0, -0.15, 0]),
  kit.cylinder(DEEP, 0.03, 0.3, 0.3, [0, -0.16, 0]),
  kit.cylinder(CYAN, 0.04, 0.12, 0.12, [0, -0.175, 0], "y", 12),
], name, { specular: 0.5, emissive: "#0a1a20" });

/**
 * Patte : l'articulation de hanche (la cuisse et le tibia partent de son centre, dessinés à part) :
 * un carter, l'axe de hanche de part en part, deux vérins.
 */
const leg: BlockModel = (kit, _color, name) => kit.fuse([
  kit.box(DARK, [0.4, 0.4, 0.4], [0, 0, 0]),
  kit.box(STEEL, [0.46, 0.08, 0.46], [0, 0.2, 0]),
  kit.cylinder(STEEL, 0.5, 0.22, 0.22, [0, 0, 0], "x", 14),
  ...[-1, 1].map((s) => kit.cylinder(HAZARD, 0.04, 0.26, 0.26, [s * 0.23, 0, 0], "x", 14)),
  ...[-1, 1].map((s) => kit.cylinder(LIGHT, 0.3, 0.06, 0.06, [s * 0.12, 0.05, 0.19], "y", 8)),
], name, { specular: 0.4 });

export const PROPULSION_MODELS: Partial<Record<BlockType, BlockModel>> = { thruster, engine, rotor, propeller, jet, hoverPad, leg };
