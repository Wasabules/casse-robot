import { fromFiles } from "./content";
import type { MeleeId } from "./melee";
import aaMine from "../../../content/weapons/aaMine.json";
import barrier from "../../../content/weapons/barrier.json";
import bombs from "../../../content/weapons/bombs.json";
import bounceMine from "../../../content/weapons/bounceMine.json";
import cannon from "../../../content/weapons/cannon.json";
import emp from "../../../content/weapons/emp.json";
import empMine from "../../../content/weapons/empMine.json";
import fireMine from "../../../content/weapons/fireMine.json";
import flak from "../../../content/weapons/flak.json";
import flamer from "../../../content/weapons/flamer.json";
import flare from "../../../content/weapons/flare.json";
import laser from "../../../content/weapons/laser.json";
import lockon from "../../../content/weapons/lockon.json";
import mine from "../../../content/weapons/mine.json";
import missile from "../../../content/weapons/missile.json";
import nanites from "../../../content/weapons/nanites.json";
import plasma from "../../../content/weapons/plasma.json";
import rail from "../../../content/weapons/rail.json";
import remoteMine from "../../../content/weapons/remoteMine.json";
import repair from "../../../content/weapons/repair.json";
import rifle from "../../../content/weapons/rifle.json";
import rockets from "../../../content/weapons/rockets.json";
import sensorMine from "../../../content/weapons/sensorMine.json";
import shotgun from "../../../content/weapons/shotgun.json";
import smoke from "../../../content/weapons/smoke.json";
import smokeMine from "../../../content/weapons/smokeMine.json";
import sniper from "../../../content/weapons/sniper.json";
import stickyMine from "../../../content/weapons/stickyMine.json";
import warhead from "../../../content/weapons/warhead.json";

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
 * sa vitesse et la gravité, se guide éventuellement, perce ou explose à l'impact. Chaque arme est
 * un fichier de données (content/weapons/<id>.json : voir catalog/content.ts), et a aussi une allure à l'écran (`PROJECTILE_LOOKS` dans client/render/projectiles.ts) et
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

/**
 * Les armes, un fichier chacune (content/weapons/<id>.json, qui suit content/schemas/weapons.schema.json),
 * dans l'ordre de leurs touches : leurs noms font `WeaponId`.
 */
const FILES = {
  rifle, sniper, cannon, missile, flak, mine, flamer, emp, smoke, laser, rail, shotgun, rockets, plasma, warhead, lockon, bombs, empMine,
  fireMine, smokeMine, bounceMine, aaMine, remoteMine, sensorMine, stickyMine, flare, repair, nanites, barrier,
};

export type WeaponId = keyof typeof FILES;

/**
 * Une arme d'après son fichier : un rechargement `null` (elle ne se recharge jamais : l'ogive, un
 * coup par vie) devient l'infini, que JSON ne sait pas écrire.
 */
function weaponOf(data: Record<string, unknown>): Weapon {
  const weapon = data as unknown as Weapon;
  const ammo = weapon.ammo as { readonly capacity: number; readonly reload: number | null } | undefined;
  return ammo?.reload === null ? { ...weapon, ammo: { ...ammo, reload: Infinity } } : weapon;
}

/** Les armes, lues de leurs fichiers. */
export const WEAPONS = fromFiles<typeof FILES, Weapon>(FILES, weaponOf);

/**
 * Les armes qui posent des mines : TypeScript le déduit des fichiers (le projectile d'une arme à
 * mines a un champ `mine`).
 */
export type MineWeaponId = { [K in WeaponId]: (typeof FILES)[K]["projectile"] extends { mine: object } ? K : never }[WeaponId];

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
