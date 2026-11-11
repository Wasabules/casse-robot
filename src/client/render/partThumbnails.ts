import * as B from "../babylon";
import { blockDef } from "../../shared/catalog/blocks";
import { wheelDef } from "../../shared/catalog/wheels";
import { BLOCK_SIZE } from "../../shared/config";
import { blockZones, solidBounds } from "../../shared/design/clearance";
import type { Part } from "../../shared/design/progression";
import { vec3 } from "../../shared/math/vec";
import { Assets } from "./materials";
import { stillBlockParts } from "./stillParts";

/** Côté d'une vignette (px), et nombre de vignettes faites au plus par image (le garage reste fluide). */
const SIZE = 112;
const PER_FRAME = 4;
/** Au-delà de ce nombre d'images à attendre ses matériaux, on prend la vignette telle quelle. */
const MAX_WAIT = 40;

/** Vignettes déjà faites, gardées d'une ouverture du garage à l'autre (clé : pièce et couleur). */
const CACHE = new Map<string, string>();

interface Job {
  part: Part;
  color: string;
  key: string;
  done: (url: string) => void;
}

/**
 * Vignettes des pièces de l'inventaire du garage : chaque pièce rendue une fois en 3D (de trois
 * quarts, un peu d'en haut, fond transparent), puis gardée en image. Un petit moteur Babylon à
 * part, sur un canvas hors de la page, qui ne tourne que tant qu'il reste des vignettes à faire, et
 * que `dispose` libère (son contexte WebGL aussi). Un bloc qui prend la couleur du robot a une
 * vignette par couleur.
 */
export class PartThumbnails {
  private engine: B.Engine | null = null;
  private scene: B.Scene | null = null;
  private camera: B.ArcRotateCamera | null = null;
  private assets: Assets | null = null;
  private readonly queue: Job[] = [];
  private current: { job: Job; meshes: B.AbstractMesh[]; waited: number } | null = null;
  private frame = 0;

  /** Vignette de la pièce : tout de suite si elle est faite, sinon `done` la recevra (et null est rendu). */
  get(part: Part, color: string, done: (url: string) => void): string | null {
    const key = thumbKey(part, color);
    const known = CACHE.get(key);
    if (known) return known;
    this.queue.push({ part, color, key, done });
    if (!this.frame) this.frame = requestAnimationFrame(() => this.pump());
    return null;
  }

  /** Oublie les vignettes demandées (l'inventaire se redessine) : elles seront redemandées. */
  cancel(): void {
    this.queue.length = 0;
  }

  dispose(): void {
    this.queue.length = 0;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.current = null;
    this.scene?.dispose();
    this.engine?.dispose();
    this.engine = null;
    this.scene = null;
    this.camera = null;
    this.assets = null;
  }

  /** Fait quelques vignettes, puis revient à l'image suivante tant qu'il en reste. */
  private pump(): void {
    this.frame = 0;
    this.start();
    for (let made = 0; made < PER_FRAME; ) {
      if (!this.current) {
        const job = this.queue.shift();
        if (!job) break;
        // Déjà faite entre-temps (demandée deux fois)
        const known = CACHE.get(job.key);
        if (known) {
          job.done(known);
          continue;
        }
        this.current = { job, meshes: this.build(job), waited: 0 };
      }
      const cur = this.current;
      // Les matériaux se compilent en arrière-plan : on attend qu'ils soient prêts
      if (!this.scene!.isReady() && cur.waited++ < MAX_WAIT) break;
      this.scene!.render();
      const url = this.engine!.getRenderingCanvas()!.toDataURL("image/png");
      CACHE.set(cur.job.key, url);
      for (const m of cur.meshes) if (!m.isDisposed()) m.dispose(); // (les enfants partent avec leur parent)
      this.current = null;
      cur.job.done(url);
      made++;
    }
    if (this.current || this.queue.length) this.frame = requestAnimationFrame(() => this.pump());
  }

  /**
   * Pose la pièce au milieu de la scène, avec ce que le jeu dessine autour d'elle (tête de tourelle,
   * pales, nacelle, patte…), et cadre la caméra sur le tout (son encombrement : une hélice de 2 m
   * tient dans la vignette).
   */
  private build(job: Job): B.AbstractMesh[] {
    const assets = this.assets!;
    const meshes: B.AbstractMesh[] = [];
    const h = BLOCK_SIZE / 2;
    let min = vec3(-h, -h, -h);
    let max = vec3(h, h, h);
    if (job.part.kind === "block") {
      const mesh = assets.blockSource(job.part.type, job.color).createInstance("thumb-block");
      const block = { x: 0, y: 0, z: 0, type: job.part.type };
      meshes.push(mesh, ...stillBlockParts(assets, block, mesh, vec3(0, 0, 0)));
      for (const s of blockZones(block).flatMap((z) => z.solids)) {
        const b = solidBounds(s);
        min = vec3(Math.min(min.x, b.min.x), Math.min(min.y, b.min.y), Math.min(min.z, b.min.z));
        max = vec3(Math.max(max.x, b.max.x), Math.max(max.y, b.max.y), Math.max(max.z, b.max.z));
      }
    } else {
      const def = wheelDef(job.part.type);
      meshes.push(assets.wheelSource(job.part.type).createInstance("thumb-wheel"));
      const r = Math.max(def.radius, def.width / 2) * 1.15;
      min = vec3(-r, -r, -r);
      max = vec3(r, r, r);
    }
    // La sphère qui englobe le tout, au milieu de l'image
    const camera = this.camera!;
    const radius = Math.hypot(max.x - min.x, max.y - min.y, max.z - min.z) / 2;
    camera.target.set((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
    camera.radius = radius / Math.sin(camera.fov / 2);
    return meshes;
  }

  /** Crée le moteur et la scène à la première vignette demandée. */
  private start(): void {
    if (this.engine) return;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = SIZE;
    const engine = new B.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: false, alpha: true, loseContextOnDispose: true }, false);
    const scene = new B.Scene(engine);
    scene.useRightHandedSystem = true;
    scene.clearColor = new B.Color4(0, 0, 0, 0);
    scene.ambientColor = new B.Color3(0.32, 0.34, 0.37);
    const hemi = new B.HemisphericLight("hemi", new B.Vector3(0.2, 1, -0.1), scene);
    hemi.intensity = 0.8;
    const sun = new B.DirectionalLight("sun", new B.Vector3(0.45, -1, -0.5).normalize(), scene);
    sun.intensity = 0.95;
    // De l'avant gauche, un peu d'en haut : on voit le dessus, l'avant et un flanc
    const camera = new B.ArcRotateCamera("thumb-cam", Math.PI / 2 - 0.7, 1.05, 2, B.Vector3.Zero(), scene);
    camera.fov = 0.6;
    camera.minZ = 0.02;
    this.engine = engine;
    this.scene = scene;
    this.camera = camera;
    this.assets = new Assets(scene);
  }
}

/** Clé d'une vignette : la pièce, et la couleur si elle prend celle du robot. */
function thumbKey(part: Part, color: string): string {
  const tinted = part.kind === "block" && blockDef(part.type).tinted;
  return `${part.kind}:${part.type}:${tinted ? color : ""}`;
}
