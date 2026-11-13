import * as B from "../../babylon";
import type { Vec3 } from "../../../shared/math/vec";
import type { FxLook } from "../../settings";
import { InstanceLayer, rgb } from "./layer";
import { sprite, SpriteLayer, type Sprite } from "./sprites";

/**
 * Sorte de particule, qui décide de son rendu :
 * - `smoke` : de la matière (fumée, poussière, terre, gaz) éclairée par le soleil, qui dérive au
 *   vent ; une particule qui ne grossit pas (éclat, copeau, douille, motte) reste une petite boule
 *   pleine, une volute de fumée sinon (effets réalistes) ;
 * - `vapor` : de la vapeur claire (condensation, souffle blanc), de sa propre couleur, sans ombre ;
 * - `glow` : une lueur (étincelle, braise, éclair), de sa propre couleur, sans ombre (mélangée
 *   comme la fumée : en plein jour, une lueur qui s'ajouterait au décor clair y virerait au blanc) ;
 * - `fire` : du feu (flamme, boule de feu). En effets simples, une lueur comme `glow` ; en effets
 *   réalistes, une flamme qui ondule en montant, ou une boule de feu qui refroidit en fumée.
 */
export type PuffKind = "smoke" | "vapor" | "glow" | "fire";
export const PUFF_KINDS: readonly PuffKind[] = ["smoke", "vapor", "glow", "fire"];

export interface PuffSpec {
  /** Couleur « #rrggbb ». Une boule de feu : la couleur de la fumée qu'elle devient. */
  color: string;
  kind: PuffKind;
  /** Diamètre au départ (m). */
  size: number;
  /** Diamètre à la fin (m) ; par défaut, `size`. Il grossit vite puis de moins en moins. */
  grow?: number;
  /** Durée de vie (s). */
  life: number;
  /** Opacité au départ (0 à 1 ; 1 par défaut). Elle s'éteint jusqu'à la fin de sa vie. */
  alpha?: number;
  /** Part de sa vie qu'elle met à apparaître (0 : d'un coup). */
  fadeIn?: number;
  /** Part de la fin de sa vie pendant laquelle elle s'efface (par défaut, tout ce qui suit son apparition). */
  fadeOut?: number;
  /** Freinage (1/s) : sa vitesse de départ se perd d'autant par seconde. */
  drag?: number;
  /** Pesanteur (m/s², vers le bas) ; négative, elle monte (fumée chaude). */
  gravity?: number;
  /** Étirement le long de sa vitesse (s) : sa longueur gagne la distance parcourue pendant ce temps (étincelles, gouttes). */
  stretch?: number;
  /** Part du vent qui l'emporte (par défaut 1 pour la fumée et la vapeur, 0 pour une lueur et le feu). */
  wind?: number;
  /** Feu (effets réalistes) : chaleur au départ (1 par défaut : blanc-jaune au cœur ; moins, plus rouge). */
  heat?: number;
  /** Feu : part de sa vie pendant laquelle il brûle (1 par défaut) ; ensuite, ce n'est plus que de la fumée. */
  burn?: number;
  /** Feu : une boule de feu (une volute incandescente qui roule), et non une flamme qui monte. */
  billow?: boolean;
  /** Rotation propre (rad/s, au plus, dans un sens ou l'autre) d'une volute ; par défaut, lente. */
  spin?: number;
}

/** Particules vivantes au plus, par sorte, et en effets réduits. */
const CAPACITY: Record<PuffKind, number> = { smoke: 2400, vapor: 900, glow: 1600, fire: 1200 };
const REDUCED_SHARE = 0.4;
/** Volutes posées pour une seule image (nuages de fumigène, voir `volute`), au plus. */
const TRANSIENT = 900;
/** Flammes posées pour une seule image (les blocs en feu, voir `flame`), au plus. */
const TRANSIENT_FIRE = 600;
/** Vent léger qui emporte les fumées (m/s) : elles ne montent pas toutes droites. */
const WIND = { x: 0.45, y: 0, z: 0.25 };
/** Rotation propre d'une volute par défaut (rad/s, au plus). */
const SPIN = 0.35;
/** Part de sa propre couleur dans une flamme (effets réalistes) : le reste est la rampe du feu. */
const FLAME_TINT = 0.4;
/**
 * Une flamme qui file se couche à l'opposé de sa course (l'air immobile la rabat) : de tant par
 * m/s de vitesse horizontale, au plus `FLAME_LEAN_MAX` (rapporté à sa hauteur : ~50°).
 */
export const FLAME_LEAN = 0.1;
export const FLAME_LEAN_MAX = 1.2;

/**
 * Une particule. Une classe, dont le constructeur donne tous les champs dans le même ordre : une
 * particule reprise du réservoir peut avoir été une volute, une flamme posée ou une particule
 * vivante, et des objets nés vides (`{}`) puis remplis dans trois ordres différents prenaient
 * chacun leur forme cachée. Le vieillissement, le tri et l'écriture, qui les lisent toutes,
 * devenaient mégamorphes : ~2 ms par image au Dépôt pour quelques centaines de particules.
 */
class Particle {
  kind: PuffKind = "smoke";
  x = 0; y = 0; z = 0;
  vx = 0; vy = 0; vz = 0;
  age = 0; life = 1;
  /** Née pendant cette image : elle est dessinée telle qu'elle naît avant de vieillir (voir `update`). */
  fresh = false;
  size = 1; grow = 1;
  alpha = 1; fadeIn = 0; fadeOut = 1;
  drag = 0; gravity = 0; stretch = 0; wind = 0;
  r = 1; g = 1; b = 1;
  // Effets réalistes
  /** Éclat, copeau : une petite boule pleine, pas une volute. */
  solid = false;
  angle = 0; spin = 0; frame = 0; seed = 0;
  /** Hauteur du sol sous son point de départ. */
  ground = 0;
  /** D'une volute de l'image (`volute`) : la hauteur (m) sur laquelle elle s'efface au ras du sol (0 : selon sa taille). */
  groundFade = 0;
  heat = 1; burn = 1; billow = false;
  /** Flamme posée pour une image (`flame`) : son haut, de la longueur de sa hauteur en part de sa largeur. */
  posed = false;
  lx = 0; ly = 0; lz = 0;
  /** Ce qu'elle a été à la dernière image (pour le tri et l'écriture) : position, taille, opacité. */
  size1 = 1; a1 = 0; long = 0;
}

/**
 * Champ de particules. Il fait vivre les particules (naissance, mouvement, croissance,
 * effacement), puis les dessine selon l'allure des effets (`setLook`) :
 * - simples : des sphères, trois couches (fumée, vapeur, lueurs) en instances fines ;
 * - réalistes : des sprites (render/fx/sprites.ts), quatre couches (fumée, vapeur, lueurs, feu),
 *   triées de la plus lointaine à la plus proche (la fumée se superpose dans le bon ordre), et les
 *   éclats restent des boules pleines.
 * Au-delà de leur plafond, les nouvelles ne naissent pas.
 */
export class ParticleField {
  private readonly scene: B.Scene;
  /** Les sphères (effets simples, et les éclats). */
  private readonly layers: Record<"smoke" | "vapor" | "glow", InstanceLayer>;
  /** Les sprites (effets réalistes), créés à la première demande. */
  private sprites: Record<PuffKind, SpriteLayer> | null = null;
  private look: FxLook = "simple";
  private readonly live: Record<PuffKind, Particle[]> = { smoke: [], vapor: [], glow: [], fire: [] };
  /** Volutes de cette image seulement (voir `volute`). */
  private readonly transient: Particle[] = [];
  /** Flammes de cette image seulement (voir `flame`). */
  private readonly transientFire: Particle[] = [];
  private readonly pool: Particle[] = [];
  private limit: Record<PuffKind, number> = { ...CAPACITY };
  /** Hauteur du sol en (x, z), fournie par les effets (l'arène affichée). */
  groundAt: (x: number, z: number) => number = () => 0;
  private readonly out: Sprite = sprite();
  private readonly order: number[] = [];
  private keys = new Float32Array(CAPACITY.smoke + TRANSIENT);

  constructor(scene: B.Scene) {
    this.scene = scene;
    const sphere = (name: string): B.Mesh => B.MeshBuilder.CreateIcoSphere(name, { radius: 0.5, subdivisions: 2 }, scene);
    this.layers = {
      smoke: new InstanceLayer(scene, "fx-smoke", sphere("fx-smoke"), { blend: "blend", lit: true, capacity: CAPACITY.smoke, selfLight: 0.3 }),
      vapor: new InstanceLayer(scene, "fx-vapor", sphere("fx-vapor"), { blend: "blend", lit: false, capacity: CAPACITY.vapor }),
      glow: new InstanceLayer(scene, "fx-glow", sphere("fx-glow"), { blend: "blend", lit: false, capacity: CAPACITY.glow + CAPACITY.fire }),
    };
  }

  /** Allure des effets : sphères (simples) ou sprites (réalistes). Les particules vivantes changent d'allure à l'image suivante. */
  setLook(look: FxLook): void {
    this.look = look;
    if (look === "realistic") this.spriteLayers();
  }

  /** Les couches de sprites (créées à la première demande : leur texture se calcule alors). */
  private spriteLayers(): Record<PuffKind, SpriteLayer> {
    if (!this.sprites) {
      const scene = this.scene;
      this.sprites = {
        // (la fumée et les fumigènes, triés ensemble ; ce qui se dessine après s'efface derrière les fumigènes : `veiled`)
        smoke: new SpriteLayer(scene, "fx-sprite-smoke", { look: "smoke", capacity: CAPACITY.smoke + TRANSIENT, sizeScale: 1.45, alphaIndex: 10 }),
        vapor: new SpriteLayer(scene, "fx-sprite-vapor", { look: "vapor", capacity: CAPACITY.vapor, sizeScale: 1.45, selfLight: 0.75, alphaIndex: 11, veiled: true }),
        fire: new SpriteLayer(scene, "fx-sprite-fire", { look: "fire", capacity: CAPACITY.fire, sizeScale: 2.3, softness: 0.15, alphaIndex: 12, veiled: true }),
        glow: new SpriteLayer(scene, "fx-sprite-glow", { look: "glow", capacity: CAPACITY.glow, sizeScale: 1.7, lengthScale: 1.15, softness: 0.05, alphaIndex: 13, veiled: true }),
      };
    }
    return this.sprites;
  }

  /** Une particule en `at`, lancée à la vitesse `vel` (m/s) ; `scale` agrandit sa taille. */
  emit(at: Vec3, spec: PuffSpec, vel?: Vec3, scale = 1): void {
    const list = this.live[spec.kind];
    if (list.length >= this.limit[spec.kind]) return;
    const p = this.pool.pop() ?? new Particle();
    this.init(p, at, spec, vel, scale);
    list.push(p);
  }

  /**
   * Une volute dessinée pendant cette image seulement, triée avec les autres (effets réalistes) :
   * les nuages de fumigène, que leur système recompose à chaque image. `shade` : la lumière
   * qu'elle reçoit (1 : au soleil ; moins : au cœur, sous le nuage) ; `groundFade` : la hauteur (m)
   * sur laquelle elle s'efface au ras du sol `ground` (0 : selon sa taille, comme une particule).
   */
  volute(at: Vec3, size: number, color: string, alpha: number, angle: number, frame: number, age: number, ground: number, shade: number, seed: number, groundFade = 0): void {
    if (this.look !== "realistic" || this.transient.length >= TRANSIENT) return;
    const p = this.pool.pop() ?? new Particle();
    const [r, g, b] = rgb(color);
    p.kind = "smoke";
    p.x = at.x; p.y = at.y; p.z = at.z;
    p.size1 = size; p.a1 = alpha; p.long = 0;
    p.r = r; p.g = g; p.b = b;
    p.solid = false;
    p.angle = angle; p.frame = frame; p.seed = seed;
    p.ground = ground;
    p.groundFade = groundFade;
    p.heat = shade; // (une volute n'a pas de chaleur : on y range sa lumière)
    p.age = age; p.life = 1;
    this.transient.push(p);
  }

  /**
   * Une flamme dessinée pendant cette image seulement, triée avec les autres (effets réalistes) :
   * une langue de feu accrochée à ce qui brûle (un bloc), que son système repose à chaque image là
   * où il est ; elle ne vieillit pas, le bruit qui défile dans son shader la fait onduler. Sa base
   * en `at`, de `size` de large ; `up` : son haut (la verticale, ou couchée par le vent de sa
   * course), de la longueur de sa hauteur en part de sa largeur ; `heat` : sa chaleur (1 :
   * blanc-jaune au cœur) ; `alpha` : moins, elle se réduit à son cœur (elle s'éteint).
   */
  flame(at: Vec3, size: number, up: Vec3, heat: number, alpha: number, seed: number, color: string): void {
    if (this.look !== "realistic" || this.transientFire.length >= TRANSIENT_FIRE) return;
    const p = this.pool.pop() ?? new Particle();
    const [r, g, b] = rgb(color);
    p.kind = "fire";
    p.x = at.x; p.y = at.y; p.z = at.z;
    p.vx = 0; p.vy = 0; p.vz = 0;
    p.size1 = size; p.a1 = alpha; p.long = 0;
    p.r = r; p.g = g; p.b = b;
    p.solid = false;
    p.angle = 0; p.frame = 0; p.seed = seed;
    p.ground = this.groundAt(at.x, at.z);
    p.heat = heat; p.burn = 1; p.billow = false;
    p.posed = true;
    p.lx = up.x; p.ly = up.y; p.lz = up.z;
    p.age = 0; p.life = 1;
    this.transientFire.push(p);
  }

  private init(p: Particle, at: Vec3, spec: PuffSpec, vel: Vec3 | undefined, scale: number): void {
    const [r, g, b] = rgb(spec.color);
    p.kind = spec.kind;
    p.x = at.x; p.y = at.y; p.z = at.z;
    p.vx = vel?.x ?? 0; p.vy = vel?.y ?? 0; p.vz = vel?.z ?? 0;
    p.age = 0; p.life = spec.life; p.fresh = true;
    p.size = spec.size * scale; p.grow = (spec.grow ?? spec.size) * scale;
    p.alpha = spec.alpha ?? 1; p.fadeIn = spec.fadeIn ?? 0; p.fadeOut = spec.fadeOut ?? 1 - p.fadeIn;
    p.drag = spec.drag ?? 0; p.gravity = spec.gravity ?? 0; p.stretch = spec.stretch ?? 0;
    p.wind = spec.wind ?? (spec.kind === "glow" || spec.kind === "fire" ? 0 : 1);
    p.r = r; p.g = g; p.b = b;
    p.solid = spec.kind === "smoke" && (spec.grow ?? spec.size) <= spec.size * 1.05;
    p.angle = Math.random() * Math.PI * 2;
    const spin = spec.spin ?? SPIN;
    p.spin = (Math.random() * 2 - 1) * spin;
    p.frame = Math.floor(Math.random() * 4);
    p.seed = Math.random();
    p.ground = this.look === "realistic" ? this.groundAt(at.x, at.z) : -1e6;
    p.heat = spec.heat ?? 1;
    p.burn = spec.burn ?? 1;
    p.billow = !!spec.billow;
    p.posed = false;
    p.size1 = p.size; p.a1 = 0; p.long = 0;
  }

  /** Les meshes des lueurs (le halo lumineux les dessine avec leur propre matière : la couleur de chaque instance). */
  get glowMesh(): B.Mesh {
    return this.layers.glow.mesh;
  }

  /** Nombre de particules vivantes (toutes sortes). */
  get count(): number {
    return this.live.smoke.length + this.live.vapor.length + this.live.glow.length + this.live.fire.length;
  }

  /** Effets réduits : moins de particules à la fois. */
  setReduced(on: boolean): void {
    for (const kind of PUFF_KINDS) this.limit[kind] = Math.round(CAPACITY[kind] * (on ? REDUCED_SHARE : 1));
  }

  clear(): void {
    for (const kind of PUFF_KINDS) {
      for (const p of this.live[kind]) this.pool.push(p);
      this.live[kind].length = 0;
    }
    this.dropTransient();
  }

  /** Les particules vieillissent et bougent, puis sont dessinées ; `eye` : la caméra (tri des sprites). */
  update(dt: number, eye: Vec3): void {
    for (const kind of PUFF_KINDS) this.age(this.live[kind], dt);
    if (this.look === "realistic") this.drawSprites(eye);
    else this.drawSpheres();
  }

  private age(list: Particle[], dt: number): void {
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      // Une particule née pendant cette image y est dessinée à sa naissance : sans quoi, à peu
      // d'images par seconde, une étincelle plus brève qu'une image ne serait jamais vue
      const step = p.fresh ? 0 : dt;
      p.fresh = false;
      p.age += step;
      if (p.age >= p.life) {
        list[i] = list[list.length - 1];
        list.pop();
        this.pool.push(p);
        continue;
      }
      if (p.drag > 0) {
        const k = Math.exp(-p.drag * step);
        p.vx *= k; p.vy *= k; p.vz *= k;
      }
      p.vy -= p.gravity * step;
      p.x += (p.vx + WIND.x * p.wind) * step;
      p.y += p.vy * step;
      p.z += (p.vz + WIND.z * p.wind) * step;
      p.angle += p.spin * step;
      const t = p.age / p.life;
      p.size1 = p.size + (p.grow - p.size) * Math.sqrt(t);
      const fade = p.fadeIn > 0 && t < p.fadeIn ? t / p.fadeIn : Math.min(1, (1 - t) / p.fadeOut);
      p.a1 = p.alpha * fade;
      p.long = 0;
      if (p.stretch > 0) {
        const speed = Math.hypot(p.vx, p.vy, p.vz);
        if (speed > 0.2) p.long = p.size1 + speed * p.stretch;
      }
    }
  }

  /** Effets simples : des sphères (le feu dans la couche des lueurs). */
  private drawSpheres(): void {
    const { smoke, vapor, glow } = this.layers;
    smoke.begin();
    vapor.begin();
    glow.begin();
    for (const p of this.live.smoke) sphere(smoke, p);
    for (const p of this.live.vapor) sphere(vapor, p);
    for (const p of this.live.glow) sphere(glow, p);
    for (const p of this.live.fire) sphere(glow, p);
    smoke.end();
    vapor.end();
    glow.end();
    this.dropTransient();
    if (this.sprites) for (const layer of Object.values(this.sprites)) {
      layer.begin();
      layer.end();
    }
  }

  /** Effets réalistes : des sprites, triés du plus lointain au plus proche ; les éclats en boules. */
  private drawSprites(eye: Vec3): void {
    const sprites = this.spriteLayers();
    const solids = this.layers.smoke;
    solids.begin();
    for (const p of this.live.smoke) if (p.solid) sphere(solids, p);
    solids.end();
    this.layers.vapor.begin();
    this.layers.vapor.end();
    this.layers.glow.begin();
    this.layers.glow.end();
    this.drawSorted(sprites.smoke, this.live.smoke, eye, this.transient);
    this.drawSorted(sprites.vapor, this.live.vapor, eye, null);
    this.drawSorted(sprites.fire, this.live.fire, eye, this.transientFire);
    // (les lueurs s'ajoutent en partie à ce qui est derrière : l'ordre compte peu)
    const glow = sprites.glow;
    glow.begin();
    for (const p of this.live.glow) this.write(glow, p);
    glow.end();
    this.dropTransient();
  }

  private dropTransient(): void {
    for (const p of this.transient) this.pool.push(p);
    this.transient.length = 0;
    for (const p of this.transientFire) this.pool.push(p);
    this.transientFire.length = 0;
  }

  /**
   * Les particules d'une couche, et ce qui n'est posé que pour cette image (les volutes, pour la
   * fumée ; les flammes des blocs, pour le feu), de la plus lointaine à la plus proche.
   */
  private drawSorted(layer: SpriteLayer, list: Particle[], eye: Vec3, transient: Particle[] | null): void {
    const order = this.order;
    order.length = 0;
    const n = list.length;
    const extra = transient ?? [];
    const total = n + extra.length;
    if (this.keys.length < total) this.keys = new Float32Array(total * 2);
    const keys = this.keys;
    for (let i = 0; i < total; i++) {
      const p = i < n ? list[i] : extra[i - n];
      if (i < n && p.solid) continue;
      const dx = p.x - eye.x, dy = p.y - eye.y, dz = p.z - eye.z;
      keys[i] = dx * dx + dy * dy + dz * dz;
      order.push(i);
    }
    order.sort((a, b) => keys[b] - keys[a]);
    layer.begin();
    for (const i of order) {
      if (layer.full) break;
      const p = i < n ? list[i] : extra[i - n];
      if (i < n || p.kind === "fire") this.write(layer, p);
      else this.writeVolute(layer, p);
    }
    layer.end();
  }

  /** Une particule vivante en sprite. */
  private write(layer: SpriteLayer, p: Particle): void {
    const s = this.out;
    s.x = p.x; s.y = p.y; s.z = p.z;
    s.size = p.size1;
    if (p.long > 0) {
      const speed = Math.hypot(p.vx, p.vy, p.vz);
      const k = p.long / speed;
      s.ax = p.vx * k; s.ay = p.vy * k; s.az = p.vz * k;
    } else {
      s.ax = 0; s.ay = 0; s.az = 0;
    }
    s.angle = p.angle;
    s.frame = p.frame;
    const t = p.age / p.life;
    s.age = t;
    if (p.kind === "fire") {
      // Il refroidit : de sa chaleur de départ à rien, au bout de la part de sa vie où il brûle
      s.heat = p.heat * Math.max(0, 1 - t / p.burn);
      s.tint = p.billow ? 0 : FLAME_TINT;
      s.upright = p.billow ? 0 : 1;
      if (p.posed) {
        s.ax = p.lx; s.ay = p.ly; s.az = p.lz;
      } else if (!p.billow) {
        // Elle se couche à l'opposé de sa course : une flamme partie d'un robot qui roule file
        // avec lui (voir render/fx/fireFx.ts), rabattue vers l'arrière
        let hx = -p.vx * FLAME_LEAN, hz = -p.vz * FLAME_LEAN;
        const h = Math.hypot(hx, hz);
        if (h > FLAME_LEAN_MAX) { hx *= FLAME_LEAN_MAX / h; hz *= FLAME_LEAN_MAX / h; }
        const k = 1 / Math.hypot(hx, 1, hz);
        s.ax = hx * k; s.ay = k; s.az = hz * k;
      }
    } else {
      s.heat = 0;
      s.tint = 0;
      s.upright = 0;
    }
    s.ground = p.ground;
    s.shade = 1;
    s.seed = p.seed;
    s.r = p.r; s.g = p.g; s.b = p.b; s.a = p.a1;
    layer.put(s);
  }

  /** Une volute de l'image (voir `volute`). */
  private writeVolute(layer: SpriteLayer, p: Particle): void {
    const s = this.out;
    s.x = p.x; s.y = p.y; s.z = p.z;
    s.size = p.size1;
    s.ax = 0; s.ay = 0; s.az = 0;
    s.angle = p.angle;
    s.frame = p.frame;
    s.age = p.age;
    s.heat = 0;
    // (une volute n'a pas de teinte de feu : sa case dit sur quelle hauteur elle s'efface au sol)
    s.tint = p.groundFade;
    s.upright = 0;
    s.ground = p.ground;
    s.shade = p.heat;
    s.seed = p.seed;
    s.r = p.r; s.g = p.g; s.b = p.b; s.a = p.a1;
    layer.put(s);
  }

  dispose(): void {
    for (const layer of Object.values(this.layers)) layer.dispose();
    if (this.sprites) for (const layer of Object.values(this.sprites)) layer.dispose();
  }
}

/** Une particule en sphère (effets simples, éclats) : étirée le long de sa vitesse si elle file. */
function sphere(layer: InstanceLayer, p: Particle): void {
  if (p.long > 0) {
    writeStretched(layer, p, p.size1, p.long, Math.hypot(p.vx, p.vy, p.vz), p.a1);
    return;
  }
  layer.writeScaled(p.x, p.y, p.z, p.size1, p.size1, p.size1, p.r, p.g, p.b, p.a1);
}

/** Une particule étirée le long de sa vitesse : son axe z sur la vitesse, de longueur `length`. */
function writeStretched(layer: InstanceLayer, p: Particle, width: number, length: number, speed: number, a: number): void {
  const zx = p.vx / speed, zy = p.vy / speed, zz = p.vz / speed;
  // Un axe perpendiculaire à la vitesse, puis le troisième
  let xx = zz, xy = 0, xz = -zx;
  let n = Math.hypot(xx, xz);
  if (n < 1e-3) { xx = 1; xy = 0; xz = 0; n = 1; }
  xx /= n; xz /= n;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  layer.writeBasis(p.x, p.y, p.z, xx * width, xy * width, xz * width, yx * width, yy * width, yz * width, zx * length, zy * length, zz * length, p.r, p.g, p.b, a);
}
