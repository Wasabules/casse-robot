import { byId } from "../dom";
import { t } from "../i18n/i18n";

/*
 * Écran de chargement (balisage dans index.html) : au démarrage du jeu (physique, sons, musique,
 * shaders), puis avant chaque partie (arène, robots, effets, musique de la partie). Opaque : la
 * scène qu'on prépare derrière (la préparation pose un exemplaire de chaque effet devant la
 * caméra) ne se voit pas. Une barre de progression et l'étape en cours ; au démarrage, s'il faut un
 * geste du joueur pour entendre le son, il finit par un bouton « Cliquer pour commencer ».
 */
export class LoadingScreen {
  private readonly root = byId("loading");
  private readonly subtitle = byId("loadingSubtitle");
  private readonly fill = byId("loadingFill");
  private readonly step = byId("loadingStep");
  private readonly go = byId<HTMLButtonElement>("loadingGo");
  /** Part affichée : la barre n'avance que vers l'avant (des étapes en parallèle se recouvrent). */
  private shown = 0;

  /** L'écran est-il affiché ? */
  get visible(): boolean {
    return !this.root.hidden;
  }

  /** Affiche l'écran, barre à zéro ; `subtitle` : ce qu'on charge (« Bataille · Dépôt · Char »). */
  show(subtitle: string): void {
    this.root.hidden = false;
    this.root.classList.remove("await-click");
    this.go.hidden = true;
    this.subtitle.textContent = subtitle;
    this.shown = 0;
    this.progress(0, t("menu.loading.default"));
    document.body.classList.add("loading-open");
  }

  /** La part faite (0 à 1) et l'étape en cours. */
  progress(done: number, step: string): void {
    this.shown = Math.max(this.shown, Math.min(1, done));
    this.fill.style.width = `${(this.shown * 100).toFixed(1)}%`;
    this.root.setAttribute("aria-valuenow", String(Math.round(this.shown * 100)));
    this.step.textContent = step;
  }

  /**
   * Tout est prêt, mais le navigateur attend un geste pour jouer le son : un bouton (ou Entrée,
   * Espace, un clic n'importe où sur l'écran). `onGesture` est appelé pendant le geste lui-même
   * (le son ne se débloque que là) ; la promesse se résout ensuite.
   */
  awaitClick(label: string, onGesture: () => void): Promise<void> {
    this.progress(1, t("menu.loading.ready"));
    this.root.classList.add("await-click");
    this.go.hidden = false;
    this.go.querySelector(".menu-label")!.textContent = label;
    this.go.focus();
    return new Promise((resolve) => {
      const done = (e: Event): void => {
        if (e instanceof KeyboardEvent && e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        this.root.removeEventListener("pointerdown", done);
        window.removeEventListener("keydown", done);
        onGesture();
        resolve();
      };
      this.root.addEventListener("pointerdown", done);
      window.addEventListener("keydown", done);
    });
  }

  hide(): void {
    this.root.hidden = true;
    this.root.classList.remove("await-click");
    document.body.classList.remove("loading-open");
  }
}

/** Laisse le navigateur dessiner l'écran (deux images) avant un long travail synchrone. */
export function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}
