import { terrainHeight } from "../../../shared/arena/terrain";
import type { ArenaLayout } from "../../../shared/arena/layout";
import { blockWorldPos } from "../../../shared/robot/queries";
import type { Vec3 } from "../../../shared/math/vec";
import type { Block, Part, Wheel } from "../../../shared/sim/entities";
import type { World } from "../../../shared/sim/world";
import { groundColor } from "../arenaView";

/**
 * Ce qu'un effet peut lire sans danger : les morceaux encore dans le monde (le corps d'un morceau
 * retiré est libéré, et le lire fige la physique jusqu'au rechargement de la page) et les roues
 * pas encore retirées (même raison : une épave retirée par `removeBot` garde son corps libéré).
 * Tenu à jour d'après les événements du monde, dont on se désabonne avec `dispose`.
 */
export class LiveSet {
  readonly parts = new Set<Part>();
  private readonly goneWheels = new WeakSet<Wheel>();
  private readonly off: () => void;

  constructor(world: World) {
    for (const bot of world.bots) for (const part of bot.parts) this.parts.add(part);
    this.off = world.on((e) => {
      if (e.type === "partAdded") this.parts.add(e.part);
      else if (e.type === "partRemoved") this.parts.delete(e.part);
      else if (e.type === "wheelRemoved") this.goneWheels.add(e.wheel);
    });
  }

  /** Le bloc est-il là, sur un morceau dont on peut lire le corps ? */
  blockOk(block: Block): boolean {
    return block.alive && this.parts.has(block.part);
  }

  /** Position du bloc dans le monde, s'il est encore là. */
  blockPos(block: Block): Vec3 | null {
    return this.blockOk(block) ? blockWorldPos(block) : null;
  }

  /** La roue est-elle encore là (montée, ou épave pas encore retirée) ? */
  wheelOk(wheel: Wheel): boolean {
    return !this.goneWheels.has(wheel);
  }

  dispose(): void {
    this.off();
    this.parts.clear();
  }
}

/** Nombre d'émissions pendant `dt` pour `rate` par seconde, en moyenne juste (tirage du reste). */
export function countOf(rate: number, dt: number): number {
  return Math.floor(rate * dt + Math.random());
}

/** Couleur « #rrggbb » arrondie à 1/24 par composante : le cache de couleurs des champs d'effets reste petit. */
export function toHex(r: number, g: number, b: number): string {
  const q = (v: number): string => Math.round(Math.max(0, Math.min(1, Math.round(v * 24) / 24)) * 255).toString(16).padStart(2, "0");
  return `#${q(r)}${q(g)}${q(b)}`;
}

/** Couleur du sol plat des petites arènes (voir `createGround`, render/scene.ts). */
const FLAT = { r: 0xbc / 255, g: 0xc6 / 255, b: 0xcb / 255 };
/** Couleur d'une piste, d'un tablier, d'un toit plat : un gris neutre. */
const DECK = { r: 0.55, g: 0.54, b: 0.52 };

/**
 * Couleur du sol (0 à 1 par composante) sous le point (x, y, z) : celle du relief, comme le dessine
 * `ArenaView` ; le sol plat des petites arènes ; un gris neutre sur le décor (piste, pont…).
 */
export function groundRgb(arena: ArenaLayout, x: number, y: number, z: number): { r: number; g: number; b: number } {
  if (!arena.terrain) return y > 0.15 ? DECK : FLAT;
  const h = Math.max(0, terrainHeight(arena.terrain, x, z));
  if (y > h + 0.2) return DECK;
  const c = groundColor(x, h, z, 0.95, arena.water ?? -Infinity, arena.paths ?? [], arena);
  return { r: c.r, g: c.g, b: c.b };
}
