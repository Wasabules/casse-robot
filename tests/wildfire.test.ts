import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { groundLevel } from "../src/shared/arena/layout";
import { propHp } from "../src/shared/catalog/props";
import { WEAPONS } from "../src/shared/catalog/weapons";
import { groundBelow, igniteProp, spawnGroundFire } from "../src/shared/combat/burning";
import { explode } from "../src/shared/combat/damage";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { norm, vec3 } from "../src/shared/math/vec";
import { blockWorldPos } from "../src/shared/robot/queries";
import type { Bot, Prop } from "../src/shared/sim/entities";
import type { SimEvent } from "../src/shared/sim/events";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnWave } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";

/*
 * Le feu dans le décor : le bois (caisses, planches, toits, arbres) prend feu, brûle, noircit,
 * gagne ses voisins et cède ; le lance-flammes et le napalm laissent des flaques de feu au sol.
 */

describe("le feu dans le décor", () => {
  let sim: Simulation;
  let events: SimEvent[];

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(8);
    sim = new Simulation();
    events = [];
    sim.on((e) => events.push(e));
  });
  afterEach(() => sim.dispose());

  const run = (seconds: number): void => {
    for (let i = 0; i < seconds * 60; i++) sim.step();
  };
  /** Les accessoires à moins de `r` m de (x, z), de ce type. */
  const near = (type: Prop["type"], x: number, z: number, r: number): Prop[] =>
    sim.props.filter((p) => p.type === type && Math.hypot(p.rb.translation().x - x, p.rb.translation().z - z) < r);
  const lit = (prop: Prop): boolean => events.some((e) => e.type === "propFire" && e.prop === prop && e.prop.burn > 0);

  it("le bois d'une cabane prend feu, noircit, gagne ses voisins et finit par céder ; la brique ne brûle pas", () => {
    sim.loadArena("valley");
    // La cabane de la Vallée : quatre pans de planches sous un toit
    const walls = near("plank", -48, -46, 5);
    expect(walls.length).toBeGreaterThanOrEqual(4);
    const wall = walls[0];
    const hp = wall.hp;
    igniteProp(sim, wall);
    expect(sim.propFires.has(wall)).toBe(true);
    expect(events.some((e) => e.type === "propFire" && e.prop === wall)).toBe(true);
    run(2);
    expect(wall.hp).toBeLessThan(hp);
    expect(wall.charred).toBeGreaterThan(0.15);
    run(25);
    // Le feu a gagné au moins un autre pan ou le toit, et le premier pan a cédé
    const cabin = [...walls, ...near("roof", -48, -46, 5)];
    expect(cabin.filter(lit).length).toBeGreaterThanOrEqual(2);
    expect(sim.props.includes(wall)).toBe(false);
    // La brique ne prend pas feu
    const brick = sim.props.find((p) => p.type === "brick")!;
    igniteProp(sim, brick);
    expect(brick.burn).toBe(0);
    expect(sim.propFires.has(brick)).toBe(false);
  });

  it("une explosion incendiaire met le feu à l'arbre qu'elle touche ; en brûlant, il bascule", () => {
    sim.loadArena("valley");
    const pine = sim.props.find((p) => p.type === "pine")!;
    const base = pine.rb.translation();
    const napalm = WEAPONS.fireMine.projectile.explosion!;
    explode(sim, vec3(base.x + 0.5, base.y - pine.half.y + 0.3, base.z), { ...napalm, ignite: 1 }, vec3(0, 1, 0), vec3(base.x, base.y + 10, base.z));
    expect(pine.burn).toBeGreaterThan(0);
    run(30);
    // À force de brûler, il cède : il bascule (et se brise ensuite)
    expect(events.some((e) => e.type === "propReleased" && e.prop === pine) || !sim.props.includes(pine)).toBe(true);
    expect(pine.charred).toBeGreaterThan(0.9);
  });

  it("l'eau éteint une flaque : rien ne brûle dans la rivière", () => {
    sim.loadArena("valley");
    const water = sim.arena.water!;
    // Un point du lit de la rivière
    let bed: { x: number; y: number; z: number } | null = null;
    for (let x = -60; x <= 60 && !bed; x += 2) {
      for (let z = -60; z <= 60 && !bed; z += 2) if (groundLevel(sim.arena, x, z) < water - 0.3) bed = vec3(x, groundLevel(sim.arena, x, z), z);
    }
    expect(bed).not.toBeNull();
    expect(spawnGroundFire(sim, bed!, { radius: 1, life: 4 }, null)).toBeNull();
    expect(sim.groundFires).toHaveLength(0);
  });

  it("un feu qui s'éteint laisse le bois noirci, sans le rallumer", () => {
    spawnWave(sim, []);
    const crate = sim.props.find((p) => p.type === "crate")!;
    igniteProp(sim, crate);
    const hp = propHp("crate", crate.half);
    run(2);
    expect(crate.hp).toBeLessThan(hp);
    // Une caisse brûle 9 s ; soit elle cède, soit elle s'éteint noircie
    run(12);
    if (sim.props.includes(crate)) {
      expect(crate.burn).toBe(0);
      expect(crate.charred).toBeGreaterThan(0.5);
      // Son extinction a été annoncée
      expect(events.filter((e) => e.type === "propFire" && e.prop === crate).length).toBeGreaterThanOrEqual(2);
    }
    expect(sim.propFires.has(crate)).toBe(false);
  });

  describe("flaques de feu", () => {
    let bots: Bot[];
    beforeEach(() => {
      spawnWave(sim, [PRESET_BOTS.find((p) => p.id === "scarab")!, PRESET_BOTS.find((p) => p.id === "truck")!]);
      sim.aiPaused = true;
      sim.combat = false;
      run(1);
      bots = sim.bots;
    });

    /** Points de structure de ses blocs et de ses roues. */
    const health = (bot: Bot): number => [...bot.blocks.values()].reduce((s, b) => s + b.hp, 0) + bot.wheels.reduce((s, w) => s + (w.part ? w.hp : 0), 0);
    const under = (bot: Bot) => {
      const at = bot.cockpit.part.rb.translation();
      return groundBelow(sim, vec3(at.x, at.y, at.z), 5)!;
    };

    it("une flaque brûle ce qui s'y tient, sauf le robot qui l'a allumée, puis s'éteint", () => {
      const [victim, owner] = bots;
      const before = health(victim);
      const ownerBefore = health(owner);
      spawnGroundFire(sim, under(victim), { radius: 3, life: 4 }, owner);
      spawnGroundFire(sim, under(owner), { radius: 3, life: 4 }, owner);
      expect(sim.groundFires).toHaveLength(2);
      expect(events.filter((e) => e.type === "groundFireAdded")).toHaveLength(2);
      run(3);
      expect(health(victim)).toBeLessThan(before - 30);
      expect(health(owner)).toBe(ownerBefore);
      // Le robot qui l'a allumée est crédité de ce qu'elle abîme
      expect(victim.lastAttacker).toBe(owner);
      run(2);
      expect(sim.groundFires).toHaveLength(0);
      expect(events.filter((e) => e.type === "groundFireRemoved")).toHaveLength(2);
    });

    it("une flaque ravivée au même endroit n'en fait pas une seconde", () => {
      const at = under(bots[0]);
      const first = spawnGroundFire(sim, at, { radius: 1, life: 2 }, null)!;
      const again = spawnGroundFire(sim, vec3(at.x + 0.3, at.y, at.z), { radius: 1, life: 4 }, null);
      expect(again).toBe(first);
      expect(sim.groundFires).toHaveLength(1);
      expect(first.until).toBeCloseTo(sim.time + 4, 5);
    });

    it("le lance-flammes laisse des flaques là où son jet touche le sol", () => {
      const at = blockWorldPos(bots[0].cockpit);
      for (let i = 0; i < 40; i++) {
        sim.fire("flamer", vec3(at.x + 6, 1.2, at.z + 6), norm(vec3(0.3, -0.25, 0.9)));
        run(0.07);
      }
      expect(sim.groundFires.length).toBeGreaterThan(0);
      for (const f of sim.groundFires) expect(f.radius).toBe(WEAPONS.flamer.projectile.puddle!.radius);
    });

    it("la mine incendiaire laisse une large flaque sous son explosion", () => {
      const at = under(bots[0]);
      explode(sim, vec3(at.x + 4, at.y + 0.3, at.z), WEAPONS.fireMine.projectile.explosion!, vec3(0, 1, 0), vec3(at.x, at.y + 10, at.z));
      expect(sim.groundFires).toHaveLength(1);
      expect(sim.groundFires[0].radius).toBe(2.4);
    });
  });
});
