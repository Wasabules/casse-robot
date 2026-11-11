import type { Collider, RigidBody } from "@dimforge/rapier3d-compat";
import type { BlockType } from "../catalog/blocks";
import type { MeleeId } from "../catalog/melee";
import type { PropType } from "../catalog/props";
import type { KillCause, WeaponId } from "../catalog/weapons";
import type { WheelType } from "../catalog/wheels";
import type { BotProfile } from "../design/presets";
import type { ImpactSurface } from "./events";
import type { PlayerInput } from "./player";
import type { Quat, Vec3 } from "../math/vec";

/*
 * État de la simulation. Chaque entité a un `id` unique dans sa Simulation : le rendu
 * s'en sert pour retrouver ses meshes, le réseau s'en servira pour nommer les entités.
 */

export interface Block {
  readonly id: number;
  readonly bot: Bot;
  /** Clé de grille "x,y,z". */
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly type: BlockType;
  /** Position dans le repère local du robot (m). Ce repère est commun à tous ses morceaux. */
  readonly local: Vec3;
  /** Orientation du bloc dans le repère du robot : son haut et son avant (unitaires), et la rotation correspondante. */
  readonly up: Vec3;
  readonly forward: Vec3;
  readonly rot: Quat;
  /** Morceau qui porte le bloc (le dernier, s'il est détruit). */
  part: Part;
  /** Points de structure restants (au départ, ceux de son type). */
  hp: number;
  alive: boolean;
  /** Temps de feu restant (s) ; 0 : il ne brûle pas (voir combat/fire.ts). */
  burn: number;
  /**
   * Paralysie locale (lance électrique, voir combat/emp.ts) : jusqu'à cet instant (temps simulé),
   * l'organe que porte le bloc (moteur, appui, tourelle, arme de contact, bouclier) est coupé.
   */
  stunnedUntil: number;
}

/**
 * Morceau de robot : un seul corps rigide. Ses colliders fusionnent les blocs voisins de même
 * type en grandes boîtes (voir robot/colliders.ts) ; `dirty` : ses blocs ont changé depuis.
 */
export interface Part {
  readonly id: number;
  readonly bot: Bot;
  readonly rb: RigidBody;
  readonly blocks: Set<Block>;
  colliders: Collider[];
  dirty: boolean;
  /** Liaisons faibles du morceau (voir robot/structure.ts), calculées à la demande ; null : à recalculer. */
  links: WeakLink[] | null;
  /** Zones touchables des têtes de ses tourelles (voir robot/colliders.ts), refaites avec ses colliders. */
  heads: TurretHitbox[];
  /** Zones touchables des lames et des bras de ses armes de contact (robot/colliders.ts), refaites avec ses colliders. */
  blades: MeleeHitbox[];
}

/**
 * Zone touchable d'une arme de contact : les bras de sa lame (une barre, une hélice : ils tournent
 * avec elle), tout ce qu'elle balaie (un disque, un tambour, un anneau), ou la tête de son bras, sans
 * masse et sans contact ; un tir qui la touche frappe le bloc de l'arme. L'angle du rotor et celui du
 * bras où on les a posés pour la dernière fois (`syncHeads`).
 */
export interface MeleeHitbox {
  readonly arm: MeleeArm;
  readonly colliders: Collider[];
  /** La zone tourne-t-elle avec le rotor (des bras), ou suit-elle un bras ? Sinon, elle ne bouge pas. */
  readonly moves: "rotor" | "swing" | null;
  angle: number;
  swing: number;
}

/**
 * Zone touchable d'une tête de tourelle : un pavé pour la tête et un cylindre pour son canon, sans
 * masse et sans contact, qui suivent son lacet et son site (`syncHeads`) ; un tir qui les touche
 * frappe le bloc de la tourelle. Le lacet et le site où on les a posés pour la dernière fois.
 */
export interface TurretHitbox {
  readonly turret: Turret;
  readonly head: Collider;
  readonly barrel: Collider | null;
  yaw: number;
  pitch: number;
}

/**
 * Liaison faible : le seul contact entre deux ensembles de blocs d'un morceau (un col, un bras
 * d'un seul bloc de large). Un choc qui la sollicite trop la rompt, et le côté détachable part.
 */
export interface WeakLink {
  /** Clé de la liaison (voir `linkKey`). */
  readonly key: string;
  /** Bloc du côté qui reste (celui du cockpit, ou le plus gros), et bloc du côté détachable. */
  readonly inner: Block;
  readonly outer: Block;
  /** Blocs du côté détachable, leur masse (kg) et leur centre de masse (repère local du robot). */
  readonly beyond: ReadonlySet<Block>;
  readonly mass: number;
  readonly com: Vec3;
  /** Milieu de la face commune (repère local du robot). */
  readonly joint: Vec3;
  /** Choc supporté (N·m·s). */
  readonly strength: number;
}

/**
 * Roue suspendue, motorisée, directrice ou fixe. Montée, elle n'a ni corps ni liaison : sa
 * suspension, sa traction et son adhérence sont calculées à chaque pas par un lancer de rayon
 * (robot/wheels.ts), et sa pose en est déduite. Arrachée, elle devient un corps libre.
 */
export interface Wheel {
  readonly id: number;
  readonly bot: Bot;
  readonly type: WheelType;
  /** Roue directrice (elle braque) ou roue fixe. */
  readonly steerable: boolean;
  /** Clé de grille du bloc support. */
  readonly mountKey: string;
  /** 1 à gauche (x local > 0), -1 à droite, 0 au centre. */
  readonly side: number;
  /** Position du centre de la roue au repos, dans le repère local du robot. */
  readonly local: Vec3;
  /**
   * Pose de la roue (sa rotation sur l'essieu comprise) : calculée à chaque pas tant qu'elle est
   * montée (voir robot/wheels.ts) ; une fois arrachée, c'est son corps libre.
   */
  rb: WheelBody;
  /** Pose du porte-moyeu (la roue sans sa rotation sur l'essieu) ; null une fois la roue arrachée. */
  hub: WheelBody | null;
  /** Corps libre de la roue arrachée ; null tant qu'elle est montée. */
  body: RigidBody | null;
  /**
   * Instant (temps simulé) où la roue a été arrachée : son épave reste `WHEEL_WRECK_LIFE` s sur le
   * terrain, et cède sous les coups (ses points de structure repartent d'une part de son maximum).
   * Retirée, elle n'a plus ni morceau ni corps (`part` et `body` à null).
   */
  releasedAt: number;
  /**
   * Collider de la roue : montée, fixé au morceau porteur (les tirs la touchent, elle pèse, elle
   * pousse caisses et robots, mais c'est le rayon de sa suspension qui la porte sur le sol et le
   * décor fixe) ; arrachée, celui de son corps.
   */
  collider: Collider;
  /** Points de structure restants : à 0, la roue est arrachée. */
  hp: number;
  /** Braquage (rad, > 0 : vers la gauche) ; il suit la commande à la vitesse du servomoteur. */
  steer: number;
  /** Tension appliquée au moteur, de -1 à 1 ; elle suit la commande avec une rampe. */
  drive: number;
  /** La direction est alimentée (roue reliée au cockpit, électronique en marche). */
  powered: boolean;
  /** Le moteur entraîne la roue ; sinon, elle tourne librement (roue libre, ou moteur coupé). */
  engaged: boolean;
  /** Roue libre à cliquet (boost) : le moteur pousse dans le sens commandé, sans jamais retenir. */
  overrun: boolean;
  /** Frein, de 0 à 1 : part de l'adhérence du pneu qu'il peut prendre (voir robot/wheels.ts). */
  brake: number;
  /** Débattement de la suspension (m, > 0 : la roue remonte), depuis sa position au repos. */
  travel: number;
  /** Rotation de la roue sur son essieu (rad), et sa vitesse (rad/s, > 0 : en avançant). */
  spin: number;
  spinRate: number;
  /** Force d'appui au sol (N) ; 0 : la roue est en l'air. */
  load: number;
  /** Morceau porteur ; null si la roue est arrachée. */
  part: Part | null;
  /** Paralysie locale (voir combat/emp.ts) : jusqu'à cet instant (temps simulé), son moteur et sa direction sont coupés. */
  stunnedUntil: number;
}

/** Ce qu'on lit d'une roue comme d'un corps : sa pose et ses vitesses. */
export interface WheelBody {
  translation(): Vec3;
  rotation(): Quat;
  linvel(): Vec3;
  angvel(): Vec3;
}

/**
 * Moteur d'un bloc (caractéristiques dans `ThrusterSpec`). Son rôle dépend de son orientation :
 * poussée vers le haut du robot (sustentation, pilotée par le pilote de vol stationnaire) ou
 * vers l'avant (propulsion, pilotée par les gaz).
 */
export interface Thruster {
  readonly block: Block;
  /**
   * `lift` : sustentation (poussée vers le haut du robot) ; `cruise` : propulsion (vers l'avant) ;
   * `trim` : autre orientation (rotor de queue, réacteur de côté), qui aide le pilote de vol à
   * tenir l'assiette et le cap.
   */
  readonly role: "lift" | "cruise" | "trim";
  /** Sens de rotation de l'hélice autour de sa poussée : 1 anti-horaire, -1 horaire. */
  readonly spin: number;
  /** Poussée actuelle (N) le long de l'axe du bloc, et inclinaison d'un rotor orientable (N, sur deux axes). */
  thrust: number;
  tiltA: number;
  tiltB: number;
  /**
   * Part de sa pleine poussée que le moteur peut donner en ce moment : 1 intact ; moins, abîmé ; 0
   * pendant un raté (voir `wearEngines`, robot/propulsion.ts). Pas transmise en réseau : la
   * réplique voit son effet dans la poussée.
   */
  output: number;
  /** Fin du raté en cours (temps simulé, s). */
  misfireUntil: number;
}

/**
 * Appui d'un bloc sur le sol (caractéristiques dans `SupportSpec`) : patin anti-gravité ou patte.
 * L'état est gardé pour le rendu (hauteur du sol, force, allure de la marche).
 */
export interface Support {
  readonly block: Block;
  /** Distance au sol sous le bloc (m) ; Infinity s'il n'y a pas de sol à portée. */
  contact: number;
  /** Force d'appui actuelle (N). */
  force: number;
  /** Phase de la marche (rad) : elle avance avec la distance parcourue. */
  phase: number;
}

/** Surface portante d'un bloc (aile ou gouverne, caractéristiques dans `AeroSpec`). */
export interface AeroSurface {
  readonly block: Block;
  /** Braquage actuel d'une gouverne (rad) ; toujours 0 pour une aile fixe. */
  deflection: number;
}

export type AiMode =
  | "patrol" | "engage" | "cover" | "flee" | "charge" | "reverse" | "hover" | "paused"
  | "gliding" | "landing" | "stunned" | "flipped" | "stranded" | "falling" | "dead" | "support";

export interface AiState {
  mode: AiMode;
  /** Destination (seuls x et z comptent). */
  target: Vec3;
  /** Temps restant avant de changer de destination de patrouille (s). */
  timer: number;
  /** Temps restant dans le mode en cours (fuite, charge, dégagement) (s). */
  modeT: number;
  /** Temps passé à l'arrêt, pour détecter un robot coincé (s). */
  stuckT: number;
  /** Temps passé à l'arrêt malgré les moteurs, marche arrière comprise : au-delà, il faut un bond (s). */
  blockedT: number;
  /** Sens du braquage en marche arrière (-1 ou 1). */
  flip: number;
  /** Altitude visée en vol (m). */
  alt: number;
  /** Terme intégral du pilote automatique d'avion : le trim de profondeur. */
  trim: number;
  /**
   * Lacet piloté (touches A et E) : part de l'aide (0 à 1), qui retombe peu à peu après qu'il les a
   * lâchées : contre le dérapage d'un avion en virage à plat (`slipAssist`, ai/pilot.ts), ou du
   * gyroscope d'un robot volant qui pivote (`flyToward`, robot/propulsion.ts).
   */
  slip: number;
  /**
   * Bombardier (voir ai/pilot.ts) : où il en est de son circuit d'attaque (passe sur la cible,
   * éloignement, demi-tour), la direction (horizontale, unitaire) de sa passe, et le côté de son
   * demi-tour (1 : à gauche, -1 : à droite) ; null hors bombardement.
   */
  bombRun: { phase: "pass" | "out" | "turn"; dir: Vec3; turn: number } | null;
  /** État tactique en combat. */
  readonly tactics: TacticsState;
}

/** État tactique de l'IA en combat (voir ai/tactics.ts). */
export interface TacticsState {
  /** Adversaire engagé, ou dont il se cache ; null hors combat. Instant (temps simulé) où il l'a vu pour la dernière fois. */
  foe: Bot | null;
  seenAt: number;
  /** Sens dans lequel il tourne autour de l'adversaire (1 ou -1). */
  orbit: number;
  /** Temps avant de revoir son plan (s). */
  planT: number;
  /** Temps passé à couvert (s), et instant (temps simulé) avant lequel il ne s'y remet pas. */
  coverT: number;
  coverBan: number;
  /** Capture de zones : il va prendre (ou tient) une zone ; touché, il ne fuit pas. */
  holding: boolean;
}

export interface Bot {
  readonly id: number;
  readonly profile: BotProfile;
  /** Blocs encore en vie, par clé de grille. */
  readonly blocks: Map<string, Block>;
  readonly parts: Set<Part>;
  readonly wheels: Wheel[];
  readonly thrusters: Thruster[];
  readonly supports: Support[];
  readonly surfaces: AeroSurface[];
  readonly turrets: Turret[];
  /** Armes de contact (toupies, marteaux… : voir combat/melee.ts). */
  readonly melee: MeleeArm[];
  /** Gâchette pressée au pas précédent (robot piloté) : un nouveau clic fait exploser son ogive pilotée. */
  triggerHeld: boolean;
  /** Rythme commun de ses armes identiques : l'heure (s) avant laquelle chaque arme ne tire plus (voir `fireInTurn`). */
  readonly nextShot: Map<WeaponId, number>;
  /** Générateurs de bouclier (voir combat/shield.ts). */
  readonly shields: Block[];
  /** Lance-leurres, et leurs salves : prêtes, temps avant d'en regagner une (s), instant où il peut en tirer une autre (voir combat/decoys.ts). */
  readonly flareLaunchers: Block[];
  readonly flares: { charges: number; restock: number; readyAt: number };
  /** Phares et balises (blocs à `light`) : le client les allume la nuit (client/render/nightLights.ts). */
  readonly lights: Block[];
  /** Liaisons rompues entre blocs voisins (clés de `linkKey`) : ces blocs ne se tiennent plus. */
  readonly cuts: Set<string>;
  /** Équipe : les robots d'équipes différentes se combattent. */
  readonly team: Team;
  /** Qui le pilote : l'IA, ou le joueur (voir sim/player.ts). */
  controller: "ai" | "player";
  /**
   * Commandes d'un robot piloté : celles du joueur local (`sim.input`) ou d'un joueur distant
   * (serveur) ; null pour l'IA, ou pour le joueur local par défaut.
   */
  input: PlayerInput | null;
  /** Dernier robot ennemi qui l'a touché : c'est lui qu'on crédite de sa destruction. */
  lastAttacker: Bot | null;
  /**
   * Projeté en l'air par une arme (le plateau d'un flipper : combat/mechanics.ts) : jusqu'à `until`
   * (temps simulé), les chocs qu'il subit (sa chute) sont crédités à `by`, cause `cause`
   * (combat/collisions.ts). Null sinon.
   */
  thrownBy: { by: Bot; cause: KillCause; until: number } | null;
  cockpit: Block;
  /** Nombre de blocs au départ. */
  readonly total: number;
  /** Temps passé renversé et immobile (s), et temps restant du redressement en cours (voir robot/righting.ts). */
  flippedFor: number;
  righting: number;
  /** Hauteur du bloc le plus haut au-dessus de l'origine du robot (m). */
  readonly top: number;
  /** Rayon du cercle horizontal qui contient tout le robot (m). */
  readonly radius: number;
  /** Dernière position connue du cockpit, encore utile après sa destruction. */
  lastPos: Vec3;
  /** Instant (temps simulé) jusqu'auquel une impulsion électromagnétique coupe son électronique. */
  stunnedUntil: number;
  /** Instant du dernier coup reçu (temps simulé) : la réparation attend un moment de calme. */
  lastHit: number;
  /**
   * Blocs détruits, qu'une réparation peut faire repousser (voir `rebuildNear`, combat/repair.ts),
   * et instant (temps simulé) avant lequel un rayon réparateur n'en refait pas un autre.
   */
  readonly lost: Map<string, Block>;
  rebuildAt: number;
  /** Énergie stockée (kJ), voir robot/energy.ts ; et puissance tirée pendant ce pas (kW). */
  energy: number;
  drawn: number;
  readonly ai: AiState;
}

export type Team = "red" | "blue";

/** État d'une arme (tourelle, ou arme du joueur) : voir combat/arsenal.ts. */
export interface ArmState {
  /** Temps avant le prochain tir possible (s). */
  cooldown: number;
  /** Chaleur, de 0 à 1 ; en surchauffe, l'arme attend d'être redescendue. */
  heat: number;
  overheated: boolean;
  /** Coups restants dans le chargeur, et temps avant d'en regagner un (s). */
  ammo: number;
  restock: number;
}

/**
 * Tourelle d'un bloc (caractéristiques dans `TurretSpec`). Son canon est orienté par un lacet
 * autour du haut du bloc et un site au-dessus de son plan, indépendamment du robot.
 */
export interface Turret {
  readonly block: Block;
  readonly weapon: WeaponId;
  yaw: number;
  pitch: number;
  /** État de l'arme : cadence, chaleur, munitions. */
  readonly arm: ArmState;
  /** Robot visé, et temps avant de reconsidérer la cible (s). */
  target: Bot | null;
  retarget: number;
  /** Point visé actuel (monde), que suivent les missiles téléguidés de la tourelle. */
  aim: Vec3 | null;
  /** Erreur de visée de l'IA : direction tirée au hasard dans la boule unité, renouvelée à chaque choix de cible. */
  wobble: Vec3;
  /** Heure de son dernier tir (s) : parmi des armes identiques, tire celle qui attend depuis le plus longtemps. */
  firedAt: number;
  /** Arme à verrouillage (voir combat/lock.ts) : l'ennemi en cours de verrouillage, et depuis combien de temps (s). */
  lockOn: Bot | null;
  lockTime: number;
  /** Depuis combien de temps (s) le décor ou la fumée cachent la cible verrouillée : au-delà de `LOCK_GRACE`, le verrou est perdu. */
  lockHidden: number;
}

/**
 * Phase d'un bras déclenché (marteau, plateau d'un flipper, mâchoire) : armé, en train de frapper
 * (ou de se fermer), en train de revenir (ou de se recharger) ; une mâchoire qui tient sa proie : `hold`.
 */
export type SwingPhase = "ready" | "strike" | "recover" | "hold";

/**
 * Boule d'un fléau (combat/mechanics.ts) : sa position et sa vitesse (monde), intégrées au pas fixe ;
 * ce que la manivelle a enroulé de sa chaîne autour du moyeu (`wound`, m) ; sa chaîne, si elle
 * s'est enroulée autour d'un obstacle (`wrap` : le point d'appui, la longueur de chaîne entre la
 * manivelle et lui, le sens d'enroulement, depuis quand). Sur la réplique réseau, seules `pos`,
 * `wound` et `wrap.point` sont tenues, d'après l'instantané.
 */
export interface FlailBall {
  pos: Vec3;
  vel: Vec3;
  wound: number;
  wrap: { point: Vec3; length: number; axis: Vec3; since: number } | null;
}

/**
 * Prise d'une mâchoire (combat/mechanics.ts) : le bloc saisi, le point de la prise dans le repère de
 * son robot (tous les morceaux d'un robot le partagent) et dans celui du robot de la mâchoire ;
 * depuis quand (s), la glissade accumulée (s), et l'écrasement pas encore infligé (points). Sur la
 * réplique, seul `block` est tenu (d'après l'instantané).
 */
export interface JawGrip {
  block: Block;
  local: Vec3;
  own: Vec3;
  since: number;
  slip: number;
  crush: number;
}

/**
 * Arme de contact d'un bloc (caractéristiques dans `MeleeSpec`, catalog/melee.ts) : un rotor qui
 * monte en régime et garde son énergie, ou un bras qui frappe sur ordre. Le contrôleur (IA, joueur)
 * pose ses commandes à chaque pas (`wanted`, `trigger`) ; `updateMelee` les applique puis les remet
 * à zéro. Le régime, la phase et l'angle du bras passent dans l'instantané réseau.
 */
export interface MeleeArm {
  readonly block: Block;
  readonly weapon: MeleeId;
  /**
   * Régime d'un rotor (rad/s, ≥ 0 ; d'un champ, celui de son anneau, qui dit sa charge) ; d'un bras,
   * sa vitesse angulaire pendant la frappe ; d'une pointe, sa vitesse de sortie (m/s).
   */
  spin: number;
  /** Angle du rotor sur son axe (rad) : son balourd tourne avec lui. */
  angle: number;
  /**
   * Bras déclenché : sa phase, depuis combien de temps (s), son angle (rad, autour de son pivot) et
   * celui d'où il revient. Une pointe a les mêmes phases, et sa sortie (m, depuis le moyeu) dans `swing`.
   */
  phase: SwingPhase;
  phaseT: number;
  swing: number;
  from: number;
  /** Commandes de ce pas : faire tourner le rotor, frapper. */
  wanted: boolean;
  trigger: boolean;
  /** Heure (temps simulé) du dernier coup. */
  hitAt: number;
  /** Usure du balourd pas encore infligée (points de structure). */
  fatigue: number;
  /** Fléau : sa boule (null avant qu'il ne tourne, ou bloc détruit). */
  ball: FlailBall | null;
  /** Mâchoire : ce qu'elle tient (null : rien). */
  grip: JawGrip | null;
  /**
   * Morsure en cours d'une lame qui mord en continu (`MeleeSpec.bite` : scie, foreuse), ou null :
   * ce qu'elle mord à ce pas. Elle passe par l'instantané réseau (effets, son).
   */
  bite: MeleeBite | null;
  /** Morsure : dégâts pas encore infligés (ils tombent par tranches : voir combat/melee.ts). Simulation seulement. */
  gnaw: Gnaw | null;
}

/** Ce que mord une lame en ce moment (voir `MeleeArm.bite`). */
export interface MeleeBite {
  /** Où elle mord (monde), et le sens de la lame à cet endroit (unitaire, monde : la scie le long de son bord, la mèche le long de son axe). */
  point: Vec3;
  dir: Vec3;
  /** Ce qu'elle mord (robot, accessoire, décor ou sol). */
  surface: ImpactSurface;
  /** Puissance qu'elle y met (kW) : les étincelles, le grincement en suivent. */
  power: number;
  /** Elle glisse sur une pente (ricochet). */
  glance: boolean;
}

/**
 * Dégâts d'une morsure accumulés depuis la dernière tranche (simulation seulement) : sur quoi, d'où
 * repartir pour percer (la case du bloc mordu et le sens d'avance, dans le repère de son robot), et
 * l'énergie coupée (pour l'usure de la lame).
 */
export interface Gnaw {
  target: HitTarget | null;
  /** Dégâts bruts (avant résistance) accumulés, et l'énergie de coupe (J). */
  damage: number;
  cut: number;
  /**
   * Bloc mordu : le robot, son morceau (une référence, jamais relue s'il a disparu), la case, et le
   * sens d'avance dans le repère du robot (unitaire ; tous ses morceaux partagent ce repère).
   */
  cell: { bot: Bot; part: Part; x: number; y: number; z: number; feed: Vec3 } | null;
  /** Où et dans quel sens (monde), et le moyeu (d'où vient le coup, pour la réaction de l'IA). */
  point: Vec3;
  dir: Vec3;
  hub: Vec3;
  /** Heure (temps simulé) de la première part de cette tranche. */
  since: number;
}

/** Aspect d'un débris : un morceau de bloc (type et couleur du robot) ou d'accessoire. */
/** Apparence d'un débris : un bloc, ou un éclat d'accessoire (un morceau de mur a son côté, `size` m). */
export type DebrisLook = { kind: "block"; type: BlockType; color: string } | { kind: "prop"; type: PropType; size?: number };

export interface Debris {
  readonly id: number;
  readonly rb: RigidBody;
  readonly collider: Collider;
  readonly look: DebrisLook;
  /** Instant d'apparition, en temps simulé (s). */
  readonly born: number;
  /** Durée de vie (s). */
  readonly life: number;
}

/** Accessoire du décor (caractéristiques dans `PropTypeDef`). */
export interface Prop {
  readonly id: number;
  readonly type: PropType;
  readonly rb: RigidBody;
  readonly collider: Collider;
  /** Emplacement d'où il vient (indice dans `arena.props`) : ses dimensions, ce qui le porte. */
  readonly spot: number;
  /** Demi-dimensions (m) : boîte ou dalle ; pour un cylindre, (rayon, demi-hauteur, rayon). */
  readonly half: Vec3;
  /** Corps fixe : ancré (mur, arbre), il ne bouge pas tant qu'il n'est pas libéré (arena/structures.ts). */
  fixed: boolean;
  hp: number;
  /**
   * Après la rupture : mèche qui brûle (baril) ou gaz qui fuit (bouteille) par un trou sur le
   * flanc (`leak`, direction dans le repère de l'accessoire), avec le temps restant (s).
   */
  state: { kind: "intact" } | { kind: "fuse"; left: number } | { kind: "venting"; left: number; leak: Vec3 };
  /** Feu (du bois : voir `PropTypeDef.burns`) : secondes qu'il brûlera encore s'il n'est pas ravivé (0 : il ne brûle pas). */
  burn: number;
  /** Part noircie par le feu (0 à 1), qui ne revient pas. */
  charred: number;
  /**
   * Brisé par un robot qui passe au travers : la vitesse que ses éclats emportent (devant lui), au
   * lieu de la sienne (combat/collisions.ts, arena/props.ts).
   */
  struck?: Vec3;
  /** Couché par un robot qui passe : jusqu'à ce temps (simulé), il ne heurte pas les robots (`fellProp`). */
  yielding?: number;
}

/**
 * Flaque de feu au sol (lance-flammes, napalm) : elle brûle ce qui s'y tient jusqu'à `until`
 * (temps simulé), voir combat/groundFires.ts.
 */
export interface GroundFire {
  readonly id: number;
  /** Centre, au sol. */
  readonly pos: Vec3;
  readonly radius: number;
  until: number;
  /** Robot qui l'a allumée (crédité des destructions ; ses flaques ne le brûlent pas), ou null. */
  readonly owner: Bot | null;
}

/**
 * Projectile en vol : un point qui avance à chaque pas le long de sa vitesse (lancer de rayon
 * entre deux positions), soumis à la gravité et éventuellement guidé.
 */
export interface Projectile {
  readonly id: number;
  readonly weapon: WeaponId;
  /** Robot qui a tiré (ses propres blocs ne l'arrêtent pas), ou null pour le joueur. */
  readonly shooter: Bot | null;
  /** Point de départ du tir, pour la réaction de la cible. */
  readonly origin: Vec3;
  pos: Vec3;
  vel: Vec3;
  age: number;
  /** Dégâts qu'il peut encore infliger (diminuent quand il perfore). */
  damage: number;
  /** Tourelle qui le téléguide (missile `command`), ou null : il suit alors `sim.playerAim`. */
  readonly commander: Turret | null;
  /** Cible d'un missile à tête chercheuse. */
  homing: Bot | null;
  /** Mine posée au sol. */
  landed: boolean;
  /** Mine : instant (temps simulé) où elle éclate (bondissante en l'air, ventouse, télécommandée), ou null. */
  fuse: number | null;
  /** Mine ventouse collée à un robot : le bloc qui la porte, et sa place par rapport à lui (repère du morceau). */
  stuck: { block: Block; offset: Vec3 } | null;
  /** Une explosion l'a atteinte : elle saute au pas suivant (déminage, voir combat/mines.ts). */
  blown: boolean;
  /** Mine : les équipes adverses qui l'ont repérée (leur IA l'évite, voir ai/navigation.ts). */
  spotted: Team[];
  /** Capteur : instant (temps simulé) où il peut de nouveau signaler un ennemi. */
  pingAt: number;
  /** Points de structure d'un projectile qu'on peut abattre (voir `ProjectileSpec.hull`). */
  hp: number;
  /** Missile détourné par un leurre (il le suit), les leurres qu'il a déjà vus, et s'il a perdu sa cible (le leurre éteint, il file droit). */
  decoy: Projectile | null;
  readonly tried: number[];
  lost: boolean;
  /**
   * Tête chercheuse (voir `steer`, combat/projectiles.ts) : où elle a vu sa cible pour la dernière
   * fois, et depuis combien de temps (s) le décor ou la fumée la lui cachent.
   */
  seen: Vec3 | null;
  blind: number;
  /** Retiré du monde (il a fini sa course). */
  done: boolean;
}

/**
 * Mur d'énergie déployé par un projecteur de bouclier (voir combat/barriers.ts) : un rectangle
 * vertical, face à `normal` (horizontale), qui arrête les tirs des ennemis de son équipe.
 */
export interface Barrier {
  readonly id: number;
  readonly team: Team;
  /** Centre du rectangle, et sa normale (horizontale, unitaire, vers l'ennemi). */
  readonly center: Vec3;
  readonly normal: Vec3;
  readonly width: number;
  readonly height: number;
  /** Points de structure : à 0, le mur se brise. */
  hp: number;
  readonly maxHp: number;
  /** Instant de sa fin (temps simulé). */
  readonly until: number;
}

/** Nuage de fumée : il cache ce qui est derrière lui (voir combat/smoke.ts). */
export interface SmokeCloud {
  readonly id: number;
  readonly pos: Vec3;
  /** Rayon final (m). */
  readonly radius: number;
  /** Instant d'apparition (temps simulé) et durée de vie (s). */
  readonly born: number;
  readonly life: number;
}

/** Ce que représente un collider, retrouvé par son handle (tirs, requêtes). */
export type ColliderOwner =
  | { kind: "part"; part: Part }
  | { kind: "head"; turret: Turret }
  /** La lame ou le bras d'une arme de contact (sa zone touchable) : c'est son bloc qui encaisse. */
  | { kind: "blade"; arm: MeleeArm }
  | { kind: "wheel"; wheel: Wheel }
  | { kind: "prop"; prop: Prop }
  | { kind: "debris" };

/** Ce qu'un tir ou une explosion touche : un bloc, une roue ou un accessoire. */
export type HitTarget =
  | { kind: "block"; block: Block }
  | { kind: "wheel"; wheel: Wheel }
  | { kind: "prop"; prop: Prop };
