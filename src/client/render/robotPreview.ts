import * as B from "../babylon";
import { wheelDef } from "../../shared/catalog/wheels";
import { BLOCK_SIZE } from "../../shared/config";
import { cross, quatFromBasis } from "../../shared/math/vec";
import { designZones, solidBounds } from "../../shared/design/clearance";
import { designCenterOfMass } from "../../shared/design/flight";
import { AXES, cellKey, DEFAULT_FACING, wheelLocalPos, type RobotDesign } from "../../shared/design/robotDesign";
import { designSurfaceSides } from "../../shared/robot/surfaces";
import { stillBelts } from "./belts";
import { Assets } from "./materials";
import { stillBlockParts, stillWheelParts } from "./stillParts";

/** Vitesse de rotation de l'aperçu (rad/s), et pause après que le joueur l'a tourné à la souris (s). */
const SPIN = 0.45;
const SPIN_PAUSE = 3;
/**
 * Champ de vision vertical de la caméra (rad), et distance de la caméra, en part de celle où la
 * sphère englobante du robot tiendrait tout juste dans l'image (plus près : elle est prudente, le
 * robot remplit mieux l'aperçu, et ne sort pas du cadre en tournant).
 */
const FOV = 0.7;
const FRAMING = 0.8;
/** Part de l'image (en hauteur et en largeur) que la boîte englobante du robot occupe au plus. */
const FIT_MARGIN = 0.92;

/**
 * Distance de la caméra (au milieu de la boîte englobante `min`–`max`) à laquelle la boîte tient
 * dans l'image, sous tous les angles où l'aperçu tourne (`beta` : la hauteur de la caméra ; `aspect` :
 * largeur sur hauteur de l'image).
 */
function fitDistance(min: B.Vector3, max: B.Vector3, beta: number, aspect: number): number {
  const c = B.Vector3.Center(min, max);
  const tanV = Math.tan(FOV / 2) * FIT_MARGIN;
  const tanH = tanV * aspect;
  let need = 0;
  for (let k = 0; k < 16; k++) {
    const alpha = (k / 16) * Math.PI * 2;
    // Une caméra orbitale est en target + r·(cos α sin β, cos β, sin α sin β)
    const dir = new B.Vector3(Math.cos(alpha) * Math.sin(beta), Math.cos(beta), Math.sin(alpha) * Math.sin(beta));
    const right = B.Vector3.Cross(B.Vector3.Up(), dir).normalize();
    const up = B.Vector3.Cross(dir, right).normalize();
    for (const x of [min.x, max.x]) {
      for (const y of [min.y, max.y]) {
        for (const z of [min.z, max.z]) {
          const p = new B.Vector3(x - c.x, y - c.y, z - c.z);
          const toward = B.Vector3.Dot(p, dir);
          need = Math.max(need, toward + Math.abs(B.Vector3.Dot(p, up)) / tanV, toward + Math.abs(B.Vector3.Dot(p, right)) / tanH);
        }
      }
    }
  }
  return need;
}

/**
 * Aperçu 3D d'un robot (écran de choix du robot) : il tourne lentement sur un socle, on peut le
 * faire tourner à la souris ou au doigt. Son propre moteur Babylon, sur son propre canvas : le jeu
 * continue derrière le menu sur le sien. Créé au premier robot montré, libéré par `dispose` (le
 * contexte WebGL aussi) : une seule scène à la fois, seulement tant que l'écran est ouvert.
 */
export class RobotPreview {
  readonly canvas = document.createElement("canvas");
  private engine: B.Engine | null = null;
  private scene: B.Scene | null = null;
  private camera: B.ArcRotateCamera | null = null;
  private assets: Assets | null = null;
  private socle: B.Mesh | null = null;
  private meshes: B.AbstractMesh[] = [];
  private resize: ResizeObserver | null = null;
  /** Robot montré (clé donnée par l'appelant), pour ne pas le redessiner à l'identique. */
  private shown: string | null = null;
  /** Le joueur a tourné l'aperçu : il ne tourne plus tout seul jusqu'à ce moment (s, horloge de la page). */
  private heldUntil = 0;

  constructor() {
    this.canvas.className = "rp-canvas";
    this.canvas.setAttribute("aria-hidden", "true");
    this.canvas.addEventListener("pointerdown", () => (this.heldUntil = Infinity));
    const release = (): void => {
      if (this.heldUntil === Infinity) this.heldUntil = performance.now() / 1000 + SPIN_PAUSE;
    };
    this.canvas.addEventListener("pointerup", release);
    this.canvas.addEventListener("pointerleave", release);
  }

  /**
   * Montre ce robot (`key` le désigne : même clé, rien à refaire). `distance` éloigne la caméra
   * (une pièce seule, avec son canon, sortait du cadre).
   */
  show(key: string, design: RobotDesign, color: string, distance = 1): void {
    if (key === this.shown && this.engine) return;
    this.start();
    const assets = this.assets!;
    for (const m of this.meshes) if (!m.isDisposed()) m.dispose(); // (les enfants partent avec leur parent)
    this.meshes = [];
    this.shown = key;

    // Blocs, et ce qui en dépasse (têtes de tourelle, pales, nacelles, pattes), roues et leurs
    // ferrures, chenilles, comme au garage ; et l'encombrement, pour le cadrage
    const min = new B.Vector3(Infinity, Infinity, Infinity);
    const max = new B.Vector3(-Infinity, -Infinity, -Infinity);
    const extend = (x: number, y: number, z: number, r: number): void => {
      min.minimizeInPlaceFromFloats(x - r, y - r, z - r);
      max.maximizeInPlaceFromFloats(x + r, y + r, z + r);
    };
    const com = designCenterOfMass(design);
    // Ailes et gouvernes voisines : une seule aile, comme en jeu
    const surfaces = designSurfaceSides(design.blocks);
    for (const b of design.blocks) {
      const f = b.facing ?? DEFAULT_FACING;
      const up = AXES[f.up];
      const forward = AXES[f.forward];
      const q = quatFromBasis(cross(up, forward), up, forward);
      const sides = surfaces.get(cellKey(b.x, b.y, b.z));
      const source = sides === undefined ? assets.blockSource(b.type, color) : assets.surfaceSource(b.type, color, sides);
      const mesh = source.createInstance("preview-block");
      mesh.position.set(b.x * BLOCK_SIZE, b.y * BLOCK_SIZE, b.z * BLOCK_SIZE);
      mesh.rotationQuaternion = new B.Quaternion(q.x, q.y, q.z, q.w);
      this.meshes.push(mesh, ...stillBlockParts(assets, b, mesh, com));
      extend(mesh.position.x, mesh.position.y, mesh.position.z, BLOCK_SIZE / 2);
    }
    for (const w of design.wheels) {
      const p = wheelLocalPos(w);
      const mesh = assets.wheelSource(w.type).createInstance("preview-wheel");
      mesh.position.set(p.x, p.y, p.z);
      this.meshes.push(mesh, ...stillWheelParts(assets, w));
      extend(p.x, p.y, p.z, wheelDef(w.type).radius);
    }
    // Ce qui dépasse des blocs compte dans le cadrage : une hélice de 2 m ne sort pas de l'image
    for (const zone of designZones(design)) {
      for (const s of zone.solids) {
        const bounds = solidBounds(s);
        min.minimizeInPlaceFromFloats(bounds.min.x, bounds.min.y, bounds.min.z);
        max.maximizeInPlaceFromFloats(bounds.max.x, bounds.max.y, bounds.max.z);
      }
    }
    // Chenilles : la bande et ses patins autour des galets, et le barbotin, comme au garage
    for (const belt of stillBelts("preview-belt", this.scene!, assets, design.wheels)) this.meshes.push(belt.band, ...belt.sprockets);
    if (!this.meshes.length) return;

    // Cadrage : la caméra vise le milieu, assez loin pour que la sphère englobante tienne dans
    // l'image, et plus loin si la boîte englobante en sortirait (un robot haut sur pattes)
    const center = B.Vector3.Center(min, max);
    const radius = Math.max(0.6, B.Vector3.Distance(min, max) / 2);
    const camera = this.camera!;
    camera.target.copyFrom(center);
    const aspect = this.canvas.clientWidth > 0 && this.canvas.clientHeight > 0 ? this.canvas.clientWidth / this.canvas.clientHeight : 2;
    camera.radius = Math.max((radius / Math.sin(FOV / 2)) * FRAMING, fitDistance(min, max, camera.beta, aspect)) * distance;
    camera.lowerRadiusLimit = camera.radius * 0.5;
    camera.upperRadiusLimit = camera.radius * 1.8;
    const socle = this.socle!;
    socle.position.set(center.x, min.y - 0.03, center.z);
    socle.scaling.set(radius * 1.25, 1, radius * 1.25);
  }

  /** Crée le moteur et la scène au premier robot montré. */
  private start(): void {
    if (this.engine) return;
    const engine = new B.Engine(this.canvas, true, { stencil: false, alpha: true, loseContextOnDispose: true }, true);
    const scene = new B.Scene(engine);
    scene.useRightHandedSystem = true;
    scene.clearColor = new B.Color4(0, 0, 0, 0);
    scene.ambientColor = new B.Color3(0.3, 0.32, 0.35);
    const hemi = new B.HemisphericLight("hemi", new B.Vector3(0.2, 1, -0.1), scene);
    hemi.intensity = 0.75;
    const sun = new B.DirectionalLight("sun", new B.Vector3(0.45, -1, -0.5).normalize(), scene);
    sun.intensity = 0.95;
    // De l'avant droit, un peu d'en haut, comme la vignette
    const camera = new B.ArcRotateCamera("preview-cam", -Math.PI / 2 + 0.75, 1.1, 8, B.Vector3.Zero(), scene);
    camera.fov = FOV;
    camera.minZ = 0.05;
    camera.lowerBetaLimit = 0.25;
    camera.upperBetaLimit = 1.55;
    camera.wheelPrecision = 60;
    camera.panningSensibility = 0;
    camera.attachControl(true);
    const socle = B.MeshBuilder.CreateCylinder("socle", { height: 0.06, diameter: 2, tessellation: 48 }, scene);
    const mat = new B.StandardMaterial("socle", scene);
    mat.diffuseColor = B.Color3.FromHexString("#3a444c");
    mat.specularColor = new B.Color3(0.08, 0.08, 0.08);
    mat.alpha = 0.85;
    socle.material = mat;
    socle.isPickable = false;

    this.engine = engine;
    this.scene = scene;
    this.camera = camera;
    this.assets = new Assets(scene);
    this.socle = socle;
    engine.runRenderLoop(() => {
      if (performance.now() / 1000 > this.heldUntil) camera.alpha += SPIN * Math.min(engine.getDeltaTime() / 1000, 0.1);
      scene.render();
    });
    this.resize = new ResizeObserver(() => engine.resize());
    this.resize.observe(this.canvas);
  }

  /** Libère la scène, le moteur et son contexte WebGL (on quitte l'écran). */
  dispose(): void {
    this.resize?.disconnect();
    this.resize = null;
    this.engine?.stopRenderLoop();
    this.scene?.dispose();
    this.engine?.dispose();
    this.engine = null;
    this.scene = null;
    this.camera = null;
    this.assets = null;
    this.socle = null;
    this.meshes = [];
    this.shown = null;
  }
}
