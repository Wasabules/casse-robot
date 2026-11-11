import * as B from "../babylon";
import type { BLOCK_TYPES, BlockType } from "../../shared/catalog/blocks";
import type { ProjectileSpec } from "../../shared/catalog/weapons";

/** Types de blocs qui sont des tourelles. */
export type TurretBlockType = {
  [K in BlockType]: (typeof BLOCK_TYPES)[K] extends { turret: object } ? K : never;
}[BlockType];

/**
 * Tête de tourelle : un boîtier (largeur, hauteur, profondeur) et des tubes le long de l'avant
 * (+z), décalés en x et y, de la longueur du canon. L'origine est l'axe de rotation.
 */
interface TurretLook {
  head: readonly [number, number, number];
  barrels: readonly { x: number; y: number; z?: number; length: number; diameter: number }[];
  color: string;
  barrelColor: string;
}

const TURRET_LOOKS: Record<TurretBlockType, TurretLook> = {
  gunTurret: { head: [0.32, 0.22, 0.34], barrels: [{ x: 0, y: 0, length: 0.6, diameter: 0.07 }], color: "#3b4249", barrelColor: "#1e2226" },
  sniperTurret: { head: [0.28, 0.24, 0.4], barrels: [{ x: 0, y: 0.02, length: 0.95, diameter: 0.05 }], color: "#4a4f3a", barrelColor: "#1e2226" },
  cannonTurret: { head: [0.46, 0.3, 0.5], barrels: [{ x: 0, y: 0, length: 0.85, diameter: 0.16 }], color: "#4b5059", barrelColor: "#2a2e33" },
  missileLauncher: {
    head: [0.46, 0.34, 0.5],
    barrels: [
      { x: -0.1, y: 0.07, length: 0.5, diameter: 0.14 }, { x: 0.1, y: 0.07, length: 0.5, diameter: 0.14 },
      { x: -0.1, y: -0.08, length: 0.5, diameter: 0.14 }, { x: 0.1, y: -0.08, length: 0.5, diameter: 0.14 },
    ],
    color: "#5a6b4d", barrelColor: "#d9dee2",
  },
  flakLauncher: {
    head: [0.4, 0.26, 0.42],
    barrels: [{ x: -0.12, y: 0, length: 0.55, diameter: 0.12 }, { x: 0.12, y: 0, length: 0.55, diameter: 0.12 }],
    color: "#6a4f6e", barrelColor: "#e0e4e8",
  },
  mineLayer: { head: [0.36, 0.16, 0.2], barrels: [{ x: 0, y: -0.02, length: 0.35, diameter: 0.2 }], color: "#6b5a3a", barrelColor: "#2a2e33" },
  empMineLayer: { head: [0.36, 0.16, 0.2], barrels: [{ x: 0, y: -0.02, length: 0.35, diameter: 0.2 }], color: "#2f4a5c", barrelColor: "#2a2e33" },
  fireMineLayer: { head: [0.36, 0.16, 0.2], barrels: [{ x: 0, y: -0.02, length: 0.35, diameter: 0.2 }], color: "#6b3a2a", barrelColor: "#2a2e33" },
  smokeMineLayer: { head: [0.36, 0.16, 0.2], barrels: [{ x: 0, y: -0.02, length: 0.35, diameter: 0.2 }], color: "#5a6168", barrelColor: "#2a2e33" },
  bounceMineLayer: { head: [0.36, 0.16, 0.2], barrels: [{ x: 0, y: -0.02, length: 0.35, diameter: 0.2 }], color: "#6b603a", barrelColor: "#2a2e33" },
  aaMineLayer: { head: [0.36, 0.2, 0.2], barrels: [{ x: 0, y: -0.02, length: 0.35, diameter: 0.22 }], color: "#5a4a6e", barrelColor: "#2a2e33" },
  remoteMineLayer: { head: [0.36, 0.16, 0.2], barrels: [{ x: 0, y: -0.02, length: 0.35, diameter: 0.2 }, { x: 0.12, y: 0.12, length: 0.1, diameter: 0.03 }], color: "#5c5230", barrelColor: "#2a2e33" },
  sensorMineLayer: { head: [0.3, 0.14, 0.2], barrels: [{ x: 0, y: -0.02, length: 0.3, diameter: 0.16 }], color: "#2f5a40", barrelColor: "#2a2e33" },
  stickyMineLayer: { head: [0.36, 0.16, 0.2], barrels: [{ x: 0, y: -0.02, length: 0.35, diameter: 0.2 }], color: "#5c2f3a", barrelColor: "#2a2e33" },
  /** Un émetteur court, à lentille verte. */
  repairTurret: { head: [0.32, 0.24, 0.36], barrels: [{ x: 0, y: 0, length: 0.45, diameter: 0.12 }], color: "#2f4a3a", barrelColor: "#7fffb0" },
  /** Une ruche : trois tubes courts, embouts clairs. */
  naniteLauncher: {
    head: [0.34, 0.26, 0.32],
    barrels: [
      { x: -0.08, y: 0.05, length: 0.3, diameter: 0.09 }, { x: 0.08, y: 0.05, length: 0.3, diameter: 0.09 }, { x: 0, y: -0.07, length: 0.3, diameter: 0.09 },
    ],
    color: "#d8d2b8", barrelColor: "#b8ffcf",
  },
  /** Un émetteur large et plat, à lentille bleue. */
  barrierProjector: { head: [0.46, 0.2, 0.34], barrels: [{ x: 0, y: 0, length: 0.25, diameter: 0.3 }], color: "#2f3f52", barrelColor: "#8fd0ff" },
  /** Sous le bloc, un râtelier où pendent deux bombes. */
  bombBay: {
    head: [0.36, 0.1, 0.42],
    barrels: [{ x: -0.1, y: -0.12, z: -0.22, length: 0.44, diameter: 0.14 }, { x: 0.1, y: -0.12, z: -0.22, length: 0.44, diameter: 0.14 }],
    color: "#2c322d", barrelColor: "#5b6650",
  },
  flamerTurret: { head: [0.34, 0.24, 0.36], barrels: [{ x: 0, y: -0.02, length: 0.5, diameter: 0.13 }], color: "#5a3b30", barrelColor: "#2a2e33" },
  empTurret: { head: [0.4, 0.3, 0.44], barrels: [{ x: 0, y: 0, length: 0.7, diameter: 0.15 }], color: "#2f4a5c", barrelColor: "#9fe3ff" },
  smokeLauncher: {
    head: [0.36, 0.2, 0.3],
    barrels: [{ x: -0.09, y: 0, length: 0.4, diameter: 0.1 }, { x: 0.09, y: 0, length: 0.4, diameter: 0.1 }],
    color: "#4a5057", barrelColor: "#1e2226",
  },
  laserTurret: { head: [0.3, 0.22, 0.36], barrels: [{ x: 0, y: 0, length: 0.55, diameter: 0.06 }], color: "#40363c", barrelColor: "#ff4d5e" },
  /** Deux rails parallèles. */
  railTurret: {
    head: [0.42, 0.26, 0.56],
    barrels: [{ x: -0.07, y: 0, length: 1.1, diameter: 0.06 }, { x: 0.07, y: 0, length: 1.1, diameter: 0.06 }],
    color: "#39424c", barrelColor: "#8fd3ff",
  },
  /** Deux canons côte à côte, courts et gros. */
  shotgunTurret: {
    head: [0.36, 0.24, 0.36],
    barrels: [{ x: -0.06, y: 0, length: 0.55, diameter: 0.1 }, { x: 0.06, y: 0, length: 0.55, diameter: 0.1 }],
    color: "#4a4137", barrelColor: "#1e2226",
  },
  /** Un panier de six tubes courts. */
  rocketPod: {
    head: [0.5, 0.36, 0.46],
    barrels: [-0.14, 0, 0.14].flatMap((x) => [0.08, -0.08].map((y) => ({ x, y, length: 0.45, diameter: 0.11 }))),
    color: "#55604a", barrelColor: "#d9dee2",
  },
  /** Un gros tube unique, où l'on voit la pointe rouge de l'ogive. */
  warheadLauncher: { head: [0.5, 0.4, 0.56], barrels: [{ x: 0, y: 0, length: 0.7, diameter: 0.32 }], color: "#4a3a36", barrelColor: "#ff6b5a" },
  /** Trois tubes en rang, sous une antenne de guidage. */
  lockonLauncher: {
    head: [0.5, 0.3, 0.46],
    barrels: [
      { x: -0.14, y: -0.03, length: 0.5, diameter: 0.12 }, { x: 0, y: -0.03, length: 0.5, diameter: 0.12 }, { x: 0.14, y: -0.03, length: 0.5, diameter: 0.12 },
      { x: 0, y: 0.13, length: 0.2, diameter: 0.04 },
    ],
    color: "#5a5238", barrelColor: "#ffcf5a",
  },
  /** Un émetteur épais, violet. */
  plasmaTurret: { head: [0.34, 0.26, 0.4], barrels: [{ x: 0, y: 0, length: 0.5, diameter: 0.14 }], color: "#3a3046", barrelColor: "#c77dff" },
};

function solid(scene: B.Scene, name: string, color: string, emissive?: string): B.StandardMaterial {
  const m = new B.StandardMaterial(name, scene);
  m.diffuseColor = B.Color3.FromHexString(color);
  m.specularColor = new B.Color3(0.3, 0.3, 0.3);
  if (emissive) m.emissiveColor = B.Color3.FromHexString(emissive);
  return m;
}

/** Fusionne des meshes en une source invisible, prête à instancier. */
function merge(parts: B.Mesh[], name: string): B.Mesh {
  const merged = B.Mesh.MergeMeshes(parts, true, true, undefined, false, true);
  if (!merged) throw new Error(`Impossible de construire le modèle ${name}`);
  merged.name = name;
  merged.isVisible = false;
  merged.isPickable = false;
  merged.receiveShadows = true;
  return merged;
}

/** Tube le long de +z, commençant à `z` (à l'origine par défaut). */
function tube(scene: B.Scene, length: number, diameter: number, x: number, y: number, z = 0): B.Mesh {
  const t = B.MeshBuilder.CreateCylinder("tube", { height: length, diameter, tessellation: 10 }, scene);
  t.rotation.x = Math.PI / 2;
  t.position.set(x, y, z + length / 2);
  t.bakeCurrentTransformIntoVertices();
  return t;
}

export function createTurretHead(scene: B.Scene, type: TurretBlockType): B.Mesh {
  const look = TURRET_LOOKS[type];
  const [w, h, d] = look.head;
  const head = B.MeshBuilder.CreateBox("head", { width: w, height: h, depth: d }, scene);
  head.material = solid(scene, `turret-${type}`, look.color);
  const barrelMat = solid(scene, `barrel-${type}`, look.barrelColor);
  const barrels = look.barrels.map((b) => {
    const t = tube(scene, b.length, b.diameter, b.x, b.y, b.z);
    t.material = barrelMat;
    return t;
  });
  return merge([head, ...barrels], `src-head-${type}`);
}

/**
 * Projectiles : traçante (étirée selon la vitesse), obus, missile avec sa flamme, mine, bombe, flamme,
 * orbe, grenade, rayon laser et trait du canon électrique (étirés eux aussi).
 */
export function createProjectileSource(scene: B.Scene, look: ProjectileSpec["look"]): B.Mesh {
  switch (look) {
    case "bullet": {
      const m = B.MeshBuilder.CreateBox("src-bullet", { width: 0.05, height: 0.05, depth: 1 }, scene);
      const mat = solid(scene, "bullet", "#ffe28a", "#ffd24a");
      mat.disableLighting = true;
      m.material = mat;
      m.isVisible = false;
      m.isPickable = false;
      return m;
    }
    case "pellet": {
      const m = B.MeshBuilder.CreateBox("src-pellet", { width: 0.025, height: 0.025, depth: 1 }, scene);
      const mat = solid(scene, "pellet", "#ffd27a", "#ffb347");
      mat.disableLighting = true;
      m.material = mat;
      m.isVisible = false;
      m.isPickable = false;
      return m;
    }
    case "rocket": {
      const body = tube(scene, 0.4, 0.07, 0, 0);
      body.position.z = -0.2;
      body.bakeCurrentTransformIntoVertices();
      body.material = solid(scene, "rocket", "#d9dee2");
      const flame = B.MeshBuilder.CreateCylinder("flame", { height: 0.35, diameterTop: 0.09, diameterBottom: 0, tessellation: 8 }, scene);
      flame.rotation.x = Math.PI / 2;
      flame.position.z = -0.4;
      flame.bakeCurrentTransformIntoVertices();
      const fm = solid(scene, "rocket-flame", "#ffb347", "#ff9a2a");
      fm.disableLighting = true;
      flame.material = fm;
      return merge([body, flame], "src-rocket");
    }
    case "warhead": {
      // Corps épais, pointe rouge, ailerons, grande flamme
      const body = tube(scene, 1.3, 0.3, 0, 0);
      body.position.z = -0.6;
      body.bakeCurrentTransformIntoVertices();
      body.material = solid(scene, "warhead", "#d9dee2");
      const nose = B.MeshBuilder.CreateCylinder("nose", { height: 0.45, diameterTop: 0, diameterBottom: 0.3, tessellation: 12 }, scene);
      nose.rotation.x = Math.PI / 2;
      nose.position.z = 0.27;
      nose.bakeCurrentTransformIntoVertices();
      nose.material = solid(scene, "warhead-nose", "#ff6b5a", "#5a1a10");
      const fins = B.MeshBuilder.CreateBox("fins", { width: 0.7, height: 0.04, depth: 0.3 }, scene);
      fins.position.z = -1.05;
      fins.bakeCurrentTransformIntoVertices();
      fins.material = solid(scene, "warhead-fins", "#8a939b");
      const flame = B.MeshBuilder.CreateCylinder("flame", { height: 1, diameterTop: 0.34, diameterBottom: 0, tessellation: 8 }, scene);
      flame.rotation.x = Math.PI / 2;
      flame.position.z = -1.7;
      flame.bakeCurrentTransformIntoVertices();
      const fm = solid(scene, "warhead-flame", "#ffb347", "#ff9a2a");
      fm.disableLighting = true;
      flame.material = fm;
      return merge([body, nose, fins, flame], "src-warhead");
    }
    case "plasma":
      // Boule d'un mètre, étirée le long de sa course (voir ProjectileView) : les tirs se suivent en un jet continu
      return glowBall(scene, "plasma", 1, "#c77dff", 0.8);
    case "shell": {
      const m = B.MeshBuilder.CreateSphere("src-shell", { diameter: 0.2, segments: 8 }, scene);
      m.material = solid(scene, "shell", "#2a2e33", "#7a3a10");
      m.isVisible = false;
      m.isPickable = false;
      return m;
    }
    case "missile": {
      const body = tube(scene, 0.7, 0.12, 0, 0);
      body.position.z = -0.35;
      body.bakeCurrentTransformIntoVertices();
      body.material = solid(scene, "missile", "#e8ecef");
      const flame = B.MeshBuilder.CreateCylinder("flame", { height: 0.5, diameterTop: 0.14, diameterBottom: 0, tessellation: 8 }, scene);
      flame.rotation.x = Math.PI / 2;
      flame.position.z = -0.6;
      flame.bakeCurrentTransformIntoVertices();
      const fm = solid(scene, "missile-flame", "#ffb347", "#ff9a2a");
      fm.disableLighting = true;
      flame.material = fm;
      return merge([body, flame], "src-missile");
    }
    case "mine": {
      const disc = B.MeshBuilder.CreateCylinder("mine", { height: 0.12, diameter: 0.5, tessellation: 16 }, scene);
      disc.material = solid(scene, "mine", "#2f3a2a");
      const light = B.MeshBuilder.CreateSphere("mine-light", { diameter: 0.1, segments: 6 }, scene);
      light.position.y = 0.07;
      light.bakeCurrentTransformIntoVertices();
      light.material = solid(scene, "mine-light", "#ff3b30", "#ff3b30");
      return merge([disc, light], "src-mine");
    }
    case "bomb": {
      // Corps fuselé, nez arrondi, empennage en croix ; le nez suit la vitesse (il pique en tombant)
      const body = tube(scene, 0.5, 0.16, 0, 0, -0.3);
      body.material = solid(scene, "bomb", "#4f5a45");
      const nose = B.MeshBuilder.CreateSphere("bomb-nose", { diameter: 0.16, segments: 8 }, scene);
      nose.position.z = 0.2;
      nose.bakeCurrentTransformIntoVertices();
      nose.material = solid(scene, "bomb-nose", "#3c4535");
      const band = tube(scene, 0.04, 0.17, 0, 0, 0.08);
      band.material = solid(scene, "bomb-band", "#f0bd2c");
      const fins = [0, Math.PI / 2].map((angle) => {
        const f = B.MeshBuilder.CreateBox("bomb-fin", { width: 0.3, height: 0.02, depth: 0.14 }, scene);
        f.rotation.z = angle;
        f.position.z = -0.34;
        f.bakeCurrentTransformIntoVertices();
        f.material = solid(scene, "bomb-fin", "#3c4535");
        return f;
      });
      return merge([body, nose, band, ...fins], "src-bomb");
    }
    case "flame":
      return glowBall(scene, "flame", 0.3, "#ff8a2a", 0.75);
    case "flare":
      return glowBall(scene, "flare", 0.4, "#fff2b0", 0.95);
    case "repair": {
      // Un trait vert, étiré le long de sa course, comme le laser
      const m = B.MeshBuilder.CreateBox("src-repair", { width: 0.05, height: 0.05, depth: 1 }, scene);
      const mat = solid(scene, "repair", "#7fffb0", "#7fffb0");
      mat.disableLighting = true;
      mat.alpha = 0.85;
      m.material = mat;
      m.isVisible = false;
      m.isPickable = false;
      return m;
    }
    case "orb":
      return glowBall(scene, "orb", 0.3, "#7fd8ff", 0.9);
    case "nanites":
      return glowBall(scene, "nanites", 0.22, "#b8ffcf", 0.9);
    case "barrier":
      return glowBall(scene, "barrier", 0.35, "#8fd0ff", 0.8);
    case "beam":
    case "rail": {
      const size = look === "beam" ? 0.035 : 0.08;
      const color = look === "beam" ? "#ff4d5e" : "#9fe3ff";
      const m = B.MeshBuilder.CreateBox(`src-${look}`, { width: size, height: size, depth: 1 }, scene);
      const mat = solid(scene, look, color, color);
      mat.disableLighting = true;
      m.material = mat;
      m.isVisible = false;
      m.isPickable = false;
      return m;
    }
    case "grenade": {
      const m = B.MeshBuilder.CreateSphere("src-grenade", { diameter: 0.16, segments: 8 }, scene);
      m.material = solid(scene, "grenade", "#3d4a3a", "#1a2418");
      m.isVisible = false;
      m.isPickable = false;
      return m;
    }
  }
}

/** Boule lumineuse et translucide (flamme, orbe électromagnétique). */
function glowBall(scene: B.Scene, name: string, diameter: number, color: string, alpha: number): B.Mesh {
  const m = B.MeshBuilder.CreateSphere(`src-${name}`, { diameter, segments: 8 }, scene);
  const mat = solid(scene, name, color, color);
  mat.disableLighting = true;
  mat.alpha = alpha;
  m.material = mat;
  m.isVisible = false;
  m.isPickable = false;
  return m;
}

/** Flamme posée sur un bloc en feu : deux cônes emboîtés, orange et jaune. Origine à la base. */
export function createFireSource(scene: B.Scene): B.Mesh {
  const outer = B.MeshBuilder.CreateCylinder("fire", { height: 0.55, diameterTop: 0, diameterBottom: 0.38, tessellation: 7 }, scene);
  outer.position.y = 0.27;
  outer.bakeCurrentTransformIntoVertices();
  const om = solid(scene, "fire-outer", "#ff7a1a", "#ff6a10");
  om.disableLighting = true;
  om.alpha = 0.8;
  outer.material = om;
  const inner = B.MeshBuilder.CreateCylinder("fire-in", { height: 0.35, diameterTop: 0, diameterBottom: 0.22, tessellation: 6 }, scene);
  inner.position.y = 0.17;
  inner.bakeCurrentTransformIntoVertices();
  const im = solid(scene, "fire-inner", "#ffe07a", "#ffd24a");
  im.disableLighting = true;
  inner.material = im;
  return merge([outer, inner], "src-fire");
}
