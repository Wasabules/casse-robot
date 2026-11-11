import { byId } from "../dom";

/** Durée d'affichage d'un marqueur de touche, selon ce qu'il annonce (ms). */
const MARKER_TIME = { hit: 140, crit: 220, kill: 600 } as const;
/** Durée d'un arc de dégâts reçus (ms). */
const DAMAGE_TIME = 1300;

export type MarkerKind = keyof typeof MARKER_TIME;

/**
 * Retour de tir du joueur : un marqueur autour du réticule quand un de ses tirs touche (plus
 * marqué quand il détruit des blocs, et encore plus quand il détruit un robot), et un arc autour
 * du centre de l'écran vers l'endroit d'où on le touche.
 */
export class HitFeedback {
  private readonly marker = byId("hitMarker");
  private readonly ring = byId("damageRing");
  private markerTimer = 0;
  /** Arcs affichés, par robot qui tire : leur élément et leur heure de fin. */
  private readonly arcs = new Map<number, { el: HTMLElement; until: number }>();

  /** Marqueur en (x, y) (px, dans la fenêtre). Un marqueur plus fort n'est pas remplacé par un plus faible. */
  showMarker(x: number, y: number, kind: MarkerKind): void {
    const current = this.marker.dataset.kind as MarkerKind | undefined;
    const rank = { hit: 0, crit: 1, kill: 2 };
    if (!this.marker.hidden && current && rank[current] > rank[kind]) return;
    this.marker.style.left = `${x}px`;
    this.marker.style.top = `${y}px`;
    this.marker.dataset.kind = kind;
    this.marker.hidden = false;
    clearTimeout(this.markerTimer);
    this.markerTimer = window.setTimeout(() => (this.marker.hidden = true), MARKER_TIME[kind]);
  }

  /** Dégâts reçus depuis la direction `angle` (rad, 0 : devant à l'écran, > 0 : à droite), tirés par `source`. */
  damageFrom(angle: number, source: number): void {
    let arc = this.arcs.get(source);
    if (!arc) {
      const el = document.createElement("div");
      el.className = "dmg-arc";
      this.ring.append(el);
      arc = { el, until: 0 };
      this.arcs.set(source, arc);
    }
    arc.el.style.transform = `rotate(${angle}rad)`;
    arc.el.style.opacity = "1";
    arc.until = performance.now() + DAMAGE_TIME;
  }

  /** Les arcs s'effacent, puis disparaissent. */
  update(): void {
    const now = performance.now();
    for (const [source, arc] of this.arcs) {
      const left = arc.until - now;
      if (left <= 0) {
        arc.el.remove();
        this.arcs.delete(source);
      } else {
        arc.el.style.opacity = String(Math.min(1, left / 500));
      }
    }
  }

  clear(): void {
    this.marker.hidden = true;
    for (const arc of this.arcs.values()) arc.el.remove();
    this.arcs.clear();
  }
}
