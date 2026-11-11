import { ROBOT_BUDGET } from "../../shared/design/budget";
import { RobotPreview } from "../render/robotPreview";
import { sketchRobot } from "../render/robotSketch";
import { measure, t } from "../i18n/i18n";
import { armName, botName, botTrait, partName } from "../i18n/names";
import {
  locomotionFilter, locomotionName, LOCOMOTIONS, matches, sortName, SORTS, sortCards,
  type RobotCard, type RobotFilter, type RobotSort,
} from "./robotCatalog";

/** Taille d'une vignette de la liste (px, en CSS : voir `.rp-thumb`). */
const THUMB = { width: 88, height: 60 };
/** Clé du robot choisi la dernière fois, dans le stockage du navigateur. */
const LAST_KEY = "casse-robot.lastRobot";

/** Robot choisi la dernière fois (identifiant de son profil), s'il y en a un. */
export function lastPick(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

/** Retient le robot choisi, pour le mettre en avant la prochaine fois. */
export function rememberPick(id: string): void {
  try {
    localStorage.setItem(LAST_KEY, id);
  } catch {
    // Stockage indisponible (navigation privée) : on ne s'en souviendra pas
  }
}

export interface PickerOptions {
  cards: readonly RobotCard[];
  /** Robot choisi la dernière fois (identifiant de profil) : mis en avant, et sélectionné d'emblée. */
  last: string | null;
  /** Libellé du bouton qui choisit le robot sélectionné. */
  action: (card: RobotCard) => string;
  /** Un robot auquel manquent des pièces peut-il être choisi ? (au garage : on l'ouvre pour le modifier) */
  allowLocked: boolean;
  onPick: (card: RobotCard) => void;
}

/** Filtre et tri choisis : ils restent d'une ouverture à l'autre, le temps de la visite. */
const remembered: { filter: RobotFilter["locomotion"]; sort: RobotSort } = { filter: "all", sort: "order" };

/**
 * Écran de choix du robot : des filtres (propulsion, garage), une recherche et un tri ; la liste
 * des robots (vignette, nom, propulsion, armes, coût), qui défile ; et la fiche du robot
 * sélectionné, avec son aperçu 3D qui tourne. Clavier : flèches pour passer d'un robot à l'autre,
 * Entrée pour le choisir ; souris : un clic le sélectionne, un double clic le choisit.
 */
export class RobotPicker {
  readonly element: HTMLElement;
  private readonly options: PickerOptions;
  private readonly preview = new RobotPreview();
  private readonly rows = new Map<RobotCard, HTMLButtonElement>();
  private readonly chips = new Map<RobotFilter["locomotion"], HTMLButtonElement>();
  private readonly list: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly search: HTMLInputElement;
  private selected: RobotCard | null = null;
  /** Robots visibles, dans l'ordre affiché. */
  private visible: RobotCard[] = [];

  constructor(options: PickerOptions) {
    this.options = options;
    const root = el("div", "robot-picker");
    this.element = root;

    // Filtres : tous, le garage, puis chaque propulsion représentée (avec son nombre de robots)
    const tools = el("div", "rp-tools");
    const filters = el("div", "rp-filters");
    filters.setAttribute("role", "group");
    filters.setAttribute("aria-label", t("picker.filters"));
    const count = (f: RobotFilter["locomotion"]): number => options.cards.filter((c) => matches(c, { locomotion: f, query: "" })).length;
    const kinds: RobotFilter["locomotion"][] = ["all", "own", ...LOCOMOTIONS];
    for (const f of kinds) {
      const n = count(f);
      if (!n) continue;
      const chip = el("button", "rp-chip");
      chip.type = "button";
      chip.append(f === "all" ? t("picker.all") : f === "own" ? t("picker.own") : locomotionFilter(f), el("span", "", String(n)));
      chip.addEventListener("click", () => {
        remembered.filter = f;
        this.apply();
      });
      this.chips.set(f, chip);
      filters.append(chip);
    }
    if (!this.chips.has(remembered.filter)) remembered.filter = "all";

    // Recherche et tri
    const find = el("div", "rp-search");
    this.search = document.createElement("input");
    this.search.type = "search";
    this.search.placeholder = t("picker.searchHint");
    this.search.setAttribute("aria-label", t("picker.search"));
    this.search.spellcheck = false;
    this.search.addEventListener("input", () => this.apply());
    this.search.addEventListener("keydown", (e) => {
      // Échap efface la recherche, puis (recherche vide) revient à l'écran précédent
      if (e.key === "Escape" && !this.search.value) return;
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        this.search.value = "";
        this.apply();
      } else if (e.key === "ArrowDown" || e.key === "Enter") {
        e.preventDefault();
        this.focusRow(this.selected && this.visible.includes(this.selected) ? this.selected : this.visible[0]);
      }
    });
    const sort = document.createElement("select");
    sort.setAttribute("aria-label", t("picker.sort"));
    for (const s of SORTS) {
      const option = document.createElement("option");
      option.value = s;
      option.textContent = sortName(s);
      sort.append(option);
    }
    sort.value = remembered.sort;
    sort.addEventListener("change", () => {
      remembered.sort = sort.value as RobotSort;
      this.apply();
    });
    sort.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") e.stopPropagation();
    });
    find.append(this.search, sort);
    tools.append(filters, find);

    // Liste : une ligne par robot, créées une fois (les filtres ne font que les masquer et les ranger)
    const body = el("div", "rp-body");
    this.list = el("div", "rp-list");
    this.list.setAttribute("role", "listbox");
    this.list.setAttribute("aria-label", t("picker.list"));
    this.list.addEventListener("keydown", (e) => this.onListKey(e));
    for (const card of options.cards) this.list.append(this.row(card));
    this.empty = el("p", "rp-empty", t("picker.noMatch"));
    this.detail = el("div", "rp-detail");
    const listWrap = el("div", "rp-list-wrap");
    listWrap.append(this.list, this.empty);
    body.append(listWrap, this.detail);
    root.append(tools, body);

    this.apply(options.cards.find((c) => c.profile.id === options.last));
    if (!this.selected) this.showDetail(null);
  }

  /** Donne le focus au robot sélectionné (à l'ouverture de l'écran). */
  focus(): void {
    if (this.selected) this.focusRow(this.selected);
  }

  /** On quitte l'écran : l'aperçu 3D libère son moteur. */
  dispose(): void {
    this.preview.dispose();
  }

  /**
   * Applique filtre, recherche et tri : range les lignes, masque les autres. La sélection reste si
   * son robot est encore visible (ou passe à `prefer`, s'il l'est), sinon au premier de la liste.
   */
  private apply(prefer?: RobotCard): void {
    const filter: RobotFilter = { locomotion: remembered.filter, query: this.search.value };
    for (const [f, chip] of this.chips) chip.setAttribute("aria-pressed", String(f === remembered.filter));
    this.visible = sortCards(this.options.cards.filter((c) => matches(c, filter)), remembered.sort);
    const shown = new Set(this.visible);
    for (const [card, row] of this.rows) row.hidden = !shown.has(card);
    for (const card of this.visible) this.list.append(this.rows.get(card)!);
    this.empty.hidden = this.visible.length > 0;
    const keep = prefer && shown.has(prefer) ? prefer : this.selected && shown.has(this.selected) ? this.selected : this.visible[0] ?? null;
    if (keep !== this.selected) this.select(keep);
    else if (keep) this.reveal(keep);
  }

  /**
   * Fait défiler la liste jusqu'à ce robot. La liste seule : sur un téléphone, où c'est la page qui
   * défile (la liste n'a pas de hauteur maximale), le titre et les filtres restent en vue.
   */
  private reveal(card: RobotCard): void {
    const row = this.rows.get(card)!.getBoundingClientRect();
    const list = this.list.getBoundingClientRect();
    if (row.top < list.top) this.list.scrollTop -= list.top - row.top + 4;
    else if (row.bottom > list.bottom) this.list.scrollTop += row.bottom - list.bottom + 4;
  }

  private row(card: RobotCard): HTMLButtonElement {
    const { profile } = card;
    const row = el("button", "rp-item");
    row.type = "button";
    row.setAttribute("role", "option");
    row.tabIndex = -1;
    if (card.locked.length) row.classList.add("locked");
    const thumb = el("canvas", "rp-thumb");
    sketchRobot(thumb, profile.design, profile.color, THUMB.width, THUMB.height);
    const text = el("span", "rp-text");
    const name = el("span", "rp-name", botName(profile));
    if (card.own) name.append(el("span", "rp-tag", t("picker.tagGarage")));
    if (profile.id === this.options.last) name.append(el("span", "rp-tag", t("picker.tagLast")));
    const weapons = card.weapons.map((w) => armName(w.id)).join(", ") || t("picker.unarmed");
    const sub = card.locked.length
      ? t("picker.lockedLine", { parts: card.locked.map(partName).join(", ") })
      : t("picker.line", { locomotion: locomotionName(card.locomotion), weapons });
    text.append(name, el("span", "rp-sub", sub));
    row.append(thumb, text, el("span", "rp-cost", String(card.cost)));
    row.title = t("picker.rowTitle", { name: botName(profile), trait: botTrait(profile) });
    row.addEventListener("click", () => this.select(card));
    row.addEventListener("dblclick", () => this.pick(card));
    row.addEventListener("focus", () => this.select(card));
    this.rows.set(card, row);
    return row;
  }

  /** Sélectionne un robot : sa ligne est marquée, sa fiche et son aperçu s'affichent. */
  private select(card: RobotCard | null): void {
    if (card === this.selected) return;
    this.selected = card;
    for (const [c, row] of this.rows) {
      row.setAttribute("aria-selected", String(c === card));
      row.tabIndex = c === card ? 0 : -1;
    }
    if (card) this.reveal(card);
    this.showDetail(card);
  }

  private focusRow(card: RobotCard | undefined): void {
    if (!card) return;
    this.select(card);
    this.rows.get(card)!.focus({ preventScroll: true });
    this.reveal(card);
  }

  private pick(card: RobotCard): void {
    if (card.locked.length && !this.options.allowLocked) return;
    this.options.onPick(card);
  }

  /** Flèches, Début, Fin, Page préc./suiv. : d'un robot à l'autre ; Entrée : le choisir. */
  private onListKey(e: KeyboardEvent): void {
    const i = this.selected ? this.visible.indexOf(this.selected) : -1;
    const last = this.visible.length - 1;
    const page = Math.max(1, Math.floor(this.list.clientHeight / 72));
    const target: Record<string, number> = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: last, PageDown: i + page, PageUp: i - page };
    if (e.key in target) {
      e.preventDefault();
      e.stopPropagation();
      this.focusRow(this.visible[Math.max(0, Math.min(last, target[e.key]))]);
    } else if (e.key === "Enter" && this.selected) {
      e.preventDefault();
      e.stopPropagation();
      this.pick(this.selected);
    }
  }

  /** Fiche du robot : aperçu 3D, description, chiffres, armes, et le bouton qui le choisit. */
  private showDetail(card: RobotCard | null): void {
    const detail = this.detail;
    const view = el("div", "rp-view");
    view.append(this.preview.canvas);
    if (!card) {
      detail.replaceChildren(view, el("p", "rp-trait", t("picker.nothing")));
      return;
    }
    const { profile } = card;
    this.preview.show(`${card.order}:${profile.id}`, profile.design, profile.color);

    const title = el("h2", "rp-title", botName(profile));
    const stats = el("dl", "rp-stats");
    const stat = (label: string, value: string, meter?: number): void => {
      const cell = el("div", "");
      const dd = el("dd", "", value);
      if (meter !== undefined) {
        const bar = el("span", "rp-meter");
        const fill = el("i", "");
        fill.style.width = `${Math.round(Math.min(1, meter) * 100)}%`;
        bar.append(fill);
        dd.append(bar);
      }
      cell.append(el("dt", "", label), dd);
      stats.append(cell);
    };
    stat(t("picker.cost"), t("picker.budget", { cost: card.cost, budget: ROBOT_BUDGET }), card.cost / ROBOT_BUDGET);
    stat(t("picker.mass"), measure(card.mass, "kg"));
    stat(t("picker.locomotion"), locomotionName(card.locomotion));
    stat(t("picker.speed"), measure(profile.speed * 3.6, "kmh"));
    const weapons = el("div", "rp-weapons");
    weapons.setAttribute("aria-label", t("picker.weapons"));
    for (const w of card.weapons) weapons.append(el("span", "rp-weapon", w.count > 1 ? t("picker.weaponCount", { name: armName(w.id), n: w.count }) : armName(w.id)));
    if (!card.weapons.length) weapons.append(el("span", "rp-weapon", t("picker.noWeapon")));

    const go = el("button", "menu-entry primary rp-go");
    go.type = "button";
    const blocked = card.locked.length > 0 && !this.options.allowLocked;
    go.disabled = blocked;
    go.append(el("span", "menu-label", blocked ? t("picker.unlockFirst") : this.options.action(card)));
    go.addEventListener("click", () => this.pick(card));

    const trait = card.own ? t("picker.ownTrait", { trait: botTrait(profile), n: profile.design.blocks.length }) : botTrait(profile);
    const parts: HTMLElement[] = [view, title, el("p", "rp-trait", trait), stats, weapons];
    if (card.locked.length) parts.push(el("p", "rp-locked", t("picker.lockedParts", { parts: card.locked.map(partName).join(", ") })));
    parts.push(go);
    detail.replaceChildren(...parts);
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
