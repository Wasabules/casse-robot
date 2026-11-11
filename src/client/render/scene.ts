import * as B from "../babylon";
import { GROUND_HALF, type ArenaLayout } from "../../shared/arena/layout";
import type { ShadowQuality } from "../settings";
import { context2d } from "./materials";

/** Qualités des ombres : taille de la carte d'ombre (px) et filtrage de leurs bords (PCF). */
export const SHADOW_MAPS: Record<ShadowQuality, { size: number; filtering: number }> = {
  low: { size: 1024, filtering: B.ShadowGenerator.QUALITY_LOW },
  medium: { size: 2048, filtering: B.ShadowGenerator.QUALITY_MEDIUM },
  high: { size: 4096, filtering: B.ShadowGenerator.QUALITY_HIGH },
};

export interface SceneKit {
  engine: B.Engine;
  scene: B.Scene;
  shadows: B.ShadowGenerator;
  /** Le soleil, ou la lune la nuit (`applyArenaLook`). */
  sun: B.DirectionalLight;
  hemi: B.HemisphericLight;
  /** Le ciel étoilé et la lune (la nuit seulement), fait à la première nuit. */
  night: B.Mesh | null;
}

/** Ciel et brouillard par défaut (les petites arènes). */
const SKY = "#c7d1d6";
const FOG = 0.009;

/**
 * Éclairage du jour et de la nuit : ciel (lumière qui vient d'en haut, et d'en bas, renvoyée par le
 * sol), soleil ou lune (direction, force, couleur), lumière ambiante. La nuit, une lune bleutée
 * haute dans le ciel et une faible lumière du ciel : on voit les robots et le relief, sans couleurs ;
 * ce sont les lampes, les tirs, les flammes et les phares qui éclairent (render/nightLights.ts).
 */
const DAY = {
  hemi: { intensity: 0.55, sky: "#ffffff", ground: "#524d47" },
  sun: { dir: [-0.45, -1, 0.32], intensity: 1.05, color: "#fff7e6" },
  ambient: "#40454d",
} as const;
const NIGHT = {
  hemi: { intensity: 0.22, sky: "#8293c2", ground: "#1c1d22" },
  sun: { dir: [-0.45, -0.55, 0.7], intensity: 0.28, color: "#a8bcff" },
  ambient: "#0f1117",
} as const;
/** Le ciel de nuit : son rayon (m, sous la portée de la caméra), le zénith (l'horizon est la couleur du brouillard). */
const DOME_RADIUS = 600;
const ZENITH = "#04060c";

const DOME_VERTEX = `
precision highp float;
attribute vec3 position;
uniform mat4 worldViewProjection;
varying vec3 vDir;
void main(void) {
  vDir = position;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}
`;

/**
 * Le ciel de nuit, d'après la direction regardée : du brouillard à l'horizon au bleu presque noir du
 * zénith, des étoiles (une par case d'une grille sur la sphère, au hasard : elles scintillent un
 * peu), une voie lactée pâle, la lune (un disque piqueté, un halo) là d'où vient sa lumière.
 */
const DOME_FRAGMENT = `
precision highp float;
varying vec3 vDir;
uniform vec3 horizon;
uniform vec3 zenith;
uniform vec3 moon;
uniform float time;
float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
void main(void) {
  vec3 d = normalize(vDir);
  float up = max(d.y, 0.0);
  vec3 col = mix(horizon, zenith, smoothstep(-0.02, 0.55, d.y));
  // Étoiles : une case sur quelques centaines en a une, plus vive au cœur de sa case
  vec3 p = d * 140.0;
  vec3 cell = floor(p);
  float h = hash(cell);
  if (h > 0.985) {
    vec3 c = cell + 0.5 + (vec3(hash(cell + 3.1), hash(cell + 7.7), hash(cell + 11.3)) - 0.5) * 0.6;
    float r = length(p - c);
    float twinkle = 0.75 + 0.25 * sin(time * (1.5 + h * 40.0) + h * 300.0);
    float star = smoothstep(0.32, 0.0, r) * (h - 0.985) / 0.015 * twinkle;
    col += vec3(0.85, 0.9, 1.0) * star * smoothstep(0.02, 0.25, d.y) * 1.4;
  }
  // Une voie lactée pâle, en écharpe
  float band = exp(-pow(dot(d, normalize(vec3(0.55, 0.35, -0.75))) * 5.0, 2.0));
  col += vec3(0.09, 0.1, 0.14) * band * smoothstep(0.0, 0.4, d.y) * (0.6 + 0.4 * hash(floor(d * 60.0)));
  // La lune : un disque piqueté de mers sombres, un halo autour
  float m = dot(d, moon);
  float disc = smoothstep(0.99955, 0.9997, m);
  float seas = 0.82 + 0.18 * hash(floor((d - moon) * 900.0));
  col = mix(col, vec3(0.93, 0.95, 1.0) * seas, disc);
  col += vec3(0.25, 0.3, 0.45) * pow(max(m, 0.0), 180.0) + vec3(0.06, 0.07, 0.1) * pow(max(m, 0.0), 12.0);
  gl_FragColor = vec4(col, 1.0);
}
`;
/**
 * Ombres en cascades (WebGL 2) : plusieurs cartes d'ombre le long du champ de la caméra, fines de
 * près, larges au loin. Une arène plus grande que WIDE_ARENA (demi-côté, m) a des ombres jusqu'à
 * WIDE_SHADOWS m de la caméra, sur trois cascades ; une petite, jusqu'à SMALL_SHADOWS m, sur deux
 * (son décor tient dans ce champ). Une seule carte cadrée sur toute la Vallée serait floue ;
 * cadrée autour du robot, elle laissait sans ombre tout ce qu'on voyait au loin.
 */
const WIDE_ARENA = 50;
const WIDE_SHADOWS = 240;
const SMALL_SHADOWS = 110;
/** Part de chaque cascade fondue dans la suivante : pas de marche visible entre deux cascades. */
const CASCADE_BLEND = 0.08;

/** Moteur, scène, lumières, ombres et sol. */
export function createScene(canvas: HTMLCanvasElement): SceneKit {
  const engine = new B.Engine(canvas, true, { stencil: false, preserveDrawingBuffer: false }, true);
  const scene = new B.Scene(engine);
  scene.useRightHandedSystem = true; // même repère que Rapier
  scene.fogMode = B.Scene.FOGMODE_EXP2;
  setSky(scene, SKY, FOG);

  const hemi = new B.HemisphericLight("hemi", new B.Vector3(0.2, 1, -0.1), scene);
  const sun = new B.DirectionalLight("sun", new B.Vector3(-0.45, -1, 0.32).normalize(), scene);
  // (sa position, pour la carte d'ombre unique sans WebGL 2 : loin dans l'axe de ses rayons, pour que toute la Vallée tienne dans sa profondeur)
  setDaylight(scene, hemi, sun, false);
  sun.shadowMinZ = 1;
  sun.shadowMaxZ = 600;
  // Sans WebGL 2, une seule carte d'ombre, que Babylon cadre sur tout ce qui en projette
  const cascades = B.CascadedShadowGenerator.IsSupported;
  const shadows = cascades ? new B.CascadedShadowGenerator(SHADOW_MAPS.medium.size, sun) : new B.ShadowGenerator(SHADOW_MAPS.medium.size, sun);
  if (shadows instanceof B.CascadedShadowGenerator) {
    shadows.lambda = 0.85;
    shadows.cascadeBlendPercentage = CASCADE_BLEND;
    shadows.depthClamp = true;
    shadows.stabilizeCascades = true;
  }
  shadows.usePercentageCloserFiltering = true;
  shadows.filteringQuality = SHADOW_MAPS.medium.filtering;
  shadows.bias = 0.0015;
  shadows.normalBias = 0.02;

  createGround(scene);
  return { engine, scene, shadows, sun, hemi, night: null };
}

/** Lumière du ciel, soleil (ou lune) et lumière ambiante, de jour ou de nuit. */
function setDaylight(scene: B.Scene, hemi: B.HemisphericLight, sun: B.DirectionalLight, night: boolean): void {
  const look = night ? NIGHT : DAY;
  hemi.intensity = look.hemi.intensity;
  hemi.diffuse = B.Color3.FromHexString(look.hemi.sky);
  hemi.groundColor = B.Color3.FromHexString(look.hemi.ground);
  sun.direction = new B.Vector3(look.sun.dir[0], look.sun.dir[1], look.sun.dir[2]).normalize();
  sun.intensity = look.sun.intensity;
  sun.diffuse = B.Color3.FromHexString(look.sun.color);
  // Carte d'ombre unique (sans WebGL 2) : la lumière loin dans l'axe de ses rayons
  sun.position = sun.direction.scale(-250);
  scene.ambientColor = B.Color3.FromHexString(look.ambient);
}

/** Le ciel de nuit (un dôme qui suit la caméra, sans brouillard ni ombre), fait une fois. */
function nightDome(kit: SceneKit): B.Mesh {
  if (kit.night) return kit.night;
  B.ShaderStore.ShadersStore["nightSkyVertexShader"] = DOME_VERTEX;
  B.ShaderStore.ShadersStore["nightSkyFragmentShader"] = DOME_FRAGMENT;
  const mat = new B.ShaderMaterial("night-sky", kit.scene, "nightSky", { attributes: ["position"], uniforms: ["worldViewProjection", "horizon", "zenith", "moon", "time"] });
  mat.backFaceCulling = false;
  mat.onBindObservable.add(() => mat.getEffect()?.setFloat("time", performance.now() / 1000));
  const dome = B.MeshBuilder.CreateSphere("night-sky", { diameter: DOME_RADIUS * 2, segments: 24 }, kit.scene);
  dome.material = mat;
  dome.infiniteDistance = true;
  dome.isPickable = false;
  dome.applyFog = false;
  dome.receiveShadows = false;
  dome.alwaysSelectAsActiveMesh = true;
  kit.night = dome;
  return dome;
}

function setSky(scene: B.Scene, color: string, fog: number): void {
  const sky = B.Color3.FromHexString(color);
  scene.clearColor = new B.Color4(sky.r, sky.g, sky.b, 1);
  scene.fogColor = sky;
  scene.fogDensity = fog;
}

/** Ciel, brouillard, jour ou nuit, et portée des ombres d'une arène (voir WIDE_SHADOWS). */
export function applyArenaLook(kit: SceneKit, layout: ArenaLayout): void {
  const color = layout.sky?.color ?? SKY;
  setSky(kit.scene, color, layout.sky?.fog ?? FOG);
  const night = !!layout.sky?.night;
  setDaylight(kit.scene, kit.hemi, kit.sun, night);
  if (night) {
    const dome = nightDome(kit);
    const mat = dome.material as B.ShaderMaterial;
    mat.setColor3("horizon", B.Color3.FromHexString(color));
    mat.setColor3("zenith", B.Color3.FromHexString(ZENITH));
    // La lune est là d'où vient sa lumière
    mat.setVector3("moon", kit.sun.direction.scale(-1).normalize());
  }
  kit.night?.setEnabled(night);
  const shadows = kit.shadows;
  if (!(shadows instanceof B.CascadedShadowGenerator)) return;
  const wide = layout.bounds.half > WIDE_ARENA;
  shadows.numCascades = wide ? 3 : 2;
  shadows.shadowMaxZ = wide ? WIDE_SHADOWS : SMALL_SHADOWS;
}

/** Sol quadrillé : une case mineure = un bloc (0,5 m), une case majeure = 4 m. */
export function createGround(scene: B.Scene): void {
  const size = GROUND_HALF * 2;
  const ground = B.MeshBuilder.CreateGround("ground", { width: size, height: size }, scene);
  const t = new B.DynamicTexture("t-ground", { width: 512, height: 512 }, scene, true);
  const c = context2d(t);
  c.fillStyle = "#bcc6cb";
  c.fillRect(0, 0, 512, 512);
  c.strokeStyle = "#8f9ca4";
  c.lineWidth = 4;
  for (let i = 0; i <= 512; i += 64) {
    c.beginPath(); c.moveTo(i, 0); c.lineTo(i, 512); c.stroke();
    c.beginPath(); c.moveTo(0, i); c.lineTo(512, i); c.stroke();
  }
  c.strokeStyle = "#86959e";
  c.lineWidth = 7;
  c.strokeRect(0, 0, 512, 512);
  t.update();
  t.uScale = t.vScale = size / 4; // une texture = 4 m
  t.anisotropicFilteringLevel = 8;
  const mat = new B.StandardMaterial("groundMat", scene);
  mat.diffuseTexture = t;
  mat.specularColor = new B.Color3(0, 0, 0);
  ground.material = mat;
  ground.receiveShadows = true;
}
