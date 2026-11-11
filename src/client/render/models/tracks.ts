import type * as B from "../../babylon";
import type { WheelType, WheelTypeDef } from "../../../shared/catalog/wheels";
import type { ModelKit, WheelModel } from "../modelKit";
import { BELT_CLEARANCE } from "../trackShape";

/*
 * Chenilles : le galet de roulement (un type de roue, `track`), et deux pièces qu'on dessine autour
 * de lui (render/locomotionView.ts, garage) : le patin, répété tout le long de la bande et qui
 * défile avec elle (render/belts.ts), et le barbotin denté qui entraîne la bande à l'arrière de
 * chaque tronçon. Repère d'un galet : son moyeu à l'origine, son essieu le long de x.
 *
 * En coupe, du dehors vers le moyeu : le crampon des patins (son bout sur le parcours de la bande,
 * BELT_CLEARANCE au-delà du rayon du galet : il mord un peu dans le sol), la plaque du patin, la
 * bande de dessous (render/belts.ts), les roues jumelles du galet, et entre elles les guides des
 * patins.
 */

const RUBBER = "#1b1d1f";
const STEEL = "#7b848b";
const DISH = "#4d555b";
const HUB = "#353b40";
const BOLT = "#b3bbc1";
const HOLE = "#16181a";
const PLATE = "#2b2e31";
const GROUSER = "#3f4448";
const HINGE = "#222528";
const PIN = "#8a9298";
const CAP = "#f0bd2c";

/** Hauteur du crampon d'un patin, épaisseur de sa plaque, longueur d'un patin le long de la bande (m). */
const GROUSER_HEIGHT = 0.02;
const SHOE_PLATE = 0.025;
const SHOE_LENGTH = 0.1;
/** Profondeur d'un patin, du bout de son crampon à la face intérieure de sa plaque (m). */
export const SHOE_DEPTH = GROUSER_HEIGHT + SHOE_PLATE;
/** Bande de dessous : sa face extérieure, à BAND_INSET m en dedans du parcours, est cachée dans la plaque des patins ; son épaisseur (m). */
export const BAND_INSET = SHOE_DEPTH - 0.004;
export const BAND_THICKNESS = 0.008;
/** Demi-écart entre les deux roues jumelles d'un galet (m) : les guides des patins passent entre elles. */
const TWIN_GAP = 0.045;
/**
 * Loin de la caméra, une chenille se dessine plus simplement. Au-delà de ROLLER_DETAIL_RANGE (m),
 * ses galets n'ont plus que leur bandage, leur flasque et leur moyeu (un niveau de détail du modèle,
 * que Babylon choisit pour chaque instance, cartes d'ombre comprises : un allégement y ferait moins
 * de 3 pixels) ; au-delà de TRACK_DETAIL_RANGE, ses patins et son barbotin laissent la place à une
 * bande épaisse (render/locomotionView.ts : un patin y ferait moins de 4 pixels).
 */
export const ROLLER_DETAIL_RANGE = 20;
export const TRACK_DETAIL_RANGE = 35;

/** Rayon des roues d'un galet : sous la bande, qu'elles portent (m). */
const rollerRadius = (def: WheelTypeDef): number => def.radius + BELT_CLEARANCE - BAND_INSET - BAND_THICKNESS - 0.002;

/**
 * Galet de roulement : deux roues jumelles à bandage de caoutchouc (entre elles passent les guides
 * des patins), leurs flasques embouties percées d'allégements, un moyeu boulonné de chaque côté et
 * l'essieu entre elles. Symétrique : il sert à gauche comme à droite.
 */
const roadWheel: WheelModel = (kit, def, name) => {
  const r = rollerRadius(def);
  const half = def.width / 2;
  const twin = half - TWIN_GAP;
  const parts: B.Mesh[] = [kit.cylinder(STEEL, 2 * TWIN_GAP + 0.01, 0.09, 0.09, [0, 0, 0], "x", 10)];
  for (const s of [-1, 1]) {
    const face = s * half;
    parts.push(
      // Bandage de caoutchouc, et la lèvre d'acier de sa jante, dehors (dedans, entre les roues, on ne la verrait pas)
      kit.cylinder(RUBBER, twin * 0.85, 2 * r, 2 * r, [s * (TWIN_GAP + twin * 0.425), 0, 0], "x", 18),
      kit.cylinder(STEEL, twin * 0.15, 2 * r - 0.03, 2 * r - 0.03, [s * (half - twin * 0.075), 0, 0], "x", 18),
      // Flasque emboutie, ses cinq allégements
      kit.cylinder(DISH, 0.012, 2 * r * 0.72, 2 * r * 0.72, [face + s * 0.004, 0, 0], "x", 16),
      ...[0, 1, 2, 3, 4].map((i) => {
        const a = (i * Math.PI * 2) / 5;
        return kit.cylinder(HOLE, 0.006, 0.05, 0.05, [face + s * 0.011, Math.cos(a) * r * 0.46, Math.sin(a) * r * 0.46], "x", 6);
      }),
      // Moyeu, et ses six écrous
      kit.cylinder(HUB, 0.03, 0.11, 0.09, [face + s * 0.022, 0, 0], "x", 10),
      ...[0, 1, 2, 3, 4, 5].map((i) => {
        const a = (i * Math.PI) / 3;
        return kit.cylinder(BOLT, 0.014, 0.022, 0.022, [face + s * 0.03, Math.cos(a) * 0.04, Math.sin(a) * 0.04], "x", 6);
      }),
    );
  }
  const wheel = kit.fuse(parts, name, { specular: 0.3 });
  // De loin : le bandage d'une roue pleine, la flasque et le moyeu qui en dépassent de chaque côté (~7 fois moins de triangles)
  const far = kit.fuse([
    kit.cylinder(RUBBER, def.width - 0.02, 2 * r, 2 * r, [0, 0, 0], "x", 14),
    kit.cylinder(DISH, def.width + 0.01, 2 * r * 0.72, 2 * r * 0.72, [0, 0, 0], "x", 10),
    kit.cylinder(HUB, def.width + 0.05, 0.1, 0.1, [0, 0, 0], "x", 8),
  ], `${name}-far`, { specular: 0.3 });
  wheel.addLODLevel(ROLLER_DETAIL_RANGE, far);
  return wheel;
};

export const TRACK_MODELS: Partial<Record<WheelType, WheelModel>> = { track: roadWheel };

/**
 * Patin de chenille, dans son repère (celui que lui donne `placeShoes`, render/trackShape.ts) :
 * x en travers de la bande (`width` m de large, centrée), y vers l'extérieur (0 : le bout de son
 * crampon, sur le parcours de la bande), z le long de la bande. Une plaque et son crampon en
 * relief ; le long d'un bord, la charnière qui le lie au suivant, et ses connecteurs d'acier aux
 * deux bouts de l'axe ; vers l'intérieur, ses guides, un au milieu de chaque rangée de galets
 * (`horns`, en x) : ils passent entre leurs roues jumelles.
 */
export function trackShoe(kit: ModelKit, width: number, horns: readonly number[], name: string): B.Mesh {
  const plateY = -GROUSER_HEIGHT - SHOE_PLATE / 2;
  const edge = -SHOE_LENGTH / 2;
  const parts: B.Mesh[] = [
    kit.box(PLATE, [width, SHOE_PLATE, SHOE_LENGTH], [0, plateY, 0]),
    kit.box(GROUSER, [width * 0.94, GROUSER_HEIGHT, 0.028], [0, -GROUSER_HEIGHT / 2, 0.018]),
    kit.box(HINGE, [width * 0.9, 0.024, 0.026], [0, plateY, edge]),
    ...[-1, 1].map((s) => kit.box(PIN, [0.018, 0.036, 0.05], [s * (width / 2 + 0.009), plateY, edge])),
    ...horns.map((x) => kit.box(STEEL, [0.036, 0.05, 0.05], [x, -SHOE_DEPTH - 0.021, 0])),
  ];
  return kit.fuse(parts, name, { specular: 0.2 });
}

/**
 * Barbotin : la roue dentée qui entraîne la bande, sur le galet arrière de chaque tronçon. Deux
 * couronnes de dents contre les faces extérieures de ses roues jumelles (le bandage cacherait une
 * couronne plus à l'intérieur), dont les dents montent jusque sous la bande (elles mordent entre
 * les patins), tenues par un voile ajouré, et un moyeu cerclé de jaune. Même repère qu'un galet,
 * qu'il habille ; symétrique lui aussi.
 */
export function sprocket(kit: ModelKit, def: WheelTypeDef, name: string): B.Mesh {
  const r = rollerRadius(def);
  const half = def.width / 2;
  const teeth = 12;
  // Bout des dents : sous la bande de dessous
  const tip = r + 0.002;
  const parts: B.Mesh[] = [];
  for (const s of [-1, 1]) {
    const x = s * (half + 0.016);
    parts.push(
      kit.cylinder(STEEL, 0.024, 2 * (tip - 0.042), 2 * (tip - 0.042), [x, 0, 0], "x", 24),
      kit.cylinder(DISH, 0.01, 2 * r * 0.62, 2 * r * 0.62, [x + s * 0.015, 0, 0], "x", 16),
      ...[0, 1, 2, 3, 4, 5].map((i) => {
        const a = (i * Math.PI) / 3 + Math.PI / 6;
        return kit.cylinder(HOLE, 0.006, 0.048, 0.048, [x + s * 0.021, Math.cos(a) * r * 0.42, Math.sin(a) * r * 0.42], "x", 8);
      }),
      kit.cylinder(HUB, 0.028, 0.12, 0.1, [x + s * 0.026, 0, 0], "x", 12),
      kit.cylinder(CAP, 0.012, 0.07, 0.07, [x + s * 0.044, 0, 0], "x", 12),
      ...Array.from({ length: teeth }, (_, i) => {
        const a = (i * Math.PI * 2) / teeth;
        const at = tip - 0.025;
        return kit.box(STEEL, [0.024, 0.05, 0.034], [x, Math.cos(a) * at, Math.sin(a) * at], [a, 0, 0]);
      }),
    );
  }
  return kit.fuse(parts, name, { specular: 0.35 });
}
