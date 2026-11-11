import { byId } from "../dom";

/** Voile plein écran affiché pendant le chargement, ou en cas d'erreur fatale. */

export function hideOverlay(): void {
  byId("overlay").hidden = true;
}

export function showError(message: string): void {
  const overlay = byId("overlay");
  overlay.hidden = false;
  overlay.classList.add("err");
  byId("overlayText").textContent = message;
}
