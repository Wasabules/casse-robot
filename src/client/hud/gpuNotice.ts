import type * as B from "../babylon";
import { byId } from "../dom";
import { t } from "../i18n/i18n";

/** Délai (s) après lequel une carte graphique qui ne revient pas fait proposer de recharger la page. */
const STUCK_AFTER = 5;

/**
 * La carte graphique réinitialisée (pilote qui plante, téléphone qui reprend la mémoire, onglet
 * longtemps en arrière-plan) : le navigateur retire le contexte WebGL au jeu. Babylon le reprend de
 * lui-même quand le navigateur le rend (textures, géométries, shaders refaits : vérifié par
 * `npm run render:check`) ; en attendant, un bandeau le dit, et s'il ne revient pas au bout de
 * `STUCK_AFTER` s, il propose de recharger la page.
 */
export function watchGpu(engine: B.Engine): void {
  const notice = byId("gpuNotice");
  const text = byId("gpuNoticeText");
  const reload = byId<HTMLButtonElement>("gpuReload");
  let timer = 0;
  reload.addEventListener("click", () => location.reload());
  engine.onContextLostObservable.add(() => {
    console.warn("Contexte WebGL perdu");
    text.textContent = t("hud.gpu.lost");
    reload.hidden = true;
    notice.hidden = false;
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      text.textContent = t("hud.gpu.stuck");
      reload.hidden = false;
    }, STUCK_AFTER * 1000);
  });
  engine.onContextRestoredObservable.add(() => {
    console.warn("Contexte WebGL rendu");
    clearTimeout(timer);
    notice.hidden = true;
  });
}
