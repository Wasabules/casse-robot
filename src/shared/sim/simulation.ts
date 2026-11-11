import RAPIER, { type EventQueue, type RigidBody, type World } from "@dimforge/rapier3d-compat";
import { thinkBot } from "../ai/brain";
import { buffet } from "../arena/air";
import { buildGround, buildScenery, clearScenery } from "../arena/arena";
import { arenaById, ARENAS, DEFAULT_ARENA, type ArenaKey, type ArenaLayout } from "../arena/layout";
import { resetProps, updateProps } from "../arena/props";
import { WEAPON_IDS, weaponDef, type WeaponId } from "../catalog/weapons";
import { canFire, newArmState, tickArm, useArm } from "../combat/arsenal";
import { cutStunnedOrgans, isStunned } from "../combat/emp";
import { updateRepairs } from "../combat/repair";
import { updateFlares } from "../combat/decoys";
import { settleEnergy } from "../robot/energy";
import { wearEngines } from "../robot/propulsion";
import { updateDetection } from "./detection";
import { updateMatch, type Match } from "./match";
import { newInput, type PlayerInput } from "./player";
import { captureMotions, resolveCollisions } from "../combat/collisions";
import { expireDebris } from "../combat/debris";
import { expireWheelWrecks } from "../robot/lifecycle";
import { updateFires } from "../combat/fire";
import { updateScorch } from "../combat/scorch";
import { updateHazards } from "./hazards";
import { updateSmokes } from "../combat/smoke";
import { updateBarriers } from "../combat/barriers";
import { updateMelee } from "../combat/melee";
import { spawnProjectile, stepProjectiles } from "../combat/projectiles";
import { GRAVITY, SOLVER_ITERATIONS, STEP } from "../config";
import { add, scale, type Vec3 } from "../math/vec";
import { applyAerodynamics } from "../robot/aero";
import { placeWheels, stepWheels } from "../robot/wheels";
import { ownerBot, syncHeads } from "../robot/colliders";
import type { ArmState, Barrier, Block, Bot, ColliderOwner, Debris, GroundFire, Part, Projectile, Prop, SmokeCloud, Team } from "./entities";
import type { SimEvent, SimListener } from "./events";

/** Charge le module WebAssembly de Rapier. À attendre une fois avant de créer une Simulation. */
export function initPhysics(): Promise<void> {
  return RAPIER.init();
}

/**
 * Le monde du jeu : physique Rapier, robots, projectiles, accessoires et débris, à pas fixe.
 * Ne dépend ni du DOM ni de Babylon, pour pouvoir tourner aussi sur un serveur Node.
 */
export class Simulation {
  readonly world: World;
  /** Ce que représente chaque collider, par handle. À tenir à jour à chaque création ou retrait. */
  readonly colliders = new Map<number, ColliderOwner>();
  bots: Bot[] = [];
  /** Tous les morceaux de robots présents dans le monde, y compris ceux des robots hors de `bots` (épaves). */
  readonly parts = new Set<Part>();
  debris: Debris[] = [];
  props: Prop[] = [];
  projectiles: Projectile[] = [];
  smokes: SmokeCloud[] = [];
  /** Murs d'énergie déployés (voir combat/barriers.ts). */
  barriers: Barrier[] = [];
  /** Blocs en feu. */
  readonly fires = new Set<Block>();
  /** Accessoires en bois qui brûlent (voir combat/fire.ts). */
  readonly propFires = new Set<Prop>();
  /** Flaques de feu au sol (lance-flammes, napalm ; voir combat/fire.ts). */
  groundFires: GroundFire[] = [];
  /** Point que vise le joueur : les missiles téléguidés qu'il a tirés le suivent. */
  playerAim: Vec3 | null = null;
  /** Armes du joueur (caméra libre) : cadence, chaleur, munitions de chacune. */
  readonly playerArms = new Map<WeaponId, ArmState>(WEAPON_IDS.map((id) => [id, newArmState(weaponDef(id))]));
  /** Ennemis repérés par chaque équipe (voir sim/detection.ts). */
  readonly detected = new Map<Team, Set<Bot>>();
  /** Robot piloté par le joueur (voir sim/player.ts), et ses commandes du moment. */
  player: Bot | null = null;
  readonly input: PlayerInput = newInput();
  /** Partie en cours (score, réapparitions), ou null (voir sim/match.ts). */
  match: Match | null = null;
  /** Arène en place (décor, accessoires, zones) ; on en change avec `loadArena`. */
  arena: ArenaLayout = ARENAS[DEFAULT_ARENA];
  /** Temps simulé (s). */
  time = 0;
  destroyedCount = 0;
  aiPaused = false;
  /** Les tourelles de l'IA tirent (désactivé au stand de tir). */
  combat = true;
  /**
   * Mesure du temps passé dans chaque étape du pas (ms, cumulés), quand on la demande (`npm run
   * bench`) ; `now` : l'horloge (performance.now), fournie par l'appelant.
   */
  profile: { now: () => number; times: Record<string, number> } | null = null;

  private lastId = 0;
  private readonly listeners = new Set<SimListener>();
  /** Événements de la physique (forces de contact), pour les dégâts de collision. */
  private readonly events: EventQueue = new RAPIER.EventQueue(true);
  /** Corps du décor fixe de l'arène (pas le sol, commun à toutes). */
  private scenery: RigidBody[];

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world.timestep = STEP;
    this.world.numSolverIterations = SOLVER_ITERATIONS;
    buildGround(this.world);
    this.scenery = buildScenery(this.world, this.arena);
  }

  /**
   * Change d'arène : le décor fixe est remplacé et les accessoires remis aux places de la nouvelle.
   * À faire avant de placer les robots (une vague ou une partie), qui ne doivent pas se trouver
   * dans le nouveau décor. Une arène du jeu, ou une carte communautaire : par son identifiant (elle
   * doit être connue : `registerArena`, arena/layout.ts), ou directement (shared/map/ : `arenaFromMap`).
   */
  loadArena(arena: ArenaKey | ArenaLayout): void {
    const layout = typeof arena === "string" ? arenaById(arena) : arena;
    if (!layout) throw new Error(`Arène inconnue : ${String(arena)}`);
    if (layout === this.arena) return;
    clearScenery(this.world, this.scenery);
    this.arena = layout;
    this.scenery = buildScenery(this.world, this.arena);
    this.emit({ type: "arenaChanged", arena: layout.id });
    resetProps(this);
  }

  nextId(): number {
    return ++this.lastId;
  }

  /** S'abonne aux événements. Renvoie la fonction de désabonnement. */
  on(listener: SimListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: SimEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /**
   * Avance d'un pas fixe (STEP) : décisions de l'IA (conduite, vol, tourelles), air (portance,
   * traînée, rafales), physique, chocs, armes de contact, projectiles, jets de flamme des moteurs, feux, fumées,
   * accessoires, fin de vie des débris.
   */
  step(): void {
    this.measure("détection", () => updateDetection(this));
    this.measure("ia", () => {
      for (const bot of this.bots) {
        if (bot.thrusters.length) wearEngines(this, bot);
        thinkBot(this, bot, STEP, this.aiPaused);
        // Paralysie locale (lance électrique) : les roues coupées n'obéissent pas aux commandes
        cutStunnedOrgans(this, bot);
        settleEnergy(bot, !isStunned(this, bot));
      }
      for (const [id, arm] of this.playerArms) tickArm(arm, weaponDef(id), STEP);
      // Les zones touchables des têtes suivent leur lacet et leur site
      syncHeads(this);
    });
    this.measure("air", () => {
      for (const bot of this.bots) {
        if (bot.surfaces.length) applyAerodynamics(bot);
        if (bot.profile.mobility !== "ground" && bot.cockpit.alive) buffet(bot.cockpit.part.rb);
      }
    });
    this.measure("roues", () => stepWheels(this));
    const motions = captureMotions(this);
    this.measure("physique", () => {
      this.world.step(this.events);
      placeWheels(this);
    });
    this.time += STEP;
    this.measure("chocs", () => resolveCollisions(this, this.events, motions));
    // Armes de contact (combat/melee.ts) : régime, gyroscope, balourd, coups
    this.measure("contact", () => updateMelee(this));
    this.measure("projectiles", () => stepProjectiles(this));
    // Jets de flamme des moteurs (combat/scorch.ts) : avant le feu, qui brûle ce qu'ils allument
    this.measure("jets", () => updateScorch(this));
    this.measure("feu, fumée, réparation", () => {
      updateFires(this);
      updateHazards(this);
      updateSmokes(this);
      updateBarriers(this);
      updateRepairs(this);
      updateFlares(this);
    });
    this.measure("accessoires, débris", () => {
      updateProps(this);
      expireDebris(this);
      expireWheelWrecks(this);
    });
    this.measure("partie", () => updateMatch(this));
  }

  /**
   * Une étape du pas, minutée si `profile` est actif. Une sous-étape (nom « étape › détail »)
   * est comptée dans son étape : le banc ne l'ajoute pas au total.
   */
  measure(name: string, work: () => void): void {
    if (!this.profile) {
      work();
      return;
    }
    const { now, times } = this.profile;
    const start = now();
    work();
    times[name] = (times[name] ?? 0) + now() - start;
  }

  /**
   * Tir du joueur : un projectile de l'arme `weapon` part de `origin` dans la direction unitaire
   * `dir`. `homing` : cible d'un missile à tête chercheuse.
   */
  fire(weapon: WeaponId, origin: Vec3, dir: Vec3, homing: Bot | null = null): Projectile {
    return spawnProjectile(this, weapon, origin, dir, { shooter: null, homing });
  }

  /**
   * Tir du joueur si son arme est prête (cadence, chaleur, munitions) : comme `fire`, mais l'arme
   * chauffe et consomme. Renvoie le projectile, ou null si l'arme n'était pas prête.
   */
  tryFire(weapon: WeaponId, origin: Vec3, dir: Vec3, homing: Bot | null = null): Projectile | null {
    const arm = this.playerArms.get(weapon)!;
    if (!canFire(arm)) return null;
    useArm(arm, weaponDef(weapon));
    return this.fire(weapon, origin, dir, homing);
  }

  /**
   * Premier obstacle (hors débris, et hors du robot `ignore`) sur le rayon, à moins de `maxDist` m :
   * le point touché et ce que c'est.
   */
  raycast(origin: Vec3, dir: Vec3, maxDist: number, ignore: Bot | null = null): { point: Vec3; owner: ColliderOwner | undefined } | null {
    const hit = this.world.castRay(
      new RAPIER.Ray(origin, dir), maxDist, true, undefined, undefined, undefined, undefined,
      (c) => {
        const owner = this.colliders.get(c.handle);
        if (owner?.kind === "debris") return false;
        return !ignore || ownerBot(owner) !== ignore;
      },
    );
    if (!hit) return null;
    return { point: add(origin, scale(dir, hit.timeOfImpact)), owner: this.colliders.get(hit.collider.handle) };
  }

  /** Libère la mémoire WebAssembly du monde. La simulation n'est plus utilisable ensuite. */
  dispose(): void {
    this.match?.unsubscribe();
    this.listeners.clear();
    this.events.free();
    this.world.free();
  }
}
