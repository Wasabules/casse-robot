import * as B from "../babylon";
import { groundLevel, type ArenaLayout } from "../../shared/arena/layout";
import { smokeRadius } from "../../shared/combat/smoke";
import type { Vec3 } from "../../shared/math/vec";
import type { SmokeCloud } from "../../shared/sim/entities";
import type { World } from "../../shared/sim/world";

/*
 * Le voile des fumigènes : ce qu'un nuage cache de ce qui est derrière lui ou dedans.
 *
 * Le nuage (render/fx/smokeCloudFx.ts, ou les bulles de SmokeView en effets simples) est fait de
 * surfaces transparentes qui n'écrivent pas la profondeur : il couvre le décor et les robots, déjà
 * dessinés, mais pas ce qui se dessine après lui, les autres surfaces transparentes (disques flous
 * des pales, lueur des patins, flammes des moteurs, étincelles, flammes, faisceaux des lampes), ni
 * leur halo (render/lighting.ts) : elles se voyaient au travers, comme les étiquettes des robots
 * (dessinées par-dessus tout). Chacune s'efface donc d'elle-même derrière un nuage : son shader
 * multiplie son opacité par la part de lumière qui traverse les nuages entre la caméra et son
 * point (`smokeVeil`), d'après une boule de densité qui va de son cœur, presque opaque, à rien à son
 * bord (pas de bord net). Les étiquettes font de même, sur le processeur (`SmokeVeil.transmittance`).
 */

/** Nuages pris en compte à la fois, les plus proches de la caméra (un uniforme chacun). */
export const VEIL_CLOUDS = 4;
/**
 * Densité au cœur d'un nuage, en part de son rayon : à travers son centre, la lumière qui passe est
 * exp(−4/3 × DENSITY) (1 %), comme le cœur opaque du nuage dessiné.
 */
const DENSITY = 3.45;
/**
 * Le voile d'un nuage, d'après la forme du nuage dessiné (une demi-boule posée au sol, un peu
 * aplatie : le centre de ses volutes du cœur de 0,17 à 0,83 fois son rayon au-dessus de sa base,
 * à 0,76 fois son rayon du centre au plus) : un ellipsoïde, son centre à VEIL_LIFT fois le rayon
 * au-dessus de sa base, de VEIL_RADIUS fois le rayon à l'horizontale, VEIL_FLAT fois moins haut.
 * Plus grand (une boule de 1,2 fois le rayon, son centre à 0,5), il cachait les étiquettes de robots
 * qu'on voyait encore au bord du nuage, ou juste au-dessus.
 */
const VEIL_LIFT = 0.35;
const VEIL_RADIUS = 1.05;
const VEIL_FLAT = 0.75;
/**
 * Les premiers mètres devant la caméra ne cachent rien : les volutes s'effacent tout contre elle
 * (render/fx/sprites.ts, `soft`) ; une caméra au bord d'un nuage voit à travers ce bord.
 */
const VEIL_CLEAR = 2;
/** Temps de croissance d'un nuage (s, voir combat/smoke.ts) : ensuite, il ne fait plus que s'effilocher en se dissipant. */
export const CLOUD_GROWTH = 1.2;

/** Forme d'un nuage à l'heure `time`, telle que la dessinent les effets. */
export interface CloudShape {
  /** Rayon (m) et part du nuage déjà là (il grandit, puis se dissipe). */
  r: number;
  show: number;
  /** Hauteur du sol sous lui, et de sa base (le bas de ses volutes). */
  ground: number;
  base: number;
}

/** La forme d'un nuage (rayon, base…), commune au nuage dessiné et à son voile. */
export function cloudShape(cloud: SmokeCloud, time: number, arena: ArenaLayout): CloudShape {
  const r = smokeRadius(cloud, time);
  const k = Math.min(1, r / cloud.radius);
  const ground = Math.min(cloud.pos.y, groundLevel(arena, cloud.pos.x, cloud.pos.z));
  return { r, show: Math.min(1, k * 1.6), ground, base: Math.max(ground, cloud.pos.y - r * 0.15) };
}

/** Les uniformes du voile d'une scène : une boule par nuage (centre, rayon) et leurs densités (0 : pas de nuage). */
interface VeilState {
  clouds: Float32Array;
  density: Float32Array;
}
const STATES = new WeakMap<B.Scene, VeilState>();

/** Les uniformes du voile de cette scène (sans nuage tant que personne ne les remplit : le garage, l'éditeur). */
export function veilState(scene: B.Scene): VeilState {
  let state = STATES.get(scene);
  if (!state) {
    state = { clouds: new Float32Array(VEIL_CLOUDS * 4), density: new Float32Array(VEIL_CLOUDS) };
    STATES.set(scene, state);
  }
  return state;
}

/** Noms des uniformes du voile (une matière d'effet les reçoit : render/fx/fxMaterial.ts). */
export const VEIL_UNIFORMS = ["smokeVeil0", "smokeVeil1", "smokeVeil2", "smokeVeil3", "smokeVeilDensity"];

/** Donne les uniformes du voile de `scene` à un shader. */
export function bindVeil(effect: B.Effect, scene: B.Scene): void {
  const { clouds: c, density: d } = veilState(scene);
  effect.setFloat4("smokeVeil0", c[0], c[1], c[2], c[3]);
  effect.setFloat4("smokeVeil1", c[4], c[5], c[6], c[7]);
  effect.setFloat4("smokeVeil2", c[8], c[9], c[10], c[11]);
  effect.setFloat4("smokeVeil3", c[12], c[13], c[14], c[15]);
  effect.setFloat4("smokeVeilDensity", d[0], d[1], d[2], d[3]);
}

/**
 * La part de lumière qui traverse les nuages le long du segment de l'œil au point, passé ses
 * VEIL_CLEAR premiers mètres : la densité (1 − r²/R²) de chaque ellipsoïde, intégrée le long de la
 * corde. Le calcul se fait dans un espace où les hauteurs sont divisées par VEIL_FLAT (l'ellipsoïde
 * y est une boule, son centre déjà ramené dans cet espace par `SmokeVeil.write`), sa longueur
 * rapportée ensuite aux mètres du monde.
 */
const VEIL_BODY = `
float smokeVeilCloud(vec3 eye, vec3 dir, float len, float clear, vec4 c, float density) {
  if (density <= 0.0) return 0.0;
  vec3 oc = c.xyz - eye;
  float b = dot(oc, dir);
  float r2 = c.w * c.w;
  float q = dot(oc, oc) - b * b;
  if (q >= r2) return 0.0;
  float h = sqrt(r2 - q);
  float s0 = max(-h, clear - b);
  float s1 = min(h, len - b);
  if (s1 <= s0) return 0.0;
  float along = (1.0 - q / r2) * (s1 - s0) - (s1 * s1 * s1 - s0 * s0 * s0) / (3.0 * r2);
  return along * density / c.w;
}
float smokeVeil(vec3 eye, vec3 p) {
  if (smokeVeilDensity.x <= 0.0) return 1.0;
  vec3 squash = vec3(1.0, ${(1 / VEIL_FLAT).toFixed(6)}, 1.0);
  vec3 d = p - eye;
  float world = length(d);
  if (world < 0.0001) return 1.0;
  d *= squash;
  vec3 e = eye * squash;
  float len = length(d);
  vec3 dir = d / len;
  float clear = ${VEIL_CLEAR.toFixed(1)} * len / world;
  float tau = smokeVeilCloud(e, dir, len, clear, smokeVeil0, smokeVeilDensity.x)
    + smokeVeilCloud(e, dir, len, clear, smokeVeil1, smokeVeilDensity.y)
    + smokeVeilCloud(e, dir, len, clear, smokeVeil2, smokeVeilDensity.z)
    + smokeVeilCloud(e, dir, len, clear, smokeVeil3, smokeVeilDensity.w);
  return exp(-tau * world / len);
}
`;

/** Le voile en GLSL : ses uniformes et `float smokeVeil(vec3 eye, vec3 p)` (1 : rien ne cache p). */
export const VEIL_GLSL = `
uniform vec4 smokeVeil0;
uniform vec4 smokeVeil1;
uniform vec4 smokeVeil2;
uniform vec4 smokeVeil3;
uniform vec4 smokeVeilDensity;
${VEIL_BODY}`;

/** Le même en WGSL (les matières de Babylon sous WebGPU). */
const VEIL_WGSL = `
uniform smokeVeil0: vec4f;
uniform smokeVeil1: vec4f;
uniform smokeVeil2: vec4f;
uniform smokeVeil3: vec4f;
uniform smokeVeilDensity: vec4f;
fn smokeVeilCloud(eye: vec3f, dir: vec3f, len: f32, clear: f32, c: vec4f, density: f32) -> f32 {
  if (density <= 0.0) { return 0.0; }
  let oc = c.xyz - eye;
  let b = dot(oc, dir);
  let r2 = c.w * c.w;
  let q = dot(oc, oc) - b * b;
  if (q >= r2) { return 0.0; }
  let h = sqrt(r2 - q);
  let s0 = max(-h, clear - b);
  let s1 = min(h, len - b);
  if (s1 <= s0) { return 0.0; }
  let along = (1.0 - q / r2) * (s1 - s0) - (s1 * s1 * s1 - s0 * s0 * s0) / (3.0 * r2);
  return along * density / c.w;
}
fn smokeVeil(eye: vec3f, p: vec3f) -> f32 {
  if (uniforms.smokeVeilDensity.x <= 0.0) { return 1.0; }
  let squash = vec3f(1.0, ${(1 / VEIL_FLAT).toFixed(6)}, 1.0);
  let world = length(p - eye);
  if (world < 0.0001) { return 1.0; }
  let d = (p - eye) * squash;
  let e = eye * squash;
  let len = length(d);
  let dir = d / len;
  let clear = ${VEIL_CLEAR.toFixed(1)} * len / world;
  let tau = smokeVeilCloud(e, dir, len, clear, uniforms.smokeVeil0, uniforms.smokeVeilDensity.x)
    + smokeVeilCloud(e, dir, len, clear, uniforms.smokeVeil1, uniforms.smokeVeilDensity.y)
    + smokeVeilCloud(e, dir, len, clear, uniforms.smokeVeil2, uniforms.smokeVeilDensity.z)
    + smokeVeilCloud(e, dir, len, clear, uniforms.smokeVeil3, uniforms.smokeVeilDensity.w);
  return exp(-tau * world / len);
}
`;

/** Valeur de Babylon : `ShaderLanguage.WGSL`. */
const WGSL = 1;

/**
 * Le voile dans une matière de Babylon (`StandardMaterial`) transparente : son opacité, à la fin du
 * shader, multipliée par la part de lumière qui traverse les nuages (GLSL et WGSL).
 */
class SmokeVeilPlugin extends B.MaterialPluginBase {
  constructor(material: B.Material) {
    super(material, "SmokeVeil", 250, { SMOKEVEIL: false });
    // (sans quoi Babylon n'appelle pas `hardBindForSubMesh`, et les nuages ne parviennent pas au shader)
    this.registerForExtraEvents = true;
    this._enable(true);
  }

  override getClassName(): string {
    return "SmokeVeilPlugin";
  }

  override isCompatible(): boolean {
    return true;
  }

  override prepareDefines(defines: B.MaterialDefines): void {
    defines["SMOKEVEIL"] = true;
  }

  override getUniforms(): { externalUniforms: string[] } {
    return { externalUniforms: VEIL_UNIFORMS };
  }

  /** À chaque dessin (aussi d'une matière figée) : les nuages de l'image. */
  override hardBindForSubMesh(_ubo: unknown, scene: B.Scene, _engine: unknown, subMesh: B.SubMesh): void {
    const effect = subMesh.effect;
    if (effect) bindVeil(effect, scene);
  }

  override getCustomCode(shaderType: string, shaderLanguage?: number): { [point: string]: string } | null {
    if (shaderType !== "fragment") return null;
    if (shaderLanguage === WGSL) {
      return {
        CUSTOM_FRAGMENT_DEFINITIONS: VEIL_WGSL,
        CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `
#ifdef SMOKEVEIL
let smokeVeilLeft = smokeVeil(scene.vEyePosition.xyz, fragmentInputs.vPositionW);
#ifdef PREMULTIPLYALPHA
color = color * smokeVeilLeft;
#else
color = vec4f(color.rgb, color.a * smokeVeilLeft);
#endif
#endif
`,
      };
    }
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: VEIL_GLSL,
      CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `
#ifdef SMOKEVEIL
float smokeVeilLeft = smokeVeil(vEyePosition.xyz, vPositionW);
#ifdef PREMULTIPLYALPHA
color *= smokeVeilLeft;
#else
color.a *= smokeVeilLeft;
#endif
#endif
`,
    };
  }
}

/**
 * Une matière transparente de Babylon qui s'efface derrière les fumigènes (disque flou des pales,
 * lueur des patins…) : à donner aux surfaces qui se dessinent après la fumée.
 */
export function veilMaterial(material: B.StandardMaterial): void {
  if (!material.pluginManager?.getPlugin("SmokeVeil")) new SmokeVeilPlugin(material);
}

/** Le voile d'un nuage : centre, rayon à l'horizontale (VEIL_FLAT fois moins haut), densité. */
interface VeilBall {
  x: number;
  y: number;
  z: number;
  r: number;
  density: number;
  /** Distance de la caméra à sa surface (pour choisir les plus proches). */
  near: number;
}

/**
 * Les nuages du monde affiché (d'après leurs événements, en réseau aussi) : à chaque image, leurs
 * boules (`update`), les uniformes du voile pour les shaders, et la part de lumière qui traverse
 * les nuages entre deux points (`transmittance`), pour les étiquettes.
 */
export class SmokeVeil {
  private readonly scene: B.Scene;
  private world: World;
  private off: () => void;
  private readonly clouds = new Map<number, SmokeCloud>();
  private readonly balls: VeilBall[] = [];

  constructor(scene: B.Scene, world: World) {
    this.scene = scene;
    this.world = world;
    this.off = this.listen(world);
  }

  /** Le monde affiché change : ses nuages remplacent les anciens. */
  bind(world: World): void {
    this.off();
    this.clouds.clear();
    this.balls.length = 0;
    this.world = world;
    this.off = this.listen(world);
    this.write();
  }

  /** Les boules des nuages à cette image, et les uniformes des plus proches de `eye` (la caméra). */
  update(eye: Vec3): void {
    const balls = this.balls;
    balls.length = 0;
    const time = this.world.time;
    for (const cloud of this.clouds.values()) {
      const shape = cloudShape(cloud, time, this.world.arena);
      if (shape.r < 0.05) continue;
      const r = shape.r * VEIL_RADIUS;
      const x = cloud.pos.x, y = shape.base + shape.r * VEIL_LIFT, z = cloud.pos.z;
      balls.push({ x, y, z, r, density: DENSITY * shape.show, near: Math.hypot(x - eye.x, y - eye.y, z - eye.z) - r });
    }
    if (balls.length > VEIL_CLOUDS) balls.sort((a, b) => a.near - b.near);
    this.write();
  }

  /** Part de la lumière qui traverse les nuages de `from` à `to` (1 : aucun nuage entre les deux ; comme `smokeVeil`). */
  transmittance(from: Vec3, to: Vec3): number {
    if (!this.balls.length) return 1;
    const world = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    if (world < 1e-4) return 1;
    // (dans l'espace où l'ellipsoïde est une boule : les hauteurs divisées par VEIL_FLAT)
    const dx = to.x - from.x, dy = (to.y - from.y) / VEIL_FLAT, dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    const ux = dx / len, uy = dy / len, uz = dz / len;
    const clear = (VEIL_CLEAR * len) / world;
    let tau = 0;
    for (const ball of this.balls) {
      const ox = ball.x - from.x, oy = (ball.y - from.y) / VEIL_FLAT, oz = ball.z - from.z;
      const b = ox * ux + oy * uy + oz * uz;
      const r2 = ball.r * ball.r;
      const q = ox * ox + oy * oy + oz * oz - b * b;
      if (q >= r2) continue;
      const h = Math.sqrt(r2 - q);
      const s0 = Math.max(-h, clear - b), s1 = Math.min(h, len - b);
      if (s1 <= s0) continue;
      tau += (((1 - q / r2) * (s1 - s0) - (s1 * s1 * s1 - s0 * s0 * s0) / (3 * r2)) * ball.density) / ball.r;
    }
    return Math.exp((-tau * world) / len);
  }

  dispose(): void {
    this.off();
    this.clouds.clear();
    this.balls.length = 0;
    this.write();
  }

  private listen(world: World): () => void {
    return world.on((e) => {
      if (e.type === "smokeAdded") this.clouds.set(e.cloud.id, e.cloud);
      else if (e.type === "smokeRemoved") this.clouds.delete(e.cloud.id);
    });
  }

  /** Les uniformes : les `VEIL_CLOUDS` premières boules (les plus proches), densité nulle au-delà. */
  private write(): void {
    const state = veilState(this.scene);
    for (let i = 0; i < VEIL_CLOUDS; i++) {
      const ball = this.balls[i];
      state.clouds[i * 4] = ball?.x ?? 0;
      // (sa hauteur dans l'espace où l'ellipsoïde est une boule, voir `smokeVeil`)
      state.clouds[i * 4 + 1] = (ball?.y ?? 0) / VEIL_FLAT;
      state.clouds[i * 4 + 2] = ball?.z ?? 0;
      state.clouds[i * 4 + 3] = ball?.r ?? 1;
      state.density[i] = ball?.density ?? 0;
    }
  }
}
