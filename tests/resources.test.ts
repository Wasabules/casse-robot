import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BLOCK_TYPES } from "../src/shared/catalog/blocks";
import { RESUME_HEAT, WEAPONS } from "../src/shared/catalog/weapons";
import { canFire, newArmState, readiness, stackRate, tickArm, useArm } from "../src/shared/combat/arsenal";
import { releaseSmoke } from "../src/shared/combat/smoke";
import { SIGHT_RANGE } from "../src/shared/config";
import { PRESET_BOTS, type BotProfile } from "../src/shared/design/presets";
import { vec3 } from "../src/shared/math/vec";
import { groundHeight, spawnBot } from "../src/shared/robot/lifecycle";
import { energyCapacity, energyFraction } from "../src/shared/robot/energy";
import type { Bot, Team } from "../src/shared/sim/entities";
import { isDetected, updateDetection } from "../src/shared/sim/detection";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnWave } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";

const preset = (id: string): BotProfile => PRESET_BOTS.find((p) => p.id === id)!;

describe("surchauffe et munitions", () => {
  it("le fusil surchauffe après une longue rafale, puis refroidit", () => {
    const w = WEAPONS.rifle;
    const arm = newArmState(w);
    let shots = 0;
    while (canFire(arm) && shots < 100) {
      useArm(arm, w);
      shots++;
      tickArm(arm, w, w.cooldown);
    }
    expect(shots).toBeGreaterThan(15);
    expect(shots).toBeLessThan(40);
    expect(arm.overheated).toBe(true);
    tickArm(arm, w, (1 - RESUME_HEAT) / w.heat.cooling + 0.01);
    expect(canFire(arm)).toBe(true);
  });

  it("le lance-missiles vide son chargeur, puis regagne un missile à la fois", () => {
    const w = WEAPONS.missile;
    const arm = newArmState(w);
    for (let i = 0; i < w.ammo.capacity; i++) {
      expect(canFire(arm)).toBe(true);
      useArm(arm, w);
      arm.cooldown = 0; // tir suivant tout de suite, sans laisser le temps de recharger
    }
    expect(canFire(arm)).toBe(false);
    tickArm(arm, w, w.ammo.reload);
    expect(arm.ammo).toBe(1);
    expect(canFire(arm)).toBe(true);
  });
});

describe("jauge du réticule : où en est l'arme", () => {
  it("après un tir, l'arme attend sa cadence, puis elle est prête", () => {
    const w = WEAPONS.cannon;
    const arm = newArmState(w);
    expect(readiness([arm], w)).toMatchObject({ progress: 1, cause: null, magazine: { rounds: 10, capacity: 10 } });
    useArm(arm, w);
    tickArm(arm, w, w.cooldown / 4);
    const r = readiness([arm], w);
    expect(r.cause).toBe("cycle");
    expect(r.span).toBeCloseTo(w.cooldown, 5);
    expect(r.progress).toBeCloseTo(0.25, 2);
    // Le chargeur a perdu un coup, qui se recharge déjà
    expect(r.magazine!.rounds).toBe(9);
    expect(r.magazine!.next).toBeCloseTo(w.cooldown / 4 / w.ammo!.reload, 2);
    tickArm(arm, w, w.cooldown);
    expect(readiness([arm], w).cause).toBeNull();
  });

  it("des armes identiques suivent leur rythme commun, plus rapide que celui d'une seule", () => {
    const w = WEAPONS.cannon;
    const arms = [newArmState(w), newArmState(w)];
    useArm(arms[0], w);
    const r = readiness(arms, w);
    expect(r.span).toBeCloseTo(w.cooldown / stackRate(2), 5);
    expect(r.progress).toBeCloseTo(0, 5);
    // Au bout du rythme commun, la seconde tourelle peut tirer, même si la première attend encore
    tickArm(arms[0], w, w.cooldown / stackRate(2));
    expect(readiness(arms, w).cause).toBeNull();
  });

  it("chargeur vide : l'arme attend qu'un coup se recharge", () => {
    const w = WEAPONS.missile;
    const arm = newArmState(w);
    // Tout le chargeur d'un coup (sans laisser le temps d'en recharger un), puis au-delà de la cadence
    for (let i = 0; i < w.ammo!.capacity; i++) useArm(arm, w);
    tickArm(arm, w, w.cooldown + 1);
    const r = readiness([arm], w);
    expect(arm.ammo).toBe(0);
    expect(r.cause).toBe("reload");
    expect(r.span).toBe(w.ammo!.reload);
    expect(r.progress).toBeCloseTo((w.cooldown + 1) / w.ammo!.reload, 5);
  });

  it("en surchauffe, l'arme attend d'avoir refroidi ; la chaleur se lit sur la tourelle la plus froide", () => {
    const w = WEAPONS.rifle;
    const arm = newArmState(w);
    while (!arm.overheated) useArm(arm, w);
    tickArm(arm, w, 0.5);
    const r = readiness([arm], w);
    expect(r.cause).toBe("overheat");
    expect(r.progress).toBeCloseTo(1 - (arm.heat - RESUME_HEAT) / (1 - RESUME_HEAT), 5);
    expect(r.heat).toEqual({ level: arm.heat, overheated: true });
    expect(readiness([arm, newArmState(w)], w).heat).toEqual({ level: 0, overheated: false });
  });

  it("une arme électrique attend ses batteries ; l'ogive tirée ne se recharge pas", () => {
    const rail = WEAPONS.rail;
    expect(readiness([newArmState(rail)], rail, rail.power! / 4)).toMatchObject({ cause: "energy", progress: 0.25 });
    const warhead = WEAPONS.warhead;
    const arm = newArmState(warhead);
    useArm(arm, warhead);
    tickArm(arm, warhead, 10);
    expect(readiness([arm], warhead)).toMatchObject({ cause: "spent", progress: 0, magazine: { rounds: 0, capacity: 1, next: 0 } });
  });
});

describe("énergie, réparation, détection", () => {
  let sim: Simulation;

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(2);
    sim = new Simulation();
  });
  afterEach(() => sim.dispose());

  const run = (seconds: number): void => {
    for (let i = 0; i < seconds * 60; i++) sim.step();
  };
  const place = (id: string, x: number, z: number, team: Team, y?: number): Bot => {
    const profile = preset(id);
    const bot = spawnBot(sim, profile, vec3(x, y ?? groundHeight(profile.design) + 0.05, z), 0, team);
    sim.bots.push(bot);
    return bot;
  };

  it("le joueur tire ses missiles au rythme de son chargeur, pas de sa cadence", () => {
    let fired = 0;
    const seconds = 30;
    for (let i = 0; i < seconds * 60; i++) {
      if (sim.tryFire("missile", vec3(0, 20, 0), vec3(0, 1, 0))) fired++;
      sim.step();
    }
    const w = WEAPONS.missile;
    // Le chargeur, plus un missile toutes les 6 s : bien moins qu'un toutes les 2,5 s
    expect(fired).toBeGreaterThan(w.ammo.capacity);
    expect(fired).toBeLessThanOrEqual(w.ammo.capacity + Math.ceil(seconds / w.ammo.reload));
    expect(fired).toBeLessThan(seconds / w.cooldown);
  });

  it("batteries presque vides, le Drone se pose pour recharger, puis repart", () => {
    const drone = place("drone", 0, 0, "red", 5);
    run(2);
    drone.energy = 0.05 * energyCapacity(drone);
    run(8);
    expect(drone.ai.mode).toBe("landing");
    expect(drone.cockpit.part.rb.worldCom().y).toBeLessThan(1.6);
    const charging = drone.energy;
    run(3);
    expect(drone.energy).toBeGreaterThan(charging);
    drone.energy = 0.95 * energyCapacity(drone);
    run(0.5);
    expect(drone.ai.mode).not.toBe("landing");
  });

  it("batteries à plat, les rotors n'ont plus que le générateur : l'Hexacoptère descend", () => {
    const hexa = place("hexa", 0, 0, "red", 6);
    sim.aiPaused = true;
    run(2);
    const alt = hexa.cockpit.part.rb.worldCom().y;
    hexa.energy = 0;
    run(3);
    expect(energyFraction(hexa)).toBeLessThan(0.02);
    expect(hexa.cockpit.part.rb.worldCom().y).toBeLessThan(alt - 1.5);
  });

  it("le module de réparation remet en état les blocs abîmés, après un moment de calme", () => {
    const truck = place("truck", 0, 0, "red");
    sim.aiPaused = true;
    run(1);
    const block = truck.blocks.get("-1,1,4")!; // cabine, à côté du module
    block.hp = 30;
    truck.lastHit = sim.time;
    run(2);
    expect(block.hp).toBe(30); // encore trop tôt
    run(5); // 3 s d'attente en tout, puis 20 points par seconde
    expect(block.hp).toBe(BLOCK_TYPES.armor.hp);
  });

  it("la fumée cache un ennemi à la vue, pas au radar ; le brouilleur le cache au radar lointain", () => {
    const stilt = place("stilt", 0, -15, "red");
    const ram = place("ram", 0, 15, "blue");
    const buggy = place("buggy", 12, 15, "blue");
    const tank = place("scarab", -12, -15, "red"); // sans radar
    sim.aiPaused = true;
    run(0.5);
    expect(isDetected(sim, "red", ram)).toBe(true);
    // Un mur de fumée entre les deux camps
    for (const x of [-16, -8, 0, 8, 16]) releaseSmoke(sim, vec3(x, 2, 0), { radius: 6, duration: 60 });
    run(2);
    updateDetection(sim);
    expect(isDetected(sim, "blue", tank)).toBe(false); // l'équipe bleue n'a pas de radar
    expect(isDetected(sim, "red", ram)).toBe(true); // le radar de l'Échassier voit à travers
    expect(isDetected(sim, "red", buggy)).toBe(false); // brouillé au-delà de 25 m, et caché à la vue
    expect(SIGHT_RANGE).toBeGreaterThan(30);
    void stilt;
  });

  it("dans la vague, les robots équipés ont de quoi : batteries, radar, brouilleur, réparation", () => {
    spawnWave(sim, PRESET_BOTS);
    const types = new Set(sim.bots.flatMap((b) => [...b.blocks.values()].map((x) => x.type)));
    for (const t of ["battery", "radar", "jammer", "repairModule", "flamerTurret", "empTurret", "smokeLauncher"] as const) {
      expect(types.has(t), t).toBe(true);
    }
  });
});
