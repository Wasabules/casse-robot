import type { Collider, RigidBody } from "@dimforge/rapier3d-compat";
import { ARENAS, DEFAULT_ARENA, isArenaId, isMapKey, spotPose, type ArenaLayout, type MapKey } from "../arena/layout";
import { BLOCK_TYPES } from "../catalog/blocks";
import { propHalf, propHp } from "../catalog/props";
import { weaponDef, type WeaponId } from "../catalog/weapons";
import { wheelDef } from "../catalog/wheels";
import { cellKey, type WheelMount } from "../design/robotDesign";
import { clamp } from "../math/scalar";
import { add, scale, sub, vec3, type Quat, type Vec3 } from "../math/vec";
import { addThruster, addThrusters, newBlock, newBot, registerOrgans, wheelLocalPos } from "../robot/lifecycle";
import { applyMechanics } from "../combat/mechanics";
import { flapRuns } from "../robot/surfaces";
import type { ArmState, Barrier, Block, Bot, Debris, GroundFire, Part, Projectile, Prop, SmokeCloud, Team, Wheel, WheelBody } from "../sim/entities";
import type { SimEvent, SimListener } from "../sim/events";
import { newZones, type Match, type MatchRules } from "../sim/match";
import type { World } from "../sim/world";
import { decodeFrame, INTERP_DELAY, type BotDesc, type FrameHeader, type LockState, type NetEvent } from "./protocol";
import { readSnapshot, type BodyPose, type Snapshot } from "./snapshot";
import { dcos, dsin } from "../math/det";

/*
 * Côté client : réplique du monde du serveur. Elle reconstruit les mêmes entités (robots,
 * morceaux, blocs, roues, accessoires, débris, projectiles) que la simulation, mais sans
 * physique : leurs corps (`PoseBody`) ne font que porter la pose reçue. Les images reçues sont
 * rejouées avec INTERP_DELAY de retard : leurs événements au moment où leur temps est atteint (la
 * réplique émet alors les mêmes SimEvent que la simulation, pour le rendu, le son et le HUD), et
 * les poses interpolées entre deux images. Tout ce qui lit un `World` fonctionne donc de même en
 * partie locale et en multijoueur.
 */

/** Écart entre le temps affiché et celui visé au-delà duquel on saute plutôt que de rattraper (s). */
const RESYNC = 0.5;
/** Part de l'écart rattrapée à chaque image. */
const CATCH_UP = 0.1;

/** Corps d'une entité répliquée : il porte la pose reçue du serveur. Il imite ce que le client lit d'un corps Rapier. */
export class PoseBody {
  pos: Vec3 = vec3(0, 0, 0);
  rot: Quat = { x: 0, y: 0, z: 0, w: 1 };
  vel: Vec3 = vec3(0, 0, 0);
  ang: Vec3 = vec3(0, 0, 0);
  com: Vec3 | null = null;
  massValue = 0;
  readonly handle = -1;

  translation(): Vec3 {
    return { ...this.pos };
  }

  rotation(): Quat {
    return { ...this.rot };
  }

  linvel(): Vec3 {
    return { ...this.vel };
  }

  angvel(): Vec3 {
    return { ...this.ang };
  }

  worldCom(): Vec3 {
    return { ...(this.com ?? this.pos) };
  }

  mass(): number {
    return this.massValue;
  }
}

const newBody = (): RigidBody => new PoseBody() as unknown as RigidBody;
const poseOf = (rb: RigidBody | WheelBody | null): PoseBody => rb as unknown as PoseBody;
const NO_COLLIDER = null as unknown as Collider;
interface Frame {
  time: number;
  header: FrameHeader;
  snap: Snapshot;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerpVec = (a: Vec3, b: Vec3, t: number): Vec3 => add(a, scale(sub(b, a), t));
/** Écart angulaire le plus court de a à b (rad). */
const angleDelta = (a: number, b: number): number => Math.atan2(dsin(b - a), dcos(b - a));

/** Interpolation sphérique normalisée (nlerp) : suffisante entre deux images rapprochées. */
function nlerp(a: Quat, b: Quat, t: number): Quat {
  const s = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w < 0 ? -1 : 1;
  const q = { x: lerp(a.x, s * b.x, t), y: lerp(a.y, s * b.y, t), z: lerp(a.z, s * b.z, t), w: lerp(a.w, s * b.w, t) };
  const n = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
}

function blendPose(body: PoseBody, a: BodyPose | undefined, b: BodyPose | undefined, t: number): void {
  const from = a ?? b;
  if (!from) return;
  const to = b ?? from;
  body.pos = lerpVec(from.pos, to.pos, t);
  body.rot = nlerp(from.rot, to.rot, t);
}

export class Replica implements World {
  readonly bots: Bot[] = [];
  /** Temps simulé de l'instant affiché. */
  time = 0;
  player: Bot | null = null;
  match: Match | null = null;
  arena: ArenaLayout = ARENAS[DEFAULT_ARENA];
  /**
   * Les cartes communautaires que le client a déjà (livrées avec le jeu, importées, gardées d'une
   * partie précédente) : le serveur ne les envoie pas, la réplique les demande ici.
   */
  resolveArena: ((key: MapKey) => ArenaLayout | undefined) | null = null;
  /** L'arène que le serveur a mise en place sans que la réplique la connaisse (une carte non reçue), ou null. */
  missingArena: string | null = null;
  readonly detected = new Map<Team, Set<Bot>>([["red", new Set()], ["blue", new Set()]]);
  /** Cartes communautaires reçues du serveur (message `map`), par identifiant. */
  private readonly maps = new Map<MapKey, ArenaLayout>();
  /** Blocs détruits depuis l'arrivée du joueur (statistique du HUD). */
  destroyedCount = 0;
  /**
   * Retard de l'instant affiché sur la dernière image reçue (s) : INTERP_DELAY du serveur de jeu ;
   * bien plus court pour une partie solo, dont les images arrivent à chaque image (net/session.ts).
   */
  delay = INTERP_DELAY;
  /** Partie solo : nombre de nouveaux mondes reçus (images `reset` appliquées). */
  resets = 0;
  /** Partie solo : l'état des armes de la caméra libre (son HUD), d'après la dernière image. */
  freeArms: ReadonlyMap<WeaponId, ArmState> | null = null;
  /** Partie solo, mesure active : temps cumulés de chaque étape des pas reçus, et leur nombre (la mesure du rendu). */
  readonly simProfile = { times: {} as Record<string, number>, steps: 0 };

  private readonly listeners = new Set<SimListener>();
  private readonly botsById = new Map<number, Bot>();
  private readonly partsById = new Map<number, Part>();
  private readonly blocksById = new Map<number, Block>();
  private readonly wheelsById = new Map<number, Wheel>();
  private readonly debrisById = new Map<number, Debris>();
  private readonly propsById = new Map<number, Prop>();
  private readonly projectilesById = new Map<number, Projectile>();

  /** Projectiles en vol et mines posées (voir `World`). */
  get projectiles(): Iterable<Projectile> {
    return this.projectilesById.values();
  }
  /** Accessoires présents (voir `World`). */
  get props(): Iterable<Prop> {
    return this.propsById.values();
  }
  /** Flaques de feu au sol (voir `World`). */
  get groundFires(): Iterable<GroundFire> {
    return this.groundFiresById.values();
  }
  private readonly smokesById = new Map<number, SmokeCloud>();
  private readonly barriersById = new Map<number, Barrier>();
  private readonly groundFiresById = new Map<number, GroundFire>();
  private readonly queue: Frame[] = [];
  private current: Frame | null = null;
  private clock: number | null = null;

  on(listener: SimListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Nombre de corps répliqués (statistique du HUD). */
  get bodies(): number {
    return this.partsById.size + this.wheelsById.size + this.debrisById.size + this.propsById.size;
  }

  /** Retard entre la dernière image reçue et l'instant affiché (s). */
  get lag(): number {
    const last = this.queue.at(-1) ?? this.current;
    return last && this.clock !== null ? last.time - this.clock : 0;
  }

  /** Une carte communautaire reçue du serveur (déjà vérifiée : `checkMap`), pour quand il la mettra en place. */
  addArena(arena: ArenaLayout): void {
    if (isMapKey(arena.id)) this.maps.set(arena.id, arena);
  }

  /** L'arène de cet identifiant : une arène du jeu, une carte reçue, ou une carte que le client a déjà. */
  private arenaFor(id: unknown): ArenaLayout | undefined {
    if (isArenaId(id)) return ARENAS[id];
    if (!isMapKey(id)) return undefined;
    return this.maps.get(id) ?? this.resolveArena?.(id);
  }

  /** Une image reçue du serveur. */
  receive(bytes: Uint8Array): void {
    const { header, snapshot } = decodeFrame(bytes);
    const snap = readSnapshot(snapshot);
    // Partie solo, un nouveau monde : il s'affiche tout de suite (comme une première image), même partie figée
    if (header.reset) {
      this.queue.length = 0;
      this.current = null;
      this.clock = null;
    }
    this.queue.push({ time: snap.time, header, snap });
  }

  /**
   * Le temps passe de `dt` : on rejoue les images dont l'heure est venue (INTERP_DELAY derrière la
   * dernière reçue), puis on interpole les poses entre l'image courante et la suivante.
   */
  advance(dt: number): void {
    const newest = this.queue.at(-1) ?? this.current;
    if (!newest) return;
    const target = newest.time - this.delay;
    if (this.clock === null || Math.abs(target - this.clock) > RESYNC) this.clock = target;
    else this.clock += dt + (target - this.clock) * CATCH_UP;
    // La première image s'affiche tout de suite, même si elle est plus récente que l'instant visé
    if (!this.current && this.queue.length) this.clock = Math.max(this.clock, this.queue[0].time);
    while (this.queue.length && this.queue[0].time <= this.clock) this.apply(this.queue.shift()!);
    const a = this.current;
    if (!a) return;
    const b = this.queue[0];
    const t = b ? clamp((this.clock - a.time) / (b.time - a.time), 0, 1) : 0;
    this.time = b ? lerp(a.time, b.time, t) : a.time;
    this.interpolate(a.snap, b?.snap, t);
  }

  /** Rejoue d'un coup toutes les images reçues : le monde affiché est celui de la dernière (tests, reprise). */
  flush(): void {
    while (this.queue.length) this.apply(this.queue.shift()!);
    if (!this.current) return;
    this.clock = this.current.time;
    this.time = this.current.time;
    this.interpolate(this.current.snap, undefined, 0);
  }

  /** Oublie tout (fin de la session) : les vues reçoivent les retraits de toutes les entités. */
  clear(): void {
    this.forgetWorld();
    this.queue.length = 0;
    this.current = null;
    this.clock = null;
    this.match = null;
  }

  /** Retire toutes les entités (les vues en reçoivent les retraits). */
  private forgetWorld(): void {
    for (const bot of [...this.bots]) this.removeBot(bot);
    for (const id of [...this.propsById.keys()]) this.onNet({ t: "propGone", id });
    for (const id of [...this.debrisById.keys()]) this.onNet({ t: "debrisGone", id });
    for (const id of [...this.projectilesById.keys()]) this.onNet({ t: "projectileGone", id });
    for (const id of [...this.smokesById.keys()]) this.onNet({ t: "smokeGone", id });
    for (const id of [...this.barriersById.keys()]) this.onNet({ t: "barrierGone", id, broken: false });
    for (const id of [...this.groundFiresById.keys()]) this.onNet({ t: "groundFireGone", id });
  }

  private emit(e: SimEvent): void {
    for (const l of this.listeners) l(e);
  }

  // --- Images ---

  private apply(frame: Frame): void {
    // Partie solo : un nouveau monde (une autre partie, une autre vague) remplace l'ancien
    if (frame.header.reset) {
      this.forgetWorld();
      this.resets++;
    }
    this.current = frame;
    for (const e of frame.header.events) this.onNet(e, frame.snap);
    this.player = frame.header.you !== null ? this.botsById.get(frame.header.you) ?? null : null;
    this.applyStates(frame.snap);
    this.applyLock(frame.header.lock ?? null);
    // Partie solo : ce que les images du serveur n'ont pas
    if (frame.header.arms) this.freeArms = new Map(frame.header.arms);
    const profile = frame.header.profile;
    if (profile) {
      for (const [k, t] of Object.entries(profile.times)) this.simProfile.times[k] = (this.simProfile.times[k] ?? 0) + t;
      this.simProfile.steps += profile.steps;
    }
  }

  /** Verrouillage en cours de l'arme du joueur, que lit son HUD (voir combat/lock.ts). */
  private applyLock(lock: LockState | null): void {
    if (!this.player) return;
    for (const t of this.player.turrets) {
      const spec = weaponDef(t.weapon).lock;
      const mine = lock !== null && t.block.id === lock.turret;
      t.lockOn = mine ? this.botsById.get(lock.target) ?? null : null;
      t.lockTime = mine && spec ? lock.progress * spec.time : 0;
    }
  }

  /** États discrets de l'image : robots, roues (porteur, porte-moyeu), accessoires, partie, détection. */
  private applyStates(snap: Snapshot): void {
    for (const [id, s] of snap.bots) {
      const bot = this.botsById.get(id);
      if (!bot) continue;
      bot.controller = s.player ? "player" : "ai";
      bot.energy = s.energy;
      bot.flares.charges = s.flares;
      bot.ai.mode = s.mode;
      bot.stunnedUntil = s.stunnedUntil;
      bot.righting = s.righting;
      bot.flippedFor = s.flippedFor;
      bot.lastAttacker = this.botsById.get(s.lastAttacker) ?? null;
      for (const t of bot.turrets) {
        const ts = s.turrets.get(t.block.id);
        if (!ts) continue;
        t.arm.ammo = ts.ammo;
        t.arm.heat = ts.heat;
        t.arm.overheated = ts.overheated;
        t.arm.cooldown = ts.cooldown;
        t.arm.restock = ts.restock;
      }
      for (const th of bot.thrusters) {
        const ts = s.thrusters.get(th.block.id);
        if (!ts) continue;
        th.thrust = ts.thrust;
        th.tiltA = ts.tiltA;
        th.tiltB = ts.tiltB;
      }
      // Un braquage par rang de gouvernes : le serveur le nomme par l'un de ses blocs
      for (const run of flapRuns(bot)) {
        const named = run.find((f) => s.surfaces.has(f.block.id));
        if (!named) continue;
        const deflection = s.surfaces.get(named.block.id)!;
        for (const f of run) f.deflection = deflection;
      }
    }
    for (const [id, s] of snap.wheels) {
      const wheel = this.wheelsById.get(id);
      if (!wheel) continue;
      wheel.part = this.partsById.get(s.part) ?? null;
      if (!s.hub) unmount(wheel);
      wheel.drive = s.drive;
      wheel.steer = s.steer;
    }
    for (const [id, s] of snap.props) {
      const prop = this.propsById.get(id);
      if (!prop) continue;
      if (s.state === 2 && prop.state.kind !== "venting") prop.state = { kind: "venting", left: 1, leak: s.leak };
      else if (s.state === 1 && prop.state.kind === "intact") prop.state = { kind: "fuse", left: 1 };
    }
    const match = this.match;
    if (match && snap.match) {
      match.score.red = snap.match.score.red;
      match.score.blue = snap.match.score.blue;
      match.elapsed = snap.match.elapsed;
      match.winner = snap.match.winner;
      match.respawns.length = 0;
      for (const [id, at] of snap.match.respawns) {
        const bot = this.botsById.get(id);
        if (bot) match.respawns.push({ bot, at });
      }
      snap.match.zones.forEach(([owner, progress, contested, active], i) => {
        const zone = match.zones[i];
        if (!zone) return;
        zone.owner = owner;
        zone.progress = progress;
        zone.contested = contested;
        zone.active = active;
      });
    }
    for (const team of ["red", "blue"] as const) {
      const seen = this.detected.get(team)!;
      seen.clear();
      for (const id of snap.detected[team]) {
        const bot = this.botsById.get(id);
        if (bot) seen.add(bot);
      }
    }
  }

  /** Poses interpolées entre l'image courante `a` et la suivante `b` (t de 0 à 1). */
  private interpolate(a: Snapshot, b: Snapshot | undefined, t: number): void {
    for (const [id, part] of this.partsById) {
      const pa = a.parts.get(id);
      const pb = b?.parts.get(id);
      const body = poseOf(part.rb);
      blendPose(body, pa, pb, t);
      const from = pa ?? pb;
      if (!from) continue;
      const to = pb ?? from;
      body.vel = lerpVec(from.vel, to.vel, t);
      body.ang = lerpVec(from.ang, to.ang, t);
      body.com = lerpVec(from.com, to.com, t);
      body.massValue = to.mass;
    }
    for (const [id, wheel] of this.wheelsById) {
      const wa = a.wheels.get(id);
      const wb = b?.wheels.get(id);
      blendPose(poseOf(wheel.rb), wa, wb, t);
      if (wheel.hub) blendPose(poseOf(wheel.hub), wa?.hub ?? undefined, wb?.hub ?? undefined, t);
    }
    for (const [id, d] of this.debrisById) blendPose(poseOf(d.rb), a.debris.get(id), b?.debris.get(id), t);
    for (const [id, p] of this.propsById) blendPose(poseOf(p.rb), a.props.get(id), b?.props.get(id), t);
    for (const [id, p] of this.projectilesById) {
      const pa = a.projectiles.get(id);
      const pb = b?.projectiles.get(id);
      const from = pa ?? pb;
      if (!from) continue;
      const to = pb ?? from;
      p.pos = lerpVec(from.pos, to.pos, t);
      p.vel = from.vel;
      p.age = lerp(from.age, to.age, t);
      // Une mine immobile est posée (celle qui bondit ou qui est collée à un robot bouge)
      p.landed = !!weaponDef(p.weapon).projectile.mine && Math.hypot(p.vel.x, p.vel.y, p.vel.z) < 0.01;
    }
    for (const bot of this.bots) {
      const sa = a.bots.get(bot.id);
      const sb = b?.bots.get(bot.id);
      const from = sa ?? sb;
      if (!from) continue;
      const to = sb ?? from;
      bot.lastPos = lerpVec(from.lastPos, to.lastPos, t);
      for (const turret of bot.turrets) {
        const ta = from.turrets.get(turret.block.id);
        if (!ta) continue;
        const tb = to.turrets.get(turret.block.id) ?? ta;
        turret.yaw = ta.yaw + angleDelta(ta.yaw, tb.yaw) * t;
        turret.pitch = lerp(ta.pitch, tb.pitch, t);
      }
      for (const support of bot.supports) {
        const ua = from.supports.get(support.block.id);
        if (!ua) continue;
        const ub = to.supports.get(support.block.id) ?? ua;
        // (un appui en l'air a une distance au sol infinie : entre l'air et le sol, pas de moyenne, NaN)
        support.contact = Number.isFinite(ua.contact) && Number.isFinite(ub.contact) ? lerp(ua.contact, ub.contact, t) : t < 0.5 ? ua.contact : ub.contact;
        support.force = lerp(ua.force, ub.force, t);
        support.phase = lerp(ua.phase, ub.phase, t);
      }
      // Armes de contact : le régime et l'angle du bras (le rendu fait tourner le rotor de lui-même),
      // et la morsure en cours d'une lame (son point suit la lame d'une image à l'autre)
      for (const arm of bot.melee) {
        const ma = from.melee.get(arm.block.id);
        if (!ma) {
          arm.bite = null;
          continue;
        }
        const mb = to.melee.get(arm.block.id) ?? ma;
        arm.spin = lerp(ma.spin, mb.spin, t);
        arm.phase = ma.phase;
        arm.swing = lerp(ma.swing, mb.swing, t);
        const ba = ma.bite;
        const bb = mb.bite;
        arm.bite = ba && bb
          ? { ...ba, point: vec3(lerp(ba.point.x, bb.point.x, t), lerp(ba.point.y, bb.point.y, t), lerp(ba.point.z, bb.point.z, t)), power: lerp(ba.power, bb.power, t) }
          : ba;
        // Une frappe à mécanique : la proie d'une mâchoire, la boule d'un fléau (combat/mechanics.ts)
        const held = ma.link ? this.blocksById.get(ma.link) ?? null : null;
        applyMechanics(arm, held?.alive ? held : null, ma.values, mb.values, t);
      }
    }
  }

  // --- Événements ---

  private onNet(e: NetEvent, snap?: Snapshot): void {
    switch (e.t) {
      case "bot":
        this.addBot(e.bot, snap);
        break;
      case "botGone": {
        const bot = this.botsById.get(e.id);
        if (bot) this.removeBot(bot);
        break;
      }
      case "part": {
        const bot = this.botsById.get(e.bot);
        if (bot) this.emit({ type: "partAdded", part: this.addPart(e.id, bot, snap) });
        break;
      }
      case "partGone": {
        const part = this.partsById.get(e.id);
        if (!part) break;
        this.emit({ type: "partRemoved", part });
        this.forgetPart(part);
        break;
      }
      case "attach": {
        const block = this.blocksById.get(e.block);
        const part = this.partsById.get(e.part);
        if (!block || !part) break;
        block.part.blocks.delete(block);
        part.blocks.add(block);
        block.part = part;
        this.emit({ type: "blockAttached", block });
        break;
      }
      case "hp": {
        const block = this.blocksById.get(e.block);
        if (!block) break;
        block.hp = e.hp;
        this.emit({ type: e.repaired ? "blockRepaired" : "blockDamaged", block });
        break;
      }
      case "destroyed": {
        const block = this.blocksById.get(e.block);
        if (!block) break;
        block.alive = false;
        block.part.blocks.delete(block);
        block.bot.blocks.delete(block.key);
        this.blocksById.delete(block.id);
        // Une réparation peut le faire repousser (`rebuilt`)
        if (block.type !== "cockpit") block.bot.lost.set(block.key, block);
        this.destroyedCount++;
        this.emit({ type: "blockDestroyed", block });
        break;
      }
      case "wheelGone": {
        const wheel = this.wheelsById.get(e.id);
        if (!wheel) break;
        this.wheelsById.delete(e.id);
        // Retirée (son épave a cédé) : si elle a été arrachée et a cédé entre deux images, la
        // réplique la croyait encore montée
        wheel.part = null;
        unmount(wheel);
        this.emit({ type: "wheelRemoved", wheel });
        break;
      }
      case "debris": {
        const debris: Debris = { id: e.id, rb: this.posed(snap?.debris.get(e.id)), collider: NO_COLLIDER, look: e.look, born: e.born, life: e.life };
        this.debrisById.set(e.id, debris);
        this.emit({ type: "debrisAdded", debris });
        break;
      }
      case "debrisGone": {
        const debris = this.debrisById.get(e.id);
        if (!debris) break;
        this.debrisById.delete(e.id);
        this.emit({ type: "debrisRemoved", debris });
        break;
      }
      case "prop": {
        // Un accessoire ancré n'est pas dans les instantanés : il reste à son emplacement
        const spot = this.arena.props[e.spot];
        const half = spot ? propHalf(e.type, spot) : propHalf(e.type);
        const rb = this.posed(snap?.props.get(e.id) ?? (spot ? spotPose(spot, e.fixed) : undefined));
        const prop: Prop = {
          id: e.id, type: e.type, rb, collider: NO_COLLIDER, spot: e.spot, half, fixed: e.fixed, hp: propHp(e.type, half), state: { kind: "intact" },
          burn: 0, charred: 0,
        };
        this.propsById.set(e.id, prop);
        this.emit({ type: "propAdded", prop });
        break;
      }
      case "propFree": {
        const prop = this.propsById.get(e.id);
        if (!prop || !prop.fixed) break;
        prop.fixed = false;
        this.emit({ type: "propReleased", prop });
        break;
      }
      case "propGone": {
        const prop = this.propsById.get(e.id);
        if (!prop) break;
        this.propsById.delete(e.id);
        this.emit({ type: "propRemoved", prop });
        break;
      }
      case "propFire": {
        // (la durée du feu n'est connue que du serveur : ici, il brûle ou non)
        const prop = this.propsById.get(e.id);
        if (!prop) break;
        prop.burn = e.burning ? 1 : 0;
        prop.charred = e.charred;
        this.emit({ type: "propFire", prop });
        break;
      }
      case "groundFire": {
        const fire: GroundFire = { id: e.id, pos: e.pos, radius: e.radius, until: e.until, owner: null };
        this.groundFiresById.set(e.id, fire);
        this.emit({ type: "groundFireAdded", fire });
        break;
      }
      case "groundFireGone": {
        const fire = this.groundFiresById.get(e.id);
        if (!fire) break;
        this.groundFiresById.delete(e.id);
        this.emit({ type: "groundFireRemoved", fire });
        break;
      }
      case "projectile": {
        const s = snap?.projectiles.get(e.id);
        const pos = s?.pos ?? vec3(0, -100, 0);
        const projectile: Projectile = {
          id: e.id, weapon: e.weapon, shooter: e.shooter !== null ? this.botsById.get(e.shooter) ?? null : null,
          origin: pos, pos, vel: s?.vel ?? vec3(0, 0, 0), age: s?.age ?? 0, damage: 0, commander: null, homing: null, landed: false,
          fuse: null, stuck: null, blown: false, spotted: [], pingAt: 0, hp: 0, decoy: null, tried: [], lost: false, seen: null, blind: 0, done: false,
        };
        this.projectilesById.set(e.id, projectile);
        this.emit({ type: "projectileAdded", projectile });
        break;
      }
      case "mine": {
        const projectile = this.projectilesById.get(e.id);
        if (projectile) this.emit({ type: "mine", projectile, action: e.action });
        break;
      }
      case "projectileGone": {
        const projectile = this.projectilesById.get(e.id);
        if (!projectile) break;
        this.projectilesById.delete(e.id);
        projectile.done = true;
        this.emit({ type: "projectileRemoved", projectile });
        break;
      }
      case "shot":
        this.emit({ type: "shot", weapon: e.weapon, origin: e.origin, dir: e.dir });
        break;
      case "impact":
        this.emit({ type: "impact", point: e.point, surface: e.surface });
        break;
      case "explosion":
        this.emit({ type: "explosion", point: e.point, radius: e.radius, look: e.look });
        break;
      case "collision":
        this.emit({ type: "collision", point: e.point, strength: e.strength });
        break;
      case "melee": {
        const block = this.blocksById.get(e.block);
        if (block) this.emit({ type: "meleeHit", block, point: e.point, dir: e.dir, energy: e.energy, surface: e.surface, glance: e.glance });
        break;
      }
      case "link":
        this.emit({ type: "linkBroken", point: e.point });
        break;
      case "fire":
      case "fireOut": {
        const block = this.blocksById.get(e.block);
        if (!block) break;
        block.burn = e.t === "fire" ? 1 : 0;
        this.emit({ type: e.t === "fire" ? "fireStarted" : "fireEnded", block });
        break;
      }
      case "emp":
        this.emit({ type: "empBurst", point: e.point, radius: e.radius });
        break;
      case "stunned": {
        const bot = this.botsById.get(e.bot);
        if (!bot) break;
        bot.stunnedUntil = e.until;
        this.emit({ type: "stunned", bot, until: e.until });
        break;
      }
      case "shock": {
        // Paralysie locale : les organes coupés jusqu'à `until` (le HUD et les effets le lisent sur eux)
        const bot = this.botsById.get(e.bot);
        if (!bot) break;
        const blocks = e.blocks.map((id) => this.blocksById.get(id)).filter((b): b is Block => !!b && b.bot === bot);
        const wheels = e.wheels.map((id) => this.wheelsById.get(id)).filter((w): w is Wheel => !!w && w.bot === bot);
        for (const b of blocks) b.stunnedUntil = Math.max(b.stunnedUntil, e.until);
        for (const w of wheels) w.stunnedUntil = Math.max(w.stunnedUntil, e.until);
        this.emit({ type: "organsStunned", bot, blocks, wheels, until: e.until, point: e.point });
        break;
      }
      case "rebuilt": {
        const part = this.partsById.get(e.part);
        if (!part) break;
        const bot = part.bot;
        let block = this.blocksById.get(e.block) ?? bot.lost.get(e.key);
        if (block?.alive) {
          // Il quitte le morceau arraché qui le portait
          block.part.blocks.delete(block);
        } else if (block) {
          bot.lost.delete(e.key);
          block.alive = true;
          block.burn = 0;
          bot.blocks.set(block.key, block);
        } else {
          // Détruit avant l'arrivée du joueur : on le crée d'après le plan
          const spec = bot.profile.design.blocks.find((b) => cellKey(b.x, b.y, b.z) === e.key);
          if (!spec) break;
          block = newBlock(e.block, bot, part, spec);
          registerOrgans(bot, block);
          addThruster(bot, block);
        }
        block.hp = e.hp;
        block.part = part;
        part.blocks.add(block);
        this.blocksById.set(block.id, block);
        for (const key of [...bot.cuts]) if (key.split("|").includes(block.key)) bot.cuts.delete(key);
        this.emit({ type: "blockRebuilt", block });
        break;
      }
      case "barrier": {
        const barrier: Barrier = {
          id: e.id, team: e.team, center: e.center, normal: e.normal, width: e.width, height: e.height, hp: e.hp, maxHp: e.maxHp, until: e.until,
        };
        this.barriersById.set(e.id, barrier);
        this.emit({ type: "barrierAdded", barrier });
        break;
      }
      case "barrierHit": {
        const barrier = this.barriersById.get(e.id);
        if (!barrier) break;
        barrier.hp = e.hp;
        this.emit({ type: "barrierHit", barrier, point: e.point });
        break;
      }
      case "barrierGone": {
        const barrier = this.barriersById.get(e.id);
        if (!barrier) break;
        this.barriersById.delete(e.id);
        this.emit({ type: "barrierRemoved", barrier, broken: e.broken });
        break;
      }
      case "smoke": {
        const cloud: SmokeCloud = { id: e.id, pos: e.pos, radius: e.radius, born: e.born, life: e.life };
        this.smokesById.set(e.id, cloud);
        this.emit({ type: "smokeAdded", cloud });
        break;
      }
      case "smokeGone": {
        const cloud = this.smokesById.get(e.id);
        if (!cloud) break;
        this.smokesById.delete(e.id);
        this.emit({ type: "smokeRemoved", cloud });
        break;
      }
      case "hit": {
        const victim = this.botsById.get(e.victim);
        const attacker = e.attacker !== null ? this.botsById.get(e.attacker) ?? null : null;
        if (victim) this.emit({ type: "hit", victim, attacker, cause: e.cause, destroyed: e.destroyed });
        break;
      }
      case "killed": {
        const bot = this.botsById.get(e.bot);
        if (bot) this.emit({ type: "botKilled", bot, killer: e.killer !== null ? this.botsById.get(e.killer) ?? null : null, cause: e.cause });
        break;
      }
      case "arena": {
        if (e.id === this.arena.id) break;
        const arena = this.arenaFor(e.id);
        // Une carte que le serveur aurait dû envoyer avant (message `map`) : on garde l'arène en place, et le client le signale
        this.missingArena = arena ? null : String(e.id);
        if (!arena) break;
        this.arena = arena;
        this.emit({ type: "arenaChanged", arena: arena.id });
        break;
      }
      case "match":
        this.match = e.rules ? newMatch(e.rules, this.arena) : null;
        break;
      case "shield": {
        const block = this.blocksById.get(e.block);
        if (block) this.emit({ type: "shieldHit", block });
        break;
      }
      case "zone": {
        const zone = this.match?.zones[e.zone];
        if (zone) zone.owner = e.owner;
        this.emit({ type: "zoneChanged", zone: e.zone, owner: e.owner, by: e.by });
        break;
      }
      case "over":
        if (this.match) this.match.winner = e.winner;
        this.emit({ type: "matchOver", winner: e.winner });
        break;
      case "damage":
        this.emit({ type: "damage", bots: e.bots.map((id) => this.botsById.get(id)).filter((b): b is Bot => !!b) });
        break;
    }
  }

  /** Corps posé à `pose` (ou en attente de sa première pose). */
  private posed(pose: BodyPose | undefined): RigidBody {
    const rb = newBody();
    if (pose) blendPose(poseOf(rb), pose, pose, 0);
    return rb;
  }

  private addPart(id: number, bot: Bot, snap: Snapshot | undefined): Part {
    const s = snap?.parts.get(id);
    const rb = this.posed(s);
    if (s) {
      poseOf(rb).com = s.com;
      poseOf(rb).massValue = s.mass;
    }
    const part: Part = { id, bot, rb, blocks: new Set(), colliders: [], dirty: false, links: null, heads: [], blades: [] };
    bot.parts.add(part);
    this.partsById.set(id, part);
    return part;
  }

  private forgetPart(part: Part): void {
    for (const b of part.blocks) this.blocksById.delete(b.id);
    part.bot.parts.delete(part);
    this.partsById.delete(part.id);
  }

  /**
   * Robot décrit par le serveur : il se construit d'après son plan (mêmes blocs, mêmes organes), puis
   * prend l'état décrit (blocs détruits, morceaux, points de structure, feux, roues arrachées).
   */
  private addBot(desc: BotDesc, snap: Snapshot | undefined): void {
    const old = this.botsById.get(desc.id);
    if (old) this.removeBot(old);
    const { profile } = desc;
    const bot = newBot(desc.id, profile, desc.team, vec3(0, 0, 0));
    bot.controller = desc.controller;
    for (const key of desc.cuts) bot.cuts.add(key);
    const parts = desc.parts.map((id) => this.addPart(id, bot, snap));
    // Un bloc dont le morceau est inconnu (ou un cockpit détruit) est rangé dans le premier morceau
    const fallback: Part = parts[0] ?? { id: -1, bot, rb: newBody(), blocks: new Set(), colliders: [], dirty: false, links: null, heads: [], blades: [] };
    const alive = new Map(desc.blocks.map((entry) => [entry[0], entry]));
    for (const spec of profile.design.blocks) {
      const key = cellKey(spec.x, spec.y, spec.z);
      const entry = alive.get(key);
      if (entry) {
        const [, id, partId, hp, burn] = entry;
        const part = this.partsById.get(partId) ?? fallback;
        const block = newBlock(id, bot, part, spec);
        block.hp = hp;
        block.burn = burn;
        part.blocks.add(block);
        registerOrgans(bot, block);
        this.blocksById.set(id, block);
      } else if (spec.type === "cockpit") {
        const cockpit = newBlock(desc.cockpit, bot, fallback, spec);
        cockpit.alive = false;
        bot.blocks.delete(key);
      }
    }
    addThrusters(bot);
    for (const [index, id, hp] of desc.wheels) {
      const mount = profile.design.wheels[index];
      if (!mount) continue;
      const wheel = this.makeWheel(id, bot, mount, hp);
      const s = snap?.wheels.get(id);
      if (s) {
        blendPose(poseOf(wheel.rb), s, s, 0);
        wheel.part = this.partsById.get(s.part) ?? null;
        if (s.hub) blendPose(poseOf(wheel.hub), s.hub, s.hub, 0);
        else unmount(wheel);
      }
      bot.wheels.push(wheel);
      this.wheelsById.set(id, wheel);
    }
    this.bots.push(bot);
    this.botsById.set(bot.id, bot);

    this.emit({ type: "botAdded", bot });
    for (const part of parts) this.emit({ type: "partAdded", part });
    for (const block of bot.blocks.values()) {
      this.emit({ type: "blockAttached", block });
      if (block.hp < BLOCK_TYPES[block.type].hp) this.emit({ type: "blockDamaged", block });
      if (block.burn > 0) this.emit({ type: "fireStarted", block });
    }
    for (const wheel of bot.wheels) this.emit({ type: "wheelAdded", wheel });
  }

  /** Roue d'après son montage, comme `createWheel` mais sans physique. */
  private makeWheel(id: number, bot: Bot, m: WheelMount, hp: number): Wheel {
    const local = wheelLocalPos(m);
    return {
      id, bot, type: m.type, steerable: !!wheelDef(m.type).steering, mountKey: cellKey(m.x, m.y, m.z),
      side: Math.abs(local.x) < 0.1 ? 0 : Math.sign(local.x), local,
      rb: newBody(), hub: newBody(), body: null, releasedAt: 0, collider: NO_COLLIDER, hp, steer: 0, drive: 0,
      powered: false, engaged: false, overrun: false, brake: 0, travel: 0, spin: 0, spinRate: 0, load: 0, part: null, stunnedUntil: 0,
    };
  }

  private removeBot(bot: Bot): void {
    for (const wheel of bot.wheels) {
      if (!this.wheelsById.delete(wheel.id)) continue;
      this.emit({ type: "wheelRemoved", wheel });
    }
    for (const part of [...bot.parts]) {
      this.emit({ type: "partRemoved", part });
      this.forgetPart(part);
    }
    this.emit({ type: "botRemoved", bot });
    const i = this.bots.indexOf(bot);
    if (i >= 0) this.bots.splice(i, 1);
    this.botsById.delete(bot.id);
    for (const seen of this.detected.values()) seen.delete(bot);
    if (this.player === bot) this.player = null;
  }
}

/** Roue arrachée : elle perd son porte-moyeu (comme `releaseWheel`). */
function unmount(wheel: Wheel): void {
  wheel.hub = null;
}

/** Partie répliquée : score, temps, réapparitions et état des zones viennent des instantanés. */
function newMatch(rules: MatchRules, arena: ArenaLayout): Match {
  return {
    rules, score: { red: 0, blue: 0 }, elapsed: 0, winner: null, respawns: [], stuck: new Map(),
    zones: newZones(rules, arena.zones), nextHill: Infinity, unsubscribe: () => {},
  };
}
