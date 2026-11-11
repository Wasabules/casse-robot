import * as B from "../babylon";
import { blockDef } from "../../shared/catalog/blocks";
import { wheelDef } from "../../shared/catalog/wheels";
import { BLOCK_SIZE, GRAVITY } from "../../shared/config";
import { clamp } from "../../shared/math/scalar";
import {
  add, axisAngle, cross, distance, len, norm, qmul, qrot, quatFromBasis, scale, sub, vec3, type Quat, type Vec3,
} from "../../shared/math/vec";
import { isStunned, organStunned } from "../../shared/combat/emp";
import { ENGINE_WORN, engineHealth } from "../../shared/robot/propulsion";
import { blockWorldPos, liveThrusters } from "../../shared/robot/queries";
import type { Bot, Part, Support, Thruster, Wheel } from "../../shared/sim/entities";
import type { SimEvent } from "../../shared/sim/events";
import type { World } from "../../shared/sim/world";
import { beltMesh, BeltShoes, beltShape, shoeHorns, sprocketRollers, trackGroups, TREAD } from "./belts";
import type { Assets } from "./materials";
import { TRACK_DETAIL_RANGE } from "./models/tracks";
import { padGlow } from "./fx/engineFx";
import { BLADES, FOOT_OUT, kneeOf, legOut, type BladeKind } from "../../shared/design/clearance";

/**
 * Écart du pied vers l'extérieur du robot (m : la cote est dans shared, l'encombrement d'une patte
 * s'en sert), longueur d'un demi-pas (m), hauteur du pied levé (m).
 */
export { FOOT_OUT };
export const HALF_STEP = 0.35;
const FOOT_LIFT = 0.18;
/**
 * Régime d'un rotor (rad/s) : comme un vrai, il tourne presque à vitesse constante tant qu'il est
 * alimenté (la poussée se règle au pas des pales), un peu plus vite à pleine poussée. Une hélice de
 * queue, plus petite, tourne plus vite.
 */
const ROTOR_RPM = { idle: 24, full: 30 };
const TAIL_RPM = { idle: 40, full: 48 };
/** Une hélice d'avion tourne bien plus vite au plein régime qu'au ralenti (rad/s). */
const PROPELLER_RPM = { idle: 14, full: 50 };
/** Régime (part de la poussée maximale) au-dessous duquel une hélice d'avion s'arrête : moteur coupé. */
const PROPELLER_STOP = 0.02;
/** Montée en régime et ralentissement du rotor, coupé (s) : il a de l'inertie. */
const SPOOL_UP = 1.2;
const SPOOL_DOWN = 3;
/**
 * Rotation affichée par image, au plus, en part de l'écart entre deux pales : au-delà, l'œil voit
 * les pales ralentir, s'arrêter ou tourner à l'envers (effet stroboscopique, comme les roues de
 * chariot au cinéma).
 */
const STROBE_LIMIT = 0.28;
/**
 * Disque flou des pales qui tournent vite : un disque translucide de leur diamètre (`BLADES`), d'opacité
 * `BLUR_ALPHA`, dès qu'elles tournent à plus de `BLUR_FROM` de leur régime de ralenti.
 */
const BLUR_FROM = 0.8;
const BLUR_ALPHA = 0.16;
/** Balourd d'une hélice abîmée (sous `ENGINE_WORN` de ses points) : inclinaison qui tremble (rad), au plus. */
const WOBBLE = 0.08;

/**
 * Moteurs qui ont des pales : un rotor, une hélice d'avion, et un réacteur couché de côté (rotor
 * de queue : il a une petite hélice). Les autres ont une flamme (voir WorldView).
 */
export function hasBlades(t: Thruster): boolean {
  const look = blockDef(t.block.type).thruster?.look;
  return look === "rotor" || look === "propeller" || (look === undefined && t.role === "trim");
}

interface Belt {
  bot: Bot;
  wheels: Wheel[];
  /** Repère de la chenille (celui du robot, centré en x sur la bande), qui porte ses deux bandes. */
  node: B.TransformNode;
  /** De près : la bande de dessous et ses patins (enfants de la bande) ; de loin : la bande épaisse. */
  near: B.Mesh;
  far: B.Mesh;
  material: B.StandardMaterial;
  texture: B.Texture;
  shoes: BeltShoes;
  /** Barbotin(s) du bout arrière, chacun sur son galet (il en suit la pose, rotation comprise). */
  sprockets: { wheel: Wheel; mesh: B.InstancedMesh }[];
  /** Centre de la bande dans le repère local du robot. */
  center: Vec3;
  scroll: number;
  /** Angle de chaque galet autour de son essieu, dans le repère du morceau, à l'image précédente (rad). */
  roll: Map<Wheel, number>;
}

const toQuat = (q: Quat): B.Quaternion => new B.Quaternion(q.x, q.y, q.z, q.w);

/**
 * Ce qui fait avancer les robots sans roue simple : bande des chenilles (qui défile avec leurs
 * galets), pattes articulées qui marchent, lueur des patins anti-gravité, pales des rotors
 * orientables. Tout se déduit de l'état de la simulation à chaque image.
 */
export class LocomotionView {
  private readonly sim: World;
  private readonly scene: B.Scene;
  private readonly assets: Assets;
  private readonly shadows: B.ShadowGenerator;
  private readonly unsubscribe: () => void;
  private readonly belts: Belt[] = [];
  /** Robots dont les chenilles sont à (re)constituer. */
  private readonly regroup = new Set<Bot>();
  private readonly legs = new Map<number, { thigh: B.InstancedMesh; shin: B.InstancedMesh }>();
  private readonly glows = new Map<number, B.InstancedMesh>();
  /** Pales des rotors : leur angle, leur régime (rad/s), et leur disque flou. */
  private readonly blades = new Map<number, { mesh: B.InstancedMesh; disc: B.InstancedMesh; angle: number; speed: number }>();
  /** Disque flou des pales (voir `BLADE_DIAMETER`), créé au premier rotor. */
  private discSource: B.Mesh | null = null;
  /** Robot qu'on ne dessine pas (voir WorldView.hidden). */
  hidden: Bot | null = null;
  /**
   * Distance de la caméra jusqu'où les chenilles ont leurs patins et leur barbotin (m) ; au-delà,
   * une bande épaisse, et rien à poser à chaque image. Réglable depuis la console pour comparer.
   */
  shoeRange = TRACK_DETAIL_RANGE;

  constructor(sim: World, scene: B.Scene, assets: Assets, shadows: B.ShadowGenerator) {
    this.sim = sim;
    this.scene = scene;
    this.assets = assets;
    this.shadows = shadows;
    this.unsubscribe = sim.on((e) => this.onEvent(e));
  }

  sync(dt: number): void {
    // (un robot retiré entre-temps n'a plus de corps à lire)
    for (const bot of this.regroup) if (this.sim.bots.includes(bot)) this.buildBelts(bot);
    this.regroup.clear();
    this.syncBelts();
    for (const bot of this.sim.bots) {
      const shown = bot !== this.hidden;
      // Moteurs alimentés : reliés au cockpit, robot pas paralysé, ni eux (une décharge de lance électrique)
      const powered = isStunned(this.sim, bot) ? new Set<Thruster>() : new Set(liveThrusters(bot).filter((t) => !organStunned(this.sim, t.block)));
      for (const s of bot.supports) {
        if (!s.block.alive) continue;
        if (blockDef(s.block.type).support?.kind === "leg") this.syncLeg(bot, s);
        else this.syncGlow(s);
        const leg = this.legs.get(s.block.id);
        leg?.thigh.setEnabled(shown);
        leg?.shin.setEnabled(shown);
        this.glows.get(s.block.id)?.setEnabled(shown);
      }
      for (const t of bot.thrusters) {
        if (t.block.alive && hasBlades(t)) this.syncBlades(t, powered.has(t), dt);
        const entry = this.blades.get(t.block.id);
        entry?.mesh.setEnabled(shown);
        entry?.disc.setEnabled(shown);
      }
    }
  }

  dispose(): void {
    this.unsubscribe();
    for (const belt of [...this.belts]) this.removeBelt(belt);
    for (const { thigh, shin } of this.legs.values()) {
      thigh.dispose();
      shin.dispose();
    }
    for (const m of this.glows.values()) m.dispose();
    for (const { mesh, disc } of this.blades.values()) {
      mesh.dispose();
      disc.dispose();
    }
    this.legs.clear();
    this.glows.clear();
    this.blades.clear();
    this.discSource?.material?.dispose();
    this.discSource?.dispose();
    this.discSource = null;
  }

  private onEvent(e: SimEvent): void {
    switch (e.type) {
      case "wheelAdded":
        if (wheelDef(e.wheel.type).track) this.regroup.add(e.wheel.bot);
        break;
      case "blockDestroyed":
        this.forget(e.block.id);
        break;
      case "botRemoved":
        this.regroup.delete(e.bot);
        for (const belt of this.belts.filter((b) => b.bot === e.bot)) this.removeBelt(belt);
        for (const b of e.bot.blocks.values()) this.forget(b.id);
        for (const s of e.bot.supports) this.forget(s.block.id);
        for (const t of e.bot.thrusters) this.forget(t.block.id);
        break;
      default:
        break;
    }
  }

  private forget(blockId: number): void {
    const leg = this.legs.get(blockId);
    if (leg) {
      leg.thigh.dispose();
      leg.shin.dispose();
      this.legs.delete(blockId);
    }
    this.glows.get(blockId)?.dispose();
    this.glows.delete(blockId);
    const blades = this.blades.get(blockId);
    blades?.mesh.dispose();
    blades?.disc.dispose();
    this.blades.delete(blockId);
  }

  // --- Chenilles ---

  /**
   * Les galets voisins d'un même flanc, sur un même morceau, forment une chenille (à la suite, les
   * uns au-dessus des autres, ou l'un sur l'autre vers l'extérieur) : une bande fait le tour de
   * chaque groupe. Refait quand un galet part : la bande se referme sur ceux qui restent, ou se
   * coupe en deux tronçons si le trou est trop grand ; elle ne disparaît qu'avec son dernier galet.
   */
  private buildBelts(bot: Bot): void {
    for (const belt of this.belts.filter((b) => b.bot === bot)) this.removeBelt(belt);
    const byPart = new Map<Part, Wheel[]>();
    for (const w of bot.wheels) {
      if (!w.part || !wheelDef(w.type).track) continue;
      byPart.set(w.part, [...(byPart.get(w.part) ?? []), w]);
    }
    for (const rollers of byPart.values()) {
      for (const group of trackGroups(rollers, (w) => w.local, wheelDef(rollers[0].type))) this.addBelt(bot, group);
    }
  }

  /**
   * Une chenille : de près, sa bande de dessous, ses patins tout autour (render/belts.ts) et le
   * barbotin de son bout arrière ; de loin, une bande épaisse (voir `shoeRange`). Ses galets sont
   * dessinés par WorldView, comme les autres roues.
   */
  private addBelt(bot: Bot, wheels: Wheel[]): void {
    const def = wheelDef(wheels[0].type);
    const centers = wheels.map((w) => w.local);
    const shape = beltShape(centers, def);
    const node = new B.TransformNode(`belt${bot.id}`, this.scene);
    node.rotationQuaternion = new B.Quaternion();
    const material = new B.StandardMaterial(`belt${bot.id}`, this.scene);
    const texture = this.assets.treadTexture();
    material.diffuseTexture = texture;
    material.specularColor = new B.Color3(0.08, 0.08, 0.08);
    // Bande ouverte : on en voit aussi l'intérieur, entre les galets
    material.backFaceCulling = false;
    const [near, far] = [true, false].map((detailed) => {
      const mesh = beltMesh(`belt${bot.id}`, this.scene, shape, def, detailed);
      mesh.material = material;
      mesh.isPickable = false;
      mesh.parent = node;
      this.shadows.addShadowCaster(mesh, false);
      return mesh;
    });
    const shoes = new BeltShoes(`shoes${bot.id}`, near, this.assets.trackShoeSource(shape.width, shoeHorns(shape, centers)), shape);
    const sprockets = sprocketRollers(wheels, (w) => w.local).map((wheel) => {
      const m = this.assets.sprocketSource(wheel.type).createInstance(`sprocket${wheel.id}`);
      m.rotationQuaternion = new B.Quaternion();
      m.isPickable = false;
      return { wheel, mesh: m };
    });
    this.belts.push({ bot, wheels, node, near, far, material, texture, shoes, sprockets, center: vec3(shape.x, 0, 0), scroll: 0, roll: new Map() });
  }

  private removeBelt(belt: Belt): void {
    belt.material.dispose();
    belt.texture.dispose();
    // (ses bandes et les patins avec lui : le matériau des patins, celui du patin source, reste)
    belt.node.dispose();
    for (const s of belt.sprockets) s.mesh.dispose();
    this.belts.splice(this.belts.indexOf(belt), 1);
  }

  /**
   * La bande suit le châssis ; elle et ses patins défilent comme tournent ses galets, le barbotin
   * tourne avec le sien. Un galet arraché (ou emporté par un morceau qui se détache) : la chenille
   * se refait avec les galets qui restent.
   */
  private syncBelts(): void {
    const eye = this.scene.activeCamera?.globalPosition;
    for (const belt of [...this.belts]) {
      const part = belt.wheels[0].part;
      if (!part || belt.wheels.some((w) => w.part !== part)) {
        this.removeBelt(belt);
        this.regroup.add(belt.bot);
        continue;
      }
      const shown = belt.bot !== this.hidden;
      belt.node.setEnabled(shown);
      const rb = part.rb;
      const q = rb.rotation();
      const p = add(rb.translation(), qrot(q, belt.center));
      belt.node.position.set(p.x, p.y, p.z);
      belt.node.rotationQuaternion!.set(q.x, q.y, q.z, q.w);
      const near = shown && !!eye && distance(p, eye) < this.shoeRange;
      belt.near.setEnabled(near);
      belt.far.setEnabled(!near);
      // Chemin fait par la bande depuis l'image précédente : ce dont ses galets ont tourné autour de
      // leur essieu, lu sur leur pose (en réseau, la réplique n'a pas leur vitesse de rotation), fois
      // leur rayon. Quand le robot avance, ils tournent dans le sens positif, et le dessous recule
      const inverse = { x: -q.x, y: -q.y, z: -q.z, w: q.w };
      let turned = 0;
      for (const w of belt.wheels) {
        const rel = qmul(inverse, w.rb.rotation());
        const angle = 2 * Math.atan2(rel.x, rel.w);
        const last = belt.roll.get(w);
        belt.roll.set(w, angle);
        if (last !== undefined) turned += angle - last - 2 * Math.PI * Math.round((angle - last) / (2 * Math.PI));
      }
      const travel = (turned / belt.wheels.length) * wheelDef(belt.wheels[0].type).radius;
      belt.scroll = (belt.scroll + travel / TREAD) % 1;
      belt.texture.vOffset = belt.scroll;
      // Les patins vont avec la texture
      belt.shoes.advance(-travel, near);
      for (const s of belt.sprockets) {
        s.mesh.setEnabled(near);
        if (!near) continue;
        const t = s.wheel.rb.translation();
        const r = s.wheel.rb.rotation();
        s.mesh.position.set(t.x, t.y, t.z);
        s.mesh.rotationQuaternion!.set(r.x, r.y, r.z, r.w);
      }
    }
  }

  // --- Pattes ---

  /**
   * Une patte : de la hanche (le bloc) au pied posé au sol, un peu en dehors du robot. En marche,
   * les pattes avancent et reculent par groupes alternés, et le pied se lève en revenant. Le genou
   * se place par cinématique inverse (deux segments égaux), plié vers le haut et l'extérieur.
   */
  private syncLeg(bot: Bot, s: Support): void {
    let leg = this.legs.get(s.block.id);
    if (!leg) {
      const source = this.assets.legSegmentSource();
      leg = { thigh: this.segment(source), shin: this.segment(source) };
      this.legs.set(s.block.id, leg);
    }
    const hip = blockWorldPos(s.block);
    const part = s.block.part.rb;
    const out = legOut(hip, part.worldCom(), qrot(part.rotation(), vec3(1, 0, 0)));
    const reach = blockDef(s.block.type).support!.reach;
    const drop = Number.isFinite(s.contact) ? s.contact : reach * 0.8;
    let foot = add(hip, add(scale(out, FOOT_OUT), vec3(0, -drop, 0)));
    // Allure : deux groupes de pattes en opposition de phase
    const v = part.linvel();
    const moving = Math.hypot(v.x, v.z) > 0.2 && s.block.part === bot.cockpit.part;
    if (moving) {
      const offset = (s.block.x + s.block.z) % 2 === 0 ? 0 : Math.PI;
      const forward = norm(vec3(v.x, 0, v.z));
      foot = add(foot, add(scale(forward, HALF_STEP * Math.sin(s.phase + offset)), vec3(0, FOOT_LIFT * Math.max(0, Math.cos(s.phase + offset)), 0)));
    }
    // Genou : deux segments égaux, plié vers le haut et l'extérieur
    const knee = kneeOf(hip, foot, out);
    this.place(leg.thigh, hip, knee);
    this.place(leg.shin, knee, foot);
  }

  private segment(source: B.Mesh): B.InstancedMesh {
    const mesh = source.createInstance("leg");
    mesh.rotationQuaternion = new B.Quaternion();
    mesh.isPickable = false;
    this.shadows.addShadowCaster(mesh, false);
    return mesh;
  }

  /** Place un segment (source de longueur 1 le long de z) entre `a` et `b`. */
  private place(mesh: B.InstancedMesh, a: Vec3, b: Vec3): void {
    const d = sub(b, a);
    const length = len(d);
    const z = scale(d, 1 / Math.max(length, 1e-6));
    const x = norm(Math.abs(z.y) < 0.95 ? cross(vec3(0, 1, 0), z) : cross(vec3(1, 0, 0), z));
    const q = quatFromBasis(x, cross(z, x), z);
    const mid = scale(add(a, b), 0.5);
    mesh.position.set(mid.x, mid.y, mid.z);
    mesh.rotationQuaternion!.set(q.x, q.y, q.z, q.w);
    mesh.scaling.set(1, 1, length);
  }

  // --- Patins ---

  /** Lueur sous un patin anti-gravité, d'autant plus vive qu'il porte. */
  private syncGlow(s: Support): void {
    let glow = this.glows.get(s.block.id);
    if (!glow) {
      glow = this.assets.hoverGlowSource().createInstance("glow");
      glow.rotationQuaternion = new B.Quaternion();
      glow.isPickable = false;
      this.glows.set(s.block.id, glow);
    }
    const spec = blockDef(s.block.type).support!;
    const load = clamp(s.force / (spec.ratedLoad * GRAVITY), 0, 1.5);
    const q = qmul(s.block.part.rb.rotation(), s.block.rot);
    const p = add(blockWorldPos(s.block), qrot(q, vec3(0, -BLOCK_SIZE / 2 - 0.04, 0)));
    glow.position.set(p.x, p.y, p.z);
    glow.rotationQuaternion!.copyFrom(toQuat(q));
    // Plus faible (et vacillante) quand les batteries s'épuisent
    glow.scaling.setAll((0.5 + 0.5 * load) * padGlow(s.block.bot, performance.now() / 1000));
    glow.isVisible = load > 0.02;
  }

  // --- Rotors ---

  /**
   * Pales d'un rotor orientable (elles tournent selon la poussée et s'inclinent avec elle), ou
   * hélice d'un rotor de queue (un réacteur couché, qui pousse de côté) : sur la face du bloc vers
   * laquelle il pousse, elle tourne autour de l'axe de poussée.
   */
  private syncBlades(t: Thruster, powered: boolean, dt: number): void {
    const propeller = blockDef(t.block.type).thruster?.look === "propeller";
    const tail = !propeller && t.role === "trim";
    // Même choix que l'encombrement (`bladeKind`), d'après le rôle du moteur
    const kind: BladeKind = propeller ? "propeller" : tail ? "tail" : "rotor";
    let entry = this.blades.get(t.block.id);
    if (!entry) {
      const mesh = this.assets.bladeSource(kind).createInstance("blades");
      mesh.rotationQuaternion = new B.Quaternion();
      mesh.isPickable = false;
      this.shadows.addShadowCaster(mesh, false);
      const disc = this.blurDisc().createInstance("blade-disc");
      disc.rotationQuaternion = new B.Quaternion();
      disc.isPickable = false;
      const { diameter } = BLADES[kind];
      disc.scaling.set(diameter, 1, diameter);
      entry = { mesh, disc, angle: 0, speed: 0 };
      this.blades.set(t.block.id, entry);
    }
    const spec = blockDef(t.block.type).thruster!;
    const ratio = clamp(t.thrust / spec.maxThrust, 0, 1);
    // Régime : au ralenti dès qu'il est alimenté, plus vite avec la poussée ; il s'y fait avec inertie
    const rpm = propeller ? PROPELLER_RPM : tail ? TAIL_RPM : ROTOR_RPM;
    // Une hélice d'avion s'arrête quand on coupe les gaz (il plane)
    const running = powered && !(propeller && ratio < PROPELLER_STOP);
    // Une hélice tranchante a son régime dans la simulation (combat/melee.ts, et l'instantané) : un coup le fait chuter
    const blade = propeller ? t.block.bot.melee.find((a) => a.block === t.block) : undefined;
    const target = blade ? blade.spin : running ? rpm.idle + (rpm.full - rpm.idle) * ratio : 0;
    const tau = target > entry.speed ? SPOOL_UP : SPOOL_DOWN;
    entry.speed += (target - entry.speed) * (1 - Math.exp(-dt / tau));
    // Écart entre deux pales : trois pales à une hélice d'avion, deux en queue, quatre au rotor principal
    const gap = propeller ? (Math.PI * 2) / 3 : tail ? Math.PI : Math.PI / 2;
    entry.angle = (entry.angle + Math.min(entry.speed * dt, gap * STROBE_LIMIT)) % (Math.PI * 2);
    const base = qmul(t.block.part.rb.rotation(), t.block.rot);
    const thrust = Math.max(1, t.thrust);
    const tilt = qmul(axisAngle(vec3(0, 0, 1), -t.tiltA / thrust), axisAngle(vec3(1, 0, 0), t.tiltB / thrust));
    // Hélice abîmée : un balourd, elle tremble en tournant
    const health = engineHealth(t);
    const wobble = health < ENGINE_WORN && entry.speed > 1 ? (1 - health / ENGINE_WORN) * WOBBLE : 0;
    const shaken = wobble ? qmul(qmul(base, tilt), axisAngle(vec3(Math.cos(entry.angle * 3.1), 0, Math.sin(entry.angle * 3.1)), wobble)) : qmul(base, tilt);
    const q = qmul(shaken, axisAngle(vec3(0, 1, 0), entry.angle));
    const p = add(blockWorldPos(t.block), qrot(base, vec3(0, BLOCK_SIZE / 2 + BLADES[kind].offset, 0)));
    entry.mesh.position.set(p.x, p.y, p.z);
    entry.mesh.rotationQuaternion!.copyFrom(toQuat(q));
    // Disque flou, dès qu'elles tournent vite
    const blurred = entry.speed > rpm.idle * BLUR_FROM;
    entry.disc.isVisible = blurred;
    if (blurred) {
      entry.disc.position.set(p.x, p.y, p.z);
      entry.disc.rotationQuaternion!.copyFrom(toQuat(shaken));
    }
  }

  /** Disque flou des pales : un disque sombre et translucide de diamètre 1, dans le plan horizontal. */
  private blurDisc(): B.Mesh {
    if (this.discSource) return this.discSource;
    const disc = B.MeshBuilder.CreateCylinder("blade-disc", { height: 0.01, diameter: 1, tessellation: 36 }, this.scene);
    const mat = new B.StandardMaterial("blade-disc", this.scene);
    mat.diffuseColor = B.Color3.FromHexString("#3a3f45");
    mat.specularColor = B.Color3.Black();
    mat.backFaceCulling = false;
    mat.disableDepthWrite = true;
    mat.alpha = BLUR_ALPHA;
    disc.material = mat;
    disc.isVisible = false;
    disc.isPickable = false;
    this.discSource = disc;
    return disc;
  }
}
