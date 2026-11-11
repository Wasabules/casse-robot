import type { Part } from "../../shared/design/progression";
import { byId } from "../dom";
import { measure, t } from "../i18n/i18n";
import { PartThumbnails } from "../render/partThumbnails";
import { RobotPreview } from "../render/robotPreview";
import {
  allParts, CATEGORIES, categoryName, groupName, matchesSearch, partCategory, partCost, partGroup, partInfo, partName, samePart, type Category,
} from "./partInfo";

/** Ce que l'inventaire demande au garage : les pièces du joueur, ses crédits, la couleur du robot, et quoi faire d'un choix. */
export interface InventoryHost {
  /** Le joueur a-t-il cette pièce ? Son prix de déblocage ; ses crédits (null : tout est disponible). */
  has(part: Part): boolean;
  price(part: Part): number;
  credits(): number | null;
  /** Débloque la pièce (vrai si c'est fait). */
  unlock(part: Part): boolean;
  /** La pièce choisie devient l'outil de pose. */
  pick(part: Part): void;
  color(): string;
  /** Nom de la touche qui va à la recherche (choisie par le joueur). */
  searchKey(): string;
}

/** Onglets : toutes les pièces, les dernières utilisées, puis une par catégorie. */
type Tab = "all" | "recent" | Category;

/** Nom d'un onglet, dans la langue affichée. */
const tabName = (tab: Tab): string =>
  tab === "all" ? t("garage.inventory.all") : tab === "recent" ? t("garage.inventory.recent") : categoryName(tab);

/** Pièces récentes gardées (dans le navigateur, d'une visite à l'autre). */
const RECENT_KEY = "casse-robot.garage.recent";
const RECENT_MAX = 9;
/** Recul de la caméra de l'aperçu d'une pièce seule (voir `RobotPreview.show`). */
const PREVIEW_DISTANCE = 1.6;

/**
 * Inventaire du garage : les pièces rangées par catégorie (onglets), une recherche (nom, rôle,
 * caractéristiques, sans tenir compte des accents), une grille de vignettes 3D, et la fiche de la
 * pièce choisie : son aperçu qui tourne, à quoi elle sert, ses caractéristiques, et de quoi la
 * débloquer. Un clic sur une vignette la prend pour outil ; les pièces récentes et la recherche ont
 * leurs touches (la rubrique Garage de la table des actions).
 */
export class Inventory {
  private readonly root = byId("inventory");
  private readonly thumbs = new PartThumbnails();
  private readonly preview = new RobotPreview();
  private tab: Tab = "all";
  private query = "";
  private selected: Part = { kind: "block", type: "frame" };
  private recent: Part[] = loadRecent();
  private grid: HTMLElement | null = null;
  private details: HTMLElement | null = null;
  private search: HTMLInputElement | null = null;
  private readonly host: InventoryHost;

  constructor(host: InventoryHost) {
    this.host = host;
  }

  /** Montre l'inventaire, sur la pièce choisie. */
  open(selected: Part): void {
    this.selected = selected;
    this.root.hidden = false;
    this.render();
  }

  /** Cache l'inventaire et libère ses moteurs d'aperçu (leurs contextes WebGL). */
  close(): void {
    this.root.hidden = true;
    this.thumbs.dispose();
    this.preview.dispose();
    this.root.textContent = "";
    this.grid = this.details = this.search = null;
  }

  /** La pièce choisie a changé (copiée au clic du milieu, pièce récente) : on la montre, sans redessiner la grille. */
  select(part: Part): void {
    this.selected = part;
    this.remember(part);
    if (this.root.hidden) return;
    this.markSelected();
    this.showDetails();
  }

  /** Les pièces débloquées ou la couleur du robot ont changé : on redessine. */
  refresh(): void {
    if (!this.root.hidden) this.render();
  }

  /** La touche de la recherche a changé (ou son nom) : l'invite la nomme de nouveau. */
  refreshSearchHint(): void {
    if (this.search) this.search.placeholder = t("garage.inventory.searchHint", { key: this.host.searchKey() });
  }

  /** La i-ème pièce récente (0 : la plus récente), ou null. */
  recentPart(i: number): Part | null {
    return this.recent[i] ?? null;
  }

  /** Met le curseur dans la recherche. */
  focusSearch(): void {
    this.search?.focus();
    this.search?.select();
  }

  private render(): void {
    this.thumbs.cancel();
    const root = this.root;
    root.textContent = "";
    const head = el("div", "inv-head");
    head.append(el("h2", "inv-title", t("garage.inventory.title")));
    const credits = this.host.credits();
    head.append(el("span", "inv-credits", credits === null ? t("garage.inventory.allAvailable") : t("garage.inventory.credits", { n: credits })));
    root.append(head);

    const search = document.createElement("input");
    search.type = "search";
    search.className = "inv-search";
    search.placeholder = t("garage.inventory.searchHint", { key: this.host.searchKey() });
    search.value = this.query;
    search.setAttribute("aria-label", t("garage.inventory.search"));
    search.addEventListener("input", () => {
      this.query = search.value;
      this.fillGrid();
    });
    search.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (search.value) {
          search.value = this.query = "";
          this.fillGrid();
        } else search.blur();
      } else if (e.key === "Enter") {
        // Entrée : la première pièce trouvée
        const first = this.visible()[0];
        if (first) this.choose(first);
        search.blur();
      }
    });
    this.search = search;
    root.append(search);

    const tabs = el("div", "inv-tabs");
    tabs.setAttribute("role", "tablist");
    const parts = allParts();
    const tabList: Tab[] = ["all", ...(this.recent.length ? ["recent" as const] : []), ...CATEGORIES];
    for (const tab of tabList) {
      const count = tab === "all" ? parts.length : tab === "recent" ? this.recent.length : parts.filter((p) => partCategory(p) === tab).length;
      if (!count) continue;
      const b = el("button", "inv-tab");
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(tab === this.tab));
      b.append(tabName(tab), el("small", "", String(count)));
      b.addEventListener("click", () => {
        this.tab = tab;
        for (const t of tabs.children) t.setAttribute("aria-selected", String(t === b));
        this.fillGrid();
      });
      tabs.append(b);
    }
    root.append(tabs);

    this.grid = el("div", "inv-grid");
    root.append(this.grid);
    this.details = el("div", "inv-details");
    root.append(this.details);
    this.fillGrid();
    this.showDetails();
  }

  /** Pièces montrées : l'onglet, ou toutes celles qui répondent à la recherche. */
  private visible(): Part[] {
    if (this.query.trim()) return allParts().filter((p) => matchesSearch(p, this.query));
    if (this.tab === "recent") return [...this.recent];
    const all = allParts();
    return this.tab === "all" ? all : all.filter((p) => partCategory(p) === this.tab);
  }

  /** La grille : les vignettes, avec un titre à chaque changement de catégorie ou de groupe. */
  private fillGrid(): void {
    const grid = this.grid;
    if (!grid) return;
    this.thumbs.cancel();
    grid.textContent = "";
    // Pendant une recherche, les onglets ne comptent pas : ils s'estompent
    this.root.classList.toggle("searching", !!this.query.trim());
    const parts = this.visible();
    if (!parts.length) {
      grid.append(el("p", "inv-empty", t("garage.inventory.noMatch")));
      return;
    }
    const titled = this.tab !== "recent" || !!this.query.trim();
    let heading = "";
    for (const part of parts) {
      const cat = partCategory(part);
      const group = partGroup(part);
      const title = this.tab === "all" || this.query.trim() ? (group ? `${categoryName(cat)} · ${groupName(group)}` : categoryName(cat)) : group ? groupName(group) : "";
      if (titled && title && title !== heading) {
        grid.append(el("div", "inv-group", title));
        heading = title;
      }
      grid.append(this.card(part));
    }
    this.markSelected();
  }

  /** Une vignette : l'image de la pièce, son nom, son coût (ou son prix, verrouillée). */
  private card(part: Part): HTMLButtonElement {
    const b = el("button", "inv-item");
    const locked = !this.host.has(part);
    if (locked) b.classList.add("locked");
    b.dataset.part = `${part.kind}:${part.type}`;
    b.title = t("garage.inventory.cardTitle", { name: partName(part), summary: partInfo(part).summary });
    const img = document.createElement("img");
    img.alt = "";
    img.width = img.height = 56;
    const url = this.thumbs.get(part, this.host.color(), (u) => (img.src = u));
    if (url) img.src = url;
    b.append(img, el("span", "inv-name", partName(part)), el("small", "inv-cost", locked ? t("garage.inventory.cardPrice", { n: this.host.price(part) }) : measure(partCost(part), "pts")));
    b.addEventListener("click", () => this.choose(part));
    return b;
  }

  private choose(part: Part): void {
    this.host.pick(part);
    this.select(part);
  }

  private markSelected(): void {
    if (!this.grid) return;
    const key = `${this.selected.kind}:${this.selected.type}`;
    for (const item of this.grid.querySelectorAll<HTMLElement>(".inv-item")) item.setAttribute("aria-pressed", String(item.dataset.part === key));
  }

  /** La fiche de la pièce choisie : aperçu 3D, à quoi elle sert, caractéristiques, déblocage. */
  private showDetails(): void {
    const box = this.details;
    if (!box) return;
    const part = this.selected;
    box.textContent = "";
    const top = el("div", "inv-detail-top");
    top.append(this.preview.canvas);
    const text = el("div", "inv-detail-text");
    const group = partGroup(part);
    text.append(el("div", "inv-detail-cat", group ? `${categoryName(partCategory(part))} · ${groupName(group)}` : categoryName(partCategory(part))), el("h3", "inv-detail-name", partName(part)));
    const info = partInfo(part);
    text.append(el("p", "inv-detail-summary", info.summary));
    top.append(text);
    box.append(top);
    const stats = el("dl", "inv-stats");
    for (const [k, v] of info.stats) stats.append(el("dt", "", k), el("dd", "", v));
    box.append(stats);
    if (!this.host.has(part)) {
      const price = this.host.price(part);
      const credits = this.host.credits() ?? 0;
      const row = el("div", "inv-unlock");
      row.append(el("span", "", t("garage.inventory.price", { n: price })));
      const buy = el("button", "inv-buy", credits >= price ? t("garage.inventory.unlock") : t("garage.inventory.missing", { n: price - credits }));
      buy.disabled = credits < price;
      buy.addEventListener("click", () => {
        if (this.host.unlock(part)) this.render();
      });
      row.append(buy);
      box.append(row);
    }
    this.preview.show(`${part.kind}:${part.type}:${this.host.color()}`, previewDesign(part), this.host.color(), PREVIEW_DISTANCE);
  }

  private remember(part: Part): void {
    this.recent = [part, ...this.recent.filter((p) => !samePart(p, part))].slice(0, RECENT_MAX);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(this.recent));
    } catch {
      // Stockage indisponible (navigation privée) : les récentes ne durent que la visite
    }
  }
}

/** Une pièce seule, en plan de robot, pour l'aperçu 3D. */
function previewDesign(part: Part) {
  if (part.kind === "block") return { blocks: [{ x: 0, y: 0, z: 0, type: part.type }], wheels: [] };
  return { blocks: [], wheels: [{ x: 0, y: 0, z: 0, dx: 1, dz: 0, type: part.type }] };
}

/** Pièces récentes lues dans le navigateur (seulement celles qui existent encore). */
function loadRecent(): Part[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    const known = allParts();
    return raw
      .map((p) => known.find((k) => typeof p === "object" && p && k.kind === (p as Part).kind && k.type === (p as Part).type))
      .filter((p): p is Part => !!p)
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}
