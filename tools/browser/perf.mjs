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
//   npm run perf -- --dist=../avant               un autre dossier construit (une copie de dist/), sans construire : alterner deux versions
//   npm run perf -- --renderer=webgpu             sous WebGPU (WebGL par défaut)
//   npm run perf -- --eval="__casse.game.setGlow(false)"   du code dans la page, une fois la bataille lancée
//   npm run perf -- --cpuprofile=profil.cpuprofile   le profil du processeur (fil de la page), ses fonctions les plus coûteuses
//   npm run perf -- --query="sim=ts"              la simulation du TypeScript dans le Worker (« sim=rust » : celle portée en Rust)
//   npm run perf -- --phone --cpu-throttle=4      proche d'un téléphone : écran 412 × 915 au doigt, processeur 4 fois plus lent
//   npm run perf -- --phone --cpu-throttle=6 --network=4g   … 6 fois plus lent, et un réseau mobile
//
// `--phone` : l'écran (412 × 915, 2,625 pixels par pixel CSS), le doigt, l'agent d'un téléphone
// Android ; le préréglage graphique Bas, celui d'un premier lancement sur un téléphone. `--cpu-throttle`
// ralentit le processeur de la page (Emulation.setCPUThrottlingRate ; Chrome ne le fait pas pour ses
// Workers : le pas de la simulation du Worker, mesuré à pleine vitesse, est aussi donné rapporté à ce
// ralentissement) ; `--network` (4g, 3g) le réseau. Le bilan dit aussi ce qu'ont coûté le démarrage du
// Worker (le morceau de sa session, le module Rust téléchargé et instancié), ce qui a été téléchargé, et
// la mémoire de la page et du Worker (tas JavaScript, tampons ; la mémoire du module Rust ; celle du
// processus de rendu, WebAssembly compris).
//
// La machine doit être au repos : un autre calcul fausse tout (la mesure se fait par fenêtres de
// quelques secondes, et en donne l'écart). La carte graphique utilisée est donnée en tête du bilan.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { build, launchChrome, MATCH_STARTED, openGame, parseArgs, ROOT, SEED_RANDOM, serve, sleep } from "./chrome.mjs";

const options = parseArgs({
  arena: "depot", size: "", seconds: 30, window: 5, warmup: 8, preset: "", renderOnly: false, noBuild: false, json: "", compare: "", software: false,
  renderer: "webgl", query: "", eval: "", cpuprofile: "", phone: false, cpuThrottle: 1, network: "", dist: "",
});
if (options.renderer !== "webgl" && options.renderer !== "webgpu") throw new Error(`--renderer : webgl ou webgpu, pas ${options.renderer}`);
/** Un réseau mobile (latence en ms, débits en octets par seconde). */
const NETWORKS = { "4g": { latency: 60, download: 9e6 / 8, upload: 1.5e6 / 8 }, "3g": { latency: 150, download: 1.6e6 / 8, upload: 0.75e6 / 8 } };
const network = options.network ? NETWORKS[options.network] : null;
if (options.network && !network) throw new Error(`--network : ${Object.keys(NETWORKS).join(" ou ")}, pas ${options.network}`);
/** Un téléphone : son écran en pixels CSS, sa densité, son agent. */
const PHONE = { size: "412x915", scale: 2.625, agent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36" };
// (sans --size ni --preset : 1920 × 1080 au préréglage Moyenne ; au téléphone, son écran au préréglage Bas)
options.size ||= options.phone ? PHONE.size : "1920x1080";
options.preset ||= options.phone ? "low" : "medium";
const [width, height] = options.size.split("x").map(Number);

/**
 * Ce qu'on relève dans la page : intervalles entre images, appels de dessin, temps de la carte
 * graphique. En WebGL, les appels de `WebGL2RenderingContext` et son minuteur ; en WebGPU, ceux des
 * passes de rendu et le minuteur de Babylon (`timestamp-query`, render/engine.ts).
 */
const INSTRUMENT = `(async () => {
  const g = window.__casse.game, engine = g.engine;
  const M = (window.__perf = { intervals: [], draws: [], gpu: [], drawCount: 0, queries: [] });
  let last = 0;
  const tick = (t) => { if (last) M.intervals.push(t - last); last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const count = (P, names) => {
    for (const n of names) {
      const f = P[n];
      if (f) P[n] = function (...a) { M.drawCount++; return f.apply(this, a); };
    }
  };
  if (engine.isWebGPU) {
    count(GPURenderPassEncoder.prototype, ["draw", "drawIndexed", "drawIndirect", "drawIndexedIndirect"]);
    count(GPURenderBundleEncoder.prototype, ["draw", "drawIndexed", "drawIndirect", "drawIndexedIndirect"]);
    engine.enableGPUTimingMeasurements = true;
    const timer = engine.getGPUFrameTimeCounter?.();
    let seen = 0;
    engine.onBeginFrameObservable.add(() => { M.drawCount = 0; });
    engine.onEndFrameObservable.add(() => {
      M.draws.push(M.drawCount);
      // (le temps d'une image arrive quelques images plus tard, en nanosecondes)
      if (timer && timer.count !== seen) { seen = timer.count; M.gpu.push(timer.current / 1e6); }
    });
    const info = engine._adapterInfo ?? {};
    const timed = engine.getCaps().timerQuery === true;
    return { gpu: "WebGPU · " + [info.vendor, info.architecture, info.description].filter(Boolean).join(" "), timer: timed, render: [engine.getRenderWidth(), engine.getRenderHeight()] };
  }
  const gl = engine._gl;
  count(WebGL2RenderingContext.prototype, ["drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced"]);
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
  return { gpu: "WebGL 2 · " + (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)), timer: !!tq, render: [engine.getRenderWidth(), engine.getRenderHeight()] };
})()`;

/**
 * Les fonctions qui prennent le plus de temps propre (sans leurs appelées) dans un profil du
 * processeur (`Profiler.stop`), et la part de chacune : on y voit ce qui coûte dans une image.
 */
function printProfile(profile) {
  const self = new Map();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  let total = 0;
  profile.samples.forEach((id, i) => {
    const dt = profile.timeDeltas[i] ?? 0;
    const f = byId.get(id).callFrame;
    const file = f.url ? f.url.split("/").pop() : "";
    const key = `${f.functionName || "(anonyme)"} ${file}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + dt);
    total += dt;
  });
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
  console.log(`\nProfil du processeur (fil de la page, ${fmt(total / 1000, 0)} ms échantillonnées) : temps propre`);
  for (const [key, us] of top) console.log(`  ${fmt((100 * us) / total, 1).padStart(5)} %  ${key}`);
}

/** Remet les relevés à zéro (début d'une fenêtre). */
const RESET = `(() => {
  const g = window.__casse.game, M = window.__perf;
  M.intervals.length = 0; M.draws.length = 0; M.gpu.length = 0;
  g.frameProfile = { times: {}, frames: 0, totals: [] };
  // La simulation dans le Worker : ses temps arrivent avec ses images ; sinon, dans la page
  const link = g.local && g.net === g.local ? g.local : null;
  if (link) {
    link.command({ t: "profile", on: true });
    link.replica.simProfile.times = {};
    link.replica.simProfile.steps = 0;
  } else g.sim.profile = { now: () => performance.now(), times: {} };
  M.worker = !!link;
  M.simStart = g.world.time;
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
    simTimes: M.worker ? { ...g.local.replica.simProfile.times } : { ...(g.sim.profile?.times ?? {}) },
    steps: M.worker ? g.local.replica.simProfile.steps : Math.round((g.world.time - M.simStart) * 60), worker: M.worker,
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
    worker: windows.some((w) => w.worker),
    bots: last.bots, particles: last.particles, meshes: last.meshes, heap: last.heap,
  };
}

function print(result) {
  const r = result.summary;
  const lines = [
    "",
    `Mesure du rendu · ${result.arena} · ${result.size} · préréglage ${result.preset}${result.renderOnly ? " · simulation figée" : ""} · simulation ${r.worker ? "dans un Worker" : "dans la page"} · ${result.commit}`,
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
    `Pas de simulation : ${fmt(r.simStep, 2)} ms${r.worker ? " (dans le Worker, hors du fil de l'image)" : ""}`,
    ...Object.entries(r.sim).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, t]) => `  ${k.padEnd(22)} ${fmt(t, 3).padStart(7)}`),
  ];
  console.log(lines.join("\n"));
}

/** Le démarrage, les téléchargements et la mémoire (voir plus haut : `--phone`, `--cpu-throttle`, `--network`). */
function printLoad(result) {
  const mb = (bytes) => `${fmt(bytes / 1048576, 2)} Mo`;
  const w = result.boot.worker;
  const steps = w ? Object.entries(w.boot).sort((a, b) => a[1] - b[1]).map(([k, t]) => `${k} ${fmt(t, 0)}`).join(", ") : "pas de Worker";
  const kinds = {};
  for (const d of result.downloads) {
    const name = d.url.split("?")[0].split("/").pop();
    const kind = /\.wasm$/.test(name) ? name.replace(/-[A-Za-z0-9_-]{8}\.wasm$/, ".wasm") : d.worker ? "code du Worker" : /\.js$/.test(name) ? "code de la page" : "autre (sons, arènes, images…)";
    kinds[kind] = (kinds[kind] ?? 0) + d.bytes;
  }
  const heap = (h) => (h ? `tas JS ${fmt(h.js, 1)} Mo, tampons ${h.buffers === null ? "?" : `${fmt(h.buffers, 1)} Mo`}` : "-");
  const lines = [
    "",
    `Démarrage${result.cpuThrottle > 1 ? ` (processeur ${result.cpuThrottle} fois plus lent)` : ""}${result.network ? ` (réseau ${result.network})` : ""} : jeu prêt en ${fmt(result.boot.page / 1000, 1)} s, bataille lancée en ${fmt(result.boot.match / 1000, 1)} s`,
    `Worker (${w?.engine ?? "?"}${w?.fallback ? `, repli : ${w.fallback}` : ""}) : ${steps} ms après son lancement${w?.wasmMemory ? ` ; mémoire du module Rust ${mb(w.wasmMemory)}` : ""}`,
    `Téléchargé : ${Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${mb(n)}`).join(", ")}`,
    `Mémoire : page ${heap(result.memory.page)} ; Worker ${heap(result.memory.worker)}${result.memory.renderer ? ` ; processus de rendu ${mb(result.memory.renderer)}` : ""}`,
    ...result.notes.map((n) => `  (${n})`),
  ];
  // Chrome ne ralentit que la page, pas ses Workers : le pas du Worker, mesuré à pleine vitesse, est
  // rapporté à un processeur `--cpu-throttle` fois plus lent (un pas doit tenir en 16,7 ms, 60 par seconde)
  const step = result.summary.simStep;
  if (result.cpuThrottle > 1 && result.summary.worker && step) {
    const slow = step * result.cpuThrottle;
    lines.push(`Pas de simulation sur un processeur ${result.cpuThrottle} fois plus lent (estimé : Chrome ne ralentit pas les Workers) : ${fmt(slow, 1)} ms, ${fmt((100 * slow) / (1000 / 60), 0)} % du temps d'un pas`);
  }
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

if (!options.noBuild && !options.dist) build();
const server = await serve(options.dist || undefined);
const chrome = await launchChrome({ width, height, software: options.software, extraArgs: options.renderer === "webgpu" ? ["--enable-unsafe-webgpu"] : [] });
const { page } = chrome;
/** Ce que le ralentissement n'a pas pu faire (un Worker qui le refuse) : dit dans le bilan. */
const notes = [];
/** Ce qui a été téléchargé : chaque fichier, ses octets transférés, par la page ou par un Worker. */
const downloads = new Map();
try {
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: SEED_RANDOM });
  // Le téléphone : le processeur ralenti (la page, et chaque Worker avant son premier code), le réseau, l'écran, le doigt
  const slow = async (sessionId) => {
    const who = sessionId ? "du Worker" : "de la page";
    if (options.cpuThrottle > 1) await page.send("Emulation.setCPUThrottlingRate", { rate: options.cpuThrottle }, sessionId).catch((e) => notes.push(`processeur ${who} non ralenti : ${e.message}`));
    if (network) {
      const conditions = { offline: false, latency: network.latency, downloadThroughput: network.download, uploadThroughput: network.upload };
      await page.send("Network.emulateNetworkConditions", conditions, sessionId).catch((e) => notes.push(`réseau ${who} non ralenti : ${e.message}`));
    }
  };
  page.on("Network.responseReceived", (p, sessionId) => downloads.set(`${sessionId ?? ""}:${p.requestId}`, { url: p.response.url, bytes: 0, worker: !!sessionId }));
  page.on("Network.loadingFinished", (p, sessionId) => {
    const d = downloads.get(`${sessionId ?? ""}:${p.requestId}`);
    if (d) d.bytes = p.encodedDataLength;
  });
  await page.attachWorkers(async (sessionId) => {
    await page.send("Runtime.enable", {}, sessionId);
    await page.send("Network.enable", {}, sessionId);
    await slow(sessionId);
  });
  await slow(undefined);
  if (options.phone) {
    await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: PHONE.scale, mobile: true });
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await page.send("Emulation.setUserAgentOverride", { userAgent: PHONE.agent, platform: "Linux armv8l" });
  }
  console.log(`» ${chrome.version} : démarrage du jeu${options.cpuThrottle > 1 ? ` (processeur ${options.cpuThrottle} fois plus lent)` : ""}`);
  const opened = Date.now();
  await openGame(page, `${server.url}?renderer=${options.renderer}${options.query ? "&" + options.query : ""}`);
  const booted = Date.now() - opened;
  if (options.renderer === "webgpu" && !(await page.evaluate(`window.__casse.game.engine.isWebGPU`))) throw new Error("WebGPU demandé : le navigateur ne l'offre pas");
  await page.evaluate(`window.__casse.graphics(${JSON.stringify(options.preset)})`);
  // (la graine du hasard de la partie dans le Worker : la bataille se rejoue presque pareil)
  const asked = Date.now();
  await page.evaluate(`(window.__casse.game.seed = 7, window.__casse.screens.benchmark(${JSON.stringify(options.arena)}))`);
  await page.waitFor(MATCH_STARTED, 120_000 * Math.max(1, options.cpuThrottle), "début de la bataille");
  const started = Date.now() - asked;
  // (un réglage de plus pour la mesure, une fois la bataille lancée : `--eval="__casse.game.setGlow(false)"`)
  if (options.eval) await page.evaluate(`(() => { ${options.eval}; return 1; })()`);
  await page.evaluate(`(() => { const g = window.__casse.game; g.setFollow(0); g.rig.setZoom(16); return 1; })()`);
  const info = await page.evaluate(INSTRUMENT);
  // (la simulation mesurée : celle du Worker, du TypeScript ou portée en Rust, `--query="sim=rust"` ; ou celle de la page)
  const simulation = await page.evaluate(`window.__casse.game.simulationEngine`);
  console.log(`» Bataille en cours (${info.render.join(" × ")}, simulation ${simulation}) ; ${options.warmup} s pour s'engager`);
  await sleep(options.warmup * 1000);
  if (options.renderOnly) await page.evaluate(`window.__casse.game.hold()`);
  const windows = [];
  // (le profil du processeur du fil de la page, si demandé : où passe le temps de chaque image)
  if (options.cpuprofile) {
    await page.send("Profiler.enable");
    await page.send("Profiler.setSamplingInterval", { interval: 250 });
    await page.send("Profiler.start");
  }
  for (let i = 0; i < Math.max(1, Math.round(options.seconds / options.window)); i++) {
    await page.evaluate(RESET);
    await sleep(options.window * 1000);
    windows.push(await page.evaluate(COLLECT));
    process.stdout.write(`  fenêtre ${i + 1} : ${fmt(windows.at(-1).intervals.length / (sum(windows.at(-1).intervals) / 1000))} img/s\n`);
  }
  if (options.cpuprofile) {
    const { profile } = await page.send("Profiler.stop");
    writeFileSync(options.cpuprofile, JSON.stringify(profile));
    printProfile(profile);
  }
  // Le démarrage du Worker (ses étapes, la mémoire de la simulation Rust) et la mémoire de la page et
  // du Worker : leur tas JavaScript, et leurs tampons (dont la mémoire du WebAssembly : Rapier ou le module Rust)
  const worker = await page.evaluate(`window.__casse.game.local ? window.__casse.game.local.stats() : null`);
  const heapOf = async (sessionId) => {
    const h = await page.send("Runtime.getHeapUsage", {}, sessionId).catch(() => null);
    return h && { js: h.usedSize / 1048576, buffers: h.backingStorageSize === undefined ? null : h.backingStorageSize / 1048576 };
  };
  const simWorker = [...(page.workers?.entries() ?? [])].find(([, t]) => /simWorker/.test(t.url))?.[0];
  const memory = { page: await heapOf(undefined), worker: simWorker ? await heapOf(simWorker) : null, renderer: chrome.rendererMemory() };
  const errors = page.errors;
  const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
  const result = {
    date: new Date().toISOString(), commit, browser: chrome.version, gpu: info.gpu, gpuName: info.gpu,
    arena: options.arena, size: options.size, preset: options.preset, renderOnly: options.renderOnly, simulation,
    phone: options.phone, cpuThrottle: options.cpuThrottle, network: options.network || null,
    boot: { page: booted, match: started, worker }, memory, downloads: [...downloads.values()].filter((d) => d.bytes > 0), notes,
    summary: summarize(windows), windows: windows.length,
  };
  result.summary.size = options.size;
  result.summary.gpuName = info.gpu;
  print(result);
  printLoad(result);
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
