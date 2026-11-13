import * as B from "../../babylon";
import { bindVeil, VEIL_UNIFORMS } from "../smokeVeil";
import { NOISE_SIZE, noiseTexture, PUFF_CELL, puffAtlas } from "./fxNoise";

/*
 * La matière des effets réalistes (volutes de fumée, flammes, boules de feu, flammes des moteurs) :
 * un shader à nous (`ShaderMaterial`), qui reçoit à chaque image la lumière de la scène (soleil,
 * ciel, sol), l'heure et les textures calculées au démarrage (render/fx/fxNoise.ts).
 *
 * Halo : la couche de halo (`GlowLayer`) dessine ces effets avec leur propre shader
 * (`_supportGlowLayer`), en lui disant qu'elle passe (`glowPass`) : le feu y rend sa lueur, la
 * fumée n'y est qu'un cache noir (elle masque le halo de ce qui est derrière elle).
 */

/** Valeurs de Babylon : `Constants.ALPHA_PREMULTIPLIED` (couleur déjà multipliée par son opacité). */
const ALPHA_PREMULTIPLIED = 7;

/** Les deux textures des effets, une fois par scène. */
interface FxTextures {
  atlas: B.RawTexture;
  noise: B.RawTexture;
}
const TEXTURES = new WeakMap<B.Scene, FxTextures>();

export function fxTextures(scene: B.Scene): FxTextures {
  let t = TEXTURES.get(scene);
  if (!t) {
    const atlas = B.RawTexture.CreateRGBATexture(puffAtlas(), PUFF_CELL * 2, PUFF_CELL * 2, scene, true, false, B.Texture.TRILINEAR_SAMPLINGMODE);
    atlas.name = "fx-puffs";
    atlas.wrapU = atlas.wrapV = B.Texture.CLAMP_ADDRESSMODE;
    const noise = B.RawTexture.CreateRGBATexture(noiseTexture(), NOISE_SIZE, NOISE_SIZE, scene, true, false, B.Texture.TRILINEAR_SAMPLINGMODE);
    noise.name = "fx-noise";
    noise.wrapU = noise.wrapV = B.Texture.WRAP_ADDRESSMODE;
    t = { atlas, noise };
    TEXTURES.set(scene, t);
  }
  return t;
}

/** La lumière de la scène, relue une fois par image (la scène de l'arène : un ciel et un soleil). */
interface Env {
  frame: number;
  sunDir: B.Vector3;
  sunColor: B.Color3;
  sky: B.Color3;
  ground: B.Color3;
  time: number;
}
const ENVS = new WeakMap<B.Scene, Env>();

function envOf(scene: B.Scene): Env {
  let env = ENVS.get(scene);
  if (!env) {
    env = { frame: -1, sunDir: new B.Vector3(0.4, 0.85, -0.3), sunColor: new B.Color3(1, 0.97, 0.9), sky: new B.Color3(0.55, 0.55, 0.55), ground: new B.Color3(0.18, 0.17, 0.15), time: 0 };
    ENVS.set(scene, env);
  }
  const frame = scene.getFrameId();
  if (env.frame === frame) return env;
  env.frame = frame;
  // (une horloge qui reste petite : la précision des flottants du GPU)
  env.time = (performance.now() / 1000) % 3600;
  for (const light of scene.lights) {
    if (light instanceof B.DirectionalLight) {
      // Vers le soleil : à l'opposé de ses rayons
      env.sunDir.copyFrom(light.direction).normalize().scaleInPlace(-1);
      env.sunColor.copyFrom(light.diffuse).scaleInPlace(light.isEnabled() ? light.intensity : 0);
    } else if (light instanceof B.HemisphericLight) {
      env.sky.copyFrom(light.diffuse).scaleInPlace(light.intensity);
      env.ground.copyFrom(light.groundColor).scaleInPlace(light.intensity);
    }
  }
  return env;
}

/**
 * Uniformes que reçoit toute matière d'effet ; ceux du voile des fumigènes (render/smokeVeil.ts)
 * servent aux shaders qui s'effacent derrière un nuage (`VEIL_GLSL`).
 */
const COMMON_UNIFORMS = ["view", "viewProjection", "world", "cameraPosition", "time", "sunDir", "sunColor", "skyLight", "groundLight", "glowPass", ...VEIL_UNIFORMS];

/**
 * Une matière d'effet : le shader `shader` (vertex et fragment, dans `ShaderStore`), ses
 * `defines`, ses uniformes en plus. Mélange prémultiplié (une couleur peut s'ajouter en partie à
 * ce qui est derrière : le cœur d'une flamme éclaire sans blanchir le décor), sans écriture de
 * profondeur, des deux côtés.
 */
export class FxMaterial extends B.ShaderMaterial {
  constructor(name: string, scene: B.Scene, shader: string, defines: string[], uniforms: string[] = []) {
    super(name, scene, { vertex: shader, fragment: shader }, {
      attributes: ["position", "normal"],
      uniforms: [...COMMON_UNIFORMS, ...uniforms],
      samplers: ["atlas", "noiseMap"],
      defines,
      needAlphaBlending: true,
    });
    const textures = fxTextures(scene);
    this.setTexture("atlas", textures.atlas);
    this.setTexture("noiseMap", textures.noise);
    this.setFloat("glowPass", 0);
    this.backFaceCulling = false;
    this.disableDepthWrite = true;
    this.alphaMode = ALPHA_PREMULTIPLIED;
    this.onBindObservable.add(() => {
      const effect = this.getEffect();
      if (!effect) return;
      const env = envOf(scene);
      effect.setFloat("time", env.time);
      effect.setVector3("sunDir", env.sunDir);
      effect.setColor3("sunColor", env.sunColor);
      effect.setColor3("skyLight", env.sky);
      effect.setColor3("groundLight", env.ground);
      bindVeil(effect, scene);
    });
  }

  /**
   * Un mesh en instances fines est toujours dessiné en instances : sans quoi la couche de halo,
   * qui vérifie la matière sans elles, lui faisait changer de shader deux fois par image (on
   * passait de ~8 à ~57 ms de rendu par image dans une bataille).
   */
  override isReady(...args: Parameters<B.ShaderMaterial["isReady"]>): boolean {
    const [mesh, useInstances, subMesh] = args;
    const thin = (mesh as B.Mesh | undefined)?.hasThinInstances === true;
    return super.isReady(mesh, useInstances || thin, subMesh);
  }

  /** La couche de halo nous dessine avec notre propre shader (voir `glowPass`). */
  override get _supportGlowLayer(): boolean {
    return true;
  }

  override set _glowModeEnabled(on: boolean) {
    this.setFloat("glowPass", on ? 1 : 0);
  }
}

/**
 * Morceaux de GLSL communs : la rampe de couleur du feu (du rouge sombre au blanc selon sa
 * température) et le brouillard de la scène (Babylon : `vFogInfos` = mode, début, fin, densité).
 */
export const FIRE_RAMP_GLSL = `
vec3 fireRamp(float t) {
  t = clamp(t, 0.0, 1.25);
  vec3 c = mix(vec3(0.22, 0.03, 0.01), vec3(0.92, 0.26, 0.04), smoothstep(0.0, 0.3, t));
  c = mix(c, vec3(1.0, 0.58, 0.14), smoothstep(0.3, 0.6, t));
  c = mix(c, vec3(1.0, 0.86, 0.5), smoothstep(0.6, 0.88, t));
  c = mix(c, vec3(1.0, 0.98, 0.92), smoothstep(0.88, 1.15, t));
  return c;
}
`;

export const FOG_GLSL = `
#ifdef FOG
uniform vec4 vFogInfos;
uniform vec3 vFogColor;
float fogAmount(float d) {
  float f = 1.0;
  if (vFogInfos.x == 1.0) f = exp(-d * vFogInfos.w);
  else if (vFogInfos.x == 2.0) f = exp(-(d * vFogInfos.w) * (d * vFogInfos.w));
  else if (vFogInfos.x == 3.0) f = (vFogInfos.z - d) / (vFogInfos.z - vFogInfos.y);
  return clamp(f, 0.0, 1.0);
}
vec3 applyFog(vec3 c, float d) { return mix(vFogColor, c, fogAmount(d)); }
#else
vec3 applyFog(vec3 c, float d) { return c; }
#endif
`;
