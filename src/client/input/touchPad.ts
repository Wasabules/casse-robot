import { clamp } from "../../shared/math/scalar";
import { byId } from "../dom";

/** Zone morte du manche, en part de son rayon. */
const DEAD_ZONE = 0.12;

/**
 * Commandes tactiles en pilotant : un manche à gauche (avancer, tourner ; en avion, gaz et
 * virage), et à droite des boutons à tenir (tir, viseur, monter, descendre, sprint). On vise au centre de
 * l'écran (réticule) ; glisser ailleurs sur l'écran tourne la caméra (voir controls.ts).
 */
export class TouchPad {
  /** Manche, de -1 à 1 : avancer, et tourner (> 0 : à gauche). */
  throttle = 0;
  steer = 0;
  /** Boutons tenus. */
  climb = 0;
  boost = false;
  fire = false;
  scope = false;

  private readonly root = byId("touchPad");
  private readonly stick = byId("tpStick");
  private readonly knob = byId("tpKnob");
  private readonly held = new Set<string>();
  private stickPointer: number | null = null;
  private shown = false;

  constructor() {
    this.stick.addEventListener("pointerdown", (e) => {
      this.stickPointer = e.pointerId;
      this.stick.setPointerCapture(e.pointerId);
      this.moveStick(e);
    });
    this.stick.addEventListener("pointermove", (e) => {
      if (e.pointerId === this.stickPointer) this.moveStick(e);
    });
    const release = (e: PointerEvent): void => {
      if (e.pointerId !== this.stickPointer) return;
      this.stickPointer = null;
      this.centerStick();
    };
    this.stick.addEventListener("pointerup", release);
    this.stick.addEventListener("pointercancel", release);

    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-hold]")) {
      const role = button.dataset.hold!;
      const set = (on: boolean): void => {
        if (on) this.held.add(role);
        else this.held.delete(role);
        button.classList.toggle("held", on);
        this.readButtons();
      };
      button.addEventListener("pointerdown", (e) => {
        button.setPointerCapture(e.pointerId);
        set(true);
      });
      for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) button.addEventListener(type, () => set(false));
      button.addEventListener("contextmenu", (e) => e.preventDefault());
    }
  }

  /** Commandes visibles ou non ; cachées, elles sont relâchées. */
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

  private moveStick(e: PointerEvent): void {
    const rect = this.stick.getBoundingClientRect();
    const radius = rect.width / 2;
    let x = (e.clientX - (rect.left + radius)) / radius;
    let y = (e.clientY - (rect.top + radius)) / radius;
    const length = Math.hypot(x, y);
    if (length > 1) {
      x /= length;
      y /= length;
    }
    const knob = radius * 0.6;
    this.knob.style.transform = `translate(${x * knob}px, ${y * knob}px)`;
    const dead = (v: number): number => (Math.abs(v) < DEAD_ZONE ? 0 : clamp(v, -1, 1));
    this.throttle = dead(-y);
    this.steer = dead(-x);
  }

  private centerStick(): void {
    this.knob.style.transform = "";
    this.throttle = 0;
    this.steer = 0;
  }

  private readButtons(): void {
    this.fire = this.held.has("fire");
    this.scope = this.held.has("scope");
    this.boost = this.held.has("boost");
    this.climb = (this.held.has("up") ? 1 : 0) - (this.held.has("down") ? 1 : 0);
  }

  private reset(): void {
    this.held.clear();
    for (const b of this.root.querySelectorAll(".held")) b.classList.remove("held");
    this.readButtons();
    this.stickPointer = null;
    this.centerStick();
  }
}
