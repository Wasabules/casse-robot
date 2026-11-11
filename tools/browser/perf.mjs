// npm run perf : la mesure du rendu. Le jeu construit, dans Chrome sans fenêtre sur la carte
// graphique de la machine, sans limite d'images par seconde ; la bataille de référence (les douze
// robots de BATTLE_ROSTER, ceux de `npm run bench`, sans joueur, la caméra derrière le premier) ;
// le temps de chaque image, détaillé par étape (ArenaGame.frameProfile, sim.profile). Une image à
// 120 Hz doit tenir en 8,3 ms.
//
//   npm run perf                                  le Dépôt, 1920 × 1080, préréglage Moyenne, 30 s
//   npm run perf -- --arena=cityNight --preset=high --size=2560x1440 --seconds=60
//   npm run perf -- --render-only                 la simulation figée : le rendu seul
//   npm run perf -- --json=avant.json             garde le résultat…
//   npm run perf -- --compare=avant.json          … et compare un nouveau résultat à lui
//   npm run perf -- --no-build                    sans reconstruire la page
//
// La machine doit être au repos : un autre calcul fausse tout (la mesure se fait par fenêtres de
// quelques secondes, et en donne l'écart). La carte graphique utilisée est donnée en tête du bilan.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { build, launchChrome, MATCH_STARTED, openGame, parseArgs, ROOT, SEED_RANDOM, serve, sleep } from "./chrome.mjs";

const options = parseArgs({ arena: "depot", size: "1920x1080", seconds: 30, window: 5, warmup: 8, preset: "medium", renderOnly: false, noBuild: false, json: "", compare: "", software: false });
const [width, height] = options.size.split("x").map(Number);

/** Ce qu'on relève dans la page : intervalles entre images, appels de dessin, temps de la carte graphique. */
const INSTRUMENT = `(() => {
  const g = window.__casse.game, engine = g.engine, gl = engine._gl;
  const M = (window.__perf = { intervals: [], draws: [], gpu: [], drawCount: 0, queries: [] });
  let last = 0;
  const tick = (t) => { if (last) M.intervals.push(t - last); last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const P = WebGL2RenderingContext.prototype;
  for (const n of ["drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced"]) {
    const f = P[n];
    P[n] = function (...a) { M.drawCount++; return f.apply(this, a); };
  }
  // Temps de la carte graphique (s'il y a le minuteur) : de son point de vue, du début à la fin de l'image
  const tq = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  let query = null;
  engine.onBeginFrameObservable.add(() => {
    M.drawCount = 0;
    if (tq && !query) { query = gl.createQuery(); gl.beginQuery(tq.TIME_ELAPSED_EXT, query); }
  });
  engine.onEndFrameObservable.add(() => {
    M.draws.push(M.drawCount);
    if (query) { gl.endQuery(tq.TIME_ELAPSED_EXT); M.queries.push(query); query = null; }
    for (let i = M.queries.length - 1; i >= 0; i--) {
      const q = M.queries[i];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) continue;
      if (!gl.getParameter(tq.GPU_DISJOINT_EXT)) M.gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(q);
      M.queries.splice(i, 1);
    }
  });
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  return { gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), timer: !!tq, render: [engine.getRenderWidth(), engine.getRenderHeight()] };
})()`;

/** Remet les relevés à zéro (début d'une fenêtre). */
const RESET = `(() => {
  const g = window.__casse.game, M = window.__perf;
  M.intervals.length = 0; M.draws.length = 0; M.gpu.length = 0;
  g.frameProfile = { times: {}, frames: 0, totals: [] };
  g.sim.profile = { now: () => performance.now(), times: {} };
  M.simStart = g.sim.time;
  M.start = performance.now();
  return 1;
})()`;

/** Les relevés d'une fenêtre. */
const COLLECT = `(() => {
  const g = window.__casse.game, M = window.__perf, f = g.frameProfile;
  return {
    seconds: (performance.now() - M.start) / 1000,
    intervals: [...M.intervals], draws: [...M.draws], gpu: [...M.gpu],
    frames: f.frames, totals: [...f.totals], times: { ...f.times },
    simTimes: { ...(g.sim.profile?.times ?? {}) }, steps: Math.round((g.sim.time - M.simStart) * 60),
    bots: g.world.bots.filter((b) => b.cockpit.alive).length, particles: g.fx.particleCount,
    meshes: g.scene.getActiveMeshes().length, heap: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null,
  };
})()`;

const sum = (a) => a.reduce((x, y) => x + y, 0);
const mean = (a) => (a.length ? sum(a) / a.length : 0);
const quantile = (a, q) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const fmt = (x, d = 1) => (x === null || x === undefined || Number.isNaN(x) ? "-" : x.toFixed(d));

/** Le bilan de plusieurs fenêtres. */
function summarize(windows) {
  const intervals = windows.flatMap((w) => w.intervals);
  const totals = windows.flatMap((w) => w.totals);
  const frames = sum(windows.map((w) => w.frames));
  const steps = sum(windows.map((w) => w.steps));
  const stages = {};
  for (const w of windows) for (const [k, t] of Object.entries(w.times)) stages[k] = (stages[k] ?? 0) + t;
  for (const k of Object.keys(stages)) stages[k] /= Math.max(1, frames);
  const sim = {};
  for (const w of windows) for (const [k, t] of Object.entries(w.simTimes)) sim[k] = (sim[k] ?? 0) + t;
  for (const k of Object.keys(sim)) sim[k] /= Math.max(1, steps);
  const simStep = Object.entries(sim).filter(([k]) => !k.includes("›")).reduce((s, [, t]) => s + t, 0);
  const gpu = windows.flatMap((w) => w.gpu);
  const last = windows.at(-1);
  return {
    fps: intervals.length / (sum(intervals) / 1000),
    fpsByWindow: windows.map((w) => w.intervals.length / (sum(w.intervals) / 1000)),
    interval: { p50: quantile(intervals, 0.5), p95: quantile(intervals, 0.95), p99: quantile(intervals, 0.99), max: quantile(intervals, 1) },
    over: { "120 Hz": (100 * intervals.filter((x) => x > 1000 / 120).length) / intervals.length, "60 Hz": (100 * intervals.filter((x) => x > 1000 / 60).length) / intervals.length },
    cpu: { mean: mean(totals), p95: quantile(totals, 0.95) },
    stages,
    simStep,
    sim,
    gpu: gpu.length ? { mean: mean(gpu), p95: quantile(gpu, 0.95) } : null,
    draws: mean(windows.flatMap((w) => w.draws)),
    bots: last.bots, particles: last.particles, meshes: last.meshes, heap: last.heap,
  };
}

function print(result) {
  const r = result.summary;
  const lines = [
    "",
    `Mesure du rendu · ${result.arena} · ${result.size} · préréglage ${result.preset}${result.renderOnly ? " · simulation figée" : ""} · ${result.commit}`,
    `${result.gpu} · ${result.browser}`,
    "",
    `Images par seconde : ${fmt(r.fps)} (par fenêtre : ${r.fpsByWindow.map((x) => fmt(x, 0)).join(", ")})`,
    `Intervalle entre images (ms) : médiane ${fmt(r.interval.p50)}, 95 % ${fmt(r.interval.p95)}, 99 % ${fmt(r.interval.p99)}, pire ${fmt(r.interval.max)}`,
    `Images trop longues : ${fmt(r.over["120 Hz"], 0)} % pour 120 Hz (8,3 ms), ${fmt(r.over["60 Hz"], 0)} % pour 60 Hz (16,7 ms)`,
    `Processeur par image (code du jeu et préparation de l'image) : ${fmt(r.cpu.mean, 2)} ms en moyenne, ${fmt(r.cpu.p95, 2)} ms à 95 %`,
    `Carte graphique par image : ${r.gpu ? `${fmt(r.gpu.mean, 2)} ms en moyenne, ${fmt(r.gpu.p95, 2)} ms à 95 % (attentes comprises)` : "pas de minuteur"}`,
    `Appels de dessin : ${fmt(r.draws, 0)} par image · objets dessinés ${r.meshes} · particules ${r.particles} · robots ${r.bots} · tas JS ${fmt(r.heap, 0)} Mo`,
    "",
    "Par image (ms) :",
    ...Object.entries(r.stages).sort((a, b) => b[1] - a[1]).map(([k, t]) => `  ${k.padEnd(14)} ${fmt(t, 2).padStart(6)}`),
    `Pas de simulation : ${fmt(r.simStep, 2)} ms`,
    ...Object.entries(r.sim).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, t]) => `  ${k.padEnd(22)} ${fmt(t, 3).padStart(7)}`),
  ];
  console.log(lines.join("\n"));
}

function compare(before, after) {
  const a = before.summary, b = after.summary;
  const row = (label, x, y, lowerIsBetter = true, d = 2) => {
    const change = x ? ((y - x) / x) * 100 : 0;
    const better = lowerIsBetter ? change < -3 : change > 3;
    const worse = lowerIsBetter ? change > 3 : change < -3;
    return `  ${label.padEnd(26)} ${fmt(x, d).padStart(8)} → ${fmt(y, d).padStart(8)}  ${change >= 0 ? "+" : ""}${fmt(change, 0)} %${better ? "  mieux" : worse ? "  moins bien" : ""}`;
  };
  const lines = ["", `Comparaison avec ${options.compare} (${before.commit}, ${before.date.slice(0, 10)}) :`];
  lines.push(row("images par seconde", a.fps, b.fps, false, 1));
  lines.push(row("intervalle à 95 % (ms)", a.interval.p95, b.interval.p95));
  lines.push(row("processeur par image (ms)", a.cpu.mean, b.cpu.mean));
  if (a.gpu && b.gpu) lines.push(row("carte graphique (ms)", a.gpu.mean, b.gpu.mean));
  lines.push(row("pas de simulation (ms)", a.simStep, b.simStep));
  lines.push(row("appels de dessin", a.draws, b.draws, true, 0));
  for (const k of new Set([...Object.keys(a.stages), ...Object.keys(b.stages)])) lines.push(row(`  ${k}`, a.stages[k] ?? 0, b.stages[k] ?? 0));
  if (a.gpuName !== b.gpuName || a.size !== b.size) lines.push("  (attention : carte graphique ou taille d'image différentes)");
  console.log(lines.join("\n"));
}

if (!options.noBuild) build();
const server = await serve();
const chrome = await launchChrome({ width, height, software: options.software });
const { page } = chrome;
try {
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: SEED_RANDOM });
  console.log(`» ${chrome.version} : démarrage du jeu`);
  await openGame(page, server.url);
  await page.evaluate(`window.__casse.graphics(${JSON.stringify(options.preset)})`);
  await page.evaluate(`window.__casse.screens.benchmark(${JSON.stringify(options.arena)})`);
  await page.waitFor(MATCH_STARTED, 120_000, "début de la bataille");
  await page.evaluate(`(() => { const g = window.__casse.game; g.setFollow(0); g.rig.setZoom(16); return 1; })()`);
  const info = await page.evaluate(INSTRUMENT);
  console.log(`» Bataille en cours (${info.render.join(" × ")}) ; ${options.warmup} s pour s'engager`);
  await sleep(options.warmup * 1000);
  if (options.renderOnly) await page.evaluate(`window.__casse.game.hold()`);
  const windows = [];
  for (let i = 0; i < Math.max(1, Math.round(options.seconds / options.window)); i++) {
    await page.evaluate(RESET);
    await sleep(options.window * 1000);
    windows.push(await page.evaluate(COLLECT));
    process.stdout.write(`  fenêtre ${i + 1} : ${fmt(windows.at(-1).intervals.length / (sum(windows.at(-1).intervals) / 1000))} img/s\n`);
  }
  const errors = page.errors;
  const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
  const result = {
    date: new Date().toISOString(), commit, browser: chrome.version, gpu: info.gpu, gpuName: info.gpu,
    arena: options.arena, size: options.size, preset: options.preset, renderOnly: options.renderOnly,
    summary: summarize(windows), windows: windows.length,
  };
  result.summary.size = options.size;
  result.summary.gpuName = info.gpu;
  print(result);
  if (options.compare) compare(JSON.parse(readFileSync(options.compare, "utf8")), result);
  if (options.json) {
    writeFileSync(options.json, JSON.stringify(result, null, 2) + "\n");
    console.log(`\nRésultat gardé dans ${options.json}`);
  }
  if (errors.length) console.log(`\nErreurs dans la page :\n${errors.slice(0, 10).join("\n")}`);
} finally {
  await chrome.close();
  await server.close();
}
