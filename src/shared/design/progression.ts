import type { BlockType } from "../catalog/blocks";
import type { WheelType } from "../catalog/wheels";
import type { RobotDesign } from "./robotDesign";

/*
 * Progression du joueur : des crédits gagnés en partie, dépensés pour débloquer des pièces au
 * garage. Les prix et les récompenses sont des règles du jeu (le serveur pourra les appliquer) ;
 * ce que possède un joueur est gardé côté client (client/progress.ts).
 */

/**
 * Prix de déblocage de chaque type de bloc (crédits ; 0 : disponible dès le départ). Chaque
 * nouveau type de bloc doit avoir le sien : TypeScript refuse un type oublié.
 */
export const BLOCK_PRICES: Readonly<Record<BlockType, number>> = {
  frame: 0, armorLight: 0, armor: 0, cockpit: 0, battery: 0, wing: 0, flap: 0, gunTurret: 0,
  armorHeavy: 150, armorReactive: 200,
  // Formes : celles des blindages léger et normal sont libres, celles du lourd se débloquent
  wedgeLight: 0, wedge: 0, cornerLight: 0, corner: 0, innerCornerLight: 0, innerCorner: 0, roundLight: 0, round: 0,
  roundCornerLight: 0, roundCorner: 0, slopeLowLight: 0, slopeLow: 0, slopeHighLight: 0, slopeHigh: 0, slabLight: 0, slab: 0,
  wedgeHeavy: 100, cornerHeavy: 100,
  thruster: 100, engine: 150, rotor: 250, hoverPad: 200, leg: 250,
  sniperTurret: 200, cannonTurret: 250, missileLauncher: 300, flakLauncher: 250, mineLayer: 150,
  flamerTurret: 150, empTurret: 350, smokeLauncher: 100, laserTurret: 350, railTurret: 500,
  shotgunTurret: 150, rocketPod: 300, plasmaTurret: 350, lockonLauncher: 400, warheadLauncher: 600, bombBay: 350,
  empMineLayer: 300, fireMineLayer: 250, smokeMineLayer: 150, bounceMineLayer: 250, aaMineLayer: 350, remoteMineLayer: 300,
  sensorMineLayer: 200, stickyMineLayer: 300, repairTurret: 400, flareLauncher: 200, naniteLauncher: 450, barrierProjector: 500,
  headlight: 60, beacon: 60, navLight: 30, strobe: 50, antiCollision: 50, rotatingLight: 70, policeBar: 80,
  propeller: 150, jet: 400,
  // Armes de contact
  spinner: 450, hammer: 400, flipper: 400, flail: 350, jaw: 450,
  // Armes de contact d'énergie
  laserBlade: 500, plasmaWhip: 450, shockLance: 450, crusherField: 500,
  verticalSpinner: 450, drum: 400, shellSpinner: 600,
  // Armes de contact qui mordent
  saw: 420, drill: 480,
  repairModule: 250, radar: 150, jammer: 200, shield: 450,
};

/** Une roue directrice coûte plus que la fixe de sa taille ; la roulette est disponible d'emblée. */
export const WHEEL_PRICES: Readonly<Record<WheelType, number>> = {
  standard: 0, steered: 60, small: 0, smallSteered: 40, heavy: 150, heavySteered: 230, caster: 0, track: 200,
};

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
