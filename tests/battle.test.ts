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

/*
 * Batailles entre IA, sans affichage : le mode Bataille (six contre six, réapparitions) joué
 * jusqu'au bout. `npm test` en joue deux courtes pour vérifier qu'une vraie partie se déroule sans
 * erreur (c'est ainsi qu'ont été trouvés des accès à des corps déjà libérés) ; `npm run battle` en
 * joue davantage et affiche un bilan d'équilibrage : durée des parties, causes des destructions,
 * coût d'un pas, part du temps où les robots au sol sont coincés, et, par robot, destructions,
 * morts, durée de vie, temps passé renversé ou paralysé. L'arène se choisit par la variable
 * d'environnement BATTLE_ARENA (le Dépôt par défaut ; `BATTLE_ARENA=canyon npm run battle`).
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

function playBattles(seeds: readonly number[], duration: number): Report {
  const report: Report = { matches: [], kills: 0, causes: new Map(), robots: new Map(), modes: new Map(), ground: 0, stuck: 0, cost: 0, steps: 0 };
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
    sim.dispose();
  }
  return report;
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

it("des batailles entre IA se jouent sans erreur, et des robots y sont détruits", { timeout: 120_000 }, () => {
  const report = playBattles([1, 2], 40);
  expect(report.kills).toBeGreaterThan(2);
  expect(report.causes.get("self") ?? 0).toBeLessThan(report.kills / 2);
});

it.runIf(fullReport)("bilan d'équilibrage sur huit batailles", { timeout: 1_800_000 }, () => {
  printReport(playBattles([1, 2, 3, 4, 5, 6, 7, 8], 240));
});
