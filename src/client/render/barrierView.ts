import * as B from "../babylon";
import type { Barrier, Team } from "../../shared/sim/entities";
import type { SimEvent } from "../../shared/sim/events";
import type { World } from "../../shared/sim/world";

/** Le mur se déploie en DEPLOY_TIME s (il monte du sol), et s'efface en FADE_TIME s. */
const DEPLOY_TIME = 0.25;
const FADE_TIME = 0.35;
/** Opacité : à pleine charge, à vide, et l'éclat d'un tir encaissé (qui retombe en FLASH_TIME s). */
const ALPHA_FULL = 0.34;
const ALPHA_LOW = 0.14;
const FLASH = 0.35;
const FLASH_TIME = 0.18;
const TEAM_COLORS: Record<Team, string> = { blue: "#5fb8ff", red: "#ff7a6a" };

interface WallMeshes {
  barrier: Barrier;
  root: B.TransformNode;
  material: B.StandardMaterial;
  born: number;
  flash: number;
  /** Instant (horloge de la page) où il a commencé à s'effacer, ou null. */
  fading: number | null;
}

/**
 * Murs d'énergie (voir combat/barriers.ts) : un panneau translucide à motif d'alvéoles, de la
 * couleur de son équipe, bordé d'un cadre lumineux. Il monte du sol en se déployant, s'éclaire à
 * chaque tir encaissé, pâlit en perdant ses points (et grésille à la fin), puis s'efface.
 */
export class BarrierView {
  private readonly scene: B.Scene;
  private readonly walls = new Map<number, WallMeshes>();
  private readonly textures = new Map<Team, B.DynamicTexture>();
  private readonly unsubscribe: () => void;

  constructor(world: World, scene: B.Scene) {
    this.scene = scene;
    this.unsubscribe = world.on((e) => this.onEvent(e));
  }

  sync(): void {
    const now = performance.now() / 1000;
    for (const [id, w] of this.walls) {
      const grow = Math.min(1, (now - w.born) / DEPLOY_TIME);
      const fade = w.fading === null ? 1 : 1 - (now - w.fading) / FADE_TIME;
      if (fade <= 0) {
        this.dispose1(id);
        continue;
      }
      w.flash = Math.max(0, w.flash - FLASH / FLASH_TIME * this.scene.getEngine().getDeltaTime() / 1000);
      const ratio = Math.max(0, w.barrier.hp / w.barrier.maxHp);
      // Presque brisé : il grésille
      const flicker = ratio < 0.3 ? 0.6 + 0.4 * Math.sin(now * 40) : 1;
      w.material.alpha = ((ALPHA_LOW + (ALPHA_FULL - ALPHA_LOW) * ratio) * flicker + w.flash) * fade;
      w.root.scaling.set(1, Math.max(0.01, grow), 1);
    }
  }

  /**
   * Préparation (écran de chargement) : un mur de chaque équipe en `at` (identifiants négatifs : pas
   * ceux de la simulation), pour que ses alvéoles soient dessinées et sa matière compilée avant la
   * partie. Rend de quoi les retirer.
   */
  warmUp(at: { x: number; y: number; z: number }): () => void {
    const ids = (["red", "blue"] as const).map((team, i) => {
      const id = -1 - i;
      this.add({ id, team, center: { x: at.x, y: at.y + 1.4, z: at.z }, normal: { x: 0, y: 0, z: 1 }, width: 4.5, height: 2.8, hp: 700, maxHp: 700, until: Infinity });
      return id;
    });
    return () => {
      for (const id of ids) this.dispose1(id);
    };
  }

  dispose(): void {
    this.unsubscribe();
    for (const id of [...this.walls.keys()]) this.dispose1(id);
    for (const t of this.textures.values()) t.dispose();
    this.textures.clear();
  }

  private onEvent(e: SimEvent): void {
    switch (e.type) {
      case "barrierAdded":
        this.add(e.barrier);
        break;
      case "barrierHit": {
        const w = this.walls.get(e.barrier.id);
        if (w) w.flash = FLASH;
        break;
      }
      case "barrierRemoved": {
        const w = this.walls.get(e.barrier.id);
        if (w && w.fading === null) w.fading = performance.now() / 1000;
        break;
      }
      default:
        break;
    }
  }

  private add(barrier: Barrier): void {
    const scene = this.scene;
    const material = new B.StandardMaterial(`barrier-${barrier.id}`, scene);
    material.disableLighting = true;
    material.diffuseColor = B.Color3.Black();
    material.emissiveColor = B.Color3.Black();
    material.emissiveTexture = this.hexTexture(barrier.team);
    material.opacityTexture = material.emissiveTexture;
    material.backFaceCulling = false;
    material.alpha = 0;

    // Le panneau pousse du sol : son pied est l'origine du nœud
    const root = new B.TransformNode(`barrier-${barrier.id}`, scene);
    const { center, normal, width, height } = barrier;
    root.position.set(center.x, center.y - height / 2, center.z);
    root.rotation.y = Math.atan2(normal.x, normal.z);
    const panel = B.MeshBuilder.CreatePlane(`barrier-panel-${barrier.id}`, { width, height, sideOrientation: B.Mesh.DOUBLESIDE }, scene);
    panel.position.y = height / 2;
    panel.material = material;
    panel.isPickable = false;
    panel.parent = root;
    // Le cadre : quatre baguettes lumineuses
    const edge = 0.07;
    const frame: [number, number, number, number][] = [
      [0, height, width + edge, edge], [0, 0, width + edge, edge], [-width / 2, height / 2, edge, height], [width / 2, height / 2, edge, height],
    ];
    for (const [x, y, w, h] of frame) {
      const bar = B.MeshBuilder.CreateBox(`barrier-edge-${barrier.id}`, { width: w, height: h, depth: edge }, scene);
      bar.position.set(x, y, 0);
      bar.material = material;
      bar.isPickable = false;
      bar.parent = root;
    }
    this.walls.set(barrier.id, { barrier, root, material, born: performance.now() / 1000, flash: 0, fading: null });
  }

  /** Motif d'alvéoles de l'équipe, dessiné une fois à sa couleur : les bords des hexagones vifs, leur intérieur voilé. */
  private hexTexture(team: Team): B.DynamicTexture {
    const known = this.textures.get(team);
    if (known) return known;
    const size = 256;
    const texture = new B.DynamicTexture(`barrier-hex-${team}`, { width: size, height: size }, this.scene, true);
    const c = texture.getContext() as CanvasRenderingContext2D;
    const color = B.Color3.FromHexString(TEAM_COLORS[team]);
    const rgb = `${Math.round(color.r * 255)},${Math.round(color.g * 255)},${Math.round(color.b * 255)}`;
    c.fillStyle = `rgba(${rgb},0.35)`;
    c.fillRect(0, 0, size, size);
    c.strokeStyle = `rgba(${rgb},1)`;
    c.lineWidth = 3;
    const r = 22;
    const h = Math.sqrt(3) * r;
    for (let row = -1; row * h < size + h; row++) {
      for (let col = -1; col * r * 1.5 < size + r; col++) {
        const x = col * r * 1.5;
        const y = row * h + (col % 2 ? h / 2 : 0);
        c.beginPath();
        for (let i = 0; i <= 6; i++) c.lineTo(x + r * Math.cos((i * Math.PI) / 3), y + r * Math.sin((i * Math.PI) / 3));
        c.stroke();
      }
    }
    texture.hasAlpha = true;
    texture.update();
    texture.uScale = 2;
    texture.vScale = 1.2;
    this.textures.set(team, texture);
    return texture;
  }

  private dispose1(id: number): void {
    const w = this.walls.get(id);
    if (!w) return;
    w.root.dispose(false, false);
    w.material.dispose();
    this.walls.delete(id);
  }
}
