import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BLOCK_TYPES } from "../src/shared/catalog/blocks";
import { explosionDamageAt, WEAPONS } from "../src/shared/catalog/weapons";
import { applyDamage, DamageBatch, inflict, WRECK_INTEGRITY } from "../src/shared/combat/damage";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { add } from "../src/shared/math/vec";
import { blockWorldPos, drivenWheelCount, integrity } from "../src/shared/robot/queries";
import type { Block, Bot } from "../src/shared/sim/entities";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnWave } from "../src/shared/sim/wave";

const SHOOTER = { x: 0, y: 10, z: -30 };
const DOWN = { x: 0, y: -1, z: 0 };

describe("catalogue de dureté", () => {
  it("chaque type de bloc a une masse et des points de structure positifs", () => {
    for (const def of Object.values(BLOCK_TYPES)) {
      expect(def.mass).toBeGreaterThan(0);
      expect(def.hp).toBeGreaterThan(0);
    }
  });

  it("plus un blindage est dur, plus il est lourd", () => {
    const tiers = [BLOCK_TYPES.armorLight, BLOCK_TYPES.armor, BLOCK_TYPES.armorHeavy];
    for (let i = 1; i < tiers.length; i++) {
      expect(tiers[i].hp).toBeGreaterThan(tiers[i - 1].hp);
      expect(tiers[i].mass).toBeGreaterThan(tiers[i - 1].mass);
    }
  });

  it("les dégâts de zone décroissent jusqu'au bord de la zone", () => {
    const shell = WEAPONS.cannon.projectile.explosion;
    expect(explosionDamageAt(shell, 0)).toBe(shell.damage);
    expect(explosionDamageAt(shell, shell.radius / 2)).toBeCloseTo(shell.damage / 2);
    expect(explosionDamageAt(shell, shell.radius)).toBe(0);
  });
});

describe("dégâts", () => {
  let sim: Simulation;
  const damaged: Block[] = [];

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    sim = new Simulation();
    damaged.length = 0;
    sim.on((e) => {
      if (e.type === "blockDamaged") damaged.push(e.block);
    });
    spawnWave(sim, PRESET_BOTS);
  });
  afterEach(() => sim.dispose());

  const botById = (id: string): Bot => sim.bots.find((b) => b.profile.id === id)!;
  const rifleShot = (block: Block): void =>
    applyDamage(sim, blockWorldPos(block), DOWN, WEAPONS.rifle, { kind: "block", block }, SHOOTER);

  it("un blindage encaisse plusieurs tirs de fusil avant de céder", () => {
    const block = botById("ram").blocks.get("0,2,-3")!;
    expect(block.type).toBe("armor");
    const shots = Math.ceil(BLOCK_TYPES.armor.hp / WEAPONS.rifle.projectile.damage);
    expect(shots).toBeGreaterThan(1);

    for (let i = 1; i < shots; i++) {
      rifleShot(block);
      expect(block.alive).toBe(true);
    }
    expect(block.hp).toBe(BLOCK_TYPES.armor.hp - (shots - 1) * WEAPONS.rifle.projectile.damage);
    expect(damaged).toHaveLength(shots - 1);
    rifleShot(block);
    expect(block.alive).toBe(false);
    expect(sim.destroyedCount).toBe(1);
  });

  it("le blindage léger cède au deuxième tir de fusil", () => {
    const block = botById("trike").blocks.get("-1,1,-3")!;
    expect(block.type).toBe("armorLight");
    rifleShot(block);
    expect(block.alive).toBe(true);
    rifleShot(block);
    expect(block.alive).toBe(false);
  });

  it("le dôme lourd du Scarabée résiste à un tir direct de canon", () => {
    const top = botById("scarab").blocks.get("0,3,0")!;
    expect(top.type).toBe("armorHeavy");
    // L'obus frappe le dessus du bloc (choc direct) et éclate à sa surface, à 0,25 m de son centre
    const hitPoint = add(blockWorldPos(top), { x: 0, y: 0.25, z: 0 });
    applyDamage(sim, hitPoint, DOWN, WEAPONS.cannon, { kind: "block", block: top }, SHOOTER);
    const shell = WEAPONS.cannon.projectile;
    const resist = BLOCK_TYPES.armorHeavy.resist;
    expect(top.alive).toBe(true);
    // Le blindage lourd amortit l'obus (dégâts cinétiques) ; l'explosion porte ses dégâts entiers
    const expected = BLOCK_TYPES.armorHeavy.hp - shell.damage * resist.kinetic - explosionDamageAt(shell.explosion, 0.25);
    expect(top.hp).toBeCloseTo(expected, 3);
    expect(damaged).toContain(top);
  });

  it("le canon détruit le bloc touché et abîme ses voisins, de moins en moins loin de l'impact", () => {
    const ram = botById("ram");
    const center = ram.blocks.get("0,2,-2")!; // blindage au milieu du toit
    const point = blockWorldPos(center);
    applyDamage(sim, point, DOWN, WEAPONS.cannon, { kind: "block", block: center }, SHOOTER);
    expect(center.alive).toBe(false);

    const explosion = WEAPONS.cannon.projectile.explosion;
    const lost = (d: number): number => explosionDamageAt(explosion, d) * BLOCK_TYPES.armor.resist.explosive;
    const near = ram.blocks.get("1,2,-2")!; // à 0,5 m
    const far = ram.blocks.get("2,2,-2")!; // à 1 m
    expect(near.hp).toBeCloseTo(BLOCK_TYPES.armor.hp - lost(0.5), 1);
    expect(far.hp).toBeCloseTo(BLOCK_TYPES.armor.hp - lost(1), 1);
    expect(near.hp).toBeLessThan(far.hp);
  });

  it("trois tirs de fusil arrachent une roue", () => {
    const trike = botById("trike");
    const wheel = trike.wheels.find((w) => w.side !== 0)!;
    for (let i = 0; i < 3; i++) {
      expect(wheel.part).not.toBeNull();
      applyDamage(sim, wheel.rb.translation(), DOWN, WEAPONS.rifle, { kind: "wheel", wheel }, SHOOTER);
    }
    expect(wheel.part).toBeNull();
    expect(drivenWheelCount(trike)).toBe(2);
  });

  it("un robot dont il ne reste presque que le cockpit est hors de combat", () => {
    const ram = botById("ram");
    const kills: string[] = [];
    sim.on((e) => {
      if (e.type === "botKilled") kills.push(e.bot.profile.id);
    });
    // Les blocs du plus loin au plus près du cockpit : le robot tient tant qu'il garde le quart de sa structure
    const gap = (b: Block): number => Math.hypot(b.x - ram.cockpit.x, b.y - ram.cockpit.y, b.z - ram.cockpit.z);
    const others = [...ram.blocks.values()].filter((b) => b !== ram.cockpit).sort((a, b) => gap(b) - gap(a));
    const keep = Math.ceil(ram.total * WRECK_INTEGRITY);
    const doomed = others.slice(0, others.length - keep);
    const batch = new DamageBatch();
    for (const block of doomed) batch.add({ kind: "block", block }, 1e9, "kinetic");
    inflict(sim, batch, DOWN, null);
    expect(ram.cockpit.alive).toBe(true);
    expect(kills).toEqual([]);

    const last = new DamageBatch();
    for (const block of others.slice(others.length - keep)) last.add({ kind: "block", block }, 1e9, "kinetic");
    inflict(sim, last, DOWN, null);
    expect(integrity(ram)).toBe(0);
    expect(ram.cockpit.alive).toBe(false);
    expect(kills).toEqual(["ram"]);
  });

  it("un robot touché sans perdre de bloc réagit quand même", () => {
    const scarab = botById("scarab");
    rifleShot(scarab.blocks.get("0,3,0")!);
    expect(scarab.blocks.size).toBe(scarab.total);
    expect(scarab.ai.mode).toBe("flee");
  });
});
