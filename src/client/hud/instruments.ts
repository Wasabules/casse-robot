import { byId } from "../dom";
import { fixed, pct, signed } from "../i18n/format";
import { measure, t } from "../i18n/i18n";

/** Tir en cloche (canon, obus IEM, fumigène) : où en est le canon, et où tombera l'obus. */
export interface Gunnery {
  /** Hausse du canon (degrés au-dessus de l'horizon), et celle vers laquelle il va (le réticule, dans son débattement). */
  elevation: number;
  target: number;
  /** Cap du canon (degrés, 0 : nord, 90 : est). */
  bearing: number;
  /** Portée (m, à l'horizontale) et temps de vol (s) jusqu'au point de chute ; null : l'obus finit sa course en l'air. */
  range: number | null;
  flight: number | null;
  /** Point de chute à l'écran (px, dans la fenêtre), s'il est devant la caméra. */
  impact: { x: number; y: number } | null;
  /** Le canon a rejoint la hausse voulue. */
  aligned: boolean;
}

/** Bombes : leur point de chute à l'écran (px, dans la fenêtre), le rayon de leur explosion (px), le temps de chute (s). */
export interface BombSight {
  x: number;
  y: number;
  radius: number;
  time: number;
}

/** Verrouillage en cours : la cible à l'écran (px, dans la fenêtre), et où en est le verrou. */
export interface LockView {
  x: number;
  y: number;
  /** Part acquise (0 à 1). */
  progress: number;
  locked: boolean;
}

/** Ogive pilotée : temps de vol restant et total (s), altitude (m), vitesse (m/s), distance à son robot (m). */
export interface WarheadView {
  left: number;
  life: number;
  altitude: number;
  speed: number;
  range: number | null;
}

/** Robot volant : son assiette et ce que lit le pilote. */
export interface Flight {
  /** Assiette (degrés, > 0 : nez haut) et inclinaison (degrés, > 0 : virage à droite). */
  pitch: number;
  bank: number;
  /** Hauteur au-dessus du sol (m), vitesse (m/s), vitesse verticale (m/s), cap (degrés). */
  altitude: number;
  speed: number;
  climb: number;
  heading: number;
  /** Avion : régime de ses moteurs (0 à 1 ; null : plus de moteur) et pilotage (null : pas un avion). */
  power: number | null;
  mode: string | null;
}

/** Pixels par degré d'assiette sur l'horizon artificiel (rayon de 55 px). */
const PITCH_SCALE = 1.4;
/** Jauge de hausse : de -10° à 70°, sur un quart de cercle. */
const GAUGE_MIN = -10;
const GAUGE_MAX = 70;

/** Un angle, `digits` décimales (un zéro arrondi n'a pas de signe moins). */
const deg = (x: number, digits = 1): string => t("unit.deg", { v: fixed(Number(x.toFixed(digits)) || 0, digits) });
/** Un cap, sur trois chiffres (« 045° »). */
const compass = (x: number): string => `${String(Math.round(x) % 360).padStart(3, "0")}°`;
/** Un temps, à un dixième de seconde (il change à chaque image sans sauter). */
const tenths = (seconds: number): string => t("unit.s", { v: fixed(seconds, 1) });

/**
 * Instruments du pilote. Pour une arme qui tire en cloche, un panneau à côté du réticule : la
 * hausse du canon (et une jauge avec celle vers laquelle il va), son cap, la portée et le temps de
 * vol ; et un repère sur le point de chute prévu.
 * Pour un robot volant, en bas de l'écran : un horizon artificiel (assiette, inclinaison),
 * l'altitude, la vitesse, la vitesse verticale et le cap.
 */
export class Instruments {
  private readonly gunnery = byId("gunnery");
  private readonly impact = byId("impactMark");
  private readonly lock = byId("lockMark");
  private readonly bomb = byId("bombMark");
  private readonly warhead = byId("warheadHud");
  private readonly flight = byId("flightHud");
  private readonly horizon = byId("fh-horizon");

  showGunnery(g: Gunnery | null, centered: boolean): void {
    this.gunnery.hidden = !g;
    this.impact.hidden = !g?.impact;
    if (!g) return;
    if (g.impact) {
      this.impact.style.left = `${g.impact.x.toFixed(1)}px`;
      this.impact.style.top = `${g.impact.y.toFixed(1)}px`;
    }
    const out = g.range === null;
    this.gunnery.classList.toggle("centered", centered);
    this.gunnery.classList.toggle("aligned", g.aligned && !out);
    this.gunnery.classList.toggle("out", out);
    byId("gn-elevation").textContent = deg(g.elevation);
    byId("gn-target").textContent = deg(g.target);
    byId("gn-bearing").textContent = compass(g.bearing);
    byId("gn-range").textContent = g.range === null ? "—" : measure(g.range, "m");
    byId("gn-flight").textContent = g.flight === null ? "—" : tenths(g.flight);
    byId("gn-state").textContent = t(out ? "hud.gunnery.out" : g.aligned ? "hud.gunnery.aligned" : "hud.gunnery.aiming");
    // Jauge : l'aiguille (hausse du canon) et le repère (hausse voulue), sur un quart de cercle
    const angle = (x: number): number => (Math.min(GAUGE_MAX, Math.max(GAUGE_MIN, x)) - GAUGE_MIN) / (GAUGE_MAX - GAUGE_MIN) * 90;
    byId("gn-needle").setAttribute("transform", `rotate(${-angle(g.elevation)})`);
    byId("gn-mark").setAttribute("transform", `rotate(${-angle(g.target)})`);
  }

  /** Bombes : un cercle au sol, là où tomberait la prochaine (de la taille de son explosion), et son temps de chute. */
  showBombing(b: BombSight | null): void {
    this.bomb.hidden = !b;
    if (!b) return;
    this.bomb.style.left = `${b.x.toFixed(1)}px`;
    this.bomb.style.top = `${b.y.toFixed(1)}px`;
    byId("bombRing").setAttribute("r", Math.max(8, Math.min(120, b.radius)).toFixed(1));
    byId("bombTime").textContent = tenths(b.time);
  }

  /**
   * Verrouillage : des coins autour de la cible, qui se resserrent à mesure que le verrou
   * progresse, puis passent au rouge quand il est acquis.
   */
  showLock(l: LockView | null): void {
    this.lock.hidden = !l;
    if (!l) return;
    this.lock.style.left = `${l.x.toFixed(1)}px`;
    this.lock.style.top = `${l.y.toFixed(1)}px`;
    this.lock.classList.toggle("locked", l.locked);
    byId("lockCorners").setAttribute("transform", `scale(${(1 + (1 - l.progress) * 0.9).toFixed(3)})`);
    byId("lockLabel").textContent = l.locked ? t("hud.lock.locked") : pct(l.progress);
  }

  /** Ogive pilotée : ce qui lui reste à voler (jauge), son altitude, sa vitesse, sa distance au robot. */
  showWarhead(w: WarheadView | null): void {
    this.warhead.hidden = !w;
    if (!w) return;
    byId("wh-fuel").style.width = `${((w.left / w.life) * 100).toFixed(1)}%`;
    byId("wh-time").textContent = tenths(w.left);
    byId("wh-alt").textContent = measure(w.altitude, "m");
    byId("wh-speed").textContent = measure(w.speed * 3.6, "kmh");
    byId("wh-range").textContent = w.range === null ? "—" : measure(w.range, "m");
  }

  showFlight(f: Flight | null): void {
    this.flight.hidden = !f;
    if (!f) return;
    // Virage à droite : l'horizon penche dans l'autre sens ; nez haut : il descend
    this.horizon.setAttribute("transform", `rotate(${-f.bank.toFixed(1)}) translate(0 ${(f.pitch * PITCH_SCALE).toFixed(1)})`);
    byId("fh-bank").setAttribute("transform", `rotate(${-f.bank.toFixed(1)})`);
    byId("fh-pitch").textContent = deg(f.pitch, 0);
    byId("fh-roll").textContent = deg(Math.abs(f.bank), 0);
    byId("fh-alt").textContent = t("unit.m", { v: fixed(f.altitude, 1) });
    byId("fh-speed").textContent = measure(f.speed * 3.6, "kmh");
    byId("fh-climb").textContent = t("unit.mps", { v: signed(f.climb, 1) });
    byId("fh-heading").textContent = compass(f.heading);
    byId("fh-power").textContent = f.power === null ? "—" : f.power < 0.01 ? t("hud.flight.engineOff") : pct(f.power);
    const plane = f.mode !== null;
    byId("fh-power-dt").hidden = byId("fh-power").hidden = !plane;
    byId("fh-mode").hidden = !plane;
    byId("fh-mode").textContent = f.mode ?? "";
  }
}
