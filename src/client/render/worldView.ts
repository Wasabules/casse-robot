import * as B from "../babylon";
import type { RigidBody } from "@dimforge/rapier3d-compat";
import { blockDef, BLOCK_TYPES } from "../../shared/catalog/blocks";
import { propDef } from "../../shared/catalog/props";
import { wheelDef } from "../../shared/catalog/wheels";
import { BLOCK_SIZE } from "../../shared/config";
import { clamp } from "../../shared/math/scalar";
import { add, axisAngle, dot, NO_ROTATION, qmul, qrot, qrotInv, scale, sub, vec3, type Quat, type Vec3 } from "../../shared/math/vec";
import { liveThrusters } from "../../shared/robot/queries";
import { botJets, jetContact, jetHeat } from "../../shared/robot/exhaust";
import { carrierCell, flapRuns, hingeChord, isFlap, linkedAt, surfaceSides } from "../../shared/robot/surfaces";
import { ENGINE_WORN, engineHealth } from "../../shared/robot/propulsion";
import { AFTERBURNER } from "./fx/engineFx";
import type { AeroSurface, Block, Bot, Debris, DebrisLook, Part, Prop, Turret, Wheel, WheelBody } from "../../shared/sim/entities";
import type { SimEvent } from "../../shared/sim/events";
import type { World } from "../../shared/sim/world";
import { mountFace, wheelFittings } from "./fittings";
import type { FxLook } from "../settings";
import type { Assets } from "./materials";
import type { TurretBlockType } from "./models";
import { charLevel, type CharLevel } from "./propModels";
import { firingTurret, recoilKick } from "./recoil";
import { hasBlades } from "./locomotionView";
import { BotTag } from "./tags";
import { ROUND_RETURN, ROUND_SLIDE, visibleRounds } from "./rounds";
import { mergeSegments, type PlacedSegment } from "./surfaceModels";
import { weaponDef } from "../../shared/catalog/weapons";
import { headLift, JET_NACELLE } from "../../shared/design/clearance";
import { MeleeRig } from "./meleeView";
import { MELEE_IDS } from "../../shared/catalog/melee";
import { lampColors, lampLevels, LIGHT_BLOCKS, lightPowered, sweepAngle } from "./lightSources";

/** Échelle d'un débris par rapport à un bloc, et d'un éclat par rapport à son accessoire. */
const DEBRIS_SCALE = 0.47;
const SHARD_SCALE = 0.35;
/** Durée pendant laquelle un débris rétrécit avant de disparaître (s). */
const DEBRIS_FADE = 0.6;
/** Assombrissement d'un bloc sur le point d'être détruit (0 : aucun, 1 : noir). */
const WEAR_DARKEN = 0.55;
/** Roussi d'un bloc sur le point d'être détruit : le vert et le bleu baissent plus que le rouge (0 : aucun). */
const SCORCH = 0.5;
/** Taches d'usure : chaque bloc abîmé s'assombrit un peu plus ou un peu moins que son voisin (0 : uniforme). */
const BLOTCH = 0.3;
/** Noircissement d'un bloc couvert de suie (feu, explosion de près), au plus. */
const SOOT_DARKEN = 0.6;
/** Suie laissée par un feu, et par une explosion au plus près (elle s'estompe avec la distance, jusqu'à SOOT_REACH rayons). */
const FIRE_SOOT = 0.55;
const BLAST_SOOT = 0.7;
const SOOT_REACH = 1.6;
/** Une réparation efface une part de la suie. */
const REPAIR_CLEANS = 0.3;
/**
 * Suie que prend par seconde un bloc léché par le jet de flamme d'un moteur (robot/exhaust.ts), pour
 * `JET_SOOT_HEAT` dégâts par seconde (moins, d'un jet moins chaud) ; les jets se relisent toutes les
 * `JET_SOOT_EVERY` s de temps simulé.
 */
const JET_SOOT = 0.45;
const JET_SOOT_HEAT = 40;
const JET_SOOT_EVERY = 0.1;
/** Une flamme qui bute sur un obstacle le dépasse de si peu (m) : elle s'écrase dessus (les flammèches sont des effets). */
const FLAME_PAST_STOP = 0.12;
/** Bout de la tuyère d'un turboréacteur, sous le centre de son bloc (m) : sa flamme part de là. */
const JET_NOZZLE = JET_NACELLE.nozzle;
/** Recul d'une tête de tourelle : elle part en arrière d'un coup, et revient en RECOIL_RETURN s. */
const RECOIL_RETURN = 0.18;
const UNIT = new B.Vector3(1, 1, 1);

/** Blocs d'un morceau qui ont le même aspect : une mesh, et une instance fine par bloc (dans l'ordre de `blocks`). */
interface Batch {
  readonly mesh: B.Mesh;
  readonly source: B.Mesh;
  readonly part: number;
  readonly blocks: Block[];
}

/**
 * Ailes et gouvernes, d'une pièce (render/surfaceModels.ts) : les ailes d'un morceau (une pièce
 * immobile, par type), ou un rang de gouvernes (shared/robot/surfaces.ts), qui pivote autour de sa
 * charnière. Sa couleur d'usure est une couleur de sommets, case par case.
 */
interface SurfacePiece {
  readonly bot: Bot;
  readonly part: number;
  readonly mesh: B.Mesh;
  /** Ses blocs, et pour chacun son premier sommet et son nombre de sommets. */
  readonly blocks: Block[];
  readonly ranges: [number, number][];
  readonly colors: Float32Array;
  /**
   * Rang de gouvernes : son braquage (tous ses blocs braquent du même angle), l'orientation de ses
   * blocs, sa charnière (repère du robot), et le rang qui le porte (juste devant lui), ou null.
   */
  readonly flap: { surface: AeroSurface; rot: Quat; pivot: Vec3; carrier: SurfacePiece | null } | null;
}

/** Pose d'un bloc dans le repère de son morceau. */
const blockMatrix = (block: Block): B.Matrix =>
  B.Matrix.Compose(UNIT, new B.Quaternion(block.rot.x, block.rot.y, block.rot.z, block.rot.w), new B.Vector3(block.local.x, block.local.y, block.local.z));

/**
 * Couleur multiplicative d'un bloc : il s'assombrit et roussit en proportion des points de
 * structure perdus, par taches (chaque bloc un peu à sa façon), et noircit de suie (`soot`, 0 à 1)
 * s'il a brûlé ou pris une explosion de près.
 */
function wearColor(block: Block, soot = 0): number[] {
  const wear = 1 - Math.max(0, block.hp) / BLOCK_TYPES[block.type].hp;
  const k = (1 - WEAR_DARKEN * wear) * (1 - BLOTCH * wear * blotch(block.id));
  const scorch = SCORCH * wear;
  const s = 1 - SOOT_DARKEN * Math.min(1, soot);
  return [k * s, k * (1 - 0.4 * scorch) * s, k * (1 - 0.75 * scorch) * s, 1];
}

/** Tache d'un bloc : un nombre de 0 à 1 tiré de son identifiant (toujours le même pour un bloc). */
function blotch(id: number): number {
  const x = Math.sin(id * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Un accessoire affiché ; `placed` : ancré et déjà posé, sa matrice est figée. `char` : son cran de
 * noircissement (sa source en dépend). `sway` : un arbre qui ploie sous un souffle (voir `swayTrees`).
 */
interface PropEntry {
  prop: Prop;
  mesh: B.InstancedMesh;
  jet: B.InstancedMesh | null;
  placed: boolean;
  char: CharLevel;
  sway: Sway | null;
}

/** Un arbre qui ploie : il penche autour du pied de son tronc (`axis`), oscille et revient, amorti. */
interface Sway {
  axis: B.Vector3;
  amplitude: number;
  t: number;
  /** Sa pose de repos. */
  position: B.Vector3;
  rotation: B.Quaternion;
}

/** Arbres qui ploient : portée du souffle (en rayons d'explosion, plus le feuillage), inclinaison maximale (rad), oscillation. */
const SWAY_REACH = 3;
const SWAY_MAX = 0.2;
const SWAY_FREQ = 6.5;
const SWAY_DAMP = 2.2;
const SWAY_TIME = 2.6;

/** Échelle d'un débris : un cube de bloc réduit, un éclat d'accessoire réduit, ou un morceau de mur à sa taille. */
const debrisScale = (look: DebrisLook): number => (look.kind === "block" ? DEBRIS_SCALE : look.size ?? SHARD_SCALE);

function syncBody(rb: RigidBody | WheelBody, node: B.TransformNode): void {
  const t = rb.translation();
  const r = rb.rotation();
  node.position.set(t.x, t.y, t.z);
  (node.rotationQuaternion ??= new B.Quaternion()).set(r.x, r.y, r.z, r.w);
}

/**
 * Représentation Babylon de la simulation (robots, accessoires, débris). Les meshes sont créés
 * et détruits en réponse aux événements (voir shared/sim/events.ts) ; `sync()` recopie les poses
 * à chaque image. Chaque morceau est un TransformNode ; ses blocs sont groupés par aspect (type,
 * couleur) en lots d'instances fines qui lui sont parentés : Babylon ne calcule qu'une matrice par
 * lot, et ne renvoie ses instances au GPU que quand un bloc change (détruit, abîmé, déplacé). Les
 * ailes d'un morceau sont une seule pièce, chaque rang de gouvernes une autre, qui pivote autour de
 * sa charnière (`buildSurfaces`). Ce qui bouge avec un bloc (tête de tourelle, flamme, feu) est
 * accroché à son repère (`anchor`). Les projectiles ont leur propre vue (projectiles.ts).
 */
export class WorldView {
  private readonly sim: World;
  private readonly scene: B.Scene;
  private readonly assets: Assets;
  private readonly shadows: B.ShadowGenerator;
  private readonly unsubscribe: () => void;

  private readonly parts = new Map<number, { part: Part; node: B.TransformNode }>();
  /** Lots de blocs, par morceau puis par mesh source. */
  private readonly batches = new Map<number, Map<B.Mesh, Batch>>();
  /** Lot de chaque bloc affiché en instance fine. */
  private readonly slots = new Map<number, Batch>();
  /** Lots dont les instances ont changé : on les renvoie au GPU à la prochaine image. */
  private readonly dirty = new Set<Batch>();
  /**
   * Ailes et gouvernes, par clé (ce qui décide de leur géométrie : morceau, blocs et leurs profils,
   * charnière, rang porteur), et la pièce de chaque bloc. Refaites au début de l'image qui
   * suit un changement de structure de leur robot (`surfacesDirty`) ; seules celles qui ont changé
   * sont reconstruites. `repainted` : pièces dont une couleur d'usure a changé.
   */
  private readonly pieces = new Map<string, SurfacePiece>();
  private readonly pieceOf = new Map<number, SurfacePiece>();
  private readonly surfacesDirty = new Set<Bot>();
  private readonly repainted = new Set<SurfacePiece>();
  /** Repères des blocs qui portent quelque chose (tête, flamme, feu), créés à la demande. */
  private readonly anchors = new Map<number, B.TransformNode>();
  private readonly wheels = new Map<number, { wheel: Wheel; mesh: B.InstancedMesh }>();
  /**
   * Bras de direction des roues directrices montées sur un flanc, du bloc support au pivot : ils
   * suivent le porte-moyeu, qui monte et descend avec la suspension mais ne braque pas.
   */
  private readonly arms = new Map<number, { wheel: Wheel; mesh: B.InstancedMesh; offset: B.Vector3 }>();
  /** Fourches des roulettes et des roues posées sous un bloc : elles suivent le porte-moyeu (et pivotent avec lui). */
  private readonly forks = new Map<number, { wheel: Wheel; mesh: B.InstancedMesh }>();
  /** Potences des roulettes posées sur un flanc, du bloc au pivot : elles suivent le morceau. */
  private readonly stems = new Map<number, { wheel: Wheel; mesh: B.InstancedMesh; local: Vec3; alongZ: boolean }>();
  private readonly debris = new Map<number, { debris: Debris; mesh: B.InstancedMesh }>();
  private readonly props = new Map<number, PropEntry>();
  /** Heure de la page à la dernière image (s) : les arbres qui ploient s'animent en temps réel. */
  private lastSync = performance.now() / 1000;
  /** Un accessoire vient de céder (pan de mur, arbre, caisse) : sa dernière position, pour la poussière. */
  onPropBroken: ((prop: Prop, at: Vec3) => void) | null = null;
  private readonly tags = new Map<number, BotTag>();
  /** Étiquettes des robots affichées (masquées pendant la démonstration derrière le menu). */
  tagsVisible = true;
  /** Robots dont on montre l'étiquette : ceux que l'équipe du joueur a repérés (tous, par défaut). */
  tagFilter: (bot: Bot) => boolean = () => true;
  /** Flammes des moteurs et têtes de tourelles, par id de leur bloc. */
  private readonly flames = new Map<number, B.InstancedMesh>();
  /** Nacelles des turboréacteurs, par bloc. */
  private readonly nacelles = new Map<number, B.InstancedMesh>();
  /** Feux sur les blocs, par id de bloc (des cônes en effets simples ; cachés en effets réalistes, où ce sont des particules : render/fx/fireFx.ts). */
  private readonly fires = new Map<number, B.InstancedMesh>();
  /** Verre allumé des phares et des balises, par id de bloc (voir `syncLenses`). */
  private readonly lenses = new Map<number, B.InstancedMesh[]>();
  private realisticFx = false;
  /** Suie sur les blocs (0 à 1), par id de bloc : ils ont brûlé, ou une explosion les a léchés (voir `wearColor`). */
  private readonly soot = new Map<number, number>();
  /** Temps simulé de la dernière lecture des jets de flamme (voir `readJets`). */
  private jetsReadAt = 0;
  /** Distance de sa tuyère à ce que touche le jet de chaque moteur (par id de son bloc) : sa flamme s'arrête là. */
  private readonly jetStops = new Map<number, number>();
  private readonly heads = new Map<number, B.InstancedMesh>();
  /**
   * Munitions visibles de chaque tête (missiles, roquettes, ogive, bombes, capsules : render/rounds.ts) :
   * leurs instances et leurs places, combien sont montrées, et quand chacune est revenue (rechargée).
   */
  private readonly rounds = new Map<number, { meshes: B.InstancedMesh[]; places: B.Vector3[]; shown: number; back: number[] }>();
  /** Têtes de tourelles qui reculent (par bloc) : de combien (m), et depuis quand (temps simulé). */
  private readonly kicks = new Map<number, { back: number; at: number }>();
  /** Parties mobiles des armes de contact (barres des toupies, bras des marteaux), et la vibration des robots déséquilibrés. */
  private readonly melee: MeleeRig;
  /** Robot auquel appartient un nœud de morceau ou le mesh d'une roue (visée en réseau : on vise à travers son robot). */
  private readonly owners = new WeakMap<B.Node, Bot>();
  /** Robot qu'on ne dessine pas : celui du joueur quand la caméra est dans son arme (viseur). */
  hidden: Bot | null = null;

  constructor(sim: World, scene: B.Scene, assets: Assets, shadows: B.ShadowGenerator) {
    this.sim = sim;
    this.scene = scene;
    this.assets = assets;
    this.shadows = shadows;
    this.melee = new MeleeRig(assets, shadows);
    this.unsubscribe = sim.on((e) => this.onEvent(e));
  }

  /** Recopie les poses des corps et met à jour étiquettes, débris, flammes, gouvernes, tourelles et armes de contact. */
  sync(camera: B.Camera): void {
    const now = performance.now() / 1000;
    const dt = Math.min(0.1, now - this.lastSync);
    this.lastSync = now;
    this.buildSurfaces();
    this.flushBatches();
    this.melee.hidden = this.hidden;
    this.melee.update(dt);
    // Un robot dont un rotor a du balourd vibre tout entier
    const shakes = new Map<Bot, B.Vector3 | null>();
    for (const { part, node } of this.parts.values()) {
      syncBody(part.rb, node);
      node.setEnabled(part.bot !== this.hidden);
      if (!part.bot.melee.length) continue;
      let shake = shakes.get(part.bot);
      if (shake === undefined) shakes.set(part.bot, (shake = this.melee.shake(part.bot)));
      if (shake) node.position.addInPlace(shake);
    }
    for (const { wheel, mesh } of this.wheels.values()) {
      syncBody(wheel.rb, mesh);
      mesh.setEnabled(wheel.bot !== this.hidden);
    }
    this.syncArms();
    this.syncFittings();
    for (const entry of this.props.values()) this.syncProp(entry, dt);
    for (const { debris, mesh } of this.debris.values()) {
      syncBody(debris.rb, mesh);
      const left = debris.life - (this.sim.time - debris.born);
      if (left < DEBRIS_FADE) mesh.scaling.setAll(debrisScale(debris.look) * Math.max(0.05, left / DEBRIS_FADE));
    }
    for (const tag of this.tags.values()) tag.update(camera, this.tagsVisible && this.tagFilter(tag.bot));
    this.readJets();
    this.syncFlames();
    this.syncFires();
    this.syncLenses();
    this.syncFlaps();
    this.syncTurrets();
  }

  /** Le mesh fait-il partie de ce robot (un de ses blocs, de ses roues) ? */
  belongsTo(mesh: B.AbstractMesh, bot: Bot): boolean {
    for (let node: B.Node | null = mesh; node; node = node.parent) {
      const owner = this.owners.get(node);
      if (owner) return owner === bot;
    }
    return false;
  }

  /** La langue a changé : les étiquettes au-dessus des robots se redessinent (le nom d'un robot prédéfini se traduit). */
  refreshTags(): void {
    for (const tag of this.tags.values()) tag.redraw();
  }

  dispose(): void {
    this.unsubscribe();
    this.melee.dispose();
    // Les lots, les repères et ce qui y est accroché disparaissent avec les nœuds des morceaux
    for (const { node } of this.parts.values()) node.dispose();
    for (const { mesh } of [...this.wheels.values(), ...this.arms.values(), ...this.forks.values(), ...this.stems.values(), ...this.debris.values(), ...this.props.values()]) mesh.dispose();
    for (const tag of this.tags.values()) tag.dispose();
    for (const map of [this.parts, this.batches, this.slots, this.pieces, this.pieceOf, this.anchors, this.wheels, this.arms, this.forks, this.stems, this.debris, this.props, this.tags, this.flames, this.heads, this.rounds, this.fires, this.kicks, this.nacelles, this.soot, this.lenses]) map.clear();
    this.dirty.clear();
    this.surfacesDirty.clear();
    this.repainted.clear();
  }

  private onEvent(e: SimEvent): void {
    switch (e.type) {
      case "botAdded":
        this.tags.set(e.bot.id, new BotTag(this.scene, e.bot));
        break;
      case "botRemoved":
        this.tags.get(e.bot.id)?.dispose();
        this.tags.delete(e.bot.id);
        for (const b of e.bot.blocks.values()) this.soot.delete(b.id);
        for (const [key, piece] of this.pieces) if (piece.bot === e.bot) this.dropPiece(key, piece);
        this.surfacesDirty.delete(e.bot);
        break;
      case "partAdded":
        this.addPart(e.part);
        break;
      case "partRemoved":
        this.removePart(e.part);
        break;
      case "blockAttached":
        this.attachBlock(e.block);
        break;
      case "blockRebuilt":
        this.soot.delete(e.block.id);
        this.attachBlock(e.block);
        this.showWear(e.block);
        break;
      case "blockDamaged":
        this.showWear(e.block);
        break;
      case "blockRepaired": {
        const soot = this.soot.get(e.block.id);
        if (soot !== undefined) this.soot.set(e.block.id, soot * (1 - REPAIR_CLEANS));
        this.showWear(e.block);
        break;
      }
      case "blockDestroyed":
        this.soot.delete(e.block.id);
        this.disposeBlock(e.block);
        // Une aile ou une gouverne perdue, ou un bloc qui en portait : les pièces se refont
        if (e.block.bot.surfaces.length) this.surfacesDirty.add(e.block.bot);
        break;
      case "explosion":
        // Le souffle noircit les blocs proches et fait ployer les arbres
        this.blacken(e.point, e.radius);
        this.swayTrees(e.point, e.radius);
        break;
      case "wheelAdded":
        this.addWheel(e.wheel);
        break;
      case "wheelRemoved":
        this.disposeFrom(this.wheels, e.wheel.id);
        this.disposeFrom(this.arms, e.wheel.id);
        this.disposeFrom(this.forks, e.wheel.id);
        this.disposeFrom(this.stems, e.wheel.id);
        break;
      case "debrisAdded":
        this.addDebris(e.debris);
        break;
      case "debrisRemoved":
        this.disposeFrom(this.debris, e.debris.id);
        break;
      case "propAdded":
        this.addProp(e.prop);
        break;
      case "propReleased": {
        // Il tombe : sa pose change désormais à chaque image
        const entry = this.props.get(e.prop.id);
        entry?.mesh.unfreezeWorldMatrix();
        if (entry) entry.placed = false;
        break;
      }
      case "propRemoved": {
        // Son corps est déjà retiré du monde : on prend la dernière pose de son mesh
        const entry = this.props.get(e.prop.id);
        if (entry && e.prop.state.kind !== "intact") this.onPropBroken?.(e.prop, vec3(entry.mesh.position.x, entry.mesh.position.y, entry.mesh.position.z));
        this.disposeFrom(this.props, e.prop.id);
        break;
      }
      case "propFire": {
        const entry = this.props.get(e.prop.id);
        if (entry) this.charProp(entry);
        break;
      }
      case "fireStarted":
        this.soot.set(e.block.id, Math.max(this.soot.get(e.block.id) ?? 0, FIRE_SOOT));
        this.showWear(e.block);
        this.addFire(e.block);
        break;
      case "fireEnded":
        this.fires.get(e.block.id)?.dispose();
        this.fires.delete(e.block.id);
        break;
      case "shot": {
        // Recul : la tête de la tourelle qui a tiré part en arrière, puis revient (voir `syncTurrets`)
        const back = recoilKick(e.weapon).back;
        const t = back > 0 ? firingTurret(this.sim, e.weapon, e.origin) : null;
        if (t) this.kicks.set(t.block.id, { back, at: this.sim.time });
        break;
      }
      default:
        break;
    }
  }

  /** Instance d'un mesh source, orientable par quaternion et qui projette une ombre. */
  private instance(source: B.Mesh, name: string): B.InstancedMesh {
    const mesh = source.createInstance(name);
    mesh.rotationQuaternion = new B.Quaternion();
    this.shadows.addShadowCaster(mesh, false);
    return mesh;
  }

  /**
   * Roue, et ses ferrures : bras de direction d'une roue directrice montée sur le flanc gauche ou
   * droit de son bloc, fourche d'une roulette ou d'une roue posée dessous, potence d'une roulette
   * posée sur un flanc.
   */
  private addWheel(wheel: Wheel): void {
    const wheelMesh = this.instance(this.assets.wheelSource(wheel.type), "wheel");
    this.owners.set(wheelMesh, wheel.bot);
    this.wheels.set(wheel.id, { wheel, mesh: wheelMesh });
    const support = wheel.bot.blocks.get(wheel.mountKey);
    if (!support) return;
    const { fork, stem } = wheelFittings(wheelDef(wheel.type), wheel.local, support.local);
    // Les ferrures ne se visent pas : on vise à travers elles (et à travers son robot, en réseau)
    const fitting = (source: B.Mesh, name: string): B.InstancedMesh => {
      const mesh = this.instance(source, name);
      mesh.isPickable = false;
      return mesh;
    };
    if (fork !== null) this.forks.set(wheel.id, { wheel, mesh: fitting(this.assets.forkSource(wheel.type, fork), "fork") });
    if (stem) this.stems.set(wheel.id, { wheel, mesh: fitting(this.assets.steeringArmSource(stem.length), "stem"), local: stem.center, alongZ: stem.alongZ });
    if (!wheel.steerable || mountFace(wheel.local, support.local) !== "side") return;
    const dx = support.local.x - wheel.local.x;
    const length = Math.abs(dx) - BLOCK_SIZE / 2;
    const mesh = this.instance(this.assets.steeringArmSource(length), "arm");
    this.arms.set(wheel.id, { wheel, mesh, offset: new B.Vector3((Math.sign(dx) * length) / 2, 0, 0) });
  }

  /** Les bras suivent le porte-moyeu ; ils disparaissent avec lui quand la roue est arrachée. */
  private syncArms(): void {
    for (const [id, { wheel, mesh, offset }] of this.arms) {
      if (!wheel.hub) {
        this.disposeFrom(this.arms, id);
        continue;
      }
      syncBody(wheel.hub, mesh);
      mesh.position.addInPlace(offset.applyRotationQuaternion(mesh.rotationQuaternion!));
      mesh.setEnabled(wheel.bot !== this.hidden);
    }
  }

  /** Fourches et potences suivent la roue ; elles disparaissent avec elle quand elle est arrachée. */
  private syncFittings(): void {
    for (const [id, { wheel, mesh }] of this.forks) {
      if (!wheel.hub) {
        this.disposeFrom(this.forks, id);
        continue;
      }
      syncBody(wheel.hub, mesh);
      mesh.setEnabled(wheel.bot !== this.hidden);
    }
    for (const [id, { wheel, mesh, local, alongZ }] of this.stems) {
      if (!wheel.hub || !wheel.part) {
        this.disposeFrom(this.stems, id);
        continue;
      }
      const rb = wheel.part.rb;
      const q = alongZ ? qmul(rb.rotation(), axisAngle(vec3(0, 1, 0), Math.PI / 2)) : rb.rotation();
      const t = rb.translation();
      const p = qrot(rb.rotation(), local);
      mesh.position.set(t.x + p.x, t.y + p.y, t.z + p.z);
      mesh.rotationQuaternion!.set(q.x, q.y, q.z, q.w);
      mesh.setEnabled(wheel.bot !== this.hidden);
    }
  }

  private addPart(part: Part): void {
    const node = new B.TransformNode(`part${part.id}`, this.scene);
    this.owners.set(node, part.bot);
    syncBody(part.rb, node);
    this.parts.set(part.id, { part, node });
  }

  private removePart(part: Part): void {
    for (const [key, piece] of this.pieces) if (piece.part === part.id) this.dropPiece(key, piece);
    for (const b of part.blocks) this.disposeBlock(b);
    for (const lot of this.batches.get(part.id)?.values() ?? []) {
      lot.mesh.dispose();
      this.dirty.delete(lot);
    }
    this.batches.delete(part.id);
    this.parts.get(part.id)?.node.dispose();
    this.parts.delete(part.id);
  }

  /**
   * Affiche le bloc dans le lot de son morceau, ou l'y déplace (séparation), avec la tête d'une
   * tourelle. Les ailes et les gouvernes sont des pièces à part (voir `buildSurfaces`), qui se
   * refont aussi quand un bloc voisin arrive ou change de morceau.
   */
  private attachBlock(block: Block): void {
    const node = this.parts.get(block.part.id)?.node ?? null;
    const anchor = this.anchors.get(block.id);
    if (anchor) anchor.parent = node;
    if (block.bot.surfaces.length) this.surfacesDirty.add(block.bot);
    if (!blockDef(block.type).aero && this.slots.get(block.id)?.part !== block.part.id) {
      this.unbatch(block);
      this.batch(block);
    }
    // Un turboréacteur : sa nacelle dépasse de son bloc, le long de son axe de poussée
    if (blockDef(block.type).thruster?.look === "jet" && !this.nacelles.has(block.id)) {
      const nacelle = this.assets.jetNacelleSource().createInstance("nacelle");
      nacelle.parent = this.anchor(block);
      this.shadows.addShadowCaster(nacelle, false);
      this.nacelles.set(block.id, nacelle);
    }
    // Une arme de contact : sa barre ou son bras, qui tourne autour de son moyeu (render/meleeView.ts)
    if (blockDef(block.type).melee) this.melee.attach(block, this.anchor(block));
    const turret = blockDef(block.type).turret;
    if (turret && !this.heads.has(block.id)) {
      const head = this.assets.turretHeadSource(block.type as TurretBlockType).createInstance("head");
      head.parent = this.anchor(block);
      head.position.set(0, headLift(turret), 0);
      head.rotationQuaternion = new B.Quaternion();
      this.shadows.addShadowCaster(head, false);
      this.heads.set(block.id, head);
      // Ses munitions visibles : elles tournent et reculent avec elle
      const meshes = this.assets.addRounds(block.type as TurretBlockType, head);
      for (const m of meshes) this.shadows.addShadowCaster(m, false);
      if (meshes.length) {
        this.rounds.set(block.id, { meshes, places: meshes.map((m) => m.position.clone()), shown: meshes.length, back: meshes.map(() => -Infinity) });
      }
    }
  }

  /** Repère du bloc dans son morceau, pour ce qui le suit (tête de tourelle, flamme, feu). */
  private anchor(block: Block): B.TransformNode {
    let node = this.anchors.get(block.id);
    if (!node) {
      node = new B.TransformNode(`bloc${block.id}`, this.scene);
      node.position.set(block.local.x, block.local.y, block.local.z);
      const r = block.rot;
      node.rotationQuaternion = new B.Quaternion(r.x, r.y, r.z, r.w);
      node.parent = this.parts.get(block.part.id)?.node ?? null;
      this.anchors.set(block.id, node);
    }
    return node;
  }

  /** Ajoute le bloc au lot de son aspect dans son morceau (le lot se crée au premier bloc). */
  private batch(block: Block): void {
    const source = this.assets.blockSource(block.type, block.bot.profile.color);
    let lots = this.batches.get(block.part.id);
    if (!lots) this.batches.set(block.part.id, (lots = new Map()));
    let lot = lots.get(source);
    if (!lot) {
      const mesh = new B.Mesh(`lot${block.part.id}`, this.scene);
      // Une géométrie à lui : Babylon range le tampon de couleur des instances fines sur la
      // géométrie, et des lots qui la partageraient écraseraient celui des autres (sur un vrai
      // GPU, un lot plus grand que le tampon d'un autre ne serait plus dessiné du tout)
      source.geometry?.copy(`lot${block.part.id}-${source.name}`).applyToMesh(mesh);
      mesh.material = source.material;
      mesh.receiveShadows = true;
      mesh.parent = this.parts.get(block.part.id)?.node ?? null;
      mesh.thinInstanceEnablePicking = true;
      mesh.thinInstanceRegisterAttribute(B.VertexBuffer.ColorKind, 4);
      this.shadows.addShadowCaster(mesh, false);
      lot = { mesh, source, part: block.part.id, blocks: [] };
      lots.set(source, lot);
    }
    lot.mesh.thinInstanceAdd(blockMatrix(block), false);
    lot.blocks.push(block);
    lot.mesh.thinInstanceSetAttributeAt(B.VertexBuffer.ColorKind, lot.blocks.length - 1, wearColor(block, this.soot.get(block.id)), false);
    this.slots.set(block.id, lot);
    this.dirty.add(lot);
  }

  /** Retire le bloc de son lot : le dernier bloc du lot prend sa place ; un lot vide disparaît. */
  private unbatch(block: Block): void {
    const lot = this.slots.get(block.id);
    if (!lot) return;
    this.slots.delete(block.id);
    const i = lot.blocks.indexOf(block);
    const last = lot.blocks.length - 1;
    if (i < 0) return;
    if (i !== last) {
      const moved = lot.blocks[last];
      lot.blocks[i] = moved;
      lot.mesh.thinInstanceSetMatrixAt(i, blockMatrix(moved), false);
      lot.mesh.thinInstanceSetAttributeAt(B.VertexBuffer.ColorKind, i, wearColor(moved, this.soot.get(moved.id)), false);
    }
    lot.blocks.pop();
    lot.mesh.thinInstanceCount = lot.blocks.length;
    if (lot.blocks.length) {
      this.dirty.add(lot);
      return;
    }
    lot.mesh.dispose();
    this.dirty.delete(lot);
    this.batches.get(lot.part)?.delete(lot.source);
  }

  /** Renvoie au GPU les instances des lots qui ont changé, et recalcule leur volume (visibilité). */
  private flushBatches(): void {
    for (const lot of this.dirty) {
      lot.mesh.thinInstanceBufferUpdated("matrix");
      lot.mesh.thinInstanceBufferUpdated(B.VertexBuffer.ColorKind);
      lot.mesh.thinInstanceRefreshBoundingInfo(false);
    }
    this.dirty.clear();
  }

  /**
   * Une explosion noircit de suie les blocs qu'elle lèche, d'autant plus qu'ils sont près d'elle.
   * On prend la pose des morceaux affichée (celle de leurs nœuds), sans relire leurs corps.
   */
  private blacken(point: Vec3, radius: number): void {
    const reach = radius * SOOT_REACH;
    const at = new B.Vector3(point.x, point.y, point.z);
    const local = new B.Vector3();
    for (const { part, node } of this.parts.values()) {
      // (un robot fait au plus quelques mètres : on écarte d'abord les morceaux lointains)
      if (B.Vector3.Distance(node.position, at) > reach + 4) continue;
      const m = node.getWorldMatrix();
      for (const block of part.blocks) {
        if (!block.alive) continue;
        local.set(block.local.x, block.local.y, block.local.z);
        const d = B.Vector3.Distance(B.Vector3.TransformCoordinates(local, m), at);
        if (d >= reach) continue;
        const soot = Math.min(1, (this.soot.get(block.id) ?? 0) + BLAST_SOOT * (1 - d / reach));
        this.soot.set(block.id, soot);
        this.showWear(block);
      }
    }
  }

  /**
   * Ce que touche le jet de flamme de chaque moteur (robot/exhaust.ts), relu toutes les
   * `JET_SOOT_EVERY` s de temps simulé : sa flamme s'arrête là (`jetStops`, voir `syncFlames` : elle ne
   * traverse pas un mur ou un robot), et le bloc qu'il lèche (le sien, mal placé, ou celui d'un autre
   * robot) noircit peu à peu, d'autant plus vite qu'il y est chaud. Lu dans le monde affiché (la
   * poussée des moteurs passe par le réseau) ; rien ne noircit pendant une pause.
   */
  private readJets(): void {
    const time = this.sim.time;
    if (time < this.jetsReadAt) this.jetsReadAt = time; // un autre monde
    const dt = time - this.jetsReadAt;
    if (dt < JET_SOOT_EVERY) return;
    this.jetsReadAt = time;
    this.jetStops.clear();
    for (const bot of this.sim.bots) {
      for (const jet of botJets(this.sim, bot)) {
        const hit = jetContact(this.sim, jet);
        if (hit) this.jetStops.set(jet.thruster.block.id, hit.distance);
        const block = hit?.block;
        if (!hit || !block?.alive) continue;
        const soot = (this.soot.get(block.id) ?? 0) + JET_SOOT * Math.min(dt, 1) * (jetHeat(jet, hit.distance) / JET_SOOT_HEAT);
        this.soot.set(block.id, Math.min(1, soot));
        this.showWear(block);
      }
    }
  }

  /** Assombrit un bloc en proportion des points de structure perdus (et de sa suie). */
  private showWear(block: Block): void {
    const color = wearColor(block, this.soot.get(block.id));
    const piece = this.pieceOf.get(block.id);
    if (piece) {
      this.paint(piece, piece.blocks.indexOf(block), color);
      this.repainted.add(piece);
      return;
    }
    const lot = this.slots.get(block.id);
    if (!lot) return;
    lot.mesh.thinInstanceSetAttributeAt(B.VertexBuffer.ColorKind, lot.blocks.indexOf(block), color, false);
    this.dirty.add(lot);
  }

  /** Flamme sur le dessus d'un bloc en feu ; elle suit le bloc (accrochée à son repère). */
  private addFire(block: Block): void {
    if (!block.alive || this.fires.has(block.id) || (!this.slots.has(block.id) && !blockDef(block.type).aero)) return;
    const fire = this.assets.fireSource().createInstance("fire");
    fire.parent = this.anchor(block);
    fire.position.set(0, BLOCK_SIZE * 0.35, 0);
    fire.isPickable = false;
    fire.setEnabled(!this.realisticFx);
    this.fires.set(block.id, fire);
  }

  /**
   * Allure de la fumée et des flammes (réglage graphique) : en effets réalistes, les cônes des blocs
   * en feu sont cachés (des particules les remplacent) et la flamme d'un turboréacteur change de
   * source (ses instances sont refaites à l'image suivante).
   */
  setFxLook(look: FxLook): void {
    const realistic = look === "realistic";
    if (realistic === this.realisticFx) return;
    this.realisticFx = realistic;
    for (const fire of this.fires.values()) fire.setEnabled(!realistic);
    for (const flame of this.flames.values()) flame.dispose();
    this.flames.clear();
  }

  /**
   * Le verre d'une lumière de robot (un phare, une balise, un feu d'avion, un gyrophare, les deux feux
   * d'une rampe de police) luit tant que sa lumière est alimentée (reliée au cockpit, pas paralysée :
   * `lightPowered`), de jour comme de nuit, au rythme de son feu (`lampLevels` : un éclat, une
   * alternance) ; éteint, on voit le verre sombre du modèle. Le miroir d'un gyrophare tourne avec son
   * cône.
   */
  private syncLenses(): void {
    const time = this.sim.time;
    for (const bot of this.sim.bots) {
      for (const block of bot.lights) {
        if (!block.alive || !this.slots.has(block.id)) continue;
        const spec = blockDef(block.type).light!;
        let lenses = this.lenses.get(block.id);
        if (!lenses) {
          lenses = lampColors(block.type, block.x, bot.team).map((hex, i) => {
            const lens = this.assets.lightLensSource(block.type, i, hex).createInstance("lens");
            lens.parent = this.anchor(block);
            lens.isPickable = false;
            lens.rotationQuaternion = new B.Quaternion();
            return lens;
          });
          this.lenses.set(block.id, lenses);
        }
        const powered = lightPowered(this.sim, block);
        const levels = lampLevels(spec.pattern, time, block.id);
        lenses.forEach((lens, i) => {
          lens.isVisible = powered && (spec.kind === "sweep" || (levels[i] ?? levels[0]) > 0.35);
        });
        if (spec.kind === "sweep" && lenses[1]) {
          // (son miroir regarde le long de +z : tourné de β autour du haut, il regarde là où va le cône)
          B.Quaternion.RotationAxisToRef(B.Vector3.UpReadOnly, Math.PI / 2 - sweepAngle(time, block.id), lenses[1].rotationQuaternion!);
        }
      }
    }
  }

  /** Les flammes vacillent. */
  private syncFires(): void {
    const t = performance.now() / 1000;
    for (const [id, fire] of this.fires) {
      const k = 0.8 + 0.25 * Math.sin(t * 17 + id) + 0.15 * Math.sin(t * 29 + id * 3);
      fire.scaling.set(1, k, 1);
    }
  }

  private disposeBlock(block: Block): void {
    this.unbatch(block);
    this.melee.detach(block.id);
    for (const map of [this.flames, this.heads, this.fires, this.nacelles]) {
      map.get(block.id)?.dispose();
      map.delete(block.id);
    }
    for (const lens of this.lenses.get(block.id) ?? []) lens.dispose();
    this.lenses.delete(block.id);
    // (ses munitions sont parties avec la tête, qui était leur parent)
    this.rounds.delete(block.id);
    this.kicks.delete(block.id);
    this.anchors.get(block.id)?.dispose();
    this.anchors.delete(block.id);
  }

  private addDebris(debris: Debris): void {
    const look = debris.look;
    const source = look.kind === "block" ? this.assets.blockSource(look.type, look.color) : look.size ? this.assets.propShardSource(look.type) : this.assets.propSource(look.type);
    const mesh = this.instance(source, "debris");
    mesh.isPickable = false; // on ne vise pas les débris
    mesh.scaling.setAll(debrisScale(look));
    this.debris.set(debris.id, { debris, mesh });
  }

  /**
   * Un accessoire : une dalle a sa propre source à ses dimensions ; un arbre plus grand que nature
   * est une instance agrandie. Un accessoire ancré ne bouge pas : sa pose est figée (`placed`).
   */
  private addProp(prop: Prop): void {
    const spot = this.sim.arena.props[prop.spot];
    const char = charLevel(prop.charred);
    const mesh = this.instance(this.assets.propSource(prop.type, prop.half, !!spot?.diamond, char), "prop");
    const shape = propDef(prop.type).shape;
    if (shape.kind === "cylinder") mesh.scaling.setAll(prop.half.y / shape.halfHeight);
    this.props.set(prop.id, { prop, mesh, jet: null, placed: false, char, sway: null });
  }

  /** Le bois noircit d'un cran : l'accessoire prend la matière de ce cran (une autre source, à la même pose). */
  /**
   * Préparation (écran de chargement) : en `at`, un feu de bloc, une flamme de moteur et de
   * turboréacteur, et un éclat de chaque sorte d'accessoire de l'arène, pour que leurs modèles
   * soient construits et leurs matières compilées avant la partie. Rend de quoi les retirer.
   */
  warmUp(at: { x: number; y: number; z: number }): () => void {
    const made: B.InstancedMesh[] = [];
    const add = (source: B.Mesh): void => {
      const m = source.createInstance("warm-up");
      m.position.set(at.x, at.y, at.z);
      m.isPickable = false;
      made.push(m);
    };
    add(this.assets.fireSource());
    add(this.assets.flameFor());
    add(this.assets.jetFlameFor());
    // Le verre allumé de chaque lumière de robot, dans chacune de ses couleurs (les équipes, les côtés)
    for (const type of LIGHT_BLOCKS) {
      for (const [x, team] of [[1, "blue"], [-1, "red"], [0, "red"]] as const) {
        lampColors(type, x, team).forEach((hex, i) => add(this.assets.lightLensSource(type, i, hex)));
      }
    }
    // Les parties mobiles des armes de contact, et le disque flou d'un rotor
    for (const id of MELEE_IDS) {
      // (une hélice tranchante n'a pas de partie mobile à elle : ses pales sont celles du moteur)
      const source = this.assets.meleeSource(id);
      if (!source) continue;
      add(source);
      add(this.assets.meleeBlurSource(id));
      // Ce qui brille d'une arme d'énergie (l'arc d'une lame laser, le halo d'un champ…)
      const glow = this.assets.meleeGlowSource(id);
      if (glow) add(glow);
      // La mâchoire du bas, la boule et les maillons d'un fléau
      for (const piece of ["lower", "ball", "link"]) {
        const source = this.assets.meleePieceSource(id, piece);
        if (source) add(source);
      }
    }
    add(this.assets.meleeShaftSource());
    for (const type of new Set(this.sim.arena.props.map((spot) => spot.type))) add(this.assets.propShardSource(type));
    return () => {
      for (const m of made) m.dispose();
    };
  }

  private charProp(entry: PropEntry): void {
    const prop = entry.prop;
    const char = charLevel(prop.charred);
    if (char === entry.char) return;
    const spot = this.sim.arena.props[prop.spot];
    const old = entry.mesh;
    const mesh = this.instance(this.assets.propSource(prop.type, prop.half, !!spot?.diamond, char), "prop");
    mesh.scaling.copyFrom(old.scaling);
    mesh.position.copyFrom(old.position);
    mesh.rotationQuaternion!.copyFrom(old.rotationQuaternion ?? B.Quaternion.Identity());
    if (entry.jet) entry.jet.parent = mesh;
    old.dispose();
    entry.mesh = mesh;
    entry.char = char;
    entry.placed = false;
  }

  /**
   * Le souffle d'une explosion fait ployer les arbres debout proches : chacun penche à l'opposé,
   * d'autant plus qu'il est près, puis oscille et revient (le tronc ne bouge pas dans la physique).
   */
  private swayTrees(point: Vec3, radius: number): void {
    for (const entry of this.props.values()) {
      const prop = entry.prop;
      const shape = propDef(prop.type).shape;
      if (!prop.fixed || shape.kind !== "cylinder" || !propDef(prop.type).topples) continue;
      const base = entry.sway ? entry.sway.position : entry.mesh.position;
      const dx = base.x - point.x;
      const dz = base.z - point.z;
      const d = Math.hypot(dx, dz);
      const reach = radius * SWAY_REACH + prop.half.x + 2;
      if (d > reach || d < 1e-3) continue;
      const amplitude = SWAY_MAX * (1 - d / reach) * Math.min(1, radius / 2);
      if (amplitude < 0.01) continue;
      // Il penche à l'opposé du souffle : autour de l'axe haut × direction
      const axis = new B.Vector3(dz / d, 0, -dx / d);
      const rest = entry.sway ?? { position: entry.mesh.position.clone(), rotation: (entry.mesh.rotationQuaternion ?? B.Quaternion.Identity()).clone() };
      entry.sway = { axis, amplitude: Math.max(amplitude, entry.sway ? entry.sway.amplitude * 0.5 : 0), t: 0, position: rest.position, rotation: rest.rotation };
      entry.mesh.unfreezeWorldMatrix();
      entry.placed = false;
    }
  }

  /** Un arbre qui ploie : il pivote autour du pied de son tronc, et reprend sa pose de repos à la fin. */
  private syncSway(entry: PropEntry, sway: Sway, dt: number): void {
    sway.t += dt;
    const mesh = entry.mesh;
    if (sway.t > SWAY_TIME || !entry.prop.fixed) {
      entry.sway = null;
      mesh.position.copyFrom(sway.position);
      mesh.rotationQuaternion!.copyFrom(sway.rotation);
      entry.placed = false;
      return;
    }
    // Il penche d'un coup, puis oscille en s'amortissant
    const angle = sway.amplitude * Math.exp(-sway.t * SWAY_DAMP) * Math.sin(Math.min(Math.PI / 2, sway.t * 12) + sway.t * SWAY_FREQ);
    const tilt = B.Quaternion.RotationAxis(sway.axis, angle);
    const h = entry.prop.half.y;
    // Le centre du tronc tourne autour de son pied
    const up = new B.Vector3(0, h, 0).applyRotationQuaternion(tilt);
    mesh.position.set(sway.position.x + up.x, sway.position.y - h + up.y, sway.position.z + up.z);
    tilt.multiplyToRef(sway.rotation, mesh.rotationQuaternion!);
  }

  /** Pose d'un accessoire, et le jet de gaz d'une bouteille percée, orienté vers l'extérieur du trou. */
  private syncProp(entry: PropEntry, dt: number): void {
    if (entry.sway) {
      this.syncSway(entry, entry.sway, dt);
      return;
    }
    const { prop, mesh } = entry;
    if (entry.placed) return;
    syncBody(prop.rb, mesh);
    if (prop.fixed) {
      mesh.freezeWorldMatrix();
      entry.placed = true;
      return;
    }
    const state = prop.state;
    if (state.kind !== "venting") return;
    if (!entry.jet) {
      const jet = this.assets.flame.createInstance("jet");
      jet.parent = mesh;
      const radius = prop.half.x;
      const { x, z } = state.leak;
      jet.position.set(x * (radius + 0.3), 0, z * (radius + 0.3));
      // La flamme source pointe vers -y : on la couche vers l'extérieur du trou
      jet.rotationQuaternion = B.Quaternion.RotationAxis(new B.Vector3(-z, 0, x), Math.PI / 2);
      jet.scaling.set(0.8, 0.7, 0.8);
      entry.jet = jet;
    }
  }

  /**
   * Une flamme sous chaque moteur alimenté, dont la longueur suit la poussée réelle ; pas sous un
   * rotor ni une hélice, qui ont des pales (voir LocomotionView). Celle d'un turboréacteur part du
   * bout de sa tuyère, longue de plus de deux mètres à plein régime, et vacille ; en postcombustion
   * (au-delà du régime `AFTERBURNER`), elle s'allonge encore (son cœur bleuté et ses anneaux de choc
   * sont des effets : render/fx/engineFx.ts). Un moteur abîmé tousse : sa flamme hoquette.
   */
  private syncFlames(): void {
    const now = performance.now();
    const flicker = 0.92 + 0.08 * Math.sin(now / 23);
    for (const bot of this.sim.bots) {
      if (!bot.thrusters.length) continue;
      const powered = new Set(liveThrusters(bot));
      for (const t of bot.thrusters) {
        if (!t.block.alive || !this.slots.has(t.block.id) || hasBlades(t)) continue;
        const spec = blockDef(t.block.type).thruster;
        const jet = spec?.look === "jet";
        const ratio = powered.has(t) ? clamp(t.thrust / (spec?.maxThrust ?? 1), 0, 1) : 0;
        let flame = this.flames.get(t.block.id);
        if (ratio < 0.02) {
          if (flame) flame.isVisible = false;
          continue;
        }
        if (!flame) {
          flame = (jet ? this.assets.jetFlameFor() : this.assets.flameFor()).createInstance("flame");
          flame.parent = this.anchor(t.block);
          this.flames.set(t.block.id, flame);
        }
        flame.isVisible = true;
        // Moteur abîmé : la flamme hoquette, d'autant plus qu'il est usé (ses vrais ratés se voient dans la poussée)
        const health = engineHealth(t);
        const cough = health < ENGINE_WORN ? 1 - (1 - health / ENGINE_WORN) * 0.55 * Math.abs(Math.sin(now / 41 + t.block.id * 1.7) * Math.sin(now / 97 + t.block.id)) : 1;
        // Elle bute sur ce que touche son jet (un mur, un robot, le sol : voir `readJets`)
        const stop = (this.jetStops.get(t.block.id) ?? Infinity) + FLAME_PAST_STOP;
        if (jet) {
          const boost = ratio > AFTERBURNER ? (ratio - AFTERBURNER) / (1 - AFTERBURNER) : 0;
          const length = Math.min(stop, (0.3 + 2.4 * ratio) * (1 + 0.45 * boost) * flicker * cough);
          const width = (0.8 + 0.5 * ratio) * (1 + 0.12 * boost);
          flame.scaling.set(width, length, width);
          flame.position.set(0, -JET_NOZZLE - length / 2, 0);
        } else {
          const length = Math.min(stop, (0.15 + 0.85 * ratio) * cough);
          const width = 0.6 + 0.4 * ratio;
          flame.scaling.set(width, length, width);
          flame.position.set(0, -BLOCK_SIZE / 2 - length / 2, 0);
        }
      }
    }
  }

  /**
   * Chaque rang de gouvernes pivote d'une pièce autour de sa charnière, le long de son envergure,
   * selon son braquage (bord d'attaque qui monte si positif). Un rang porté par un autre (un volet
   * derrière un aileron) suit celui-ci, et ne tourne lui-même que de l'écart entre leurs braquages.
   */
  private syncFlaps(): void {
    for (const piece of this.pieces.values()) {
      const flap = piece.flap;
      if (!flap || !piece.mesh.rotationQuaternion) continue;
      const turn = axisAngle(vec3(1, 0, 0), -(flap.surface.deflection - (flap.carrier?.flap?.surface.deflection ?? 0)));
      const q = flap.carrier ? turn : qmul(flap.rot, turn);
      piece.mesh.rotationQuaternion.set(q.x, q.y, q.z, q.w);
    }
  }

  /**
   * Refait les ailes et les gouvernes des robots dont la structure a changé, puis renvoie au GPU les
   * couleurs d'usure qui ont changé. Seules les pièces dont la clé a changé sont reconstruites : un
   * bloc perdu au milieu d'un rang en fait deux rangs, un morceau arraché emporte ses pièces.
   */
  private buildSurfaces(): void {
    for (const bot of this.surfacesDirty) this.rebuildSurfaces(bot);
    this.surfacesDirty.clear();
    for (const piece of this.repainted) {
      if (!piece.mesh.isDisposed()) piece.mesh.updateVerticesData(B.VertexBuffer.ColorKind, piece.colors);
    }
    this.repainted.clear();
  }

  private rebuildSurfaces(bot: Bot): void {
    // (blocs vivants sur un morceau affiché : on ne lit que la structure, jamais un corps)
    const live = bot.surfaces.filter((s) => s.block.alive && this.parts.has(s.block.part.id));
    const sides = new Map(live.map((s) => [s.block, surfaceSides(s.block, linkedAt)]));
    const signature = (blocks: readonly Block[]): string => blocks.map((b) => `${b.id}.${sides.get(b)}`).join(",");
    const wanted = new Map<string, () => SurfacePiece>();

    // Les ailes d'un morceau (par type) : une seule pièce, immobile
    const wings = new Map<string, Block[]>();
    for (const s of live) {
      if (isFlap(s.block.type)) continue;
      const k = `${s.block.part.id}/${s.block.type}`;
      const list = wings.get(k);
      if (list) list.push(s.block);
      else wings.set(k, [s.block]);
    }
    for (const [k, blocks] of wings) {
      const key = `w${k}:${signature(blocks)}`;
      wanted.set(key, () => this.addSurfacePiece(key, bot, blocks, blocks.map((b) => ({ sides: sides.get(b)!, rot: b.rot, pos: b.local })), null));
    }

    // Les rangs de gouvernes : une pièce chacun, portée par le rang qui la précède s'il y en a un
    const runs = flapRuns(bot, live.filter((s) => isFlap(s.block.type)));
    const runOf = new Map<Block, AeroSurface[]>();
    for (const run of runs) for (const f of run) runOf.set(f.block, run);
    const carrierOf = (run: AeroSurface[]): AeroSurface[] | null => {
      const c = carrierCell(run.map((f) => f.block), linkedAt);
      return c ? runOf.get(c) ?? null : null;
    };
    const keys = new Map<AeroSurface[], string>();
    const keyOf = (run: AeroSurface[]): string => {
      let key = keys.get(run);
      if (key === undefined) {
        const blocks = run.map((f) => f.block);
        const carrier = carrierOf(run); // (juste devant lui : pas de boucle)
        key = `f${blocks[0].part.id}:${signature(blocks)}@${hingeChord(blocks, linkedAt).toFixed(3)}<${carrier ? keyOf(carrier) : ""}>`;
        keys.set(run, key);
      }
      return key;
    };
    const build = (run: AeroSurface[]): SurfacePiece => {
      const key = keyOf(run);
      const made = this.pieces.get(key);
      if (made) return made;
      const blocks = run.map((f) => f.block);
      const carrier = carrierOf(run);
      const carrierPiece = carrier ? build(carrier) : null;
      // Repère du rang : celui de ses blocs, centré sur sa charnière
      const b0 = blocks[0];
      const pivot = add(b0.local, scale(b0.forward, hingeChord(blocks, linkedAt) - dot(b0.local, b0.forward)));
      const cells = blocks.map((b): PlacedSegment => ({ sides: sides.get(b)!, rot: NO_ROTATION, pos: qrotInv(b.rot, sub(b.local, pivot)) }));
      return this.addSurfacePiece(key, bot, blocks, cells, { surface: run[0], rot: b0.rot, pivot, carrier: carrierPiece });
    };
    for (const run of runs) wanted.set(keyOf(run), () => build(run));

    // Les pièces qui ont changé disparaissent (un rang porté change avec celui qui le porte), puis
    // les nouvelles se construisent
    for (const [key, piece] of this.pieces) if (piece.bot === bot && !wanted.has(key)) this.dropPiece(key, piece);
    for (const [key, make] of wanted) if (!this.pieces.has(key)) make();
  }

  /** Une pièce d'ailes ou un rang de gouvernes : ses cases fusionnées, sa matière, ses couleurs d'usure. */
  private addSurfacePiece(key: string, bot: Bot, blocks: Block[], cells: readonly PlacedSegment[], flap: SurfacePiece["flap"]): SurfacePiece {
    const { geometry, ranges } = mergeSegments(cells);
    const mesh = new B.Mesh(flap ? `gouverne${blocks[0].id}` : `ailes${blocks[0].part.id}`, this.scene);
    const data = new B.VertexData();
    data.positions = geometry.positions;
    data.normals = geometry.normals;
    data.uvs = geometry.uvs;
    data.indices = geometry.indices;
    data.applyToMesh(mesh);
    const colors = new Float32Array((geometry.positions.length / 3) * 4);
    const piece: SurfacePiece = { bot, part: blocks[0].part.id, mesh, blocks, ranges, colors, flap };
    blocks.forEach((b, i) => {
      this.paint(piece, i, wearColor(b, this.soot.get(b.id)));
      this.pieceOf.set(b.id, piece);
    });
    mesh.setVerticesData(B.VertexBuffer.ColorKind, colors, true);
    mesh.material = this.assets.surfaceMaterial(blocks[0].type, bot.profile.color);
    mesh.receiveShadows = true;
    const node = this.parts.get(blocks[0].part.id)?.node ?? null;
    if (flap) {
      // Une gouverne pivote autour de sa charnière ; portée, elle suit le rang qui la porte (même orientation)
      const carrier = flap.carrier?.flap;
      const at = carrier ? qrotInv(flap.rot, sub(flap.pivot, carrier.pivot)) : flap.pivot;
      mesh.parent = flap.carrier ? flap.carrier.mesh : node;
      mesh.position.set(at.x, at.y, at.z);
      mesh.rotationQuaternion = carrier ? new B.Quaternion() : new B.Quaternion(flap.rot.x, flap.rot.y, flap.rot.z, flap.rot.w);
    } else {
      mesh.parent = node;
    }
    this.shadows.addShadowCaster(mesh, false);
    this.pieces.set(key, piece);
    return piece;
  }

  /** Couleur d'usure d'une case d'une pièce (le `i`-ième de ses blocs). */
  private paint(piece: SurfacePiece, i: number, color: number[]): void {
    const range = piece.ranges[i];
    if (!range) return;
    const [first, count] = range;
    for (let v = first; v < first + count; v++) piece.colors.set(color, v * 4);
  }

  /** Retire une pièce (et son mesh, s'il n'est pas déjà parti avec son morceau ou le rang qui la portait). */
  private dropPiece(key: string, piece: SurfacePiece): void {
    if (!piece.mesh.isDisposed()) piece.mesh.dispose();
    this.pieces.delete(key);
    this.repainted.delete(piece);
    for (const b of piece.blocks) if (this.pieceOf.get(b.id) === piece) this.pieceOf.delete(b.id);
  }

  /**
   * Têtes de tourelles : lacet autour du haut du bloc, puis site (le canon monte si positif) ; après
   * un tir, la tête recule le long du canon, puis revient (voir client/render/recoil.ts).
   */
  private syncTurrets(): void {
    for (const bot of this.sim.bots) {
      for (const t of bot.turrets) {
        const head = this.heads.get(t.block.id);
        if (!head?.rotationQuaternion) continue;
        // Un poseur de mines regarde vers l'arrière ; une soute à bombes (fixe, vers le bas) garde sa tête droite
        const turret = blockDef(t.block.type).turret;
        const q = turret?.fixed === "back" ? axisAngle(vec3(0, 1, 0), Math.PI) : qmul(axisAngle(vec3(0, 1, 0), t.yaw), axisAngle(vec3(1, 0, 0), -t.pitch));
        head.rotationQuaternion.set(q.x, q.y, q.z, q.w);
        const rounds = this.rounds.get(t.block.id);
        if (rounds) this.syncRounds(rounds, t);
        const kick = this.kicks.get(t.block.id);
        if (!kick) continue;
        const age = (this.sim.time - kick.at) / RECOIL_RETURN;
        const back = age >= 0 && age < 1 ? kick.back * (1 - age) * (1 - age) : 0;
        if (back === 0) this.kicks.delete(t.block.id);
        const d = qrot(q, vec3(0, 0, -back));
        head.position.set(d.x, (turret ? headLift(turret) : BLOCK_SIZE / 2) + d.y, d.z);
      }
    }
  }

  /**
   * Munitions visibles : on montre la part du chargeur qui reste (les premières places partent
   * d'abord) ; un coup rechargé revient en glissant de l'arrière de son logement à sa place.
   */
  private syncRounds(rounds: { meshes: B.InstancedMesh[]; places: B.Vector3[]; shown: number; back: number[] }, t: Turret): void {
    const n = rounds.meshes.length;
    const shown = visibleRounds(n, t.arm.ammo, weaponDef(t.weapon).ammo?.capacity ?? 0);
    const now = performance.now() / 1000;
    for (let i = n - shown; i < n - rounds.shown; i++) rounds.back[i] = now;
    rounds.shown = shown;
    rounds.meshes.forEach((m, i) => {
      const present = i >= n - shown;
      m.isVisible = present;
      if (!present) return;
      const k = clamp((now - rounds.back[i]) / ROUND_RETURN, 0, 1);
      const place = rounds.places[i];
      m.position.set(place.x, place.y, place.z - ROUND_SLIDE * (1 - k) * (1 - k));
    });
  }

  private disposeFrom(map: Map<number, { mesh: B.AbstractMesh }>, id: number): void {
    map.get(id)?.mesh.dispose();
    map.delete(id);
  }
}
