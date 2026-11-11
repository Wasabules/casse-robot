import RAPIER from "@dimforge/rapier3d-compat";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { COLLISION_GROUPS } from "../src/shared/physics/groups";
import { ProgressBook } from "../src/server/progressBook";
import { Room, type Player } from "../src/server/room";
import { ARENAS, type ArenaLayout } from "../src/shared/arena/layout";
import { BLOCK_TYPES } from "../src/shared/catalog/blocks";
import { flailOrbit, meleeDef } from "../src/shared/catalog/melee";
import { DamageBatch, inflict } from "../src/shared/combat/damage";
import { crankTip, gripping } from "../src/shared/combat/mechanics";
import { meleeFrame } from "../src/shared/combat/melee";
import { designConflicts, placementConflicts } from "../src/shared/design/clearance";
import { PRESET_BOTS, type BotProfile } from "../src/shared/design/presets";
import { DesignGrid, validateDesign, type RobotDesign, type WheelMount } from "../src/shared/design/robotDesign";
import { add, distance, len, qrot, qrotInv, sub, vec3 } from "../src/shared/math/vec";
import { GAME_MODES } from "../src/shared/modes";
import { PROTOCOL_VERSION, SNAPSHOT_EVERY, type ClientMessage, type RobotChoice } from "../src/shared/net/protocol";
import { Replica } from "../src/shared/net/replica";
import { groundHeight, removeBot, spawnBot } from "../src/shared/robot/lifecycle";
import type { Bot } from "../src/shared/sim/entities";
import type { SimEvent } from "../src/shared/sim/events";
import { startMatch } from "../src/shared/sim/match";
import { newInput, takeControl, type PlayerInput } from "../src/shared/sim/player";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";
import { spawnTeams } from "../src/shared/sim/wave";
import { seedRandom } from "./seed";
import { botName } from "../src/client/i18n/names";

/*
 * Frappes à mécanique (combat/mechanics.ts) : le flipper, le fléau et la mâchoire broyeuse, sur le
 * sol plat du Dépôt. `MELEE_REPORT=1 npx vitest run tests/meleeMechanics.test.ts --silent=false` :
 * les mesures de chaque essai ; `MELEE_BATTLE=1` en plus : des batailles avec la Catapulte et le
 * Broyeur de chaque côté, leur bilan.
 */

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

function world(arena: ArenaLayout = { ...ARENAS.depot, props: [] }): Simulation {
  sim?.dispose();
  seedRandom(3);
  const w = new Simulation();
  w.arena = arena;
  sim = w;
  return w;
}

function place(w: Simulation, p: BotProfile, x: number, z: number, yaw = 0, team: "red" | "blue" = "blue"): Bot {
  const bot = spawnBot(w, p, vec3(x, groundHeight(p.design) + 0.03, z), yaw, team);
  w.bots.push(bot);
  return bot;
}

function pilot(bot: Bot, weapon: PlayerInput["weapon"]): PlayerInput {
  const input = { ...newInput(), weapon };
  takeControl(bot, input);
  return input;
}

const run = (w: Simulation, seconds: number): void => {
  for (let i = 0; i < Math.round(seconds * 60); i++) w.step();
};

const totalHp = (bot: Bot): number => [...bot.blocks.values()].reduce((s, b) => s + b.hp, 0);
/** Hauteur du centre de masse du morceau du cockpit. */
const height = (bot: Bot): number => bot.cockpit.part.rb.worldCom().y;
/** Tangage du robot (rad, > 0 : le nez pique). */
const noseDown = (bot: Bot): number => -Math.asin(qrot(bot.cockpit.part.rb.rotation(), vec3(0, 0, 1)).y);

const tracks = (zs: number[], x: number): WheelMount[] => zs.flatMap((z) => [-1, 1].map((s) => ({ x: s * x, y: 0, z, dx: s, dz: 0, type: "track" as const })));

/** Petit flipper léger (~40 kg) : un châssis de 3 × 3 sur chenilles, le flipper devant. */
function lightFlipper(): RobotDesign {
  const g = new DesignGrid();
  g.box(-1, 1, 0, 0, -2, 0, "frame");
  g.put(0, 0, 1, "flipper");
  g.put(0, 1, -1, "cockpit");
  return { blocks: g.blocks(), wheels: tracks([-2, 0], 1) };
}

/** Petite mâchoire légère (~40 kg). */
function lightJaw(): RobotDesign {
  const g = new DesignGrid();
  g.box(-1, 1, 0, 0, -2, 0, "frame");
  g.put(0, 0, 1, "jaw");
  g.put(0, 1, -1, "cockpit");
  return { blocks: g.blocks(), wheels: tracks([-2, 0], 1) };
}

/** Une galette en blindage lourd sur quatre roues, le fléau au milieu (son mât dépasse du pont). */
function flailer(): RobotDesign {
  const g = new DesignGrid();
  g.box(-2, 2, 0, 0, -2, 2, "armorHeavy");
  g.put(0, 0, 0, "flail");
  g.put(0, 0, -2, "cockpit");
  const wheels = [-2, 2].flatMap((z) => [-1, 1].map((s) => ({ x: 2 * s, y: 0, z, dx: s, dz: 0, type: "standard" as const })));
  return { blocks: g.blocks(), wheels };
}

/** Une potence : le fléau au bout d'une flèche, sa boule pend dans le vide (pour le pendule). */
function gallows(): RobotDesign {
  const g = new DesignGrid();
  g.box(-2, 2, 0, 0, -2, 2, "armorHeavy");
  g.box(0, 0, 1, 6, 2, 2, "frame");
  g.box(0, 0, 6, 6, 3, 4, "frame");
  g.put(0, 6, 5, "flail");
  g.put(0, 0, -2, "cockpit");
  const wheels = [-2, 2].flatMap((z) => [-1, 1].map((s) => ({ x: 2 * s, y: 0, z, dx: s, dz: 0, type: "standard" as const })));
  return { blocks: g.blocks(), wheels };
}

/** Les coups d'armes de contact qu'on entend. */
function hits(w: Simulation): Extract<SimEvent, { type: "meleeHit" }>[] {
  const out: Extract<SimEvent, { type: "meleeHit" }>[] = [];
  w.on((e) => {
    if (e.type === "meleeHit") out.push(e);
  });
  return out;
}

describe("frappes à mécanique", () => {
  it("les robots prédéfinis sont valides, et rien n'entre sous le plateau, dans la gueule ni dans le tour de la boule", () => {
    for (const id of ["catapult", "crusher", "thresher"]) {
      const design = preset(id).design;
      expect(validateDesign(design), id).toEqual([]);
      expect(designConflicts(design), id).toEqual([]);
    }
    for (const design of [flailer(), lightFlipper(), lightJaw(), gallows()]) {
      expect(validateDesign(design)).toEqual([]);
      expect(designConflicts(design)).toEqual([]);
    }
    // Un bloc devant le flipper (sur le plateau), dans la gueule du Broyeur, sur le tour de la boule
    expect(placementConflicts(preset("catapult").design, { kind: "block", block: { x: 0, y: 0, z: 3, type: "armor" } }).length).toBeGreaterThan(0);
    expect(placementConflicts(preset("crusher").design, { kind: "block", block: { x: 0, y: 0, z: 5, type: "armor" } }).length).toBeGreaterThan(0);
    expect(placementConflicts(flailer(), { kind: "block", block: { x: 2, y: 1, z: 0, type: "armor" } }).length).toBeGreaterThan(0);
  });

  describe("flipper", () => {
    /** Le flipper `flipper` lève une fois sous `victim` posé devant lui, de travers ; ce qu'on mesure. */
    function flip(flipper: BotProfile, victim: string, front: number) {
      const w = world();
      const bot = place(w, flipper, 0, 0);
      const input = pilot(bot, "flipper");
      w.aiPaused = true;
      const target = place(w, preset(victim), 0, front, Math.PI / 2, "red");
      run(w, 1);
      const seen = hits(w);
      const credited: Extract<SimEvent, { type: "hit" }>[] = [];
      w.on((e) => {
        if (e.type === "hit" && e.victim === target && e.cause === "flipper") credited.push(e);
      });
      const y0 = height(target);
      const hp0 = totalHp(target);
      const energy0 = bot.energy;
      let spent = 0;
      let rise = 0;
      let pitch = 0;
      let flippedOver = false;
      let lifted = false;
      for (let i = 0; i < 240; i++) {
        input.trigger = i < 3;
        w.step();
        if (i === 3) spent = energy0 - bot.energy;
        // L'arrière décolle : plus aucune de ses roues de derrière ne porte
        const rear = Math.min(...bot.wheels.map((wh) => wh.local.z));
        lifted ||= bot.wheels.filter((wh) => wh.local.z === rear).every((wh) => wh.load <= 0);
        if (!target.cockpit.alive) break;
        rise = Math.max(rise, height(target) - y0);
        pitch = Math.max(pitch, noseDown(bot));
        flippedOver ||= qrot(target.cockpit.part.rb.rotation(), vec3(0, 1, 0)).y < 0;
      }
      return {
        hits: seen.length, rise, pitch: (pitch * 180) / Math.PI, damage: hp0 - totalHp(target), spent, flippedOver, lifted,
        credited: credited.length, phase: bot.melee[0].phase, attacker: target.lastAttacker === bot,
      };
    }

    it("il jette en l'air ce qui est sur son plateau ; la cible retombe et ses chocs sont crédités au flipper", () => {
      // (ce que coûte la chute dépend de la façon dont elle retombe, de 0 à ~100 points pour quelques
      // centimètres de plus ou de moins devant le plateau, et du moindre écart dans la physique : les
      // zones touchables de sa toupie suffisaient à la faire tomber autrement à 2,9 m ; à 2,8 m, elle
      // retombe durement, avec ou sans elles)
      const r = flip(preset("catapult"), "reaper", 2.8);
      report("FLIPPER Catapulte → Faucheuse", r);
      expect(r.hits).toBe(1);
      expect(r.rise).toBeGreaterThan(1);
      // Elle retombe et se fait mal (dégâts de chute, crédités au flipper : il touche une deuxième fois)
      expect(r.credited).toBeGreaterThan(1);
      expect(r.attacker).toBe(true);
      expect(r.damage).toBeGreaterThan(10);
      // Une levée coûte cher aux batteries
      expect(r.spent).toBeGreaterThan(meleeDef("flipper").plate!.cost * 0.9);
      // Elle est souvent retournée
      expect(r.flippedOver).toBe(true);
    });

    it("le vérin se recharge lentement : pas deux levées en moins de trois secondes", () => {
      const w = world();
      const bot = place(w, preset("catapult"), 0, 0);
      const input = pilot(bot, "flipper");
      w.aiPaused = true;
      run(w, 0.5);
      const arm = bot.melee[0];
      let strikes = 0;
      let last = arm.phase;
      for (let i = 0; i < 4 * 60; i++) {
        input.trigger = true;
        w.step();
        if (arm.phase === "strike" && last !== "strike") strikes++;
        last = arm.phase;
      }
      // 4 s gâchette tenue : la première levée, puis la recharge de 3,2 s
      expect(strikes).toBe(2);
    });

    it("un léger qui soulève un lourd le soulève à peine et pique du nez, l'arrière décolle ; un lourd sous un léger ne bronche pas", () => {
      const light = profile("flipper léger", lightFlipper());
      const weak = flip(light, "truck", 2.4);
      const strong = flip(preset("catapult"), "truck", 2.9);
      const easy = flip(preset("catapult"), "trike", 2.9);
      report("FLIPPER léger → Camion", weak, "Catapulte → Camion", strong, "Catapulte → Tricycle", easy);
      // Le léger soulève à peine le Camion, que la Catapulte (plus lourde, mieux appuyée) soulève bien plus
      expect(weak.rise).toBeLessThan(0.4);
      expect(strong.rise).toBeGreaterThan(2 * weak.rise);
      // C'est lui qui bascule : il pique du nez, l'arrière décolle
      expect(weak.pitch).toBeGreaterThan(8);
      expect(weak.lifted).toBe(true);
      // La Catapulte sous un robot léger : elle l'envoie haut et bronche à peine
      expect(easy.rise).toBeGreaterThan(2);
      expect(easy.pitch).toBeLessThan(weak.pitch);
    });
  });

  describe("fléau", () => {
    it("lancé, la boule tourne à son tour, à la vitesse de la manivelle ; sa chaîne tire sur le robot", () => {
      const w = world();
      const bot = place(w, profile("fléau", flailer()), 0, 0);
      pilot(bot, "flail");
      w.aiPaused = true;
      run(w, 5);
      const arm = bot.melee[0];
      const fl = meleeDef("flail").flail!;
      const orbit = flailOrbit(fl);
      const f = meleeFrame(arm);
      const rel = sub(arm.ball!.pos, f.hub);
      const radius = Math.hypot(rel.x, rel.z);
      const speed = len(arm.ball!.vel);
      report("FLÉAU tour", { radius, attendu: orbit.radius, speed, attendue: fl.speed * orbit.radius, sous: -rel.y, energie: bot.energy });
      expect(arm.spin).toBeCloseTo(fl.speed, 1);
      expect(Math.abs(radius - orbit.radius)).toBeLessThan(0.2);
      expect(speed).toBeGreaterThan(0.75 * fl.speed * orbit.radius);
      expect(speed).toBeLessThan(1.15 * fl.speed * orbit.radius);
    });

    it("arrêté, la boule pend en pendule : sa période est celle d'un pendule de sa longueur", () => {
      const w = world();
      const bot = place(w, profile("potence", gallows()), 0, 0);
      pilot(bot, "rifle");
      w.aiPaused = true;
      run(w, 2);
      const arm = bot.melee[0];
      const fl = meleeDef("flail").flail!;
      // Écartée de 0,3 rad le long de x (monde), chaîne tendue, lâchée sans vitesse
      const tip = crankTip(meleeFrame(arm), fl, arm.angle);
      arm.ball!.pos = add(tip, vec3(fl.chain * Math.sin(0.3), -fl.chain * Math.cos(0.3), 0));
      arm.ball!.vel = vec3(0, 0, 0);
      const crossings: number[] = [];
      let last = 1;
      let fastest = 0;
      for (let i = 0; i < 6 * 60; i++) {
        w.step();
        const now = crankTip(meleeFrame(arm), fl, arm.angle);
        const x = arm.ball!.pos.x - now.x;
        if (last > 0 && x <= 0) crossings.push(w.time);
        last = x;
        fastest = Math.max(fastest, len(arm.ball!.vel));
      }
      const periods = crossings.slice(1).map((t, i) => t - crossings[i]);
      const expected = 2 * Math.PI * Math.sqrt(fl.chain / 9.81);
      // Au point bas, la vitesse d'un pendule lâché de 0,3 rad : √(2·g·L·(1 − cos 0,3))
      const bottom = Math.sqrt(2 * 9.81 * fl.chain * (1 - Math.cos(0.3)));
      report("FLÉAU pendule", { periods, expected, fastest, bottom });
      expect(periods.length).toBeGreaterThan(1);
      for (const p of periods) expect(Math.abs(p - expected)).toBeLessThan(0.15 * expected);
      // (un peu moins : l'air la freine, la potence ploie)
      expect(fastest).toBeGreaterThan(0.7 * bottom);
      expect(fastest).toBeLessThan(1.1 * bottom);
    });

    it("ses dégâts suivent le carré de la vitesse de la boule", () => {
      const strike = (speed: number): number => {
        const w = world();
        const bot = place(w, profile("fléau", flailer()), 0, 0);
        pilot(bot, "rifle");
        w.aiPaused = true;
        const wall = new DesignGrid().box(-2, 2, 0, 2, 0, 0, "armor").put(0, 0, 1, "cockpit");
        const target = place(w, profile("mur", { blocks: wall.blocks(), wheels: [] }), 0, 2, 0, "red");
        run(w, 1);
        const arm = bot.melee[0];
        const hp = totalHp(target);
        // La manivelle vers l'avant ; la boule lancée droit sur le mur, à hauteur de son étage du
        // haut, à cette vitesse (la chaîne reste lâche jusqu'au mur)
        arm.angle = 0;
        arm.ball!.pos = vec3(0, target.cockpit.part.rb.translation().y + 1.05, 2 - 0.25 - 0.16 - 0.3);
        arm.ball!.vel = vec3(0, 0, speed);
        const seen = hits(w);
        for (let i = 0; i < 12 && !seen.length; i++) {
          arm.ball!.vel = vec3(0, 0, speed);
          w.step();
        }
        expect(seen.length).toBe(1);
        return hp - totalHp(target);
      };
      const slow = strike(6);
      const fast = strike(12);
      report("FLÉAU dégâts", { slow, fast, rapport: fast / slow });
      expect(fast / slow).toBeGreaterThan(3.2);
      expect(fast / slow).toBeLessThan(4.8);
    });

    it("lancé, il déstabilise son robot en virage", () => {
      const turn = (spinning: boolean): number => {
        const w = world();
        const bot = place(w, profile("fléau", flailer()), 0, 0);
        const input = pilot(bot, spinning ? "flail" : "rifle");
        w.aiPaused = true;
        run(w, 4);
        // Il tourne en rond, à fond
        input.throttle = 1;
        input.steer = 1;
        let wobble = 0;
        for (let i = 0; i < 4 * 60; i++) {
          w.step();
          const spin = qrotInv(bot.cockpit.part.rb.rotation(), bot.cockpit.part.rb.angvel());
          wobble += Math.hypot(spin.x, spin.z) / 240;
        }
        return wobble;
      };
      const still = turn(false);
      const spun = turn(true);
      report("FLÉAU virage", { still, spun });
      // Roulis et tangage moyens : bien plus agités quand la boule tourne
      expect(spun).toBeGreaterThan(2 * still + 0.02);
    });

    it("sa chaîne s'enroule autour d'un poteau, retient le robot, puis se déroule", () => {
      const w = world();
      // Un poteau fixe (un corps du décor, sans propriétaire), dans le tour de la boule, devant un petit robot
      const post = w.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 1.5, 1.15));
      w.world.createCollider(RAPIER.ColliderDesc.cuboid(0.1, 1.5, 0.1).setCollisionGroups(COLLISION_GROUPS.static), post);
      const g = new DesignGrid().box(-1, 1, 0, 0, -1, 1, "armorHeavy").put(0, 0, 0, "flail").put(0, 0, -1, "cockpit");
      const small = [-1, 1].flatMap((z) => [-1, 1].map((s) => ({ x: s, y: 0, z, dx: s, dz: 0, type: "small" as const })));
      const bot = place(w, profile("petit fléau", { blocks: g.blocks(), wheels: small }), 0, 0);
      pilot(bot, "flail");
      w.aiPaused = true;
      const arm = bot.melee[0];
      let wrapped = 0;
      let unwrapped = false;
      for (let i = 0; i < 8 * 60; i++) {
        w.step();
        if (arm.ball?.wrap) wrapped++;
        else if (wrapped) unwrapped = true;
      }
      report("FLÉAU enroulé", { wrapped: wrapped / 60, unwrapped });
      expect(wrapped).toBeGreaterThan(0);
      expect(unwrapped).toBe(true);
      expect(bot.cockpit.alive).toBe(true);
    });
  });

  describe("mâchoire", () => {
    /** La mâchoire `jaw` mord `victim` posé devant elle et recule à fond en le tenant ; ce qu'on mesure pendant la prise. */
    function drag(jaw: BotProfile, victim: string, front: number, seconds = 1.5, throttle = -1) {
      const w = world();
      const bot = place(w, jaw, 0, 0);
      const input = pilot(bot, "jaw");
      w.aiPaused = true;
      const wall = new DesignGrid().box(-2, 2, 0, 1, 0, 1, "armorHeavy").put(0, 1, 1, "cockpit");
      const target = victim === "wall"
        ? place(w, profile("mur", { blocks: wall.blocks(), wheels: [] }), 0, front, 0, "red")
        : place(w, preset(victim), 0, front, Math.PI / 2, "red");
      run(w, 0.5);
      const arm = bot.melee[0];
      input.trigger = true;
      for (let i = 0; i < 60 && !arm.grip; i++) w.step();
      expect(arm.grip).not.toBeNull();
      const t0 = target.cockpit.part.rb.translation();
      const j0 = bot.cockpit.part.rb.translation();
      const hp0 = totalHp(target);
      input.throttle = throttle;
      let held = 0;
      for (let i = 0; i < seconds * 60; i++) {
        w.step();
        if (arm.grip) held++;
      }
      return {
        w, bot, target, input, arm, held: held / 60, crushed: hp0 - totalHp(target),
        // (un robot détruit a ses corps libérés : on ne les relit pas)
        prey: target.cockpit.alive ? distance(target.cockpit.part.rb.translation(), t0) : NaN,
        own: bot.cockpit.alive ? distance(bot.cockpit.part.rb.translation(), j0) : NaN,
      };
    }

    it("elle saisit, écrase et traîne une proie légère", () => {
      const r = drag(preset("crusher"), "trike", 3.6);
      report("MÂCHOIRE Broyeur → Tricycle", { held: r.held, crushed: r.crushed, prey: r.prey, own: r.own });
      expect(r.held).toBeGreaterThan(1.4);
      expect(r.crushed).toBeGreaterThan(100);
      // Ils reculent ensemble
      expect(r.own).toBeGreaterThan(1);
      expect(Math.abs(r.prey - r.own)).toBeLessThan(0.4 * r.own);
      // La gâchette relâchée, elle lâche
      r.input.trigger = false;
      run(r.w, 0.1);
      expect(r.arm.grip).toBeNull();
    });

    it("une proie lourde devient l'ancre : la mâchoire légère ne bouge plus", () => {
      const r = drag(profile("mâchoire légère", lightJaw()), "truck", 2.3);
      report("MÂCHOIRE légère → Camion", { held: r.held, prey: r.prey, own: r.own });
      expect(r.held).toBeGreaterThan(1.4);
      expect(r.own).toBeLessThan(0.6);
      expect(r.prey).toBeLessThan(0.4);
    });

    it("elle lâche quand la proie est détruite ou retirée, ou qu'elle-même l'est, sans relire de corps libéré", () => {
      for (const end of ["proie détruite", "proie retirée", "mâchoire détruite"] as const) {
        const r = drag(preset("crusher"), "reaper", 3.6, 0.3);
        const { w, bot, target, arm } = r;
        if (end === "proie détruite") {
          const batch = new DamageBatch();
          for (const b of target.blocks.values()) batch.add({ kind: "block", block: b }, 5000, "impact");
          inflict(w, batch, vec3(0, 1, 0), null);
        } else if (end === "proie retirée") {
          removeBot(w, target);
          w.bots.splice(w.bots.indexOf(target), 1);
        } else {
          const batch = new DamageBatch();
          batch.add({ kind: "block", block: arm.block }, 5000, "impact");
          inflict(w, batch, vec3(0, 1, 0), null);
        }
        // (un corps libéré relu ferait paniquer Rapier : RuntimeError: unreachable)
        run(w, 1);
        expect(arm.grip, end).toBeNull();
        expect(gripping(bot), end).toBeNull();
      }
    });

    it("elle lâche d'elle-même au bout de sa prise la plus longue", () => {
      const jaw = meleeDef("jaw").jaw!;
      // (sur un mur en blindage lourd, sans tirer : elle tient jusqu'au bout)
      const r = drag(preset("crusher"), "wall", 2.9, jaw.hold + 0.5, 0);
      report("MÂCHOIRE durée", { held: r.held });
      expect(r.arm.grip).toBeNull();
      expect(r.held).toBeGreaterThan(jaw.hold - 0.3);
      expect(r.held).toBeLessThan(jaw.hold + 0.1);
    });
  });

  describe("réseau", () => {
    let room: Room | null = null;
    afterEach(() => {
      room?.dispose();
      room = null;
    });

    let tokens = 0;
    const connect = (r: Room, robot: RobotChoice, token = `jeton-meca-${++tokens}-00000000`): { player: Player; replica: Replica; send: (m: ClientMessage) => void } => {
      const replica = new Replica();
      const player = r.connect({ send: (data) => (typeof data === "string" ? undefined : replica.receive(data)) });
      const send = (msg: ClientMessage): void => r.receive(player, JSON.stringify(msg));
      send({ t: "join", version: PROTOCOL_VERSION, name: "Méca", robot, token });
      return { player, replica, send };
    };
    const tick = (r: Room, seconds: number): void => {
      const steps = Math.ceil((seconds * 60) / SNAPSHOT_EVERY) * SNAPSHOT_EVERY;
      for (let i = 0; i < steps; i++) r.tick();
    };
    /** Un ennemi au sol posé devant le robot `bot`, à `ahead` m de son cockpit, de travers. */
    const enemyAhead = (r: Room, bot: Bot, ahead: number): Bot => {
      const enemy = r.sim.bots.find((b) => b.team !== bot.team && b.cockpit.alive && b.profile.mobility === "ground" && b.parts.size === 1)!;
      const at = bot.cockpit.part.rb.translation();
      const f = qrot(bot.cockpit.part.rb.rotation(), vec3(0, 0, 1));
      const rb = [...enemy.parts][0].rb;
      rb.setTranslation({ x: at.x + f.x * ahead, y: rb.translation().y + 0.2, z: at.z + f.z * ahead }, true);
      rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
      return enemy;
    };

    it("la réplique voit le plateau du flipper, la boule du fléau et la prise de la mâchoire", () => {
      seedRandom(21);
      room = new Room(new ProgressBook());
      room.sim.aiPaused = true;
      room.sim.combat = false;
      // Le fléau se débloque avec des crédits de ce serveur
      room.book.get("jeton-fleau-0000000000").credits = 2000;
      const flail = connect(room, { name: "Fléau", color: "#8a8f96", design: flailer() }, "jeton-fleau-0000000000");
      const catapult = connect(room, { preset: "catapult" });
      const crusher = connect(room, { preset: "crusher" });
      tick(room, 1);
      flail.send({ t: "input", input: { ...newInput(), weapon: "flail" } });
      tick(room, 4);
      // La boule : la même dans la réplique qu'au serveur
      flail.replica.flush();
      const ball = flail.player.bot!.melee[0].ball!;
      const twin = flail.replica.player!.melee[0].ball!;
      expect(distance(ball.pos, twin.pos)).toBeLessThan(0.05);
      // Le plateau levé : la réplique le voit monter
      const cat = catapult.player.bot!;
      catapult.send({ t: "input", input: { ...newInput(), weapon: "flipper", trigger: true } });
      tick(room, 0.1);
      catapult.send({ t: "input", input: { ...newInput(), weapon: "flipper" } });
      tick(room, 0.1);
      catapult.replica.flush();
      const plate = catapult.replica.player!.melee[0];
      expect(plate.phase).toBe(cat.melee[0].phase);
      expect(plate.swing).toBeCloseTo(cat.melee[0].swing, 3);
      expect(plate.swing).toBeGreaterThan(meleeDef("flipper").plate!.rest + 0.5);
      // La prise : un ennemi devant la mâchoire, saisi ; la réplique sait ce qu'elle tient
      const jaw = crusher.player.bot!;
      const prey = enemyAhead(room, jaw, 2.4);
      crusher.send({ t: "input", input: { ...newInput(), weapon: "jaw", trigger: true } });
      tick(room, 1);
      crusher.replica.flush();
      const held = jaw.melee[0].grip;
      expect(held?.block.bot).toBe(prey);
      expect(crusher.replica.player!.melee[0].grip?.block.id).toBe(held!.block.id);
      expect(crusher.replica.player!.melee[0].phase).toBe("hold");
    });
  });

  it("une bataille avec la Catapulte, le Broyeur et le Batteur de chaque côté se joue sans erreur, et ils frappent", { timeout: 300_000 }, () => {
    seedRandom(7);
    const w = new Simulation();
    sim = w;
    const roster = ["catapult", "crusher", "thresher", "scarab", "ram", "buggy"];
    spawnTeams(w, roster.flatMap((id, i) => [
      { profile: preset(id), team: "blue" as const },
      { profile: preset(roster[(i + 3) % roster.length]), team: "red" as const },
    ]));
    startMatch(w, { ...GAME_MODES.battle.match, timeLimit: 60 });
    const seen = hits(w);
    run(w, 60);
    const robot = seen.filter((h) => h.surface === "robot");
    const by = (weapon: string): number => robot.filter((h) => blockOf(h.block.type) === weapon).length;
    report("BATAILLE", { flipper: by("flipper"), jaw: by("jaw"), flail: by("flail"), coups: seen.length });
    expect(robot.length).toBeGreaterThan(2);
  });

  /*
   * Bilan (`MELEE_BATTLE=1 npx vitest run tests/meleeMechanics.test.ts --silent=false` ; `MELEE_SEEDS=1,2` : ces graines-là) : des
   * batailles où chaque équipe a sa Catapulte, son Broyeur et son Batteur, le reste tiré au sort ;
   * par robot, destructions, morts, temps renversé, coups portés ; le coût de l'étape « contact ».
   */
  it.runIf(!!env.MELEE_BATTLE)("bilan des frappes à mécanique en bataille", { timeout: 3_600_000 }, () => {
    const lines: string[] = [];
    const stats = new Map<string, { kills: number; deaths: number; flipped: number; hits: number; energy: number; killedBy: Map<string, number> }>();
    const of = (bot: Bot) => {
      let s = stats.get(botName(bot.profile));
      if (!s) stats.set(botName(bot.profile), (s = { kills: 0, deaths: 0, flipped: 0, hits: 0, energy: 0, killedBy: new Map() }));
      return s;
    };
    const ours = ["catapult", "crusher", "thresher"];
    let contact = 0;
    let total = 0;
    let steps = 0;
    for (const seed of (env.MELEE_SEEDS ?? "1,2,3,4,5,6").split(",").map(Number)) {
      seedRandom(seed);
      const w = new Simulation();
      sim = w;
      const others = PRESET_BOTS.filter((p) => ![...ours, "reaper", "pounder"].includes(p.id)).sort(() => Math.random() - 0.5).slice(0, 6);
      spawnTeams(w, [
        ...ours.flatMap((id) => [{ profile: preset(id), team: "blue" as const }, { profile: preset(id), team: "red" as const }]),
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
});

/** L'arme de contact d'un type de bloc. */
const blockOf = (type: keyof typeof BLOCK_TYPES): string | undefined => (BLOCK_TYPES[type] as { melee?: string }).melee;
