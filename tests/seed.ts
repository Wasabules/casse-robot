import { vi } from "vitest";

/**
 * Remplace Math.random par un générateur à graine fixe (mulberry32) : l'IA et les rafales
 * d'air deviennent reproductibles d'un lancement à l'autre.
 */
export function seedRandom(seed: number): void {
  let a = seed >>> 0;
  vi.spyOn(Math, "random").mockImplementation(() => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  });
}
