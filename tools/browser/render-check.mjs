// npm run render:check : l'essai du rendu. Le jeu construit, dans Chrome sans fenêtre, passe par
// chaque écran (accueil, une bataille de jour, une bataille de nuit, le garage, l'éditeur de cartes),
// survit à une perte du contexte WebGL, et rien ne doit faillir : aucune erreur ni exception dans la
// console (un shader qui ne compile pas en est une), aucune requête en échec, et chaque écran dessine
// une vraie image (pas un aplat : le canvas seul, ses couleurs doivent varier). Par défaut sans
// carte graphique (SwiftShader, comme l'intégration continue) ; `--gpu` : celle de la machine.
// `--renderer=webgpu` : le même parcours sous WebGPU (échoue si le navigateur ne l'offre pas, sauf
// avec `--optional` : l'essai est alors sauté, et le dit), la perte du contexte devenant celle du
// périphérique WebGPU. Les captures de chaque écran vont dans
// artifacts/render-check/ (artifacts/render-check/webgpu/ sous WebGPU).
//
//   npm run render:check [-- --gpu] [-- --renderer=webgpu] [-- --no-build]
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BOOTED, build, launchChrome, MATCH_STARTED, openGame, parseArgs, ROOT, SEED_RANDOM, serve, sleep } from "./chrome.mjs";

const options = parseArgs({ gpu: false, noBuild: false, size: "1280x720", renderer: "webgl", optional: false, query: "" });
const [width, height] = options.size.split("x").map(Number);
if (options.renderer !== "webgl" && options.renderer !== "webgpu") throw new Error(`--renderer : webgl ou webgpu, pas ${options.renderer}`);
const gpuRun = options.renderer === "webgpu";
const SHOTS = join(ROOT, "artifacts", "render-check", ...(gpuRun ? ["webgpu"] : []));

/**
 * L'image du canvas (`Page.canvasImage` : le HUD caché), sur une grille de points : luminance
 * moyenne, son écart type, nombre de couleurs différentes.
 */
function pixelStats({ width: w, height: h, data }) {
  const n = 64, colors = new Set();
  let s = 0, s2 = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const x = Math.floor(((i + 0.5) * w) / n), y = Math.floor(((j + 0.5) * h) / n), k = (y * w + x) * 4;
    const l = 0.2126 * data[k] + 0.7152 * data[k + 1] + 0.0722 * data[k + 2];
    s += l; s2 += l * l;
    colors.add(((data[k] >> 3) << 10) | ((data[k + 1] >> 3) << 5) | (data[k + 2] >> 3));
  }
  const mean = s / (n * n);
  return { mean: Math.round(mean), spread: Math.round(Math.sqrt(Math.max(0, s2 / (n * n) - mean * mean))), colors: colors.size };
}

/** Nombre d'images dessinées jusqu'ici (tous écrans confondus). */
const FRAME = `window.__casse.game.engine.frameId`;

/**
 * Une vraie image : des couleurs variées (un aplat, un ciel seul n'en ont que quelques-unes). Relevé
 * sans carte graphique : accueil 224 couleurs, bataille de jour 194, de nuit 79, éditeur 107 ; le
 * garage, sobre (un sol gris, un petit robot), 39.
 */
const MIN_COLORS = 50;
const MIN_SPREAD = 8;

if (!options.noBuild) build();
mkdirSync(SHOTS, { recursive: true });
const server = await serve();
// (WebGPU sans carte graphique : l'adaptateur SwiftShader de Dawn)
const gpuArgs = gpuRun ? ["--enable-unsafe-webgpu", ...(options.gpu ? [] : ["--use-webgpu-adapter=swiftshader"])] : [];
const chrome = await launchChrome({ width, height, software: !options.gpu, extraArgs: gpuArgs });
const { page } = chrome;
const failures = [];
let step = 0;
/** WebGPU demandé avec `--optional`, et que le navigateur n'offre pas. */
let skipped = false;

/**
 * Un écran : `open` l'ouvre, on attend `ready`, on laisse passer `settle` s, puis on vérifie qu'il
 * dessine (`minColors` couleurs au moins) et, si `after` est donné, que cette expression est vraie.
 */
async function check(name, open, ready, { settle = 2, minColors = MIN_COLORS, after = null, pixels: drawn = true } = {}) {
  step++;
  const errorsBefore = page.errors.length;
  try {
    if (open) await page.evaluate(open);
    if (ready) await page.waitFor(ready, 120_000, `${name} : prêt`);
    const before = await page.evaluate(FRAME);
    await sleep(settle * 1000);
    let frames = (await page.evaluate(FRAME)) - before;
    // (une machine lente, l'intégration continue sans carte graphique : au moins deux images, en attendant encore un peu)
    for (let waited = 0; drawn && frames < 2 && waited < 30_000; waited += 1000) {
      await sleep(1000);
      frames = (await page.evaluate(FRAME)) - before;
    }
    // (un écran figé exprès, le périphérique perdu : ni images ni pixels à relever)
    const pixels = drawn ? pixelStats(await page.canvasImage()) : null;
    await page.screenshot(join(SHOTS, `${String(step).padStart(2, "0")}-${name}.png`));
    const problems = [];
    if (drawn && frames < 2) problems.push(`${frames} image(s) dessinée(s) en ${settle} s`);
    if (pixels && (pixels.colors < minColors || pixels.spread < MIN_SPREAD)) problems.push(`image presque unie (${pixels.colors} couleurs, écart ${pixels.spread})`);
    if (after && !(await page.evaluate(after))) problems.push(`faux : ${after}`);
    problems.push(...page.errors.slice(errorsBefore));
    console.log(`${problems.length ? "ÉCHEC" : "ok   "} ${name} · ${frames} images en ${settle} s${pixels ? ` · ${pixels.colors} couleurs, écart ${pixels.spread}` : ""}`);
    for (const p of problems) console.log(`        ${p}`);
    if (problems.length) failures.push(name);
  } catch (err) {
    console.log(`ÉCHEC ${name} : ${err.message}`);
    failures.push(name);
  }
}

try {
  const gl = await page.evaluate(`(() => { const c = document.createElement("canvas").getContext("webgl2"); const d = c?.getExtension("WEBGL_debug_renderer_info"); return c ? (d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : c.getParameter(c.RENDERER)) : "pas de WebGL 2"; })()`);
  console.log(`» ${chrome.version} · ${gl}`);
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: SEED_RANDOM });
  await openGame(page, `${server.url}?renderer=${options.renderer}${options.query ? "&" + options.query : ""}`);
  const backend = await page.evaluate(`(() => { const e = window.__casse.game.engine; return e.isWebGPU ? "WebGPU" : "WebGL " + e.webGLVersion; })()`);
  console.log(`» rendu : ${backend}`);
  if (gpuRun && backend !== "WebGPU") {
    if (options.optional) {
      console.log(`\nWebGPU indisponible dans ce navigateur (le jeu dessine en ${backend}) : essai sauté.`);
      skipped = true;
    } else {
      console.log("ÉCHEC WebGPU demandé, le jeu dessine en " + backend);
      failures.push("webgpu");
    }
  }
  if (!skipped) {
    await check("accueil", null, null, { settle: 3 });
    await check("bataille-jour", `window.__casse.screens.benchmark("depot")`, MATCH_STARTED, { settle: 3 });
    await check("bataille-nuit", `window.__casse.screens.benchmark("cityNight")`, `window.__casse.game.world.arena.id === "cityNight" && (${MATCH_STARTED})`, { settle: 3 });
    // Le choix de l'arène : le fichier de chaque grande arène se télécharge (un morceau à part), sans erreur ni
    // requête en échec, et le plan de l'arène sélectionnée se dessine. Le canvas n'est pas jugé : sans carte
    // graphique, pendant que les plans se calculent, la démonstration derrière n'a guère d'images
    await check(
      "choix-arène",
      `(window.__casse.screens.title(), window.__casse.screens.arenas("battle"), 1)`,
      `window.__casse.arenas.ready().length === 10 && !!document.querySelector(".ap-view.ready")`,
      { settle: 1, pixels: false },
    );
    // La carte graphique réinitialisée (pilote qui plante, téléphone qui reprend la mémoire) : le jeu doit
    // repartir. En WebGL, le contexte perdu puis rendu : tout revient de soi-même. En WebGPU, le
    // périphérique détruit : le bandeau propose aussitôt de recharger la page, et le jeu rechargé repart
    if (gpuRun) {
      await check(
        "perte-du-périphérique",
        `(window.__casse.game.engine._device.destroy(), 1)`,
        `!document.getElementById("gpuNotice").hidden && !document.getElementById("gpuReload").hidden`,
        { settle: 1, pixels: false },
      );
      await check(
        "après-rechargement",
        `(window.__beforeReload = 1, document.getElementById("gpuReload").click(), 1)`,
        `!window.__beforeReload && ${BOOTED}`,
        { settle: 3, after: `window.__casse.game.engine.isWebGPU` },
      );
    } else {
      await check(
        "perte-du-contexte",
        `(() => {
          const ext = window.__casse.game.engine._gl.getExtension("WEBGL_lose_context");
          ext.loseContext();
          setTimeout(() => {
            window.__gpuNoticeShown = !document.getElementById("gpuNotice").hidden;
            ext.restoreContext();
          }, 1000);
          return 1;
        })()`,
        null,
        // (le bandeau de la carte graphique réinitialisée s'est montré, puis effacé une fois le contexte rendu)
        { settle: 5, after: `window.__gpuNoticeShown === true && document.getElementById("gpuNotice").hidden && !window.__casse.game.engine._gl.isContextLost()` },
      );
    }
    await check("garage", `window.__casse.screens.garage()`, `document.body.classList.contains("in-garage")`, { settle: 3, minColors: 20 });
    await check("éditeur", `(window.__casse.screens.title(), window.__casse.screens.editor())`, `!!window.__casse.editor?.active`, { settle: 3 });
  }
} finally {
  await chrome.close();
  await server.close();
}
if (!skipped) console.log(failures.length ? `\n${failures.length} écran(s) en échec : ${failures.join(", ")} (captures : ${SHOTS})` : "\nTous les écrans se dessinent, sans erreur.");
process.exit(failures.length ? 1 : 0);
