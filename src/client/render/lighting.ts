import * as B from "../babylon";
import { blockDef } from "../../shared/catalog/blocks";
import type { ExplosionLook, WeaponId } from "../../shared/catalog/weapons";
import { add, distance, qmul, qrot, scale, sub, vec3, type Vec3 } from "../../shared/math/vec";
import { blockWorldPos, liveThrusters } from "../../shared/robot/queries";
import type { Barrier, Block } from "../../shared/sim/entities";
import type { World } from "../../shared/sim/world";
import type { LightRequest } from "./lightChoice";
import { gatherLights } from "./lightSources";
import { LightPool } from "./nightLights";
import { LightBeams } from "./lightBeams";

/*
 * Éclairage en option (onglet Graphismes) : un halo autour de ce qui brille (`GlowLayer`), de
 * brèves lumières sur les explosions et les coups de feu, une distorsion de l'air au-dessus des
 * feux et derrière les tuyères (un post-traitement). Chacun a son coût (mesuré dans Chrome sans GPU,
 * voir docs/architecture.md) ; tout se lit sur le monde affiché, la réplique comprise.
 *
 * Les lumières : si la carte graphique sait faire des lumières en grappes (WebGL 2), une réserve
 * de dizaines de lumières (`LightPool`, render/nightLights.ts) éclaire la nuit (lampes, phares,
 * balises) et, si le réglage les permet, tout ce qui brille (projectiles, feux, moteurs, éclairs) ;
 * sinon, deux `PointLight` pour les éclairs et le feu le plus proche, comme avant.
 */

// --- Halo ---

/**
 * Ce qui ne brille pas, bien que sans éclairage : étiquettes des robots, zones, vapeur, fumée,
 * marques au sol (noms de leurs meshes ou matières).
 */
const NO_HALO = /^(tag|zone|fx-vapor|fx-smoke|fx-streak-vapor|fx-streak-smoke|fx-mark)/;
/** Force du halo, et taille de la texture où il est calculé (part de l'écran) : plus petite, moins coûteuse et plus floue. */
const HALO_INTENSITY = 0.75;
const HALO_RATIO = 0.4;
const HALO_BLUR = 28;

// --- Lumières ---

/**
 * Lumières ponctuelles à la fois. Toujours le même nombre (éteintes à intensité nulle quand elles
 * ne servent pas) : changer le nombre de lumières recompile les matières de toute la scène. Avec
 * le ciel et le soleil, quatre : ce qu'une matière standard prend en compte.
 */
const FLASH_LIGHTS = 2;
/** Au-delà de cette distance à la caméra (m), pas d'éclair : on ne le verrait guère. */
const FLASH_RANGE = 90;
/** Montée d'un éclair (s), puis il s'éteint sur sa durée. */
const FLASH_RISE = 0.04;
/** Couleur de l'éclair de chaque allure d'explosion (TypeScript refuse une allure sans la sienne). */
const BLAST_LIGHT: Record<ExplosionLook, string> = {
  shell: "#ffb060", missile: "#ffb060", rocket: "#ffc070", flak: "#ffb060", mine: "#ffa050", bomb: "#ffa050",
  napalm: "#ff7a2a", warhead: "#fff0d0", barrel: "#ff8a3a", gas: "#bfe6ff", car: "#ff8030",
};
/**
 * Les coups de feu éclairent aussi (couleur, force) : les gros toujours ; les petits (fusil,
 * roquettes, laser, plasma) seulement avec la réserve de lumières (sinon, ils prendraient les deux
 * lumières aux explosions).
 */
const MUZZLE_LIGHT: Partial<Record<WeaponId, { color: string; power: number; small?: true }>> = {
  cannon: { color: "#ffc070", power: 1.3 }, rail: { color: "#a8e6ff", power: 1.6 }, warhead: { color: "#ffc070", power: 1.8 },
  missile: { color: "#ffc070", power: 1 }, lockon: { color: "#ffc070", power: 1 }, flak: { color: "#ffc070", power: 1 },
  shotgun: { color: "#ffc070", power: 0.9 }, emp: { color: "#a8e6ff", power: 1 }, sniper: { color: "#ffd090", power: 0.8 },
  rifle: { color: "#ffd090", power: 0.55, small: true }, rockets: { color: "#ffc070", power: 0.7, small: true },
  laser: { color: "#ff6070", power: 0.45, small: true }, plasma: { color: "#d38cff", power: 0.5, small: true },
};
/** Éclairs en cours, au plus, avec la réserve de lumières (une rafale n'en garde que les plus récents). */
const MAX_FLASHES = 40;

/** Un éclair, avec la réserve de lumières : où, sa couleur, sa force au plus haut, sa portée, quand et combien de temps. */
interface PoolFlash {
  at: Vec3;
  color: B.Color3;
  peak: number;
  range: number;
  start: number;
  duration: number;
}
/** Un feu du décor éclaire aussi ses environs, en vacillant, quand une lumière est libre. */
const FIRE_LIGHT = "#ff8a3a";

interface Flash {
  light: B.PointLight;
  /** Heure de la page (s) où l'éclair a commencé, sa durée (s), sa force au plus haut. */
  start: number;
  duration: number;
  peak: number;
  /** Il éclaire un feu (lumière tenue qui vacille) plutôt qu'un éclair. */
  steady: boolean;
}

// --- Distorsion de chaleur ---

/** Sources de chaleur à la fois, au plus (le post-traitement les parcourt pour chaque pixel). */
const HEAT_SOURCES = 16;
/** Au-delà de cette distance (m), l'air chaud ne se voit plus. */
const HEAT_RANGE = 70;
/** Durée (s) de l'air chaud au-dessus d'une explosion. */
const BLAST_HEAT = 0.8;

const HAZE_SHADER = `
precision highp float;
varying vec2 vUV;
uniform sampler2D textureSampler;
uniform vec4 sources[${HEAT_SOURCES}];
uniform float count;
uniform float time;
uniform float aspect;
void main(void) {
  vec2 offset = vec2(0.0);
  for (int i = 0; i < ${HEAT_SOURCES}; i++) {
    if (float(i) >= count) break;
    vec4 s = sources[i];
    vec2 d = vUV - s.xy;
    d.x *= aspect;
    // L'air chaud monte : la zone s'étire au-dessus de la source
    vec2 e = vec2(d.x, d.y > 0.0 ? d.y * 0.45 : d.y * 1.6);
    float r = length(e) / s.z;
    if (r < 1.0) {
      float k = (1.0 - r) * (1.0 - r) * s.w;
      float fi = float(i);
      offset += k * vec2(sin(vUV.y * 95.0 - time * 7.0 + fi), cos(vUV.x * 70.0 + time * 5.5 + fi * 1.7));
    }
  }
  gl_FragColor = texture2D(textureSampler, vUV + offset * 0.0045);
}
`;

interface Heat {
  at: Vec3;
  /** Rayon de la zone (m) et force (0 à 1). */
  radius: number;
  strength: number;
}

/**
 * Halo, lumières et distorsion de chaleur de la scène de l'arène. `bind` la rattache au monde
 * affiché ; `update` à chaque image.
 */
export class SceneLighting {
  private readonly scene: B.Scene;
  private readonly camera: B.ArcRotateCamera;
  private readonly glowMeshes: readonly B.Mesh[];
  private world: World;
  private unsubscribe: () => void;
  private glow: B.GlowLayer | null = null;
  private readonly flashes: Flash[] = [];
  private lightsOn = false;
  private haze: B.PostProcess | null = null;
  private readonly heat = new Float32Array(HEAT_SOURCES * 4);
  private heatCount = 0;
  /** Blocs en feu (d'après leurs événements) et explosions récentes : des sources de chaleur. */
  private readonly burning = new Set<Block>();
  private readonly blasts: { at: Vec3; radius: number; time: number }[] = [];
  /** La réserve de lumières en grappes, si la carte graphique sait la faire (sinon, les deux `flashes`). */
  private readonly pool: LightPool | null;
  private readonly poolFlashes: PoolFlash[] = [];
  /** Murs d'énergie déployés (d'après leurs événements) : ils luisent. */
  private readonly barriers = new Set<Barrier>();
  private readonly requests: LightRequest[] = [];
  private last = performance.now() / 1000;

  constructor(scene: B.Scene, camera: B.ArcRotateCamera, world: World, glowMeshes: readonly B.Mesh[]) {
    this.scene = scene;
    this.camera = camera;
    this.glowMeshes = glowMeshes;
    this.world = world;
    this.unsubscribe = this.listen(world);
    this.pool = LightPool.create(scene);
    this.beams = this.pool ? new LightBeams(scene) : null;
  }

  /** Les cônes de lumière visibles dans l'air, la nuit (avec la réserve de lumières). */
  private readonly beams: LightBeams | null;

  /** La carte graphique fait-elle les lumières en grappes (la nuit éclairée par les lampes, les phares, les tirs) ? */
  get clustered(): boolean {
    return !!this.pool;
  }

  /** Le monde affiché change (partie en réseau, retour à la partie locale). */
  bind(world: World): void {
    this.unsubscribe();
    this.burning.clear();
    this.barriers.clear();
    this.blasts.length = 0;
    this.poolFlashes.length = 0;
    this.world = world;
    this.unsubscribe = this.listen(world);
  }

  private listen(world: World): () => void {
    return world.on((e) => {
      if (e.type === "explosion") this.onExplosion(e.point, e.radius, e.look);
      else if (e.type === "shot") this.onShot(e.weapon, e.origin);
      else if (e.type === "fireStarted") this.burning.add(e.block);
      else if (e.type === "fireEnded" || e.type === "blockDestroyed") this.burning.delete(e.block);
      else if (e.type === "barrierAdded") this.barriers.add(e.barrier);
      else if (e.type === "barrierRemoved") this.barriers.delete(e.barrier);
    });
  }

  /** Halo autour de ce qui brille : flammes, lasers, traçantes, voyants des mines, lueurs des effets. */
  setGlow(on: boolean): void {
    if (on === !!this.glow) return;
    if (!on) {
      this.glow!.dispose();
      this.glow = null;
      return;
    }
    const glow = new B.GlowLayer("halo", this.scene, { mainTextureRatio: HALO_RATIO, blurKernelSize: HALO_BLUR });
    glow.intensity = HALO_INTENSITY;
    // Brille ce qui n'est pas éclairé et a une couleur propre (les autres meshes masquent le halo)
    glow.customEmissiveColorSelector = (mesh, _subMesh, material, result) => {
      const m = material as B.StandardMaterial;
      if (!m || !m.disableLighting || !m.emissiveColor || NO_HALO.test(mesh.name) || NO_HALO.test(m.name)) {
        result.set(0, 0, 0, 0);
        return;
      }
      result.set(m.emissiveColor.r, m.emissiveColor.g, m.emissiveColor.b, 1);
    };
    // Les lueurs des effets : leur propre matière, pour la couleur de chaque instance
    for (const mesh of this.glowMeshes) glow.referenceMeshToUseItsOwnMaterial(mesh);
    this.glow = glow;
  }

  /** Lumières ponctuelles brèves (explosions, gros coups de canon) et lueur des feux. */
  setLights(on: boolean): void {
    if (on === this.lightsOn) return;
    if (this.pool) {
      // (la réserve garde ses lumières : les lampes de la nuit restent, sans les lumières dynamiques)
      this.lightsOn = on;
      this.poolFlashes.length = 0;
      return;
    }
    if (on && !this.flashes.length) {
      for (let i = 0; i < FLASH_LIGHTS; i++) {
        const light = new B.PointLight(`flash-${i}`, B.Vector3.Zero(), this.scene);
        light.intensity = 0;
        light.specular = new B.Color3(0.15, 0.15, 0.15);
        this.flashes.push({ light, start: -1e9, duration: 1, peak: 0, steady: false });
      }
    }
    for (const f of this.flashes) {
      f.light.setEnabled(on);
      f.light.intensity = 0;
      f.peak = 0;
    }
    this.lightsOn = on;
  }

  /** Distorsion de l'air au-dessus des feux, derrière les tuyères et après une explosion. */
  setHeatHaze(on: boolean): void {
    if (on === !!this.haze) return;
    if (!on) {
      this.haze!.dispose(this.camera);
      this.haze = null;
      return;
    }
    B.ShaderStore.ShadersStore["heatHazeFragmentShader"] = HAZE_SHADER;
    const haze = new B.PostProcess("heatHaze", "heatHaze", ["sources", "count", "time", "aspect"], null, 1, this.camera);
    haze.onApply = (effect) => {
      effect.setArray4("sources", Array.from(this.heat));
      effect.setFloat("count", this.heatCount);
      effect.setFloat("time", performance.now() / 1000);
      effect.setFloat("aspect", haze.width / Math.max(1, haze.height));
    };
    this.haze = haze;
  }

  update(): void {
    const now = performance.now() / 1000;
    const dt = Math.min(0.1, Math.max(0, now - this.last));
    this.last = now;
    if (this.pool) this.updatePool(now, dt);
    else if (this.lightsOn) this.updateLights(now);
    // Les explosions refroidissent
    for (let i = this.blasts.length - 1; i >= 0; i--) if (now - this.blasts[i].time > BLAST_HEAT) this.blasts.splice(i, 1);
    if (this.haze) this.updateHeat(now);
  }

  dispose(): void {
    this.unsubscribe();
    this.setGlow(false);
    this.setHeatHaze(false);
    for (const f of this.flashes) f.light.dispose();
    this.flashes.length = 0;
    this.pool?.dispose();
    this.beams?.dispose();
  }

  /**
   * La réserve de lumières : ce qui éclaire à cette image (la nuit, les lampes et les phares ; avec
   * les lumières dynamiques, tout ce qui brille et les éclairs en cours), les plus utiles allumées.
   */
  private updatePool(now: number, dt: number): void {
    const requests = this.requests;
    requests.length = 0;
    const night = !!this.world.arena.sky?.night;
    gatherLights({ world: this.world, night, effects: this.lightsOn, now, barriers: this.barriers, burning: this.burning }, requests);
    for (let i = this.poolFlashes.length - 1; i >= 0; i--) {
      const f = this.poolFlashes[i];
      const t = now - f.start;
      const k = t < FLASH_RISE ? t / FLASH_RISE : 1 - (t - FLASH_RISE) / f.duration;
      if (k <= 0) {
        this.poolFlashes.splice(i, 1);
        continue;
      }
      requests.push({ key: f, x: f.at.x, y: f.at.y, z: f.at.z, r: f.color.r, g: f.color.g, b: f.color.b, intensity: f.peak * k * k, range: f.range, sudden: true });
    }
    this.pool!.update(requests, this.eye, dt, !this.lightsOn);
    this.beams?.update(requests, night, this.eye);
  }

  private onExplosion(point: Vec3, radius: number, look: ExplosionLook): void {
    this.blasts.push({ at: point, radius, time: performance.now() / 1000 });
    const heavy = look === "warhead";
    this.flash(add(point, vec3(0, Math.min(2, radius * 0.4), 0)), BLAST_LIGHT[look], 2 + radius * 0.6, radius * 5 + 6, heavy ? 0.7 : 0.25 + radius * 0.08);
  }

  private onShot(weapon: WeaponId, origin: Vec3): void {
    const l = MUZZLE_LIGHT[weapon];
    if (l && (!l.small || this.pool)) this.flash(origin, l.color, l.power, 6 + 4 * l.power, l.small ? 0.05 : 0.08);
  }

  /** Un éclair : la lumière la plus faible du moment le prend (un feu tenu cède la place) ; avec la réserve, une lumière de plus. */
  private flash(at: Vec3, color: string, peak: number, range: number, duration: number): void {
    if (!this.lightsOn || distance(at, this.eye) > FLASH_RANGE) return;
    const now = performance.now() / 1000;
    if (this.pool) {
      if (this.poolFlashes.length >= MAX_FLASHES) this.poolFlashes.shift();
      this.poolFlashes.push({ at, color: B.Color3.FromHexString(color), peak, range, start: now, duration });
      return;
    }
    let best: Flash | null = null;
    let weakest = Infinity;
    for (const f of this.flashes) {
      const left = f.steady ? 0 : f.peak * Math.max(0, 1 - (now - f.start) / (f.duration + FLASH_RISE));
      if (left < weakest) {
        weakest = left;
        best = f;
      }
    }
    if (!best || weakest > peak) return;
    best.light.position.set(at.x, at.y, at.z);
    best.light.diffuse = B.Color3.FromHexString(color);
    best.light.range = range;
    best.start = now;
    best.duration = duration;
    best.peak = peak;
    best.steady = false;
  }

  private updateLights(now: number): void {
    let free: Flash | null = null;
    for (const f of this.flashes) {
      if (f.steady) {
        free ??= f;
        continue;
      }
      const t = now - f.start;
      const k = t < FLASH_RISE ? t / FLASH_RISE : Math.max(0, 1 - (t - FLASH_RISE) / f.duration);
      f.light.intensity = f.peak * k * k;
      if (k <= 0) {
        f.steady = true;
        free ??= f;
      }
    }
    // Une lumière libre éclaire le feu du décor le plus proche, en vacillant
    if (!free) return;
    const fire = this.nearestFire();
    for (const f of this.flashes) if (f.steady && f !== free) f.light.intensity = 0;
    if (!fire) {
      free.light.intensity = 0;
      return;
    }
    free.light.position.set(fire.at.x, fire.at.y, fire.at.z);
    free.light.diffuse = B.Color3.FromHexString(FIRE_LIGHT);
    free.light.range = fire.radius * 4 + 4;
    free.light.intensity = 0.9 + 0.25 * Math.sin(now * 17) + 0.15 * Math.sin(now * 29 + 1.3);
  }

  /** Position de la caméra. */
  private get eye(): Vec3 {
    const p = this.camera.position;
    return vec3(p.x, p.y, p.z);
  }

  /** Le feu du décor (bois, flaque) le plus proche de la caméra, à moins de 40 m. */
  private nearestFire(): Heat | null {
    const eye = this.eye;
    let best: Heat | null = null;
    let bestD = 40;
    for (const prop of this.world.props) {
      if (prop.burn <= 0) continue;
      const c = prop.rb.translation();
      const d = distance(c, eye);
      if (d < bestD) {
        bestD = d;
        best = { at: add(c, vec3(0, prop.half.y * 0.5, 0)), radius: Math.max(prop.half.x, prop.half.z, 1), strength: 1 };
      }
    }
    for (const fire of this.world.groundFires) {
      const d = distance(fire.pos, eye);
      if (d < bestD) {
        bestD = d;
        best = { at: add(fire.pos, vec3(0, 0.8, 0)), radius: fire.radius, strength: 1 };
      }
    }
    return best;
  }

  /** Les sources de chaleur les plus proches, ramenées à l'écran (pour le post-traitement). */
  private updateHeat(now: number): void {
    const sources: Heat[] = [];
    for (const prop of this.world.props) {
      if (prop.burn <= 0) continue;
      const c = prop.rb.translation();
      sources.push({ at: add(c, vec3(0, prop.half.y * 0.8, 0)), radius: 2.5 + Math.max(prop.half.x, prop.half.z) * 0.6, strength: 1 });
    }
    for (const fire of this.world.groundFires) sources.push({ at: add(fire.pos, vec3(0, 0.5, 0)), radius: fire.radius + 1, strength: 0.8 });
    for (const block of this.burning) {
      if (!block.alive) {
        this.burning.delete(block);
        continue;
      }
      sources.push({ at: add(blockWorldPos(block), vec3(0, 0.4, 0)), radius: 0.9, strength: 0.6 });
    }
    for (const b of this.blasts) {
      const k = 1 - (now - b.time) / BLAST_HEAT;
      sources.push({ at: add(b.at, vec3(0, b.radius * 0.4, 0)), radius: b.radius * 2, strength: Math.max(0, k) });
    }
    // Derrière les tuyères : là où va la flamme (vers le bas du bloc)
    for (const bot of this.world.bots) {
      for (const t of liveThrusters(bot)) {
        const spec = blockDef(t.block.type).thruster;
        if (!spec || spec.look === "rotor" || spec.look === "propeller" || !t.block.alive) continue;
        const ratio = Math.min(1, t.thrust / (spec.maxThrust || 1));
        if (ratio < 0.15) continue;
        const q = qmul(t.block.part.rb.rotation(), t.block.rot);
        const down = qrot(q, vec3(0, -1, 0));
        const reach = spec.look === "jet" ? 2.2 : 1;
        sources.push({ at: add(blockWorldPos(t.block), scale(down, 0.5 + reach * ratio)), radius: (spec.look === "jet" ? 1.4 : 0.7) * (0.5 + ratio), strength: ratio });
      }
    }
    // Les plus proches devant la caméra, ramenées à l'écran
    const eye = this.eye;
    const forward = this.camera.target.subtract(this.camera.position).normalize();
    const matrix = this.scene.getTransformMatrix();
    const tan = Math.tan(this.camera.fov / 2);
    const near = sources
      .map((s) => ({ s, d: distance(s.at, eye) }))
      .filter(({ s, d }) => d < HEAT_RANGE && d > 1 && dotV(sub(s.at, eye), forward) > 0)
      .sort((a, b) => a.d - b.d)
      .slice(0, HEAT_SOURCES);
    let n = 0;
    const v = new B.Vector3();
    for (const { s, d } of near) {
      v.set(s.at.x, s.at.y, s.at.z);
      const p = B.Vector3.TransformCoordinates(v, matrix);
      const o = n * 4;
      this.heat[o] = (p.x + 1) / 2;
      this.heat[o + 1] = (p.y + 1) / 2;
      this.heat[o + 2] = (s.radius / (d * tan)) * 0.5;
      // Plus loin, plus faible
      this.heat[o + 3] = s.strength * Math.max(0.2, 1 - d / HEAT_RANGE);
      n++;
    }
    this.heatCount = n;
  }
}

const dotV = (a: Vec3, b: { x: number; y: number; z: number }): number => a.x * b.x + a.y * b.y + a.z * b.z;
