import RAPIER, { type Collider } from "@dimforge/rapier3d-compat";
import { createAiState } from "../ai/brain";
import { blockDef, BLOCK_TYPES } from "../catalog/blocks";
import { allAround, meleeDef } from "../catalog/melee";
import { wheelDef } from "../catalog/wheels";
import { BLOCK_SIZE, PART_DAMPING, WHEEL_ANGULAR_DAMPING } from "../config";
import type { BotProfile } from "../design/presets";
import {
  AXES, cellKey, DEFAULT_FACING, issueSummary, validateDesign, wheelLocalPos, type BlockPlacement, type RobotDesign, type WheelMount,
} from "../design/robotDesign";
import { add, axisAngle, cross, quatFromBasis, scale, vec3, type Quat, type Vec3 } from "../math/vec";
import { weaponDef } from "../catalog/weapons";
import { rand } from "../math/scalar";
import { COLLISION_GROUPS } from "../physics/groups";
import type { Block, Bot, Part, Team, Thruster, Wheel, WheelBody } from "../sim/entities";
import type { Simulation } from "../sim/simulation";
import { newArmState } from "../combat/arsenal";
import { newMeleeArm } from "../combat/melee";
import { rebuildColliders } from "./colliders";
import { energyCapacity } from "./energy";
import { placeWheel, wheelCollider, WheelPose } from "./wheels";

/**
 * Robot vide (sans bloc, sans corps) d'identifiant `id`. Le cockpit est rattaché par l'appelant,
 * dès que son bloc existe (validateDesign garantit qu'il y en a un). Sert à `spawnBot` et à la
 * réplique réseau (net/replica.ts), qui construit les mêmes entités sans physique.
 */
export function newBot(id: number, profile: BotProfile, team: Team, pos: Vec3): Bot {
  const { design } = profile;
  let maxY = 0;
  for (const { y } of design.blocks) maxY = Math.max(maxY, y);
  return {
    id,
    profile,
    blocks: new Map(),
    parts: new Set(),
    wheels: [],
    thrusters: [],
    supports: [],
    surfaces: [],
    turrets: [],
    melee: [],
    nextShot: new Map(),
    triggerHeld: false,
    shields: [],
    flareLaunchers: [],
    flares: { charges: 0, restock: 0, readyAt: 0 },
    lights: [],
    cuts: new Set(),
    team,
    controller: "ai",
    input: null,
    lastAttacker: null,
    thrownBy: null,
    total: design.blocks.length,
    top: maxY * BLOCK_SIZE,
    radius: designRadius(design),
    lastPos: pos,
    stunnedUntil: 0,
    flippedFor: 0,
    righting: 0,
    lastHit: -Infinity,
    lost: new Map(),
    rebuildAt: 0,
    energy: 0,
    drawn: 0,
    ai: createAiState(profile, pos),
  } as Omit<Bot, "cockpit"> as Bot;
}

/** Bloc `spec` d'un plan, d'identifiant `id`, porté par le morceau `part`, ajouté aux blocs du robot. */
export function newBlock(id: number, bot: Bot, part: Part, spec: BlockPlacement): Block {
  const { x, y, z, type, facing = DEFAULT_FACING } = spec;
  const up = AXES[facing.up];
  const forward = AXES[facing.forward];
  const block: Block = {
    id,
    bot,
    key: cellKey(x, y, z),
    x, y, z, type,
    local: vec3(x * BLOCK_SIZE, y * BLOCK_SIZE, z * BLOCK_SIZE),
    up,
    forward,
    rot: quatFromBasis(cross(up, forward), up, forward),
    part,
    hp: BLOCK_TYPES[type].hp,
    alive: true,
    burn: 0,
    stunnedUntil: 0,
  };
  bot.blocks.set(block.key, block);
  if (type === "cockpit") bot.cockpit = block;
  return block;
}

/** Organes que porte le bloc : surface portante, appui, tourelle, arme de contact (les moteurs, eux, sont recensés d'un coup par `addThrusters`). */
export function registerOrgans(bot: Bot, block: Block): void {
  const def = blockDef(block.type);
  if (def.melee) bot.melee.push(newMeleeArm(block, def.melee));
  if (def.aero) bot.surfaces.push({ block, deflection: 0 });
  if (def.support) bot.supports.push({ block, contact: Infinity, force: 0, phase: 0 });
  if (def.shield) bot.shields.push(block);
  if (def.light) bot.lights.push(block);
  if (def.flares) {
    bot.flareLaunchers.push(block);
    bot.flares.charges += def.flares.charges; // il apparaît chargé
  }
  const turret = def.turret;
  if (turret) {
    const arm = newArmState(weaponDef(turret.weapon));
    arm.cooldown = rand(0, weaponDef(turret.weapon).cooldown); // pour que les tourelles ne tirent pas toutes ensemble
    bot.turrets.push({ block, weapon: turret.weapon, yaw: 0, pitch: 0, arm, target: null, retarget: 0, aim: null, wobble: vec3(0, 0, 0), firedAt: -Infinity, lockOn: null, lockTime: 0, lockHidden: 0 });
  }
}

/** Construit un robot d'un seul morceau à la position `pos`, tourné de `yaw` autour de l'axe vertical. */
export function spawnBot(sim: Simulation, profile: BotProfile, pos: Vec3, yaw: number, team: Team = "red"): Bot {
  const { design } = profile;
  const problems = validateDesign(design);
  if (problems.length) throw new Error(`Plan « ${profile.name ?? profile.id} » invalide : ${problems.map(issueSummary).join(" ; ")}`);

  const bot = newBot(sim.nextId(), profile, team, pos);
  sim.emit({ type: "botAdded", bot });

  const rot = axisAngle(vec3(0, 1, 0), yaw);
  const main = makePart(sim, bot, pos, rot);

  for (const spec of design.blocks) {
    const block = newBlock(sim.nextId(), bot, main, spec);
    attachBlock(sim, block, main);
    registerOrgans(bot, block);
  }
  rebuildColliders(sim, main);
  addThrusters(bot);
  bot.energy = energyCapacity(bot); // batteries pleines

  for (const mount of design.wheels) {
    const wheel = createWheel(sim, bot, mount);
    bot.wheels.push(wheel);
    sim.emit({ type: "wheelAdded", wheel });
    attachWheel(sim, wheel, main);
  }
  return bot;
}

/**
 * Moteurs du robot. Ceux qui poussent vers le haut servent à la sustentation : leurs hélices
 * tournent en sens alternés autour de leur centre, comme sur un multirotor, pour qu'avec un
 * nombre pair de rotors placés symétriquement les couples de réaction s'annulent. Ceux qui
 * poussent vers l'avant servent à la propulsion. Les autres (un rotor de queue, un réacteur de
 * côté) aident le pilote de vol à tenir l'assiette et le cap.
 */
/**
 * Ordre, rôle et sens de rotation des moteurs d'un plan (tous ses réacteurs, d'après lui et non
 * d'après les blocs encore là : un client qui arrive en cours de partie, qui ne reçoit que les
 * blocs vivants, doit retrouver le même ordre et les mêmes sens que le serveur). Les rotors de
 * sustentation tournent autour de leur centre, en sens alternés ; puis les autres.
 */
function thrusterPlan(design: RobotDesign): { key: string; role: Thruster["role"]; spin: number }[] {
  const engines = design.blocks
    .filter((b) => blockDef(b.type).thruster)
    .map((b) => ({ key: cellKey(b.x, b.y, b.z), x: b.x, z: b.z, up: AXES[(b.facing ?? DEFAULT_FACING).up] }));
  const lift = engines.filter((e) => e.up.y > 0.7);
  const cx = lift.reduce((s, e) => s + e.x, 0) / (lift.length || 1);
  const cz = lift.reduce((s, e) => s + e.z, 0) / (lift.length || 1);
  const angle = (e: { x: number; z: number }): number => Math.atan2(e.z - cz, e.x - cx);
  lift.sort((a, b) => angle(a) - angle(b));
  return [
    ...lift.map((e, i) => ({ key: e.key, role: "lift" as const, spin: i % 2 === 0 ? 1 : -1 })),
    ...engines.filter((e) => e.up.y <= 0.7).map((e) => ({ key: e.key, role: e.up.z > 0.7 ? ("cruise" as const) : ("trim" as const), spin: 1 })),
  ];
}

const newThruster = (block: Block, role: Thruster["role"], spin: number): Thruster =>
  ({ block, role, spin, thrust: 0, tiltA: 0, tiltB: 0, output: 1, misfireUntil: 0 });

export function addThrusters(bot: Bot): void {
  for (const e of thrusterPlan(bot.profile.design)) {
    const block = bot.blocks.get(e.key);
    if (block) bot.thrusters.push(newThruster(block, e.role, e.spin));
  }
}

/**
 * Recense un moteur arrivé après les autres (un bloc qui repousse sur la réplique d'un joueur arrivé
 * après sa destruction) : à sa place dans l'ordre du plan, avec son rôle et son sens, comme
 * `addThrusters` (ajouté au bout avec un sens par défaut, l'ordre des moteurs et le sens des rotors
 * n'étaient plus ceux du serveur).
 */
export function addThruster(bot: Bot, block: Block): void {
  if (!blockDef(block.type).thruster || bot.thrusters.some((t) => t.block === block)) return;
  const plan = thrusterPlan(bot.profile.design);
  const rank = (key: string): number => plan.findIndex((e) => e.key === key);
  const own = rank(block.key);
  // (un bloc qui n'est pas dans le plan : son rôle d'après son orientation, au bout)
  const role = own >= 0 ? plan[own].role : block.up.y > 0.7 ? "lift" : block.up.z > 0.7 ? "cruise" : "trim";
  const thruster = newThruster(block, role, own >= 0 ? plan[own].spin : 1);
  const at = own >= 0 ? bot.thrusters.findIndex((t) => rank(t.block.key) > own) : -1;
  if (at < 0) bot.thrusters.push(thruster);
  else bot.thrusters.splice(at, 0, thruster);
}

/** Hauteur de l'origine d'un robot posé au sol (sur ses roues, ou sur ses blocs s'il n'en a pas). */
export function groundHeight(design: RobotDesign): number {
  if (design.wheels.length) {
    return Math.max(...design.wheels.map((m) => wheelDef(m.type).radius - wheelLocalPos(m).y));
  }
  return BLOCK_SIZE / 2 - Math.min(...design.blocks.map((b) => b.y)) * BLOCK_SIZE;
}

/**
 * Rayon du cercle horizontal qui contient tout le robot, blocs et roues (m), et l'anneau d'un
 * anneau-coque (il fait le tour du robot : c'est lui que heurte ce qui l'approche).
 */
export function designRadius(design: RobotDesign): number {
  let r = 0;
  for (const b of design.blocks) {
    r = Math.max(r, Math.hypot(b.x, b.z) * BLOCK_SIZE + BLOCK_SIZE * 0.71);
    const melee = blockDef(b.type).melee;
    const spec = melee ? meleeDef(melee) : null;
    if (spec?.blade && allAround(spec)) {
      const f = b.facing ?? DEFAULT_FACING;
      const [hx, hy, hz] = spec.hub;
      const up = AXES[f.up];
      const forward = AXES[f.forward];
      const hub = add(vec3(b.x * BLOCK_SIZE, b.y * BLOCK_SIZE, b.z * BLOCK_SIZE), add(scale(cross(up, forward), hx), add(scale(up, hy), scale(forward, hz))));
      r = Math.max(r, Math.hypot(hub.x, hub.z) + spec.blade.outer);
    }
  }
  for (const m of design.wheels) {
    const p = wheelLocalPos(m);
    r = Math.max(r, Math.hypot(p.x, p.z) + wheelDef(m.type).radius);
  }
  return r;
}

/** Position du centre d'une roue au repos, dans le repère local du robot. */
export { wheelLocalPos };

/**
 * Roue d'après son montage, au repos : son état (braquage, débattement, rotation, moteur) et ses
 * poses calculées ; `attachWheel` la monte ensuite sur un morceau (voir robot/wheels.ts).
 */
function createWheel(sim: Simulation, bot: Bot, m: WheelMount): Wheel {
  const local = wheelLocalPos(m);
  return {
    id: sim.nextId(),
    bot,
    type: m.type,
    steerable: !!wheelDef(m.type).steering,
    mountKey: cellKey(m.x, m.y, m.z),
    side: Math.abs(local.x) < 0.1 ? 0 : Math.sign(local.x),
    local,
    rb: new WheelPose(),
    hub: new WheelPose(),
    body: null,
    releasedAt: 0,
    collider: null as unknown as Collider, // posé par attachWheel, aussitôt
    hp: wheelDef(m.type).hp,
    steer: 0,
    drive: 0,
    powered: false,
    engaged: false,
    overrun: false,
    brake: 0,
    travel: 0,
    spin: 0,
    spinRate: 0,
    load: 0,
    part: null,
    stunnedUntil: 0,
  };
}

/** Lance tout un robot (morceaux, et roues arrachées) à la vitesse `v`. */
export function setBotVelocity(bot: Bot, v: Vec3): void {
  for (const part of bot.parts) part.rb.setLinvel(v, true);
  for (const w of bot.wheels) w.body?.setLinvel(v, true);
}

/** Retire un robot entier du monde (ses feux s'éteignent avec lui). */
export function removeBot(sim: Simulation, bot: Bot): void {
  // Ses corps vont disparaître : ses blocs ne comptent plus pour personne (tourelles qui le visent,
  // missiles qui le poursuivent, IA qui l'engage), même s'il n'avait pas été détruit
  bot.cockpit.alive = false;
  for (const b of bot.blocks.values()) {
    sim.fires.delete(b);
    b.alive = false;
  }
  for (const w of bot.wheels) {
    // (une épave déjà retirée n'a plus rien à retirer)
    if (!w.part && !w.body) continue;
    sim.colliders.delete(w.collider.handle);
    // Une roue arrachée a son corps ; le collider d'une roue montée part avec le corps de son morceau.
    // L'épave garde une pose figée : on ne relit jamais un corps libéré
    if (w.body) {
      const at = w.body.translation();
      const rot = w.body.rotation();
      sim.world.removeRigidBody(w.body);
      w.body = null;
      w.rb = frozenPose(vec3(at.x, at.y, at.z), { x: rot.x, y: rot.y, z: rot.z, w: rot.w });
    }
    w.part = null;
    w.hub = null;
    sim.emit({ type: "wheelRemoved", wheel: w });
  }
  for (const part of bot.parts) {
    for (const c of part.colliders) sim.colliders.delete(c.handle);
    sim.parts.delete(part);
    sim.world.removeRigidBody(part.rb);
    sim.emit({ type: "partRemoved", part });
  }
  // Les tourelles qui le visaient l'oublient, même celles d'un robot hors de combat ou paralysé
  // (on ne les fait plus tourner) : personne ne garde un robot dont les corps sont libérés
  for (const other of sim.bots) {
    for (const t of other.turrets) {
      if (t.target === bot) t.target = null;
      if (t.lockOn === bot) {
        t.lockOn = null;
        t.lockTime = 0;
      }
    }
    if (other.ai.tactics.foe === bot) other.ai.tactics.foe = null;
  }
  sim.emit({ type: "botRemoved", bot });
}

/** Crée un morceau vide (un corps rigide) à la pose donnée. */
export function makePart(sim: Simulation, bot: Bot, pos: Vec3, rot: Quat): Part {
  const damping = PART_DAMPING[bot.profile.mobility];
  const rb = sim.world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setRotation(rot)
      .setLinearDamping(damping.linear)
      .setAngularDamping(damping.angular),
  );
  const part: Part = { id: sim.nextId(), bot, rb, blocks: new Set(), colliders: [], dirty: false, links: null, heads: [], blades: [] };
  bot.parts.add(part);
  sim.parts.add(part);
  sim.emit({ type: "partAdded", part });
  return part;
}

/** Retire un morceau vide ; ses roues sont arrachées. */
export function removePart(sim: Simulation, part: Part): void {
  for (const w of part.bot.wheels) if (w.part === part) releaseWheel(sim, w);
  for (const c of part.colliders) sim.colliders.delete(c.handle);
  sim.world.removeRigidBody(part.rb);
  part.bot.parts.delete(part);
  sim.parts.delete(part);
  sim.emit({ type: "partRemoved", part });
}

/**
 * Fixe un bloc sur un morceau. Les colliders du morceau seront reconstruits (fusionnés) ensuite,
 * par `rebuildColliders` ou `rebuildDirtyParts`.
 */
export function attachBlock(sim: Simulation, block: Block, part: Part): void {
  block.part = part;
  part.dirty = true;
  part.links = null;
  part.blocks.add(block);
  sim.emit({ type: "blockAttached", block });
}

/** Retire un bloc de son morceau (à reconstruire ensuite). `block.part` garde la référence au morceau. */
export function detachBlock(block: Block): void {
  if (!block.part.blocks.delete(block)) return;
  block.part.dirty = true;
  block.part.links = null;
}

/**
 * Monte une roue sur un morceau : son collider, à sa place de repos dans le repère du morceau (les
 * tirs le touchent, il porte la masse de la roue, il pousse caisses et robots, mais pas le sol ni
 * le décor fixe : `COLLISION_GROUPS.wheel`), et sa pose. Sa suspension, sa traction et sa direction
 * sont calculées à chaque pas (robot/wheels.ts).
 */
export function attachWheel(sim: Simulation, wheel: Wheel, part: Part): void {
  const def = wheelDef(wheel.type);
  const { x, y, z } = wheel.local;
  const collider = sim.world.createCollider(
    wheelCollider(def, def.grip).setTranslation(x, y, z).setCollisionGroups(COLLISION_GROUPS.wheel),
    part.rb,
  );
  sim.colliders.set(collider.handle, { kind: "wheel", wheel });
  wheel.collider = collider;
  wheel.part = part;
  wheel.hub ??= new WheelPose();
  // Sa masse compte tout de suite (sinon Rapier ne la prendrait qu'au pas suivant)
  part.rb.recomputeMassPropertiesFromColliders();
  placeWheel(wheel);
}

/** Rattache une roue à un autre morceau (après une séparation). */
export function moveWheel(sim: Simulation, wheel: Wheel, part: Part): void {
  unmountWheel(sim, wheel);
  attachWheel(sim, wheel, part);
}

/**
 * Arrache une roue : son collider quitte le morceau, et elle devient un corps libre, à sa pose et
 * à sa vitesse, qui roule et rebondit.
 */
export function releaseWheel(sim: Simulation, wheel: Wheel): void {
  if (!wheel.part) return;
  unmountWheel(sim, wheel);
  const def = wheelDef(wheel.type);
  const pose = wheel.rb;
  const p = pose.translation();
  const v = pose.linvel();
  const body = sim.world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(p.x, p.y, p.z)
      .setRotation(pose.rotation())
      .setLinvel(v.x, v.y, v.z)
      .setAngvel(pose.angvel())
      .setAngularDamping(WHEEL_ANGULAR_DAMPING),
  );
  const collider = sim.world.createCollider(wheelCollider(def, def.grip).setCollisionGroups(COLLISION_GROUPS.robot), body);
  sim.colliders.set(collider.handle, { kind: "wheel", wheel });
  wheel.body = body;
  wheel.rb = body;
  wheel.hub = null;
  wheel.collider = collider;
  wheel.powered = false;
  wheel.engaged = false;
  wheel.load = 0;
  // L'épave : elle cède sous les coups, et ne reste pas indéfiniment sur le terrain
  wheel.hp = def.hp * WHEEL_WRECK_HP;
  wheel.releasedAt = sim.time;
}

/** Épave de roue arrachée : part de ses points de structure qu'elle garde, et durée sur le terrain (s). */
const WHEEL_WRECK_HP = 0.6;
export const WHEEL_WRECK_LIFE = 30;

/**
 * Retire l'épave d'une roue arrachée (elle a cédé, ou fait son temps) : son corps disparaît
 * (`wheelRemoved`). Elle garde une pose figée, pour qui la lirait encore : on ne relit jamais un
 * corps libéré.
 */
export function discardWheel(sim: Simulation, wheel: Wheel, broken: boolean): void {
  const body = wheel.body;
  if (!body) return;
  const at = body.translation();
  const rot = body.rotation();
  sim.colliders.delete(wheel.collider.handle);
  sim.world.removeRigidBody(body);
  wheel.body = null;
  wheel.rb = frozenPose(vec3(at.x, at.y, at.z), { x: rot.x, y: rot.y, z: rot.z, w: rot.w });
  sim.emit({ type: "wheelRemoved", wheel });
  if (broken) sim.emit({ type: "collision", point: vec3(at.x, at.y, at.z), strength: WHEEL_BREAK_STRENGTH });
}

/** Force de l'éclat d'une épave qui cède (pour son effet et son bruit de choc). */
const WHEEL_BREAK_STRENGTH = 40;

/** Pose immobile d'une roue retirée. */
function frozenPose(at: Vec3, rot: Quat): WheelBody {
  const still = vec3(0, 0, 0);
  return { translation: () => at, rotation: () => rot, linvel: () => still, angvel: () => still };
}

/** Les épaves de roues qui ont fait leur temps disparaissent. */
export function expireWheelWrecks(sim: Simulation): void {
  for (const bot of sim.bots) {
    for (const w of bot.wheels) if (w.body && sim.time - w.releasedAt > WHEEL_WRECK_LIFE) discardWheel(sim, w, false);
  }
}

/** La roue quitte son morceau : son collider est retiré, et la masse du morceau recalculée. */
function unmountWheel(sim: Simulation, wheel: Wheel): void {
  const part = wheel.part;
  if (!part) return;
  sim.colliders.delete(wheel.collider.handle);
  sim.world.removeCollider(wheel.collider, true);
  part.rb.recomputeMassPropertiesFromColliders();
  wheel.part = null;
}
