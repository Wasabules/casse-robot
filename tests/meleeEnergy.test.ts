import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Room } from "../src/server/room";
import { ARENAS, type ArenaLayout } from "../src/shared/arena/layout";
import { BLOCK_TYPES } from "../src/shared/catalog/blocks";
import { holdPower, meleeDef, motorPower } from "../src/shared/catalog/melee";
import { localStuns, organStunned, wheelStunned } from "../src/shared/combat/emp";
import { meleeCharge, meleeFrame, storedEnergy } from "../src/shared/combat/melee";
import { designCost, ROBOT_BUDGET } from "../src/shared/design/budget";
import { designConflicts } from "../src/shared/design/clearance";
import { PRESET_BOTS, type BotProfile } from "../src/shared/design/presets";
import { DesignGrid, validateDesign, type RobotDesign, type WheelMount } from "../src/shared/design/robotDesign";
import { distance, len, qrot, qrotInv, sub, vec3, type Vec3 } from "../src/shared/math/vec";
import { GAME_MODES } from "../src/shared/modes";
import { PROTOCOL_VERSION, SNAPSHOT_EVERY } from "../src/shared/net/protocol";
import { Replica } from "../src/shared/net/replica";
import { blockWorldPos } from "../src/shared/robot/queries";
import { groundHeight, spawnBot } from "../src/shared/robot/lifecycle";
import type { Bot } from "../src/shared/sim/entities";
import type { SimEvent } from "../src/shared/sim/events";
import { startMatch } from "../src/shared/sim/match";
import { newInput, takeControl, type PlayerInput } from "../src/shared/sim/player";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnTeams } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";
import { botName } from "../src/client/i18n/names";
import { blockName } from "../src/client/i18n/names";

/*
 * Armes de contact d'énergie (catalog/melee.ts) : la lame laser, le fouet plasma, la lance électrique
 * et le champ broyeur, et ce qu'elles ajoutent au socle (pas de masse : ni recul, ni gyroscope, ni
 * balourd ; extinction sous l'IEM et dans l'eau ; allumage ; paralysie locale ; champ autour de la
 * coque), sur le sol plat du Dépôt.
 */

/** `ENERGY_REPORT=1 npx vitest run tests/meleeEnergy.test.ts --silent=false` : les mesures de chaque essai. */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const report = (label: string, ...values: unknown[]): void => {
  if (env.ENERGY_REPORT) console.log(label, ...values);
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

/** Le Dépôt sans ses accessoires (rien entre les robots) ; `water` : de l'eau partout, à cette hauteur. */
function world(water?: number): Simulation {
  sim?.dispose();
  seedRandom(3);
  const w = new Simulation();
  w.arena = { ...ARENAS.depot, props: [], ...(water !== undefined ? { water } : {}) } as ArenaLayout;
  sim = w;
  return w;
}

/** Un robot posé au sol en (x, z), tourné de `yaw`, ajouté à la simulation. */
function place(w: Simulation, p: BotProfile, x: number, z: number, yaw = 0, team: "red" | "blue" = "blue"): Bot {
  const bot = spawnBot(w, p, vec3(x, groundHeight(p.design) + 0.03, z), yaw, team);
  w.bots.push(bot);
  return bot;
}

/** Le robot passe aux commandes `input`. */
function pilot(bot: Bot, weapon: PlayerInput["weapon"]): PlayerInput {
  const input = { ...newInput(), weapon };
  takeControl(bot, input);
  return input;
}

const run = (w: Simulation, seconds: number): void => {
  for (let i = 0; i < Math.round(seconds * 60); i++) w.step();
};

/** Ce qu'on entend d'un type d'événement. */
function heard<T extends SimEvent["type"]>(w: Simulation, type: T): Extract<SimEvent, { type: T }>[] {
  const out: Extract<SimEvent, { type: T }>[] = [];
  w.on((e) => {
    if (e.type === type) out.push(e as Extract<SimEvent, { type: T }>);
  });
  return out;
}

const totalHp = (bot: Bot): number => [...bot.blocks.values()].reduce((s, b) => s + b.hp, 0);

/** Vitesse angulaire d'un robot dans son propre repère (rad/s : x tangage, y lacet, z roulis). */
const localSpin = (bot: Bot): Vec3 => qrotInv(bot.cockpit.part.rb.rotation(), bot.cockpit.part.rb.angvel());

/** Un mur posé au sol (sans roues) : blindage sur deux étages, son cockpit derrière ; sa face avant regarde -z. */
function wall(): RobotDesign {
  const g = new DesignGrid();
  g.box(-3, 3, 0, 0, 0, 2, "armorHeavy");
  g.box(-3, 3, 1, 2, 0, 0, "armor");
  g.box(-1, 1, 1, 1, 1, 2, "armorHeavy");
  g.put(0, 1, 2, "cockpit");
  return { blocks: g.blocks(), wheels: [] };
}

/**
 * Une voiture à quatre roues et deux tourelles mitrailleuses, l'une à gauche, l'autre à droite (les
 * deux sur le dessus, au bord) : de quoi voir une paralysie locale d'un côté.
 */
function car(): RobotDesign {
  const g = new DesignGrid();
  g.box(-2, 2, 0, 0, -2, 2, "frame");
  g.put(0, 1, 0, "cockpit");
  g.put(2, 1, 0, "gunTurret").put(-2, 1, 0, "gunTurret");
  const wheel = (x: number, z: number, dx: number): WheelMount => ({ x, y: 0, z, dx, dz: 0, type: "standard" });
  return { blocks: g.blocks(), wheels: [wheel(2, -2, 1), wheel(2, 2, 1), wheel(-2, -2, -1), wheel(-2, 2, -1)] };
}

describe("armes de contact d'énergie", () => {
  it("les robots prédéfinis sont valides, dans le budget, et rien n'entre dans l'arc de la lame, du fouet ou la course de la lance", () => {
    for (const id of ["duelist", "urchin"]) {
      const design = preset(id).design;
      expect(validateDesign(design), id).toEqual([]);
      expect(designConflicts(design), id).toEqual([]);
      expect(designCost(design), id).toBeLessThanOrEqual(ROBOT_BUDGET);
      report("COÛT", id, designCost(design));
    }
    // Ce que coûtent les armes d'énergie aux batteries (le générateur donne 1,2 kW)
    const blade = meleeDef("laserBlade").spin!;
    report("LAME", { allumée: holdPower(blade), moteur: motorPower(blade) });
    expect(holdPower(blade)).toBeGreaterThan(1.2);
    expect(holdPower(meleeDef("crusherField").spin!)).toBeLessThan(0.6);
  });

  it("lame laser : allumée en une demi-seconde sur les batteries, elle découpe vite à petits coups, sans recul ni réaction", () => {
    const w = world();
    const duelist = place(w, preset("duelist"), 0, -1);
    const input = pilot(duelist, "laserBlade");
    const arm = duelist.melee.find((a) => a.weapon === "laserBlade")!;
    let lit = -1;
    for (let i = 0; i < 90; i++) {
      w.step();
      if (lit < 0 && meleeCharge(arm) >= 0.98) lit = w.time;
    }
    expect(lit).toBeGreaterThan(0.3);
    expect(lit).toBeLessThan(0.75);
    // Allumée, elle vide les batteries (plus que n'en donne le générateur)
    const charged = duelist.energy;
    run(w, 2);
    expect(duelist.energy).toBeLessThan(charged - 0.3);
    // Un mur devant la lame, à sa hauteur : elle le découpe, coup sur coup
    const target = place(w, profile("mur", wall()), 0, 1.65, 0, "red");
    const hits = heard(w, "meleeHit");
    const before = totalHp(target);
    const energyBefore = duelist.energy;
    let worst = 0;
    let turn = 0;
    for (let i = 0; i < 120; i++) {
      w.step();
      worst = Math.max(worst, len(duelist.cockpit.part.rb.linvel()));
      turn = Math.max(turn, len(duelist.cockpit.part.rb.angvel()));
    }
    const dealt = before - totalHp(target);
    report("LAME LASER", { coups: hits.length, dégâts: dealt, énergie: hits[0]?.energy, batteries: energyBefore - duelist.energy, vitesse: worst, rotation: turn });
    expect(hits.length).toBeGreaterThan(10);
    expect(hits.every((h) => h.surface === "robot" || h.surface === "scenery")).toBe(true);
    expect(dealt).toBeGreaterThan(250);
    // Ni recul ni réaction : le Duelliste ne bouge pas (une toupie l'aurait fait rebondir)
    expect(worst).toBeLessThan(0.15);
    expect(turn).toBeLessThan(0.15);
    expect(input.weapon).toBe("laserBlade");
  });

  it("lame laser : allumée, elle ne fait ni gyroscope ni réaction de son moteur", () => {
    const measure = (weapon: PlayerInput["weapon"], spin: Vec3): Vec3 => {
      const w = world();
      const duelist = place(w, preset("duelist"), 0, 0);
      pilot(duelist, weapon);
      run(w, 1.5);
      const rb = duelist.cockpit.part.rb;
      const t = rb.translation();
      rb.setTranslation({ x: t.x, y: 30, z: t.z }, true);
      rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
      rb.setAngvel(qrot(rb.rotation(), spin), true);
      run(w, 0.3);
      return localSpin(duelist);
    };
    const roll = vec3(0, 0, 1);
    const off = measure("shockLance", roll);
    const on = measure("laserBlade", roll);
    report("PRÉCESSION", { éteinte: off, allumée: on });
    // Une toupie lancée change un roulis en tangage (0,27 rad/s) ; la lame, comme éteinte
    expect(Math.abs(on.x - off.x)).toBeLessThan(0.03);
    // Elle s'allume sans faire pivoter le robot (une toupie, en montant en régime, le fait tourner)
    const w = world();
    const duelist = place(w, preset("duelist"), 0, 0);
    pilot(duelist, "shockLance");
    run(w, 0.5);
    pilot(duelist, "laserBlade");
    let yaw = 0;
    for (let i = 0; i < 40; i++) {
      w.step();
      yaw = Math.max(yaw, Math.abs(localSpin(duelist).y));
    }
    expect(yaw).toBeLessThan(0.02);
  });

  it("lame laser : elle s'éteint d'un coup sous une IEM ou une décharge, et dans l'eau", () => {
    const w = world();
    const duelist = place(w, preset("duelist"), 0, 0);
    pilot(duelist, "laserBlade");
    const arm = duelist.melee.find((a) => a.weapon === "laserBlade")!;
    run(w, 1);
    expect(meleeCharge(arm)).toBeGreaterThan(0.95);
    // Une IEM : éteinte au pas suivant (une toupie, elle, garde son élan)
    duelist.stunnedUntil = w.time + 0.5;
    w.step();
    expect(storedEnergy(arm)).toBe(0);
    run(w, 0.4);
    expect(storedEnergy(arm)).toBe(0);
    // La paralysie passée, elle se rallume
    run(w, 1);
    expect(meleeCharge(arm)).toBeGreaterThan(0.95);
    // Une décharge sur son seul bloc : éteinte aussi
    arm.block.stunnedUntil = w.time + 0.5;
    w.step();
    expect(storedEnergy(arm)).toBe(0);

    // Dans l'eau (ici, partout à 3 m) : elle ne s'allume pas, et ne coupe rien
    const wet = world(3);
    const diver = place(wet, preset("duelist"), 0, -1);
    pilot(diver, "laserBlade");
    const blade = diver.melee.find((a) => a.weapon === "laserBlade")!;
    const target = place(wet, profile("mur", wall()), 0, 1.65, 0, "red");
    const hits = heard(wet, "meleeHit");
    const before = totalHp(target);
    run(wet, 1.5);
    expect(storedEnergy(blade)).toBe(0);
    expect(hits.length).toBe(0);
    expect(totalHp(target)).toBe(before);
  });

  it("fouet plasma : il claque devant le robot, brûle ce qu'il touche et l'allume", () => {
    const w = world();
    const urchin = place(w, preset("urchin"), 0, -1);
    const input = pilot(urchin, "plasmaWhip");
    const target = place(w, profile("mur", wall()), 0, 2.05, 0, "red");
    const hits = heard(w, "meleeHit");
    const fires = heard(w, "fireStarted");
    run(w, 0.5);
    const before = totalHp(target);
    let worst = 0;
    for (let i = 0; i < 150; i++) {
      input.trigger = true;
      w.step();
      worst = Math.max(worst, len(urchin.cockpit.part.rb.linvel()));
    }
    const lit = fires.filter((e) => e.block.bot === target).length;
    report("FOUET", { coups: hits.length, dégâts: before - totalHp(target), feux: lit, vitesse: worst });
    expect(hits.filter((h) => h.surface === "robot").length).toBeGreaterThanOrEqual(2);
    expect(before - totalHp(target)).toBeGreaterThan(200);
    expect(lit).toBeGreaterThan(0);
    // Il ne pousse ni ne recule
    expect(worst).toBeLessThan(0.15);
  });

  it("lance électrique : elle paralyse les roues d'un côté et la tourelle touchée, le reste marche ; puis tout repart", () => {
    const w = world();
    const duelist = place(w, preset("duelist"), 0, -1);
    const lance = pilot(duelist, "shockLance");
    // La voiture, son flanc gauche face à la lance (tournée d'un quart de tour)
    const target = place(w, profile("voiture", car()), 0, 3.45, Math.PI / 2, "red");
    const drive = pilot(target, "rifle");
    const stuns = heard(w, "organsStunned");
    const shots = heard(w, "shot");
    run(w, 0.3);
    for (let i = 0; i < 30 && !stuns.length; i++) {
      lance.trigger = i < 3;
      w.step();
    }
    lance.trigger = false;
    expect(stuns.length).toBe(1);
    const left = target.wheels.filter((wh) => wh.side > 0);
    const right = target.wheels.filter((wh) => wh.side < 0);
    const [leftGun, rightGun] = [2, -2].map((x) => target.turrets.find((t) => t.block.x === x)!);
    expect(left.every((wh) => wheelStunned(w, wh))).toBe(true);
    expect(right.some((wh) => wheelStunned(w, wh))).toBe(false);
    expect(organStunned(w, leftGun.block)).toBe(true);
    expect(organStunned(w, rightGun.block)).toBe(false);
    report("LANCE", { coupés: localStuns(w, target).blocks.length, roues: localStuns(w, target).wheels.length, jusqu: stuns[0].until - w.time });
    // Elle roule et tire : les roues de gauche en roue libre, celles de droite tirent ; seule la tourelle de droite tire
    drive.throttle = 1;
    drive.trigger = true;
    drive.aim = vec3(20, 1.2, 3.45);
    shots.length = 0;
    run(w, 1);
    expect(left.every((wh) => !wh.powered && wh.drive === 0)).toBe(true);
    expect(right.every((wh) => wh.powered && wh.drive > 0.05)).toBe(true);
    const muzzleOf = (t: typeof leftGun): Vec3 => blockWorldPos(t.block);
    const near = (s: (typeof shots)[number], t: typeof leftGun): number => distance(s.origin, muzzleOf(t));
    expect(shots.length).toBeGreaterThan(2);
    expect(shots.every((s) => near(s, rightGun) < near(s, leftGun))).toBe(true);
    // La paralysie passée (2,5 s), tout repart : les deux tourelles tirent, les roues de gauche tirent aussi
    run(w, 2);
    shots.length = 0;
    run(w, 1.5);
    expect(left.every((wh) => wh.powered)).toBe(true);
    expect(shots.some((s) => near(s, leftGun) < near(s, rightGun))).toBe(true);
    expect(localStuns(w, target).blocks.length).toBe(0);
  });

  it("champ broyeur : il frappe ce qui touche la coque, et une toupie ennemie qui s'y frotte est repoussée, son régime chute", () => {
    // La Faucheuse, lancée loin de lui, fonce sur l'Oursin ; témoin : un Oursin dont le champ est coupé
    const charge = (field: boolean): { charge: number; away: number; hp: number; touched: number } => {
      const w = world();
      const urchin = place(w, preset("urchin"), 0, 0, 0, "red");
      pilot(urchin, "plasmaWhip");
      if (!field) urchin.melee.find((a) => a.weapon === "crusherField")!.block.stunnedUntil = 1e9;
      const reaper = place(w, preset("reaper"), 0, 9, Math.PI, "blue");
      const input = pilot(reaper, "spinner");
      const arm = reaper.melee[0];
      run(w, 3);
      const own = heard(w, "meleeHit");
      input.throttle = 0.5;
      // Jusqu'à son premier coup sur l'Oursin : son régime le plus bas, et la vitesse la plus forte qui l'en écarte
      let lowest = 1;
      let away = 0;
      let touched = -1;
      for (let i = 0; i < 240; i++) {
        w.step();
        if (own.some((h) => h.block === arm.block && h.surface === "robot")) {
          touched = w.time;
          break;
        }
        lowest = Math.min(lowest, meleeCharge(arm));
        const out = sub(reaper.cockpit.part.rb.translation(), urchin.cockpit.part.rb.translation());
        const v = reaper.cockpit.part.rb.linvel();
        away = Math.max(away, (v.x * out.x + v.z * out.z) / Math.max(1e-6, Math.hypot(out.x, out.z)));
      }
      return { charge: lowest, away, hp: arm.block.hp, touched };
    };
    const without = charge(false);
    const withField = charge(true);
    report("CHAMP", { sans: without, avec: withField });
    // Sans champ, elle arrive à plein régime ; avec, son régime chute avant même qu'elle ne touche, elle est repoussée et abîmée
    expect(without.charge).toBeGreaterThan(0.9);
    expect(withField.charge).toBeLessThan(0.7);
    expect(withField.away).toBeGreaterThan(without.away + 0.4);
    expect(withField.hp).toBeLessThan(BLOCK_TYPES.spinner.hp);

    // Un mur ennemi collé à la coque (à 15 cm) : le champ s'arme, ses blocs perdent des points, il est repoussé
    const w = world();
    const urchin = place(w, preset("urchin"), 0, 0, 0, "red");
    pilot(urchin, "plasmaWhip");
    const field = urchin.melee.find((a) => a.weapon === "crusherField")!;
    const target = place(w, profile("mur", wall()), 0, 2.15, 0, "blue");
    const hits = heard(w, "meleeHit");
    const before = totalHp(target);
    const start = target.cockpit.part.rb.translation();
    run(w, 2);
    const fieldHits = hits.filter((h) => h.block === field.block);
    const pushed = distance(target.cockpit.part.rb.translation(), start);
    report("CHAMP COQUE", { coups: fieldHits.length, dégâts: before - totalHp(target), repoussé: pushed, charge: meleeCharge(field) });
    expect(fieldHits.length).toBeGreaterThan(0);
    expect(fieldHits.every((h) => h.surface === "robot")).toBe(true);
    expect(before - totalHp(target)).toBeGreaterThan(15);
    expect(pushed).toBeGreaterThan(0.2);
  });

  it("réseau : la réplique voit la lame allumée, et la paralysie locale de la lance", () => {
    seedRandom(21);
    const room = new Room();
    try {
      const replica = new Replica();
      const events: SimEvent[] = [];
      replica.on((e) => events.push(e));
      const player = room.connect({ send: (data) => { if (typeof data !== "string") replica.receive(data); } });
      room.receive(player, JSON.stringify({ t: "join", version: PROTOCOL_VERSION, name: "Léa", robot: { preset: "duelist" }, token: "jeton-energie-0000000" }));
      const tick = (seconds: number): void => {
        for (let i = 0; i < Math.ceil((seconds * 60) / SNAPSHOT_EVERY) * SNAPSHOT_EVERY; i++) room.tick();
      };
      tick(1);
      room.sim.aiPaused = true;
      room.receive(player, JSON.stringify({ t: "input", input: { ...newInput(), weapon: "laserBlade" } }));
      tick(1.5);
      replica.flush();
      const bot = player.bot!;
      const copy = replica.player!;
      const blade = copy.melee.find((a) => a.weapon === "laserBlade")!;
      expect(blade.spin).toBeGreaterThan(0.9 * meleeDef("laserBlade").spin!.speed);
      // Un ennemi (au sol, d'un seul morceau, avec des roues) posé devant la lance ; pas le premier robot
      // de l'IA de son équipe : c'est lui que remplacera le joueur qui arrive ensuite (`replaceAi`)
      const replaced = room.sim.bots.find((b) => b.team !== bot.team && b.controller === "ai");
      const enemy = room.sim.bots.find((b) => b !== replaced && b.team !== bot.team && b.cockpit.alive && b.profile.mobility === "ground" && b.parts.size === 1 && b.wheels.length >= 4)!;
      const lance = bot.melee.find((a) => a.weapon === "shockLance")!;
      const f = meleeFrame(lance);
      const ahead = qrot(bot.cockpit.part.rb.rotation(), vec3(0, 0, 1));
      const rb = [...enemy.parts][0].rb;
      rb.setTranslation({ x: f.hub.x + ahead.x * 2, y: rb.translation().y, z: f.hub.z + ahead.z * 2 }, true);
      rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
      for (let i = 0; i < 20 && !localStuns(room.sim, enemy).blocks.length && !localStuns(room.sim, enemy).wheels.length; i++) {
        room.receive(player, JSON.stringify({ t: "input", input: { ...newInput(), weapon: "shockLance", trigger: true, throttle: 0.4 } }));
        tick(0.15);
      }
      room.receive(player, JSON.stringify({ t: "input", input: { ...newInput(), weapon: "shockLance" } }));
      tick(0.2);
      replica.flush();
      const server = localStuns(room.sim, enemy);
      expect(server.blocks.length + server.wheels.length).toBeGreaterThan(0);
      const twin = replica.bots.find((b) => b.id === enemy.id)!;
      const seen = localStuns(replica, twin);
      expect(seen.blocks.map((b) => b.id).sort()).toEqual(server.blocks.map((b) => b.id).sort());
      expect(seen.wheels.map((b) => b.id).sort()).toEqual(server.wheels.map((b) => b.id).sort());
      expect(events.some((e) => e.type === "organsStunned" && e.bot === twin)).toBe(true);
      // Un joueur qui arrive pendant la paralysie la reçoit aussi
      const late = new Replica();
      const second = room.connect({ send: (data) => { if (typeof data !== "string") late.receive(data); } });
      room.receive(second, JSON.stringify({ t: "join", version: PROTOCOL_VERSION, name: "Tom", robot: { preset: "buggy" }, token: "jeton-energie-0000001" }));
      tick(0.2);
      late.flush();
      const lateTwin = late.bots.find((b) => b.id === enemy.id);
      if (localStuns(room.sim, enemy).blocks.length) expect(localStuns(late, lateTwin!).blocks.length).toBeGreaterThan(0);
    } finally {
      room.dispose();
    }
  });

  /*
   * Bilan des armes d'énergie (`ENERGY_BATTLE=1 npx vitest run tests/meleeEnergy.test.ts --silent=false`) :
   * des batailles où chaque équipe a son Duelliste et son Oursin, le reste tiré au sort ; par robot,
   * destructions, morts, temps renversé, coups portés, paralysies infligées ; et le coût de l'étape
   * « contact » du pas.
   */
  it.runIf(!!env.ENERGY_BATTLE)("bilan des armes d'énergie en bataille", { timeout: 3_600_000 }, () => {
    const lines: string[] = [];
    const stats = new Map<string, { kills: number; deaths: number; flipped: number; hits: number; stuns: number; killedBy: Map<string, number> }>();
    const of = (bot: Bot) => {
      let s = stats.get(botName(bot.profile));
      if (!s) stats.set(botName(bot.profile), (s = { kills: 0, deaths: 0, flipped: 0, hits: 0, stuns: 0, killedBy: new Map() }));
      return s;
    };
    const weapons = new Map<string, { hits: number; energy: number }>();
    let contact = 0;
    let total = 0;
    let steps = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      seedRandom(seed);
      const w = new Simulation();
      sim = w;
      const others = PRESET_BOTS.filter((p) => !["duelist", "urchin"].includes(p.id)).sort(() => Math.random() - 0.5).slice(0, 8);
      spawnTeams(w, [
        { profile: preset("duelist"), team: "blue" }, { profile: preset("urchin"), team: "blue" },
        { profile: preset("duelist"), team: "red" }, { profile: preset("urchin"), team: "red" },
        ...others.map((p, i) => ({ profile: p, team: i % 2 ? "red" as const : "blue" as const })),
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
          of(e.block.bot).hits++;
          const weapon = blockName(e.block.type);
          const s = weapons.get(weapon) ?? { hits: 0, energy: 0 };
          s.hits++;
          s.energy += e.energy;
          weapons.set(weapon, s);
        }
        if (e.type === "organsStunned") of(e.bot).stuns++;
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
      console.log(lines[lines.length - 1]);
      w.dispose();
      sim = null;
    }
    lines.push(`Pas moyen ${(total / steps).toFixed(2)} ms, dont l'étape « contact » ${(contact / steps).toFixed(3)} ms`);
    for (const [name, s] of weapons) lines.push(`${name.padEnd(18)} ${s.hits} coups sur des robots (${(s.energy / s.hits / 1000).toFixed(2)} kJ en moyenne)`);
    for (const [name, s] of [...stats].sort((a, b) => b[1].kills - b[1].deaths - (a[1].kills - a[1].deaths))) {
      lines.push(`${name.padEnd(14)} destructions ${String(s.kills).padStart(3)} · morts ${String(s.deaths).padStart(3)} · renversé ${s.flipped.toFixed(0).padStart(3)} s`
        + (s.hits ? ` · ${s.hits} coups` : "") + (s.stuns ? ` · paralysé localement ${s.stuns} fois` : "")
        + ` · tué par ${[...s.killedBy].map(([c, n]) => `${c} ${n}`).join(", ")}`);
    }
    console.log(lines.join("\n"));
  });

  it("une bataille avec le Duelliste et l'Oursin de chaque côté se joue sans erreur, et ils frappent", { timeout: 120_000 }, () => {
    seedRandom(7);
    const w = new Simulation();
    sim = w;
    const roster = ["duelist", "urchin", "trike", "scarab", "ram", "buggy"];
    spawnTeams(w, roster.flatMap((id, i) => [
      { profile: preset(id), team: "blue" as const },
      { profile: preset(roster[(i + 2) % roster.length]), team: "red" as const },
    ]));
    startMatch(w, { ...GAME_MODES.battle.match, timeLimit: 60 });
    const hits = heard(w, "meleeHit");
    let kills = 0;
    w.on((e) => {
      if (e.type === "botKilled") kills++;
    });
    run(w, 60);
    const energyHits = hits.filter((h) => h.surface === "robot" && ["laserBlade", "plasmaWhip", "shockLance", "crusherField"].includes(h.block.type));
    report("BATAILLE", { coups: energyHits.length, destructions: kills });
    expect(energyHits.length).toBeGreaterThan(2);
    expect(kills).toBeGreaterThan(0);
  });
});
