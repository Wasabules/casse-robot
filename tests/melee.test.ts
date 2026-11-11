import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ARENAS } from "../src/shared/arena/layout";
import { BLOCK_TYPES } from "../src/shared/catalog/blocks";
import { meleeDef, spinEnergy } from "../src/shared/catalog/melee";
import { aimSpread } from "../src/shared/combat/accuracy";
import { angularMomentum, meleeCharge, storedEnergy, vibration } from "../src/shared/combat/melee";
import { weaponDef } from "../src/shared/catalog/weapons";
import { designConflicts, placementConflicts } from "../src/shared/design/clearance";
import { PRESET_BOTS, type BotProfile } from "../src/shared/design/presets";
import { DesignGrid, validateDesign, type Facing, type RobotDesign, type WheelMount } from "../src/shared/design/robotDesign";
import { cross, len, qrot, qrotInv, sub, vec3, type Vec3 } from "../src/shared/math/vec";
import { GAME_MODES } from "../src/shared/modes";
import { groundHeight, spawnBot } from "../src/shared/robot/lifecycle";
import type { Block, Bot } from "../src/shared/sim/entities";
import type { SimEvent } from "../src/shared/sim/events";
import { startMatch } from "../src/shared/sim/match";
import { newInput, takeControl, type PlayerInput } from "../src/shared/sim/player";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnTeams } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";
import { botName } from "../src/client/i18n/names";

/*
 * Armes de contact (combat/melee.ts) : la toupie horizontale et le marteau pneumatique, et les
 * règles communes (montée en régime et chute au coup, réaction, précession, balourd, ricochet,
 * arrachement), sur le sol plat du Dépôt.
 */

/** `MELEE_REPORT=1 npx vitest run tests/melee.test.ts --silent=false` : les mesures de chaque essai. */
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

/** Les coups d'armes de contact qu'on entend. */
function hits(w: Simulation): Extract<SimEvent, { type: "meleeHit" }>[] {
  const out: Extract<SimEvent, { type: "meleeHit" }>[] = [];
  w.on((e) => {
    if (e.type === "meleeHit") out.push(e);
  });
  return out;
}

/** Vitesse angulaire d'un robot dans son propre repère (rad/s : x tangage, y lacet, z roulis). */
const localSpin = (bot: Bot): Vec3 => qrotInv(bot.cockpit.part.rb.rotation(), bot.cockpit.part.rb.angvel());

/** Points de structure de tous les blocs d'un robot. */
const totalHp = (bot: Bot): number => [...bot.blocks.values()].reduce((s, b) => s + b.hp, 0);

/** Petit robot léger armé de la toupie horizontale : un châssis de 3 × 3, sur petites roues. */
function lightSpinner(): RobotDesign {
  const g = new DesignGrid();
  g.box(-1, 1, 0, 0, -2, 0, "frame");
  g.put(0, 0, 1, "spinner");
  g.put(0, 1, -2, "cockpit");
  const small = (x: number, z: number, dx: number): WheelMount => ({ x, y: 0, z, dx, dz: 0, type: "small" });
  return { blocks: g.blocks(), wheels: [small(-1, -2, -1), small(1, -2, 1), small(-1, 0, -1), small(1, 0, 1)] };
}

/** Un mur posé au sol (sans roues), de `type` sur deux étages, face à -z, avec son cockpit derrière. */
function wall(type: keyof typeof BLOCK_TYPES, facing?: Facing): RobotDesign {
  const g = new DesignGrid();
  g.box(-3, 3, 0, 0, 0, 2, "armorHeavy");
  g.box(-3, 3, 1, 2, 0, 0, type, facing);
  g.box(-1, 1, 1, 1, 1, 2, "armorHeavy");
  g.put(0, 1, 2, "cockpit");
  return { blocks: g.blocks(), wheels: [] };
}

describe("armes de contact", () => {
  it("les robots prédéfinis sont valides, et rien n'entre dans le disque de la barre ni dans l'arc du marteau", () => {
    for (const id of ["reaper", "pounder"]) {
      const design = preset(id).design;
      expect(validateDesign(design), id).toEqual([]);
      expect(designConflicts(design), id).toEqual([]);
    }
    // Un bloc posé dans le disque de la barre (au-dessus du nez de la Faucheuse) est refusé, comme devant la tête du marteau
    expect(placementConflicts(preset("reaper").design, { kind: "block", block: { x: 0, y: 1, z: 2, type: "armor" } }).length).toBeGreaterThan(0);
    expect(placementConflicts(preset("pounder").design, { kind: "block", block: { x: 0, y: 1, z: 3, type: "armor" } }).length).toBeGreaterThan(0);
  });

  it("une toupie choisie monte en régime en ~2,4 s en puisant dans les batteries, et ralentit en roue libre une fois une autre arme choisie", () => {
    const w = world();
    const reaper = place(w, preset("reaper"), 0, 0);
    const input = pilot(reaper, "spinner");
    const arm = reaper.melee[0];
    let full = -1;
    let drained = 0;
    for (let i = 0; i < 240; i++) {
      w.step();
      drained = Math.max(drained, reaper.drawn);
      if (full < 0 && meleeCharge(arm) >= 0.98) full = w.time;
    }
    const spin = meleeDef("spinner").spin!;
    expect(full).toBeGreaterThan(spin.spinUp * 0.7);
    expect(full).toBeLessThan(spin.spinUp * 1.3);
    expect(storedEnergy(arm)).toBeCloseTo(spinEnergy(spin, spin.speed), -2);
    // Une autre arme choisie : roue libre, le régime retombe peu à peu (perd les deux tiers en `spinDown` s)
    input.weapon = "rifle";
    run(w, 3);
    expect(meleeCharge(arm)).toBeLessThan(0.9);
    expect(meleeCharge(arm)).toBeGreaterThan(0.6);
  });

  it("chaque coup fait chuter le régime ; il frappe fort, arrache des blocs et projette sa cible", () => {
    const w = world();
    const reaper = place(w, preset("reaper"), 0, -1);
    const input = pilot(reaper, "spinner");
    w.aiPaused = true;
    run(w, 3);
    const target = place(w, preset("trike"), 0, 4, Math.PI / 2, "red");
    const seen = hits(w);
    let lost = 0;
    w.on((e) => {
      if ((e.type === "blockDestroyed" && e.block.bot === target) || (e.type === "wheelRemoved" && e.wheel.bot === target)) lost++;
    });
    const arm = reaper.melee[0];
    const before = storedEnergy(arm);
    input.throttle = 0.5;
    for (let i = 0; i < 180 && !seen.length; i++) w.step();
    expect(seen.length).toBe(1);
    const first = seen[0];
    expect(first.surface).toBe("robot");
    // Le coup prend une part de l'énergie du rotor (`bite`) : le régime chute d'autant
    expect(first.energy).toBeGreaterThan(before * 0.4);
    expect(storedEnergy(arm)).toBeLessThan(before * 0.6);
    // La cible part (plus de 2 m/s), des blocs tombent
    w.step();
    const v = target.cockpit.alive ? target.cockpit.part.rb.linvel() : vec3(9, 9, 9);
    expect(len(v)).toBeGreaterThan(2);
    run(w, 1);
    // Des blocs, des roues arrachés
    expect(lost + target.wheels.filter((wh) => !wh.part).length).toBeGreaterThan(0);
  });

  it("réaction : un petit robot à grosse toupie rebondit sur sa cible lourde, plus fort qu'elle", () => {
    const w = world();
    const light = place(w, profile("toupie légère", lightSpinner()), 0, -2);
    const input = pilot(light, "spinner");
    w.aiPaused = true;
    run(w, 3);
    const truck = place(w, preset("truck"), 0, 4.5, Math.PI / 2, "red");
    const seen = hits(w);
    input.throttle = 0.6;
    let v0 = vec3(0, 0, 0);
    let t0 = vec3(0, 0, 0);
    for (let i = 0; i < 240 && !seen.length; i++) {
      v0 = light.cockpit.part.rb.linvel();
      t0 = truck.cockpit.part.rb.linvel();
      w.step();
    }
    expect(seen.length).toBe(1);
    const own = sub(light.cockpit.part.rb.linvel(), v0);
    const theirs = sub(truck.cockpit.part.rb.linvel(), t0);
    report("REACTION", { own, theirs, energy: seen[0].energy, mass: light.cockpit.part.rb.mass(), truck: truck.cockpit.part.rb.mass() });
    // Il repart à l'opposé de l'impulsion donnée, bien plus vite que le Camion n'est poussé
    const dir = seen[0].dir;
    expect(own.x * dir.x + own.y * dir.y + own.z * dir.z).toBeLessThan(-1.5);
    expect(len(own)).toBeGreaterThan(2 * len(theirs));
  });

  it("précession : lancée, la toupie fait cabrer ou piquer le robot qui roule sur le côté ; arrêtée, rien ; et le lacet ne la trouble pas", () => {
    const measure = (spinning: boolean, spin: Vec3): Vec3 => {
      const w = world();
      const reaper = place(w, preset("reaper"), 0, 0);
      pilot(reaper, spinning ? "spinner" : "rifle");
      run(w, 3);
      // En l'air (sans appui), il tourne sur lui-même à `spin` (son repère)
      const rb = reaper.cockpit.part.rb;
      const t = rb.translation();
      rb.setTranslation({ x: t.x, y: 30, z: t.z }, true);
      rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
      rb.setAngvel(qrot(rb.rotation(), spin), true);
      run(w, 0.3);
      return localSpin(reaper);
    };
    const roll = vec3(0, 0, 1);
    const still = measure(false, roll);
    const spun = measure(true, roll);
    // Moment cinétique de la toupie (vertical) × roulis : un couple de tangage
    report("PRECESSION", still, spun);
    expect(Math.abs(still.x)).toBeLessThan(0.08);
    expect(Math.abs(spun.x)).toBeGreaterThan(0.2);
    // Le lacet, parallèle à son axe, ne fait rien
    const yaw = measure(true, vec3(0, 1.5, 0));
    expect(Math.hypot(yaw.x, yaw.z)).toBeLessThan(0.1);
    // Le couple est bien L × Ω : son moment cinétique est vertical
    const w = world();
    const reaper = place(w, preset("reaper"), 0, 0);
    pilot(reaper, "spinner");
    run(w, 3);
    const L = angularMomentum(reaper.melee[0]);
    const spec = meleeDef("spinner").spin!;
    expect(L.y).toBeCloseTo(spec.inertia * spec.speed, -1);
    expect(len(cross(L, vec3(0, 1, 0)))).toBeLessThan(0.05 * len(L));
  });

  it("balourd : sous la moitié de ses points, la toupie fait vibrer le robot, dégrade sa visée et s'use jusqu'à casser", () => {
    const jitter = (health: number): { vibration: number; shake: number; spread: number; hp: number; alive: boolean } => {
      const w = world();
      const reaper = place(w, preset("reaper"), 0, 0);
      pilot(reaper, "spinner");
      const arm = reaper.melee[0];
      arm.block.hp = BLOCK_TYPES.spinner.hp * health;
      run(w, 4);
      // L'agitation du morceau du cockpit : l'écart de sa vitesse d'un pas à l'autre
      let shake = 0;
      let last = reaper.cockpit.part.rb.linvel();
      for (let i = 0; i < 60; i++) {
        w.step();
        const v = reaper.cockpit.part.rb.linvel();
        shake += len(sub(v, last));
        last = v;
      }
      const result = {
        vibration: vibration(reaper), shake: shake / 60, spread: aimSpread(reaper, weaponDef("rifle"), true), hp: arm.block.hp, alive: arm.block.alive,
      };
      return result;
    };
    const healthy = jitter(0.8);
    const worn = jitter(0.15);
    report("BALOURD", healthy, worn);
    expect(healthy.vibration).toBe(0);
    expect(worn.vibration).toBeGreaterThan(0.5);
    expect(worn.shake).toBeGreaterThan(3 * healthy.shake + 0.01);
    expect(worn.spread).toBeGreaterThan(healthy.spread + 0.01);
    // Il s'use : au bout de 5 s à plein régime, il a perdu des points (la fatigue du balourd)
    expect(worn.hp).toBeLessThan(BLOCK_TYPES.spinner.hp * 0.15);
    expect(healthy.hp).toBe(BLOCK_TYPES.spinner.hp * 0.8);
    // Usée jusqu'au bout, elle casse
    const w = world();
    const reaper = place(w, preset("reaper"), 0, 0);
    pilot(reaper, "spinner");
    reaper.melee[0].block.hp = 10;
    run(w, 12);
    expect(reaper.melee[0].block.alive).toBe(false);
  });

  it("ricochet : un glacis en biseau, pris en biais, fait glisser la barre (moins de dégâts, moins d'énergie prise)", () => {
    const strikeWall = (design: RobotDesign): { glance: boolean; energy: number; damage: number } => {
      const w = world();
      const reaper = place(w, preset("reaper"), 0, -1);
      const input = pilot(reaper, "spinner");
      w.aiPaused = true;
      run(w, 3);
      const target = place(w, profile("mur", design), 0, 2.3, 0, "red");
      const seen = hits(w);
      const before = totalHp(target);
      input.throttle = 0.4;
      for (let i = 0; i < 240 && !seen.length; i++) w.step();
      expect(seen.length).toBeGreaterThan(0);
      return { glance: seen[0].glance, energy: seen[0].energy, damage: before - totalHp(target) };
    };
    // La barre, à l'avant, va vers la gauche du robot (+x) : un biseau dont la pente regarde à droite et en haut la reçoit en biais
    const cubes = strikeWall(wall("armorHeavy"));
    const glacis = strikeWall(wall("wedgeHeavy", { up: "+y", forward: "-x" }));
    expect(cubes.glance).toBe(false);
    expect(glacis.glance).toBe(true);
    expect(glacis.energy).toBeLessThan(0.85 * cubes.energy);
    report("RICOCHET", cubes, glacis);
    expect(glacis.damage).toBeLessThan(0.7 * cubes.damage);
  });

  it("arrachement : un coup franc rompt la liaison d'un bras d'un seul bloc et l'emporte", () => {
    const w = world();
    const reaper = place(w, preset("reaper"), 0, -1);
    const input = pilot(reaper, "spinner");
    w.aiPaused = true;
    run(w, 3);
    // Une cible dont un bras d'un bloc de large dépasse vers la Faucheuse, à hauteur de sa barre
    const g = new DesignGrid();
    g.box(-2, 2, 0, 0, 0, 3, "armorHeavy");
    g.put(0, 1, 2, "cockpit");
    // Un col (0, 1, 0), puis le bras d'un bloc de large, et une tête de trois blocs au bout
    g.box(0, 0, 1, 1, -2, 0, "armor");
    g.box(-1, 1, 1, 1, -3, -3, "armor");
    const target = place(w, profile("bras", { blocks: g.blocks(), wheels: [] }), 0, 4.5, 0, "red");
    let snapped = 0;
    w.on((e) => {
      if (e.type === "linkBroken") snapped++;
    });
    const seen = hits(w);
    input.throttle = 0.4;
    for (let i = 0; i < 300 && (seen.length < 2 || target.parts.size < 2); i++) w.step();
    expect(seen.length).toBeGreaterThan(0);
    // Le bras est parti : un morceau de plus (liaison rompue, ou bloc du col arraché)
    report("ARRACHEMENT", { snapped, parts: target.parts.size, hits: seen.map((h) => h.energy.toFixed(0)), blocs: target.blocks.size });
    expect(target.parts.size + snapped).toBeGreaterThan(1);
  });

  it("marteau : il frappe le dessus de sa cible, fort, et chaque coup soulève l'avant de son robot", () => {
    const w = world();
    const pounder = place(w, preset("pounder"), 0, 0);
    const input = pilot(pounder, "hammer");
    w.aiPaused = true;
    const target = place(w, profile("mur", wall("armor")), 0, 2.2, 0, "red");
    run(w, 1);
    const seen = hits(w);
    const struck: Block[] = [];
    w.on((e) => {
      if (e.type === "blockDamaged" && e.block.bot === target && seen.length && !struck.length) struck.push(e.block);
    });
    const before = totalHp(target);
    let lift = 0;
    const nose = (): number => qrot(pounder.cockpit.part.rb.rotation(), vec3(0, 0, 1)).y;
    const rest = nose();
    for (let i = 0; i < 120; i++) {
      input.trigger = i < 3;
      w.step();
      if (seen.length) lift = Math.max(lift, nose() - rest);
    }
    expect(seen.length).toBe(1);
    expect(seen[0].surface).toBe("robot");
    expect(before - totalHp(target)).toBeGreaterThan(150);
    // Le coup tombe d'en haut : sur un bloc qui n'a rien au-dessus de lui
    const hit = struck[0] ?? [...target.lost.values()][0];
    expect(hit).toBeDefined();
    expect(target.blocks.has(`${hit.x},${hit.y + 1},${hit.z}`)).toBe(false);
    expect(seen[0].dir.y).toBeLessThan(-0.5);
    // L'avant se soulève (plus de 3°)
    report("MARTEAU", { damage: before - totalHp(target), lift: (Math.asin(lift) * 180) / Math.PI, energy: seen[0].energy, hit: `${hit.type} ${hit.x},${hit.y},${hit.z}` });
    expect(lift).toBeGreaterThan(Math.sin((3 * Math.PI) / 180));
    // Il revient à l'armement, puis peut frapper de nouveau (le vérin a puisé dans les batteries)
    expect(pounder.melee[0].phase).toBe("ready");
  });

  /*
   * Bilan des armes de contact (`MELEE_BATTLE=1 npx vitest run tests/melee.test.ts --silent=false`) :
   * des batailles où chaque équipe a sa Faucheuse et son Pilon, le reste tiré au sort ; par robot,
   * destructions, morts, temps renversé, coups portés et leur énergie ; et le coût de l'étape
   * « contact » du pas, avec ces quatre robots parmi douze.
   */
  it.runIf(!!env.MELEE_BATTLE)("bilan des armes de contact en bataille", { timeout: 1_800_000 }, () => {
    const lines: string[] = [];
    const stats = new Map<string, { kills: number; deaths: number; flipped: number; hits: number; energy: number; killedBy: Map<string, number> }>();
    const of = (bot: Bot) => {
      const key = botName(bot.profile);
      let s = stats.get(key);
      if (!s) stats.set(key, (s = { kills: 0, deaths: 0, flipped: 0, hits: 0, energy: 0, killedBy: new Map() }));
      return s;
    };
    let contact = 0;
    let total = 0;
    let steps = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      seedRandom(seed);
      const w = new Simulation();
      sim = w;
      const others = PRESET_BOTS.filter((p) => !["reaper", "pounder"].includes(p.id)).sort(() => Math.random() - 0.5).slice(0, 8);
      spawnTeams(w, [
        { profile: preset("reaper"), team: "blue" }, { profile: preset("pounder"), team: "blue" },
        { profile: preset("reaper"), team: "red" }, { profile: preset("pounder"), team: "red" },
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
        if (e.type === "meleeHit" && e.surface === "robot") {
          const s = of(e.block.bot);
          s.hits++;
          s.energy += e.energy;
        }
      });
      w.profile = { now: () => performance.now(), times: {} };
      for (let i = 0; i < 180 * 60 && !match.winner; i++) {
        w.step();
        steps++;
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
        + (s.hits ? ` · ${s.hits} coups (${(s.energy / s.hits / 1000).toFixed(2)} kJ en moyenne)` : "")
        + ` · tué par ${[...s.killedBy].map(([c, n]) => `${c} ${n}`).join(", ")}`);
    }
    console.log(lines.join("\n"));
  });

  it("une bataille avec la Faucheuse et le Pilon de chaque côté se joue sans erreur, et ils frappent", { timeout: 120_000 }, () => {
    seedRandom(5);
    const w = new Simulation();
    sim = w;
    const roster = ["reaper", "pounder", "trike", "scarab", "ram", "buggy"];
    spawnTeams(w, roster.flatMap((id, i) => [
      { profile: preset(id), team: "blue" as const },
      { profile: preset(roster[(i + 3) % roster.length]), team: "red" as const },
    ]));
    startMatch(w, { ...GAME_MODES.battle.match, timeLimit: 60 });
    const seen = hits(w);
    let kills = 0;
    w.on((e) => {
      if (e.type === "botKilled") kills++;
    });
    run(w, 60);
    expect(seen.filter((h) => h.surface === "robot").length).toBeGreaterThan(2);
    expect(kills).toBeGreaterThan(0);
  });
});
