/**
 * Types de roue. Le moteur est dans la roue : chaque type a son couple, sa vitesse et la
 * charge qu'il est fait pour porter. Un robot lourd a besoin de plus de roues, ou de roues
 * plus fortes. Quatre sortes (`wheelKind`) : la roue fixe ; la roue directrice (`steering` : une
 * fusée qui braque, plus chère) ; la roulette (`caster` : une roue folle, sans moteur, qui pivote
 * librement et suit le mouvement) ; le galet de chenille (`track`). Les roues fixes et directrices
 * existent en trois tailles. Chaque type a son apparence côté client (`WHEEL_LOOKS`) et son nom dans
 * chaque langue (`wheel.<type>`, client/i18n/locales/<langue>/catalog.ts).
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

/** Les trois tailles de roue fixe ou directrice. */
const STANDARD = {
  radius: 0.55, width: 0.3, mass: 4, hp: 50, grip: 0.9,
  stallTorque: 300, freeSpeed: 12, ratedLoad: 25,
  suspension: { travelUp: 0.14, travelDown: 0.1, frequency: 2.4, dampingRatio: 0.6 },
} as const;
const SMALL = {
  radius: 0.3, width: 0.2, mass: 1.2, hp: 30, grip: 0.9,
  stallTorque: 50, freeSpeed: 25, ratedLoad: 10,
  suspension: { travelUp: 0.1, travelDown: 0.08, frequency: 2.6, dampingRatio: 0.55 },
} as const;
const HEAVY = {
  radius: 0.75, width: 0.45, mass: 9, hp: 120, grip: 0.95,
  stallTorque: 900, freeSpeed: 7, ratedLoad: 70,
  suspension: { travelUp: 0.2, travelDown: 0.14, frequency: 1.9, dampingRatio: 0.55 },
} as const;
/** Une roue directrice coûte plus que la fixe de sa taille : sa fusée et son servomoteur (points de construction). */
const STEER_EXTRA = 3;

export const WHEEL_TYPES = {
  standard: { cost: 6, ...STANDARD },
  steered: { cost: 6 + STEER_EXTRA, ...STANDARD, steering: { maxAngle: 0.6, rate: 1.6 } },
  /** Petite roue légère et rapide, pour les engins légers (ou le train d'atterrissage d'un avion). */
  small: { cost: 3, ...SMALL },
  smallSteered: { cost: 3 + STEER_EXTRA, ...SMALL, steering: { maxAngle: 0.7, rate: 2.5 } },
  /** Grande roue à fort couple mais lente, avec un grand débattement, pour les engins lourds. */
  heavy: { cost: 12, ...HEAVY },
  heavySteered: { cost: 12 + STEER_EXTRA, ...HEAVY, steering: { maxAngle: 0.5, rate: 1 } },
  /**
   * Roulette : une petite roue folle, sans moteur, qui pivote librement et suit le mouvement. Elle
   * porte (roue de queue d'un avion, appui d'un robot à deux roues motrices) sans gêner les
   * virages ; seule, elle ne fait pas avancer.
   */
  caster: {
    cost: 2,
    radius: 0.22, width: 0.14, mass: 0.8, hp: 30, grip: 0.9,
    stallTorque: 0, freeSpeed: 30, ratedLoad: 15,
    // Long débattement vers le bas : elle garde le contact même sous un robot que ses roues motrices
    // (réglées pour une charge plus lourde) tiennent plus haut que prévu
    suspension: { travelUp: 0.1, travelDown: 0.22, frequency: 2.2, dampingRatio: 0.6 },
    caster: { trail: 0.08 },
  },
  /**
   * Galet de chenille : petit, très adhérent, lent et fort ; un galet toutes les une ou deux cases,
   * le long du flanc. On en pose aussi au-dessus ou au-dessous d'un autre (une chenille plus
   * haute), ou sur un autre vers l'extérieur (une chenille plus large, qui porte et agrippe plus :
   * chaque galet a son moteur et son appui).
   */
  track: {
    cost: 8,
    radius: 0.24, width: 0.4, mass: 3, hp: 120, grip: 1.3,
    stallTorque: 300, freeSpeed: 16, ratedLoad: 60,
    suspension: { travelUp: 0.08, travelDown: 0.06, frequency: 2.8, dampingRatio: 0.7 },
    track: true,
    drop: 0.12,
  },
} as const satisfies Record<string, WheelTypeDef>;

export type WheelType = keyof typeof WHEEL_TYPES;

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
  return def.radius * Math.sin(angle) + (def.width / 2) * (Math.cos(angle) - 1);
}
