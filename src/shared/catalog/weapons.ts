import type { MeleeId } from "./melee";

/**
 * Nature des dégâts. Chaque type de bloc y résiste plus ou moins (`BlockTypeDef.resist`) : un
 * blindage lourd encaisse mieux les balles, un blindage réactif les explosions. `impact` : les
 * chocs (collisions, un marteau) ; `fire` : les flammes ; `energy` : le laser, que le blindage lourd
 * n'arrête pas mieux qu'un autre ; `cut` : les lames des armes de contact (toupies, scies), qui
 * mordent dans ce qu'elles frappent : le blindage lourd les encaisse, le léger s'y déchire.
 */
export type DamageType = "kinetic" | "pierce" | "explosive" | "impact" | "fire" | "energy" | "cut";

export const DAMAGE_TYPES: readonly DamageType[] = ["kinetic", "pierce", "explosive", "impact", "fire", "energy", "cut"];

/**
 * Armes. Chaque tir lance un projectile physique (voir combat/projectiles.ts) : il vole avec
 * sa vitesse et la gravité, se guide éventuellement, perce ou explose à l'impact.
 * Chaque arme a aussi une allure à l'écran (`PROJECTILE_LOOKS` dans client/render/projectiles.ts) et
 * son nom dans chaque langue (`weapon.<id>`, client/i18n/locales/<langue>/catalog.ts).
 */
export interface Weapon {
  /** Délai minimal entre deux tirs (s). */
  readonly cooldown: number;
  /** Tire en continu tant que la gâchette est maintenue. */
  readonly automatic: boolean;
  /**
   * Dispersion au viseur, robot immobile : écart angulaire aléatoire du tir (rad). La meilleure
   * précision de l'arme ; `handling` dit comment elle se dégrade.
   */
  readonly spread: number;
  readonly handling: Handling;
  /** Recul : impulsion renvoyée sur le robot qui tire, à l'opposé du tir (N·s). */
  readonly recoil: number;
  /** Portée utile (m) : l'IA engage les cibles plus proches. */
  readonly range: number;
  /**
   * Distance à laquelle l'IA aime combattre avec cette arme (m) ; sans elle, l'arme ne compte pas
   * dans ses choix de placement (fumigène).
   */
  readonly engage?: number;
  /**
   * Surchauffe : chaque tir chauffe l'arme de `perShot` (1 : surchauffe) et elle refroidit de
   * `cooling` par seconde. En surchauffe, elle ne tire plus avant d'être redescendue à `RESUME_HEAT`.
   */
  readonly heat?: { readonly perShot: number; readonly cooling: number };
  /** Munitions : un chargeur de `capacity` coups, qui regagne un coup toutes les `reload` s. */
  readonly ammo?: { readonly capacity: number; readonly reload: number };
  /** L'IA ne tire pas sur une cible plus proche (m) : l'explosion la toucherait elle-même. */
  readonly minRange?: number;
  /** Le joueur ne peut tirer qu'au viseur (clic droit) : une arme de précision ne tire pas à la hanche. */
  readonly scopeOnly?: boolean;
  /**
   * Arme électrique : chaque tir prend `power` kJ aux batteries du robot (voir robot/energy.ts) ;
   * batteries trop basses, elle ne tire plus. Les batteries lui tiennent lieu de munitions.
   */
  readonly power?: number;
  /**
   * Verrouillage (voir combat/lock.ts) : il faut garder un ennemi dans un cône de `cone` rad
   * autour de la visée pendant `time` s avant de pouvoir tirer ; les missiles poursuivent ensuite
   * la cible verrouillée.
   */
  readonly lock?: { readonly time: number; readonly cone: number };
  /**
   * Arme larguée (bombes) : une soute fixe lâche ses projectiles sous le robot, sans viser ; ils
   * tombent en gardant sa vitesse. Le joueur largue à la gâchette (le HUD marque le point de
   * chute) ; l'IA, quand ses bombes tomberaient sur un ennemi au sol (voir ai/gunner.ts).
   */
  readonly dropped?: boolean;
  /**
   * Arme de soutien automatique : ses tourelles choisissent seules l'allié à soigner et tirent sans
   * qu'on vise ni qu'on appuie, joueur compris (voir `operateSupport`, ai/gunner.ts).
   */
  readonly autoSupport?: boolean;
  readonly projectile: ProjectileSpec;
}

/**
 * Maniement d'une arme : ce qui dégrade sa précision (voir combat/accuracy.ts). Sans viseur, la
 * dispersion est multipliée par `hip` ; le mouvement du robot l'élargit de `move` rad par m/s, et
 * ses rotations (il vire, il tangue, il rebondit) de `turn` rad par rad/s. Un sniper qui bouge ne
 * touche plus rien ; un lance-flammes ou un missile guidé ne s'en soucient pas.
 */
export interface Handling {
  readonly hip: number;
  readonly move: number;
  readonly turn: number;
}

/** Chaleur (0 à 1) à laquelle une arme en surchauffe peut tirer de nouveau. */
export const RESUME_HEAT = 0.35;

export interface ProjectileSpec {
  /** Apparence du projectile. */
  readonly look: "bullet" | "pellet" | "shell" | "missile" | "rocket" | "warhead" | "mine" | "bomb" | "flame" | "plasma" | "orb" | "grenade" | "beam" | "rail" | "repair" | "flare" | "nanites" | "barrier";
  /** Vitesse de sortie (m/s). */
  readonly speed: number;
  /** Part de la gravité subie : 0 pour une trajectoire droite (missile propulsé), 1 pour une balistique. */
  readonly gravity: number;
  /** Durée de vol maximale (s). Un projectile explosif explose en fin de course. */
  readonly life: number;
  /** Dégâts à l'impact direct, et leur nature (une explosion est toujours `explosive`). */
  readonly damage: number;
  readonly damageType: DamageType;
  /**
   * Perforant : si le projectile détruit ce qu'il touche, il continue avec les dégâts qui lui
   * restent (dégâts − points de structure du bloc traversé).
   */
  readonly penetrating: boolean;
  /** Impulsion transmise à ce qui est touché (N·s). */
  readonly impulse: number;
  readonly explosion?: Explosion;
  readonly guidance?: Guidance;
  /** Fusée de proximité (en vol) : explose si une cible passe à moins de ce rayon (m). */
  readonly proximity?: number;
  /** Mine : elle se pose là où elle tombe, puis attend ce qui la déclenche (voir `MineSpec`). */
  readonly mine?: MineSpec;
  /**
   * Projectile qu'on peut abattre (missile, roquette, ogive, bombe, mine posée) : une sphère de
   * `radius` m que les balles et les explosions touchent, et ses points de structure ; à 0, il
   * éclate là où il est (voir combat/interception.ts).
   */
  readonly hull?: { readonly radius: number; readonly hp: number };
  /** Leurre : il brûle en l'air, et les missiles ennemis qui le voient peuvent le suivre (voir combat/decoys.ts). */
  readonly decoy?: boolean;
  /**
   * Rayon réparateur : au lieu de dégâts, il remet `amount` points de structure à chaque bloc (et
   * roue) d'un robot allié à moins de `radius` m du point touché ; il ne fait rien à un ennemi.
   */
  readonly repair?: RepairShot;
  /** Projecteur de bouclier : il se déploie en mur d'énergie au bout de sa course (voir `BarrierSpec`). */
  readonly barrier?: BarrierSpec;
  /** Probabilité d'enflammer le bloc touché (voir combat/fire.ts). */
  readonly ignite?: number;
  /**
   * Flaque de feu (lance-flammes) : un jet qui touche le sol ou le décor, ou qui s'éteint près du
   * sol, y laisse une flaque de feu avec la probabilité `chance` (voir combat/groundFires.ts).
   */
  readonly puddle?: GroundFireSpec & { readonly chance: number };
  /** Impulsion électromagnétique à l'impact : elle coupe l'électronique des robots proches. */
  readonly emp?: EmpPulse;
  /** Nuage de fumée libéré à l'impact, ou en fin de course : il cache ce qui est derrière. */
  readonly smoke?: SmokeSpec;
  /**
   * Gerbe (fusil à pompe) : chaque tir lance `count` plombs, écartés chacun d'au plus `spread` rad
   * autour de la direction du tir (elle-même dispersée comme celle d'une autre arme).
   */
  readonly pellets?: { readonly count: number; readonly spread: number };
  /**
   * Éventail (salve de roquettes) : chaque projectile part écarté d'au plus `fan` rad de la
   * direction du tir, puis son guidage le ramène vers le point visé. Ce n'est pas une imprécision :
   * le cercle de dispersion du réticule n'en tient pas compte.
   */
  readonly fan?: number;
}

/**
 * Mine (voir combat/mines.ts). Les mines qui visent les robots au sol ont une portée préférée
 * (`engage`) courte : l'IA qui les porte tourne près de sa cible en les semant autour d'elle.
 * Posée, elle s'arme au bout de `armDelay` s, puis attend ce qui la
 * déclenche (`trigger`) : un robot ennemi au sol à moins de `radius` m (`ground`), un robot ennemi
 * en vol à moins de `radius` m (`air`), l'ordre de son poseur (`remote` : le joueur fait sauter
 * ses mines, l'IA dès qu'un ennemi est à moins de `radius` m), ou rien (`none` : un capteur).
 * Déclenchée, elle éclate sur place (explosion, impulsion électromagnétique, fumée : ce que porte
 * son projectile), ou fait ce que dit `action` : bondir à `height` m et y éclater, lancer un
 * projectile de l'arme `weapon` sur sa cible (un identifiant du catalogue : le type ne peut pas le
 * dire sans se citer lui-même, `tests/mines.test.ts` le vérifie), ou se coller à elle et éclater
 * `fuse` s plus tard.
 * Un capteur fait repérer à son équipe les ennemis à moins de `sense` m, à travers tout. Une
 * explosion proche fait sauter les mines (voir `blowMines`).
 */
/**
 * Tir réparateur : sur un allié, chaque bloc et roue à moins de `radius` m du point touché regagne
 * `amount` points, et un bloc détruit voisin repousse (combat/repair.ts). Sur un ennemi, `drain`
 * dégâts au bloc touché, dont la part `steal` répare le tireur (vol de vie) : il soigne un allié
 * plus qu'il n'abîme un ennemi.
 */
export interface RepairShot {
  readonly amount: number;
  readonly radius: number;
  readonly drain?: number;
  readonly steal?: number;
  /**
   * Nanites : elles se répandent sur tout le robot et remettent en état ses `swarm` blocs les plus
   * abîmés, où qu'ils soient ; le bloc perdu qu'elles font repousser aussi.
   */
  readonly swarm?: number;
}

/**
 * Mur d'énergie : le projectile file `reach` m (ou jusqu'à ce qu'il touche quelque chose) puis se
 * déploie en un rectangle vertical de `width` × `height` m, face au tireur, posé au sol, qui arrête
 * les tirs ennemis (et le souffle de leurs explosions) pendant `life` s ou jusqu'à perdre ses `hp`.
 */
export interface BarrierSpec {
  readonly width: number;
  readonly height: number;
  readonly hp: number;
  readonly life: number;
  readonly reach: number;
}

export interface MineSpec {
  readonly armDelay: number;
  readonly trigger: "ground" | "air" | "remote" | "none";
  readonly radius: number;
  readonly action?:
    | { readonly kind: "bounce"; readonly height: number }
    | { readonly kind: "launch"; readonly weapon: string }
    | { readonly kind: "stick"; readonly fuse: number };
  readonly sense?: number;
}

/** Impulsion électromagnétique : moteurs, rotors et tourelles coupés pendant `duration` s au centre, moitié moins au bord. */
export interface EmpPulse {
  readonly radius: number;
  readonly duration: number;
}

/** Nuage de fumée : il grandit jusqu'à `radius` (m) puis se dissipe au bout de `duration` s. */
export interface SmokeSpec {
  readonly radius: number;
  readonly duration: number;
}

/**
 * Allure d'une explosion (le client en fait son effet et choisit son bruit) : obus, missile,
 * roquette, obus de flak qui éclate en l'air, mine qui projette la terre, bombe, napalm, ogive, baril, gaz.
 */
export type ExplosionLook = "shell" | "missile" | "rocket" | "flak" | "mine" | "bomb" | "napalm" | "warhead" | "barrel" | "gas" | "car";

/** Explosion : dégâts de zone décroissants jusqu'au bord de `radius`, et souffle qui pousse les corps. */
export interface Explosion {
  /** Allure de l'explosion (effet et bruit côté client). */
  readonly look: ExplosionLook;
  /** Rayon de la zone de dégâts (m). */
  readonly radius: number;
  /** Dégâts au centre, décroissant linéairement jusqu'à 0 au bord. */
  readonly damage: number;
  /** Rayon du souffle (m). */
  readonly blastRadius: number;
  /** Impulsion du souffle au centre (N·s par bloc touché). */
  readonly power: number;
  /** Composante verticale ajoutée à la direction du souffle. */
  readonly lift: number;
  /** Probabilité d'enflammer chaque bloc resté entier dans la zone de dégâts. */
  readonly ignite?: number;
  /** Flaque de feu laissée au sol (napalm), sous l'explosion (voir combat/groundFires.ts). */
  readonly puddle?: GroundFireSpec;
}

/**
 * Flaque de feu au sol : un disque de `radius` m qui brûle `life` s ce qui s'y tient (blocs,
 * roues : dégâts `fire`, et il peut les enflammer), et allume le bois qui la touche.
 */
export interface GroundFireSpec {
  readonly radius: number;
  readonly life: number;
}

/**
 * Guidage d'un missile : `command`, il vise en continu le point que vise celui qui l'a tiré
 * (téléguidé) ; `homing`, il poursuit tout seul la cible choisie au départ (tête chercheuse) ;
 * `piloted`, le joueur qui l'a tiré en prend les commandes, la caméra au nez (voir sim/player.ts),
 * et l'IA le téléguide.
 */
export interface Guidance {
  readonly mode: "command" | "homing" | "piloted";
  /** Vitesse de virage maximale (rad/s). */
  readonly turnRate: number;
  /** Ne vise que les robots en vol (missile anti-aérien). */
  readonly airOnly?: boolean;
  /**
   * Départ (s) : le missile file d'abord droit dans l'axe de l'arme, propulseur allumé, puis son
   * guidage prend la main (il ne part pas d'emblée vers le point visé).
   */
  readonly launch?: number;
  /**
   * Missile qui a de l'élan (voir `steer`, combat/projectiles.ts) : il ne vire pas plus serré que
   * cette accélération latérale (m/s² ; plus il va vite, plus son virage est large), chaque virage
   * lui coûte cette part de sa vitesse par radian (`bleed`), et son moteur la lui rend à ce rythme
   * (`recover`, 1/s). Avec un peu de poids (`ProjectileSpec.gravity`), tiré vers le haut sur une
   * cible verrouillée derrière une colline, il monte sur son élan, la retrouve et plonge dessus ; une
   * cible qui vire sec au dernier moment peut lui échapper.
   */
  readonly maxAccel?: number;
  readonly bleed?: number;
  readonly recover?: number;
}

export const WEAPONS = {
  rifle: {
    cooldown: 0.16, automatic: true, spread: 0.003, recoil: 3, range: 45, engage: 22,
    handling: { hip: 3.3, move: 0.003, turn: 0.012 },
    heat: { perShot: 0.07, cooling: 0.25 }, // environ 5 s de rafale continue
    projectile: { look: "bullet", speed: 160, gravity: 1, life: 1.2, damage: 22, damageType: "kinetic", penetrating: false, impulse: 6 },
  },
  sniper: {
    cooldown: 2.2, automatic: false, spread: 0.0005, recoil: 40, range: 90, engage: 55, scopeOnly: true,
    handling: { hip: 1, move: 0.025, turn: 0.09 },
    ammo: { capacity: 6, reload: 4 },
    projectile: { look: "bullet", speed: 600, gravity: 1, life: 0.6, damage: 220, damageType: "pierce", penetrating: true, impulse: 25 },
  },
  cannon: {
    cooldown: 1.4, automatic: false, spread: 0.002, recoil: 80, range: 70, engage: 32,
    handling: { hip: 2, move: 0.004, turn: 0.02 },
    ammo: { capacity: 10, reload: 3 },
    projectile: {
      look: "shell", speed: 60, gravity: 1, life: 4, damage: 40, damageType: "kinetic", penetrating: false, impulse: 30,
      explosion: { look: "shell", radius: 1.2, damage: 120, blastRadius: 2.4, power: 3.2, lift: 0.35, ignite: 0.08 },
    },
  },
  missile: {
    cooldown: 3, automatic: false, spread: 0, recoil: 10, range: 80, engage: 40,
    handling: { hip: 1, move: 0, turn: 0 },
    ammo: { capacity: 3, reload: 8 },
    projectile: {
      look: "missile", speed: 28, gravity: 0, life: 7, damage: 70, damageType: "explosive", penetrating: false, impulse: 20, hull: { radius: 0.4, hp: 45 },
      explosion: { look: "missile", radius: 1.4, damage: 150, blastRadius: 3.2, power: 5, lift: 0.4, ignite: 0.2 },
      guidance: { mode: "command", turnRate: 2.2, launch: 0.35 },
    },
  },
  flak: {
    cooldown: 2.5, automatic: false, spread: 0, recoil: 10, range: 70, engage: 35,
    handling: { hip: 1, move: 0, turn: 0 },
    ammo: { capacity: 4, reload: 5 },
    projectile: {
      look: "missile", speed: 45, gravity: 0.2, life: 5, damage: 60, damageType: "explosive", penetrating: false, impulse: 15, hull: { radius: 0.4, hp: 30 },
      explosion: { look: "flak", radius: 2.2, damage: 90, blastRadius: 4, power: 4, lift: 0.2, ignite: 0.1 },
      guidance: { mode: "homing", turnRate: 4.5, airOnly: true, launch: 0.2, maxAccel: 110, bleed: 0.2, recover: 2 },
      proximity: 2.5,
    },
  },
  mine: {
    cooldown: 2, automatic: false, spread: 0, recoil: 0, range: 14,
    handling: { hip: 1, move: 0, turn: 0 },
    ammo: { capacity: 5, reload: 8 },
    projectile: {
      look: "mine", speed: 3, gravity: 1, life: 90, damage: 0, damageType: "explosive", penetrating: false, impulse: 0, hull: { radius: 0.35, hp: 30 },
      explosion: { look: "mine", radius: 1.8, damage: 220, blastRadius: 4, power: 9, lift: 1.2, ignite: 0.3 },
      mine: { armDelay: 1.5, trigger: "ground", radius: 1.8 },
    },
  },
  /** Jet de flammes : de petites gouttes brûlantes, à courte portée, qui mettent le feu aux blocs. */
  flamer: {
    cooldown: 0.07, automatic: true, spread: 0.07, recoil: 0.3, range: 11, engage: 6,
    handling: { hip: 1, move: 0, turn: 0 },
    heat: { perShot: 0.032, cooling: 0.2 }, // environ 4 s de jet continu
    projectile: {
      look: "flame", speed: 15, gravity: 0.1, life: 0.8, damage: 5, damageType: "fire", penetrating: false, impulse: 0.3,
      ignite: 0.12, puddle: { radius: 0.9, life: 4, chance: 0.3 },
    },
  },
  /** Obus électromagnétique : peu de dégâts, mais les robots proches de l'impact sont paralysés. */
  emp: {
    cooldown: 4, automatic: false, spread: 0.0027, recoil: 12, range: 55, engage: 22,
    handling: { hip: 1.5, move: 0.004, turn: 0.015 },
    ammo: { capacity: 2, reload: 12 },
    projectile: {
      look: "orb", speed: 40, gravity: 0.25, life: 3, damage: 10, damageType: "kinetic", penetrating: false, impulse: 4,
      emp: { radius: 4.5, duration: 4 },
    },
  },
  /** Grenade fumigène : un écran de fumée qui coupe la vue, pour couvrir une fuite. */
  smoke: {
    cooldown: 5, automatic: false, spread: 0.008, recoil: 4, range: 40,
    handling: { hip: 1.25, move: 0.002, turn: 0.005 },
    ammo: { capacity: 3, reload: 10 },
    projectile: {
      look: "grenade", speed: 24, gravity: 1, life: 3, damage: 0, damageType: "kinetic", penetrating: false, impulse: 2,
      smoke: { radius: 6, duration: 14 },
    },
  },
  /**
   * Laser : un rayon continu, parfaitement précis, qui chauffe vite et puise un peu dans les
   * batteries. Ses dégâts (`energy`) passent le blindage lourd comme un autre : c'est l'arme
   * contre les robots cuirassés.
   */
  laser: {
    cooldown: 0.1, automatic: true, spread: 0.001, recoil: 0.4, range: 60, engage: 30, power: 0.15,
    handling: { hip: 2, move: 0.0015, turn: 0.006 },
    heat: { perShot: 0.05, cooling: 0.3 }, // environ 3 s de tir continu
    projectile: { look: "beam", speed: 500, gravity: 0, life: 0.14, damage: 16, damageType: "energy", penetrating: false, impulse: 0.4, ignite: 0.01 },
  },
  /**
   * Canon électrique : un projectile lancé à 1 200 m/s qui traverse plusieurs blocs, avec un fort
   * recul. Pas de chargeur : chaque tir vide une bonne part des batteries (la batterie du cockpit
   * en tient deux ; le générateur en recharge un en un peu plus de huit secondes).
   */
  rail: {
    cooldown: 3, automatic: false, spread: 0.0003, recoil: 70, range: 100, engage: 50, power: 10,
    handling: { hip: 6, move: 0.012, turn: 0.05 },
    projectile: { look: "rail", speed: 1200, gravity: 0, life: 0.12, damage: 380, damageType: "pierce", penetrating: true, impulse: 70 },
  },
  /**
   * Fusil à pompe : une gerbe de neuf plombs, dévastatrice au contact (180 dégâts si tout touche),
   * qui s'éparpille au loin ; un chargeur de six cartouches, rechargées une à une.
   */
  shotgun: {
    cooldown: 0.9, automatic: false, spread: 0.004, recoil: 30, range: 22, engage: 9,
    handling: { hip: 1.5, move: 0.002, turn: 0.008 },
    ammo: { capacity: 6, reload: 1.4 },
    projectile: {
      look: "pellet", speed: 150, gravity: 1, life: 0.3, damage: 20, damageType: "kinetic", penetrating: false, impulse: 5,
      pellets: { count: 9, spread: 0.075 },
    },
  },
  /**
   * Lance-roquettes : une salve de mini-missiles qui partent en éventail puis filent vers le point
   * visé ; huit dans le panier, rechargées une à une, lentement.
   */
  rockets: {
    cooldown: 0.12, automatic: true, spread: 0.01, recoil: 4, range: 55, engage: 28,
    handling: { hip: 1.3, move: 0.001, turn: 0.004 },
    ammo: { capacity: 8, reload: 1.1 },
    projectile: {
      look: "rocket", speed: 45, gravity: 0, life: 2.2, damage: 20, damageType: "explosive", penetrating: false, impulse: 6, hull: { radius: 0.3, hp: 12 },
      explosion: { look: "rocket", radius: 0.9, damage: 55, blastRadius: 1.8, power: 1.5, lift: 0.2, ignite: 0.05 },
      guidance: { mode: "command", turnRate: 2.2, launch: 0.15 },
      fan: 0.16,
    },
  },
  /**
   * Projecteur de plasma : un jet continu de plasma brûlant, à courte portée, qui passe le
   * blindage lourd et met le feu ; il chauffe vite (3,5 s de jet) et puise dans les batteries.
   */
  plasma: {
    cooldown: 0.05, automatic: true, spread: 0.012, recoil: 0.5, range: 26, engage: 14, power: 0.08,
    handling: { hip: 1.2, move: 0.001, turn: 0.004 },
    heat: { perShot: 0.025, cooling: 0.22 },
    projectile: { look: "plasma", speed: 60, gravity: 0, life: 0.45, damage: 13, damageType: "energy", penetrating: false, impulse: 0.8, ignite: 0.04 },
  },
  /**
   * Ogive pilotée : un seul coup par vie, une énorme explosion. Le pilote en prend les commandes,
   * la caméra au nez : il la dirige à la souris et la fait exploser d'un clic (elle explose aussi
   * au contact, ou au bout de 14 s) ; pendant ce temps, son robot s'arrête et ses armes se taisent.
   * Pas de portée préférée : l'IA ne se place pas pour elle, ni ne se met à couvert pour la recharger.
   */
  warhead: {
    cooldown: 2, automatic: false, spread: 0, recoil: 40, range: 120, minRange: 20,
    handling: { hip: 1, move: 0, turn: 0 },
    ammo: { capacity: 1, reload: Infinity },
    projectile: {
      look: "warhead", speed: 24, gravity: 0, life: 14, damage: 250, damageType: "explosive", penetrating: false, impulse: 60, hull: { radius: 0.6, hp: 150 },
      explosion: { look: "warhead", radius: 5, damage: 550, blastRadius: 9, power: 25, lift: 1.5, ignite: 0.5 },
      guidance: { mode: "piloted", turnRate: 1.3, launch: 0.4 },
    },
  },
  /**
   * Missiles à verrouillage : il faut garder l'ennemi dans le viseur 1,2 s ; ensuite, une salve de
   * quatre missiles le poursuit où qu'il aille (tête chercheuse), même hors de vue.
   */
  lockon: {
    cooldown: 0.35, automatic: true, spread: 0, recoil: 8, range: 80, engage: 45,
    handling: { hip: 1, move: 0, turn: 0 },
    ammo: { capacity: 4, reload: 6 },
    lock: { time: 1.2, cone: 0.1 },
    projectile: {
      // Lourd et vif à la fois : tiré vers le haut, il passe par-dessus un mur ou une colline et plonge
      // sur sa cible verrouillée ; une cible qui file droit est touchée, un écart franc à 10-15 m le fait
      // rater (mesuré par tests/missileSight.test.ts)
      look: "missile", speed: 38, gravity: 0.6, life: 6, damage: 45, damageType: "explosive", penetrating: false, impulse: 12, hull: { radius: 0.4, hp: 35 },
      explosion: { look: "missile", radius: 1.3, damage: 110, blastRadius: 3, power: 4, lift: 0.3, ignite: 0.1 },
      guidance: { mode: "homing", turnRate: 3.2, launch: 0.3, maxAccel: 60, bleed: 0.6, recover: 1.5 },
    },
  },
  /**
   * Bombes : une soute sous un avion les lâche en chapelet tant que la gâchette est tenue (huit
   * dans la soute, rechargées une à une). Elles tombent en gardant la vitesse de l'appareil : il
   * faut les lâcher avant d'être au-dessus de la cible. Elles explosent au sol, largement.
   */
  bombs: {
    cooldown: 0.25, automatic: true, spread: 0.01, recoil: 0, range: 80, dropped: true,
    handling: { hip: 1, move: 0, turn: 0 },
    ammo: { capacity: 8, reload: 2.5 },
    projectile: {
      look: "bomb", speed: 1.5, gravity: 1, life: 10, damage: 60, damageType: "explosive", penetrating: false, impulse: 20, hull: { radius: 0.35, hp: 40 },
      explosion: { look: "bomb", radius: 2.4, damage: 170, blastRadius: 4.5, power: 8, lift: 0.9, ignite: 0.2 },
    },
  },
  /** Mine IEM : elle ne détruit rien, mais paralyse 4 s les robots autour d'elle. */
  empMine: {
    cooldown: 2, automatic: false, spread: 0, recoil: 0, range: 14, engage: 12,
    handling: { hip: 1, move: 0, turn: 0 },
    ammo: { capacity: 4, reload: 10 },
    projectile: {
      look: "mine", speed: 3, gravity: 1, life: 90, damage: 0, damageType: "explosive", penetrating: false, impulse: 0, hull: { radius: 0.35, hp: 30 },
      emp: { radius: 5, duration: 4 },
      mine: { armDelay: 1.5, trigger: "ground", radius: 2 },
    },
  },
  /** Mine incendiaire : une boule de feu qui fait peu de dégâts mais embrase presque tous les blocs autour. */
  fireMine: {
    cooldown: 2, automatic: false, spread: 0, recoil: 0, range: 14, engage: 12,
    handling: { hip: 1, move: 0, turn: 0 },
    ammo: { capacity: 5, reload: 8 },
    projectile: {
      look: "mine", speed: 3, gravity: 1, life: 90, damage: 0, damageType: "explosive", penetrating: false, impulse: 0, hull: { radius: 0.35, hp: 30 },
      explosion: { look: "napalm", radius: 3, damage: 50, blastRadius: 3.5, power: 3, lift: 0.6, ignite: 0.9, puddle: { radius: 2.4, life: 7 } },
      mine: { armDelay: 1.5, trigger: "ground", radius: 2 },
    },
  },
  /** Mine fumigène : un écran de fumée quand un poursuivant passe dessus (l'IA la sème en fuyant). */
  smokeMine: {
    cooldown: 2, automatic: false, spread: 0, recoil: 0, range: 20,
    handling: { hip: 1, move: 0, turn: 0 },
    ammo: { capacity: 3, reload: 12 },
    projectile: {
      look: "mine", speed: 3, gravity: 1, life: 90, damage: 0, damageType: "kinetic", penetrating: false, impulse: 0, hull: { radius: 0.35, hp: 30 },
      smoke: { radius: 7, duration: 14 },
      mine: { armDelay: 1, trigger: "ground", radius: 2.5 },
    },
  },
  /** Mine bondissante : elle saute à hauteur de caisse avant d'éclater, et frappe le corps et les tourelles plutôt que les roues. */
  bounceMine: {
    cooldown: 2, automatic: false, spread: 0, recoil: 0, range: 14, engage: 12,
    handling: { hip: 1, move: 0, turn: 0 },
    ammo: { capacity: 5, reload: 8 },
    projectile: {
      look: "mine", speed: 3, gravity: 1, life: 90, damage: 0, damageType: "explosive", penetrating: false, impulse: 0, hull: { radius: 0.35, hp: 30 },
      explosion: { look: "flak", radius: 2.4, damage: 160, blastRadius: 4, power: 5, lift: 0.2, ignite: 0.1 },
      mine: { armDelay: 1.5, trigger: "ground", radius: 2.4, action: { kind: "bounce", height: 1.6 } },
    },
  },
  /** Mine anti-aérienne : posée au sol, elle tire un missile anti-aérien sur un robot en vol qui passe au-dessus d'elle. */
  aaMine: {
    cooldown: 2.5, automatic: false, spread: 0, recoil: 0, range: 30,
    handling: { hip: 1, move: 0, turn: 0 },
    ammo: { capacity: 3, reload: 12 },
    projectile: {
      look: "mine", speed: 3, gravity: 1, life: 120, damage: 0, damageType: "explosive", penetrating: false, impulse: 0, hull: { radius: 0.35, hp: 30 },
      mine: { armDelay: 2, trigger: "air", radius: 16, action: { kind: "launch", weapon: "flak" } },
    },
  },
  /** Mine télécommandée : aucun détecteur ; son poseur la fait sauter quand il veut (touche E). */
  remoteMine: {
    cooldown: 1.5, automatic: false, spread: 0, recoil: 0, range: 14, engage: 12,
    handling: { hip: 1, move: 0, turn: 0 },
    ammo: { capacity: 4, reload: 8 },
    projectile: {
      look: "mine", speed: 3, gravity: 1, life: 120, damage: 0, damageType: "explosive", penetrating: false, impulse: 0, hull: { radius: 0.35, hp: 30 },
      explosion: { look: "mine", radius: 2.2, damage: 260, blastRadius: 5, power: 10, lift: 1.2, ignite: 0.3 },
      mine: { armDelay: 1, trigger: "remote", radius: 2.2 },
    },
  },
  /** Mine capteur : elle n'explose pas ; son équipe repère les ennemis qui passent à moins de 14 m, à travers les murs. */
  sensorMine: {
    cooldown: 3, automatic: false, spread: 0, recoil: 0, range: 45,
    handling: { hip: 1, move: 0, turn: 0 },
    ammo: { capacity: 3, reload: 15 },
    projectile: {
      look: "mine", speed: 3, gravity: 1, life: 120, damage: 0, damageType: "kinetic", penetrating: false, impulse: 0, hull: { radius: 0.35, hp: 30 },
      mine: { armDelay: 1, trigger: "none", radius: 0, sense: 14 },
    },
  },
  /** Mine ventouse : elle se colle au robot qui passe dessus et éclate 2 s plus tard, même s'il continue de rouler. */
  stickyMine: {
    cooldown: 2, automatic: false, spread: 0, recoil: 0, range: 14, engage: 12,
    handling: { hip: 1, move: 0, turn: 0 },
    ammo: { capacity: 4, reload: 9 },
    projectile: {
      look: "mine", speed: 3, gravity: 1, life: 90, damage: 0, damageType: "explosive", penetrating: false, impulse: 0, hull: { radius: 0.35, hp: 30 },
      explosion: { look: "missile", radius: 1.4, damage: 240, blastRadius: 3, power: 6, lift: 0.4, ignite: 0.2 },
      mine: { armDelay: 1.5, trigger: "ground", radius: 1.6, action: { kind: "stick", fuse: 2 } },
    },
  },
  /**
   * Rayon réparateur : un faisceau continu qui remet en état les blocs d'un allié autour du point
   * touché (pas les blocs détruits) ; il chauffe et puise dans les batteries. Sans effet sur un ennemi.
   */
  /**
   * Leurre : éjecté par salves de quatre par un lance-leurres (ce n'est pas une arme de tourelle :
   * voir combat/decoys.ts), il brûle 3,5 s en retombant lentement ; les missiles ennemis qui le
   * voient peuvent le suivre.
   */
  flare: {
    cooldown: 1.5, automatic: false, spread: 0.2, recoil: 0, range: 0,
    handling: { hip: 1, move: 0, turn: 0 },
    projectile: {
      look: "flare", speed: 11, gravity: 0.25, life: 3.5, damage: 0, damageType: "fire", penetrating: false, impulse: 0,
      decoy: true, pellets: { count: 4, spread: 0.55 },
    },
  },
  repair: {
    cooldown: 0.1, automatic: true, spread: 0.002, recoil: 0, range: 24, power: 0.12,
    handling: { hip: 1.5, move: 0.002, turn: 0.006 },
    heat: { perShot: 0.025, cooling: 0.2 }, // environ 5 s de réparation continue
    projectile: {
      look: "repair", speed: 400, gravity: 0, life: 0.1, damage: 0, damageType: "energy", penetrating: false, impulse: 0,
      repair: { amount: 7, radius: 1.2, drain: 6, steal: 0.8 },
    },
  },
  nanites: {
    cooldown: 1.2, automatic: true, spread: 0.08, recoil: 0, range: 40, power: 1.5, autoSupport: true,
    handling: { hip: 1, move: 0, turn: 0 },
    projectile: {
      look: "nanites", speed: 20, gravity: 0, life: 3.5, damage: 0, damageType: "energy", penetrating: false, impulse: 0,
      guidance: { mode: "homing", turnRate: 5 },
      repair: { amount: 30, radius: 1.6, swarm: 8 },
    },
  },
  barrier: {
    cooldown: 12, automatic: false, spread: 0, recoil: 0, range: 30, power: 6,
    handling: { hip: 1, move: 0, turn: 0 },
    projectile: {
      look: "barrier", speed: 30, gravity: 0, life: 0.3, damage: 0, damageType: "energy", penetrating: false, impulse: 0,
      barrier: { width: 4.5, height: 2.8, hp: 700, life: 10, reach: 5 },
    },
  },
} as const satisfies Record<string, Weapon>;

export type WeaponId = keyof typeof WEAPONS;

/** Les armes qui posent des mines (TypeScript le déduit du catalogue). */
export type MineWeaponId = { [K in WeaponId]: (typeof WEAPONS)[K]["projectile"] extends { mine: MineSpec } ? K : never }[WeaponId];

/** Les armes dans l'ordre de leurs touches (1, 2, …). */
export const WEAPON_IDS = Object.keys(WEAPONS) as WeaponId[];

/**
 * Ce qui a détruit un robot, pour le fil des destructions : une arme (de tourelle ou de contact,
 * catalog/melee.ts), un choc (`impact`), le feu,
 * le souffle d'un accessoire qui explose (`blast`), un sabordage (`self`), la lave (`lava`), la
 * noyade (`drown` : voir sim/hazards.ts) ou le jet de flamme d'un moteur (`exhaust` : voir
 * combat/scorch.ts).
 */
export type KillCause = WeaponId | MeleeId | "impact" | "fire" | "blast" | "self" | "lava" | "drown" | "exhaust";

export const isWeaponId = (value: string): value is WeaponId => Object.hasOwn(WEAPONS, value);

/** Caractéristiques d'une arme, avec les champs optionnels accessibles. */
export const weaponDef = (id: WeaponId): Weapon => WEAPONS[id];

/**
 * L'arme tire-t-elle en cloche (canon, obus IEM, fumigène) ? Un projectile lent, soumis à la
 * pesanteur, ni guidé, ni posé, ni largué. Le joueur en choisit la hausse (combat/ballistics.ts).
 */
export function lobbed(weapon: Weapon): boolean {
  const p = weapon.projectile;
  return p.gravity >= 0.2 && p.speed <= 100 && !p.guidance && !p.mine && !weapon.dropped;
}

/** Arme qui lâche ses projectiles sans viser, d'une tourelle fixe : poseurs de mines, soute à bombes. */
export const released = (weapon: Weapon): boolean => !!weapon.projectile.mine || !!weapon.dropped;

/** Dégâts d'une explosion reçus à `distance` (m) de son centre. */
export function explosionDamageAt(explosion: Explosion, distance: number): number {
  if (distance >= explosion.radius) return 0;
  return explosion.damage * (1 - distance / explosion.radius);
}
