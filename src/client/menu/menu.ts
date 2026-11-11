import { byId } from "../dom";
import { t } from "../i18n/i18n";

export interface MenuEntry {
  label: string;
  /** Petite ligne d'explication sous le libellé. */
  detail?: string;
  /** Bouton mis en avant (l'action principale). */
  primary?: boolean;
  /** Entrée visible mais inactive (fonctionnalité à venir). */
  disabled?: boolean;
  onSelect?: () => void;
}

/** Champ de saisie (nom du joueur, adresse du serveur). */
export interface MenuField {
  label: string;
  value: string;
  placeholder?: string;
  onInput: (value: string) => void;
}

/** Une option d'un réglage à choix. */
export interface SettingOption<T extends string | number> {
  value: T;
  label: string;
}

/**
 * Une ligne de réglage : un libellé (et son explication) à gauche, sa commande à droite. Le
 * changement est appliqué tout de suite ; l'écran se redessine ensuite avec les nouvelles valeurs.
 */
export type SettingRow =
  | { kind: "toggle"; label: string; detail?: string; value: boolean; onChange: (value: boolean) => void }
  | { kind: "choice"; label: string; detail?: string; options: readonly SettingOption<string | number>[]; value: string | number; onChange: (value: string | number) => void }
  | {
      kind: "slider"; label: string; detail?: string; value: number; min: number; max: number; step: number;
      /** Valeur affichée à côté du curseur. */
      format: (value: number) => string;
      /** Pendant le glissement (pour entendre ou voir l'effet), puis au lâcher avec `done`. */
      onChange: (value: number, done: boolean) => void;
    }
  | { kind: "text"; label: string; detail?: string; value: string; placeholder?: string; onChange: (value: string) => void }
  | { kind: "button"; label: string; detail?: string; action: string; onSelect: () => void }
  /** Une information, sans commande (la manette branchée). */
  | { kind: "note"; label: string; detail?: string }
  /**
   * Les touches d'une action : une case par touche (clic : en choisir une autre ; clic droit : la
   * retirer), un bouton pour remettre celles par défaut (`onReset`, absent si elles le sont), et un
   * mot sous la ligne (`note` : un échange de touches, un refus).
   */
  | { kind: "binding"; label: string; detail?: string; note?: string; slots: readonly BindingSlotView[]; onReset?: () => void }
  /** Intertitre, pour grouper les lignes d'un onglet ; `columns` : les titres des cases des lignes de touches. */
  | { kind: "heading"; label: string; columns?: readonly string[] };

/** Une case d'une ligne de touches. */
export interface BindingSlotView {
  /** Le nom de la touche (« — » : aucune). */
  text: string;
  /** Explication, au survol. */
  title?: string;
  /** À l'écoute de la nouvelle touche. */
  listening?: boolean;
  /** Touche fixe : la case ne se change pas. */
  fixed?: boolean;
  onSelect?: () => void;
  /** Clic droit : retirer la touche. */
  onClear?: () => void;
}

/** Réglage à choix, typé par ses valeurs. */
export function choiceRow<T extends string | number>(
  label: string, options: readonly SettingOption<T>[], value: T, onChange: (value: T) => void, detail?: string,
): SettingRow {
  return { kind: "choice", label, detail, options, value, onChange: (v) => onChange(v as T) };
}

export interface MenuTabs {
  labels: readonly string[];
  active: number;
  onSelect: (index: number) => void;
}

export interface MenuView {
  /**
   * Identifiant de l'écran (« settings ») : le même identifiant, c'est le même écran redessiné (le
   * focus et la position de défilement restent). Sans lui, le titre en tient lieu ; mais un titre
   * change avec la langue.
   */
  id?: string;
  title: string;
  subtitle?: string;
  /** Onglets, au-dessus des lignes de réglage. */
  tabs?: MenuTabs;
  /** Lignes de réglage (écran des paramètres). */
  rows?: readonly SettingRow[];
  entries: readonly MenuEntry[];
  /** Champs de saisie, au-dessus des entrées. */
  fields?: readonly MenuField[];
  /** Liste de paires (touche, effet), affichée sous les entrées. */
  keys?: readonly (readonly [string, string])[];
  footer?: string;
  /** Entrées sur deux colonnes, dans un panneau plus large (longues listes : choix du robot). */
  wide?: boolean;
  /** Écran titre : le nom du jeu en grand. */
  hero?: boolean;
  /** Contenu construit ailleurs, entre le titre et les entrées (choix du robot : menu/robotPicker.ts), dans le panneau le plus large. */
  content?: HTMLElement;
  /** Appelé quand l'écran est remplacé ou fermé : le contenu libère ce qu'il a pris (l'aperçu 3D). */
  onClose?: () => void;
  /** Retour à l'écran précédent (Échap), s'il y en a un. */
  back?: () => void;
}

/**
 * Menu plein écran (écran titre, pause, paramètres), dessiné en HTML par-dessus la scène.
 * Le balisage est construit ici à partir d'une description (`MenuView`). Quand un écran se
 * redessine (un réglage a changé), la commande qui avait le focus le garde.
 */
export class Menu {
  private readonly root = byId("menu");
  private back: (() => void) | undefined;
  /** À appeler quand l'écran affiché s'en va (`MenuView.onClose`). */
  private close: (() => void) | undefined;
  /** Écran affiché (son identifiant, sinon son titre) : le même, c'est le même écran redessiné. */
  private current = "";

  get visible(): boolean {
    return !this.root.hidden;
  }

  /** Remet le focus sur la première commande (l'écran était caché derrière l'écran de chargement). */
  focus(): void {
    if (this.visible) this.root.querySelector<HTMLElement>(".menu-entries button:not(:disabled), .menu-tab[aria-selected=true]")?.focus();
  }

  show(view: MenuView): void {
    // Commande qui a le focus, retrouvée après coup par sa clé si c'est le même écran redessiné
    const screen = view.id ?? view.title;
    const redraw = this.visible && screen === this.current;
    const focused = redraw && this.root.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.key : undefined;
    this.back = view.back;
    this.current = screen;
    this.closeView();
    this.close = view.onClose;

    const panel = document.createElement("div");
    panel.className = ["menu-panel", view.wide && "wide", view.hero && "hero", view.rows && "settings", view.content && "custom"].filter(Boolean).join(" ");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", view.title);

    const title = document.createElement("h1");
    title.className = "menu-title";
    if (view.hero) {
      // « Casse-Robot » : le trait d'union à la couleur du jeu, comme dans le HUD
      const [head, ...rest] = view.title.split("-");
      const dash = document.createElement("span");
      dash.textContent = "-";
      title.append(head, ...(rest.length ? [dash, rest.join("-")] : []));
    } else {
      title.textContent = view.title;
    }
    panel.append(title);
    if (view.subtitle) panel.append(paragraph("menu-subtitle", view.subtitle));

    if (view.tabs) panel.append(tabBar(view.tabs));
    if (view.rows) {
      const rows = document.createElement("div");
      rows.className = "menu-rows";
      if (view.tabs) rows.setAttribute("role", "tabpanel");
      view.rows.forEach((row, i) => rows.append(settingRow(row, `row${i}`)));
      panel.append(rows);
    }

    if (view.content) panel.append(view.content);

    view.fields?.forEach((field, i) => {
      const label = document.createElement("label");
      label.className = "menu-field";
      const name = document.createElement("span");
      name.textContent = field.label;
      const input = textInput(field.value, field.placeholder, field.onInput);
      input.dataset.key = `field${i}`;
      label.append(name, input);
      panel.append(label);
    });

    const list = document.createElement("div");
    list.className = "menu-entries";
    view.entries.forEach((entry, i) => list.append(this.button(entry, `entry${i}`)));
    panel.append(list);

    if (view.keys) {
      const dl = document.createElement("dl");
      dl.className = "menu-keys";
      for (const [key, effect] of view.keys) {
        const dt = document.createElement("dt");
        dt.textContent = key;
        const dd = document.createElement("dd");
        dd.textContent = effect;
        dl.append(dt, dd);
      }
      panel.append(dl);
    }
    if (view.footer) panel.append(paragraph("menu-foot", view.footer));

    const scroll = this.root.scrollTop;
    this.root.replaceChildren(panel);
    this.root.hidden = false;
    // Le HUD s'efface tant qu'un menu est ouvert (voir style.css)
    document.body.classList.add("menu-open");
    const again = focused ? panel.querySelector<HTMLElement>(`[data-key="${focused}"]`) : null;
    // Un nouvel écran commence en haut ; un écran redessiné reste où il était
    this.root.scrollTop = redraw ? scroll : 0;
    if (again) {
      again.focus({ preventScroll: true });
    } else if (!view.content) {
      // Un contenu construit ailleurs place le focus lui-même (le choix du robot, sur le robot sélectionné)
      panel.querySelector<HTMLElement>(view.tabs ? ".menu-tab[aria-selected=true]" : ".menu-entries button:not(:disabled)")?.focus();
    }
  }

  hide(): void {
    this.closeView();
    this.root.hidden = true;
    this.root.replaceChildren();
    this.back = undefined;
    this.current = "";
    document.body.classList.remove("menu-open");
  }

  /** L'écran affiché s'en va : son contenu libère ce qu'il a pris. */
  private closeView(): void {
    const close = this.close;
    this.close = undefined;
    close?.();
  }

  /** Échap : revient à l'écran précédent, s'il y en a un. Renvoie false sinon. */
  goBack(): boolean {
    if (!this.visible || !this.back) return false;
    this.back();
    return true;
  }

  // --- Manette : on parcourt le menu au focus ---

  /** La commande du menu qui a le focus, ou null. */
  private focused(): HTMLElement | null {
    const a = document.activeElement;
    return a instanceof HTMLElement && a !== this.root && this.root.contains(a) ? a : null;
  }

  /** Les commandes qu'on peut atteindre (visibles, actives, dans l'ordre de tabulation). */
  private focusables(): HTMLElement[] {
    return [...this.root.querySelectorAll<HTMLElement>("button, input, select, [tabindex]")]
      .filter((el) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0 && el.getClientRects().length > 0);
  }

  /**
   * Une direction (croix, stick gauche) : la commande qui a le focus s'en charge si elle le sait
   * (liste des robots, onglets : elle reçoit la flèche du clavier), un curseur se règle ; sinon, la
   * commande voisine dans cette direction prend le focus.
   */
  navigate(dir: "up" | "down" | "left" | "right"): void {
    if (!this.visible) return;
    const active = this.focused();
    if (!active) {
      this.focus();
      return;
    }
    const key = ARROWS[dir];
    if (!active.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }))) return;
    if (active instanceof HTMLInputElement && active.type === "range" && (dir === "left" || dir === "right")) {
      stepRange(active, dir === "right" ? 1 : -1);
      return;
    }
    const next = nearest(this.focusables(), active, dir);
    if (!next) return;
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  /** A : active la commande qui a le focus (la liste des robots reçoit Entrée). */
  accept(): void {
    const active = this.focused();
    if (!active) {
      this.focus();
      return;
    }
    if (!active.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }))) return;
    if (active instanceof HTMLButtonElement) active.click();
  }

  /** LB, RB : onglet précédent ou suivant, s'il y en a. */
  cycleTab(step: number): void {
    const tabs = [...this.root.querySelectorAll<HTMLElement>(".menu-tab")];
    const i = tabs.findIndex((t) => t.getAttribute("aria-selected") === "true");
    if (i < 0) return;
    const next = tabs[(i + step + tabs.length) % tabs.length];
    const key = next.dataset.key;
    next.click();
    // L'écran est redessiné : le focus passe au nouvel onglet
    this.root.querySelector<HTMLElement>(`.menu-tab[data-key="${key}"]`)?.focus();
  }

  private button(entry: MenuEntry, key: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.className = entry.primary ? "menu-entry primary" : "menu-entry";
    button.dataset.key = key;
    button.disabled = !!entry.disabled;
    const label = document.createElement("span");
    label.className = "menu-label";
    label.textContent = entry.label;
    button.append(label);
    if (entry.detail) {
      const detail = document.createElement("span");
      detail.className = "menu-detail";
      detail.textContent = entry.detail;
      button.append(detail);
    }
    if (entry.onSelect) button.addEventListener("click", entry.onSelect);
    return button;
  }
}

const ARROWS = { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight" } as const;

/** Écart entre deux intervalles (0 s'ils se recouvrent). */
const gap = (a0: number, a1: number, b0: number, b1: number): number => Math.max(0, b0 - a1, a0 - b1);

/**
 * La commande la plus proche de `from` dans une direction : devant elle (pas à côté), la plus
 * proche, de préférence celle qui lui fait face (même colonne pour monter ou descendre). De côté,
 * seulement sur la même ligne (la case voisine, l'option suivante) : sinon, rien.
 */
function nearest(list: readonly HTMLElement[], from: HTMLElement, dir: keyof typeof ARROWS): HTMLElement | null {
  const a = from.getBoundingClientRect();
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of list) {
    if (el === from) continue;
    const b = el.getBoundingClientRect();
    const vertical = dir === "up" || dir === "down";
    const along = dir === "down" ? b.top - a.bottom : dir === "up" ? a.top - b.bottom : dir === "right" ? b.left - a.right : a.left - b.right;
    // Pas devant (un léger chevauchement est toléré)
    if (along < -4) continue;
    const across = vertical ? gap(a.left, a.right, b.left, b.right) : gap(a.top, a.bottom, b.top, b.bottom);
    if (!vertical && across > 0) continue;
    const offset = vertical ? Math.abs(b.left + b.right - a.left - a.right) / 2 : Math.abs(b.top + b.bottom - a.top - a.bottom) / 2;
    const score = Math.max(0, along) + across + 0.1 * offset;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

/** Un cran de curseur, comme la flèche du clavier (les événements d'une flèche simulée ne le font pas d'eux-mêmes). */
function stepRange(input: HTMLInputElement, sign: number): void {
  const step = Number(input.step) || 1;
  const value = Math.min(Number(input.max), Math.max(Number(input.min), Number(input.value) + sign * step));
  if (value === Number(input.value)) return;
  input.value = String(value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Barre d'onglets ; les flèches gauche et droite passent d'un onglet à l'autre. */
function tabBar(tabs: MenuTabs): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "menu-tabs";
  bar.setAttribute("role", "tablist");
  tabs.labels.forEach((label, i) => {
    const tab = document.createElement("button");
    tab.className = "menu-tab";
    tab.type = "button";
    tab.textContent = label;
    tab.dataset.key = `tab${i}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(i === tabs.active));
    tab.tabIndex = i === tabs.active ? 0 : -1;
    tab.addEventListener("click", () => tabs.onSelect(i));
    tab.addEventListener("keydown", (e) => {
      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const next = (i + step + tabs.labels.length) % tabs.labels.length;
      tabs.onSelect(next);
      // L'écran est redessiné : le focus passe au nouvel onglet
      document.querySelector<HTMLElement>(`.menu-tab[data-key="tab${next}"]`)?.focus();
    });
    bar.append(tab);
  });
  return bar;
}

function settingRow(row: SettingRow, key: string): HTMLElement {
  if (row.kind === "heading") {
    const h = document.createElement("h2");
    h.className = "menu-heading";
    h.textContent = row.label;
    if (!row.columns) return h;
    // Titres des cases des lignes de touches, alignés sur elles
    const head = document.createElement("div");
    head.className = "menu-heading-row";
    const cols = document.createElement("div");
    cols.className = "menu-key-cols";
    cols.setAttribute("aria-hidden", "true");
    for (const c of row.columns) cols.append(Object.assign(document.createElement("span"), { textContent: c }));
    head.append(h, cols);
    return head;
  }
  const line = document.createElement("div");
  line.className = `menu-row ${row.kind}`;
  const text = document.createElement("div");
  text.className = "menu-row-text";
  const label = document.createElement("span");
  label.className = "menu-row-label";
  label.id = `${key}-label`;
  label.textContent = row.label;
  text.append(label);
  if (row.detail) text.append(paragraph("menu-row-detail", row.detail));
  if (row.kind === "binding" && row.note) text.append(paragraph("menu-row-note", row.note));
  line.append(text);

  switch (row.kind) {
    case "note":
      break;
    case "binding": {
      const keys = document.createElement("div");
      keys.className = "menu-keyset";
      keys.setAttribute("role", "group");
      keys.setAttribute("aria-labelledby", label.id);
      row.slots.forEach((slot, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "menu-key";
        b.dataset.key = `${key}-${i}`;
        b.textContent = slot.text;
        if (slot.title) b.title = slot.title;
        if (slot.listening) b.classList.add("listening");
        if (slot.text === "—") b.classList.add("empty");
        b.disabled = !!slot.fixed;
        if (slot.onSelect) b.addEventListener("click", slot.onSelect);
        b.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          slot.onClear?.();
        });
        keys.append(b);
      });
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "menu-key-reset";
      reset.dataset.key = `${key}-reset`;
      reset.textContent = "↺";
      reset.title = t("menu.bind.reset");
      reset.setAttribute("aria-label", t("menu.bind.resetLabel", { action: row.label }));
      // Déjà par défaut : le bouton garde sa place (les cases restent alignées), invisible
      if (row.onReset) reset.addEventListener("click", row.onReset);
      else {
        reset.classList.add("idle");
        reset.disabled = true;
      }
      keys.append(reset);
      line.append(keys);
      break;
    }
    case "toggle": {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "menu-switch";
      sw.dataset.key = key;
      sw.setAttribute("role", "switch");
      sw.setAttribute("aria-checked", String(row.value));
      sw.setAttribute("aria-labelledby", label.id);
      const state = document.createElement("span");
      state.textContent = row.value ? t("common.on") : t("common.off");
      sw.append(document.createElement("i"), state);
      sw.addEventListener("click", () => row.onChange(!row.value));
      line.append(sw);
      break;
    }
    case "choice": {
      const group = document.createElement("div");
      group.className = "menu-choice";
      group.setAttribute("role", "radiogroup");
      group.setAttribute("aria-labelledby", label.id);
      row.options.forEach((option, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = option.label;
        b.dataset.key = `${key}-${i}`;
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", String(option.value === row.value));
        b.addEventListener("click", () => {
          if (option.value !== row.value) row.onChange(option.value);
        });
        group.append(b);
      });
      line.append(group);
      break;
    }
    case "slider": {
      const wrap = document.createElement("div");
      wrap.className = "menu-slider";
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(row.min);
      input.max = String(row.max);
      input.step = String(row.step);
      input.value = String(row.value);
      input.dataset.key = key;
      input.setAttribute("aria-labelledby", label.id);
      const out = document.createElement("output");
      out.textContent = row.format(row.value);
      input.setAttribute("aria-valuetext", out.textContent);
      input.addEventListener("input", () => {
        const v = Number(input.value);
        out.textContent = row.format(v);
        input.setAttribute("aria-valuetext", out.textContent);
        row.onChange(v, false);
      });
      input.addEventListener("change", () => row.onChange(Number(input.value), true));
      // Les flèches règlent le curseur : elles ne doivent pas piloter le robot
      input.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") e.stopPropagation();
      });
      wrap.append(input, out);
      line.append(wrap);
      break;
    }
    case "text": {
      const input = textInput(row.value, row.placeholder, row.onChange);
      input.dataset.key = key;
      input.setAttribute("aria-labelledby", label.id);
      line.append(input);
      break;
    }
    case "button": {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "menu-action";
      b.dataset.key = key;
      b.textContent = row.action;
      b.addEventListener("click", row.onSelect);
      line.append(b);
      break;
    }
  }
  return line;
}

function textInput(value: string, placeholder: string | undefined, onInput: (value: string) => void): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  input.placeholder = placeholder ?? "";
  input.spellcheck = false;
  input.addEventListener("input", () => onInput(input.value));
  // Les touches tapées ne doivent pas piloter le robot ni ouvrir la pause
  input.addEventListener("keydown", (e) => e.stopPropagation());
  return input;
}

function paragraph(className: string, text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = className;
  p.textContent = text;
  return p;
}
