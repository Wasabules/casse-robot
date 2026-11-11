import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PRESET_BOTS, type BotProfile } from "../src/shared/design/presets";
import { applyDamage } from "../src/shared/combat/damage";
import { GAME_MODES, matchEntries } from "../src/shared/modes";
import { add, axisAngle, qmul, qrot, scale, sub, vec3, type Vec3 } from "../src/shared/math/vec";
import { releaseWheel } from "../src/shared/robot/lifecycle";
import { FLIPPED_UP_Y, RIGHTING_DELAY } from "../src/shared/robot/righting";
import { liveTurrets, muzzleVelocity, turretFrame, turretSpec } from "../src/shared/combat/turrets";
import { predictImpact, type Impact } from "../src/shared/combat/ballistics";
import { firingDirection } from "../src/shared/ai/gunner";
import { spawnProjectile } from "../src/shared/combat/projectiles";
import { WEAPONS } from "../src/shared/catalog/weapons";
import { aimSpread, hipSpread } from "../src/shared/combat/accuracy";
import type { Bot } from "../src/shared/sim/entities";
import type { SimEvent } from "../src/shared/sim/events";
import { startMatch } from "../src/shared/sim/match";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnTeams } from "../src/shared/sim/wave";
import { LETHAL } from "./helpers";
import { seedRandom } from "./seed";

const preset = (id: string): BotProfile => PRESET_BOTS.find((p) => p.id === id)!;
const DOWN = vec3(0, -1, 0);

describe("robot piloté et parties", () => {
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

  const run = (seconds: number, each?: () => void): void => {
    for (let i = 0; i < seconds * 60; i++) {
      each?.();
      sim.step();
    }
  };
  const kill = (bot: Bot): void => applyDamage(sim, bot.lastPos, DOWN, LETHAL, { kind: "block", block: bot.cockpit }, vec3(0, 20, 0));

  /** Le joueur pilote `id` dans l'équipe bleue, face à un Scarabée rouge ; l'IA est figée. */
  function duel(id: string): { player: Bot; enemy: Bot } {
    const [player, enemy] = spawnTeams(sim, [{ profile: preset(id), team: "blue" }, { profile: preset("scarab"), team: "red" }]);
    player.controller = "player";
    sim.player = player;
    sim.combat = false;
    return { player, enemy };
  }

  it("le joueur conduit son robot et ses tourelles tirent vers le point visé", () => {
    const { player, enemy } = duel("tank");
    run(1);
    const start = player.lastPos;
    sim.input.throttle = 1;
    run(3);
    sim.input.throttle = 0;
    expect(Math.hypot(player.lastPos.x - start.x, player.lastPos.z - start.z)).toBeGreaterThan(6);
    sim.input.aim = add(enemy.lastPos, vec3(0, 1, 0));
    sim.input.trigger = true;
    run(4);
    expect(events.filter((e) => e.type === "shot").length).toBeGreaterThan(0);
    expect(liveTurrets(player)[0].aim).toEqual(sim.input.aim);
  });

  it("au viseur, les tirs du joueur se dispersent moins ; en bougeant, bien plus", () => {
    const dir = vec3(0, 0, 1);
    const deviation = (spread: number): number => {
      let sum = 0;
      for (let i = 0; i < 400; i++) {
        const p = spawnProjectile(sim, "rifle", vec3(0, 50, 0), dir, { shooter: null, spread });
        const v = p.vel;
        sum += Math.acos(Math.min(1, v.z / Math.hypot(v.x, v.y, v.z)));
      }
      return sum / 400;
    };
    const { player } = duel("stilt");
    run(2); // il se pose sur ses roues
    const rifle = WEAPONS.rifle;
    const scoped = aimSpread(player, rifle, true);
    const hip = aimSpread(player, rifle, false);
    expect(scoped).toBeCloseTo(rifle.spread, 4);
    expect(hip).toBeCloseTo(hipSpread(rifle), 4);
    expect(deviation(scoped) / deviation(hip)).toBeGreaterThan(0.7 / rifle.handling.hip);
    expect(deviation(scoped) / deviation(hip)).toBeLessThan(1.3 / rifle.handling.hip);
    // Le robot roule à 4 m/s : sa visée se dégrade, celle du sniper bien plus que celle du fusil
    player.cockpit.part.rb.setLinvel(vec3(0, 0, 4), true);
    expect(aimSpread(player, rifle, true)).toBeGreaterThan(rifle.spread * 3);
    const sniper = aimSpread(player, WEAPONS.sniper, true);
    expect(sniper).toBeGreaterThan(0.08); // près de 5° : il ne touche plus rien
    expect(sniper).toBeGreaterThan(aimSpread(player, rifle, true) * 5);
    // Il tourne sur lui-même : la visée se dégrade aussi
    player.cockpit.part.rb.setLinvel(vec3(0, 0, 0), true);
    player.cockpit.part.rb.setAngvel(vec3(0, 1.5, 0), true);
    expect(aimSpread(player, WEAPONS.sniper, true)).toBeGreaterThan(0.1);
  });

  it("le sniper du joueur ne tire qu'au viseur", () => {
    const { player, enemy } = duel("stilt");
    run(1);
    expect(WEAPONS.sniper.scopeOnly).toBe(true);
    sim.input.aim = add(enemy.lastPos, vec3(0, 1, 0));
    sim.input.weapon = "sniper";
    sim.input.trigger = true;
    run(4);
    const sniperShots = (): number => events.filter((e) => e.type === "shot" && e.weapon === "sniper").length;
    expect(sniperShots()).toBe(0);
    sim.input.scope = true;
    run(4);
    expect(sniperShots()).toBeGreaterThan(0);
    expect(player.cockpit.alive).toBe(true);
  });

  it("le canon du joueur se lève vers le ciel", () => {
    const { player } = duel("tank");
    run(1);
    sim.input.aim = add(player.lastPos, vec3(0, 40, 12));
    run(3);
    const cannon = liveTurrets(player).find((t) => t.weapon === "cannon")!;
    expect(cannon.pitch).toBeGreaterThan(1);
  });

  it("le canon du joueur pointe droit vers le réticule : viser l'horizon ne l'envoie pas au ciel", () => {
    const { player } = duel("tank");
    run(1);
    const cannon = liveTurrets(player).find((t) => t.weapon === "cannon")!;
    // Bien au-delà de sa portée : la solution balistique relèverait le canon à 45°
    sim.input.aim = add(turretFrame(cannon).muzzle, vec3(500, 0, 0));
    run(3);
    const { dir } = turretFrame(cannon);
    expect(Math.abs(Math.asin(dir.y))).toBeLessThan(0.05);
    expect(dir.x).toBeGreaterThan(0.99);
  });

  it("le canon du joueur tire à sa butée quand on vise plus bas qu'il ne peut", () => {
    const { player } = duel("tank");
    run(1);
    const cannon = liveTurrets(player).find((t) => t.weapon === "cannon")!;
    sim.input.aim = add(turretFrame(cannon).muzzle, vec3(0, -3, 4));
    sim.input.weapon = "cannon";
    sim.input.trigger = true;
    run(3);
    expect(cannon.pitch).toBeCloseTo(turretSpec(cannon).minPitch, 2);
    expect(events.some((e) => e.type === "shot" && e.weapon === "cannon")).toBe(true);
  });

  it("les tourelles des armes qui ne sont pas choisies reviennent au repos", () => {
    const { player } = duel("truck");
    run(1);
    const cannon = liveTurrets(player).find((t) => t.weapon === "cannon")!;
    const rifle = liveTurrets(player).find((t) => t.weapon !== "cannon" && !turretSpec(t).fixed)!;
    // Toutes les armes visent sur le côté
    sim.input.aim = add(turretFrame(cannon).muzzle, vec3(40, 2, 0));
    sim.input.weapon = null;
    run(3);
    expect(Math.abs(rifle.yaw)).toBeGreaterThan(1);
    // Le canon choisi garde la visée ; le fusil revient droit devant, à l'horizontale
    sim.input.weapon = "cannon";
    run(3);
    expect(turretFrame(cannon).dir.x).toBeGreaterThan(0.9);
    expect(rifle.yaw).toBeCloseTo(0, 3);
    expect(rifle.pitch).toBeCloseTo(0, 3);
  });

  it("l'obus tombe là où le HUD prévoit son point de chute", () => {
    const { player } = duel("tank");
    run(1);
    const cannon = liveTurrets(player).find((t) => t.weapon === "cannon")!;
    // Vers l'est, 8° au-dessus de l'horizon
    sim.input.aim = add(turretFrame(cannon).muzzle, vec3(Math.cos(0.14) * 50, Math.sin(0.14) * 50, 0));
    sim.input.weapon = "cannon";
    let predicted: Impact | null = null;
    let landed: Vec3 | null = null;
    sim.on((e) => {
      if (e.type === "shot" && e.weapon === "cannon" && !predicted) {
        const vel = add(scale(e.dir, WEAPONS.cannon.projectile.speed), muzzleVelocity(cannon, e.origin));
        predicted = predictImpact(e.origin, vel, WEAPONS.cannon.projectile, (a, b) => {
          const d = sub(b, a);
          const length = Math.hypot(d.x, d.y, d.z);
          return sim.raycast(a, scale(d, 1 / length), length, player)?.point ?? null;
        });
      }
      if (e.type === "explosion" && predicted && !landed) landed = e.point;
    });
    run(2);
    sim.input.trigger = true;
    run(4);
    expect(predicted).not.toBeNull();
    expect(landed).not.toBeNull();
    const { point } = predicted!;
    expect(Math.hypot(point.x - landed!.x, point.y - landed!.y, point.z - landed!.z)).toBeLessThan(0.3);
    // Assez loin, et pas plus loin que ce que permet la hausse
    const range = Math.hypot(point.x - player.lastPos.x, point.z - player.lastPos.z);
    expect(range).toBeGreaterThan(30);
  });

  it("un tir qui touche annonce le tireur, sa cible et les blocs détruits", () => {
    const { player, enemy } = duel("tank");
    // La cible ne bouge pas : on vise là où elle est
    sim.aiPaused = true;
    run(1);
    // Le joueur lève le réticule au-dessus de sa cible pour compenser la chute de l'obus
    const cannon = liveTurrets(player).find((t) => t.weapon === "cannon")!;
    const { muzzle } = turretFrame(cannon);
    const target = add(enemy.lastPos, vec3(0, 1, 0));
    const lob = firingDirection(muzzle, target, vec3(0, 0, 0), WEAPONS.cannon);
    sim.input.aim = add(muzzle, scale(lob, Math.hypot(target.x - muzzle.x, target.z - muzzle.z)));
    sim.input.trigger = true;
    sim.input.weapon = "cannon";
    run(6);
    const hits = events.filter((e): e is Extract<SimEvent, { type: "hit" }> => e.type === "hit");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.attacker === player && h.victim === enemy && h.cause === "cannon")).toBe(true);
    expect(hits.some((h) => h.destroyed > 0)).toBe(true);
  });

  it("en conduite relative à la caméra, le robot tourne vers la direction voulue, ou recule si elle est derrière lui", () => {
    const { player } = duel("tank");
    run(1);
    const nose = (): { x: number; z: number } => {
      const f = qrot(player.cockpit.part.rb.rotation(), vec3(0, 0, 1));
      return { x: f.x, z: f.z };
    };
    const start = nose();
    const heading = Math.atan2(start.x, start.z);
    sim.input.relative = true;
    // La caméra regarde un quart de tour à gauche du robot : « avancer », c'est aller à sa gauche
    sim.input.heading = heading + Math.PI / 2;
    sim.input.throttle = 1;
    run(4);
    const turned = Math.atan2(Math.sin(Math.atan2(nose().x, nose().z) - heading), Math.cos(Math.atan2(nose().x, nose().z) - heading));
    expect(turned).toBeGreaterThan(1.1);
    // Derrière lui : il recule sans faire demi-tour
    const facing = Math.atan2(nose().x, nose().z);
    const before = player.lastPos;
    sim.input.heading = facing + Math.PI;
    run(3);
    const moved = { x: player.lastPos.x - before.x, z: player.lastPos.z - before.z };
    const back = moved.x * -Math.sin(facing) + moved.z * -Math.cos(facing);
    expect(back).toBeGreaterThan(1.5);
    const after = Math.atan2(nose().x, nose().z);
    expect(Math.abs(Math.atan2(Math.sin(after - facing), Math.cos(after - facing)))).toBeLessThan(0.6);
  });

  it("un robot volant piloté avance dans la direction de la caméra", () => {
    const { player } = duel("drone");
    run(2);
    const start = player.lastPos;
    sim.input.heading = Math.PI / 2; // la caméra regarde vers +x
    sim.input.throttle = 1;
    run(4);
    expect(player.lastPos.x - start.x).toBeGreaterThan(5);
    expect(Math.abs(player.lastPos.z - start.z)).toBeLessThan(3);
  });

  it("une destruction rapporte un point à l'adversaire ; le robot réapparaît de son côté", () => {
    const [, red] = spawnTeams(sim, [{ profile: preset("ram"), team: "blue" }, { profile: preset("trike"), team: "red" }]);
    sim.combat = false;
    startMatch(sim, { scoreToWin: 3, timeLimit: 0, respawn: 2 });
    kill(red);
    expect(sim.match!.score).toEqual({ red: 0, blue: 1 });
    run(2.2);
    const fresh = sim.bots[1];
    expect(fresh).not.toBe(red);
    expect(fresh.cockpit.alive).toBe(true);
    expect(fresh.team).toBe("red");
    expect(fresh.lastPos.z).toBeGreaterThan(0); // les rouges apparaissent au nord
  });

  it("la partie s'arrête au score visé", () => {
    spawnTeams(sim, [{ profile: preset("ram"), team: "blue" }, { profile: preset("trike"), team: "red" }]);
    sim.combat = false;
    startMatch(sim, { scoreToWin: 2, timeLimit: 0, respawn: 0.5 });
    kill(sim.bots[1]);
    run(1);
    kill(sim.bots[1]);
    run(0.1);
    expect(sim.match!.winner).toBe("blue");
    expect(events.some((e) => e.type === "matchOver" && e.winner === "blue")).toBe(true);
  });

  it("en élimination, la dernière équipe debout gagne", () => {
    const bots = spawnTeams(sim, matchEntries(GAME_MODES.elimination, preset("tank")).slice(0, 4));
    sim.combat = false;
    startMatch(sim, GAME_MODES.elimination.match);
    for (const bot of bots.filter((b) => b.team === "red")) kill(bot);
    run(0.1);
    expect(sim.match!.winner).toBe("blue");
  });

  it("la destruction est créditée au robot qui a tiré", () => {
    const { player, enemy } = duel("ram");
    let killer: Bot | null | undefined;
    sim.on((e) => {
      if (e.type === "botKilled") killer = e.killer;
    });
    // Un obus du joueur, puis le coup fatal
    sim.fire("cannon", add(enemy.lastPos, vec3(0, 3, 0)), DOWN);
    const shell = sim.projectiles[sim.projectiles.length - 1] as { shooter: Bot | null };
    shell.shooter = player;
    run(0.5);
    kill(enemy);
    expect(killer).toBe(player);
  });

  it("un robot renversé se redresse tout seul après quelques secondes", () => {
    const [bot] = spawnTeams(sim, [{ profile: preset("buggy"), team: "blue" }]);
    sim.combat = false;
    run(1);
    // Le robot entier se retourne autour de son centre de masse, un peu en l'air (ses roues montées suivent ses morceaux)
    const rb = bot.cockpit.part.rb;
    const center = rb.worldCom();
    const turn = axisAngle(vec3(0, 0, 1), Math.PI);
    const bodies = [...[...bot.parts].map((p) => p.rb), ...bot.wheels.map((w) => w.body)];
    for (const body of bodies) {
      if (!body) continue;
      const p = add(center, qrot(turn, sub(body.translation(), center)));
      body.setTranslation(vec3(p.x, p.y + 1.2, p.z), true);
      body.setRotation(qmul(turn, body.rotation()), true);
      body.setLinvel(vec3(0, 0, 0), true);
      body.setAngvel(vec3(0, 0, 0), true);
    }
    const upY = (): number => qrot(rb.rotation(), vec3(0, 1, 0)).y;
    run(2);
    expect(upY()).toBeLessThan(FLIPPED_UP_Y);
    expect(bot.ai.mode).toBe("flipped");
    run(RIGHTING_DELAY + 2);
    expect(upY()).toBeGreaterThan(0.8);
    expect(bot.ai.mode).not.toBe("flipped");
  });

  it("un robot de l'IA immobilisé depuis trop longtemps se saborde, puis réapparaît", () => {
    const [, red] = spawnTeams(sim, [{ profile: preset("ram"), team: "blue" }, { profile: preset("trike"), team: "red" }]);
    sim.combat = false;
    startMatch(sim, { scoreToWin: 0, timeLimit: 0, respawn: 1 });
    for (const w of [...red.wheels]) releaseWheel(sim, w);
    run(14);
    expect(red.cockpit.alive).toBe(false);
    expect(sim.match!.score.blue).toBe(1);
    expect(sim.bots[1]).not.toBe(red);
  });
});
