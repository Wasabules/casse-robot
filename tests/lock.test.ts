import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WEAPONS } from "../src/shared/catalog/weapons";
import { isLocked, lockProgress } from "../src/shared/combat/lock";
import { PRESET_BOTS, type BotProfile } from "../src/shared/design/presets";
import { DesignGrid, validateDesign, type RobotDesign } from "../src/shared/design/robotDesign";
import { add, vec3 } from "../src/shared/math/vec";
import { groundHeight, spawnBot } from "../src/shared/robot/lifecycle";
import type { Bot, Projectile } from "../src/shared/sim/entities";
import type { SimEvent } from "../src/shared/sim/events";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { seedRandom } from "./seed";

/** Un plateau, le cockpit derrière, un lance-missiles à verrouillage devant. */
function launcherDesign(): RobotDesign {
  const g = new DesignGrid().box(-1, 1, 0, 0, -1, 1, "frame").put(0, 1, -1, "cockpit").put(0, 1, 1, "lockonLauncher");
  return { blocks: g.blocks(), wheels: [] };
}
const profileOf = (d: RobotDesign): BotProfile => ({ ...PRESET_BOTS[0], id: "essai", name: "Essai", design: d });

describe("missiles à verrouillage", () => {
  let sim: Simulation;
  let events: SimEvent[];

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(7);
    sim = new Simulation();
    events = [];
    sim.on((e) => events.push(e));
  });
  afterEach(() => sim.dispose());

  const run = (seconds: number): void => {
    for (let i = 0; i < seconds * 60; i++) sim.step();
  };
  const place = (profile: BotProfile, x: number, z: number, team: "blue" | "red"): Bot => {
    const bot = spawnBot(sim, profile, vec3(x, groundHeight(profile.design) + 0.03, z), 0, team);
    sim.bots.push(bot);
    return bot;
  };
  const launched = (): Projectile[] => events.flatMap((e) => (e.type === "projectileAdded" && e.projectile.weapon === "lockon" ? [e.projectile] : []));

  /** Le joueur (bleu) et un Scarabée rouge à 30 m à l'ouest, immobile, dans l'allée dégagée au sud du Dépôt. */
  const duel = (): { player: Bot; enemy: Bot } => {
    expect(validateDesign(launcherDesign())).toEqual([]);
    const player = place(profileOf(launcherDesign()), 0, -30, "blue");
    player.controller = "player";
    sim.player = player;
    sim.input.weapon = "lockon";
    // Le joueur ne verrouille qu'au viseur
    sim.input.scope = true;
    const enemy = place(PRESET_BOTS.find((p) => p.id === "scarab")!, -30, -30, "red");
    sim.aiPaused = true;
    run(0.5);
    return { player, enemy };
  };

  it("il faut garder la cible dans le viseur avant de pouvoir tirer ; les missiles la poursuivent", () => {
    const { player, enemy } = duel();
    const [t] = player.turrets;
    sim.input.aim = add(enemy.cockpit.part.rb.worldCom(), vec3(0.5, 0, 0));
    sim.input.trigger = true;
    run(WEAPONS.lockon.lock.time * 0.6);
    // Gâchette pressée, mais pas encore verrouillé : rien ne part
    expect(t.lockOn).toBe(enemy);
    expect(lockProgress(t)).toBeGreaterThan(0.3);
    expect(lockProgress(t)).toBeLessThan(1);
    expect(launched().length).toBe(0);
    run(1);
    expect(isLocked(t)).toBe(true);
    expect(launched().length).toBeGreaterThan(0);
    expect(launched().every((p) => p.homing === enemy)).toBe(true);
  });

  it("le verrou retombe quand la cible sort du viseur", () => {
    const { player, enemy } = duel();
    const [t] = player.turrets;
    sim.input.aim = enemy.cockpit.part.rb.worldCom();
    run(1.5);
    expect(isLocked(t)).toBe(true);
    // On vise ailleurs, loin de la cible
    sim.input.aim = vec3(0, 1, 0);
    run(1);
    expect(t.lockOn).toBeNull();
    expect(lockProgress(t)).toBe(0);
  });

  it("le joueur ne verrouille qu'au viseur : sans lui, rien ne se verrouille, et le verrou retombe", () => {
    const { player, enemy } = duel();
    const [t] = player.turrets;
    sim.input.scope = false;
    sim.input.aim = enemy.cockpit.part.rb.worldCom();
    sim.input.trigger = true;
    run(1.5);
    expect(t.lockOn).toBeNull();
    expect(launched().length).toBe(0);
    sim.input.scope = true;
    run(1.5);
    expect(isLocked(t)).toBe(true);
    sim.input.scope = false;
    run(0.1);
    expect(t.lockOn).toBeNull();
  });

  it("l'IA verrouille sa cible avant de tirer, puis ses missiles la poursuivent", () => {
    const shooter = place({ ...profileOf(launcherDesign()), behavior: "flee" }, 0, -30, "blue");
    const enemy = place(PRESET_BOTS.find((p) => p.id === "scarab")!, -32, -30, "red");
    enemy.controller = "player"; // immobile : il ne reçoit aucune commande
    const [t] = shooter.turrets;
    let lockedAt = Infinity;
    let firstShot = Infinity;
    for (let i = 0; i < 6 * 60; i++) {
      sim.step();
      if (isLocked(t) && lockedAt === Infinity) lockedAt = sim.time;
      if (launched().length && firstShot === Infinity) firstShot = sim.time;
    }
    expect(launched().length).toBeGreaterThan(0);
    expect(firstShot).toBeGreaterThanOrEqual(lockedAt);
    expect(launched()[0].homing).toBe(enemy);
  });
});
