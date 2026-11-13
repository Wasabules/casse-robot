// node tools/browser/online.mjs : l'essai d'une partie en ligne. Le jeu construit (la page et le
// serveur de jeu), le serveur lancé sur un port libre (8792 par défaut : `--port`), qui sert aussi la
// page ; un Chrome sans fenêtre l'ouvre et rejoint la partie (`__casse.screens.online`). Ses images
// passent par le fil (src/shared/net/wire.ts : quantifiées, en écarts, compressées par la WebSocket) :
// la réplique doit suivre la partie sans une erreur. `--rtt=0.1 --jitter=0.01` : un relais entre la page
// et le serveur retarde chaque message (la moitié de l'aller-retour dans chaque sens, plus une gigue,
// dans l'ordre) ; le relais sert aussi la page, la partie passe donc par lui. On mesure, dans la page,
// le temps entre l'appui sur la touche d'avance et le moment où le robot bouge à l'écran, et le retard
// d'affichage que la réplique a pris (`Replica.delay`, réglé d'après les images : src/shared/net/pacing.ts),
// et la part des images où elle n'avait pas l'image suivante pour interpoler (un à-coup). `--fixed` : le
// retard d'avant (INTERP_DELAY, 100 ms, sans réglage), pour comparer. `--gpu` : la carte graphique de
// la machine (sinon SwiftShader, dont les images lentes font arriver les messages par paquets).
//
//   node tools/browser/online.mjs [--no-build] [--seconds=12] [--rtt=0.1] [--jitter=0.01] [--presses=6]
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { build, launchChrome, openGame, parseArgs, ROOT, sleep } from "./chrome.mjs";

const options = parseArgs({ noBuild: false, port: 8792, seconds: 12, rtt: 0, jitter: 0, presses: 6, preset: "buggy", gpu: false, fixed: false });

if (!options.noBuild) {
  build();
  console.log("» Construction du serveur (vite build --ssr)");
  const r = spawnSync("npx", ["vite", "build", "--ssr", "src/server/main.ts", "--outDir", "dist-server", "--emptyOutDir", "--logLevel", "warn"], { cwd: ROOT, stdio: "inherit", shell: true });
  if (r.status !== 0) throw new Error("La construction du serveur a échoué");
}

// Le serveur de jeu, sa progression dans un dossier à part, seulement le Dépôt (il se charge vite)
const work = mkdtempSync(join(tmpdir(), "casse-robot-online-"));
const server = spawn(process.execPath, ["dist-server/main.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(options.port), CLIENT_DIR: "dist", ARENAS: "depot", MAPS_DIR: join(work, "maps"), PROGRESS_FILE: join(work, "progress.json") },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
for (let i = 0; i < 600 && !log.includes("Serveur Casse-Robot"); i++) await sleep(100);
if (!log.includes("Serveur Casse-Robot")) throw new Error(`Le serveur n'a pas démarré :\n${log}`);
console.log(`» Serveur de jeu sur le port ${options.port} (${/simulation (\w+)/.exec(log)?.[1] ?? "?"})`);

/** Un relais qui retarde chaque message (et sert la page) : la moitié de l'aller-retour, plus une gigue, dans l'ordre. */
async function relay(target) {
  const delay = () => (options.rtt / 2 + Math.random() * options.jitter) * 1000;
  const http = createServer((req, res) => {
    const up = request({ host: "127.0.0.1", port: target, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => res.end());
    req.pipe(up);
  });
  const wss = new WebSocketServer({ server: http, perMessageDeflate: { threshold: 64 } });
  wss.on("connection", (client) => {
    const upstream = new WebSocket(`ws://127.0.0.1:${target}`);
    // Une file par sens, vidée dans l'ordre (des minuteries séparées, arrondies à la milliseconde, en inversaient)
    const pipe = (from, to) => {
      const queue = [];
      let timer = null;
      const pump = () => {
        timer = null;
        if (to.readyState !== WebSocket.OPEN) return;
        while (queue.length && queue[0].at <= performance.now()) {
          const { data, binary } = queue.shift();
          to.send(data, { binary });
        }
        if (queue.length) timer = setTimeout(pump, Math.max(1, queue[0].at - performance.now()));
      };
      from.on("message", (data, binary) => {
        const at = Math.max(queue.at(-1)?.at ?? 0, performance.now() + delay());
        queue.push({ at, data, binary });
        if (timer === null) timer = setTimeout(pump, Math.max(1, at - performance.now()));
      });
      to.on("open", pump);
    };
    pipe(client, upstream);
    pipe(upstream, client);
    client.on("close", () => upstream.close());
    upstream.on("close", () => client.close());
  });
  await new Promise((done) => http.listen(0, "127.0.0.1", done));
  return { port: http.address().port, close: () => (wss.close(), http.close()) };
}

const hop = options.rtt > 0 || options.jitter > 0 ? await relay(options.port) : null;
const url = `http://127.0.0.1:${hop?.port ?? options.port}/`;
const chrome = await launchChrome({ width: 1280, height: 720, software: !options.gpu });
const { page } = chrome;
const failures = [];
try {
  await openGame(page, url);
  // La poignée de main de la WebSocket : la compression négociée
  let extensions = null;
  page.on("Network.webSocketHandshakeResponseReceived", (p) => (extensions ??= p.response.headers["Sec-WebSocket-Extensions"] ?? p.response.headers["sec-websocket-extensions"] ?? ""));
  await page.evaluate(`window.__casse.screens.online(${JSON.stringify(options.preset)})`);
  await page.waitFor(`window.__casse.game.online && !!window.__casse.game.world.player && window.__casse.game.world.bots.length >= 12`, 60_000, "la partie en ligne");
  console.log(`» En ligne (${url}) ; compression : ${extensions || "aucune"}`);
  // Dans la page : chaque image dessinée, où est le robot du joueur ; et quand la touche d'avance s'enfonce
  await page.evaluate(`(() => {
    const probe = window.__probe = { moves: [], skipped: { dead: 0, moving: 0, stuck: 0 }, delays: [], rates: [], times: [], offline: 0, frames: 0, starved: 0, began: performance.now() };
    if (${options.fixed}) {
      const net = window.__casse.game.net;
      net.pacing.arrive = () => {};
      net.pacing.delay = net.replica.delay = 0.1;
      net.pacing.rate = net.replica.rate = 1;
    }
    // Un appui : le robot du joueur, à l'arrêt, doit bouger de 5 cm à l'écran dans les 1,5 s (sinon il est
    // bloqué, retourné, détruit : l'appui ne compte pas)
    let pending = null;
    addEventListener("keydown", (e) => {
      if (e.code !== "KeyW" || e.repeat) return;
      const bot = window.__casse.game.world.player;
      if (!bot?.cockpit.alive) probe.skipped.dead++;
      else if (Math.hypot(bot.cockpit.part.rb.linvel().x, bot.cockpit.part.rb.linvel().z) >= 0.2) probe.skipped.moving++;
      else pending = { at: performance.now(), from: bot.cockpit.part.rb.translation() };
    }, true);
    const look = () => {
      const game = window.__casse.game;
      const bot = game.world.player;
      probe.frames++;
      // (hors ligne, la réplique est celle de la partie solo : la liaison a été coupée)
      if (!game.online) probe.offline++;
      const replica = game.online ? game.net?.replica : null;
      if (replica) {
        probe.delays.push(replica.delay);
        probe.rates.push(replica.rate);
        probe.times.push(replica.time);
        if (replica.queue.length === 0) probe.starved++;
      }
      if (pending) {
        const waited = performance.now() - pending.at;
        const p = bot?.cockpit.alive ? bot.cockpit.part.rb.translation() : null;
        if (p && Math.hypot(p.x - pending.from.x, p.z - pending.from.z) > 0.05) {
          probe.moves.push(waited);
          pending = null;
        } else if (waited > 1500) {
          probe.skipped.stuck++;
          pending = null;
        }
      }
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  })()`);
  const W = { code: "KeyW", key: "w", windowsVirtualKeyCode: 87 };
  const SPACE = { code: "Space", key: " ", windowsVirtualKeyCode: 32 };
  const hold = async (k, ms) => {
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", ...k });
    await sleep(ms);
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...k });
  };
  // Chaque fois : à l'arrêt (le frein, puis un temps au hasard), plein gaz
  for (let k = 0; k < options.presses; k++) {
    await hold(SPACE, 1300);
    await sleep(400 + Math.random() * 300);
    await hold(W, 1200);
  }
  await sleep(Math.max(0, options.seconds * 1000 - options.presses * 3000));
  const probe = await page.evaluate(`window.__probe`);
  const moves = probe.moves.map((m) => Math.round(m));
  const delays = probe.delays.slice(-300);
  const delay = delays.reduce((a, b) => a + b, 0) / Math.max(1, delays.length);
  const advanced = probe.times.at(-1) - probe.times[0];
  const sorted = [...moves].sort((a, b) => a - b);
  console.log(`» Commande → robot qui bouge à l'écran : ${moves.join(", ")} ms (médiane ${sorted[sorted.length >> 1] ?? "?"} ms ; appuis écartés : robot détruit ${probe.skipped.dead}, pas à l'arrêt ${probe.skipped.moving}, qui ne bouge pas en 1,5 s ${probe.skipped.stuck})`);
  const rate = probe.rates.at(-1) ?? 1;
  const fps = probe.frames / Math.max(1e-3, (await page.evaluate("performance.now()") - probe.began) / 1000);
  const last = [...delays.slice(-60)].sort((a, b) => a - b);
  console.log(`» La page : ${fps.toFixed(0)} images par seconde ; retard d'affichage à la fin ${((last[last.length >> 1] ?? 0) * 1000).toFixed(0)} ms ; à-coups (pas d'image suivante) ${((probe.starved / Math.max(1, probe.delays.length)) * 100).toFixed(1)} % des images${options.fixed ? " (retard fixe de 100 ms)" : ""}`);
  console.log(`» Retard d'affichage : ${(delay * 1000).toFixed(0)} ms (au plus ${(Math.max(...delays) * 1000).toFixed(0)}) ; la réplique a avancé de ${advanced.toFixed(1)} s ; le temps du serveur à ${(rate * 100).toFixed(0)} % du temps réel`);
  if (probe.offline) failures.push(`la liaison s'est coupée (${probe.offline} images hors ligne)`);
  if (!extensions?.includes("permessage-deflate")) failures.push("la WebSocket n'a pas négocié permessage-deflate");
  if (!(advanced > options.seconds * 0.25)) failures.push(`la réplique n'avance pas (${advanced} s)`);
  if (!moves.length) failures.push("le robot n'a jamais bougé à l'appui sur la touche d'avance");
  failures.push(...page.errors, ...page.warnings.filter((w) => w.includes("illisible")));
} catch (e) {
  failures.push(e.message);
} finally {
  await chrome.close();
  hop?.close();
  server.kill();
  rmSync(work, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`✗ ${failures.join("\n✗ ")}`);
  process.exit(1);
}
console.log("✓ Partie en ligne sans erreur");
