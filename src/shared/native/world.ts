import { arenaById, ARENAS, DEFAULT_ARENA, type ArenaKey, type ArenaLayout } from "../arena/layout";
import type { WeaponId } from "../catalog/weapons";
import type { BotProfile } from "../design/presets";
import type { Vec3 } from "../math/vec";
import type { BotDesc, LockState, NetEvent } from "../net/protocol";
import type { MatchRules } from "../sim/match";
import type { PlayerInput } from "../sim/player";
import type { Team } from "../sim/entities";
import { giveArena } from "./arena";
import { CODE, readBotDesc, readLog, type LoggedEvent } from "./events";
import type { SimModule } from "./simModule";

/*
 * Un monde de la simulation portée (crates/casse-sim/src/sim/), vu du TypeScript : ce que la session
 * solo et la salle du serveur font sur une `Simulation` (une arène, des vagues, des équipes, une partie,
 * des pilotes, un pas), fait par le module ; et ce qu'elles en lisent pour leurs images (le journal des
 * événements, l'instantané, la description des robots et du monde). Les robots sont désignés par leur
 * rang dans le module (`Slot`), et sur le réseau par leur numéro d'entité, le même que dans le
 * TypeScript. Le monde naît avec le décor du Dépôt, comme une `Simulation` neuve.
 */

/** Le rang d'un robot dans le module (ses robots présents, retirés, réapparus : chacun le sien). */
export type Slot = number;

const TEAMS: readonly Team[] = ["red", "blue"];
const MOBILITY = { ground: 0, hover: 1, plane: 2 } as const;
/** Drapeaux des commandes du pilote (crates/casse-sim/src/sim/hooks.rs, `sim_set_input`). */
const FLAGS = { boost: 1, trigger: 2, scope: 4, detonate: 8, flares: 16, relative: 32, manual: 64 } as const;

export class NativeWorld {
  readonly id: number;
  /** L'arène en place, et les règles de la partie en cours (null : pas de partie). */
  arena: ArenaLayout = ARENAS[DEFAULT_ARENA];
  rules: MatchRules | null = null;
  /** Les profils donnés au module, dans l'ordre de leurs rangs ; chaque robot une fois (par son texte). */
  readonly profiles: BotProfile[] = [];
  private readonly profileRanks = new WeakMap<BotProfile, number>();
  private readonly profileTexts = new Map<string, number>();
  /** Qui lit les événements du journal, dans l'ordre où ils se sont produits (`sim.on`). */
  private readonly listeners = new Set<(e: LoggedEvent) => void>();

  readonly m: SimModule;

  constructor(m: SimModule, seed: number) {
    this.m = m;
    this.id = m.x.sim_new();
    m.x.sim_seed(this.id, seed >>> 0);
    m.x.sim_log_events(this.id, 1);
    // Au combat, comme une `Simulation` neuve (`combat = true`)
    m.x.sim_combat(this.id, 1);
    // Le décor du Dépôt (`new Simulation()` : `buildScenery`), sans ses accessoires
    giveArena(m, this.id, this.arena);
  }

  /** S'abonne aux événements du journal ; rend la fonction de désabonnement. */
  on(listener: (e: LoggedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Lit le journal depuis la dernière fois et le donne aux abonnés. */
  drain(): void {
    const n = this.m.x.sim_take_events(this.id);
    if (!n) return;
    for (const e of readLog(this.m.out(n), { arena: this.arena.id, profiles: this.profiles })) for (const l of this.listeners) l(e);
  }

  /**
   * Le rang du profil dans le module : donné une fois par robot, même venu dans un autre objet (les
   * robots d'une partie solo arrivent recopiés à chaque commande du jeu ; ceux d'une salle, à chaque
   * joueur) : la liste ne grandit pas d'une partie à l'autre.
   */
  profile(p: BotProfile): number {
    let rank = this.profileRanks.get(p);
    if (rank !== undefined) return rank;
    const text = JSON.stringify(p);
    rank = this.profileTexts.get(text);
    if (rank === undefined) {
      rank = this.m.withText(JSON.stringify(p.design), (ptr, len) =>
        this.m.x.sim_add_profile(this.id, p.speed, p.turn, MOBILITY[p.mobility], p.behavior === "charge" ? 1 : 0, ptr, len));
      this.m.check(rank, `profil ${p.id}`);
      this.profileTexts.set(text, rank);
      this.profiles[rank] = p;
    }
    this.profileRanks.set(p, rank);
    return rank;
  }

  /** Change d'arène (`loadArena`) : le décor remplacé, les accessoires remis aux places de la nouvelle. */
  loadArena(arena: ArenaKey | ArenaLayout): void {
    const layout = typeof arena === "string" ? arenaById(arena) : arena;
    if (!layout) throw new Error(`Arène inconnue : ${String(arena)}`);
    if (layout === this.arena) return;
    this.m.x.sim_arena_reset(this.id);
    giveArena(this.m, this.id, layout);
    this.arena = layout;
    this.m.check(this.m.x.sim_arena_changed(this.id), "arène"); // i18n-ignore (pour la console)
    this.drain();
  }

  set combat(on: boolean) {
    this.m.x.sim_combat(this.id, on ? 1 : 0);
  }

  /** Vide l'arène et fait apparaître deux équipes (`spawnTeams`) ; leurs robots, dans l'ordre des entrées. */
  spawnTeams(entries: readonly { profile: BotProfile; team: Team }[]): Slot[] {
    const flat = new Uint32Array(entries.flatMap((e) => [this.profile(e.profile), TEAMS.indexOf(e.team)]));
    const n = this.m.withBytes(flat, (ptr) => this.m.x.sim_spawn_teams(this.id, ptr, entries.length));
    const bots = this.slots(this.m.check(n, "équipes")); // i18n-ignore (pour la console)
    this.drain();
    return bots;
  }

  /** Vide l'arène et fait apparaître une vague (`spawnWave`). */
  spawnWave(profiles: readonly BotProfile[]): Slot[] {
    const flat = new Uint32Array(profiles.map((p) => this.profile(p)));
    const n = this.m.withBytes(flat, (ptr) => this.m.x.sim_spawn_wave(this.id, ptr, profiles.length));
    const bots = this.slots(this.m.check(n, "vague")); // i18n-ignore (pour la console)
    this.drain();
    return bots;
  }

  private slots(n: number): Slot[] {
    return Array.from(new Uint32Array(this.m.out(n * 4).buffer));
  }

  /** Commence une partie (`startMatch`). */
  startMatch(rules: MatchRules): void {
    const c = rules.capture;
    this.m.x.sim_start_match(this.id, rules.scoreToWin, rules.timeLimit, rules.respawn ?? NaN, c ? 1 : 0, c?.time ?? 0, c?.rate ?? 0, c?.hill ?? NaN);
    this.rules = rules;
  }

  endMatch(): void {
    this.m.x.sim_end_match(this.id);
    this.rules = null;
  }

  takeControl(bot: Slot, slot: number): void {
    this.m.x.sim_take_control(this.id, bot, slot);
  }

  releaseControl(bot: Slot): void {
    this.m.x.sim_release_control(this.id, bot);
  }

  set player(bot: Slot | null) {
    this.m.x.sim_set_player(this.id, bot ?? -1);
  }

  get player(): Slot | null {
    const b = this.m.x.sim_player(this.id);
    return b < 0 ? null : b;
  }

  /** Le numéro d'entité d'un robot. */
  botId(bot: Slot): number {
    return this.m.x.sim_bot_id(this.id, bot);
  }

  /** Les commandes du pilote `slot` (`PlayerInput`). */
  setInput(slot: number, i: PlayerInput): void {
    const flags = (i.boost ? FLAGS.boost : 0) | (i.trigger ? FLAGS.trigger : 0) | (i.scope ? FLAGS.scope : 0) | (i.detonate ? FLAGS.detonate : 0)
      | (i.flares ? FLAGS.flares : 0) | (i.relative ? FLAGS.relative : 0) | (i.manual ? FLAGS.manual : 0);
    const a = i.aim;
    const l = i.look;
    this.m.withText(i.weapon ?? "", (ptr, len) => this.m.x.sim_set_input(
      this.id, slot, i.throttle, i.steer, i.climb, i.brake, i.yaw, i.power, i.heading, flags, ptr, len,
      a?.x ?? NaN, a?.y ?? NaN, a?.z ?? NaN, l?.x ?? NaN, l?.y ?? NaN, l?.z ?? NaN,
    ));
  }

  set playerAim(aim: Vec3 | null) {
    this.m.x.sim_player_aim(this.id, aim?.x ?? NaN, aim?.y ?? NaN, aim?.z ?? NaN);
  }

  set aiPaused(on: boolean) {
    this.m.x.sim_pause(this.id, on ? 1 : 0);
  }

  selfDestruct(bot: Slot): void {
    this.m.x.sim_self_destruct(this.id, bot);
    this.drain();
  }

  /** Un joueur prend la place d'un robot de l'IA (`Room.replaceAi`) ; son robot. */
  replaceBot(old: Slot, profile: BotProfile, team: Team, slot: number): Slot {
    const bot = this.m.check(this.m.x.sim_replace_bot(this.id, old, this.profile(profile), TEAMS.indexOf(team), slot), "remplacement");
    this.drain();
    return bot;
  }

  /** Un tir de la caméra libre (`sim.fire`), qui cherche sa cible le long de `homing` s'il y en a un. */
  fire(weapon: WeaponId, origin: Vec3, dir: Vec3, homing: { from: Vec3; dir: Vec3; airOnly: boolean } | null): void {
    const h = homing;
    this.m.withText(weapon, (ptr, len) => this.m.check(this.m.x.sim_fire_free(
      this.id, ptr, len, origin.x, origin.y, origin.z, dir.x, dir.y, dir.z,
      h ? 1 : 0, h?.from.x ?? 0, h?.from.y ?? 0, h?.from.z ?? 0, h?.dir.x ?? 0, h?.dir.y ?? 0, h?.dir.z ?? 0, h?.airOnly ? 1 : 0,
    ), "tir")); // i18n-ignore (pour la console)
    this.drain();
  }

  /** Un impact de la console (`applyDamage` sans cible). */
  applyDamage(weapon: WeaponId, point: Vec3, dir: Vec3, shooter: Vec3): void {
    this.m.withText(weapon, (ptr, len) => this.m.check(this.m.x.sim_apply_damage(
      this.id, ptr, len, point.x, point.y, point.z, dir.x, dir.y, dir.z, shooter.x, shooter.y, shooter.z,
    ), "impact"));
    this.drain();
  }

  /** Avance de `n` pas. */
  step(n = 1): void {
    this.m.check(this.m.x.sim_advance(this.id, n), "pas");
    this.drain();
  }

  /** L'instantané du monde (`writeSnapshot`). */
  snapshot(): Uint8Array {
    return this.m.out(this.m.x.sim_snapshot(this.id));
  }

  /** Le robot de numéro `id` tel qu'il est (`describeBot`). */
  describeBot(id: number): BotDesc {
    const n = this.m.x.sim_describe_bot(this.id, id);
    return readBotDesc(id, this.m.out(n), this.profiles);
  }

  /** Tout le monde, pour une image qui décrit le monde (`describeWorld`). */
  describeWorld(): NetEvent[] {
    const events: NetEvent[] = [{ t: "arena", id: this.arena.id }, { t: "match", rules: this.rules }];
    const log = readLog(this.m.out(this.m.x.sim_describe_world(this.id)), { arena: this.arena.id, profiles: this.profiles });
    for (const e of log) events.push(e.code === CODE.botAdded ? { t: "bot", bot: this.describeBot(e.bot!) } : e.net!);
    return events;
  }

  /** Le verrou à montrer au pilote du robot `bot` (`pilotLock`). */
  lock(bot: Slot | null): LockState | null {
    if (bot === null) return null;
    let found = 0;
    const out = this.m.numbers(3, (ptr) => (found = this.m.x.sim_lock(this.id, bot, ptr)));
    return found ? { turret: out[0], target: out[1], progress: out[2] } : null;
  }

  /** La partie : là ou non, le score, le temps écoulé, le vainqueur ; et le temps simulé. */
  matchState(): { present: boolean; score: Record<Team, number>; elapsed: number; winner: Team | "draw" | null; time: number } {
    const v = this.m.numbers(6, (ptr) => this.m.x.sim_match_state(this.id, ptr));
    return { present: v[0] === 1, score: { red: v[1], blue: v[2] }, elapsed: v[3], winner: v[4] < 0 ? null : v[4] === 2 ? "draw" : TEAMS[v[4]], time: v[5] };
  }

  /** Les robots présents (`sim.bots`) : rang, numéro, profil, équipe, cockpit vivant, mobilité, mode d'IA, blocage, piloté. */
  roster(): { slot: Slot; id: number; profile: BotProfile; team: Team; alive: boolean; mobility: number; mode: number; blockedT: number; piloted: boolean }[] {
    const n = this.m.x.sim_roster(this.id);
    const v = new Float64Array(this.m.out(n * 72).buffer);
    return Array.from({ length: n }, (_, i) => {
      const o = i * 9;
      return {
        slot: v[o], id: v[o + 1], profile: this.profiles[v[o + 2]], team: TEAMS[v[o + 3]], alive: v[o + 4] !== 0, mobility: v[o + 5], mode: v[o + 6],
        blockedT: v[o + 7], piloted: v[o + 8] !== 0,
      };
    });
  }

  get time(): number {
    return this.m.x.sim_time(this.id);
  }

  /** Le robot présent aux commandes du pilote `slot` (après une réapparition, le nouveau), ou null. */
  botWithInput(slot: number): Slot | null {
    const b = this.m.x.sim_bot_with_input(this.id, slot);
    return b < 0 ? null : b;
  }

  /** Son cockpit est-il intact ? */
  alive(bot: Slot): boolean {
    return this.m.x.sim_alive(this.id, bot) !== 0;
  }

  /**
   * Fait `f` avec `Math.random` tiré du hasard du module (les tirages de `rand` du code partagé : la
   * composition des équipes), qui reprend ensuite où `f` s'est arrêtée : une seule suite, comme le
   * `Math.random` de la simulation du TypeScript.
   */
  draw<T>(f: () => T, seed?: number): T {
    let state = (seed ?? this.m.x.sim_rng_state(this.id)) >>> 0;
    const saved = Math.random;
    Math.random = () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    try {
      return f();
    } finally {
      Math.random = saved;
      this.m.x.sim_seed(this.id, state);
    }
  }

  dispose(): void {
    this.listeners.clear();
    this.m.x.sim_free(this.id);
  }
}

/** Un événement du journal qui dit qu'un robot apparaît. */
export const isBotAdded = (e: LoggedEvent): boolean => e.code === CODE.botAdded;
