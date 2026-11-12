import * as B from "../babylon";
import { lavaAt, VALLEY_GROUND, type GroundStyle, type Waterfall } from "../../shared/arena/features";
import type { ArenaLayout, BoxLook, PathSurface, StaticBox, StaticKind, TerrainPath } from "../../shared/arena/layout";
import { rockShape } from "../../shared/arena/rocks";
import { noise2, type Terrain } from "../../shared/arena/terrain";
import type { Vec3 } from "../../shared/math/vec";
import { clamp } from "../../shared/math/scalar";
import { context2d, type Assets } from "./materials";

type Ctx = CanvasRenderingContext2D;

/** Ce qui projette une ombre : murs d'enceinte, rampes, pistes et voies ferrées sont trop bas pour que ça se voie. */
/** Les allures du port (voir `BoxLook`). */
type HarbourLook = "quay" | "steel" | "hull" | "superstructure" | "hatch" | "funnel" | "lighthouse" | "lamp" | "silo" | "container";

/**
 * Allure d'une boîte du port : sa texture dessinée, répétée tous les `tile` m le long de chaque face
 * (0 : une fois par face ; `vertical` : seulement en largeur, une coque garde sa ligne de
 * flottaison), si elle projette une ombre, sa lueur, et ce que montrent son dessus et les bouts d'un
 * cylindre (`cap` : un coin uni de la texture, u0, v0, u1, v1).
 */
interface HarbourDef {
  readonly draw: (c: Ctx) => void;
  readonly tile: number;
  readonly vertical?: boolean;
  readonly shadow: boolean;
  readonly glow?: string;
  readonly cap?: readonly [number, number, number, number];
}

const HARBOUR_LOOKS: Record<HarbourLook, HarbourDef> = {
  quay: { draw: drawQuay, tile: 4, shadow: false },
  steel: { draw: drawSteel, tile: 2.5, shadow: true },
  hull: { draw: drawHull, tile: 6, vertical: true, shadow: true, cap: [0.1, 0.9, 0.3, 0.95] },
  superstructure: { draw: drawSuperstructure, tile: 3, shadow: true, cap: [0, 0, 0.05, 0.05] },
  hatch: { draw: drawHatch, tile: 3, shadow: true },
  funnel: { draw: drawFunnel, tile: 0, shadow: true, cap: [0.1, 0.85, 0.2, 0.95] },
  lighthouse: { draw: drawLighthouse, tile: 0, shadow: true, cap: [0.1, 0.8, 0.2, 0.9] },
  lamp: { draw: drawLamp, tile: 0, shadow: false, glow: "#ffe9a8", cap: [0.3, 0.3, 0.4, 0.4] },
  silo: { draw: drawSilo, tile: 4, vertical: true, shadow: true, cap: [0.3, 0.3, 0.4, 0.4] },
  container: { draw: (c) => drawContainer(c, "#2f5f8a", true), tile: 0, shadow: true },
};
const harbour = (look: BoxLook | undefined): HarbourDef | null => (look && look in HARBOUR_LOOKS ? HARBOUR_LOOKS[look as HarbourLook] : null);

const CASTS_SHADOW: Record<StaticKind, boolean> = {
  wall: false, ramp: false, pillar: true, platform: true, barrier: true, rock: true, container: true, deck: true, road: false, bound: false,
  tower: true, track: false,
};
/** Un immeuble : une travée de sa façade (une fenêtre) fait TOWER_BAY m de large, un étage TOWER_STOREY m. */
const TOWER_BAY = 4;
const TOWER_STOREY = 3.6;

/** Couleurs des conteneurs, tirées d'après leur place dans la liste. */
const CONTAINER_COLORS = ["#a8432f", "#2f5f8a", "#3e7a45", "#c7812c", "#6d6f73"];

/** Couleurs du relief, d'après la palette d'une arène (`ArenaLayout.ground`, voir `GroundStyle`). */
interface Palette {
  base: readonly [B.Color3, B.Color3];
  dirt: B.Color3;
  sand: B.Color3;
  mud: B.Color3;
  rock: B.Color3;
  peak: B.Color3;
  /** Au-dessus de ces hauteurs, la roche, puis le sommet (neige, cendre) (m). */
  rockLine: number;
  peakLine: number;
  /** Hauteur de la plage au-dessus de l'eau (m). */
  beach: number;
  basalt: B.Color3 | null;
  basaltWidth: number;
  strata: readonly B.Color3[];
  strataStep: number;
  patches: readonly { x: number; z: number; r: number; color: B.Color3 }[];
  /** Motif des deux teintes du sol (m), part des taches de terre. */
  grain: number;
  stains: number;
  /** Teinte des pentes (null : la roche, ou ses strates), et à partir de quelle composante verticale de la normale, sur quel écart. */
  slope: B.Color3 | null;
  slopeFrom: number;
  slopeSpan: number;
  /** Écart de hauteur sur lequel le sol passe à la roche (m). */
  rockSpan: number;
  /** Teinte des chemins d'herbe (null : le sol éclairci). */
  lawn: B.Color3 | null;
}

const hex = (c: string): B.Color3 => B.Color3.FromHexString(c);
const paletteOf = (s: GroundStyle): Palette => ({
  base: [hex(s.base[0]), hex(s.base[1])], dirt: hex(s.dirt), sand: hex(s.sand), mud: hex(s.mud), rock: hex(s.rock), peak: hex(s.peak),
  rockLine: s.rockLine, peakLine: s.peakLine, beach: s.beach ?? 0.6, basalt: s.basalt ? hex(s.basalt) : null, basaltWidth: s.basaltWidth ?? 3,
  strata: (s.strata ?? []).map(hex), strataStep: s.strataStep ?? 2,
  patches: (s.patches ?? []).map((q) => ({ x: q.x, z: q.z, r: q.r, color: hex(q.color) })),
  grain: s.grain ?? 9, stains: s.stains ?? 0.25,
  slope: s.slope?.color ? hex(s.slope.color) : null, slopeFrom: s.slope?.from ?? 0.82, slopeSpan: s.slope?.span ?? 0.18,
  rockSpan: s.rockSpan ?? 10, lawn: s.lawn ? hex(s.lawn) : null,
});
/** La palette par défaut : celle de la Vallée (herbe, terre, sable des berges, roche des pentes, neige des sommets). */
const VALLEY_PALETTE: Palette = paletteOf(VALLEY_GROUND);
const palettes = new WeakMap<GroundStyle, Palette>();
function palette(arena: ArenaLayout | undefined): Palette {
  const style = arena?.ground;
  if (!style) return VALLEY_PALETTE;
  let p = palettes.get(style);
  if (!p) palettes.set(style, (p = paletteOf(style)));
  return p;
}


/**
 * Teinte des revêtements qui ne viennent pas de la palette du sol : allée de gravier, ballast,
 * chaussée ; ils se posent par-dessus tout, dans cet ordre (le dernier par-dessus).
 */
const PAVINGS: readonly (readonly [PathSurface, B.Color3])[] = [["gravel", hex("#a39276")], ["ballast", hex("#5f574d")], ["asphalt", hex("#46484a")]];

/** Lave (vertex colors, émise : elle brille sans lumière) : la croûte sombre, la lave qui coule, son cœur. */
const LAVA_CRUST = hex("#3a1a10");
const LAVA_FLOW = hex("#ff5a14");
const LAVA_HOT = hex("#ffc04a");

/** Strates du relief (texture) : une bande claire ou sombre tous les `strataStep` m de hauteur, STRATA_BANDS bandes par tour de texture. */
const STRATA_BANDS = 8;

/** Le maillage du relief et ce qu'il faut pour le remodeler (l'éditeur de cartes : `reshapeTerrain`). */
interface TerrainState {
  readonly mesh: B.Mesh;
  readonly cells: number;
  readonly size: number;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly colors: Float32Array;
}

/**
 * Meshes du décor fixe de l'arène en place (boîtes, relief, eau) ; `show` le remplace quand on change
 * d'arène. L'éditeur de cartes en refait seulement une part (`showBoxes`, `showGround`) et remodèle le
 * relief pendant un coup de pinceau (`reshapeTerrain`).
 */
export class ArenaView {
  private readonly scene: B.Scene;
  private readonly assets: Assets;
  private readonly shadows: B.ShadowGenerator;
  /** Les boîtes, dans l'ordre de l'arène (null : une limite invisible, qui ne se dessine pas). */
  private boxes: (B.Mesh | null)[] = [];
  /** Le relief, l'eau, la lave, les cascades. */
  private ground: B.Mesh[] = [];
  private falls: B.Mesh[] = [];
  private waterMesh: B.Mesh | null = null;
  private terrainState: TerrainState | null = null;
  private current: ArenaLayout | null = null;
  private readonly materials = new Map<string, B.StandardMaterial>();
  /** Textures qui défilent (`update`) : la croûte de la lave, l'eau des cascades. */
  private lavaTexture: B.Texture | null = null;
  private fallTexture: B.Texture | null = null;
  private flowTime = 0;
  /** Dessin qu'on modifie (l'éditeur de cartes) : relief remodelable, ni découpé ni figé. */
  private readonly editable: boolean;

  constructor(scene: B.Scene, assets: Assets, shadows: B.ShadowGenerator, editable = false) {
    this.scene = scene;
    this.assets = assets;
    this.shadows = shadows;
    this.editable = editable;
  }

  show(layout: ArenaLayout): void {
    if (layout === this.current) return;
    this.current = layout;
    this.showBoxes(layout);
    this.showGround(layout);
    this.setNight(!!layout.sky?.night);
  }

  private towerWindows: B.DynamicTexture | null = null;

  /**
   * La nuit, des fenêtres des immeubles du bord s'éclairent (une texture émise qui couvre quatre
   * motifs de façade sur quatre, voir `drawTowerWindows`) ; le jour, elles s'éteignent.
   */
  private setNight(on: boolean): void {
    const mat = this.materials.get("tower");
    if (!mat) return;
    if (on && !this.towerWindows) {
      const tex = new B.DynamicTexture("t-tower-windows", { width: 1024, height: 1024 }, this.scene, true);
      drawTowerWindows(context2d(tex));
      tex.update();
      tex.wrapU = tex.wrapV = B.Texture.WRAP_ADDRESSMODE;
      tex.uScale = tex.vScale = 1 / TOWER_WINDOW_TILES;
      this.towerWindows = tex;
    }
    mat.emissiveTexture = on ? this.towerWindows : null;
  }

  /** Refait les boîtes du décor. */
  showBoxes(layout: ArenaLayout): void {
    for (const m of this.boxes) m?.dispose();
    // Les limites invisibles de la carte ne se dessinent pas
    const boxes = layout.boxes.map((b, i) => (b.kind === "bound" ? null : this.box(b, i)));
    // L'éditeur garde une boîte par mesh (on les choisit, on les déplace) ; en jeu, rien ne les bouge
    this.boxes = this.editable ? boxes : this.mergeBoxes(boxes);
    for (const m of this.boxes) if (m && this.casters.has(m)) this.shadows.addShadowCaster(m);
    this.casters.clear();
  }

  /**
   * En jeu, les boîtes du décor (immeubles du bord, piliers, rochers, tabliers…) ne bougent ni ne
   * cèdent : celles qui ont la même matière (et la même façon de faire de l'ombre) ne font qu'un mesh.
   * Une passe de dessin par matière dans l'image et dans chaque cascade d'ombre, au lieu d'une par
   * boîte : dans la Cité, les 86 immeubles du bord faisaient 258 passes d'ombre par image.
   */
  private mergeBoxes(boxes: readonly (B.Mesh | null)[]): B.Mesh[] {
    const groups = new Map<string, B.Mesh[]>();
    for (const m of boxes) {
      if (!m) continue;
      const key = `${m.material?.uniqueId ?? "-"}|${this.casters.has(m)}|${m.getVerticesDataKinds().sort().join(",")}`;
      const group = groups.get(key);
      if (group) group.push(m);
      else groups.set(key, [m]);
    }
    const merged: B.Mesh[] = [];
    for (const group of groups.values()) {
      const caster = this.casters.has(group[0]);
      const one = group.length > 1 ? B.Mesh.MergeMeshes(group, true, true) : group[0];
      if (!one) {
        merged.push(...group);
        continue;
      }
      one.receiveShadows = true;
      one.freezeWorldMatrix();
      if (caster) this.casters.add(one);
      merged.push(one);
    }
    return merged;
  }

  /** Les boîtes qui font de l'ombre (le temps de les construire et de les fusionner). */
  private readonly casters = new Set<B.Mesh>();

  /** Refait le sol : le relief, l'eau, la lave, les cascades. */
  showGround(layout: ArenaLayout): void {
    for (const m of this.ground) m.dispose();
    this.ground = [];
    this.waterMesh = null;
    this.terrainState = null;
    // Le sol quadrillé des petites arènes disparaît sous le relief
    this.scene.getMeshByName("ground")?.setEnabled(!layout.terrain);
    if (layout.terrain) this.ground.push(this.terrain(layout.terrain, layout.water ?? -Infinity, layout.paths ?? [], layout));
    if (layout.terrain && layout.water !== undefined) this.ground.push((this.waterMesh = this.water(layout.terrain.size, layout.water, layout.waterColor)));
    if (layout.terrain && layout.lava) this.ground.push(this.lava(layout.terrain, layout));
    this.falls = (layout.falls ?? []).map((fall) => this.waterfall(fall));
    this.ground.push(...this.falls);
  }

  /** Les meshes des boîtes, dans l'ordre de l'arène (null : une limite invisible) ; en jeu, fusionnées par matière. */
  get boxMeshes(): readonly (B.Mesh | null)[] {
    return this.boxes;
  }

  /** Les cascades, dans l'ordre de l'arène. */
  get fallMeshes(): readonly B.Mesh[] {
    return this.falls;
  }

  /** La nappe d'eau (l'éditeur la monte et la descend pendant qu'on règle son niveau). */
  get waterSurface(): B.Mesh | null {
    return this.waterMesh;
  }

  /**
   * Remodèle le relief dessiné d'après des hauteurs (celles du champ qu'un pinceau modifie, dans
   * l'ordre de `Terrain.heights`), sur la zone touchée et un sommet autour : positions, normales (par
   * différences centrées) et couleurs. Le maillage complet, ses normales exactes et la lave sont
   * refaits ensuite (`showGround`). Dessin modifiable seulement.
   */
  reshapeTerrain(heights: Float32Array, region: { ix0: number; ix1: number; iz0: number; iz1: number }, layout: ArenaLayout): void {
    const t = this.terrainState;
    if (!t || !this.editable) return;
    const n = t.cells + 1;
    const step = t.size / t.cells;
    const ix0 = Math.max(0, region.ix0 - 1);
    const ix1 = Math.min(t.cells, region.ix1 + 1);
    const iz0 = Math.max(0, region.iz0 - 1);
    const iz1 = Math.min(t.cells, region.iz1 + 1);
    const h = (ix: number, iz: number): number => heights[Math.min(t.cells, Math.max(0, ix)) * n + Math.min(t.cells, Math.max(0, iz))];
    const water = layout.water ?? -Infinity;
    const paths = layout.paths ?? [];
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const k = ix * n + iz;
        const y = heights[k];
        t.positions[k * 3 + 1] = y;
        const gx = (h(ix + 1, iz) - h(ix - 1, iz)) / (2 * step);
        const gz = (h(ix, iz + 1) - h(ix, iz - 1)) / (2 * step);
        const len = Math.hypot(gx, 1, gz);
        t.normals[k * 3] = -gx / len;
        t.normals[k * 3 + 1] = 1 / len;
        t.normals[k * 3 + 2] = -gz / len;
        const c = groundColor(t.positions[k * 3], y, t.positions[k * 3 + 2], 1 / len, water, paths, layout);
        t.colors[k * 4] = c.r;
        t.colors[k * 4 + 1] = c.g;
        t.colors[k * 4 + 2] = c.b;
      }
    }
    t.mesh.updateVerticesData(B.VertexBuffer.PositionKind, t.positions);
    t.mesh.updateVerticesData(B.VertexBuffer.NormalKind, t.normals);
    t.mesh.updateVerticesData(B.VertexBuffer.ColorKind, t.colors);
    t.mesh.refreshBoundingInfo();
  }

  /** Libère tout : meshes, matières et leurs textures. */
  dispose(): void {
    for (const m of this.boxes) m?.dispose();
    for (const m of this.ground) m.dispose();
    for (const mat of this.materials.values()) mat.dispose(true, true);
    this.boxes = [];
    this.ground = [];
    this.falls = [];
    this.materials.clear();
    this.terrainState = null;
    this.waterMesh = null;
    this.current = null;
  }

  /** Fait couler la lave et les cascades (à chaque image ; `dt` en s). */
  update(dt: number): void {
    this.flowTime += dt;
    if (this.lavaTexture) {
      this.lavaTexture.uOffset = this.flowTime * 0.012;
      this.lavaTexture.vOffset = this.flowTime * 0.02;
    }
    if (this.fallTexture) this.fallTexture.vOffset = this.flowTime * 1.6;
  }

  private box(b: StaticBox, index: number): B.Mesh {
    const { kind, pos, half, rot } = b;
    // Une chaussée, une voie ferrée le long de z : leur motif court le long de x ; on les construit
    // donc le long de x, tournées d'un quart de tour (bandes et rails restent dans le bon sens)
    // (pas une boîte qui a son apparence : la voie ferrée du Canyon court le long de z)
    const turned = !b.look && (kind === "road" || kind === "track") && half.z > half.x;
    const h = turned ? { x: half.z, y: half.y, z: half.x } : half;
    const port = harbour(b.look);
    const m = kind === "rock"
      ? this.rock(half, pos.x, pos.z)
      : b.round
        ? this.cylinder(b, port)
        : B.MeshBuilder.CreateBox(kind, { width: h.x * 2, height: h.y * 2, depth: h.z * 2, faceUV: port ? harbourUV(h, port) : faceUVOf(b, h), wrap: true }, this.scene);
    m.material = b.look ? this.lookMaterial(b.look, kind, half) : this.materialOf(kind, index, half);
    m.position.set(pos.x, pos.y, pos.z);
    m.rotationQuaternion = new B.Quaternion(rot.x, rot.y, rot.z, rot.w);
    if (turned) m.rotationQuaternion = m.rotationQuaternion.multiply(B.Quaternion.RotationAxis(B.Vector3.Up(), Math.PI / 2));
    m.receiveShadows = true;
    m.freezeWorldMatrix();
    // (elle fera de l'ombre une fois les boîtes fusionnées, voir `showBoxes`)
    if (port ? port.shadow : CASTS_SHADOW[kind]) this.casters.add(m);
    return m;
  }

  /** Une boîte ronde (`StaticBox.round`) : un cylindre debout, la texture faisant le tour. */
  private cylinder(b: StaticBox, def: HarbourDef | null): B.Mesh {
    const turns = def && def.tile > 0 ? Math.max(1, Math.round((2 * Math.PI * b.half.x) / def.tile)) : 1;
    const side = new B.Vector4(0, 0, turns, def?.vertical || !def?.tile ? 1 : (2 * b.half.y) / def.tile);
    const cap = new B.Vector4(...(def?.cap ?? [0, 0, 0.2, 0.2]));
    return B.MeshBuilder.CreateCylinder(b.look ?? b.kind, { height: b.half.y * 2, diameter: b.half.x * 2, tessellation: 28, faceUV: [cap, side, cap] }, this.scene);
  }

  /** Matière d'une allure du port, la même pour toutes ses boîtes. */
  private harbourMaterial(look: HarbourLook): B.StandardMaterial {
    return this.material(`look-${look}`, () => {
      const def = HARBOUR_LOOKS[look];
      const mat = this.textured(`look-${look}`, def.draw);
      if (def.glow) {
        mat.emissiveColor = B.Color3.FromHexString(def.glow);
        mat.disableLighting = true;
      }
      return mat;
    });
  }

  private materialOf(kind: StaticKind, index: number, half: { x: number; z: number }): B.Material {
    switch (kind) {
      case "barrier":
      case "platform":
        return this.assets.darkConcrete;
      case "rock":
        return this.material("rock", () => {
          const mat = new B.StandardMaterial("rock", this.scene);
          mat.diffuseColor = B.Color3.FromHexString("#8a857b");
          mat.specularColor = new B.Color3(0.05, 0.05, 0.05);
          return mat;
        });
      case "container": {
        const color = CONTAINER_COLORS[index % CONTAINER_COLORS.length];
        return this.material(`container-${color}-${half.x > half.z ? "x" : "z"}`, () => this.textured(`container-${color}`, (c) => drawContainer(c, color, half.x > half.z)));
      }
      case "deck":
        return this.material("deck", () => this.textured("deck", drawStone));
      case "road":
        return this.material("road", () => this.textured("road", drawRunway));
      case "track":
        return this.material("track", () => this.textured("track", drawTrack));
      case "tower":
        return this.material("tower", () => this.textured("tower", drawTowerFacade, 512));
      default:
        return this.assets.concrete;
    }
  }

  /** Matière d'une boîte qui a son apparence (`StaticBox.look`) : grès, charpente, voie ferrée, wagon, planches, rouille, basalte. */
  private lookMaterial(look: BoxLook, kind: StaticKind, half: { x: number; z: number }): B.Material {
    switch (look) {
      case "sandstone":
        if (kind === "rock") {
          return this.material("rock-sandstone", () => {
            const mat = new B.StandardMaterial("rock-sandstone", this.scene);
            mat.diffuseColor = B.Color3.FromHexString("#b4643f");
            mat.specularColor = new B.Color3(0.04, 0.04, 0.04);
            return mat;
          });
        }
        return this.material("sandstone", () => this.textured("sandstone", drawSandstone));
      case "timber":
        return this.material("timber", () => this.textured("timber", drawTimber));
      case "rail":
        // Une voie seule (une plateforme de 2,6 m), ou le tablier de bois d'un pont qui la porte
        return Math.min(half.x, half.z) > 2
          ? this.material("rail-deck", () => this.textured("rail-deck", drawRailDeck))
          : this.material("rail", () => this.textured("rail", drawRail));
      case "wagon":
        return this.material("wagon", () => this.textured("wagon", drawWagon));
      case "wood":
        return this.material("wood", () => this.textured("wood", drawBoards));
      case "rust":
        return this.material("rust", () => this.textured("rust", drawRust));
      case "basalt":
        return this.material("basalt", () => {
          const mat = new B.StandardMaterial("basalt", this.scene);
          mat.diffuseColor = hex("#45403c");
          mat.specularColor = new B.Color3(0.12, 0.12, 0.12);
          mat.specularPower = 24;
          return mat;
        });
      default:
        return this.harbourMaterial(look);
    }
  }

  private material(key: string, build: () => B.StandardMaterial): B.StandardMaterial {
    let mat = this.materials.get(key);
    if (!mat) {
      mat = build();
      this.materials.set(key, mat);
    }
    return mat;
  }

  private textured(name: string, draw: (c: Ctx) => void, px = 256): B.StandardMaterial {
    const tex = new B.DynamicTexture(`t-${name}`, { width: px, height: px }, this.scene, true);
    draw(context2d(tex));
    tex.update();
    tex.wrapU = tex.wrapV = B.Texture.WRAP_ADDRESSMODE;
    tex.anisotropicFilteringLevel = 8;
    const mat = new B.StandardMaterial(name, this.scene);
    mat.diffuseTexture = tex;
    mat.specularColor = new B.Color3(0.06, 0.06, 0.06);
    return mat;
  }

  /** Rocher : la forme que lui donne la physique (shared/arena/rocks.ts), à facettes. */
  private rock(half: Vec3, x: number, z: number): B.Mesh {
    const { vertices, faces } = rockShape(half, x, z);
    // Un sommet par coin de facette : des normales par facette (à plat) ; triangles dans le sens de Babylon
    const positions: number[] = [];
    const indices: number[] = [];
    for (let f = 0; f < faces.length; f += 3) {
      for (const k of [faces[f], faces[f + 2], faces[f + 1]]) {
        positions.push(vertices[k * 3], vertices[k * 3 + 1], vertices[k * 3 + 2]);
        indices.push(indices.length);
      }
    }
    const normals: number[] = [];
    B.VertexData.ComputeNormals(positions, indices, normals);
    const data = new B.VertexData();
    data.positions = positions;
    data.indices = indices;
    data.normals = normals;
    const m = new B.Mesh("rock", this.scene);
    data.applyToMesh(m);
    return m;
  }

  /**
   * Relief : un maillage à la résolution du champ de hauteurs (coupé en triangles comme lui, voir
   * shared/arena/terrain.ts), teinté sommet par sommet (herbe, chemins, sable des berges, roche des
   * pentes et des montagnes, neige des sommets) sous une texture de grain. Un relief à strates
   * (`GroundStyle.strata`) prend à la place une texture de bandes posée selon la hauteur : elle
   * dessine des couches nettes sur une falaise, même entre deux sommets éloignés du maillage.
   */
  private terrain(t: Terrain, water: number, paths: readonly TerrainPath[], layout: ArenaLayout): B.Mesh {
    const n = t.cells + 1;
    const step = t.size / t.cells;
    const positions = new Float32Array(n * n * 3);
    const uvs = new Float32Array(n * n * 2);
    const style = layout.ground;
    const strata = style?.strata?.length ? (style.strataStep ?? 2) * STRATA_BANDS : 0;
    for (let ix = 0; ix < n; ix++) {
      for (let iz = 0; iz < n; iz++) {
        const k = ix * n + iz;
        const x = -t.size / 2 + ix * step;
        const z = -t.size / 2 + iz * step;
        positions.set([x, t.heights[k], z], k * 3);
        uvs.set(strata ? [(x + z * 0.7) / 7, t.heights[k] / strata] : [x / 6, z / 6], k * 2);
      }
    }
    // Chaque case : deux triangles de part et d'autre de la diagonale (ix+1, iz) – (ix, iz+1), comme
    // Rapier ; sommets dans le sens de ceux de CreateGround (normales vers le haut)
    const indices: number[] = [];
    for (let ix = 0; ix < t.cells; ix++) {
      for (let iz = 0; iz < t.cells; iz++) {
        const a = ix * n + iz;
        const b = (ix + 1) * n + iz;
        const c = ix * n + iz + 1;
        const d = (ix + 1) * n + iz + 1;
        indices.push(a, b, c, b, d, c);
      }
    }
    const normals = new Float32Array(n * n * 3);
    B.VertexData.ComputeNormals(positions, indices, normals);
    const colors = new Float32Array(n * n * 4);
    for (let k = 0; k < n * n; k++) {
      const [x, h, z] = [positions[k * 3], positions[k * 3 + 1], positions[k * 3 + 2]];
      const c = groundColor(x, h, z, Math.abs(normals[k * 3 + 1]), water, paths, layout);
      colors.set([c.r, c.g, c.b, 1], k * 4);
    }
    const data = new B.VertexData();
    data.positions = positions;
    data.indices = indices;
    data.normals = normals;
    data.colors = colors;
    data.uvs = uvs;
    const mesh = new B.Mesh("terrain", this.scene);
    // (modifiable : l'éditeur de cartes remodèle le relief à chaque image d'un coup de pinceau)
    data.applyToMesh(mesh, this.editable);
    const mat = strata ? this.material("terrain-strata", () => this.textured("terrain-strata", drawStrata)) : this.material("terrain", () => this.textured("terrain", drawGrain));
    mat.specularColor = new B.Color3(0, 0, 0);
    mesh.material = mat;
    mesh.receiveShadows = true;
    if (this.editable) {
      // L'éditeur vise le relief sans la scène (shared/arena/terrain.ts) : ni découpé, ni figé
      mesh.isPickable = false;
      this.terrainState = { mesh, cells: t.cells, size: t.size, positions, normals, colors };
      return mesh;
    }
    // En réseau, on vise par la scène : découpé, le relief ne se teste que près du rayon
    mesh.subdivide(64);
    mesh.freezeWorldMatrix();
    return mesh;
  }

  /** L'eau : un plan translucide, qui ne se voit qu'au-dessus du lit de la rivière (ou de la mer). */
  private water(size: number, level: number, color = "#3f6f86"): B.Mesh {
    const m = B.MeshBuilder.CreateGround("water", { width: size, height: size }, this.scene);
    m.position.y = level;
    const mat = this.material(`water-${color}`, () => {
      const w = new B.StandardMaterial("water", this.scene);
      w.diffuseColor = B.Color3.FromHexString(color);
      w.specularColor = new B.Color3(0.5, 0.55, 0.6);
      w.specularPower = 64;
      w.alpha = 0.72;
      return w;
    });
    m.material = mat;
    m.isPickable = false;
    m.receiveShadows = true;
    // La première des surfaces transparentes : ce qui flotte au-dessus (fumée, flammes, explosions) se
    // dessine ensuite, par-dessus elle. Sans cela (rang par défaut, le dernier), la nappe passait après
    // la fumée, qu'elle teintait de bleu jusqu'à la berge.
    m.alphaIndex = 0;
    m.freezeWorldMatrix();
    return m;
  }

  /**
   * La lave : les triangles du relief qu'elle couvre (`ArenaLayout.lava`), un peu au-dessus de lui,
   * qui brillent d'eux-mêmes (couleur émise : la nuit comme le jour, et dans le halo) ; une croûte
   * sombre qui défile lentement par-dessus. Pas sous la mer (là où une coulée s'y jette).
   */
  private lava(t: Terrain, layout: ArenaLayout): B.Mesh {
    const n = t.cells + 1;
    const step = t.size / t.cells;
    const water = layout.water ?? -Infinity;
    const positions: number[] = [];
    const colors: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const index = new Map<number, number>();
    const vertex = (ix: number, iz: number): number => {
      const k = ix * n + iz;
      let v = index.get(k);
      if (v === undefined) {
        const x = -t.size / 2 + ix * step;
        const z = -t.size / 2 + iz * step;
        const depth = lavaAt(layout.lava, x, z, 2);
        // Au bord, la croûte ; au milieu, la lave qui coule, et par endroits son cœur jaune
        const heat = clamp(depth / 1.6, 0, 1) * (0.75 + 0.25 * noise2(x / 3.1, z / 3.1));
        const c = heat > 0.55 ? B.Color3.Lerp(LAVA_FLOW, LAVA_HOT, (heat - 0.55) / 0.45) : B.Color3.Lerp(LAVA_CRUST, LAVA_FLOW, heat / 0.55);
        v = positions.length / 3;
        positions.push(x, t.heights[k] + 0.06, z);
        colors.push(c.r, c.g, c.b, 1);
        uvs.push(x / 7, z / 7);
        index.set(k, v);
      }
      return v;
    };
    const inside = (ix: number, iz: number): boolean => lavaAt(layout.lava, -t.size / 2 + ix * step, -t.size / 2 + iz * step) > -0.4;
    const dry = (ix: number, iz: number): boolean => t.heights[ix * n + iz] > water - 0.15;
    for (let ix = 0; ix < t.cells; ix++) {
      for (let iz = 0; iz < t.cells; iz++) {
        // Les deux triangles de la case, coupés comme le relief ; un triangle dont un sommet est dans la lave
        for (const tri of [[[ix, iz], [ix + 1, iz], [ix, iz + 1]], [[ix + 1, iz], [ix + 1, iz + 1], [ix, iz + 1]]]) {
          if (!tri.some(([a, b]) => inside(a, b)) || !tri.every(([a, b]) => dry(a, b))) continue;
          indices.push(...tri.map(([a, b]) => vertex(a, b)));
        }
      }
    }
    const normals: number[] = [];
    B.VertexData.ComputeNormals(positions, indices, normals);
    const data = new B.VertexData();
    data.positions = positions;
    data.indices = indices;
    data.normals = normals;
    data.colors = colors;
    data.uvs = uvs;
    const mesh = new B.Mesh("lava", this.scene);
    data.applyToMesh(mesh);
    mesh.material = this.material("lava", () => {
      const mat = this.textured("lava", drawLavaCrust);
      this.lavaTexture = mat.diffuseTexture as B.Texture;
      // Sans éclairage : la couleur des sommets, multipliée par la croûte, est celle qu'on voit ; le halo
      // (s'il est réglé) prend la couleur émise : orangée, pas blanche
      mat.emissiveTexture = mat.diffuseTexture;
      mat.disableLighting = true;
      mat.emissiveColor = new B.Color3(1, 0.62, 0.32);
      return mat;
    });
    mesh.isPickable = false;
    mesh.receiveShadows = false;
    mesh.freezeWorldMatrix();
    return mesh;
  }

  /** Une cascade : un rideau d'eau qui tombe en défilant, translucide, tourné vers l'aval. */
  private waterfall(fall: Waterfall): B.Mesh {
    const height = fall.top - fall.bottom;
    const m = B.MeshBuilder.CreatePlane("waterfall", { width: fall.width, height, sideOrientation: B.Mesh.DOUBLESIDE }, this.scene);
    m.position.set(fall.x, fall.bottom + height / 2, fall.z);
    m.rotation.y = fall.dir;
    // Un peu penché vers l'aval : l'eau quitte la roche en avançant
    m.rotation.x = 0.12;
    m.material = this.material("waterfall", () => {
      const mat = this.textured("waterfall", drawFallingWater);
      const tex = mat.diffuseTexture as B.Texture;
      tex.vScale = height / 2;
      this.fallTexture = tex;
      mat.diffuseTexture!.hasAlpha = true;
      mat.useAlphaFromDiffuseTexture = true;
      mat.emissiveColor = new B.Color3(0.35, 0.4, 0.42);
      mat.specularColor = new B.Color3(0.4, 0.45, 0.5);
      mat.backFaceCulling = false;
      return mat;
    });
    m.isPickable = false;
    return m;
  }
}

/** Planches d'un pont de bois : des lattes en travers, de teintes un peu différentes, et leurs joints. */
function drawBoards(c: Ctx): void {
  c.fillStyle = "#3b2c1f";
  c.fillRect(0, 0, 256, 256);
  let seed = 7;
  const random = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const boards = 8;
  const w = 256 / boards;
  for (let i = 0; i < boards; i++) {
    const shade = 0.82 + random() * 0.3;
    c.fillStyle = `rgb(${Math.round(150 * shade)}, ${Math.round(112 * shade)}, ${Math.round(72 * shade)})`;
    c.fillRect(i * w + 2, 0, w - 4, 256);
    // Le fil du bois et deux clous à chaque bout
    c.strokeStyle = "rgba(60, 40, 22, 0.35)";
    c.lineWidth = 1;
    for (let k = 0; k < 3; k++) {
      const x = i * w + 5 + random() * (w - 10);
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x + random() * 4 - 2, 256); c.stroke();
    }
    c.fillStyle = "#2a2622";
    for (const y of [14, 242]) for (const x of [i * w + 8, i * w + w - 10]) c.fillRect(x, y, 3, 3);
  }
}

/** Acier rouillé d'une épave : des tôles rivetées, coulées de rouille et plaques de peinture qui reste. */
function drawRust(c: Ctx): void {
  c.fillStyle = "#6e3b26";
  c.fillRect(0, 0, 256, 256);
  let seed = 17;
  const random = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // Restes de peinture (gris bleu) et taches plus sombres
  for (let i = 0; i < 26; i++) {
    c.fillStyle = random() < 0.4 ? `rgba(84, 98, 104, ${0.5 + random() * 0.3})` : `rgba(48, 24, 14, ${0.25 + random() * 0.3})`;
    c.fillRect(random() * 256, random() * 256, 10 + random() * 60, 8 + random() * 40);
  }
  // Coulées de rouille vers le bas
  for (let i = 0; i < 40; i++) {
    const x = random() * 256;
    const y = random() * 200;
    c.strokeStyle = `rgba(150, 72, 30, ${0.25 + random() * 0.35})`;
    c.lineWidth = 1 + random() * 3;
    c.beginPath(); c.moveTo(x, y); c.lineTo(x + random() * 4 - 2, y + 20 + random() * 50); c.stroke();
  }
  // Joints des tôles et rivets
  c.strokeStyle = "rgba(35, 18, 10, 0.8)";
  c.lineWidth = 2;
  for (let k = 0; k <= 256; k += 64) {
    c.beginPath(); c.moveTo(k, 0); c.lineTo(k, 256); c.stroke();
    c.beginPath(); c.moveTo(0, k); c.lineTo(256, k); c.stroke();
    c.fillStyle = "rgba(30, 16, 10, 0.9)";
    for (let t = 6; t < 256; t += 12) {
      c.fillRect(k + 3, t, 2, 2);
      c.fillRect(t, k + 3, 2, 2);
    }
  }
}

/** Croûte de la lave (multiplie la couleur des sommets) : du clair (la lave à nu) taché de plaques sombres et de fissures. */
function drawLavaCrust(c: Ctx): void {
  c.fillStyle = "#ffffff";
  c.fillRect(0, 0, 256, 256);
  let seed = 31;
  const random = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 90; i++) {
    const x = random() * 256;
    const y = random() * 256;
    const r = 6 + random() * 22;
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, "rgba(40, 18, 12, 0.85)");
    g.addColorStop(1, "rgba(40, 18, 12, 0)");
    c.fillStyle = g;
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  }
  c.strokeStyle = "rgba(255, 236, 170, 0.9)";
  c.lineWidth = 1.5;
  for (let i = 0; i < 40; i++) {
    let x = random() * 256;
    let y = random() * 256;
    c.beginPath();
    c.moveTo(x, y);
    for (let k = 0; k < 5; k++) {
      x += random() * 24 - 12;
      y += random() * 24 - 12;
      c.lineTo(x, y);
    }
    c.stroke();
  }
}

/** Eau qui tombe : des filets verticaux blancs et bleutés, plus ou moins opaques (la texture défile vers le bas). */
function drawFallingWater(c: Ctx): void {
  c.clearRect(0, 0, 256, 256);
  let seed = 5;
  const random = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 140; i++) {
    const x = random() * 256;
    const y = random() * 256;
    const length = 30 + random() * 120;
    const a = 0.25 + random() * 0.55;
    c.strokeStyle = random() < 0.5 ? `rgba(240, 248, 255, ${a})` : `rgba(170, 210, 225, ${a})`;
    c.lineWidth = 2 + random() * 5;
    c.beginPath(); c.moveTo(x, y); c.lineTo(x, y + length); c.stroke();
    // La texture se répète en hauteur : un filet qui dépasse reprend en haut
    if (y + length > 256) { c.beginPath(); c.moveTo(x, y - 256); c.lineTo(x, y + length - 256); c.stroke(); }
  }
}

/**
 * Distance d'un point au chemin le plus proche, moins sa demi-largeur (< 0 : dessus) ; seulement ceux
 * de cette surface. Au-delà d'un mètre du bord d'un chemin, elle peut valoir Infinity.
 */
function pathDistance(x: number, z: number, paths: readonly TerrainPath[], surface: PathSurface = "dirt"): number {
  let best = Infinity;
  for (const p of paths) {
    if ((p.surface ?? "dirt") !== surface) continue;
    // Hors de son emprise (à plus d'un mètre de son bord), un chemin ne teinte pas le sol : on ne le mesure pas
    const box = pathBox(p);
    if (x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ) continue;
    for (let i = 1; i < p.points.length; i++) {
      const [ax, az] = p.points[i - 1];
      const [bx, bz] = p.points[i];
      const dx = bx - ax;
      const dz = bz - az;
      const t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1), 0, 1);
      best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t) - p.width / 2);
    }
  }
  return best;
}

const mix = (a: B.Color3, b: B.Color3, t: number): B.Color3 => B.Color3.Lerp(a, b, clamp(t, 0, 1));

/** Emprise d'un chemin (sa largeur comprise, et un mètre de plus), calculée une fois. */
const pathBoxes = new WeakMap<TerrainPath, { minX: number; maxX: number; minZ: number; maxZ: number }>();
function pathBox(p: TerrainPath): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let box = pathBoxes.get(p);
  if (!box) {
    const w = p.width / 2 + 1;
    const xs = p.points.map((q) => q[0]);
    const zs = p.points.map((q) => q[1]);
    box = { minX: Math.min(...xs) - w, maxX: Math.max(...xs) + w, minZ: Math.min(...zs) - w, maxZ: Math.max(...zs) + w };
    pathBoxes.set(p, box);
  }
  return box;
}

/**
 * Couleur du sol en un sommet du relief (hauteur `h`, composante verticale de sa normale `up`),
 * dans la palette de l'arène (`ArenaLayout.ground` ; sans elle, celle de la Vallée).
 */
export function groundColor(x: number, h: number, z: number, up: number, water: number, paths: readonly TerrainPath[], arena?: ArenaLayout): B.Color3 {
  const p = palette(arena);
  let c = mix(p.base[0], p.base[1], 0.5 + 0.5 * noise2(x / p.grain, z / p.grain));
  for (const q of p.patches) c = mix(c, q.color, 1.6 * (1 - Math.hypot(x - q.x, z - q.z) / q.r) + 0.25 * noise2(x / 4, z / 4));
  c = mix(c, p.dirt, p.stains * (0.5 + 0.5 * noise2(x / 23 + 5, z / 23 - 3)));
  c = mix(c, p.dirt, 1 - clamp(pathDistance(x, z, paths) / 1.5 + 0.5, 0, 1));
  // Une pelouse, une piste en herbe rase (le sol éclairci), un chemin de sable
  if (paths.some((q) => q.surface === "grass")) c = mix(c, p.lawn ?? B.Color3.Lerp(p.base[1], new B.Color3(0.85, 0.9, 0.6), 0.25), 1 - clamp(pathDistance(x, z, paths, "grass") / 1.5 + 0.5, 0, 1));
  if (paths.some((q) => q.surface === "sand")) c = mix(c, p.sand, 1 - clamp(pathDistance(x, z, paths, "sand") / 1.5 + 0.5, 0, 1));
  const roads = paths.some((q) => q.surface === "road") ? 1 - clamp(pathDistance(x, z, paths, "road") / 1.5 + 0.5, 0, 1) : 0;
  // Berges : sable (la plage), puis boue sous l'eau
  c = mix(c, p.sand, 1 - (h - water) / p.beach);
  c = mix(c, p.mud, (water - h) / 0.5);
  // Pentes raides et montagnes : la roche (ses strates, s'il y en a ; les talus d'une ville), puis le
  // sommet (la neige, la cendre d'un volcan)
  c = mix(c, p.slope ?? (p.strata.length ? strataColor(p, h + 0.8 * noise2(x / 17, z / 17)) : p.rock), (p.slopeFrom - up) / p.slopeSpan);
  c = mix(c, p.rock, (h - p.rockLine) / p.rockSpan);
  c = mix(c, p.peak, (h - p.peakLine) / 5 - (1 - up) * 2);
  // Le basalte figé autour de la lave
  if (p.basalt && arena?.lava) c = mix(c, p.basalt, 1 + lavaAt(arena.lava, x, z, p.basaltWidth) / p.basaltWidth);
  // Une route de gravier : par-dessus la roche et le sommet (elle monte un volcan)
  if (roads > 0) c = mix(c, B.Color3.Lerp(p.dirt, p.rock, 0.35 + 0.15 * noise2(x / 4, z / 4)), roads);
  // Allées, ballast, chaussées : par-dessus tout (un talus, des gravats)
  for (const [surface, color] of PAVINGS) {
    if (paths.some((q) => q.surface === surface)) c = mix(c, color, 1 - clamp(pathDistance(x, z, paths, surface) / 1.5 + 0.5, 0, 1));
  }
  return c;
}

/** Couleur des strates à la hauteur `h` : une couche tous les `strataStep` m, fondue dans la suivante sur son dernier quart. */
function strataColor(p: Palette, h: number): B.Color3 {
  const f = h / p.strataStep;
  const i = Math.floor(f);
  const n = p.strata.length;
  const at = (k: number): B.Color3 => p.strata[((k % n) + n) % n];
  return mix(at(i), at(i + 1), (f - i - 0.75) / 0.25);
}

/**
 * Coordonnées de texture des faces d'une boîte (`h` : ses demi-dimensions, celles d'une chaussée
 * tournée pour courir le long de x). Une voie ferrée du Canyon (posée dans l'axe z de sa boîte) :
 * toute sa largeur sur la texture, des traverses tous les 3 m de texture le long ; grès et
 * charpente : un motif qui se répète au mètre sur chaque face ; un wagon : une texture par face ; un
 * immeuble : une fenêtre par travée et par étage.
 */
function faceUVOf(b: StaticBox, h: { x: number; y: number; z: number }): B.Vector4[] | undefined {
  switch (b.look) {
    case "rail": {
      const top = new B.Vector4(0, 0, 1, (2 * h.z) / 3);
      return [top, top, top, top, top, top];
    }
    case "timber":
      return scaledUV(h, 1.6);
    case "sandstone":
      return scaledUV(h, 6);
    case "wagon":
      return undefined;
    default:
      if (b.kind === "tower") return towerUV(h);
      return b.kind === "road" || b.kind === "deck" || b.kind === "track" ? tiledUV(h, b.kind === "road" ? 12 : 3) : undefined;
  }
}

/**
 * Coordonnées de texture de chaque face d'une boîte du port (dans l'ordre de Babylon : avant,
 * arrière, droite, gauche, dessus, dessous), le motif répété tous les `tile` m.
 */
function harbourUV(h: { x: number; y: number; z: number }, def: HarbourDef): B.Vector4[] {
  const reps = (size: number): number => (def.tile > 0 ? Math.max(1, Math.round((2 * size) / def.tile)) : 1);
  const up = (size: number): number => (def.vertical ? 1 : reps(size));
  const front = new B.Vector4(0, 0, reps(h.x), up(h.y));
  const side = new B.Vector4(0, 0, reps(h.z), up(h.y));
  const top = def.cap ? new B.Vector4(...def.cap) : new B.Vector4(0, 0, reps(h.x), reps(h.z));
  return [front, front, side, side, top, top];
}

/** Bruit fixe pour les textures (le même à chaque chargement). */
function grain(c: Ctx, seed: number, count: number, color: (r: number) => string, size = 3): void {
  let s = seed;
  const random = (): number => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < count; i++) {
    c.fillStyle = color(random());
    c.fillRect(random() * 256, random() * 256, 1 + random() * size, 1 + random() * size);
  }
}

/** Mur de quai : des blocs de béton, plus sombres en bas (mouillés), un liseré jaune en haut. */
function drawQuay(c: Ctx): void {
  c.fillStyle = "#9b988f";
  c.fillRect(0, 0, 256, 256);
  grain(c, 7, 900, (r) => `rgba(${90 + r * 60}, ${88 + r * 58}, ${82 + r * 55}, 0.35)`);
  c.strokeStyle = "rgba(60, 58, 54, 0.55)";
  c.lineWidth = 3;
  for (let y = 0; y <= 256; y += 64) {
    c.beginPath(); c.moveTo(0, y); c.lineTo(256, y); c.stroke();
    for (let x = (y / 64) % 2 ? 0 : 64; x < 256; x += 128) {
      c.beginPath(); c.moveTo(x, y); c.lineTo(x, y + 64); c.stroke();
    }
  }
  c.fillStyle = "rgba(40, 46, 44, 0.35)";
  c.fillRect(0, 170, 256, 86);
}

/** Acier peint des grues : un orangé, des montants et des croisillons sombres (un treillis). */
function drawSteel(c: Ctx): void {
  c.fillStyle = "#d4892a";
  c.fillRect(0, 0, 256, 256);
  grain(c, 11, 500, (r) => `rgba(${120 + r * 60}, ${70 + r * 30}, 30, 0.25)`, 2);
  c.strokeStyle = "#7a4a17";
  c.lineWidth = 14;
  c.strokeRect(7, 7, 242, 242);
  c.lineWidth = 9;
  c.beginPath(); c.moveTo(10, 10); c.lineTo(246, 246); c.moveTo(246, 10); c.lineTo(10, 246); c.stroke();
}

/** Coque : noire au-dessus de la ligne de flottaison, rouge dessous, un liseré blanc au bord. */
function drawHull(c: Ctx): void {
  c.fillStyle = "#1f2a33";
  c.fillRect(0, 0, 256, 256);
  c.fillStyle = "#8c2b22";
  c.fillRect(0, 166, 256, 90);
  c.fillStyle = "#e9e6dc";
  c.fillRect(0, 158, 256, 6);
  c.fillRect(0, 4, 256, 5);
  grain(c, 13, 700, (r) => `rgba(${80 + r * 60}, ${50 + r * 30}, ${40 + r * 20}, 0.25)`);
  // Des coulures de rouille sous les hublots, et les tôles
  c.strokeStyle = "rgba(0, 0, 0, 0.3)";
  c.lineWidth = 2;
  for (let x = 0; x < 256; x += 64) {
    c.beginPath(); c.moveTo(x, 0); c.lineTo(x, 256); c.stroke();
  }
  c.fillStyle = "rgba(140, 70, 30, 0.35)";
  for (let x = 20; x < 256; x += 64) c.fillRect(x, 20, 4, 60);
}

/** Château d'un navire : peint en blanc, des rangées de fenêtres. */
function drawSuperstructure(c: Ctx): void {
  c.fillStyle = "#e6e4dd";
  c.fillRect(0, 0, 256, 256);
  grain(c, 17, 400, (r) => `rgba(${150 + r * 60}, ${150 + r * 60}, ${145 + r * 60}, 0.3)`, 2);
  c.fillStyle = "#2c3a46";
  for (let y = 40; y < 256; y += 96) {
    for (let x = 18; x < 256; x += 64) c.fillRect(x, y, 34, 34);
  }
  c.fillStyle = "rgba(255, 255, 255, 0.35)";
  for (let y = 40; y < 256; y += 96) {
    for (let x = 18; x < 256; x += 64) c.fillRect(x + 4, y + 4, 10, 26);
  }
}

/** Pont d'un navire, panneaux de cale : de l'acier peint en vert, des tôles soudées, des plots. */
function drawHatch(c: Ctx): void {
  c.fillStyle = "#4d6d47";
  c.fillRect(0, 0, 256, 256);
  grain(c, 19, 900, (r) => `rgba(${50 + r * 40}, ${70 + r * 40}, ${45 + r * 30}, 0.35)`);
  c.strokeStyle = "rgba(20, 30, 20, 0.55)";
  c.lineWidth = 3;
  c.strokeRect(2, 2, 252, 252);
  c.beginPath(); c.moveTo(128, 0); c.lineTo(128, 256); c.stroke();
  c.fillStyle = "rgba(230, 200, 60, 0.6)";
  c.fillRect(0, 0, 256, 6);
}

/** Cheminée : noire en haut, une bande rouge, puis le bleu de la compagnie. */
function drawFunnel(c: Ctx): void {
  c.fillStyle = "#29506e";
  c.fillRect(0, 0, 256, 256);
  c.fillStyle = "#c0332a";
  c.fillRect(0, 60, 256, 40);
  c.fillStyle = "#f2efe6";
  c.fillRect(0, 100, 256, 10);
  c.fillStyle = "#16181a";
  c.fillRect(0, 0, 256, 60);
}

/** Phare : blanc, une large bande rouge au milieu. */
function drawLighthouse(c: Ctx): void {
  c.fillStyle = "#f1efe8";
  c.fillRect(0, 0, 256, 256);
  c.fillStyle = "#b8302a";
  c.fillRect(0, 96, 256, 64);
  grain(c, 37, 300, (r) => `rgba(${150 + r * 60}, ${150 + r * 60}, ${150 + r * 60}, 0.25)`, 2);
}

/** Lanterne d'un phare : une lumière chaude, des montants. */
function drawLamp(c: Ctx): void {
  c.fillStyle = "#fff1c2";
  c.fillRect(0, 0, 256, 256);
  c.fillStyle = "rgba(60, 50, 30, 0.6)";
  for (let x = 0; x < 256; x += 64) c.fillRect(x, 0, 6, 256);
}

/** Silo : béton clair, des joints verticaux, une ceinture sombre en haut. */
function drawSilo(c: Ctx): void {
  c.fillStyle = "#c9c4b8";
  c.fillRect(0, 0, 256, 256);
  grain(c, 41, 900, (r) => `rgba(${150 + r * 50}, ${145 + r * 50}, ${135 + r * 50}, 0.35)`);
  c.fillStyle = "rgba(90, 86, 78, 0.45)";
  for (let x = 0; x < 256; x += 64) c.fillRect(x, 0, 3, 256);
  c.fillStyle = "#77736a";
  c.fillRect(0, 0, 256, 14);
  c.fillStyle = "rgba(60, 70, 60, 0.25)";
  c.fillRect(0, 200, 256, 56);
}

/** Coordonnées de texture de chaque face d'une boîte : le motif se répète tous les `tile` m. */
function scaledUV(h: { x: number; y: number; z: number }, tile: number): B.Vector4[] {
  const w = (2 * h.x) / tile;
  const y = (2 * h.y) / tile;
  const d = (2 * h.z) / tile;
  return [new B.Vector4(0, 0, w, y), new B.Vector4(0, 0, w, y), new B.Vector4(0, 0, d, y), new B.Vector4(0, 0, d, y), new B.Vector4(0, 0, w, d), new B.Vector4(0, 0, w, d)];
}

/** Coordonnées de texture d'une boîte dont le motif se répète tous les `tile` m (le long de sa plus grande longueur). */
function tiledUV(h: { x: number; y: number; z: number }, tile: number): B.Vector4[] {
  const along = Math.max(h.x, h.z) * 2 / tile;
  const across = 1;
  const top = h.x >= h.z ? new B.Vector4(0, 0, along, across) : new B.Vector4(0, 0, across, along);
  return [top, top, top, top, top, top];
}

/**
 * Coordonnées de texture d'un immeuble : sur chaque façade, une fenêtre par travée de TOWER_BAY m
 * et par étage de TOWER_STOREY m (la texture en a deux sur deux) ; le toit, d'une seule teinte.
 */
function towerUV(h: { x: number; y: number; z: number }): B.Vector4[] {
  const w = (h.x * 2) / (TOWER_BAY * 2);
  const d = (h.z * 2) / (TOWER_BAY * 2);
  const y = (h.y * 2) / (TOWER_STOREY * 2);
  const roof = new B.Vector4(0.02, 0.02, 0.06, 0.06);
  return [new B.Vector4(0, 0, w, y), new B.Vector4(0, 0, w, y), new B.Vector4(0, 0, d, y), new B.Vector4(0, 0, d, y), roof, roof];
}

/**
 * Façade d'un immeuble éventré, deux travées sur deux étages : béton taché, une fenêtre par
 * travée (sombre, soufflée et noircie de suie, murée de parpaings), dalles d'étage apparentes.
 */
function drawTowerFacade(c: Ctx): void {
  const n = 512;
  let seed = 4242;
  const random = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  c.fillStyle = "#8f8a80";
  c.fillRect(0, 0, n, n);
  for (let i = 0; i < 2200; i++) {
    const g = 105 + random() * 70;
    c.fillStyle = `rgba(${g}, ${g - 4}, ${g - 12}, 0.3)`;
    c.fillRect(random() * n, random() * n, 2 + random() * 5, 2 + random() * 5);
  }
  for (let i = 0; i < 24; i++) {
    c.fillStyle = `rgba(55, 52, 46, ${0.08 + random() * 0.12})`;
    c.fillRect(random() * n, random() * n * 0.6, 4 + random() * 8, n * (0.2 + random() * 0.4));
  }
  for (let row = 0; row < 2; row++) {
    // Dalle d'étage, au bas de chaque étage
    c.fillStyle = "#7a766e";
    c.fillRect(0, row * 256 + 236, n, 20);
    for (let col = 0; col < 2; col++) {
      const x0 = col * 256 + 58;
      const y0 = row * 256 + 54;
      const kind = (row * 3 + col) % 4; // 0 et 3 : sombre ; 1 : soufflée ; 2 : murée
      if (kind === 1) {
        const soot = c.createLinearGradient(0, y0 - 60, 0, y0 + 20);
        soot.addColorStop(0, "rgba(18, 16, 14, 0)");
        soot.addColorStop(1, "rgba(18, 16, 14, 0.8)");
        c.fillStyle = soot;
        c.fillRect(x0 - 10, y0 - 60, 160, 80);
      }
      c.fillStyle = "#b3ad9f";
      c.fillRect(x0 - 8, y0 - 8, 156, 156);
      c.fillStyle = kind === 1 ? "#0f0e0d" : kind === 2 ? "#77726a" : "#262c31";
      c.fillRect(x0, y0, 140, 140);
      if (kind === 2) {
        // Parpaings
        c.strokeStyle = "rgba(40, 38, 34, 0.6)";
        c.lineWidth = 2;
        for (let r = 0; r < 7; r++) {
          c.beginPath(); c.moveTo(x0, y0 + r * 20); c.lineTo(x0 + 140, y0 + r * 20); c.stroke();
          for (let k = (r % 2) * 20; k < 140; k += 40) {
            c.beginPath(); c.moveTo(x0 + k, y0 + r * 20); c.lineTo(x0 + k, y0 + r * 20 + 20); c.stroke();
          }
        }
      } else if (kind !== 1) {
        c.fillStyle = "#3c4852";
        c.fillRect(x0 + 8, y0 + 8, 58, 124);
        c.fillRect(x0 + 74, y0 + 8, 58, 124);
      }
    }
  }
}

/** Motifs de façade (deux fenêtres sur deux étages chacun) que couvre la texture des fenêtres éclairées, en largeur et en hauteur. */
const TOWER_WINDOW_TILES = 4;

/**
 * Les fenêtres éclairées des immeubles du bord, la nuit : aux places de celles de
 * `drawTowerFacade` (à demi-résolution), sur quatre motifs sur quatre ; seules les fenêtres entières
 * (pas les soufflées ni les murées) s'allument, une sur quatre environ, d'une lampe chaude ou d'un
 * écran bleuté.
 */
function drawTowerWindows(c: Ctx): void {
  let seed = 991;
  const random = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  c.fillStyle = "#000000";
  c.fillRect(0, 0, 1024, 1024);
  const tints = ["#c99550", "#d8a85e", "#b8783c", "#e0bc80", "#7f97c8"];
  for (let tu = 0; tu < TOWER_WINDOW_TILES; tu++) {
    for (let tv = 0; tv < TOWER_WINDOW_TILES; tv++) {
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 2; col++) {
          const kind = (row * 3 + col) % 4;
          if (kind === 1 || kind === 2 || random() > 0.28) continue;
          const x0 = tu * 256 + (col * 256 + 58) / 2;
          const y0 = tv * 256 + (row * 256 + 54) / 2;
          c.fillStyle = tints[Math.floor(random() * tints.length)];
          c.fillRect(x0 + 4, y0 + 4, 29, 62);
          c.fillRect(x0 + 37, y0 + 4, 29, 62);
        }
      }
    }
  }
}

/** Voie ferrée : ballast, traverses de béton, deux rails le long de la texture (3 m de long sur 3 m de large). */
function drawTrack(c: Ctx): void {
  let seed = 77;
  const random = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  c.fillStyle = "#5f574d";
  c.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2600; i++) {
    const g = 60 + random() * 70;
    c.fillStyle = `rgba(${g + 8}, ${g + 2}, ${g - 6}, 0.8)`;
    c.fillRect(random() * 256, random() * 256, 2 + random() * 4, 2 + random() * 4);
  }
  // Traverses, en travers (une tous les 0,6 m)
  for (let k = 0; k < 5; k++) {
    c.fillStyle = "#7d7a73";
    c.fillRect(k * 51.2 + 14, 22, 22, 212);
    c.fillStyle = "rgba(0, 0, 0, 0.25)";
    c.fillRect(k * 51.2 + 32, 22, 4, 212);
  }
  // Rails, le long de la voie
  for (const y of [62, 188]) {
    c.fillStyle = "#3b3632";
    c.fillRect(0, y - 6, 256, 12);
    c.fillStyle = "#b9b6ae";
    c.fillRect(0, y - 2, 256, 4);
  }
}

/** Grain du sol : un bruit clair, qui ne fait que moduler la couleur des sommets. */
function drawGrain(c: Ctx): void {
  c.fillStyle = "#e4e4e4";
  c.fillRect(0, 0, 256, 256);
  let seed = 99;
  const random = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 2600; i++) {
    const g = 175 + random() * 80;
    c.fillStyle = `rgba(${g}, ${g}, ${g}, 0.7)`;
    c.fillRect(random() * 256, random() * 256, 1 + random() * 3, 1 + random() * 3);
  }
}

/** Hasard fixe des textures : le même motif à chaque partie. */
function fixedRandom(seed: number): () => number {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

/**
 * Strates du relief : STRATA_BANDS bandes horizontales (le long de v, la hauteur), claires ou
 * sombres et d'épaisseurs inégales, sur un grain clair ; elles ne font que moduler la couleur des sommets.
 */
function drawStrata(c: Ctx): void {
  const random = fixedRandom(7);
  const band = 256 / STRATA_BANDS;
  for (let i = 0; i < STRATA_BANDS; i++) {
    const g = 200 + random() * 55;
    c.fillStyle = `rgb(${g}, ${g}, ${g})`;
    c.fillRect(0, i * band, 256, band);
    // Un liseré à peine plus sombre à la base de chaque couche (marqué, il dessinait des courbes de
    // niveau sur le sol presque plat), et une couche claire au milieu
    c.fillStyle = "rgba(60, 40, 30, 0.08)";
    c.fillRect(0, i * band + band - 3, 256, 3);
    c.fillStyle = `rgba(255, 245, 230, ${0.05 + random() * 0.08})`;
    c.fillRect(0, i * band + band * (0.3 + random() * 0.3), 256, 3 + random() * 4);
  }
}

/** Grès : un rouge orangé tacheté, à peine veiné de couches (en bandes nettes, son dessus semblait fait de planches). */
function drawSandstone(c: Ctx): void {
  const random = fixedRandom(19);
  c.fillStyle = "#b8673f";
  c.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 90; i++) {
    c.fillStyle = random() < 0.5 ? `rgba(225, 160, 110, ${0.1 + random() * 0.15})` : `rgba(110, 45, 25, ${0.08 + random() * 0.12})`;
    c.beginPath();
    c.ellipse(random() * 256, random() * 256, 8 + random() * 30, 4 + random() * 12, 0, 0, Math.PI * 2);
    c.fill();
  }
  for (let y = 0; y < 256; y += 20 + random() * 30) {
    c.fillStyle = `rgba(110, 45, 25, ${0.06 + random() * 0.08})`;
    c.fillRect(0, y, 256, 2 + random() * 3);
  }
  for (let i = 0; i < 1400; i++) {
    c.fillStyle = `rgba(${random() < 0.5 ? "90, 40, 25" : "235, 190, 150"}, 0.25)`;
    c.fillRect(random() * 256, random() * 256, 1 + random() * 3, 1 + random() * 2);
  }
}

/** Charpente : des madriers de bois grisé par le soleil, leurs joints et leur fil. */
function drawTimber(c: Ctx): void {
  const random = fixedRandom(31);
  const boards = 4;
  const h = 256 / boards;
  for (let i = 0; i < boards; i++) {
    const shade = 0.85 + random() * 0.25;
    c.fillStyle = `rgb(${Math.round(128 * shade)}, ${Math.round(96 * shade)}, ${Math.round(66 * shade)})`;
    c.fillRect(0, i * h, 256, h);
    c.strokeStyle = "rgba(60, 40, 22, 0.35)";
    c.lineWidth = 1;
    for (let k = 0; k < 6; k++) {
      const y = i * h + 4 + random() * (h - 8);
      c.beginPath(); c.moveTo(0, y); c.lineTo(256, y + random() * 6 - 3); c.stroke();
    }
    c.fillStyle = "#3a2716";
    c.fillRect(0, i * h, 256, 3);
  }
  // Boulons
  c.fillStyle = "#2a2a2a";
  for (const [x, y] of [[20, 30], [236, 30], [20, 222], [236, 222]]) c.fillRect(x, y, 6, 6);
}

/**
 * Voie ferrée vue de dessus, dans l'axe v : du ballast, cinq traverses de bois, deux rails d'acier
 * (u : sa largeur, 2,6 m ; l'écartement fait à peu près celui d'une vraie voie).
 */
function drawRail(c: Ctx): void {
  const random = fixedRandom(43);
  c.fillStyle = "#7d6f62";
  c.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1800; i++) {
    const g = 90 + random() * 80;
    c.fillStyle = `rgba(${g + 10}, ${g}, ${g - 10}, 0.8)`;
    c.fillRect(random() * 256, random() * 256, 2 + random() * 3, 2 + random() * 3);
  }
  for (let i = 0; i < 5; i++) {
    const y = i * 51.2 + 12;
    c.fillStyle = "#5a4330";
    c.fillRect(30, y, 196, 22);
    c.fillStyle = "rgba(30, 20, 10, 0.4)";
    c.fillRect(30, y + 18, 196, 4);
  }
  for (const x of [78, 170]) {
    c.fillStyle = "#4a4d50";
    c.fillRect(x - 2, 0, 12, 256);
    c.fillStyle = "#b9bcbf";
    c.fillRect(x + 1, 0, 5, 256);
  }
}

/** Tablier du viaduc : des planches en travers, la voie au milieu, deux bandes de roulement. */
function drawRailDeck(c: Ctx): void {
  const random = fixedRandom(57);
  for (let y = 0; y < 256; y += 16) {
    const shade = 0.82 + random() * 0.25;
    c.fillStyle = `rgb(${Math.round(120 * shade)}, ${Math.round(90 * shade)}, ${Math.round(62 * shade)})`;
    c.fillRect(0, y, 256, 16);
    c.fillStyle = "rgba(40, 25, 12, 0.5)";
    c.fillRect(0, y + 14, 256, 2);
  }
  for (const x of [104, 146]) {
    c.fillStyle = "#4a4d50";
    c.fillRect(x - 2, 0, 9, 256);
    c.fillStyle = "#b9bcbf";
    c.fillRect(x, 0, 4, 256);
  }
}

/** Wagon de marchandises : planches rouge sombre, cadre et ferrures noirs, une porte coulissante. */
function drawWagon(c: Ctx): void {
  const random = fixedRandom(71);
  for (let x = 0; x < 256; x += 16) {
    const shade = 0.85 + random() * 0.2;
    c.fillStyle = `rgb(${Math.round(128 * shade)}, ${Math.round(46 * shade)}, ${Math.round(32 * shade)})`;
    c.fillRect(x, 0, 16, 256);
    c.fillStyle = "rgba(30, 10, 5, 0.45)";
    c.fillRect(x, 0, 2, 256);
  }
  c.strokeStyle = "#1f1b19";
  c.lineWidth = 10;
  c.strokeRect(5, 5, 246, 246);
  c.lineWidth = 6;
  c.strokeRect(80, 40, 96, 190);
  c.beginPath(); c.moveTo(80, 40); c.lineTo(176, 230); c.stroke();
}

/** Pierre du pont : des blocs taillés. */
function drawStone(c: Ctx): void {
  c.fillStyle = "#8e8a80";
  c.fillRect(0, 0, 256, 256);
  c.strokeStyle = "#6c685f";
  c.lineWidth = 4;
  for (let r = 0; r < 4; r++) {
    c.beginPath(); c.moveTo(0, r * 64); c.lineTo(256, r * 64); c.stroke();
    for (let x = (r % 2) * 48; x < 256; x += 96) {
      c.beginPath(); c.moveTo(x, r * 64); c.lineTo(x, r * 64 + 64); c.stroke();
    }
  }
}

/** Piste : asphalte, bandes blanches sur les bords et tirets au milieu (le long de la texture). */
function drawRunway(c: Ctx): void {
  c.fillStyle = "#3c3f42";
  c.fillRect(0, 0, 256, 256);
  c.fillStyle = "#e8e6df";
  c.fillRect(0, 10, 256, 6);
  c.fillRect(0, 240, 256, 6);
  c.fillRect(20, 124, 120, 8);
}

/** Conteneur : tôle ondulée de sa couleur, nervures dans le sens de la hauteur. */
function drawContainer(c: Ctx, color: string, _long: boolean): void {
  c.fillStyle = color;
  c.fillRect(0, 0, 256, 256);
  for (let x = 0; x < 256; x += 16) {
    c.fillStyle = "rgba(0, 0, 0, 0.18)";
    c.fillRect(x, 0, 5, 256);
    c.fillStyle = "rgba(255, 255, 255, 0.12)";
    c.fillRect(x + 8, 0, 3, 256);
  }
  c.strokeStyle = "rgba(0, 0, 0, 0.35)";
  c.lineWidth = 6;
  c.strokeRect(3, 3, 250, 250);
}
