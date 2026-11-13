import { writeFileSync } from "node:fs";
import { beforeAll, expect, it } from "vitest";
import { isArenaId, type ArenaKey } from "../src/shared/arena/layout";
import { checkMapText, registerMap } from "../src/shared/map";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { GAME_MODES, matchEntries } from "../src/shared/modes";
import type { Bot } from "../src/shared/sim/entities";
import { startMatch } from "../src/shared/sim/match";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnTeams } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";
import { botName } from "../src/client/i18n/names";
import { readFileSync } from "node:fs";
import type { BotProfile } from "../src/shared/design/presets";
import { simulationNamed } from "../src/shared/native/choice";
import { CODE } from "../src/shared/native/events";
import { loadSimModule } from "../src/shared/native/simModule";
import { NativeWorld } from "../src/shared/native/world";
import { MODES_BY_CODE } from "../src/shared/net/protocol";
import { simWasmPath } from "./probe";

/*
 * Batailles entre IA, sans affichage : le mode Bataille (six contre six, réapparitions) joué
 * jusqu'au bout. `npm test` en joue deux courtes pour vérifier qu'une vraie partie se déroule sans
 * erreur (c'est ainsi qu'ont été trouvés des accès à des corps déjà libérés) ; `npm run battle` en
 * joue davantage et affiche un bilan d'équilibrage : durée des parties, causes des destructions,
 * coût d'un pas, part du temps où les robots au sol sont coincés, et, par robot, destructions,
 * morts, durée de vie, temps passé renversé ou paralysé. L'arène se choisit par la variable
 * d'environnement BATTLE_ARENA (le Dépôt par défaut ; `BATTLE_ARENA=canyon npm run battle`).
 * BATTLE_RECORD=<fichier> garde aussi le bilan en JSON : les batailles de référence
 * (tests/reference/), auxquelles comparer une simulation déplacée ou réécrite (mêmes graines).
 * SIM=rust : les mêmes batailles sur la simulation portée en Rust (src/shared/native/world.ts, le
 * module de `npm run native` ou la sonde la plus récente) ; leur bilan doit être celui du TypeScript.
 */

interface RobotStats {
  kills: number;
  deaths: number;
  life: number;
  flipped: number;
  stunned: number;
  /** Causes de ses morts. */
  killedBy: Map<string, number>;
}

interface Report {
  matches: string[];
  /** Chaque partie : sa graine, son vainqueur, son score, sa durée (s). */
  results: { seed: number; winner: string | null; blue: number; red: number; elapsed: number }[];
  kills: number;
  causes: Map<string, number>;
  robots: Map<string, RobotStats>;
  /** Temps passé dans chaque mode d'IA, tous robots confondus (s). */
  modes: Map<string, number>;
  /** Temps des robots au sol (s), et celui où ils étaient coincés : en manœuvre de dégagement, ou bloqués (moteurs qui poussent, robot immobile). */
  ground: number;
  stuck: number;
  /** Temps de calcul de la simulation (ms) et nombre de pas. */
  cost: number;
  steps: number;
}

/** Les cartes communautaires du dépôt (maps/), par nom de fichier : `BATTLE_ARENA=val-du-lac npm run battle`. */
const BUNDLED_MAPS = import.meta.glob<string>("../maps/*.casse-map.json", { query: "?raw", import: "default", eager: true });

/** Arène des batailles : BATTLE_ARENA (une arène du jeu, ou une carte de maps/ par son nom de fichier), ou le Dépôt. */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
function battleArena(name: string | undefined): ArenaKey {
  if (isArenaId(name)) return name;
  const text = Object.entries(BUNDLED_MAPS).find(([path]) => name && path.endsWith(`/${name}.casse-map.json`))?.[1];
  const check = text ? checkMapText(text) : null;
  return check?.map && !check.issues.length ? registerMap(check.map).id : "depot";
}
const ARENA: ArenaKey = battleArena(env.BATTLE_ARENA);

/**
 * La simulation des batailles : celle du TypeScript, ou celle portée en Rust (SIM=rust). Le TypeScript
 * par défaut, quelle que soit celle du jeu (`DEFAULT_SIMULATION`) : il est la référence des batailles
 * de référence et des essais de parité ; `SIM=ts` le dit aussi.
 */
if (env.SIM && !simulationNamed(env.SIM)) throw new Error(`SIM : « ts » ou « rust », pas « ${env.SIM} »`);
const RUST = simulationNamed(env.SIM) === "rust";

/**
 * Les mêmes batailles sur la simulation portée en Rust : la même composition des équipes (tirée dans
 * son hasard, à la même graine), le même bilan, lu dans son journal d'événements et dans l'état de
 * ses robots (`roster`) aux mêmes pas.
 */
async function playBattlesRust(seeds: readonly number[], duration: number): Promise<Report> {
  const path = simWasmPath();
  if (!path) throw new Error("SIM=rust : pas de simulation compilée entière (npm run native)");
  const module = await loadSimModule(readFileSync(path));
  const report: Report = { matches: [], results: [], kills: 0, causes: new Map(), robots: new Map(), modes: new Map(), ground: 0, stuck: 0, cost: 0, steps: 0 };
  const stats = (profile: BotProfile): RobotStats => {
    const name = botName(profile);
    let s = report.robots.get(name);
    if (!s) report.robots.set(name, (s = { kills: 0, deaths: 0, life: 0, flipped: 0, stunned: 0, killedBy: new Map() }));
    return s;
  };
  for (const seed of seeds) {
    const world = new NativeWorld(module, seed);
    if (ARENA !== "depot") world.loadArena(ARENA);
    const mode = GAME_MODES.battle;
    const profiles = new Map<number, BotProfile>();
    const born = new Map<number, number>();
    world.on((e) => {
      if (e.code === CODE.botAdded) {
        profiles.set(e.bot!, world.profiles[e.profile!]);
        born.set(e.bot!, e.time!);
      }
      if (e.code !== CODE.botKilled) return;
      report.kills++;
      const cause = e.cause ?? "?";
      report.causes.set(cause, (report.causes.get(cause) ?? 0) + 1);
      const victim = stats(profiles.get(e.bot!)!);
      victim.deaths++;
      victim.killedBy.set(cause, (victim.killedBy.get(cause) ?? 0) + 1);
      victim.life += e.time! - (born.get(e.bot!) ?? 0);
      if (e.killer !== null && e.killer !== undefined) stats(profiles.get(e.killer)!).kills++;
    });
    const entries = world.draw(() => matchEntries(mode, PRESET_BOTS[seed % PRESET_BOTS.length]), seed);
    world.spawnTeams(entries);
    world.startMatch({ ...mode.match, timeLimit: duration });
    const every = 30;
    let state = world.matchState();
    for (let i = 0; i < duration * 60 && !state.winner; i++) {
      const t0 = performance.now();
      world.step();
      report.cost += performance.now() - t0;
      report.steps++;
      state = world.matchState();
      if (i % every) continue;
      for (const b of world.roster()) {
        if (!b.alive) continue;
        const m = MODES_BY_CODE[b.mode];
        report.modes.set(m, (report.modes.get(m) ?? 0) + every / 60);
        if (b.mobility === 0 && m !== "dead") {
          report.ground += every / 60;
          if (m === "reverse" || b.blockedT > 1) report.stuck += every / 60;
        }
        if (m === "flipped") stats(b.profile).flipped += every / 60;
        if (m === "stunned") stats(b.profile).stunned += every / 60;
      }
    }
    report.matches.push(`graine ${seed} : ${state.winner ?? "en cours"}, ${state.score.blue} à ${state.score.red} en ${state.elapsed.toFixed(0)} s`);
    report.results.push({ seed, winner: state.winner ?? null, blue: state.score.blue, red: state.score.red, elapsed: Math.round(state.elapsed) });
    world.dispose();
  }
  return report;
}

function playBattles(seeds: readonly number[], duration: number): Report {
  const report: Report = { matches: [], results: [], kills: 0, causes: new Map(), robots: new Map(), modes: new Map(), ground: 0, stuck: 0, cost: 0, steps: 0 };
  const stats = (bot: Bot): RobotStats => {
    const name = botName(bot.profile);
    let s = report.robots.get(name);
    if (!s) report.robots.set(name, (s = { kills: 0, deaths: 0, life: 0, flipped: 0, stunned: 0, killedBy: new Map() }));
    return s;
  };
  for (const seed of seeds) {
    seedRandom(seed);
    const sim = new Simulation();
    if (ARENA !== "depot") sim.loadArena(ARENA);
    const mode = GAME_MODES.battle;
    spawnTeams(sim, matchEntries(mode, PRESET_BOTS[seed % PRESET_BOTS.length]));
    const match = startMatch(sim, { ...mode.match, timeLimit: duration });
    const born = new Map<Bot, number>(sim.bots.map((b) => [b, 0]));
    sim.on((e) => {
      if (e.type === "botAdded") born.set(e.bot, sim.time);
      if (e.type !== "botKilled") return;
      report.kills++;
      const cause = e.cause ?? "?";
      report.causes.set(cause, (report.causes.get(cause) ?? 0) + 1);
      const victim = stats(e.bot);
      victim.deaths++;
      victim.killedBy.set(cause, (victim.killedBy.get(cause) ?? 0) + 1);
      victim.life += sim.time - (born.get(e.bot) ?? 0);
      if (e.killer) stats(e.killer).kills++;
    });
    const every = 30;
    for (let i = 0; i < duration * 60 && !match.winner; i++) {
      const t0 = performance.now();
      sim.step();
      report.cost += performance.now() - t0;
      report.steps++;
      if (i % every) continue;
      for (const b of sim.bots) {
        if (!b.cockpit.alive) continue;
        report.modes.set(b.ai.mode, (report.modes.get(b.ai.mode) ?? 0) + every / 60);
        if (b.profile.mobility === "ground" && b.ai.mode !== "dead") {
          report.ground += every / 60;
          if (b.ai.mode === "reverse" || b.ai.blockedT > 1) report.stuck += every / 60;
        }
        if (b.ai.mode === "flipped") stats(b).flipped += every / 60;
        if (b.ai.mode === "stunned") stats(b).stunned += every / 60;
      }
    }
    report.matches.push(`graine ${seed} : ${match.winner ?? "en cours"}, ${match.score.blue} à ${match.score.red} en ${match.elapsed.toFixed(0)} s`);
    report.results.push({ seed, winner: match.winner ?? null, blue: match.score.blue, red: match.score.red, elapsed: Math.round(match.elapsed) });
    sim.dispose();
  }
  return report;
}

/** Le bilan en JSON (BATTLE_RECORD) : les batailles de référence. Le coût d'un pas dépend de la machine. */
function recordReport(report: Report, file: string, duration: number): void {
  const round = (x: number, d = 1): number => Math.round(x * 10 ** d) / 10 ** d;
  const robots = Object.fromEntries([...report.robots].sort((a, b) => a[0].localeCompare(b[0])).map(([name, s]) => [name, {
    kills: s.kills, deaths: s.deaths, life: s.deaths ? round(s.life / s.deaths) : null, flipped: round(s.flipped), stunned: round(s.stunned),
    killedBy: Object.fromEntries([...s.killedBy].sort()),
  }]));
  const json = {
    arena: ARENA, duration, date: new Date().toISOString().slice(0, 10),
    matches: report.results,
    kills: report.kills,
    causes: Object.fromEntries([...report.causes].sort()),
    stuckShare: round((100 * report.stuck) / Math.max(1, report.ground)),
    modes: Object.fromEntries([...report.modes].sort().map(([m, t]) => [m, Math.round(t)])),
    stepMs: round(report.cost / Math.max(1, report.steps), 2),
    robots,
  };
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`Bilan gardé dans ${file}`);
}

function printReport(report: Report): void {
  const lines = [`Arène : ${ARENA}`, ...report.matches, ""];
  lines.push(`Pas de simulation : ${(report.cost / Math.max(1, report.steps)).toFixed(2)} ms en moyenne · robots au sol coincés ${((100 * report.stuck) / Math.max(1, report.ground)).toFixed(1)} % du temps`);
  lines.push("Causes : " + [...report.causes].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(", "));
  lines.push("Modes (s) : " + [...report.modes].sort((a, b) => b[1] - a[1]).map(([m, t]) => `${m} ${t.toFixed(0)}`).join(", "), "");
  const rows = [...report.robots].sort((a, b) => b[1].kills - b[1].deaths - (a[1].kills - a[1].deaths));
  for (const [name, s] of rows) {
    const life = s.deaths ? `${(s.life / s.deaths).toFixed(0)} s` : "-";
    lines.push(
      `${name.padEnd(14)} destructions ${String(s.kills).padStart(3)} · morts ${String(s.deaths).padStart(3)}`
      + ` · vie moyenne ${life.padStart(5)} · renversé ${s.flipped.toFixed(0).padStart(3)} s · paralysé ${s.stunned.toFixed(0).padStart(3)} s`
      + ` · tué par ${[...s.killedBy].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(", ")}`,
    );
  }
  console.log(lines.join("\n"));
}

beforeAll(async () => {
  await initPhysics();
});

/** `npm run battle` : l'environnement de npm nomme le script lancé. */
const fullReport = env.npm_lifecycle_event === "battle";

it("des batailles entre IA se jouent sans erreur, et des robots y sont détruits", { timeout: 120_000 }, async () => {
  const report = RUST ? await playBattlesRust([1, 2], 40) : playBattles([1, 2], 40);
  expect(report.kills).toBeGreaterThan(2);
  expect(report.causes.get("self") ?? 0).toBeLessThan(report.kills / 2);
});

it.runIf(fullReport)("bilan d'équilibrage sur huit batailles", { timeout: 1_800_000 }, async () => {
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
  const report = RUST ? await playBattlesRust(seeds, 240) : playBattles(seeds, 240);
  printReport(report);
  if (env.BATTLE_RECORD) recordReport(report, env.BATTLE_RECORD, 240);
});
