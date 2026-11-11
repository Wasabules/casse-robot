import { add, cross, scale, vec3, type Vec3 } from "../math/vec";
import { isWeaponId, type DamageType, type WeaponId } from "./weapons";

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

export const MELEE_WEAPONS = {
  /**
   * Toupie horizontale : une grande barre d'acier qui tourne à plat au-dessus (ou au-dessous) de son
   * bloc, 1,9 m d'envergure, ~3 kJ à plein régime. Elle arrache des blocs entiers et éprouve les
   * liaisons ; chaque coup la fait reculer ; abîmée, elle se déséquilibre.
   */
  spinner: {
    look: "bar", motion: "spin", axis: "up", hub: [0, 0.42, 0],
    blade: { inner: 0, outer: 0.95, half: 0.07, arms: { count: 2, width: 0.18 } },
    spin: { inertia: 1.6, speed: 62, spinUp: 2.4, spinDown: 15, gyro: 1, unbalance: 0.035, mass: 6 },
    hit: {
      damageType: "cut", damage: 170, bite: 0.55, fling: 0.5, push: { tangent: 1, radial: 0.55, axial: 0, lift: 0.3 },
      recoil: 1, spread: 0.35, wheels: 1.2, wear: 5, gap: 0.15, minSpeed: 0.25,
    },
    engage: 1.5,
  },
  /**
   * Marteau pneumatique : un bras sur le dessus du robot, armé vers l'arrière, qui s'abat devant lui
   * sur ordre (gâchette) ; gros dégâts sur le dessus de la cible ; chaque coup soulève l'avant de
   * son robot. Le vérin se recharge sur les batteries.
   */
  hammer: {
    look: "hammer", motion: "swing", axis: "left", hub: [0, 0.2, 0.1],
    swing: { reach: 1.3, radius: 0.18, rest: 1.9, end: -1, strike: 0.22, recover: 0.85, energy: 1500, cost: 2 },
    hit: {
      // La réaction au pivot soulève l'avant du robot ; entière, le Pilon se cabrait de 19° et risquait de se retourner
      damageType: "impact", damage: 220, bite: 1, fling: 0.4, push: { tangent: 1, radial: 0.15, axial: 0, lift: 0 },
      recoil: 0.8, spread: 0.4, wheels: 1, wear: 3, gap: 0, minSpeed: 0,
    },
    engage: 2,
  },
  /**
   * Flipper : un plateau en coin devant son bloc, qu'un vérin relève d'un coup sur ordre : ce qui
   * est dessus part en l'air (et se fait mal en retombant). Peu de dégâts par lui-même ; une levée
   * coûte cher aux batteries et le vérin met longtemps à se recharger. Le sol retient le robot qui
   * soulève : un robot léger qui veut soulever un lourd s'enfonce, et c'est lui qui pique du nez.
   */
  flipper: {
    // Au repos, sur un robot à chenilles (bloc à 0,36 m du sol), le bord du plateau effleure le sol
    look: "plate", motion: "flip", axis: "left", hub: [0, -0.1, 0.3],
    plate: { length: 1, half: 0.7, rest: -0.24, end: 1.15, strike: 0.14, lower: 0.5, reload: 3.2, energy: 4000, cost: 8 },
    hit: {
      damageType: "impact", damage: 30, bite: 1, fling: 0.9, push: { tangent: 1, radial: 0, axial: 0, lift: 0.5 },
      recoil: 1, spread: 0.25, wheels: 1, wear: 1, gap: 0, minSpeed: 0,
    },
    engage: 2,
  },
  /**
   * Fléau : une boule d'acier hérissée au bout d'une chaîne, au-dessus de son bloc (un petit mât) ;
   * la manivelle la fait tourner autour de lui à plat, et la boule frappe d'autant plus fort qu'elle
   * va vite. Libre au bout de sa chaîne, elle suit mal les virages, rebondit, s'enroule autour d'un
   * poteau, et tire sur son robot à chaque tour.
   */
  flail: {
    look: "flail", motion: "flail", axis: "up", hub: [0, 0.9, 0],
    flail: {
      crank: 0.4, inertia: 0.25, speed: 7, spinUp: 3.5, chain: 1.4, links: 11,
      mass: 7, radius: 0.16, restitution: 0.25, friction: 0.25, drag: 0.08,
    },
    hit: {
      // `minSpeed` : la vitesse (m/s) de la boule par rapport à ce qu'elle frappe, sous laquelle elle ne fait que toucher
      damageType: "impact", damage: 250, bite: 1, fling: 1, push: { tangent: 1, radial: 0, axial: 0, lift: 0 },
      recoil: 0, spread: 0.3, wheels: 1.1, wear: 2, gap: 0.12, minSpeed: 3,
    },
    engage: 2.6,
  },
  /**
   * Mâchoire broyeuse : deux mâchoires dentées devant son bloc ; sur ordre elles se referment, et ce
   * qu'elles trouvent entre elles est saisi, écrasé en continu (le blindage lourd tient plus
   * longtemps) et traîné. C'est le plus lourd des deux robots qui ne bouge pas : un robot léger qui
   * en mord un lourd ne fait que s'y accrocher.
   */
  jaw: {
    look: "jaw", motion: "grip", axis: "left", hub: [0, 0, 0.28],
    jaw: {
      length: 0.8, half: 0.3, open: 0.55, shut: 0.05, close: 0.2, reopen: 0.4, cooldown: 0.8, mouth: [0.15, 0.85],
      strength: 6000, slip: 0.4, tear: 0.6, crush: 110, bite: 60, power: 1.6, hold: 6,
    },
    hit: {
      damageType: "impact", damage: 0, bite: 1, fling: 0, push: { tangent: 0, radial: 1, axial: 0, lift: 0 },
      recoil: 0, spread: 0.25, wheels: 1.2, wear: 1.5, gap: 0, minSpeed: 0,
    },
    engage: 2,
  },
  /**
   * Lame laser rotative : un arc d'énergie qui balaie à plat au-dessus de son bloc. Ni gyroscope, ni
   * recul, ni balourd : rien ne tourne vraiment. Elle s'allume en une demi-seconde et découpe vite,
   * à petits coups rapprochés (dégâts d'énergie, que le blindage lourd ne réduit pas) ; allumée, elle
   * vide les batteries (1,5 kW pour tenir sa charge, plus qu'en donne le générateur ; 3 kW pour la
   * refaire en coupant). Sous une IEM, une paralysie, ou le moyeu dans l'eau, elle s'éteint d'un coup.
   */
  laserBlade: {
    look: "saber", motion: "spin", axis: "up", hub: [0, 0.36, 0], quench: true,
    blade: { inner: 0.2, outer: 1.05, half: 0.06 },
    spin: { inertia: 2.4, speed: 32, spinUp: 0.5, spinDown: 2, gyro: 0, unbalance: 0, mass: 0, reaction: 0 },
    hit: {
      damageType: "energy", damage: 80, bite: 0.3, fling: 0, push: { tangent: 1, radial: 0.2, axial: 0, lift: 0 },
      recoil: 0, spread: 0.2, wheels: 1.2, wear: 0.5, gap: 0.08, minSpeed: 0.45,
    },
    engage: 1.5,
  },
  /**
   * Fouet plasma : un filament qui claque à plat devant le robot, de sa droite à sa gauche (à la
   * gâchette) ; il brûle ce qu'il touche (dégâts de feu) et l'allume : le pendant au contact du
   * lance-flammes. Pas de masse au bout : il ne pousse ni ne recule. Il s'éteint dans l'eau.
   */
  plasmaWhip: {
    look: "whip", motion: "swing", axis: "up", hub: [0, 0.34, 0.1], quench: true,
    swing: { reach: 2.1, radius: 0.22, rest: 1.45, end: -1.45, strike: 0.2, recover: 0.55, energy: 1200, cost: 1.6 },
    hit: {
      damageType: "fire", damage: 150, bite: 1, fling: 0, push: { tangent: 1, radial: 0.2, axial: 0, lift: 0.2 },
      recoil: 0, spread: 0.35, wheels: 1, wear: 1, gap: 0, minSpeed: 0, ignite: 0.6,
    },
    engage: 2.2,
  },
  /**
   * Lance électrique : une pointe qui sort droit devant son bloc (à la gâchette) et décharge ce
   * qu'elle touche : peu de dégâts, mais une paralysie locale (une IEM ciblée) des organes autour du
   * point touché pendant 2,5 s : les roues de ce côté en roue libre, une tourelle muette, un moteur
   * coupé ; le reste du robot marche.
   */
  shockLance: {
    look: "lance", motion: "thrust", axis: "up", hub: [0, 0.08, 0.2],
    thrust: { retracted: 0.3, reach: 1.6, radius: 0.16, strike: 0.14, recover: 0.6, energy: 800, cost: 2.5 },
    hit: {
      damageType: "energy", damage: 90, bite: 1, fling: 0, push: { tangent: 1, radial: 0, axial: 0, lift: 0 },
      recoil: 0, spread: 0.25, wheels: 1, wear: 1, gap: 0, minSpeed: 0, stun: { radius: 1.1, duration: 2.5 },
    },
    engage: 1.8,
  },
  /**
   * Toupie verticale : un disque épais debout à l'avant, qui tourne vers le haut par devant (sens -1
   * autour de la gauche) : il cueille l'adversaire par-dessous, le soulève et le retourne. Son moment
   * cinétique est couché (le long de l'essieu) : en virage, il fait pencher son robot sur le côté
   * (couple L × Ω), et un robot haut sur roues peut se renverser. S'il frappe trop bas (le sol, en
   * piquant du nez), le sol le renvoie vers le haut : le nez se lève, jusqu'au salto arrière.
   */
  verticalSpinner: {
    look: "disc", motion: "spin", axis: "left", hub: [0, 0.05, 0.72],
    blade: { inner: 0, outer: 0.45, half: 0.07 },
    spin: { inertia: 1, speed: 80, spinUp: 2.6, spinDown: 14, gyro: 1, unbalance: 0.03, mass: 9, direction: -1 },
    hit: {
      damageType: "cut", damage: 150, bite: 0.5, fling: 0.8, push: { tangent: 1, radial: 0.25, axial: 0, lift: 0.6 },
      recoil: 1, spread: 0.3, wheels: 1.2, wear: 5, gap: 0.18, minSpeed: 0.25, ground: 1,
    },
    engage: 1.8,
  },
  /**
   * Champ broyeur : un projecteur de bouclier détourné. Armé (seul, quand un ennemi approche), il
   * frappe d'énergie ce qui entre dans une marge de 0,35 m autour des blocs de son morceau (à moins
   * de 2,6 m de lui) et le repousse ; une arme de contact ennemie qui s'y frotte est frappée la
   * première, et son régime chute. Défensif et passif : pas de touche. Chaque coup puise dans sa
   * charge, que les batteries refont (0,5 kW pour la tenir, 1 kW pour la refaire).
   */
  crusherField: {
    look: "field", motion: "field", axis: "up", hub: [0, 0.3, 0],
    spin: { inertia: 24, speed: 10, spinUp: 1.5, spinDown: 6, gyro: 0, unbalance: 0, mass: 0, reaction: 0 },
    field: { margin: 0.35, radius: 2.6, contacts: 4, drain: 0.35, repel: 160 },
    hit: {
      damageType: "energy", damage: 150, bite: 0.1, fling: 0.35, push: { tangent: 0, radial: 1, axial: 0, lift: 0.15 },
      recoil: 0, spread: 0, wheels: 1, wear: 0, gap: 0.2, minSpeed: 0.3,
    },
    engage: 1.5,
  },
  /**
   * Tambour : un cylindre à dents, large et bas, couché à l'avant, qui tourne vers le haut par devant.
   * La version stable : petit rayon, régime élevé, peu de moment cinétique (peu de précession) ; des
   * coups brefs et répétés qui font sautiller l'adversaire, et qui arrachent roues et galets.
   */
  drum: {
    look: "drum", motion: "spin", axis: "left", hub: [0, 0, 0.5],
    blade: { inner: 0, outer: 0.25, half: 0.45 },
    spin: { inertia: 0.32, speed: 115, spinUp: 1.8, spinDown: 10, gyro: 1, unbalance: 0.02, mass: 10, direction: -1 },
    hit: {
      damageType: "cut", damage: 140, bite: 0.3, fling: 0.45, push: { tangent: 0.7, radial: 0.3, axial: 0, lift: 0.7 },
      recoil: 1, spread: 0.3, wheels: 2.6, wear: 3, gap: 0.12, minSpeed: 0.3,
    },
    engage: 1.4,
  },
  /**
   * Anneau-coque : un anneau d'acier qui tourne autour du robot entier, pendu à des rayons posés sur
   * le dessus (son bloc, au centre du robot, en est le moyeu). Il frappe de tous côtés sans viser ;
   * il sert aussi de blindage (un tir de côté le touche). Énorme moment cinétique vertical : tout le
   * robot devient un gyroscope, et la réaction de son moteur le fait pivoter et déraper quand
   * l'anneau reprend de la vitesse.
   */
  shellSpinner: {
    look: "shell", motion: "spin", axis: "up", hub: [0, -0.185, 0],
    blade: { inner: 1.48, outer: 1.6, half: 0.475, web: { at: 0.475, half: 0.04 } },
    spin: { inertia: 24, speed: 24, spinUp: 3.2, spinDown: 25, gyro: 1, unbalance: 0.05, mass: 11 },
    hit: {
      damageType: "cut", damage: 100, bite: 0.25, fling: 0.55, push: { tangent: 1, radial: 0.5, axial: 0, lift: 0.25 },
      recoil: 1, spread: 0.3, wheels: 1.4, wear: 2, gap: 0.2, minSpeed: 0.25, ground: 0.15,
    },
    engage: 2.3,
  },
  /**
   * Hélice tranchante : les trois pales de l'hélice d'avion (le bloc `propeller`, un moteur). Son
   * régime suit la poussée ; son disque de près de 2 m (les cotes de `BLADES.propeller`,
   * design/clearance.ts) blesse ce qu'il touche, mais chaque coup l'use beaucoup : sous la moitié de
   * ses points, le moteur perd de sa poussée ; cassée, plus rien. Frôler un ennemi, c'est risquer
   * son moteur.
   */
  propeller: {
    look: "propeller", motion: "driven", axis: "up", hub: [0, 0.35, 0],
    blade: { inner: 0, outer: 0.975, half: 0.035, arms: { count: 3, width: 0.14 } },
    // Pas de balourd : une hélice abîmée a déjà celui d'un moteur abîmé (ratés, poussée, tremblement)
    spin: { inertia: 0.8, speed: 50, spinUp: 0.6, spinDown: 3, gyro: 0, unbalance: 0, mass: 2 },
    drive: { idle: 0.28, stop: 0.02 },
    hit: {
      damageType: "cut", damage: 170, bite: 0.7, fling: 0.3, push: { tangent: 1, radial: 0.2, axial: 0.5, lift: 0 },
      recoil: 1, spread: 0.25, wheels: 1.2, wear: 60, gap: 0.1, minSpeed: 0.2,
    },
    engage: 0,
  },
  /**
   * Scie circulaire : un disque d'acier denté de 0,9 m, à plat, au bout d'un bras devant son bloc ;
   * petit et rapide (1 430 tr/min). Il ne frappe pas : il mord en continu (`bite`), perce un bloc
   * puis le suivant, et sa prise tire son robot latéralement le long de la cible.
   */
  saw: {
    look: "saw", motion: "spin", axis: "up", hub: [0, 0.02, 0.72],
    blade: { inner: 0, outer: 0.45, half: 0.03 },
    spin: { inertia: 0.3, speed: 150, spinUp: 1.2, spinDown: 10, gyro: 1, unbalance: 0.012, mass: 3 },
    bite: { power: 5, feed: "radial", grab: 10, gear: 1, depth: 0.8 },
    hit: {
      damageType: "cut", damage: 90, bite: 0, fling: 0, push: { tangent: 1, radial: 0, axial: 0, lift: 0 },
      recoil: 0, spread: 0.15, wheels: 1.3, wear: 0.8, gap: 0, minSpeed: 0.2,
    },
    engage: 1.5,
  },
  /**
   * Foreuse : une mèche hélicoïdale d'un mètre devant son bloc, menée par un volant et un réducteur
   * (1/16) : elle tourne lentement, avec un couple énorme. Très perforante, elle traverse une ligne
   * de blocs jusqu'au cockpit ; son couple tord la cible, et, en réaction, fait rouler sur lui-même
   * un robot léger autour de l'axe du foret : il faut de la masse ou des appuis larges.
   */
  drill: {
    look: "drill", motion: "spin", axis: "forward", hub: [0, 0, 0.75],
    blade: { inner: 0, outer: 0.11, half: 0.5 },
    spin: { inertia: 0.5, speed: 120, spinUp: 2, spinDown: 8, gyro: 1, unbalance: 0.008, mass: 4 },
    bite: { power: 4, feed: "axial", grab: 0, gear: 16, depth: 1.2 },
    hit: {
      damageType: "cut", damage: 120, bite: 0, fling: 0, push: { tangent: 0, radial: 0, axial: 1, lift: 0 },
      recoil: 0, spread: 0, wheels: 1, wear: 0.6, gap: 0, minSpeed: 0.2,
    },
    engage: 1.5,
  },
} as const satisfies Record<string, MeleeSpec>;

export type MeleeId = keyof typeof MELEE_WEAPONS;

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
  return add(scale(e1, swing.reach * Math.cos(angle)), scale(e2, -swing.reach * Math.sin(angle)));
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
  return add(scale(e1, Math.cos(angle)), scale(e2, -Math.sin(angle)));
}

/** Énergie d'un fléau à plein régime (J) : la boule qui tourne au bout de sa chaîne, et le volant de la manivelle. */
export function flailEnergy(flail: FlailSpec): number {
  const r = flail.crank + flail.chain;
  return 0.5 * flail.mass * (flail.speed * r) ** 2 + 0.5 * flail.inertia * flail.speed ** 2;
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
    const r = flail.crank + flail.chain * Math.sin(beta);
    beta = Math.atan((flail.speed ** 2 * r) / 9.81);
  }
  return { radius: flail.crank + flail.chain * Math.sin(beta), drop: flail.chain * Math.cos(beta) };
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
