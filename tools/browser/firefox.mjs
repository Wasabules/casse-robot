// Le jeu construit dans Firefox sans fenêtre (par WebDriver BiDi, le protocole que Firefox parle) : il
// démarre, une bataille se lance et se joue quelques secondes sur la simulation choisie, sans erreur
// dans la console. Une vérification de base, à la main (Firefox n'est pas dans l'intégration continue) :
//
//   node tools/browser/firefox.mjs                 la simulation Rust (« sim=rust »), au Dépôt
//   node tools/browser/firefox.mjs --query=sim=ts --arena=valley --seconds=20 --no-build
//
// FIREFOX_PATH pour choisir un Firefox.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { BOOTED, build, MATCH_STARTED, parseArgs, serve, sleep } from "./chrome.mjs";

const options = parseArgs({ query: "sim=rust", arena: "depot", seconds: 15, noBuild: false, port: 9333 });

/** Le Firefox de la machine. */
function findFirefox() {
  if (process.env.FIREFOX_PATH) return process.env.FIREFOX_PATH;
  const candidates = {
    win32: [`${process.env.PROGRAMFILES}\\Mozilla Firefox\\firefox.exe`, `${process.env["PROGRAMFILES(X86)"]}\\Mozilla Firefox\\firefox.exe`],
    darwin: ["/Applications/Firefox.app/Contents/MacOS/firefox"],
    linux: ["/usr/bin/firefox", "/usr/local/bin/firefox", "/snap/bin/firefox"],
  }[process.platform] ?? [];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("Firefox introuvable : indiquer son chemin dans FIREFOX_PATH");
  return found;
}

/** Une session WebDriver BiDi : des commandes, et les entrées de la console. */
class Bidi {
  static async open(url) {
    for (let i = 0; i < 100; i++) {
      try {
        const ws = new WebSocket(url);
        await new Promise((resolve, reject) => {
          ws.once("open", resolve);
          ws.once("error", reject);
        });
        return new Bidi(ws);
      } catch {
        await sleep(200);
      }
    }
    throw new Error("Firefox n'ouvre pas son port WebDriver BiDi");
  }

  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.logs = [];
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.type === "error") reject(new Error(`${msg.error} : ${msg.message}`));
        else resolve(msg.result);
      } else if (msg.method === "log.entryAdded") this.logs.push(msg.params);
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Évalue une expression dans la page (une promesse est attendue) et rend sa valeur (nombres, textes, booléens). */
  async evaluate(context, expression) {
    const r = await this.send("script.evaluate", { expression, target: { context }, awaitPromise: true });
    if (r.type === "exception") throw new Error(`Dans la page : ${r.exceptionDetails.text}`);
    return r.result.value;
  }
}

if (!options.noBuild) build();
const server = await serve();
const profile = mkdtempSync(join(tmpdir(), "casse-robot-firefox-"));
// Le son sans geste du joueur (sinon le jeu attend un clic, « Cliquer pour commencer »), et WebGL sans fenêtre
writeFileSync(join(profile, "user.js"), [
  'user_pref("media.autoplay.default", 0);',
  'user_pref("media.autoplay.blocking_policy", 0);',
  'user_pref("webgl.force-enabled", true);',
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  "",
].join("\n"));
const firefox = spawn(findFirefox(), ["--headless", "--no-remote", "--profile", profile, `--remote-debugging-port=${options.port}`, "about:blank"], { stdio: "ignore" });
let bidi = null;
try {
  bidi = await Bidi.open(`ws://127.0.0.1:${options.port}/session`);
  const { capabilities } = await bidi.send("session.new", { capabilities: {} });
  console.log(`» ${capabilities.browserName} ${capabilities.browserVersion} : démarrage du jeu (${options.query})`);
  await bidi.send("session.subscribe", { events: ["log.entryAdded"] });
  const { contexts } = await bidi.send("browsingContext.getTree", {});
  const context = contexts[0].context;
  await bidi.send("browsingContext.navigate", { context, url: `${server.url}?${options.query}`, wait: "complete" });
  const waitFor = async (expression, timeout, what) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await bidi.evaluate(context, expression).catch(() => false)) return;
      await sleep(250);
    }
    // Où le chargement s'est arrêté, et ce que dit la console
    const step = await bidi.evaluate(context, `document.getElementById("loadingStep")?.textContent ?? "?"`).catch(() => "?");
    const logs = bidi.logs.slice(-8).map((l) => `${l.level} : ${l.text}`).join("\n  ");
    throw new Error(`Délai dépassé : ${what} (écran de chargement : « ${step} »)${logs ? `\n  ${logs}` : ""}`);
  };
  const t0 = Date.now();
  await waitFor(BOOTED, 180_000, "démarrage du jeu");
  console.log(`» jeu prêt en ${((Date.now() - t0) / 1000).toFixed(1)} s ; bataille (${options.arena})`);
  await bidi.evaluate(context, `(window.__casse.screens.benchmark(${JSON.stringify(options.arena)}), 1)`);
  await waitFor(MATCH_STARTED, 180_000, "début de la bataille");
  const engine = await bidi.evaluate(context, `window.__casse.game.simulationEngine`);
  const start = await bidi.evaluate(context, `window.__casse.game.world.time`);
  const frames0 = await bidi.evaluate(context, `(window.__frames = 0, (function tick() { window.__frames++; requestAnimationFrame(tick); })(), 1)`);
  void frames0;
  await sleep(options.seconds * 1000);
  const end = await bidi.evaluate(context, `window.__casse.game.world.time`);
  const frames = await bidi.evaluate(context, `window.__frames`);
  const stats = await bidi.evaluate(context, `window.__casse.game.local ? window.__casse.game.local.stats().then((s) => JSON.stringify(s)) : "null"`);
  const bots = await bidi.evaluate(context, `window.__casse.game.world.bots.filter((b) => b.cockpit.alive).length`);
  const errors = bidi.logs.filter((l) => l.level === "error").map((l) => l.text);
  console.log(`Simulation : ${engine} ; ${(end - start).toFixed(1)} s de jeu simulées en ${options.seconds} s ; ${(frames / options.seconds).toFixed(1)} images par seconde ; ${bots} robots en vie`);
  console.log(`Worker : ${stats}`);
  if (errors.length) {
    console.log(`Erreurs dans la console :\n${errors.slice(0, 10).join("\n")}`);
    process.exitCode = 1;
  } else if (!(end - start > options.seconds / 3)) {
    console.log("La partie n'avance pas");
    process.exitCode = 1;
  } else console.log("Sans erreur.");
} finally {
  await bidi?.send("session.end").catch(() => {});
  firefox.kill();
  await new Promise((r) => (firefox.exitCode !== null ? r() : firefox.once("exit", r)));
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  await server.close();
}
