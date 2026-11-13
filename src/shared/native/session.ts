import { isArenaId, isMapKey } from "../arena/layout";
import { canFire, newArmState, tickArm, useArm } from "../combat/arsenal";
import { WEAPON_IDS, weaponDef, type WeaponId } from "../catalog/weapons";
import { STEP } from "../config";
import { provideGameArenaFile } from "../map/gameArenas";
import { registerMap } from "../map/load";
import { ENDLESS_MATCH, GAME_MODES, matchEntries, pickRoster, type GameModeId } from "../modes";
import { encodeFrame, type FrameHeader, type NetEvent } from "../net/protocol";
import type { SessionCommand, SessionLike } from "../net/session";
import type { ArmState } from "../sim/entities";
import { newInput } from "../sim/input";
import { NativeEncoder } from "./events";
import type { SimModule } from "./simModule";
import { NativeWorld } from "./world";

/*
 * La partie solo sur la simulation portée en Rust (crates/casse-sim, src/shared/native/world.ts), derrière
 * le même contrat que `LocalSession` (src/shared/net/session.ts) : les mêmes commandes, les mêmes images
 * (les événements depuis l'image précédente, ou la description du monde, et l'instantané binaire),
 * octet pour octet, d'après la même graine (tests/nativeSession.test.ts). La réplique du client n'y voit
 * aucune différence. Ce que le TypeScript garde : les tirages de la composition des équipes
 * (`matchEntries`, `pickRoster` : le même hasard que le module, qui reprend où ils se sont arrêtés), les
 * armes de la caméra libre (leur cadence, leur chaleur : rien du monde n'y touche) et la lecture du
 * journal des événements.
 */

/** Au plus tant de pas par commande `advance` (comme `LocalSession`). */
const MAX_STEPS = 4;

/** Les étapes d'un pas du module (`Sim::stage`), et leur nom dans la mesure (`Simulation.measure`). */
const STAGE_NAMES = [
  "détection", "ia", "air", "roues", "physique", "physique", "chocs", "contact", "projectiles", "jets", "feu, fumée, réparation", "accessoires, débris", "partie", // i18n-ignore (les étapes de la mesure, comme `Simulation.measure`)
];

export class NativeSession implements SessionLike {
  private world: NativeWorld;
  private readonly encoder = new NativeEncoder();
  private unsubscribe: () => void;
  private accumulator = 0;
  private fresh = true;
  private mode: GameModeId = "arena";
  /** Les commandes du joueur (`sim.input`), recopiées dans le module à chaque changement. */
  private readonly input = newInput();
  /** Armes de la caméra libre (`sim.playerArms`). */
  private readonly playerArms = new Map<WeaponId, ArmState>(WEAPON_IDS.map((id) => [id, newArmState(weaponDef(id))]));
  private profiling = false;
  private profiled = 0;
  private times: Record<string, number> = {};
  private readonly now: () => number;

  constructor(m: SimModule, now: () => number, seed = Math.floor(Math.random() * 4294967296)) {
    this.now = now;
    this.world = new NativeWorld(m, seed);
    this.unsubscribe = this.world.on((e) => this.encoder.record(e));
  }

  handle(cmd: SessionCommand): Uint8Array[] {
    switch (cmd.t) {
      case "start":
        this.start(cmd);
        return [this.frame()];
      case "spawn":
        this.world.endMatch();
        this.world.player = null;
        this.world.spawnWave(cmd.profiles);
        this.fresh = true;
        return [this.frame()];
      case "input":
        Object.assign(this.input, cmd.input);
        this.world.setInput(0, this.input);
        this.world.playerAim = cmd.aim;
        return [];
      case "advance": {
        this.accumulator += Math.max(0, cmd.dt);
        let steps = 0;
        while (this.accumulator >= STEP && steps < MAX_STEPS) {
          this.step();
          this.accumulator -= STEP;
          steps++;
        }
        if (steps === MAX_STEPS) this.accumulator = 0;
        this.profiled += steps;
        return steps ? [this.frame()] : [];
      }
      case "steps":
        for (let i = 0; i < cmd.n; i++) this.step();
        this.profiled += cmd.n;
        return [this.frame()];
      case "fire": {
        if (!cmd.free) {
          const arm = this.playerArms.get(cmd.weapon)!;
          if (!canFire(arm)) return [];
          useArm(arm, weaponDef(cmd.weapon));
        }
        this.world.fire(cmd.weapon, cmd.origin, cmd.dir, cmd.homing);
        return [];
      }
      case "pause":
        this.world.aiPaused = cmd.ai;
        return [];
      case "selfDestruct": {
        const player = this.world.player;
        if (player !== null) this.world.selfDestruct(player);
        return [];
      }
      case "damage":
        this.world.applyDamage(cmd.weapon, cmd.point, cmd.dir, cmd.shooter);
        return [this.frame()];
      case "profile":
        this.profiling = cmd.on;
        this.times = {};
        this.profiled = 0;
        return [];
    }
  }

  /** Un pas : celui du module (étape par étape quand on le mesure), puis les armes de la caméra libre. */
  private step(): void {
    const w = this.world;
    if (!this.profiling) w.step();
    else {
      for (let k = 0; k < STAGE_NAMES.length; k++) {
        const start = this.now();
        w.m.x.sim_stage(w.id, k);
        this.times[STAGE_NAMES[k]] = (this.times[STAGE_NAMES[k]] ?? 0) + this.now() - start;
      }
      w.drain();
    }
    for (const [id, arm] of this.playerArms) tickArm(arm, weaponDef(id), STEP);
  }

  /** Une nouvelle partie (comme `LocalSession.start`). */
  private start(cmd: Extract<SessionCommand, { t: "start" }>): void {
    if (cmd.map && isMapKey(cmd.arena)) registerMap(cmd.map);
    else if (cmd.map && isArenaId(cmd.arena)) provideGameArenaFile(cmd.arena, cmd.map);
    const mode = GAME_MODES[cmd.mode];
    this.mode = cmd.mode;
    const w = this.world;
    w.endMatch();
    w.loadArena(cmd.arena);
    w.player = null;
    w.combat = mode.combat;
    w.aiPaused = false;
    const piloted = mode.pilot && cmd.pilot !== null;
    // La composition des équipes tire dans le hasard du module (une graine donnée : une partie
    // rejouable, comme `seedMathRandom`), qui le reprend ensuite pour faire apparaître les robots
    const entries = w.draw(() => (piloted ? matchEntries(mode, cmd.pilot!) : null), cmd.seed);
    const roster = piloted ? null : cmd.roster ?? w.draw(() => pickRoster(mode));
    if (entries) {
      const bots = w.spawnTeams(entries);
      w.takeControl(bots[0], 0);
      w.player = bots[0];
    } else {
      w.spawnWave(roster!);
    }
    const rules = piloted ? mode.match : cmd.roster ? ENDLESS_MATCH : null;
    if (rules) w.startMatch(rules);
    this.accumulator = 0;
    this.fresh = true;
  }

  /** L'image du moment (comme `LocalSession.frame`). */
  private frame(): Uint8Array {
    const w = this.world;
    w.drain();
    let events: NetEvent[] = this.encoder.take((id) => w.describeBot(id));
    const reset = this.fresh;
    if (reset) events = w.describeWorld();
    this.fresh = false;
    const player = w.player;
    const header: FrameHeader = { events, you: player === null ? null : w.botId(player), lock: w.lock(player) };
    if (reset) header.reset = true;
    if (!GAME_MODES[this.mode].pilot) header.arms = [...this.playerArms];
    if (this.profiling) {
      header.profile = { times: { ...this.times }, steps: this.profiled };
      this.times = {};
      this.profiled = 0;
    }
    return encodeFrame(header, w.snapshot());
  }

  dispose(): void {
    this.unsubscribe();
    this.world.dispose();
  }
}
