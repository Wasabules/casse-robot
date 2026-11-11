import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { lobbed, released, WEAPONS } from "../src/shared/catalog/weapons";
import { suits } from "../src/shared/ai/gunner";
import { ballisticPoint, fallTime } from "../src/shared/combat/ballistics";
import { lineOfFireBlocked, liveTurrets, turretFrame } from "../src/shared/combat/turrets";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { buriedTurrets, DesignGrid } from "../src/shared/design/robotDesign";
import { vec3 } from "../src/shared/math/vec";
import type { Bot } from "../src/shared/sim/entities";
import type { SimEvent } from "../src/shared/sim/events";
import { newInput, takeControl } from "../src/shared/sim/player";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnWave } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";

const profile = (id: string) => PRESET_BOTS.find((p) => p.id === id)!;

describe("bombes (calculs)", () => {
  it("le temps de chute rejoint la trajectoire intégrée", () => {
    const from = vec3(0, 12, 0);
    const vel = vec3(12, -1.5, 0);
    const t = fallTime(12, vel.y, 1)!;
    expect(ballisticPoint(from, vel, 1, t).y).toBeCloseTo(0, 6);
    expect(fallTime(-3, -1, 1)).toBeNull(); // il faudrait remonter
  });

  it("les bombes sont larguées, pas tirées en cloche, et ne visent que les robots au sol", () => {
    expect(released(WEAPONS.bombs)).toBe(true);
    expect(lobbed(WEAPONS.bombs)).toBe(false);
    const target = (id: string) => ({ profile: profile(id) }) as Bot;
    expect(suits(WEAPONS.bombs, target("tank"))).toBe(true);
    expect(suits(WEAPONS.bombs, target("drone"))).toBe(false);
    expect(suits(WEAPONS.bombs, target("plane"))).toBe(false);
  });

  it("une soute sous laquelle on pose un bloc est signalée enfouie", () => {
    const g = new DesignGrid().put(0, 0, 0, "cockpit").put(0, 0, 1, "bombBay");
    expect(buriedTurrets({ blocks: g.blocks(), wheels: [] })).toHaveLength(0);
    g.put(0, -1, 1, "frame");
    expect(buriedTurrets({ blocks: g.blocks(), wheels: [] }).map((b) => b.type)).toEqual(["bombBay"]);
  });
});

describe("bombardier", () => {
  let sim: Simulation;
  const events: SimEvent[] = [];

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(5);
    sim = new Simulation();
    events.length = 0;
    sim.on((e) => events.push(e));
  });
  afterEach(() => sim.dispose());

  it("ses soutes lâchent vers le bas, sans que son robot masque la chute", () => {
    spawnWave(sim, [profile("bomber")]);
    const bomber = sim.bots[0];
    const bays = liveTurrets(bomber).filter((t) => t.weapon === "bombs");
    expect(bays).toHaveLength(2);
    for (const t of bays) {
      const { dir } = turretFrame(t);
      const down = -dir.y / Math.hypot(dir.x, dir.y, dir.z);
      expect(down).toBeGreaterThan(0.9);
      expect(lineOfFireBlocked(t)).toBe(false);
    }
  });

  it("piloté, il largue un chapelet tant que la gâchette est tenue ; les bombes gardent sa vitesse et explosent au sol", () => {
    spawnWave(sim, [profile("bomber")]);
    const bomber = sim.bots[0];
    takeControl(bomber, sim.input);
    for (let i = 0; i < 60; i++) sim.step();
    const speed = Math.hypot(bomber.cockpit.part.rb.linvel().x, bomber.cockpit.part.rb.linvel().z);
    sim.input.weapon = "bombs";
    sim.input.trigger = true;
    for (let i = 0; i < 60; i++) sim.step();
    sim.input.trigger = false;
    const dropped = events.filter((e) => e.type === "shot" && e.weapon === "bombs");
    expect(dropped.length).toBeGreaterThanOrEqual(4); // quatre par seconde, deux soutes à tour de rôle
    const bomb = sim.projectiles.find((p) => p.weapon === "bombs")!;
    expect(Math.hypot(bomb.vel.x, bomb.vel.z)).toBeGreaterThan(speed * 0.7);
    for (let i = 0; i < 5 * 60; i++) sim.step();
    const blasts = events.filter((e) => e.type === "explosion" && e.look === "bomb");
    expect(blasts.length).toBe(dropped.length);
    for (const e of blasts) if (e.type === "explosion") expect(e.point.y).toBeLessThan(1.5);
    expect(bomber.cockpit.alive).toBe(true);
  });

  it("l'IA passe sur un ennemi au sol et le bombarde, en tenant son altitude", () => {
    spawnWave(sim, [profile("bomber"), profile("tank")]);
    const bomber = sim.bots.find((b) => b.profile.id === "bomber")!;
    const tank = sim.bots.find((b) => b.profile.id === "tank")!;
    expect(bomber.team).not.toBe(tank.team);
    takeControl(tank, newInput()); // la cible reste immobile
    // Seules les bombes : la tourelle ventrale se tait
    for (const t of bomber.turrets) if (t.weapon !== "bombs") t.arm.ammo = 0;
    let low = Infinity;
    let hitAt = -1;
    for (let i = 0; i < 60 * 60 && hitAt < 0; i++) {
      sim.step();
      low = Math.min(low, bomber.cockpit.part.rb.worldCom().y);
      if (events.some((e) => e.type === "hit" && e.victim === tank && e.cause === "bombs")) hitAt = sim.time;
    }
    expect(hitAt).toBeGreaterThan(0);
    expect(low).toBeGreaterThan(5);
  });
});
