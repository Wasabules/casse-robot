import { byId } from "../dom";
import { t, type MessageKey } from "../i18n/i18n";
import { onLocaleChange } from "../i18n/state";

/*
 * Jouer au doigt (téléphone, tablette) : ce que la page ajoute quand on joue au doigt, en plus des
 * commandes tactiles (input/touchPad.ts). La classe `touch-ui` de la page (un pointeur grossier,
 * ou un premier toucher) ; en partie, un bouton de pause (pas de touche Échap sur un téléphone) et
 * un bouton de plein écran (là où le navigateur le permet : pas sur l'iPhone), qui tourne aussi
 * l'écran à l'horizontale (Android) ; et, téléphone tenu en hauteur, une invitation à le tourner
 * (style.css). Pendant la partie, la page ne se zoome pas d'un pincement ni ne défile (style.css :
 * `touch-action`, `overscroll-behavior` ; Safari : `gesturestart`).
 */

/** Les écrans faits pour la souris, et ce qu'on y dit à qui joue au doigt. */
export type TouchNote = "garage" | "editor";
const NOTES = { garage: "hud.page.touchGarage", editor: "hud.page.touchEditor" } as const satisfies Record<TouchNote, MessageKey>;

/** Le navigateur sait-il mettre la page en plein écran ? */
export function fullscreenSupported(): boolean {
  return typeof document !== "undefined" && !!document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === "function";
}

/** La page est-elle en plein écran ? */
export const isFullscreen = (): boolean => !!document.fullscreenElement;

/**
 * Passe en plein écran, ou en sort. `landscape` : tourne aussi l'écran à l'horizontale (là où le
 * navigateur le permet, en plein écran seulement : Chrome sur Android).
 */
export async function toggleFullscreen(landscape = false): Promise<void> {
  try {
    if (isFullscreen()) {
      await document.exitFullscreen();
      return;
    }
    await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    if (landscape && orientation?.lock) await orientation.lock("landscape").catch(() => undefined);
  } catch {
    // Refusé (pas de geste du joueur, réglage du navigateur) : rien à faire
  }
}

export class TouchHud {
  /** Le bouton de pause : la partie se met en pause (comme Échap). */
  onPause: (() => void) | null = null;
  /** Le plein écran a changé (les menus qui le proposent se redessinent). */
  onFullscreen: (() => void) | null = null;
  private touch = false;
  private readonly fullscreen = byId<HTMLButtonElement>("thFullscreen");
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
    this.fullscreen.hidden = !fullscreenSupported();
    this.fullscreen.addEventListener("click", () => void toggleFullscreen(true));
    document.addEventListener("fullscreenchange", () => {
      this.refresh();
      this.onFullscreen?.();
    });
    // Safari : pas de zoom d'un pincement pendant la partie (il ne respecte pas toujours `touch-action`)
    document.addEventListener("gesturestart", (e) => {
      if (!document.body.classList.contains("menu-open")) e.preventDefault();
    });
    onLocaleChange(() => this.refresh());
    this.refresh();
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

  /** Le bouton de plein écran dit ce qu'il fera ; le mot affiché, dans la langue du moment. */
  private refresh(): void {
    if (this.noteKind) byId("touchNoteText").textContent = t(NOTES[this.noteKind]);
    const label = isFullscreen() ? t("hud.page.exitFullscreen") : t("hud.page.fullscreen");
    this.fullscreen.setAttribute("aria-label", label);
    this.fullscreen.title = label;
    this.fullscreen.classList.toggle("on", isFullscreen());
  }
}
