import type * as B from "../../babylon";
import type { BlockType } from "../../../shared/catalog/blocks";
import type { BlockModel, HeadModel, ModelKit, V3, RoundsModel } from "../modelKit";
import type { TurretBlockType } from "../models";

/*
 * Armes guidées, mines, largage et soutien : modèles 3D de leurs socles (le bloc) et de leurs
 * têtes. Couleurs d'identité reprises de `TURRET_LOOKS` (render/models.ts).
 *
 * Repères (voir render/modelKit.ts) : une tête a son axe de rotation à l'origine, le canon vers +z,
 * et la bouche de son arme à `barrel` m devant l'axe (TurretSpec, shared/catalog/blocks.ts : c'est
 * de là que part le coup). Un socle est centré sur sa case (±0,25 m), son haut vers +y, son avant
 * vers +z.
 *
 * Un poseur de mines (tourelle fixe `back`) a sa tête sur le dessus de son bloc, tournée vers
 * l'arrière en jeu mais pas au garage ni dans les aperçus : sa tête est donc un tambour symétrique,
 * et la goulotte d'où tombent les mines, vers l'arrière (-z), fait partie du socle.
 */

// --- Couleurs communes ---
const GUNMETAL = "#3b4249";
const DARK = "#24282c";
const SOOT = "#141618";
const STEEL = "#8d959c";
const LIGHT = "#d9dee2";
const HAZARD = "#f0bd2c";
const RED = "#d8433a";

// --- Petits outils (en plus de ceux de l'atelier) ---

/** Tube le long de +z, de `z0` à `z0 + length`, centré en (x, y). */
const tubeZ = (kit: ModelKit, color: string, x: number, y: number, z0: number, length: number, dia: number, tess = 12): B.Mesh =>
  kit.cylinder(color, length, dia, dia, [x, y, z0 + length / 2], "z", tess);

/** Cône pointé vers +z : sa base de diamètre `base` en `z0`, sa pointe à `z0 + length`. */
const coneZ = (kit: ModelKit, color: string, x: number, y: number, z0: number, length: number, base: number, tess = 10): B.Mesh =>
  kit.cylinder(color, length, base, 0, [x, y, z0 + length / 2], "z", tess);

/** Disque mince face à +z (embouchure, lentille), centré en `at`. */
const discZ = (kit: ModelKit, color: string, dia: number, at: V3, depth = 0.012, tess = 12): B.Mesh =>
  kit.cylinder(color, depth, dia, dia, at, "z", tess);

/** Collier plat (un cylindre à peine plus large que ce qu'il cercle), le long de +z. */
const bandZ = (kit: ModelKit, color: string, x: number, y: number, z: number, dia: number, width = 0.025, tess = 12): B.Mesh =>
  kit.cylinder(color, width, dia, dia, [x, y, z], "z", tess);

/** Tourillons de la tête : l'axe de site, de part et d'autre, à l'origine. */
const trunnions = (kit: ModelKit, width: number, dia = 0.09): B.Mesh =>
  kit.cylinder(DARK, width, dia, dia, [0, 0, 0], "x", 10);

/**
 * Socle de tourelle orientable : un caisson aux angles abattus, une plaque de dessus, la couronne
 * d'orientation (cerclée de la couleur de l'arme, boulonnée), et une trappe d'accès sur chaque
 * flanc. Le haut de la couronne arrive à 0,23 m (le dessus du bloc est à 0,25 m).
 */
function turretBase(kit: ModelKit, name: string, body: string, accent: string, extra: B.Mesh[] = []): B.Mesh {
  const parts: B.Mesh[] = [
    kit.box(body, [0.47, 0.3, 0.47], [0, -0.09, 0]),
    // Angles abattus : quatre montants plus sombres
    ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => kit.box(DARK, [0.05, 0.3, 0.05], [sx * 0.225, -0.09, sz * 0.225]))),
    kit.box(GUNMETAL, [0.44, 0.05, 0.44], [0, 0.085, 0]),
    // Couronne d'orientation, cerclée et boulonnée
    kit.cylinder(DARK, 0.07, 0.42, 0.4, [0, 0.145, 0], "y", 16),
    kit.cylinder(accent, 0.02, 0.43, 0.43, [0, 0.13, 0], "y", 16),
    kit.cylinder(GUNMETAL, 0.05, 0.3, 0.3, [0, 0.2, 0], "y", 14),
    ...Array.from({ length: 8 }, (_, i) => {
      const a = (i * Math.PI) / 4 + Math.PI / 8;
      return kit.cylinder(STEEL, 0.02, 0.025, 0.025, [Math.cos(a) * 0.18, 0.19, Math.sin(a) * 0.18], "y", 6);
    }),
    // Trappes d'accès sur les flancs, avec leur poignée
    ...[-1, 1].flatMap((s) => [
      kit.box(GUNMETAL, [0.012, 0.14, 0.2], [s * 0.24, -0.1, 0]),
      kit.box(accent, [0.016, 0.02, 0.1], [s * 0.245, -0.05, 0]),
    ]),
    // Grille d'aération à l'arrière
    ...[-0.12, -0.06, 0].map((y) => kit.box(SOOT, [0.3, 0.02, 0.012], [0, y, -0.238])),
    ...extra,
  ];
  return kit.fuse(parts, name, { specular: 0.3 });
}

// --- Socles ---

/** Hauteur de la colonne qui porte la tête au-dessus de la couronne (m), pour les têtes perchées. */
const BASE_COLUMN: Partial<Record<TurretBlockType, number>> = { flakLauncher: 0.08 };

const GUIDED_BASE_COLORS: Partial<Record<TurretBlockType, [string, string]>> = {
  missileLauncher: ["#4c5b41", "#d9dee2"],
  flakLauncher: ["#5a435e", "#e0e4e8"],
  rocketPod: ["#48523e", HAZARD],
  lockonLauncher: ["#4c4530", "#ffcf5a"],
  warheadLauncher: ["#3f312e", "#ff6b5a"],
  repairTurret: ["#27402f", "#7fffb0"],
  naniteLauncher: ["#bdb79d", "#57d38c"],
  barrierProjector: ["#27354a", "#8fd0ff"],
};

/**
 * Poseur de mines : une trémie (le magasin des mines), sa goulotte qui descend vers l'arrière
 * (d'où elles tombent, -z) et sa trappe ; `body` : la couleur de la mine qu'il sème.
 */
function mineLayerBase(kit: ModelKit, name: string, body: string, accent: string): B.Mesh {
  return kit.fuse([
    // Caisson du magasin, jusqu'au dessus du bloc (le tambour y est posé)
    kit.box(body, [0.46, 0.4, 0.4], [0, -0.02, 0.03]),
    kit.box(DARK, [0.48, 0.05, 0.42], [0, 0.2, 0.03]),
    kit.box(DARK, [0.48, 0.05, 0.42], [0, -0.225, 0.03]),
    // Bandes d'avertissement sur les flancs
    ...[-1, 1].flatMap((s) => [-0.1, -0.02].map((y) => kit.box(accent, [0.012, 0.03, 0.34], [s * 0.232, y, 0.03]))),
    // Goulotte : une gaine carrée qui sort vers l'arrière, et sa bouche
    kit.box(GUNMETAL, [0.26, 0.2, 0.2], [0, -0.06, -0.2]),
    kit.box(SOOT, [0.2, 0.14, 0.02], [0, -0.06, -0.3]),
    kit.box(accent, [0.28, 0.03, 0.03], [0, 0.05, -0.29]),
    kit.box(accent, [0.28, 0.03, 0.03], [0, -0.17, -0.29]),
    // Trappe de chargement sur l'avant du caisson
    kit.box(GUNMETAL, [0.24, 0.16, 0.012], [0, -0.02, 0.235]),
    kit.box(STEEL, [0.08, 0.025, 0.02], [0, 0.03, 0.245]),
  ], name, { specular: 0.25 });
}

/** Soute à bombes : le caisson, deux portes dessous (entrouvertes) et une bande de danger. */
const bombBayBase: BlockModel = (kit, _color, name) => kit.fuse([
  kit.box("#2c322d", [0.48, 0.38, 0.48], [0, 0.03, 0]),
  ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => kit.box(DARK, [0.05, 0.38, 0.05], [sx * 0.225, 0.03, sz * 0.225]))),
  kit.box(HAZARD, [0.49, 0.04, 0.49], [0, 0.14, 0]),
  kit.box(DARK, [0.49, 0.02, 0.49], [0, 0.14, 0]),
  // Portes de soute : deux battants légèrement ouverts, sous le caisson
  kit.box("#3a423b", [0.2, 0.025, 0.44], [-0.115, -0.19, 0], [0, 0, 0.18]),
  kit.box("#3a423b", [0.2, 0.025, 0.44], [0.115, -0.19, 0], [0, 0, -0.18]),
  kit.box(SOOT, [0.1, 0.02, 0.4], [0, -0.16, 0]),
  // Charnières
  ...[-1, 1].map((s) => kit.cylinder(STEEL, 0.44, 0.03, 0.03, [s * 0.21, -0.17, 0], "z", 8)),
], name, { specular: 0.25 });

// --- Têtes ---

/** Lance-missiles : un conteneur à quatre tubes (les missiles, à part, dépassent de leur bouche : voir `MISSILES`). */
const missileHead: HeadModel = (kit, name) => {
  const body = "#5a6b4d";
  const parts: B.Mesh[] = [
    trunnions(kit, 0.54),
    kit.box(body, [0.44, 0.34, 0.5], [0, 0, 0.1]),
    kit.box(DARK, [0.46, 0.04, 0.52], [0, 0.0, 0.1]),
    // Poignée de chargement et boîtier de guidage sur le dessus
    kit.box(GUNMETAL, [0.14, 0.06, 0.16], [0, 0.2, -0.02]),
    kit.box("#8fd0ff", [0.1, 0.035, 0.012], [0, 0.2, 0.065]),
    kit.box(STEEL, [0.02, 0.04, 0.3], [0.17, 0.19, 0.12]),
    kit.box(STEEL, [0.02, 0.04, 0.3], [-0.17, 0.19, 0.12]),
    // Tuyères à l'arrière
    ...[-1, 1].flatMap((sx) => [-1, 1].map((sy) => discZ(kit, SOOT, 0.11, [sx * 0.1, sy * 0.08, -0.152], 0.012, 10))),
  ];
  for (const [x, y] of MISSILE_TUBES) {
    parts.push(
      tubeZ(kit, LIGHT, x, y, 0.33, 0.17, 0.145, 12),
      // La bouche, sombre : le nez du missile en dépasse ; parti, il reste un trou noir
      discZ(kit, SOOT, 0.12, [x, y, 0.503], 0.006, 12),
    );
  }
  return kit.fuse(parts, name, { specular: 0.35 });
};

/** Les tubes du lance-missiles (x, y), dans l'ordre où ils tirent. */
const MISSILE_TUBES: readonly [number, number][] = [[0.1, 0.08], [-0.1, 0.08], [0.1, -0.08], [-0.1, -0.08]];

/** Un missile dans son tube : son corps blanc, sa coiffe qui dépasse de la bouche, sa pointe rouge. */
const MISSILES: RoundsModel = (kit, name) => ({
  mesh: kit.fuse([
    tubeZ(kit, "#eef1f3", 0, 0, -0.05, 0.06, 0.1, 10),
    coneZ(kit, "#eef1f3", 0, 0, 0.01, 0.1, 0.1, 10),
    coneZ(kit, RED, 0, 0, 0.08, 0.035, 0.035, 8),
  ], name, { specular: 0.35 }),
  slots: MISSILE_TUBES.map(([x, y]): V3 => [x, y, 0.47]),
});

/** Anti-aérien : deux longs tubes blancs sur un berceau, un radar de conduite de tir au milieu. */
const flakHead: HeadModel = (kit, name) => {
  const body = "#6a4f6e";
  const parts: B.Mesh[] = [
    trunnions(kit, 0.2, 0.1),
    kit.box(body, [0.16, 0.24, 0.34], [0, 0, 0.02]),
    kit.box(DARK, [0.4, 0.06, 0.12], [0, -0.06, 0]),
    // Radar de conduite de tir : une parabole face à l'avant, sur un mât
    kit.cylinder(GUNMETAL, 0.12, 0.035, 0.035, [0, 0.17, 0], "y", 8),
    kit.cylinder("#c792ea", 0.03, 0.2, 0.14, [0, 0.26, 0.03], "z", 14),
    discZ(kit, SOOT, 0.13, [0, 0.26, 0.047], 0.01),
    coneZ(kit, STEEL, 0, 0.26, 0.05, 0.07, 0.03, 6),
  ];
  for (const x of [-0.15, 0.15]) {
    parts.push(
      tubeZ(kit, "#e0e4e8", x, 0, -0.14, 0.64, 0.13, 12),
      bandZ(kit, body, x, 0, -0.06, 0.145),
      bandZ(kit, body, x, 0, 0.3, 0.145),
      discZ(kit, SOOT, 0.11, [x, 0, 0.503], 0.006),
      discZ(kit, SOOT, 0.1, [x, 0, -0.142], 0.01),
    );
  }
  return kit.fuse(parts, name, { specular: 0.35 });
};

/** Un missile anti-aérien : son nez rouge qui dépasse du tube. */
const FLAK: RoundsModel = (kit, name) => ({
  mesh: kit.fuse([
    tubeZ(kit, "#e0e4e8", 0, 0, -0.04, 0.05, 0.1, 10),
    coneZ(kit, RED, 0, 0, 0.01, 0.1, 0.1, 10),
  ], name, { specular: 0.35 }),
  slots: [[0.15, 0, 0.48], [-0.15, 0, 0.48]],
});

/** Lance-roquettes : un panier alvéolé de six tubes, pointes jaunes, blindé sur les flancs. */
const rocketHead: HeadModel = (kit, name) => {
  const body = "#55604a";
  const parts: B.Mesh[] = [
    trunnions(kit, 0.6),
    kit.box(body, [0.5, 0.34, 0.44], [0, 0, 0.21]),
    // Plaques de blindage des flancs, un peu décollées
    ...[-1, 1].map((s) => kit.box("#48523e", [0.03, 0.38, 0.46], [s * 0.265, 0, 0.21])),
    // Cadre de la face avant
    kit.box(DARK, [0.5, 0.03, 0.02], [0, 0.17, 0.43]),
    kit.box(DARK, [0.5, 0.03, 0.02], [0, -0.17, 0.43]),
    // Poignée sur le dessus, feu de position rouge
    kit.box(STEEL, [0.26, 0.02, 0.03], [0, 0.21, 0.2]),
    ...[-1, 1].map((s) => kit.box(STEEL, [0.02, 0.04, 0.03], [s * 0.12, 0.19, 0.2])),
    kit.box(RED, [0.04, 0.03, 0.03], [0.2, 0.18, 0.05]),
  ];
  for (const [x, y] of ROCKET_CELLS) {
    // Alvéole : un embout clair et son fond sombre (la roquette, à part, en sort)
    parts.push(
      tubeZ(kit, LIGHT, x, y, 0.42, 0.03, 0.12, 10),
      discZ(kit, SOOT, 0.1, [x, y, 0.452], 0.006, 10),
    );
  }
  return kit.fuse(parts, name, { specular: 0.3 });
};

/** Les alvéoles du panier de roquettes (x, y), dans l'ordre où elles tirent. */
const ROCKET_CELLS: readonly [number, number][] = [
  [0.15, 0.075], [-0.15, 0.075], [0, 0.075], [0.15, -0.075], [-0.15, -0.075], [0, -0.075],
];

/** Une roquette : sa pointe jaune qui sort de l'alvéole. */
const ROCKETS: RoundsModel = (kit, name) => ({
  mesh: kit.fuse([
    tubeZ(kit, "#c9ced2", 0, 0, -0.03, 0.04, 0.07, 8),
    coneZ(kit, HAZARD, 0, 0, 0.01, 0.06, 0.07, 8),
  ], name, { specular: 0.3 }),
  slots: ROCKET_CELLS.map(([x, y]): V3 => [x, y, 0.445]),
});

/** Missiles à verrouillage : trois tubes en rang sous un autodirecteur (parabole et lentille jaune). */
const lockonHead: HeadModel = (kit, name) => {
  const body = "#5a5238";
  const accent = "#ffcf5a";
  const parts: B.Mesh[] = [
    trunnions(kit, 0.58),
    kit.box(body, [0.5, 0.26, 0.46], [0, -0.03, 0.17]),
    kit.box(DARK, [0.52, 0.03, 0.48], [0, -0.03, 0.17]),
    // Autodirecteur : un boîtier, une parabole et sa lentille, une antenne
    kit.box(GUNMETAL, [0.2, 0.12, 0.2], [0, 0.16, 0.06]),
    kit.cylinder(STEEL, 0.03, 0.2, 0.15, [0, 0.16, 0.18], "z", 14),
    discZ(kit, SOOT, 0.14, [0, 0.16, 0.197], 0.01),
    kit.sphere(accent, 0.06, [0, 0.16, 0.2], [1, 1, 0.6], 8),
    kit.cylinder(STEEL, 0.18, 0.015, 0.008, [0.08, 0.3, 0.0], "y", 6),
    kit.sphere(RED, 0.03, [0.08, 0.39, 0.0], [1, 1, 1], 6),
    // Bande jaune de repérage
    kit.box(accent, [0.505, 0.03, 0.03], [0, 0.07, 0.38]),
  ];
  for (const x of [-0.15, 0, 0.15]) {
    parts.push(
      tubeZ(kit, LIGHT, x, -0.04, 0.38, 0.12, 0.13, 12),
      discZ(kit, SOOT, 0.11, [x, -0.04, 0.503], 0.006),
    );
  }
  return kit.fuse(parts, name, { specular: 0.35 });
};

/** Un missile à verrou : sa coiffe blanche à pointe jaune, qui dépasse du tube. */
const LOCKONS: RoundsModel = (kit, name) => ({
  mesh: kit.fuse([
    tubeZ(kit, "#eef1f3", 0, 0, -0.05, 0.06, 0.1, 10),
    coneZ(kit, "#eef1f3", 0, 0, 0.01, 0.08, 0.1, 10),
    coneZ(kit, "#ffcf5a", 0, 0, 0.07, 0.03, 0.03, 8),
  ], name, { specular: 0.35 }),
  slots: [[0.15, -0.04, 0.47], [-0.15, -0.04, 0.47], [0, -0.04, 0.47]],
});

/** Lance-ogive : un gros tube cerclé, la culasse massive (l'ogive rouge à ailettes, à part, dépasse de la bouche). */
const warheadHead: HeadModel = (kit, name) => {
  const body = "#4a3a36";
  const parts: B.Mesh[] = [
    trunnions(kit, 0.62, 0.12),
    // Culasse et berceau
    kit.box(body, [0.46, 0.42, 0.3], [0, 0, -0.05]),
    kit.box(DARK, [0.5, 0.06, 0.32], [0, -0.14, -0.05]),
    ...[-1, 1].map((s) => kit.box(GUNMETAL, [0.04, 0.28, 0.26], [s * 0.25, 0.02, -0.05])),
    // Le tube, cerclé et zébré
    tubeZ(kit, "#5a4a44", 0, 0.02, 0.05, 0.62, 0.36, 16),
    bandZ(kit, DARK, 0, 0.02, 0.12, 0.38, 0.04, 16),
    bandZ(kit, HAZARD, 0, 0.02, 0.4, 0.375, 0.03, 16),
    bandZ(kit, DARK, 0, 0.02, 0.44, 0.375, 0.03, 16),
    bandZ(kit, DARK, 0, 0.02, 0.64, 0.4, 0.05, 16),
    // La bouche, sombre : l'ogive (à part, voir `WARHEAD`) en dépasse ; partie, il reste un trou noir
    discZ(kit, SOOT, 0.3, [0, 0.02, 0.673], 0.006, 16),
    // Viseur sur le flanc gauche
    kit.box(GUNMETAL, [0.08, 0.1, 0.16], [0.24, 0.16, 0.12]),
    discZ(kit, "#8fd0ff", 0.05, [0.24, 0.17, 0.205], 0.01, 8),
  ];
  return kit.fuse(parts, name, { specular: 0.35 });
};

/** L'ogive dans son tube : sa coiffe rouge qui dépasse de la bouche, ses ailettes dans le tube. */
const WARHEAD: RoundsModel = (kit, name) => ({
  mesh: kit.fuse([
    coneZ(kit, "#ff6b5a", 0, 0, 0, 0.17, 0.26, 14),
    coneZ(kit, LIGHT, 0, 0, 0.13, 0.04, 0.07, 8),
    ...[0, 1, 2, 3].map((i) => kit.box(STEEL, [0.012, 0.11, 0.08], [0, 0, 0.04], [0, 0, (i * Math.PI) / 4 + Math.PI / 8])),
  ], name, { specular: 0.35 }),
  slots: [[0, 0.02, 0.63]],
});

/** Bombe fuselée à empennage en croix, bande jaune, le long de z, centrée en (x, y, z). */
function bomb(kit: ModelKit, x: number, y: number, z: number): B.Mesh[] {
  const olive = "#5b6650";
  return [
    kit.sphere(olive, 0.15, [x, y, z], [1, 1, 2.6], 10),
    coneZ(kit, olive, x, y, z - 0.3, 0.12, 0.02, 8),
    kit.cylinder(HAZARD, 0.025, 0.152, 0.152, [x, y, z + 0.1], "z", 10),
    ...[0, 1].map((i) => kit.box(DARK, i ? [0.012, 0.16, 0.08] : [0.16, 0.012, 0.08], [x, y, z - 0.2])),
    // Crochet de suspension
    kit.box(STEEL, [0.03, 0.06, 0.03], [x, y + 0.09, z]),
  ];
}

/** Soute à bombes : la poutre-râtelier sous le bloc, deux bombes pendues. */
const bombBayHead: HeadModel = (kit, name) => kit.fuse([
  kit.box("#2c322d", [0.38, 0.05, 0.44], [0, 0.02, 0]),
  kit.box(DARK, [0.06, 0.04, 0.44], [0, 0.0, 0]),
  // Pylônes qui accrochent le râtelier sous la soute
  ...[-0.15, 0.15].map((z) => kit.box(DARK, [0.1, 0.1, 0.05], [0, 0.07, z])),
], name, { specular: 0.3 });

/** Les deux bombes pendues sous le râtelier (la soute en largue huit : on en voit deux tant qu'il en reste). */
const BOMBS: RoundsModel = (kit, name) => ({
  mesh: kit.fuse(bomb(kit, 0, 0, 0), name, { specular: 0.3 }),
  slots: [[0.1, -0.1, 0], [-0.1, -0.1, 0]],
});

/** Tambour d'un poseur de mines : un barillet à vertical, cerclé, et son `detail` propre au-dessus. */
function mineDrum(kit: ModelKit, name: string, body: string, accent: string, detail: B.Mesh[]): B.Mesh {
  return kit.fuse([
    kit.cylinder(DARK, 0.04, 0.38, 0.38, [0, -0.01, 0], "y", 16),
    kit.cylinder(body, 0.12, 0.34, 0.34, [0, 0.07, 0], "y", 16),
    kit.cylinder(accent, 0.022, 0.35, 0.35, [0, 0.07, 0], "y", 16),
    // Alvéoles du barillet (les mines rangées), tout autour
    ...Array.from({ length: 6 }, (_, i) => {
      const a = (i * Math.PI) / 3;
      return kit.cylinder(SOOT, 0.1, 0.07, 0.07, [Math.cos(a) * 0.15, 0.07, Math.sin(a) * 0.15], "y", 8);
    }),
    kit.cylinder(GUNMETAL, 0.03, 0.2, 0.22, [0, 0.145, 0], "y", 12),
    ...detail,
  ], name, { specular: 0.3 });
}

type MineLayerType =
  | "mineLayer" | "empMineLayer" | "fireMineLayer" | "smokeMineLayer" | "bounceMineLayer"
  | "aaMineLayer" | "remoteMineLayer" | "sensorMineLayer" | "stickyMineLayer";

/**
 * Chaque poseur : la couleur de sa mine (celle de `TURRET_LOOKS`), une couleur de repère, et le
 * détail qui le distingue sur son tambour (centré : la tête tourne d'un demi-tour en jeu).
 */
const MINE_LAYERS: Record<MineLayerType, { body: string; accent: string; detail: (kit: ModelKit) => B.Mesh[] }> = {
  // Mine classique : un bouton de mise à feu rouge, bande jaune et noire
  mineLayer: { body: "#6b5a3a", accent: HAZARD, detail: (kit) => [kit.cylinder(RED, 0.04, 0.07, 0.08, [0, 0.18, 0], "y", 10)] },
  // IEM : une bobine de cuivre et son électrode bleue
  empMineLayer: {
    body: "#2f4a5c", accent: "#7fd8ff",
    detail: (kit) => [
      ...[0.17, 0.2, 0.23].map((y) => kit.cylinder("#b0673a", 0.018, 0.12, 0.12, [0, y, 0], "y", 12)),
      kit.cylinder("#7fd8ff", 0.08, 0.02, 0.02, [0, 0.28, 0], "y", 6),
      kit.sphere("#7fd8ff", 0.05, [0, 0.33, 0], [1, 1, 1], 8),
    ],
  },
  // Incendiaire : un réservoir rouge et son évent
  fireMineLayer: {
    body: "#6b3a2a", accent: "#ff8a2a",
    detail: (kit) => [
      kit.sphere("#c0392b", 0.14, [0, 0.21, 0], [1, 0.8, 1], 10),
      kit.cylinder(DARK, 0.05, 0.03, 0.03, [0, 0.29, 0], "y", 8),
      kit.cylinder("#ff8a2a", 0.015, 0.05, 0.05, [0, 0.315, 0], "y", 8),
    ],
  },
  // Fumigène : une cartouche grise percée d'évents
  smokeMineLayer: {
    body: "#5a6168", accent: "#e0e4e8",
    detail: (kit) => [
      kit.cylinder("#8a9096", 0.1, 0.12, 0.12, [0, 0.21, 0], "y", 12),
      ...[0.19, 0.225].map((y) => kit.cylinder(SOOT, 0.012, 0.125, 0.125, [0, y, 0], "y", 12)),
      kit.cylinder("#e0e4e8", 0.02, 0.08, 0.08, [0, 0.27, 0], "y", 10),
    ],
  },
  // Bondissante : un ressort (des spires empilées) sous un chapeau
  bounceMineLayer: {
    body: "#6b603a", accent: HAZARD,
    detail: (kit) => [
      ...[0.17, 0.195, 0.22, 0.245].map((y) => kit.cylinder(STEEL, 0.012, 0.1, 0.1, [0, y, 0], "y", 10)),
      kit.cylinder(HAZARD, 0.03, 0.14, 0.12, [0, 0.275, 0], "y", 12),
    ],
  },
  // Anti-aérienne : un petit tube lance-missile dressé vers le ciel
  aaMineLayer: {
    body: "#5a4a6e", accent: "#c792ea",
    detail: (kit) => [
      kit.cylinder("#e0e4e8", 0.16, 0.07, 0.07, [0, 0.24, 0], "y", 10),
      kit.cylinder(RED, 0.05, 0.06, 0, [0, 0.345, 0], "y", 8),
      kit.cylinder("#c792ea", 0.015, 0.08, 0.08, [0, 0.2, 0], "y", 10),
    ],
  },
  // Télécommandée : une antenne et son voyant
  remoteMineLayer: {
    body: "#5c5230", accent: "#ffcf5a",
    detail: (kit) => [
      kit.cylinder(DARK, 0.04, 0.08, 0.08, [0, 0.18, 0], "y", 10),
      kit.cylinder(STEEL, 0.22, 0.014, 0.008, [0, 0.3, 0], "y", 6),
      kit.sphere(RED, 0.035, [0, 0.415, 0], [1, 1, 1], 6),
    ],
  },
  // Capteur : un dôme vert
  sensorMineLayer: {
    body: "#2f5a40", accent: "#57d38c",
    detail: (kit) => [
      kit.sphere("#57d38c", 0.14, [0, 0.17, 0], [1, 0.7, 1], 10),
      kit.cylinder(SOOT, 0.012, 0.15, 0.15, [0, 0.16, 0], "y", 12),
    ],
  },
  // Ventouse : une coupelle rose
  stickyMineLayer: {
    body: "#5c2f3a", accent: "#ff6b8a",
    detail: (kit) => [
      kit.cylinder(DARK, 0.04, 0.05, 0.05, [0, 0.18, 0], "y", 8),
      kit.cylinder("#ff6b8a", 0.05, 0.08, 0.17, [0, 0.225, 0], "y", 14),
    ],
  },
};

/** Rayon réparateur : un corps arrondi, un émetteur cerclé de bobines vertes, la lentille au bout. */
const repairHead: HeadModel = (kit, name) => {
  const body = "#2f4a3a";
  const green = "#7fffb0";
  return kit.fuse([
    trunnions(kit, 0.4),
    kit.box(body, [0.32, 0.24, 0.3], [0, 0, -0.02]),
    kit.sphere(body, 0.3, [0, 0, -0.13], [1.05, 0.8, 0.7], 10),
    // Croix verte sur les flancs
    ...[-1, 1].flatMap((s) => [
      kit.box(green, [0.012, 0.12, 0.04], [s * 0.162, 0, -0.02]),
      kit.box(green, [0.012, 0.04, 0.12], [s * 0.162, 0, -0.02]),
    ]),
    // Émetteur et ses bobines
    tubeZ(kit, GUNMETAL, 0, 0, 0.12, 0.34, 0.1, 12),
    ...[0.2, 0.27, 0.34].map((z) => bandZ(kit, "#b0673a", 0, 0, z, 0.14, 0.03, 12)),
    kit.cylinder(DARK, 0.05, 0.12, 0.17, [0, 0, 0.455], "z", 14),
    discZ(kit, green, 0.14, [0, 0, 0.485], 0.012, 14),
    kit.sphere(green, 0.08, [0, 0, 0.49], [1, 1, 0.5], 8),
  ], name, { specular: 0.4, emissive: "#0a1f12" });
};

/** Lance-nanites : une ruche hexagonale, trois tubes courts aux embouts verts, des alvéoles dessus. */
const naniteHead: HeadModel = (kit, name) => {
  const body = "#d8d2b8";
  const green = "#b8ffcf";
  const parts: B.Mesh[] = [
    trunnions(kit, 0.4),
    // La ruche : un prisme hexagonal couché, le long de z
    kit.cylinder(body, 0.3, 0.36, 0.36, [0, 0, 0.02], "z", 6),
    kit.cylinder("#bdb79d", 0.04, 0.38, 0.38, [0, 0, -0.14], "z", 6),
    kit.cylinder("#bdb79d", 0.03, 0.37, 0.37, [0, 0, 0.17], "z", 6),
    // Alvéoles sur le dessus
    ...[-0.08, 0, 0.08].map((x, i) => kit.cylinder("#57d38c", 0.02, 0.06, 0.06, [x, 0.155, i === 1 ? 0.07 : 0.0], "y", 6)),
  ];
  for (const [x, y] of [[-0.08, 0.05], [0.08, 0.05], [0, -0.08]] as const) {
    parts.push(
      tubeZ(kit, GUNMETAL, x, y, 0.17, 0.18, 0.1, 10),
      discZ(kit, green, 0.08, [x, y, 0.352], 0.01, 10),
      kit.sphere(green, 0.05, [x, y, 0.352], [1, 1, 0.6], 6),
    );
  }
  return kit.fuse(parts, name, { specular: 0.3, emissive: "#0a1a10" });
};

/** Projecteur de bouclier : un émetteur large et plat, sa lentille bleue, deux ailerons de champ. */
const barrierHead: HeadModel = (kit, name) => {
  const body = "#2f3f52";
  const blue = "#8fd0ff";
  return kit.fuse([
    trunnions(kit, 0.52, 0.1),
    kit.box(body, [0.46, 0.2, 0.3], [0, 0, -0.03]),
    kit.box(DARK, [0.48, 0.04, 0.32], [0, -0.06, -0.03]),
    // L'émetteur : un disque large et sa lentille, cerclé
    kit.cylinder(GUNMETAL, 0.1, 0.34, 0.3, [0, 0.01, 0.17], "z", 16),
    bandZ(kit, blue, 0, 0.01, 0.22, 0.345, 0.018, 16),
    kit.cylinder(DARK, 0.06, 0.3, 0.34, [0, 0.01, 0.25], "z", 16),
    discZ(kit, blue, 0.28, [0, 0.01, 0.285], 0.012, 16),
    kit.sphere("#d6efff", 0.1, [0, 0.01, 0.29], [1, 1, 0.35], 8),
    // Ailerons de champ, de part et d'autre, et leurs pointes lumineuses
    ...[-1, 1].flatMap((s) => [
      kit.box(body, [0.03, 0.3, 0.18], [s * 0.26, 0.03, 0.12]),
      kit.box(blue, [0.035, 0.03, 0.14], [s * 0.26, 0.19, 0.12]),
      kit.box(blue, [0.035, 0.03, 0.14], [s * 0.26, -0.13, 0.12]),
    ]),
  ], name, { specular: 0.45, emissive: "#081420" });
};

// --- Registre ---

const bases: Partial<Record<BlockType, BlockModel>> = { bombBay: bombBayBase };
for (const [type, [body, accent]] of Object.entries(GUIDED_BASE_COLORS) as [TurretBlockType, [string, string]][]) {
  const column = BASE_COLUMN[type] ?? 0;
  bases[type] = (kit, _color, name) =>
    turretBase(kit, name, body, accent, column ? [kit.cylinder(GUNMETAL, column, 0.14, 0.16, [0, 0.225 + column / 2, 0], "y", 12)] : []);
}
const heads: Partial<Record<TurretBlockType, HeadModel>> = {
  missileLauncher: missileHead,
  flakLauncher: flakHead,
  rocketPod: rocketHead,
  lockonLauncher: lockonHead,
  warheadLauncher: warheadHead,
  bombBay: bombBayHead,
  repairTurret: repairHead,
  naniteLauncher: naniteHead,
  barrierProjector: barrierHead,
};
for (const [type, look] of Object.entries(MINE_LAYERS) as [MineLayerType, (typeof MINE_LAYERS)[MineLayerType]][]) {
  bases[type] = (kit, _color, name) => mineLayerBase(kit, name, look.body, look.accent);
  heads[type] = (kit, name) => mineDrum(kit, name, look.body, look.accent, look.detail(kit));
}

/** Armes guidées, mines, largage et soutien : modèles 3D de leurs socles (le bloc) et de leurs têtes. */
export const GUIDED_BASES: Partial<Record<BlockType, BlockModel>> = bases;
export const GUIDED_HEADS: Partial<Record<TurretBlockType, HeadModel>> = heads;
/** Munitions visibles : elles partent quand on tire, reviennent au rechargement (render/rounds.ts). */
export const GUIDED_ROUNDS: Partial<Record<TurretBlockType, RoundsModel>> = {
  missileLauncher: MISSILES,
  flakLauncher: FLAK,
  rocketPod: ROCKETS,
  lockonLauncher: LOCKONS,
  warheadLauncher: WARHEAD,
  bombBay: BOMBS,
};
