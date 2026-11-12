import { BLOCK_PRICES } from "../catalog/blocks";
import type { BlockType } from "../catalog/blocks";
import { WHEEL_PRICES } from "../catalog/wheels";
import type { WheelType } from "../catalog/wheels";
import type { RobotDesign } from "./robotDesign";

/*
 * Progression du joueur : des crédits gagnés en partie, dépensés pour débloquer des pièces au
 * garage. Les prix et les récompenses sont des règles du jeu (le serveur pourra les appliquer) ;
 * ce que possède un joueur est gardé côté client (client/progress.ts).
 */

/**
 * Prix de déblocage de chaque type de bloc : chaque fichier de bloc donne le sien
 * (content/blocks/<type>.json), les blocs de forme ont les leurs (catalog/blocks.ts).
 */
export { BLOCK_PRICES } from "../catalog/blocks";

/** Prix de déblocage de chaque type de roue : chaque fichier de roue donne le sien (content/wheels/<type>.json). */
export { WHEEL_PRICES } from "../catalog/wheels";

/**
 * Pièces débloquées d'une version précédente : la roue directrice n'était qu'une option d'une roue ;
 * qui avait débloqué la roue lourde a donc aussi la roue lourde directrice.
 */
export function upgradeUnlocked(keys: readonly string[]): string[] {
  const set = new Set(keys);
  if (set.has("wheel:heavy")) set.add("wheel:heavySteered");
  return [...set];
}

/** Une pièce : un type de bloc ou de roue. */
export type Part = { kind: "block"; type: BlockType } | { kind: "wheel"; type: WheelType };

/** Clé d'une pièce dans la liste des pièces débloquées. */
export const partKey = (part: Part): string => `${part.kind}:${part.type}`;
export const partPrice = (part: Part): number => (part.kind === "block" ? BLOCK_PRICES[part.type] : WHEEL_PRICES[part.type]);

/**
 * Progression d'un joueur, en données JSON : ses crédits et les pièces qu'il a débloquées (clés de
 * `partKey`). Le serveur en garde une par joueur (server/progressBook.ts).
 */
export interface Ledger {
  credits: number;
  unlocked: string[];
}

/** Le joueur a-t-il cette pièce ? Les pièces gratuites, toujours. */
export const hasPart = (ledger: Ledger, part: Part): boolean => partPrice(part) === 0 || ledger.unlocked.includes(partKey(part));

/** Débloque ces pièces si les crédits suffisent pour toutes ; renvoie leur prix, ou null (rien n'est débloqué). */
export function unlockParts(ledger: Ledger, parts: readonly Part[]): number | null {
  const missing = parts.filter((p) => !hasPart(ledger, p));
  const price = missing.reduce((sum, p) => sum + partPrice(p), 0);
  if (price > ledger.credits) return null;
  ledger.credits -= price;
  for (const p of missing) ledger.unlocked.push(partKey(p));
  return price;
}

/** Les pièces d'un plan que le joueur n'a pas (d'après `has`), sans doublon. */
export function lockedParts(design: RobotDesign, has: (part: Part) => boolean): Part[] {
  const parts = new Map<string, Part>();
  for (const b of design.blocks) parts.set(`block:${b.type}`, { kind: "block", type: b.type });
  for (const w of design.wheels) parts.set(`wheel:${w.type}`, { kind: "wheel", type: w.type });
  return [...parts.values()].filter((p) => !has(p));
}

/** Ce qui rapporte des crédits dans une partie. */
export const REWARDS = { played: 40, win: 120, draw: 50, kill: 20, capture: 10 } as const;

export interface MatchResult {
  outcome: "win" | "draw" | "loss";
  /** Robots détruits par le joueur. */
  kills: number;
  /** Zones prises par son équipe (capture de zones). */
  captures: number;
}

/**
 * Une ligne du détail des crédits : ce qui les rapporte (`n` : combien de destructions, de zones),
 * et le montant. Le client la dit dans la langue du joueur (`reward.<kind>`).
 */
export interface RewardLine {
  kind: "played" | "win" | "draw" | "kills" | "captures";
  n: number;
  credits: number;
}

/** Crédits gagnés, et leur détail. */
export interface Reward {
  total: number;
  lines: RewardLine[];
}

/** Crédits gagnés, et leur détail. */
export function matchReward(r: MatchResult): Reward {
  const lines: RewardLine[] = [{ kind: "played", n: 1, credits: REWARDS.played }];
  if (r.outcome === "win") lines.push({ kind: "win", n: 1, credits: REWARDS.win });
  if (r.outcome === "draw") lines.push({ kind: "draw", n: 1, credits: REWARDS.draw });
  if (r.kills) lines.push({ kind: "kills", n: r.kills, credits: r.kills * REWARDS.kill });
  if (r.captures) lines.push({ kind: "captures", n: r.captures, credits: r.captures * REWARDS.capture });
  return { total: lines.reduce((s, l) => s + l.credits, 0), lines };
}
