import type { MusicChange, MusicNow, Track } from "../audio/music";
import { byId } from "../dom";
import { t } from "../i18n/i18n";
import { onLocaleChange } from "../i18n/state";
import type { MusicPlayerMode } from "../settings";

/** Durée du mot qui annonce un morceau (ms). */
const TOAST_MS = 4500;
/**
 * Lecteur qui se réduit tout seul : le temps qu'il reste déplié après un changement de morceau, ou
 * après le dernier geste du joueur sur lui (ms). Un peu plus que le mot d'un morceau en partie : le
 * temps de lire le titre, et de toucher « suivant ».
 */
export const UNFOLD_MS = 6000;

/** Titre d'un morceau, dans la langue affichée. */
export const trackTitle = (track: Track): string => t(`music.title.${track}`);

/** L'écran d'une musique, dans la langue affichée : celui d'un morceau, ou le motif de fin. */
export function musicScreen(now: MusicNow): string {
  if (now.theme) return t(`music.theme.${now.theme}`);
  return now.stinger ? t(`music.stinger.${now.stinger}`) : "";
}

/**
 * Un changement de musique s'annonce-t-il (un mot quelques secondes en partie ; dans les menus, la
 * ligne qui s'éclaire, et se déplie si elle était réduite) ? `toast` : un morceau d'écran commence,
 * ou le joueur a demandé autre chose (`asked`). Le lecteur caché n'annonce que ce que le joueur a
 * demandé (en partie, au clavier : c'est tout ce qui lui répond).
 */
export function announces(mode: MusicPlayerMode, toast: boolean, asked: boolean): boolean {
  return toast && (mode !== "hidden" || asked);
}

/**
 * Le lecteur des menus et du garage, déplié ou réduit à sa pastille (logique pure, en millisecondes :
 * tests/nowPlaying.test.ts). Toujours déplié (`always`), caché (`hidden`), ou qui se réduit tout seul
 * (`auto`) : déplié quand un morceau commence (`unfold`) ou que le joueur touche la pastille
 * (`toggle`), il se réduit `UNFOLD_MS` après, ou après le dernier geste du joueur sur lui (`touch`),
 * mais pas tant que le joueur s'en sert ou qu'il est caché par un écran de chargement (`tick`, `held`).
 */
export class PlayerFold {
  private mode: MusicPlayerMode = "always";
  private open = true;
  private until: number | null = null;

  /** Le réglage (voir `MusicPlayerMode`). */
  get setting(): MusicPlayerMode {
    return this.mode;
  }

  /** Réduit à sa pastille (seulement quand il se réduit tout seul). */
  get folded(): boolean {
    return this.mode === "auto" && !this.open;
  }

  /** Quand il se réduira (ms), s'il doit le faire ; null sinon. */
  get due(): number | null {
    return this.mode === "auto" && this.open ? this.until : null;
  }

  /** Change le réglage ; passé à « se réduit tout seul », il est réduit d'emblée. */
  setMode(mode: MusicPlayerMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.open = mode !== "auto";
    this.until = null;
  }

  /** Un morceau commence, ou le joueur déplie la pastille : déplié pour `UNFOLD_MS`. */
  unfold(now: number): void {
    this.open = true;
    this.until = now + UNFOLD_MS;
  }

  /** Le joueur se sert du lecteur déplié (un toucher, la souris qui le quitte, le focus qui en sort) : le délai repart. */
  touch(now: number): void {
    if (this.open) this.until = now + UNFOLD_MS;
  }

  /** Le joueur le réduit. */
  fold(): void {
    this.open = false;
    this.until = null;
  }

  /** La note (la pastille, ou l'icône du lecteur déplié) : déplie ou réduit ; rien s'il ne se réduit pas tout seul. */
  toggle(now: number): void {
    if (this.mode !== "auto") return;
    if (this.folded) this.unfold(now);
    else this.fold();
  }

  /**
   * Le temps passe : à l'échéance, il se réduit, sauf si `held` (le joueur s'en sert : la souris
   * dessus, le focus dedans ; ou un écran de chargement le cache) : il attend encore `UNFOLD_MS`.
   * Rend vrai s'il vient de se réduire.
   */
  tick(now: number, held: boolean): boolean {
    const due = this.due;
    if (due === null || now < due) return false;
    if (held) {
      this.until = now + UNFOLD_MS;
      return false;
    }
    this.fold();
    return true;
  }
}

/** Ce que le lecteur annonce, en plus de ce qu'on entend : un morceau illisible, aucun précédent. */
type Note = { change: "failed"; track: Track } | { change: "none" };

/** Ce que dit `NowPlaying.update` : la musique qui a changé, et s'il faut l'annoncer. */
export interface MusicUpdate {
  now: MusicNow;
  change: MusicChange;
  /** Un morceau d'écran commence, ou le joueur a demandé autre chose : le mot (ou l'éclat de la ligne). */
  toast: boolean;
  /** Le joueur l'a demandé (boutons, touches) : le lecteur caché l'annonce quand même. */
  asked: boolean;
  /** Le morceau illisible (`failed`). */
  track?: Track | null;
}

/**
 * Le lecteur de musique (index.html, `#nowPlaying`) : en partie, quand un morceau commence ou que
 * le joueur en change, un mot dit son titre quelques secondes, sous la mini-carte (`flash`) ; dans
 * les menus et au garage (`body.menu-open`, `body.in-garage` : style.css), la ligne de la musique
 * en cours reste en bas à droite (en haut sur un écran étroit), avec ses boutons « précédent » et
 * « suivant », et s'éclaire quand le morceau change. Selon le réglage (`setMode`) : toujours dépliée,
 * réduite d'elle-même à une pastille (la note) quelques secondes après un changement (`PlayerFold` ;
 * un toucher, un clic ou Entrée sur la note la déplie ou la réduit), ou cachée. Un morceau demandé
 * qui se prépare encore (un précédent déjà libéré) le dit (« chargement »). Rien pendant un
 * chargement ni dans l'éditeur de cartes, ni quand la musique est coupée (`setMuted` : le son, ou
 * son volume, à zéro).
 */
export class NowPlaying {
  private readonly el = byId("nowPlaying");
  private readonly label = byId("npLabel");
  private readonly title = byId("npTitle");
  private readonly toggle = byId<HTMLButtonElement>("npToggle");
  private readonly prev = byId<HTMLButtonElement>("npPrev");
  private readonly next = byId<HTMLButtonElement>("npNext");
  private readonly fold = new PlayerFold();
  private now: MusicNow | null = null;
  private note: Note | null = null;
  private timer = 0;
  private foldTimer = 0;
  /** La souris est sur le lecteur (il ne se réduit pas sous elle). */
  private hovered = false;

  constructor(actions: { previous: () => void; next: () => void; toggle?: () => void }) {
    this.prev.addEventListener("click", actions.previous);
    this.next.addEventListener("click", actions.next);
    this.toggle.addEventListener("click", () => {
      if (this.fold.setting !== "auto") return;
      actions.toggle?.();
      this.fold.toggle(performance.now());
      this.render();
      this.scheduleFold();
    });
    // Un clic ou un toucher sur un bouton ne doit pas lui laisser le focus (Espace, Entrée le rejoueraient
    // en partie ; et le lecteur ne se réduirait plus, le croyant tenu). Au doigt, le navigateur le donne
    // après le `pointerup` (au `mousedown` émulé) : on l'enlève au clic, sauf venu du clavier (`detail` 0)
    for (const b of [this.prev, this.next, this.toggle]) {
      b.addEventListener("click", (e) => {
        if (e.detail > 0) b.blur();
      });
    }
    // Le joueur se sert du lecteur déplié : il ne se réduit pas sous ses doigts
    this.el.addEventListener("pointerdown", () => this.touched());
    this.el.addEventListener("pointerenter", (e) => {
      if (e.pointerType === "mouse") this.hovered = true;
    });
    this.el.addEventListener("pointerleave", () => {
      this.hovered = false;
      this.touched();
    });
    this.el.addEventListener("focusout", () => this.touched());
    onLocaleChange(() => this.render());
    this.render();
  }

  /** La musique est coupée (réglages : le son, le volume général ou celui de la musique à zéro) : le lecteur ne se montre pas. */
  setMuted(muted: boolean): void {
    this.el.classList.toggle("np-muted", muted);
  }

  /** Le réglage du lecteur : toujours déplié, qui se réduit tout seul, ou caché. */
  setMode(mode: MusicPlayerMode): void {
    if (mode === this.fold.setting) return;
    this.fold.setMode(mode);
    this.el.classList.toggle("np-auto", mode === "auto");
    this.el.classList.toggle("np-hidden", mode === "hidden");
    this.render();
    this.scheduleFold();
  }

  /** La musique a changé (voir `MusicUpdate`). */
  update({ now, change, toast, asked, track = null }: MusicUpdate): void {
    this.now = now;
    if (change === "failed" && track) this.note = { change, track };
    else if (change === "none") this.note = { change };
    else this.note = null;
    if (announces(this.fold.setting, toast, asked)) {
      this.fold.unfold(performance.now());
      this.scheduleFold();
      this.render();
      this.flash();
    } else {
      this.render();
    }
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

  /** Le joueur s'est servi du lecteur déplié : le délai avant qu'il se réduise repart. */
  private touched(): void {
    this.fold.touch(performance.now());
    this.scheduleFold();
  }

  /** Programme la réduction du lecteur à son échéance (`PlayerFold.due`), s'il en a une. */
  private scheduleFold(): void {
    window.clearTimeout(this.foldTimer);
    const due = this.fold.due;
    if (due === null) return;
    this.foldTimer = window.setTimeout(() => {
      // (la souris dessus, le focus dedans, ou un écran de chargement qui le cache : il attend)
      const hovered = this.hovered && this.el.matches(":hover");
      const held = hovered || this.el.contains(document.activeElement) || document.body.classList.contains("loading-open");
      if (this.fold.tick(performance.now(), held)) this.render();
      this.scheduleFold();
    }, Math.max(0, due - performance.now()) + 20);
  }

  private render(): void {
    const now = this.now;
    const note = this.note;
    const shown = now?.pending ?? now?.track ?? null;
    this.el.classList.toggle("np-on", !!shown);
    this.el.classList.toggle("np-loading", !!now?.pending);
    this.el.classList.toggle("np-bad", note?.change === "failed");
    this.el.classList.toggle("np-folded", this.fold.folded);
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
    // La note : un bouton quand le lecteur se réduit tout seul (déplier, réduire) ; sinon, une simple icône
    const foldable = this.fold.setting === "auto";
    this.toggle.inert = !foldable;
    if (foldable) {
      const folded = this.fold.folded;
      const label = folded ? t("music.unfold") : t("music.fold");
      this.toggle.title = label;
      this.toggle.setAttribute("aria-label", label);
      this.toggle.setAttribute("aria-expanded", String(!folded));
    } else {
      this.toggle.removeAttribute("title");
      this.toggle.removeAttribute("aria-label");
      this.toggle.removeAttribute("aria-expanded");
    }
  }
}
