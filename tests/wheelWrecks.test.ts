import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyDamage } from "../src/shared/combat/damage";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { vec3 } from "../src/shared/math/vec";
import { readSnapshot, writeSnapshot } from "../src/shared/net/snapshot";
import { removeBot, WHEEL_WRECK_LIFE } from "../src/shared/robot/lifecycle";
import type { Bot, Wheel } from "../src/shared/sim/entities";
import type { SimEvent } from "../src/shared/sim/events";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnWave } from "../src/shared/sim/wave";
import { LETHAL } from "./helpers";
import { seedRandom } from "./seed";

describe("épaves de roues", () => {
  let sim: Simulation;
  let events: SimEvent[];
  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(4);
    sim = new Simulation();
    events = [];
    sim.on((e) => events.push(e));
    spawnWave(sim, PRESET_BOTS.filter((p) => p.id === "buggy"));
    sim.aiPaused = true;
    for (let i = 0; i < 30; i++) sim.step();
  });
  afterEach(() => sim.dispose());

  /** Un tir mortel sur la roue : montée, elle est arrachée ; arrachée, son épave cède. */
  const shoot = (w: Wheel): void => {
    const at = w.rb.translation();
    applyDamage(sim, vec3(at.x, at.y, at.z), vec3(0, -1, 0), LETHAL, { kind: "wheel", wheel: w }, vec3(at.x, at.y + 20, at.z));
  };
  const buggy = (): Bot => sim.bots[0];

  it("une roue arrachée laisse une épave, qui cède sous un tir : son corps disparaît", () => {
    const w = buggy().wheels[0];
    shoot(w);
    expect(w.part).toBeNull();
    expect(w.body).not.toBeNull();
    expect(w.hp).toBeGreaterThan(0); // l'épave a des points à elle
    const handle = w.collider.handle;
    sim.step();
    shoot(w);
    expect(w.body).toBeNull();
    expect(sim.colliders.has(handle)).toBe(false);
    expect(events.some((e) => e.type === "wheelRemoved" && e.wheel === w)).toBe(true);
    // Elle n'est plus dans les instantanés du réseau, et sa pose se lit sans corps
    expect(readSnapshot(writeSnapshot(sim)).wheels.has(w.id)).toBe(false);
    expect(Number.isFinite(w.rb.translation().x)).toBe(true);
    for (let i = 0; i < 30; i++) sim.step();
  });

  it("une épave de roue ne reste pas indéfiniment sur le terrain", () => {
    const w = buggy().wheels[1];
    shoot(w);
    expect(w.body).not.toBeNull();
    for (let i = 0; i < (WHEEL_WRECK_LIFE - 1) * 60; i++) sim.step();
    expect(w.body).not.toBeNull();
    for (let i = 0; i < 2 * 60; i++) sim.step();
    expect(w.body).toBeNull();
    expect(events.filter((e) => e.type === "wheelRemoved" && e.wheel === w)).toHaveLength(1);
  });

  it("un robot retiré laisse à l'épave de sa roue une pose figée, pas son corps libéré", () => {
    const bot = buggy();
    const w = bot.wheels[2];
    shoot(w);
    expect(w.body).not.toBeNull();
    const at = w.rb.translation();
    removeBot(sim, bot);
    expect(w.body).toBeNull();
    // (relire un corps libéré ferait paniquer Rapier : la pose se lit sans lui, là où était l'épave)
    expect(w.rb.translation()).toEqual({ x: at.x, y: at.y, z: at.z });
    for (let i = 0; i < 30; i++) sim.step();
  });
});
