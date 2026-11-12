import { columnsOf, gridMove, isGridKey } from "./gridNav";

export interface CardGridOptions<T> {
  /** Nom de la grille pour les lecteurs d'écran (« Robots »). */
  label: string;
  /** Une carte est sélectionnée (ou aucune) : la fiche suit. */
  onSelect: (item: T | null) => void;
  /** Une carte est choisie : Entrée, double clic, ou au doigt un second toucher sur la carte sélectionnée. */
  onPick: (item: T) => void;
}

/**
 * Une grille de cartes à choisir (les robots, les arènes) : elle occupe la largeur qu'on lui donne,
 * autant de colonnes qu'il en tient (CSS). Une carte sélectionnée à la fois. Clavier : flèches dans
 * les deux dimensions, Début, Fin, pages, Entrée pour choisir ; la manette envoie les mêmes touches
 * (menu.ts) ; souris : un clic sélectionne, un double clic choisit ; au doigt, un toucher sélectionne
 * et un second toucher sur la même carte la choisit. La grille défile seule quand elle a sa hauteur
 * (grand écran), sinon c'est la page qui défile (téléphone).
 */
export class CardGrid<T> {
  readonly element: HTMLElement;
  private readonly options: CardGridOptions<T>;
  private readonly cards = new Map<T, HTMLButtonElement>();
  /** Cartes visibles, dans l'ordre affiché. */
  private visible: T[] = [];
  private current: T | null = null;
  /** Le dernier appui venait-il d'un doigt ? (un second toucher sur la carte sélectionnée la choisit) */
  private touching = false;

  constructor(options: CardGridOptions<T>) {
    this.options = options;
    const grid = document.createElement("div");
    grid.className = "picker-grid";
    grid.setAttribute("role", "listbox");
    grid.setAttribute("aria-label", options.label);
    grid.addEventListener("keydown", (e) => this.onKey(e));
    grid.addEventListener("pointerdown", (e) => (this.touching = e.pointerType === "touch" || e.pointerType === "pen"), { capture: true });
    this.element = grid;
  }

  get selected(): T | null {
    return this.current;
  }

  /** Les cartes visibles, dans l'ordre affiché. */
  get shown(): readonly T[] {
    return this.visible;
  }

  /** Ajoute la carte d'un élément (créée par l'appelant : son contenu lui appartient). */
  add(item: T, card: HTMLButtonElement): void {
    card.type = "button";
    card.classList.add("picker-card");
    card.setAttribute("role", "option");
    card.setAttribute("aria-selected", "false");
    card.tabIndex = -1;
    card.addEventListener("click", () => {
      const again = this.touching && item === this.current;
      this.select(item);
      if (again) this.options.onPick(item);
    });
    card.addEventListener("dblclick", () => this.options.onPick(item));
    card.addEventListener("focus", () => this.select(item));
    this.cards.set(item, card);
    this.element.append(card);
  }

  /**
   * Montre ces éléments, dans cet ordre (les autres sont cachés). La sélection reste si son élément
   * est encore visible (ou passe à `prefer`, s'il l'est), sinon au premier.
   */
  show(items: readonly T[], prefer?: T | null): void {
    this.visible = [...items];
    const shown = new Set(this.visible);
    for (const [item, card] of this.cards) card.hidden = !shown.has(item);
    for (const item of this.visible) this.element.append(this.cards.get(item)!);
    const keep = prefer && shown.has(prefer) ? prefer : this.current && shown.has(this.current) ? this.current : this.visible[0] ?? null;
    if (keep !== this.current) this.select(keep);
    else if (keep) this.reveal(keep);
  }

  /** Sélectionne un élément : sa carte est marquée, la fiche suit. */
  select(item: T | null, page = false): void {
    if (item === this.current) {
      if (item) this.reveal(item, page);
      return;
    }
    this.current = item;
    for (const [i, card] of this.cards) {
      card.setAttribute("aria-selected", String(i === item));
      card.tabIndex = i === item ? 0 : -1;
    }
    if (item) this.reveal(item, page);
    this.options.onSelect(item);
  }

  /** Donne le focus à la carte sélectionnée (ou à la première). */
  focus(): void {
    this.focusItem(this.current && this.visible.includes(this.current) ? this.current : this.visible[0]);
  }

  private focusItem(item: T | undefined, page = false): void {
    if (item === undefined) return;
    this.select(item, page);
    this.cards.get(item)!.focus({ preventScroll: true });
    this.reveal(item, page);
  }

  /**
   * Fait voir la carte. Quand la grille défile seule (grand écran), on la fait défiler, elle seule.
   * Sinon (téléphone : la page défile), seulement quand on se déplace au clavier ou à la manette
   * (`page`) : à l'ouverture, le titre et les filtres restent en vue.
   */
  private reveal(item: T, page = false): void {
    const card = this.cards.get(item)!;
    const grid = this.element;
    if (grid.scrollHeight > grid.clientHeight + 1 && getComputedStyle(grid).overflowY !== "visible") {
      const c = card.getBoundingClientRect();
      const g = grid.getBoundingClientRect();
      if (c.top < g.top) grid.scrollTop -= g.top - c.top + 6;
      else if (c.bottom > g.bottom) grid.scrollTop += c.bottom - g.bottom + 6;
    } else if (page) {
      card.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  /** Colonnes de la grille et rangées qui tiennent à l'écran (une page), relevées sur la page. */
  private shape(): { columns: number; rows: number } {
    const cards = this.visible.map((i) => this.cards.get(i)!);
    const columns = columnsOf(cards.slice(0, 64).map((c) => c.offsetTop));
    const height = cards[0]?.offsetHeight ?? 1;
    const view = Math.min(this.element.clientHeight || Infinity, window.innerHeight);
    return { columns, rows: Math.max(1, Math.floor(view / Math.max(1, height + 8))) };
  }

  private onKey(e: KeyboardEvent): void {
    // (Espace sur une carte la « clique » : ce n'est pas un toucher)
    this.touching = false;
    if (isGridKey(e.key)) {
      const { columns, rows } = this.shape();
      const index = this.current ? this.visible.indexOf(this.current) : -1;
      const next = gridMove(index, this.visible.length, columns, e.key, rows);
      // Au bord de la grille : rien (le menu donne le focus à la commande voisine, à la manette)
      if (next === null) return;
      e.preventDefault();
      e.stopPropagation();
      this.focusItem(this.visible[next], true);
    } else if (e.key === "Enter" && this.current) {
      e.preventDefault();
      e.stopPropagation();
      this.options.onPick(this.current);
    }
  }
}
