import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ARENAS } from "../src/shared/arena/layout";
import { resetProps } from "../src/shared/arena/props";
import { propHalf, type PropType } from "../src/shared/catalog/props";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { vec3, type Vec3 } from "../src/shared/math/vec";
import { takeControl } from "../src/shared/sim/player";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnWave } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";

/*
 * Percée (combat/collisions.ts) : un robot lourd et rapide qui brise un accessoire ancré (un arbre,
 * un pan de mur) passe au travers en ralentissant ; un robot léger ou lent, ou un obstacle trop
 * solide, l'arrête net, comme avant.
 */

let sim: Simulation | null = null;
beforeAll(async () => {
  await initPhysics();
});
afterEach(() => {
  sim?.dispose();
  sim = null;
});

interface Run {
  /** Le robot est passé de l'autre côté. */
  passed: boolean;
  /** L'accessoire est encore debout, ancré. */
  standing: boolean;
  /** Vitesse du robot juste avant le choc, et la plus basse ensuite (m/s, le long de sa course). */
  before: number;
  after: number;
  /** Dégâts de choc encaissés par le robot. */
  hurt: number;
}

/** Un robot `id`, plein gaz, lancé à `speed` m/s droit sur un accessoire `type` posé seul sur le sol plat du Dépôt. */
function charge(id: string, type: PropType, speed: number, half?: Vec3): Run {
  sim?.dispose();
  seedRandom(4);
  const world = new Simulation();
  sim = world;
  const h = propHalf(type, { half });
  const at = vec3(0, h.y, 0);
  world.arena = { ...ARENAS.depot, props: [{ type, pos: at, half }] };
  spawnWave(world, PRESET_BOTS.filter((p) => p.id === id));
  // (après la vague, qui remet les accessoires en place)
  resetProps(world);
  const prop = world.props[0];
  const bot = world.bots[0];
  takeControl(bot, world.input);
  world.input.throttle = 1;
  const rb = bot.cockpit.part.rb;
  const start = -(h.z + bot.radius + 1.5);
  const t = rb.translation();
  rb.setTranslation({ x: 0, y: t.y, z: start }, true);
  rb.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
  rb.setLinvel({ x: 0, y: 0, z: speed }, true);
  rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
  const hp0 = [...bot.blocks.values()].reduce((s, b) => s + b.hp, 0);
  let before = speed;
  let after = Infinity;
  let touched = false;
  for (let i = 0; i < 150 && bot.cockpit.alive; i++) {
    world.step();
    const body = bot.cockpit.part.rb;
    const v = body.linvel().z;
    const z = body.translation().z;
    if (!touched && z + bot.radius > -h.z - 0.3) touched = true;
    if (!touched) before = v;
    else after = Math.min(after, v);
  }
  const z = bot.cockpit.alive ? bot.cockpit.part.rb.translation().z : -Infinity;
  const hp1 = [...bot.blocks.values()].reduce((s, b) => s + b.hp, 0);
  return { passed: z > h.z + 1, standing: world.props.includes(prop) && prop.fixed, before, after, hurt: hp0 - hp1 };
}

const show = (label: string, r: Run): string =>
  `${label} : ${r.passed ? "passe" : "arrêté"}, obstacle ${r.standing ? "debout" : "à terre"}, ${r.before.toFixed(1)} → ${r.after.toFixed(1)} m/s, ${r.hurt.toFixed(0)} points perdus`;

describe("percée : un robot lourd et rapide passe au travers de ce qu'il brise", () => {
  it("le Bélier lancé abat un sapin et passe en ralentissant ; le Buggy s'y arrête", () => {
    const ram = charge("ram", "pine", 7);
    console.log(show("Bélier contre un sapin", ram));
    expect(ram.standing).toBe(false);
    expect(ram.passed).toBe(true);
    expect(ram.after).toBeGreaterThan(1);
    expect(ram.after).toBeLessThan(ram.before - 0.5);
    const buggy = charge("buggy", "pine", 5);
    console.log(show("Buggy contre un sapin", buggy));
    expect(buggy.standing).toBe(true);
    expect(buggy.passed).toBe(false);
  });

  it("une palissade de planches cède devant le Bélier, qui garde de la vitesse ; un pan de béton l'arrête", () => {
    const planks = charge("ram", "plank", 7, vec3(1.2, 0.9, 0.08));
    console.log(show("Bélier contre des planches", planks));
    expect(planks.standing).toBe(false);
    expect(planks.passed).toBe(true);
    expect(planks.after).toBeGreaterThan(2.5);
    const concrete = charge("ram", "concrete", 7, vec3(2, 1.5, 0.15));
    console.log(show("Bélier contre du béton", concrete));
    expect(concrete.standing).toBe(true);
    expect(concrete.passed).toBe(false);
  });

  it("le Camion lancé traverse un mur de briques ; le même mur arrête le Bélier", () => {
    const truck = charge("truck", "brick", 11, vec3(2, 1.5, 0.12));
    console.log(show("Camion contre des briques", truck));
    expect(truck.standing).toBe(false);
    expect(truck.passed).toBe(true);
    const ram = charge("ram", "brick", 7, vec3(2, 1.5, 0.12));
    console.log(show("Bélier contre des briques", ram));
    expect(ram.passed).toBe(false);
  });
});
