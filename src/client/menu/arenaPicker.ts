import type { ArenaKey, ArenaLayout, CommunityMeta } from "../../shared/arena/layout";
import { measure, t } from "../i18n/i18n";
import { authored } from "../i18n/names";
import { paintPlan, PlanQueue } from "./arenaPreview";
import { CardGrid } from "./cardGrid";

/** Une arène qu'on peut choisir : celles du jeu, puis les cartes communautaires. */
export interface ArenaOption {
  key: ArenaKey;
  name: string;
  /** Sa description : la phrase du menu (`arenaInfo`), ou ce qu'en a écrit l'auteur d'une carte. */
  info: string;
  /** Une carte communautaire : son auteur, sa licence. */
  community?: CommunityMeta;
  /** Demi-côté de la zone de jeu (m), nombre de zones à capturer, de nuit ou non. */
  half: number;
  zones: number;
  night: boolean;
  /** L'arène elle-même, pour son plan (construite à la demande : le Canyon, une carte communautaire). */
  layout: () => ArenaLayout | undefined;
}

export interface ArenaPickerOptions {
  arenas: readonly ArenaOption[];
  /** L'arène sélectionnée d'emblée. */
  selected: ArenaKey | null;
  /** L'arène choisie la dernière fois : marquée. */
  last: ArenaKey | null;
  /** Une arène choisie, ou « au hasard ». */
  onPick: (choice: ArenaKey | "random") => void;
}

/** La carte « au hasard », dans la grille avec les arènes. */
const RANDOM = "random";
type Choice = ArenaOption | typeof RANDOM;

/** Une arène est grande à partir de ce demi-côté (m) : les petites arènes font ±36 m, les grandes cartes ±94 à ±116. */
const LARGE_HALF = 60;
/** Taille de la vignette d'une carte de la grille (px, en CSS : proportion de `.ap-thumb`), et de la grande vue de la fiche. */
const THUMB = { width: 250, height: 200 };
const VIEW = 400;
/** Clé de l'arène choisie la dernière fois, dans le stockage du navigateur. */
const LAST_KEY = "casse-robot.lastArena";

/** L'arène choisie la dernière fois, s'il y en a une. */
export function lastArena(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

/** Retient l'arène choisie, pour la sélectionner la prochaine fois. */
export function rememberArena(key: ArenaKey): void {
  try {
    localStorage.setItem(LAST_KEY, key);
  } catch {
    // Stockage indisponible (navigation privée) : on ne s'en souviendra pas
  }
}

/** Quelques faits sur une arène : sa taille, ses zones, le jour ou la nuit. */
function facts(arena: ArenaOption): string[] {
  return [
    arena.half >= LARGE_HALF ? t("menu.arena.large") : t("menu.arena.small"),
    t("menu.arena.side", { side: measure(arena.half * 2, "m", 0) }),
    t("menu.arena.zones", { n: arena.zones }),
    arena.night ? t("menu.arena.night") : t("menu.arena.day"),
  ];
}

/**
 * Écran de choix de l'arène : une grille de cartes (le plan de chaque arène vu de dessus, son nom,
 * sa description), « Au hasard » en dernier ; et la fiche de l'arène sélectionnée (son plan en
 * grand, sa description entière, sa taille, ses zones, le jour ou la nuit, l'auteur d'une carte
 * communautaire). Mêmes commandes que le choix du robot (cardGrid.ts).
 */
export class ArenaPicker {
  readonly element: HTMLElement;
  private readonly options: ArenaPickerOptions;
  private readonly grid: CardGrid<Choice>;
  private readonly detail: HTMLElement;
  private readonly plans = new PlanQueue();

  constructor(options: ArenaPickerOptions) {
    this.options = options;
    const root = el("div", "picker arena-picker bare");
    this.element = root;
    const body = el("div", "picker-body");
    this.grid = new CardGrid<Choice>({
      label: t("menu.arena.list"),
      onSelect: (choice) => this.showDetail(choice),
      onPick: (choice) => options.onPick(choice === RANDOM ? RANDOM : choice.key),
    });
    for (const arena of options.arenas) this.grid.add(arena, this.card(arena));
    this.grid.add(RANDOM, this.randomCard());
    this.detail = el("div", "picker-detail");
    const main = el("div", "picker-main");
    main.append(this.grid.element);
    body.append(main, this.detail);
    root.append(body);
    const chosen = options.arenas.find((a) => a.key === options.selected);
    this.grid.show([...options.arenas, RANDOM], chosen ?? options.arenas[0]);
  }

  focus(): void {
    this.grid.focus();
  }

  /** On quitte l'écran : les plans qui restent à dessiner sont abandonnés (ceux déjà dessinés sont gardés). */
  dispose(): void {
    this.plans.stop();
  }

  private card(arena: ArenaOption): HTMLButtonElement {
    const button = el("button", "ap-card");
    const figure = el("span", "picker-figure ap-figure");
    const thumb = el("canvas", "picker-thumb ap-thumb");
    thumb.width = THUMB.width * 2;
    thumb.height = THUMB.height * 2;
    thumb.setAttribute("aria-hidden", "true");
    figure.append(thumb);
    this.plans.request(arena.key, arena.layout, (plan) => {
      paintPlan(thumb, plan);
      figure.classList.add("ready");
    });
    const tags = el("span", "picker-tags");
    if (arena.key === this.options.last) tags.append(el("span", "rp-tag", t("menu.arena.tagLast")));
    if (arena.community) tags.append(el("span", "rp-tag", t("menu.arena.tagCommunity")));
    if (arena.night) tags.append(el("span", "rp-tag", t("menu.arena.night")));
    if (tags.childElementCount) figure.append(tags);
    button.append(figure, el("span", "picker-name", arena.name), el("span", "picker-sub", arena.info));
    button.title = arena.info ? t("menu.arena.cardTitle", { name: arena.name, info: arena.info }) : arena.name;
    return button;
  }

  private randomCard(): HTMLButtonElement {
    const button = el("button", "ap-card ap-random");
    const figure = el("span", "picker-figure ap-figure ready");
    figure.append(dice());
    button.append(figure, el("span", "picker-name", t("menu.arena.random")), el("span", "picker-sub", t("menu.arena.randomInfo", { n: this.options.arenas.length })));
    return button;
  }

  /** Fiche : le plan en grand, le nom, la description entière, quelques faits, et le bouton qui la choisit. */
  private showDetail(choice: Choice | null): void {
    if (!choice) {
      this.detail.replaceChildren();
      return;
    }
    const view = el("div", "picker-view ap-view");
    const go = el("button", "menu-entry primary picker-go");
    go.type = "button";
    go.append(el("span", "menu-label", t("menu.arena.choose")));
    if (choice === RANDOM) {
      view.append(dice());
      go.addEventListener("click", () => this.options.onPick(RANDOM));
      this.detail.replaceChildren(
        view,
        el("h2", "picker-title", t("menu.arena.random")),
        el("p", "picker-text", t("menu.arena.randomInfo", { n: this.options.arenas.length })),
        go,
      );
      return;
    }
    const canvas = el("canvas", "ap-plan");
    canvas.width = canvas.height = VIEW * 2;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", t("menu.arena.plan", { name: choice.name }));
    view.append(canvas);
    this.plans.request(choice.key, choice.layout, (plan) => {
      paintPlan(canvas, plan);
      view.classList.add("ready");
    });
    this.plans.hurry(choice.key);
    const chips = el("div", "picker-chips");
    for (const fact of facts(choice)) chips.append(el("span", "picker-chip", fact));
    const parts: HTMLElement[] = [view, el("h2", "picker-title", choice.name)];
    const meta = choice.community;
    if (meta) {
      const description = meta.description && authored(meta.description, meta.descriptions);
      parts.push(el("p", "picker-byline", [t("maps.by", { author: meta.author }), t("maps.license", { license: meta.license })].join(" · ")));
      if (description) parts.push(el("p", "picker-text", description));
    } else if (choice.info) {
      parts.push(el("p", "picker-text", choice.info));
    }
    go.addEventListener("click", () => this.options.onPick(choice.key));
    parts.push(chips, go);
    this.detail.replaceChildren(...parts);
  }
}

/** Le dé de « Au hasard » (un dessin, sans texte). */
function dice(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("class", "ap-dice");
  svg.setAttribute("aria-hidden", "true");
  const shape = (tag: string, attrs: Record<string, string | number>): void => {
    const node = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    svg.append(node);
  };
  shape("rect", { x: 22, y: 22, width: 56, height: 56, rx: 11, transform: "rotate(-12 50 50)" });
  for (const [x, y] of [[36, 36], [64, 36], [50, 50], [36, 64], [64, 64]]) shape("circle", { cx: x, cy: y, r: 5.5, transform: "rotate(-12 50 50)" });
  return svg;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
