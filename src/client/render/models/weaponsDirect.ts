import type * as B from "../../babylon";
import { blockDef, type BlockType } from "../../../shared/catalog/blocks";
import type { BlockModel, HeadModel, ModelKit, RoundsModel, V3 } from "../modelKit";
import type { TurretBlockType } from "../models";

/*
 * Armes à tir direct et explosives : modèles 3D de leurs têtes et de leurs socles (le bloc sous la
 * tête). Repère d'une tête : son axe de rotation à l'origine, le canon vers +z ; la bouche tombe à
 * `TurretSpec.barrel` m devant l'axe (d'où part le coup, combat/turrets.ts), c'est là que finit
 * chaque canon (lu dans le catalogue, `spec`). Un socle est centré sur sa case (±0,25 m), haut vers +y : la tête est
 * posée à `TurretSpec.height` au-dessus de son centre, sur la couronne d'orientation.
 * Les couleurs reprennent celles de `TURRET_LOOKS` (render/models.ts), l'identité de chaque arme.
 */

/** Hauteur de l'axe de la tête au-dessus du centre du bloc (m) et distance de l'axe à la bouche du canon (m) : `TurretSpec`. */
const spec = (type: TurretBlockType): { height: number; barrel: number } => {
  const t = blockDef(type).turret!;
  return { height: t.height, barrel: t.barrel };
};

const STEEL = "#8d959c";
/** Acier de la couronne d'orientation, plus sombre : sous la lumière, l'acier clair paraissait blanc. */
const RING = "#62696f";
const GUNMETAL = "#23272b";
const BLACK = "#15171a";
const BRASS = "#c9a045";
const HAZARD = "#f0bd2c";
const OLIVE = "#5b6340";
const GLASS = "#6fa8dc";

/** Un tube le long de +z, de `from` à `to` (m devant l'axe), centré en x, y. */
const tube = (kit: ModelKit, color: string, diameter: number, from: number, to: number, x = 0, y = 0, tip?: number): B.Mesh =>
  kit.cylinder(color, to - from, diameter, tip ?? diameter, [x, y, (from + to) / 2], "z", 12);

/** Pavé à facettes : un tronc de pyramide carré (côtés `bottom` et `top`), de hauteur `h`, centré en `at`. */
function frustum(kit: ModelKit, color: string, h: number, bottom: number, top: number, at: V3): B.Mesh {
  const m = kit.cylinder(color, h, bottom * Math.SQRT2, top * Math.SQRT2, [0, 0, 0], "y", 4);
  m.rotation.y = Math.PI / 4;
  m.position.set(at[0], at[1], at[2]);
  m.bakeCurrentTransformIntoVertices();
  m.convertToFlatShadedMesh();
  return m;
}

/** Tourillons de part et d'autre de la tête (l'axe du site, le long de x). */
const trunnions = (kit: ModelKit, color: string, width: number, diameter = 0.08): B.Mesh =>
  kit.cylinder(color, width, diameter, diameter, [0, 0, 0], "x", 12);

/** Frein de bouche : un manchon et deux fentes, finissant à `z`. */
function muzzleBrake(kit: ModelKit, color: string, z: number, diameter: number, length: number, y = 0): B.Mesh[] {
  return [
    tube(kit, color, diameter, z - length, z, 0, y),
    kit.box(color, [diameter * 1.35, diameter * 0.35, length * 0.3], [0, y, z - length * 0.7]),
    kit.box(color, [diameter * 1.35, diameter * 0.35, length * 0.3], [0, y, z - length * 0.25]),
  ];
}

// --- Têtes ---

/** Mitrailleuse : boîte de culasse, bouclier, canon à manchon de refroidissement, caisse à munitions et bande. */
const gunHead: HeadModel = (kit, name) => {
  const z = spec("gunTurret").barrel;
  return kit.fuse([
    kit.box("#3b4249", [0.2, 0.16, 0.34], [0, 0, 0.0]),
    kit.box("#4a525a", [0.16, 0.05, 0.26], [0, 0.1, -0.01]),
    trunnions(kit, GUNMETAL, 0.3),
    // Bouclier, un peu incliné
    kit.box("#3b4249", [0.34, 0.24, 0.03], [0, 0.02, 0.17], [-0.12, 0, 0]),
    // Canon : manchon ajouré, tube, frein de bouche
    tube(kit, GUNMETAL, 0.085, 0.18, 0.44),
    ...[0.24, 0.3, 0.36].map((c) => tube(kit, BLACK, 0.095, c, c + 0.02)),
    tube(kit, BLACK, 0.05, 0.44, z - 0.05),
    ...muzzleBrake(kit, BLACK, z, 0.07, 0.07),
    // Caisse à munitions à gauche, et sa bande de cartouches
    kit.box(OLIVE, [0.12, 0.15, 0.2], [0.17, -0.03, -0.02]),
    kit.box(HAZARD, [0.125, 0.02, 0.205], [0.17, 0.03, -0.02]),
    ...[0, 1, 2].map((i) => kit.box(BRASS, [0.03, 0.035, 0.035], [0.11 - i * 0.012, 0.025 - i * 0.012, 0.03 + i * 0.03])),
    // Hausse
    kit.box(BLACK, [0.03, 0.05, 0.03], [0, 0.145, 0.1]),
  ], name, { specular: 0.35 });
};

/** Sniper : culasse fine, longue lunette sur montants, chargeur, crosse, long canon et frein de bouche. */
const sniperHead: HeadModel = (kit, name) => {
  const z = spec("sniperTurret").barrel;
  return kit.fuse([
    kit.box("#4a4f3a", [0.14, 0.14, 0.44], [0, 0, 0]),
    kit.box("#3c4030", [0.12, 0.09, 0.14], [0, -0.01, -0.27]),
    trunnions(kit, GUNMETAL, 0.24),
    kit.box(BLACK, [0.07, 0.14, 0.09], [0, -0.13, 0.05], [0.25, 0, 0]),
    // Lunette : corps, bonnettes, montants, verre
    tube(kit, BLACK, 0.065, -0.14, 0.2, 0, 0.13),
    tube(kit, BLACK, 0.085, -0.17, -0.1, 0, 0.13),
    tube(kit, BLACK, 0.09, 0.14, 0.22, 0, 0.13),
    tube(kit, GLASS, 0.075, 0.22, 0.226, 0, 0.13),
    kit.box(GUNMETAL, [0.04, 0.06, 0.03], [0, 0.085, -0.06]),
    kit.box(GUNMETAL, [0.04, 0.06, 0.03], [0, 0.085, 0.1]),
    kit.cylinder(BLACK, 0.04, 0.035, 0.035, [0.045, 0.13, 0.02], "x", 8),
    // Canon
    tube(kit, "#2a2d24", 0.06, 0.2, 0.36),
    tube(kit, "#1e2226", 0.04, 0.36, z - 0.08),
    ...muzzleBrake(kit, "#1e2226", z, 0.065, 0.09),
  ], name, { specular: 0.3 });
};

/** Canon : tourelle lourde à masque en biseau, tube à évacuateur de fumées et frein de bouche, tourelleau, coffre arrière. */
const cannonHead: HeadModel = (kit, name) => {
  const z = spec("cannonTurret").barrel;
  const body = "#4b5059";
  return kit.fuse([
    kit.box(body, [0.5, 0.24, 0.42], [0, -0.01, -0.04]),
    frustum(kit, body, 0.07, 0.48, 0.38, [0, 0.145, -0.05]),
    // Masque en biseau, à l'avant
    kit.box("#555b64", [0.3, 0.2, 0.12], [0, 0, 0.18], [-0.3, 0, 0]),
    trunnions(kit, "#3c4148", 0.54, 0.1),
    // Jupes latérales
    kit.box("#42474f", [0.03, 0.2, 0.36], [0.26, -0.03, -0.02]),
    kit.box("#42474f", [0.03, 0.2, 0.36], [-0.26, -0.03, -0.02]),
    // Coffre arrière
    kit.box("#42474f", [0.44, 0.18, 0.12], [0, -0.01, -0.31]),
    kit.box(HAZARD, [0.445, 0.02, 0.125], [0, 0.06, -0.31]),
    // Tourelleau et périscope
    kit.cylinder("#555b64", 0.05, 0.14, 0.14, [0.11, 0.2, -0.1], "y", 12),
    kit.box(BLACK, [0.07, 0.04, 0.04], [0.11, 0.24, -0.06]),
    kit.box(GLASS, [0.05, 0.02, 0.005], [0.11, 0.245, -0.038]),
    // Tube : collier, tube, évacuateur, frein de bouche
    tube(kit, "#3c4148", 0.18, 0.2, 0.34),
    tube(kit, "#2a2e33", 0.12, 0.34, z - 0.1),
    tube(kit, "#2a2e33", 0.16, 0.5, 0.62),
    ...muzzleBrake(kit, "#2a2e33", z, 0.15, 0.12),
  ], name, { specular: 0.3 });
};

/** Fusil à pompe : deux gros canons superposés côte à côte, bandes, chargeur-tambour, garde-main ajouré. */
const shotgunHead: HeadModel = (kit, name) => {
  const z = spec("shotgunTurret").barrel;
  return kit.fuse([
    kit.box("#4a4137", [0.3, 0.19, 0.3], [0, 0, -0.02]),
    frustum(kit, "#564b3f", 0.05, 0.28, 0.22, [0, 0.12, -0.03]),
    trunnions(kit, GUNMETAL, 0.36, 0.09),
    // Chargeur-tambour sous la culasse
    kit.cylinder("#3a332b", 0.12, 0.2, 0.2, [0, -0.13, 0.02], "x", 14),
    kit.cylinder(BRASS, 0.125, 0.07, 0.07, [0, -0.13, 0.02], "x", 10),
    // Canons, bandes, bouches évasées
    ...[-1, 1].flatMap((s) => [
      tube(kit, "#1e2226", 0.085, 0.13, z - 0.03, s * 0.055),
      tube(kit, "#1e2226", 0.1, z - 0.03, z, s * 0.055),
    ]),
    ...[0.22, 0.4].map((c) => kit.box("#4a4137", [0.23, 0.11, 0.035], [0, 0, c])),
    // Garde-main ajouré sur le dessus
    ...[0.2, 0.27, 0.34, 0.41].map((c) => kit.box(BLACK, [0.16, 0.012, 0.035], [0, 0.058, c])),
  ], name, { specular: 0.3 });
};

/** Laser : carter rond à ailettes de refroidissement, condensateurs, tube de focalisation et lentille rouge. */
const laserHead: HeadModel = (kit, name) => {
  const z = spec("laserTurret").barrel;
  const red = "#ff4d5e";
  return kit.fuse([
    tube(kit, "#40363c", 0.22, -0.18, 0.16),
    ...[-0.12, -0.07, -0.02, 0.03, 0.08].map((c) => tube(kit, "#2c2529", 0.29, c, c + 0.018)),
    trunnions(kit, GUNMETAL, 0.3),
    // Condensateurs de part et d'autre
    ...[-1, 1].map((s) => kit.box("#5a4b53", [0.05, 0.12, 0.18], [s * 0.15, -0.03, -0.04])),
    ...[-1, 1].map((s) => kit.box(red, [0.052, 0.02, 0.182], [s * 0.15, 0.01, -0.04])),
    // Tube de focalisation, bagues, lentille
    tube(kit, GUNMETAL, 0.07, 0.16, z - 0.04, 0, 0, 0.06),
    ...[0.28, 0.4].map((c) => tube(kit, red, 0.085, c, c + 0.02)),
    tube(kit, BLACK, 0.085, z - 0.04, z),
    tube(kit, red, 0.06, z - 0.005, z + 0.002),
    // Câbles
    ...[-1, 1].map((s) => tube(kit, BLACK, 0.025, -0.14, 0.12, s * 0.09, -0.1)),
  ], name, { specular: 0.45, emissive: "#140608" });
};

/** Canon électrique : deux rails d'acier dans des bobines bleues, caisson, bancs de condensateurs. */
const railHead: HeadModel = (kit, name) => {
  const z = spec("railTurret").barrel;
  const blue = "#8fd3ff";
  return kit.fuse([
    kit.box("#39424c", [0.36, 0.22, 0.5], [0, 0, -0.04]),
    frustum(kit, "#434d58", 0.06, 0.34, 0.26, [0, 0.14, -0.06]),
    trunnions(kit, "#2b3239", 0.42, 0.1),
    // Bancs de condensateurs à l'arrière
    ...[-1, 1].map((s) => tube(kit, "#2b3239", 0.1, -0.32, -0.06, s * 0.13, -0.02)),
    ...[-1, 1].map((s) => tube(kit, blue, 0.09, -0.335, -0.32, s * 0.13, -0.02)),
    // Rails, dos qui les relie, bobines
    ...[-1, 1].map((s) => kit.box(STEEL, [0.04, 0.09, z - 0.18], [s * 0.055, 0, (0.18 + z) / 2])),
    kit.box("#2b3239", [0.07, 0.03, z - 0.24], [0, 0.07, (0.2 + z - 0.04) / 2]),
    ...[0.32, 0.47, 0.62, 0.77, 0.92].map((c) => kit.ring(blue, 0.2, 0.035, [0, 0, c], "z", 10)),
    ...[0.32, 0.62, 0.92].map((c) => kit.box("#2b3239", [0.22, 0.03, 0.05], [0, -0.075, c])),
    // Bouts des rails
    ...[-1, 1].map((s) => kit.box(blue, [0.045, 0.1, 0.02], [s * 0.055, 0, z - 0.01])),
  ], name, { specular: 0.45, emissive: "#040b12" });
};

/** Plasma : chambre bombée cerclée de violet, ailettes, tube d'émission à anneaux de confinement. */
const plasmaHead: HeadModel = (kit, name) => {
  const z = spec("plasmaTurret").barrel;
  const violet = "#c77dff";
  return kit.fuse([
    kit.sphere("#3a3046", 0.3, [0, 0, -0.03], [1, 0.85, 1.15], 10),
    kit.ring(violet, 0.3, 0.035, [0, 0, -0.03], "z", 10),
    kit.ring("#2a2233", 0.27, 0.03, [0, 0, -0.03], "y", 10),
    trunnions(kit, GUNMETAL, 0.32),
    // Ailettes de refroidissement sur les flancs
    ...[-1, 1].flatMap((s) => [-0.09, -0.03, 0.03].map((c) => kit.box("#2a2233", [0.06, 0.16, 0.014], [s * 0.15, 0, c]))),
    // Tube d'émission, anneaux de confinement, bouche
    tube(kit, "#2a2233", 0.12, 0.1, z - 0.04, 0, 0, 0.09),
    ...[0.22, 0.33].map((c) => kit.ring(violet, 0.13, 0.03, [0, 0, c], "z", 8)),
    tube(kit, violet, 0.13, z - 0.04, z),
    // Conduits
    ...[-1, 1].map((s) => tube(kit, violet, 0.025, -0.08, 0.14, s * 0.07, 0.1)),
  ], name, { specular: 0.4, emissive: "#0c0612" });
};

/** Lance-flammes : corps, deux réservoirs rouges et une bouteille de gaz, lance et buse, veilleuse. */
const flamerHead: HeadModel = (kit, name) => {
  const z = spec("flamerTurret").barrel;
  const tank = "#b8452e";
  return kit.fuse([
    kit.box("#5a3b30", [0.22, 0.18, 0.3], [0, 0, -0.02]),
    trunnions(kit, GUNMETAL, 0.46),
    // Réservoirs de part et d'autre, avec leurs calottes et leurs sangles
    ...[-1, 1].flatMap((s) => [
      tube(kit, tank, 0.12, -0.2, 0.08, s * 0.17, -0.01),
      // Calottes : des troncs de cône (une sphère coûtait quatre fois plus de sommets)
      tube(kit, tank, 0.12, 0.08, 0.11, s * 0.17, -0.01, 0.07),
      tube(kit, tank, 0.07, -0.23, -0.2, s * 0.17, -0.01, 0.12),
      tube(kit, GUNMETAL, 0.13, -0.1, -0.08, s * 0.17, -0.01),
      tube(kit, GUNMETAL, 0.13, 0.0, 0.02, s * 0.17, -0.01),
    ]),
    // Bouteille de gaz sur le dessus, et son manomètre
    tube(kit, STEEL, 0.07, -0.16, 0.06, 0, 0.12),
    kit.cylinder(BLACK, 0.02, 0.045, 0.045, [0.05, 0.12, -0.04], "x", 10),
    // Lance, buse évasée, veilleuse orange
    tube(kit, "#2a2e33", 0.07, 0.13, z - 0.07),
    tube(kit, "#2a2e33", 0.09, z - 0.07, z, 0, 0, 0.12),
    kit.box("#ff8a2a", [0.025, 0.025, 0.04], [0, -0.06, z - 0.03]),
    // Tuyau d'alimentation
    tube(kit, BLACK, 0.03, 0.02, 0.2, 0, -0.08),
  ], name, { specular: 0.3 });
};

/** Canon IEM : caisson, tube à trois bobines de champ bleues, pavillon d'émission, sphères de décharge. */
const empHead: HeadModel = (kit, name) => {
  const z = spec("empTurret").barrel;
  const blue = "#9fe3ff";
  return kit.fuse([
    kit.box("#2f4a5c", [0.36, 0.24, 0.4], [0, 0, -0.04]),
    frustum(kit, "#36546a", 0.06, 0.34, 0.26, [0, 0.15, -0.05]),
    trunnions(kit, "#22364a", 0.42, 0.1),
    // Sphères de décharge sur le dessus, sur leurs isolateurs
    ...[-1, 1].flatMap((s) => [
      kit.cylinder("#e8e4d8", 0.06, 0.04, 0.03, [s * 0.1, 0.21, -0.1], "y", 8),
      kit.sphere(blue, 0.09, [s * 0.1, 0.27, -0.1], [1, 1, 1], 10),
    ]),
    // Tube, bobines de champ, pavillon
    tube(kit, "#22364a", 0.09, 0.16, z - 0.06),
    ...[0.3, 0.44, 0.56].map((c) => kit.ring(blue, 0.22, 0.045, [0, 0, c], "z", 10)),
    tube(kit, "#22364a", 0.1, z - 0.06, z, 0, 0, 0.2),
    tube(kit, blue, 0.16, z - 0.004, z + 0.002),
  ], name, { specular: 0.4, emissive: "#03080c" });
};

/** Lance-fumigènes : un berceau et quatre tubes (deux sur deux) ; les capsules, à part, au bord des tubes (`SMOKE`). */
const smokeHead: HeadModel = (kit, name) => {
  const z = spec("smokeLauncher").barrel;
  return kit.fuse([
    kit.box("#4a5057", [0.28, 0.12, 0.2], [0, -0.07, -0.04]),
    trunnions(kit, GUNMETAL, 0.34),
    // Flasques qui tiennent les tubes
    ...[-1, 1].map((s) => kit.box("#3c4147", [0.02, 0.22, 0.3], [s * 0.14, 0.02, 0.08])),
    kit.box("#3c4147", [0.26, 0.22, 0.03], [0, 0.02, -0.06]),
    ...[-1, 1].flatMap((sx) => [-1, 1].map((sy) => tube(kit, "#1e2226", 0.1, -0.05, z, sx * 0.065, 0.02 + sy * 0.058))),
    kit.box(HAZARD, [0.27, 0.025, 0.04], [0, 0.14, 0.24]),
  ], name, { specular: 0.3 });
};

// --- Socles ---

/**
 * Socle de tourelle : un caisson presque plein (il se raccorde aux blocs voisins), un chanfrein, la
 * couronne d'orientation et ses boulons, et le pivot fixe qui monte jusque sous la tête (posée à
 * `height` m au-dessus du centre du bloc : `TurretSpec.height`) ; `extra` ajoute ce qui distingue l'arme.
 */
function socle(body: string, trim: string, height: number, extra: (kit: ModelKit) => B.Mesh[] = () => []): BlockModel {
  const post = height - 0.07 - 0.22;
  return (kit, _color, name) => kit.fuse([
    kit.box(body, [0.485, 0.3, 0.485], [0, -0.095, 0]),
    frustum(kit, body, 0.1, 0.485, 0.38, [0, 0.105, 0]),
    // Liserés et bande basse
    kit.box(trim, [0.49, 0.03, 0.49], [0, 0.04, 0]),
    kit.box(GUNMETAL, [0.49, 0.04, 0.49], [0, -0.225, 0]),
    // Couronne d'orientation, ses boulons, et le pivot
    kit.cylinder(RING, 0.05, 0.36, 0.34, [0, 0.18, 0], "y", 16),
    kit.cylinder(GUNMETAL, 0.03, 0.26, 0.26, [0, 0.215, 0], "y", 16),
    ...[0, 1, 2, 3, 4, 5].map((i) => {
      const a = (i / 6) * Math.PI * 2;
      return kit.cylinder(BLACK, 0.02, 0.025, 0.025, [Math.cos(a) * 0.15, 0.21, Math.sin(a) * 0.15], "y", 6);
    }),
    ...(post > 0.01 ? [kit.cylinder(GUNMETAL, post, 0.13, 0.12, [0, 0.22 + post / 2, 0], "y", 12)] : []),
    // Trappe de visite sur l'arrière
    kit.box(trim, [0.2, 0.12, 0.012], [0, -0.1, -0.245]),
    ...extra(kit),
  ], name, { specular: 0.3 });
}

/** Caisse à munitions sur un flanc du socle. */
const ammoBox = (color: string) => (kit: ModelKit): B.Mesh[] => [
  kit.box(color, [0.03, 0.16, 0.22], [0.255, -0.08, 0.02]),
  kit.box(HAZARD, [0.032, 0.025, 0.225], [0.256, -0.02, 0.02]),
];

/** Batterie de condensateurs sur un flanc (armes électriques). */
const capacitors = (glow: string) => (kit: ModelKit): B.Mesh[] => [
  ...[-0.08, 0.08].map((z) => kit.cylinder("#2b3239", 0.18, 0.08, 0.08, [0.26, -0.09, z], "y", 10)),
  ...[-0.08, 0.08].map((z) => kit.cylinder(glow, 0.02, 0.085, 0.085, [0.26, 0.005, z], "y", 10)),
];

export const DIRECT_BASES: Partial<Record<BlockType, BlockModel>> = {
  gunTurret: socle("#3b4249", "#4a525a", spec("gunTurret").height, ammoBox(OLIVE)),
  sniperTurret: socle("#4a4f3a", "#3c4030", spec("sniperTurret").height, (kit) => [kit.box(BLACK, [0.03, 0.08, 0.3], [0.255, -0.1, 0])]),
  cannonTurret: socle("#4b5059", "#42474f", spec("cannonTurret").height, ammoBox("#3c4148")),
  shotgunTurret: socle("#4a4137", "#564b3f", spec("shotgunTurret").height, ammoBox("#3a332b")),
  laserTurret: socle("#40363c", "#2c2529", spec("laserTurret").height, capacitors("#ff4d5e")),
  railTurret: socle("#39424c", "#2b3239", spec("railTurret").height, capacitors("#8fd3ff")),
  plasmaTurret: socle("#3a3046", "#2a2233", spec("plasmaTurret").height, capacitors("#c77dff")),
  flamerTurret: socle("#5a3b30", "#4a2f26", spec("flamerTurret").height, (kit) => [
    kit.cylinder("#b8452e", 0.3, 0.1, 0.1, [0.255, -0.08, 0], "z", 10),
    kit.cylinder(GUNMETAL, 0.02, 0.11, 0.11, [0.255, -0.08, 0.08], "z", 10),
  ]),
  empTurret: socle("#2f4a5c", "#22364a", spec("empTurret").height, capacitors("#9fe3ff")),
  smokeLauncher: socle("#4a5057", "#3c4147", spec("smokeLauncher").height, (kit) => [0.08, -0.08].map((z) => kit.cylinder("#e0e4e8", 0.18, 0.07, 0.07, [0.26, -0.09, z], "y", 10))),
};

/** Une capsule fumigène, au bord de son tube (quatre tubes, trois coups : on en voit la part qui reste). */
const SMOKE: RoundsModel = (kit, name) => {
  const z = spec("smokeLauncher").barrel;
  return {
    // Le culot clair de la capsule affleure à la bouche du tube (plein et sombre)
    mesh: kit.fuse([
      tube(kit, "#e0e4e8", 0.075, -0.04, 0.012),
      tube(kit, "#c9ced2", 0.08, 0.004, 0.016),
    ], name, { specular: 0.3 }),
    slots: [[0.065, 0.078, z], [-0.065, 0.078, z], [0.065, -0.038, z], [-0.065, -0.038, z]],
  };
};

/** Munitions visibles : elles partent quand on tire, reviennent au rechargement (render/rounds.ts). */
export const DIRECT_ROUNDS: Partial<Record<TurretBlockType, RoundsModel>> = { smokeLauncher: SMOKE };

export const DIRECT_HEADS: Partial<Record<TurretBlockType, HeadModel>> = {
  gunTurret: gunHead,
  sniperTurret: sniperHead,
  cannonTurret: cannonHead,
  shotgunTurret: shotgunHead,
  laserTurret: laserHead,
  railTurret: railHead,
  plasmaTurret: plasmaHead,
  flamerTurret: flamerHead,
  empTurret: empHead,
  smokeLauncher: smokeHead,
};
