import * as B from "../../babylon";
import { FIRE_RAMP_GLSL, FOG_GLSL, FxMaterial } from "./fxMaterial";

/*
 * Flamme des moteurs (réacteur, propulseur, turboréacteur et sa postcombustion), en effets
 * réalistes : le même cône que les flammes simples (pointe vers -y, tuyère en +y, étiré selon la
 * poussée par WorldView), dessiné par un shader. Un bruit défile de la tuyère vers la pointe
 * (la flamme file), ses bords s'effacent (vus de biais, le cône n'a pas d'arête dure) et tremblent,
 * sa pointe se déchire ; le cœur est plus chaud près de la tuyère (bleuté pour un turboréacteur).
 * Les deux faces du cône sont dessinées : là où elles se recouvrent, au milieu, la flamme est plus
 * dense, comme un vrai jet.
 */

const FLAME_VERTEX = `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
#ifdef INSTANCES
attribute vec4 world0;
attribute vec4 world1;
attribute vec4 world2;
attribute vec4 world3;
#endif
uniform mat4 world;
uniform mat4 viewProjection;
varying vec3 vLocal;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vSeed;
varying float vDepth;
void main(void) {
#ifdef INSTANCES
  mat4 m = mat4(world0, world1, world2, world3);
#else
  mat4 m = world;
#endif
  vec4 wp = m * vec4(position, 1.0);
  // Normale sous une échelle non uniforme (largeur, longueur) : divisée par le carré de l'échelle
  vec3 s2 = vec3(dot(m[0].xyz, m[0].xyz), dot(m[1].xyz, m[1].xyz), dot(m[2].xyz, m[2].xyz));
  vNormal = normalize(mat3(m) * (normal / max(s2, vec3(0.000001))));
  vLocal = position;
  vWorld = wp.xyz;
  vSeed = fract(dot(m[3].xyz, vec3(0.731, 1.37, 2.113)));
  vec4 clip = viewProjection * wp;
  vDepth = clip.w;
  gl_Position = clip;
}
`;

const FLAME_FRAGMENT = `
precision highp float;
varying vec3 vLocal;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vSeed;
varying float vDepth;
uniform sampler2D noiseMap;
uniform vec3 cameraPosition;
uniform float time;
uniform float glowPass;
${FOG_GLSL}
${FIRE_RAMP_GLSL}
void main(void) {
  // De la tuyère (0) à la pointe (1)
  float along = clamp(0.5 - vLocal.y, 0.0, 1.0);
  float around = atan(vLocal.z, vLocal.x) / 6.2831853;
  vec3 view = normalize(cameraPosition - vWorld);
  float facing = abs(dot(normalize(vNormal), view));
  float n1 = texture2D(noiseMap, vec2(around * 2.0 + vSeed * 7.0, along * 1.1 - time * 4.5)).r;
  float n2 = texture2D(noiseMap, vec2(around * 4.0 - vSeed * 3.0, along * 2.3 - time * 8.0)).g;
  float turb = n1 * 0.6 + n2 * 0.4;
  // Bords doux qui tremblent, pointe déchirée
  float edge = smoothstep(0.12, 0.85 + (turb - 0.5) * 0.4, facing);
  float body = pow(1.0 - along, 0.7);
  float tip = 1.0 - smoothstep(0.35, 1.0, along + (turb - 0.5) * 0.7);
  float intensity = body * tip * edge * (0.35 + 1.0 * turb);
#ifdef JET
  // Turboréacteur : un cœur bleu-blanc près de la tuyère, coupé d'anneaux de choc, dans une enveloppe orange
  float core = smoothstep(0.6, 0.95, facing) * (1.0 - smoothstep(0.0, 0.45, along));
  float shock = 1.0 + 0.35 * smoothstep(0.55, 1.0, cos(along * 34.0 - 1.2)) * (1.0 - smoothstep(0.1, 0.5, along));
  intensity *= shock;
  vec3 col = mix(fireRamp(intensity * 0.72 + 0.05), vec3(0.72, 0.86, 1.0), core * 0.6);
#else
  vec3 col = fireRamp(intensity * 0.8 + (1.0 - along) * 0.12);
#endif
  float a = clamp(intensity * 1.15, 0.0, 1.0);
  if (a < 0.003) discard;
  col = applyFog(col, vDepth);
  if (glowPass > 0.5) {
    // (le halo ne vient que du cœur de la flamme, sans quoi il la blanchirait toute)
    gl_FragColor = vec4(col * a * 0.55 * smoothstep(0.3, 0.9, intensity), a);
    return;
  }
  gl_FragColor = vec4(col * a, a * 0.6);
}
`;

B.ShaderStore.ShadersStore["fxFlameVertexShader"] = FLAME_VERTEX;
B.ShaderStore.ShadersStore["fxFlameFragmentShader"] = FLAME_FRAGMENT;

/** La matière d'une flamme de moteur (`jet` : turboréacteur, au cœur bleuté). */
export function flameMaterial(scene: B.Scene, jet: boolean): FxMaterial {
  return new FxMaterial(jet ? "fx-flame-jet" : "fx-flame", scene, "fxFlame", jet ? ["JET"] : []);
}
