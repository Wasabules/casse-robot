import type * as B from "../babylon";
import { byId } from "../dom";
import { t } from "../i18n/i18n";
import { restoresAfterLoss } from "../render/engine";

/** Délai (s) après lequel une carte graphique qui ne revient pas fait proposer de recharger la page. */
const STUCK_AFTER = 5;

/**
 * La carte graphique réinitialisée (pilote qui plante, téléphone qui reprend la mémoire, onglet
 * longtemps en arrière-plan) : le navigateur retire le contexte WebGL au jeu. Babylon le reprend de
 * lui-même quand le navigateur le rend (textures, géométries, shaders refaits : vérifié par
 * `npm run render:check`) ; en attendant, un bandeau le dit, et s'il ne revient pas au bout de
 * `STUCK_AFTER` s, il propose de recharger la page. Sous WebGPU, le périphérique perdu n'est pas
 * refait (render/engine.ts, `restoresAfterLoss`) : le bandeau propose tout de suite de recharger.
 */
export function watchGpu(engine: B.AbstractEngine): void {
  const notice = byId("gpuNotice");
  const text = byId("gpuNoticeText");
  const reload = byId<HTMLButtonElement>("gpuReload");
  let timer = 0;
  reload.addEventListener("click", () => location.reload());
  const stuck = (): void => {
    text.textContent = t(engine.isWebGPU ? "hud.gpu.reset" : "hud.gpu.stuck");
    reload.hidden = false;
  };
  engine.onContextLostObservable.add(() => {
    console.warn(engine.isWebGPU ? "Périphérique WebGPU perdu" : "Contexte WebGL perdu");
    notice.hidden = false;
    clearTimeout(timer);
    if (!restoresAfterLoss(engine)) {
      stuck();
      return;
    }
    text.textContent = t("hud.gpu.lost");
    reload.hidden = true;
    timer = window.setTimeout(stuck, STUCK_AFTER * 1000);
  });
  engine.onContextRestoredObservable.add(() => {
    console.warn("Contexte WebGL rendu");
    clearTimeout(timer);
    notice.hidden = true;
  });
}
