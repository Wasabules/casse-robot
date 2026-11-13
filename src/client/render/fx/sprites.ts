import * as B from "../../babylon";
import { VEIL_GLSL } from "../smokeVeil";
import { FIRE_RAMP_GLSL, FOG_GLSL, FxMaterial } from "./fxMaterial";

/*
 * Effets réalistes : des quadrilatères tournés vers la caméra (des « sprites »), en instances
 * fines (un appel au GPU par couche), orientés dans le shader de vertex (le `billboardMode` de
 * Babylon ne vaut pas par instance fine). Quatre allures :
 * - `smoke` : une volute de l'atlas (render/fx/fxNoise.ts), éclairée par le soleil d'après la
 *   normale de sa surface (côté soleil plus clair, dessous plus sombre, creux à l'ombre), qui
 *   tourne lentement, roule (sa texture se tord) et s'effiloche en vieillissant ;
 * - `vapor` : la même volute, presque de sa propre couleur (vapeur, condensation) ;
 * - `glow` : une lueur ronde au cœur blanc (étincelle, braise, éclair), étirée le long de sa course ;
 * - `fire` : une flamme qui monte (une langue qui ondule, d'un bruit qui défile, du blanc-jaune au
 *   rouge selon sa chaleur), ou une boule de feu (une volute incandescente qui refroidit en fumée).
 * Un ruban (`ribbon`) est un trait face à la caméra, au bord doux (traînées, sillages).
 *
 * Bords doux : une volute s'efface en approchant du sol sous elle (pas de coupure nette où elle
 * le traverse) et tout contre la caméra. Le brouillard de la scène les voile comme le décor.
 */

/**
 * Données d'une instance (20 nombres : la « matrice » et la couleur des instances fines, qui ne
 * sont pas ici une matrice). world0 : centre, diamètre ; world1 : étirement (vecteur de sa
 * longueur, nul pour un sprite rond ; d'une flamme droite, son haut et sa hauteur), angle dans le
 * plan de l'écran ; world2 : case de l'atlas,
 * âge relatif, chaleur, teinte du feu ; world3 : hauteur du sol, flamme droite, ombre, graine.
 */
const SPRITE_VERTEX = `
precision highp float;
attribute vec3 position;
attribute vec4 world0;
attribute vec4 world1;
attribute vec4 world2;
attribute vec4 world3;
attribute vec4 instanceColor;
uniform mat4 view;
uniform mat4 viewProjection;
uniform vec3 cameraPosition;
uniform float sizeScale;
uniform float lengthScale;
varying vec2 vUV;
varying vec4 vColor;
varying vec4 vData;
varying vec4 vExtra;
varying vec3 vWorld;
varying vec3 vRight;
varying vec3 vUp;
varying float vSize;
varying float vDepth;
void main(void) {
  vec3 center = world0.xyz;
  float size = world0.w * sizeScale;
  vec3 axis = world1.xyz;
  vec2 c = position.xy;
  vec3 camRight = vec3(view[0][0], view[1][0], view[2][0]);
  vec3 camUp = vec3(view[0][1], view[1][1], view[2][1]);
  vec3 toEye = cameraPosition - center;
  float dist = length(toEye);
  toEye = dist > 0.0001 ? toEye / dist : vec3(0.0, 1.0, 0.0);
  float len = length(axis);
  bool upright = world3.y > 0.5;
  vec3 r;
  vec3 u;
  float h = size;
  // Une flamme part de son point (sa base), le reste est centré
  float lift = 0.0;
  if (len > 0.0001 && !upright) {
    // Étiré le long de sa course : un ruban face à la caméra
    u = axis / len;
    r = cross(u, toEye);
    float rl = length(r);
    r = rl > 0.0001 ? r / rl : camRight;
    h = len * lengthScale;
  } else {
    // (une flamme a son haut : la verticale, ou couchée par le vent de sa course, et sa hauteur
    // en part de sa largeur, la longueur de son axe)
    vec3 up = upright && len > 0.0001 ? axis / len : vec3(0.0, 1.0, 0.0);
    vec3 pu = up - toEye * dot(up, toEye);
    float pl = length(pu);
    if (upright && pl > 0.25) {
      // Une flamme monte : son haut est sa direction vue par la caméra
      u = pu / pl;
      r = cross(u, toEye);
      lift = 0.42;
      if (len > 0.0001) h = size * len;
    } else {
      float s = sin(world1.w);
      float co = cos(world1.w);
      r = camRight * co + camUp * s;
      u = camUp * co - camRight * s;
    }
  }
  vec3 p = center + r * (c.x * size) + u * ((c.y + lift) * h);
  vUV = c + 0.5;
  vColor = instanceColor;
  vData = world2;
  vExtra = world3;
  vWorld = p;
  vRight = r;
  vUp = u;
  vSize = size;
  vec4 clip = viewProjection * vec4(p, 1.0);
  vDepth = clip.w;
  gl_Position = clip;
}
`;

const SPRITE_FRAGMENT = `
precision highp float;
varying vec2 vUV;
varying vec4 vColor;
varying vec4 vData;
varying vec4 vExtra;
varying vec3 vWorld;
varying vec3 vRight;
varying vec3 vUp;
varying float vSize;
varying float vDepth;
uniform sampler2D atlas;
uniform sampler2D noiseMap;
uniform vec3 cameraPosition;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform vec3 skyLight;
uniform vec3 groundLight;
uniform float time;
uniform float selfLight;
uniform float softness;
uniform float glowPass;
${FOG_GLSL}
${FIRE_RAMP_GLSL}
#ifdef VEIL
${VEIL_GLSL}
#endif
// Une volute de l'atlas (2 x 2 cases)
vec4 puff(vec2 uv, float frame) {
  // (la case arrive interpolée : 1,99999 sur un triangle du quadrilatère, 2 sur l'autre ; sans
  // l'arrondi, chaque moitié prenait une autre volute, coupée net le long de la diagonale)
  float f = floor(frame + 0.5);
  vec2 cell = vec2(mod(f, 2.0), floor(f * 0.5 + 0.25)) * 0.5;
  vec4 tex = texture2D(atlas, cell + clamp(uv, 0.004, 0.996) * 0.5);
  // Nulle au bord du quadrilatère, quoi que fasse la torsion (sinon son bord se verrait, en trait net)
  tex.a *= 1.0 - smoothstep(0.4, 0.5, length(vUV - 0.5));
  return tex;
}
// La lumière que reçoit la surface d'une volute : ciel, sol, soleil (adouci : la fumée diffuse),
// creux à l'ombre, et le soleil qui la traverse quand on le regarde à travers elle
vec3 shade(vec4 tex) {
  vec2 nxy = tex.rg * 2.0 - 1.0;
  float nz = sqrt(max(0.0, 1.0 - dot(nxy, nxy)));
  vec3 toEye = normalize(cameraPosition - vWorld);
  vec3 n = normalize(vRight * nxy.x + vUp * nxy.y + toEye * nz);
  float sun = clamp(dot(n, sunDir) * 0.5 + 0.5, 0.0, 1.0);
  float through = pow(clamp(dot(-toEye, sunDir), 0.0, 1.0), 6.0) * (1.0 - tex.a) * 0.7;
  vec3 ambient = mix(groundLight, skyLight, n.y * 0.5 + 0.5);
  float ao = tex.b;
  // (la fumée diffuse la lumière : son côté à l'ombre n'est pas noir)
  return (ambient * (0.6 + 0.4 * ao) + sunColor * ((0.22 + 0.78 * sun * sun) * mix(0.7, 1.0, ao) + through)) * vExtra.z;
}
// Fondu au ras du sol (sous la volute) et tout contre la caméra
float soft() {
  float fade = max(0.12, vSize * softness);
#if defined(SMOKE) || defined(VAPOR)
  // (une volute peut donner sa hauteur de fondu : celles d'un fumigène, posé au sol, ne s'y effacent
  // que sur quelques décimètres ; sur le tiers de leur taille, le bas du nuage laissait voir le sol)
  if (vData.w > 0.0) fade = vData.w;
#endif
  float ground = smoothstep(0.0, fade, vWorld.y - vExtra.x);
  // (et une grande volute plus proche que le tiers de sa taille s'efface : elle entoure la caméra,
  // tout l'écran à une profondeur presque nulle, et son bord y tracerait un trait)
  float near = smoothstep(0.12, 0.8, vDepth) * smoothstep(0.08, 0.35, vDepth / vSize);
  return ground * near;
}
void main(void) {
  vec3 col;
  float a;
  float add = 0.0;
  bool softened = false;
  float glowMask = 0.0;
#ifdef RIBBON
  // Un trait : un profil doux en travers, effiloché le long de sa course
  float x = vUV.x * 2.0 - 1.0;
  float prof = 1.0 - x * x;
  prof *= prof;
  float n = texture2D(noiseMap, vec2(dot(vWorld, vec3(0.11, 0.07, 0.13)) + x * 0.15, dot(vWorld, vec3(0.05, 0.13, 0.07)) - time * 0.02)).r;
  a = prof * clamp(0.45 + 0.9 * n, 0.0, 1.0) * vColor.a;
#ifdef GLOW
  col = mix(vColor.rgb, vec3(1.0), prof * prof * 0.4);
  add = 0.35;
  glowMask = 1.0;
#else
  vec3 light = mix(skyLight + sunColor * 0.55, vec3(1.0), selfLight);
  col = vColor.rgb * light;
#endif
#else
#ifdef GLOW
  // Une lueur : un cœur presque blanc dans un halo de sa couleur
  vec2 p = vUV * 2.0 - 1.0;
  float r2 = dot(p, p);
  float core = exp(-r2 * 7.0);
  float halo = exp(-r2 * 2.6) * (1.0 - smoothstep(0.6, 1.0, r2));
  a = clamp(core + halo * 0.5, 0.0, 1.0) * vColor.a;
  col = mix(vColor.rgb, vec3(1.0, 0.98, 0.92), core * 0.55);
  add = 0.35;
  glowMask = 1.0;
#endif
#if defined(SMOKE) || defined(VAPOR)
  // Une volute : elle roule (sa texture se tord), puis s'effiloche en vieillissant
  float frame = vData.x;
  float age = vData.y;
  vec2 wob = texture2D(noiseMap, vUV * 0.45 + vec2(vExtra.w * 3.1, time * 0.03 + vExtra.w)).rg - 0.5;
  vec4 tex = puff(vUV + wob * (0.06 + 0.08 * age), frame);
  float erode = age * age * 0.55;
  a = clamp((tex.a - erode) / max(0.05, 1.0 - erode), 0.0, 1.0) * vColor.a * soft();
  softened = true;
  // (rien à éclairer là où la volute est transparente : la plupart des pixels d'un sprite)
  if (a < 0.002) discard;
  col = vColor.rgb * mix(shade(tex), vec3(1.0), selfLight);
#endif
#ifdef FIRE
  float heat = vData.z;
  float seed = vExtra.w;
  // (les textures sont lues avant de choisir entre flamme et boule de feu : WebGPU refuse une
  // lecture filtrée dans une branche qui dépend de l'instance : textureSample en WGSL)
  vec2 q = vUV;
  float n1 = texture2D(noiseMap, vec2(q.x * 0.8 + seed * 5.0, q.y * 0.7 - time * 1.6 + seed * 3.0)).r;
  float n2 = texture2D(noiseMap, vec2(q.x * 1.9 - seed * 7.0, q.y * 1.6 - time * 2.9)).g;
  vec2 wob = texture2D(noiseMap, vUV * 0.5 + vec2(seed * 3.7, time * 0.06)).rg - 0.5;
  vec4 tex = puff(vUV + wob * 0.1, vData.x);
  float n = texture2D(noiseMap, vUV * 1.2 + vec2(seed * 5.3, -time * 0.4)).b;
  if (vExtra.y > 0.5) {
    // Une flamme : une langue qui ondule en montant, plus chaude en bas et au cœur
    float turb = n1 * 0.62 + n2 * 0.38;
    float y = q.y;
    // Elle ondule de plus en plus vers le haut
    float x = abs(q.x - 0.5 + (n1 - 0.5) * 0.45 * y + (n2 - 0.5) * 0.18 * y);
    // Une goutte : un pied arrondi, une pointe effilée
    float width = 0.38 * pow(clamp(1.0 - y, 0.0, 1.0), 0.7) * smoothstep(-0.1, 0.22, y);
    float body = 1.0 - smoothstep(width * 0.2, max(width, 0.001), x);
    float top = 1.0 - smoothstep(0.5, 1.0, y + (turb - 0.5) * 0.6);
    float shape = body * top;
    // Le cœur (bas et milieu de la langue) est le plus chaud
    // (au plus froid, un rouge sombre : presque noire, la flamme se tachait de pâtés sombres)
    float temp = max(0.16, shape * (0.5 + 0.65 * heat) + (turb - 0.5) * 0.25 - y * 0.22);
    vec3 tint = vColor.rgb / max(0.001, max(vColor.r, max(vColor.g, vColor.b)));
    col = fireRamp(temp) * mix(vec3(1.0), tint, vData.w);
    // Un bord net et opaque (une flamme translucide virerait au rose sur un fond clair) : en
    // s'éteignant, elle se réduit à son cœur plutôt que de pâlir ; seul le cœur s'ajoute en
    // partie à ce qui est derrière
    float fading = (1.0 - vColor.a) * 0.6;
    a = smoothstep(0.08 + fading, 0.26 + fading, shape * (0.6 + 0.6 * turb)) * min(1.0, vColor.a * 2.5);
    add = 0.55 * smoothstep(0.45, 0.95, temp);
    // (le halo ne vient que du cœur : autour de toute la flamme, il la blanchirait)
    glowMask = 0.6 * smoothstep(0.45, 1.0, temp);
  } else {
    // Une boule de feu : une volute incandescente qui roule, puis refroidit en fumée (la couleur
    // de l'instance est celle de cette fumée)
    float age = vData.y;
    float temp = heat * (0.5 + 0.7 * tex.b * tex.a + (n - 0.5) * 0.7);
    float burning = smoothstep(0.1, 0.32, temp);
    vec3 smoke = vColor.rgb * shade(tex);
    col = mix(smoke, fireRamp(temp), burning);
    float erode = age * age * 0.5;
    a = clamp((tex.a - erode) / max(0.05, 1.0 - erode), 0.0, 1.0) * vColor.a;
    add = 0.35 * burning;
    glowMask = 0.6 * burning * smoothstep(0.35, 0.9, temp);
  }
#endif
#endif
  if (!softened) a *= soft();
#ifdef VEIL
  // Derrière un fumigène (ou dedans), elle s'efface : la fumée, dessinée avant, ne la couvre pas
  a *= smokeVeil(cameraPosition, vWorld);
#endif
  if (a < 0.002) discard;
  col = applyFog(col, vDepth);
  if (glowPass > 0.5) {
    // Dans le halo : la lueur du feu, et la fumée qui cache ce qui est derrière elle
    gl_FragColor = vec4(col * a * glowMask, a);
    return;
  }
  gl_FragColor = vec4(col * a, a * (1.0 - add));
}
`;

B.ShaderStore.ShadersStore["fxSpriteVertexShader"] = SPRITE_VERTEX;
B.ShaderStore.ShadersStore["fxSpriteFragmentShader"] = SPRITE_FRAGMENT;

/** Allure d'une couche de sprites (voir plus haut). */
export type SpriteLook = "smoke" | "vapor" | "glow" | "fire";

/** Une instance à écrire : on remplit un objet réutilisé, puis `put`. */
export interface Sprite {
  x: number;
  y: number;
  z: number;
  /** Diamètre (m) ; d'un sprite étiré, sa largeur. */
  size: number;
  /**
   * Étirement : le vecteur de sa longueur (étincelle, trait), ou nul. D'une flamme droite
   * (`upright`) : son haut (nul : la verticale), de la longueur de sa hauteur en part de sa largeur.
   */
  ax: number;
  ay: number;
  az: number;
  /** Rotation dans le plan de l'écran (rad). */
  angle: number;
  /** Case de l'atlas (0 à 3). */
  frame: number;
  /** Âge relatif (0 à 1) : une volute s'effiloche en vieillissant. */
  age: number;
  /** Chaleur d'un feu (0 à 1). */
  heat: number;
  /**
   * Part de sa propre couleur dans une flamme (0 : la rampe du feu seule). D'une volute (fumée,
   * vapeur) : la hauteur (m) sur laquelle elle s'efface au ras du sol (0 : la part `softness` de sa taille).
   */
  tint: number;
  /** Hauteur du sol sous lui (il s'efface en l'approchant). */
  ground: number;
  /** Flamme droite (1) ou sprite qui tourne (0). */
  upright: number;
  /** Lumière reçue (1 ; moins : à l'ombre, au cœur d'un nuage). */
  shade: number;
  /** Graine (0 à 1) : chaque sprite a son bruit. */
  seed: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

export function sprite(): Sprite {
  return { x: 0, y: 0, z: 0, size: 1, ax: 0, ay: 0, az: 0, angle: 0, frame: 0, age: 0, heat: 0, tint: 0, ground: -1e6, upright: 0, shade: 1, seed: 0, r: 1, g: 1, b: 1, a: 1 };
}

export interface SpriteLayerOptions {
  look: SpriteLook;
  /** Des traits (rubans), et non des sprites ronds. */
  ribbon?: boolean;
  /** Instances au plus. */
  capacity: number;
  /** Agrandissement du quadrilatère par rapport au diamètre donné (la volute ne le remplit pas). */
  sizeScale: number;
  /** Agrandissement de la longueur d'un sprite étiré. */
  lengthScale?: number;
  /** Part de sa propre couleur (1 : pas éclairée par la scène). */
  selfLight?: number;
  /** Fondu au ras du sol, en part de son diamètre. */
  softness?: number;
  /** Ordre de dessin entre couches transparentes (plus petit : avant). */
  alphaIndex: number;
  /**
   * Elle s'efface derrière les fumigènes (render/smokeVeil.ts) : une couche dessinée après la fumée,
   * que les nuages ne couvrent donc pas (vapeur, feu, lueurs).
   */
  veiled?: boolean;
}

/**
 * Une couche de sprites : un quadrilatère en instances fines, rempli à chaque image (`begin`,
 * `put`…, `end` ; seules les instances écrites partent au GPU), comme `InstanceLayer`.
 */
export class SpriteLayer {
  readonly mesh: B.Mesh;
  readonly capacity: number;
  private readonly data: Float32Array;
  private readonly colors: Float32Array;
  private count = 0;
  private uploaded = false;

  constructor(scene: B.Scene, name: string, options: SpriteLayerOptions) {
    this.capacity = options.capacity;
    const mesh = B.MeshBuilder.CreatePlane(name, { size: 1 }, scene);
    const defines = [options.look.toUpperCase(), ...(options.ribbon ? ["RIBBON"] : []), ...(options.veiled ? ["VEIL"] : [])];
    const mat = new FxMaterial(name, scene, "fxSprite", defines, ["sizeScale", "lengthScale", "selfLight", "softness"]);
    mat.setFloat("sizeScale", options.sizeScale);
    mat.setFloat("lengthScale", options.lengthScale ?? 1);
    mat.setFloat("selfLight", options.selfLight ?? 0);
    mat.setFloat("softness", options.softness ?? 0.3);
    mesh.material = mat;
    mesh.alphaIndex = options.alphaIndex;
    mesh.isPickable = false;
    mesh.receiveShadows = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = true;
    this.data = new Float32Array(options.capacity * 16);
    this.colors = new Float32Array(options.capacity * 4);
    mesh.thinInstanceSetBuffer("matrix", this.data, 16, false);
    mesh.thinInstanceSetBuffer("color", this.colors, 4, false);
    mesh.thinInstanceCount = 0;
    mesh.setEnabled(false);
    this.mesh = mesh;
  }

  begin(): void {
    this.count = 0;
  }

  get full(): boolean {
    return this.count >= this.capacity;
  }

  put(s: Sprite): void {
    if (this.count >= this.capacity) return;
    const d = this.data;
    const o = this.count * 16;
    d[o] = s.x; d[o + 1] = s.y; d[o + 2] = s.z; d[o + 3] = s.size;
    d[o + 4] = s.ax; d[o + 5] = s.ay; d[o + 6] = s.az; d[o + 7] = s.angle;
    d[o + 8] = s.frame; d[o + 9] = s.age; d[o + 10] = s.heat; d[o + 11] = s.tint;
    d[o + 12] = s.ground; d[o + 13] = s.upright; d[o + 14] = s.shade; d[o + 15] = s.seed;
    const c = this.colors;
    const k = this.count * 4;
    c[k] = s.r; c[k + 1] = s.g; c[k + 2] = s.b; c[k + 3] = s.a;
    this.count++;
  }

  end(): void {
    const mesh = this.mesh;
    if (this.count > 0) {
      if (this.uploaded) {
        mesh.thinInstancePartialBufferUpdate("matrix", this.count, 0);
        mesh.thinInstancePartialBufferUpdate("color", this.count, 0);
      } else {
        mesh.thinInstanceBufferUpdated("matrix");
        mesh.thinInstanceBufferUpdated("color");
        this.uploaded = true;
      }
    }
    mesh.thinInstanceCount = this.count;
    if (mesh.isEnabled() !== this.count > 0) mesh.setEnabled(this.count > 0);
  }

  dispose(): void {
    this.mesh.material?.dispose();
    this.mesh.dispose();
  }
}
