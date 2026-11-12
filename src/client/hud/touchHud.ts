import { byId } from "../dom";
import { t, type MessageKey } from "../i18n/i18n";
import { onLocaleChange } from "../i18n/state";

/*
 * Jouer au doigt (téléphone, tablette) : ce que la page ajoute quand on joue au doigt, en plus des
 * commandes tactiles (input/touchPad.ts). La classe `touch-ui` de la page (un pointeur grossier,
 * ou un premier toucher) ; en partie, un bouton de pause (pas de touche Échap sur un téléphone :
 * le plein écran est dans le menu pause, comme à l'accueil, hud/fullscreen.ts) ; et, téléphone
 * tenu en hauteur, une invitation à le tourner (style.css). Pendant la partie, la page ne se zoome
 * pas d'un pincement ni ne défile (style.css : `touch-action`, `overscroll-behavior` ; Safari :
 * `gesturestart`).
 */

/** Les écrans faits pour la souris, et ce qu'on y dit à qui joue au doigt. */
export type TouchNote = "garage" | "editor";
const NOTES = { garage: "hud.page.touchGarage", editor: "hud.page.touchEditor" } as const satisfies Record<TouchNote, MessageKey>;

export class TouchHud {
  /** Le bouton de pause : la partie se met en pause (comme Échap). */
  onPause: (() => void) | null = null;
  private touch = false;
  /** Le mot affiché (au garage, dans l'éditeur), et ceux que le joueur a fermés pendant cette visite. */
  private noteKind: TouchNote | null = null;
  private readonly dismissed = new Set<TouchNote>();

  constructor() {
    byId("touchNoteClose").addEventListener("click", () => {
      if (this.noteKind) this.dismissed.add(this.noteKind);
      this.note(null);
    });
    if (window.matchMedia?.("(pointer: coarse)").matches) this.enable();
    // Un premier toucher (une tablette avec clavier, un ordinateur à écran tactile)
    window.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") this.enable();
    }, { capture: true, passive: true });
    byId("thPause").addEventListener("click", () => this.onPause?.());
    // Safari : pas de zoom d'un pincement pendant la partie (il ne respecte pas toujours `touch-action`)
    document.addEventListener("gesturestart", (e) => {
      if (!document.body.classList.contains("menu-open")) e.preventDefault();
    });
    onLocaleChange(() => {
      if (this.noteKind) byId("touchNoteText").textContent = t(NOTES[this.noteKind]);
    });
  }

  /** Joue-t-on au doigt ? */
  get active(): boolean {
    return this.touch;
  }

  /**
   * Au doigt, au garage ou dans l'éditeur de cartes (faits pour la souris et le clavier) : un mot dit
   * ce qui marche au doigt et ce qui demande une souris, jusqu'à ce que le joueur le ferme. Null : aucun.
   */
  note(kind: TouchNote | null): void {
    const show = !!kind && this.touch && !this.dismissed.has(kind);
    this.noteKind = show ? kind : null;
    byId("touchNote").hidden = !show;
    if (show) byId("touchNoteText").textContent = t(NOTES[kind]);
  }

  private enable(): void {
    if (this.touch) return;
    this.touch = true;
    document.body.classList.add("touch-ui");
  }
}
