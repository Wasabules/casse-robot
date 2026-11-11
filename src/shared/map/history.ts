import type { MapFile } from "./format";

/*
 * Historique d'annulation de l'éditeur de cartes : les cartes successives, telles quelles (les
 * opérations d'édition rendent une nouvelle carte et partagent ce qui ne change pas : un relief non
 * touché n'est gardé qu'une fois). Un coup de pinceau est une seule modification. Le relief d'une
 * grande carte pèse jusqu'à 1 Mo en texte : l'historique en garde au plus `budget` octets (les plus
 * anciennes modifications s'en vont d'abord), et au plus `limit` modifications.
 */

/** Au plus autant de modifications, et autant d'octets de reliefs différents. */
const LIMIT = 100;
const BUDGET = 48 * 1024 * 1024;

export class MapHistory {
  private past: MapFile[] = [];
  private future: MapFile[] = [];
  private now: MapFile;
  private readonly limit: number;
  private readonly budget: number;

  constructor(initial: MapFile, limit = LIMIT, budget = BUDGET) {
    this.now = initial;
    this.limit = limit;
    this.budget = budget;
  }

  /** La carte telle qu'elle est. */
  get current(): MapFile {
    return this.now;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Nombre de modifications qu'on peut annuler, et rétablir. */
  get depth(): { undo: number; redo: number } {
    return { undo: this.past.length, redo: this.future.length };
  }

  /** Une modification : la carte d'avant passe dans le passé (une carte identique à l'actuelle ne compte pas). */
  push(map: MapFile): void {
    if (map === this.now) return;
    this.past.push(this.now);
    this.now = map;
    this.future = [];
    this.trim();
  }

  /** Repart d'une carte (une autre carte ouverte) : plus rien à annuler. */
  reset(map: MapFile): void {
    this.past = [];
    this.future = [];
    this.now = map;
  }

  undo(): MapFile | null {
    const previous = this.past.pop();
    if (!previous) return null;
    this.future.push(this.now);
    this.now = previous;
    return previous;
  }

  redo(): MapFile | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(this.now);
    this.now = next;
    return next;
  }

  /** Octets des reliefs différents que garde l'historique (une estimation : un caractère par octet). */
  get bytes(): number {
    const seen = new Set<string>();
    let total = 0;
    for (const map of [...this.past, this.now, ...this.future]) {
      const h = map.terrain?.heights;
      if (h && !seen.has(h)) {
        seen.add(h);
        total += h.length;
      }
    }
    return total;
  }

  private trim(): void {
    while (this.past.length > this.limit) this.past.shift();
    while (this.past.length && this.bytes > this.budget) this.past.shift();
  }
}
