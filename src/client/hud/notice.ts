import { byId } from "../dom";

/** Le bandeau reste tant de secondes. */
const NOTICE_TIME = 9;

/**
 * Un bandeau en haut de l'écran, quelques secondes : ce qui vient d'arriver à la partie et que le
 * joueur doit savoir, comme une simulation qui s'est arrêtée sur une erreur et la partie qui reprend
 * (le serveur l'a relancée ; en solo, le Worker de la simulation du TypeScript remplace celui de la
 * Rust). Le même style que celui de la carte graphique (hud/gpuNotice.ts), sans bouton.
 */
export class Notice {
  private readonly box = byId("simNotice");
  private readonly text = byId("simNoticeText");
  private timer = 0;

  show(text: string, seconds = NOTICE_TIME): void {
    this.text.textContent = text;
    this.box.hidden = false;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => (this.box.hidden = true), seconds * 1000);
  }
}
