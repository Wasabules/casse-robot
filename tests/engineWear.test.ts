import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { blockDef } from "../src/shared/catalog/blocks";
import { DamageBatch, ENGINE_FIRE_BELOW, inflict } from "../src/shared/combat/damage";
import { extinguish } from "../src/shared/combat/burning";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { add, qmul, qrot, qrotInv, sub, vec3 } from "../src/shared/math/vec";
import { ENGINE_WORN, wearEngines } from "../src/shared/robot/propulsion";
import type { Bot, Thruster } from "../src/shared/sim/entities";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnWave } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";

describe("moteurs abîmés", () => {
  let sim: Simulation;

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(7);
    sim = new Simulation();
  });
  afterEach(() => sim.dispose());

  const alone = (id: string): Bot => {
    spawnWave(sim, PRESET_BOTS.filter((p) => p.id === id));
    return sim.bots[0];
  };
  const wear = (t: Thruster, health: number): void => {
    t.block.hp = blockDef(t.block.type).hp * health;
  };
  /** Un coup presque sans dégâts sur le bloc de ce moteur. */
  const tap = (t: Thruster, cause: "rifle" | "fire"): void => {
    const batch = new DamageBatch();
    batch.cause = cause;
    batch.add({ kind: "block", block: t.block }, 0.001, "kinetic");
    inflict(sim, batch, vec3(0, -1, 0), null);
  };

  it("un moteur intact donne toute sa poussée ; abîmé, moins, et il a des ratés", () => {
    const drone = alone("drone");
    const t = drone.thrusters[0];
    wearEngines(sim, drone);
    expect(t.output).toBe(1);
    // Juste au-dessus du seuil d'usure : rien ne change
    wear(t, ENGINE_WORN + 0.01);
    wearEngines(sim, drone);
    expect(t.output).toBe(1);
    // À 20 % : moins de poussée, et des coupures brèves, au hasard
    wear(t, 0.2);
    const outputs: number[] = [];
    for (let i = 0; i < 20 * 60; i++) {
      sim.step();
      outputs.push(t.output);
    }
    const running = outputs.filter((o) => o > 0);
    const misfiring = outputs.length - running.length;
    expect(Math.max(...running)).toBeLessThan(0.9);
    expect(Math.min(...running)).toBeGreaterThan(0.45);
    // Quelques ratés par seconde au plus : il tourne l'essentiel du temps
    expect(misfiring).toBeGreaterThan(0);
    expect(misfiring / outputs.length).toBeLessThan(0.35);
  });

  it("un avion au moteur à bout, arrivé bas, se pose et s'arrête sans s'écraser", () => {
    // Au bout de la piste de l'aérodrome de la Vallée (x de 19 à 95, z = -65, à 2,5 m), à x = 75, vers l'ouest
    // à 1,3 m du sol et 11 m/s : il ne redécolle pas, et ne roule pas jusqu'à un mur
    sim.loadArena("valley");
    const plane = alone("plane");
    const engine = plane.thrusters.find((t) => blockDef(t.block.type).thruster?.look === "propeller")!;
    expect(engine).toBeDefined();
    wear(engine, 0.12);
    const c = plane.cockpit.part.rb.translation();
    const q0 = plane.cockpit.part.rb.rotation();
    const yaw = { x: 0, y: -Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
    for (const part of plane.parts) {
      // Chaque morceau garde sa place dans le repère du robot, tourné vers l'ouest (-x)
      const local = qrotInv(q0, sub(part.rb.translation(), c));
      const at = add(vec3(75, 2.5 + 1.3, -65), qrot(yaw, local));
      part.rb.setTranslation(at, true);
      part.rb.setRotation(qmul(yaw, qmul({ x: -q0.x, y: -q0.y, z: -q0.z, w: q0.w }, part.rb.rotation())), true);
      part.rb.setLinvel({ x: -11, y: 0, z: 0 }, true);
      part.rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    const blocks = plane.blocks.size;
    for (let i = 0; i < 10 * 60 && plane.cockpit.alive; i++) sim.step();
    expect(plane.cockpit.alive).toBe(true);
    expect(plane.ai.mode).toBe("stranded");
    const v = plane.cockpit.part.rb.linvel();
    expect(Math.hypot(v.x, v.z)).toBeLessThan(3);
    expect(plane.blocks.size).toBeGreaterThan(blocks * 0.8);
  });

  it("un avion à deux turboréacteurs abîmés garde assez de poussée pour voler", () => {
    const fighter = alone("fighter");
    for (let i = 0; i < 4 * 60; i++) sim.step();
    for (const t of fighter.thrusters) wear(t, 0.2);
    let low = Infinity;
    for (let i = 0; i < 15 * 60; i++) {
      sim.step();
      low = Math.min(low, fighter.cockpit.part.rb.worldCom().y);
    }
    expect(fighter.cockpit.alive).toBe(true);
    expect(fighter.ai.mode).not.toBe("stranded");
    expect(low).toBeGreaterThan(4);
  });

  it("un moteur à bout, touché encore, peut prendre feu ; pas par son propre feu", () => {
    const drone = alone("drone");
    const t = drone.thrusters[0];
    wear(t, ENGINE_FIRE_BELOW * 0.8);
    // Son propre feu ne le rallume pas
    for (let i = 0; i < 40 && t.block.burn <= 0; i++) tap(t, "fire");
    expect(t.block.burn).toBe(0);
    // Une balle, si : une chance sur quelques-unes à chaque coup
    let hits = 0;
    while (t.block.burn <= 0 && hits < 60) {
      tap(t, "rifle");
      hits++;
    }
    expect(t.block.burn).toBeGreaterThan(0);
    expect(hits).toBeGreaterThan(0);
    // Au-dessus du seuil, un moteur touché ne s'allume pas
    extinguish(sim, t.block);
    wear(t, ENGINE_FIRE_BELOW + 0.1);
    for (let i = 0; i < 60; i++) tap(t, "rifle");
    expect(t.block.burn).toBe(0);
  });
});
