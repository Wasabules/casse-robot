import { BLOCK_SIZE, PLATE_THICKNESS } from "../config";
import { shapeFraction, type ShapeId } from "./shapes";
import type { MeleeId } from "./melee";
import type { DamageType, WeaponId } from "./weapons";
import { dpow } from "../math/det";
import { splitFiles } from "./content";
import aaMineLayer from "../../../content/blocks/aaMineLayer.json";
import antiCollision from "../../../content/blocks/antiCollision.json";
import armor from "../../../content/blocks/armor.json";
import armorHeavy from "../../../content/blocks/armorHeavy.json";
import armorLight from "../../../content/blocks/armorLight.json";
import armorReactive from "../../../content/blocks/armorReactive.json";
import barrierProjector from "../../../content/blocks/barrierProjector.json";
import battery from "../../../content/blocks/battery.json";
import beacon from "../../../content/blocks/beacon.json";
import bombBay from "../../../content/blocks/bombBay.json";
import bounceMineLayer from "../../../content/blocks/bounceMineLayer.json";
import cannonTurret from "../../../content/blocks/cannonTurret.json";
import cockpit from "../../../content/blocks/cockpit.json";
import crusherField from "../../../content/blocks/crusherField.json";
import drill from "../../../content/blocks/drill.json";
import drum from "../../../content/blocks/drum.json";
import empMineLayer from "../../../content/blocks/empMineLayer.json";
import empTurret from "../../../content/blocks/empTurret.json";
import engine from "../../../content/blocks/engine.json";
import fireMineLayer from "../../../content/blocks/fireMineLayer.json";
import flail from "../../../content/blocks/flail.json";
import flakLauncher from "../../../content/blocks/flakLauncher.json";
import flamerTurret from "../../../content/blocks/flamerTurret.json";
import flap from "../../../content/blocks/flap.json";
import flareLauncher from "../../../content/blocks/flareLauncher.json";
import flipper from "../../../content/blocks/flipper.json";
import frame from "../../../content/blocks/frame.json";
import gunTurret from "../../../content/blocks/gunTurret.json";
import hammer from "../../../content/blocks/hammer.json";
import headlight from "../../../content/blocks/headlight.json";
import hoverPad from "../../../content/blocks/hoverPad.json";
import jammer from "../../../content/blocks/jammer.json";
import jaw from "../../../content/blocks/jaw.json";
import jet from "../../../content/blocks/jet.json";
import laserBlade from "../../../content/blocks/laserBlade.json";
import laserTurret from "../../../content/blocks/laserTurret.json";
import leg from "../../../content/blocks/leg.json";
import lockonLauncher from "../../../content/blocks/lockonLauncher.json";
import mineLayer from "../../../content/blocks/mineLayer.json";
import missileLauncher from "../../../content/blocks/missileLauncher.json";
import naniteLauncher from "../../../content/blocks/naniteLauncher.json";
import navLight from "../../../content/blocks/navLight.json";
import plasmaTurret from "../../../content/blocks/plasmaTurret.json";
import plasmaWhip from "../../../content/blocks/plasmaWhip.json";
import policeBar from "../../../content/blocks/policeBar.json";
import propeller from "../../../content/blocks/propeller.json";
import radar from "../../../content/blocks/radar.json";
import railTurret from "../../../content/blocks/railTurret.json";
import remoteMineLayer from "../../../content/blocks/remoteMineLayer.json";
import repairModule from "../../../content/blocks/repairModule.json";
import repairTurret from "../../../content/blocks/repairTurret.json";
import rocketPod from "../../../content/blocks/rocketPod.json";
import rotatingLight from "../../../content/blocks/rotatingLight.json";
import rotor from "../../../content/blocks/rotor.json";
import saw from "../../../content/blocks/saw.json";
import sensorMineLayer from "../../../content/blocks/sensorMineLayer.json";
import shellSpinner from "../../../content/blocks/shellSpinner.json";
import shield from "../../../content/blocks/shield.json";
import shockLance from "../../../content/blocks/shockLance.json";
import shotgunTurret from "../../../content/blocks/shotgunTurret.json";
import smokeLauncher from "../../../content/blocks/smokeLauncher.json";
import smokeMineLayer from "../../../content/blocks/smokeMineLayer.json";
import sniperTurret from "../../../content/blocks/sniperTurret.json";
import spinner from "../../../content/blocks/spinner.json";
import stickyMineLayer from "../../../content/blocks/stickyMineLayer.json";
import strobe from "../../../content/blocks/strobe.json";
import thruster from "../../../content/blocks/thruster.json";
import verticalSpinner from "../../../content/blocks/verticalSpinner.json";
import warheadLauncher from "../../../content/blocks/warheadLauncher.json";
import wing from "../../../content/blocks/wing.json";

/**
 * Caractéristiques d'un type de bloc. Chaque type est un fichier de données (content/blocks/<type>.json :
 * voir catalog/content.ts), sauf les blocs de forme, calculés (`shaped`). Chaque type a aussi une apparence côté client (`BLOCK_LOOKS` dans client/render/materials.ts) et
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
 * Les types de bloc écrits en fichiers (content/blocks/<type>.json, qui suit
 * content/schemas/blocks.schema.json, avec le prix de déblocage du bloc), dans l'ordre du catalogue.
 * Les blindages forment une échelle de dureté : plus un bloc encaisse, plus il pèse (le blindage
 * réactif est à part : il arrête les explosions, mais un obus perforant le traverse).
 */
const FILES = {
  frame, armorLight, armor, armorHeavy, armorReactive, cockpit, thruster, engine, wing, flap, gunTurret, sniperTurret, cannonTurret,
  missileLauncher, flakLauncher, mineLayer, empMineLayer, fireMineLayer, smokeMineLayer, bounceMineLayer, aaMineLayer, remoteMineLayer,
  sensorMineLayer, stickyMineLayer, repairTurret, naniteLauncher, barrierProjector, bombBay, rotor, propeller, jet, hoverPad, leg, battery,
  repairModule, flareLauncher, radar, headlight, beacon, navLight, strobe, antiCollision, rotatingLight, policeBar, jammer, flamerTurret,
  empTurret, smokeLauncher, laserTurret, railTurret, shotgunTurret, rocketPod, warheadLauncher, lockonLauncher, plasmaTurret, spinner,
  hammer, verticalSpinner, drum, shellSpinner, flipper, flail, jaw, laserBlade, plasmaWhip, shockLance, crusherField, saw, drill, shield,
};

const FILE_BLOCKS = splitFiles<typeof FILES, BlockTypeDef, number>(FILES, "price");
const FILED = FILE_BLOCKS.defs;

/**
 * Les blocs de forme, calculés (`shaped`) : taillés dans les blindages léger et normal (le biseau et
 * le coin aussi en lourd : glacis, étraves). Ils suivent leur matière, que donne son fichier.
 */
const SHAPED = {
  wedgeLight: shaped(FILED.armorLight, "wedge"),
  wedge: shaped(FILED.armor, "wedge"),
  wedgeHeavy: shaped(FILED.armorHeavy, "wedge"),
  cornerLight: shaped(FILED.armorLight, "corner"),
  corner: shaped(FILED.armor, "corner"),
  cornerHeavy: shaped(FILED.armorHeavy, "corner"),
  innerCornerLight: shaped(FILED.armorLight, "innerCorner"),
  innerCorner: shaped(FILED.armor, "innerCorner"),
  roundLight: shaped(FILED.armorLight, "round"),
  round: shaped(FILED.armor, "round"),
  roundCornerLight: shaped(FILED.armorLight, "roundCorner"),
  roundCorner: shaped(FILED.armor, "roundCorner"),
  slopeLowLight: shaped(FILED.armorLight, "slopeLow"),
  slopeLow: shaped(FILED.armor, "slopeLow"),
  slopeHighLight: shaped(FILED.armorLight, "slopeHigh"),
  slopeHigh: shaped(FILED.armor, "slopeHigh"),
  slabLight: shaped(FILED.armorLight, "slab"),
  slab: shaped(FILED.armor, "slab"),
};

/** Prix de déblocage des blocs de forme : ceux des blindages léger et normal sont libres, ceux du lourd se débloquent. */
const SHAPED_PRICES: Readonly<Record<keyof typeof SHAPED, number>> = {
  wedgeLight: 0, wedge: 0, wedgeHeavy: 100, cornerLight: 0, corner: 0, cornerHeavy: 100, innerCornerLight: 0, innerCorner: 0, roundLight: 0,
  round: 0, roundCornerLight: 0, roundCorner: 0, slopeLowLight: 0, slopeLow: 0, slopeHighLight: 0, slopeHigh: 0, slabLight: 0, slab: 0,
};

const { frame: _frame, armorLight: _armorLight, armor: _armor, armorHeavy: _armorHeavy, ...OTHERS } = FILED;

/** Les types de bloc : ceux des fichiers, et les blocs de forme après les trois blindages dont ils sont taillés. */
export const BLOCK_TYPES = {
  frame: FILED.frame, armorLight: FILED.armorLight, armor: FILED.armor, armorHeavy: FILED.armorHeavy, ...SHAPED, ...OTHERS,
};

export type BlockType = keyof typeof BLOCK_TYPES;

/**
 * Prix de déblocage de chaque type de bloc (crédits ; 0 : disponible dès le départ), dans l'ordre du
 * catalogue : celui d'un bloc écrit en fichier y est, celui d'un bloc de forme dans `SHAPED_PRICES`.
 */
const PRICES: Readonly<Record<string, number>> = { ...FILE_BLOCKS.split, ...SHAPED_PRICES };
export const BLOCK_PRICES = Object.fromEntries(Object.keys(BLOCK_TYPES).map((type) => [type, PRICES[type]])) as Readonly<Record<BlockType, number>>;

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
  const volume = def.shape === "plate" ? BLOCK_SIZE * BLOCK_SIZE * PLATE_THICKNESS : dpow(BLOCK_SIZE, 3) * (shape ? shapeFraction(shape) : 1);
  return def.mass / volume;
}
