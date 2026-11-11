import { RESUME_HEAT } from "../../shared/catalog/weapons";
import type { ArmId } from "../../shared/catalog/melee";
import type { Readiness } from "../../shared/combat/arsenal";
import { byId } from "../dom";
import { num } from "../i18n/format";
import { t } from "../i18n/i18n";

/** Dessin d'un réticule : une forme, et sa couleur. */
type Shape =
  | "ring" | "dot" | "cross" | "chevron" | "brackets" | "wide" | "arcs" | "rails" | "lob" | "scatter" | "salvo" | "plasma" | "lock" | "warhead"
  | "bomb" | "repair" | "spin" | "slam" | "saber" | "lash" | "lance" | "field" | "saw" | "drill" | "flip" | "flail" | "jaw";

/**
 * Visée d'une arme : son réticule, ses grossissements au viseur (×2 : la vue est deux fois plus
 * serrée ; du plus faible au plus fort, la molette passe de l'un à l'autre), et ce qui entoure la
 * vue au viseur : les bords assombris, ou la lunette ronde d'une arme de précision.
 */
interface Sight {
  shape: Shape;
  color: string;
  zooms: readonly number[];
  mask: "vignette" | "scope";
}

const WHITE = "rgba(255, 255, 255, 0.92)";

/** Chaque arme (de tourelle ou de contact) a sa visée : TypeScript refuse une arme sans la sienne. */
export const SIGHTS: Readonly<Record<ArmId, Sight>> = {
  rifle: { shape: "ring", color: WHITE, zooms: [1.6], mask: "vignette" },
  sniper: { shape: "cross", color: WHITE, zooms: [2.5, 4, 8], mask: "scope" },
  cannon: { shape: "chevron", color: WHITE, zooms: [2], mask: "vignette" },
  missile: { shape: "brackets", color: WHITE, zooms: [1.6], mask: "vignette" },
  flak: { shape: "brackets", color: "#e7c6ff", zooms: [1.4], mask: "vignette" },
  mine: { shape: "dot", color: WHITE, zooms: [1.2], mask: "vignette" },
  flamer: { shape: "wide", color: "#ffc27a", zooms: [1.2], mask: "vignette" },
  emp: { shape: "arcs", color: "#9fe3ff", zooms: [1.6], mask: "vignette" },
  smoke: { shape: "lob", color: WHITE, zooms: [1.4], mask: "vignette" },
  laser: { shape: "dot", color: "#ff7b86", zooms: [2], mask: "vignette" },
  rail: { shape: "rails", color: "#9fe3ff", zooms: [2, 4], mask: "scope" },
  shotgun: { shape: "scatter", color: WHITE, zooms: [1.3], mask: "vignette" },
  rockets: { shape: "salvo", color: WHITE, zooms: [1.5], mask: "vignette" },
  plasma: { shape: "plasma", color: "#d9a6ff", zooms: [1.3], mask: "vignette" },
  lockon: { shape: "lock", color: "#ffcf5a", zooms: [1.6], mask: "vignette" },
  warhead: { shape: "warhead", color: "#ff8a7a", zooms: [1.2], mask: "vignette" },
  bombs: { shape: "bomb", color: "#ffd27a", zooms: [1.3], mask: "vignette" },
  empMine: { shape: "dot", color: "#9fe3ff", zooms: [1.2], mask: "vignette" },
  fireMine: { shape: "dot", color: "#ffb36b", zooms: [1.2], mask: "vignette" },
  smokeMine: { shape: "dot", color: WHITE, zooms: [1.2], mask: "vignette" },
  bounceMine: { shape: "dot", color: WHITE, zooms: [1.2], mask: "vignette" },
  aaMine: { shape: "dot", color: "#e7c6ff", zooms: [1.2], mask: "vignette" },
  remoteMine: { shape: "dot", color: "#ffcf5a", zooms: [1.2], mask: "vignette" },
  sensorMine: { shape: "dot", color: "#7fffb0", zooms: [1.2], mask: "vignette" },
  stickyMine: { shape: "dot", color: "#ff8a7a", zooms: [1.2], mask: "vignette" },
  repair: { shape: "repair", color: "#7fffb0", zooms: [1.5], mask: "vignette" },
  flare: { shape: "dot", color: "#fff2b0", zooms: [1.2], mask: "vignette" },
  nanites: { shape: "repair", color: "#b8ffcf", zooms: [1.2], mask: "vignette" },
  barrier: { shape: "wide", color: "#8fd0ff", zooms: [1.2], mask: "vignette" },
  // Armes de contact : rien à viser au loin, le réticule montre ce que fait l'arme (la jauge, son régime)
  spinner: { shape: "spin", color: "#ffb36b", zooms: [1.2], mask: "vignette" },
  hammer: { shape: "slam", color: "#ffd27a", zooms: [1.2], mask: "vignette" },
  verticalSpinner: { shape: "spin", color: "#ff9a6b", zooms: [1.2], mask: "vignette" },
  drum: { shape: "spin", color: "#ffd27a", zooms: [1.2], mask: "vignette" },
  shellSpinner: { shape: "spin", color: "#cfd8de", zooms: [1.1], mask: "vignette" },
  // (jamais choisie : son moteur la mène ; la table est exhaustive)
  propeller: { shape: "spin", color: "#ffb36b", zooms: [1.2], mask: "vignette" },
  flipper: { shape: "flip", color: "#b5f07a", zooms: [1.2], mask: "vignette" },
  flail: { shape: "flail", color: "#d8dde0", zooms: [1.2], mask: "vignette" },
  jaw: { shape: "jaw", color: "#d6a6ff", zooms: [1.2], mask: "vignette" },
  laserBlade: { shape: "saber", color: "#7fe4ff", zooms: [1.2], mask: "vignette" },
  plasmaWhip: { shape: "lash", color: "#e09bff", zooms: [1.2], mask: "vignette" },
  shockLance: { shape: "lance", color: "#9fd0ff", zooms: [1.2], mask: "vignette" },
  crusherField: { shape: "field", color: "#b8a8ff", zooms: [1.2], mask: "vignette" },
  saw: { shape: "saw", color: "#9fe0ff", zooms: [1.2], mask: "vignette" },
  drill: { shape: "drill", color: "#ffc27a", zooms: [1.2], mask: "vignette" },
};

/** Un cercle denté de rayon `r` (px) à `n` dents : chaque dent, un trait en biais qui sort du cercle. */
function teeth(r: number, n: number): string {
  const f = (v: number): string => v.toFixed(1);
  let d = `M${-r} 0a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const b = a + 0.35;
    d += `M${f(r * Math.cos(a))} ${f(r * Math.sin(a))}L${f((r + 4) * Math.cos(b))} ${f((r + 4) * Math.sin(b))}`;
  }
  return d;
}

/** Tracé SVG de chaque forme, centré sur (0, 0), dans un carré de 64 px. */
const PATHS: Record<Shape, string> = {
  // Un rond, et un point au centre
  ring: "M-10 0a10 10 0 1 0 20 0a10 10 0 1 0 -20 0",
  // Un petit cercle fin autour du point
  dot: "M-6 0a6 6 0 1 0 12 0a6 6 0 1 0 -12 0",
  // Croix fine, interrompue au centre, avec des graduations sous le centre (chute de la balle)
  cross: "M-30 0H-4M4 0H30M0 -30V-4M0 4V30M-3 10H3M-3 17H3M-3 24H3",
  // Chevron pointé sur le centre, et deux traits de hausse dessous
  chevron: "M-11 7L0 0L11 7M-5 14H5M-3 20H3",
  // Quatre coins d'un carré : la zone où le missile cherche
  brackets: "M-14 -8V-14H-8M8 -14H14V-8M14 8V14H8M-8 14H-14V8",
  // Grand cercle en pointillés : la portée du jet
  wide: "M-22 0a22 22 0 1 0 44 0a22 22 0 1 0 -44 0",
  // Cercle coupé en quatre arcs
  arcs: "M-12 0a12 12 0 0 1 3.5 -8.5M-3.5 -11.5a12 12 0 0 1 7 0M8.5 -8.5a12 12 0 0 1 3.5 8.5M12 0a12 12 0 0 1 -3.5 8.5M3.5 11.5a12 12 0 0 1 -7 0M-8.5 8.5a12 12 0 0 1 -3.5 -8.5",
  // Deux rails verticaux de part et d'autre du centre, et une ligne d'horizon
  rails: "M-4 -18V-5M4 -18V-5M-4 5V18M4 5V18M-26 0H-9M9 0H26",
  // Arc de tir en cloche au-dessus du centre
  lob: "M-12 4Q0 -18 12 4",
  // Quatre traits sur un grand cercle, et quatre en diagonale : la gerbe des plombs
  scatter: "M-20 0H-13M13 0H20M0 -20V-13M0 13V20M-9 -9l3 3M9 -9l-3 3M-9 9l3 -3M9 9l-3 -3",
  // Trois petits triangles autour du centre : la salve de roquettes
  salvo: "M0 -14l3 5h-6zM-12 8l5 -1l-2 5zM12 8l-5 -1l2 5z",
  // Grands coins et une croix : la visée de l'ogive
  warhead: "M-24 -16V-24H-16M16 -24H24V-16M24 16V24H16M-16 24H-24V16M-7 0H7M0 -7V7",
  // Un losange : le cône dans lequel on verrouille
  lock: "M0 -12L12 0L0 12L-12 0Z",
  // Un horizon coupé et une flèche vers le bas : les bombes tombent sous l'avion (le point de chute est marqué au sol)
  bomb: "M-18 -4H-6M6 -4H18M0 2V14M-5 9L0 14L5 9",
  // Une croix de soin dans un cercle : le rayon réparateur
  repair: "M-12 0a12 12 0 1 0 24 0a12 12 0 1 0 -24 0M-6 0H6M0 -6V6",
  // Deux arcs de part et d'autre : la gueule du projecteur
  plasma: "M-14 -7a14 14 0 0 0 0 14M14 -7a14 14 0 0 1 0 14M-7 0H-4M4 0H7",
  // Trois arcs qui tournent autour du centre : une toupie
  spin: "M12 0a12 12 0 0 1 -6 10.4M-6 10.4a12 12 0 0 1 -6 -10.4M-6 -10.4a12 12 0 0 1 12 0M12 0l-3 -2M-6 10.4l3.5 0.4M-6 -10.4l-0.5 3.5",
  // Une flèche qui s'abat sur une enclume : un marteau
  slam: "M0 -16V-2M-5 -7L0 -2L5 -7M-12 5H12M-8 5V10H8V5",
  // Un plateau en coin qui se relève, et la flèche de ce qu'il jette en l'air : un flipper
  flip: "M-14 10L10 4M-14 10L-14 6M0 1V-15M-5 -10L0 -15L5 -10",
  // Une boule au bout d'une chaîne, sur son tour : un fléau
  flail: "M0 0L8 -8M8 -8a4 4 0 1 0 0.01 0M-12 0a12 12 0 0 0 24 0",
  // Deux mâchoires qui se referment : une pince
  jaw: "M-14 -10Q0 -2 14 -10M-14 10Q0 2 14 10M-6 -5V-2M0 -4V-1M6 -5V-2M-6 5V2M0 4V1M6 5V2",
  // Deux arcs fins qui balaient le centre, comme les deux lames : une lame laser
  saber: "M-14 6a15 15 0 0 1 10 -16M14 -6a15 15 0 0 1 -10 16M-2 0H2M0 -2V2",
  // Un éclair qui claque de droite à gauche : un fouet plasma
  lash: "M16 -6L6 2L2 -4L-6 4L-10 -2L-16 6M-2 0H2",
  // Une pointe droit devant, et ses étincelles : une lance électrique
  lance: "M0 14V-6M-4 -2L0 -10L4 -2M-9 -11l3 3M9 -11l-3 3M-12 -4h3M12 -4h-3",
  // Un hexagone : un champ autour de la coque
  field: "M0 -14L12 -7V7L0 14L-12 7V-7ZM-2 0H2",
  // Un cercle denté : une scie (les dents inclinées dans le sens où elle tourne)
  saw: teeth(11, 10),
  // Une mèche qui pointe le centre, ses filets en chevrons : une foreuse
  drill: "M0 -4L-4 -12H4ZM-7 -6L-10 -2M7 -6L10 -2M-8 2L-12 7M8 2L12 7M-10 11H10",
};

function svg(sight: Sight): string {
  const dash = sight.shape === "wide" ? ' stroke-dasharray="4 5"' : "";
  const path = PATHS[sight.shape];
  return `<svg class="sight" viewBox="-32 -32 64 64" aria-hidden="true">`
    + `<path class="under" d="${path}"${dash}/><path class="over" d="${path}"${dash}/>`
    + `<circle class="spread" r="0"/><circle class="dot" r="1.6"/></svg>`;
}

/*
 * Jauge autour du réticule : à droite, un arc qui se remplit de bas en haut jusqu'au prochain tir
 * possible (cadence, coup qui se recharge, refroidissement, énergie) et s'efface quand l'arme est
 * prête ; à gauche, le chargeur, un segment par coup (le suivant se remplit pendant qu'il se
 * recharge), ou la chaleur d'une arme automatique.
 */
/** Rayon des arcs (px), leur étendue de part et d'autre de l'horizontale (degrés), l'écart entre deux coups du chargeur (degrés). */
const GAUGE_R = 34;
const GAUGE_HALF = 55;
const GAUGE_GAP = 3;
/** Au-delà de ce nombre de coups (armes identiques), le chargeur se dessine d'un seul trait. */
const MAX_SEGMENTS = 12;
/** Une attente plus brève (la cadence d'une arme automatique) ne s'affiche pas : l'arc clignoterait. */
const MIN_SPAN = 0.3;
/** Les deux arcs se remplissent de bas en haut. */
const CYCLE_FROM = GAUGE_HALF;
const CYCLE_TO = -GAUGE_HALF;
const RESERVE_FROM = 180 - GAUGE_HALF;
const RESERVE_TO = 180 + GAUGE_HALF;

const SVG_NS = "http://www.w3.org/2000/svg";

/** Point du cercle de rayon `r` à l'angle `deg` (degrés, 0 : à droite, l'axe y vers le bas). */
function polar(deg: number, r = GAUGE_R): string {
  const a = (deg * Math.PI) / 180;
  return `${(r * Math.cos(a)).toFixed(2)} ${(r * Math.sin(a)).toFixed(2)}`;
}

/** Arc de la jauge, de l'angle `from` à l'angle `to` (moins d'un demi-tour). */
const arcPath = (from: number, to: number): string =>
  `M${polar(from)}A${GAUGE_R} ${GAUGE_R} 0 0 ${to > from ? 1 : 0} ${polar(to)}`;

/** Un tracé de la jauge ; `pathLength` 1 : on le remplit en partie par `stroke-dasharray`. */
function gaugePath(parent: Element, d: string, cls: string): SVGPathElement {
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("class", cls);
  if (cls === "fill") path.setAttribute("pathLength", "1");
  parent.append(path);
  return path;
}

/** Remplit une part (0 à 1) d'un tracé ; ne touche au DOM que si elle change. */
function setFill(path: SVGPathElement, part: number): void {
  const dash = part >= 0.999 ? "1 0" : `${Math.max(0, part).toFixed(3)} 1`;
  if (path.getAttribute("stroke-dasharray") !== dash) path.setAttribute("stroke-dasharray", dash);
}

/**
 * Jauge du réticule (voir plus haut). Elle ne lit que `Readiness` (combat/arsenal.ts), calculée
 * d'après l'état des armes : elle marche aussi en réseau.
 */
class Gauge {
  readonly el = document.createElementNS(SVG_NS, "svg");
  private readonly cycle = document.createElementNS(SVG_NS, "g");
  private readonly cycleFill: SVGPathElement;
  private readonly reserve = document.createElementNS(SVG_NS, "g");
  private reserveKey = "";
  private fills: SVGPathElement[] = [];
  private waiting = false;

  constructor() {
    this.el.setAttribute("class", "gauge");
    this.el.setAttribute("viewBox", "-48 -48 96 96");
    this.el.setAttribute("aria-hidden", "true");
    const d = arcPath(CYCLE_FROM, CYCLE_TO);
    gaugePath(this.cycle, d, "track");
    this.cycleFill = gaugePath(this.cycle, d, "fill");
    this.cycle.setAttribute("class", "cycle");
    this.cycle.dataset.state = "off";
    this.reserve.setAttribute("class", "reserve");
    this.el.append(this.cycle, this.reserve);
  }

  /** Une autre arme : rien ne passe de l'une à l'autre (ni l'éclair de l'arme prête). */
  reset(): void {
    this.waiting = false;
    this.cycle.dataset.state = "off";
  }

  update(r: Readiness | null): void {
    this.showCycle(r);
    this.showReserve(r);
  }

  /** Arc de droite : l'attente du prochain tir ; une fois l'arme prête, il se remplit et s'efface. */
  private showCycle(r: Readiness | null): void {
    const cause = r?.cause ?? null;
    if (r && cause && cause !== "spent" && !(cause === "cycle" && r.span < MIN_SPAN)) {
      this.cycle.dataset.cause = cause;
      this.cycle.dataset.state = "wait";
      setFill(this.cycleFill, r.progress);
      this.waiting = true;
    } else if (this.waiting) {
      this.waiting = false;
      const ready = r !== null && cause === null;
      if (ready) setFill(this.cycleFill, 1);
      this.cycle.dataset.state = ready ? "done" : "off";
    }
  }

  /** Arc de gauche : le chargeur (un segment par coup, ou d'un seul trait), ou la chaleur. */
  private showReserve(r: Readiness | null): void {
    const mag = r?.magazine ?? null;
    const heat = r?.heat ?? null;
    const segmented = !!mag && mag.capacity <= MAX_SEGMENTS;
    const key = mag ? (segmented ? `rounds ${mag.capacity}` : "magazine") : heat ? "heat" : "";
    if (key !== this.reserveKey) this.buildReserve(key, segmented ? mag!.capacity : 1);
    if (mag && segmented) {
      this.fills.forEach((fill, i) => {
        setFill(fill, i < mag.rounds ? 1 : i === mag.rounds ? mag.next : 0);
        fill.classList.toggle("loading", i >= mag.rounds);
      });
    } else if (mag) {
      setFill(this.fills[0], (mag.rounds + mag.next) / mag.capacity);
    } else if (heat) {
      setFill(this.fills[0], heat.level);
    }
    const cls = this.reserve.classList;
    cls.toggle("empty", !!mag && mag.rounds === 0);
    cls.toggle("hot", !!heat && !heat.overheated && heat.level >= 0.75);
    cls.toggle("over", !!heat?.overheated);
  }

  private buildReserve(key: string, count: number): void {
    this.reserveKey = key;
    this.reserve.replaceChildren();
    this.fills = [];
    if (!key) return;
    const span = RESERVE_TO - RESERVE_FROM;
    const size = (span - GAUGE_GAP * (count - 1)) / count;
    for (let i = 0; i < count; i++) {
      const from = RESERVE_FROM + i * (size + GAUGE_GAP);
      const d = arcPath(from, from + size);
      gaugePath(this.reserve, d, count > 1 ? "track seg" : "track");
      gaugePath(this.reserve, d, "slot");
      this.fills.push(gaugePath(this.reserve, d, "fill"));
    }
    // Chaleur : un repère là où une arme en surchauffe se remet à tirer
    if (key === "heat") {
      const at = RESERVE_FROM + span * RESUME_HEAT;
      gaugePath(this.reserve, `M${polar(at, GAUGE_R - 4.5)}L${polar(at, GAUGE_R + 4.5)}`, "tick");
    }
  }
}

/** Ce que montre le réticule à chaque image. */
export interface ReticleState {
  /** On pilote et l'on vise au réticule. */
  visible: boolean;
  weapon: ArmId;
  scoping: boolean;
  /** Part du passage au viseur (0 à 1). */
  amount: number;
  /** Grossissement au viseur. */
  magnification: number;
  /** Dispersion du tir en ce moment, en px à l'écran (rayon du cercle où partiront les tirs). */
  spreadPx: number;
  /** Le mouvement du robot dégrade nettement la visée : il faudrait s'immobiliser. */
  unsteady: boolean;
  /** Toutes les tourelles de l'arme sont masquées par le robot lui-même : elle ne tire pas. */
  masked: boolean;
  /** Où en est l'arme choisie (jauge autour du réticule) ; null : pas de jauge. */
  readiness: Readiness | null;
}

/**
 * Réticule du pilote, propre à l'arme choisie, avec le cercle où partiront les tirs (il s'ouvre
 * quand le robot bouge ou tangue, se referme au viseur, robot immobile) ; et ce qu'on voit au
 * viseur : les bords assombris, ou la lunette ronde avec son optique (montants épais, croix fine,
 * repères gradués), et le grossissement. Il est centré au pixel près sur le point que vise
 * `Controls.aimPoint` : 45 % de la hauteur en vue de dos, le centre exact au viseur.
 */
export class Reticle {
  private readonly el = byId("crosshair");
  private readonly overlay = byId("scopeOverlay");
  private readonly label = byId("scopeZoom");
  private readonly steady = byId("steadyHint");
  private drawn: ArmId | null = null;
  private spread: SVGCircleElement | null = null;
  private spreadPx = -1;
  private readonly gauge = new Gauge();

  constructor() {
    this.el.append(this.gauge.el);
  }

  update(s: ReticleState): void {
    this.el.hidden = !s.visible;
    // Une seule indication à la fois : la plus bloquante d'abord
    const hint = s.masked ? t("hud.reticle.masked") : s.unsteady ? t("hud.reticle.unsteady") : "";
    this.steady.hidden = !(s.visible && hint);
    this.steady.textContent = hint;
    this.steady.classList.toggle("scoped", s.scoping);
    if (!s.visible) return;
    if (s.weapon !== this.drawn) {
      // Le dessin de l'arme change ; la jauge reste, à la couleur de l'arme
      this.el.querySelector("svg.sight")?.remove();
      this.el.insertAdjacentHTML("afterbegin", svg(SIGHTS[s.weapon]));
      this.el.style.setProperty("--reticle", SIGHTS[s.weapon].color);
      this.spread = this.el.querySelector("circle.spread");
      this.spreadPx = -1;
      this.drawn = s.weapon;
      this.gauge.reset();
    }
    this.gauge.update(s.readiness);
    // Cercle de dispersion : caché quand il est plus petit que le réticule lui-même
    const r = Math.round(Math.min(s.spreadPx, 400));
    if (this.spread && r !== this.spreadPx) {
      this.spread.setAttribute("r", String(r));
      this.spread.style.display = r < 5 ? "none" : "";
      this.spreadPx = r;
    }
    const sight = SIGHTS[s.weapon];
    this.el.classList.toggle("centered", s.scoping);
    this.el.classList.toggle("unsteady", s.unsteady);
    this.el.classList.toggle("masked", s.masked);
    // Dans la lunette, l'optique remplace le dessin du réticule (il n'en reste que le point et le cercle)
    this.el.classList.toggle("optic", s.scoping && sight.mask === "scope" && s.amount > 0.5);
    const shown = s.amount > 0.01;
    this.overlay.hidden = !shown;
    if (!shown) return;
    this.overlay.style.opacity = s.amount.toFixed(2);
    this.overlay.dataset.mask = sight.mask;
    const levels = sight.zooms.length;
    // Sans grossissement (ogive pilotée), rien à afficher
    this.label.hidden = s.magnification === 1;
    const zoom = t("unit.times", { v: num(s.magnification, 1) });
    this.label.textContent = levels > 1 && s.scoping ? t("hud.scope.zoomWheel", { zoom }) : zoom;
  }
}
