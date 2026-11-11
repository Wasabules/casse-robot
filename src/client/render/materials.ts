import * as B from "../babylon";
import { blockDef, blockShape, BLOCK_TYPES, type BlockType } from "../../shared/catalog/blocks";
import { propDef, type PropType } from "../../shared/catalog/props";
import { shapePieces, type ShapeId } from "../../shared/catalog/shapes";
import type { ProjectileSpec, MineWeaponId } from "../../shared/catalog/weapons";
import { wheelDef, type WheelType, type WheelTypeDef } from "../../shared/catalog/wheels";
import { BLOCK_SIZE, PLATE_THICKNESS } from "../../shared/config";
import { cross, dot, norm, scale, sub, vec3, type Vec3 } from "../../shared/math/vec";
import { BLADES, JET_NACELLE, LEG_THICKNESS, type BladeKind } from "../../shared/design/clearance";
import { createFireSource, createProjectileSource, createTurretHead, type TurretBlockType } from "./models";
import { MINE_MODELS } from "./models/mines";
import { MELEE_MODELS, MELEE_PIECES } from "./models/melee";
import { LANCE_SHAFT, MELEE_BLURS, MELEE_GLOWS } from "./models/meleeEnergy";
import type { MeleeId } from "../../shared/catalog/melee";
import { PropModels, type CharLevel } from "./propModels";
import { BLOCK_MODELS, HEAD_MODELS, HEAD_ROUNDS, WHEEL_MODELS } from "./blockModels";
import { ModelKit, type Rounds } from "./modelKit";
import { sprocket, trackShoe } from "./models/tracks";
import { surfaceSegment } from "./surfaceModels";
import { SIDES_ALONE } from "../../shared/robot/surfaces";
import type { FxLook } from "../settings";
import { flameMaterial } from "./fx/flames";
import { LIGHT_LENSES } from "./models/lights";

type Ctx = CanvasRenderingContext2D;

/** Contexte 2D d'une DynamicTexture (dans le navigateur, c'est un vrai canvas). */
export function context2d(tex: B.DynamicTexture): Ctx {
  return tex.getContext() as unknown as Ctx;
}

/** Apparence d'un bloc : panneau `fill` bordé de `edge` (épaisseur `edgeWidth`, 8 par défaut), avec un motif optionnel. */
interface BlockLook {
  fill: string;
  edge: string;
  edgeWidth?: number;
  specular: number;
  emissive?: B.Color3;
  decorate?: (c: Ctx) => void;
  /**
   * Texture qui se raccorde d'une case à l'autre, sans bordure ni reflet sur ses bords : les ailes
   * et les gouvernes, dont des cases voisines font une seule pièce (render/surfaceModels.ts).
   * Son motif doit se répéter sans couture (période qui divise 128 px).
   */
  seamless?: boolean;
}

const disc = (c: Ctx, r: number, color: string): void => {
  c.fillStyle = color;
  c.beginPath();
  c.arc(64, 64, r, 0, Math.PI * 2);
  c.fill();
};

const rivets = (c: Ctx, color: string): void => {
  c.fillStyle = color;
  for (const [x, y] of [[22, 22], [106, 22], [22, 106], [106, 106]]) {
    c.beginPath();
    c.arc(x, y, 4, 0, Math.PI * 2);
    c.fill();
  }
};

const darker = (hex: string, k: number): string => B.Color3.FromHexString(hex).scale(k).toHexString();

/** Socle de tourelle : acier sombre avec une couronne de la couleur de l'arme. */
const turretBase = (accent: string): BlockLook => ({
  fill: "#2f353b",
  edge: "#1d2125",
  edgeWidth: 10,
  specular: 0.4,
  decorate: (c) => {
    c.strokeStyle = accent;
    c.lineWidth = 8;
    c.beginPath();
    c.arc(64, 64, 34, 0, Math.PI * 2);
    c.stroke();
  },
});
const lighter = (hex: string, t: number): string =>
  B.Color3.Lerp(B.Color3.FromHexString(hex), B.Color3.White(), t).toHexString();

/** Les trois blindages, et les formes taillées dans chacun (même aspect, voir `shapeVertexData`). */
const lightArmorLook = (color: string): BlockLook => ({
  fill: lighter(color, 0.18),
  edge: darker(color, 0.8),
  edgeWidth: 4,
  specular: 0.12,
  decorate: (c) => {
    c.fillStyle = "rgba(20,30,40,0.28)";
    for (const x of [40, 64, 88]) {
      for (const y of [40, 64, 88]) {
        c.beginPath();
        c.arc(x, y, 5, 0, Math.PI * 2);
        c.fill();
      }
    }
  },
});
const heavyArmorLook = (color: string): BlockLook => ({
  fill: darker(color, 0.78),
  edge: darker(color, 0.5),
  edgeWidth: 14,
  specular: 0.3,
  decorate: (c) => {
    c.strokeStyle = "rgba(10,15,20,0.35)";
    c.lineWidth = 4;
    c.strokeRect(30, 30, 68, 68);
    rivets(c, darker(color, 0.4));
  },
});
const armorLook = (color: string): BlockLook => ({
  fill: color,
  edge: darker(color, 0.72),
  specular: 0.18,
  decorate: (c) => {
    c.strokeStyle = "rgba(20,30,40,0.22)";
    c.lineWidth = 2;
    c.beginPath(); c.moveTo(24, 64); c.lineTo(104, 64); c.stroke();
  },
});

/** Apparence de secours d'un feu (sans son modèle) : un verre rond de sa couleur sur une platine sombre. */
function lampLook(glass: string): BlockLook {
  return {
    fill: "#2b3034",
    edge: "#15181b",
    specular: 0.5,
    decorate: (c) => {
      c.fillStyle = "#d5dade";
      c.beginPath(); c.arc(64, 64, 30, 0, Math.PI * 2); c.fill();
      c.fillStyle = glass;
      c.beginPath(); c.arc(64, 64, 22, 0, Math.PI * 2); c.fill();
    },
  };
}

/**
 * Apparence de chaque type de bloc. `color` : couleur du robot, pour les blocs teintés.
 * Les blindages se reconnaissent à leur bordure : fine et ajourée pour le léger, épaisse et rivetée pour le lourd.
 */
const BLOCK_LOOKS: Record<BlockType, (color: string) => BlockLook> = {
  frame: () => ({ fill: "#4b5761", edge: "#343d45", specular: 0.18, decorate: (c) => rivets(c, "#2d353c") }),
  armorLight: lightArmorLook,
  armorHeavy: heavyArmorLook,
  armor: armorLook,
  wedgeLight: lightArmorLook,
  wedge: armorLook,
  wedgeHeavy: heavyArmorLook,
  cornerLight: lightArmorLook,
  corner: armorLook,
  cornerHeavy: heavyArmorLook,
  innerCornerLight: lightArmorLook,
  innerCorner: armorLook,
  roundLight: lightArmorLook,
  round: armorLook,
  roundCornerLight: lightArmorLook,
  roundCorner: armorLook,
  slopeLowLight: lightArmorLook,
  slopeLow: armorLook,
  slopeHighLight: lightArmorLook,
  slopeHigh: armorLook,
  slabLight: lightArmorLook,
  slab: armorLook,
  armorReactive: (color) => ({
    fill: darker(color, 0.92),
    edge: darker(color, 0.55),
    edgeWidth: 6,
    specular: 0.22,
    decorate: (c) => {
      // Tuiles de charges réactives
      c.fillStyle = "rgba(15,20,25,0.35)";
      for (const [x, y] of [[18, 18], [66, 66]]) c.fillRect(x, y, 44, 44);
      c.strokeStyle = "rgba(255,210,120,0.55)";
      c.lineWidth = 3;
      for (const [x, y] of [[66, 18], [18, 66]]) c.strokeRect(x + 4, y + 4, 36, 36);
    },
  }),
  cockpit: () => ({
    fill: "#f0bd2c",
    edge: "#a37a0c",
    specular: 0.35,
    decorate: (c) => { disc(c, 22, "#1d1a10"); disc(c, 9, "#f0bd2c"); },
  }),
  thruster: () => ({
    fill: "#3a3f44",
    edge: "#26292d",
    specular: 0.3,
    emissive: new B.Color3(0.45, 0.2, 0.04),
    decorate: (c) => { disc(c, 30, "#ff8a2a"); disc(c, 14, "#ffd27a"); },
  }),
  engine: () => ({
    fill: "#2e3338",
    edge: "#1b1e21",
    edgeWidth: 10,
    specular: 0.45,
    emissive: new B.Color3(0.08, 0.25, 0.4),
    decorate: (c) => { disc(c, 34, "#15191c"); disc(c, 24, "#6fd3ff"); disc(c, 12, "#15191c"); },
  }),
  wing: (color) => ({
    fill: lighter(color, 0.08),
    edge: darker(color, 0.75),
    edgeWidth: 4,
    specular: 0.25,
    seamless: true,
    decorate: (c) => {
      // Nervures le long de la corde, tous les 64 px : elles se suivent d'une case à l'autre
      c.strokeStyle = "rgba(20,30,40,0.22)";
      c.lineWidth = 3;
      for (const x of [32, 96]) {
        c.beginPath(); c.moveTo(x, 0); c.lineTo(x, 128); c.stroke();
      }
    },
  }),
  gunTurret: () => turretBase("#f0bd2c"),
  sniperTurret: () => turretBase("#9ccc65"),
  cannonTurret: () => turretBase("#ff8a2a"),
  missileLauncher: () => turretBase("#6fd3ff"),
  flakLauncher: () => turretBase("#c792ea"),
  mineLayer: () => turretBase("#ff5b4f"),
  empMineLayer: () => turretBase("#7fd8ff"),
  fireMineLayer: () => turretBase("#ff8a2a"),
  smokeMineLayer: () => turretBase("#c8ccd0"),
  bounceMineLayer: () => turretBase("#f0bd2c"),
  aaMineLayer: () => turretBase("#c792ea"),
  remoteMineLayer: () => turretBase("#ffcf5a"),
  sensorMineLayer: () => turretBase("#57d38c"),
  stickyMineLayer: () => turretBase("#ff6b8a"),
  flareLauncher: () => ({
    fill: "#3b3a33",
    edge: "#22211c",
    edgeWidth: 10,
    specular: 0.3,
    decorate: (c) => {
      // Une grille de tubes, bouches jaunes
      c.fillStyle = "#1a1a16";
      for (const x of [34, 64, 94]) for (const y of [40, 88]) {
        c.beginPath(); c.arc(x, y, 11, 0, Math.PI * 2); c.fill();
      }
      c.fillStyle = "#f0bd2c";
      for (const x of [34, 64, 94]) for (const y of [40, 88]) {
        c.beginPath(); c.arc(x, y, 5, 0, Math.PI * 2); c.fill();
      }
    },
  }),
  repairTurret: () => ({
    fill: "#2f3b34",
    edge: "#1b231e",
    edgeWidth: 10,
    specular: 0.35,
    decorate: (c) => {
      // Une croix verte
      c.fillStyle = "#57d38c";
      c.fillRect(52, 28, 24, 72);
      c.fillRect(28, 52, 72, 24);
    },
  }),
  bombBay: () => ({
    fill: "#3a413b",
    edge: "#1f2420",
    edgeWidth: 10,
    specular: 0.3,
    decorate: (c) => {
      // Deux trappes, et un liseré jaune et noir
      c.fillStyle = "#f0bd2c";
      c.fillRect(14, 14, 100, 100);
      c.fillStyle = "#1a1d1a";
      for (let i = -100; i < 128; i += 24) {
        c.beginPath(); c.moveTo(i, 128); c.lineTo(i + 12, 128); c.lineTo(i + 140, 0); c.lineTo(i + 128, 0); c.fill();
      }
      c.fillStyle = "#2c322d";
      c.fillRect(24, 24, 80, 80);
      c.strokeStyle = "#151815";
      c.lineWidth = 4;
      c.beginPath(); c.moveTo(64, 24); c.lineTo(64, 104); c.stroke();
    },
  }),
  battery: () => ({
    fill: "#2c3e33",
    edge: "#18231c",
    edgeWidth: 10,
    specular: 0.35,
    emissive: new B.Color3(0.02, 0.12, 0.05),
    decorate: (c) => {
      // Éléments de batterie, avec la borne
      c.fillStyle = "#57d38c";
      for (const x of [28, 56, 84]) c.fillRect(x, 40, 16, 48);
      c.fillStyle = "#c8f5d8";
      c.fillRect(58, 26, 12, 10);
    },
  }),
  naniteLauncher: () => ({
    fill: "#d8d2b8",
    edge: "#8f8a74",
    edgeWidth: 10,
    specular: 0.35,
    emissive: new B.Color3(0.04, 0.1, 0.06),
    decorate: (c) => {
      // Une ruche : des alvéoles vertes
      c.fillStyle = "#57d38c";
      for (const [x, y] of [[40, 40], [88, 40], [64, 64], [40, 88], [88, 88]]) {
        c.beginPath();
        for (let i = 0; i < 6; i++) c.lineTo(x + 13 * Math.cos((i * Math.PI) / 3), y + 13 * Math.sin((i * Math.PI) / 3));
        c.fill();
      }
    },
  }),
  barrierProjector: () => ({
    fill: "#2f3f52",
    edge: "#18212c",
    edgeWidth: 10,
    specular: 0.45,
    emissive: new B.Color3(0.03, 0.07, 0.12),
    decorate: (c) => {
      // Un écu bleu
      c.fillStyle = "#8fd0ff";
      c.beginPath();
      c.moveTo(34, 30); c.lineTo(94, 30); c.lineTo(94, 66); c.lineTo(64, 100); c.lineTo(34, 66);
      c.fill();
      c.fillStyle = "#2f3f52";
      c.fillRect(60, 40, 8, 44);
    },
  }),
  repairModule: () => ({
    fill: "#e3e7ea",
    edge: "#8b969d",
    edgeWidth: 8,
    specular: 0.3,
    emissive: new B.Color3(0.05, 0.12, 0.06),
    decorate: (c) => {
      // Croix verte
      c.fillStyle = "#35b56a";
      c.fillRect(52, 28, 24, 72);
      c.fillRect(28, 52, 72, 24);
    },
  }),
  radar: () => ({
    fill: "#34414a",
    edge: "#1f272d",
    specular: 0.4,
    decorate: (c) => {
      // Cercles concentriques et un balayage
      c.strokeStyle = "#7fd8ff";
      c.lineWidth = 4;
      for (const r of [16, 30, 44]) {
        c.beginPath(); c.arc(64, 64, r, 0, Math.PI * 2); c.stroke();
      }
      c.beginPath(); c.moveTo(64, 64); c.lineTo(104, 40); c.stroke();
    },
  }),
  headlight: () => ({
    fill: "#2b3034",
    edge: "#15181b",
    specular: 0.5,
    decorate: (c) => {
      // Un verre rond cerclé de chrome
      c.fillStyle = "#d5dade";
      c.beginPath(); c.arc(64, 64, 44, 0, Math.PI * 2); c.fill();
      c.fillStyle = "#fff3cf";
      c.beginPath(); c.arc(64, 64, 36, 0, Math.PI * 2); c.fill();
    },
  }),
  navLight: () => lampLook("#ff2a1e"),
  strobe: () => lampLook("#f4f8ff"),
  antiCollision: () => lampLook("#ff2a1e"),
  rotatingLight: () => lampLook("#ffa018"),
  policeBar: () => ({
    fill: "#2b3034",
    edge: "#15181b",
    specular: 0.5,
    decorate: (c) => {
      // Deux feux côte à côte, bleu et rouge
      c.fillStyle = "#2f78ff";
      c.fillRect(18, 44, 44, 40);
      c.fillStyle = "#ff2a1e";
      c.fillRect(66, 44, 44, 40);
    },
  }),
  beacon: () => ({
    fill: "#2b3034",
    edge: "#15181b",
    specular: 0.5,
    decorate: (c) => {
      // Un dôme de verre dans sa cage
      c.fillStyle = "#9fdcff";
      c.beginPath(); c.arc(64, 64, 34, 0, Math.PI * 2); c.fill();
      c.strokeStyle = "#d5dade";
      c.lineWidth = 6;
      c.beginPath(); c.moveTo(64, 26); c.lineTo(64, 102); c.moveTo(26, 64); c.lineTo(102, 64); c.stroke();
    },
  }),
  jammer: () => ({
    fill: "#3b3346",
    edge: "#231e2a",
    specular: 0.4,
    decorate: (c) => {
      // Ondes en zigzag
      c.strokeStyle = "#c792ea";
      c.lineWidth = 5;
      for (const y of [44, 64, 84]) {
        c.beginPath();
        for (let x = 20; x <= 108; x += 11) c.lineTo(x, y + ((x / 11) % 2 ? -7 : 7));
        c.stroke();
      }
    },
  }),
  rotor: () => ({
    fill: "#3a3f44",
    edge: "#202428",
    edgeWidth: 10,
    specular: 0.45,
    decorate: (c) => { disc(c, 34, "#15191c"); disc(c, 16, "#c9ced2"); },
  }),
  // Carter du moteur à pistons : ailettes de refroidissement autour de l'axe
  propeller: () => ({
    fill: "#4a4f55",
    edge: "#2b2f33",
    edgeWidth: 10,
    specular: 0.5,
    decorate: (c) => {
      c.strokeStyle = "#2b2f33";
      c.lineWidth = 5;
      for (const r of [44, 34, 24]) {
        c.beginPath(); c.arc(64, 64, r, 0, Math.PI * 2); c.stroke();
      }
      disc(c, 12, "#c9ced2");
    },
  }),
  // Le bloc qui porte la nacelle : métal brûlé
  jet: () => ({
    fill: "#3d4146",
    edge: "#24272a",
    edgeWidth: 10,
    specular: 0.55,
    decorate: (c) => { disc(c, 38, "#1b1d20"); disc(c, 26, "#5a4a3a"); disc(c, 12, "#1b1d20"); },
  }),
  hoverPad: () => ({
    fill: "#2b3a44",
    edge: "#17222a",
    edgeWidth: 8,
    specular: 0.4,
    emissive: new B.Color3(0.03, 0.14, 0.18),
    decorate: (c) => {
      // Anneau émetteur
      c.strokeStyle = "#5fe0ff";
      c.lineWidth = 8;
      c.beginPath(); c.arc(64, 64, 36, 0, Math.PI * 2); c.stroke();
      disc(c, 12, "#bff3ff");
    },
  }),
  leg: () => ({
    fill: "#4d535a",
    edge: "#2c3136",
    edgeWidth: 10,
    specular: 0.35,
    decorate: (c) => {
      // Rotule de hanche
      disc(c, 30, "#23272b");
      disc(c, 18, "#8a949b");
    },
  }),
  flamerTurret: () => turretBase("#ff6a3d"),
  empTurret: () => turretBase("#4fc3ff"),
  smokeLauncher: () => turretBase("#9aa4ad"),
  laserTurret: () => turretBase("#ff4d5e"),
  railTurret: () => turretBase("#8fd3ff"),
  shotgunTurret: () => turretBase("#d9a441"),
  rocketPod: () => turretBase("#e8ecef"),
  plasmaTurret: () => turretBase("#c77dff"),
  lockonLauncher: () => turretBase("#ffcf5a"),
  warheadLauncher: () => turretBase("#ff6b5a"),
  // Armes de contact (leur modèle 3D, render/models/melee.ts, prime ; ces couleurs servent aux vignettes)
  spinner: () => turretBase("#b8352c"),
  hammer: () => turretBase("#f0bd2c"),
  verticalSpinner: () => turretBase("#c9542c"),
  drum: () => turretBase("#d89a2c"),
  shellSpinner: () => turretBase("#9aa2a8"),
  flipper: () => turretBase("#5c8a3a"),
  flail: () => turretBase("#8a8f96"),
  jaw: () => turretBase("#7a4fa0"),
  laserBlade: () => turretBase("#46d6ff"),
  plasmaWhip: () => turretBase("#a05cff"),
  shockLance: () => turretBase("#2e6fd6"),
  crusherField: () => turretBase("#7a5cff"),
  saw: () => turretBase("#7fb0bd"),
  drill: () => turretBase("#d08a3a"),
  shield: () => ({
    fill: "#223048",
    edge: "#131b29",
    edgeWidth: 8,
    specular: 0.45,
    emissive: new B.Color3(0.04, 0.1, 0.22),
    decorate: (c) => {
      // Alvéoles hexagonales
      c.strokeStyle = "#5fb8ff";
      c.lineWidth = 4;
      const hex = (x: number, y: number, r: number): void => {
        c.beginPath();
        for (let i = 0; i <= 6; i++) c.lineTo(x + r * Math.cos((i * Math.PI) / 3), y + r * Math.sin((i * Math.PI) / 3));
        c.stroke();
      };
      hex(64, 64, 22);
      for (let i = 0; i < 6; i++) hex(64 + 38 * Math.cos(Math.PI / 6 + (i * Math.PI) / 3), 64 + 38 * Math.sin(Math.PI / 6 + (i * Math.PI) / 3), 22);
    },
  }),
  flap: () => ({
    fill: "#d9dee2",
    edge: "#8a949b",
    edgeWidth: 4,
    specular: 0.25,
    seamless: true,
    decorate: (c) => {
      // Bandes jaunes : une gouverne mobile se repère de loin (période de 32 px : elles se suivent d'une case à l'autre)
      c.fillStyle = "#f0bd2c";
      for (let x = -64; x < 128; x += 32) {
        c.beginPath(); c.moveTo(x, 128); c.lineTo(x + 16, 128); c.lineTo(x + 80, 0); c.lineTo(x + 64, 0); c.closePath(); c.fill();
      }
    },
  }),
};

/**
 * Géométrie d'un bloc de forme (catalog/shapes.ts), de demi-côté `half` : les faces de ses
 * morceaux, à plat. Une face alignée sur un axe prend le panneau comme la face du cube qui la
 * porte (deux morceaux d'un coin rentrant, qui se recouvrent, y dessinent donc le même motif) ;
 * une face en biais le prend tendu sur toute sa longueur.
 */
function shapeVertexData(shape: ShapeId, half: number): B.VertexData {
  const positions: number[] = [];
  const indices: number[] = [];
  const uvs: number[] = [];
  const axes = [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)];
  for (const piece of shapePieces(shape)) {
    for (const face of piece.faces) {
      const n = face.normal;
      const aligned = axes.find((a) => Math.abs(dot(a, n)) > 0.999);
      let project: (p: Vec3) => [number, number];
      if (aligned) {
        // Comme les faces d'une boîte : les deux autres axes, de -1 à 1
        const [a, b] = aligned.x ? ["z", "y"] as const : aligned.y ? ["x", "z"] as const : ["x", "y"] as const;
        project = (p) => [(p[a] + 1) / 2, (p[b] + 1) / 2];
      } else {
        // Dans le plan de la face, le long de l'axe du cube qui y est le plus couché
        const along = axes.reduce((best, a) => (Math.abs(dot(a, n)) < Math.abs(dot(best, n)) ? a : best));
        const e1 = norm(sub(along, scale(n, dot(along, n))));
        const e2 = cross(n, e1);
        const coords = face.points.map((p) => [dot(p, e1), dot(p, e2)]);
        const [minA, maxA] = [Math.min(...coords.map((c) => c[0])), Math.max(...coords.map((c) => c[0]))];
        const [minB, maxB] = [Math.min(...coords.map((c) => c[1])), Math.max(...coords.map((c) => c[1]))];
        project = (p) => [(dot(p, e1) - minA) / (maxA - minA || 1), (dot(p, e2) - minB) / (maxB - minB || 1)];
      }
      // Un sommet par coin de facette (normales à plat) ; triangles dans le sens de Babylon (comme les rochers, ArenaView)
      const pts = face.points;
      for (let i = 1; i + 1 < pts.length; i++) {
        for (const p of [pts[0], pts[i + 1], pts[i]]) {
          positions.push(p.x * half, p.y * half, p.z * half);
          uvs.push(...project(p));
          indices.push(indices.length);
        }
      }
    }
  }
  const normals: number[] = [];
  B.VertexData.ComputeNormals(positions, indices, normals);
  const data = new B.VertexData();
  data.positions = positions;
  data.indices = indices;
  data.normals = normals;
  data.uvs = uvs;
  return data;
}

function panelTexture(
  scene: B.Scene, name: string, look: Pick<BlockLook, "fill" | "edge" | "edgeWidth" | "decorate" | "seamless">,
): B.DynamicTexture {
  const t = new B.DynamicTexture(name, { width: 128, height: 128 }, scene, true);
  const c = context2d(t);
  c.fillStyle = look.fill;
  c.fillRect(0, 0, 128, 128);
  if (!look.seamless) {
    c.strokeStyle = look.edge;
    c.lineWidth = look.edgeWidth ?? 8;
    c.strokeRect(4, 4, 120, 120);
    c.strokeStyle = "rgba(255,255,255,0.16)";
    c.lineWidth = 3;
    c.beginPath(); c.moveTo(11, 117); c.lineTo(11, 11); c.lineTo(117, 11); c.stroke();
  }
  look.decorate?.(c);
  t.update();
  t.anisotropicFilteringLevel = 4;
  return t;
}

function panelMaterial(scene: B.Scene, name: string, tex: B.Texture, specular: number): B.StandardMaterial {
  const m = new B.StandardMaterial(name, scene);
  m.diffuseTexture = tex;
  m.specularColor = new B.Color3(specular, specular, specular);
  m.specularPower = 48;
  m.ambientColor = new B.Color3(1, 1, 1);
  return m;
}

/** Moyeu d'une roue directrice, quelle que soit sa taille : on la distingue d'une roue fixe au premier coup d'œil. */
const STEERING_HUB = "#e2703a";

/** Couleurs à plat d'un bloc, son fond et sa bordure (vignettes du choix du robot, render/robotSketch.ts). */
export function blockColors(type: BlockType, color: string): { fill: string; edge: string } {
  const look = BLOCK_LOOKS[type](color);
  return { fill: look.fill, edge: look.edge };
}

/** Couleurs d'une roue, son pneu et son moyeu (vignettes). */
export function wheelColors(type: WheelType): { tire: string; hub: string } {
  return WHEEL_LOOKS[type];
}

/** Apparence de chaque type de roue (les dimensions viennent du catalogue). */
const WHEEL_LOOKS: Record<WheelType, { tire: string; hub: string }> = {
  standard: { tire: "#23272b", hub: "#b9c3c9" },
  steered: { tire: "#23272b", hub: STEERING_HUB },
  small: { tire: "#2b2f33", hub: "#e0b64a" },
  smallSteered: { tire: "#2b2f33", hub: STEERING_HUB },
  heavy: { tire: "#1c1f22", hub: "#7d8a92" },
  heavySteered: { tire: "#1c1f22", hub: STEERING_HUB },
  caster: { tire: "#2b2f33", hub: "#dfe4e7" },
  track: { tire: "#1b1d1f", hub: "#50585e" },
};
/** Bras de direction, fourche et potence d'une roulette : section (m) et couleur. */
const ARM_SECTION = 0.13;
const ARM_COLOR = "#4b545b";
/** Fourche : épaisseur de ses flasques (m), et hauteur de son dessus au-dessus du pneu (m). */
const FORK_PLATE = 0.04;
export const FORK_TOP = 0.05;

/** Meshes sources (invisibles, à instancier) et matériaux partagés. */
export class Assets {
  readonly concrete: B.StandardMaterial;
  /** Béton plus sombre : murets et plateformes, pour les distinguer des piliers et des rampes. */
  readonly darkConcrete: B.StandardMaterial;
  /** Flamme sous un réacteur : cône pointe en bas, de hauteur 1, à mettre à l'échelle de la poussée. */
  readonly flame: B.Mesh;
  /** Allure des flammes des moteurs (voir `flameFor`). */
  private flameLook: FxLook = "simple";
  private readonly scene: B.Scene;
  private readonly blockSources = new Map<string, B.Mesh>();
  /** Matières des ailes et des gouvernes (par type et couleur), et leurs sources par profil de case. */
  private readonly surfaceMaterials = new Map<string, B.StandardMaterial>();
  private readonly surfaceSources = new Map<string, B.Mesh>();
  private readonly wheelSources = new Map<string, B.Mesh>();
  private readonly models = new Map<string, B.Mesh>();
  /** L'atelier des modèles 3D de blocs et de têtes (render/modelKit.ts). */
  private readonly kit: ModelKit;
  private stillBelt: B.StandardMaterial | null = null;
  private readonly roundSources = new Map<TurretBlockType, Rounds>();
  private readonly propModels: PropModels;

  constructor(scene: B.Scene) {
    this.scene = scene;
    this.propModels = new PropModels(scene);
    this.kit = new ModelKit(scene);

    this.flame = B.MeshBuilder.CreateCylinder("src-flame", { height: 1, diameterTop: BLOCK_SIZE * 0.7, diameterBottom: 0, tessellation: 12 }, scene);
    const flameMat = new B.StandardMaterial("flame", scene);
    flameMat.emissiveColor = B.Color3.FromHexString("#ffb347");
    flameMat.disableLighting = true;
    flameMat.alpha = 0.75;
    this.flame.material = flameMat;
    this.flame.isVisible = false;
    this.flame.isPickable = false;

    this.concrete = new B.StandardMaterial("concrete", scene);
    this.concrete.diffuseColor = B.Color3.FromHexString("#66737b");
    this.concrete.specularColor = new B.Color3(0.05, 0.05, 0.05);
    this.darkConcrete = new B.StandardMaterial("darkConcrete", scene);
    this.darkConcrete.diffuseColor = B.Color3.FromHexString("#4f5a61");
    this.darkConcrete.specularColor = new B.Color3(0.05, 0.05, 0.05);
  }

  /**
   * Mesh source d'un type de bloc. Les blocs teintés ont une source par couleur.
   * Chaque instance a sa propre couleur multiplicative (`instancedBuffers.color`), blanche
   * par défaut : WorldView l'assombrit quand le bloc est abîmé.
   */
  blockSource(type: BlockType, color: string): B.Mesh {
    // Une aile, une gouverne seule : une case aux quatre côtés façonnés (débris, vignettes, pièce à poser)
    if (blockDef(type).aero) return this.surfaceSource(type, color, SIDES_ALONE);
    const key = BLOCK_TYPES[type].tinted ? `${type}${color}` : type;
    let source = this.blockSources.get(key);
    if (!source) {
      const model = BLOCK_MODELS[type];
      if (model) {
        // Un modèle 3D (render/blockModels.ts) : ses couleurs sont celles de ses sommets
        source = model(this.kit, color, `src-${key}`);
      } else {
        const look = BLOCK_LOOKS[type](color);
        const mat = panelMaterial(this.scene, `block-${key}`, panelTexture(this.scene, `t-${key}`, look), look.specular);
        if (look.emissive) mat.emissiveColor = look.emissive;
        const size = BLOCK_SIZE * 0.985;
        const height = blockDef(type).shape === "plate" ? PLATE_THICKNESS : size;
        const shape = blockShape(type);
        if (shape) {
          source = new B.Mesh(`src-${key}`, this.scene);
          shapeVertexData(shape, size / 2).applyToMesh(source);
        } else {
          source = B.MeshBuilder.CreateBox(`src-${key}`, { width: size, height, depth: size }, this.scene);
        }
        source.material = mat;
      }
      source.isVisible = false;
      source.receiveShadows = true;
      // Couleur par instance (le garage assombrit les étages inférieurs) : pas pour un modèle 3D,
      // dont les couleurs sont celles de ses sommets (Babylon ne sait pas mêler les deux sur des
      // instances classiques, et le dessinait blanc). En jeu, les lots d'instances fines ont leur
      // propre teinte d'usure, qui, elle, se mêle aux couleurs de sommets.
      if (!model) {
        source.registerInstancedBuffer(B.VertexBuffer.ColorKind, 4);
        source.instancedBuffers.color = new B.Color4(1, 1, 1, 1);
      }
      this.blockSources.set(key, source);
    }
    return source;
  }

  /**
   * Matière d'une aile ou d'une gouverne (type, couleur du robot) : sa texture se raccorde d'une case
   * à l'autre. Elle sert aux sources par case (garage, aperçus, débris) comme aux pièces fusionnées
   * du jeu (WorldView), dont la couleur d'usure est une couleur de sommets.
   */
  surfaceMaterial(type: BlockType, color: string): B.StandardMaterial {
    const key = BLOCK_TYPES[type].tinted ? `${type}${color}` : type;
    let mat = this.surfaceMaterials.get(key);
    if (!mat) {
      const look = BLOCK_LOOKS[type](color);
      mat = panelMaterial(this.scene, `surface-${key}`, panelTexture(this.scene, `ts-${key}`, look), look.specular);
      this.surfaceMaterials.set(key, mat);
    }
    return mat;
  }

  /**
   * Source d'une case d'aile ou de gouverne, selon son profil (`surfaceSides`, voir
   * shared/robot/surfaces.ts et render/surfaceModels.ts) : au garage et dans les aperçus, des ailes
   * voisines font une seule aile, comme en jeu. Couleur par instance, comme les autres blocs.
   */
  surfaceSource(type: BlockType, color: string, sides: number): B.Mesh {
    const key = `${BLOCK_TYPES[type].tinted ? `${type}${color}` : type}/${sides}`;
    let source = this.surfaceSources.get(key);
    if (!source) {
      const g = surfaceSegment(sides);
      const data = new B.VertexData();
      data.positions = g.positions;
      data.normals = g.normals;
      data.uvs = g.uvs;
      data.indices = g.indices;
      source = new B.Mesh(`src-${key}`, this.scene);
      data.applyToMesh(source);
      source.material = this.surfaceMaterial(type, color);
      source.isVisible = false;
      source.receiveShadows = true;
      source.registerInstancedBuffer(B.VertexBuffer.ColorKind, 4);
      source.instancedBuffers.color = new B.Color4(1, 1, 1, 1);
      this.surfaceSources.set(key, source);
    }
    return source;
  }

  /** Mesh source d'un type de roue : son modèle 3D (render/blockModels.ts), sinon un cylindre et un moyeu. */
  wheelSource(type: WheelType): B.Mesh {
    let source = this.wheelSources.get(type);
    if (!source) {
      const model = WHEEL_MODELS[type];
      source = model
        ? model(this.kit, wheelDef(type), `src-wheel-${type}`)
        : createWheelSource(this.scene, type, wheelDef(type), WHEEL_LOOKS[type].hub, WHEEL_LOOKS[type].tire);
      this.wheelSources.set(type, source);
    }
    return source;
  }

  /**
   * Fourche d'une roue de ce type, dans le repère de son porte-moyeu (elle pivote avec lui) : deux
   * flasques de part et d'autre du pneu, de l'essieu jusqu'au-dessus du pneu (`FORK_TOP`), le
   * dessus, et une tige de `pin` m qui monte vers le bloc (pivot d'une roulette, ou attache d'une
   * roue posée sous un bloc).
   */
  forkSource(type: WheelType, pin: number): B.Mesh {
    return this.model(`fork-${type}-${pin.toFixed(3)}`, () => {
      const { radius, width } = wheelDef(type);
      const top = radius + FORK_TOP;
      const parts: B.Mesh[] = [];
      for (const side of [-1, 1]) {
        const plate = B.MeshBuilder.CreateBox("fork-plate", { width: FORK_PLATE, height: top, depth: 0.1 }, this.scene);
        plate.position.set(side * (width / 2 + FORK_PLATE), top / 2, 0);
        parts.push(plate);
      }
      const bridge = B.MeshBuilder.CreateBox("fork-top", { width: width + 3 * FORK_PLATE, height: FORK_PLATE, depth: 0.12 }, this.scene);
      bridge.position.y = top;
      parts.push(bridge);
      if (pin > 0.005) {
        const stem = B.MeshBuilder.CreateCylinder("fork-pin", { height: pin, diameter: 0.07, tessellation: 10 }, this.scene);
        stem.position.y = top + pin / 2;
        parts.push(stem);
      }
      const fork = B.Mesh.MergeMeshes(parts, true, true);
      if (!fork) throw new Error("Impossible de fusionner la fourche");
      const mat = new B.StandardMaterial(`fork-${type}`, this.scene);
      mat.diffuseColor = B.Color3.FromHexString(ARM_COLOR);
      mat.specularColor = new B.Color3(0.3, 0.3, 0.3);
      fork.material = mat;
      fork.isVisible = false;
      fork.receiveShadows = true;
      return fork;
    });
  }

  /** Bras de direction de longueur `length` (m), le long de l'axe X, centré. */
  steeringArmSource(length: number): B.Mesh {
    return this.model(`arm-${length.toFixed(3)}`, () => {
      const arm = B.MeshBuilder.CreateBox("src-arm", { width: length, height: ARM_SECTION, depth: ARM_SECTION }, this.scene);
      const mat = new B.StandardMaterial("arm", this.scene);
      mat.diffuseColor = B.Color3.FromHexString(ARM_COLOR);
      mat.specularColor = new B.Color3(0.3, 0.3, 0.3);
      arm.material = mat;
      arm.isVisible = false;
      arm.receiveShadows = true;
      return arm;
    });
  }

  turretHeadSource(type: TurretBlockType): B.Mesh {
    const model = HEAD_MODELS[type];
    return this.model(`head-${type}`, () => (model ? model(this.kit, `src-head-${type}`) : createTurretHead(this.scene, type)));
  }

  /**
   * Munitions visibles de la tête d'une tourelle, posées à leurs places sous `head` (elles tournent
   * et reculent avec elle), toutes présentes (le rendu en retire à mesure que le chargeur se vide) ;
   * une liste vide pour une arme qui n'en montre pas.
   */
  addRounds(type: TurretBlockType, head: B.Node): B.InstancedMesh[] {
    const model = HEAD_ROUNDS[type];
    if (!model) return [];
    const rounds = this.roundSources.get(type) ?? model(this.kit, `src-rounds-${type}`);
    this.roundSources.set(type, rounds);
    return rounds.slots.map(([x, y, z]) => {
      const m = rounds.mesh.createInstance("round");
      m.parent = head;
      m.position.set(x, y, z);
      m.isPickable = false;
      return m;
    });
  }

  /** Ce bloc a-t-il un modèle 3D (render/blockModels.ts) plutôt qu'un cube ? Le garage le vise alors par une boîte invisible. */
  hasModel(type: BlockType): boolean {
    return !!BLOCK_MODELS[type];
  }

  /** Boîte invisible de la taille d'une case : ce que vise le garage sur un bloc qui a un modèle 3D. */
  pickBoxSource(): B.Mesh {
    return this.model("pick-box", () => {
      const m = B.MeshBuilder.CreateBox("src-pick-box", { size: BLOCK_SIZE }, this.scene);
      m.isVisible = false;
      return m;
    });
  }

  /**
   * Mesh source d'un accessoire : une dalle a une source par taille (`half`, sa texture se répète
   * au mètre) ; les autres, une par type.
   */
  /** Accessoire (voir `PropModels.source`) ; `char` : bois noirci par le feu. */
  propSource(type: PropType, half: Vec3 | null = null, diamond = false, char: CharLevel = 0): B.Mesh {
    const size = half && propDef(type).shape.kind === "slab" ? half : null;
    const key = (size ? `prop-${type}-${size.x.toFixed(2)},${size.y.toFixed(2)},${size.z.toFixed(2)}${diamond ? "-d" : ""}` : `prop-${type}`) + (char ? `-c${char}` : "");
    return this.model(key, () => this.propModels.source(type, size, diamond, char));
  }

  /** Éclat d'un accessoire, cube de 1 m de sa matière ; celui d'un accessoire peint est l'accessoire en réduction. */
  propShardSource(type: PropType): B.Mesh {
    return this.model(`shard-${type}`, () => this.propModels.shard(type) ?? this.propSource(type));
  }

  projectileSource(look: ProjectileSpec["look"]): B.Mesh {
    return this.model(`projectile-${look}`, () => createProjectileSource(this.scene, look));
  }

  /** Mine, en vol comme posée : chaque sorte a son modèle (render/models/mines.ts). */
  mineSource(weapon: MineWeaponId): B.Mesh {
    return this.model(`mine-${weapon}`, () => MINE_MODELS[weapon].body(this.kit, `src-mine-${weapon}`));
  }

  /** Voyant d'une mine : une petite bille qui brille par elle-même, à la couleur de sa sorte. */
  mineLightSource(weapon: MineWeaponId): B.Mesh {
    const { color, size = 0.06 } = MINE_MODELS[weapon].light;
    return this.model(`mine-light-${color}-${size}`, () => {
      const m = B.MeshBuilder.CreateSphere("src-mine-light", { diameter: size, segments: size > 0.1 ? 10 : 6 }, this.scene);
      const mat = new B.StandardMaterial(`mine-light-${color}`, this.scene);
      mat.emissiveColor = B.Color3.FromHexString(color);
      mat.disableLighting = true;
      m.material = mat;
      m.isVisible = false;
      m.isPickable = false;
      return m;
    });
  }

  fireSource(): B.Mesh {
    return this.model("fire", () => createFireSource(this.scene));
  }

  /** Segment de patte : une barre de longueur 1 le long de z, à étirer. */
  legSegmentSource(): B.Mesh {
    return this.model("leg-segment", () => {
      const m = B.MeshBuilder.CreateBox("src-leg", { width: LEG_THICKNESS, height: LEG_THICKNESS, depth: 1 }, this.scene);
      const mat = new B.StandardMaterial("leg", this.scene);
      mat.diffuseColor = B.Color3.FromHexString("#5a6168");
      mat.specularColor = new B.Color3(0.35, 0.35, 0.35);
      m.material = mat;
      m.isVisible = false;
      m.receiveShadows = true;
      return m;
    });
  }

  /**
   * Le verre allumé n° `index` d'une lumière de robot (`LIGHT_LENSES`, render/models/lights.ts : un
   * phare, une balise, un feu d'avion, un gyrophare, une rampe de police), de la couleur `hex`, dans
   * le repère de son bloc, posé sur son modèle ; une matière émise sans éclairage, que le halo fait
   * rayonner (sa couleur éclaircie au cœur : on la reconnaît sans qu'elle vire au blanc). Le dôme
   * d'un gyrophare est translucide : on voit tourner son miroir dedans.
   */
  lightLensSource(type: BlockType, index: number, hex: string): B.Mesh {
    return this.model(`lens-${type}-${index}-${hex}`, () => {
      const shape = LIGHT_LENSES[type]?.[index];
      if (!shape) throw new Error(`Pas de verre n° ${index} pour ${type}`);
      const [sx, sy, sz] = shape.size;
      let m: B.Mesh;
      if (shape.kind === "disc") {
        m = B.MeshBuilder.CreateCylinder("src-lens", { height: sy, diameter: 1, tessellation: 20 }, this.scene);
        m.scaling.set(sx, 1, sz);
      } else if (shape.kind === "box") {
        m = B.MeshBuilder.CreateBox("src-lens", { width: sx, height: sy, depth: sz }, this.scene);
      } else if (shape.kind === "bead") {
        m = B.MeshBuilder.CreateSphere("src-lens", { diameter: 1, segments: 10 }, this.scene);
        m.scaling.set(sx, sy, sz);
      } else {
        // Un dôme : la moitié haute d'une sphère, de son centre à `sy` au-dessus
        m = B.MeshBuilder.CreateSphere("src-lens", { diameter: 1, segments: 12, slice: 0.5 }, this.scene);
        m.scaling.set(sx, sy * 2, sz);
      }
      m.position.set(shape.at[0], shape.at[1], shape.at[2]);
      m.bakeCurrentTransformIntoVertices();
      const mat = new B.StandardMaterial(`lens-${type}-${index}-${hex}`, this.scene);
      mat.emissiveColor = B.Color3.FromHexString(hex).add(new B.Color3(0.22, 0.22, 0.22));
      mat.disableLighting = true;
      mat.backFaceCulling = shape.kind !== "dome";
      if (type === "rotatingLight" && index === 0) mat.alpha = 0.55;
      m.material = mat;
      m.isVisible = false;
      m.isPickable = false;
      return m;
    });
  }

  /** La nuit : le verre des lampes du décor s'allume, des fenêtres s'éclairent (voir `PropModels.setNight`). */
  setNight(on: boolean): void {
    this.propModels.setNight(on);
  }

  /** Lueur sous un patin anti-gravité : un disque lumineux et translucide. */
  hoverGlowSource(): B.Mesh {
    return this.model("hover-glow", () => {
      const m = B.MeshBuilder.CreateCylinder("src-glow", { height: 0.04, diameter: BLOCK_SIZE * 1.3, tessellation: 20 }, this.scene);
      const mat = new B.StandardMaterial("hover-glow", this.scene);
      mat.emissiveColor = B.Color3.FromHexString("#5fe0ff");
      mat.disableLighting = true;
      mat.alpha = 0.7;
      m.material = mat;
      m.isVisible = false;
      m.isPickable = false;
      return m;
    });
  }

  /**
   * Partie mobile d'une arme de contact (la barre d'une toupie, le bras d'un marteau : voir
   * render/models/melee.ts), dans le repère de son bloc, son origine au moyeu, à l'angle 0.
   */
  meleeSource(id: MeleeId): B.Mesh | null {
    const model = MELEE_MODELS[id];
    // (une hélice tranchante : ses pales sont celles de son moteur, que dessine LocomotionView)
    return model ? this.model(`melee-${id}`, () => model(this.kit, `src-melee-${id}`)) : null;
  }

  /**
   * Autre pièce mobile d'une arme de contact (`MELEE_PIECES`, render/models/melee.ts : la mâchoire du
   * bas, la boule d'un fléau, un maillon de sa chaîne) ; null si l'arme n'en a pas de ce nom.
   */
  meleePieceSource(id: MeleeId, piece: string): B.Mesh | null {
    const model = MELEE_PIECES[id]?.[piece];
    return model ? this.model(`melee-${id}-${piece}`, () => model(this.kit, `src-melee-${id}-${piece}`)) : null;
  }

  /**
   * Disque flou d'un rotor qui tourne vite : un disque translucide de diamètre 1 dans le plan
   * horizontal (son axe le long de y), à l'échelle de la lame, d'acier pâle ; celui d'une lame
   * d'énergie (`MELEE_BLURS`, render/models/meleeEnergy.ts) brille de sa couleur.
   */
  meleeBlurSource(id?: MeleeId): B.Mesh {
    const tint = id ? MELEE_BLURS[id as keyof typeof MELEE_BLURS] : undefined;
    return this.model(tint ? `melee-blur-${id}` : "melee-blur", () => {
      const disc = B.MeshBuilder.CreateCylinder("melee-blur", { height: 1, diameter: 1, tessellation: 40 }, this.scene);
      const mat = new B.StandardMaterial(tint ? `melee-blur-${id}` : "melee-blur", this.scene);
      if (tint) {
        mat.emissiveColor = B.Color3.FromHexString(tint.color);
        mat.disableLighting = true;
        mat.alpha = tint.alpha;
      } else {
        mat.diffuseColor = B.Color3.FromHexString("#aeb6bc");
        mat.specularColor = new B.Color3(0.5, 0.5, 0.5);
        mat.alpha = 0.22;
      }
      mat.backFaceCulling = false;
      mat.disableDepthWrite = true;
      disc.material = mat;
      disc.isVisible = false;
      disc.isPickable = false;
      return disc;
    });
  }

  /**
   * Ce qui brille d'une arme d'énergie (l'arc d'une lame laser, le filament d'un fouet, la pointe
   * d'une lance, le halo d'un champ : `MELEE_GLOWS`), dans le repère de sa partie mobile ; null pour
   * une arme qui ne brille pas.
   */
  meleeGlowSource(id: MeleeId): B.Mesh | null {
    const build = MELEE_GLOWS[id as keyof typeof MELEE_GLOWS];
    if (!build) return null;
    return this.model(`melee-glow-${id}`, () => build(this.kit, this.scene, `src-melee-glow-${id}`));
  }

  /** Hampe d'une lance : un cylindre d'acier de longueur 1 le long de +z, de l'origine à z = 1 (à étirer jusqu'à sa tête). */
  meleeShaftSource(): B.Mesh {
    return this.model("melee-shaft", () => this.kit.fuse([
      this.kit.cylinder("#9aa2a8", 1, LANCE_SHAFT, LANCE_SHAFT, [0, 0, 0.5], "z", 10),
    ], "src-melee-shaft", { specular: 0.6 }));
  }

  /**
   * Pales d'un moteur, de cette sorte (`BLADES` : leur diamètre est celui que réserve leur
   * encombrement), dans le plan horizontal de leur repère, à poser `BLADES[kind].offset` m au-dessus
   * de la face du bloc vers laquelle il pousse.
   */
  bladeSource(kind: BladeKind): B.Mesh {
    return kind === "propeller" ? this.propellerSource() : kind === "tail" ? this.tailBladesSource() : this.bladesSource();
  }

  /** Pales d'un rotor orientable : deux pales croisées et un moyeu, dans le plan horizontal. */
  bladesSource(): B.Mesh {
    return this.model("blades", () => {
      const mat = new B.StandardMaterial("blades", this.scene);
      mat.diffuseColor = B.Color3.FromHexString("#2a2e33");
      mat.specularColor = new B.Color3(0.3, 0.3, 0.3);
      const span = BLADES.rotor.diameter;
      const a = B.MeshBuilder.CreateBox("blade", { width: span, height: BLADES.rotor.thickness, depth: 0.22 }, this.scene);
      const b = B.MeshBuilder.CreateBox("blade", { width: 0.22, height: BLADES.rotor.thickness, depth: span }, this.scene);
      const hub = B.MeshBuilder.CreateCylinder("hub", { height: 0.18, diameter: 0.3, tessellation: 12 }, this.scene);
      for (const m of [a, b, hub]) m.material = mat;
      const merged = B.Mesh.MergeMeshes([a, b, hub], true, true, undefined, false, false);
      if (!merged) throw new Error("Impossible de construire les pales");
      merged.isVisible = false;
      merged.isPickable = false;
      return merged;
    });
  }

  /**
   * Hélice d'avion : trois pales autour d'un cône, jusqu'au bord du disque qu'elle réserve
   * (`BLADES.propeller`), dans le plan horizontal (elles tournent autour de y, l'axe de poussée) ;
   * bouts peints, pour qu'on les voie tourner.
   */
  propellerSource(): B.Mesh {
    return this.model("propeller", () => {
      const mat = new B.StandardMaterial("propeller", this.scene);
      mat.diffuseColor = B.Color3.FromHexString("#23262a");
      mat.specularColor = new B.Color3(0.35, 0.35, 0.35);
      const tipMat = new B.StandardMaterial("propeller-tips", this.scene);
      tipMat.diffuseColor = B.Color3.FromHexString("#f0bd2c");
      const parts: B.Mesh[] = [];
      // Du pied (2,5 cm de l'axe) au bout de la pale
      const reach = BLADES.propeller.diameter / 2;
      for (let i = 0; i < 3; i++) {
        const angle = (i * Math.PI * 2) / 3;
        const blade = B.MeshBuilder.CreateBox("prop-blade", { width: reach - 0.025, height: 0.03, depth: 0.16 }, this.scene);
        blade.position.x = (reach + 0.025) / 2;
        blade.rotation.x = 0.25; // calage
        blade.bakeCurrentTransformIntoVertices();
        blade.rotation.y = angle;
        blade.bakeCurrentTransformIntoVertices();
        blade.material = mat;
        const tip = B.MeshBuilder.CreateBox("prop-tip", { width: 0.12, height: 0.035, depth: 0.165 }, this.scene);
        tip.position.x = reach - 0.055;
        tip.rotation.x = 0.25;
        tip.bakeCurrentTransformIntoVertices();
        tip.rotation.y = angle;
        tip.bakeCurrentTransformIntoVertices();
        tip.material = tipMat;
        parts.push(blade, tip);
      }
      const spinner = B.MeshBuilder.CreateCylinder("prop-spinner", { height: 0.34, diameterTop: 0, diameterBottom: 0.3, tessellation: 14 }, this.scene);
      spinner.position.y = 0.1;
      spinner.bakeCurrentTransformIntoVertices();
      const spinnerMat = new B.StandardMaterial("prop-spinner", this.scene);
      spinnerMat.diffuseColor = B.Color3.FromHexString("#c9ced2");
      spinnerMat.specularColor = new B.Color3(0.6, 0.6, 0.6);
      spinner.material = spinnerMat;
      const merged = B.Mesh.MergeMeshes([...parts, spinner], true, true, undefined, false, true);
      if (!merged) throw new Error("Impossible de construire l'hélice");
      merged.isVisible = false;
      merged.isPickable = false;
      return merged;
    });
  }

  /**
   * Nacelle de turboréacteur, le long de y (l'axe de poussée) : un fût qui dépasse de son bloc
   * devant et derrière, l'entrée d'air (sombre, une lèvre claire) vers +y, la tuyère vers -y ; ses
   * cotes sont celles de son encombrement (`JET_NACELLE`).
   */
  jetNacelleSource(): B.Mesh {
    const { radius, intake: front, nozzle: back } = JET_NACELLE;
    return this.model("jet-nacelle", () => {
      const body = new B.StandardMaterial("jet-body", this.scene);
      body.diffuseColor = B.Color3.FromHexString("#8a9096");
      body.specularColor = new B.Color3(0.6, 0.6, 0.6);
      const dark = new B.StandardMaterial("jet-dark", this.scene);
      dark.diffuseColor = B.Color3.FromHexString("#15171a");
      const nozzle = new B.StandardMaterial("jet-nozzle", this.scene);
      nozzle.diffuseColor = B.Color3.FromHexString("#4a3b30");
      nozzle.emissiveColor = B.Color3.FromHexString("#3a1a08");
      const hull = B.MeshBuilder.CreateCylinder("jet-hull", { height: 0.8, diameter: 2 * radius, tessellation: 18 }, this.scene);
      hull.material = body;
      // La lèvre de l'entrée d'air : son bord avant est le bout de la nacelle
      const lip = B.MeshBuilder.CreateTorus("jet-lip", { diameter: 2 * radius - 0.04, thickness: 0.06, tessellation: 18 }, this.scene);
      lip.position.y = front - 0.03;
      lip.bakeCurrentTransformIntoVertices();
      lip.material = body;
      const intake = B.MeshBuilder.CreateCylinder("jet-intake", { height: 0.02, diameter: 2 * radius - 0.1, tessellation: 18 }, this.scene);
      intake.position.y = front - 0.035;
      intake.bakeCurrentTransformIntoVertices();
      intake.material = dark;
      // La tuyère : son bout arrière est celui de la nacelle, d'où part la flamme
      const cone = B.MeshBuilder.CreateCylinder("jet-cone", { height: 0.28, diameterTop: 0.44, diameterBottom: 0.34, tessellation: 18 }, this.scene);
      cone.position.y = -(back - 0.14);
      cone.bakeCurrentTransformIntoVertices();
      cone.material = nozzle;
      const merged = B.Mesh.MergeMeshes([hull, lip, intake, cone], true, true, undefined, false, true);
      if (!merged) throw new Error("Impossible de construire la nacelle");
      merged.isVisible = false;
      merged.isPickable = false;
      merged.receiveShadows = true;
      return merged;
    });
  }

  /**
   * Flamme de postcombustion : un cœur bleu-blanc dans une enveloppe orange, cônes de hauteur 1
   * le long de y, pointe vers -y (à étirer selon la poussée).
   */
  jetFlameSource(): B.Mesh {
    return this.model("jet-flame", () => {
      const outer = B.MeshBuilder.CreateCylinder("jet-flame-outer", { height: 1, diameterTop: 0.4, diameterBottom: 0.02, tessellation: 14 }, this.scene);
      const outerMat = new B.StandardMaterial("jet-flame-outer", this.scene);
      outerMat.emissiveColor = B.Color3.FromHexString("#ff9a3a");
      outerMat.disableLighting = true;
      outerMat.alpha = 0.55;
      outer.material = outerMat;
      const core = B.MeshBuilder.CreateCylinder("jet-flame-core", { height: 0.7, diameterTop: 0.22, diameterBottom: 0.02, tessellation: 12 }, this.scene);
      core.position.y = 0.15;
      core.bakeCurrentTransformIntoVertices();
      const coreMat = new B.StandardMaterial("jet-flame-core", this.scene);
      coreMat.emissiveColor = B.Color3.FromHexString("#bfe6ff");
      coreMat.disableLighting = true;
      coreMat.alpha = 0.85;
      core.material = coreMat;
      const merged = B.Mesh.MergeMeshes([outer, core], true, true, undefined, false, true);
      if (!merged) throw new Error("Impossible de construire la flamme");
      merged.isVisible = false;
      merged.isPickable = false;
      return merged;
    });
  }

  /**
   * Allure des flammes des moteurs (réglage graphique) : en effets réalistes, leurs sources sont
   * des cônes sans fond dessinés par un shader (`flameFor`, `jetFlameFor`).
   */
  setFlameLook(look: FxLook): void {
    this.flameLook = look;
  }

  /** La source de la flamme d'un réacteur ou d'un propulseur, dans l'allure du moment. */
  flameFor(): B.Mesh {
    return this.flameLook === "realistic" ? this.flameFxSource(false) : this.flame;
  }

  /** La source de la flamme d'un turboréacteur, dans l'allure du moment. */
  jetFlameFor(): B.Mesh {
    return this.flameLook === "realistic" ? this.flameFxSource(true) : this.jetFlameSource();
  }

  /**
   * Flamme en effets réalistes : un cône ouvert (pointe vers -y, de hauteur 1, sans fond : un
   * disque plein à la tuyère se verrait), dont le shader fait le feu (render/fx/flames.ts) ; celle
   * d'un turboréacteur (`jet`) a un cœur bleuté et ses anneaux de choc.
   */
  flameFxSource(jet: boolean): B.Mesh {
    return this.model(jet ? "jet-flame-fx" : "flame-fx", () => {
      const top = jet ? 0.42 : BLOCK_SIZE * 0.7;
      const m = B.MeshBuilder.CreateCylinder(jet ? "jet-flame-fx" : "flame-fx", { height: 1, diameterTop: top, diameterBottom: 0.02, tessellation: 18, subdivisions: 4, cap: B.Mesh.NO_CAP }, this.scene);
      m.material = flameMaterial(this.scene, jet);
      m.isVisible = false;
      m.isPickable = false;
      return m;
    });
  }

  /** Hélice de rotor de queue : deux pales fines autour d'un moyeu, qui tournent autour de y. */
  tailBladesSource(): B.Mesh {
    return this.model("tail-blades", () => {
      const mat = new B.StandardMaterial("tail-blades", this.scene);
      mat.diffuseColor = B.Color3.FromHexString("#2a2e33");
      mat.specularColor = new B.Color3(0.3, 0.3, 0.3);
      const blade = B.MeshBuilder.CreateBox("tail-blade", { width: BLADES.tail.diameter, height: 0.025, depth: 0.11 }, this.scene);
      // Bouts des pales peints : on voit tourner l'hélice
      const tipMat = new B.StandardMaterial("tail-tips", this.scene);
      tipMat.diffuseColor = B.Color3.FromHexString("#f0bd2c");
      const tips = [-1, 1].map((s) => {
        const tip = B.MeshBuilder.CreateBox("tail-tip", { width: 0.12, height: 0.03, depth: 0.115 }, this.scene);
        tip.position.x = s * 0.51;
        tip.material = tipMat;
        return tip;
      });
      const hub = B.MeshBuilder.CreateCylinder("tail-hub", { height: 0.12, diameter: 0.16, tessellation: 10 }, this.scene);
      for (const m of [blade, hub]) m.material = mat;
      const merged = B.Mesh.MergeMeshes([blade, hub, ...tips], true, true, undefined, false, true);
      if (!merged) throw new Error("Impossible de construire l'hélice de queue");
      merged.isVisible = false;
      merged.isPickable = false;
      return merged;
    });
  }

  /**
   * Patin de chenille pour une bande de `width` m, ses guides en `horns` (en x, depuis le milieu de
   * la bande) : un par largeur de bande et disposition des galets (render/models/tracks.ts).
   */
  trackShoeSource(width: number, horns: readonly number[]): B.Mesh {
    const key = `shoe-${width.toFixed(3)}-${horns.map((x) => x.toFixed(3)).join("/")}`;
    return this.model(key, () => trackShoe(this.kit, width, horns, `src-${key}`));
  }

  /** Barbotin denté, qui habille le galet arrière d'une chenille de ce type (render/models/tracks.ts). */
  sprocketSource(type: WheelType): B.Mesh {
    return this.model(`sprocket-${type}`, () => sprocket(this.kit, wheelDef(type), `src-sprocket-${type}`));
  }

  /** Matériau des bandes de chenilles immobiles (garage, aperçu du choix du robot) : une texture pour toutes, qui ne défile pas. */
  stillBeltMaterial(): B.StandardMaterial {
    if (!this.stillBelt) {
      const mat = new B.StandardMaterial("still-belt", this.scene);
      mat.diffuseTexture = this.treadTexture();
      mat.specularColor = new B.Color3(0.08, 0.08, 0.08);
      mat.backFaceCulling = false;
      this.stillBelt = mat;
    }
    return this.stillBelt;
  }

  /** Texture de bande de chenille (neuve à chaque appel : chaque bande la fait défiler à sa vitesse). */
  treadTexture(): B.DynamicTexture {
    const t = new B.DynamicTexture("tread", { width: 64, height: 64 }, this.scene, true);
    const c = context2d(t);
    c.fillStyle = "#26292c";
    c.fillRect(0, 0, 64, 64);
    c.fillStyle = "#14161a";
    for (const y of [4, 36]) c.fillRect(0, y, 64, 18);
    c.fillStyle = "#3a3e42";
    c.fillRect(0, 0, 6, 64);
    c.fillRect(58, 0, 6, 64);
    t.update();
    t.wrapU = B.Texture.WRAP_ADDRESSMODE;
    t.wrapV = B.Texture.WRAP_ADDRESSMODE;
    return t;
  }

  private model(key: string, build: () => B.Mesh): B.Mesh {
    let source = this.models.get(key);
    if (!source) {
      source = build();
      this.models.set(key, source);
    }
    return source;
  }
}

/** Roue : pneu et moyeu fusionnés, essieu le long de X. */
function createWheelSource(scene: B.Scene, key: string, def: WheelTypeDef, hubColor: string, tireColor: string): B.Mesh {
  const { radius, width } = def;
  const tire = B.MeshBuilder.CreateCylinder("tire", { height: width, diameter: radius * 2, tessellation: 28 }, scene);
  const hub = B.MeshBuilder.CreateCylinder("hub", { height: width + 0.02, diameter: radius * 0.9, tessellation: 6 }, scene);
  const tireMat = new B.StandardMaterial(`tire-${key}`, scene);
  tireMat.diffuseColor = B.Color3.FromHexString(tireColor);
  tireMat.specularColor = new B.Color3(0.05, 0.05, 0.05);
  const hubMat = new B.StandardMaterial(`hub-${key}`, scene);
  hubMat.diffuseColor = B.Color3.FromHexString(hubColor);
  hubMat.specularColor = new B.Color3(0.4, 0.4, 0.4);
  tire.material = tireMat;
  hub.material = hubMat;
  const merged = B.Mesh.MergeMeshes([tire, hub], true, true, undefined, false, true);
  if (!merged) throw new Error("Impossible de fusionner le mesh de la roue");
  merged.rotation.z = Math.PI / 2;
  merged.bakeCurrentTransformIntoVertices();
  merged.isVisible = false;
  merged.receiveShadows = true;
  return merged;
}
