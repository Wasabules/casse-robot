import { ARENA_IDS, isMapKey, type ArenaId, type ArenaKey, type MapKey } from "../shared/arena/layout";
import type { MapFile } from "../shared/map/format";
import { registerMap } from "../shared/map/load";
import { isArmId } from "../shared/catalog/melee";
import { designCost } from "../shared/design/budget";
import { hasPart, lockedParts, matchReward, partPrice, unlockParts } from "../shared/design/progression";
import { profileFromDesign } from "../shared/design/custom";
import type { BotProfile } from "../shared/design/presets";
import { upgradeDesign, validateDesign, type RobotDesign } from "../shared/design/robotDesign";
import { vec3, type Vec3 } from "../shared/math/vec";
import { GAME_MODES, PILOTABLE, pickRoster } from "../shared/modes";
import { describeWorld, NetEncoder } from "../shared/net/encoder";
import {
  encodeFrame, KNOWN_MAPS, PROTOCOL_VERSION, SNAPSHOT_EVERY, type ClientMessage, type NetEvent, type RobotChoice, type ServerMessage,
} from "../shared/net/protocol";
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
const MODE = GAME_MODES.battle;
const TEAM_SIZE = MODE.size / 2;
const TEAMS: readonly Team[] = ["blue", "red"];

/** Liaison vers un client. */
export interface Connection {
  send(data: string | Uint8Array): void;
}

export interface Player {
  readonly id: number;
  readonly conn: Connection;
  name: string;
  /** Robot choisi ; null tant qu'il n'a pas rejoint la partie. */
  profile: BotProfile | null;
  team: Team;
  /** Ses commandes, que pilote son robot (`Bot.input`). */
  readonly input: PlayerInput;
  bot: Bot | null;
  /** Il vient d'arriver : sa première image décrit tout le monde. */
  fresh: boolean;
  /** Son jeton : sa progression sur le serveur ; et les robots qu'il a détruits dans la partie en cours. */
  token: string;
  kills: number;
  /** Les cartes communautaires qu'il a déjà (annoncées en rejoignant, ou envoyées depuis) : on ne les lui renvoie pas. */
  known: Set<string>;
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
}

export class Room {
  readonly sim = new Simulation();
  /** Progression des joueurs : crédits gagnés ici, pièces débloquées ici. */
  readonly book: ProgressBook;
  private readonly encoder: NetEncoder;
  private readonly players = new Set<Player>();
  private nextPlayer = 1;
  private steps = 0;
  /** Temps simulé auquel la partie suivante commence (après la fin de celle en cours), ou null. */
  private restartAt: number | null = null;
  /** Rang de l'arène de la partie en cours : elles se succèdent d'une partie à l'autre. */
  private arenaIndex = -1;
  /** Les arènes qui se succèdent : celles du jeu, puis les cartes communautaires. */
  readonly rotation: readonly ArenaKey[];
  /** Les cartes communautaires de la salle, par identifiant : envoyées à qui ne les a pas. */
  private readonly maps = new Map<MapKey, MapFile>();

  constructor(book = new ProgressBook(), options: RoomOptions = {}) {
    this.book = book;
    for (const map of options.maps ?? []) {
      const arena = registerMap(map);
      if (isMapKey(arena.id)) this.maps.set(arena.id, map);
    }
    const community = [...this.maps.keys()];
    this.rotation = options.mapsOnly && community.length ? community : [...(options.arenas ?? ARENA_IDS), ...community];
    this.encoder = new NetEncoder(this.sim);
    this.sim.combat = MODE.combat;
    // Les destructions de chaque joueur (ses robots successifs portent ses commandes)
    this.sim.on((e) => {
      if (e.type !== "botKilled" || !e.killer || e.killer.team === e.bot.team) return;
      for (const p of this.players) if (p.profile && e.killer.input === p.input) p.kills++;
    });
    this.newMatch();
  }

  /** Joueurs dans la partie. */
  get playerCount(): number {
    return [...this.players].filter((p) => p.profile).length;
  }

  /** Un client se connecte ; il rejoint la partie avec son premier message (`join`). */
  connect(conn: Connection): Player {
    const player: Player = {
      id: this.nextPlayer++, conn, name: "", profile: null, team: "blue", input: newInput(), bot: null, fresh: true, token: "", kills: 0,
      known: new Set(),
    };
    this.players.add(player);
    return player;
  }

  /** Le client s'en va : son robot repasse à l'IA. */
  disconnect(player: Player): void {
    if (player.bot) releaseControl(player.bot);
    this.players.delete(player);
  }

  receive(player: Player, text: string): void {
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
        if (player.bot?.cockpit.alive) selfDestruct(this.sim, player.bot);
        break;
      default:
        break;
    }
  }

  /** Un pas de simulation ; une image pour tous les joueurs tous les SNAPSHOT_EVERY pas. */
  tick(): void {
    this.sim.step();
    // Après une réapparition, le robot du joueur est un nouveau robot qui porte ses commandes
    for (const p of this.players) if (p.profile) p.bot = this.sim.bots.find((b) => b.input === p.input) ?? null;
    const match = this.sim.match;
    if (match?.winner && this.restartAt === null) {
      this.restartAt = this.sim.time + RESTART_DELAY;
      this.reward(match.winner);
    }
    if (this.restartAt !== null && this.sim.time >= this.restartAt) this.newMatch();
    if (++this.steps % SNAPSHOT_EVERY === 0) this.broadcast();
  }

  dispose(): void {
    this.encoder.dispose();
    this.sim.dispose();
  }

  private send(player: Player, msg: ServerMessage): void {
    player.conn.send(JSON.stringify(msg));
  }

  private join(player: Player, msg: Extract<ClientMessage, { t: "join" }>): void {
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
    if (this.restartAt === null) this.replaceAi(player);
  }

  /** Envoie au joueur la carte communautaire en place, s'il ne l'a pas déjà (une seule fois). */
  private shareMap(player: Player): void {
    const key = this.sim.arena.id;
    if (!isMapKey(key) || player.known.has(key)) return;
    const map = this.maps.get(key);
    if (!map) return;
    this.send(player, { t: "map", key, map });
    player.known.add(key);
  }

  /** Fin de partie : chaque joueur gagne des crédits (partie jouée, victoire, destructions), ici gardés. */
  private reward(winner: Team | "draw"): void {
    for (const p of this.players) {
      if (!p.profile || !p.token) continue;
      const outcome = winner === "draw" ? "draw" : winner === p.team ? "win" : "loss";
      const reward = matchReward({ outcome, kills: p.kills, captures: 0 });
      const ledger = this.book.get(p.token);
      ledger.credits += reward.total;
      this.send(p, { t: "progress", progress: ledger, reward });
    }
    this.book.changed();
  }

  /** Le robot du joueur remplace un robot de l'IA de son équipe, de son côté de l'arène. */
  private replaceAi(player: Player): void {
    const i = this.sim.bots.findIndex((b) => b.team === player.team && b.controller === "ai");
    if (i < 0 || !player.profile) return;
    const old = this.sim.bots[i];
    const match = this.sim.match;
    if (match) {
      const waiting = match.respawns.findIndex((r) => r.bot === old);
      if (waiting >= 0) match.respawns.splice(waiting, 1);
      match.stuck.delete(old);
    }
    removeBot(this.sim, old);
    const bot = respawnBot(this.sim, player.profile, player.team);
    takeControl(bot, player.input);
    this.sim.bots[i] = bot;
    player.bot = bot;
  }

  /**
   * Nouvelle partie, dans l'arène suivante : les joueurs d'abord, puis l'IA complète les équipes,
   * du robot le plus cher au moins cher, chacun dans l'équipe qui coûte le moins jusque-là (voir
   * `matchEntries`) : les deux équipes sont de même force.
   */
  private newMatch(): void {
    endMatch(this.sim);
    for (const p of this.players) p.kills = 0;
    this.arenaIndex = (this.arenaIndex + 1) % this.rotation.length;
    this.sim.loadArena(this.rotation[this.arenaIndex]);
    // Une carte communautaire : à ceux qui ne l'ont pas, avant l'image qui la met en place
    for (const p of this.players) if (p.profile) this.shareMap(p);
    const humans = [...this.players].filter((p) => p.profile);
    const cost = (profile: BotProfile): number => designCost(profile.design);
    const teams: Record<Team, { entries: WaveEntry[]; owners: (Player | null)[]; cost: number }> = {
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
    const pool = pickRoster(MODE);
    const ai = Array.from({ length: free("red") + free("blue") }, (_, i) => pool[i % pool.length]).sort((a, b) => cost(b) - cost(a));
    for (const profile of ai) {
      const team: Team = free("blue") > 0 && (free("red") === 0 || teams.blue.cost <= teams.red.cost) ? "blue" : "red";
      teams[team].entries.push({ profile, team });
      teams[team].owners.push(null);
      teams[team].cost += cost(profile);
    }
    const entries = TEAMS.flatMap((team) => teams[team].entries);
    const owners = TEAMS.flatMap((team) => teams[team].owners);
    const bots = spawnTeams(this.sim, entries);
    bots.forEach((bot, k) => {
      const owner = owners[k];
      if (!owner) return;
      takeControl(bot, owner.input);
      owner.bot = bot;
    });
    startMatch(this.sim, MODE.match);
    this.encoder.push({ t: "match", rules: MODE.match });
    this.restartAt = null;
  }

  /** Image pour chacun : les changements depuis la précédente, ou tout le monde pour qui arrive. */
  private broadcast(): void {
    const events = this.encoder.take();
    const snapshot = writeSnapshot(this.sim);
    let world: NetEvent[] | null = null;
    for (const p of this.players) {
      if (!p.profile) continue;
      const locking = p.bot ? pilotLock(p.bot) : null;
      const lock = locking?.lockOn ? { turret: locking.block.id, target: locking.lockOn.id, progress: lockProgress(locking) } : null;
      const header = { events: p.fresh ? (world ??= describeWorld(this.sim)) : events, you: p.bot?.id ?? null, lock };
      p.fresh = false;
      p.conn.send(encodeFrame(header, snapshot));
    }
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
