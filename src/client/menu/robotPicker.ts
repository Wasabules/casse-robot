import { ROBOT_BUDGET } from "../../shared/design/budget";
import { RobotPreview } from "../render/robotPreview";
import { sketchRobot } from "../render/robotSketch";
import { measure, t } from "../i18n/i18n";
import { armName, botName, botTrait, partName } from "../i18n/names";
import { CardGrid } from "./cardGrid";
import {
  locomotionFilter, locomotionName, LOCOMOTIONS, matches, sortName, SORTS, sortCards,
  type RobotCard, type RobotFilter, type RobotSort,
} from "./robotCatalog";

/** Taille d'une vignette de la grille (px, en CSS ; dessinée à cette proportion : voir `.rp-thumb`). */
const THUMB = { width: 200, height: 124 };
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
 * Écran de choix du robot : des filtres (propulsion, garage), une recherche et un tri ; la grille
 * des robots (une carte chacun : vignette, nom, propulsion, armes, coût), qui prend toute la largeur
 * de l'écran ; et la fiche du robot sélectionné, avec son aperçu 3D qui tourne, à côté de la grille
 * sur un grand écran, au-dessus sur un téléphone. Clavier et manette : flèches dans la grille,
 * Entrée pour choisir ; souris : un clic sélectionne, un double clic choisit (voir cardGrid.ts).
 */
export class RobotPicker {
  readonly element: HTMLElement;
  private readonly options: PickerOptions;
  private readonly preview = new RobotPreview();
  private readonly grid: CardGrid<RobotCard>;
  private readonly chips = new Map<RobotFilter["locomotion"], HTMLButtonElement>();
  private readonly empty: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly search: HTMLInputElement;

  constructor(options: PickerOptions) {
    this.options = options;
    const root = el("div", "picker robot-picker");
    this.element = root;

    // Filtres : tous, le garage, puis chaque propulsion représentée (avec son nombre de robots)
    const tools = el("div", "picker-tools");
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
        // (sur un téléphone, le clavier de l'écran se referme)
        this.search.blur();
        this.grid.focus();
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

    // Grille : une carte par robot, créées une fois (les filtres ne font que les masquer et les ranger)
    const body = el("div", "picker-body");
    this.grid = new CardGrid<RobotCard>({
      label: t("picker.list"),
      onSelect: (card) => this.showDetail(card),
      onPick: (card) => this.pick(card),
    });
    for (const card of options.cards) this.grid.add(card, this.card(card));
    this.empty = el("p", "picker-empty", t("picker.noMatch"));
    this.detail = el("div", "picker-detail");
    const gridWrap = el("div", "picker-main");
    gridWrap.append(this.grid.element, this.empty);
    body.append(gridWrap, this.detail);
    root.append(tools, body);

    this.apply(options.cards.find((c) => c.profile.id === options.last));
    if (!this.grid.selected) this.showDetail(null);
  }

  /** Donne le focus au robot sélectionné (à l'ouverture de l'écran). */
  focus(): void {
    this.grid.focus();
  }

  /** On quitte l'écran : l'aperçu 3D libère son moteur. */
  dispose(): void {
    this.preview.dispose();
  }

  /** Applique filtre, recherche et tri : range les cartes, masque les autres. */
  private apply(prefer?: RobotCard): void {
    const filter: RobotFilter = { locomotion: remembered.filter, query: this.search.value };
    for (const [f, chip] of this.chips) chip.setAttribute("aria-pressed", String(f === remembered.filter));
    const visible = sortCards(this.options.cards.filter((c) => matches(c, filter)), remembered.sort);
    this.empty.hidden = visible.length > 0;
    this.grid.show(visible, prefer);
  }

  /** La carte d'un robot : vignette (avec son coût et ses étiquettes), nom, propulsion et armes. */
  private card(card: RobotCard): HTMLButtonElement {
    const { profile } = card;
    const button = el("button", "rp-card");
    if (card.locked.length) button.classList.add("locked");
    const figure = el("span", "picker-figure");
    const thumb = el("canvas", "picker-thumb rp-thumb");
    sketchRobot(thumb, profile.design, profile.color, THUMB.width, THUMB.height);
    figure.append(thumb, el("span", "picker-badge", String(card.cost)));
    const tags = el("span", "picker-tags");
    if (card.own) tags.append(el("span", "rp-tag", t("picker.tagGarage")));
    if (profile.id === this.options.last) tags.append(el("span", "rp-tag", t("picker.tagLast")));
    if (tags.childElementCount) figure.append(tags);
    const weapons = card.weapons.map((w) => armName(w.id)).join(", ") || t("picker.unarmed");
    const sub = card.locked.length
      ? t("picker.lockedLine", { parts: card.locked.map(partName).join(", ") })
      : t("picker.line", { locomotion: locomotionName(card.locomotion), weapons });
    button.append(figure, el("span", "picker-name", botName(profile)), el("span", "picker-sub", sub));
    button.title = t("picker.rowTitle", { name: botName(profile), trait: botTrait(profile) });
    return button;
  }

  private pick(card: RobotCard): void {
    if (card.locked.length && !this.options.allowLocked) return;
    this.options.onPick(card);
  }

  /** Fiche du robot : aperçu 3D, description, chiffres, armes, et le bouton qui le choisit. */
  private showDetail(card: RobotCard | null): void {
    const detail = this.detail;
    const view = el("div", "picker-view rp-view");
    view.append(this.preview.canvas);
    if (!card) {
      detail.replaceChildren(view, el("p", "picker-text", t("picker.nothing")));
      return;
    }
    const { profile } = card;
    this.preview.show(`${card.order}:${profile.id}`, profile.design, profile.color);

    const title = el("h2", "picker-title", botName(profile));
    const stats = el("dl", "picker-stats");
    const stat = (label: string, value: string, meter?: number): void => {
      const cell = el("div", "");
      const dd = el("dd", "", value);
      if (meter !== undefined) {
        const bar = el("span", "picker-meter");
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
    const weapons = el("div", "picker-chips");
    weapons.setAttribute("aria-label", t("picker.weapons"));
    for (const w of card.weapons) weapons.append(el("span", "picker-chip", w.count > 1 ? t("picker.weaponCount", { name: armName(w.id), n: w.count }) : armName(w.id)));
    if (!card.weapons.length) weapons.append(el("span", "picker-chip", t("picker.noWeapon")));

    const go = el("button", "menu-entry primary picker-go");
    go.type = "button";
    const blocked = card.locked.length > 0 && !this.options.allowLocked;
    go.disabled = blocked;
    go.append(el("span", "menu-label", blocked ? t("picker.unlockFirst") : this.options.action(card)));
    go.addEventListener("click", () => this.pick(card));

    const trait = card.own ? t("picker.ownTrait", { trait: botTrait(profile), n: profile.design.blocks.length }) : botTrait(profile);
    const parts: HTMLElement[] = [view, title, el("p", "picker-text", trait), stats, weapons];
    if (card.locked.length) parts.push(el("p", "picker-warn", t("picker.lockedParts", { parts: card.locked.map(partName).join(", ") })));
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
