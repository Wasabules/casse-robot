import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BLOCK_TYPES } from "../src/shared/catalog/blocks";
import { PROP_TYPES } from "../src/shared/catalog/props";
import { WEAPONS } from "../src/shared/catalog/weapons";
import { applyDamage } from "../src/shared/combat/damage";
import { fireTurret, liveTurrets, turretFrame } from "../src/shared/combat/turrets";
import { GRAVITY, STEP } from "../src/shared/config";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { add, distance, dot, norm, sub, vec3 } from "../src/shared/math/vec";
import { blockWorldPos, integrity } from "../src/shared/robot/queries";
import type { Bot, Prop } from "../src/shared/sim/entities";
import type { SimEvent } from "../src/shared/sim/events";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnWave } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";

describe("moteur de combat", () => {
  let sim: Simulation;
  let events: SimEvent[];

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(5);
    sim = new Simulation();
    events = [];
    sim.on((e) => events.push(e));
  });
  afterEach(() => {
    sim.dispose();
    vi.restoreAllMocks();
  });

  const only = (...ids: string[]): void => spawnWave(sim, PRESET_BOTS.filter((p) => ids.includes(p.id)));
  const byId = (id: string): Bot => sim.bots.find((b) => b.profile.id === id)!;
  const run = (seconds: number): void => {
    for (let i = 0; i < seconds * 60; i++) sim.step();
  };
  const count = (type: SimEvent["type"]): number => events.filter((e) => e.type === type).length;
  const propsOf = (type: Prop["type"]): Prop[] => sim.props.filter((p) => p.type === type);

  it("une balle suit une trajectoire balistique", () => {
    only();
    const origin = vec3(0, 20, -60);
    const bullet = sim.fire("rifle", origin, vec3(0, 0, 1));
    run(0.3);
    const t = 0.3;
    expect(bullet.pos.z - origin.z).toBeCloseTo(WEAPONS.rifle.projectile.speed * t, 0);
    // Tombée de ½·g·t², à la dispersion près
    expect(origin.y - bullet.pos.y).toBeGreaterThan(0.5 * GRAVITY * t * t - 1);
    expect(origin.y - bullet.pos.y).toBeLessThan(0.5 * GRAVITY * t * t + 1);
  });

  it("une balle de sniper perce plusieurs blocs d'un coup", () => {
    only("scarab");
    sim.aiPaused = true;
    const scarab = byId("scarab");
    const target = blockWorldPos(scarab.blocks.get("0,1,-3")!); // rangée de blindage, visée par le travers
    const origin = add(target, vec3(-15, 0, 0));
    sim.fire("sniper", origin, norm(sub(target, origin)));
    run(0.2);
    expect(sim.destroyedCount).toBeGreaterThanOrEqual(2);
  });

  it("un baril qui saute fait sauter son voisin (réaction en chaîne)", () => {
    only();
    const [first, second] = propsOf("barrel");
    expect(distance(first.rb.translation(), second.rb.translation())).toBeLessThan(PROP_TYPES.barrel.explosion.radius);
    applyDamage(sim, first.rb.translation(), vec3(0, -1, 0), WEAPONS.rifle, { kind: "prop", prop: first }, vec3(0, 10, 0));
    run(1);
    expect(sim.props.includes(first)).toBe(false);
    expect(sim.props.includes(second)).toBe(false);
    expect(count("explosion")).toBeGreaterThanOrEqual(2);
  });

  it("une bouteille de gaz percée s'envole, puis explose", () => {
    only();
    const gas = propsOf("gas")[0];
    const start = gas.rb.translation();
    applyDamage(sim, start, vec3(1, 0, 0), WEAPONS.rifle, { kind: "prop", prop: gas }, vec3(0, 10, 0));
    expect(gas.state.kind).toBe("venting");
    run(0.8);
    expect(distance(gas.rb.translation(), start)).toBeGreaterThan(1);
    run(1.2);
    expect(sim.props.includes(gas)).toBe(false);
    expect(count("explosion")).toBeGreaterThanOrEqual(1);
  });

  it("une caisse se brise en éclats", () => {
    only();
    const crate = propsOf("crate")[0];
    applyDamage(sim, crate.rb.translation(), vec3(0, -1, 0), WEAPONS.cannon, { kind: "prop", prop: crate }, vec3(0, 10, 0));
    run(0.1);
    expect(sim.props.includes(crate)).toBe(false);
    expect(sim.debris.some((d) => d.look.kind === "prop" && d.look.type === "crate")).toBe(true);
  });

  it("le tir d'un sniper fait reculer le robot", () => {
    only("stilt");
    sim.aiPaused = true;
    run(1);
    const stilt = byId("stilt");
    const turret = liveTurrets(stilt)[0];
    const rb = stilt.cockpit.part.rb;
    const before = rb.linvel();
    const { dir } = turretFrame(turret);
    fireTurret(sim, turret);
    const kick = sub(rb.linvel(), before);
    expect(dot(kick, dir)).toBeLessThan(-0.1);
    expect(count("projectileAdded")).toBe(1);
  });

  it("un missile téléguidé suit le point que vise le joueur", () => {
    only();
    const missile = sim.fire("missile", vec3(0, 15, -30), vec3(0, 0, 1));
    sim.playerAim = vec3(25, 15, -10); // on vise sur la droite
    run(1.5);
    expect(missile.pos.x).toBeGreaterThan(5);
  });

  it("un missile anti-aérien abat le drone ennemi", () => {
    only("drone", "hexa");
    const drone = byId("drone");
    expect(byId("hexa").team).not.toBe(drone.team);
    run(12);
    expect(events.some((e) => e.type === "shot" && e.weapon === "flak")).toBe(true);
    const hurt = (e: SimEvent): boolean => (e.type === "blockDamaged" || e.type === "blockDestroyed") && e.block.bot === drone;
    expect(events.some(hurt)).toBe(true);
  });

  it("une mine posée près d'un robot s'arme puis explose", () => {
    only("ram");
    sim.aiPaused = true;
    run(0.5);
    const ram = byId("ram");
    const side = add(ram.cockpit.part.rb.worldCom(), vec3(0, 1.5, 0));
    const mine = sim.fire("mine", add(side, vec3(2.4, 0, 0)), vec3(0, -1, 0));
    run(0.5);
    expect(mine.landed).toBe(true);
    expect(sim.projectiles.includes(mine)).toBe(true);
    run(WEAPONS.mine.projectile.mine.armDelay + 0.5);
    expect(sim.projectiles.includes(mine)).toBe(false);
    expect(count("explosion")).toBe(1);
  });

  it("les robots de deux équipes se combattent avec leurs tourelles", () => {
    only("scarab", "trike");
    const [a, b] = sim.bots;
    expect(a.team).not.toBe(b.team);
    run(15);
    expect(count("shot")).toBeGreaterThanOrEqual(2);
    const hurt = (bot: Bot): boolean =>
      integrity(bot) < 1 || [...bot.blocks.values()].some((x) => x.hp < BLOCK_TYPES[x.type].hp);
    expect(hurt(a) || hurt(b)).toBe(true);
  });

  it("un projectile n'atteint pas le robot qui l'a tiré", () => {
    only("scarab");
    sim.aiPaused = true;
    run(0.5);
    const scarab = byId("scarab");
    const turret = liveTurrets(scarab)[0];
    // Canon pointé à travers son propre dôme : le projectile doit passer sans le toucher
    turret.pitch = -0.1;
    fireTurret(sim, turret);
    run(STEP * 10);
    expect(scarab.blocks.size).toBe(scarab.total);
  });
});
