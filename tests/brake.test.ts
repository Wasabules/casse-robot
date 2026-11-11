import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { dot, qrot, vec3 } from "../src/shared/math/vec";
import type { Bot } from "../src/shared/sim/entities";
import { takeControl } from "../src/shared/sim/player";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { groundHeight, spawnBot } from "../src/shared/robot/lifecycle";
import { seedRandom } from "./seed";

/*
 * Boost et frein du robot piloté (sim/player.ts, robot/propulsion.ts). Le boost ne doit jamais
 * retenir le robot (Maj freinait : roues débrayées, appuis ramenés à l'arrêt) ; le frein l'arrête
 * franchement, sans le renverser, et il repart dès qu'on le relâche.
 */
describe("boost et frein du robot piloté", () => {
  let sim: Simulation;

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(3);
    sim = new Simulation();
  });
  afterEach(() => sim.dispose());

  /**
   * Ce robot seul dans le Dépôt, au bout d'une longue allée dégagée (de x = 28 vers -x, le long du
   * mur sud), posé, aux commandes du joueur (`sim.input`).
   */
  const piloted = (id: string): Bot => {
    const profile = PRESET_BOTS.find((p) => p.id === id)!;
    sim.combat = false;
    const bot = spawnBot(sim, profile, vec3(28, groundHeight(profile.design) + 0.03, -27), -Math.PI / 2);
    sim.bots.push(bot);
    // Aux commandes du joueur d'emblée : l'IA ne le tourne pas pendant qu'il se pose
    takeControl(bot, sim.input);
    for (let i = 0; i < 60; i++) sim.step();
    return bot;
  };
  /** Vitesse le long de son avant (m/s). */
  const forwardSpeed = (bot: Bot): number => {
    const rb = bot.cockpit.part.rb;
    return dot(rb.linvel(), qrot(rb.rotation(), vec3(0, 0, 1)));
  };
  const upright = (bot: Bot): number => qrot(bot.cockpit.part.rb.rotation(), vec3(0, 1, 0)).y;
  /** Avance de `seconds` s ; `each` après chaque pas. */
  const run = (seconds: number, each?: () => void): void => {
    for (let i = 0; i < seconds * 60; i++) {
      sim.step();
      each?.();
    }
  };

  it("sans propulseur, le boost fait sprinter les moteurs des roues, sans jamais freiner (Scarabée)", () => {
    const bot = piloted("scarab");
    sim.input.throttle = 1;
    run(4);
    const cruise = forwardSpeed(bot);
    sim.input.boost = true;
    let low = Infinity;
    run(2, () => (low = Math.min(low, forwardSpeed(bot))));
    expect(cruise).toBeGreaterThan(2.5);
    expect(low).toBeGreaterThan(cruise - 0.1);
    expect(forwardSpeed(bot)).toBeGreaterThan(cruise * 1.15);
  });

  it("avec un propulseur, la vitesse ne retombe pas pendant qu'il monte en régime (Fusée)", () => {
    const bot = piloted("rocket");
    sim.input.throttle = 1;
    run(4);
    const cruise = forwardSpeed(bot);
    sim.input.boost = true;
    let low = Infinity;
    run(2, () => (low = Math.min(low, forwardSpeed(bot))));
    expect(low).toBeGreaterThan(cruise - 0.1);
    expect(forwardSpeed(bot)).toBeGreaterThan(cruise + 2);
  });

  it("patins et pattes : le boost ne les arrête plus, il les fait aller plus vite", () => {
    for (const id of ["hovercraft", "spider"]) {
      sim.dispose();
      seedRandom(3);
      sim = new Simulation();
      const bot = piloted(id);
      sim.input.throttle = 1;
      sim.input.boost = false;
      run(4);
      const cruise = forwardSpeed(bot);
      sim.input.boost = true;
      let low = Infinity;
      run(1.5, () => (low = Math.min(low, forwardSpeed(bot))));
      expect(cruise, id).toBeGreaterThan(1.5);
      expect(low, id).toBeGreaterThan(cruise * 0.95);
      expect(forwardSpeed(bot), id).toBeGreaterThan(cruise * 1.1);
    }
  });

  it("le frein arrête bien plus vite que de lâcher les gaz, sans renverser le robot, puis il repart", () => {
    // Roues, chenilles, pattes, patins ; l'Échassier est haut sur une base étroite
    for (const id of ["trike", "tank", "spider", "hovercraft", "stilt"]) {
      const stopTime = (brake: number): { time: number; tilt: number } => {
        sim.dispose();
        seedRandom(3);
        sim = new Simulation();
        const bot = piloted(id);
        sim.input.throttle = 1;
        sim.input.brake = 0;
        run(4);
        // Le frein prime sur les gaz, encore tenus ; sans frein, on lâche les gaz
        if (brake) sim.input.brake = brake;
        else sim.input.throttle = 0;
        let time = Infinity;
        let tilt = 1;
        for (let i = 0; i < 6 * 60 && time === Infinity; i++) {
          sim.step();
          tilt = Math.min(tilt, upright(bot));
          if (Math.abs(forwardSpeed(bot)) < 0.3) time = (i + 1) / 60;
        }
        if (brake) {
          // Relâché, il roule de nouveau
          sim.input.brake = 0;
          sim.input.throttle = 1;
          run(2);
          expect(forwardSpeed(bot), `${id} repart`).toBeGreaterThan(1);
        }
        return { time, tilt };
      };
      const braked = stopTime(1);
      const coasted = stopTime(0);
      console.log(`${id} : arrêt en ${braked.time.toFixed(2)} s au frein, ${coasted.time.toFixed(2)} s gaz lâchés ; inclinaison ${braked.tilt.toFixed(3)}`);
      expect(braked.time, id).toBeLessThan(1.6);
      expect(braked.time, id).toBeLessThan(coasted.time);
      expect(braked.tilt, id).toBeGreaterThan(0.85);
    }
  });

  it("le frein prime sur le boost : les propulseurs s'éteignent", () => {
    const bot = piloted("rocket");
    sim.input.throttle = 1;
    sim.input.boost = true;
    run(3);
    sim.input.brake = 1;
    run(2.5);
    expect(Math.abs(forwardSpeed(bot))).toBeLessThan(0.3);
  });
});
