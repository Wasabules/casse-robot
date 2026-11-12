import { vec3, type Vec3 } from "../math/vec";
import type { DamageType, Explosion } from "./weapons";
import { dpow } from "../math/det";
import { fromFiles } from "./content";
import barrel from "../../../content/props/barrel.json";
import brick from "../../../content/props/brick.json";
import cactus from "../../../content/props/cactus.json";
import car from "../../../content/props/car.json";
import concrete from "../../../content/props/concrete.json";
import crate from "../../../content/props/crate.json";
import facade from "../../../content/props/facade.json";
import floodlight from "../../../content/props/floodlight.json";
import gas from "../../../content/props/gas.json";
import kapok from "../../../content/props/kapok.json";
import lamppost from "../../../content/props/lamppost.json";
import oak from "../../../content/props/oak.json";
import palm from "../../../content/props/palm.json";
import pine from "../../../content/props/pine.json";
import plank from "../../../content/props/plank.json";
import roof from "../../../content/props/roof.json";
import sheet from "../../../content/props/sheet.json";
import tank from "../../../content/props/tank.json";
import tenement from "../../../content/props/tenement.json";
import watertank from "../../../content/props/watertank.json";
import wreck from "../../../content/props/wreck.json";

/**
 * Accessoires du décor : des corps physiques qu'on pousse, qu'on casse, et qui réagissent. Chaque
 * type est un fichier de données (content/props/<type>.json : voir catalog/content.ts), et a aussi
 * son apparence côté client (`PROP_LOOKS` dans client/render/propModels.ts) et son nom dans chaque
 * langue (`prop.<type>`, client/i18n/locales/<langue>/catalog.ts).
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

/** Demi-dimensions d'une voiture, d'une épave (m) : 4,2 m de long, 1,45 m de haut, 1,85 m de large (avant +x). */
export const CAR_HALF = vec3(2.1, 0.72, 0.92);

/**
 * Les types d'accessoire, un fichier chacun (content/props/<type>.json, qui suit
 * content/schemas/props.schema.json), dans l'ordre du catalogue : leurs noms font `PropType`.
 */
const FILES = {
  crate, barrel, gas, brick, concrete, plank, sheet, roof, pine, oak, palm, kapok, cactus, watertank, tank, facade, tenement, car, wreck,
  lamppost, floodlight,
};

export type PropType = keyof typeof FILES;

/** Les types d'accessoire, lus de leurs fichiers. */
export const PROP_TYPES = fromFiles<typeof FILES, PropTypeDef>(FILES);

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
  return def.mass * dpow(half.x / nominal, 3);
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
  return Math.round(def.hp * dpow(half.x / nominal, 2));
}
