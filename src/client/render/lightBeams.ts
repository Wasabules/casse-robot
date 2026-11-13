import * as B from "../babylon";
import type { LightRequest } from "./lightChoice";
import { FOG_GLSL, FxMaterial } from "./fx/fxMaterial";
import { VEIL_GLSL } from "./smokeVeil";

/*
 * Cônes de lumière, la nuit : sous un lampadaire, devant les projecteurs d'un mât d'éclairage,
 * devant le phare d'un robot, l'air éclairé se voit (un peu de brume, de poussière). Un cône ouvert
 * par source qui en demande un (`LightRequest.beam` : sa longueur visible), en instances d'un cône de
 * sa couleur, posé à chaque image d'après la lumière elle-même (render/lightSources.ts) : il suit
 * le robot, s'éteint avec sa lampe. Son shader l'ajoute à ce qui est derrière, plus dense au cœur
 * du cône (là où on le regarde à travers le plus d'air), de moins en moins loin de la lampe,
 * effacé par le brouillard et tout contre la caméra (quand on est dedans) ; un bruit lent le
 * fait onduler comme une brume.
 */

const BEAM_VERTEX = `
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
varying float vDepth;
void main(void) {
#ifdef INSTANCES
  mat4 m = mat4(world0, world1, world2, world3);
#else
  mat4 m = world;
#endif
  vec4 wp = m * vec4(position, 1.0);
  vec3 s2 = vec3(dot(m[0].xyz, m[0].xyz), dot(m[1].xyz, m[1].xyz), dot(m[2].xyz, m[2].xyz));
  vNormal = normalize(mat3(m) * (normal / max(s2, vec3(0.000001))));
  vLocal = position;
  vWorld = wp.xyz;
  vec4 clip = viewProjection * wp;
  vDepth = clip.w;
  gl_Position = clip;
}
`;

const BEAM_FRAGMENT = `
precision highp float;
varying vec3 vLocal;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vDepth;
uniform sampler2D noiseMap;
uniform vec3 cameraPosition;
uniform float time;
uniform float glowPass;
uniform vec3 beamColor;
uniform float strength;
${FOG_GLSL}
${VEIL_GLSL}
void main(void) {
  // (rien dans le halo : le cône ne brille pas, il ne cache rien non plus)
  if (glowPass > 0.5) discard;
  // De la lampe (0) au bout du cône (1)
  float along = clamp(vLocal.y, 0.0, 1.0);
  vec3 view = normalize(cameraPosition - vWorld);
  float facing = abs(dot(normalize(vNormal), view));
  float a = strength * pow(facing, 1.5) * pow(1.0 - along, 1.5) * smoothstep(0.0, 0.08, along);
  // Une brume qui ondule lentement
  float n = texture2D(noiseMap, vec2(vWorld.x * 0.11 + vWorld.z * 0.07 + time * 0.015, vWorld.y * 0.13 - time * 0.02)).r;
  a *= 0.7 + 0.6 * n;
  // Effacé tout contre la caméra (de dedans, il voilerait tout l'écran) et par le brouillard
  a *= smoothstep(0.5, 4.0, vDepth);
#ifdef FOG
  a *= fogAmount(vDepth);
#endif
  // (et derrière un fumigène : dessiné après la fumée, il ne s'y voit pas au travers, render/smokeVeil.ts)
  a *= smokeVeil(cameraPosition, vWorld);
  if (a < 0.002) discard;
  // Prémultiplié, d'opacité nulle : il s'ajoute à ce qui est derrière
  gl_FragColor = vec4(beamColor * a, 0.0);
}
`;

/** Au plus tant de cônes à la fois, les plus proches de la caméra. */
const MAX_BEAMS = 40;
/** Force d'un cône (la part de sa couleur qu'il ajoute, au plus épais). */
const STRENGTH = 0.16;
/** Un cône un peu plus étroit que la lumière : le cœur de son faisceau. */
const CORE = 0.75;

/** Une couleur arrondie (la clé de la source de son cône : peu de couleurs, peu de sources). */
const hexOf = (r: LightRequest): string => {
  const q = (v: number): string => Math.round(Math.max(0, Math.min(1, v)) * 15).toString(16);
  return `#${q(r.r)}${q(r.g)}${q(r.b)}`;
};

export class LightBeams {
  private readonly scene: B.Scene;
  private readonly sources = new Map<string, B.Mesh>();
  private readonly beams = new Map<unknown, { mesh: B.InstancedMesh; hex: string }>();
  private readonly seen = new Set<unknown>();

  constructor(scene: B.Scene) {
    this.scene = scene;
    B.ShaderStore.ShadersStore["fxBeamVertexShader"] = BEAM_VERTEX;
    B.ShaderStore.ShadersStore["fxBeamFragmentShader"] = BEAM_FRAGMENT;
  }

  /** Pose les cônes des lumières qui en demandent un (`beam`), la nuit ; sinon, plus aucun. */
  update(requests: readonly LightRequest[], night: boolean, eye: { x: number; y: number; z: number }): void {
    const seen = this.seen;
    seen.clear();
    if (night) {
      const lit = requests.filter((r) => r.beam && r.dir);
      if (lit.length > MAX_BEAMS) {
        const d = (r: LightRequest): number => (r.x - eye.x) ** 2 + (r.y - eye.y) ** 2 + (r.z - eye.z) ** 2;
        lit.sort((a, b) => d(a) - d(b));
        lit.length = MAX_BEAMS;
      }
      for (const r of lit) {
        seen.add(r.key);
        this.place(r);
      }
    }
    for (const [key, beam] of this.beams) {
      if (seen.has(key)) continue;
      beam.mesh.dispose();
      this.beams.delete(key);
    }
  }

  dispose(): void {
    for (const beam of this.beams.values()) beam.mesh.dispose();
    this.beams.clear();
    for (const source of this.sources.values()) {
      source.material?.dispose();
      source.dispose();
    }
    this.sources.clear();
  }

  private place(r: LightRequest): void {
    const hex = hexOf(r);
    let beam = this.beams.get(r.key);
    if (beam && beam.hex !== hex) {
      beam.mesh.dispose();
      beam = undefined;
    }
    if (!beam) {
      const mesh = this.source(hex).createInstance("beam");
      mesh.rotationQuaternion = new B.Quaternion();
      mesh.isPickable = false;
      beam = { mesh, hex };
      this.beams.set(r.key, beam);
    }
    const dir = r.dir!;
    const length = r.beam!;
    const radius = length * Math.tan((r.angle ?? 1) / 2) * CORE;
    const mesh = beam.mesh;
    mesh.position.set(r.x, r.y, r.z);
    // Son +y (de la lampe au bout du cône) le long de la lumière
    const to = new B.Vector3(dir.x, dir.y, dir.z);
    B.Quaternion.FromUnitVectorsToRef(B.Vector3.UpReadOnly, to, mesh.rotationQuaternion!);
    mesh.scaling.set(radius, length, radius);
  }

  /** Le cône d'une couleur : de la pointe (0, 0, 0) à sa base, d'un rayon de 1, en (0, 1, 0), ouvert. */
  private source(hex: string): B.Mesh {
    let mesh = this.sources.get(hex);
    if (mesh) return mesh;
    mesh = B.MeshBuilder.CreateCylinder(`src-beam-${hex}`, { height: 1, diameterTop: 2, diameterBottom: 0, tessellation: 24, cap: 0 }, this.scene);
    mesh.position.y = 0.5;
    mesh.bakeCurrentTransformIntoVertices();
    const mat = new FxMaterial(`beam-${hex}`, this.scene, "fxBeam", [], ["beamColor", "strength"]);
    mat.setColor3("beamColor", B.Color3.FromHexString(`#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`));
    mat.setFloat("strength", STRENGTH);
    mesh.material = mat;
    mesh.isVisible = false;
    mesh.isPickable = false;
    // (après les volutes de fumée et les flammes : il éclaire l'air devant elles)
    mesh.alphaIndex = 14;
    this.sources.set(hex, mesh);
    return mesh;
  }
}
