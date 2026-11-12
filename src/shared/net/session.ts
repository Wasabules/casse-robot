import { isMapKey, type ArenaKey } from "../arena/layout";
import { lockProgress, pilotLock } from "../combat/lock";
import { applyDamage } from "../combat/damage";
import { findHomingTarget } from "../combat/projectiles";
import type { WeaponId } from "../catalog/weapons";
import { weaponDef } from "../catalog/weapons";
import type { BotProfile } from "../design/presets";
import type { MapFile } from "../map/format";
import { registerMap } from "../map/load";
import type { Vec3 } from "../math/vec";
import { ENDLESS_MATCH, GAME_MODES, matchEntries, pickRoster, type GameModeId } from "../modes";
import { endMatch, selfDestruct, startMatch } from "../sim/match";
import type { PlayerInput } from "../sim/player";
import { Simulation } from "../sim/simulation";
import { spawnTeams, spawnWave } from "../sim/wave";
import { STEP } from "../config";
import { describeWorld, NetEncoder } from "./encoder";
import { encodeFrame, type FrameHeader, type NetEvent } from "./protocol";
import { writeSnapshot } from "./snapshot";

/*
 * La partie solo hors du fil du rendu. La simulation tourne dans un Worker (client/sim/simWorker.ts)
 * qui ne reçoit que des commandes et rend des images comme le serveur de jeu (les événements depuis
 * l'image précédente et un instantané, encodeFrame) ; le client les rejoue dans une réplique, comme en
 * multijoueur (net/replica.ts), avec un retard d'interpolation court. Ce que le serveur ne fait pas
 * devient une commande : lancer un mode de jeu dans une arène (avec le robot du joueur, ou des robots
 * imposés), une vague de plus, le tir de la caméra libre, la pause de l'IA, le temps qui avance (le
 * client le mène : ralenti et pause compris). La même session tourne dans Node pour les essais
 * (tests/session.test.ts) : la réplique qu'elle nourrit doit reproduire son monde.
 */

/** Ce que le client demande à la session. */
export type SessionCommand =
  /**
   * Une partie : le mode, l'arène (une carte communautaire est donnée avec, la session la fait
   * connaître), le robot du joueur dans un mode piloté, ou des robots imposés (la mesure du rendu) ;
   * `seed` : un hasard rejouable (Math.random de la session).
   */
  | { t: "start"; mode: GameModeId; arena: ArenaKey; map?: MapFile; pilot: BotProfile | null; roster: readonly BotProfile[] | null; seed?: number }
  /** Une vague de ces robots-là, sans joueur (la caméra libre, la console). */
  | { t: "spawn"; profiles: readonly BotProfile[] }
  /** Les commandes du joueur, et le point visé à la caméra libre (les missiles téléguidés le suivent). */
  | { t: "input"; input: PlayerInput; aim: Vec3 | null }
  /** Le temps avance de `dt` s (déjà multiplié par le ralenti ; 0 en pause) : la session fait les pas qui tombent. */
  | { t: "advance"; dt: number }
  /** `n` pas d'un coup (la console : `__casse.sim(n)`). */
  | { t: "steps"; n: number }
  /** Un tir de la caméra libre ; `free` : sans tenir compte de la cadence ni des munitions ; `homing` : chercher une cible. */
  | { t: "fire"; weapon: WeaponId; origin: Vec3; dir: Vec3; free: boolean; homing: { from: Vec3; dir: Vec3; airOnly: boolean } | null }
  /** L'IA figée ou non. */
  | { t: "pause"; ai: boolean }
  /** Le robot du joueur se saborde. */
  | { t: "selfDestruct" }
  /** Un impact (la console : `__casse.applyDamage`), comme si le tir venait de `shooter`. */
  | { t: "damage"; point: Vec3; dir: Vec3; weapon: WeaponId; shooter: Vec3 }
  /** Mesurer chaque étape d'un pas (la mesure du rendu) : les temps partent avec chaque image (`profile`). */
  | { t: "profile"; on: boolean };

/** Au plus tant de pas par commande `advance` : une machine à la traîne ne s'enfonce pas. */
const MAX_STEPS = 4;

export class LocalSession {
  readonly sim = new Simulation();
  private encoder: NetEncoder;
  private accumulator = 0;
  /** La prochaine image décrit tout le monde (une nouvelle partie). */
  private fresh = true;
  /** Mode de la partie en cours (la caméra libre envoie l'état de ses armes). */
  private mode: GameModeId = "arena";
  private profiled = 0;
  /** L'horloge (ms) de la mesure des étapes : fournie par qui fait tourner la session (le Worker, Node). */
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
    this.encoder = new NetEncoder(this.sim);
  }

  /** Fait une commande ; rend les images à envoyer au client (au plus une). */
  handle(cmd: SessionCommand): Uint8Array[] {
    switch (cmd.t) {
      case "start":
        this.start(cmd);
        return [this.frame()];
      case "spawn":
        // Comme `ArenaGame.spawn` : l'arène remise en place, ces robots-là, sans partie
        endMatch(this.sim);
        this.sim.loadArena(this.sim.arena);
        this.sim.player = null;
        spawnWave(this.sim, cmd.profiles);
        this.fresh = true;
        return [this.frame()];
      case "input":
        Object.assign(this.sim.input, cmd.input);
        this.sim.playerAim = cmd.aim;
        return [];
      case "advance": {
        this.accumulator += Math.max(0, cmd.dt);
        let steps = 0;
        while (this.accumulator >= STEP && steps < MAX_STEPS) {
          this.sim.step();
          this.accumulator -= STEP;
          steps++;
        }
        if (steps === MAX_STEPS) this.accumulator = 0;
        this.profiled += steps;
        return steps ? [this.frame()] : [];
      }
      case "steps":
        for (let i = 0; i < cmd.n; i++) this.sim.step();
        this.profiled += cmd.n;
        return [this.frame()];
      case "fire": {
        const homing = cmd.homing ? findHomingTarget(this.sim, cmd.homing.from, cmd.homing.dir, cmd.homing.airOnly, null) : null;
        if (cmd.free) this.sim.fire(cmd.weapon, cmd.origin, cmd.dir, homing);
        else this.sim.tryFire(cmd.weapon, cmd.origin, cmd.dir, homing);
        return [];
      }
      case "pause":
        this.sim.aiPaused = cmd.ai;
        return [];
      case "selfDestruct":
        if (this.sim.player) selfDestruct(this.sim, this.sim.player);
        return [];
      case "damage":
        applyDamage(this.sim, cmd.point, cmd.dir, weaponDef(cmd.weapon), undefined, cmd.shooter);
        return [this.frame()];
      case "profile":
        this.sim.profile = cmd.on ? { now: this.now, times: {} } : null;
        this.profiled = 0;
        return [];
    }
  }

  /** Une nouvelle partie, comme `ArenaGame.newWave` le fait dans le fil du rendu. */
  private start(cmd: Extract<SessionCommand, { t: "start" }>): void {
    if (cmd.seed !== undefined) seedMathRandom(cmd.seed);
    if (cmd.map && isMapKey(cmd.arena)) registerMap(cmd.map);
    const mode = GAME_MODES[cmd.mode];
    this.mode = cmd.mode;
    endMatch(this.sim);
    this.sim.loadArena(cmd.arena);
    this.sim.player = null;
    this.sim.combat = mode.combat;
    this.sim.aiPaused = false;
    const piloted = mode.pilot && cmd.pilot !== null;
    if (piloted) {
      const bots = spawnTeams(this.sim, matchEntries(mode, cmd.pilot!));
      bots[0].controller = "player";
      this.sim.player = bots[0];
    } else {
      spawnWave(this.sim, cmd.roster ?? pickRoster(mode));
    }
    const rules = piloted ? mode.match : cmd.roster ? ENDLESS_MATCH : null;
    // (la description du nouveau monde dit la partie)
    if (rules) startMatch(this.sim, rules);
    this.accumulator = 0;
    this.fresh = true;
  }

  /** L'image du moment : les changements depuis la précédente (ou tout le monde), et l'instantané. */
  private frame(): Uint8Array {
    let events: NetEvent[] = this.encoder.take();
    const reset = this.fresh;
    // Un nouveau monde : sa description (ce qui s'est passé avant y est compris, la partie aussi)
    if (reset) events = describeWorld(this.sim);
    this.fresh = false;
    const player = this.sim.player;
    const locking = player ? pilotLock(player) : null;
    const lock = locking?.lockOn ? { turret: locking.block.id, target: locking.lockOn.id, progress: lockProgress(locking) } : null;
    const header: FrameHeader = { events, you: player?.id ?? null, lock };
    if (reset) header.reset = true;
    if (!GAME_MODES[this.mode].pilot) header.arms = [...this.sim.playerArms];
    if (this.sim.profile) {
      header.profile = { times: { ...this.sim.profile.times }, steps: this.profiled };
      this.sim.profile.times = {};
      this.profiled = 0;
    }
    return encodeFrame(header, writeSnapshot(this.sim));
  }

  dispose(): void {
    this.encoder.dispose();
    this.sim.dispose();
  }
}

/** Remplace Math.random par un tirage à graine fixe (mulberry32) : une partie rejouable. */
function seedMathRandom(seed: number): void {
  let a = seed >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

