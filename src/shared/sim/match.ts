import type { CaptureZone } from "../arena/layout";
import { DamageBatch, inflict } from "../combat/damage";
import { STEP } from "../config";
import { clamp, rand } from "../math/scalar";
import { vec3 } from "../math/vec";
import { removeBot } from "../robot/lifecycle";
import type { AiMode, Bot, Team } from "./entities";
import type { Simulation } from "./simulation";
import { respawnBot } from "./wave";

/*
 * Règles d'une partie entre deux équipes. Chaque robot détruit (son cockpit) rapporte un point à
 * l'équipe adverse ; il réapparaît de son côté de l'arène après un délai, ou jamais (élimination).
 * En capture de zones, les points viennent des zones tenues, pas des destructions.
 * La partie s'arrête au score visé, à la fin du temps, ou quand une équipe n'a plus personne.
 * Un robot de l'IA renversé ou immobilisé trop longtemps se saborde (le point va à l'adversaire).
 */

/** Capture de zones : les zones de l'arène se prennent en y restant seul, et rapportent des points. */
export interface CaptureRules {
  /** Temps pour prendre une zone neutre, seul (s) ; à n robots, √n fois plus vite. */
  readonly time: number;
  /** Points par seconde et par zone tenue. */
  readonly rate: number;
  /**
   * Roi de la colline : une seule zone est en jeu à la fois (la colline), celle du centre d'abord ;
   * toutes les `hill` s, elle passe à une autre zone, et l'ancienne revient au neutre.
   */
  readonly hill?: number;
}

export interface MatchRules {
  /** Points pour gagner ; 0 : pas de limite. */
  readonly scoreToWin: number;
  /** Durée de la partie (s) ; 0 : pas de limite. */
  readonly timeLimit: number;
  /** Délai de réapparition (s) ; null : pas de réapparition (élimination). */
  readonly respawn: number | null;
  /** Capture de zones ; absent, le score compte les destructions. */
  readonly capture?: CaptureRules;
}

/** État d'une zone à capturer. */
export interface ZoneState {
  readonly zone: CaptureZone;
  /** Équipe qui la tient, ou null. */
  owner: Team | null;
  /** Avancement de la prise, de -1 (aux rouges) à 1 (aux bleus) ; 0 : neutre. */
  progress: number;
  /** Des robots des deux équipes s'y trouvent : rien ne bouge. */
  contested: boolean;
  /** En jeu : elle se prend et rapporte des points (au roi de la colline, seule la colline l'est). */
  active: boolean;
}

export interface Match {
  readonly rules: MatchRules;
  /** Score ; en capture de zones, il gagne des fractions de point à chaque pas (on l'affiche arrondi). */
  readonly score: Record<Team, number>;
  /** Temps écoulé depuis le début (s). */
  elapsed: number;
  /** Gagnant, une fois la partie finie. */
  winner: Team | "draw" | null;
  /** Robots détruits qui attendent de réapparaître, et quand. */
  readonly respawns: { bot: Bot; at: number }[];
  /** Temps passé renversé ou immobilisé, par robot de l'IA. */
  readonly stuck: Map<Bot, number>;
  /** Zones à capturer (vide hors capture de zones), dans l'ordre de l'arène. */
  readonly zones: ZoneState[];
  /** Roi de la colline : quand la colline se déplace (s, temps de la partie). */
  nextHill: number;
  readonly unsubscribe: () => void;
}

/** Au-delà de ce temps renversé ou immobilisé (s), un robot de l'IA se saborde. */
const STUCK_LIMIT = 12;
const HELPLESS: ReadonlySet<AiMode> = new Set(["flipped", "stranded", "falling"]);
/** Un robot compte dans une zone jusqu'à cette hauteur au-dessus d'elle (m) : les robots à rotors aussi. */
const ZONE_HEIGHT = 8;
/** Une zone que personne n'occupe revient vers son état (tenue ou neutre) à cette part de la vitesse de prise. */
const ZONE_RECOVERY = 0.5;

export const otherTeam = (team: Team): Team => (team === "red" ? "blue" : "red");
const teamSign = (team: Team): number => (team === "blue" ? 1 : -1);

/**
 * Zones d'une partie, toutes neutres, pour les règles `rules` et les zones de l'arène ; au roi de la
 * colline, seule celle du milieu de la liste (le centre de l'arène) est d'abord en jeu.
 */
export function newZones(rules: MatchRules, zones: readonly CaptureZone[]): ZoneState[] {
  if (!rules.capture) return [];
  const first = Math.floor(zones.length / 2);
  return zones.map((zone, i) => ({ zone, owner: null, progress: 0, contested: false, active: !rules.capture?.hill || i === first }));
}

/** La colline passe à une autre zone, tirée au hasard ; l'ancienne revient au neutre. */
function moveHill(match: Match): void {
  const current = match.zones.findIndex((z) => z.active);
  const others = match.zones.map((_, i) => i).filter((i) => i !== current);
  if (!others.length) return;
  const next = others[Math.floor(rand(0, others.length))];
  const old = match.zones[current];
  if (old) Object.assign(old, { active: false, owner: null, progress: 0, contested: false });
  match.zones[next].active = true;
}

/** Commence une partie sur les robots déjà en place. */
export function startMatch(sim: Simulation, rules: MatchRules): Match {
  sim.match?.unsubscribe();
  const match: Match = {
    rules,
    score: { red: 0, blue: 0 },
    elapsed: 0,
    winner: null,
    respawns: [],
    stuck: new Map(),
    zones: newZones(rules, sim.arena.zones),
    nextHill: rules.capture?.hill ?? Infinity,
    unsubscribe: sim.on((e) => {
      if (e.type !== "botKilled" || match.winner || !sim.bots.includes(e.bot)) return;
      if (!rules.capture) match.score[otherTeam(e.bot.team)]++;
      if (rules.respawn !== null) match.respawns.push({ bot: e.bot, at: sim.time + rules.respawn });
    }),
  };
  sim.match = match;
  return match;
}

export function endMatch(sim: Simulation): void {
  sim.match?.unsubscribe();
  sim.match = null;
}

/** Un pas de la partie : réapparitions, sabordages, zones, fin de partie. */
export function updateMatch(sim: Simulation): void {
  const match = sim.match;
  if (!match || match.winner) return;
  match.elapsed += STEP;

  for (const r of [...match.respawns]) {
    if (sim.time < r.at) continue;
    match.respawns.splice(match.respawns.indexOf(r), 1);
    const i = sim.bots.indexOf(r.bot);
    if (i < 0) continue;
    removeBot(sim, r.bot);
    const fresh = respawnBot(sim, r.bot.profile, r.bot.team);
    fresh.controller = r.bot.controller;
    fresh.input = r.bot.input;
    sim.bots[i] = fresh;
    if (sim.player === r.bot) sim.player = fresh;
  }

  for (const bot of sim.bots) {
    if (!bot.cockpit.alive || bot.controller !== "ai" || !HELPLESS.has(bot.ai.mode)) {
      match.stuck.delete(bot);
      continue;
    }
    const t = (match.stuck.get(bot) ?? 0) + STEP;
    match.stuck.set(bot, t);
    if (t > STUCK_LIMIT) selfDestruct(sim, bot);
  }

  const capture = match.rules.capture;
  if (capture?.hill && match.elapsed >= match.nextHill) {
    moveHill(match);
    match.nextHill += capture.hill;
  }
  if (capture) updateZones(sim, match, capture);

  const winner = decide(sim, match);
  if (winner) {
    match.winner = winner;
    sim.emit({ type: "matchOver", winner });
  }
}

/** Robots de chaque équipe dans une zone (cockpit intact ; pas les avions, qui ne font que passer). */
export function zoneOccupants(sim: Simulation, zone: CaptureZone): Record<Team, number> {
  const count = { red: 0, blue: 0 };
  for (const bot of sim.bots) {
    if (!bot.cockpit.alive || bot.profile.mobility === "plane") continue;
    const p = bot.cockpit.part.rb.translation();
    const dy = p.y - zone.pos.y;
    if (dy > -1 && dy < ZONE_HEIGHT && Math.hypot(p.x - zone.pos.x, p.z - zone.pos.z) <= zone.radius) count[bot.team]++;
  }
  return count;
}

/**
 * Zones : une équipe seule dans une zone la fait basculer vers elle (d'abord la neutraliser si
 * elle est à l'adversaire, puis la prendre) ; à plusieurs, plus vite ; les deux équipes, rien ne
 * bouge. Chaque zone tenue rapporte `rate` points par seconde.
 */
function updateZones(sim: Simulation, match: Match, rules: CaptureRules): void {
  match.zones.forEach((z, i) => {
    if (!z.active) return;
    const count = zoneOccupants(sim, z.zone);
    z.contested = count.blue > 0 && count.red > 0;
    if (!z.contested && (count.blue || count.red)) {
      const team: Team = count.blue ? "blue" : "red";
      const sign = teamSign(team);
      z.progress = clamp(z.progress + (sign * Math.sqrt(count[team]) * STEP) / rules.time, -1, 1);
      if (z.owner && z.owner !== team && sign * z.progress >= 0) {
        z.owner = null;
        sim.emit({ type: "zoneChanged", zone: i, owner: null, by: team });
      }
      if (!z.owner && sign * z.progress >= 1) {
        z.owner = team;
        sim.emit({ type: "zoneChanged", zone: i, owner: team, by: team });
      }
    } else if (!z.contested) {
      // Personne : la zone revient vers son état
      const rest = z.owner ? teamSign(z.owner) : 0;
      const step = (ZONE_RECOVERY * STEP) / rules.time;
      z.progress = z.progress < rest ? Math.min(rest, z.progress + step) : Math.max(rest, z.progress - step);
    }
    if (z.owner) match.score[z.owner] += rules.rate * STEP;
  });
}

/** Le robot se saborde : son cockpit est détruit (la destruction revient à son dernier attaquant). */
export function selfDestruct(sim: Simulation, bot: Bot): void {
  if (!bot.cockpit.alive) return;
  const batch = new DamageBatch();
  batch.cause = "self";
  batch.add({ kind: "block", block: bot.cockpit }, Infinity, "kinetic");
  inflict(sim, batch, vec3(0, 1, 0), null);
}

function decide(sim: Simulation, match: Match): Team | "draw" | null {
  const { rules, score } = match;
  if (rules.scoreToWin > 0) {
    if (score.blue >= rules.scoreToWin) return "blue";
    if (score.red >= rules.scoreToWin) return "red";
  }
  if (rules.respawn === null) {
    const standing = (team: Team): boolean => sim.bots.some((b) => b.team === team && b.cockpit.alive);
    const blue = standing("blue");
    const red = standing("red");
    if (!blue || !red) return blue ? "blue" : red ? "red" : "draw";
  }
  if (rules.timeLimit > 0 && match.elapsed >= rules.timeLimit) {
    const blue = Math.floor(score.blue);
    const red = Math.floor(score.red);
    return blue > red ? "blue" : red > blue ? "red" : "draw";
  }
  return null;
}
