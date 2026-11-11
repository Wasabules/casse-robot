import { byId } from "../dom";
import { t } from "../i18n/i18n";

/** Durée du mot qui annonce une manette branchée ou débranchée (ms). */
const NOTICE_MS = 3500;

/**
 * Indicateur de manette, dans un coin de l'écran (au-dessus des menus) : une icône tant qu'une
 * manette est branchée (son nom au survol), et un mot quand elle arrive ou s'en va.
 */
export class PadBadge {
  private readonly el = byId("padBadge");
  private readonly text = byId("padBadgeText");
  private timer = 0;

  /** Une manette est branchée (`id` : son nom), ou n'est plus là (null). */
  show(id: string | null): void {
    window.clearTimeout(this.timer);
    if (id) {
      this.el.hidden = false;
      this.el.title = id;
      this.text.textContent = t("hud.pad.connected");
      this.timer = window.setTimeout(() => (this.text.textContent = ""), NOTICE_MS);
    } else {
      if (this.el.hidden) return;
      this.text.textContent = t("hud.pad.disconnected");
      this.el.title = "";
      this.timer = window.setTimeout(() => (this.el.hidden = true), NOTICE_MS);
    }
  }
}
