import { dcos, dsin } from "../math/det";
import { splitFiles } from "./content";
import caster from "../../../content/wheels/caster.json";
import heavy from "../../../content/wheels/heavy.json";
import heavySteered from "../../../content/wheels/heavySteered.json";
import small from "../../../content/wheels/small.json";
import smallSteered from "../../../content/wheels/smallSteered.json";
import standard from "../../../content/wheels/standard.json";
import steered from "../../../content/wheels/steered.json";
import track from "../../../content/wheels/track.json";
/**
 * Types de roue. Le moteur est dans la roue : chaque type a son couple, sa vitesse et la
 * charge qu'il est fait pour porter. Un robot lourd a besoin de plus de roues, ou de roues
 * plus fortes. Quatre sortes (`wheelKind`) : la roue fixe ; la roue directrice (`steering` : une
 * fusée qui braque, plus chère) ; la roulette (`caster` : une roue folle, sans moteur, qui pivote
 * librement et suit le mouvement) ; le galet de chenille (`track`). Les roues fixes et directrices
 * existent en trois tailles. Chaque type est un fichier de données (content/wheels/<type>.json : voir
 * catalog/content.ts), et a son apparence côté client (`WHEEL_LOOKS`) et son nom dans chaque langue
 * (`wheel.<type>`, client/i18n/locales/<langue>/catalog.ts).
 */
export interface WheelTypeDef {
  /** Coût de construction. */
  readonly cost: number;
  /** Rayon (m). */
  readonly radius: number;
  /** Largeur (m). */
  readonly width: number;
  /** Masse de la roue et de son moteur (kg). */
  readonly mass: number;
  /** Points de structure : à 0, la roue est arrachée. */
  readonly hp: number;
  /** Adhérence (coefficient de frottement du pneu). */
  readonly grip: number;
  /**
   * Moteur électrique : couple maximal à l'arrêt (N·m). Le couple baisse linéairement avec
   * la vitesse jusqu'à 0 à `freeSpeed` ; la puissance maximale vaut stallTorque × freeSpeed / 4.
   * 0 : pas de moteur (une roulette).
   */
  readonly stallTorque: number;
  /** Vitesse de rotation à vide du moteur (rad/s). */
  readonly freeSpeed: number;
  /** Charge nominale par roue (kg). La suspension est réglée pour elle ; au-delà, elle s'affaisse. */
  readonly ratedLoad: number;
  readonly suspension: SuspensionDef;
  /** Roue directrice : sa direction. Absente : la roue ne braque pas. */
  readonly steering?: SteeringDef;
  /** Roulette : une roue folle qui pivote librement autour d'un axe vertical (voir `CasterDef`). */
  readonly caster?: CasterDef;
  /**
   * Galet de chenille : les galets voisins d'un même flanc (à la suite, les uns au-dessus des
   * autres, ou posés l'un sur l'autre vers l'extérieur) forment une chenille, dessinée avec sa
   * bande. Une chenille ne braque pas : le robot tourne en ripant, comme un char.
   */
  readonly track?: boolean;
  /**
   * Le moyeu pend sous le centre de son bloc (m) : un petit galet de chenille laisse ainsi de la
   * garde au sol à la caisse (sans elle, le bord de la caisse touchait la moindre montée du relief
   * et portait le robot).
   */
  readonly drop?: number;
}

/**
 * Roulette : son pivot est un peu en avant de la roue (la chasse, `trail`) ; en roulant, le sol la
 * ramène derrière le pivot : elle s'aligne sur la vitesse d'autant plus vite que celle-ci est
 * grande (et fait demi-tour quand on recule). Elle ne tient presque pas de côté.
 */
export interface CasterDef {
  /** Chasse (m). */
  readonly trail: number;
}

/** Direction d'une roue directrice : elle pivote autour d'un axe vertical passant par son centre. */
export interface SteeringDef {
  /** Braquage maximal de chaque côté (rad). */
  readonly maxAngle: number;
  /** Vitesse de braquage (rad/s). */
  readonly rate: number;
}

/** Suspension : un ressort et un amortisseur verticaux entre le châssis et la roue (robot/wheels.ts). */
export interface SuspensionDef {
  /** Débattement en compression (la roue remonte) et en détente (m). */
  readonly travelUp: number;
  readonly travelDown: number;
  /** Fréquence propre sous la charge nominale (Hz) : fixe la raideur du ressort. */
  readonly frequency: number;
  /** Taux d'amortissement (1 : critique, sans rebond). */
  readonly dampingRatio: number;
}

/**
 * Les types de roue, un fichier chacun (content/wheels/<type>.json, qui suit
 * content/schemas/wheels.schema.json), dans l'ordre du catalogue : leurs noms font `WheelType`. Un
 * fichier donne aussi le prix de déblocage de sa roue (`price`).
 */
const FILES = { standard, steered, small, smallSteered, heavy, heavySteered, caster, track };

export type WheelType = keyof typeof FILES;

const WHEELS = splitFiles<typeof FILES, WheelTypeDef, number>(FILES, "price");

/** Les types de roue, lus de leurs fichiers. */
export const WHEEL_TYPES = WHEELS.defs;

/**
 * Prix de déblocage de chaque type de roue (crédits ; 0 : disponible dès le départ ; une roue
 * directrice coûte plus que la fixe de sa taille), que donne son fichier.
 */
export const WHEEL_PRICES: Readonly<Record<WheelType, number>> = WHEELS.split;

export const isWheelType = (value: string): value is WheelType => Object.hasOwn(WHEEL_TYPES, value);

export const wheelDef = (type: WheelType): WheelTypeDef => WHEEL_TYPES[type];

/** Sorte de roue : fixe, directrice, roulette ou galet de chenille. */
export type WheelKind = "fixed" | "steered" | "caster" | "track";

export function wheelKind(def: WheelTypeDef): WheelKind {
  if (def.track) return "track";
  if (def.caster) return "caster";
  return def.steering ? "steered" : "fixed";
}

/**
 * La roue directrice de même taille qu'une roue fixe, ou null. Sert à relire les plans d'avant les
 * trois sortes de roue, où une roue directrice était une roue fixe avec une case « directrice ».
 */
export function steeredVariant(type: WheelType): WheelType | null {
  switch (type) {
    case "standard": return "steered";
    case "small": return "smallSteered";
    case "heavy": return "heavySteered";
    default: return wheelDef(type).steering ? type : null;
  }
}

/** Réglage du ressort d'une suspension. */
export interface SpringTuning {
  /** Raideur (N/m). */
  readonly stiffness: number;
  /** Amortissement (N·s/m). */
  readonly damping: number;
  /** Débattement (m) où le ressort ne pousse plus : la précharge qui compense la charge nominale. */
  readonly rest: number;
}

/** Ressort qui donne la fréquence propre voulue sous la charge nominale, et s'y tient à sa position du plan. */
export function springTuning(def: WheelTypeDef, gravity: number): SpringTuning {
  const { frequency, dampingRatio } = def.suspension;
  const omega = 2 * Math.PI * frequency;
  const stiffness = def.ratedLoad * omega * omega;
  return {
    stiffness,
    damping: 2 * dampingRatio * Math.sqrt(stiffness * def.ratedLoad),
    rest: -gravity / (omega * omega),
  };
}

/**
 * Place à laisser en plus entre une roue qui pivote, montée sur le flanc gauche ou droit, et son
 * bloc support (m) : braquée à fond, la roue ne doit pas entrer dans le bloc. Braquée d'un angle a,
 * elle déborde vers l'intérieur de R·sin a + (l/2)·cos a au lieu de l/2 ; une roulette fait le
 * tour : R − l/2. Une roue fixe : rien.
 */
export function steerClearance(def: WheelTypeDef): number {
  const angle = def.caster ? Math.PI / 2 : def.steering?.maxAngle ?? 0;
  return def.radius * dsin(angle) + (def.width / 2) * (dcos(angle) - 1);
}
