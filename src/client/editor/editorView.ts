import * as B from "../babylon";
import { boundAt, mapBounds, type ArenaOrigins, type ElementOrigin } from "../../shared/map/build";
import { elementPoints, elementsOf, refKey, spawnsOf, type ElementRef, type MapElement } from "../../shared/map/edit";
import type { MapFile, MapPoint } from "../../shared/map/format";
import { propDef, propHalf, CAR_HALF } from "../../shared/catalog/props";
import { terrainHeight, type Terrain } from "../../shared/arena/terrain";
import type { ArenaLayout } from "../../shared/arena/layout";
import { ArenaView } from "../render/arenaView";
import { Assets } from "../render/materials";
import { createGround } from "../render/scene";
import { discData, meshOf, ribbonData, type Ground } from "./draping";

/*
 * Ce que montre l'éditeur de cartes : la carte telle qu'on la jouera, avec le rendu du jeu (le relief,
 * l'eau, la lave et les boîtes par `ArenaView`, les accessoires par leurs modèles), et par-dessus, en
 * surimpression : les limites de jeu, la zone où rôde l'IA, les lignes de départ, les zones, les lieux
 * nommés, les marques des problèmes, la sélection, la pose en attente (fantôme), le pinceau et les
 * tracés. Sa propre scène, sur le moteur du jeu (l'arène est en veille pendant ce temps), libérée tout
 * entière en partant (`dispose`).
 */

/** Ce qu'une boîte, un accessoire, un repère désigne quand on clique dessus. */
export interface Pickable {
  readonly ref: ElementRef;
  /** Une poignée : déplacer une ligne de départ, la tourner, déplacer un point d'un tracé. */
  readonly handle?: "rotate" | "point";
  readonly point?: number;
}

/** Ce qu'il faut refaire après une modification de la carte. */
export interface Changes {
  /** Le relief, l'eau, la lave, les chemins, les cascades. */
  readonly ground: boolean;
  readonly boxes: boolean;
  readonly props: boolean;
}

/** Une étiquette posée dans la scène (zone, lieu, ligne de départ, problème). */
export interface Label {
  readonly text: string;
  readonly cls: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Un clic sur elle (un problème : on y va). */
  readonly onClick?: () => void;
}

/** L'empreinte d'un fantôme : une boîte (dimensions, orientation), ou un disque. */
export type Footprint = { kind: "box"; w: number; h: number; d: number; yaw: number } | { kind: "disc"; r: number };

/** Couleurs de la surimpression. */
const COLORS = {
  play: "#f0bd2c", roam: "#5fd0e8", bound: "#ff6150", blue: "#4f8ff0", red: "#ef5a52", zone: "#ffe27a", place: "#f5f5f5",
  vent: "#ff9b3d", lava: "#ff6a1a", path: "#e8e0c8", select: "#ffd84a", ok: "#57d38c", bad: "#ff6150", brush: "#ffffff",
  trace: "#ffd84a", grid: "#ffffff", issue: "#ff3b30", handle: "#ffffff",
} as const;
type OverlayColor = keyof typeof COLORS;

/** Les surimpressions sont des surfaces transparentes : après l'eau (0), avant la fumée et les flammes du jeu (9 à 14). */
const OVERLAY_ALPHA_INDEX = 2;
/** Hauteur de la surimpression au-dessus du sol (m). */
const LIFT = 0.25;
/** Taille de la grille dessinée autour du centre de la vue (m, de chaque côté). */
const GRID_REACH = 60;

/** La vue de l'éditeur : sa scène, sa caméra, la carte dessinée et sa surimpression. */
export class EditorView {
  readonly scene: B.Scene;
  readonly camera: B.ArcRotateCamera;
  private readonly engine: B.AbstractEngine;
  private readonly assets: Assets;
  private readonly arenaView: ArenaView;
  private readonly shadows: B.ShadowGenerator;
  private readonly loop: () => void;
  private props: B.InstancedMesh[] = [];
  /** Les meshes de chaque élément de la carte (`refKey`). */
  private readonly byElement = new Map<string, B.AbstractMesh[]>();
  /** Surimpression qu'on refait à chaque modification, et celle de la sélection. */
  private overlay: B.Mesh[] = [];
  private selectionMeshes: B.Mesh[] = [];
  private ghost: B.Mesh | null = null;
  private brushRing: B.Mesh | null = null;
  private trace: B.Mesh[] = [];
  private grid: { mesh: B.Mesh; x: number; z: number; step: number } | null = null;
  private readonly materials = new Map<string, B.StandardMaterial>();
  private readonly labelRoot: HTMLElement;
  private labels: { el: HTMLElement; pos: B.Vector3 }[] = [];
  private labelKey = "";
  /** Le relief qu'on vise (celui du champ qu'un pinceau modifie pendant un coup), et l'arène dessinée. */
  private terrain: Terrain | null = null;
  private arena: ArenaLayout | null = null;
  private map: MapFile | null = null;
  /** Ce qu'on fait glisser : les meshes et leur position de départ. */
  private dragging: { mesh: B.AbstractMesh; x: number; z: number; frozen: boolean }[] = [];
  /** Vue de dessus : l'inclinaison d'avant, pour y revenir. */
  private topFrom: number | null = null;
  private last = performance.now();
  /** À chaque image, avant le rendu (l'éditeur déplace la vue au clavier). */
  onFrame: (dt: number) => void = () => {};

  constructor(engine: B.AbstractEngine, labelRoot: HTMLElement) {
    this.engine = engine;
    this.labelRoot = labelRoot;
    const scene = new B.Scene(engine);
    scene.useRightHandedSystem = true;
    scene.ambientColor = new B.Color3(0.25, 0.27, 0.3);
    scene.fogMode = B.Scene.FOGMODE_EXP2;
    const hemi = new B.HemisphericLight("hemi", new B.Vector3(0.2, 1, -0.1), scene);
    hemi.intensity = 0.6;
    hemi.groundColor = new B.Color3(0.32, 0.3, 0.28);
    const sun = new B.DirectionalLight("sun", new B.Vector3(-0.45, -1, 0.32).normalize(), scene);
    sun.intensity = 1;
    sun.diffuse = new B.Color3(1, 0.97, 0.9);
    sun.position = sun.direction.scale(-300);
    // Une seule carte d'ombre, cadrée sur toute la carte : l'éditeur la regarde de loin
    const shadows = new B.ShadowGenerator(2048, sun);
    shadows.usePercentageCloserFiltering = true;
    shadows.bias = 0.002;
    shadows.normalBias = 0.03;
    this.shadows = shadows;
    createGround(scene);
    this.scene = scene;
    this.assets = new Assets(scene);
    this.arenaView = new ArenaView(scene, this.assets, shadows, true);
    this.camera = new B.ArcRotateCamera("editor-cam", -Math.PI / 2, 0.9, 160, B.Vector3.Zero(), scene);
    this.camera.minZ = 0.5;
    this.camera.maxZ = 2500;
    this.camera.fov = 0.9;
    this.loop = () => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.onFrame(dt);
      this.arenaView.update(dt);
      scene.render();
      this.placeLabels();
    };
    engine.runRenderLoop(this.loop);
  }

  /** Libère tout : la scène (meshes, matières, textures), la boucle de rendu, les étiquettes. */
  dispose(): void {
    this.engine.stopRenderLoop(this.loop);
    this.arenaView.dispose();
    this.scene.dispose();
    this.labelRoot.replaceChildren();
    this.labels = [];
    this.materials.clear();
    this.byElement.clear();
  }

  // --- Ciel et caméra ---

  /** Ciel de la carte ; brouillard allégé (on regarde la carte de loin). */
  setSky(color: string, fog: number): void {
    const sky = B.Color3.FromHexString(color);
    this.scene.clearColor = new B.Color4(sky.r, sky.g, sky.b, 1);
    this.scene.fogColor = sky;
    this.scene.fogDensity = fog * 0.3;
  }

  /** Hauteur du sol (le relief visé, sinon le plat). */
  readonly ground: Ground = (x, z) => (this.terrain ? Math.max(0, terrainHeight(this.terrain, x, z)) : 0);

  /** Le relief visé (celui qu'un pinceau modifie, pendant un coup). */
  setTerrain(terrain: Terrain | null): void {
    this.terrain = terrain;
  }

  orbit(dx: number, dy: number): void {
    const c = this.camera;
    c.alpha -= dx * 0.006;
    if (this.topFrom === null) c.beta = Math.min(1.48, Math.max(0.08, c.beta - dy * 0.006));
  }

  /** Déplace le centre de la vue, dans le plan (écran : `dx` vers la droite, `dy` vers le bas). */
  pan(dx: number, dy: number): void {
    const k = this.camera.radius * 0.0016;
    this.shift(-dx * k, dy * k);
  }

  /** Déplace le centre de la vue de `right` m vers la droite de l'écran et `forward` m vers le haut. */
  shift(right: number, forward: number): void {
    const c = this.camera;
    // Vers où regarde la caméra, dans le plan (alpha : la caméra est en (cos α, sin α) du centre)
    const fx = -Math.cos(c.alpha);
    const fz = -Math.sin(c.alpha);
    // La droite de l'écran (repère direct : vue de dessus, l'ouest +x est à gauche quand le nord est en haut)
    const rx = fz;
    const rz = -fx;
    const t = c.target;
    const x = Math.max(-260, Math.min(260, t.x + rx * right + fx * forward));
    const z = Math.max(-260, Math.min(260, t.z + rz * right + fz * forward));
    // (garder l'inclinaison et la distance : la caméra suit son centre)
    c.setTarget(new B.Vector3(x, this.ground(x, z), z), false, false, true);
  }

  zoom(delta: number): void {
    const c = this.camera;
    c.radius = Math.min(700, Math.max(6, c.radius * Math.pow(1.0015, delta)));
  }

  /** Vue de dessus (le nord en haut), ou retour à la vue d'avant. */
  toggleTop(): boolean {
    const c = this.camera;
    if (this.topFrom === null) {
      this.topFrom = c.beta;
      c.beta = 0.0001;
      c.alpha = -Math.PI / 2;
    } else {
      c.beta = this.topFrom;
      this.topFrom = null;
    }
    return this.topFrom !== null;
  }

  get top(): boolean {
    return this.topFrom !== null;
  }

  /** Recentre la vue sur (x, z), à une distance qui montre `size` m. */
  focus(x: number, z: number, size: number): void {
    this.camera.setTarget(new B.Vector3(x, this.ground(x, z), z), false, false, true);
    this.camera.radius = Math.min(500, Math.max(14, size * 2.2));
  }

  /** La vue (pour la retrouver en revenant d'un essai). */
  get pose(): { alpha: number; beta: number; radius: number; x: number; z: number; top: boolean } {
    const c = this.camera;
    return { alpha: c.alpha, beta: this.topFrom ?? c.beta, radius: c.radius, x: c.target.x, z: c.target.z, top: this.topFrom !== null };
  }

  set pose(p: { alpha: number; beta: number; radius: number; x: number; z: number; top: boolean }) {
    const c = this.camera;
    c.alpha = p.alpha;
    c.beta = p.beta;
    c.radius = p.radius;
    c.setTarget(new B.Vector3(p.x, this.ground(p.x, p.z), p.z), false, false, true);
    this.topFrom = null;
    if (p.top) this.toggleTop();
  }

  // --- Visée ---

  /** Le point du sol sous le pointeur (x, y : en pixels CSS dans le canvas), ou null. */
  groundAt(x: number, y: number): { x: number; y: number; z: number } | null {
    const ray = this.scene.createPickingRay(x, y, B.Matrix.Identity(), this.camera, false);
    const o = ray.origin;
    const d = ray.direction;
    const below = (t: number): boolean => o.y + d.y * t <= this.ground(o.x + d.x * t, o.z + d.z * t);
    if (below(0)) return null;
    const step = 1;
    let prev = 0;
    for (let t = step; t <= 2000; t += t > 200 ? 2 : step) {
      if (below(t)) {
        // Le bord, par dichotomie
        let a = prev;
        let b = t;
        for (let i = 0; i < 14; i++) {
          const m = (a + b) / 2;
          if (below(m)) b = m;
          else a = m;
        }
        const px = o.x + d.x * b;
        const pz = o.z + d.z * b;
        return { x: px, y: this.ground(px, pz), z: pz };
      }
      prev = t;
    }
    return null;
  }

  /** Ce qu'on désigne sous le pointeur : un élément, une poignée (les poignées d'abord), ou null. */
  pickAt(x: number, y: number): Pickable | null {
    const handle = this.scene.pick(x, y, (m) => m.isEnabled() && m.isVisible && !!(m.metadata as { pick?: Pickable } | null)?.pick?.handle);
    const hit = handle?.hit ? handle : this.scene.pick(x, y, (m) => m.isEnabled() && m.isVisible && !!(m.metadata as { pick?: Pickable } | null)?.pick);
    return hit?.hit ? ((hit.pickedMesh?.metadata as { pick: Pickable }).pick) : null;
  }

  // --- La carte ---

  /** Dessine la carte : ce qui a changé seulement (`changes`), et toute la surimpression. */
  show(map: MapFile, arena: ArenaLayout, origins: ArenaOrigins, changes: Changes): void {
    this.map = map;
    this.arena = arena;
    this.terrain = arena.terrain ?? null;
    this.setSky(arena.sky?.color ?? "#bfd0db", arena.sky?.fog ?? 0.0045);
    this.dragging = [];
    if (changes.ground) this.arenaView.showGround(arena);
    if (changes.boxes) this.arenaView.showBoxes(arena);
    if (changes.props) this.showProps(arena);
    this.index(map, origins);
    this.showOverlay(map, arena);
  }

  /** Les accessoires : une instance de leur modèle chacun (comme en jeu). */
  private showProps(arena: ArenaLayout): void {
    for (const m of this.props) m.dispose();
    this.props = arena.props.map((spot) => {
      const def = propDef(spot.type);
      const slab = def.shape.kind === "slab";
      const half = slab ? spot.half ?? (spot.type === "car" || spot.type === "wreck" ? CAR_HALF : null) : null;
      const mesh = this.assets.propSource(spot.type, half, !!spot.diamond).createInstance("prop");
      mesh.position.set(spot.pos.x, spot.pos.y, spot.pos.z);
      const r = spot.rot;
      mesh.rotationQuaternion = r ? new B.Quaternion(r.x, r.y, r.z, r.w) : B.Quaternion.Identity();
      if (def.shape.kind === "cylinder") mesh.scaling.setAll(propHalf(spot.type, spot).y / def.shape.halfHeight);
      this.shadows.addShadowCaster(mesh, false);
      return mesh;
    });
  }

  /** Relie chaque mesh à l'élément de la carte qu'il dessine (pour le choisir d'un clic, le faire glisser). */
  private index(map: MapFile, origins: ArenaOrigins): void {
    this.byElement.clear();
    const tie = (mesh: B.AbstractMesh | null | undefined, origin: ElementOrigin | ElementRef | null | undefined): void => {
      if (!mesh) return;
      if (!origin) {
        mesh.isPickable = false;
        mesh.metadata = null;
        return;
      }
      const ref: ElementRef = { list: origin.list, index: origin.index };
      mesh.isPickable = true;
      mesh.metadata = { pick: { ref } satisfies Pickable };
      const key = refKey(ref);
      const list = this.byElement.get(key);
      if (list) list.push(mesh);
      else this.byElement.set(key, [mesh]);
    };
    this.arenaView.boxMeshes.forEach((m, i) => tie(m, origins.boxes[i]));
    this.props.forEach((m, i) => tie(m, origins.props[i]));
    this.arenaView.fallMeshes.forEach((m, i) => tie(m, i < (map.falls?.length ?? 0) ? { list: "falls", index: i } : null));
  }

  /** Les meshes d'un élément (boîtes, accessoires, repères). */
  meshesOf(ref: ElementRef): readonly B.AbstractMesh[] {
    return this.byElement.get(refKey(ref)) ?? [];
  }

  // --- Surimpression ---

  private material(color: OverlayColor, alpha: number): B.StandardMaterial {
    const key = `${color}-${alpha}`;
    let mat = this.materials.get(key);
    if (!mat) {
      mat = new B.StandardMaterial(`ed-${key}`, this.scene);
      mat.emissiveColor = B.Color3.FromHexString(COLORS[color]);
      mat.diffuseColor = B.Color3.Black();
      mat.specularColor = B.Color3.Black();
      mat.disableLighting = true;
      mat.backFaceCulling = false;
      mat.alpha = alpha;
      mat.zOffset = -2;
      this.materials.set(key, mat);
    }
    return mat;
  }

  private add(list: B.Mesh[], mesh: B.Mesh | null, pick?: Pickable): B.Mesh | null {
    if (!mesh) return null;
    mesh.alphaIndex = OVERLAY_ALPHA_INDEX;
    if (pick) {
      mesh.isPickable = true;
      mesh.metadata = { pick };
      const key = refKey(pick.ref);
      if (!pick.handle) {
        const meshes = this.byElement.get(key);
        if (meshes) meshes.push(mesh);
        else this.byElement.set(key, [mesh]);
      }
    }
    list.push(mesh);
    return mesh;
  }

  /** Un ruban posé sur le sol. */
  private ribbon(list: B.Mesh[], points: readonly MapPoint[], width: number, color: OverlayColor, alpha: number, closed = false, pick?: Pickable, lift = LIFT): B.Mesh | null {
    return this.add(list, meshOf(this.scene, "ed-ribbon", ribbonData(points, width, this.ground, lift, closed), this.material(color, alpha)), pick);
  }

  /** Un disque (ou un anneau) posé sur le sol. */
  private disc(list: B.Mesh[], x: number, z: number, r: number, color: OverlayColor, alpha: number, inner = 0, pick?: Pickable): B.Mesh | null {
    return this.add(list, meshOf(this.scene, "ed-disc", discData(x, z, r, this.ground, LIFT, inner), this.material(color, alpha)), pick);
  }

  /** Une bille (une poignée, un repère). */
  private ball(list: B.Mesh[], x: number, y: number, z: number, diameter: number, color: OverlayColor, pick?: Pickable): B.Mesh | null {
    const m = B.MeshBuilder.CreateSphere("ed-ball", { diameter, segments: 8 }, this.scene);
    m.position.set(x, y, z);
    m.material = this.material(color, 0.95);
    m.isPickable = false;
    return this.add(list, m, pick);
  }

  /** Un carré de demi-côté `half` posé sur le sol. */
  private square(list: B.Mesh[], half: number, width: number, color: OverlayColor, alpha: number): void {
    this.ribbon(list, [[-half, -half], [half, -half], [half, half], [-half, half]], width, color, alpha, true, undefined, LIFT + 0.05);
  }

  private showOverlay(map: MapFile, arena: ArenaLayout): void {
    for (const m of this.overlay) m.dispose();
    this.overlay = [];
    const o = this.overlay;
    const b = mapBounds(map, 0);
    // Limites : la zone de jeu, la zone où rôde l'IA, la limite invisible
    this.square(o, b.half, 0.8, "play", 0.9);
    this.square(o, b.roam, 0.4, "roam", 0.6);
    const bound = boundAt(map);
    if (bound !== null && arena.terrain && bound < arena.terrain.size / 2) this.square(o, bound, 0.6, "bound", 0.7);
    // Lignes de départ : un ruban à la couleur de l'équipe, une flèche vers où elle regarde, deux poignées
    const spawns = spawnsOf(map);
    (["blue", "red"] as const).forEach((team, index) => {
      const s = spawns[team];
      const a = (s.facing * Math.PI) / 180;
      const fx = Math.sin(a);
      const fz = Math.cos(a);
      const lx = Math.cos(a);
      const lz = -Math.sin(a);
      const w = s.width / 2;
      const ref: ElementRef = { list: "spawns", index };
      this.ribbon(o, [[s.x - lx * w, s.z - lz * w], [s.x + lx * w, s.z + lz * w]], 2.2, team, 0.75, false, { ref });
      this.ribbon(o, [[s.x, s.z], [s.x + fx * 7, s.z + fz * 7]], 1, team, 0.9);
      this.ball(o, s.x, this.ground(s.x, s.z) + 0.8, s.z, 1.4, "handle", { ref });
      const tx = s.x + fx * 8;
      const tz = s.z + fz * 8;
      this.ball(o, tx, this.ground(tx, tz) + 0.8, tz, 1.6, team, { ref, handle: "rotate" });
    });
    // Zones, lieux, fumerolles, lacs et coulées de lave, chemins
    map.zones.forEach((z, index) => {
      const ref: ElementRef = { list: "zones", index };
      this.disc(o, z.x, z.z, z.radius, "zone", 0.16, 0, { ref });
      this.disc(o, z.x, z.z, z.radius, "zone", 0.85, Math.max(0, z.radius - 0.5));
    });
    (map.places ?? []).forEach((p, index) => {
      const g = this.ground(p.x, p.z);
      const pin = B.MeshBuilder.CreateCylinder("ed-pin", { height: 3, diameter: 0.25, tessellation: 6 }, this.scene);
      pin.position.set(p.x, g + 1.5, p.z);
      pin.material = this.material("place", 0.9);
      this.add(o, pin, { ref: { list: "places", index } });
      this.ball(o, p.x, g + 3.2, p.z, 0.8, "place", { ref: { list: "places", index } });
    });
    (map.vents ?? []).forEach((v, index) => {
      const g = v.y ?? this.ground(v.x, v.z);
      const cone = B.MeshBuilder.CreateCylinder("ed-vent", { height: 1.6, diameterTop: 0, diameterBottom: Math.max(0.8, v.size), tessellation: 10 }, this.scene);
      cone.position.set(v.x, g + 0.8, v.z);
      cone.material = this.material("vent", 0.85);
      this.add(o, cone, { ref: { list: "vents", index } });
    });
    (map.lava ?? []).forEach((l, index) => {
      const ref: ElementRef = { list: "lava", index };
      if (l.kind === "pool") this.disc(o, l.x, l.z, l.r, "lava", 0.22, 0, { ref });
      else this.ribbon(o, l.points, Math.min(2, l.width), "lava", 0.55, false, { ref });
    });
    (map.paths ?? []).forEach((p, index) => this.ribbon(o, p.points, Math.min(1.2, p.width), "path", 0.4, false, { ref: { list: "paths", index } }));
    // Les boîtes invisibles (limites placées par l'auteur) se voient dans l'éditeur
    (map.boxes ?? []).forEach((box, index) => {
      if (box.kind !== "bound") return;
      for (const m of this.meshesOf({ list: "boxes", index })) m.dispose();
      const m = B.MeshBuilder.CreateBox("ed-bound", { width: box.size[0], height: box.size[1], depth: box.size[2] }, this.scene);
      const arenaBox = arena.boxes[index];
      if (arenaBox) {
        m.position.set(arenaBox.pos.x, arenaBox.pos.y, arenaBox.pos.z);
        m.rotationQuaternion = new B.Quaternion(arenaBox.rot.x, arenaBox.rot.y, arenaBox.rot.z, arenaBox.rot.w);
      }
      m.material = this.material("bound", 0.25);
      this.add(o, m, { ref: { list: "boxes", index } });
    });
  }

  /** Les étiquettes de la carte : zones, lieux, lignes de départ, problèmes (refaites si elles changent). */
  setLabels(labels: readonly Label[]): void {
    const key = labels.map((l) => `${l.cls}|${l.text}|${l.x.toFixed(1)}|${l.y.toFixed(1)}|${l.z.toFixed(1)}`).join(";");
    if (key === this.labelKey) return;
    this.labelKey = key;
    this.labelRoot.replaceChildren();
    this.labels = labels.map((l) => {
      const el = document.createElement(l.onClick ? "button" : "span");
      el.className = `ed-label ${l.cls}`;
      el.textContent = l.text;
      if (l.onClick) {
        (el as HTMLButtonElement).type = "button";
        el.addEventListener("click", l.onClick);
      }
      this.labelRoot.append(el);
      return { el, pos: new B.Vector3(l.x, l.y, l.z) };
    });
  }

  private placeLabels(): void {
    if (!this.labels.length) return;
    const engine = this.engine;
    const scale = engine.getHardwareScalingLevel();
    const viewport = this.camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
    const transform = this.scene.getTransformMatrix();
    for (const { el, pos } of this.labels) {
      const p = B.Vector3.Project(pos, B.Matrix.IdentityReadOnly, transform, viewport);
      const visible = p.z > 0 && p.z < 1;
      el.style.display = visible ? "" : "none";
      if (visible) el.style.transform = `translate(${(p.x * scale).toFixed(1)}px, ${(p.y * scale).toFixed(1)}px) translate(-50%, -100%)`;
    }
  }

  // --- Sélection, fantôme, pinceau, tracés, grille ---

  /** Montre la sélection : une boîte autour de chaque élément, les poignées des points d'un tracé, le rayon d'un bois. */
  showSelection(refs: readonly ElementRef[]): void {
    for (const m of this.selectionMeshes) m.dispose();
    this.selectionMeshes = [];
    const map = this.map;
    if (!map) return;
    const s = this.selectionMeshes;
    for (const ref of refs) {
      const e = elementsOf(map, ref.list)[ref.index] as MapElement | undefined;
      if (!e) continue;
      // Une boîte autour de ses meshes
      const meshes = this.meshesOf(ref).filter((m) => !m.isDisposed());
      if (meshes.length) {
        let min = new B.Vector3(Infinity, Infinity, Infinity);
        let max = new B.Vector3(-Infinity, -Infinity, -Infinity);
        for (const m of meshes) {
          m.computeWorldMatrix(true);
          const bb = m.getBoundingInfo().boundingBox;
          min = B.Vector3.Minimize(min, bb.minimumWorld);
          max = B.Vector3.Maximize(max, bb.maximumWorld);
        }
        const size = max.subtract(min);
        const box = B.MeshBuilder.CreateBox("ed-select", { size: 1 }, this.scene);
        box.scaling.set(Math.max(0.3, size.x + 0.3), Math.max(0.3, size.y + 0.3), Math.max(0.3, size.z + 0.3));
        box.position = min.add(max).scale(0.5);
        box.material = this.material("select", 0.12);
        box.enableEdgesRendering();
        box.edgesWidth = 6;
        box.edgesColor = B.Color4.FromHexString(`${COLORS.select}ff`);
        box.isPickable = false;
        box.alphaIndex = OVERLAY_ALPHA_INDEX;
        s.push(box);
      }
      // Les points d'un tracé : des poignées
      const points = elementPoints(e);
      if (points) {
        this.ribbon(s, points, 0.5, "select", 0.9, false, undefined, LIFT + 0.1);
        points.forEach(([x, z], point) => this.ball(s, x, this.ground(x, z) + 0.6, z, 1.2, "select", { ref, handle: "point", point }));
      }
      // Un bois, un tas de rochers, un lac de lave : leur disque
      const radius = "radius" in e && "count" in e ? e.radius : "r" in e ? e.r : 0;
      if (radius) {
        const c = e as { x: number; z: number };
        this.disc(s, c.x, c.z, radius, "select", 0.9, Math.max(0, radius - 0.4));
      }
    }
  }

  /** Fait glisser des éléments de (dx, dz) m (seulement leurs meshes et leur sélection ; la carte est refaite au relâchement). */
  dragBy(refs: readonly ElementRef[], dx: number, dz: number): void {
    if (!this.dragging.length) {
      const meshes = new Set<B.AbstractMesh>(this.selectionMeshes);
      for (const ref of refs) for (const m of this.meshesOf(ref)) meshes.add(m);
      for (const m of meshes) {
        if (m.isDisposed()) continue;
        const frozen = m.isWorldMatrixFrozen;
        if (frozen) m.unfreezeWorldMatrix();
        this.dragging.push({ mesh: m, x: m.position.x, z: m.position.z, frozen });
      }
    }
    for (const d of this.dragging) {
      if (d.mesh.isDisposed()) continue;
      d.mesh.position.x = d.x + dx;
      d.mesh.position.z = d.z + dz;
    }
  }

  /** Fin d'un glisser sans changement : les meshes reviennent. */
  endDrag(restore: boolean): void {
    for (const d of this.dragging) {
      if (d.mesh.isDisposed()) continue;
      if (restore) {
        d.mesh.position.x = d.x;
        d.mesh.position.z = d.z;
      }
      if (d.frozen) d.mesh.freezeWorldMatrix();
    }
    this.dragging = [];
  }

  /** Le fantôme de ce qu'on va poser (vert : ça passe ; rouge : non), ou rien. */
  showGhost(at: { x: number; z: number } | null, footprint: Footprint | null, ok: boolean): void {
    this.ghost?.dispose();
    this.ghost = null;
    if (!at || !footprint) return;
    const g = this.ground(at.x, at.z);
    if (footprint.kind === "disc") {
      this.ghost = meshOf(this.scene, "ed-ghost", discData(at.x, at.z, footprint.r, this.ground, LIFT + 0.1), this.material(ok ? "ok" : "bad", 0.35));
    } else {
      const m = B.MeshBuilder.CreateBox("ed-ghost", { width: footprint.w, height: footprint.h, depth: footprint.d }, this.scene);
      m.position.set(at.x, g + footprint.h / 2, at.z);
      m.rotation.y = (footprint.yaw * Math.PI) / 180;
      m.material = this.material(ok ? "ok" : "bad", 0.35);
      m.isPickable = false;
      this.ghost = m;
    }
    if (this.ghost) this.ghost.alphaIndex = OVERLAY_ALPHA_INDEX;
  }

  /** L'anneau du pinceau sous le pointeur, ou rien. */
  showBrush(at: { x: number; z: number } | null, radius: number): void {
    this.brushRing?.dispose();
    this.brushRing = at ? meshOf(this.scene, "ed-brush", discData(at.x, at.z, radius, this.ground, LIFT, Math.max(0, radius - Math.max(0.3, radius * 0.04)), 64), this.material("brush", 0.9)) : null;
    if (this.brushRing) this.brushRing.alphaIndex = OVERLAY_ALPHA_INDEX;
  }

  /** Le tracé en cours : ses points, et le segment jusqu'au pointeur. */
  showTrace(points: readonly MapPoint[], cursor: MapPoint | null, width: number): void {
    for (const m of this.trace) m.dispose();
    this.trace = [];
    const all = cursor ? [...points, cursor] : points;
    if (all.length >= 2) this.ribbon(this.trace, all, Math.max(0.6, width), "trace", 0.6);
    for (const [x, z] of points) this.ball(this.trace, x, this.ground(x, z) + 0.6, z, 1.1, "trace");
  }

  /** La grille d'aimantage, autour du centre de la vue (refaite quand la vue s'en éloigne), ou rien. */
  showGrid(step: number | null): void {
    const t = this.camera.target;
    if (step === null) {
      this.grid?.mesh.dispose();
      this.grid = null;
      return;
    }
    // Pas plus d'une centaine de traits : de loin, une grille plus lâche
    const drawn = step * Math.max(1, Math.ceil((2 * GRID_REACH) / step / 60));
    const cx = Math.round(t.x / drawn) * drawn;
    const cz = Math.round(t.z / drawn) * drawn;
    if (this.grid && this.grid.step === drawn && Math.abs(this.grid.x - cx) < drawn * 4 && Math.abs(this.grid.z - cz) < drawn * 4) return;
    this.grid?.mesh.dispose();
    const lines: B.VertexData[] = [];
    for (let k = -GRID_REACH; k <= GRID_REACH; k += drawn) {
      for (const along of [true, false]) {
        const pts: MapPoint[] = along ? [[cx - GRID_REACH, cz + k], [cx + GRID_REACH, cz + k]] : [[cx + k, cz - GRID_REACH], [cx + k, cz + GRID_REACH]];
        const data = ribbonData(pts, 0.12, this.ground, LIFT * 0.6, false, Math.max(1, drawn / 2));
        if (data) lines.push(data);
      }
    }
    const merged = new B.VertexData();
    const positions: number[] = [];
    const indices: number[] = [];
    for (const d of lines) {
      const base = positions.length / 3;
      positions.push(...(d.positions as number[]));
      indices.push(...(d.indices as number[]).map((i) => i + base));
    }
    merged.positions = positions;
    merged.indices = indices;
    const mesh = meshOf(this.scene, "ed-grid", merged, this.material("grid", 0.3))!;
    mesh.alphaIndex = OVERLAY_ALPHA_INDEX;
    this.grid = { mesh, x: cx, z: cz, step: drawn };
  }

  /** Le relief redessiné pendant un coup de pinceau (sur la zone touchée). */
  reshape(heights: Float32Array, region: { ix0: number; ix1: number; iz0: number; iz1: number }): void {
    if (this.arena) this.arenaView.reshapeTerrain(heights, region, this.arena);
  }

  /** La nappe d'eau, à cette hauteur (pendant qu'on règle son niveau). */
  setWaterLevel(level: number): void {
    const w = this.arenaView.waterSurface;
    if (!w) return;
    w.unfreezeWorldMatrix();
    w.position.y = level;
  }

  /** Nombre de meshes de la scène (mesure : rien ne doit rester en partant). */
  get meshCount(): number {
    return this.scene.meshes.length;
  }
}
