import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Room, type Player } from "../src/server/room";
import { ARENAS } from "../src/shared/arena/layout";
import { BLOCK_TYPES } from "../src/shared/catalog/blocks";
import { biteDps, biteSpeed, biteTorque, meleeDef } from "../src/shared/catalog/melee";
import { BITE_TICK, meleeCharge, meleeFrame } from "../src/shared/combat/melee";
import { designConflicts, placementConflicts } from "../src/shared/design/clearance";
import { PRESET_BOTS, type BotProfile } from "../src/shared/design/presets";
import { DesignGrid, validateDesign, type Facing, type RobotDesign, type WheelMount } from "../src/shared/design/robotDesign";
import { GAME_MODES } from "../src/shared/modes";
import { dot, qrot, qrotInv, sub, vec3 } from "../src/shared/math/vec";
import { PROTOCOL_VERSION, SNAPSHOT_EVERY, type ClientMessage } from "../src/shared/net/protocol";
import { Replica } from "../src/shared/net/replica";
import { groundHeight, spawnBot } from "../src/shared/robot/lifecycle";
import { blockWorldPos } from "../src/shared/robot/queries";
import type { Block, Bot } from "../src/shared/sim/entities";
import type { SimEvent } from "../src/shared/sim/events";
import { startMatch } from "../src/shared/sim/match";
import { newInput, takeControl, type PlayerInput } from "../src/shared/sim/player";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnTeams } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";
import { botName } from "../src/client/i18n/names";

/*
 * Armes de contact qui mordent (combat/melee.ts, `MeleeSpec.bite`) : la scie circulaire et la
 * foreuse. Une morsure continue tire ses dégâts du régime, fait baisser le régime sous la charge,
 * perce un bloc puis le suivant ; la scie tire son robot le long de sa cible, la foreuse tord (et
 * fait rouler un robot léger), un glacis rasant fait glisser la scie. Sur le sol plat du Dépôt.
 */

/** `MELEE_REPORT=1 npx vitest run tests/meleeBite.test.ts --silent=false` : les mesures de chaque essai. */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const report = (label: string, ...values: unknown[]): void => {
  if (env.MELEE_REPORT) console.log(label, ...values);
};

let sim: Simulation | null = null;
beforeAll(async () => {
  await initPhysics();
});
afterEach(() => {
  sim?.dispose();
  sim = null;
});

const preset = (id: string): BotProfile => PRESET_BOTS.find((p) => p.id === id)!;
const profile = (id: string, design: RobotDesign): BotProfile => ({
  id, name: id, color: "#888888", speed: 5, turn: 3, behavior: "charge", mobility: "ground", design,
});

function world(): Simulation {
  sim?.dispose();
  seedRandom(3);
  const w = new Simulation();
  // Le Dépôt, sans ses accessoires : rien entre les robots
  w.arena = { ...ARENAS.depot, props: [] };
  sim = w;
  return w;
}

/** Un robot posé au sol en (x, z), tourné de `yaw`, ajouté à la simulation. */
function place(w: Simulation, p: BotProfile, x: number, z: number, yaw = 0, team: "red" | "blue" = "blue"): Bot {
  const bot = spawnBot(w, p, vec3(x, groundHeight(p.design) + 0.03, z), yaw, team);
  w.bots.push(bot);
  return bot;
}

/** Le robot passe aux commandes `input` (l'IA des autres est figée). */
function pilot(bot: Bot, weapon: PlayerInput["weapon"]): PlayerInput {
  const input = { ...newInput(), weapon };
  takeControl(bot, input);
  return input;
}

const run = (w: Simulation, seconds: number): void => {
  for (let i = 0; i < Math.round(seconds * 60); i++) w.step();
};

/** Points de structure de tous les blocs d'un robot. */
const totalHp = (bot: Bot): number => [...bot.blocks.values()].reduce((s, b) => s + b.hp, 0);

/** Roulis d'un robot (rad) : de combien son haut penche sur le côté. */
const rollOf = (bot: Bot): number => {
  const q = bot.cockpit.part.rb.rotation();
  const up = qrot(q, vec3(0, 1, 0));
  const left = qrot(q, vec3(1, 0, 0));
  return Math.atan2(left.y, up.y);
};

/**
 * Un mur posé au sol (sans roues), face à -z : un socle de blindage lourd, puis, à hauteur `height`
 * (1 : ~0,75 m du sol), une rangée de blocs `front`, deux rangées `back` derrière, une de blindage
 * lourd, et son cockpit au-dessus de l'arrière.
 */
function wall(front: keyof typeof BLOCK_TYPES, back: keyof typeof BLOCK_TYPES, facing?: Facing, height = 1): RobotDesign {
  const g = new DesignGrid();
  g.box(-3, 3, 0, height - 1, 0, 4, "armorHeavy");
  g.box(-3, 3, height, height, 0, 0, front, facing);
  g.box(-3, 3, height, height, 1, 2, back);
  g.box(-3, 3, height, height, 3, 4, "armorHeavy");
  g.put(0, height + 1, 4, "cockpit");
  return { blocks: g.blocks(), wheels: [] };
}

/** Une petite foreuse légère : une colonne d'un bloc de large (châssis, cockpit dessus), sur petites roues. */
function lightDriller(): RobotDesign {
  const g = new DesignGrid();
  g.box(0, 0, 0, 0, -2, 0, "frame");
  g.put(0, 0, 1, "drill");
  g.put(0, 1, -1, "cockpit");
  const small = (z: number, dx: number): WheelMount => ({ x: 0, y: 0, z, dx, dz: 0, type: "small" });
  return { blocks: g.blocks(), wheels: [small(-2, -1), small(-2, 1), small(0, -1), small(0, 1)] };
}

/** Une cible dont le cockpit est au bout d'une ligne de blocs, à hauteur de la foreuse du Foreur, face à -z. */
function lineTarget(): RobotDesign {
  const g = new DesignGrid();
  g.box(-2, 2, 0, 0, 0, 3, "armorHeavy");
  g.box(-2, 2, 1, 1, 0, 3, "armorHeavy");
  g.put(0, 1, 0, "armor").put(0, 1, 1, "armor").put(0, 1, 2, "cockpit");
  return { blocks: g.blocks(), wheels: [] };
}

/** Le Scieur (ou un autre robot à scie) mord la cible posée devant lui, à `gap` m de son nez. */
function sawAgainst(design: RobotDesign, seconds: number, spinning = true): { w: Simulation; sawyer: Bot; target: Bot; input: PlayerInput } {
  const w = world();
  const sawyer = place(w, preset("sawyer"), 0, -2);
  const input = pilot(sawyer, spinning ? "saw" : "spinner");
  w.aiPaused = true;
  run(w, 2.5);
  const target = place(w, profile("cible", design), 0, 1.4, 0, "red");
  input.throttle = 0.5;
  run(w, seconds);
  return { w, sawyer, target, input };
}

describe("armes de contact qui mordent", () => {
  it("les robots prédéfinis sont valides, et rien n'entre dans le disque de la scie ni sur la mèche de la foreuse", () => {
    for (const id of ["sawyer", "borer"]) {
      const design = preset(id).design;
      expect(validateDesign(design), id).toEqual([]);
      expect(designConflicts(design), id).toEqual([]);
    }
    // Un bloc posé dans le disque (devant le nez du Scieur), sur la mèche (devant le Foreur), est refusé
    expect(placementConflicts(preset("sawyer").design, { kind: "block", block: { x: 0, y: 0, z: 3, type: "armor" } }).length).toBeGreaterThan(0);
    expect(placementConflicts(preset("borer").design, { kind: "block", block: { x: 0, y: 1, z: 5, type: "armor" } }).length).toBeGreaterThan(0);
    // Le régime d'équilibre sous la charge : sous le plein régime (le moteur ne rend pas toute la coupe), au-dessus du régime où la lame cale
    for (const id of ["saw", "drill"] as const) {
      const m = meleeDef(id);
      const omega = biteSpeed(m.spin!, m.bite!);
      report("ÉQUILIBRE", id, { regime: omega / m.spin!.speed, dpsFull: biteDps(m, m.spin!.speed), dpsHeld: biteDps(m, omega), torque: biteTorque(m.spin!, m.bite!) });
      expect(omega / m.spin!.speed).toBeLessThan(0.7);
      expect(omega / m.spin!.speed).toBeGreaterThan(m.hit.minSpeed + 0.1);
    }
  });

  it("la scie mord en continu : son régime baisse sous la charge, et sa puissance de coupe le suit", () => {
    const w = world();
    const sawyer = place(w, preset("sawyer"), 0, -2);
    const input = pilot(sawyer, "saw");
    w.aiPaused = true;
    run(w, 2.5);
    const arm = sawyer.melee[0];
    expect(meleeCharge(arm)).toBeGreaterThan(0.97);
    place(w, profile("mur", wall("armorHeavy", "armorHeavy")), 0, 1.4, 0, "red");
    input.throttle = 0.5;
    const samples: { regime: number; power: number }[] = [];
    for (let i = 0; i < 300; i++) {
      w.step();
      if (arm.bite?.surface === "robot") samples.push({ regime: arm.spin, power: arm.bite.power });
    }
    expect(samples.length).toBeGreaterThan(120);
    const first = samples[0];
    const low = samples.reduce((a, b) => (b.regime < a.regime ? b : a));
    report("RÉGIME", { first, low, steps: samples.length, equilibrium: biteSpeed(meleeDef("saw").spin!, meleeDef("saw").bite!) });
    // Le régime tombe vers son équilibre (le moteur ne rend pas toute la coupe), sans caler
    const spin = meleeDef("saw").spin!;
    expect(first.regime).toBeGreaterThan(0.9 * spin.speed);
    expect(low.regime).toBeLessThan(0.65 * spin.speed);
    expect(low.regime).toBeGreaterThan(0.85 * biteSpeed(spin, meleeDef("saw").bite!));
    // La puissance de coupe suit le régime (couple constant)
    const torque = biteTorque(spin, meleeDef("saw").bite!);
    for (const s of samples) expect((s.power * 1000) / s.regime).toBeGreaterThan(0.9 * torque);
    for (const s of samples) expect((s.power * 1000) / s.regime).toBeLessThan(1.15 * torque);
  });

  it("ses dégâts continus suivent le régime : deux fois plus de dégâts à plein régime qu'à mi-régime", () => {
    const damageAt = (share: number): number => {
      const w = world();
      const sawyer = place(w, preset("sawyer"), 0, -2);
      // Arme non choisie : le moteur ne rend rien, le régime ne vient que de l'élan qu'on lui donne
      pilot(sawyer, "spinner");
      w.aiPaused = true;
      run(w, 1);
      // (le disque, devant le nez, entre de 0,4 m dans sa première rangée)
      const target = place(w, profile("mur", wall("armorHeavy", "armorHeavy")), 0, 0, 0, "red");
      run(w, 0.5);
      const before = totalHp(target);
      const arm = sawyer.melee[0];
      arm.spin = share * meleeDef("saw").spin!.speed;
      // Une tranche de morsure, et ce qu'elle a fait
      run(w, BITE_TICK + 2 / 60);
      return before - totalHp(target);
    };
    const full = damageAt(1);
    const half = damageAt(0.5);
    report("DÉGÂTS / RÉGIME", { full, half, ratio: full / half });
    expect(full).toBeGreaterThan(10);
    expect(full / half).toBeGreaterThan(1.6);
    expect(full / half).toBeLessThan(2.6);
  });

  it("la scie perce un bloc puis le suivant : ce qui reste d'une tranche passe au bloc de derrière", () => {
    const w = world();
    const sawyer = place(w, preset("sawyer"), 0, -2);
    const input = pilot(sawyer, "saw");
    w.aiPaused = true;
    run(w, 2.5);
    const target = place(w, profile("mur", wall("armorLight", "armorLight")), 0, 1.4, 0, "red");
    const destroyed: { block: Block; time: number }[] = [];
    const damaged: { block: Block; time: number }[] = [];
    w.on((e) => {
      if (e.type === "blockDestroyed" && e.block.bot === target) destroyed.push({ block: e.block, time: w.time });
      if (e.type === "blockDamaged" && e.block.bot === target) damaged.push({ block: e.block, time: w.time });
    });
    let killer: unknown = null;
    w.on((e) => {
      if (e.type === "hit" && e.victim === target) killer = e.cause;
    });
    input.throttle = 0.5;
    run(w, 3);
    report("PERCÉE", destroyed.map((d) => `${d.time.toFixed(2)} ${d.block.x},${d.block.y},${d.block.z}`).join(" · "));
    expect(destroyed.length).toBeGreaterThanOrEqual(2);
    expect(killer).toBe("saw");
    // Le premier bloc mordu : celui du milieu de la rangée de devant, à hauteur de la lame
    const first = destroyed[0].block;
    expect(first.z).toBe(0);
    expect(first.y).toBe(1);
    // Au pas où il cède, le bloc de derrière reçoit ce qui reste de la tranche
    const behind = damaged.find((d) => d.block.x === first.x && d.block.y === first.y && d.block.z === first.z + 1);
    expect(behind).toBeDefined();
    expect(behind!.time).toBeCloseTo(destroyed[0].time, 6);
  });

  it("sa prise tire son robot le long de la cible (à l'opposé du sens de la lame), pas une scie arrêtée", () => {
    const drift = (spinning: boolean): { lateral: number; along: number; yaw: number } => {
      const { w, sawyer } = sawAgainst(wall("armorHeavy", "armorHeavy"), 0.4, spinning);
      const arm = sawyer.melee[0];
      // Le nez du robot (le bloc de la scie), le long du mur
      const start = blockWorldPos(arm.block);
      const heading = (): number => {
        const f = qrot(sawyer.cockpit.part.rb.rotation(), vec3(0, 0, 1));
        return Math.atan2(f.x, f.z);
      };
      const yaw0 = heading();
      let along = 0;
      let seen = 0;
      for (let i = 0; i < 90; i++) {
        w.step();
        if (arm.bite?.surface === "robot") {
          along += arm.bite.dir.x;
          seen++;
        }
      }
      const end = blockWorldPos(arm.block);
      return { lateral: end.x - start.x, along: seen ? along / seen : 0, yaw: heading() - yaw0 };
    };
    const spun = drift(true);
    const still = drift(false);
    report("PRISE", { spun, still });
    // La lame va d'un côté le long du mur : le nez de son robot glisse de l'autre (et il pivote un peu)
    expect(Math.abs(spun.along)).toBeGreaterThan(0.3);
    expect(-Math.sign(spun.along) * spun.lateral).toBeGreaterThan(0.3);
    expect(Math.abs(still.lateral)).toBeLessThan(0.1);
  });

  it("ricochet : un glacis rasant fait glisser la scie (moins de dégâts, moins de régime pris)", () => {
    const bite = (design: RobotDesign): { glance: boolean; power: number; damage: number } => {
      const w = world();
      const sawyer = place(w, preset("sawyer"), 0, -2);
      const input = pilot(sawyer, "saw");
      w.aiPaused = true;
      run(w, 2.5);
      const target = place(w, profile("mur", design), 0, 1.4, 0, "red");
      const before = totalHp(target);
      input.throttle = 0.4;
      const arm = sawyer.melee[0];
      let first: { glance: boolean; power: number } | null = null;
      for (let i = 0; i < 240 && !first; i++) {
        w.step();
        if (arm.bite?.surface === "robot") first = { glance: arm.bite.glance, power: arm.bite.power / (arm.spin || 1) };
      }
      expect(first).not.toBeNull();
      run(w, 1);
      return { ...first!, damage: before - totalHp(target) };
    };
    // Un glacis tourné vers la scie (sa pente monte vers l'arrière), contre des cubes du même blindage
    const cubes = bite(wall("armorHeavy", "armorHeavy"));
    const glacis = bite(wall("wedgeHeavy", "armorHeavy", { up: "+y", forward: "-z" }));
    report("RICOCHET", { cubes, glacis });
    expect(cubes.glance).toBe(false);
    expect(glacis.glance).toBe(true);
    expect(glacis.power).toBeLessThan(0.85 * cubes.power);
    expect(glacis.damage).toBeLessThan(0.7 * cubes.damage);
  });

  it("la foreuse traverse une ligne de blocs jusqu'au cockpit", () => {
    const w = world();
    const borer = place(w, preset("borer"), 0, -3.2);
    const input = pilot(borer, "drill");
    w.aiPaused = true;
    run(w, 2.5);
    const arm = borer.melee[0];
    const hub = meleeFrame(arm).hub;
    report("FOREUSE", { hub, charge: meleeCharge(arm) });
    const target = place(w, profile("ligne", lineTarget()), 0, 0.6, 0, "red");
    const order: string[] = [];
    let killed: { cause: unknown; time: number } | null = null;
    w.on((e) => {
      if (e.type === "blockDestroyed" && e.block.bot === target) order.push(`${e.block.type} ${e.block.x},${e.block.y},${e.block.z}`);
      if (e.type === "botKilled" && e.bot === target) killed = { cause: e.cause, time: w.time };
    });
    input.throttle = 0.4;
    const start = w.time;
    for (let i = 0; i < 12 * 60 && !killed; i++) w.step();
    report("PERCÉE DE LA FOREUSE", order.join(" · "), killed, start);
    expect(killed).not.toBeNull();
    expect(killed!.cause).toBe("drill");
    // Dans l'ordre de la ligne : les deux blocs de devant, puis le cockpit
    expect(order.slice(0, 3)).toEqual(["armor 0,1,0", "armor 0,1,1", "cockpit 0,1,2"]);
  });

  it("le couple de la foreuse fait rouler sur lui-même un robot léger, pas le Foreur, lourd et large", () => {
    const roll = (design: BotProfile, x: number): number => {
      const w = world();
      const driller = place(w, design, 0, x);
      const input = pilot(driller, "drill");
      w.aiPaused = true;
      run(w, 2.5);
      place(w, profile("mur", wall("armorHeavy", "armorHeavy")), 0, 1.6, 0, "red");
      input.throttle = 0.3;
      let worst = 0;
      for (let i = 0; i < 4 * 60; i++) {
        w.step();
        if (driller.cockpit.alive) worst = Math.max(worst, Math.abs(rollOf(driller)));
      }
      return worst;
    };
    const light = roll(profile("foreuse légère", lightDriller()), -0.8);
    const heavy = roll(preset("borer"), -3.4);
    report("ROULIS", { light: (light * 180) / Math.PI, heavy: (heavy * 180) / Math.PI });
    expect(light).toBeGreaterThan((35 * Math.PI) / 180);
    expect(heavy).toBeLessThan((5 * Math.PI) / 180);
  });

  it("réseau : la réplique voit le régime et les morsures d'une lame", () => {
    seedRandom(21);
    const room = new Room();
    try {
      const replica = new Replica();
      const player: Player = room.connect({ send: (data) => (typeof data === "string" ? undefined : replica.receive(data)) });
      const send = (msg: ClientMessage): void => room.receive(player, JSON.stringify(msg));
      const tick = (seconds: number): void => {
        const steps = Math.ceil((seconds * 60) / SNAPSHOT_EVERY) * SNAPSHOT_EVERY;
        for (let i = 0; i < steps; i++) room.tick();
      };
      send({ t: "join", version: PROTOCOL_VERSION, name: "Léa", robot: { preset: "sawyer" }, token: "jeton-de-test-morsure-0000" });
      tick(1);
      room.sim.aiPaused = true;
      send({ t: "input", input: { ...newInput(), weapon: "saw" } });
      tick(2.5);
      const bot = player.bot!;
      // Un ennemi posé devant sa scie
      const enemy = room.sim.bots.find((b) => b.team !== bot.team && b.cockpit.alive && b.profile.mobility === "ground" && b.parts.size === 1 && b.wheels.length > 0 && !b.supports.length)!;
      const frame = meleeFrame(bot.melee[0]);
      const ahead = qrot(bot.cockpit.part.rb.rotation(), vec3(0, 0, 1));
      const rb = [...enemy.parts][0].rb;
      rb.setTranslation({ x: frame.hub.x + ahead.x * 2.5, y: rb.translation().y, z: frame.hub.z + ahead.z * 2.5 }, true);
      rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
      send({ t: "input", input: { ...newInput(), weapon: "saw", throttle: 0.4 } });
      let seen = 0;
      let match = 0;
      for (let i = 0; i < 3 * 60; i++) {
        room.tick();
        const arm = bot.melee[0];
        if ((i + 1) % SNAPSHOT_EVERY) continue;
        replica.flush();
        const twin = replica.bots.find((b) => b.id === bot.id)!.melee[0];
        expect(twin.spin).toBeCloseTo(arm.spin, 3);
        if (arm.bite) {
          seen++;
          if (twin.bite && twin.bite.surface === arm.bite.surface && Math.hypot(twin.bite.point.x - arm.bite.point.x, twin.bite.point.y - arm.bite.point.y, twin.bite.point.z - arm.bite.point.z) < 1e-3) match++;
        } else {
          expect(twin.bite).toBeNull();
        }
      }
      report("RÉSEAU", { seen, match, enemy: botName(enemy.profile), hub: meleeFrame(bot.melee[0]).hub, at: enemy.cockpit.alive ? enemy.cockpit.part.rb.translation() : null, regime: meleeCharge(bot.melee[0]) });
      expect(seen).toBeGreaterThan(5);
      expect(match).toBe(seen);
    } finally {
      room.dispose();
    }
  });

  /*
   * Bilan des armes qui mordent (`MELEE_BATTLE=1 npx vitest run tests/meleeBite.test.ts --silent=false`) :
   * des batailles où chaque équipe a son Scieur et son Foreur, le reste tiré au sort ; par robot,
   * destructions, morts, temps renversé, temps passé à mordre un robot et dégâts de ses tranches.
   */
  it.runIf(!!env.MELEE_BATTLE)("bilan des armes qui mordent en bataille", { timeout: 3_600_000 }, () => {
    const lines: string[] = [];
    const stats = new Map<string, { kills: number; deaths: number; flipped: number; biting: number; killedBy: Map<string, number> }>();
    const of = (bot: Bot) => {
      let s = stats.get(botName(bot.profile));
      if (!s) stats.set(botName(bot.profile), (s = { kills: 0, deaths: 0, flipped: 0, biting: 0, killedBy: new Map() }));
      return s;
    };
    let contact = 0;
    let total = 0;
    let steps = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      seedRandom(seed);
      const w = new Simulation();
      sim = w;
      const others = PRESET_BOTS.filter((p) => !["sawyer", "borer"].includes(p.id)).sort(() => Math.random() - 0.5).slice(0, 8);
      spawnTeams(w, [
        { profile: preset("sawyer"), team: "blue" }, { profile: preset("borer"), team: "blue" },
        { profile: preset("sawyer"), team: "red" }, { profile: preset("borer"), team: "red" },
        ...others.map((profile, i) => ({ profile, team: i % 2 ? "red" as const : "blue" as const })),
      ]);
      const match = startMatch(w, { ...GAME_MODES.battle.match, timeLimit: 180 });
      w.on((e) => {
        if (e.type === "botKilled") {
          const victim = of(e.bot);
          victim.deaths++;
          victim.killedBy.set(e.cause ?? "?", (victim.killedBy.get(e.cause ?? "?") ?? 0) + 1);
          if (e.killer) of(e.killer).kills++;
        }
      });
      w.profile = { now: () => performance.now(), times: {} };
      for (let i = 0; i < 180 * 60 && !match.winner; i++) {
        w.step();
        steps++;
        for (const b of w.bots) if (b.melee.some((a) => a.bite?.surface === "robot")) of(b).biting += 1 / 60;
        if (i % 30) continue;
        for (const b of w.bots) if (b.cockpit.alive && b.ai.mode === "flipped") of(b).flipped += 0.5;
      }
      const times = w.profile.times;
      contact += times.contact ?? 0;
      total += Object.entries(times).reduce((s, [k, x]) => (k.includes("›") ? s : s + x), 0);
      lines.push(`graine ${seed} : ${match.winner ?? "en cours"}, ${Math.floor(match.score.blue)} à ${Math.floor(match.score.red)} en ${match.elapsed.toFixed(0)} s`);
      w.dispose();
      sim = null;
    }
    lines.push(`Pas moyen ${(total / steps).toFixed(2)} ms, dont l'étape « contact » ${(contact / steps).toFixed(3)} ms`);
    for (const [name, s] of [...stats].sort((a, b) => b[1].kills - b[1].deaths - (a[1].kills - a[1].deaths))) {
      lines.push(`${name.padEnd(14)} destructions ${String(s.kills).padStart(3)} · morts ${String(s.deaths).padStart(3)} · renversé ${s.flipped.toFixed(0).padStart(3)} s`
        + (s.biting ? ` · mord ${s.biting.toFixed(0)} s` : "")
        + ` · tué par ${[...s.killedBy].map(([c, n]) => `${c} ${n}`).join(", ")}`);
    }
    console.log(lines.join("\n"));
  });

  it("une bataille avec le Scieur et le Foreur de chaque côté se joue sans erreur, et leurs lames mordent", { timeout: 300_000 }, () => {
    seedRandom(5);
    const w = new Simulation();
    sim = w;
    const roster = ["sawyer", "borer", "trike", "scarab", "ram", "buggy"];
    spawnTeams(w, roster.flatMap((id, i) => [
      { profile: preset(id), team: "blue" as const },
      { profile: preset(roster[(i + 3) % roster.length]), team: "red" as const },
    ]));
    startMatch(w, { ...GAME_MODES.battle.match, timeLimit: 60 });
    let biting = 0;
    let kills = 0;
    const causes: unknown[] = [];
    w.on((e: SimEvent) => {
      if (e.type === "botKilled") {
        kills++;
        causes.push(e.cause);
      }
    });
    for (let i = 0; i < 60 * 60; i++) {
      w.step();
      for (const b of w.bots) if (b.melee.some((a) => a.bite?.surface === "robot")) biting++;
    }
    report("BATAILLE", { biting: biting / 60, kills, causes });
    expect(biting).toBeGreaterThan(60);
    expect(kills).toBeGreaterThan(0);
    void dot; void sub; void qrotInv;
  });
});
