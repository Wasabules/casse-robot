import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { BATTLE_ROSTER } from "../src/shared/design/presets";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnWave } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";

/*
 * La simulation est déterministe : deux batailles de la même graine donnent exactement le même monde,
 * au bit près. C'est le garde-fou des déménagements prévus de la simulation (dans un Worker, puis en
 * code compilé) : la même graine doit y donner la même empreinte, et c'est aussi ce que demandera la
 * prédiction côté client.
 */

beforeAll(async () => {
  await initPhysics();
});

afterAll(() => vi.restoreAllMocks());

/**
 * Empreinte du monde après `seconds` s de bataille à douze robots (BATTLE_ROSTER) : les poses et
 * vitesses exactes de chaque morceau, les points de chaque bloc, les projectiles, les événements.
 */
function fingerprint(seed: number, seconds: number): { hash: string; events: number; destroyed: number } {
  seedRandom(seed);
  const sim = new Simulation();
  spawnWave(sim, BATTLE_ROSTER);
  let events = 0;
  sim.on(() => events++);
  for (let i = 0; i < seconds * 60; i++) sim.step();
  // FNV-1a sur 32 bits, sur les octets exacts des nombres (pas d'arrondi : au bit près)
  let h = 0x811c9dc5;
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  const mix = (x: number): void => {
    view.setFloat64(0, x);
    for (const b of bytes) h = Math.imul(h ^ b, 0x01000193);
  };
  for (const bot of sim.bots) {
    mix(bot.blocks.size);
    for (const part of bot.parts) {
      if (!part.rb.isValid()) continue;
      const t = part.rb.translation(), r = part.rb.rotation(), v = part.rb.linvel(), w = part.rb.angvel();
      for (const x of [t.x, t.y, t.z, r.x, r.y, r.z, r.w, v.x, v.y, v.z, w.x, w.y, w.z]) mix(x);
    }
    for (const block of bot.blocks.values()) mix(block.hp);
  }
  for (const p of sim.projectiles) for (const x of [p.pos.x, p.pos.y, p.pos.z]) mix(x);
  mix(events);
  const destroyed = sim.destroyedCount;
  sim.dispose();
  return { hash: (h >>> 0).toString(16).padStart(8, "0"), events, destroyed };
}

it("deux batailles de la même graine donnent exactement le même monde", { timeout: 120_000 }, () => {
  const a = fingerprint(3, 12);
  const b = fingerprint(3, 12);
  // (une bataille qui ne se passe rien ne prouverait pas grand-chose)
  expect(a.destroyed).toBeGreaterThan(0);
  expect(b).toEqual(a);
  expect(fingerprint(4, 12).hash).not.toBe(a.hash);
});
