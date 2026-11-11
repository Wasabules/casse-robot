import "./style.css";
import { initPhysics } from "../shared/sim/simulation";
import { installDebugApi } from "./debug";
import { byId, errorMessage } from "./dom";
import { App } from "./app";
import { ArenaGame } from "./game";
import { watchGpu } from "./hud/gpuNotice";
import { hideOverlay, showError } from "./hud/overlay";
import { LoadingScreen, nextPaint } from "./menu/loading";
import { applyDom } from "./i18n/dom";
import { t } from "./i18n/i18n";
import { onLocaleChange, setLocale } from "./i18n/state";
import { loadSettings } from "./settings";

// La langue choisie (ou celle du navigateur) dès le premier écran ; la page suit ses changements
setLocale(loadSettings().language);
applyDom();
onLocaleChange(() => applyDom());

// L'écran de chargement couvre tout jusqu'à ce que le jeu soit prêt (voir `App.boot`)
const loading = new LoadingScreen();
loading.show(t("menu.loading.prepare"));
loading.progress(0.02, t("menu.loading.wasm"));
try {
  await initPhysics();
} catch (e) {
  loading.hide();
  showError(t("menu.error.physics", { error: errorMessage(e) }));
  throw e;
}

/**
 * La suite du démarrage, hors de l'évaluation de ce module (pas d'`await` au premier niveau) : en
 * production, les morceaux de code des shaders, chargés à la demande, importent ce module-ci ; ils
 * attendraient qu'il ait fini de s'évaluer, pendant qu'il attendrait que les shaders soient prêts.
 */
async function start(): Promise<void> {
  loading.progress(0.08, t("menu.loading.scene"));
  await nextPaint();
  const canvas = byId<HTMLCanvasElement>("c");
  const game = new ArenaGame(canvas);
  watchGpu(game.engine);
  const app = new App(game, canvas, loading);
  canvas.tabIndex = 0;
  app.showTitle();
  game.start();
  installDebugApi(game, app.garage, app);
  hideOverlay();
  await app.boot();
}

void start().catch((e: unknown) => {
  loading.hide();
  showError(t("menu.error.start", { error: errorMessage(e) }));
  console.error(e);
});
