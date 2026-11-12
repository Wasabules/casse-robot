import type { MusicChange, MusicNow, Track } from "../audio/music";
import { byId } from "../dom";
import { t } from "../i18n/i18n";
import { onLocaleChange } from "../i18n/state";

/** Durée du mot qui annonce un morceau (ms). */
const TOAST_MS = 4500;

/** Titre d'un morceau, dans la langue affichée. */
export const trackTitle = (track: Track): string => t(`music.title.${track}`);

/** L'écran d'une musique, dans la langue affichée : celui d'un morceau, ou le motif de fin. */
export function musicScreen(now: MusicNow): string {
  if (now.theme) return t(`music.theme.${now.theme}`);
  return now.stinger ? t(`music.stinger.${now.stinger}`) : "";
}

/** Ce que le lecteur annonce, en plus de ce qu'on entend : un morceau illisible, aucun précédent. */
type Note = { change: "failed"; track: Track } | { change: "none" };

/**
 * Le lecteur de musique (index.html, `#nowPlaying`) : en partie, quand un morceau commence ou que
 * le joueur en change, un mot dit son titre quelques secondes, sous la mini-carte (`flash`) ; dans
 * les menus et au garage (`body.menu-open`, `body.in-garage` : style.css), la ligne de la musique
 * en cours reste en bas à droite, avec ses boutons « précédent » et « suivant », et s'éclaire quand
 * le morceau change. Un morceau demandé qui se prépare
 * encore (un précédent déjà libéré) le dit (« chargement »). Rien pendant un chargement ni dans
 * l'éditeur de cartes, ni quand la musique est coupée (`setMuted` : le son, ou son volume, à zéro).
 */
export class NowPlaying {
  private readonly el = byId("nowPlaying");
  private readonly label = byId("npLabel");
  private readonly title = byId("npTitle");
  private readonly prev = byId<HTMLButtonElement>("npPrev");
  private readonly next = byId<HTMLButtonElement>("npNext");
  private now: MusicNow | null = null;
  private note: Note | null = null;
  private timer = 0;

  constructor(actions: { previous: () => void; next: () => void }) {
    this.prev.addEventListener("click", actions.previous);
    this.next.addEventListener("click", actions.next);
    // Un clic sur un bouton ne doit pas garder le focus (Espace, Entrée le rejoueraient en partie)
    for (const b of [this.prev, this.next]) b.addEventListener("pointerup", () => b.blur());
    onLocaleChange(() => this.render());
    this.render();
  }

  /** La musique est coupée (réglages : le son, le volume général ou celui de la musique à zéro) : le lecteur ne se montre pas. */
  setMuted(muted: boolean): void {
    this.el.classList.toggle("np-muted", muted);
  }

  /** La musique a changé (voir `MusicChange`) ; `toast` : l'annoncer quelques secondes. */
  update(now: MusicNow, change: MusicChange, toast: boolean, track: Track | null = null): void {
    this.now = now;
    if (change === "failed" && track) this.note = { change, track };
    else if (change === "none") this.note = { change };
    else this.note = null;
    this.render();
    if (toast) this.flash();
  }

  /** Le mot s'affiche (ou, dans les menus, la ligne s'éclaire), puis s'efface. */
  private flash(): void {
    window.clearTimeout(this.timer);
    // Relancer l'animation d'entrée
    this.el.classList.remove("np-toast");
    void this.el.offsetWidth;
    this.el.classList.add("np-toast");
    this.timer = window.setTimeout(() => {
      this.el.classList.remove("np-toast");
      // La note (illisible, aucun précédent) ne dure que le temps du mot
      if (this.note) {
        this.note = null;
        this.render();
      }
    }, TOAST_MS);
  }

  private render(): void {
    const now = this.now;
    const note = this.note;
    const shown = now?.pending ?? now?.track ?? null;
    this.el.classList.toggle("np-on", !!shown);
    this.el.classList.toggle("np-loading", !!now?.pending);
    this.el.classList.toggle("np-bad", note?.change === "failed");
    if (!now || !shown) {
      this.label.textContent = "";
      this.title.textContent = "";
    } else if (note?.change === "failed") {
      this.label.textContent = t("music.failed");
      this.title.textContent = trackTitle(note.track);
    } else if (note?.change === "none") {
      this.label.textContent = t("music.none");
      this.title.textContent = trackTitle(shown);
    } else {
      this.label.textContent = now.pending ? t("music.loading") : t("music.label", { screen: musicScreen(now) });
      this.title.textContent = trackTitle(shown);
    }
    const canSkip = !!now?.canSkip;
    this.next.disabled = !canSkip;
    this.prev.disabled = !canSkip || !now?.previous;
    const next = t("music.next");
    const prev = now?.previous ? t("music.previousTo", { title: trackTitle(now.previous) }) : t("music.previous");
    this.next.title = next;
    this.next.setAttribute("aria-label", next);
    this.prev.title = prev;
    this.prev.setAttribute("aria-label", prev);
  }
}
