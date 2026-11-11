import type { ArenaKey } from "../arena/layout";
import type { ExplosionLook, KillCause, WeaponId } from "../catalog/weapons";
import type { Vec3 } from "../math/vec";
import type { Barrier, Block, Bot, Debris, GroundFire, Part, Projectile, Prop, SmokeCloud, Team, Wheel } from "./entities";

/**
 * Changements du monde, émis au moment où ils se produisent. Le rendu crée et détruit ses
 * meshes et ses effets à partir de ces événements ; les poses, elles, se lisent directement
 * sur les corps à chaque image. Plus tard, le serveur enverra ces mêmes événements aux clients.
 */
/** Ce que touche un projectile : un robot (bloc ou roue), un accessoire, ou le décor (sol, murs). */
export type ImpactSurface = "robot" | "prop" | "scenery" | "projectile";

/** Ce que fait une mine, pour le son : bondir, se coller, signaler un ennemi. */
export type MineAction = "bounce" | "stick" | "ping";

export type SimEvent =
  | { type: "botAdded"; bot: Bot }
  | { type: "botRemoved"; bot: Bot }
  | { type: "partAdded"; part: Part }
  /** Les blocs encore présents dans `part.blocks` disparaissent avec le morceau. */
  | { type: "partRemoved"; part: Part }
  /** Bloc créé, ou déplacé vers un autre morceau (`block.part`) lors d'une séparation. */
  | { type: "blockAttached"; block: Block }
  /** Bloc touché qui a perdu des points de structure (`block.hp`) sans être détruit. */
  | { type: "blockDamaged"; block: Block }
  /** Bloc remis en état (en partie) par un module de réparation. */
  | { type: "blockRepaired"; block: Block }
  | { type: "blockDestroyed"; block: Block }
  /** Un bloc détruit repousse (réparation) : il revient sur le morceau du cockpit (`block.part`), avec `block.hp`. */
  | { type: "blockRebuilt"; block: Block }
  | { type: "wheelAdded"; wheel: Wheel }
  | { type: "wheelRemoved"; wheel: Wheel }
  | { type: "debrisAdded"; debris: Debris }
  | { type: "debrisRemoved"; debris: Debris }
  | { type: "propAdded"; prop: Prop }
  | { type: "propRemoved"; prop: Prop }
  /** Un accessoire ancré est libéré : un arbre qui bascule, un toit qui n'est plus porté. */
  | { type: "propReleased"; prop: Prop }
  /**
   * Le feu d'un accessoire en bois change : il prend feu ou s'éteint (`prop.burn` > 0 ou non), ou
   * il noircit d'un cran (`prop.charred`). Un accessoire retiré en brûlant n'a pas d'extinction.
   */
  | { type: "propFire"; prop: Prop }
  /** Une flaque de feu s'allume au sol (lance-flammes, napalm), ou s'éteint. */
  | { type: "groundFireAdded"; fire: GroundFire }
  | { type: "groundFireRemoved"; fire: GroundFire }
  | { type: "projectileAdded"; projectile: Projectile }
  | { type: "projectileRemoved"; projectile: Projectile }
  /** Départ d'un tir, pour la lueur à la bouche du canon. */
  | { type: "shot"; weapon: WeaponId; origin: Vec3; dir: Vec3 }
  /** Une mine bondit, se colle à un robot, ou (capteur) signale un ennemi (pour le son). */
  | { type: "mine"; projectile: Projectile; action: MineAction }
  /** Impact sans explosion (étincelles), et ce qu'il touche (pour son bruit). */
  | { type: "impact"; point: Vec3; surface: ImpactSurface }
  | { type: "explosion"; point: Vec3; radius: number; look: ExplosionLook }
  /**
   * Coup d'une arme de contact (combat/melee.ts) : `block`, le bloc de l'arme ; `point`, où la lame
   * ou la tête frappe ; `dir`, le sens de l'impulsion donnée ; `energy`, l'énergie du coup (J) ; ce
   * qu'elle frappe (un robot, un accessoire, le décor) ; `glance` : elle a ricoché (glacis rasant).
   */
  | { type: "meleeHit"; block: Block; point: Vec3; dir: Vec3; energy: number; surface: ImpactSurface; glance: boolean }
  /** Choc violent entre deux corps (au-delà de ce qu'ils encaissent sans dégâts) ; `strength` : dégâts infligés. */
  | { type: "collision"; point: Vec3; strength: number }
  /** Une liaison faible a rompu en `point` : une partie du robot s'en détache. */
  | { type: "linkBroken"; point: Vec3 }
  /** Un bloc prend feu ; il s'éteint (`fireEnded`) ou il est détruit (`blockDestroyed`). */
  | { type: "fireStarted"; block: Block }
  | { type: "fireEnded"; block: Block }
  /** Impulsion électromagnétique en `point`, et robot paralysé jusqu'à `until` (temps simulé). */
  | { type: "empBurst"; point: Vec3; radius: number }
  | { type: "stunned"; bot: Bot; until: number }
  /**
   * Paralysie locale (lance électrique, combat/emp.ts) : ces blocs et ces roues de `bot` sont coupés
   * jusqu'à `until` (temps simulé) ; `point` : où la décharge a frappé (null : un état décrit à un
   * joueur qui arrive).
   */
  | { type: "organsStunned"; bot: Bot; blocks: Block[]; wheels: Wheel[]; until: number; point: Vec3 | null }
  /** Un générateur de bouclier a absorbé des dégâts : un éclat autour de lui. */
  | { type: "shieldHit"; block: Block }
  /** Un mur d'énergie est déployé, encaisse un tir en `point`, disparaît (brisé ou éteint). */
  | { type: "barrierAdded"; barrier: Barrier }
  | { type: "barrierHit"; barrier: Barrier; point: Vec3 }
  | { type: "barrierRemoved"; barrier: Barrier; broken: boolean }
  | { type: "smokeAdded"; cloud: SmokeCloud }
  | { type: "smokeRemoved"; cloud: SmokeCloud }
  /**
   * Un tir (projectile ou explosion d'une arme) a touché ce robot : `attacker`, le robot qui a tiré
   * (null : la caméra libre), et le nombre de ses blocs détruits. Sert au retour de tir du joueur.
   */
  | { type: "hit"; victim: Bot; attacker: Bot | null; cause: KillCause | null; destroyed: number }
  /** Le cockpit d'un robot est détruit : il est hors de combat. `killer` : le dernier ennemi qui l'a touché. */
  | { type: "botKilled"; bot: Bot; killer: Bot | null; cause: KillCause | null }
  /** Le décor a changé : une autre arène (les accessoires sont remis à leurs places), que `World.arena` donne déjà. */
  | { type: "arenaChanged"; arena: ArenaKey }
  /** Une zone à capturer (rang dans l'arène) change de mains : prise (`owner`) ou neutralisée (null) par l'équipe `by`. */
  | { type: "zoneChanged"; zone: number; owner: Team | null; by: Team }
  /** Fin de la partie : l'équipe gagnante, ou « draw » en cas d'égalité. */
  | { type: "matchOver"; winner: Team | "draw" }
  /** Fin d'un impact ou d'une explosion : les robots touchés ont déjà réagi. */
  | { type: "damage"; bots: Bot[] };

export type SimListener = (event: SimEvent) => void;
