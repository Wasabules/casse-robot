import { vec3, type Vec3 } from "../math/vec";
import type { DamageType, Explosion } from "./weapons";

/**
 * Accessoires du décor : des corps physiques qu'on pousse, qu'on casse, et qui réagissent.
 * Chaque type a aussi une apparence côté client (`PROP_LOOKS` dans client/render/materials.ts) et son
 * nom dans chaque langue (`prop.<type>`, client/i18n/locales/<langue>/catalog.ts).
 */
export interface PropTypeDef {
  /**
   * Forme : une boîte (demi-côté), un cylindre debout (rayon, demi-hauteur), ou une dalle dont
   * chaque emplacement donne les dimensions (`PropSpot.half` : un pan de mur, un toit) (m). Un
   * cylindre peut être agrandi par son emplacement (`PropSpot.scale` : un arbre plus grand).
   */
  readonly shape:
    | { readonly kind: "box"; readonly half: number }
    | { readonly kind: "cylinder"; readonly radius: number; readonly halfHeight: number }
    | { readonly kind: "slab" };
  /** Masse (kg) ; pour une dalle, masse volumique (kg/m³). */
  readonly mass: number;
  readonly friction: number;
  /** Points de structure : à 0, l'accessoire casse, explose ou s'emballe. Pour une dalle, par m² de sa plus grande face. */
  readonly hp: number;
  /** Facteur des dégâts reçus selon leur nature (1 par défaut), comme pour les blocs. */
  readonly resist?: Readonly<Partial<Record<DamageType, number>>>;
  /** Explosion quand il cède (après `fuse` s) : les explosions voisines peuvent le faire sauter en chaîne. */
  readonly explosion?: Explosion;
  /** Délai entre la rupture et l'explosion (s). */
  readonly fuse?: number;
  /**
   * Fuite de gaz : une fois percé, il est propulsé le long de son axe par le jet (poussée en N)
   * pendant `duration` s, en tournoyant, puis explose.
   */
  readonly vent?: { readonly thrust: number; readonly duration: number };
  /** Se brise en éclats quand il cède. */
  readonly shatters?: boolean;
  /**
   * Ancré au sol : un corps fixe, que rien ne pousse (mur, arbre, citerne). Il ne bouge qu'une
   * fois libéré : quand ce qui le porte a disparu (un toit), ou quand il tombe (`topples`).
   */
  readonly anchored?: boolean;
  /**
   * Il tombe au lieu de casser, la première fois qu'il cède (un arbre) : libéré, il bascule du
   * côté où on l'a frappé, avec cette part de ses points de structure.
   */
  readonly topples?: number;
  /**
   * Du bois : il prend feu (lance-flammes, napalm, explosion qui enflamme, flaque de feu, voisin
   * en feu), perd des points en brûlant, noircit, et s'éteint au bout de `time` s s'il n'est pas
   * ravivé (voir combat/fire.ts). La brique, le béton, la tôle ne brûlent pas. `reach` : portée
   * de ses flammes au-delà de sa surface (m ; un arbre brûle jusque dans son feuillage, à la
   * taille nominale), qui décide des voisins qu'il peut enflammer.
   */
  readonly burns?: { readonly time: number; readonly reach: number };
}

/** Nature des dégâts, et résistance d'une maçonnerie : les balles l'écornent, les explosions l'abattent. */
const MASONRY = { kinetic: 0.3, pierce: 0.55, energy: 0.5, explosive: 1.3, impact: 0.8, fire: 0, cut: 0.35 };
/** Du bois : un robot lancé le traverse, le feu le ronge, une lame le tranche. */
const TIMBER = { kinetic: 0.6, pierce: 0.8, energy: 0.8, explosive: 1.5, impact: 2.5, fire: 2.5, cut: 1.5 };
/** Un tronc : il faut une explosion, une rafale soutenue ou un robot lourd lancé pour l'abattre (une toupie l'entaille). */
const TRUNK = { kinetic: 0.4, pierce: 0.5, energy: 0.7, explosive: 1.2, impact: 1.2, fire: 2, cut: 1.2 };
/** De la tôle d'acier peinte (une voiture, une épave, un lampadaire) : elle ne brûle pas d'elle-même. */
const STEEL = { kinetic: 0.6, pierce: 0.85, energy: 0.7, explosive: 1.2, impact: 0.6, fire: 0, cut: 0.7 };

/** Demi-dimensions d'une voiture, d'une épave (m) : 4,2 m de long, 1,45 m de haut, 1,85 m de large (avant +x). */
export const CAR_HALF = vec3(2.1, 0.72, 0.92);

export const PROP_TYPES = {
  crate: {
    shape: { kind: "box", half: 0.5 }, mass: 12, friction: 0.7, hp: 120, shatters: true, burns: { time: 9, reach: 0.2 },
    // Du bois : elle résiste aux balles, mais un robot lourd lancé ou une chute la fracasse, et elle brûle
    resist: { impact: 3.5, fire: 2, cut: 1.5 },
  },
  barrel: {
    shape: { kind: "cylinder", radius: 0.35, halfHeight: 0.5 }, mass: 25, friction: 0.6, hp: 20,
    // Un robot moyen qui le percute lancé le fait sauter, pas un petit qui le frôle ; les flammes l'allument vite
    resist: { impact: 0.4, fire: 2 },
    explosion: { look: "barrel", radius: 3.2, damage: 260, blastRadius: 4.5, power: 7, lift: 0.8, ignite: 0.5 }, fuse: 0.25,
  },
  gas: {
    shape: { kind: "cylinder", radius: 0.22, halfHeight: 0.55 }, mass: 12, friction: 0.5, hp: 20,
    // Un choc franc la perce (elle fuit, puis saute)
    resist: { impact: 0.6, fire: 1.5 },
    explosion: { look: "gas", radius: 2.2, damage: 180, blastRadius: 3, power: 5, lift: 0.5, ignite: 0.4 }, vent: { thrust: 600, duration: 1.6 },
  },
  brick: {
    shape: { kind: "slab" }, mass: 1800, friction: 0.8, hp: 55, shatters: true, anchored: true, resist: MASONRY,
  },
  concrete: {
    shape: { kind: "slab" }, mass: 2400, friction: 0.8, hp: 110, shatters: true, anchored: true,
    resist: { kinetic: 0.15, pierce: 0.4, energy: 0.35, explosive: 0.9, impact: 0.4, fire: 0, cut: 0.25 },
  },
  plank: {
    shape: { kind: "slab" }, mass: 500, friction: 0.7, hp: 35, shatters: true, anchored: true, resist: TIMBER, burns: { time: 14, reach: 0.3 },
  },
  sheet: {
    shape: { kind: "slab" }, mass: 700, friction: 0.5, hp: 45, shatters: true, anchored: true,
    resist: { kinetic: 0.45, pierce: 1, energy: 0.8, explosive: 1.2, impact: 1.2, fire: 0.2 },
  },
  roof: {
    // Des tuiles sur une charpente de bois : elle brûle
    shape: { kind: "slab" }, mass: 600, friction: 0.7, hp: 40, shatters: true, anchored: true, burns: { time: 12, reach: 0.3 },
    resist: { kinetic: 0.5, pierce: 0.8, energy: 0.8, explosive: 1.5, impact: 1.5, fire: 1.5 },
  },
  pine: {
    shape: { kind: "cylinder", radius: 0.28, halfHeight: 4.5 }, mass: 450, friction: 0.8, hp: 150,
    shatters: true, anchored: true, topples: 0.5, resist: TRUNK, burns: { time: 18, reach: 2.3 },
  },
  oak: {
    shape: { kind: "cylinder", radius: 0.4, halfHeight: 3.2 }, mass: 700, friction: 0.8, hp: 220,
    shatters: true, anchored: true, topples: 0.5, resist: TRUNK, burns: { time: 22, reach: 2.6 },
  },
  // L'Île volcanique : un palmier (tronc mince et haut, une couronne de palmes), un fromager (le
  // géant de la jungle : tronc large à contreforts, cime en parasol)
  palm: {
    shape: { kind: "cylinder", radius: 0.2, halfHeight: 4.2 }, mass: 280, friction: 0.8, hp: 110,
    shatters: true, anchored: true, topples: 0.5, resist: TRUNK, burns: { time: 14, reach: 2.2 },
  },
  kapok: {
    shape: { kind: "cylinder", radius: 0.6, halfHeight: 5.5 }, mass: 1500, friction: 0.8, hp: 380,
    shatters: true, anchored: true, topples: 0.5, resist: TRUNK, burns: { time: 26, reach: 3.4 },
  },
  cactus: {
    // Un cierge du désert : charnu, il ne brûle pas ; il éclate sous un obus ou un robot lancé
    shape: { kind: "cylinder", radius: 0.32, halfHeight: 2 }, mass: 300, friction: 0.8, hp: 70, shatters: true, anchored: true,
    resist: { kinetic: 0.5, pierce: 0.5, energy: 0.8, explosive: 1.4, impact: 1.6, fire: 0.3 },
  },
  watertank: {
    // Réservoir d'eau en douves de bois cerclées de fer, sur ses pilotis : il brûle, il crève, il n'explose pas
    shape: { kind: "cylinder", radius: 1.6, halfHeight: 1.5 }, mass: 1500, friction: 0.7, hp: 160, shatters: true, anchored: true,
    resist: TIMBER, burns: { time: 20, reach: 0.4 },
  },
  tank: {
    shape: { kind: "cylinder", radius: 1.4, halfHeight: 1.7 }, mass: 2500, friction: 0.6, hp: 200, anchored: true,
    // Pleine de carburant : elle résiste aux balles, pas aux obus ; les flammes l'allument, et
    // elle fait sauter ses voisines
    resist: { kinetic: 0.4, pierce: 1, energy: 0.8, explosive: 1, impact: 0.3, fire: 1.5 },
    explosion: { look: "barrel", radius: 7, damage: 400, blastRadius: 10, power: 40, lift: 1, ignite: 0.7 }, fuse: 0.8,
  },
  facade: {
    // Un étage d'un immeuble (un pan de `PropSpot.half`) : enduit sur maçonnerie, percé de fenêtres
    shape: { kind: "slab" }, mass: 1500, friction: 0.8, hp: 50, shatters: true, anchored: true, resist: MASONRY,
  },
  tenement: {
    shape: { kind: "slab" }, mass: 1700, friction: 0.8, hp: 55, shatters: true, anchored: true, resist: MASONRY,
  },
  car: {
    // Une voiture abandonnée (dimensions : `CAR_HALF`), qu'un robot lourd pousse. À bout, elle prend
    // feu (son essence) et brûle pendant sa mèche, puis explose ; les flammes la font céder aussi,
    // et une voiture en feu allume sa voisine
    shape: { kind: "slab" }, mass: 117, friction: 0.7, hp: 26, shatters: true,
    resist: { ...STEEL, explosive: 1.1, impact: 0.5, fire: 1.6 }, burns: { time: 25, reach: 0.8 },
    explosion: { look: "car", radius: 3.6, damage: 220, blastRadius: 5.5, power: 12, lift: 1.4, ignite: 0.6 }, fuse: 5,
  },
  wreck: {
    // Une carcasse déjà brûlée, posée sur ses jantes (dimensions : `CAR_HALF`) : un abri qu'on ne pousse pas
    shape: { kind: "slab" }, mass: 80, friction: 0.8, hp: 40, shatters: true, anchored: true, resist: STEEL,
  },
  lamppost: {
    // Un robot lancé le couche, un obus aussi ; couché, il se brise s'il cède encore
    shape: { kind: "cylinder", radius: 0.13, halfHeight: 3.2 }, mass: 180, friction: 0.6, hp: 60,
    shatters: true, anchored: true, topples: 0.5, resist: { ...STEEL, impact: 1.6 },
  },
  floodlight: {
    // Un mât d'éclairage de 9 m, ses projecteurs en haut (la nuit, ils éclairent : client/render/nightLights.ts) ;
    // plus solide qu'un lampadaire, il se couche aussi sous un choc franc
    shape: { kind: "cylinder", radius: 0.14, halfHeight: 4.6 }, mass: 420, friction: 0.6, hp: 110,
    shatters: true, anchored: true, topples: 0.5, resist: { ...STEEL, impact: 1.3 },
  },
} as const satisfies Record<string, PropTypeDef>;

export type PropType = keyof typeof PROP_TYPES;

export const propDef = (type: PropType): PropTypeDef => PROP_TYPES[type];

/**
 * Demi-dimensions d'un accessoire posé debout (m) : boîte ou dalle ; pour un cylindre, (rayon,
 * demi-hauteur, rayon). Une dalle prend celles de son emplacement ; un cylindre, les siennes à
 * l'échelle de son emplacement.
 */
export function propHalf(type: PropType, spot: { half?: Vec3; scale?: number } = {}): Vec3 {
  const shape = propDef(type).shape;
  const s = spot.scale ?? 1;
  switch (shape.kind) {
    case "box":
      return vec3(shape.half, shape.half, shape.half);
    case "cylinder":
      return vec3(shape.radius * s, shape.halfHeight * s, shape.radius * s);
    case "slab":
      return spot.half ?? vec3(0.5, 0.5, 0.5);
  }
}

/** Volume (m³) d'un accessoire de ces demi-dimensions. */
export function propVolume(type: PropType, half: Vec3): number {
  return propDef(type).shape.kind === "cylinder" ? Math.PI * half.x * half.x * 2 * half.y : 8 * half.x * half.y * half.z;
}

/** Masse (kg) d'un accessoire de ces demi-dimensions. */
export function propMass(type: PropType, half: Vec3): number {
  const def = propDef(type);
  const shape = def.shape;
  if (shape.kind === "slab") return def.mass * propVolume(type, half);
  const nominal = shape.kind === "box" ? shape.half : shape.radius;
  return def.mass * (half.x / nominal) ** 3;
}

/** Points de structure de départ d'un accessoire de ces demi-dimensions. */
export function propHp(type: PropType, half: Vec3): number {
  const def = propDef(type);
  const shape = def.shape;
  if (shape.kind === "slab") {
    const [a, b] = [half.x, half.y, half.z].sort((p, q) => q - p);
    return Math.round(def.hp * 4 * a * b);
  }
  const nominal = shape.kind === "box" ? shape.half : shape.radius;
  return Math.round(def.hp * (half.x / nominal) ** 2);
}
