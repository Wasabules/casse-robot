import { add, cross, scale, vec3, type Vec3 } from "../math/vec";
import { isWeaponId, type DamageType, type WeaponId } from "./weapons";
import { dcos, dpow, dsin } from "../math/det";
import { fromFiles } from "./content";
import crusherField from "../../../content/melee/crusherField.json";
import drill from "../../../content/melee/drill.json";
import drum from "../../../content/melee/drum.json";
import flail from "../../../content/melee/flail.json";
import flipper from "../../../content/melee/flipper.json";
import hammer from "../../../content/melee/hammer.json";
import jaw from "../../../content/melee/jaw.json";
import laserBlade from "../../../content/melee/laserBlade.json";
import plasmaWhip from "../../../content/melee/plasmaWhip.json";
import propeller from "../../../content/melee/propeller.json";
import saw from "../../../content/melee/saw.json";
import shellSpinner from "../../../content/melee/shellSpinner.json";
import shockLance from "../../../content/melee/shockLance.json";
import spinner from "../../../content/melee/spinner.json";
import verticalSpinner from "../../../content/melee/verticalSpinner.json";

/*
 * Armes de contact : une masse qui tourne, ou un bras qui frappe, porté par un bloc (le champ
 * `melee` de `BlockTypeDef`, catalog/blocks.ts). Ce ne sont pas des tourelles : rien n'est tiré, la
 * lame frappe ce qui entre dans le volume qu'elle balaie (voir combat/melee.ts).
 *
 * Les mouvements (`motion`) :
 * - `spin` : un rotor (barre, disque, tambour, anneau) monte en régime, garde une énergie cinétique
 *   ½·I·ω² et la vide dans ce qu'il touche ; il a l'effet gyroscopique d'un rotor (I·ω le long de
 *   son axe) et, abîmé, un balourd ;
 * - `swing` : un bras armé (marteau, fouet) frappe sur ordre, d'un angle de repos à un angle de fin,
 *   puis revient ; l'énergie d'une frappe vient des batteries ;
 * - `thrust` : une pointe (lance) sort droit devant son moyeu sur ordre, puis rentre ;
 * - `field` : un champ autour de la coque de son morceau (champ broyeur), qui frappe ce qui y entre ;
 * - `driven` : un rotor mené par le moteur de son bloc (l'hélice tranchante : son bloc est aussi un
 *   moteur, `thruster`) ; son régime suit la poussée, personne ne le commande, et le moteur lui rend
 *   ce qu'un coup lui prend. Il frappe, s'use et précesse comme un rotor.
 *
 * Armes d'énergie, sans masse (lame laser, fouet plasma, lance électrique, champ broyeur) : rien ne
 * tourne ni ne pèse au bout du bras. Le socle les dispense de la mécanique par leurs données : un
 * rotor sans gyroscope (`gyro` 0), sans balourd (`unbalance` 0) ni réaction de son moteur
 * (`reaction` 0), un coup qui ne pousse ni ne recule (`fling`, `recoil` 0). Leur énergie (`spin` :
 * la « charge » ½·I·ω², I n'étant qu'une mesure de ce qu'elles stockent) vient des batteries, et une
 * arme qui s'éteint sans courant (`quench`) s'éteint d'un coup, et sous l'eau.
 *
 * Et les frappes à mécanique (combat/mechanics.ts) :
 * - `flip` : un plateau en coin qu'un vérin relève d'un coup (le flipper) : il jette en l'air ce qui
 *   est dessus ; le sol retient le robot qui soulève (il bascule autour de son appui le plus avancé) ;
 * - `flail` : une boule au bout d'une chaîne, menée par une manivelle (le fléau) : un pendule libre,
 *   intégré au pas fixe, qui tire sur son robot et peut s'enrouler autour d'un poteau ;
 * - `grip` : deux mâchoires qui saisissent (la mâchoire broyeuse) : une prise tenue par des
 *   impulsions entre les deux corps (pas une liaison de Rapier), qui écrase et traîne, et lâche
 *   quand il le faut.
 *
 * Et un mode de coup : la morsure continue (`bite`, `BiteSpec`) d'un rotor qui use ce qu'il touche
 * au lieu de le frapper (scie, foreuse) : des dégâts par seconde tirés de son régime tant que la
 * lame touche, le régime qui baisse sous la charge, la progression d'un bloc percé au suivant, une
 * friction qui tire son robot le long de la cible, le couple de l'outil qui tord la cible et son
 * robot. Il servira aussi à d'autres armes continues (une lame laser, un champ broyeur).
 *
 * Chaque mouvement nouveau est un `motion`, que `updateMelee` traite dans son `switch` : TypeScript
 * refuse un mouvement oublié.
 */

/** Axe d'un rotor ou du pivot d'un bras, dans le repère de son bloc : son haut (+y), sa gauche (+x), son avant (+z). */
export type MeleeAxis = "up" | "left" | "forward";

/**
 * Volume que balaie un rotor, dans son repère (l'axe de rotation et le plan de rotation) : un
 * anneau épais, de rayon intérieur `inner` à `outer`, sur une demi-épaisseur `half` le long de
 * l'axe. Une barre et un disque balaient un disque plein (intérieur 0) ; un tambour, un cylindre
 * long et bas ; un anneau-coque, un anneau autour du robot.
 */
export interface SweptRing {
  readonly inner: number;
  readonly outer: number;
  readonly half: number;
  /**
   * Bras de la lame (une barre : deux ; une hélice : trois), chacun large de `width` m, du moyeu au
   * bord : sa zone touchable tourne avec eux (un tir passe entre). Absent : la lame remplit ce
   * qu'elle balaie (un disque, un tambour, un anneau), et sa zone touchable aussi.
   */
  readonly arms?: { readonly count: number; readonly width: number };
  /**
   * Voile qui relie un anneau à son moyeu (les rayons d'un anneau-coque, au-dessus du robot) : un
   * disque de rayon `outer`, centré à `at` m du moyeu le long de l'axe, de demi-épaisseur `half`. Il
   * ne frappe pas (c'est l'anneau qui frappe) ; il réserve sa place (design/clearance.ts).
   */
  readonly web?: { readonly at: number; readonly half: number };
}

/**
 * Rotor (mouvement `spin`). Son inertie et sa vitesse de pleine rotation donnent l'énergie stockée
 * (½·I·ω²) et son moment cinétique (I·ω).
 */
export interface SpinSpec {
  /** Moment d'inertie (kg·m²) et vitesse de rotation à plein régime (rad/s). */
  readonly inertia: number;
  readonly speed: number;
  /** Montée en régime de l'arrêt au plein régime, moteur à pleine puissance (s) : la puissance du moteur en découle. */
  readonly spinUp: number;
  /** Roue libre : le régime perd les deux tiers (1/e) en `spinDown` s ; tenir le plein régime coûte ces pertes. */
  readonly spinDown: number;
  /** Multiplicateur de l'effet gyroscopique (1 : physique) : couple L × Ω sur le robot qui tourne. */
  readonly gyro: number;
  /**
   * Balourd : excentrement (m) de la masse tournante d'un rotor à bout (0 point de structure). Il
   * naît sous la moitié de ses points, et grandit jusqu'à la casse.
   */
  readonly unbalance: number;
  /** Masse qui tourne (kg), pour le balourd (comprise dans la masse du bloc). */
  readonly mass: number;
  /**
   * Sens de rotation autour de l'axe (1 par défaut : trigonométrique vu du bout de l'axe). Une
   * toupie verticale d'axe `left` qui doit frapper vers le haut à l'avant tourne à -1.
   */
  readonly direction?: 1 | -1;
  /**
   * Part de la réaction de son moteur que reçoit le robot (1 par défaut : ce que le rotor gagne en
   * moment cinétique, le robot le perd). 0 : rien ne tourne vraiment (une lame d'énergie, un champ).
   */
  readonly reaction?: number;
}

/**
 * Rotor mené par un moteur (mouvement `driven`) : au ralenti, il tourne à `idle` de son plein
 * régime (`SpinSpec.speed`), plus vite avec la poussée du moteur de son bloc ; sous `stop` de la
 * poussée maximale (moteur coupé), il s'arrête. Il rejoint ce régime en `spinUp` s (`spinDown` en
 * ralentissant), comme les pales que dessine le rendu.
 */
export interface DriveSpec {
  readonly idle: number;
  readonly stop: number;
}

/**
 * Bras déclenché (mouvement `swing`) : il pivote autour de l'axe `axis` du moyeu ; sa tête, à
 * `reach` m du pivot, part de l'angle de repos `rest` (armé) et va jusqu'à `end`, en `strike` s, en
 * accélérant ; puis il revient à l'armement en `recover` s. Angles autour de l'axe, dans le plan
 * qui lui est perpendiculaire : 0 droit devant (l'avant du bloc), π/2 vers son haut.
 */
export interface SwingSpec {
  readonly reach: number;
  /** Rayon de la tête, pour la toucher (m), et dimensions de la tête dessinée (largeur le long du pivot, épaisseur, longueur). */
  readonly radius: number;
  readonly rest: number;
  readonly end: number;
  readonly strike: number;
  readonly recover: number;
  /** Énergie de la tête au bout de sa course (J) ; touchée plus tôt, elle en a moins (elle accélère). */
  readonly energy: number;
  /** Ce que coûte une frappe aux batteries (kJ) : la charge du vérin. */
  readonly cost: number;
}

/**
 * Pointe (mouvement `thrust`) : elle sort le long de `e1` (l'avant du bloc pour un axe `up` ou
 * `left`), de `retracted` à `reach` m du moyeu, en `strike` s, en accélérant ; puis elle rentre en
 * `recover` s. Son état passe par `MeleeArm.swing` (sa sortie, m) et `phase`.
 */
export interface ThrustSpec {
  readonly retracted: number;
  readonly reach: number;
  /** Rayon de la pointe, pour toucher (m). */
  readonly radius: number;
  readonly strike: number;
  readonly recover: number;
  /** Énergie du coup (J) : une décharge, la même où que la pointe touche le long de sa course. */
  readonly energy: number;
  /** Ce que coûte une frappe aux batteries (kJ). */
  readonly cost: number;
}

/**
 * Plateau d'un flipper (mouvement `flip`) : une plaque articulée sur l'axe `axis` du moyeu, posée en
 * coin devant son bloc (son bord au ras du sol) ; sur ordre, un vérin la relève de `rest` à `end`
 * en `strike` s et soulève ce qui est dessus. Angles comme ceux d'un bras (`SwingSpec`) : 0 droit
 * devant, π/2 vers le haut du bloc ; le plateau va le long de cos θ·e1 − sin θ·e2, sur toute sa
 * largeur le long de l'axe.
 */
export interface PlateSpec {
  /** Longueur du plateau depuis son pivot (m), et sa demi-largeur, le long du pivot (m). */
  readonly length: number;
  readonly half: number;
  /** Angle au repos (rad, < 0 : en coin, vers le sol) et en fin de levée. */
  readonly rest: number;
  readonly end: number;
  /** Durée de la levée (s), en accélérant ; il redescend en `lower` s ; le vérin est rechargé `reload` s après la levée. */
  readonly strike: number;
  readonly lower: number;
  readonly reload: number;
  /**
   * Travail du vérin sur toute sa course (J) : ce qu'il peut donner à ce qu'il soulève. Touché tard
   * dans la course, il lui en reste moins (la part de course qui reste).
   */
  readonly energy: number;
  /** Ce que coûte une levée aux batteries (kJ). */
  readonly cost: number;
}

/**
 * Champ autour de la coque (mouvement `field`) : son énergie est celle de `spin` (le projecteur se
 * charge sur les batteries, comme un rotor monte en régime), et chaque coup (tous les `hit.gap` s)
 * frappe ce qui entre dans la marge autour des blocs de son morceau.
 */
export interface FieldSpec {
  /** Marge autour des blocs couverts (m) : ce qui y entre est frappé. */
  readonly margin: number;
  /** Il couvre les blocs de son morceau à moins de `radius` m du projecteur. */
  readonly radius: number;
  /** Contacts frappés à chaque coup, au plus : les armes de contact ennemies d'abord, puis les plus enfoncés. */
  readonly contacts: number;
  /** Part de son énergie qu'un rotor ennemi qui s'y frotte perd à chaque coup (son régime chute). */
  readonly drain: number;
  /**
   * Impulsion (N·s) qui repousse une arme de contact ennemie qui s'y frotte, à chaque coup, appliquée
   * au point de la coque qu'elle approche (ce qui touche la coque, lui, est poussé d'après `hit.fling`).
   */
  readonly repel: number;
}

/** Paralysie locale (voir combat/emp.ts) : les organes à moins de `radius` m du point touché, pendant `duration` s. */
export interface LocalStun {
  readonly radius: number;
  readonly duration: number;
}

/**
 * Fléau (mouvement `flail`) : une boule au bout d'une chaîne, accrochée au bout d'une manivelle que
 * le moteur fait tourner autour de l'axe du moyeu. La boule est un pendule libre (sa position et sa
 * vitesse, intégrées au pas fixe ; la chaîne ne fait que la retenir) : elle suit la manivelle de
 * loin, subit les accélérations de son robot, rebondit sur ce qu'elle frappe et peut s'enrouler
 * autour d'un obstacle. Ce qu'elle tire sur la chaîne, le robot le reçoit au bout de la manivelle.
 */
export interface FlailSpec {
  /** Rayon de la manivelle (m), et son inertie avec le moyeu (kg·m², un petit volant : son gyroscope). */
  readonly crank: number;
  readonly inertia: number;
  /**
   * Régime de la manivelle à plein (rad/s), que son motoréducteur tient quoi que tire la chaîne ; temps
   * qu'il faut à la boule pour être lancée (s), d'où la puissance du moteur (et la jauge).
   */
  readonly speed: number;
  readonly spinUp: number;
  /** Longueur de la chaîne (m), et nombre de maillons dessinés. */
  readonly chain: number;
  readonly links: number;
  /** La boule : masse (kg), rayon (m). */
  readonly mass: number;
  readonly radius: number;
  /** Rebond de la boule (0 : mou, 1 : élastique), et part de sa vitesse le long de ce qu'elle frappe qu'elle garde. */
  readonly restitution: number;
  readonly friction: number;
  /** Freinage de l'air sur la boule (part de sa vitesse perdue par seconde). */
  readonly drag: number;
}

/**
 * Mâchoire broyeuse (mouvement `grip`) : deux mâchoires articulées sur l'axe du moyeu, de part et
 * d'autre du plan de e1 ; sur ordre elles se ferment, et ce qu'elles trouvent dans leur gueule est
 * saisi (une prise entre les deux corps, tenue par des impulsions : voir combat/mechanics.ts), écrasé
 * en continu et traîné. La prise lâche sur ordre, au bout de `hold` s, quand la proie ou la mâchoire
 * est détruite, quand elle tire trop fort (`strength`, `slip`) ou s'arrache (`tear`).
 */
export interface JawSpec {
  /** Longueur des mâchoires depuis leur pivot (m), et leur demi-largeur, le long du pivot (m). */
  readonly length: number;
  readonly half: number;
  /** Demi-ouverture (rad) : ouverte, et fermée à vide. */
  readonly open: number;
  readonly shut: number;
  /** Fermeture (s), réouverture (s), et répit avant une nouvelle morsure (s). */
  readonly close: number;
  readonly reopen: number;
  readonly cooldown: number;
  /** La gueule : ce qui s'y trouve, entre ces distances du pivot le long de e1 (m), peut être saisi. */
  readonly mouth: readonly [number, number];
  /** Force que tient la prise (N) ; au-delà, elle glisse, et après `slip` s de glissade elle lâche. */
  readonly strength: number;
  readonly slip: number;
  /** Écart (m) entre les deux points de la prise au-delà duquel elle s'arrache. */
  readonly tear: number;
  /** Dégâts par seconde de l'écrasement au bloc saisi (nature `hit.damageType`), et la morsure qui le saisit. */
  readonly crush: number;
  readonly bite: number;
  /** Puissance du vérin pendant qu'il serre (kW) ; vide, la prise lâche. */
  readonly power: number;
  /** Prise la plus longue (s). */
  readonly hold: number;
}

/** Ce que fait un coup. */
export interface MeleeHit {
  readonly damageType: DamageType;
  /** Dégâts par kJ que prend le coup (avant résistance). */
  readonly damage: number;
  /** Part de l'énergie stockée qu'un coup franc prend à un rotor (une frappe prend toute la sienne). */
  readonly bite: number;
  /** Part de l'énergie du coup qui projette la cible (le reste la déchire) : l'impulsion en découle. */
  readonly fling: number;
  /**
   * Direction de l'impulsion au point touché : le long du mouvement de la lame (`tangent`), vers
   * l'extérieur depuis le moyeu (`radial`), le long de l'axe (`axial`), et vers le haut du monde (`lift`).
   */
  readonly push: { readonly tangent: number; readonly radial: number; readonly axial: number; readonly lift: number };
  /** Part de l'impulsion rendue à son propre robot, au moyeu (1 : égale et opposée). */
  readonly recoil: number;
  /** Part des dégâts que reçoivent les blocs voisins de celui qui est touché. */
  readonly spread: number;
  /** Multiplicateur des dégâts aux roues et aux galets (1 par défaut). */
  readonly wheels?: number;
  /** Usure : points de structure que perd l'arme par kJ de coup, divisés par la résistance de ce qu'elle frappe. */
  readonly wear: number;
  /** Délai minimal entre deux coups (s) : la lame doit revenir. */
  readonly gap: number;
  /** Régime sous lequel un rotor ne mord plus (part du plein régime). */
  readonly minSpeed: number;
  /**
   * Part de ce que prendrait un coup franc sur un robot que prend un coup d'un rotor sur le sol
   * (`SCENERY_BITE`, 0,4, par défaut, comme sur un mur du décor : il ne s'y déchire pas, il glisse).
   * Un disque debout mord le sol comme un robot : trop bas, il s'y renvoie lui-même, nez en l'air.
   */
  readonly ground?: number;
  /**
   * Chance d'allumer le bloc touché (fois sa sensibilité au feu, `flammability`), la moitié pour
   * ses voisins ; un accessoire en bois touché prend feu avec cette chance.
   */
  readonly ignite?: number;
  /** Paralysie locale des organes autour du point touché (lance électrique). */
  readonly stun?: LocalStun;
}

/**
 * Morsure continue (mode de coup d'un rotor : scie, foreuse ; plus tard, toute arme qui use au lieu
 * de frapper). Tant que la lame touche, elle prend à son rotor une puissance de coupe, à couple
 * constant (elle suit donc le régime : P = couple × ω) ; ce qu'elle lui prend devient des dégâts
 * (`MeleeHit.damage` par kJ coupé), qui tombent par tranches (combat/melee.ts). Si la coupe demande
 * plus que ne rend le moteur, le régime baisse sous la charge jusqu'à l'équilibre : le volant
 * d'inertie donne d'abord un coup de dents, puis la lame mord à la puissance du moteur. Un bloc
 * percé laisse la lame mordre le suivant, dans le sens où elle avance (`feed`), avec ce qui reste
 * de ses dégâts. Une lame qui mord ne projette pas, ne recule pas (`fling`, `recoil`, `push` et
 * `bite` de `MeleeHit` ne servent pas) : elle accroche.
 */
export interface BiteSpec {
  /** Puissance de coupe à plein régime (kW) : ce que la lame prend à son rotor tant qu'elle mord ; à un régime moindre, d'autant moins. */
  readonly power: number;
  /**
   * Sens où la morsure avance dans la cible : `radial`, le bord d'un disque (une scie : de son bloc
   * vers ce qu'elle mord, dans le plan du disque) ; `axial`, la pointe d'une mèche (une foreuse : le
   * long de son axe ; elle mord d'abord le premier bloc qu'elle rencontre sur lui). Une pente se
   * juge sur ce sens : un glacis rasant fait glisser la lame (ricochet), un flanc droit la reçoit.
   */
  readonly feed: "radial" | "axial";
  /**
   * Prise : multiplicateur de la force de coupe (le couple de l'outil rapporté au rayon du point
   * touché) qui entraîne la cible dans le sens de la lame et tire son propre robot à l'opposé, au
   * moyeu (0 : rien ; 1 : physique ; une scie accroche davantage). Sans effet pour une mèche : sa
   * pointe est sur l'axe, elle tord au lieu de tirer.
   */
  readonly grab: number;
  /**
   * Réduction entre le rotor (le volant qui garde l'énergie) et l'outil : l'outil tourne `gear` fois
   * moins vite, avec un couple `gear` fois plus fort, que reçoivent la cible (une mèche la tord
   * autour de son axe) et, en réaction, son propre robot (1 : prise directe).
   */
  readonly gear: number;
  /** Profondeur (m) jusqu'où les dégâts qui restent d'un bloc percé passent aux suivants, dans le sens où la lame avance. */
  readonly depth: number;
}

/** Une arme de contact. */
export interface MeleeSpec {
  /**
   * Allure (dessin, son et effets côté client, nom de ce qu'elle réserve au garage) : la barre d'une
   * toupie, un marteau, une lame laser, un fouet plasma, une lance électrique, un champ, le disque
   * d'une toupie verticale, un tambour, un anneau-coque, une hélice, le disque d'une scie, la mèche
   * d'une foreuse, le plateau d'un flipper, un fléau, une mâchoire.
   */
  readonly look:
    | "bar" | "hammer" | "saber" | "whip" | "lance" | "field" | "disc" | "drum" | "shell" | "propeller" | "saw" | "drill"
    | "plate" | "flail" | "jaw";
  /**
   * Mouvement : un rotor (`spin`), un rotor mené par le moteur de son bloc (`driven`), un bras
   * déclenché (`swing`), une pointe (`thrust`), un champ (`field`), un plateau qui soulève
   * (`flip`), une boule au bout d'une chaîne (`flail`), une mâchoire qui saisit (`grip`).
   */
  readonly motion: "spin" | "driven" | "swing" | "thrust" | "field" | "flip" | "flail" | "grip";
  /** Axe du rotor, ou du pivot du bras, dans le repère du bloc. */
  readonly axis: MeleeAxis;
  /** Moyeu (centre du rotor, ou pivot du bras), dans le repère du bloc (m). */
  readonly hub: readonly [number, number, number];
  /**
   * Rotor : le volume que balaie sa lame, et son régime. Un volume plus long le long de l'axe
   * (`half`) que large (`outer`) est une mèche : son moyeu est au milieu de sa longueur.
   */
  readonly blade?: SweptRing;
  readonly spin?: SpinSpec;
  /** Rotor mené par un moteur (mouvement `driven`) : comment son régime suit la poussée. */
  readonly drive?: DriveSpec;
  /** Rotor qui mord en continu au lieu de frapper (scie, foreuse : voir `BiteSpec`). */
  readonly bite?: BiteSpec;
  /** Bras déclenché. */
  readonly swing?: SwingSpec;
  /** Flipper, fléau, mâchoire (combat/mechanics.ts). */
  readonly plate?: PlateSpec;
  readonly flail?: FlailSpec;
  readonly jaw?: JawSpec;
  /** Pointe. */
  readonly thrust?: ThrustSpec;
  /** Champ autour de la coque (son énergie : `spin`). */
  readonly field?: FieldSpec;
  /**
   * Arme d'énergie qui s'éteint sans courant : sans commande, sans alimentation (paralysie, cockpit
   * perdu) ou le moyeu sous l'eau, son énergie tombe à zéro d'un coup (elle n'a pas d'élan) ; sous
   * l'eau, elle ne frappe pas.
   */
  readonly quench?: boolean;
  readonly hit: MeleeHit;
  /** Distance à laquelle l'IA engage avec elle (m, entre les centres des robots) : au contact. */
  readonly engage: number;
}

/** Rendement du moteur d'un rotor : ce qui ne passe pas dans la lame est perdu. */
export const MOTOR_EFFICIENCY = 0.8;

/**
 * Les armes de contact, un fichier chacune (content/melee/<id>.json, qui suit
 * content/schemas/melee.schema.json), dans l'ordre du catalogue : leurs noms font `MeleeId`.
 */
const FILES = {
  spinner, hammer, flipper, flail, jaw, laserBlade, plasmaWhip, shockLance, verticalSpinner, crusherField, drum, shellSpinner, propeller, saw,
  drill,
};

/** Les armes de contact, lues de leurs fichiers. */
export const MELEE_WEAPONS = fromFiles<typeof FILES, MeleeSpec>(FILES);

export type MeleeId = keyof typeof FILES;

export const MELEE_IDS = Object.keys(MELEE_WEAPONS) as MeleeId[];

export const isMeleeId = (value: string): value is MeleeId => Object.hasOwn(MELEE_WEAPONS, value);

/** Caractéristiques d'une arme de contact, avec les champs optionnels accessibles. */
export const meleeDef = (id: MeleeId): MeleeSpec => MELEE_WEAPONS[id];

/** Une arme du joueur : celle d'une tourelle, ou une arme de contact (ce qu'on choisit dans la barre des armes). */
export type ArmId = WeaponId | MeleeId;

export const isArmId = (value: string): value is ArmId => isWeaponId(value) || isMeleeId(value);

/**
 * Une arme qu'on manie (le joueur la choisit, l'IA en tient compte dans sa tactique) : pas une
 * hélice, que mène son moteur et qui ne frappe qu'en passant.
 */
export const wielded = (spec: MeleeSpec): boolean => spec.motion !== "driven";

/** Rayon intérieur (m) au-delà duquel une lame entoure le robot (anneau-coque) : elle frappe de tous côtés, sans viser. */
const ALL_AROUND = 0.8;

/** La lame entoure-t-elle son robot (un anneau-coque) ? */
export const allAround = (spec: MeleeSpec): boolean => (spec.blade?.inner ?? 0) >= ALL_AROUND;

/** Énergie stockée par un rotor à ce régime (J). */
export const spinEnergy = (spin: SpinSpec, omega: number): number => 0.5 * spin.inertia * omega * omega;

/** Puissance du moteur d'un rotor (kW) : de quoi monter au plein régime en `spinUp` s. */
export const motorPower = (spin: SpinSpec): number => spinEnergy(spin, spin.speed) / spin.spinUp / MOTOR_EFFICIENCY / 1000;

/** Puissance qu'il faut pour tenir le plein régime contre les pertes (kW). */
export const holdPower = (spin: SpinSpec): number => (2 * spinEnergy(spin, spin.speed)) / spin.spinDown / MOTOR_EFFICIENCY / 1000;

/** Couple de coupe d'une lame qui mord, au rotor (N·m) : constant, sa puissance suit le régime. */
export const biteTorque = (spin: SpinSpec, bite: BiteSpec): number => (bite.power * 1000) / spin.speed;

/**
 * Régime (rad/s) où une lame qui mord franchement tient : là où la coupe et les pertes de la roue
 * libre prennent ce que rend le moteur (sous le plein régime si la coupe demande plus que lui).
 */
export function biteSpeed(spin: SpinSpec, bite: BiteSpec): number {
  const given = motorPower(spin) * 1000 * MOTOR_EFFICIENCY;
  const torque = biteTorque(spin, bite);
  // τ·ω + (I/spinDown)·ω² = P : la racine positive
  const a = spin.inertia / spin.spinDown;
  const omega = (-torque + Math.sqrt(torque * torque + 4 * a * given)) / (2 * a);
  return Math.min(spin.speed, omega);
}

/** Dégâts par seconde d'une lame qui mord franchement au régime `omega` (avant résistance). */
export const biteDps = (spec: MeleeSpec, omega: number): number =>
  spec.spin && spec.bite ? ((biteTorque(spec.spin, spec.bite) * omega) / 1000) * spec.hit.damage : 0;

/**
 * Repère d'un rotor ou d'un bras dans celui de son bloc : son axe, et deux directions de son plan de
 * rotation (`e1`, l'angle 0 : l'avant du bloc, ou son haut pour un axe vers l'avant ; `e2` = axe × e1).
 * Un rotor tourne de e1 vers e2 ; un bras va de son angle de repos à son angle de fin le long de
 * cos θ·e1 − sin θ·e2 (θ = π/2 : vers le haut du bloc, pour un pivot sur sa gauche).
 */
export function meleeAxes(axis: MeleeAxis): { axis: Vec3; e1: Vec3; e2: Vec3 } {
  const a = axis === "up" ? vec3(0, 1, 0) : axis === "left" ? vec3(1, 0, 0) : vec3(0, 0, 1);
  const e1 = axis === "forward" ? vec3(0, 1, 0) : vec3(0, 0, 1);
  return { axis: a, e1, e2: cross(a, e1) };
}

/** Position de la tête d'un bras à l'angle `angle`, depuis le pivot, dans le repère du bloc (m). */
export function headOffset(axis: MeleeAxis, swing: SwingSpec, angle: number): Vec3 {
  const { e1, e2 } = meleeAxes(axis);
  return add(scale(e1, swing.reach * dcos(angle)), scale(e2, -swing.reach * dsin(angle)));
}

/** Une lame plus longue le long de son axe que large : une mèche (son moyeu est au milieu de sa longueur). */
export const isBit = (blade: SweptRing): boolean => blade.half > blade.outer;

/**
 * Portée d'une arme de contact depuis son moyeu (m) : le bord de sa lame (la pointe d'une mèche), la
 * tête de son bras, sa pointe sortie, le bout du plateau, la boule, les mâchoires ; un champ, sa marge.
 */
export function meleeReach(spec: MeleeSpec): number {
  if (spec.blade) return isBit(spec.blade) ? spec.blade.half : spec.blade.outer;
  if (spec.swing) return spec.swing.reach + spec.swing.radius;
  if (spec.thrust) return spec.thrust.reach + spec.thrust.radius;
  if (spec.field) return spec.field.margin;
  if (spec.plate) return spec.plate.length;
  if (spec.flail) return spec.flail.crank + spec.flail.chain + spec.flail.radius;
  if (spec.jaw) return spec.jaw.length;
  return 0;
}

/** Direction (repère du bloc) d'un bras, d'un plateau ou d'une mâchoire à l'angle `angle` autour de son axe : cos θ·e1 − sin θ·e2. */
export function pivotDir(axis: MeleeAxis, angle: number): Vec3 {
  const { e1, e2 } = meleeAxes(axis);
  return add(scale(e1, dcos(angle)), scale(e2, -dsin(angle)));
}

/** Énergie d'un fléau à plein régime (J) : la boule qui tourne au bout de sa chaîne, et le volant de la manivelle. */
export function flailEnergy(flail: FlailSpec): number {
  const r = flail.crank + flail.chain;
  return 0.5 * flail.mass * dpow(flail.speed * r, 2) + 0.5 * flail.inertia * dpow(flail.speed, 2);
}

/** Puissance du moteur d'un fléau (kW) : de quoi lancer sa boule en `spinUp` s. */
export const flailPower = (flail: FlailSpec): number => flailEnergy(flail) / flail.spinUp / MOTOR_EFFICIENCY / 1000;

/**
 * Tour de la boule d'un fléau à plein régime : le rayon où elle tourne (m, depuis l'axe) et ce qu'elle
 * pend sous le moyeu (m) — un pendule conique au bout de la manivelle, tan β = ω²·R / g.
 */
export function flailOrbit(flail: FlailSpec): { radius: number; drop: number } {
  let beta = 1.2;
  for (let i = 0; i < 30; i++) {
    const r = flail.crank + flail.chain * dsin(beta);
    beta = Math.atan((dpow(flail.speed, 2) * r) / 9.81);
  }
  return { radius: flail.crank + flail.chain * dsin(beta), drop: flail.chain * dcos(beta) };
}

/** Position de la pointe d'une lance sortie de `extension` m, depuis le moyeu, dans le repère du bloc (m). */
export function tipOffset(axis: MeleeAxis, extension: number): Vec3 {
  return scale(meleeAxes(axis).e1, extension);
}

/**
 * Arme offensive : on la mène au contact, elle a sa touche dans la barre des armes. Un champ ne
 * l'est pas : il défend la coque, s'arme seul, et ne compte ni dans le placement de l'IA, ni dans
 * ses charges, ni pour faire d'un robot du garage un robot qui charge ; une hélice non plus (elle
 * n'est même pas maniée : `wielded`).
 */
export const meleeOffensive = (spec: MeleeSpec): boolean => spec.motion !== "field" && wielded(spec);
