import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ProgressBook } from "../src/server/progressBook";
import { Room } from "../src/server/room";
import { ARENAS } from "../src/shared/arena/layout";
import { blockDef } from "../src/shared/catalog/blocks";
import { meleeDef, spinEnergy, type MeleeId } from "../src/shared/catalog/melee";
import { angularMomentum, liveMelee, meleeCharge, meleeFrame, storedEnergy } from "../src/shared/combat/melee";
import { designCost, ROBOT_BUDGET } from "../src/shared/design/budget";
import { BLADES, designConflicts, placementConflicts } from "../src/shared/design/clearance";
import { PRESET_BOTS, type BotProfile } from "../src/shared/design/presets";
import { DesignGrid, validateDesign, type RobotDesign, type WheelMount } from "../src/shared/design/robotDesign";
import { add, len, qrot, scale, vec3, type Vec3 } from "../src/shared/math/vec";
import { GAME_MODES } from "../src/shared/modes";
import { PROTOCOL_VERSION, SNAPSHOT_EVERY, type ServerMessage } from "../src/shared/net/protocol";
import { Replica } from "../src/shared/net/replica";
import { hitTargetOf } from "../src/shared/robot/colliders";
import { groundHeight, spawnBot } from "../src/shared/robot/lifecycle";
import { liveThrusters } from "../src/shared/robot/queries";
import type { Bot, MeleeArm, MeleeHitbox } from "../src/shared/sim/entities";
import type { SimEvent } from "../src/shared/sim/events";
import { startMatch } from "../src/shared/sim/match";
import { newInput, takeControl, type PlayerInput } from "../src/shared/sim/player";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnTeams } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";
import { botName } from "../src/client/i18n/names";

/*
 * Les toupies et l'hélice tranchante (combat/melee.ts) : la toupie verticale (elle soulève et
 * retourne sa cible ; trop bas, elle renvoie son propre robot en salto ; en virage, son gyroscope le
 * penche), le tambour (peu de précession, il fait sautiller et arrache les roues), l'anneau-coque
 * (il frappe de tous côtés, jamais son robot, qu'il fait déraper), l'hélice tranchante (elle blesse
 * ce qu'elle frôle et s'y brise), les zones touchables des lames et des bras, et le réseau.
 */

/** `MELEE_REPORT=1 npx vitest run tests/spinners.test.ts --silent=false` : les mesures de chaque essai. */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const report = (label: string, ...values: unknown[]): void => {
  const round = (_: string, v: unknown): unknown => (typeof v === "number" ? Math.round(v * 1000) / 1000 : v);
  if (env.MELEE_REPORT) console.log(label, ...values.map((v) => (typeof v === "object" ? JSON.stringify(v, round) : v)));
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

/** Le robot passe aux commandes `input` (l'IA des autres est figée, ou pas). */
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

/** Haut, avant et gauche d'un robot dans le monde. */
const upOf = (bot: Bot): Vec3 => qrot(bot.cockpit.part.rb.rotation(), vec3(0, 1, 0));
const noseOf = (bot: Bot): Vec3 => qrot(bot.cockpit.part.rb.rotation(), vec3(0, 0, 1));
const leftOf = (bot: Bot): Vec3 => qrot(bot.cockpit.part.rb.rotation(), vec3(1, 0, 0));
const deg = (rad: number): number => (rad * 180) / Math.PI;

const totalHp = (bot: Bot): number => [...bot.blocks.values()].reduce((s, b) => s + b.hp, 0);
const armOf = (bot: Bot, weapon: MeleeId): MeleeArm => bot.melee.find((a) => a.weapon === weapon)!;
const hitboxOf = (arm: MeleeArm): MeleeHitbox => arm.block.part.blades.find((h) => h.arm === arm)!;

/** Un mur posé au sol (sans roues), de blindage lourd, avec son cockpit derrière (son avant vers +z). */
function wall(): RobotDesign {
  const g = new DesignGrid();
  g.box(-2, 2, 0, 2, 0, 0, "armorHeavy");
  g.box(-1, 1, 0, 1, 1, 1, "armorHeavy");
  g.put(0, 0, 2, "cockpit");
  return { blocks: g.blocks(), wheels: [] };
}

/** Une tour de blindage sur quatre roues fixes, la toupie verticale devant : haute, elle pivote sur place. */
function tallTumbler(): RobotDesign {
  const g = new DesignGrid();
  g.box(-1, 1, 0, 0, -3, 1, "frame");
  g.put(0, 0, 2, "verticalSpinner");
  g.box(-1, 1, 1, 4, -2, -1, "armor");
  g.put(0, 5, -2, "cockpit");
  g.put(0, 5, -1, "battery");
  const mount = (x: number, z: number, dx: number): WheelMount => ({ x, y: 0, z, dx, dz: 0, type: "standard" });
  return { blocks: g.blocks(), wheels: [mount(-1, 1, -1), mount(1, 1, 1), mount(-1, -2, -1), mount(1, -2, 1)] };
}

describe("toupies et hélice tranchante", () => {
  it("les robots de la famille sont valides, dans le budget, et rien n'entre dans ce que balaient leurs armes", () => {
    for (const id of ["tumbler", "drummer", "whirlwind"]) {
      const design = preset(id).design;
      expect(validateDesign(design), id).toEqual([]);
      expect(designConflicts(design), id).toEqual([]);
      expect(designCost(design), id).toBeLessThanOrEqual(ROBOT_BUDGET);
    }
    // (deux familles ajoutées en même temps avaient chacune leur « Batteur » : un nom par robot)
    expect(new Set(PRESET_BOTS.map((p) => botName(p))).size).toBe(PRESET_BOTS.length);
    const blocked =(id: string, x: number, y: number, z: number): boolean =>
      placementConflicts(preset(id).design, { kind: "block", block: { x, y, z, type: "armor" } }).length > 0;
    // Le disque, devant les fourches ; le tambour, sur toute sa largeur
    expect(blocked("tumbler", 0, 0, 3)).toBe(true);
    expect(blocked("tumbler", 0, 1, 4)).toBe(true);
    expect(blocked("drummer", 1, 0, 3)).toBe(true);
    expect(blocked("drummer", -1, 0, 3)).toBe(true);
    // L'anneau : rien dans sa bande (à 1,5 m du moyeu) ni sous ses rayons (au-dessus du robot) ; le
    // robot, lui, tient dans son creux
    expect(blocked("whirlwind", 3, 0, 0)).toBe(true);
    expect(blocked("whirlwind", 0, 2, 1)).toBe(true);
    expect(blocked("whirlwind", 2, 1, 0)).toBe(false);
    // L'hélice tranchante frappe avec les pales du moteur : mêmes cotes que leur encombrement
    const propeller = meleeDef("propeller");
    expect(propeller.blade!.outer * 2).toBeCloseTo(BLADES.propeller.diameter, 6);
    expect(propeller.blade!.half * 2).toBeCloseTo(BLADES.propeller.thickness, 6);
    expect(propeller.hub[1]).toBeCloseTo(0.25 + BLADES.propeller.offset, 6);
    expect(blockDef("propeller").melee).toBe("propeller");
  });

  it("toupie verticale : elle monte en régime, soulève sa cible et la retourne ; le gyroscope de la cible la redresse", () => {
    const w = world();
    const tumbler = place(w, preset("tumbler"), 0, -1);
    const input = pilot(tumbler, "verticalSpinner");
    w.aiPaused = true;
    const arm = armOf(tumbler, "verticalSpinner");
    let full = -1;
    for (let i = 0; i < 240; i++) {
      w.step();
      if (full < 0 && meleeCharge(arm) >= 0.98) full = w.time;
    }
    const spin = meleeDef("verticalSpinner").spin!;
    expect(full).toBeGreaterThan(spin.spinUp * 0.8);
    expect(full).toBeLessThan(spin.spinUp * 1.4);
    expect(storedEnergy(arm)).toBeCloseTo(spinEnergy(spin, spin.speed), -2);
    // Un Tricycle en travers devant lui
    const target = place(w, preset("trike"), 0, 4, Math.PI / 2, "red");
    const seen = hits(w);
    input.throttle = 0.5;
    let lift = 0;
    let lowest = 1;
    let flippedAt = -1;
    for (let i = 0; i < 240; i++) {
      w.step();
      if (!target.cockpit.alive) break;
      lift = Math.max(lift, target.cockpit.part.rb.linvel().y);
      lowest = Math.min(lowest, upOf(target).y);
      if (flippedAt < 0 && upOf(target).y < 0.55) flippedAt = w.time;
    }
    const first = seen.find((h) => h.surface === "robot")!;
    expect(first).toBeDefined();
    // Le coup part vers le haut : la cible décolle et se retourne
    expect(first.dir.y).toBeGreaterThan(0.6);
    expect(lift).toBeGreaterThan(2.5);
    expect(lowest).toBeLessThan(0.55);
    // Couchée, elle se redresse d'elle-même (le gyroscope de son cockpit)
    input.throttle = 0;
    input.weapon = "rifle";
    let upright = false;
    for (let i = 0; i < 12 * 60 && !upright; i++) {
      w.step();
      upright = target.cockpit.alive && upOf(target).y > 0.9 && w.time > flippedAt + 1;
    }
    report("VERTICALE", { full, first: first.energy, lift, lowest, flippedAt, upright });
    expect(upright).toBe(true);
  });

  it("toupie verticale : lancée, si elle pique du nez, son disque mord le sol et renvoie son robot en salto arrière", () => {
    const w = world();
    const tumbler = place(w, preset("tumbler"), 0, 0);
    pilot(tumbler, "verticalSpinner");
    run(w, 3.5);
    expect(meleeCharge(armOf(tumbler, "verticalSpinner"))).toBeGreaterThan(0.95);
    const seen = hits(w);
    // Il tombe de 90 cm, le nez en bas de 30° : le disque touche le sol le premier
    const rb = tumbler.cockpit.part.rb;
    const t = rb.translation();
    const pitch = (30 * Math.PI) / 180;
    rb.setTranslation({ x: t.x, y: t.y + 0.9, z: t.z }, true);
    rb.setRotation({ x: Math.sin(pitch / 2), y: 0, z: 0, w: Math.cos(pitch / 2) }, true);
    let nose = -1;
    let lowest = 1;
    for (let i = 0; i < 180; i++) {
      w.step();
      nose = Math.max(nose, noseOf(tumbler).y);
      lowest = Math.min(lowest, upOf(tumbler).y);
    }
    const ground = seen.filter((h) => h.surface === "scenery");
    report("SALTO", { ground: ground.map((h) => h.energy), nose, lowest });
    expect(ground.length).toBeGreaterThan(0);
    // Le sol le renvoie vers le haut et vers l'arrière : le nez se lève jusqu'à la verticale, il se retourne
    expect(ground[0].dir.y).toBeGreaterThan(0.5);
    expect(nose).toBeGreaterThan(0.9);
    expect(lowest).toBeLessThan(0.55);
  });

  it("toupie verticale : en virage, son gyroscope penche son robot vers l'intérieur ; arrêtée, rien", () => {
    // Une tour qui pivote sur place : sans toupie, elle penche un peu vers l'extérieur ; avec, vers l'intérieur
    const lean = (spinning: boolean, steer: number): { roll: number; yaw: number } => {
      const w = world();
      const bot = place(w, profile("tour", tallTumbler()), 0, 0);
      const input = pilot(bot, spinning ? "verticalSpinner" : "rifle");
      run(w, 3.5);
      input.steer = steer;
      let roll = 0;
      let yaw = 0;
      let n = 0;
      for (let i = 0; i < 300; i++) {
        w.step();
        if (i < 90) continue;
        // > 0 : le flanc gauche monte, il penche à droite
        roll += Math.asin(Math.max(-1, Math.min(1, leftOf(bot).y)));
        yaw += bot.cockpit.part.rb.angvel().y;
        n++;
      }
      return { roll: deg(roll / n), yaw: yaw / n };
    };
    const results = [1, -1].map((steer) => ({ steer, still: lean(false, steer), spun: lean(true, steer) }));
    report("VIRAGE", results);
    for (const { steer, still, spun } of results) {
      // Le virage à gauche (lacet > 0) : penché à droite au repos ; la toupie le ramène vers la gauche
      expect(Math.sign(still.yaw)).toBe(steer);
      expect((spun.roll - still.roll) * steer).toBeLessThan(-0.2);
    }
  });

  it("tambour : peu de moment cinétique ; il fait sautiller sa cible et arrache la roue qu'il mord", () => {
    const disc = meleeDef("verticalSpinner").spin!;
    const drum = meleeDef("drum").spin!;
    // La version stable : bien moins de moment cinétique que la toupie verticale, pour une énergie comparable
    expect(drum.inertia * drum.speed).toBeLessThan(0.5 * disc.inertia * disc.speed);
    expect(spinEnergy(drum, drum.speed)).toBeGreaterThan(0.6 * spinEnergy(disc, disc.speed));
    const w = world();
    const drummer = place(w, preset("drummer"), 0, -1);
    const input = pilot(drummer, "drum");
    w.aiPaused = true;
    run(w, 2.5);
    // Un Buggy en travers, sa roue avant droite face au tambour
    const target = place(w, preset("buggy"), -1.5, 3.5, Math.PI / 2, "red");
    const seen = hits(w);
    const mounted = (): number => target.wheels.filter((wh) => wh.part).length;
    const before = mounted();
    input.throttle = 0.6;
    let hops = 0;
    let rising = false;
    for (let i = 0; i < 300; i++) {
      w.step();
      if (!target.cockpit.alive) break;
      const vy = target.cockpit.part.rb.linvel().y;
      if (vy > 0.8 && !rising) hops++;
      rising = vy > 0.8;
    }
    report("TAMBOUR", { hits: seen.map((h) => `${h.surface} ${h.energy.toFixed(0)}`), ripped: before - mounted(), hops });
    expect(seen.filter((h) => h.surface === "robot").length).toBeGreaterThan(1);
    expect(before - mounted()).toBeGreaterThan(0);
    expect(hops).toBeGreaterThan(1);
  });

  it("anneau-coque : il frappe de tous côtés sans viser, jamais son propre robot", () => {
    const w = world();
    const shell = place(w, preset("whirlwind"), 0, 0);
    pilot(shell, "shellSpinner");
    w.aiPaused = true;
    // Quatre murs autour de lui, chacun tourné vers lui
    const sides = ([[0, 2.6, Math.PI], [0, -2.6, 0], [2.6, 0, -Math.PI / 2], [-2.6, 0, Math.PI / 2]] as const)
      .map(([x, z, yaw]) => place(w, profile("mur", wall()), x, z, yaw, "red"));
    const full = sides.map(totalHp);
    const others = [...shell.blocks.values()].filter((b) => b.type !== "shellSpinner");
    const seen = hits(w);
    run(w, 6);
    const lost = sides.map((s, i) => full[i] - totalHp(s));
    report("ANNEAU", { hits: seen.length, lost, charge: meleeCharge(armOf(shell, "shellSpinner")) });
    for (const l of lost) expect(l).toBeGreaterThan(20);
    expect(seen.every((h) => h.surface === "robot")).toBe(true);
    // Ses propres blocs n'ont rien (seul l'anneau s'use en frappant)
    for (const b of others) expect(b.hp).toBe(blockDef(b.type).hp);
  });

  it("anneau-coque : tout le robot devient un gyroscope ; il dérape quand son anneau prend de la vitesse", () => {
    const drift = (spinning: boolean): { turned: number; aside: number; L: number } => {
      const w = world();
      const shell = place(w, preset("whirlwind"), 0, 0);
      const input = pilot(shell, spinning ? "shellSpinner" : "rifle");
      input.throttle = 1;
      run(w, 4);
      const nose = noseOf(shell);
      const p = shell.cockpit.part.rb.translation();
      return { turned: deg(Math.acos(Math.max(-1, Math.min(1, nose.z)))), aside: Math.abs(p.x), L: len(angularMomentum(armOf(shell, "shellSpinner"))) };
    };
    const still = drift(false);
    const spun = drift(true);
    report("DÉRAPAGE", { still, spun });
    expect(spun.L).toBeGreaterThan(400);
    // Tout droit, gaz à fond : il tient son cap ; l'anneau lancé (la réaction de son moteur), il pivote et s'écarte
    expect(still.turned).toBeLessThan(3);
    expect(spun.turned).toBeGreaterThan(6);
    expect(spun.aside).toBeGreaterThan(still.aside + 1);
  });

  it("anneau-coque : renversé, son anneau lancé racle le sol sans le faire rebondir, et le gyroscope du cockpit le redresse", () => {
    const w = world();
    w.aiPaused = true;
    const bot = place(w, preset("whirlwind"), 0, 0);
    pilot(bot, "shellSpinner");
    run(w, 4);
    const arm = armOf(bot, "shellSpinner");
    expect(meleeCharge(arm)).toBeGreaterThan(0.9);
    // À l'envers, un peu au-dessus du sol
    const rb = bot.cockpit.part.rb;
    const t = rb.translation();
    rb.setTranslation(vec3(t.x, t.y + 1.2, t.z), true);
    rb.setRotation({ x: 0, y: 0, z: 1, w: 0 }, true);
    let fastest = 0;
    let righted = Infinity;
    for (let i = 0; i < 6 * 60; i++) {
      w.step();
      // (à l'envers, avant que le gyroscope ne le fasse bondir)
      if (i > 60 && upOf(bot).y < 0.55 && bot.righting <= 0) fastest = Math.max(fastest, len(rb.linvel()));
      if (righted === Infinity && upOf(bot).y > 0.9) righted = i / 60;
    }
    report("anneau renversé", { fastest, righted, spin: arm.spin });
    // (avant : chaque contact de l'anneau avec le sol le renvoyait, à plusieurs m/s, et il ne se posait jamais)
    expect(arm.spin).toBeGreaterThan(0.5 * meleeDef("shellSpinner").spin!.speed);
    expect(fastest).toBeLessThan(3.5);
    expect(righted).toBeLessThan(5);
  });

  it("hélice tranchante : son régime suit la poussée ; elle blesse ce qu'elle frôle et s'y brise, et l'avion perd son moteur", () => {
    const w = world();
    // (les tourelles se taisent : seule l'hélice frappe)
    w.combat = false;
    const plane = spawnBot(w, preset("plane"), vec3(0, 2, 0), 0, "blue");
    w.bots.push(plane);
    const target = place(w, profile("mur", wall()), 0, 1.85, Math.PI, "red");
    const prop = armOf(plane, "propeller");
    const engine = plane.thrusters.find((t) => t.block === prop.block)!;
    // Elle n'est pas une arme du joueur ni de l'IA : seul son moteur la mène
    expect(liveMelee(plane)).toEqual([]);
    const seen = hits(w);
    const pinned = { p: plane.cockpit.part.rb.translation(), q: plane.cockpit.part.rb.rotation() };
    const before = totalHp(target);
    let ratio = 0;
    let spun = 0;
    let brokeAt = -1;
    for (let i = 0; i < 480; i++) {
      // L'avion tenu en l'air, plein gaz : deux secondes en retrait, puis son hélice mord le haut du mur
      const back = i < 120 ? -1.2 : 0;
      for (const part of plane.parts) {
        part.rb.setTranslation({ x: pinned.p.x, y: pinned.p.y, z: pinned.p.z + back }, true);
        part.rb.setRotation(pinned.q, true);
        part.rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
        part.rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
      }
      w.step();
      if (i === 110) {
        ratio = engine.thrust / blockDef(engine.block.type).thruster!.maxThrust;
        spun = prop.spin;
      }
      if (brokeAt < 0 && !prop.block.alive) brokeAt = w.time;
    }
    const drive = meleeDef("propeller").drive!;
    const speed = meleeDef("propeller").spin!.speed;
    report("HÉLICE", { ratio, spun, hits: seen.map((h) => `${h.surface} ${h.energy.toFixed(0)}`), damage: before - totalHp(target), brokeAt });
    // (il suit la poussée avec un peu de retard : `spinUp`)
    const wanted = speed * (drive.idle + (1 - drive.idle) * ratio);
    expect(spun).toBeGreaterThan(0.8 * wanted);
    expect(spun).toBeLessThan(1.02 * wanted);
    expect(seen.some((h) => h.surface === "robot" && h.block === prop.block)).toBe(true);
    expect(before - totalHp(target)).toBeGreaterThan(50);
    // Elle s'y brise : le moteur est perdu
    expect(prop.block.alive).toBe(false);
    expect(liveThrusters(plane).some((t) => t.block === prop.block)).toBe(false);
  });

  it("zones touchables : un rayon sur la barre, le disque, le tambour, l'anneau ou la tête du marteau touche le bloc de l'arme", () => {
    const w = world();
    const reaper = place(w, preset("reaper"), -6, 0);
    const pounder = place(w, preset("pounder"), 6, 0);
    const tumbler = place(w, preset("tumbler"), -6, 8);
    const drummer = place(w, preset("drummer"), 6, 8);
    const shell = place(w, preset("whirlwind"), 0, -8);
    w.aiPaused = true;
    run(w, 0.5);
    const down = vec3(0, -1, 0);
    const blade = (origin: Vec3, dir: Vec3, arm: MeleeArm): boolean => {
      const hit = w.raycast(origin, dir, 10);
      if (hit?.owner?.kind !== "blade" || hit.owner.arm !== arm) return false;
      expect(hitTargetOf(hit.owner, hit.point, dir)).toEqual({ kind: "block", block: arm.block });
      return true;
    };
    // La barre, à l'angle où elle s'est arrêtée : son bout se touche d'en haut, pas l'entre-deux
    const bar = armOf(reaper, "spinner");
    const tip = (arm: MeleeArm, turn: number): Vec3 => {
      const f = meleeFrame(arm);
      const a = hitboxOf(arm).angle + turn;
      return add(f.hub, scale(add(scale(f.e1, Math.cos(a)), scale(f.e2, Math.sin(a))), 0.8));
    };
    expect(blade(add(tip(bar, 0), vec3(0, 3, 0)), down, bar)).toBe(true);
    expect(blade(add(tip(bar, Math.PI / 2), vec3(0, 3, 0)), down, bar)).toBe(false);
    // Elle tourne : sa zone touchable la suit
    pilot(reaper, "spinner");
    run(w, 1);
    expect(hitboxOf(bar).angle).not.toBe(0);
    expect(blade(add(tip(bar, 0), vec3(0, 3, 0)), down, bar)).toBe(true);
    // La tête du marteau, armée au-dessus du robot
    const hammer = armOf(pounder, "hammer");
    const f = meleeFrame(hammer);
    const head = add(f.hub, add(scale(f.e1, Math.cos(hammer.swing) * 1.3), scale(f.e2, -Math.sin(hammer.swing) * 1.3)));
    expect(blade(add(head, scale(leftOf(pounder), 3)), scale(leftOf(pounder), -1), hammer)).toBe(true);
    // Le disque et le tambour, de côté
    for (const [bot, weapon] of [[tumbler, "verticalSpinner"], [drummer, "drum"]] as const) {
      const arm = armOf(bot, weapon);
      const hub = meleeFrame(arm).hub;
      expect(blade(add(hub, scale(leftOf(bot), 3)), scale(leftOf(bot), -1), arm), weapon).toBe(true);
    }
    // L'anneau, de côté à sa hauteur ; d'en haut, on touche le robot dedans
    const ring = armOf(shell, "shellSpinner");
    const hub = meleeFrame(ring).hub;
    expect(blade(add(hub, vec3(4, 0, 0.3)), vec3(-1, 0, 0), ring)).toBe(true);
    expect(blade(add(hub, vec3(0.5, 3, 0.5)), down, ring)).toBe(false);
    // Sans masse, sans contact
    for (const bot of [reaper, pounder, tumbler, drummer, shell]) {
      for (const h of bot.cockpit.part.blades) {
        for (const c of h.colliders) {
          expect(c.mass()).toBe(0);
          expect(c.collisionGroups() & 0xffff).toBe(0);
        }
      }
    }
    // Une balle sur le tambour abîme le bloc du tambour
    const drum = armOf(drummer, "drum");
    const before = drum.block.hp;
    const at = meleeFrame(drum).hub;
    w.fire("rifle", add(at, scale(leftOf(drummer), 4)), scale(leftOf(drummer), -1));
    run(w, 0.2);
    expect(drum.block.hp).toBeLessThan(before);
  });

  it("réseau : le régime des toupies et de l'hélice arrive dans la réplique, comme leurs coups", () => {
    seedRandom(21);
    const room = new Room(new ProgressBook());
    try {
      const replica = new Replica();
      const texts: ServerMessage[] = [];
      const events: SimEvent[] = [];
      replica.on((e) => events.push(e));
      const player = room.connect({
        send: (data) => {
          if (typeof data === "string") texts.push(JSON.parse(data) as ServerMessage);
          else replica.receive(data);
        },
      });
      const send = (msg: object): void => room.receive(player, JSON.stringify(msg));
      send({ t: "join", version: PROTOCOL_VERSION, name: "Tom", robot: { preset: "whirlwind" }, token: "jeton-anneau-0000000000" });
      const tick = (seconds: number): void => {
        for (let i = 0; i < Math.ceil((seconds * 60) / SNAPSHOT_EVERY) * SNAPSHOT_EVERY; i++) room.tick();
      };
      tick(1);
      room.sim.aiPaused = true;
      send({ t: "input", input: { ...newInput(), weapon: "shellSpinner" } });
      tick(4);
      replica.flush();
      const bot = player.bot!;
      const copy = replica.player!;
      expect(copy.id).toBe(bot.id);
      const ring = armOf(copy, "shellSpinner");
      expect(ring.spin).toBeCloseTo(armOf(bot, "shellSpinner").spin, 3);
      expect(ring.spin).toBeGreaterThan(0.85 * meleeDef("shellSpinner").spin!.speed);
      // Toutes les armes de contact, hélices des avions comprises, ont le même régime de part et d'autre
      for (const other of room.sim.bots) {
        const twin = replica.bots.find((b) => b.id === other.id)!;
        for (const arm of other.melee) {
          if (!arm.block.alive) continue;
          expect(twin.melee.find((a) => a.block.id === arm.block.id)!.spin, arm.weapon).toBeCloseTo(arm.spin, 3);
        }
      }
      // Un ennemi posé contre son anneau : le coup part du serveur et arrive dans la réplique
      const enemy = room.sim.bots.find((b) => b.team !== bot.team && b.cockpit.alive && b.profile.mobility === "ground" && b.parts.size === 1)!;
      const hub = meleeFrame(armOf(bot, "shellSpinner")).hub;
      const rb = [...enemy.parts][0].rb;
      rb.setTranslation({ x: hub.x + 2.4, y: rb.translation().y, z: hub.z }, true);
      rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
      tick(2);
      replica.flush();
      const hit = events.find((e) => e.type === "meleeHit");
      expect(hit?.type === "meleeHit" && hit.block.id).toBe(armOf(bot, "shellSpinner").block.id);
      expect(texts.some((m) => m.t === "refused")).toBe(false);
    } finally {
      room.dispose();
    }
  });

  /*
   * Bilan en bataille (`SPINNER_BATTLE=1 npx vitest run tests/spinners.test.ts --silent=false`) : six
   * batailles où chaque équipe a son Culbuteur, son Tambourin et son Tourbillon, le reste tiré au sort ;
   * par robot, destructions, morts, temps renversé, coups portés et leur énergie, roues arrachées ;
   * les coups des hélices des avions ; et le coût de l'étape « contact » du pas.
   */
  it.runIf(!!env.SPINNER_BATTLE)("bilan des toupies en bataille", { timeout: 1_800_000 }, () => {
    const lines: string[] = [];
    const stats = new Map<string, { kills: number; deaths: number; flipped: number; hits: number; energy: number; wheels: number; killedBy: Map<string, number> }>();
    const of = (bot: Bot) => {
      let s = stats.get(botName(bot.profile));
      if (!s) stats.set(botName(bot.profile), (s = { kills: 0, deaths: 0, flipped: 0, hits: 0, energy: 0, wheels: 0, killedBy: new Map() }));
      return s;
    };
    let contact = 0;
    let total = 0;
    let steps = 0;
    let propellerHits = 0;
    let propellersBroken = 0;
    const family = ["tumbler", "drummer", "whirlwind"];
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      seedRandom(seed);
      const w = new Simulation();
      sim = w;
      const others = PRESET_BOTS.filter((p) => !family.includes(p.id)).sort(() => Math.random() - 0.5).slice(0, 6);
      spawnTeams(w, [
        ...family.flatMap((id) => [{ profile: preset(id), team: "blue" as const }, { profile: preset(id), team: "red" as const }]),
        ...others.map((profile, i) => ({ profile, team: i % 2 ? "red" as const : "blue" as const })),
      ]);
      const match = startMatch(w, { ...GAME_MODES.battle.match, timeLimit: 180 });
      // Une roue arrachée par une arme de contact : le coup juste avant, sur ce robot
      let lastMelee: { bot: Bot; at: number } | null = null;
      w.on((e) => {
        if (e.type === "botKilled") {
          const victim = of(e.bot);
          victim.deaths++;
          victim.killedBy.set(e.cause ?? "?", (victim.killedBy.get(e.cause ?? "?") ?? 0) + 1);
          if (e.killer) of(e.killer).kills++;
        }
        if (e.type === "meleeHit" && e.surface === "robot") {
          if (blockDef(e.block.type).melee === "propeller") propellerHits++;
          else {
            const s = of(e.block.bot);
            s.hits++;
            s.energy += e.energy;
            lastMelee = { bot: e.block.bot, at: w.time };
          }
        }
        if (e.type === "blockDestroyed" && blockDef(e.block.type).melee === "propeller") propellersBroken++;
        if (e.type === "wheelRemoved" && lastMelee && w.time - lastMelee.at < 0.05 && e.wheel.bot !== lastMelee.bot) of(lastMelee.bot).wheels++;
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
    lines.push(`Hélices : ${propellerHits} coups sur des robots, ${propellersBroken} brisées`);
    for (const [name, s] of [...stats].sort((a, b) => b[1].kills - b[1].deaths - (a[1].kills - a[1].deaths))) {
      lines.push(`${name.padEnd(14)} destructions ${String(s.kills).padStart(3)} · morts ${String(s.deaths).padStart(3)} · renversé ${s.flipped.toFixed(0).padStart(3)} s`
        + (s.hits ? ` · ${s.hits} coups (${(s.energy / s.hits / 1000).toFixed(2)} kJ en moyenne), ${s.wheels} roues arrachées` : "")
        + ` · tué par ${[...s.killedBy].map(([c, n]) => `${c} ${n}`).join(", ")}`);
    }
    console.log(lines.join("\n"));
  });

  it("une bataille avec le Culbuteur, le Tambourin et le Tourbillon de chaque côté se joue sans erreur, et ils frappent", { timeout: 120_000 }, () => {
    seedRandom(7);
    const w = new Simulation();
    sim = w;
    const roster = ["tumbler", "drummer", "whirlwind", "trike", "buggy", "plane"];
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
    const struck = new Set(seen.filter((h) => h.surface === "robot").map((h) => h.block.bot.profile.id));
    report("BATAILLE", { hits: seen.length, struck: [...struck], kills });
    expect(seen.filter((h) => h.surface === "robot").length).toBeGreaterThan(2);
    expect(kills).toBeGreaterThan(0);
  });
});
