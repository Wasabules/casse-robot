import type * as B from "../../babylon";
import type { BlockType } from "../../../shared/catalog/blocks";
import { meleeDef, type MeleeId } from "../../../shared/catalog/melee";
import { FLAIL_MAST, HAMMER_ARM, JAW_THICK, PLATE_THICK } from "../../../shared/design/clearance";
import type { BlockModel, ModelKit } from "../modelKit";
import { ENERGY_BASES, ENERGY_MODELS } from "./meleeEnergy";

/*
 * Armes de contact (catalog/melee.ts) : le socle (le bloc : moteur et moyeu, ou vérin et pivot), dans
 * le repère du bloc (±0,25 m, haut +y, avant +z), et la partie qui bouge (`MELEE_MODELS`) : la barre
 * d'une toupie, le bras et la tête d'un marteau, le disque d'une toupie verticale, un tambour,
 * l'anneau d'un anneau-coque (l'hélice tranchante n'en a pas : ses pales sont celles du moteur,
 * dessinées par LocomotionView). Celle-ci est dessinée dans le repère du bloc, son
 * origine au moyeu (`MeleeSpec.hub`), à l'angle 0 : elle pointe le long de `e1` (l'avant du bloc,
 * voir `meleeAxes`) ; le rendu la fait tourner autour de l'axe de l'arme (render/meleeView.ts). Ses
 * cotes sont celles du catalogue (la lame balaie `blade.outer`, la tête est à `swing.reach`) : ce que
 * réserve l'encombrement (shared/design/clearance.ts) et ce que touche la simulation.
 */

const STEEL = "#9aa2a8";
const DARK = "#2b3034";
const GUNMETAL = "#3b4147";
const HAZARD = "#f0bd2c";
const RED = "#b8352c";
const EDGE = "#d8dde0";

/** Quatre boulons aux coins d'une platine horizontale, à la hauteur `y`. */
const bolts = (kit: ModelKit, y: number, spread = 0.17): B.Mesh[] =>
  [-1, 1].flatMap((sx) => [-1, 1].map((sz) => kit.cylinder(STEEL, 0.03, 0.045, 0.045, [sx * spread, y, sz * spread], "y", 8)));

/** Toupie horizontale, le socle : le moteur sur sa platine, le palier, et l'arbre qui monte jusqu'au moyeu de la barre. */
const spinnerBase: BlockModel = (kit, _color, name) => {
  const hub = meleeDef("spinner").hub[1];
  return kit.fuse([
    kit.box(DARK, [0.48, 0.08, 0.48], [0, -0.21, 0]),
    ...bolts(kit, -0.16),
    kit.cylinder(GUNMETAL, 0.28, 0.4, 0.38, [0, -0.04, 0], "y", 20),
    kit.ring(RED, 0.4, 0.04, [0, 0.04, 0], "y", 24),
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => kit.box(DARK, [0.03, 0.2, 0.06], [0.19 * Math.cos((i * Math.PI) / 4), -0.04, 0.19 * Math.sin((i * Math.PI) / 4)], [0, -(i * Math.PI) / 4, 0])),
    kit.cylinder(STEEL, 0.1, 0.3, 0.26, [0, 0.15, 0], "y", 18),
    kit.cylinder(STEEL, hub - 0.15, 0.12, 0.12, [0, (hub + 0.2) / 2, 0], "y", 12),
  ], name, { specular: 0.45 });
};

/** Marteau pneumatique, le socle : une platine, le réservoir d'air, et les deux flasques qui portent l'axe du bras. */
const hammerBase: BlockModel = (kit, _color, name) => {
  const [, y, z] = meleeDef("hammer").hub;
  return kit.fuse([
    kit.box(DARK, [0.48, 0.08, 0.48], [0, -0.21, 0]),
    ...bolts(kit, -0.16),
    kit.cylinder(HAZARD, 0.42, 0.2, 0.2, [0, -0.06, -0.1], "x", 16),
    kit.ring(DARK, 0.2, 0.03, [0.16, -0.06, -0.1], "x", 16),
    kit.ring(DARK, 0.2, 0.03, [-0.16, -0.06, -0.1], "x", 16),
    ...[-1, 1].map((s) => kit.box(GUNMETAL, [0.06, 0.4, 0.22], [s * 0.15, y - 0.12, z], [0, 0, 0])),
    kit.cylinder(STEEL, 0.4, 0.08, 0.08, [0, y, z], "x", 12),
    // Le vérin : un cylindre qui part en biais vers l'arrière du bras
    kit.cylinder(STEEL, 0.32, 0.09, 0.09, [0, -0.02, z + 0.02], "z", 10),
  ], name, { specular: 0.4 });
};

/** Partie mobile d'une arme de contact (son repère : voir en tête). */
export type MeleeModel = (kit: ModelKit, name: string) => B.Mesh;

/**
 * La barre de la toupie : de bout en bout de la lame (`blade.outer`), plus épaisse au moyeu, deux
 * dents d'acier clair aux bouts (ce qui frappe), des bandes jaunes pour qu'on la voie tourner.
 */
const spinnerBar: MeleeModel = (kit, name) => {
  const blade = meleeDef("spinner").blade!;
  const r = blade.outer;
  const thick = blade.half * 1.5;
  return kit.fuse([
    kit.box(GUNMETAL, [0.18, thick, 2 * r - 0.3], [0, 0, 0]),
    kit.cylinder(STEEL, thick + 0.06, 0.34, 0.34, [0, 0, 0], "y", 20),
    kit.cylinder(DARK, thick + 0.08, 0.12, 0.12, [0, 0, 0], "y", 12),
    ...[-1, 1].flatMap((s) => [
      kit.box(EDGE, [0.2, thick + 0.02, 0.16], [0, 0, s * (r - 0.08)]),
      kit.box(DARK, [0.06, thick + 0.03, 0.16], [s * 0.08, 0, s * (r - 0.08)]),
      kit.box(HAZARD, [0.185, thick + 0.004, 0.08], [0, 0, s * (r - 0.32)]),
      kit.box(HAZARD, [0.185, thick + 0.004, 0.08], [0, 0, s * (r - 0.48)]),
    ]),
  ], name, { specular: 0.55 });
};

/**
 * Le bras du marteau : de l'axe (à l'origine) à la tête, à `swing.reach` le long de +z ; la tête, une
 * masse d'acier dont la face qui frappe (vers -y à l'angle 0) porte une pointe.
 */
const hammerArm: MeleeModel = (kit, name) => {
  const swing = meleeDef("hammer").swing!;
  const reach = swing.reach;
  const r = swing.radius;
  return kit.fuse([
    kit.cylinder(STEEL, 0.22, 0.14, 0.14, [0, 0, 0], "x", 14),
    kit.box(GUNMETAL, [HAMMER_ARM, HAMMER_ARM, reach - 0.1], [0, 0, (reach - 0.1) / 2]),
    kit.box(HAZARD, [HAMMER_ARM + 0.004, HAMMER_ARM + 0.004, 0.12], [0, 0, reach * 0.45]),
    // La tête : une masse, plus large que haute, et la pointe vers le bas
    kit.box(DARK, [r * 1.8, r * 1.1, r * 1.5], [0, 0, reach]),
    kit.box(RED, [r * 1.85, r * 0.3, r * 1.55], [0, r * 0.45, reach]),
    // (le « haut » d'un cylindre est du côté +y : la pointe, en bas, est sa base)
    kit.cylinder(EDGE, r * 0.8, 0.02, r * 1.2, [0, -r * 0.95, reach], "y", 4),
  ], name, { specular: 0.45 });
};

/** Deux flasques de part et d'autre d'un rotor d'axe x, du bloc à son moyeu (`hz` devant, à `hy`), écartées de `gap` de son axe. */
const forks = (kit: ModelKit, gap: number, hy: number, hz: number, height: number): B.Mesh[] =>
  [-1, 1].flatMap((s) => [
    kit.box(GUNMETAL, [0.045, height, hz + 0.08], [s * (gap + 0.025), hy, (hz + 0.08) / 2 - 0.08]),
    // Le palier, au bout de la flasque
    kit.cylinder(STEEL, 0.07, 0.15, 0.15, [s * (gap + 0.04), hy, hz], "x", 14),
  ]);

/**
 * Toupie verticale, le socle : le moteur couché sur sa platine, deux flasques qui portent l'essieu
 * du disque devant le bloc, et la courroie (un carter) du moteur à l'essieu.
 */
const verticalBase: BlockModel = (kit, _color, name) => {
  const spec = meleeDef("verticalSpinner");
  const [, hy, hz] = spec.hub;
  const gap = spec.blade!.half + 0.02;
  return kit.fuse([
    kit.box(DARK, [0.48, 0.08, 0.48], [0, -0.21, 0]),
    ...bolts(kit, -0.16),
    kit.cylinder(GUNMETAL, 0.36, 0.3, 0.3, [0, -0.02, -0.06], "x", 18),
    kit.ring(RED, 0.3, 0.035, [0.17, -0.02, -0.06], "x", 20),
    kit.ring(RED, 0.3, 0.035, [-0.17, -0.02, -0.06], "x", 20),
    ...forks(kit, gap, hy, hz, 0.2),
    // Le carter de la courroie, le long de la flasque de gauche
    kit.box(HAZARD, [0.05, 0.12, hz + 0.1], [gap + 0.08, hy - 0.02, (hz + 0.1) / 2 - 0.1]),
  ], name, { specular: 0.45 });
};

/** Tambour, le socle : le moteur, et deux bras qui tiennent l'essieu du tambour devant le bloc, à ses deux bouts. */
const drumBase: BlockModel = (kit, _color, name) => {
  const spec = meleeDef("drum");
  const [, hy, hz] = spec.hub;
  const gap = spec.blade!.half + 0.01;
  return kit.fuse([
    kit.box(DARK, [0.48, 0.08, 0.48], [0, -0.21, 0]),
    ...bolts(kit, -0.16),
    kit.cylinder(GUNMETAL, 0.42, 0.32, 0.32, [0, -0.01, -0.04], "x", 18),
    kit.ring(HAZARD, 0.32, 0.04, [0, -0.01, -0.04], "x", 20),
    // Une traverse qui va d'un bras à l'autre, sous le dos du tambour
    kit.box(GUNMETAL, [2 * gap + 0.08, 0.08, 0.1], [0, hy - 0.12, 0.2]),
    ...forks(kit, gap, hy, hz, 0.16),
  ], name, { specular: 0.45 });
};

/**
 * Anneau-coque, le socle : le moyeu sur le dessus du robot, un palier épais où viennent se fixer les
 * rayons de l'anneau (la partie mobile).
 */
const shellBase: BlockModel = (kit, _color, name) => kit.fuse([
  kit.box(DARK, [0.48, 0.08, 0.48], [0, -0.21, 0]),
  ...bolts(kit, -0.16),
  kit.cylinder(GUNMETAL, 0.34, 0.44, 0.4, [0, 0, 0], "y", 22),
  kit.ring(RED, 0.42, 0.04, [0, 0.12, 0], "y", 24),
  kit.cylinder(STEEL, 0.1, 0.3, 0.26, [0, 0.21, 0], "y", 18),
], name, { specular: 0.5 });

/**
 * Le disque de la toupie verticale (dans le plan perpendiculaire à x) : épais, en acier, son moyeu,
 * deux dents qui arrivent au bord de ce qu'il balaie (`blade.outer`), et des bandes jaunes pour qu'on
 * le voie tourner. À l'angle 0, une dent pointe vers l'avant (+z).
 */
const verticalDisc: MeleeModel = (kit, name) => {
  const blade = meleeDef("verticalSpinner").blade!;
  const r = blade.outer;
  const thick = blade.half * 2;
  return kit.fuse([
    kit.cylinder(STEEL, thick, 2 * (r - 0.05), 2 * (r - 0.05), [0, 0, 0], "x", 30),
    kit.cylinder(DARK, thick + 0.03, 0.16, 0.16, [0, 0, 0], "x", 14),
    kit.ring(GUNMETAL, 2 * (r - 0.07), 0.035, [0, 0, 0], "x", 30),
    ...[-1, 1].flatMap((s) => [
      // La dent, crochue, au bout du rayon
      kit.box(EDGE, [thick + 0.02, 0.1, 0.14], [0, 0, s * (r - 0.07)]),
      kit.box(DARK, [thick + 0.025, 0.03, 0.1], [0, s * 0.05, s * (r - 0.06)]),
      // Bandes jaunes sur les faces, en travers du disque
      kit.box(HAZARD, [thick + 0.006, 0.08, 0.22], [0, 0, s * (r - 0.3)]),
    ]),
  ], name, { specular: 0.55 });
};

/**
 * Le tambour (un cylindre le long de x) : trois rangées de dents décalées tout autour, des flasques
 * aux deux bouts. Une rangée regarde vers l'avant (+z) à l'angle 0.
 */
const drumRoller: MeleeModel = (kit, name) => {
  const blade = meleeDef("drum").blade!;
  const r = blade.outer;
  const length = blade.half * 2;
  const teeth: B.Mesh[] = [];
  for (let row = 0; row < 3; row++) {
    const a = (row * 2 * Math.PI) / 3;
    // Rayon vers l'extérieur à cet angle : cos a·(+z) + sin a·(-y) ; une dent le long de son « haut » (y) tourné vers lui
    const dy = -Math.sin(a);
    const dz = Math.cos(a);
    for (let k = 0; k < 3; k++) {
      const x = (-0.3 + k * 0.3 + (row - 1) * 0.1) * (length / 0.9);
      teeth.push(kit.box(EDGE, [0.12, 0.09, 0.07], [x, dy * (r - 0.06), dz * (r - 0.06)], [a + Math.PI / 2, 0, 0]));
    }
  }
  return kit.fuse([
    kit.cylinder(GUNMETAL, length - 0.04, 2 * (r - 0.07), 2 * (r - 0.07), [0, 0, 0], "x", 20),
    kit.cylinder(HAZARD, 0.08, 2 * (r - 0.065), 2 * (r - 0.065), [0, 0, 0], "x", 20),
    ...[-1, 1].map((s) => kit.cylinder(STEEL, 0.04, 2 * (r - 0.03), 2 * (r - 0.03), [s * (length / 2 - 0.02), 0, 0], "x", 20)),
    ...teeth,
  ], name, { specular: 0.5 });
};

/**
 * L'anneau-coque : la bande d'acier (vingt-quatre pans) qui entoure le robot, de `blade.inner` à
 * `blade.outer`, sur toute sa hauteur (±`blade.half` autour du moyeu), quatre percuteurs sur sa face
 * extérieure, et les quatre rayons qui la relient au moyeu, sur le dessus (`blade.web`).
 */
const shellRing: MeleeModel = (kit, name) => {
  const blade = meleeDef("shellSpinner").blade!;
  const n = 24;
  const r = (blade.inner + blade.outer) / 2 - 0.01;
  const wall = blade.outer - blade.inner - 0.04;
  const chord = 2 * (r + wall / 2) * Math.sin(Math.PI / n) + 0.01;
  const parts: B.Mesh[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i * 2 * Math.PI) / n;
    const [x, z] = [Math.sin(a), Math.cos(a)];
    parts.push(kit.box(i % 6 === 3 ? HAZARD : STEEL, [chord, blade.half * 2, wall], [x * r, 0, z * r], [0, a, 0]));
    // Un rebord sombre en haut et en bas
    for (const s of [-1, 1]) parts.push(kit.box(DARK, [chord, 0.05, wall + 0.02], [x * r, s * (blade.half - 0.02), z * r], [0, a, 0]));
  }
  // Les percuteurs, jusqu'au bord de ce qu'il balaie
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    const at = blade.outer - 0.035;
    parts.push(kit.box(EDGE, [0.16, blade.half * 1.4, 0.07], [Math.sin(a) * at, 0, Math.cos(a) * at], [0, a, 0]));
  }
  // Les rayons, sur le dessus, du moyeu à la bande
  const web = blade.web!;
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    const len = blade.inner;
    parts.push(kit.box(GUNMETAL, [0.1, web.half * 1.6, len], [Math.sin(a) * (len / 2), web.at, Math.cos(a) * (len / 2)], [0, a, 0]));
  }
  parts.push(kit.cylinder(DARK, web.half * 2.2, 0.36, 0.36, [0, web.at, 0], "y", 18));
  parts.push(kit.cylinder(RED, 0.04, 0.2, 0.2, [0, web.at + web.half * 1.1 + 0.01, 0], "y", 14));
  return kit.fuse(parts, name, { specular: 0.55 });
};

/** Flipper, le socle : la platine, le vérin couché qui pousse sous le plateau, et les deux chapes de l'articulation, devant. */
const flipperBase: BlockModel = (kit, _color, name) => {
  const [, y, z] = meleeDef("flipper").hub;
  const half = meleeDef("flipper").plate!.half;
  return kit.fuse([
    kit.box(DARK, [0.48, 0.08, 0.48], [0, -0.21, 0]),
    ...bolts(kit, -0.16),
    // Le vérin pneumatique et son réservoir
    kit.cylinder(GUNMETAL, 0.4, 0.17, 0.17, [0, -0.05, -0.04], "z", 16),
    kit.cylinder(STEEL, 0.22, 0.09, 0.09, [0, -0.05, 0.16], "z", 12),
    kit.ring(HAZARD, 0.18, 0.03, [0, -0.05, -0.2], "z", 16),
    kit.cylinder(RED, 0.3, 0.12, 0.12, [0.15, 0.02, -0.08], "z", 12),
    // Les chapes de l'articulation, aux deux bouts de l'axe du plateau
    ...[-1, 1].map((s) => kit.box(GUNMETAL, [0.06, 0.18, 0.14], [s * Math.min(0.22, half), y + 0.02, z - 0.05])),
    kit.cylinder(STEEL, 0.48, 0.07, 0.07, [0, y, z], "x", 10),
  ], name, { specular: 0.4 });
};

/** Fléau, le socle : le moteur sur sa platine, et le mât qui monte jusqu'au moyeu de la manivelle. */
const flailBase: BlockModel = (kit, _color, name) => {
  const hub = meleeDef("flail").hub[1];
  return kit.fuse([
    kit.box(DARK, [0.48, 0.08, 0.48], [0, -0.21, 0]),
    ...bolts(kit, -0.16),
    kit.cylinder(GUNMETAL, 0.3, 0.36, 0.3, [0, -0.02, 0], "y", 18),
    kit.ring(HAZARD, 0.34, 0.03, [0, 0.06, 0], "y", 20),
    kit.cylinder(STEEL, hub - 0.08, 2 * FLAIL_MAST, 2 * FLAIL_MAST, [0, (hub + 0.08) / 2, 0], "y", 12),
    kit.cylinder(DARK, 0.1, 0.2, 0.2, [0, hub - 0.08, 0], "y", 14),
  ], name, { specular: 0.45 });
};

/** Mâchoire, le socle : le vérin hydraulique, et les flasques de l'axe des mâchoires, devant. */
const jawBase: BlockModel = (kit, _color, name) => {
  const [, y, z] = meleeDef("jaw").hub;
  return kit.fuse([
    kit.box(DARK, [0.48, 0.08, 0.48], [0, -0.21, 0]),
    ...bolts(kit, -0.16),
    kit.box(GUNMETAL, [0.4, 0.3, 0.32], [0, -0.02, -0.06]),
    kit.cylinder(STEEL, 0.36, 0.1, 0.1, [0, 0.15, -0.04], "z", 12),
    kit.ring(HAZARD, 0.12, 0.025, [0, 0.15, -0.18], "z", 12),
    ...[-1, 1].map((s) => kit.box(GUNMETAL, [0.05, 0.36, 0.2], [s * 0.2, y, z - 0.05])),
    kit.cylinder(STEEL, 0.46, 0.08, 0.08, [0, y, z], "x", 10),
  ], name, { specular: 0.4 });
};

/**
 * Le plateau du flipper : une plaque de sa longueur le long de +z depuis l'articulation (à l'origine),
 * de toute sa largeur, le bord avant aminci en coin (il glisse sous l'ennemi), des nervures dessous,
 * des bandes jaunes et noires sur le dessus.
 */
const flipperPlate: MeleeModel = (kit, name) => {
  const plate = meleeDef("flipper").plate!;
  const l = plate.length;
  const w = 2 * plate.half;
  const t = PLATE_THICK;
  return kit.fuse([
    kit.cylinder(STEEL, w * 0.9, t * 1.2, t * 1.2, [0, 0, 0], "x", 12),
    kit.box(GUNMETAL, [w, t, l - 0.12], [0, 0, (l - 0.12) / 2]),
    // Le bord en coin
    kit.box(EDGE, [w, t * 0.45, 0.14], [0, -t * 0.2, l - 0.07]),
    // Nervures dessous
    ...[-0.6, 0, 0.6].map((s) => kit.box(DARK, [0.05, t * 0.8, l * 0.8], [s * plate.half, -t * 0.7, l * 0.42])),
    // Bandes de danger
    ...[0.25, 0.45, 0.65].map((f) => kit.box(HAZARD, [w * 0.98, 0.004, 0.08], [0, t / 2 + 0.002, l * f])),
  ], name, { specular: 0.5 });
};

/** La manivelle du fléau : un bras court le long de +z depuis le moyeu, et l'œil où s'accroche la chaîne. */
const flailCrank: MeleeModel = (kit, name) => {
  const fl = meleeDef("flail").flail!;
  return kit.fuse([
    kit.cylinder(STEEL, 0.1, 0.18, 0.18, [0, 0, 0], "y", 14),
    kit.box(GUNMETAL, [0.08, 0.06, fl.crank + 0.04], [0, 0, fl.crank / 2]),
    kit.ring(EDGE, 0.09, 0.025, [0, 0, fl.crank], "x", 10),
    kit.box(HAZARD, [0.085, 0.064, 0.05], [0, 0, fl.crank * 0.55]),
  ], name, { specular: 0.5 });
};

/**
 * La mâchoire du haut : un bras épais le long de +z depuis son axe (à l'origine), ses dents vers le
 * bas (-y) ; celle du bas est son reflet (`jawLower`).
 */
const jawJaw = (side: 1 | -1): MeleeModel => (kit, name) => {
  const jaw = meleeDef("jaw").jaw!;
  const l = jaw.length;
  const w = 2 * jaw.half;
  const t = JAW_THICK;
  const teeth = 5;
  return kit.fuse([
    kit.cylinder(STEEL, w * 0.95, t * 1.1, t * 1.1, [0, 0, 0], "x", 12),
    kit.box(GUNMETAL, [w, t, l - 0.1], [0, side * t * 0.1, (l - 0.1) / 2]),
    kit.box(RED, [w * 0.6, t * 0.4, l * 0.5], [0, side * t * 0.6, l * 0.35]),
    // Le crochet du bout
    kit.box(DARK, [w, t * 1.6, 0.1], [0, -side * t * 0.3, l - 0.05]),
    // Les dents, pointes vers l'autre mâchoire (le « haut » d'un cylindre est du côté +y)
    ...Array.from({ length: teeth }, (_, i) => {
      const z = l * (0.25 + (0.68 * i) / (teeth - 1));
      const [bottom, top] = side === 1 ? [0.005, 0.05] : [0.05, 0.005];
      return [-1, 1].map((s) => kit.cylinder(EDGE, t * 0.9, bottom, top, [s * w * 0.28, -side * t * 0.9, z], "y", 4));
    }).flat(),
  ], name, { specular: 0.5 });
};

/** La boule du fléau : une sphère d'acier hérissée de pointes. */
const flailBall: MeleeModel = (kit, name) => {
  const r = meleeDef("flail").flail!.radius;
  const spikes: B.Mesh[] = [];
  const dirs: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (const [x, y, z] of dirs) {
    const axis = x !== 0 ? "x" : y !== 0 ? "y" : "z";
    // (la pointe du côté où elle sort : le « haut » d'un cylindre est du côté +axe)
    const [bottom, top] = x + y + z > 0 ? [r * 0.45, 0.01] : [0.01, r * 0.45];
    spikes.push(kit.cylinder(EDGE, r * 0.7, bottom, top, [x * r * 1.1, y * r * 1.1, z * r * 1.1], axis, 6));
  }
  return kit.fuse([kit.sphere(DARK, 2 * r, [0, 0, 0], [1, 1, 1], 14), ...spikes], name, { specular: 0.6 });
};

/** Un maillon de la chaîne : un anneau allongé, couché dans le plan xz, le long de z. */
const chainLink: MeleeModel = (kit, name) => kit.fuse([kit.ring(STEEL, 0.1, 0.022, [0, 0, 0], "y", 10)], name, { specular: 0.6 });

/**
 * Autres pièces mobiles d'une arme de contact, par nom : la mâchoire du bas (reflet de celle du haut),
 * la boule d'un fléau et un maillon de sa chaîne (posés dans le monde, render/meleeView.ts).
 */
export const MELEE_PIECES: Partial<Record<MeleeId, Record<string, MeleeModel>>> = {
  jaw: { lower: jawJaw(-1) },
  flail: { ball: flailBall, link: chainLink },
};

/**
 * Scie circulaire, le socle : le moteur sur sa platine, le bras qui avance jusqu'au moyeu du disque
 * (sous lui), l'arbre, et un carter jaune sur la moitié arrière du bord du disque (au-dessus de lui).
 */
const sawBase: BlockModel = (kit, _color, name) => {
  const [, hy, hz] = meleeDef("saw").hub;
  const blade = meleeDef("saw").blade!;
  const below = hy - blade.half - 0.05;
  const guard = blade.outer + 0.02;
  return kit.fuse([
    kit.box(DARK, [0.48, 0.08, 0.48], [0, -0.21, 0]),
    ...bolts(kit, -0.16),
    kit.cylinder(GUNMETAL, 0.3, 0.34, 0.3, [0, -0.04, -0.04], "y", 20),
    kit.ring(RED, 0.32, 0.03, [0, 0.11, -0.04], "y", 20),
    ...[0, 1, 2, 3, 4, 5].map((i) => kit.box(DARK, [0.03, 0.22, 0.05], [0.16 * Math.cos((i * Math.PI) / 3), -0.04, -0.04 + 0.16 * Math.sin((i * Math.PI) / 3)], [0, -(i * Math.PI) / 3, 0])),
    // Le bras, de l'avant du moteur jusque sous le moyeu, et l'arbre qui monte au disque
    kit.box(GUNMETAL, [0.14, 0.1, hz - 0.05], [0, below, (hz + 0.05) / 2]),
    kit.box(HAZARD, [0.145, 0.104, 0.06], [0, below, hz * 0.55]),
    kit.cylinder(STEEL, 0.14, 0.14, 0.12, [0, below + 0.04, hz], "y", 14),
    // Le carter : un capot en éventail sur la moitié arrière du disque, juste au-dessus de lui, bordé d'une lèvre
    ...[-3, -2, -1, 0, 1, 2, 3].flatMap((k) => {
      const a = Math.PI + (k * Math.PI) / 8;
      const mid = (guard + 0.16) / 2;
      return [
        kit.box(HAZARD, [0.19, 0.02, guard - 0.16], [mid * Math.sin(a), hy + blade.half + 0.03, hz + mid * Math.cos(a)], [0, a, 0]),
        kit.box(DARK, [0.19, 0.06, 0.025], [guard * Math.sin(a), hy + blade.half + 0.01, hz + guard * Math.cos(a)], [0, a, 0]),
      ];
    }),
  ], name, { specular: 0.45 });
};

/** Foreuse, le socle : le carter du volant à l'arrière, le réducteur, et le mandrin d'où sort la mèche, à l'avant du bloc. */
const drillBase: BlockModel = (kit, _color, name) => {
  const bit = meleeDef("drill").blade!;
  const chuck = meleeDef("drill").hub[2] - bit.half;
  return kit.fuse([
    kit.box(DARK, [0.48, 0.08, 0.48], [0, -0.21, 0]),
    ...bolts(kit, -0.16),
    // Le volant, dans son carter rond, et le réducteur devant lui
    kit.cylinder(DARK, 0.14, 0.44, 0.44, [0, 0, -0.17], "z", 24),
    kit.ring(RED, 0.44, 0.03, [0, 0, -0.1], "z", 24),
    kit.box(GUNMETAL, [0.38, 0.36, 0.22], [0, 0, 0.04]),
    kit.box(HAZARD, [0.385, 0.08, 0.225], [0, 0.12, 0.04]),
    ...[-1, 1].map((s) => kit.box(DARK, [0.04, 0.3, 0.2], [s * 0.2, 0, 0.04])),
    // Le mandrin, à l'avant du bloc : la mèche en sort
    kit.cylinder(STEEL, chuck - 0.13, 0.26, 0.22, [0, 0, (chuck + 0.15) / 2], "z", 16),
    kit.cylinder(DARK, 0.05, 0.28, 0.28, [0, 0, chuck - 0.04], "z", 16),
  ], name, { specular: 0.45 });
};

/**
 * Le disque de la scie : une lame d'acier mince de la taille de ce qu'elle balaie (`blade.outer`),
 * des dents claires tout autour (inclinées dans le sens de rotation), un flasque sombre et ses
 * boulons au moyeu, trois fentes et une bande jaune qui montrent qu'il tourne.
 */
const sawDisc: MeleeModel = (kit, name) => {
  const blade = meleeDef("saw").blade!;
  const r = blade.outer;
  const thick = blade.half;
  const teeth = 28;
  return kit.fuse([
    kit.cylinder(STEEL, thick, 2 * r - 0.05, 2 * r - 0.05, [0, 0, 0], "y", 40),
    ...Array.from({ length: teeth }, (_, i) => {
      const a = (i / teeth) * Math.PI * 2;
      return kit.box(EDGE, [0.045, thick * 1.2, 0.05], [Math.sin(a) * (r - 0.03), 0, Math.cos(a) * (r - 0.03)], [0, a + 0.5, 0]);
    }),
    kit.cylinder(DARK, thick + 0.03, 0.18, 0.18, [0, 0, 0], "y", 18),
    ...[0, 1, 2, 3].map((i) => kit.cylinder(STEEL, thick + 0.05, 0.03, 0.03, [0.055 * Math.cos((i * Math.PI) / 2), 0, 0.055 * Math.sin((i * Math.PI) / 2)], "y", 6)),
    ...[0, 1, 2].map((i) => {
      const a = (i * 2 * Math.PI) / 3;
      return kit.box(DARK, [0.025, thick + 0.004, 0.14], [Math.sin(a) * 0.27, 0, Math.cos(a) * 0.27], [0, a, 0]);
    }),
    kit.box(HAZARD, [0.07, thick + 0.006, r * 0.45], [0, 0, r * 0.55]),
  ], name, { specular: 0.7 });
};

/**
 * La mèche de la foreuse : un cône d'acier d'un bout à l'autre de sa longueur (le long de +z,
 * centré sur le moyeu), deux filets hélicoïdaux qui s'affinent vers la pointe, une bague sombre à
 * sa base. Elle tourne lentement : on voit les filets avancer.
 */
const drillBit: MeleeModel = (kit, name) => {
  const bit = meleeDef("drill").blade!;
  const half = bit.half;
  const r = bit.outer;
  const turns = 4.5;
  const steps = 54;
  const flutes: B.Mesh[] = [];
  for (const phase of [0, Math.PI]) {
    for (let k = 0; k < steps; k++) {
      const s = k / steps;
      const z = -half + 0.08 + s * (2 * half - 0.16);
      const radius = r * (1 - 0.8 * s);
      const a = phase + s * turns * 2 * Math.PI;
      // Angle 0 vers le haut du bloc (e1) ; il tourne vers e2 = axe × e1 (-x)
      flutes.push(kit.box(k % 6 === 0 ? HAZARD : EDGE, [0.05 * (1 - 0.6 * s) + 0.015, 0.03, 0.06], [-radius * Math.sin(a), radius * Math.cos(a), z], [0, 0, a]));
    }
  }
  return kit.fuse([
    kit.cylinder(STEEL, 2 * half - 0.04, 2 * r * 0.75, 0.02, [0, 0, 0.02], "z", 16),
    kit.cylinder(DARK, 0.08, 2 * r + 0.03, 2 * r + 0.03, [0, 0, -half + 0.04], "z", 16),
    ...flutes,
  ], name, { specular: 0.6 });
};

/** Socles des armes de contact (réunis dans `BLOCK_MODELS`, render/blockModels.ts) ; ceux des armes d'énergie dans models/meleeEnergy.ts. */
export const MELEE_BASES: Partial<Record<BlockType, BlockModel>> = {
  spinner: spinnerBase, hammer: hammerBase, verticalSpinner: verticalBase, drum: drumBase, shellSpinner: shellBase, saw: sawBase, drill: drillBase,
  flipper: flipperBase, flail: flailBase, jaw: jawBase, ...ENERGY_BASES,
};

/**
 * Partie mobile de chaque arme de contact : TypeScript refuse une arme sans la sienne. null : elle
 * est dessinée ailleurs (les pales de l'hélice tranchante sont celles du moteur, `LocomotionView`).
 */
export const MELEE_MODELS: Record<MeleeId, MeleeModel | null> = {
  spinner: spinnerBar, hammer: hammerArm, verticalSpinner: verticalDisc, drum: drumRoller, shellSpinner: shellRing, propeller: null,
  saw: sawDisc, drill: drillBit, flipper: flipperPlate, flail: flailCrank, jaw: jawJaw(1), ...ENERGY_MODELS,
};
