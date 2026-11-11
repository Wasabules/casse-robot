import type * as B from "../../babylon";
import { groundLevel } from "../../../shared/arena/layout";
import { vec3, type Vec3 } from "../../../shared/math/vec";
import type { Bot } from "../../../shared/sim/entities";
import type { World } from "../../../shared/sim/world";
import type { FxLook } from "../../settings";
import type { Assets } from "../materials";
import { jitter } from "./layer";
import { MarkField } from "./marks";
import { PUFF_KINDS, ParticleField, type PuffSpec } from "./particles";
import { StreakField } from "./streaks";
import { FX_SYSTEMS } from "./systems";

/**
 * Ce que voit un système d'effets : le monde affiché (simulation locale ou réplique du serveur :
 * un effet ne lit que ce que lit le rendu, il marche donc aussi en réseau), les trois champs où il
 * dessine, et l'état de la vue.
 */
export interface FxContext {
  readonly world: World;
  readonly scene: B.Scene;
  readonly assets: Assets;
  readonly particles: ParticleField;
  readonly streaks: StreakField;
  readonly marks: MarkField;
  /** Position de la caméra. */
  readonly eye: Vec3;
  /** Au viseur, le robot dans lequel est la caméra : ses propres effets tout contre l'objectif ne doivent pas boucher la vue. */
  readonly inside: Bot | null;
  /** Part des effets à émettre : 1, ou moins en effets réduits (un système en tient compte dans ses cadences). */
  readonly density: number;
  /** Effets réduits (réglage graphique). */
  readonly reduced: boolean;
  /**
   * Allure de la fumée et des flammes (réglage graphique) : en effets réalistes, les boules de feu
   * des explosions, les nuages de fumigène, les flammes des blocs et le jet du lance-flammes sont
   * des effets d'ici (render/effects.ts, SmokeView et WorldView ne les dessinent plus).
   */
  readonly look: FxLook;
  /** Horloge de la page (s) : rythmes des effets, qui ne dépendent pas du temps simulé. */
  readonly now: number;
}

/**
 * Un système d'effets : une famille (traînées des projectiles, moteurs, dégâts, sol…). Il écoute
 * les événements du monde (`ctx.world.on`, désabonné dans `dispose`) et le relit à chaque image
 * (`update`). Il ne relit jamais le corps de ce qu'on retire (voir docs/architecture.md, « Son »).
 */
export interface FxSystem {
  update(dt: number): void;
  dispose(): void;
}

export type FxFactory = (ctx: FxContext) => FxSystem;

/** Au-delà de cette distance à la caméra (m), un système peut ne rien émettre : on ne le verrait pas. */
export const FX_RANGE = 160;

interface MutableContext {
  world: World;
  scene: B.Scene;
  assets: Assets;
  particles: ParticleField;
  streaks: StreakField;
  marks: MarkField;
  eye: Vec3;
  inside: Bot | null;
  density: number;
  reduced: boolean;
  look: FxLook;
  now: number;
}

/** Poussière d'un pan de mur qui s'écroule (effets réalistes) : des volutes de la couleur du matériau. */
const DUST: PuffSpec = { color: "#8a7a66", kind: "smoke", size: 1, grow: 2.4, life: 2.6, alpha: 0.5, fadeIn: 0.08, drag: 1.4, gravity: -0.35 };

/**
 * Les effets du monde : particules, traits et marques au sol, et les systèmes qui les émettent
 * (`FX_SYSTEMS`, render/fx/systems.ts). `bind` les rattache à un autre monde (partie en réseau).
 */
export class Fx {
  private readonly ctx: MutableContext;
  private systems: FxSystem[] = [];

  constructor(scene: B.Scene, assets: Assets, world: World) {
    this.ctx = {
      world, scene, assets,
      particles: new ParticleField(scene),
      streaks: new StreakField(scene),
      marks: new MarkField(scene),
      eye: { x: 0, y: 0, z: 0 },
      inside: null,
      density: 1,
      reduced: false,
      look: "simple",
      now: performance.now() / 1000,
    };
    // Les volutes s'effacent en approchant du sol de l'arène affichée
    this.ctx.particles.groundAt = (x, z) => groundLevel(this.ctx.world.arena, x, z);
    this.systems = FX_SYSTEMS.map((make) => make(this.ctx));
  }

  /** Les effets montrent désormais `world` : ceux de l'ancien disparaissent. */
  bind(world: World): void {
    for (const s of this.systems) s.dispose();
    this.ctx.particles.clear();
    this.ctx.streaks.clear();
    this.ctx.marks.clear();
    this.ctx.world = world;
    this.systems = FX_SYSTEMS.map((make) => make(this.ctx));
  }

  /**
   * Préparation (écran de chargement) : une particule, un trait et une marque de chaque sorte en
   * `at`, dans l'allure du moment (et chaque variante d'un sprite : volute, flamme, boule de feu,
   * étincelle), pour que chaque couche soit dessinée (et ses shaders compilés) avant la partie ;
   * `clear` les efface ensuite.
   */
  warmUp(at: Vec3): void {
    const { particles, streaks, marks } = this.ctx;
    for (const kind of PUFF_KINDS) {
      particles.emit(at, { color: "#888888", kind, size: 0.5, grow: 1, life: 10 });
      particles.emit(at, { color: "#888888", kind, size: 0.2, life: 10, stretch: 0.05 }, { x: 0, y: 4, z: 0 });
    }
    particles.emit(at, { color: "#888888", kind: "fire", size: 0.5, grow: 1, life: 10, billow: true });
    particles.volute(at, 1, "#888888", 0.5, 0, 0, 0, at.y - 1, 1, 0);
    for (const kind of ["smoke", "vapor", "glow"] as const) streaks.line(at, { x: at.x + 1, y: at.y + 1, z: at.z }, { color: "#888888", kind, width: 0.1, life: 10 });
    const up = { x: 0, y: 1, z: 0 };
    marks.disc(at, up, 1, { color: "#333333", life: 10 });
    marks.strip(at, { x: at.x + 1, y: at.y, z: at.z }, up, 0.3, { color: "#333333", life: 10 });
  }

  /** Efface toutes les particules, tous les traits et toutes les marques (après la préparation). */
  clear(): void {
    this.ctx.particles.clear();
    this.ctx.streaks.clear();
    this.ctx.marks.clear();
  }

  /** Les meshes des lueurs et des traits lumineux en sphères (pour le halo : voir render/lighting.ts ; les sprites ont le leur). */
  get glowMeshes(): B.Mesh[] {
    return [this.ctx.particles.glowMesh, this.ctx.streaks.glowMesh];
  }

  /** Nombre d'effets vivants (particules), pour le tableau et les mesures. */
  get particleCount(): number {
    return this.ctx.particles.count;
  }

  /** Allure de la fumée et des flammes (réglage graphique). */
  get look(): FxLook {
    return this.ctx.look;
  }

  update(dt: number, eye: Vec3, inside: Bot | null): void {
    const ctx = this.ctx;
    ctx.eye = eye;
    ctx.inside = inside;
    ctx.now = performance.now() / 1000;
    for (const s of this.systems) s.update(dt);
    ctx.particles.update(dt, eye);
    ctx.streaks.update(dt);
    ctx.marks.update(dt);
  }

  setReduced(on: boolean): void {
    this.ctx.reduced = on;
    this.ctx.density = on ? 0.45 : 1;
    this.ctx.particles.setReduced(on);
    this.ctx.streaks.setReduced(on);
    this.ctx.marks.setReduced(on);
  }

  /** Allure de la fumée et des flammes : sphères (simples) ou sprites (réalistes), à chaud. */
  setLook(look: FxLook): void {
    this.ctx.look = look;
    this.ctx.particles.setLook(look);
    this.ctx.streaks.setLook(look);
  }

  /**
   * Poussière d'un pan de mur qui s'écroule ou d'un arbre qui se brise (effets réalistes ; en
   * effets simples, render/effects.ts) : des volutes sur toute son étendue (`half`), qui montent
   * lentement.
   */
  dust(center: Vec3, half: Vec3, color: string): void {
    const size = Math.max(half.x, half.y, half.z);
    const count = Math.round(Math.min(14, 3 + size * 3) * this.ctx.density);
    const spec = { ...DUST, color };
    for (let i = 0; i < count; i++) {
      const at = vec3(center.x + jitter(-1, 1) * half.x, center.y + jitter(-1, 0.5) * half.y, center.z + jitter(-1, 1) * half.z);
      this.ctx.particles.emit(at, spec, vec3(jitter(-0.6, 0.6), jitter(0.2, 0.9), jitter(-0.6, 0.6)), (0.6 + size * 0.25) * jitter(0.8, 1.2));
    }
  }

  dispose(): void {
    for (const s of this.systems) s.dispose();
    this.systems = [];
    this.ctx.particles.dispose();
    this.ctx.streaks.dispose();
    this.ctx.marks.dispose();
  }
}

/**
 * Cadence d'émission : combien de fois émettre pendant `dt` pour `rate` émissions par seconde,
 * avec le reste gardé d'une image à l'autre dans `carry` (une traînée reste régulière à tous les
 * nombres d'images par seconde).
 */
export function emissions(carry: { acc: number }, rate: number, dt: number): number {
  carry.acc += rate * dt;
  const n = Math.floor(carry.acc);
  carry.acc -= n;
  return n;
}
