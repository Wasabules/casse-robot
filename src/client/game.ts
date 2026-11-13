import * as B from "./babylon";
import { isOperational } from "../shared/ai/brain";
import { blockDef } from "../shared/catalog/blocks";
import { lobbed, weaponDef, WEAPON_IDS, WEAPONS, type Weapon, type WeaponId } from "../shared/catalog/weapons";
import { isMeleeId, meleeDef, meleeOffensive, type ArmId, type MeleeId } from "../shared/catalog/melee";
import { liveMelee, meleeCharge, meleeReadiness, vibration } from "../shared/combat/melee";
import { lobDirection, predictImpact } from "../shared/combat/ballistics";
import { sphereHit } from "../shared/combat/interception";
import { flareCapacity, incomingMissile } from "../shared/combat/decoys";
import { isLocked, lockProgress } from "../shared/combat/lock";
import { lineOfFireBlocked, liveTurrets, muzzleVelocity, reachableDirection, turretFrame } from "../shared/combat/turrets";
import { findHomingTarget } from "../shared/combat/projectiles";
import { BLOCK_SIZE, STEP } from "../shared/config";
import type { BotProfile } from "../shared/design/presets";
import { clamp } from "../shared/math/scalar";
import { add, cross, distance, dot, len, norm, qrot, scale, sub, vec3, type Vec3 } from "../shared/math/vec";
import { ENDLESS_MATCH, GAME_MODES, matchEntries, pickRoster, type GameModeId } from "../shared/modes";
import { blockWorldPos, liveThrusters } from "../shared/robot/queries";
import { isDetected } from "../shared/sim/detection";
import type { ArmState, Bot, HitTarget, Projectile, Team, Turret } from "../shared/sim/entities";
import { endMatch, selfDestruct, startMatch } from "../shared/sim/match";
import { CRUISE_POWER } from "../shared/sim/player";
import { Simulation } from "../shared/sim/simulation";
import type { SimEvent } from "../shared/sim/events";
import type { World } from "../shared/sim/world";
import { InputPacer } from "../shared/net/pacing";
import { NetClient } from "./net/netClient";
import { WorkerLink } from "./sim/workerLink";
import { spawnTeams, spawnWave } from "../shared/sim/wave";
import { Sound } from "./audio/sound";
import { byId } from "./dom";
import { Hud } from "./hud/hud";
import { MiniMap } from "./hud/minimap";
import { HitFeedback, type MarkerKind } from "./hud/hitFeedback";
import { Instruments, type BombSight, type Flight, type Gunnery, type LockView, type WarheadView } from "./hud/instruments";
import { Reticle, SIGHTS } from "./hud/reticle";
import { aimSpread } from "../shared/combat/accuracy";
import { readiness, type Readiness } from "../shared/combat/arsenal";
import { MatchHud } from "./hud/matchHud";
import { Notice } from "./hud/notice";
import { CameraRig } from "./input/cameraRig";
import { Controls, RETICLE_HEIGHT } from "./input/controls";
import { ACTIONS, WEAPON_SLOTS, type ActionId } from "./input/bindings";
import { freeKeys, pilotKeys } from "./keys";
import { ArenaView } from "./render/arenaView";
import { ZoneView } from "./render/zoneView";
import { ARENA_IDS, DEFAULT_ARENA, groundLevel, isMapKey, type ArenaId, type ArenaKey, type ArenaLayout } from "../shared/arena/layout";
import type { MapFile } from "../shared/map/format";
import { mapFileOf } from "../shared/map/load";
import { arenaFile, arenaReady, loadArena, readyArenas } from "./maps/gameArenas";
import { rayArena } from "../shared/arena/ray";
import { Effects } from "./render/effects";
import { Fx } from "./render/fx/fx";
import { SceneLighting } from "./render/lighting";
import { PoseInterpolation } from "./render/interpolation";
import { firingTurret, recoilKick } from "./render/recoil";
import { requestedSimulation, type FarShadows, type FxLook, type ShadowQuality, type SimulationEngine } from "./settings";
import { DEFAULT_SIMULATION } from "../shared/native/choice";
import { LocomotionView } from "./render/locomotionView";
import { applyArenaLook, SHADOW_MAPS, type SceneKit } from "./render/scene";
import { Assets } from "./render/materials";
import { ProjectileView } from "./render/projectiles";
import { createScene } from "./render/scene";
import { dustColor } from "./render/propModels";
import { SmokeView } from "./render/smokeView";
import { pickTerrain } from "./render/terrainPick";
import { BarrierView } from "./render/barrierView";
import { WorldView } from "./render/worldView";
import { t } from "./i18n/i18n";
import { armName, arenaName, modeName } from "./i18n/names";
import { onLocaleChange } from "./i18n/state";
import type { LostReason } from "./hud/hud";

/** Au plus 4 pas de physique par image : au-delà, le jeu ralentit au lieu de s'emballer. */
const MAX_STEPS_PER_FRAME = 4;
/** Préparation d'une partie : attente au plus de cette durée (s) que la scène se dise prête (shaders compilés). */
const READY_WAIT = 6;
const SLOWMO_SCALE = 0.25;
/** Portée de la visée du joueur (m). */
/** Marques du canon montrées au plus (une par tourelle de l'arme choisie). */
const GUN_MARKS = 4;
const AIM_RANGE = 400;
/** Démonstration derrière le menu : on relance une vague quand il reste si peu de robots actifs, ou au bout de ce temps (s). */
const ATTRACT_MIN_ACTIVE = 3;
const ATTRACT_MAX_WAVE = 120;
/**
 * Le fichier d'une arène, que la partie solo dans un Worker reçoit avec la partie : une carte
 * communautaire, ou une grande arène du jeu (le Worker n'a que les petites ; client/maps/gameArenas.ts).
 */
const arenaFileFor = (key: ArenaKey): MapFile | undefined => (isMapKey(key) ? mapFileOf(key) : arenaFile(key));
/** Démonstration : le temps (s) qu'une nouvelle vague arrive du Worker avant qu'on juge ce qu'il en reste. */
const ATTRACT_SETTLE = 3;
/**
 * Une arène au hasard (démonstration derrière le menu), parmi celles dont le fichier est là ; le
 * tirage tombe-t-il sur une autre, son fichier se charge pour une prochaine fois (une grande arène ne se
 * télécharge que si on la montre : client/maps/gameArenas.ts).
 */
function randomArena(): ArenaId {
  const wish = ARENA_IDS[Math.floor(Math.random() * ARENA_IDS.length)];
  if (arenaReady(wish)) return wish;
  loadArena(wish).catch(() => {});
  const ready = readyArenas();
  return ready[Math.floor(Math.random() * ready.length)] ?? DEFAULT_ARENA;
}
/** Distance de la caméra au robot piloté, au départ (m). */
const PILOT_CAMERA = 13;
/** Intervalle entre deux bips du verrouillage en cours (s) : au début, puis juste avant le verrou. */
const LOCK_BEEP_SLOW = 0.3;
const LOCK_BEEP_FAST = 0.08;
/** Au viseur : hauteur du point de vue au-dessus du bloc de la tourelle (m). Les zooms de chaque arme sont dans hud/reticle.ts. */
const EYE_HEIGHT = 0.45;
/**
 * Ogive pilotée : la caméra est à WARHEAD_NOSE m devant son centre, et reste WARHEAD_WATCH s sur
 * place après l'explosion.
 */
const WARHEAD_NOSE = 0.9;
const WARHEAD_WATCH = 1.2;
/** Après l'explosion, la caméra regarde de WARHEAD_BACK m en arrière sur la trajectoire, à WATCH_FLOOR m du sol au moins. */
const WARHEAD_BACK = 6;
const WATCH_FLOOR = 1.5;
/** Pas de grossissement dans l'ogive. */
const NO_ZOOM: readonly number[] = [1];
/** Au viseur, pas d'éclair de tir à moins de cette distance de la caméra (m) : ce sont ceux de ses propres canons. */
const OWN_FLASH = 3;
/** Le HUD signale un missile ennemi qui fonce sur le robot du joueur à moins de cette distance (m). */
const MISSILE_ALERT = 60;
/** Le réticule accroche un missile qui passe à moins de cette marge (m) au-delà de sa taille. */
const AIM_HULL_MARGIN = 0.5;
/** Une étincelle de réparation par bloc au plus toutes les REPAIR_SPARK s. */
const REPAIR_SPARK = 0.2;
/**
 * La caméra de pilotage vise au moins OVER_TOP m au-dessus du haut du robot (pas son centre) : on
 * voit par-dessus, même un robot haut ne cache pas ce qu'il y a devant lui.
 */
const OVER_TOP = 0.9;
/** Le HUD de partie se rafraîchit à cette cadence (s). */
const MATCH_HUD_REFRESH = 0.1;
/**
 * Armes de contact du joueur : un coup fait sauter la vue de MELEE_KICK rad par kJ (au plus
 * MELEE_KICK_MAX) ; un rotor déséquilibré la fait trembler d'au plus SHAKE_VIEW rad à chaque image ;
 * une lame qui mord, de BITE_VIEW rad par BITE_VIEW_POWER kW de coupe (au plus le double).
 */
const MELEE_KICK = 0.012;
const MELEE_KICK_MAX = 0.05;
const SHAKE_VIEW = 0.006;
const BITE_VIEW = 0.0025;
const BITE_VIEW_POWER = 3;

/** Secousse de la vue d'un robot dont une lame mord (rad) : d'après la puissance de sa coupe (passe par le réseau). */
function biteShake(bot: Bot): number {
  let power = 0;
  for (const arm of bot.melee) if (arm.bite && arm.block.alive) power = Math.max(power, arm.bite.power);
  return power > 0 ? BITE_VIEW * Math.min(2, power / BITE_VIEW_POWER) : 0;
}

const toVec3 = (v: B.Vector3): Vec3 => vec3(v.x, v.y, v.z);

/**
 * Partie en arène, selon un mode de jeu (voir shared/modes.ts). Soit le joueur pilote un robot de
 * l'équipe bleue (conduite, visée à la souris, tourelles), soit il regarde deux équipes de l'IA
 * s'affronter et tire depuis une caméra libre. Assemble la simulation, son rendu, le HUD et les
 * entrées, et fait tourner la boucle. En démonstration (derrière le menu), la caméra tourne seule
 * et les entrées sont coupées. En multijoueur (`startOnline`), le rendu montre la réplique du
 * monde du serveur, et les commandes du joueur partent au serveur.
 */
/** Une arme à un coup qui ne se recharge pas (l'ogive), déjà tirée : plus rien à tirer de cette vie. */
function spent(id: WeaponId, arm: ArmState): boolean {
  const ammo = weaponDef(id).ammo;
  return !!ammo && !Number.isFinite(ammo.reload) && arm.ammo < 1;
}

/**
 * Avion : course entière du manche au clavier en 1/STICK_RATE s ; gaz qui montent ou descendent de
 * POWER_RATE par seconde (avancer, reculer). Pilotage manuel : la souris immobile depuis CHASE_DELAY
 * s, la caméra se remet derrière lui (CHASE_RATE, 1/s). À la souris, pendant qu'on vire ou cabre au
 * clavier, et KEY_STEER_HOLD s après, l'avion garde sa route et la caméra le suit, plus vite
 * (KEY_CHASE_RATE) : lâché, il repart vers ce que vise le réticule, qui est devant lui.
 */
const STICK_RATE = 5;
const POWER_RATE = 0.6;
const CHASE_DELAY = 1.2;
const CHASE_RATE = 1.6;
const KEY_STEER_HOLD = 0.35;
const KEY_CHASE_RATE = 6;
/** Le repère du nez de l'avion (où il va), à cette distance devant lui (m). */
const NOSE_MARK_RANGE = 120;

/** Régime moyen des moteurs qui font avancer un avion (0 à 1), ou null s'il n'en a plus. */
function engineRegime(bot: Bot): number | null {
  const engines = liveThrusters(bot, "cruise");
  if (!engines.length) return null;
  let sum = 0;
  for (const t of engines) sum += clamp(t.thrust / blockDef(t.block.type).thruster!.maxThrust, 0, 1);
  return sum / engines.length;
}

/**
 * Mesure par étape des images (`ArenaGame.frameProfile`) : le temps cumulé de chaque étape (ms), le
 * nombre d'images mesurées, et le temps de calcul de chacune (code du jeu et préparation de l'image par
 * Babylon, sans l'attente de la carte graphique).
 */
export interface FrameProfile {
  times: Record<string, number>;
  frames: number;
  totals: number[];
}

export class ArenaGame {
  readonly sim: Simulation;
  readonly scene: B.Scene;
  readonly rig: CameraRig;
  view: WorldView;
  readonly hud: Hud;
  /** Mini-carte, et carte entière (M). */
  private readonly minimap = new MiniMap();
  readonly controls: Controls;
  readonly sound: Sound;
  /** Arme choisie à la caméra libre. */
  weapon: WeaponId = "rifle";
  mode: GameModeId = "arena";
  /** Arène des prochaines vagues (et de la partie en cours). */
  /** Arène de la partie : une arène du jeu, ou une carte communautaire connue (`registerArena`). */
  arenaId: ArenaKey = DEFAULT_ARENA;
  /** Robot que pilote le joueur dans les modes pilotés. */
  playerProfile: BotProfile | null = null;
  /** Le joueur peut tirer, conduire et déplacer la caméra (faux derrière le menu). */
  inputEnabled = false;
  /** Simulation figée (menu pause) : seul le rendu continue. */
  frozen = false;
  /** Prochaine étincelle de réparation permise, par bloc (voir `blockRepaired`). */
  private readonly repairSparks = new Map<number, number>();
  /** Appelé quand une partie se termine. */
  onMatchOver: ((winner: Team | "draw") => void) | null = null;
  /** Arène en veille (le garage a l'écran) : ni simulation ni rendu. */
  suspended = false;

  readonly engine: B.AbstractEngine;
  private readonly shadows: B.ShadowGenerator;
  private readonly kit: SceneKit;
  private attract = false;
  private waveStart = 0;
  private readonly effects: Effects;
  /** Traînées, fumées, marques au sol… (render/fx/). */
  private readonly fx: Fx;
  /** Halo, lumières des explosions, distorsion de chaleur (réglages graphiques ; render/lighting.ts). */
  private readonly lighting: SceneLighting;
  private readonly assets: Assets;
  private readonly arenaView: ArenaView;
  private readonly zoneView: ZoneView;
  private projectiles: ProjectileView;
  private smokes: SmokeView;
  private barriers: BarrierView;
  private locomotion: LocomotionView;
  /** Session multijoueur en cours, ou null (partie locale). */
  /**
   * La réplique que montre le jeu et ce qui la nourrit : le serveur de jeu (une partie en réseau), ou
   * la simulation de la partie solo dans un Worker (`local`) ; null : la simulation dans ce fil
   * (`sim` : sans Worker, ou `?sim=page`).
   */
  private net: NetClient | WorkerLink | null = null;
  /** La partie solo dans un Worker (client/sim/workerLink.ts), s'il a pu démarrer. */
  private local: WorkerLink | null = null;
  /** Quand envoyer les commandes au serveur : une touche qui change tout de suite, le reste à INPUT_RATE (net/pacing.ts). */
  private readonly inputPacer = new InputPacer();
  private unbindWorld: () => void;
  private readonly matchHud = new MatchHud();
  /** Le bandeau de ce qui arrive à la partie (une simulation arrêtée sur une erreur, la partie qui reprend). */
  private readonly notices = new Notice();
  private readonly feedback = new HitFeedback();
  private readonly reticle = new Reticle();
  private readonly instruments = new Instruments();
  /** Marques du canon (voir `showGunMarks`). */
  private readonly gunMarks = byId("gunMarks");
  /** Conduite relative à la caméra (réglage du joueur). */
  relativeDrive = false;
  /** Avion : pilotage manuel (le manche au clavier) ; sinon à la souris (réglage du joueur, que sa touche bascule en vol). */
  manualFlight = false;
  /** Le joueur a basculé le pilotage de l'avion : l'application enregistre le réglage. */
  onFlightChange: ((manual: boolean) => void) | null = null;
  /** En vol : le manche au clavier (lissé : les touches sont tout ou rien), les gaz tenus, et l'avion qu'ils pilotent. */
  private readonly stick = { pitch: 0, roll: 0, yaw: 0 };
  private power = CRUISE_POWER;
  private flown: Bot | null = null;
  /** À la souris : temps (s) pendant lequel l'avion garde encore sa route (on vire ou cabre au clavier). */
  private keySteer = 0;
  /** Un avion vient d'apparaître : la vue se met derrière lui à la prochaine image (voir `steerPlane`). */
  private snapView = false;
  /** Repère du nez de l'avion piloté à la souris : où il va, que le réticule l'emmène. */
  private readonly noseMark = byId("noseMark");
  /** Partie en cours : robots détruits par le joueur, zones prises par son équipe (pour les crédits). */
  readonly matchStats = { kills: 0, captures: 0 };
  /** Robots paralysés par une impulsion électromagnétique : des arcs électriques courent sur eux. */
  private readonly stunned = new Set<Bot>();
  private timeScale = 1;
  /** Index dans `sim.bots` du robot suivi par la caméra, ou -1. */
  private follow = -1;
  private accumulator = 0;
  /** Temps de calcul moyen d'un pas de simulation (ms), affiché dans le HUD. */
  private physMs = 0;
  /**
   * Mesure du temps de chaque image par étape (ms cumulées), quand elle est active : la mesure du
   * rendu (`npm run perf`, tools/browser/perf.mjs) l'active, comme `sim.profile` pour la simulation.
   */
  frameProfile: FrameProfile | null = null;
  /** Graine du hasard de la partie solo dans le Worker (la mesure du rendu : une bataille rejouable), ou null. */
  seed: number | null = null;
  /** Robots d'une vague sans joueur imposés (la mesure du rendu : `BATTLE_ROSTER`), ou tirés au sort. */
  private fixedRoster: readonly BotProfile[] | null = null;
  /** En solo, les poses montrées au rendu, interpolées entre les deux derniers pas (render/interpolation.ts). */
  private readonly poses = new PoseInterpolation();
  /** Des robots sont apparus (réapparitions) : la liste du HUD est à refaire. */
  private rosterChanged = false;
  /** Robot dont le HUD montre les armes (il change à chaque réapparition du joueur). */
  private armedBot: Bot | null = null;
  /** Armes du robot piloté, dans l'ordre des touches. */
  pilotWeapons: ArmId[] = [];
  private matchHudTimer = 0;
  /** On était au viseur à l'image précédente (pour repérer le passage au viseur). */
  private wasScoping = false;
  /** Prochain bip du verrouillage en cours (s, horloge de la page). */
  private nextLockBeep = 0;
  /** Hauteur de visée de la caméra au-dessus du robot du joueur, gardée quand il est détruit. */
  private pilotLift = 0.5;
  /** Pour les sons de l'arme choisie : son état à l'image précédente, et la gâchette. */
  private lastWeaponState: { weapon: ArmId; cause: Readiness["cause"] } | null = null;
  private lastTrigger = false;
  /** Derniers points visés de dos et au viseur : en passant de l'un à l'autre, on garde ce que l'on visait. */
  private backAim: Vec3 | null = null;
  private scopeAim: Vec3 | null = null;
  /** Le verrou de l'arme choisie était acquis à l'image précédente (un son marque son acquisition). */
  private wasLocked = false;
  /** Ogive pilotée en vol tirée par le joueur : la caméra est à son nez (voir `updateCamera`). */
  private warhead: Projectile | null = null;
  /** L'ogive vient de partir : la caméra doit se tourner dans son axe. */
  private warheadLaunched = false;
  /** Après l'explosion, la caméra reste un moment là où elle était : point de vue, et heure de fin (s, horloge de la page). */
  private warheadWatch: { eye: Vec3; until: number } | null = null;
  /** Part de la résolution de l'écran à laquelle l'image est calculée (réglage du joueur). */
  private renderScale = 1;

  /** Le jeu, sur le moteur de la page (WebGL ou WebGPU : render/engine.ts) et son canvas. */
  constructor(engine: B.AbstractEngine, simulation: SimulationEngine = DEFAULT_SIMULATION) {
    const canvas = engine.getRenderingCanvas()!;
    this.sim = new Simulation();
    const kit = createScene(engine);
    const { scene, shadows } = kit;
    this.kit = kit;
    this.engine = engine;
    this.scene = scene;
    this.shadows = shadows;
    this.rig = new CameraRig(scene, canvas, () => !this.suspended);
    // En pilotant, la caméra ne passe pas derrière le décor de l'arène affichée
    this.rig.setOcclusion((from, dir, length) => rayArena(this.world.arena, from, dir, length));
    const assets = new Assets(scene);
    this.assets = assets;
    this.arenaView = new ArenaView(scene, assets, shadows);
    this.zoneView = new ZoneView(scene);
    this.effects = new Effects(scene);
    this.fx = new Fx(scene, assets, this.sim);
    this.lighting = new SceneLighting(scene, this.rig.camera, this.sim, this.fx.glowMeshes);
    this.view = this.worldView(this.sim);
    this.projectiles = new ProjectileView(this.sim, assets);
    this.smokes = new SmokeView(this.sim, scene);
    this.barriers = new BarrierView(this.sim, scene);
    this.locomotion = new LocomotionView(this.sim, scene, assets, shadows);
    this.hud = new Hud({
      selectWeapon: (id) => this.selectWeapon(id),
      newWave: () => this.newWave(),
      togglePause: () => this.setPaused(!this.sim.aiPaused),
      toggleSlowmo: () => this.toggleSlowmo(),
      toggleFollow: (i) => this.setFollow(this.follow === i ? -1 : i),
    });
    this.hud.showWeapon(this.weapon);
    this.showArena(this.sim.arena);
    this.controls = new Controls(canvas, this);
    // Les touches de chaque arme, et les aides à l'écran : celles choisies par le joueur
    this.hud.weaponKey = (slot) => this.controls.keyName(WEAPON_SLOTS[slot % 10]);
    this.controls.onLabels = () => this.refreshKeyHelp();
    this.matchHud.selfDestructKey = () => this.controls.keyName("selfDestruct");
    this.refreshKeyHelp();
    this.sound = new Sound(this.sim, true);
    this.unbindWorld = this.sim.on((e) => this.onWorldEvent(e));
    // La langue change (depuis les paramètres) : le HUD se refait dans la nouvelle langue
    onLocaleChange(() => this.refreshTexts());
    this.startLocal(simulation);
  }

  /**
   * La partie solo dans un Worker (client/sim/workerLink.ts) : le fil du rendu ne fait plus la
   * simulation, il rejoue les images du Worker dans une réplique, comme en réseau. Sans Worker (ou
   * `?sim=page` dans l'adresse), la simulation reste dans ce fil, comme avant.
   */
  private startLocal(simulation: SimulationEngine): void {
    if (typeof Worker === "undefined" || new URLSearchParams(location.search).get("sim") === "page") return;
    // La simulation du TypeScript ou celle portée en Rust (le réglage, ou `?sim=` ; les mêmes images)
    this.openWorker(requestedSimulation(simulation), true);
  }

  /**
   * Un Worker de la partie solo sur cette simulation (`playing` : la partie s'y joue tout de suite) ;
   * faux s'il ne démarre pas. Si sa simulation s'arrête sur une erreur en cours de route (une panique
   * de la simulation Rust : son instance du module est perdue), la partie en cours reprend dans un
   * Worker neuf sur celle du TypeScript ; si c'est elle qui s'arrête, dans ce fil. Un bandeau le dit.
   */
  private openWorker(engine: SimulationEngine, playing: boolean): boolean {
    let link: WorkerLink;
    try {
      link = new WorkerLink(engine);
    } catch (e) {
      console.warn("La simulation reste sur la page : pas de Worker", e);
      return false;
    }
    link.onFail = () => {
      if (this.local !== link) return;
      link.close();
      this.local = null;
      const shown = this.net === link;
      if (shown) this.net = null;
      // (seule la simulation Rust passe la main à un Worker du TypeScript ; un Worker du TypeScript qui échoue laisse la partie à la page)
      const again = link.engine === "rust" && this.openWorker("ts", shown);
      if (!shown) return;
      if (!again) this.bind(this.sim);
      this.newWave();
      // (la démonstration derrière le menu reprend sans rien dire : le joueur n'y perd rien)
      if (!this.attract) this.notices.show(t(again ? "hud.sim.fallbackTs" : "hud.sim.fallbackPage"));
    };
    this.local = link;
    if (playing) {
      this.net = link;
      this.bind(link.replica);
    }
    return true;
  }

  /**
   * La simulation de la partie solo : celle du Worker (du TypeScript, ou portée en Rust), ou celle de
   * la page (sans Worker, `?sim=page`, ou après un échec du Worker).
   */
  get simulationEngine(): SimulationEngine | "page" {
    return this.local ? this.local.engine : "page";
  }

  /** La partie se joue dans le Worker (la partie solo hors du fil du rendu). */
  private get inWorker(): boolean {
    return this.local !== null && this.net === this.local;
  }

  /**
   * La langue a changé : ce que le HUD a construit une fois (barre des armes, lignes du tableau,
   * aide des touches, titre du tableau et de la carte, étiquettes des robots) se refait ; le reste
   * se met à jour de lui-même à l'image suivante.
   */
  private refreshTexts(): void {
    this.hud.refreshTexts();
    this.refreshKeyHelp();
    this.showTitle();
    this.minimap.refreshTexts();
    this.view.refreshTags();
  }

  /** Ce que montrent le rendu, le son et le HUD : la simulation locale, ou la réplique de la partie en réseau. */
  get world(): World {
    return this.net?.replica ?? this.sim;
  }

  /** Une partie en réseau est-elle en cours ? */
  get online(): boolean {
    return this.net instanceof NetClient;
  }

  /** Effets, HUD et fin de partie, d'après les événements du monde affiché. */
  private onWorldEvent(e: SimEvent): void {
    this.hud.onWorldEvent(e);
    this.minimap.onWorldEvent(e);
    switch (e.type) {
      case "shot": {
        // Dans l'arme, pas d'éclair à la bouche de ses propres canons, tout contre l'objectif
        if (!(this.rig.inWeapon && distance(e.origin, this.rig.position) < OWN_FLASH)) this.effects.muzzle(e.origin, e.weapon);
        // Recul : la vue du pilote saute vers le haut à chacun de ses tirs (moitié moins de dos qu'au viseur)
        const view = recoilKick(e.weapon).view;
        const player = this.world.player;
        if (view > 0 && this.piloting && player && firingTurret(this.world, e.weapon, e.origin)?.block.bot === player) {
          this.rig.kick(view * (this.controls.scoping ? 1 : 0.5));
        }
        break;
      }
      case "projectileAdded":
        // Le joueur a tiré son ogive pilotée : il en prend les commandes
        if (e.projectile.shooter && e.projectile.shooter === this.world.player && weaponDef(e.projectile.weapon).projectile.guidance?.mode === "piloted") {
          this.warhead = e.projectile;
          this.warheadLaunched = true;
          this.warheadWatch = null;
        }
        break;
      case "projectileRemoved":
        if (e.projectile === this.warhead) {
          // On regarde l'explosion d'un peu en arrière sur la trajectoire, au-dessus du sol
          const back = sub(e.projectile.pos, scale(norm(e.projectile.vel), WARHEAD_BACK));
          this.warheadWatch = { eye: vec3(back.x, Math.max(back.y, WATCH_FLOOR), back.z), until: performance.now() / 1000 + WARHEAD_WATCH };
          this.warhead = null;
        }
        break;
      case "meleeHit": {
        // Un coup de son arme de contact : la vue saute, d'autant plus que le coup est fort
        if (this.piloting && e.block.bot === this.world.player) this.rig.kick(Math.min(MELEE_KICK_MAX, (MELEE_KICK * e.energy) / 1000));
        break;
      }
      case "impact": this.effects.spark(e.point); break;
      // (en effets réalistes, l'explosion est faite de particules : render/fx/blastFx.ts)
      case "explosion": if (this.fx.look === "simple") this.effects.explosion(e.point, e.radius, e.look); break;
      case "collision": this.effects.spark(e.point); break;
      case "empBurst": this.effects.empBurst(e.point, e.radius); break;
      case "stunned": this.stunned.add(e.bot); break;
      case "linkBroken": this.effects.spark(e.point); break;
      case "shieldHit": this.effects.shield(blockWorldPos(e.block), blockDef(e.block.type).shield?.radius ?? 1); break;
      case "blockRebuilt": this.effects.regrow(blockWorldPos(e.block)); break;
      case "barrierHit": this.effects.shield(e.point, 0.35); break;
      case "barrierRemoved":
        if (e.broken) this.effects.barrierBreak(e.barrier.center, e.barrier.width);
        break;
      case "blockRepaired": {
        // Une étincelle verte par bloc remis en état, au plus toutes les REPAIR_SPARK s
        const now = performance.now() / 1000;
        if ((this.repairSparks.get(e.block.id) ?? 0) > now) break;
        this.repairSparks.set(e.block.id, now + REPAIR_SPARK);
        this.effects.repairSpark(blockWorldPos(e.block));
        break;
      }
      case "damage": this.hud.refreshSoon(); break;
      case "botAdded": this.rosterChanged = true; break;
      case "botRemoved": this.rosterChanged = true; break;
      case "botKilled":
        if (this.attract) break;
        this.matchHud.onKill(e.bot, e.killer, e.cause);
        if (e.killer && e.killer === this.world.player) {
          this.markHit("kill");
          this.matchStats.kills++;
        }
        break;
      case "hit": this.onHit(e.victim, e.attacker, e.destroyed); break;
      case "matchOver": this.onMatchOver?.(e.winner); break;
      case "arenaChanged": this.showArena(this.world.arena); break;
      case "zoneChanged": {
        if (this.attract) break;
        const zone = this.world.arena.zones[e.zone];
        if (zone) this.matchHud.onZone(zone.label, e.owner, e.by);
        const team = this.world.player?.team ?? "blue";
        this.sound.ui(e.by === team ? "capture" : "lost");
        if (e.owner === team) this.matchStats.captures++;
        break;
      }
      default: break;
    }
  }

  /**
   * Retour de tir : marqueur quand un tir du joueur touche (en pilotant, ceux de son robot ; à la
   * caméra libre, les siens) ; arc et son quand son robot est touché.
   */
  private onHit(victim: Bot, attacker: Bot | null, destroyed: number): void {
    if (this.attract) return;
    const player = this.world.player;
    const mine = player ? attacker === player : attacker === null;
    if (mine && victim !== player) this.markHit(destroyed ? "crit" : "hit");
    if (player && victim === player && attacker && attacker !== player) {
      const from = attacker.lastPos;
      const at = player.lastPos;
      const bearing = Math.atan2(from.x - at.x, from.z - at.z);
      this.feedback.damageFrom(this.rig.heading - bearing, attacker.id);
      this.sound.ui("hurt");
    }
  }

  /** Marqueur au réticule (ou au pointeur), et son de confirmation ; un bloc détruit compte davantage. */
  private markHit(kind: MarkerKind): void {
    const p = this.controls.aimPoint();
    const box = this.controls.box;
    this.feedback.showMarker(p.x + box.left, p.y + box.top, kind);
    this.sound.ui(kind);
  }

  /** Vue des robots et des accessoires ; un pan de mur ou un arbre qui cède fait de la poussière. */
  private worldView(world: World): WorldView {
    const view = new WorldView(world, this.scene, this.assets, this.shadows);
    view.onPropBroken = (prop, at) => {
      const color = dustColor(prop.type);
      if (!color) return;
      if (this.fx.look === "realistic") this.fx.dust(at, prop.half, color);
      else this.effects.dust(at, prop.half, color);
    };
    view.setFxLook(this.fx.look);
    return view;
  }

  /** Décor, ciel et ombres de l'arène ; la caméra reste dans ses limites et au-dessus de son sol. */
  private showArena(layout: ArenaLayout): void {
    // (la nuit : le verre des lampes du décor et des fenêtres s'allument, avant que l'arène ne les pose)
    this.assets.setNight(!!layout.sky?.night);
    this.arenaView.show(layout);
    this.minimap.setArena(layout);
    this.showTitle();
    applyArenaLook(this.kit, layout);
    this.rig.setArena(layout.bounds.half, (x, z) => groundLevel(layout, x, z));
  }

  /** Titre du tableau (Tab) : le mode et l'arène. */
  private showTitle(): void {
    const mode = this.online ? t("hud.title.multiplayer") : modeName(this.mode);
    this.hud.setTitle(`${mode} · ${arenaName(this.world.arena)}`);
  }

  /** Tab enfoncé, relâché : le tableau des robots, de la partie et des commandes. */
  pressTab(): void {
    this.hud.pressTab();
  }

  releaseTab(): void {
    this.hud.releaseTab();
  }

  /** M : la carte entière. */
  toggleMap(): void {
    this.minimap.toggleBig();
  }

  /** Ferme le tableau et la carte (pause, nouvelle partie) : ils ne réapparaissent pas d'eux-mêmes. */
  closeOverlays(): void {
    this.hud.closeTab();
    this.minimap.toggleBig(false);
  }

  /** Les vues montrent désormais `world` (elles oublient ce qu'elles montraient). */
  private bind(world: World): void {
    for (const v of [this.view, this.projectiles, this.smokes, this.barriers, this.locomotion]) v.dispose();
    this.minimap.clear();
    this.unbindWorld();
    this.stunned.clear();
    this.feedback.clear();
    this.warhead = null;
    this.warheadWatch = null;
    this.view = this.worldView(world);
    this.projectiles = new ProjectileView(world, this.assets);
    this.projectiles.setFxLook(this.fx.look);
    this.smokes = new SmokeView(world, this.scene);
    this.smokes.setFxLook(this.fx.look);
    this.barriers = new BarrierView(world, this.scene);
    this.locomotion = new LocomotionView(world, this.scene, this.assets, this.shadows);
    this.sound.setWorld(world);
    this.fx.bind(world);
    this.lighting.bind(world);
    this.showArena(world.arena);
    this.unbindWorld = world.on((e) => this.onWorldEvent(e));
    this.setDetectionFilter();
    this.rosterChanged = true;
  }

  /**
   * Partie en réseau : le rendu passe sur la réplique du serveur, les commandes partent au serveur.
   * La simulation locale se met en veille.
   */
  startOnline(net: NetClient): void {
    endMatch(this.sim);
    this.sim.player = null;
    // (la partie solo du Worker s'arrête là où elle en est)
    this.local?.command({ t: "advance", dt: 0 });
    this.net = net;
    this.bind(net.replica);
    this.resetMatchStats();
    this.mode = "battle";
    this.attract = false;
    this.inputEnabled = true;
    this.frozen = false;
    this.armedBot = null;
    this.matchHud.clearFeed();
    this.rig.resetView();
    this.rig.setZoom(PILOT_CAMERA);
    this.refreshKeyHelp();
    document.body.classList.add("piloting");
    this.setFollow(-1);
    this.closeOverlays();
    this.showTitle();
  }

  /** Fin de la partie en réseau : on se déconnecte et le rendu revient à la simulation locale. */
  stopOnline(): void {
    if (!this.online) return;
    this.net!.close();
    this.net = this.local;
    this.bind(this.local?.replica ?? this.sim);
  }

  /** Une ligne dans le fil de la partie (crédits gagnés sur le serveur…). */
  note(text: string): void {
    this.matchHud.note(text);
  }

  /** Un bandeau quelques secondes en haut de l'écran (le serveur a relancé la partie après une erreur…). */
  notice(text: string): void {
    this.notices.show(text);
  }

  resetMatchStats(): void {
    this.matchStats.kills = 0;
    this.matchStats.captures = 0;
  }

  /**
   * Réticule (et cercle de dispersion), viseur, et instruments du pilote : tir en cloche, vol.
   * La dispersion est celle que prendrait un tir maintenant (combat/accuracy.ts), en pixels.
   */
  private showSights(): void {
    const player = this.world.player;
    const aiming = this.piloting && this.inputEnabled && !this.frozen;
    const reticle = aiming && this.controls.reticleAim;
    // Dans l'ogive pilotée (et le temps de regarder son explosion) : sa visée, au centre, bords assombris
    const piloted = this.warhead !== null || this.warheadWatch !== null;
    const shown: ArmId = piloted ? "warhead" : this.pilotWeapon;
    const scoping = this.controls.scoping || piloted;
    let spreadPx = 0;
    let unsteady = false;
    let masked = false;
    let ready: Readiness | null = null;
    // Arme de contact : rien à viser au loin ; la jauge montre le régime du rotor, ou le réarmement du bras
    if (isMeleeId(shown)) {
      if (reticle && player?.cockpit.alive) ready = meleeReadiness(liveMelee(player).filter((a) => a.weapon === shown), player.energy);
      this.reticle.update({ visible: reticle, weapon: shown, scoping, amount: this.rig.scopeAmount, magnification: this.rig.magnification, spreadPx: 0, unsteady: false, masked: false, readiness: ready });
      this.weaponSounds(shown, ready);
      this.instruments.showGunnery(null, scoping);
      this.instruments.showBombing(null);
      this.instruments.showWarhead(null);
      this.instruments.showLock(null);
      this.instruments.showFlight(aiming && player ? this.flight(player) : null);
      this.showGunMarks(null);
      this.showNoseMark(reticle && !this.controls.scoping ? player : null);
      return;
    }
    const weapon = weaponDef(shown);
    if (reticle && player?.cockpit.alive && !piloted) {
      const spread = aimSpread(player, weapon, scoping);
      const height = this.controls.box.height;
      spreadPx = (Math.tan(spread) / Math.tan(this.rig.camera.fov / 2)) * (height / 2);
      // Une arme de précision que le mouvement fait trembler : il faudrait s'immobiliser
      const base = weapon.spread * (scoping ? 1 : weapon.handling.hip);
      unsteady = weapon.handling.move >= 0.01 && spread - base > 0.01;
      // Toutes les tourelles de l'arme ont leur ligne de tir coupée par le robot lui-même
      const armed = liveTurrets(player).filter((t) => t.weapon === this.pilotWeapon);
      masked = armed.length > 0 && armed.every(lineOfFireBlocked);
      // Jauge autour du réticule : délai avant le prochain tir, chargeur ou chaleur
      if (armed.length > 0) ready = readiness(armed.map((t) => t.arm), weapon, player.energy);
    }
    this.reticle.update({
      visible: reticle, weapon: shown, scoping, amount: this.rig.scopeAmount,
      magnification: this.rig.magnification, spreadPx, unsteady, masked, readiness: ready,
    });
    this.weaponSounds(shown, ready);
    this.instruments.showGunnery(aiming && player && !piloted ? this.gunnery(player) : null, scoping);
    this.instruments.showBombing(aiming && player && !piloted ? this.bombing(player) : null);
    this.instruments.showWarhead(aiming && this.warhead ? this.warheadView(this.warhead) : null);
    const lock = aiming && player && !piloted ? this.lockView(player) : null;
    if (lock?.locked && !this.wasLocked) this.sound.ui("lock");
    this.wasLocked = !!lock?.locked;
    // Pendant le verrouillage, des bips de plus en plus rapprochés, jusqu'au double bip du verrou acquis
    const now = performance.now() / 1000;
    if (lock && !lock.locked && lock.progress > 0) {
      if (now >= this.nextLockBeep) {
        this.sound.ui("locking");
        this.nextLockBeep = now + LOCK_BEEP_SLOW - (LOCK_BEEP_SLOW - LOCK_BEEP_FAST) * lock.progress;
      }
    } else {
      this.nextLockBeep = 0;
    }
    this.instruments.showLock(lock);
    this.instruments.showFlight(aiming && player ? this.flight(player) : null);
    this.showGunMarks(reticle && player?.cockpit.alive && !piloted ? player : null);
    this.showNoseMark(reticle && !piloted && !scoping ? player : null);
  }

  /**
   * Marques du canon : là où pointe vraiment chaque tourelle de l'arme choisie (le premier obstacle
   * sur l'axe de son canon, ou sa portée). Les coups partent de sa bouche dans cet axe ; la tourelle
   * tourne à sa vitesse vers le réticule : tant qu'elle n'y est pas, sa marque en est écartée. Pas
   * pour un tir en cloche (son point de chute est marqué à part), des mines, des bombes.
   */
  private showGunMarks(player: Bot | null): void {
    const id = this.pilotWeapon;
    if (isMeleeId(id)) player = null;
    const weapon = weaponDef(isMeleeId(id) ? "rifle" : id);
    const shown = player && !lobbed(weapon) && !weapon.projectile.mine && !weapon.dropped && weapon.projectile.guidance?.mode !== "piloted"
      ? liveTurrets(player).filter((t) => t.weapon === this.pilotWeapon).slice(0, GUN_MARKS)
      : [];
    const marks = this.gunMarks;
    while (marks.children.length < GUN_MARKS) marks.append(document.createElement("i"));
    [...marks.children].forEach((mark, i) => {
      const t = shown[i];
      const at = t ? this.gunMark(t, weapon.range || AIM_RANGE) : null;
      const el = mark as HTMLElement;
      el.hidden = !at;
      if (at) el.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px)`;
    });
  }

  /** Où arrive l'axe du canon de cette tourelle, à l'écran (null : derrière la caméra). */
  private gunMark(t: Turret, range: number): { x: number; y: number } | null {
    const { muzzle, dir } = turretFrame(t);
    return this.toScreen(this.pick(muzzle, dir, range) ?? add(muzzle, scale(dir, range)));
  }

  /**
   * Sons de l'arme choisie : elle part en surchauffe, un coup revient dans un chargeur vide, ou
   * l'on presse la gâchette sur un chargeur vide (ou une arme à un coup déjà tirée). Un changement
   * d'arme ne compte pas comme une transition.
   */
  private weaponSounds(weapon: ArmId, ready: Readiness | null): void {
    const was = this.lastWeaponState;
    const trigger = this.sim.input.trigger;
    const pressed = trigger && !this.lastTrigger;
    this.lastWeaponState = ready ? { weapon, cause: ready.cause } : null;
    this.lastTrigger = trigger;
    if (!ready || !was || was.weapon !== weapon) return;
    if (ready.cause === "overheat" && was.cause !== "overheat") this.sound.ui("overheat");
    if (was.cause === "reload" && ready.cause !== "reload") this.sound.ui("reload");
    if (pressed && (ready.cause === "reload" || ready.cause === "spent")) this.sound.ui("dry");
  }

  /**
   * Tir en cloche avec l'arme choisie : hausse du canon et celle que commande le réticule, cap, et
   * point de chute de l'obus s'il partait maintenant (combat/ballistics.ts).
   */
  private gunnery(player: Bot): Gunnery | null {
    const id = this.pilotWeapon;
    if (isMeleeId(id)) return null;
    const weapon = weaponDef(id);
    const aim = this.sim.input.aim;
    if (!aim || !player.cockpit.alive || !lobbed(weapon)) return null;
    const t = liveTurrets(player).find((x) => x.weapon === id);
    if (!t) return null;
    const { dir, muzzle } = turretFrame(t);
    const inherit = muzzleVelocity(t, muzzle);
    const speed = weapon.projectile.speed;
    const want = reachableDirection(t, lobDirection(muzzle, aim, inherit, speed));
    const impact = predictImpact(muzzle, add(scale(dir, speed), inherit), weapon.projectile, (a, b) => this.segmentHit(a, b));
    const degrees = (x: number): number => (x * 180) / Math.PI;
    const elevation = (v: Vec3): number => degrees(Math.asin(Math.max(-1, Math.min(1, v.y))));
    return {
      elevation: elevation(dir),
      target: elevation(want),
      bearing: (degrees(Math.atan2(-dir.x, dir.z)) + 360) % 360,
      range: impact ? Math.hypot(impact.point.x - muzzle.x, impact.point.z - muzzle.z) : null,
      flight: impact ? impact.time : null,
      impact: impact ? this.toScreen(impact.point) : null,
      aligned: Math.acos(Math.max(-1, Math.min(1, dot(dir, want)))) < 0.02,
    };
  }

  /**
   * Bombes choisies : où tomberait une bombe lâchée maintenant (elle part avec la vitesse du robot),
   * dans combien de temps, et la zone de son explosion à l'écran.
   */
  private bombing(player: Bot): BombSight | null {
    const id = this.pilotWeapon;
    if (isMeleeId(id)) return null;
    const weapon = weaponDef(id);
    if (!weapon.dropped || !player.cockpit.alive) return null;
    const t = liveTurrets(player).find((x) => x.weapon === id);
    if (!t) return null;
    const { dir, muzzle } = turretFrame(t);
    const vel = add(muzzleVelocity(t, muzzle), scale(dir, weapon.projectile.speed));
    const impact = predictImpact(muzzle, vel, weapon.projectile, (a, b) => this.segmentHit(a, b));
    const at = impact && this.toScreen(impact.point);
    if (!impact || !at) return null;
    // Rayon de l'explosion, à l'écran : un point à cette distance, à l'horizontale, en travers de la vue
    const cam = this.rig.camera;
    const across = norm(cross(vec3(0, 1, 0), sub(toVec3(cam.target), toVec3(cam.position))));
    const edge = this.toScreen(add(impact.point, scale(across, weapon.projectile.explosion?.radius ?? 1)));
    const radius = edge ? Math.hypot(edge.x - at.x, edge.y - at.y) : 0;
    return { ...at, radius, time: impact.time };
  }

  /** Premier obstacle sur le segment de `a` à `b` (à travers son propre robot), pour suivre une trajectoire. */
  private segmentHit(a: Vec3, b: Vec3): Vec3 | null {
    const d = sub(b, a);
    const length = Math.hypot(d.x, d.y, d.z);
    return length > 1e-3 ? this.pick(a, scale(d, 1 / length), length) : null;
  }

  /** Ogive pilotée : temps de vol restant, altitude, vitesse, distance à son robot. */
  private warheadView(p: Projectile): WarheadView {
    const life = weaponDef(p.weapon).projectile.life;
    const player = this.world.player;
    return {
      left: Math.max(0, life - p.age), life, altitude: p.pos.y, speed: len(p.vel),
      range: player?.cockpit.alive ? distance(p.pos, player.lastPos) : null,
    };
  }

  /** Arme à verrouillage choisie : la cible qu'elle verrouille, à l'écran, et où en est le verrou. */
  private lockView(player: Bot): LockView | null {
    const id = this.pilotWeapon;
    if (isMeleeId(id) || !weaponDef(id).lock || !player.cockpit.alive) return null;
    const t = player.turrets.find((x) => x.weapon === this.pilotWeapon && x.block.alive && x.lockOn?.cockpit.alive);
    const screen = t?.lockOn ? this.toScreen(t.lockOn.cockpit.part.rb.worldCom()) : null;
    return t && screen ? { ...screen, progress: lockProgress(t), locked: isLocked(t) } : null;
  }

  /** Position à l'écran (px, dans la fenêtre) d'un point du monde ; null s'il est derrière la caméra. */
  private toScreen(p: Vec3): { x: number; y: number } | null {
    const cam = this.rig.camera;
    // Matrices recalculées : la caméra a bougé depuis la dernière image dessinée
    const transform = cam.getViewMatrix(true).multiply(cam.getProjectionMatrix(true));
    const point = new B.Vector3(p.x, p.y, p.z);
    if (B.Vector3.Dot(point.subtract(cam.position), cam.target.subtract(cam.position)) <= 0) return null;
    const ndc = B.Vector3.TransformCoordinates(point, transform);
    const box = this.controls.box;
    return { x: box.left + ((ndc.x + 1) / 2) * box.width, y: box.top + ((1 - ndc.y) / 2) * box.height };
  }

  /** Robot volant piloté : assiette, inclinaison, altitude, vitesses et cap. */
  private flight(player: Bot): Flight | null {
    if (!player.cockpit.alive || player.profile.mobility === "ground") return null;
    const rb = player.cockpit.part.rb;
    const q = rb.rotation();
    const forward = qrot(q, vec3(0, 0, 1));
    const left = qrot(q, vec3(1, 0, 0));
    const up = qrot(q, vec3(0, 1, 0));
    const v = rb.linvel();
    const com = rb.worldCom();
    const degrees = (x: number): number => (x * 180) / Math.PI;
    const plane = player.profile.mobility === "plane";
    return {
      pitch: degrees(Math.asin(Math.max(-1, Math.min(1, forward.y)))),
      // Sur tout le tour : dos au sol (une boucle, un tonneau), l'inclinaison passe 90°
      bank: degrees(Math.atan2(left.y, up.y)),
      altitude: com.y - groundLevel(this.world.arena, com.x, com.z),
      // Les gaz que tient le joueur (à la souris : la vitesse voulue ; en manuel : le régime voulu) ; plus de moteur : rien
      power: plane && engineRegime(player) !== null ? this.sim.input.power : null,
      mode: plane ? t(this.manualFlight ? "hud.flight.manual" : "hud.flight.mouse") : null,
      speed: Math.hypot(v.x, v.y, v.z),
      climb: v.y,
      heading: (degrees(Math.atan2(-forward.x, forward.z)) + 360) % 360,
    };
  }

  /** Arme dont on montre le réticule : celle choisie, ou la première du robot piloté. */
  private get pilotWeapon(): ArmId {
    return this.sim.input.weapon ?? this.pilotWeapons[0] ?? "rifle";
  }

  /** Le joueur pilote-t-il un robot ? */
  get piloting(): boolean {
    return this.world.player !== null || this.online || (this.inWorker && GAME_MODES[this.mode].pilot && this.playerProfile !== null);
  }

  /** Lance la boucle de rendu. */
  start(): void {
    const reported = new Set<string>();
    this.engine.runRenderLoop(() => {
      if (this.suspended) return;
      const profile = this.frameProfile;
      const t0 = profile ? performance.now() : 0;
      try {
        this.frame(Math.min(this.engine.getDeltaTime() / 1000, 0.1));
      } catch (err) {
        // Une erreur dans une image ne doit pas arrêter la boucle de Babylon (elle ne repartirait pas) ; on la signale une fois
        const text = String(err instanceof Error ? err.stack : err);
        if (!reported.has(text)) console.error(err);
        reported.add(text);
      }
      this.measure("rendu", () => this.scene.render());
      // L'image dessinée, la simulation reprend ses corps (voir `simulateFrame`)
      this.poses.end();
      if (profile) {
        profile.frames++;
        profile.totals.push(performance.now() - t0);
      }
    });
    window.addEventListener("resize", () => {
      // Le zoom du navigateur change le rapport de pixels : l'échelle de rendu en dépend
      this.applyRenderScale();
      this.engine.resize();
    });
  }

  /**
   * Commence une partie dans le mode `id` ; `pilot` : le robot du joueur, dans un mode piloté ;
   * `arena` : l'arène (sinon, celle de la partie précédente) ; `roster` : dans un mode sans joueur,
   * ces robots-là plutôt que des robots tirés au sort.
   */
  startMode(id: GameModeId, pilot: BotProfile | null = null, arena: ArenaKey = this.arenaId, roster: readonly BotProfile[] | null = null): void {
    this.mode = id;
    this.fixedRoster = roster;
    this.arenaId = arena;
    this.resetMatchStats();
    // L'IA figée et le ralenti de l'arène libre ne suivent pas dans une autre partie (en pilotant, leurs boutons sont cachés)
    this.setPaused(false);
    if (this.timeScale !== 1) this.toggleSlowmo();
    this.playerProfile = pilot;
    this.attract = false;
    this.inputEnabled = true;
    this.frozen = false;
    this.rig.resetView();
    this.closeOverlays();
    this.newWave();
    if (this.piloting) this.rig.setZoom(PILOT_CAMERA);
  }

  /**
   * Partie préparée derrière l'écran de chargement : elle attend, figée, sans commandes du joueur
   * (en réseau, la réplique continue de recevoir le monde), jusqu'à `release`.
   */
  hold(): void {
    this.frozen = true;
    this.inputEnabled = false;
  }

  /** La partie commence : la simulation avance, le joueur a les commandes. */
  release(): void {
    this.frozen = false;
    this.inputEnabled = true;
  }

  /**
   * Prépare tout ce que la partie montrera, avant de la montrer (écran de chargement) : un exemplaire
   * de chaque projectile, mine, traçante, explosion, éclair, effet, mur d'énergie, nuage de fumée et
   * feu est posé devant la caméra (caché par l'écran de chargement), le temps de quelques images,
   * puis on attend que la scène soit prête (matières et shaders compilés, ombres et halo compris) ;
   * ensuite tout est retiré. Sans cela, le premier tir de chaque arme, la première explosion, le
   * premier effet construisaient leur modèle et compilaient leurs shaders en pleine partie : autant
   * de saccades. `progress` reçoit la part faite (0 à 1).
   */
  async prewarm(progress: (done: number) => void = () => {}): Promise<void> {
    const target = this.rig.camera.target;
    const at = { x: target.x, y: target.y, z: target.z };
    progress(0.05);
    const cleanups = [this.projectiles.warmUp(at), this.view.warmUp(at), this.smokes.warmUp(at), this.barriers.warmUp(at)];
    this.effects.warmUp(at);
    this.fx.warmUp(at);
    progress(0.3);
    await this.renderedFrames(2);
    progress(0.55);
    // Au plus `READY_WAIT` s : un shader qui ne se dirait jamais prêt ne doit pas bloquer la partie
    const ready = await Promise.race([
      this.scene.whenReadyAsync().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), READY_WAIT * 1000)),
    ]);
    if (!ready) console.warn(`Préparation : la scène n'était pas prête au bout de ${READY_WAIT} s, la partie commence quand même`);
    await this.renderedFrames(1);
    progress(0.85);
    for (const cleanup of cleanups) cleanup();
    this.effects.clear();
    this.fx.clear();
    await this.renderedFrames(1);
    progress(1);
  }

  /** Attend que `n` images aient été dessinées (la boucle de rendu tourne). */
  private renderedFrames(n: number): Promise<void> {
    return new Promise((resolve) => {
      let left = n;
      const observer = this.scene.onAfterRenderObservable.add(() => {
        if (--left > 0) return;
        this.scene.onAfterRenderObservable.remove(observer);
        resolve();
      });
    });
  }

  /**
   * En réseau : attend que la réplique ait reçu le monde et le robot du joueur (au plus `timeout`
   * secondes). Vrai s'il est là.
   */
  async waitForOnlineWorld(timeout = 10): Promise<boolean> {
    const end = performance.now() + timeout * 1000;
    while (performance.now() < end) {
      if (!this.net) return false;
      if (this.world.player) return true;
      await this.renderedFrames(1);
    }
    return !!this.world.player;
  }

  /**
   * La partie solo dans le Worker : attend que son monde soit arrivé (ses robots, et celui du joueur
   * s'il pilote), au plus `timeout` s ; sans Worker, tout de suite.
   */
  async worldReady(timeout = 10): Promise<void> {
    if (!this.local || !this.inWorker) return;
    const end = performance.now() + timeout * 1000;
    const pilot = GAME_MODES[this.mode].pilot && this.playerProfile !== null;
    while (performance.now() < end) {
      // (le Worker du moment : celui du TypeScript remplace celui de la Rust qui s'arrête sur une erreur)
      const link = this.local;
      if (!link || !this.inWorker) return;
      if (link.arrived && (!pilot || this.world.player)) return;
      await this.renderedFrames(1);
    }
    console.warn(`Partie solo : le monde du Worker n'est pas arrivé au bout de ${timeout} s`);
  }

  /** Démonstration derrière le menu : une bataille que la caméra survole, sans le joueur. */
  startDemo(): void {
    this.mode = "arena";
    this.fixedRoster = null;
    this.arenaId = randomArena();
    this.playerProfile = null;
    this.attract = true;
    this.inputEnabled = false;
    this.frozen = false;
    this.controls.triggerHeld = false;
    this.newWave();
  }

  setShadows(on: boolean): void {
    const light = this.shadows.getLight();
    light.shadowEnabled = on;
  }

  /** Qualité des ombres : taille de la carte d'ombre (dans la limite de la carte graphique) et filtrage de leurs bords. */
  setShadowQuality(quality: ShadowQuality): void {
    const { size, filtering } = SHADOW_MAPS[quality];
    const mapSize = Math.min(size, this.engine.getCaps().maxTextureSize);
    if (this.shadows.mapSize !== mapSize) this.shadows.mapSize = mapSize;
    this.shadows.filteringQuality = filtering;
  }

  /** Ombres lointaines : la cascade la plus lointaine refaite à chaque image, ou une image sur deux (render/scene.ts, `FarCascade`). */
  setFarShadows(mode: FarShadows): void {
    if (this.kit.farShadows) this.kit.farShadows.every = mode === "half" ? 2 : 1;
  }

  /** Part de la résolution de l'écran à laquelle l'image est calculée (1 : pleine résolution, écrans haute densité compris). */
  setRenderScale(scale: number): void {
    this.renderScale = scale;
    this.applyRenderScale();
  }

  private applyRenderScale(): void {
    // (au plus deux pixels par pixel CSS : un téléphone en a souvent trois, neuf fois plus d'image à calculer qu'un écran ordinaire)
    const level = 1 / (Math.min(2, window.devicePixelRatio || 1) * this.renderScale);
    if (Math.abs(this.engine.getHardwareScalingLevel() - level) > 1e-6) this.engine.setHardwareScalingLevel(level);
  }

  /** Effets réduits : moins de lueurs, d'étincelles et de fumées d'explosion à la fois. */
  setReducedEffects(on: boolean): void {
    this.effects.setReduced(on);
    this.fx.setReduced(on);
  }

  /**
   * Fumée et flammes (réglage graphique) : réalistes (volutes éclairées, flammes animées, boules de
   * feu, render/fx/sprites.ts) ou simples (des sphères). Le changement vaut à chaud : les effets en
   * cours changent d'allure à l'image suivante.
   */
  setFxLook(look: FxLook): void {
    if (look === this.fx.look) return;
    this.fx.setLook(look);
    this.assets.setFlameLook(look);
    this.view.setFxLook(look);
    this.projectiles.setFxLook(look);
    this.smokes.setFxLook(look);
    // Les sphères d'une explosion en cours ne passent pas d'une allure à l'autre
    this.effects.clear();
  }

  /** Halo autour de ce qui brille (réglage graphique). */
  setGlow(on: boolean): void {
    this.lighting.setGlow(on);
  }

  /** Lumières des explosions, des gros coups de canon et des feux (réglage graphique). */
  setDynamicLights(on: boolean): void {
    this.lighting.setLights(on);
  }

  /** Distorsion de l'air chaud (réglage graphique). */
  setHeatHaze(on: boolean): void {
    this.lighting.setHeatHaze(on);
  }

  /** Relance la vague (ou la partie) du mode en cours. */
  newWave(): void {
    const mode = GAME_MODES[this.mode];
    if (this.inWorker) {
      this.prepare();
      const pilot = mode.pilot ? this.playerProfile : null;
      this.local!.command({ t: "start", mode: this.mode, arena: this.arenaId, map: arenaFileFor(this.arenaId), pilot, roster: pilot ? null : this.fixedRoster ?? pickRoster(mode), seed: this.seed ?? undefined });
      this.finish();
      return;
    }
    if (mode.pilot && this.playerProfile) {
      this.prepare();
      const bots = spawnTeams(this.sim, matchEntries(mode, this.playerProfile));
      bots[0].controller = "player";
      this.sim.player = bots[0];
      this.finish();
    } else {
      this.spawn(this.fixedRoster ?? pickRoster(mode));
    }
  }

  /** Vague composée de ces robots-là, sans joueur (débogage : `__casse.spawnWave(["tank", "heli"])`). */
  spawn(profiles: readonly BotProfile[]): void {
    this.prepare();
    if (this.inWorker) this.local!.command({ t: "spawn", profiles });
    else spawnWave(this.sim, profiles);
    this.finish();
  }

  private prepare(): void {
    // (peut arriver pendant le rendu d'une image : la démonstration relance sa vague depuis la caméra)
    this.poses.reset();
    this.matchHud.clearFeed();
    // Dans le Worker : la session refait l'arène et les robots (net/session.ts)
    if (this.inWorker) return;
    endMatch(this.sim);
    this.sim.loadArena(this.arenaId);
    this.sim.player = null;
    this.sim.combat = GAME_MODES[this.mode].combat;
    this.matchHud.clearFeed();
  }

  private finish(): void {
    const mode = GAME_MODES[this.mode];
    if (!this.inWorker) {
      if (mode.match && this.piloting) startMatch(this.sim, mode.match);
      // La bataille de la mesure du rendu (robots imposés) : sans fin, les robots détruits réapparaissent (la charge ne baisse pas)
      else if (this.fixedRoster) startMatch(this.sim, ENDLESS_MATCH);
    }
    this.waveStart = performance.now() / 1000;
    this.hud.setEnemies(this.world.bots, this.world.player);
    this.showTitle();
    this.rosterChanged = false;
    this.setFollow(-1);
    this.setDetectionFilter();
    this.refreshKeyHelp();
    document.body.classList.toggle("piloting", this.piloting);
    // Armes du HUD : celles du robot piloté (showArsenal les reprend), ou tout le catalogue à la caméra libre
    if (this.piloting) this.armedBot = null;
    else this.resetArsenal();
    this.syncViews();
  }

  /** Pilote : on ne voit que ce que son équipe a repéré ; caméra libre : tout. */
  private setDetectionFilter(): void {
    const seen = (bot: Bot): boolean => {
      const player = this.world.player;
      return !player || bot.team === player.team || isDetected(this.world, player.team, bot);
    };
    this.hud.setDetection(this.piloting ? seen : null);
    this.minimap.setDetection(this.piloting ? seen : null);
    // Pas d'étiquette sur son propre robot : elle masquerait la visée
    this.view.tagFilter = this.piloting ? (bot) => bot !== this.world.player && seen(bot) : () => true;
  }

  /** Le robot du joueur se saborde (renversé, coincé) : il réapparaîtra. */
  selfDestruct(): void {
    if (this.frozen) return;
    if (this.net) this.net.send({ t: "selfDestruct" });
    else if (this.sim.player) selfDestruct(this.sim, this.sim.player);
  }

  /**
   * Un impact de la console (`__casse.applyDamage`) : dans la simulation de la page (`here`), ou
   * demandé à la session du Worker (sans cible imposée : l'impact touche ce qui est au point).
   */
  debugDamage(point: Vec3, dir: Vec3, weapon: Weapon, target: HitTarget | null, here: (sim: Simulation) => void): void {
    if (!this.inWorker) {
      here(this.sim);
      return;
    }
    const id = WEAPON_IDS.find((w) => WEAPONS[w] === weapon || WEAPONS[w].projectile === weapon.projectile);
    if (!id) return;
    if (target) console.warn("Partie solo dans le Worker : l'impact touche ce qui est au point, sans cible imposée");
    this.local!.command({ t: "damage", point, dir, weapon: id, shooter: this.rig.position });
  }

  /** Avance la simulation de `n` pas d'un coup, puis met le rendu à jour. */
  simulate(n: number): void {
    this.poses.reset();
    if (this.inWorker) {
      this.local!.command({ t: "steps", n });
      return;
    }
    for (let i = 0; i < n; i++) this.sim.step();
    this.syncViews();
  }

  /**
   * Tire à la caméra libre vers le pixel (x, y) du canvas si l'arme est prête (cadence, chaleur,
   * munitions), ou dans tous les cas si `free` (débogage). Le projectile part d'un canon fictif en
   * bas à droite de l'écran vers le point visé ; une mine est posée là où l'on vise ; un missile à
   * tête chercheuse poursuit l'ennemi le plus proche de la visée.
   */
  fireAt(x: number, y: number, free = false): void {
    const { origin, dir, point } = this.aimAt(x, y);
    const spec = weaponDef(this.weapon).projectile;
    const shoot = (from: Vec3, d: Vec3, homing: Bot | null = null): void => {
      if (free) this.sim.fire(this.weapon, from, d, homing);
      else this.sim.tryFire(this.weapon, from, d, homing);
    };
    if (this.inWorker) {
      // La session tire, et cherche elle-même la cible d'une tête chercheuse
      const fire = (from: Vec3, d: Vec3, homing: { from: Vec3; dir: Vec3; airOnly: boolean } | null = null): void =>
        this.local!.command({ t: "fire", weapon: this.weapon, origin: from, dir: d, free, homing });
      if (spec.mine) {
        fire(add(point, vec3(0, 1, 0)), vec3(0, -1, 0));
        return;
      }
      const side = norm(cross(dir, vec3(0, 1, 0)));
      const from = add(add(origin, scale(dir, 2)), add(scale(side, -0.6), vec3(0, -0.5, 0)));
      fire(from, norm(sub(point, from)), spec.guidance?.mode === "homing" ? { from: origin, dir, airOnly: !!spec.guidance.airOnly } : null);
      return;
    }
    if (spec.mine) {
      shoot(add(point, vec3(0, 1, 0)), vec3(0, -1, 0));
      return;
    }
    const right = norm(cross(dir, vec3(0, 1, 0)));
    const muzzle = add(add(origin, scale(dir, 2)), add(scale(right, -0.6), vec3(0, -0.5, 0)));
    const homing = spec.guidance?.mode === "homing" ? findHomingTarget(this.sim, origin, dir, !!spec.guidance.airOnly, null) : null;
    shoot(muzzle, norm(sub(point, muzzle)), homing);
  }

  /** Mines télécommandées posées par le robot du joueur (celles de ses vies précédentes comprises) et pas encore sautées. */
  private remoteMines(): number {
    const player = this.world.player;
    if (!player) return 0;
    let count = 0;
    for (const p of this.world.projectiles) {
      if (p.landed && weaponDef(p.weapon).projectile.mine?.trigger === "remote" && (p.shooter === player || (!!player.input && p.shooter?.input === player.input))) count++;
    }
    return count;
  }

  /** Tire si l'arme est prête. */
  tryFire(x: number, y: number): void {
    this.fireAt(x, y);
  }

  /** Arme suivante (`step` 1) ou précédente (-1) : celles du robot piloté, ou tout le catalogue à la caméra libre. */
  cycleWeapon(step: number): void {
    const order: readonly ArmId[] = this.piloting ? this.pilotWeapons : WEAPON_IDS;
    if (!order.length) return;
    const from = order.indexOf(this.piloting ? this.sim.input.weapon ?? order[0] : this.weapon);
    this.selectWeapon(order[(Math.max(0, from) + step + order.length) % order.length]);
    this.sound.ui("click");
  }

  /**
   * Les touches choisies par le joueur, partout où elles sont nommées : le tableau des commandes
   * (Tab), les touches des armes, les rappels du HUD (`[data-key-action]`, dans index.html).
   */
  refreshKeyHelp(): void {
    const keys = (id: ActionId): string => this.controls.keyName(id, "keys");
    const pads = (id: ActionId): string => this.controls.padName(id);
    this.hud.setHelp(this.piloting ? pilotKeys(keys, pads) : freeKeys(keys, pads));
    this.hud.refreshWeaponKeys();
    for (const el of document.querySelectorAll<HTMLElement>("[data-key-action]")) {
      const id = el.dataset.keyAction as ActionId;
      if (id in ACTIONS) el.textContent = this.controls.keyName(id);
    }
  }

  /** Choisit une arme : celle de la caméra libre, ou le groupe de tourelles qui tire, en pilotant. */
  selectWeapon(id: ArmId): void {
    if (this.piloting) this.sim.input.weapon = id;
    // (la caméra libre n'a pas d'arme de contact)
    else if (!isMeleeId(id)) this.weapon = id;
    else return;
    this.hud.showWeapon(id);
  }

  setPaused(paused: boolean): void {
    this.sim.aiPaused = paused;
    if (this.inWorker) this.local!.command({ t: "pause", ai: paused });
    this.hud.showPaused(paused);
  }

  toggleSlowmo(): void {
    this.timeScale = this.timeScale === 1 ? SLOWMO_SCALE : 1;
    this.hud.showSlowmo(this.timeScale !== 1);
  }

  /** Suit le robot d'index `i` avec la caméra (-1 : arrêter). */
  setFollow(i: number): void {
    this.follow = i;
    this.hud.showFollow(i);
    if (i >= 0) this.rig.closeIn();
  }

  followNext(): void {
    const bots = this.world.bots;
    if (bots.length) this.setFollow((this.follow + 1) % bots.length);
  }

  /**
   * Rayon de visée sous le pixel (x, y) : origine, direction, et premier point touché (ou au loin), à
   * travers son propre robot, et au-delà de ce qui le sépare de la caméra (voir `pick`).
   */
  private aimAt(x: number, y: number): { origin: Vec3; dir: Vec3; point: Vec3 } {
    const ray = this.scene.createPickingRay(x, y, B.Matrix.Identity(), this.rig.camera, false);
    const origin = toVec3(ray.origin);
    const dir = toVec3(ray.direction);
    // En pilotant, ce qui est entre la caméra et son robot ne compte pas : la caméra traverse le
    // décor, et une caisse derrière le robot ferait viser à reculons (dans l'ogive, la caméra est loin de lui)
    const player = this.warhead ? null : this.world.player;
    const skip = player ? Math.max(0, dot(sub(player.lastPos, origin), dir) - player.radius) : 0;
    const point = this.pick(add(origin, scale(dir, skip)), dir, AIM_RANGE - skip);
    // Un missile, une ogive, une bombe sous le réticule, avant l'obstacle : on le vise lui (on peut l'abattre)
    const reach = point ? distance(origin, point) : AIM_RANGE;
    const missile = this.pickProjectile(origin, dir, skip, reach);
    return { origin, dir, point: missile ?? point ?? add(origin, scale(dir, AIM_RANGE)) };
  }

  /**
   * Projectile qu'on peut abattre (voir combat/interception.ts) sous le rayon de visée, entre
   * `from` et `to` m : sa sphère est un peu grossie, pour qu'on puisse le viser. Pas les siens.
   */
  private pickProjectile(origin: Vec3, dir: Vec3, from: number, to: number): Vec3 | null {
    const player = this.world.player;
    let best: Vec3 | null = null;
    let bestT = to;
    for (const p of this.world.projectiles) {
      const hull = weaponDef(p.weapon).projectile.hull;
      if (!hull || p.done || (player && p.shooter === player)) continue;
      const t = sphereHit(origin, dir, p.pos, hull.radius + AIM_HULL_MARGIN);
      if (t !== null && t >= from && t < bestT) {
        best = p.pos;
        bestT = t;
      }
    }
    return best;
  }

  /**
   * Premier obstacle sur le rayon (`dir` unitaire) à moins de `length` m, à travers son propre
   * robot. En réseau, sans physique locale, on cherche parmi les meshes de la scène.
   */
  private pick(origin: Vec3, dir: Vec3, length: number): Vec3 | null {
    if (this.net) {
      const player = this.world.player;
      // Le relief d'abord, sans la scène (render/terrainPick.ts : ses triangles ne sont pas visables par
      // elle) ; puis ce qu'il y a de plus près dans la scène
      const terrain = this.world.arena.terrain;
      const ground = terrain ? pickTerrain(terrain, origin, dir, length) : null;
      const ray = new B.Ray(new B.Vector3(origin.x, origin.y, origin.z), new B.Vector3(dir.x, dir.y, dir.z), ground ?? length);
      const hit = this.scene.pickWithRay(ray, (m) => m.isPickable && m.isEnabled() && !(player && this.view.belongsTo(m, player)));
      if (hit?.hit && hit.pickedPoint) return toVec3(hit.pickedPoint);
      return ground === null ? null : add(origin, scale(dir, ground));
    }
    return this.sim.raycast(origin, dir, length, this.sim.player)?.point ?? null;
  }

  private frame(dt: number): void {
    this.measure("commandes", () => {
      this.controls.updatePointer(this.piloting && this.inputEnabled && !this.frozen);
      this.controls.poll(dt);
      this.readInput(dt);
    });
    if (this.inWorker) this.measure("réplique", () => this.replayLocal(dt));
    else if (this.net) this.measure("réplique", () => this.replay(dt));
    else this.measure("simulation", () => this.simulateFrame(dt));

    if (this.rosterChanged) {
      this.hud.setEnemies(this.world.bots, this.world.player);
      this.rosterChanged = false;
    }
    this.measure("vues", () => {
      this.syncViews();
      this.locomotion.sync(dt);
      this.showStuns(dt);
    });
    this.measure("effets", () => {
      this.effects.update(dt);
      this.fx.update(dt, this.rig.position, this.rig.inWeapon ? this.world.player : null);
    });
    this.measure("arène", () => {
      this.arenaView.update(dt);
      this.zoneView.sync(this.world, performance.now() / 1000);
    });
    this.measure("lumières", () => this.lighting.update());
    this.measure("caméra", () => this.updateCamera(dt));
    // Le balourd d'une arme de contact du joueur fait trembler la vue, et sa lame qui mord la secoue
    const pilot = this.world.player;
    if (this.piloting && !this.attract && !this.frozen && pilot?.cockpit.alive && pilot.melee.length) this.rig.shake(Math.max(vibration(pilot) * SHAKE_VIEW, biteShake(pilot)));
    this.measure("caméra", () => this.rig.update(dt));
    this.measure("visées", () => this.showSights());
    this.measure("son", () => this.sound.update(this.rig.camera, dt));
    const fps = this.engine.getFps();
    const stats = this.net
      ? { destroyed: this.net.replica.destroyedCount, bodies: this.net.replica.bodies, physMs: 0, fps }
      : { destroyed: this.sim.destroyedCount, bodies: this.sim.world.bodies.len(), physMs: this.physMs, fps };
    this.measure("HUD", () => {
      this.feedback.update();
      this.hud.update(dt, this.world, stats);
      this.updateMap(dt);
      this.showArsenal();
      this.matchHudTimer -= dt;
      if (this.matchHudTimer <= 0) {
        this.matchHud.update(this.world);
        this.matchHudTimer = MATCH_HUD_REFRESH;
      }
    });
  }

  /** Fait `work`, et, si la mesure par étape est active (`frameProfile`), ajoute son temps à l'étape `name`. */
  private measure(name: string, work: () => void): void {
    const profile = this.frameProfile;
    if (!profile) {
      work();
      return;
    }
    const t0 = performance.now();
    try {
      work();
    } finally {
      profile.times[name] = (profile.times[name] ?? 0) + performance.now() - t0;
    }
  }

  /**
   * Mini-carte : centrée sur son robot (même détruit : son épave), ou sur ce que regarde la caméra
   * libre ; le cône montre où regarde la caméra.
   */
  private updateMap(dt: number): void {
    const cam = this.rig.camera;
    const player = this.world.player;
    const center = player ? player.lastPos : toVec3(cam.target);
    const look = vec3(cam.target.x - cam.position.x, 0, cam.target.z - cam.position.z);
    this.minimap.update(dt, this.world, center, look);
  }

  /** En réseau : la réplique rejoue les images reçues, et les commandes partent au serveur. */
  private replay(dt: number): void {
    this.net!.replica.advance(dt);
    if (this.inputPacer.due(dt, this.sim.input)) this.net!.send({ t: "input", input: this.sim.input });
  }

  /**
   * La partie solo dans le Worker : ses commandes et le temps qui passe (au ralenti, ou rien pendant
   * la pause) partent à chaque image ; la réplique rejoue les images reçues ; le tir continu de la
   * caméra libre.
   */
  private replayLocal(dt: number): void {
    const step = this.frozen ? 0 : dt * this.timeScale;
    const link = this.local!;
    link.command({ t: "input", input: this.sim.input, aim: this.sim.playerAim });
    link.command({ t: "advance", dt: step });
    link.replica.advance(step);
    if (this.inputEnabled && !this.frozen && !this.piloting && this.controls.freeTrigger && WEAPONS[this.weapon].automatic) {
      const p = this.controls.aimPoint();
      this.tryFire(p.x, p.y);
    }
  }

  /** En local : la physique à pas fixe (rien pendant la pause), et le tir continu de la caméra libre. */
  private simulateFrame(dt: number): void {
    if (!this.frozen) this.accumulator += dt * this.timeScale;
    let steps = 0;
    const t0 = performance.now();
    while (this.accumulator >= STEP && steps < MAX_STEPS_PER_FRAME) {
      this.sim.step();
      this.poses.capture(this.sim);
      this.accumulator -= STEP;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;
    if (steps) this.physMs = this.physMs * 0.85 + ((performance.now() - t0) / steps) * 0.15;
    // Jusqu'à la fin de l'image, le rendu voit les poses entre les deux derniers pas, à la part du
    // pas suivant déjà écoulée : tout glisse, quel que soit le rythme de l'écran (120, 144 Hz…)
    this.poses.begin(this.accumulator / STEP);

    // Caméra libre, arme automatique : tir continu tant que le bouton (ou la touche de tir) est maintenu
    if (this.inputEnabled && !this.frozen && !this.piloting && this.controls.freeTrigger && WEAPONS[this.weapon].automatic) {
      const p = this.controls.aimPoint();
      this.tryFire(p.x, p.y);
    }
  }

  /**
   * Commandes du joueur pour ce pas : en pilotant, conduite, visée et gâchette de son robot ; à la
   * caméra libre, le point visé par les missiles téléguidés. Tout est relâché derrière un menu.
   */
  private readInput(dt: number): void {
    const input = this.sim.input;
    const active = this.inputEnabled && !this.frozen;
    // Dans l'ogive (et le temps de regarder son explosion), on vise au centre : elle va là où l'on regarde
    this.controls.centerAim = this.warhead !== null || this.warheadWatch !== null;
    const pointer = this.controls.aimPoint();
    const ray = active ? this.aimAt(pointer.x, pointer.y) : null;
    const aim = ray?.point ?? null;
    this.sim.playerAim = aim;
    if (!this.piloting) return;
    const axes = active ? this.controls.pilotAxes() : { throttle: 0, steer: 0, climb: 0, boost: false, brake: 0 };
    if (this.flyingPlane) this.steerPlane(dt, axes, active, ray?.dir ?? null);
    else {
      input.manual = false;
      input.look = null;
      input.throttle = axes.throttle;
      input.steer = axes.steer;
      input.climb = axes.climb;
      input.boost = axes.boost;
      input.brake = axes.brake;
      // En vol, le lacet (drone, hélicoptère : il pivote sur place), en douceur comme le manche
      this.stick.yaw = this.flying ? this.stick.yaw + clamp((active ? this.controls.rudder : 0) - this.stick.yaw, -STICK_RATE * dt, STICK_RATE * dt) : 0;
      input.yaw = this.stick.yaw;
    }
    input.aim = aim;
    input.trigger = active && this.controls.firing;
    input.scope = active && this.controls.scoping;
    input.relative = this.relativeDrive;
    input.heading = this.rig.heading;
    // Mines télécommandées : la touche tenue les fait sauter ; un déclic quand on appuie, s'il y en a
    const detonate = active && this.controls.detonating;
    const remote = this.remoteMines();
    if (detonate && !input.detonate && remote > 0) this.sound.ui("detonate");
    input.detonate = detonate;
    input.flares = active && this.controls.launchingFlares;
    const weapon = input.weapon && !isMeleeId(input.weapon) ? weaponDef(input.weapon) : null;
    this.controls.showScopeHint(active && !!weapon?.scopeOnly && !input.scope);
    this.controls.showDetonateHint(active && remote > 0 ? remote : 0, this.flying);
    // Un missile ennemi fonce sur lui : l'alerte, et la touche des leurres s'il en a
    const player = this.world.player;
    const threat = active && player?.cockpit.alive ? incomingMissile(this.world.projectiles, player, MISSILE_ALERT) : null;
    this.controls.showMissileHint(threat !== null, player && flareCapacity(player) > 0 ? player.flares.charges : null);
  }

  /** Le joueur pilote un avion (en état de voler). */
  private get flyingPlane(): Bot | null {
    const player = this.world.player;
    return player?.cockpit.alive && player.profile.mobility === "plane" ? player : null;
  }

  /**
   * Le joueur pilote un robot volant ou un avion (en état de voler) : les commandes « en vol » valent
   * (monter, lacet…), celles « au sol » non (freiner) ; voir input/bindings.ts.
   */
  get flying(): boolean {
    const player = this.world.player;
    return !!player?.cockpit.alive && player.profile.mobility !== "ground";
  }

  /**
   * Avion : les gaz à part de la direction (avancer et reculer les montent et les baissent, le boost
   * les pousse à fond tant qu'on le tient) ; virer (gauche, droite), cabrer et piquer (monter,
   * descendre), le palonnier (lacet), en douceur. À la souris, l'avion va là où regarde le réticule
   * (`look`), sauf pendant qu'on pilote au clavier : il garde alors sa route et la caméra le suit.
   * En manuel, ces touches sont le manche (voir `flyManual`).
   */
  private steerPlane(dt: number, axes: { throttle: number; steer: number; climb: number; boost: boolean; brake: number }, active: boolean, look: Vec3 | null): void {
    const input = this.sim.input;
    const plane = this.flyingPlane!;
    // Un nouvel avion (apparition) part à sa vitesse de croisière ; la vue se met derrière son nez,
    // à l'horizontale (la caméra de départ regarde le robot d'en haut : il piquait droit au sol)
    if (plane !== this.flown) {
      this.flown = plane;
      this.power = CRUISE_POWER;
      this.snapView = true;
    }
    const ramp = (from: number, to: number): number => from + clamp(to - from, -STICK_RATE * dt, STICK_RATE * dt);
    this.stick.pitch = ramp(this.stick.pitch, axes.climb);
    this.stick.roll = ramp(this.stick.roll, axes.steer);
    this.stick.yaw = ramp(this.stick.yaw, active ? this.controls.rudder : 0);
    this.power = clamp(this.power + axes.throttle * POWER_RATE * dt, 0, 1);
    input.manual = this.manualFlight;
    input.throttle = 0;
    input.steer = this.stick.roll;
    input.climb = this.stick.pitch;
    input.yaw = this.stick.yaw;
    input.power = axes.boost ? 1 : this.power;
    input.boost = false;
    input.brake = 0;
    const keys = Math.max(Math.abs(this.stick.pitch), Math.abs(this.stick.roll), Math.abs(this.stick.yaw)) > 0.05;
    this.keySteer = keys ? KEY_STEER_HOLD : Math.max(0, this.keySteer - dt);
    input.look = !this.manualFlight && this.keySteer <= 0 && !this.snapView ? look : null;
  }

  /** Bascule le pilotage de l'avion (à la souris, manuel) ; les gaz restent où ils étaient. */
  toggleFlight(): void {
    const plane = this.flyingPlane;
    if (!plane) return;
    this.manualFlight = !this.manualFlight;
    this.flown = plane;
    this.note(this.flightNote());
    this.sound.ui("click");
    this.onFlightChange?.(this.manualFlight);
  }

  /** Ce que font les touches dans le pilotage choisi (une ligne du fil, en le basculant). */
  private flightNote(): string {
    const k = (id: ActionId): string => this.controls.keyName(id);
    const pair = (a: ActionId, b: ActionId): string => `${k(a)} · ${k(b)}`;
    const throttle = pair("forward", "back");
    return this.manualFlight
      ? t("hud.note.manualFlight", { pitch: pair("climb", "descend"), roll: pair("left", "right"), rudder: pair("yawLeft", "yawRight"), throttle })
      : t("hud.note.mouseFlight", { throttle, turn: pair("left", "right"), pitch: pair("climb", "descend") });
  }

  /** Coupe les gaz (avion) : il plane, l'hélice s'arrête ; avancer les remet. */
  cutEngine(): void {
    if (!this.flyingPlane) return;
    this.power = 0;
  }

  /** Repère du nez de l'avion piloté à la souris (où il va) ; caché autrement. */
  private showNoseMark(player: Bot | null): void {
    const plane = player && !this.manualFlight && player.profile.mobility === "plane" && player.cockpit.alive ? player : null;
    const rb = plane?.cockpit.part.rb;
    const at = rb ? this.toScreen(add(rb.worldCom(), scale(qrot(rb.rotation(), vec3(0, 0, 1)), NOSE_MARK_RANGE))) : null;
    this.noseMark.hidden = !at;
    if (at) this.noseMark.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px)`;
  }

  /** Armes affichées : celles du catalogue à la caméra libre, celles du robot piloté sinon. */
  private showArsenal(): void {
    const player = this.world.player;
    if (!player) {
      if (this.armedBot) this.resetArsenal();
      if (!this.net) this.hud.showArsenal(this.sim.playerArms);
      else if (this.inWorker && this.local!.replica.freeArms) this.hud.showArsenal(this.local!.replica.freeArms);
      return;
    }
    if (player !== this.armedBot) {
      this.armedBot = player;
      // Les armes de soutien automatiques (nanites) se passent du joueur : elles n'ont pas de touche ;
      // les armes de contact suivent les tourelles (pas un champ, qui s'arme seul)
      const turrets = [...new Set(player.turrets.map((t) => t.weapon))].filter((id) => !weaponDef(id).autoSupport);
      const melee = [...new Set(player.melee.map((a) => a.weapon))].filter((id) => meleeOffensive(meleeDef(id)));
      this.pilotWeapons = [...turrets, ...melee];
      this.hud.setArsenal(this.pilotWeapons);
      const keep = this.sim.input.weapon && this.pilotWeapons.includes(this.sim.input.weapon);
      this.selectWeapon(keep ? this.sim.input.weapon! : this.pilotWeapons[0] ?? "rifle");
    }
    // Pour chaque arme : l'état de la tourelle la plus prête
    const arms = new Map<WeaponId, ArmState>();
    for (const t of liveTurrets(player)) {
      const best = arms.get(t.weapon);
      if (!best || t.arm.ammo > best.ammo || (!t.arm.overheated && best.overheated) || t.arm.heat < best.heat) arms.set(t.weapon, t.arm);
    }
    // Armes de contact : le régime du rotor (le meilleur), ou le bras le plus armé
    const melee = new Map<MeleeId, number>();
    for (const a of liveMelee(player)) melee.set(a.weapon, Math.max(melee.get(a.weapon) ?? 0, meleeCharge(a)));
    // Armes perdues : toutes leurs tourelles (ou leurs armes de contact) détruites, ou un coup unique
    // déjà tiré (l'ogive). Des mots invariables : les noms d'armes n'ont pas tous le même genre
    const lost = new Map<ArmId, LostReason>();
    for (const id of this.pilotWeapons) {
      if (isMeleeId(id)) {
        if (!melee.has(id)) lost.set(id, "offline");
        continue;
      }
      const arm = arms.get(id);
      if (!arm) lost.set(id, "offline");
      else if (spent(id, arm)) lost.set(id, "empty");
    }
    // (une mâchoire qui tient sa proie : « serre »)
    const holding = new Set(liveMelee(player).filter((a) => a.grip).map((a) => a.weapon));
    this.hud.showArsenal(arms, lost, melee, holding);
    if (player.cockpit.alive) this.switchFromLost(lost);
  }

  /**
   * L'arme choisie n'est plus disponible (voir `showArsenal`) : on passe à la suivante qui l'est,
   * dans l'ordre des boutons. Pas pendant le vol de l'ogive que l'on pilote (c'est son tir qui la
   * rend indisponible) : après. Un chargeur vide ou une surchauffe ne comptent pas : ils passent.
   */
  private switchFromLost(lost: ReadonlyMap<ArmId, LostReason>): void {
    const current = this.sim.input.weapon;
    if (!current || !lost.has(current) || this.warhead || this.warheadWatch) return;
    const order = this.pilotWeapons;
    const from = order.indexOf(current);
    const next = [...order.slice(from + 1), ...order.slice(0, from)].find((id) => !lost.has(id));
    if (!next) return;
    this.selectWeapon(next);
    this.note(t(`hud.lostNote.${lost.get(current)!}`, { weapon: armName(current), next: armName(next) }));
    this.sound.ui("click");
  }

  private resetArsenal(): void {
    this.armedBot = null;
    this.pilotWeapons = [];
    this.hud.setArsenal(Object.keys(WEAPONS) as WeaponId[]);
    this.hud.showWeapon(this.weapon);
  }

  /** Arcs électriques au hasard sur les blocs des robots paralysés. */
  private showStuns(dt: number): void {
    for (const bot of this.stunned) {
      if (!bot.cockpit.alive || bot.stunnedUntil <= this.world.time) {
        this.stunned.delete(bot);
        continue;
      }
      if (Math.random() > dt * 25) continue;
      const blocks = [...bot.cockpit.part.blocks];
      this.effects.zap(blockWorldPos(blocks[Math.floor(Math.random() * blocks.length)]));
    }
  }

  private syncViews(): void {
    // Pas d'étiquettes sous un menu (démonstration ou pause) : elles passeraient sous le panneau
    this.view.tagsVisible = !this.attract && !this.frozen;
    this.view.sync(this.rig.camera);
    const player = this.world.player;
    this.projectiles.near = this.rig.inWeapon && player ? { shooter: player, eye: this.rig.position } : null;
    this.projectiles.sync();
    this.smokes.sync();
    this.barriers.sync();
  }

  /**
   * Point de vue au viseur : juste au-dessus des tourelles de l'arme choisie ; s'il y en a
   * plusieurs, au milieu des plus hautes (vue dégagée, centrée entre les canons). Elles sont
   * choisies dans le repère du robot : en le comparant dans celui du monde, le choix changeait
   * d'une image à l'autre quand le robot tanguait, et la caméra sautait d'une tourelle à l'autre.
   * null : pas de tourelle.
   */
  private scopeEye(): Vec3 | null {
    const player = this.world.player;
    if (!player?.cockpit.alive) return null;
    const weapon = this.sim.input.weapon;
    const turrets = liveTurrets(player);
    const armed = turrets.filter((t) => t.weapon === weapon);
    const pool = armed.length ? armed : turrets;
    if (!pool.length) return null;
    const top = Math.max(...pool.map((t) => t.block.local.y));
    const highest = pool.filter((t) => t.block.local.y === top);
    // Milieu des tourelles, dans le repère du robot (commun à tous ses morceaux), puis dans le monde
    const local = vec3(0, EYE_HEIGHT, 0);
    for (const t of highest) {
      local.x += t.block.local.x / highest.length;
      local.y += t.block.local.y / highest.length;
      local.z += t.block.local.z / highest.length;
    }
    const rb = highest[0].block.part.rb;
    return add(rb.translation(), qrot(rb.rotation(), local));
  }

  /** Point de vue dans l'ogive pilotée : juste devant son nez. */
  private warheadEye(p: Projectile): Vec3 {
    return add(p.pos, scale(norm(p.vel), WARHEAD_NOSE));
  }

  /** Hauteur à viser au-dessus de `comY` pour voir par-dessus ce robot (m). */
  private overTop(bot: Bot, comY: number): number {
    const rb = bot.cockpit.part.rb;
    const topY = rb.translation().y + qrot(rb.rotation(), vec3(0, bot.top + BLOCK_SIZE / 2, 0)).y;
    return Math.max(0.5, topY - comY + OVER_TOP);
  }

  private updateCamera(dt: number): void {
    // En pilotant, la caméra peut viser vers le ciel ; au viseur, elle passe dans l'arme choisie
    this.rig.setPilotView(this.piloting && !this.attract);
    // Ogive pilotée en vol (ou qui vient d'exploser) : la caméra est à son nez, la souris la dirige
    if (this.warheadWatch && performance.now() / 1000 > this.warheadWatch.until) this.warheadWatch = null;
    const nose = this.warhead ? this.warheadEye(this.warhead) : this.warheadWatch?.eye ?? null;
    if (nose && this.piloting && !this.attract) {
      this.rig.setScope(true, NO_ZOOM);
      this.rig.setEye(nose);
      if (this.warheadLaunched && this.warhead) this.rig.lookFromEye(add(nose, scale(norm(this.warhead.vel), 20)));
      this.warheadLaunched = false;
      this.wasScoping = true;
      // Au retour de l'ogive, la caméra ne cherche pas à retrouver ce que l'on visait avant
      this.scopeAim = null;
    } else {
      const scoping = this.piloting && this.sim.input.scope;
      const sight = this.piloting && !this.attract ? this.scopeEye() : null;
      this.rig.setScope(scoping, SIGHTS[this.pilotWeapon].zooms);
      this.rig.setEye(sight);
      // En passant au viseur, la caméra se tourne vers ce que visait le réticule de dos ; en en
      // sortant, pour que le réticule de dos retombe sur ce que l'on visait dans l'arme
      if (scoping && !this.wasScoping && sight && this.backAim) this.rig.lookFromEye(this.backAim);
      else if (!scoping && this.wasScoping && this.scopeAim) this.rig.lookFromBehind(this.scopeAim, RETICLE_HEIGHT);
      // Le point visé de l'image de bascule ne compte pas : il est pris au nouvel emplacement du
      // réticule (au centre, ou au-dessus), avant que la caméra ne se soit tournée
      if (scoping === this.wasScoping) {
        if (scoping) this.scopeAim = this.sim.input.aim;
        else this.backAim = this.sim.input.aim;
      }
      this.wasScoping = scoping;
    }
    // Dans l'arme, on ne dessine plus son propre robot : il boucherait la vue (dans l'ogive, il est loin)
    const hidden = this.rig.inWeapon && !nose ? this.world.player : null;
    this.view.hidden = hidden;
    this.locomotion.hidden = hidden;
    if (this.attract) {
      this.rig.drift(dt);
      const active = this.world.bots.filter(isOperational).length;
      const age = performance.now() / 1000 - this.waveStart;
      // (une partie qui vient de partir pour le Worker n'a pas encore ses robots)
      if (age > ATTRACT_SETTLE && (active < ATTRACT_MIN_ACTIVE || age > ATTRACT_MAX_WAVE)) {
        this.arenaId = randomArena();
        this.newWave();
      }
      return;
    }
    const player = this.world.player;
    if (player) {
      if (player.cockpit.alive) {
        const com = player.cockpit.part.rb.worldCom();
        this.pilotLift = this.overTop(player, com.y);
        this.rig.track(dt, com, this.pilotLift);
        // Avion : la vue libre en tangage (il boucle, elle aussi). À la souris, pendant qu'on vire ou
        // cabre au clavier, la caméra le suit (le réticule reste sur son nez) ; en manuel, quand la
        // souris ne bouge plus
        const plane = player.profile.mobility === "plane";
        this.rig.setFreePitch(plane);
        if (plane && !this.sim.input.scope) {
          const nose = qrot(player.cockpit.part.rb.rotation(), vec3(0, 0, 1));
          if (this.snapView) this.rig.chaseDirection(1, vec3(nose.x, 0, nose.z), Infinity, RETICLE_HEIGHT);
          this.snapView = false;
          if (!this.manualFlight && this.keySteer > 0) this.rig.chaseDirection(dt, nose, KEY_CHASE_RATE, RETICLE_HEIGHT);
          else if (this.manualFlight && this.rig.idle > CHASE_DELAY) this.rig.chaseDirection(dt, nose, CHASE_RATE, RETICLE_HEIGHT);
        }
      } else {
        // Détruit : la caméra reste au-dessus de l'épave, à la même hauteur. Rabattue au ras du
        // sol, elle plongeait dans l'épave quand on regardait vers le haut (elle se rapproche pour
        // ne pas passer sous le sol)
        this.rig.setFreePitch(false);
        this.rig.track(dt, player.lastPos, this.pilotLift);
      }
      return;
    }
    const { forward, side } = this.controls.moveAxes();
    if (forward || side) {
      if (this.follow >= 0) this.setFollow(-1);
      this.rig.pan(dt, forward, side);
    }
    const bot = this.world.bots[this.follow];
    if (bot) this.rig.track(dt, bot.cockpit.alive ? bot.cockpit.part.rb.worldCom() : bot.lastPos);
  }
}
