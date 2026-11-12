import { beforeAll, expect, it } from "vitest";
import { PoseInterpolation, ShownPose } from "../src/client/render/interpolation";
import { BATTLE_ROSTER } from "../src/shared/design/presets";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnWave } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";

/*
 * L'interpolation des poses en solo (client/render/interpolation.ts) : pendant le rendu d'une image,
 * les corps des morceaux, des roues, des débris, des accessoires mobiles et la position des
 * projectiles sont remplacés par des poses entre les deux derniers pas, puis rendus à la simulation.
 */

beforeAll(async () => {
  await initPhysics();
});

it("montre au rendu des poses entre les deux derniers pas, puis rend ses corps à la simulation", () => {
  seedRandom(5);
  const sim = new Simulation();
  spawnWave(sim, BATTLE_ROSTER);
  const poses = new PoseInterpolation();
  for (let i = 0; i < 90; i++) {
    sim.step();
    poses.capture(sim);
  }
  // Un morceau qui bouge : sa pose de l'avant-dernier pas, puis celle du dernier
  const part = [...sim.parts].find((p) => Math.hypot(p.rb.linvel().x, p.rb.linvel().z) > 0.5)!;
  expect(part).toBeDefined();
  const body = part.rb;
  const before = body.translation();
  sim.step();
  poses.capture(sim);
  const after = body.translation();

  poses.begin(0.25);
  const shown = part.rb as unknown as ShownPose;
  expect(shown).toBeInstanceOf(ShownPose);
  const p = shown.translation();
  for (const k of ["x", "y", "z"] as const) expect(p[k]).toBeCloseTo(before[k] + 0.25 * (after[k] - before[k]), 6);
  // Les vitesses sont celles du vrai corps ; le centre de masse suit la pose interpolée
  expect(shown.linvel()).toEqual(body.linvel());
  const com = shown.worldCom(), real = body.worldCom();
  for (const k of ["x", "y", "z"] as const) expect(com[k] - p[k]).toBeCloseTo(real[k] - after[k], 1);
  // Les roues (et leur porte-moyeu) aussi, et les projectiles en vol
  const wheel = sim.bots.flatMap((b) => b.wheels).find((w) => w.part);
  if (wheel) expect(wheel.rb).toBeInstanceOf(ShownPose);
  poses.end();
  // Gardée au-delà de son image, une pose ne relit plus aucun corps
  expect(shown.linvel()).toEqual({ x: 0, y: 0, z: 0 });

  // Rendus : la simulation retrouve ses corps et repart
  expect(part.rb).toBe(body);
  if (wheel) expect(wheel.rb).not.toBeInstanceOf(ShownPose);
  for (let i = 0; i < 30; i++) sim.step();

  // Une nouvelle vague : rien de l'ancienne n'est plus remplacé
  poses.begin(0.5);
  poses.reset();
  expect(part.rb).toBe(body);
  sim.dispose();
});
