import { clamp } from "../../shared/math/scalar";
import { byId } from "../dom";
import { stickPosition, type TouchLook } from "./touchLook";

/** Zone morte du manche de déplacement, sur chaque axe, en part de son rayon. */
const DEAD_ZONE = 0.12;

/** Disposition des commandes à l'écran (réglages, onglet Tactile). */
export interface TouchLayout {
  /** Visée en glissant le doigt, ou au manche de visée (à droite). */
  aim: "swipe" | "stick";
  /** Le bouton du viseur bascule (un appui le met, un autre l'enlève) au lieu d'être tenu. */
  scopeToggle: boolean;
  /** Gaucher : le manche de déplacement à droite, la visée et les boutons à gauche. */
  leftHanded: boolean;
  /** Taille des commandes (1 : celle d'origine), et leur opacité. */
  size: number;
  opacity: number;
}

/**
 * Un manche à l'écran : le doigt qui l'a pris (son `pointerId`) le déplace, jusqu'à ce qu'il se lève.
 * Sa position est dans le disque unité (y > 0 : vers le bas), sans zone morte (chacun la sienne).
 */
class Stick {
  x = 0;
  y = 0;
  private pointer: number | null = null;
  private readonly el: HTMLElement;
  private readonly knob: HTMLElement;

  constructor(el: HTMLElement, knob: HTMLElement) {
    this.el = el;
    this.knob = knob;
    el.addEventListener("pointerdown", (e) => {
      // (un second doigt sur un manche déjà pris ne le prend pas)
      if (this.pointer !== null) return;
      this.pointer = e.pointerId;
      el.setPointerCapture(e.pointerId);
      this.move(e);
    });
    el.addEventListener("pointermove", (e) => {
      if (e.pointerId === this.pointer) this.move(e);
    });
    const release = (e: PointerEvent): void => {
      if (e.pointerId !== this.pointer) return;
      this.release();
    };
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) el.addEventListener(type, release);
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  private move(e: PointerEvent): void {
    // (le rectangle du manche visible : la zone qu'on peut toucher autour de lui est plus grande)
    const rect = this.el.getBoundingClientRect();
    const radius = rect.width / 2;
    const p = stickPosition(e.clientX - (rect.left + radius), e.clientY - (rect.top + radius), radius);
    this.x = p.x;
    this.y = p.y;
    const reach = radius * 0.6;
    this.knob.style.transform = `translate(${p.x * reach}px, ${p.y * reach}px)`;
  }

  /** Le doigt se lève (ou les commandes se cachent) : le manche revient au centre. */
  release(): void {
    this.pointer = null;
    this.x = 0;
    this.y = 0;
    this.knob.style.transform = "";
  }
}

/**
 * Commandes tactiles en pilotant : un manche à gauche (avancer, tourner ; en avion, gaz et virage), et
 * à droite des boutons (tir, viseur, monter, descendre, turbo) et, si on vise au manche, le manche de
 * visée. On vise au réticule ; glisser le doigt ailleurs sur l'écran tourne la caméra (controls.ts),
 * même quand on vise au manche : le manche tourne en vitesse (les grands virages), le glissé corrige
 * finement (et un doigt qui manque le manche ne s'y perd pas). Le bouton de tir se fait glisser : on
 * vise en tirant, le pouce posé sur lui (un seul doigt tourne la caméra à la fois : `TouchLook`).
 */
export class TouchPad {
  /** Manche de déplacement, de -1 à 1 : avancer, et tourner (> 0 : à gauche). */
  throttle = 0;
  steer = 0;
  /** Boutons tenus. */
  climb = 0;
  boost = false;
  fire = false;
  /** Au viseur : bouton tenu, ou basculé (`layout.scopeToggle`). */
  scope = false;

  private readonly root = byId("touchPad");
  private readonly move: Stick;
  /** Manche de visée (visée au manche). */
  readonly aim: Stick;
  private readonly held = new Set<string>();
  private readonly scopeButton: HTMLButtonElement;
  private scopeOn = false;
  private shown = false;
  private layout: TouchLayout = { aim: "swipe", scopeToggle: true, leftHanded: false, size: 1, opacity: 1 };

  /** `look` : les doigts qui tournent la caméra (le bouton de tir qu'on fait glisser en est un). */
  constructor(look: TouchLook) {
    this.move = new Stick(byId("tpStick"), byId("tpKnob"));
    this.aim = new Stick(byId("tpAim"), byId("tpAimKnob"));
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"] as const) {
      byId("tpStick").addEventListener(type, () => this.readStick());
    }
    this.scopeButton = this.root.querySelector<HTMLButtonElement>("[data-hold=scope]")!;

    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-hold]")) {
      const role = button.dataset.hold!;
      const set = (on: boolean): void => {
        if (on) this.held.add(role);
        else this.held.delete(role);
        button.classList.toggle("held", on);
        this.readButtons();
      };
      let pointer: number | null = null;
      button.addEventListener("pointerdown", (e) => {
        if (pointer !== null) return;
        pointer = e.pointerId;
        button.setPointerCapture(e.pointerId);
        // Le viseur qui bascule : un appui le met, un autre l'enlève
        if (role === "scope" && this.layout.scopeToggle) {
          this.scopeOn = !this.scopeOn;
          this.readButtons();
          return;
        }
        set(true);
        // Tir : le doigt posé dessus peut glisser pour viser en tirant
        if (role === "fire") look.down(e.pointerId, e.clientX, e.clientY, performance.now());
      });
      button.addEventListener("pointermove", (e) => {
        if (role === "fire" && e.pointerId === pointer) look.move(e.pointerId, e.clientX, e.clientY);
      });
      const release = (e: PointerEvent): void => {
        if (e.pointerId !== pointer) return;
        pointer = null;
        if (role === "fire") look.cancel(e.pointerId);
        if (role === "scope" && this.layout.scopeToggle) return;
        set(false);
      };
      for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) button.addEventListener(type, release);
      button.addEventListener("contextmenu", (e) => e.preventDefault());
    }
  }

  /** Commandes visibles ou non ; cachées, elles sont relâchées (le viseur basculé aussi). */
  show(on: boolean): void {
    if (on === this.shown) return;
    this.shown = on;
    this.root.hidden = !on;
    document.body.classList.toggle("touch-pilot", on);
    if (!on) this.reset();
  }

  get visible(): boolean {
    return this.shown;
  }

  /** Disposition, taille et opacité des commandes (réglages). */
  configure(layout: TouchLayout): void {
    const was = this.layout;
    this.layout = { ...layout };
    const root = this.root;
    root.classList.toggle("aim-stick", layout.aim === "stick");
    root.classList.toggle("lefty", layout.leftHanded);
    root.style.setProperty("--tp-scale", String(layout.size));
    root.style.setProperty("--tp-alpha", String(layout.opacity));
    if (layout.aim !== "stick") this.aim.release();
    // Le viseur passe de basculé à tenu (ou l'inverse) : on repart sans viseur
    if (was.scopeToggle !== layout.scopeToggle) {
      this.scopeOn = false;
      this.held.delete("scope");
      this.readButtons();
    }
  }

  /** Visée au manche : la position du manche de visée (disque unité ; nulle sinon). */
  get aimStick(): { x: number; y: number } {
    return this.layout.aim === "stick" ? { x: this.aim.x, y: this.aim.y } : { x: 0, y: 0 };
  }

  private readStick(): void {
    const dead = (v: number): number => (Math.abs(v) < DEAD_ZONE ? 0 : clamp(v, -1, 1));
    this.throttle = dead(-this.move.y);
    this.steer = dead(-this.move.x);
  }

  private readButtons(): void {
    this.fire = this.held.has("fire");
    this.scope = this.layout.scopeToggle ? this.scopeOn : this.held.has("scope");
    this.scopeButton.classList.toggle("held", this.scope);
    this.boost = this.held.has("boost");
    this.climb = (this.held.has("up") ? 1 : 0) - (this.held.has("down") ? 1 : 0);
  }

  private reset(): void {
    this.held.clear();
    this.scopeOn = false;
    for (const b of this.root.querySelectorAll(".held")) b.classList.remove("held");
    this.readButtons();
    this.move.release();
    this.aim.release();
    this.readStick();
  }
}
