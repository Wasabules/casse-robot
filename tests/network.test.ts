import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ProgressBook } from "../src/server/progressBook";
import { Room, type Player } from "../src/server/room";
import { GAME_MODES } from "../src/shared/modes";
import { add, flatDistance, qrot, scale, sub, vec3 } from "../src/shared/math/vec";
import { utf8Decode, utf8Encode } from "../src/shared/net/binary";
import { decodeFrame, encodeFrame, PROTOCOL_VERSION, SNAPSHOT_EVERY, type ClientMessage, type RobotChoice, type ServerMessage } from "../src/shared/net/protocol";
import { Replica } from "../src/shared/net/replica";
import { WireDecoder, WireEncoder } from "../src/shared/net/wire";
import { readSnapshot, writeSnapshot } from "../src/shared/net/snapshot";
import type { Bot, Prop } from "../src/shared/sim/entities";
import { applyDamage, strike } from "../src/shared/combat/damage";
import { groundBelow, igniteProp, spawnGroundFire } from "../src/shared/combat/burning";
import { spawnProjectile } from "../src/shared/combat/projectiles";
import { rebuildBlock } from "../src/shared/combat/repair";
import type { SimEvent } from "../src/shared/sim/events";
import { newInput } from "../src/shared/sim/player";
import { initPhysics } from "../src/shared/sim/simulation";
import { energyFraction } from "../src/shared/robot/energy";
import { botJets, jetContact } from "../src/shared/robot/exhaust";
import { liftToWeight } from "../src/shared/robot/propulsion";
import { blockWorldPos, integrity, wheelLoad } from "../src/shared/robot/queries";
import { flapRuns } from "../src/shared/robot/surfaces";
import { steeringGeometry } from "../src/shared/robot/steering";
import { lockProgress, pilotLock } from "../src/shared/combat/lock";
import { readiness } from "../src/shared/combat/arsenal";
import { sightBlocked } from "../src/shared/combat/sight";
import { liveTurrets, turretFrame } from "../src/shared/combat/turrets";
import { liveMelee, meleeFrame, vibration } from "../src/shared/combat/melee";
import { meleeDef } from "../src/shared/catalog/melee";
import { weaponDef } from "../src/shared/catalog/weapons";
import { DesignGrid } from "../src/shared/design/robotDesign";
import { isDetected } from "../src/shared/sim/detection";
import { LETHAL } from "./helpers";
import { seedRandom } from "./seed";
import { refusalText } from "../src/client/i18n/names";
import { blankMap, checkMap, mapKey, validateMap, type MapFile } from "../src/shared/map";

/** L'avant d'un robot, à plat (unitaire). */
function qrotOf(bot: Bot): { x: number; z: number } {
  const f = qrot(bot.cockpit.part.rb.rotation(), vec3(0, 0, 1));
  const n = Math.hypot(f.x, f.z) || 1;
  return { x: f.x / n, z: f.z / n };
}

/** Un client en mémoire : ce que le serveur lui envoie va dans sa réplique. */
interface TestClient {
  player: Player;
  replica: Replica;
  texts: ServerMessage[];
  events: SimEvent[];
  send(msg: ClientMessage): void;
}

describe("multijoueur", () => {
  let room: Room;
  /** Le fil du serveur (net/wire.ts) : les images passent quantifiées, en écarts, comme par la WebSocket. */
  let wire: WireEncoder;

  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    seedRandom(21);
    room = new Room();
    wire = new WireEncoder();
  });
  afterEach(() => room.dispose());

  let tokens = 0;
  const connect = (name: string, robot: RobotChoice = { preset: "buggy" }, token = `jeton-de-test-${++tokens}-0000`): TestClient => {
    const replica = new Replica();
    const texts: ServerMessage[] = [];
    const events: SimEvent[] = [];
    replica.on((e) => events.push(e));
    const stream = wire.stream();
    const decoder = new WireDecoder();
    const player = room.connect({
      send: (data) => {
        if (typeof data === "string") texts.push(JSON.parse(data) as ServerMessage);
        else replica.receiveFrame(decoder.decode(stream.encode(data)));
      },
    });
    const client: TestClient = { player, replica, texts, events, send: (msg) => room.receive(player, JSON.stringify(msg)) };
    client.send({ t: "join", version: PROTOCOL_VERSION, name, robot, token });
    return client;
  };
  /** Avance d'un nombre entier d'images (la dernière est envoyée au dernier pas). */
  const run = (seconds: number): void => {
    const steps = Math.ceil((seconds * 60) / SNAPSHOT_EVERY) * SNAPSHOT_EVERY;
    for (let i = 0; i < steps; i++) room.tick();
  };

  /** La réplique d'un client est-elle le monde du serveur (après avoir rejoué toutes les images) ? */
  const expectSameWorld = (client: TestClient): void => {
    const replica = client.replica;
    replica.flush();
    const sim = room.sim;
    expect(replica.time).toBeCloseTo(sim.time, 6);
    expect(replica.bots.map((b) => b.id).sort()).toEqual(sim.bots.map((b) => b.id).sort());
    for (const bot of sim.bots) {
      const copy = replica.bots.find((b) => b.id === bot.id)!;
      expect(copy.profile.name, bot.profile.name).toBe(bot.profile.name);
      expect(copy.team).toBe(bot.team);
      expect(copy.cockpit.alive).toBe(bot.cockpit.alive);
      expect([...copy.blocks.keys()].sort()).toEqual([...bot.blocks.keys()].sort());
      expect([...copy.parts].map((p) => p.id).sort()).toEqual([...bot.parts].map((p) => p.id).sort());
      for (const block of bot.blocks.values()) {
        const twin = copy.blocks.get(block.key)!;
        expect(twin.id).toBe(block.id);
        expect(twin.part.id).toBe(block.part.id);
        expect(twin.hp).toBeCloseTo(block.hp, 3);
      }
      for (const part of bot.parts) {
        const twin = [...copy.parts].find((p) => p.id === part.id)!;
        const a = part.rb.translation();
        const b = twin.rb.translation();
        expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThan(1e-3);
      }
    }
    expect(replica.match?.score).toEqual(sim.match?.score);
    expect(replica.player?.id).toBe(client.player.bot?.id);
    // Ce que le HUD, le son et le rendu lisent d'un robot marche aussi sur la réplique (corps sans physique)
    for (const copy of replica.bots) {
      const bot = sim.bots.find((b) => b.id === copy.id)!;
      expect(integrity(copy)).toBeCloseTo(integrity(bot), 6);
      expect(energyFraction(copy)).toBeCloseTo(energyFraction(bot), 3);
      if (copy.cockpit.alive) {
        expect(wheelLoad(copy)).toBeCloseTo(wheelLoad(bot), 2);
        // (`Thruster.output` ne passe pas par le réseau : un moteur abîmé ne donne moins que sur le serveur)
        if (bot.thrusters.every((t) => t.output === 1)) expect(liftToWeight(copy)).toBeCloseTo(liftToWeight(bot), 2);
        steeringGeometry(copy);
        for (const b of copy.blocks.values()) blockWorldPos(b);
        // Le jet de flamme des moteurs (flammes qui butent, suie, flammèches) : la poussée passe par le réseau
        const jets = botJets(sim, bot);
        const seen = botJets(replica, copy);
        expect(seen.map((j) => j.thruster.block.id)).toEqual(jets.map((j) => j.thruster.block.id));
        seen.forEach((jet, i) => {
          expect(jet.length).toBeCloseTo(jets[i].length, 3);
          jetContact(replica, jet);
        });
        // La jauge du réticule : cadence, chargeur (coup en cours de rechargement compris), chaleur
        for (const t of liveTurrets(copy)) {
          const twin = bot.turrets.find((u) => u.block.id === t.block.id)!;
          const weapon = weaponDef(t.weapon);
          const mine = readiness([t.arm], weapon, copy.energy);
          const theirs = readiness([twin.arm], weapon, bot.energy);
          expect(mine.cause, t.weapon).toBe(theirs.cause);
          expect(mine.progress).toBeCloseTo(theirs.progress, 3);
          expect(mine.magazine?.next ?? 0).toBeCloseTo(theirs.magazine?.next ?? 0, 3);
        }
        // Les armes de contact : le régime d'un rotor, la phase d'un bras, la vibration du balourd
        for (const arm of liveMelee(copy)) {
          const twin = bot.melee.find((a) => a.block.id === arm.block.id)!;
          expect(arm.spin).toBeCloseTo(twin.spin, 3);
          expect(arm.phase).toBe(twin.phase);
        }
        expect(vibration(copy)).toBeCloseTo(vibration(bot), 3);
      }
    }
  };

  it("les messages et les instantanés font l'aller-retour", () => {
    expect(utf8Decode(utf8Encode("Éloïse · 机器人 🤖"))).toBe("Éloïse · 机器人 🤖");
    const frame = encodeFrame({ events: [{ t: "impact", point: vec3(1, 2, 3), surface: "robot" }], you: 42 }, new Uint8Array([7, 8, 9]));
    const { header, snapshot } = decodeFrame(frame);
    expect(header).toEqual({ events: [{ t: "impact", point: { x: 1, y: 2, z: 3 }, surface: "robot" }], you: 42 });
    expect([...snapshot]).toEqual([7, 8, 9]);

    run(1);
    const snap = readSnapshot(writeSnapshot(room.sim));
    expect(snap.time).toBe(room.sim.time);
    expect(snap.bots.size).toBe(room.sim.bots.length);
    expect(snap.parts.size).toBe(room.sim.parts.size);
    const part = [...room.sim.parts][0];
    const pose = snap.parts.get(part.id)!;
    expect(pose.pos.x).toBeCloseTo(part.rb.translation().x, 4);
    const bot = room.sim.bots[0];
    expect(snap.bots.get(bot.id)!.mode).toBe(bot.ai.mode);
  });

  it("un joueur rejoint la partie à la place d'un robot de l'IA, et sa réplique suit le monde du serveur", () => {
    const client = connect("Éloïse");
    expect(client.texts[0]).toMatchObject({ t: "welcome", player: client.player.id, bought: null });
    const bot = client.player.bot!;
    expect(bot.controller).toBe("player");
    expect(bot.profile.name).toBe("Éloïse");
    expect(room.sim.bots.filter((b) => b.team === bot.team)).toHaveLength(6);
    run(8);
    expect(room.sim.destroyedCount).toBeGreaterThan(0); // on s'est battu
    expectSameWorld(client);
    // Les vues de la réplique ont reçu de quoi tout construire, et le retour de tir
    expect(client.events.filter((e) => e.type === "blockAttached").length).toBeGreaterThan(100);
    expect(client.events.some((e) => e.type === "hit" && e.attacker !== null)).toBe(true);
  });

  it("un joueur qui arrive en cours de partie reçoit le monde tel qu'il est", () => {
    const first = connect("Aya");
    run(10);
    const late = connect("Bruno", { preset: "tank" });
    expect(late.player.team).not.toBe(first.player.team);
    run(1);
    expectSameWorld(first);
    expectSameWorld(late);
    expect(late.replica.player?.profile.name).toBe("Bruno");
  });

  it("la réplique suit les blocs qui repoussent et les murs d'énergie", () => {
    const client = connect("Gaëlle", { preset: "guardian" });
    run(1);
    const bot = client.player.bot!;
    const sim = room.sim;
    // Un bloc détruit, qui repousse
    const block = bot.blocks.get("2,1,-2")!;
    applyDamage(sim, bot.lastPos, vec3(0, -1, 0), LETHAL, { kind: "block", block }, add(bot.lastPos, vec3(0, 30, 0)));
    run(0.5);
    const late = connect("Hugo"); // il arrive quand le bloc est détruit
    run(0.5);
    expect(bot.lost.has("2,1,-2")).toBe(true);
    rebuildBlock(sim, block, 30);
    // Le Gardien déploie son mur
    const turret = bot.turrets.find((t) => t.weapon === "barrier")!;
    spawnProjectile(sim, "barrier", add(blockWorldPos(turret.block), vec3(0, 0.3, 0)), vec3(0, 0, bot.team === "blue" ? 1 : -1), { shooter: bot });
    run(1);
    expect(sim.barriers).toHaveLength(1);
    expectSameWorld(client);
    expectSameWorld(late);
    for (const c of [client, late]) {
      expect(c.events.some((e) => e.type === "blockRebuilt" && e.block.key === "2,1,-2")).toBe(true);
      expect(c.events.some((e) => e.type === "barrierAdded")).toBe(true);
    }
  });

  it("à la partie suivante, l'arène change, et les répliques suivent", () => {
    const client = connect("Inès");
    run(1);
    expect(client.replica.arena.id).toBe("depot");
    room.sim.match!.score.blue = 999;
    run(10); // fin de partie, puis la suivante 8 s plus tard
    expect(room.sim.arena.id).toBe("fort");
    client.replica.flush();
    expect(client.replica.arena.id).toBe("fort");
    expect(client.events.some((e) => e.type === "arenaChanged" && e.arena === "fort")).toBe(true);
    expectSameWorld(client);
    // Qui arrive maintenant reçoit l'arène en place
    const late = connect("Jo");
    run(1);
    late.replica.flush();
    expect(late.replica.arena.id).toBe("fort");
    expectSameWorld(late);
  });

  it("dans la Vallée, la réplique pose les accessoires ancrés à leur emplacement, puis suit ceux qui tombent", () => {
    room.sim.loadArena("valley");
    const client = connect("Val");
    run(1);
    client.replica.flush();
    expect(client.replica.arena.id).toBe("valley");
    // Les accessoires de la réplique, d'après ses événements
    const props = new Map<number, Prop>();
    for (const e of client.events) {
      if (e.type === "propAdded") props.set(e.prop.id, e.prop);
      if (e.type === "propRemoved") props.delete(e.prop.id);
    }
    expect(props.size).toBe(room.sim.props.length);
    const samePose = (a: Prop, b: Prop): void => {
      const p = a.rb.translation();
      const q = b.rb.translation();
      expect(Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z), a.type).toBeLessThan(0.05);
    };
    for (const prop of room.sim.props) {
      const copy = props.get(prop.id)!;
      expect(copy.type).toBe(prop.type);
      expect(copy.fixed).toBe(prop.fixed);
      expect(copy.half).toEqual(prop.half);
      samePose(prop, copy);
    }
    // Un arbre abattu sur le serveur : il est libéré dans la réplique, qui suit sa chute
    const tree = room.sim.props.find((p) => p.type === "oak")!;
    const at = tree.rb.translation();
    strike(room.sim, { kind: "prop", prop: tree }, 1e6, "explosive", at, vec3(1, 0, 0), 0, vec3(at.x - 5, at.y, at.z));
    run(2);
    client.replica.flush();
    const copy = props.get(tree.id)!;
    expect(copy.fixed).toBe(false);
    expect(client.events.some((e) => e.type === "propReleased" && e.prop === copy)).toBe(true);
    samePose(tree, copy);
    expect(tree.rb.translation().y).toBeLessThan(at.y - 0.5);
  });

  it("la réplique suit le bois qui brûle et les flaques de feu, même pour un joueur qui arrive", () => {
    room.sim.loadArena("valley");
    const client = connect("Flo");
    run(1);
    const sim = room.sim;
    const wall = sim.props.find((p) => p.type === "plank")!;
    igniteProp(sim, wall);
    const at = wall.rb.translation();
    const fire = spawnGroundFire(sim, groundBelow(sim, vec3(at.x + 3, at.y + 2, at.z + 3), 10)!, { radius: 2, life: 3 }, null)!;
    run(1.5);
    const late = connect("Gus");
    run(0.5);
    for (const c of [client, late]) {
      c.replica.flush();
      const copy = c.events.filter((e) => e.type === "propAdded").map((e) => e.prop).find((p) => p.id === wall.id)!;
      expect(copy.burn).toBeGreaterThan(0);
      expect(c.events.some((e) => e.type === "groundFireAdded" && e.fire.id === fire.id && e.fire.radius === 2)).toBe(true);
    }
    run(3);
    for (const c of [client, late]) {
      c.replica.flush();
      expect(c.events.some((e) => e.type === "groundFireRemoved" && e.fire.id === fire.id)).toBe(true);
      // Le bois noircit par crans, annoncés (le serveur en garde la valeur exacte)
      const copy = c.events.filter((e) => e.type === "propAdded").map((e) => e.prop).find((p) => p.id === wall.id)!;
      expect(copy.charred).toBeGreaterThanOrEqual(0.25);
      expect(copy.charred).toBeLessThanOrEqual(wall.charred);
    }
  });

  it("les tourelles qui visaient le robot remplacé par le joueur changent de cible", () => {
    run(2);
    const replaced = room.sim.bots.find((b) => b.team === "blue" && b.controller === "ai")!;
    for (const enemy of room.sim.bots.filter((b) => b.team === "red")) {
      for (const t of enemy.turrets) {
        t.target = replaced;
        t.retarget = 10;
      }
      enemy.ai.tactics.foe = replaced;
    }
    const client = connect("Hana");
    expect(client.player.team).toBe("blue");
    expect(room.sim.bots).not.toContain(replaced);
    expect(replaced.cockpit.alive).toBe(false);
    run(1); // sans lire les corps libérés du robot retiré
    expect(room.sim.bots.flatMap((b) => b.turrets).some((t) => t.target === replaced)).toBe(false);
  });

  it("les commandes du joueur pilotent son robot sur le serveur", () => {
    room.sim.combat = false;
    const client = connect("Chloé");
    run(1);
    const bot = client.player.bot!;
    const start = bot.lastPos;
    client.send({ t: "input", input: { ...newInput(), throttle: 1 } });
    run(3);
    expect(flatDistance(bot.lastPos, start)).toBeGreaterThan(4);
    // Des commandes aberrantes sont bornées
    client.send({ t: "input", input: { ...newInput(), throttle: 50, brake: 7, aim: { x: Infinity, y: 0, z: 0 } } });
    expect(client.player.input.throttle).toBe(1);
    expect(client.player.input.brake).toBe(1);
    expect(client.player.input.aim).toBeNull();
    client.send({ t: "input", input: { ...newInput(), brake: -3 } });
    expect(client.player.input.brake).toBe(0);
    // Le regard (la direction que suit un avion piloté à la souris) : ramené à l'unité, ou rien
    client.send({ t: "input", input: { ...newInput(), look: { x: 0, y: 3, z: 4 }, power: 4 } });
    expect(client.player.input.look).toEqual({ x: 0, y: 0.6, z: 0.8 });
    expect(client.player.input.power).toBe(1);
    for (const look of [{ x: Infinity, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, "haut", null]) {
      client.send({ t: "input", input: { ...newInput(), look: look as never } });
      expect(client.player.input.look).toBeNull();
    }
    // Le frein arrête le robot sur le serveur (l'IA figée : un coéquipier qui le poussait, selon les
    // robots tirés au sort, l'empêchait de s'arrêter)
    room.sim.aiPaused = true;
    client.send({ t: "input", input: { ...newInput(), throttle: 1 } });
    run(2);
    client.send({ t: "input", input: { ...newInput(), throttle: 1, brake: 1 } });
    run(1.5);
    const v = bot.cockpit.part.rb.linvel();
    expect(Math.hypot(v.x, v.z)).toBeLessThan(0.5);
  });

  it("le jet de flamme des moteurs se lit sur la réplique (sa poussée passe par le réseau)", () => {
    room.sim.combat = false;
    const client = connect("Jules", { preset: "dragster" });
    run(1);
    client.send({ t: "input", input: { ...newInput(), boost: true } });
    run(2);
    expectSameWorld(client);
    expect(botJets(client.replica, client.replica.player!).length).toBe(4);
  });

  it("le régime d'une arme de contact et ses coups arrivent dans la réplique", () => {
    const client = connect("Léa", { preset: "reaper" });
    run(1);
    room.sim.aiPaused = true;
    client.send({ t: "input", input: { ...newInput(), weapon: "spinner" } });
    run(3);
    expectSameWorld(client);
    const bot = client.player.bot!;
    const spinner = client.replica.player!.melee[0];
    expect(spinner.spin).toBeGreaterThan(0.9 * meleeDef("spinner").spin!.speed);
    // Un ennemi posé devant sa barre : le coup part du serveur et arrive dans la réplique. Posé son
    // bloc le plus avancé à 2 m du moyeu, et il faut que l'avant qu'il présente ait un bloc à la
    // hauteur de la barre, en face d'elle (un robot bas passe dessous ; la composition des équipes
    // change avec le catalogue des robots)
    const frame = meleeFrame(bot.melee[0]);
    const ahead = qrotOf(bot);
    const across = (o: { x: number; z: number }): number => o.x * ahead.z - o.z * ahead.x;
    const along = (o: { x: number; z: number }): number => o.x * ahead.x + o.z * ahead.z;
    const placement = (b: Bot): number | null => {
      const origin = [...b.parts][0].rb.translation();
      const offsets = [...b.blocks.values()].map((x) => {
        const p = blockWorldPos(x);
        return { o: { x: p.x - origin.x, z: p.z - origin.z }, level: Math.abs(p.y - frame.hub.y) < 0.3 };
      });
      const front = Math.min(...offsets.map(({ o }) => along(o)));
      const facing = offsets.some(({ o, level }) => level && along(o) - front < 0.6 && Math.abs(across(o)) < 0.8);
      return facing ? 2 - front : null;
    };
    const enemy = room.sim.bots.find((b) => b.team !== bot.team && b.cockpit.alive && b.profile.mobility === "ground" && b.parts.size === 1 && placement(b) !== null)!;
    const reach = placement(enemy)!;
    const rb = [...enemy.parts][0].rb;
    rb.setTranslation({ x: frame.hub.x + ahead.x * reach, y: rb.translation().y, z: frame.hub.z + ahead.z * reach }, true);
    rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
    client.send({ t: "input", input: { ...newInput(), weapon: "spinner", throttle: 0.5 } });
    run(3);
    client.replica.flush();
    // (le coup de sa barre : l'hélice d'un avion qui frôle quelque chose frappe aussi)
    const hit = client.events.find((e) => e.type === "meleeHit" && e.block.id === bot.melee[0].block.id);
    expect(hit?.type === "meleeHit" && hit.block.id).toBe(bot.melee[0].block.id);
    expectSameWorld(client);
  });

  it("le verrouillage de l'arme du joueur arrive dans sa réplique, pour son HUD", () => {
    // L'IA ne tire pas : une bombe tombée près de lui l'arrachait, selon les robots tirés au sort
    room.sim.combat = false;
    const g = new DesignGrid().box(-1, 1, 0, 0, -1, 1, "frame").put(0, 1, -1, "cockpit").put(0, 1, 1, "lockonLauncher");
    // Le lance-missiles à verrou se débloque avec des crédits de ce serveur
    room.book.get("jeton-verrou-00000000").credits = 1000;
    const client = connect("Inès", { name: "Verrou", color: "#ffcf5a", design: { blocks: g.blocks(), wheels: [] } }, "jeton-verrou-00000000");
    const bot = client.player.bot!;
    run(1);
    // Il garde dans son viseur l'ennemi repéré le plus proche qu'il voit (le décor coupe le verrou) ;
    // l'IA figée, la ligne de vue reste dégagée
    room.sim.aiPaused = true;
    const launcher = bot.turrets.find((t) => t.weapon === "lockon")!;
    const muzzle = turretFrame(launcher).muzzle;
    // (vu de la bouche au repos, et un demi-mètre de chaque côté : la tourelle la déplace en tournant
    // vers sa cible, et un ennemi vu de justesse au bord d'un mur s'y cachait)
    const side = scale(qrot(bot.cockpit.part.rb.rotation(), vec3(1, 0, 0)), 0.5);
    const inSight = (b: Bot): boolean => [muzzle, add(muzzle, side), sub(muzzle, side)].every((p) => !sightBlocked(room.sim, p, b));
    const target = room.sim.bots
      .filter((b) => b.team !== bot.team && b.cockpit.alive && isDetected(room.sim, bot.team, b) && inSight(b))
      .sort((a, b) => flatDistance(a.lastPos, bot.lastPos) - flatDistance(b.lastPos, bot.lastPos))[0];
    expect(target).toBeDefined();
    for (let i = 0; i < 60; i++) {
      if (target.cockpit.alive) client.send({ t: "input", input: { ...newInput(), weapon: "lockon", scope: true, aim: target.cockpit.part.rb.worldCom() } });
      room.tick();
    }
    run(0.1);
    const locking = pilotLock(bot);
    expect(locking?.lockOn).toBe(target);
    expect(lockProgress(locking!)).toBeGreaterThan(0.5);
    client.replica.flush();
    const twin = client.replica.player!.turrets.find((t) => t.block.id === locking!.block.id)!;
    expect(twin.lockOn?.id).toBe(target.id);
    expect(lockProgress(twin)).toBeCloseTo(lockProgress(locking!), 5);
  });

  it("un robot détruit réapparaît et reste celui du joueur ; un joueur qui part rend son robot à l'IA", () => {
    const client = connect("Dan");
    run(0.5);
    const first: Bot = client.player.bot!;
    room.receive(client.player, JSON.stringify({ t: "selfDestruct" }));
    expect(first.cockpit.alive).toBe(false);
    run(7);
    const second = client.player.bot!;
    expect(second).not.toBe(first);
    expect(second.cockpit.alive).toBe(true);
    expect(second.controller).toBe("player");
    expectSameWorld(client);
    room.disconnect(client.player);
    expect(second.controller).toBe("ai");
    expect(room.playerCount).toBe(0);
  });

  it("le serveur garde la progression : pièces à débloquer avec ses crédits, crédits gagnés en fin de partie", () => {
    const g = new DesignGrid().box(-1, 1, 0, 0, -1, 1, "frame").put(0, 1, -1, "cockpit").put(0, 1, 1, "cannonTurret");
    const tank: RobotChoice = { name: "Canon", color: "#6b7a4a", design: { blocks: g.blocks(), wheels: [] } };
    // Sans crédits sur ce serveur, la tourelle canon (250) n'est pas débloquée : refusé
    const poor = connect("Hugo", tank, "jeton-hugo-000000000");
    expect(poor.texts[0].t).toBe("refused");
    const refused = poor.texts[0];
    expect(refused.t === "refused" && refused.refusal).toEqual({ code: "locked", parts: [{ kind: "block", type: "cannonTurret" }], price: 250, credits: 0 });
    // Le client le dit dans la langue du joueur
    if (refused.t === "refused") expect(refusalText(refused.refusal)).toContain("Tourelle canon");
    // Avec des crédits, elle se débloque en rejoignant
    room.book.get("jeton-ines-000000000").credits = 300;
    const rich = connect("Inès", tank, "jeton-ines-000000000");
    const welcome = rich.texts[0];
    expect(welcome.t).toBe("welcome");
    if (welcome.t !== "welcome") return;
    expect(welcome.bought?.parts).toEqual([{ kind: "block", type: "cannonTurret" }]);
    expect(welcome.progress.credits).toBe(50);
    expect(room.book.get("jeton-ines-000000000").unlocked).toContain("block:cannonTurret");
    // Un robot prédéfini est toujours accepté ; la fin de partie rapporte des crédits
    const free = connect("Jade", { preset: "tank" }, "jeton-jade-000000000");
    expect(free.texts[0].t).toBe("welcome");
    run(1);
    room.sim.match!.score[free.player.team] = GAME_MODES.battle.match.scoreToWin;
    run(0.1);
    const progress = free.texts.find((m) => m.t === "progress");
    expect(progress?.t).toBe("progress");
    if (progress?.t !== "progress") return;
    expect(progress.reward.lines.map((l) => l.kind)).toContain("win");
    expect(room.book.get("jeton-jade-000000000").credits).toBe(progress.reward.total);
    // Un jeton illisible est refusé
    const texts: string[] = [];
    const anon = room.connect({ send: (d) => texts.push(String(d)) });
    room.receive(anon, JSON.stringify({ t: "join", version: PROTOCOL_VERSION, name: "Kim", robot: { preset: "buggy" }, token: "x" }));
    expect(JSON.parse(texts[0]).t).toBe("refused");
  });

  it("les progressions du serveur s'enregistrent et se relisent", () => {
    const book = new ProgressBook();
    book.get("jeton-lea-0000000000").credits = 420;
    book.get("jeton-lea-0000000000").unlocked.push("block:railTurret");
    const copy = new ProgressBook();
    copy.load(JSON.parse(JSON.stringify(book)));
    expect(copy.get("jeton-lea-0000000000")).toEqual({ credits: 420, unlocked: ["block:railTurret"] });
    // Ce qui est illisible est ignoré
    copy.load({ "trop court": { credits: 5 }, "jeton-max-0000000000": { credits: -3, unlocked: "rien" } });
    expect(copy.get("jeton-max-0000000000")).toEqual({ credits: 0, unlocked: [] });
  });

  it("la réplique retrouve les rangs de gouvernes et leur braquage (un par rang dans l'instantané), même quand un rang se coupe", () => {
    const client = connect("Hugo", { preset: "plane" });
    const bot = client.player.bot!;
    const runs = (b: Bot): string[] => flapRuns(b).map((r) => r.map((s) => s.block.id).sort((x, y) => x - y).join(",")).sort();
    const same = (): void => {
      client.replica.flush();
      const copy = client.replica.bots.find((b) => b.id === bot.id)!;
      expect(runs(copy)).toEqual(runs(bot));
      for (const s of bot.surfaces) {
        if (!s.block.alive) continue;
        const twin = copy.surfaces.find((t) => t.block.id === s.block.id)!;
        expect(twin.deflection).toBeCloseTo(s.deflection, 5);
      }
    };
    run(2);
    expect(bot.cockpit.alive).toBe(true);
    expect(bot.surfaces.some((s) => Math.abs(s.deflection) > 0.01)).toBe(true);
    same();
    // Un bloc détruit au milieu de la profondeur : deux rangs, de part et d'autre (le nombre de rangs d'avant dépend
    // de ce que les tirs de l'IA ont déjà emporté de l'avion, la dérive par exemple)
    const before = runs(bot).length;
    applyDamage(room.sim, bot.lastPos, vec3(0, -1, 0), LETHAL, { kind: "block", block: bot.blocks.get("0,0,-6")! }, vec3(0, 60, 0));
    expect(runs(bot)).toHaveLength(before + 1);
    run(1);
    same();
  });

  it("une carte communautaire : le serveur l'envoie une fois à qui ne l'a pas, la réplique la reconstruit", () => {
    const map: MapFile = {
      ...blankMap({ name: "Carte du réseau", author: "Tests", half: 70 }),
      prefabs: [
        { kind: "house", x: 25, z: 20, width: 8, depth: 6, height: 3, wall: "brick", roof: "roof", door: 2 },
        { kind: "woods", x: -30, z: -20, radius: 14, count: 8, seed: 5 },
      ],
      props: [{ type: "barrel", x: 6, z: 10 }, { type: "crate", x: -6, z: 10 }],
    };
    expect(validateMap(map)).toEqual([]);
    const key = mapKey(map);
    room.dispose();
    room = new Room(new ProgressBook(), { maps: [map], mapsOnly: true });
    expect(room.rotation).toEqual([key]);
    expect(room.sim.arena.id).toBe(key);
    // Un client qui ne l'a pas : il la reçoit avant la première image, la vérifie, et sa réplique la construit
    const client = connect("Lou");
    const sent = client.texts.filter((m): m is Extract<ServerMessage, { t: "map" }> => m.t === "map");
    expect(sent.map((m) => m.key)).toEqual([key]);
    const check = checkMap(JSON.parse(JSON.stringify(sent[0].map)));
    expect(check.issues).toEqual([]);
    expect(check.key).toBe(key);
    client.replica.addArena(check.arena!);
    run(1);
    client.replica.flush();
    expect(client.replica.arena.id).toBe(key);
    expect(client.replica.arena.community?.name).toBe("Carte du réseau");
    expect(client.replica.missingArena).toBeNull();
    expect(client.replica.arena.props.length).toBe(room.sim.arena.props.length);
    expect(client.replica.arena.terrain?.heights).toEqual(room.sim.arena.terrain?.heights);
    expect(client.events.some((e) => e.type === "arenaChanged" && e.arena === key)).toBe(true);
    expectSameWorld(client);
    // Les accessoires de la carte (posés d'après leur emplacement) sont à la même place que sur le serveur
    for (const prop of room.sim.props.filter((p) => p.fixed)) {
      const twin = [...client.replica.props].find((p) => p.id === prop.id)!;
      expect(flatDistance(twin.rb.translation(), prop.rb.translation())).toBeLessThan(1e-3);
    }
    // À la partie suivante (la même carte), rien n'est renvoyé
    const before = client.texts.length;
    room.sim.match!.score.blue = 999;
    run(10);
    expect(client.texts.slice(before).some((m) => m.t === "map")).toBe(false);
    // Un client qui l'a déjà (il l'annonce en rejoignant) ne la reçoit pas : il la trouve chez lui
    const replica = new Replica();
    replica.resolveArena = (k) => (k === key ? check.arena! : undefined);
    const texts: ServerMessage[] = [];
    const player = room.connect({ send: (d) => (typeof d === "string" ? texts.push(JSON.parse(d) as ServerMessage) : replica.receive(d)) });
    room.receive(player, JSON.stringify({ t: "join", version: PROTOCOL_VERSION, name: "Max", robot: { preset: "buggy" }, token: "jeton-de-max-000000", maps: [key, "map-pas-une-cle", 42] }));
    expect(texts.map((m) => m.t)).toEqual(["welcome"]);
    run(1);
    replica.flush();
    expect(replica.arena.id).toBe(key);
  });

  it("une carte venue d'un paquet : le message porte l'empreinte de ses ressources, la réplique a la même carte et les mêmes ressources", () => {
    const map: MapFile = {
      ...blankMap({ name: "Carte en paquet", author: "Tests", half: 60 }),
      props: [{ type: "crate", x: -6, z: 10 }],
      assets: { models: { crate: { sha256: "a".repeat(64), bytes: 45328 } }, ambience: { sha256: "b".repeat(64), bytes: 209282 } },
    };
    expect(validateMap(map)).toEqual([]);
    const key = mapKey(map);
    const { assets: _a, ...plain } = map;
    expect(key).not.toBe(mapKey(plain));
    room.dispose();
    room = new Room(new ProgressBook(), { maps: [map], mapsOnly: true });
    expect(room.sim.arena.assets).toEqual(map.assets);
    const client = connect("Lou");
    const sent = client.texts.find((m): m is Extract<ServerMessage, { t: "map" }> => m.t === "map")!;
    const check = checkMap(JSON.parse(JSON.stringify(sent.map)));
    expect(check.issues).toEqual([]);
    expect(check.key).toBe(key);
    client.replica.addArena(check.arena!);
    run(1);
    client.replica.flush();
    expect(client.replica.arena.id).toBe(key);
    expect(client.replica.arena.assets).toEqual(map.assets);
  });

  it("le serveur refuse un plan invalide ou une autre version du jeu ; il accepte un avion", () => {
    const bad = connect("Eve", { name: "Tas", color: "#ff0000", design: { blocks: [], wheels: [] } });
    expect(bad.texts[0].t).toBe("refused");
    const plane = connect("Fred", { preset: "plane" });
    expect(plane.texts[0].t).toBe("welcome");
    expect(plane.player.bot?.profile.mobility).toBe("plane");
    room.disconnect(plane.player);
    const old = room.connect({ send: () => {} });
    const texts: string[] = [];
    const other = room.connect({ send: (d) => texts.push(String(d)) });
    room.receive(other, JSON.stringify({ t: "join", version: PROTOCOL_VERSION + 1, name: "Gus", robot: { preset: "buggy" }, token: "jeton-de-gus-000000" }));
    expect(JSON.parse(texts[0]).t).toBe("refused");
    expect(old.profile).toBeNull();
    expect(room.playerCount).toBe(0);
  });
});
