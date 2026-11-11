import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { groundLevel } from "../src/shared/arena/layout";
import { blockDef } from "../src/shared/catalog/blocks";
import { profileFromDesign } from "../src/shared/design/custom";
import { PRESET_BOTS, type BotProfile } from "../src/shared/design/presets";
import { AXES, DEFAULT_FACING, DesignGrid, type Facing, type RobotDesign } from "../src/shared/design/robotDesign";
import { vec3, type Vec3 } from "../src/shared/math/vec";
import { botJets, exhaustSpec, jetContact, jetObstructions, ownContact, thrusterRole } from "../src/shared/robot/exhaust";
import { groundHeight, spawnBot } from "../src/shared/robot/lifecycle";
import type { Bot, Prop, Team } from "../src/shared/sim/entities";
import type { SimEvent } from "../src/shared/sim/events";
import { takeControl, type PlayerInput } from "../src/shared/sim/player";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { seedRandom } from "./seed";

/*
 * Le jet de flamme des moteurs (robot/exhaust.ts, combat/scorch.ts) : ce qui est derrière la
 * tuyère d'un réacteur, d'un propulseur ou d'un turboréacteur qui pousse chauffe et peut prendre
 * feu ; son propre robot aussi, s'il est mal construit. Les robots prédéfinis ne se brûlent pas.
 */

const PUSH_FORWARD: Facing = { up: "+z", forward: "+y" };

/** Le plan a-t-il un moteur à flamme ? */
const hasFlameEngine = (design: RobotDesign): boolean =>
  design.blocks.some((b) => exhaustSpec(b.type, thrusterRole(AXES[(b.facing ?? DEFAULT_FACING).up])) !== null);

let sim: Simulation | null = null;
beforeAll(async () => {
  await initPhysics();
});
afterEach(() => {
  sim?.dispose();
  sim = null;
});

function world(arena?: "valley"): Simulation {
  sim?.dispose();
  seedRandom(5);
  sim = new Simulation();
  if (arena) sim.loadArena(arena);
  return sim;
}

/** Fait apparaître un robot en `pos`, tourné vers `yaw` (avant : (sin, 0, cos)), dans la partie. */
function spawn(s: Simulation, profile: BotProfile, pos: Vec3, yaw: number, team: Team): Bot {
  const bot = spawnBot(s, profile, pos, yaw, team);
  s.bots.push(bot);
  return bot;
}

/** Pose un robot au sol en (x, z). */
function place(s: Simulation, profile: BotProfile, x: number, z: number, yaw: number, team: Team): Bot {
  const y = groundLevel(s.arena, x, z) + (profile.mobility === "hover" ? 1.2 : groundHeight(profile.design) + 0.03);
  return spawn(s, profile, vec3(x, y, z), yaw, team);
}

/** Immobilise un robot (vitesses nulles) : il pousse sans avancer. */
function hold(bot: Bot): void {
  for (const part of bot.parts) {
    part.rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
    part.rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }
}

/** Points de structure perdus par les blocs d'un robot (blocs détruits compris). */
const lostHp = (bot: Bot, start: Map<number, number>): number => {
  let lost = 0;
  for (const [id, hp] of start) {
    const block = [...bot.blocks.values()].find((b) => b.id === id);
    lost += hp - (block?.hp ?? 0);
  }
  return lost;
};
const hpOf = (bot: Bot): Map<number, number> => new Map([...bot.blocks.values()].map((b) => [b.id, b.hp]));

describe("le jet de flamme des moteurs", () => {
  const flaming = PRESET_BOTS.filter((p) => hasFlameEngine(p.design));

  it("les robots prédéfinis à moteurs à flamme n'ont aucun bloc dans le jet de leurs moteurs", () => {
    expect(flaming.map((p) => p.id).sort()).toEqual(["angel", "dragster", "drone", "fighter", "frigate", "hexa", "rocket"]);
    for (const p of PRESET_BOTS) expect(jetObstructions(p.design), p.id).toEqual([]);
  });

  it.each(flaming.map((p) => [p.name, p] as const))("%s ne se brûle pas à plein régime", (_name, profile) => {
    const s = world("valley");
    const plane = profile.mobility === "plane";
    // En l'air pour un avion (à sa vitesse de croisière), au sol pour les autres, dans un champ dégagé
    const bot = plane ? spawn(s, profile, vec3(0, 60, -40), 0, "red") : place(s, profile, 0, -40, 0, "red");
    if (plane) for (const part of bot.parts) part.rb.setLinvel({ x: 0, y: 0, z: profile.speed }, true);
    const input: Partial<PlayerInput> = plane
      ? { manual: true, power: 1, throttle: 0, steer: 0 }
      : profile.mobility === "hover"
        ? { climb: 1, throttle: 0.6 }
        : { boost: true, throttle: 0 };
    Object.assign(s.input, input);
    takeControl(bot, s.input);
    const start = hpOf(bot);
    let power = 0;
    let selfContact = 0;
    for (let i = 0; i < 4 * 60; i++) {
      s.step();
      if (profile.mobility === "ground") hold(bot);
      for (const jet of botJets(s, bot)) {
        power = Math.max(power, jet.power);
        if (ownContact(jet)) selfContact++;
      }
    }
    // Les moteurs ont bien poussé à fond, sans que leur jet touche le robot
    expect(power).toBeGreaterThan(0.9);
    expect(selfContact).toBe(0);
    expect(lostHp(bot, start)).toBe(0);
    expect([...s.fires].some((b) => b.bot === bot)).toBe(false);
  });

  /** Un plan du garage : un châssis sur quatre roues, un propulseur à l'arrière, et un bloc posé juste derrière sa tuyère. */
  function badDesign(): RobotDesign {
    const g = new DesignGrid();
    g.box(-1, 1, 0, 0, -2, 2, "frame");
    g.put(0, 1, 0, "cockpit");
    g.put(0, 0, -3, "engine", PUSH_FORWARD);
    g.put(0, 0, -4, "armorLight"); // dans le jet
    return {
      blocks: g.blocks(),
      wheels: [[-1, -2, -1], [1, -2, 1], [-1, 2, -1], [1, 2, 1]].map(([x, z, dx]) => ({ x, y: 0, z, dx, dz: 0, type: "standard" as const })),
    };
  }

  it("un bloc posé derrière la tuyère d'un plan du garage brûle, et le garage le signale", () => {
    const design = badDesign();
    expect(jetObstructions(design).map((o) => [o.engine.type, o.block.type])).toEqual([["engine", "armorLight"]]);
    const s = world();
    const bot = place(s, profileFromDesign("Brûlot", "#c04020", design), 0, 0, 0, "red");
    const behind = bot.blocks.get("0,0,-4")!;
    const before = behind.hp;
    Object.assign(s.input, { boost: true, throttle: 0 });
    takeControl(bot, s.input);
    for (let i = 0; i < 3 * 60; i++) {
      s.step();
      hold(bot);
      // L'affichage le voit aussi (la suie, les flammèches)
      if (i === 60) expect(botJets(s, bot).map((jet) => jetContact(s, jet))).toMatchObject([{ kind: "block", block: behind, distance: 0 }]);
    }
    expect(behind.hp).toBeLessThan(before - 15);
    // Personne n'est crédité : c'est son propre jet
    expect(bot.lastAttacker).toBeNull();
  });

  /** Un mannequin : une caisse de châssis et de blindage sur quatre roues. */
  const dummy = (): BotProfile => {
    const g = new DesignGrid();
    g.box(-1, 1, 0, 0, -2, 2, "frame");
    g.box(-1, 1, 1, 1, -2, 2, "armorLight");
    g.put(0, 1, 0, "cockpit");
    return profileFromDesign("Mannequin", "#808080", {
      blocks: g.blocks(),
      wheels: [[-1, -2, -1], [1, -2, 1], [-1, 2, -1], [1, 2, 1]].map(([x, z, dx]) => ({ x, y: 0, z, dx, dz: 0, type: "standard" as const })),
    });
  };

  it("un robot ennemi dans le jet d'un Bolide qui pousse chauffe et prend feu ; le Bolide est crédité", () => {
    const s = world();
    const events: SimEvent[] = [];
    s.on((e) => events.push(e));
    const dragster = PRESET_BOTS.find((p) => p.id === "dragster")!;
    const bolide = place(s, dragster, 0, 0, 0, "red");
    // Ses tuyères sont 3,7 m derrière son origine : le mannequin, de travers, 1,2 m plus loin
    const target = place(s, dummy(), 0, -6.1, Math.PI / 2, "blue");
    const start = hpOf(target);
    Object.assign(s.input, { boost: true, throttle: 0 });
    takeControl(bolide, s.input);
    let burned = false;
    let seen = false;
    for (let i = 0; i < 4 * 60; i++) {
      s.step();
      hold(bolide);
      hold(target);
      if ([...target.blocks.values()].some((b) => b.burn > 0)) burned = true;
      // Ce que l'affichage en voit, sans physique (en réseau aussi) : le jet bute sur le mannequin
      if (i === 90) seen = botJets(s, bolide).some((jet) => jetContact(s, jet)?.block?.bot === target);
    }
    expect(seen).toBe(true);
    expect(lostHp(target, start)).toBeGreaterThan(30);
    expect(burned).toBe(true);
    expect(events.some((e) => e.type === "fireStarted" && e.block.bot === target)).toBe(true);
    expect(target.lastAttacker).toBe(bolide);
    // Rien de son côté
    expect([...bolide.blocks.values()].every((b) => b.hp === blockDef(b.type).hp)).toBe(true);
  });

  it("l'IA n'allume pas un propulseur qui brûlerait son propre robot", () => {
    const boosted = (design: RobotDesign): number => {
      const s = world();
      const bot = place(s, profileFromDesign("Fuyard", "#c04020", design), 0, 0, 0, "red");
      expect(bot.controller).toBe("ai");
      // En fuite, droit devant : un propulseur sain s'allume
      Object.assign(bot.ai, { mode: "flee", modeT: 10, target: vec3(0, 0, 30) });
      let thrust = 0;
      for (let i = 0; i < 2 * 60; i++) {
        s.step();
        thrust = Math.max(thrust, ...bot.thrusters.map((t) => t.thrust));
      }
      return thrust;
    };
    const bad = badDesign();
    const good = { ...bad, blocks: bad.blocks.filter((b) => !(b.x === 0 && b.y === 0 && b.z === -4)) };
    expect(boosted(good)).toBeGreaterThan(100);
    expect(boosted(bad)).toBe(0);
  });

  it("l'IA d'un Bolide allume ses turboréacteurs sur un ennemi collé à son arrière", () => {
    const s = world();
    const dragster = PRESET_BOTS.find((p) => p.id === "dragster")!;
    const bolide = place(s, dragster, 0, 0, 0, "red");
    const target = place(s, dummy(), 0, -6.1, Math.PI / 2, "blue");
    s.aiPaused = false;
    target.ai.mode = "paused";
    const start = hpOf(target);
    let thrust = 0;
    for (let i = 0; i < 1.5 * 60; i++) {
      s.step();
      hold(target);
      thrust = Math.max(thrust, ...bolide.thrusters.map((t) => t.thrust));
    }
    // Il ne fuyait ni ne chargeait : c'est l'ennemi dans son jet qui les a allumés
    expect(bolide.ai.mode).not.toBe("flee");
    expect(thrust).toBeGreaterThan(200);
    expect(lostHp(target, start)).toBeGreaterThan(0);
    expect(target.lastAttacker).toBe(bolide);
  });

  it("un robot qui ne pousse pas, ou paralysé, n'a pas de jet", () => {
    const s = world();
    const dragster = PRESET_BOTS.find((p) => p.id === "dragster")!;
    const bolide = place(s, dragster, 0, 0, 0, "red");
    Object.assign(s.input, { boost: false, throttle: 0 });
    takeControl(bolide, s.input);
    for (let i = 0; i < 60; i++) s.step();
    expect(botJets(s, bolide)).toEqual([]);
    s.input.boost = true;
    for (let i = 0; i < 2 * 60; i++) {
      s.step();
      hold(bolide);
    }
    expect(botJets(s, bolide).length).toBe(4);
    bolide.stunnedUntil = s.time + 5;
    expect(botJets(s, bolide)).toEqual([]);
  });

  it("un arbre derrière un Bolide qui pousse s'embrase", () => {
    const s = world("valley");
    // Un arbre isolé : aucun autre accessoire à moins de 9 m
    const trees = s.props.filter((p) => p.type === "oak" || p.type === "pine");
    const at = (p: Prop): Vec3 => p.rb.translation();
    const tree = trees.find((t) => s.props.every((o) => o === t || Math.hypot(at(o).x - at(t).x, at(o).z - at(t).z) > 9))!;
    expect(tree).toBeDefined();
    const c = at(tree);
    // Le Bolide tourne le dos à l'arbre, ses tuyères à 1,5 m de son tronc
    const dragster = PRESET_BOTS.find((p) => p.id === "dragster")!;
    const away = 5.2 + tree.half.x;
    const bolide = place(s, dragster, c.x, c.z + away, 0, "red");
    Object.assign(s.input, { boost: true, throttle: 0 });
    takeControl(bolide, s.input);
    for (let i = 0; i < 5 * 60 && tree.burn <= 0; i++) {
      s.step();
      hold(bolide);
    }
    expect(tree.burn).toBeGreaterThan(0);
    expect(s.propFires.has(tree)).toBe(true);
  });
});
