// Le jeu construit, joué dans un vrai Chrome sans fenêtre, piloté par le protocole des outils de
// développement (CDP) : ce que partagent la mesure du rendu (perf.mjs) et l'essai du rendu
// (render-check.mjs). Construire la page, la servir, lancer Chrome, attendre que le jeu ait démarré,
// évaluer du code dans la page, relever ce que dit la console.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import WebSocket from "ws";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Options de la ligne de commande : `--clé=valeur` ou `--drapeau`. */
export function parseArgs(defaults) {
  const options = { ...defaults };
  for (const arg of process.argv.slice(2)) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m) throw new Error(`Option inconnue : ${arg}`);
    const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (!(key in defaults)) throw new Error(`Option inconnue : --${m[1]} (options : ${Object.keys(defaults).join(", ")})`);
    options[key] = m[2] === undefined ? true : typeof defaults[key] === "number" ? Number(m[2]) : m[2];
  }
  return options;
}

/** Construit la page du jeu dans dist/ (sans la vérification des types : `npm run check` la fait). */
export function build() {
  console.log("» Construction de la page (vite build)");
  const result = spawnSync("npx", ["vite", "build", "--logLevel", "warn"], { cwd: ROOT, stdio: "inherit", shell: true, env: { ...process.env, BASE_PATH: "" } });
  if (result.status !== 0) throw new Error("La construction de la page a échoué");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Sert dist/ (vite preview, sans la configuration du projet : ni ouverture du navigateur ni cache partagé). */
export async function serve() {
  const { preview } = await import("vite");
  const port = await freePort();
  const server = await preview({
    root: ROOT,
    configFile: false,
    logLevel: "warn",
    build: { outDir: "dist" },
    preview: { host: "127.0.0.1", port, strictPort: true, open: false },
  });
  return { url: `http://127.0.0.1:${port}/`, close: () => server.close() };
}

/** Le Chrome (ou Edge, ou Chromium) de la machine ; `CHROME_PATH` pour en choisir un. */
export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const env = process.env;
  const candidates = {
    win32: [
      `${env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
      `${env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
      `${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      `${env["PROGRAMFILES(X86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ],
    darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"],
  }[process.platform];
  if (candidates) {
    const found = candidates.find((path) => existsSync(path));
    if (found) return found;
  }
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const which = spawnSync("which", [name], { encoding: "utf8" });
    if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  }
  throw new Error("Chrome introuvable : indiquer son chemin dans CHROME_PATH");
}

/**
 * Lance Chrome sans fenêtre. `software` : rendu sans carte graphique (SwiftShader : l'intégration
 * continue) ; sinon, la carte graphique de la machine. Sans limite d'images par seconde (la mesure
 * voit ce que la machine peut faire), son coupé, sans geste demandé pour le son.
 */
export async function launchChrome({ width = 1280, height = 720, software = false, extraArgs = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "casse-robot-chrome-"));
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${dir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--mute-audio",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-gpu-vsync",
    "--disable-frame-rate-limit",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    `--window-size=${width},${height}`,
  ];
  if (software) args.push("--use-angle=swiftshader", "--enable-unsafe-swiftshader");
  else if (process.platform === "win32") args.push("--use-angle=d3d11");
  // Sur les machines de l'intégration continue (Ubuntu récent), le bac à sable de Chrome n'a pas le droit de s'ouvrir
  if (process.env.CI) args.push("--no-sandbox");
  args.push(...extraArgs, "about:blank");
  const child = spawn(findChrome(), args, { stdio: "ignore" });
  // Chrome écrit le port qu'il a pris dans DevToolsActivePort
  const portFile = join(dir, "DevToolsActivePort");
  for (let i = 0; i < 200 && !existsSync(portFile); i++) await sleep(100);
  if (!existsSync(portFile)) throw new Error("Chrome n'a pas ouvert son port de débogage");
  let port = 0;
  for (let i = 0; i < 50 && !port; i++) {
    port = Number(readFileSync(portFile, "utf8").split("\n")[0]) || 0;
    if (!port) await sleep(100);
  }
  const base = `http://127.0.0.1:${port}`;
  const version = await (await fetch(`${base}/json/version`)).json();
  const targets = await (await fetch(`${base}/json/list`)).json();
  const page = await Page.connect(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await page.setup(width, height);
  return {
    page,
    version: version.Browser,
    close: async () => {
      page.close();
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)));
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

/** Une page de Chrome, par le protocole des outils de développement. */
export class Page {
  static async connect(url) {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return new Page(ws);
  }

  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    /** Erreurs et avertissements de la console, exceptions, requêtes en échec. */
    this.errors = [];
    this.warnings = [];
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      }
      for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const n = ++this.id;
      this.pending.set(n, { resolve, reject });
      this.ws.send(JSON.stringify({ id: n, method, params }));
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  async setup(width, height) {
    const text = (args) => args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 500);
    this.on("Runtime.consoleAPICalled", (p) => {
      if (p.type === "error" || p.type === "assert") this.errors.push(`console : ${text(p.args)}`);
      if (p.type === "warning") this.warnings.push(text(p.args));
    });
    this.on("Runtime.exceptionThrown", (p) => this.errors.push(`exception : ${(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text).slice(0, 800)}`));
    this.on("Network.responseReceived", (p) => {
      // (le navigateur demande une icône que le jeu n'a pas : sans importance)
      if (p.response.status >= 400 && !p.response.url.endsWith("/favicon.ico")) this.errors.push(`réseau : ${p.response.status} ${p.response.url}`);
    });
    this.on("Network.loadingFailed", (p) => {
      if (!p.canceled) this.errors.push(`réseau : ${p.errorText} (${p.type})`);
    });
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Network.enable");
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  }

  /** Évalue une expression dans la page (une promesse est attendue) et rend sa valeur. */
  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`Dans la page : ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }

  /** Attend que l'expression soit vraie dans la page (au plus `timeout` ms). */
  async waitFor(expression, timeout = 60_000, what = expression) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await this.evaluate(expression).catch(() => false)) return;
      await sleep(250);
    }
    throw new Error(`Délai dépassé : ${what}`);
  }

  async navigate(url) {
    await this.send("Page.navigate", { url });
  }

  async screenshot(file) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(file, Buffer.from(r.data, "base64"));
  }

  /**
   * L'image du canvas du jeu seul (le HUD et les menus cachés le temps de la capture), en pixels RGBA :
   * relevée par une capture de la page, elle vaut pour WebGL comme pour WebGPU.
   */
  async canvasImage() {
    await this.evaluate(`(() => {
      const s = document.createElement("style");
      s.id = "canvas-only";
      s.textContent = "* { visibility: hidden !important; } #c { visibility: visible !important; }";
      document.head.append(s);
    })()`);
    try {
      // (deux images dessinées sans le HUD avant la capture)
      await this.evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
      const box = await this.evaluate(`(() => { const r = document.getElementById("c").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
      const r = await this.send("Page.captureScreenshot", { format: "png", clip: { ...box, scale: 1 } });
      return decodePng(Buffer.from(r.data, "base64"));
    } finally {
      await this.evaluate(`document.getElementById("canvas-only")?.remove()`);
    }
  }

  close() {
    this.ws.close();
  }
}

/**
 * Une image PNG (8 bits par canal, gris, RVB, gris et alpha ou RVBA, sans entrelacement : ce que
 * rend Chrome) en pixels RGBA.
 */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("pas une image PNG");
  let at = 8, width = 0, height = 0, type = 0;
  const parts = [];
  while (at < buf.length) {
    const length = buf.readUInt32BE(at);
    const kind = buf.toString("ascii", at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + length);
    if (kind === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      type = data[9];
      if (data[8] !== 8 || data[12] !== 0) throw new Error("PNG : seulement 8 bits par canal, sans entrelacement");
    } else if (kind === "IDAT") parts.push(data);
    else if (kind === "IEND") break;
    at += 12 + length;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  if (!channels) throw new Error(`PNG : type de couleur ${type} non lu`);
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? rows[y * stride + i - channels] : 0;
      const b = y > 0 ? rows[(y - 1) * stride + i] : 0;
      const c = i >= channels && y > 0 ? rows[(y - 1) * stride + i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      rows[y * stride + i] = v & 255;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let k = 0; k < width * height; k++) {
    const src = k * channels;
    const grey = channels < 3;
    rgba[k * 4] = rows[src];
    rgba[k * 4 + 1] = grey ? rows[src] : rows[src + 1];
    rgba[k * 4 + 2] = grey ? rows[src] : rows[src + 2];
    rgba[k * 4 + 3] = channels === 4 ? rows[src + 3] : channels === 2 ? rows[src + 1] : 255;
  }
  return { width, height, data: rgba };
}

/**
 * Graine fixe de Math.random dans la page, avant le jeu (`Page.addScriptToEvaluateOnNewDocument`) :
 * l'arène de la démonstration de l'accueil, les batailles se rejouent presque pareil d'une fois à l'autre.
 */
export const SEED_RANDOM = `(() => {
  let a = 7;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();`;

/** Le jeu a démarré : écran de chargement passé, l'API de la console en place. */
export const BOOTED = `!!window.__casse && getComputedStyle(document.getElementById("loading")).display === "none"`;
/** Une partie lancée par `__casse.screens.benchmark` a commencé (chargée, robots en place). */
export const MATCH_STARTED = `getComputedStyle(document.getElementById("loading")).display === "none" && window.__casse.game.world.bots.length > 0 && !window.__casse.game.frozen`;

/** Ouvre le jeu et attend qu'il ait démarré. */
export async function openGame(page, url) {
  await page.navigate(url);
  try {
    await page.waitFor(BOOTED, 120_000, "démarrage du jeu");
  } catch (err) {
    // Où le chargement s'est arrêté, et les dernières erreurs de la page : de quoi comprendre un démarrage bloqué
    const step = await page.evaluate(`document.getElementById("loadingStep")?.textContent ?? "?"`).catch(() => "?");
    const errors = page.errors.slice(-5);
    throw new Error(`${err.message} (écran de chargement : « ${step} »${errors.length ? ` ; ${errors.join(" | ")}` : ""})`);
  }
}
