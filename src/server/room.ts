import { ARENA_IDS, isMapKey, type ArenaId, type ArenaKey, type MapKey } from "../shared/arena/layout";
import type { MapFile } from "../shared/map/format";
import { registerMap } from "../shared/map/load";
import { isArmId } from "../shared/catalog/melee";
import { designCost } from "../shared/design/budget";
import { hasPart, lockedParts, matchReward, partPrice, unlockParts, type MatchResult } from "../shared/design/progression";
import { profileFromDesign } from "../shared/design/custom";
import type { BotProfile } from "../shared/design/presets";
import { upgradeDesign, validateDesign, type RobotDesign } from "../shared/design/robotDesign";
import { vec3, type Vec3 } from "../shared/math/vec";
import { GAME_MODES, PILOTABLE, pickRoster } from "../shared/modes";
import { describeWorld, NetEncoder } from "../shared/net/encoder";
import {
  encodeFrame, KNOWN_MAPS, PROTOCOL_VERSION, SNAPSHOT_EVERY, type ClientMessage, type FrameHeader, type LockState, type NetEvent, type RobotChoice,
  type ServerMessage,
} from "../shared/net/protocol";
import { STEP } from "../shared/config";
import type { MatchRules } from "../shared/sim/match";
import { writeSnapshot } from "../shared/net/snapshot";
import { lockProgress, pilotLock } from "../shared/combat/lock";
import { removeBot } from "../shared/robot/lifecycle";
import type { Bot, Team } from "../shared/sim/entities";
import { endMatch, selfDestruct, startMatch } from "../shared/sim/match";
import { newInput, releaseControl, takeControl, type PlayerInput } from "../shared/sim/player";
import { Simulation } from "../shared/sim/simulation";
import { respawnBot, spawnTeams, type WaveEntry } from "../shared/sim/wave";
import { ProgressBook, TOKEN_PATTERN } from "./progressBook";

/*
 * Salle de jeu du serveur : une bataille six contre six (mode Bataille), sans fin. Les joueurs
 * prennent la place de robots de l'IA dans l'équipe qui compte le moins d'humains ; un joueur qui
 * part rend son robot à l'IA. Après chaque partie, une nouvelle commence au bout de quelques
 * secondes. La salle ne connaît pas le transport : elle reçoit des messages texte et envoie par
 * `Connection` (WebSocket dans server/main.ts, simple fonction dans les tests).
 */

/** Délai entre la fin d'une partie et la suivante (s). */
const RESTART_DELAY = 8;
/** Longueur maximale d'un nom de joueur. */
const NAME_MAX = 20;
/** Le mode de jeu de la salle. */
export const MODE_ID = "battle";
export const MODE = GAME_MODES[MODE_ID];
const TEAM_SIZE = MODE.size / 2;
const TEAMS: readonly Team[] = ["blue", "red"];

/** Liaison vers un client. */
export interface Connection {
  send(data: string | Uint8Array): void;
}

/** Un joueur ; `B` : son robot, tel que le désigne la simulation de la salle (un `Bot`, un rang du module Rust). */
export interface Player<B = Bot> {
  readonly id: number;
  readonly conn: Connection;
  name: string;
  /** Robot choisi ; null tant qu'il n'a pas rejoint la partie. */
  profile: BotProfile | null;
  team: Team;
  /** Ses commandes, que pilote son robot (`Bot.input`). */
  readonly input: PlayerInput;
  bot: B | null;
  /** Il vient d'arriver : sa première image décrit tout le monde. */
  fresh: boolean;
  /** Son jeton : sa progression sur le serveur ; et les robots qu'il a détruits dans la partie en cours. */
  token: string;
  kills: number;
  /** Les cartes communautaires qu'il a déjà (annoncées en rejoignant, ou envoyées depuis) : on ne les lui renvoie pas. */
  known: Set<string>;
  /**
   * Sa réplique montre le monde d'une salle qui s'est arrêtée sur une erreur (server/roomHost.ts) : sa
   * prochaine image (qui décrit tout le monde) lui dit de l'oublier (`FrameHeader.reset`).
   */
  reset: boolean;
}

/**
 * Ce qu'une salle neuve reprend de celle qui s'est arrêtée sur une erreur (server/roomHost.ts) : les
 * clients connectés, et où en était la rotation des arènes.
 */
export interface RoomCarry {
  /** Les clients connectés ; ceux qui avaient rejoint gardent leur nom, leur robot, leur équipe, leur jeton, leurs cartes. */
  readonly players: readonly Player<unknown>[];
  /** Le rang, dans la rotation, de l'arène de la partie interrompue : la première partie se joue dans la suivante. */
  readonly arena: number;
}

/** Où en est une salle, d'après ce qu'elle tient elle-même : rien n'est demandé à sa simulation (lisible après une erreur). */
export interface RoomSummary {
  /** L'arène de la partie en cours, et son rang dans la rotation. */
  readonly arena: ArenaKey;
  readonly arenaRank: number;
  /** Le mode de jeu de la salle. */
  readonly mode: string;
  /** Temps simulé depuis la création de la salle, et depuis le début de la partie en cours (s). */
  readonly time: number;
  readonly matchTime: number;
  /** Joueurs dans la partie. */
  readonly players: number;
}

/** Ce qu'on peut donner à une salle en plus de la progression des joueurs. */
export interface RoomOptions {
  /**
   * Les arènes du jeu de la rotation (toutes par défaut) : celles dont le fichier a été fourni
   * (map/gameArenas.ts ; server/main.ts les lit dans content/arenas/).
   */
  readonly arenas?: readonly ArenaId[];
  /** Cartes communautaires (déjà vérifiées : `checkMap`), qui entrent dans la rotation après les arènes du jeu. */
  readonly maps?: readonly MapFile[];
  /** Seulement les cartes communautaires dans la rotation (s'il y en a). */
  readonly mapsOnly?: boolean;
  /** Ce que la salle reprend de celle qui s'est arrêtée sur une erreur (server/roomHost.ts). */
  readonly carry?: RoomCarry;
}

/**
 * Ce que fait une salle, quelle que soit sa simulation : les joueurs qui arrivent et partent, leurs
 * commandes, la rotation des arènes, les parties qui se suivent, les crédits ; et la simulation, par
 * ce que chaque sorte de salle en fait (celle du TypeScript : `Room` ; celle portée en Rust :
 * `NativeRoom`, server/nativeRoom.ts). `B` : un robot, tel que la simulation le désigne.
 */
export abstract class RoomBase<B> {
  /** Progression des joueurs : crédits gagnés ici, pièces débloquées ici. */
  readonly book: ProgressBook;
  protected readonly players = new Set<Player<B>>();
  private nextPlayer = 1;
  private steps = 0;
  /** Le pas où la partie en cours a commencé. */
  private matchStep = 0;
  /** Temps simulé auquel la partie suivante commence (après la fin de celle en cours), ou null. */
  private restartAt: number | null = null;
  /** Rang de l'arène de la partie en cours : elles se succèdent d'une partie à l'autre. */
  private arenaIndex = -1;
  /** Les arènes qui se succèdent : celles du jeu, puis les cartes communautaires. */
  readonly rotation: readonly ArenaKey[];
  /** Les cartes communautaires de la salle, par identifiant : envoyées à qui ne les a pas. */
  private readonly maps = new Map<MapKey, MapFile>();

  constructor(book: ProgressBook, options: RoomOptions) {
    this.book = book;
    for (const map of options.maps ?? []) {
      const arena = registerMap(map);
      if (isMapKey(arena.id)) this.maps.set(arena.id, map);
    }
    const community = [...this.maps.keys()];
    this.rotation = options.mapsOnly && community.length ? community : [...(options.arenas ?? ARENA_IDS), ...community];
    // Reprise après une erreur : les clients connectés passent dans cette salle (avant sa première partie,
    // qui place ceux qui avaient rejoint), qui reprend la rotation après l'arène de la partie interrompue
    const carry = options.carry;
    if (carry) {
      this.arenaIndex = carry.arena % this.rotation.length;
      for (const p of carry.players) this.adopt(p as Player<B>);
    }
  }

  /** Un client de la salle qui s'est arrêtée : son robot de là-bas n'existe plus, son monde est à refaire. */
  private adopt(player: Player<B>): void {
    player.bot = null;
    player.kills = 0;
    player.fresh = true;
    player.reset = player.profile !== null;
    this.players.add(player);
    this.nextPlayer = Math.max(this.nextPlayer, player.id + 1);
  }

  /** Les clients connectés (ceux qui ont rejoint la partie, et les autres). */
  get connected(): readonly Player<B>[] {
    return [...this.players];
  }

  /** Où en est la salle : lu sans rien demander à la simulation (une simulation qui a paniqué ne répond plus). */
  summary(): RoomSummary {
    return {
      arena: this.rotation[Math.max(0, this.arenaIndex)], arenaRank: this.arenaIndex, mode: MODE_ID,
      time: this.steps * STEP, matchTime: (this.steps - this.matchStep) * STEP, players: this.playerCount,
    };
  }

  /** Temps simulé depuis la création de la salle (s), d'après ses pas. */
  get elapsed(): number {
    return this.steps * STEP;
  }

  /** Ce que la simulation sait d'une erreur (le message d'une panique du module Rust, `SimModule.explain`). */
  explain(e: unknown): string {
    return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }

  /**
   * Outil d'essai (`SIM_FAULT`, server/main.ts ; tests/roomHost.test.ts) : une vraie panne de la
   * simulation, comme une panique au milieu d'un pas ; elle lève l'erreur.
   */
  abstract provokeFault(): void;

  // La simulation de la salle (chaque sorte la sienne)
  /** Temps simulé, arène en place, vainqueur de la partie en cours (null : elle continue, ou pas de partie). */
  protected abstract get time(): number;
  protected abstract get arenaKey(): ArenaKey;
  protected abstract get winner(): Team | "draw" | null;
  /** Un pas de simulation (les destructions de chaque joueur comptées : `creditKill`). */
  protected abstract stepWorld(): void;
  /** Le robot qui porte les commandes du joueur (après une réapparition, un nouveau robot), ou null. */
  protected abstract botOf(player: Player<B>): B | null;
  protected abstract alive(bot: B): boolean;
  protected abstract selfDestructBot(bot: B): void;
  protected abstract releaseBot(bot: B): void;
  /** Le robot du joueur remplace un robot de l'IA de son équipe (ce robot, ou null s'il n'y en a pas). */
  protected abstract replaceAiBot(player: Player<B>, profile: BotProfile): B | null;
  protected abstract endMatchWorld(): void;
  protected abstract loadArenaWorld(key: ArenaKey): void;
  /** Le hasard de la simulation, pour la composition des équipes (`pickRoster`). */
  protected abstract drawRoster(): BotProfile[];
  protected abstract spawnTeamsWorld(entries: WaveEntry[]): B[];
  protected abstract takeControlWorld(bot: B, player: Player<B>): void;
  /** Une partie commence (et l'événement `match` part avec la prochaine image). */
  protected abstract startMatchWorld(rules: MatchRules): void;
  /** Les événements depuis l'image précédente, l'instantané, et la description du monde (pour qui arrive). */
  protected abstract takeEvents(): NetEvent[];
  protected abstract snapshot(): Uint8Array;
  protected abstract describeWorld(): NetEvent[];
  /** Le numéro d'entité du robot, et le verrou à montrer à son pilote. */
  protected abstract botId(bot: B): number;
  protected abstract lockOf(bot: B): LockState | null;
  abstract dispose(): void;

  /** Un robot ennemi détruit par un robot aux commandes `input` : la destruction compte pour son joueur. */
  protected creditKill(input: PlayerInput): void {
    for (const p of this.players) if (p.profile && input === p.input) p.kills++;
  }

  /** Joueurs dans la partie. */
  get playerCount(): number {
    return [...this.players].filter((p) => p.profile).length;
  }

  /** Un client se connecte ; il rejoint la partie avec son premier message (`join`). */
  connect(conn: Connection): Player<B> {
    const player: Player<B> = {
      id: this.nextPlayer++, conn, name: "", profile: null, team: "blue", input: newInput(), bot: null, fresh: true, token: "", kills: 0,
      known: new Set(), reset: false,
    };
    this.players.add(player);
    return player;
  }

  /** Le client s'en va : son robot repasse à l'IA (il quitte la salle d'abord : une erreur de la simulation ne le retient pas). */
  disconnect(player: Player<B>): void {
    this.players.delete(player);
    if (player.bot !== null) this.releaseBot(player.bot);
  }

  receive(player: Player<B>, text: string): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(text) as ClientMessage;
    } catch {
      return;
    }
    switch (msg?.t) {
      case "join":
        if (!player.profile) this.join(player, msg);
        break;
      case "input":
        readInput(player.input, msg.input);
        break;
      case "selfDestruct":
        if (player.bot !== null && this.alive(player.bot)) this.selfDestructBot(player.bot);
        break;
      default:
        break;
    }
  }

  /** Un pas de simulation ; une image pour tous les joueurs tous les SNAPSHOT_EVERY pas. */
  tick(): void {
    this.stepWorld();
    // Après une réapparition, le robot du joueur est un nouveau robot qui porte ses commandes
    for (const p of this.players) if (p.profile) p.bot = this.botOf(p);
    const winner = this.winner;
    if (winner && this.restartAt === null) {
      this.restartAt = this.time + RESTART_DELAY;
      this.reward(winner);
    }
    if (this.restartAt !== null && this.time >= this.restartAt) this.newMatch();
    if (++this.steps % SNAPSHOT_EVERY === 0) this.broadcast();
  }

  private send(player: Player<B>, msg: ServerMessage): void {
    player.conn.send(JSON.stringify(msg));
  }

  private join(player: Player<B>, msg: Extract<ClientMessage, { t: "join" }>): void {
    if (msg.version !== PROTOCOL_VERSION) {
      this.send(player, { t: "refused", refusal: { code: "version" } });
      return;
    }
    const token = typeof msg.token === "string" && TOKEN_PATTERN.test(msg.token) ? msg.token : null;
    if (!token) {
      this.send(player, { t: "refused", refusal: { code: "token" } });
      return;
    }
    const robot = resolveRobot(msg.robot);
    if (!robot) {
      this.send(player, { t: "refused", refusal: { code: "invalidRobot" } });
      return;
    }
    // Un robot du garage : ses pièces doivent être débloquées ici ; les crédits du serveur y pourvoient
    const ledger = this.book.get(token);
    const locked = "design" in msg.robot ? lockedParts(robot.design, (part) => hasPart(ledger, part)) : [];
    const price = locked.length ? unlockParts(ledger, locked) : 0;
    if (price === null) {
      const need = locked.reduce((sum, p) => sum + partPrice(p), 0);
      this.send(player, { t: "refused", refusal: { code: "locked", parts: locked, price: need, credits: ledger.credits } });
      return;
    }
    if (price > 0) this.book.changed();
    const humans = (team: Team): number => [...this.players].filter((p) => p.profile && p.team === team).length;
    const team = TEAMS.filter((t) => humans(t) < TEAM_SIZE).sort((a, b) => humans(a) - humans(b))[0];
    if (!team) {
      this.send(player, { t: "refused", refusal: { code: "full" } });
      return;
    }
    // Sans nom : « Robot 3 », un nom qui se lit pareil dans les langues du jeu (le serveur n'écrit pas de texte à traduire)
    player.name = String(msg.name ?? "").trim().slice(0, NAME_MAX) || `Robot ${player.id}`;
    player.profile = { ...robot, name: player.name };
    player.team = team;
    player.fresh = true;
    player.token = token;
    player.kills = 0;
    // Les cartes qu'il a déjà : des identifiants bien formés, en nombre borné
    player.known = new Set(Array.isArray(msg.maps) ? msg.maps.slice(0, KNOWN_MAPS).filter(isMapKey) : []);
    this.send(player, {
      t: "welcome", player: player.id, progress: ledger,
      bought: locked.length ? { parts: locked, price } : null,
    });
    // La carte en place, s'il ne l'a pas : avant la première image, qui la met en place
    this.shareMap(player);
    // En pleine partie, il prend tout de suite la place d'un robot de l'IA de son équipe
    if (this.restartAt === null) {
      const bot = this.replaceAiBot(player, player.profile);
      if (bot !== null) player.bot = bot;
    }
  }

  /** Envoie au joueur la carte communautaire en place, s'il ne l'a pas déjà (une seule fois). */
  private shareMap(player: Player<B>): void {
    const key = this.arenaKey;
    if (!isMapKey(key) || player.known.has(key)) return;
    const map = this.maps.get(key);
    if (!map) return;
    this.send(player, { t: "map", key, map });
    player.known.add(key);
  }

  /** Fin de partie : chaque joueur gagne des crédits (partie jouée, victoire, destructions), ici gardés. */
  private reward(winner: Team | "draw"): void {
    this.pay((p) => (winner === "draw" ? "draw" : winner === p.team ? "win" : "loss"));
  }

  /**
   * La salle s'arrête sur une erreur au milieu d'une partie (server/roomHost.ts) : chaque joueur gagne
   * ce que la partie lui a déjà rapporté (partie jouée, ses destructions), ni victoire ni match nul.
   * Ne lit rien de la simulation (elle a pu paniquer). Rien entre deux parties : la précédente a payé.
   */
  rewardInterrupted(): void {
    if (this.restartAt === null) this.pay(() => "loss");
  }

  private pay(outcomeOf: (p: Player<B>) => MatchResult["outcome"]): void {
    for (const p of this.players) {
      if (!p.profile || !p.token) continue;
      const reward = matchReward({ outcome: outcomeOf(p), kills: p.kills, captures: 0 });
      const ledger = this.book.get(p.token);
      ledger.credits += reward.total;
      this.send(p, { t: "progress", progress: ledger, reward });
    }
    this.book.changed();
  }

  /**
   * Nouvelle partie, dans l'arène suivante : les joueurs d'abord, puis l'IA complète les équipes,
   * du robot le plus cher au moins cher, chacun dans l'équipe qui coûte le moins jusque-là (voir
   * `matchEntries`) : les deux équipes sont de même force.
   */
  protected newMatch(): void {
    this.endMatchWorld();
    for (const p of this.players) p.kills = 0;
    this.arenaIndex = (this.arenaIndex + 1) % this.rotation.length;
    this.loadArenaWorld(this.rotation[this.arenaIndex]);
    // Une carte communautaire : à ceux qui ne l'ont pas, avant l'image qui la met en place
    for (const p of this.players) if (p.profile) this.shareMap(p);
    const humans = [...this.players].filter((p) => p.profile);
    const cost = (profile: BotProfile): number => designCost(profile.design);
    const teams: Record<Team, { entries: WaveEntry[]; owners: (Player<B> | null)[]; cost: number }> = {
      red: { entries: [], owners: [], cost: 0 },
      blue: { entries: [], owners: [], cost: 0 },
    };
    for (const team of TEAMS) {
      for (const p of humans.filter((h) => h.team === team).slice(0, TEAM_SIZE)) {
        teams[team].entries.push({ profile: p.profile!, team });
        teams[team].owners.push(p);
        teams[team].cost += cost(p.profile!);
      }
    }
    const free = (team: Team): number => TEAM_SIZE - teams[team].entries.length;
    const pool = this.drawRoster();
    const ai = Array.from({ length: free("red") + free("blue") }, (_, i) => pool[i % pool.length]).sort((a, b) => cost(b) - cost(a));
    for (const profile of ai) {
      const team: Team = free("blue") > 0 && (free("red") === 0 || teams.blue.cost <= teams.red.cost) ? "blue" : "red";
      teams[team].entries.push({ profile, team });
      teams[team].owners.push(null);
      teams[team].cost += cost(profile);
    }
    const entries = TEAMS.flatMap((team) => teams[team].entries);
    const owners = TEAMS.flatMap((team) => teams[team].owners);
    const bots = this.spawnTeamsWorld(entries);
    bots.forEach((bot, k) => {
      const owner = owners[k];
      if (!owner) return;
      this.takeControlWorld(bot, owner);
      owner.bot = bot;
    });
    this.startMatchWorld(MODE.match);
    this.restartAt = null;
    this.matchStep = this.steps;
  }

  /** Image pour chacun : les changements depuis la précédente, ou tout le monde pour qui arrive. */
  private broadcast(): void {
    const events = this.takeEvents();
    const snapshot = this.snapshot();
    let world: NetEvent[] | null = null;
    for (const p of this.players) {
      if (!p.profile) continue;
      const lock = p.bot !== null ? this.lockOf(p.bot) : null;
      const header: FrameHeader = { events: p.fresh ? (world ??= this.describeWorld()) : events, you: p.bot !== null ? this.botId(p.bot) : null, lock };
      // La salle d'avant s'est arrêtée sur une erreur : sa réplique oublie le monde qu'elle montrait
      if (p.reset) header.reset = true;
      p.fresh = false;
      p.reset = false;
      p.conn.send(encodeFrame(header, snapshot));
    }
  }
}

/** La salle sur la simulation du TypeScript (`Simulation`). */
export class Room extends RoomBase<Bot> {
  readonly sim = new Simulation();
  private readonly encoder: NetEncoder;

  constructor(book = new ProgressBook(), options: RoomOptions = {}) {
    super(book, options);
    this.encoder = new NetEncoder(this.sim);
    this.sim.combat = MODE.combat;
    // Les destructions de chaque joueur (ses robots successifs portent ses commandes)
    this.sim.on((e) => {
      if (e.type !== "botKilled" || !e.killer || e.killer.team === e.bot.team || !e.killer.input) return;
      this.creditKill(e.killer.input);
    });
    this.newMatch();
  }

  protected get time(): number {
    return this.sim.time;
  }

  protected get arenaKey(): ArenaKey {
    return this.sim.arena.id;
  }

  protected get winner(): Team | "draw" | null {
    return this.sim.match?.winner ?? null;
  }

  protected stepWorld(): void {
    this.sim.step();
  }

  protected botOf(player: Player<Bot>): Bot | null {
    return this.sim.bots.find((b) => b.input === player.input) ?? null;
  }

  protected alive(bot: Bot): boolean {
    return bot.cockpit.alive;
  }

  protected selfDestructBot(bot: Bot): void {
    selfDestruct(this.sim, bot);
  }

  protected releaseBot(bot: Bot): void {
    releaseControl(bot);
  }

  protected replaceAiBot(player: Player<Bot>, profile: BotProfile): Bot | null {
    const i = this.sim.bots.findIndex((b) => b.team === player.team && b.controller === "ai");
    if (i < 0) return null;
    const old = this.sim.bots[i];
    const match = this.sim.match;
    if (match) {
      const waiting = match.respawns.findIndex((r) => r.bot === old);
      if (waiting >= 0) match.respawns.splice(waiting, 1);
      match.stuck.delete(old);
    }
    removeBot(this.sim, old);
    const bot = respawnBot(this.sim, profile, player.team);
    takeControl(bot, player.input);
    this.sim.bots[i] = bot;
    return bot;
  }

  protected endMatchWorld(): void {
    endMatch(this.sim);
  }

  protected loadArenaWorld(key: ArenaKey): void {
    this.sim.loadArena(key);
  }

  protected drawRoster(): BotProfile[] {
    return pickRoster(MODE);
  }

  protected spawnTeamsWorld(entries: WaveEntry[]): Bot[] {
    return spawnTeams(this.sim, entries);
  }

  protected takeControlWorld(bot: Bot, player: Player<Bot>): void {
    takeControl(bot, player.input);
  }

  protected startMatchWorld(rules: MatchRules): void {
    startMatch(this.sim, rules);
    this.encoder.push({ t: "match", rules });
  }

  protected takeEvents(): NetEvent[] {
    return this.encoder.take();
  }

  protected snapshot(): Uint8Array {
    return writeSnapshot(this.sim);
  }

  protected describeWorld(): NetEvent[] {
    return describeWorld(this.sim);
  }

  protected botId(bot: Bot): number {
    return bot.id;
  }

  protected lockOf(bot: Bot): LockState | null {
    const locking = pilotLock(bot);
    return locking?.lockOn ? { turret: locking.block.id, target: locking.lockOn.id, progress: lockProgress(locking) } : null;
  }

  provokeFault(): void {
    throw new Error("panne d'essai de la simulation du TypeScript (SIM_FAULT)");
  }

  dispose(): void {
    this.encoder.dispose();
    this.sim.dispose();
  }
}

/** Robot demandé par un client : un robot pilotable prédéfini, ou un plan du garage valide. */
function resolveRobot(choice: RobotChoice | undefined): BotProfile | null {
  if (!choice || typeof choice !== "object") return null;
  if ("preset" in choice) return PILOTABLE.find((p) => p.id === choice.preset) ?? null;
  const raw = choice.design as RobotDesign;
  if (!raw || !Array.isArray(raw.blocks) || !Array.isArray(raw.wheels)) return null;
  const design = upgradeDesign(raw);
  try {
    if (validateDesign(design).length) return null;
  } catch {
    return null;
  }
  const color = /^#[0-9a-f]{6}$/i.test(choice.color) ? choice.color : "#888888";
  return profileFromDesign(String(choice.name ?? "Robot").slice(0, NAME_MAX), color, design);
}

/** Recopie des commandes reçues, bornées : on ne fait pas confiance au client. */
function readInput(target: PlayerInput, raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const i = raw as Record<string, unknown>;
  const unit = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);
  target.throttle = unit(i.throttle);
  target.steer = unit(i.steer);
  target.climb = unit(i.climb);
  target.boost = i.boost === true;
  target.brake = Math.max(0, unit(i.brake));
  target.trigger = i.trigger === true;
  target.scope = i.scope === true;
  target.detonate = i.detonate === true;
  target.flares = i.flares === true;
  target.relative = i.relative === true;
  target.manual = i.manual === true;
  target.yaw = unit(i.yaw);
  target.power = Math.max(0, unit(i.power));
  target.heading = typeof i.heading === "number" && Number.isFinite(i.heading) ? i.heading : 0;
  // Une arme de tourelle ou de contact (une toupie choisie tourne)
  target.weapon = typeof i.weapon === "string" && isArmId(i.weapon) ? i.weapon : null;
  target.aim = toVec(i.aim);
  target.look = toDirection(i.look);
}

/** Une direction (le regard du pilote) : ramenée à l'unité, ou null si elle n'en est pas une. */
function toDirection(v: unknown): Vec3 | null {
  const d = toVec(v);
  const l = d ? Math.hypot(d.x, d.y, d.z) : 0;
  return d && l > 1e-3 ? vec3(d.x / l, d.y / l, d.z / l) : null;
}

function toVec(v: unknown): Vec3 | null {
  if (!v || typeof v !== "object") return null;
  const { x, y, z } = v as Record<string, unknown>;
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 1e4;
  return ok(x) && ok(y) && ok(z) ? vec3(x, y, z) : null;
}
