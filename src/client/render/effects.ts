import * as B from "../babylon";
import type { ExplosionLook, WeaponId } from "../../shared/catalog/weapons";
import { jitter } from "./fx/layer";
import type { Vec3 } from "../../shared/math/vec";

/** Une sphère qui grossit de `from` à `to` (m) en s'effaçant, pendant `duration` (s), et qui peut monter. */
interface Puff {
  mesh: B.Mesh;
  material: B.StandardMaterial;
  t: number;
  duration: number;
  from: number;
  to: number;
  alpha: number;
  rise: number;
}

/** Taille de la lueur à la bouche du canon, par arme (m). */
const MUZZLE_FLASH: Record<WeaponId, number> = {
  rifle: 0.35, sniper: 0.7, cannon: 1.1, missile: 0.9, flak: 0.9, mine: 0, flamer: 0, emp: 0.8, smoke: 0.4, laser: 0.18, rail: 1.3,
  shotgun: 0.8, rockets: 0.5, plasma: 0.25, lockon: 0.9, warhead: 1.5, bombs: 0,
  empMine: 0, fireMine: 0, smokeMine: 0, bounceMine: 0, aaMine: 0, remoteMine: 0, sensorMine: 0, stickyMine: 0, repair: 0,
  flare: 0.4, nanites: 0.2, barrier: 0.6,
};

/**
 * Effets visibles en même temps, au plus : au-delà, le plus ancien est recyclé. Au cœur d'une
 * bataille, on en compte quelques dizaines ; sans plafond, la réserve garderait pour toujours la
 * taille du pire moment.
 */
const MAX_PUFFS = 120;
/** Effets réduits (réglage graphique) : trois fois moins d'effets à la fois. */
const REDUCED_PUFFS = 40;

const FIRE = B.Color3.FromHexString("#ffb347");
const SPARK = B.Color3.FromHexString("#ffe28a");
const SMOKE = B.Color3.FromHexString("#5a6168");
const ELECTRIC = B.Color3.FromHexString("#7fd8ff");
const SHIELD = B.Color3.FromHexString("#5fb8ff");
const REPAIR = B.Color3.FromHexString("#7fffb0");
const WHITE_HOT = B.Color3.FromHexString("#fff4d6");
const ORANGE = B.Color3.FromHexString("#ff7a1f");
const RED_FIRE = B.Color3.FromHexString("#ff4a1a");
const DARK_SMOKE = B.Color3.FromHexString("#26282b");
const DIRT = B.Color3.FromHexString("#6b5a45");
const GAS_FLASH = B.Color3.FromHexString("#bfe6ff");

/**
 * Une couche d'explosion : une sphère qui grossit de `from` à `to` (en rayons d'explosion) en
 * s'effaçant pendant `duration` s ; `lift` : hauteur de départ (en rayons) ; `rise` : montée (m/s).
 */
interface Layer {
  color: B.Color3;
  glow: boolean;
  from: number;
  to: number;
  duration: number;
  alpha: number;
  rise: number;
  lift?: number;
}

/** Éclats ou mottes projetés autour du centre : `count` petites sphères, dans `spread` rayons. */
interface Scatter {
  count: number;
  color: B.Color3;
  glow: boolean;
  size: number;
  spread: number;
  duration: number;
  rise: number;
}

interface ExplosionStyle {
  layers: readonly Layer[];
  scatter?: Scatter;
}

/** Chaque allure d'explosion a son effet (TypeScript refuse une allure sans le sien). */
const EXPLOSION_STYLES: Record<ExplosionLook, ExplosionStyle> = {
  // Obus : éclair orange, fumée grise, gerbe de terre
  shell: {
    layers: [
      { color: FIRE, glow: true, from: 0.25, to: 1.1, duration: 0.3, alpha: 0.95, rise: 0 },
      { color: SMOKE, glow: false, from: 0.5, to: 1.5, duration: 1.4, alpha: 0.55, rise: 1 },
      { color: DIRT, glow: false, from: 0.4, to: 1.3, duration: 0.8, alpha: 0.6, rise: 0.6, lift: -0.2 },
    ],
    scatter: { count: 6, color: SPARK, glow: true, size: 0.18, spread: 1.2, duration: 0.35, rise: 1.5 },
  },
  // Missile : cœur blanc, boule de feu, épaisse fumée noire qui monte
  missile: {
    layers: [
      { color: WHITE_HOT, glow: true, from: 0.2, to: 0.8, duration: 0.18, alpha: 1, rise: 0 },
      { color: ORANGE, glow: true, from: 0.3, to: 1.3, duration: 0.45, alpha: 0.9, rise: 0.5 },
      { color: DARK_SMOKE, glow: false, from: 0.6, to: 2, duration: 2.2, alpha: 0.6, rise: 1.6 },
    ],
    scatter: { count: 8, color: SPARK, glow: true, size: 0.16, spread: 1.4, duration: 0.45, rise: 2 },
  },
  // Roquette : éclair vif et bref, petite fumée claire
  rocket: {
    layers: [
      { color: WHITE_HOT, glow: true, from: 0.2, to: 1, duration: 0.18, alpha: 0.95, rise: 0 },
      { color: SMOKE, glow: false, from: 0.4, to: 1.2, duration: 0.9, alpha: 0.45, rise: 0.8 },
    ],
    scatter: { count: 4, color: SPARK, glow: true, size: 0.12, spread: 1, duration: 0.25, rise: 1 },
  },
  // Flak : éclate en l'air, nuage noir et éclats qui partent loin
  flak: {
    layers: [
      { color: FIRE, glow: true, from: 0.2, to: 0.9, duration: 0.22, alpha: 0.95, rise: 0 },
      { color: DARK_SMOKE, glow: false, from: 0.6, to: 1.6, duration: 1.8, alpha: 0.7, rise: 0.2 },
    ],
    scatter: { count: 10, color: SPARK, glow: true, size: 0.1, spread: 1.6, duration: 0.4, rise: -1 },
  },
  // Mine : la terre jaillit en colonne
  mine: {
    layers: [
      { color: FIRE, glow: true, from: 0.2, to: 0.8, duration: 0.2, alpha: 0.9, rise: 0 },
      { color: DIRT, glow: false, from: 0.4, to: 1, duration: 1.3, alpha: 0.75, rise: 3.5 },
      { color: DIRT, glow: false, from: 0.6, to: 1.6, duration: 1.1, alpha: 0.55, rise: 0.4 },
    ],
    scatter: { count: 8, color: DIRT, glow: false, size: 0.22, spread: 1, duration: 0.9, rise: 3 },
  },
  // Bombe : éclair, boule de feu, colonne de terre, fumée sombre qui monte, mottes projetées
  bomb: {
    layers: [
      { color: WHITE_HOT, glow: true, from: 0.3, to: 1, duration: 0.2, alpha: 1, rise: 0 },
      { color: ORANGE, glow: true, from: 0.3, to: 1.2, duration: 0.55, alpha: 0.9, rise: 0.8 },
      { color: DIRT, glow: false, from: 0.4, to: 1, duration: 1.6, alpha: 0.75, rise: 4 },
      { color: DARK_SMOKE, glow: false, from: 0.6, to: 1.8, duration: 2.6, alpha: 0.6, rise: 1.5 },
    ],
    scatter: { count: 12, color: DIRT, glow: false, size: 0.25, spread: 1.1, duration: 1, rise: 3.5 },
  },
  // Napalm : une large boule de feu rouge qui roule au sol, peu de fumée noire, des gouttes brûlantes
  napalm: {
    layers: [
      { color: ORANGE, glow: true, from: 0.3, to: 1.2, duration: 0.5, alpha: 0.95, rise: 0.4 },
      { color: RED_FIRE, glow: true, from: 0.5, to: 1.5, duration: 1.3, alpha: 0.75, rise: 0.8, lift: -0.2 },
      { color: DARK_SMOKE, glow: false, from: 0.5, to: 1.4, duration: 2.2, alpha: 0.45, rise: 1.4 },
    ],
    scatter: { count: 14, color: FIRE, glow: true, size: 0.22, spread: 1.1, duration: 1.1, rise: 0.8 },
  },
  // Ogive : flash blanc, boule de feu, onde de choc, champignon de fumée qui monte
  warhead: {
    layers: [
      { color: WHITE_HOT, glow: true, from: 0.4, to: 1.6, duration: 0.3, alpha: 1, rise: 0 },
      { color: ORANGE, glow: true, from: 0.4, to: 1.3, duration: 0.9, alpha: 0.9, rise: 1.5 },
      { color: WHITE_HOT, glow: true, from: 0.5, to: 3.2, duration: 0.5, alpha: 0.22, rise: 0 },
      { color: DARK_SMOKE, glow: false, from: 0.5, to: 0.9, duration: 3.5, alpha: 0.65, rise: 3 },
      { color: SMOKE, glow: false, from: 0.8, to: 2, duration: 4, alpha: 0.55, rise: 3, lift: 0.8 },
    ],
    scatter: { count: 14, color: FIRE, glow: true, size: 0.35, spread: 1.4, duration: 0.8, rise: 2.5 },
  },
  // Baril : grosse boule de feu rouge, fumée noire et grasse
  barrel: {
    layers: [
      { color: FIRE, glow: true, from: 0.3, to: 1.1, duration: 0.3, alpha: 0.95, rise: 0 },
      { color: RED_FIRE, glow: true, from: 0.4, to: 1.4, duration: 0.7, alpha: 0.85, rise: 1.2 },
      { color: DARK_SMOKE, glow: false, from: 0.6, to: 2, duration: 2.6, alpha: 0.65, rise: 1.8 },
    ],
    scatter: { count: 10, color: FIRE, glow: true, size: 0.2, spread: 1.2, duration: 0.6, rise: 2 },
  },
  // Gaz : flash bleuté, anneau de feu, peu de fumée
  gas: {
    layers: [
      { color: GAS_FLASH, glow: true, from: 0.3, to: 1.2, duration: 0.25, alpha: 0.95, rise: 0 },
      { color: ORANGE, glow: true, from: 0.4, to: 1.4, duration: 0.5, alpha: 0.7, rise: 0.6 },
      { color: SMOKE, glow: false, from: 0.4, to: 1.2, duration: 1, alpha: 0.35, rise: 0.8 },
    ],
    scatter: { count: 6, color: GAS_FLASH, glow: true, size: 0.14, spread: 1.2, duration: 0.3, rise: 1 },
  },
  // Voiture : le réservoir s'embrase, une boule de feu qui monte, fumée noire et grasse, débris en feu
  car: {
    layers: [
      { color: FIRE, glow: true, from: 0.3, to: 1.2, duration: 0.35, alpha: 0.95, rise: 0.2 },
      { color: ORANGE, glow: true, from: 0.4, to: 1.5, duration: 0.9, alpha: 0.85, rise: 1.6 },
      { color: RED_FIRE, glow: true, from: 0.5, to: 1.3, duration: 1.2, alpha: 0.6, rise: 2.2, lift: 0.3 },
      { color: DARK_SMOKE, glow: false, from: 0.6, to: 2.2, duration: 3.2, alpha: 0.7, rise: 2.6 },
    ],
    scatter: { count: 12, color: FIRE, glow: true, size: 0.22, spread: 1.3, duration: 0.8, rise: 2.5 },
  },
};

/** Effets éphémères : lueurs de tir, étincelles d'impact, explosions avec leur fumée. */
export class Effects {
  private readonly scene: B.Scene;
  /** Effets en cours, du plus ancien au plus récent. */
  private readonly active: Puff[] = [];
  /** Sphères prêtes à resservir : on n'en crée pas une nouvelle à chaque tir. */
  private readonly pool: { mesh: B.Mesh; material: B.StandardMaterial }[] = [];
  /** Sphère modèle, invisible : les autres en sont des copies qui partagent sa géométrie. */
  private readonly sphere: B.Mesh;
  /** Effets visibles en même temps, au plus. */
  private limit = MAX_PUFFS;

  constructor(scene: B.Scene) {
    this.scene = scene;
    this.sphere = B.MeshBuilder.CreateSphere("puff", { diameter: 1, segments: 8 }, scene);
    this.sphere.isVisible = false;
    this.sphere.isPickable = false;
  }

  muzzle(origin: Vec3, weapon: WeaponId): void {
    const size = MUZZLE_FLASH[weapon];
    if (size) this.puff(origin, FIRE, true, 0.2 * size, size, 0.08, 0.9, 0);
  }

  spark(point: Vec3): void {
    this.puff(point, SPARK, true, 0.1, 0.35, 0.1, 0.9, 0);
  }

  /** Étincelle verte d'une réparation. */
  repairSpark(point: Vec3): void {
    this.puff(point, REPAIR, true, 0.12, 0.45, 0.25, 0.8, 0.8);
  }

  /** Un bloc perdu qui repousse : une bulle verte qui s'ouvre autour de lui. */
  regrow(point: Vec3): void {
    this.puff(point, REPAIR, true, 0.1, 0.9, 0.35, 0.9, 0);
  }

  /** Un mur d'énergie qui se brise : un éclat bleuté de sa largeur. */
  barrierBreak(center: Vec3, width: number): void {
    this.puff(center, SHIELD, true, width * 0.3, width * 1.2, 0.35, 0.5, 0);
  }

  /** Petit arc électrique (robot paralysé). */
  zap(point: Vec3): void {
    this.puff(point, ELECTRIC, true, 0.05, 0.3, 0.08, 1, 0);
  }

  /** Éclat d'un bouclier qui encaisse : une bulle bleutée autour du générateur, de son rayon. */
  shield(center: Vec3, radius: number): void {
    this.puff(center, SHIELD, true, radius * 1.8, radius * 2, 0.22, 0.3, 0);
  }

  /** Onde d'une impulsion électromagnétique, jusqu'à son rayon. */
  empBurst(point: Vec3, radius: number): void {
    this.puff(point, ELECTRIC, true, 0.3, radius * 2, 0.4, 0.5, 0);
  }

  /**
   * Poussière d'un pan de mur qui s'écroule ou d'un arbre qui se brise : des nuages sur toute son
   * étendue (`half`, demi-dimensions dans le monde), qui montent lentement.
   */
  dust(center: Vec3, half: Vec3, color: string): void {
    const tint = B.Color3.FromHexString(color);
    const size = Math.max(half.x, half.y, half.z);
    const count = Math.min(7, 2 + Math.round(size * 1.5));
    for (let i = 0; i < count; i++) {
      const at = { x: center.x + jitter(-1, 1) * half.x, y: center.y + jitter(-1, 0.5) * half.y, z: center.z + jitter(-1, 1) * half.z };
      this.puff(at, tint, false, 0.6 + size * 0.2, 1.4 + size * 0.5, jitter(1.6, 2.6), 0.55, 0.5);
    }
  }

  /** Explosion : les couches de son allure (voir EXPLOSION_STYLES), à la mesure de son rayon. */
  explosion(point: Vec3, radius: number, look: ExplosionLook): void {
    const style = EXPLOSION_STYLES[look];
    for (const l of style.layers) {
      const at = { x: point.x, y: point.y + (l.lift ?? 0) * radius, z: point.z };
      this.puff(at, l.color, l.glow, l.from * radius, l.to * radius, l.duration, l.alpha, l.rise);
    }
    const s = style.scatter;
    if (!s) return;
    for (let i = 0; i < s.count; i++) {
      const at = { x: point.x + jitter(-1, 1) * s.spread * radius, y: point.y + jitter(0, 1) * s.spread * radius * 0.6, z: point.z + jitter(-1, 1) * s.spread * radius };
      this.puff(at, s.color, s.glow, s.size * 0.5, s.size, s.duration * jitter(0.7, 1.2), 0.9, s.rise);
    }
  }

  /**
   * Préparation (écran de chargement) : une explosion de chaque allure, un éclair de chaque arme et
   * les petits effets, en `at` (derrière l'écran de chargement), pour que leurs sphères et leurs
   * matières existent et soient compilées avant la partie ; `clear` les range ensuite.
   */
  warmUp(at: Vec3): void {
    for (const look of Object.keys(EXPLOSION_STYLES) as ExplosionLook[]) this.explosion(at, 1.5, look);
    for (const weapon of Object.keys(MUZZLE_FLASH) as WeaponId[]) this.muzzle(at, weapon);
    this.spark(at);
    this.repairSpark(at);
    this.regrow(at);
    this.zap(at);
    this.shield(at, 1);
    this.empBurst(at, 2);
    this.barrierBreak(at, 2);
    this.dust(at, { x: 1, y: 1, z: 1 }, "#8a7a66");
  }

  /** Range tous les effets en cours (sans les détruire : ils resservent). */
  clear(): void {
    for (const p of this.active) {
      p.mesh.setEnabled(false);
      this.pool.push({ mesh: p.mesh, material: p.material });
    }
    this.active.length = 0;
  }

  /** Effets réduits : moins d'effets à la fois (les plus anciens sont recyclés plus tôt). */
  setReduced(on: boolean): void {
    this.limit = on ? REDUCED_PUFFS : MAX_PUFFS;
  }

  update(dt: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i];
      p.t += dt;
      const k = Math.min(1, p.t / p.duration);
      p.mesh.scaling.setAll(p.from + (p.to - p.from) * Math.sqrt(k));
      p.mesh.position.y += p.rise * dt;
      p.material.alpha = p.alpha * (1 - k);
      if (k >= 1) {
        p.mesh.setEnabled(false);
        this.pool.push({ mesh: p.mesh, material: p.material });
        this.active.splice(i, 1);
      }
    }
  }

  private puff(at: Vec3, color: B.Color3, glowing: boolean, from: number, to: number, duration: number, alpha: number, rise: number): void {
    const slot = this.active.length >= this.limit ? this.active.shift()! : this.pool.pop() ?? this.createSlot();
    const { mesh, material } = slot;
    material.disableLighting = glowing;
    material.emissiveColor = glowing ? color : B.Color3.Black();
    material.diffuseColor = color;
    mesh.position.set(at.x, at.y, at.z);
    mesh.setEnabled(true);
    this.active.push({ mesh, material, t: 0, duration, from, to, alpha, rise });
  }

  private createSlot(): { mesh: B.Mesh; material: B.StandardMaterial } {
    const mesh = this.sphere.clone("puff");
    mesh.isVisible = true;
    const material = new B.StandardMaterial("puff", this.scene);
    material.specularColor = B.Color3.Black();
    mesh.material = material;
    mesh.isPickable = false;
    return { mesh, material };
  }
}
