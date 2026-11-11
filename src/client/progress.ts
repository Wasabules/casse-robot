import { partKey, partPrice, upgradeUnlocked, type Part } from "../shared/design/progression";

/**
 * Progression du joueur, gardée dans le navigateur : ses crédits et les pièces qu'il a débloquées.
 * En bac à sable (réglage), toutes les pièces sont à lui.
 */
export class Progress {
  credits = 0;
  private readonly unlocked = new Set<string>();
  /** Bac à sable : toutes les pièces sont disponibles. */
  sandbox = false;

  constructor() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as { credits?: unknown; unlocked?: unknown };
      if (typeof saved.credits === "number" && Number.isFinite(saved.credits) && saved.credits >= 0) this.credits = Math.floor(saved.credits);
      if (Array.isArray(saved.unlocked)) {
        for (const k of upgradeUnlocked(saved.unlocked.filter((k): k is string => typeof k === "string"))) this.unlocked.add(k);
      }
    } catch {
      // Pas de stockage, ou illisible : on repart de zéro
    }
  }

  /** Le joueur peut-il poser cette pièce ? */
  has(part: Part): boolean {
    return this.sandbox || partPrice(part) === 0 || this.unlocked.has(partKey(part));
  }

  /** Pièces achetées (hors pièces gratuites). */
  get count(): number {
    return this.unlocked.size;
  }

  earn(credits: number): void {
    this.credits += Math.max(0, Math.round(credits));
    this.save();
  }

  /** Débloque la pièce si le joueur en a les moyens ; renvoie false sinon. */
  buy(part: Part): boolean {
    if (this.has(part)) return true;
    const price = partPrice(part);
    if (this.credits < price) return false;
    this.credits -= price;
    this.unlocked.add(partKey(part));
    this.save();
    return true;
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ credits: this.credits, unlocked: [...this.unlocked] }));
    } catch {
      // Pas de stockage : la progression vaut pour cette visite seulement
    }
  }
}

const KEY = "casse-robot.progress";
const TOKEN_KEY = "casse-robot.token";

/**
 * Jeton du joueur : un secret tiré au hasard une fois, gardé dans le navigateur. Il désigne sa
 * progression sur les serveurs de jeu (crédits gagnés et pièces débloquées là-bas) ; sans
 * stockage, il ne vaut que pour la visite.
 */
export function playerToken(): string {
  try {
    const saved = localStorage.getItem(TOKEN_KEY);
    if (saved && /^[a-z0-9-]{16,64}$/.test(saved)) return saved;
  } catch {
    // Pas de stockage : un jeton pour cette visite
  }
  const token = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Idem
  }
  return token;
}
