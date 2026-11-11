import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WEAPONS } from "../src/shared/catalog/weapons";
import { applyDamage } from "../src/shared/combat/damage";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { drivenWheelCount, integrity, liveThrusters } from "../src/shared/robot/queries";
import type { Bot } from "../src/shared/sim/entities";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { LETHAL, lethalBlast } from "./helpers";
import { spawnWave } from "../src/shared/sim/wave";

const SHOOTER = { x: 0, y: 10, z: -30 };
const DOWN = { x: 0, y: -1, z: 0 };
/** Armes de test qui détruisent à coup sûr : ces tests portent sur la séparation, pas sur la dureté. */
const LETHAL_BLAST = lethalBlast(0.9);

/** Tient le compte des entités à partir des seuls événements, comme le fait le rendu. */
function trackEvents(sim: Simulation) {
  const parts = new Set<number>();
  const blocks = new Set<number>();
  const wheels = new Set<number>();
  const debris = new Set<number>();
  const props = new Set<number>();
  sim.on((e) => {
    switch (e.type) {
      case "partAdded": parts.add(e.part.id); break;
      case "partRemoved":
        parts.delete(e.part.id);
        for (const b of e.part.blocks) blocks.delete(b.id);
        break;
      case "blockAttached": blocks.add(e.block.id); break;
      case "blockRebuilt": blocks.add(e.block.id); break;
      case "blockDestroyed": blocks.delete(e.block.id); break;
      case "wheelAdded": wheels.add(e.wheel.id); break;
      case "wheelRemoved": wheels.delete(e.wheel.id); break;
      case "debrisAdded": debris.add(e.debris.id); break;
      case "debrisRemoved": debris.delete(e.debris.id); break;
      case "propAdded": props.add(e.prop.id); break;
      case "propRemoved": props.delete(e.prop.id); break;
      default: break;
    }
  });
  return { parts, blocks, wheels, debris, props };
}

/** Vérifie que les événements reçus décrivent exactement l'état de la simulation. */
function expectEventsInSync(sim: Simulation, seen: ReturnType<typeof trackEvents>): void {
  const parts = sim.bots.flatMap((b) => [...b.parts]);
  expect(seen.parts).toEqual(new Set(parts.map((p) => p.id)));
  expect(seen.blocks).toEqual(new Set(parts.flatMap((p) => [...p.blocks].map((b) => b.id))));
  // (une épave de roue retirée n'est plus là)
  expect(seen.wheels).toEqual(new Set(sim.bots.flatMap((b) => b.wheels.filter((w) => w.part || w.body).map((w) => w.id))));
  expect(seen.debris).toEqual(new Set(sim.debris.map((d) => d.id)));
  expect(seen.props).toEqual(new Set(sim.props.map((c) => c.id)));
}

const botById = (sim: Simulation, id: string): Bot => sim.bots.find((b) => b.profile.id === id)!;

/** Détruit un bloc précis, comme un tir direct qui le toucherait. */
function shootBlock(sim: Simulation, bot: Bot, key: string): void {
  const block = bot.blocks.get(key);
  if (!block) throw new Error(`pas de bloc en ${key}`);
  applyDamage(sim, bot.lastPos, DOWN, LETHAL, { kind: "block", block }, SHOOTER);
}

describe("simulation", () => {
  let sim: Simulation;
  let seen: ReturnType<typeof trackEvents>;

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    sim = new Simulation();
    seen = trackEvents(sim);
    spawnWave(sim, PRESET_BOTS);
  });
  afterEach(() => sim.dispose());

  it("fait apparaître chaque robot d'un seul morceau", () => {
    expect(sim.bots).toHaveLength(PRESET_BOTS.length);
    for (const bot of sim.bots) {
      expect(bot.parts.size).toBe(1);
      expect(bot.blocks.size).toBe(bot.profile.design.blocks.length);
      expect(integrity(bot)).toBe(1);
      expect(drivenWheelCount(bot)).toBe(bot.profile.design.wheels.length);
    }
    expectEventsInSync(sim, seen);
  });

  it("simule 10 s de combat sans valeur invalide, et le rendu suit tous les changements", () => {
    for (let i = 0; i < 600; i++) sim.step();
    for (const bot of sim.bots) {
      const p = bot.lastPos;
      expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
    }
    expectEventsInSync(sim, seen);
  });

  it("sépare la flèche de la Grue quand on coupe son mât", () => {
    const crane = botById(sim, "crane");
    const total = crane.blocks.size;
    shootBlock(sim, crane, "0,3,0");

    expect(crane.parts.size).toBe(2);
    expect(crane.blocks.size).toBe(total - 1);
    expect(sim.destroyedCount).toBe(1);
    expect(sim.debris).toHaveLength(1);
    const cockpitPart = crane.cockpit.part;
    expect(cockpitPart.blocks.has(crane.blocks.get("0,2,0")!)).toBe(true);
    expect(cockpitPart.blocks.has(crane.blocks.get("0,4,0")!)).toBe(false);
    expect(integrity(crane)).toBeLessThan(0.5);
    expectEventsInSync(sim, seen);
  });

  it("les roues suivent le morceau de leur bloc support", () => {
    const centi = botById(sim, "centi");
    shootBlock(sim, centi, "0,0,3"); // cou entre la tête et le reste du corps
    expect(centi.parts.size).toBe(2);
    expect(drivenWheelCount(centi)).toBe(4);
    const body = centi.blocks.get("0,0,0")!.part;
    expect(body).not.toBe(centi.cockpit.part);
    expect(centi.wheels.filter((w) => w.part === body)).toHaveLength(4);
    expectEventsInSync(sim, seen);
  });

  it("une roue tombe quand son bloc support est détruit", () => {
    const scarab = botById(sim, "scarab");
    const wheel = scarab.wheels.find((w) => w.mountKey === "-3,0,-3")!;
    shootBlock(sim, scarab, "-3,0,-3");
    expect(wheel.part).toBeNull();
    expect(drivenWheelCount(scarab)).toBe(5);
  });

  it("le robot sans cockpit est détruit, et un morceau vidé disparaît", () => {
    const drone = botById(sim, "drone");
    const at = drone.cockpit.part.rb.translation();
    applyDamage(sim, at, DOWN, LETHAL_BLAST, undefined, SHOOTER);
    expect(drone.cockpit.alive).toBe(false);
    expect(integrity(drone)).toBe(0);
    expect(liveThrusters(drone)).toHaveLength(0);
    sim.step();
    expect(drone.ai.mode).toBe("dead");

    // Le bras droit est devenu un morceau à part : le vider bloc par bloc le fait disparaître
    const arm = drone.blocks.get("2,0,0")!.part;
    expect(arm.blocks.size).toBe(3);
    const parts = drone.parts.size;
    for (const key of ["2,0,0", "3,0,0", "4,0,0"]) shootBlock(sim, drone, key);
    expect(drone.parts.has(arm)).toBe(false);
    expect(drone.parts.size).toBe(parts - 1);
    expectEventsInSync(sim, seen);
  });

  it("une nouvelle vague remet tout à zéro", () => {
    applyDamage(sim, botById(sim, "ram").lastPos, DOWN, WEAPONS.cannon, undefined, SHOOTER);
    for (let i = 0; i < 30; i++) sim.step();
    spawnWave(sim, PRESET_BOTS);
    expect(sim.destroyedCount).toBe(0);
    expect(sim.debris).toHaveLength(0);
    expectEventsInSync(sim, seen);
  });

  it("les débris disparaissent en fin de vie", () => {
    sim.aiPaused = true; // pas de combat : seul ce débris compte
    shootBlock(sim, botById(sim, "ram"), "0,2,-3");
    expect(sim.debris).toHaveLength(1);
    const shot = sim.debris[0];
    for (let i = 0; i < 6.1 * 60; i++) sim.step();
    // (dans le cercle de départ serré, un voisin peut perdre un bloc entre-temps : on suit le sien)
    expect(sim.debris).not.toContain(shot);
    expectEventsInSync(sim, seen);
  });
});
