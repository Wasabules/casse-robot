import { BLOCK_SIZE, PLATE_THICKNESS } from "../config";
import { shapeFraction, type ShapeId } from "./shapes";
import type { MeleeId } from "./melee";
import type { DamageType, WeaponId } from "./weapons";

/**
 * Caractéristiques d'un type de bloc.
 * Chaque type a aussi une apparence côté client (`BLOCK_LOOKS` dans client/render/materials.ts) et
 * son nom dans chaque langue (`block.<type>`, client/i18n/locales/<langue>/catalog.ts) : TypeScript
 * refuse un type sans apparence ou sans nom.
 */
export interface BlockTypeDef {
  /** Masse nominale (kg). */
  readonly mass: number;
  /** Points de structure : le bloc est détruit quand ils tombent à 0. */
  readonly hp: number;
  /** Le bloc prend la couleur du robot. */
  readonly tinted: boolean;
  /** Coût de construction : un robot ne dépasse pas le budget (`ROBOT_BUDGET`, voir design/budget.ts). */
  readonly cost: number;
  /**
   * Solidité de ses liaisons avec ses voisins (N·m·s) : le choc qu'une liaison unique (un col, un
   * bras d'un seul bloc de large) supporte avant de rompre. Une liaison vaut la plus faible de
   * ses deux blocs. Voir robot/structure.ts.
   */
  readonly bond: number;
  /** Facteur des dégâts reçus selon leur nature (1 par défaut ; < 1 : il résiste, > 1 : il y est sensible). */
  readonly resist?: Readonly<Partial<Record<DamageType, number>>>;
  /**
   * Forme du bloc (et de son collider) : un cube plein, une plaque fine perpendiculaire au haut du
   * bloc, ou une forme découpée dans le cube (biseau, coin, arrondi… : voir catalog/shapes.ts), qui
   * garde son propre collider convexe. Cube par défaut.
   */
  readonly shape?: "cube" | "plate" | ShapeId;
  /** Présent si le bloc est un moteur : il pousse vers le haut du bloc. */
  readonly thruster?: ThrusterSpec;
  /** Présent si le bloc est une surface portante (aile, gouverne). */
  readonly aero?: AeroSpec;
  /** Présent si le bloc est une tourelle armée. */
  readonly turret?: TurretSpec;
  /** Batterie : énergie stockée (kJ) pour les réacteurs et les propulseurs. */
  readonly battery?: { readonly capacity: number };
  /** Module de réparation (voir combat/repair.ts). */
  readonly repair?: RepairSpec;
  /** Générateur de bouclier (voir combat/shield.ts). */
  readonly shield?: ShieldSpec;
  /** Radar : repère les ennemis à cette portée (m), à travers les murs et la fumée. */
  readonly radar?: { readonly range: number };
  /** Brouilleur : un radar ennemi ne repère plus le robot au-delà de cette portée (m). */
  readonly jammer?: { readonly range: number };
  /** Lance-leurres : `charges` salves de leurres, qui reviennent une à une toutes les `reload` s (voir combat/decoys.ts). */
  readonly flares?: { readonly charges: number; readonly reload: number };
  /** Lumière (phare, balise) : elle éclaire la nuit ; rien d'autre dans la simulation (voir `LightSpec`). */
  readonly light?: LightSpec;
  /** Appui sur le sol sans roue : patin anti-gravité ou patte (voir robot/supports.ts). */
  readonly support?: SupportSpec;
  /**
   * Arme de contact (toupie, marteau… : catalog/melee.ts) : le bloc en est le moteur et le moyeu ;
   * sa lame ou son bras dépasse de sa case (voir combat/melee.ts).
   */
  readonly melee?: MeleeId;
}

/**
 * Une lumière que porte un bloc (phare, balise, feux d'avion, gyrophare, rampe de police). Elle n'a
 * aucun effet dans la simulation : le client allume son verre tant que le bloc est relié au cockpit
 * et pas paralysé, et, la nuit, la lumière qu'elle jette (client/render/lightSources.ts). `spot` :
 * un cône le long du haut du bloc (comme la poussée d'un moteur : posé sur l'avant du robot, il
 * éclaire devant lui), d'angle total `cone` (rad) ; `point` : tout autour ; `sweep` : un cône qui
 * tourne autour du haut du bloc, un peu penché vers le bas (un gyrophare). `range` : jusqu'où elle
 * porte (m) ; `color` et `pattern` : sa couleur et son rythme (voir `LightColor`, `LightPattern`).
 */
export interface LightSpec {
  readonly kind: "spot" | "point" | "sweep";
  readonly range: number;
  readonly cone?: number;
  readonly color: LightColor;
  readonly pattern: LightPattern;
}

/**
 * Couleur d'une lumière : chaude (un phare), blanche, rouge, orange, bleue ; `team` : celle de son
 * équipe ; `side` : rouge à gauche du robot, verte à droite, blanche au milieu (les feux de
 * position d'un avion : posés en symétrie, ils font la bonne paire) ; `police` : deux feux, bleu à
 * gauche du bloc, rouge à droite.
 */
export type LightColor = "warm" | "white" | "red" | "amber" | "blue" | "team" | "side" | "police";

/**
 * Rythme d'une lumière : fixe ; un battement lent ; des éclats brefs (un feu anticollision qui
 * tourne : un éclat par tour) ; un double éclat (un stroboscope) ; en alternance (une rampe de
 * police : trois éclats d'un feu, puis trois de l'autre) ; tournant (un gyrophare : son cône fait
 * le tour). Calculé d'après le temps du monde et le numéro du bloc : le même sur la réplique.
 */
export type LightPattern = "steady" | "pulse" | "beacon" | "strobe" | "wigwag" | "rotate";

/**
 * Appui sur le sol : le bloc se tient à `height` m au-dessus du sol (mesurés sous lui, jusqu'à
 * `reach` m), comme un ressort-amortisseur réglé pour sa charge nominale, et pousse le robot
 * horizontalement dans la limite de son adhérence. Un patin anti-gravité flotte sur un coussin
 * (peu d'adhérence, il glisse, il consomme de l'énergie) ; une patte s'appuie au sol (elle
 * agrippe, elle enjambe les obstacles, elle ne consomme rien).
 */
export interface SupportSpec {
  readonly kind: "hover" | "leg";
  readonly height: number;
  readonly reach: number;
  /** Charge nominale (kg), fréquence propre (Hz) et taux d'amortissement de la sustentation. */
  readonly ratedLoad: number;
  readonly frequency: number;
  readonly dampingRatio: number;
  /** Adhérence : force horizontale maximale, en part de la force d'appui. */
  readonly traction: number;
  /** Puissance consommée sous la charge nominale (kW). */
  readonly power: number;
}

/**
 * Module de réparation : quand le robot n'a pas été touché depuis `delay` s, il remet en état ses
 * blocs abîmés (et ses roues) à moins de `radius` m, à raison de `rate` points par seconde en
 * tout, les plus abîmés d'abord. Il ne reconstruit pas un bloc détruit.
 */
export interface RepairSpec {
  readonly rate: number;
  readonly radius: number;
  readonly delay: number;
}

/**
 * Générateur de bouclier : tant que le robot a de l'énergie, il absorbe la part `absorb` des
 * dégâts reçus par ses blocs à moins de `radius` m, chaque point absorbé coûtant `cost` kJ aux
 * batteries. Batteries vides, il ne protège plus.
 */
export interface ShieldSpec {
  readonly radius: number;
  readonly absorb: number;
  readonly cost: number;
}

/**
 * Tourelle : une tête qui tourne indépendamment du robot, en lacet autour du haut du bloc et
 * en site au-dessus de son horizon, à vitesse limitée, et qui porte une arme.
 */
export interface TurretSpec {
  readonly weapon: WeaponId;
  /** Vitesses de rotation (rad/s). */
  readonly yawRate: number;
  readonly pitchRate: number;
  /** Débattement en site (rad), par rapport au plan du bloc. */
  readonly minPitch: number;
  readonly maxPitch: number;
  /** Hauteur de l'axe de la tête au-dessus du centre du bloc (négative : la tête pend dessous), et longueur du canon (m). */
  readonly height: number;
  readonly barrel: number;
  /**
   * Dimensions de la tête (m : largeur, hauteur, profondeur), centrée sur son axe, et calibre du
   * canon (m : le diamètre du tube, ou du faisceau de tubes) : sa zone touchable (robot/colliders.ts).
   */
  readonly head: readonly [number, number, number];
  readonly caliber: number;
  /**
   * Tourelle fixe : elle lâche ses munitions vers l'arrière du bloc (poseur de mines) ou sous lui
   * (soute à bombes), sans viser.
   */
  readonly fixed?: "back" | "down";
}

/** Moteur d'un bloc. La poussée est dirigée vers le haut du bloc. */
export interface ThrusterSpec {
  /** Poussée maximale (N). */
  readonly maxThrust: number;
  /** Temps de réponse du moteur (s) : la poussée rattrape la consigne avec ce retard. */
  readonly spoolTime: number;
  /**
   * Couple de réaction de l'hélice par newton de poussée (N·m/N). Sur un multirotor, les hélices
   * tournent en sens alternés et ces couples s'annulent ; s'il en manque une, le robot tourne sur lui-même.
   */
  readonly torqueRatio: number;
  /** Puissance électrique consommée à pleine poussée (kW), prise sur les batteries (voir robot/energy.ts). */
  readonly power: number;
  /**
   * Rotor orientable : la poussée peut s'incliner jusqu'à cet angle (rad) de chaque côté de l'axe
   * du bloc. Le pilote s'en sert pour tenir l'assiette, comme le plateau cyclique d'un hélicoptère.
   */
  readonly gimbal?: number;
  /**
   * Allure à l'écran (et au son) : une flamme (par défaut), les pales d'un rotor, une hélice
   * d'avion devant son bloc, ou la nacelle d'un turboréacteur et sa longue flamme.
   */
  readonly look?: "rotor" | "propeller" | "jet";
  /**
   * Hélice : sa poussée baisse à mesure que l'air arrive vite le long de son axe (le vent de la
   * course), et s'annule à `topSpeed` m/s. Forte au départ, elle plafonne en vitesse ; un réacteur,
   * lui, garde toute sa poussée.
   */
  readonly topSpeed?: number;
  /**
   * Jet de flamme d'un moteur à flamme (réacteur, propulseur, turboréacteur ; pas un rotor, une
   * hélice, ni un réacteur couché, dessiné en rotor de queue) : derrière sa tuyère, à l'opposé de sa
   * poussée, ce qui se trouve dans le jet chauffe (voir robot/exhaust.ts et combat/scorch.ts).
   */
  readonly exhaust?: ExhaustSpec;
}

/**
 * Jet de flamme d'un moteur. Sa longueur suit le régime (`Thruster.thrust`) : un quart de `reach`
 * au ralenti, `reach` à plein régime ; au-delà d'`afterburner` (part de la poussée maximale), la
 * postcombustion l'allonge de moitié et le rend plus chaud d'un tiers. Les dégâts (nature `fire`)
 * sont ceux de `dps` au ras de la tuyère, à plein régime, et faiblissent jusqu'au bout du jet.
 */
export interface ExhaustSpec {
  /** Distance du centre du bloc au bout de la tuyère (m) : la face du bloc, ou le bout de la nacelle d'un turboréacteur. */
  readonly nozzle: number;
  /** Longueur du jet à plein régime, au-delà de la tuyère (m). */
  readonly reach: number;
  /** Dégâts par seconde (avant résistance) au ras de la tuyère, à plein régime. */
  readonly dps: number;
  /** Rayon du jet à la tuyère (m), et ce qu'il gagne par mètre. */
  readonly radius: number;
  readonly flare: number;
  /** Régime de la postcombustion (turboréacteur). */
  readonly afterburner?: number;
}

/**
 * Surface portante (plaque plane d'une case). L'air qui l'attaque par son avant, avec une
 * incidence α, produit une portance le long de son haut et une traînée :
 * portance = ½·ρ·V²·surface·CL(α), avec CL = pente·α jusqu'au décrochage, puis l'effondrement
 * d'une plaque plane décrochée.
 */
export interface AeroSpec {
  /** Surface (m²). */
  readonly area: number;
  /** Pente de portance (par rad). */
  readonly liftSlope: number;
  /** Incidence de décrochage (rad). */
  readonly stallAngle: number;
  /** Coefficient de traînée à portance nulle. */
  readonly dragMin: number;
  /** Traînée induite : CD = dragMin + inducedDrag·CL². */
  readonly inducedDrag: number;
  /** Braquage maximal (rad) si la surface est une gouverne mobile. */
  readonly maxDeflection?: number;
}

const WING_AERO = { area: BLOCK_SIZE * BLOCK_SIZE, liftSlope: 4, stallAngle: 0.26, dragMin: 0.02, inducedDrag: 0.08 };

/** Les ailes et les gouvernes, fines et légères, craignent le feu, les explosions et les lames. */
const FRAGILE = { fire: 1.5, explosive: 1.2, energy: 1.2, cut: 1.5 };

/** Blindages de base (voir `BLOCK_TYPES`), dont les formes reprennent la matière. */
const ARMOR_LIGHT = { cost: 1, mass: 0.5, hp: 40, tinted: true, bond: 30, resist: { fire: 1.3, energy: 1.2, cut: 1.3 } } as const;
const ARMOR = { cost: 2, mass: 1, hp: 100, tinted: true, bond: 120, resist: { explosive: 0.85 } } as const;
const ARMOR_HEAVY = {
  cost: 4, mass: 2, hp: 250, tinted: true, bond: 250,
  resist: { kinetic: 0.7, pierce: 0.85, impact: 0.6, fire: 0.8, cut: 0.5 },
} as const;

/**
 * Bloc de forme, taillé dans un blindage : masse et points de structure en proportion de son
 * volume (un biseau pèse la moitié d'un cube), coût aussi (1 au moins) ; mêmes résistances et même
 * solidité de liaison que sa matière.
 */
function shaped(base: BlockTypeDef, shape: ShapeId): BlockTypeDef {
  const k = shapeFraction(shape);
  return {
    ...base, shape,
    mass: Math.round(base.mass * k * 100) / 100,
    hp: Math.max(1, Math.round(base.hp * k)),
    cost: Math.max(1, Math.round(base.cost * k)),
  };
}

/**
 * Les trois blindages forment une échelle de dureté : plus un bloc encaisse, plus il pèse.
 * Repères : le fusil inflige 50 points, le canon 200 (voir catalog/weapons.ts). Le blindage
 * réactif est à part : il arrête les explosions, mais un obus perforant le traverse.
 * Solidité des liaisons (`bond`) : un obus de canon (30 N·s) qui frappe le bout d'un bras de
 * blindage léger long d'un mètre l'arrache ; le même bras en blindage lourd tient.
 */
export const BLOCK_TYPES = {
  frame: { cost: 1, mass: 1, hp: 80, tinted: false, bond: 60, resist: { cut: 1.1 } },
  armorLight: ARMOR_LIGHT,
  armor: ARMOR,
  armorHeavy: ARMOR_HEAVY,
  // Formes, en blindage léger et normal (le biseau et le coin aussi en lourd : glacis, étraves)
  wedgeLight: shaped(ARMOR_LIGHT, "wedge"),
  wedge: shaped(ARMOR, "wedge"),
  wedgeHeavy: shaped(ARMOR_HEAVY, "wedge"),
  cornerLight: shaped(ARMOR_LIGHT, "corner"),
  corner: shaped(ARMOR, "corner"),
  cornerHeavy: shaped(ARMOR_HEAVY, "corner"),
  innerCornerLight: shaped(ARMOR_LIGHT, "innerCorner"),
  innerCorner: shaped(ARMOR, "innerCorner"),
  roundLight: shaped(ARMOR_LIGHT, "round"),
  round: shaped(ARMOR, "round"),
  roundCornerLight: shaped(ARMOR_LIGHT, "roundCorner"),
  roundCorner: shaped(ARMOR, "roundCorner"),
  slopeLowLight: shaped(ARMOR_LIGHT, "slopeLow"),
  slopeLow: shaped(ARMOR, "slopeLow"),
  slopeHighLight: shaped(ARMOR_LIGHT, "slopeHigh"),
  slopeHigh: shaped(ARMOR, "slopeHigh"),
  slabLight: shaped(ARMOR_LIGHT, "slab"),
  slab: shaped(ARMOR, "slab"),
  armorReactive: {
    cost: 4, mass: 1.2, hp: 90, tinted: true, bond: 120,
    resist: { explosive: 0.35, fire: 0.7, kinetic: 1.1, pierce: 1.4, cut: 1.2 },
  },
  cockpit: { cost: 0, mass: 1, hp: 800, tinted: false, bond: 200 },
  /**
   * Rotor de sustentation. 4 rotors portent 1,5 fois le poids du Drone (armé, avec ses batteries) ;
   * à 3, il ne tient plus son altitude ; à 2, il tombe.
   */
  thruster: {
    cost: 8, mass: 1, hp: 50, tinted: false, bond: 40, resist: { fire: 1.4 },
    thruster: { maxThrust: 108, spoolTime: 0.12, torqueRatio: 0.05, power: 1, exhaust: { nozzle: 0.25, reach: 1, dps: 14, radius: 0.12, flare: 0.12 } },
  },
  /** Moteur de propulsion (turbine) : plus lourd et plus lent à réagir, sans couple de réaction. */
  engine: {
    cost: 10, mass: 2, hp: 80, tinted: false, bond: 100,
    thruster: { maxThrust: 140, spoolTime: 0.5, torqueRatio: 0, power: 1.5, exhaust: { nozzle: 0.25, reach: 1.1, dps: 18, radius: 0.13, flare: 0.12 } },
  },
  wing: { cost: 2, mass: 0.4, hp: 40, tinted: true, bond: 40, resist: FRAGILE, shape: "plate", aero: WING_AERO },
  /** Aile mobile : aileron, profondeur ou direction selon sa place sur l'avion (voir robot/aero.ts). */
  flap: {
    cost: 3, mass: 0.4, hp: 30, tinted: false, bond: 30, resist: FRAGILE, shape: "plate",
    // 29° au plus : à 20°, les ailerons d'un avion ne le faisaient rouler qu'à 17°/s
    aero: { ...WING_AERO, maxDeflection: 0.5 },
  },
  gunTurret: {
    cost: 15, mass: 3, hp: 70, tinted: false, bond: 150,
    turret: { weapon: "rifle", yawRate: 3, pitchRate: 2, minPitch: -0.35, maxPitch: 1.2, height: 0.35, barrel: 0.6, head: [0.32, 0.22, 0.34], caliber: 0.07 },
  },
  sniperTurret: {
    cost: 25, mass: 4, hp: 70, tinted: false, bond: 150,
    turret: { weapon: "sniper", yawRate: 1.2, pitchRate: 1, minPitch: -0.3, maxPitch: 1.1, height: 0.35, barrel: 0.95, head: [0.28, 0.24, 0.4], caliber: 0.09 },
  },
  cannonTurret: {
    cost: 30, mass: 8, hp: 150, tinted: false, bond: 150,
    turret: { weapon: "cannon", yawRate: 1.2, pitchRate: 0.8, minPitch: -0.15, maxPitch: 1.1, height: 0.4, barrel: 0.85, head: [0.46, 0.3, 0.5], caliber: 0.16 },
  },
  missileLauncher: {
    cost: 30, mass: 6, hp: 90, tinted: false, bond: 150,
    turret: { weapon: "missile", yawRate: 1.5, pitchRate: 1, minPitch: 0, maxPitch: 0.9, height: 0.4, barrel: 0.5, head: [0.46, 0.34, 0.5], caliber: 0.34 },
  },
  flakLauncher: {
    cost: 25, mass: 6, hp: 90, tinted: false, bond: 150,
    turret: { weapon: "flak", yawRate: 2.5, pitchRate: 2, minPitch: 0.2, maxPitch: 1.4, height: 0.4, barrel: 0.5, head: [0.4, 0.26, 0.42], caliber: 0.36 },
  },
  mineLayer: {
    cost: 15, mass: 5, hp: 80, tinted: false, bond: 150,
    turret: { weapon: "mine", yawRate: 0, pitchRate: 0, minPitch: 0, maxPitch: 0, height: 0, barrel: 0.45, fixed: "back", head: [0.36, 0.16, 0.2], caliber: 0.24 },
  },
  empMineLayer: {
    cost: 18, mass: 5, hp: 80, tinted: false, bond: 150,
    turret: { weapon: "empMine", yawRate: 0, pitchRate: 0, minPitch: 0, maxPitch: 0, height: 0, barrel: 0.45, fixed: "back", head: [0.36, 0.16, 0.2], caliber: 0.24 },
  },
  fireMineLayer: {
    cost: 16, mass: 5, hp: 80, tinted: false, bond: 150,
    turret: { weapon: "fireMine", yawRate: 0, pitchRate: 0, minPitch: 0, maxPitch: 0, height: 0, barrel: 0.45, fixed: "back", head: [0.36, 0.16, 0.2], caliber: 0.24 },
  },
  smokeMineLayer: {
    cost: 10, mass: 4, hp: 80, tinted: false, bond: 150,
    turret: { weapon: "smokeMine", yawRate: 0, pitchRate: 0, minPitch: 0, maxPitch: 0, height: 0, barrel: 0.45, fixed: "back", head: [0.36, 0.16, 0.2], caliber: 0.24 },
  },
  bounceMineLayer: {
    cost: 18, mass: 5, hp: 80, tinted: false, bond: 150,
    turret: { weapon: "bounceMine", yawRate: 0, pitchRate: 0, minPitch: 0, maxPitch: 0, height: 0, barrel: 0.45, fixed: "back", head: [0.36, 0.16, 0.2], caliber: 0.24 },
  },
  aaMineLayer: {
    cost: 22, mass: 5, hp: 80, tinted: false, bond: 150,
    turret: { weapon: "aaMine", yawRate: 0, pitchRate: 0, minPitch: 0, maxPitch: 0, height: 0, barrel: 0.45, fixed: "back", head: [0.36, 0.2, 0.2], caliber: 0.26 },
  },
  remoteMineLayer: {
    cost: 18, mass: 5, hp: 80, tinted: false, bond: 150,
    turret: { weapon: "remoteMine", yawRate: 0, pitchRate: 0, minPitch: 0, maxPitch: 0, height: 0, barrel: 0.45, fixed: "back", head: [0.36, 0.16, 0.2], caliber: 0.24 },
  },
  sensorMineLayer: {
    cost: 12, mass: 3, hp: 70, tinted: false, bond: 150,
    turret: { weapon: "sensorMine", yawRate: 0, pitchRate: 0, minPitch: 0, maxPitch: 0, height: 0, barrel: 0.45, fixed: "back", head: [0.3, 0.14, 0.2], caliber: 0.2 },
  },
  stickyMineLayer: {
    cost: 20, mass: 5, hp: 80, tinted: false, bond: 150,
    turret: { weapon: "stickyMine", yawRate: 0, pitchRate: 0, minPitch: 0, maxPitch: 0, height: 0, barrel: 0.45, fixed: "back", head: [0.36, 0.16, 0.2], caliber: 0.24 },
  },
  /** Tourelle de réparation : un rayon qui remet en état les alliés ; il puise dans les batteries. */
  repairTurret: {
    cost: 30, mass: 4, hp: 90, tinted: false, bond: 150,
    turret: { weapon: "repair", yawRate: 2.6, pitchRate: 2, minPitch: -0.35, maxPitch: 1.1, height: 0.35, barrel: 0.5, head: [0.32, 0.24, 0.36], caliber: 0.12 },
  },
  /**
   * Lance-nanites : de lui-même, il verrouille l'allié le plus abîmé à portée et lui envoie des
   * nanites qui le poursuivent et le réparent (blocs détruits compris), sans qu'on vise.
   */
  naniteLauncher: {
    cost: 32, mass: 3, hp: 80, tinted: false, bond: 150,
    turret: { weapon: "nanites", yawRate: 3, pitchRate: 2.5, minPitch: -0.3, maxPitch: 1.3, height: 0.3, barrel: 0.35, head: [0.34, 0.26, 0.32], caliber: 0.25 },
  },
  /** Projecteur de bouclier : il déploie un mur d'énergie devant lui, qui arrête les tirs ennemis. */
  barrierProjector: {
    cost: 35, mass: 5, hp: 110, tinted: false, bond: 150,
    turret: { weapon: "barrier", yawRate: 2.2, pitchRate: 1.5, minPitch: -0.2, maxPitch: 0.3, height: 0.3, barrel: 0.4, head: [0.46, 0.2, 0.34], caliber: 0.3 },
  },
  /** Soute à bombes : sous un avion, elle lâche ses bombes à la verticale ; la case du dessous doit rester libre. */
  bombBay: {
    cost: 40, mass: 5, hp: 100, tinted: false, bond: 150,
    turret: { weapon: "bombs", yawRate: 0, pitchRate: 0, minPitch: 0, maxPitch: 0, height: -0.3, barrel: 0.2, fixed: "down", head: [0.36, 0.1, 0.42], caliber: 0.1 },
  },
  /** Rotor d'hélicoptère orientable : un seul suffit à voler, avec un réacteur de côté en rotor de queue. */
  rotor: {
    cost: 30, mass: 4, hp: 90, tinted: false, bond: 100, resist: { fire: 1.2 },
    thruster: { maxThrust: 540, spoolTime: 0.25, torqueRatio: 0.06, power: 4, gimbal: 0.3, look: "rotor" },
  },
  /**
   * Hélice d'avion : un grand disque de trois pales devant son bloc (face vers laquelle elle pousse).
   * Forte au décollage, elle perd de la poussée en prenant de la vitesse (plus rien à 45 m/s). Ses
   * pales tranchent ce qu'elles touchent, et s'y brisent (arme de contact menée par le moteur :
   * `MELEE_WEAPONS.propeller`).
   */
  propeller: {
    cost: 16, mass: 3, hp: 80, tinted: false, bond: 100, resist: { fire: 1.2 },
    thruster: { maxThrust: 260, spoolTime: 0.6, torqueRatio: 0, power: 1.5, look: "propeller", topSpeed: 45 },
    melee: "propeller",
  },
  /**
   * Turboréacteur : une nacelle qui dépasse de son bloc, beaucoup de poussée (cinq propulseurs),
   * lent à monter en régime, et une longue flamme de postcombustion ; il garde sa poussée à toute
   * vitesse. Deux tournent sur le générateur ; au-delà, il faut des batteries. Placé vers l'avant,
   * il propulse ; vers le haut, il porte (décollage vertical) ; de côté, il fait tourner.
   */
  jet: {
    cost: 35, mass: 6, hp: 120, tinted: false, bond: 150, resist: { fire: 0.8, explosive: 0.9 },
    thruster: {
      maxThrust: 700, spoolTime: 1.4, torqueRatio: 0, power: 0.6, look: "jet",
      // Sa flamme part du bout de la nacelle, à 0,68 m du centre du bloc ; plus de 4 m en postcombustion
      exhaust: { nozzle: 0.68, reach: 2.7, dps: 40, radius: 0.2, flare: 0.08, afterburner: 0.85 },
    },
  },
  hoverPad: {
    cost: 12, mass: 1.5, hp: 70, tinted: false, bond: 60,
    support: {
      kind: "hover", height: 1.1, reach: 2.4, ratedLoad: 20, frequency: 1.6, dampingRatio: 0.6, traction: 0.35, power: 0.6,
    },
  },
  leg: {
    cost: 12, mass: 3, hp: 120, tinted: false, bond: 150,
    support: {
      kind: "leg", height: 1.3, reach: 1.9, ratedLoad: 15, frequency: 2.4, dampingRatio: 0.8, traction: 1, power: 0,
    },
  },
  /** Batterie : de l'énergie pour voler plus longtemps. Détruite, elle prend feu. */
  battery: {
    cost: 8, mass: 1.5, hp: 60, tinted: false, bond: 60, resist: { explosive: 1.2, fire: 1.2 },
    battery: { capacity: 50 },
  },
  repairModule: {
    cost: 20, mass: 2, hp: 70, tinted: false, bond: 60,
    repair: { rate: 20, radius: 3, delay: 3 },
  },
  /** Lance-leurres : sur ordre (touche F), ou quand l'IA voit un missile arriver, il éjecte une salve de leurres qui détournent les missiles ennemis. */
  flareLauncher: { cost: 12, mass: 1, hp: 50, tinted: false, bond: 60, flares: { charges: 2, reload: 12 } },
  radar: { cost: 15, mass: 1.5, hp: 50, tinted: false, bond: 40, radar: { range: 120 } },
  /** Phare : la nuit, il éclaire devant lui (le long de son haut : posé sur l'avant du robot, droit devant). */
  headlight: { cost: 3, mass: 0.4, hp: 30, tinted: false, bond: 40, light: { kind: "spot", range: 34, cone: 1.4, color: "warm", pattern: "steady" } },
  /** Balise lumineuse : la nuit, elle luit tout autour, de la couleur de son équipe. */
  beacon: { cost: 3, mass: 0.4, hp: 30, tinted: false, bond: 40, light: { kind: "point", range: 9, color: "team", pattern: "pulse" } },
  /** Feu de position : fixe, rouge à gauche du robot, vert à droite, blanc au milieu (le bout des ailes, la queue d'un avion). */
  navLight: { cost: 1, mass: 0.2, hp: 20, tinted: false, bond: 40, light: { kind: "point", range: 5, color: "side", pattern: "steady" } },
  /** Feu à éclats : un stroboscope blanc, double éclat (sous un avion, au bout de ses ailes). */
  strobe: { cost: 2, mass: 0.2, hp: 20, tinted: false, bond: 40, light: { kind: "point", range: 14, color: "white", pattern: "strobe" } },
  /** Feu anticollision : rouge, il tourne (un éclat par tour), sur le dos ou sous le ventre d'un avion. */
  antiCollision: { cost: 2, mass: 0.3, hp: 25, tinted: false, bond: 40, light: { kind: "point", range: 10, color: "red", pattern: "beacon" } },
  /** Gyrophare : orange, son faisceau tourne et balaie ce qui l'entoure (un engin de chantier, une dépanneuse). */
  rotatingLight: { cost: 3, mass: 0.4, hp: 30, tinted: false, bond: 40, light: { kind: "sweep", range: 20, cone: 0.7, color: "amber", pattern: "rotate" } },
  /** Rampe de police : deux feux, bleu à gauche, rouge à droite, qui éclatent en alternance. */
  policeBar: { cost: 4, mass: 0.5, hp: 35, tinted: false, bond: 40, light: { kind: "point", range: 12, color: "police", pattern: "wigwag" } },
  jammer: { cost: 15, mass: 1.5, hp: 60, tinted: false, bond: 60, jammer: { range: 25 } },
  flamerTurret: {
    cost: 15, mass: 3, hp: 80, tinted: false, bond: 150, resist: { fire: 0.3 },
    turret: { weapon: "flamer", yawRate: 3, pitchRate: 2, minPitch: -0.3, maxPitch: 0.9, height: 0.3, barrel: 0.5, head: [0.34, 0.24, 0.36], caliber: 0.17 },
  },
  empTurret: {
    cost: 30, mass: 5, hp: 90, tinted: false, bond: 150,
    turret: { weapon: "emp", yawRate: 1.5, pitchRate: 1, minPitch: -0.1, maxPitch: 1.1, height: 0.4, barrel: 0.7, head: [0.4, 0.3, 0.44], caliber: 0.15 },
  },
  smokeLauncher: {
    cost: 10, mass: 3, hp: 70, tinted: false, bond: 150,
    turret: { weapon: "smoke", yawRate: 2, pitchRate: 1.5, minPitch: 0.25, maxPitch: 1.1, height: 0.35, barrel: 0.4, head: [0.36, 0.2, 0.3], caliber: 0.28 },
  },
  laserTurret: {
    cost: 25, mass: 3, hp: 70, tinted: false, bond: 150, resist: { energy: 0.6 },
    turret: { weapon: "laser", yawRate: 3.5, pitchRate: 2.5, minPitch: -0.35, maxPitch: 1.3, height: 0.35, barrel: 0.55, head: [0.3, 0.22, 0.36], caliber: 0.06 },
  },
  railTurret: {
    cost: 55, mass: 7, hp: 110, tinted: false, bond: 150,
    turret: { weapon: "rail", yawRate: 1, pitchRate: 0.8, minPitch: -0.15, maxPitch: 1, height: 0.4, barrel: 1.1, head: [0.42, 0.26, 0.56], caliber: 0.2 },
  },
  shotgunTurret: {
    cost: 18, mass: 3.5, hp: 80, tinted: false, bond: 150,
    turret: { weapon: "shotgun", yawRate: 2.6, pitchRate: 1.8, minPitch: -0.35, maxPitch: 1, height: 0.35, barrel: 0.55, head: [0.36, 0.24, 0.36], caliber: 0.22 },
  },
  rocketPod: {
    cost: 28, mass: 5, hp: 90, tinted: false, bond: 150,
    turret: { weapon: "rockets", yawRate: 1.8, pitchRate: 1.2, minPitch: -0.1, maxPitch: 1, height: 0.4, barrel: 0.45, head: [0.5, 0.36, 0.46], caliber: 0.1 },
  },
  warheadLauncher: {
    cost: 90, mass: 5, hp: 110, tinted: false, bond: 150,
    turret: { weapon: "warhead", yawRate: 0.9, pitchRate: 0.7, minPitch: 0.05, maxPitch: 1, height: 0.45, barrel: 0.7, head: [0.5, 0.4, 0.56], caliber: 0.32 },
  },
  lockonLauncher: {
    cost: 32, mass: 6, hp: 90, tinted: false, bond: 150,
    turret: { weapon: "lockon", yawRate: 1.6, pitchRate: 1.2, minPitch: 0, maxPitch: 1.2, height: 0.4, barrel: 0.5, head: [0.5, 0.3, 0.46], caliber: 0.4 },
  },
  plasmaTurret: {
    cost: 30, mass: 4, hp: 80, tinted: false, bond: 150, resist: { energy: 0.6, fire: 0.5 },
    turret: { weapon: "plasma", yawRate: 2.8, pitchRate: 2, minPitch: -0.3, maxPitch: 1, height: 0.35, barrel: 0.5, head: [0.34, 0.26, 0.4], caliber: 0.14 },
  },
  /**
   * Toupie horizontale (arme de contact, catalog/melee.ts) : le moteur et le moyeu d'une barre qui
   * tourne à plat au-dessus de son bloc (au-dessous, posé tête en bas). Lourde : la barre pèse 6 kg.
   */
  spinner: {
    cost: 45, mass: 12, hp: 220, tinted: false, bond: 250,
    resist: { cut: 0.7, kinetic: 0.85, impact: 0.8 }, melee: "spinner",
  },
  /** Marteau pneumatique (arme de contact) : le vérin et le pivot d'un bras qui s'abat devant le bloc. */
  hammer: {
    cost: 38, mass: 10, hp: 200, tinted: false, bond: 250,
    resist: { cut: 0.7, kinetic: 0.85, impact: 0.8 }, melee: "hammer",
  },
  /** Toupie verticale : le moteur d'un disque épais debout devant le bloc, tenu par deux fourches. */
  verticalSpinner: {
    cost: 45, mass: 13, hp: 220, tinted: false, bond: 250,
    resist: { cut: 0.7, kinetic: 0.85, impact: 0.8 }, melee: "verticalSpinner",
  },
  /** Tambour : le moteur d'un cylindre à dents, large et bas, tenu devant le bloc par deux bras. */
  drum: {
    cost: 42, mass: 14, hp: 260, tinted: false, bond: 250,
    resist: { cut: 0.6, kinetic: 0.8, impact: 0.75 }, melee: "drum",
  },
  /**
   * Anneau-coque : le moyeu d'un anneau d'acier qui tourne autour du robot entier (posé sur le dessus,
   * au centre) ; l'anneau lui sert de blindage : tout tir de côté le touche (sa zone touchable fait
   * le tour du robot), d'où sa solidité, celle d'une coque d'acier épaisse (à 600 points, le fusil et
   * le lance-flammes d'un Bélier le cassaient en cinq secondes).
   */
  shellSpinner: {
    cost: 80, mass: 20, hp: 1400, tinted: false, bond: 300,
    resist: { cut: 0.5, kinetic: 0.45, pierce: 0.7, explosive: 0.7, impact: 0.7, fire: 0.35, energy: 0.8 }, melee: "shellSpinner",
  },
  /** Flipper (arme de contact) : le vérin et l'articulation d'un plateau en coin, devant le bloc, qui soulève ce qui est dessus. */
  flipper: {
    cost: 40, mass: 16, hp: 240, tinted: false, bond: 250,
    resist: { cut: 0.7, kinetic: 0.85, impact: 0.8 }, melee: "flipper",
  },
  /** Fléau (arme de contact) : le moteur, le mât et la manivelle d'une boule au bout d'une chaîne (la boule pèse 7 kg). */
  flail: {
    cost: 35, mass: 12, hp: 200, tinted: false, bond: 250,
    resist: { cut: 0.7, kinetic: 0.85, impact: 0.8 }, melee: "flail",
  },
  /** Mâchoire broyeuse (arme de contact) : le vérin et les deux mâchoires dentées qui saisissent devant le bloc. */
  jaw: {
    cost: 45, mass: 18, hp: 300, tinted: false, bond: 250,
    resist: { cut: 0.7, kinetic: 0.85, impact: 0.8 }, melee: "jaw",
  },
  /** Lame laser (arme de contact d'énergie) : l'émetteur d'un arc qui balaie à plat au-dessus du bloc. Rien de lourd ne tourne. */
  laserBlade: {
    cost: 40, mass: 5, hp: 150, tinted: false, bond: 200,
    resist: { energy: 0.6, cut: 0.8, fire: 0.7 }, melee: "laserBlade",
  },
  /** Fouet plasma (arme de contact d'énergie) : la poignée d'un filament de plasma qui claque devant le bloc. */
  plasmaWhip: {
    cost: 36, mass: 6, hp: 160, tinted: false, bond: 200,
    resist: { fire: 0.4, energy: 0.6, cut: 0.8 }, melee: "plasmaWhip",
  },
  /** Lance électrique (arme de contact d'énergie) : le fourreau d'une pointe qui sort devant le bloc et paralyse ce qu'elle touche. */
  shockLance: {
    cost: 34, mass: 5, hp: 150, tinted: false, bond: 200,
    resist: { energy: 0.5, cut: 0.8 }, melee: "shockLance",
  },
  /** Champ broyeur (arme de contact d'énergie) : un projecteur qui frappe ce qui touche la coque de son morceau. */
  crusherField: {
    cost: 40, mass: 4, hp: 120, tinted: false, bond: 120,
    resist: { energy: 0.5 }, melee: "crusherField",
  },
  /**
   * Scie circulaire (arme de contact qui mord) : le moteur et le bras qui porte le disque devant le
   * bloc ; le disque pèse 3 kg.
   */
  saw: {
    cost: 34, mass: 8, hp: 170, tinted: false, bond: 220,
    resist: { cut: 0.7, kinetic: 0.85, impact: 0.8 }, melee: "saw",
  },
  /** Foreuse (arme de contact qui mord) : le moteur, le volant et le réducteur d'une mèche d'un mètre ; lourde et solide. */
  drill: {
    cost: 42, mass: 14, hp: 230, tinted: false, bond: 280,
    resist: { cut: 0.7, kinetic: 0.85, impact: 0.8 }, melee: "drill",
  },
  /** Générateur de bouclier : il protège ce qui l'entoure, tant que les batteries tiennent. */
  shield: {
    cost: 30, mass: 3, hp: 90, tinted: false, bond: 80, resist: { energy: 0.5 },
    shield: { radius: 2.5, absorb: 0.6, cost: 0.06 },
  },
} as const satisfies Record<string, BlockTypeDef>;

export type BlockType = keyof typeof BLOCK_TYPES;

/** Caractéristiques d'un type de bloc, avec les champs optionnels (`thruster`, `aero`…) accessibles. */
export const blockDef = (type: BlockType): BlockTypeDef => BLOCK_TYPES[type];

export const isBlockType = (value: string): value is BlockType => Object.hasOwn(BLOCK_TYPES, value);

/** Forme découpée dans le cube (biseau, coin…), ou null pour un cube ou une plaque. */
export function blockShape(type: BlockType): ShapeId | null {
  const shape = blockDef(type).shape;
  return shape && shape !== "cube" && shape !== "plate" ? shape : null;
}

/**
 * Densité à donner au collider pour obtenir la masse nominale (calculée sur le volume
 * d'une case pleine, d'une plaque, ou de la part du cube qu'occupe une forme).
 */
export function blockDensity(type: BlockType): number {
  const def = blockDef(type);
  const shape = blockShape(type);
  const volume = def.shape === "plate" ? BLOCK_SIZE * BLOCK_SIZE * PLATE_THICKNESS : BLOCK_SIZE ** 3 * (shape ? shapeFraction(shape) : 1);
  return def.mass / volume;
}
