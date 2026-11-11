import { designCost } from "./design/budget";
import { PRESET_BOTS, type BotProfile } from "./design/presets";
import { rand } from "./math/scalar";
import type { MatchRules } from "./sim/match";
import type { WaveEntry } from "./sim/wave";

/**
 * Modes de jeu : les règles d'une partie. Ils vivent dans le code partagé, parce que le serveur
 * multijoueur les applique lui aussi. Leur nom et leur phrase pour le menu sont dans chaque langue
 * (`mode.<id>`, `modeInfo.<id>` : client/i18n/locales/<langue>/world.ts).
 */
export interface GameMode {
  /** Le joueur pilote un robot de l'équipe bleue ; sinon, il regarde et tire depuis une caméra libre. */
  readonly pilot: boolean;
  /** Les tourelles de l'IA tirent. */
  readonly combat: boolean;
  /** Les robots parmi lesquels on tire ceux de la vague, et leur nombre (joueur compris). */
  readonly roster: readonly BotProfile[];
  readonly size: number;
  /** Règles de la partie (score, durée, réapparitions) ; null : pas de partie, la vague se relance à la demande. */
  readonly match: MatchRules | null;
  /** Mode proposé à l'écran titre (l'essai du garage ne l'est pas). */
  readonly listed: boolean;
}

export const GAME_MODES = {
  battle: {
    pilot: true,
    combat: true,
    roster: PRESET_BOTS,
    size: 12,
    match: { scoreToWin: 15, timeLimit: 300, respawn: 5 },
    listed: true,
  },
  capture: {
    pilot: true,
    combat: true,
    roster: PRESET_BOTS,
    size: 12,
    match: { scoreToWin: 100, timeLimit: 420, respawn: 6, capture: { time: 6, rate: 0.5 } },
    listed: true,
  },
  hill: {
    pilot: true,
    combat: true,
    roster: PRESET_BOTS,
    size: 12,
    match: { scoreToWin: 60, timeLimit: 420, respawn: 6, capture: { time: 4, rate: 1, hill: 40 } },
    listed: true,
  },
  elimination: {
    pilot: true,
    combat: true,
    roster: PRESET_BOTS,
    size: 12,
    match: { scoreToWin: 0, timeLimit: 300, respawn: null },
    listed: true,
  },
  arena: {
    pilot: false,
    combat: true,
    roster: PRESET_BOTS,
    size: 12,
    match: null,
    listed: true,
  },
  range: {
    pilot: false,
    combat: false,
    roster: PRESET_BOTS,
    size: 12,
    match: null,
    listed: true,
  },
  trial: {
    pilot: true,
    combat: false,
    roster: PRESET_BOTS,
    size: 8,
    match: null,
    listed: false,
  },
} as const satisfies Record<string, GameMode>;

export type GameModeId = keyof typeof GAME_MODES;

/** Robots que le joueur peut piloter : tous (en avion, le pilote automatique l'aide). */
export const PILOTABLE: readonly BotProfile[] = PRESET_BOTS;

/** Mélange une liste (aléatoire de la simulation, donc reproductible). */
function shuffled<T>(list: readonly T[]): T[] {
  const pool = [...list];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand(0, i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

/** Les robots d'une vague : `size` robots tirés au hasard dans la liste, sans doublon. */
export function pickRoster(mode: GameMode): BotProfile[] {
  return shuffled(mode.roster).slice(0, mode.size);
}

/**
 * Les deux équipes d'une partie pilotée : le robot du joueur en tête de l'équipe bleue, puis ses
 * coéquipiers et leurs adversaires tirés au hasard dans la liste (des doublons sont possibles).
 * Les équipes sont de même force : les robots tirés sont répartis du plus cher au moins cher,
 * chacun dans l'équipe qui coûte le moins jusque-là (le robot du joueur compris). Un joueur qui
 * choisit un petit robot a donc des coéquipiers plus lourds.
 */
export function matchEntries(mode: GameMode, player: BotProfile): WaveEntry[] {
  const half = Math.floor(mode.size / 2);
  const pool = shuffled(mode.roster);
  const drawn = Array.from({ length: half * 2 - 1 }, (_, i) => pool[i % pool.length]);
  const cost = (p: BotProfile): number => designCost(p.design);
  const blue: BotProfile[] = [];
  const red: BotProfile[] = [];
  let blueCost = cost(player);
  let redCost = 0;
  for (const profile of drawn.sort((a, b) => cost(b) - cost(a))) {
    const toBlue = blue.length < half - 1 && (red.length >= half || blueCost <= redCost);
    if (toBlue) {
      blue.push(profile);
      blueCost += cost(profile);
    } else {
      red.push(profile);
      redCost += cost(profile);
    }
  }
  return [
    { profile: player, team: "blue" },
    ...blue.map((profile) => ({ profile, team: "blue" as const })),
    ...red.map((profile) => ({ profile, team: "red" as const })),
  ];
}

/** Coût total d'une équipe (voir `matchEntries`). */
export const teamCost = (entries: readonly WaveEntry[], team: WaveEntry["team"]): number =>
  entries.filter((e) => e.team === team).reduce((s, e) => s + designCost(e.profile.design), 0);
