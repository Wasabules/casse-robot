/*
 * La caméra au doigt, sans DOM (tests/touchLook.test.ts) : le suivi des doigts posés sur l'écran,
 * la conversion d'un glissé en angles, et la lecture d'un manche à l'écran (le manche de visée).
 *
 * Un seul doigt tourne la caméra : le premier posé (son `pointerId`). Les autres sont suivis sans
 * rien tourner (leur position reste à jour : s'il se lève, le suivant prend la main là où il est,
 * sans saut). Avant, le glissé n'était lié à aucun doigt : un second doigt posé sur l'écran (à côté
 * d'un bouton, pour viser en tirant) remplaçait le premier, puis les déplacements des deux doigts
 * alternaient et chaque écart entre leurs deux positions devenait une rotation : des tours complets.
 */

/** Au-delà de ce déplacement (px CSS, cumulé), un doigt tourne la caméra ; en deçà, un toucher bref est un tapotement. */
export const DRAG_THRESHOLD = 8;
/** Durée maximale d'un tapotement (ms). */
export const TAP_MAX_MS = 400;
/**
 * Déplacement le plus grand pris d'un seul événement (px CSS) : un geste très vif sur un téléphone
 * lent n'en fait pas tant ; au-delà, c'est un saut (un doigt perdu puis retrouvé), qu'on borne.
 */
export const MAX_STEP = 240;
/**
 * Lissage léger du glissé (s) : ce qui n'est pas encore rendu à la caméra s'écoule avec ce temps
 * caractéristique (à 60 images par seconde, les deux tiers à la première image, 96 % en trois). Il
 * égalise les à-coups quand les événements du doigt ne tombent pas au rythme des images, sans
 * retard sensible.
 */
export const LOOK_SMOOTHING = 0.016;
/**
 * Glisser pour viser, à la sensibilité 1 : rotation par pixel CSS (rad), en lacet et en site. Un
 * pixel CSS fait à peu près la même taille sur tous les téléphones (~0,16 mm) : un glissé de la
 * moitié d'un écran à l'horizontale (~420 px, 6 à 7 cm) fait ~85°. L'ancienne valeur, celle de la
 * caméra libre à la souris (0,006), faisait le double.
 */
export const TOUCH_YAW = 0.0036;
export const TOUCH_PITCH = 0.0029;
/**
 * Manche de visée poussé à fond, à la sensibilité 1 : vitesse de rotation (rad/s), comme le stick
 * droit de la manette ; la réponse suit la course à la puissance STICK_CURVE (précise près du
 * centre, vive au bord), au-delà d'une zone morte (part du rayon).
 */
export const STICK_YAW = 2.6;
export const STICK_PITCH = 1.7;
export const STICK_CURVE = 1.7;
export const STICK_DEADZONE = 0.1;

/** Un doigt posé : sa dernière position (px CSS), le chemin parcouru, quand il s'est posé (ms). */
interface Finger {
  x: number;
  y: number;
  moved: number;
  since: number;
}

/**
 * Les doigts posés sur une surface qui tourne la caméra (l'écran de jeu, le bouton de tir qu'on fait
 * glisser) : un seul la tourne à la fois. Le glissé s'accumule, puis s'écoule à chaque image (`take`).
 */
export class TouchLook {
  private readonly fingers = new Map<number, Finger>();
  /** Le doigt qui tourne la caméra, ou null. */
  private owner: number | null = null;
  /** Glissé pas encore rendu à la caméra (px CSS). */
  private pendingX = 0;
  private pendingY = 0;

  /** Un doigt se pose ; il prend la main si aucun autre ne l'a. */
  down(id: number, x: number, y: number, now: number): void {
    this.fingers.set(id, { x, y, moved: 0, since: now });
    if (this.owner === null) this.owner = id;
  }

  /** Un doigt bouge : seul celui qui a la main tourne la caméra (une fois le seuil passé). */
  move(id: number, x: number, y: number): void {
    const f = this.fingers.get(id);
    if (!f) return;
    let dx = x - f.x;
    let dy = y - f.y;
    f.x = x;
    f.y = y;
    f.moved += Math.abs(dx) + Math.abs(dy);
    if (id !== this.owner || f.moved <= DRAG_THRESHOLD) return;
    const step = Math.hypot(dx, dy);
    if (step > MAX_STEP) {
      dx *= MAX_STEP / step;
      dy *= MAX_STEP / step;
    }
    this.pendingX += dx;
    this.pendingY += dy;
  }

  /**
   * Un doigt se lève (`now` : ms) : vrai si c'était un tapotement (bref, sans glisser). S'il avait la
   * main, elle passe au plus ancien des doigts restants, là où il est.
   */
  up(id: number, now: number): boolean {
    const f = this.fingers.get(id);
    if (!f) return false;
    this.fingers.delete(id);
    if (this.owner === id) this.owner = this.fingers.keys().next().value ?? null;
    return f.moved <= DRAG_THRESHOLD && now - f.since < TAP_MAX_MS;
  }

  /** Un doigt perdu (geste annulé par le navigateur) : comme levé, sans tapotement. */
  cancel(id: number): void {
    this.up(id, Infinity);
  }

  /** Le doigt qui tourne la caméra (null : aucun). */
  get active(): number | null {
    return this.owner;
  }

  /** Nombre de doigts suivis. */
  get count(): number {
    return this.fingers.size;
  }

  /**
   * À chaque image : la part du glissé à rendre à la caméra (px CSS), lissée (`LOOK_SMOOTHING`) ;
   * le reste attend les images suivantes. Rien ne se perd : la somme rendue est le glissé entier.
   */
  take(dt: number): { dx: number; dy: number } {
    if (dt <= 0) return { dx: 0, dy: 0 };
    const k = 1 - Math.exp(-dt / LOOK_SMOOTHING);
    let dx = this.pendingX * k;
    let dy = this.pendingY * k;
    // Un reste de moins d'un centième de pixel : rendu d'un coup
    if (Math.abs(this.pendingX - dx) < 0.01 && Math.abs(this.pendingY - dy) < 0.01) {
      dx = this.pendingX;
      dy = this.pendingY;
    }
    this.pendingX -= dx;
    this.pendingY -= dy;
    return { dx, dy };
  }

  /** Oublie le glissé pas encore rendu (la partie en pause, un menu ouvert). */
  drop(): void {
    this.pendingX = 0;
    this.pendingY = 0;
  }

  /** Oublie tout : les doigts et le glissé (commandes cachées). */
  clear(): void {
    this.fingers.clear();
    this.owner = null;
    this.drop();
  }
}

/** Réglages de la visée au doigt. */
export interface TouchLookSettings {
  /** Sensibilité du glissé (1 : normale). */
  sensitivity: number;
  /** Sensibilité du manche de visée (1 : normale). */
  stickSensitivity: number;
  /** Axe vertical inversé : glisser vers le haut fait regarder vers le bas. */
  invertY: boolean;
}

/**
 * Un glissé de (dx, dy) px CSS en angles de caméra (rad) : comme les jeux de tir sur téléphone, le
 * doigt déplace la visée : vers la droite, la vue tourne à droite (`yaw` > 0) ; vers le haut, elle
 * regarde vers le haut (`pitch` < 0 : voir `CameraRig.turn`).
 */
export function swipeAngles(dx: number, dy: number, s: TouchLookSettings): { yaw: number; pitch: number } {
  return { yaw: dx * TOUCH_YAW * s.sensitivity, pitch: dy * TOUCH_PITCH * s.sensitivity * (s.invertY ? -1 : 1) };
}

/**
 * Position d'un manche à l'écran : le doigt à (dx, dy) px de son centre, pour un manche de rayon
 * `radius` px ; dans le disque unité (au-delà du bord, ramenée sur lui ; y > 0 : vers le bas).
 */
export function stickPosition(dx: number, dy: number, radius: number): { x: number; y: number } {
  let x = radius > 0 ? dx / radius : 0;
  let y = radius > 0 ? dy / radius : 0;
  const length = Math.hypot(x, y);
  if (length > 1) {
    x /= length;
    y /= length;
  }
  return { x, y };
}

/**
 * Manche de visée : sa position (disque unité) en vitesse de rotation (rad/s ; `yaw` > 0 : vers la
 * droite, `pitch` > 0 : vers le bas, comme `CameraRig.turn`). Zone morte radiale, puis la course
 * restante à la puissance `STICK_CURVE`, dans la direction du doigt ; à fond : `STICK_YAW` en lacet,
 * `STICK_PITCH` en site, à la sensibilité 1.
 */
export function stickRates(x: number, y: number, s: TouchLookSettings, deadzone = STICK_DEADZONE): { yaw: number; pitch: number } {
  const length = Math.hypot(x, y);
  if (length <= deadzone) return { yaw: 0, pitch: 0 };
  const reach = Math.min(1, (length - deadzone) / (1 - deadzone)) ** STICK_CURVE;
  const k = (reach / length) * s.stickSensitivity;
  return { yaw: x * k * STICK_YAW, pitch: y * k * STICK_PITCH * (s.invertY ? -1 : 1) };
}
