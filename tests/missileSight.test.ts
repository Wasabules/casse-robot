import RAPIER from "@dimforge/rapier3d-compat";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WEAPONS } from "../src/shared/catalog/weapons";
import { isLocked, LOCK_GRACE, updateLock } from "../src/shared/combat/lock";
import { spawnProjectile } from "../src/shared/combat/projectiles";
import { sightBlocked } from "../src/shared/combat/sight";
import { releaseSmoke } from "../src/shared/combat/smoke";
import { turretFrame } from "../src/shared/combat/turrets";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { add, dot, len, norm, scale, sub, vec3, type Vec3 } from "../src/shared/math/vec";
import type { Bot, Turret } from "../src/shared/sim/entities";
import type { SimEvent } from "../src/shared/sim/events";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnWave } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";

/*
 * Missiles plus réalistes : on perd le verrou d'une cible que le décor ou la fumée cachent, une
 * tête chercheuse qui ne voit plus sa cible finit par la perdre, et un missile part d'abord droit
 * dans l'axe de l'arme avant que son guidage ne le tourne.
 */
describe("missiles : ligne de vue et départ dans l'axe", () => {
  let sim: Simulation;
  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(5);
    sim = new Simulation();
  });
  afterEach(() => sim.dispose());

  const run = (seconds: number): void => {
    for (let i = 0; i < seconds * 60; i++) sim.step();
  };
  /** Déplace un robot (tous ses morceaux) pour que son cockpit soit en `at`. */
  const place = (bot: Bot, at: Vec3): void => {
    const c = bot.cockpit.part.rb.translation();
    for (const part of bot.parts) {
      const t = part.rb.translation();
      part.rb.setTranslation({ x: t.x - c.x + at.x, y: t.y - c.y + at.y, z: t.z - c.z + at.z }, true);
      part.rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
    }
  };
  /** Un Traqueur et un Char face à face, à 25 m, au centre du Dépôt, l'IA figée. */
  const duel = (): { tracker: Bot; tank: Bot; launcher: Turret } => {
    spawnWave(sim, PRESET_BOTS.filter((p) => p.id === "tracker" || p.id === "tank"));
    sim.aiPaused = true;
    const tracker = sim.bots.find((b) => b.profile.id === "tracker")!;
    const tank = sim.bots.find((b) => b.profile.id === "tank")!;
    expect(tank.team).not.toBe(tracker.team);
    place(tracker, vec3(0, 2, -12));
    place(tank, vec3(0, 2, 13));
    run(1);
    return { tracker, tank, launcher: tracker.turrets.find((t) => t.weapon === "lockon")! };
  };
  /** Verrouille pendant `seconds` s, l'arme pointée sur le cockpit de la cible. */
  const hold = (t: Turret, target: Bot, seconds: number): void => {
    for (let i = 0; i < seconds * 60; i++) {
      const { muzzle } = turretFrame(t);
      updateLock(sim, t, muzzle, norm(sub(target.cockpit.part.rb.worldCom(), muzzle)), 1 / 60);
      sim.step();
    }
  };

  it("un verrou acquis est perdu quand la fumée cache la cible, pas sur un instant", () => {
    const { tank, launcher } = duel();
    expect(sightBlocked(sim, turretFrame(launcher).muzzle, tank)).toBe(false);
    hold(launcher, tank, WEAPONS.lockon.lock.time + 0.3);
    expect(isLocked(launcher)).toBe(true);
    // Un nuage entre les deux : le verrou tient le temps d'une hésitation, puis il est perdu
    const middle = scale(add(launcher.block.bot.cockpit.part.rb.worldCom(), tank.cockpit.part.rb.worldCom()), 0.5);
    releaseSmoke(sim, middle, { radius: 4, duration: 10 });
    run(1.3); // le nuage grandit
    hold(launcher, tank, LOCK_GRACE * 0.5);
    expect(launcher.lockOn).toBe(tank);
    hold(launcher, tank, LOCK_GRACE);
    expect(launcher.lockOn).toBeNull();
    expect(isLocked(launcher)).toBe(false);
  });

  it("une tête chercheuse qui ne voit plus sa cible file droit, perdue", () => {
    const { tank } = duel();
    const target = tank.cockpit.part.rb.worldCom();
    const origin = add(target, vec3(35, 6, 0));
    const missile = spawnProjectile(sim, "lockon", origin, norm(sub(target, origin)), { shooter: null, homing: tank });
    run(0.5);
    expect(missile.lost).toBe(false);
    // La fumée enveloppe la cible : le missile la cherche encore un moment, puis la perd
    releaseSmoke(sim, target, { radius: 5, duration: 10 });
    run(2);
    expect(missile.lost || missile.done).toBe(true);
  });

  it("un missile part droit dans l'axe de l'arme, puis son guidage le tourne vers le point visé", () => {
    const origin = vec3(0, 6, 0);
    const axis = vec3(1, 0, 0);
    // Le point visé est sur le côté : guidé d'emblée, il partirait vers lui
    sim.playerAim = vec3(0, 6, 40);
    const missile = spawnProjectile(sim, "missile", origin, axis, { shooter: null, spread: 0 });
    const launch = WEAPONS.missile.projectile.guidance.launch!;
    for (let i = 0; i < Math.floor(launch * 60) - 1; i++) sim.step();
    expect(dot(norm(missile.vel), axis)).toBeGreaterThan(0.999);
    run(1);
    expect(norm(missile.vel).z).toBeGreaterThan(0.5);
    expect(len(missile.vel)).toBeGreaterThan(1);
  });

  it("tiré vers le haut sur une cible verrouillée derrière un mur, il fait une cloche par-dessus et l'atteint ; tiré droit, il percute le mur", () => {
    /** Un Char derrière un mur de 4 m (un collider du décor fixe), un missile tiré de 15 m devant, dans la direction `dir`. */
    const shoot = (dir: Vec3): boolean => {
      sim.dispose();
      seedRandom(5);
      sim = new Simulation();
      const events: SimEvent[] = [];
      sim.on((e) => events.push(e));
      spawnWave(sim, PRESET_BOTS.filter((p) => p.id === "tank"));
      sim.aiPaused = true;
      const tank = sim.bots[0];
      place(tank, vec3(0, 1.5, 5));
      sim.world.createCollider(RAPIER.ColliderDesc.cuboid(3, 2, 0.3).setTranslation(0, 2, 0));
      run(0.5);
      spawnProjectile(sim, "lockon", vec3(0, 2, -15), norm(dir), { shooter: null, homing: tank, spread: 0 });
      run(5);
      return events.some((e) => e.type === "hit" && e.victim === tank);
    };
    expect(shoot(vec3(0, 0.1, 1))).toBe(false);
    expect(shoot(vec3(0, 1.3, 1))).toBe(true);
  });

  it("une cible qui file droit est touchée ; un écart franc au bon moment le fait rater", () => {
    /** Un Buggy qui file de côté à `speed` m/s, et part dans l'autre sens quand le missile est à `jink` m (0 : jamais), visé de 40 m. */
    const dodge = (speed: number, jink: number): boolean => {
      sim.dispose();
      seedRandom(5);
      sim = new Simulation();
      const events: SimEvent[] = [];
      sim.on((e) => events.push(e));
      spawnWave(sim, PRESET_BOTS.filter((p) => p.id === "buggy"));
      sim.aiPaused = true;
      const bot = sim.bots[0];
      place(bot, vec3(0, 1.2, 0));
      run(0.5);
      const from = vec3(0, 3, -40);
      const missile = spawnProjectile(sim, "lockon", from, norm(sub(bot.cockpit.part.rb.worldCom(), from)), { shooter: null, homing: bot, spread: 0 });
      let dir = 1;
      for (let i = 0; i < 300 && !missile.done; i++) {
        if (jink && dir === 1 && len(sub(missile.pos, bot.cockpit.part.rb.worldCom())) < jink) dir = -1;
        for (const part of bot.parts) part.rb.setLinvel({ x: speed * dir, y: part.rb.linvel().y, z: 0 }, true);
        sim.step();
      }
      return events.some((e) => e.type === "hit" && e.victim === bot);
    };
    expect(dodge(10, 0)).toBe(true);
    expect(dodge(10, 12)).toBe(false);
  });
});
