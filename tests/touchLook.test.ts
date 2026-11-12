import { describe, expect, it } from "vitest";
import {
  DRAG_THRESHOLD, MAX_STEP, STICK_DEADZONE, STICK_PITCH, STICK_YAW, TOUCH_PITCH, TOUCH_YAW,
  stickPosition, stickRates, swipeAngles, TouchLook, type TouchLookSettings,
} from "../src/client/input/touchLook";

const NORMAL: TouchLookSettings = { sensitivity: 1, stickSensitivity: 1, invertY: false };

/** Tout le glissé en attente, rendu en autant d'images qu'il faut (la somme, comme la caméra la verra). */
function drain(look: TouchLook, dt = 1 / 60): { dx: number; dy: number } {
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < 600; i++) {
    const d = look.take(dt);
    dx += d.dx;
    dy += d.dy;
  }
  return { dx, dy };
}

describe("Caméra au doigt : suivi des doigts", () => {
  it("un doigt qui glisse : tout son déplacement (passé le seuil) tourne la caméra", () => {
    const look = new TouchLook();
    look.down(1, 100, 100, 0);
    // Les premiers pixels (sous le seuil) ne comptent pas : un toucher ne fait pas trembler la vue
    look.move(1, 104, 100);
    expect(drain(look)).toEqual({ dx: 0, dy: 0 });
    look.move(1, 110, 100);
    for (let x = 120; x <= 300; x += 10) look.move(1, x, 100 + (x - 110) / 4);
    const d = drain(look);
    expect(d.dx).toBeCloseTo(300 - 104, 6);
    expect(d.dy).toBeCloseTo(47.5, 6);
  });

  it("un second doigt posé pendant un glissé ne fait pas sauter la caméra (la cause des tours complets)", () => {
    const look = new TouchLook();
    look.down(1, 600, 200, 0);
    look.move(1, 620, 200);
    drain(look);
    // Un second doigt, loin du premier (un pouce qui manque un bouton) ; les deux bougent tour à tour
    look.down(2, 150, 300, 10);
    for (let i = 1; i <= 10; i++) {
      look.move(2, 150 + i, 300);
      look.move(1, 620 + i * 2, 200);
    }
    // Seul le premier doigt compte : 20 px, pas les ~470 px d'écart entre les deux doigts à chaque événement
    expect(drain(look).dx).toBeCloseTo(20, 6);
    expect(look.active).toBe(1);
  });

  it("le doigt qui tourne la caméra se lève : le suivant prend la main là où il est, sans saut", () => {
    const look = new TouchLook();
    look.down(1, 600, 200, 0);
    look.down(2, 100, 300, 0);
    look.move(2, 140, 300);
    look.up(1, 50);
    expect(look.active).toBe(2);
    expect(drain(look)).toEqual({ dx: 0, dy: 0 });
    look.move(2, 150, 310);
    const d = drain(look);
    expect(d.dx).toBeCloseTo(10, 9);
    expect(d.dy).toBeCloseTo(10, 9);
    look.up(2, 100);
    expect(look.active).toBeNull();
    expect(look.count).toBe(0);
  });

  it("un tapotement : bref et sans glisser ; un geste annulé n'en est pas un", () => {
    const look = new TouchLook();
    look.down(5, 10, 10, 1000);
    look.move(5, 13, 12);
    expect(look.up(5, 1200)).toBe(true);
    look.down(6, 10, 10, 1000);
    expect(look.up(6, 1000 + 500)).toBe(false);
    look.down(7, 10, 10, 1000);
    look.move(7, 10 + DRAG_THRESHOLD + 1, 10);
    expect(look.up(7, 1100)).toBe(false);
    look.down(8, 10, 10, 1000);
    look.cancel(8);
    expect(look.count).toBe(0);
    // Un doigt inconnu (déjà levé) : rien
    expect(look.up(42, 0)).toBe(false);
  });

  it("un saut d'un seul événement est borné", () => {
    const look = new TouchLook();
    look.down(1, 0, 0, 0);
    look.move(1, 20, 0);
    drain(look);
    look.move(1, 2020, 0);
    expect(drain(look).dx).toBeCloseTo(MAX_STEP, 6);
  });

  it("le lissage est léger et ne perd rien ; la pause l'oublie", () => {
    const look = new TouchLook();
    look.down(1, 0, 0, 0);
    look.move(1, 10, 0);
    look.move(1, 110, 0);
    // À 60 images par seconde, l'essentiel passe en trois images (~50 ms)
    let first = 0;
    for (let i = 0; i < 3; i++) first += look.take(1 / 60).dx;
    expect(first / 110).toBeGreaterThan(0.9);
    expect(first + drain(look).dx).toBeCloseTo(110, 9);
    look.move(1, 200, 0);
    look.drop();
    expect(drain(look).dx).toBe(0);
    // Sans temps qui passe, rien ne sort
    look.move(1, 250, 0);
    expect(look.take(0)).toEqual({ dx: 0, dy: 0 });
    look.clear();
    expect(look.count).toBe(0);
    expect(drain(look).dx).toBe(0);
  });
});

describe("Caméra au doigt : angles", () => {
  it("un glissé tourne la vue comme dans un jeu de tir sur téléphone, à la sensibilité choisie", () => {
    // Vers la droite : la vue tourne à droite (lacet > 0) ; vers le haut : elle regarde vers le haut (site < 0)
    const a = swipeAngles(100, -50, NORMAL);
    expect(a.yaw).toBeCloseTo(100 * TOUCH_YAW, 12);
    expect(a.pitch).toBeCloseTo(-50 * TOUCH_PITCH, 12);
    // La moitié d'un téléphone à l'horizontale (~420 px CSS) : autour de 85°, loin d'un tour complet
    expect((swipeAngles(420, 0, NORMAL).yaw * 180) / Math.PI).toBeGreaterThan(75);
    expect((swipeAngles(420, 0, NORMAL).yaw * 180) / Math.PI).toBeLessThan(95);
    const fast = swipeAngles(100, -50, { ...NORMAL, sensitivity: 2, invertY: true });
    expect(fast.yaw).toBeCloseTo(2 * a.yaw, 12);
    expect(fast.pitch).toBeCloseTo(-2 * a.pitch, 12);
  });

  it("position d'un manche : dans le disque unité", () => {
    expect(stickPosition(30, -40, 100)).toEqual({ x: 0.3, y: -0.4 });
    const out = stickPosition(300, 400, 100);
    expect(out.x).toBeCloseTo(0.6, 12);
    expect(out.y).toBeCloseTo(0.8, 12);
    expect(stickPosition(5, 5, 0)).toEqual({ x: 0, y: 0 });
  });

  it("manche de visée : zone morte, courbe, vitesse à fond, axe vertical et sensibilité", () => {
    expect(stickRates(STICK_DEADZONE * 0.9, 0, NORMAL)).toEqual({ yaw: 0, pitch: 0 });
    // À fond vers la droite : la vitesse du stick droit de la manette
    expect(stickRates(1, 0, NORMAL).yaw).toBeCloseTo(STICK_YAW, 12);
    expect(stickRates(0, 1, NORMAL).pitch).toBeCloseTo(STICK_PITCH, 12);
    // À mi-course, bien moins que la moitié (précis près du centre)
    expect(stickRates(0.5, 0, NORMAL).yaw).toBeLessThan(0.45 * STICK_YAW);
    expect(stickRates(0.5, 0, NORMAL).yaw).toBeGreaterThan(0);
    // La direction est gardée (une diagonale n'est pas ralentie sur un axe)
    const d = stickRates(Math.SQRT1_2, -Math.SQRT1_2, NORMAL);
    expect(d.yaw / STICK_YAW).toBeCloseTo(-d.pitch / STICK_PITCH, 12);
    expect(stickRates(0, 1, { ...NORMAL, invertY: true }).pitch).toBeCloseTo(-STICK_PITCH, 12);
    expect(stickRates(1, 0, { ...NORMAL, stickSensitivity: 1.5 }).yaw).toBeCloseTo(1.5 * STICK_YAW, 12);
    // Relâché (au centre) : plus rien ne tourne
    expect(stickRates(0, 0, NORMAL)).toEqual({ yaw: 0, pitch: 0 });
  });
});
