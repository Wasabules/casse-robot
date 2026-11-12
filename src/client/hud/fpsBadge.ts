import type * as B from "../babylon";
import { byId } from "../dom";
import { num } from "../i18n/format";
import { t } from "../i18n/i18n";

/** Rafraîchissement du compteur (ms) : assez lent pour être lisible. */
const REFRESH_MS = 500;

/**
 * Compteur d'images par seconde dans un coin de l'écran (réglage graphique). Il tourne à part
 * de la boucle de l'arène : il reste juste au garage et derrière les menus, pendant qu'on règle
 * les graphismes.
 */
export class FpsBadge {
  private readonly el = byId("fpsBadge");
  private readonly engine: B.AbstractEngine;
  private timer = 0;

  constructor(engine: B.AbstractEngine) {
    this.engine = engine;
  }

  setVisible(on: boolean): void {
    if (on === !this.el.hidden) return;
    this.el.hidden = !on;
    window.clearInterval(this.timer);
    if (!on) return;
    const refresh = (): void => {
      const fps = this.engine.getFps();
      this.el.textContent = t("hud.fps", { fps: Number.isFinite(fps) ? num(fps) : "–" });
      this.el.dataset.level = fps < 30 ? "bad" : fps < 50 ? "warn" : "ok";
    };
    refresh();
    this.timer = window.setInterval(refresh, REFRESH_MS);
  }
}
