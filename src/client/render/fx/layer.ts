import * as B from "../../babylon";

/**
 * Mélange d'une couche d'effets : `blend` (fumée, poussière, traces au sol : l'opacité compte, on
 * voit à travers) ou `add` (feu, étincelles, lueurs : la couleur s'ajoute à ce qui est derrière,
 * le noir est transparent).
 */
export type Blend = "blend" | "add";

/** Valeurs de Babylon (`Material.MATERIAL_ALPHABLEND`, `Constants.ALPHA_ADD`, `ALPHA_COMBINE`). */
const TRANSPARENCY_BLEND = 2;
const ALPHA_ADD = 1;
const ALPHA_COMBINE = 2;

export interface LayerOptions {
  blend: Blend;
  /** Éclairée par le soleil (fumée, terre) ou de sa propre couleur (feu, vapeur blanche, lueurs). */
  lit: boolean;
  /** Instances au plus. */
  capacity: number;
  /** Décalage de profondeur (négatif : passe devant ce qu'elle recouvre, pour les marques au sol). */
  zOffset?: number;
  /** Part de lumière propre d'une couche éclairée : son côté à l'ombre n'est pas noir. */
  selfLight?: number;
  /** Ordre de dessin entre couches transparentes (plus petit : avant ; par défaut, après les effets). */
  alphaIndex?: number;
}

/**
 * Une couche d'effets : un seul mesh, dessiné en instances fines (un appel au GPU pour toutes),
 * chacune avec sa matrice et sa couleur (opacité comprise). On la remplit à chaque image
 * (`begin`, `write…`, `end`) : seules les instances écrites sont envoyées au GPU.
 */
export class InstanceLayer {
  readonly mesh: B.Mesh;
  readonly capacity: number;
  private readonly matrices: Float32Array;
  private readonly colors: Float32Array;
  private count = 0;
  /** Les tampons ont-ils été envoyés une première fois en entier ? (Les mises à jour partielles le supposent.) */
  private uploaded = false;

  constructor(scene: B.Scene, name: string, geometry: B.Mesh, options: LayerOptions) {
    this.capacity = options.capacity;
    this.mesh = geometry;
    geometry.name = name;
    const mat = new B.StandardMaterial(name, scene);
    mat.diffuseColor = B.Color3.White();
    mat.specularColor = B.Color3.Black();
    mat.disableLighting = !options.lit;
    // Sans éclairage, Babylon ne garde que la couleur émise (multipliée par celle de l'instance) : blanche, elle rend celle de l'instance
    if (!options.lit) mat.emissiveColor = B.Color3.White();
    else if (options.selfLight) mat.emissiveColor = new B.Color3(options.selfLight, options.selfLight, options.selfLight);
    mat.disableDepthWrite = true;
    mat.transparencyMode = TRANSPARENCY_BLEND;
    mat.alphaMode = options.blend === "add" ? ALPHA_ADD : ALPHA_COMBINE;
    mat.zOffset = options.zOffset ?? 0;
    geometry.material = mat;
    if (options.alphaIndex !== undefined) geometry.alphaIndex = options.alphaIndex;
    geometry.isPickable = false;
    geometry.receiveShadows = false;
    geometry.alwaysSelectAsActiveMesh = true;
    geometry.doNotSyncBoundingInfo = true;
    this.matrices = new Float32Array(options.capacity * 16);
    this.colors = new Float32Array(options.capacity * 4);
    geometry.thinInstanceSetBuffer("matrix", this.matrices, 16, false);
    geometry.thinInstanceSetBuffer("color", this.colors, 4, false);
    geometry.thinInstanceCount = 0;
    geometry.setEnabled(false);
  }

  /** Une image commence : la couche est vide. */
  begin(): void {
    this.count = 0;
  }

  /** Place libre ? */
  get full(): boolean {
    return this.count >= this.capacity;
  }

  /** Une instance alignée sur les axes, de dimensions (sx, sy, sz), en (x, y, z). */
  writeScaled(x: number, y: number, z: number, sx: number, sy: number, sz: number, r: number, g: number, b: number, a: number): void {
    if (this.count >= this.capacity) return;
    const m = this.matrices;
    const o = this.count * 16;
    m[o] = sx; m[o + 1] = 0; m[o + 2] = 0; m[o + 3] = 0;
    m[o + 4] = 0; m[o + 5] = sy; m[o + 6] = 0; m[o + 7] = 0;
    m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = sz; m[o + 11] = 0;
    m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
    this.color(r, g, b, a);
  }

  /**
   * Une instance d'axes quelconques : (ax, ay, az), (bx, by, bz), (cx, cy, cz) sont les images des
   * axes x, y, z du mesh, déjà mises à l'échelle.
   */
  writeBasis(
    x: number, y: number, z: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    r: number, g: number, b: number, a: number,
  ): void {
    if (this.count >= this.capacity) return;
    const m = this.matrices;
    const o = this.count * 16;
    m[o] = ax; m[o + 1] = ay; m[o + 2] = az; m[o + 3] = 0;
    m[o + 4] = bx; m[o + 5] = by; m[o + 6] = bz; m[o + 7] = 0;
    m[o + 8] = cx; m[o + 9] = cy; m[o + 10] = cz; m[o + 11] = 0;
    m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
    this.color(r, g, b, a);
  }

  /** L'image est prête : les instances écrites partent au GPU. */
  end(): void {
    const mesh = this.mesh;
    // La couche se remplit : Babylon revoit les attributs de sa matière. Il ne met la couleur des
    // instances dans le shader (`INSTANCESCOLOR`) que s'il voit des instances quand il les revoit :
    // vérifiée une fois sans instance (la scène vérifiée pendant l'écran de chargement, couche vide),
    // la matière l'oubliait pour de bon, et les marques au sol (cratères, empreintes, traces) se
    // dessinaient blanches et pleines, sans leur couleur ni leur opacité
    if (this.count > 0 && mesh.thinInstanceCount === 0) (mesh as unknown as AttributesDirty)._markSubMeshesAsAttributesDirty();
    if (this.count > 0) {
      if (this.uploaded) {
        mesh.thinInstancePartialBufferUpdate("matrix", this.count, 0);
        mesh.thinInstancePartialBufferUpdate("color", this.count, 0);
      } else {
        mesh.thinInstanceBufferUpdated("matrix");
        mesh.thinInstanceBufferUpdated("color");
        this.uploaded = true;
      }
    }
    mesh.thinInstanceCount = this.count;
    // (sans instance, Babylon dessinerait le mesh lui-même, à l'origine)
    if (mesh.isEnabled() !== this.count > 0) mesh.setEnabled(this.count > 0);
  }

  dispose(): void {
    this.mesh.material?.dispose();
    this.mesh.dispose();
  }

  private color(r: number, g: number, b: number, a: number): void {
    const c = this.colors;
    const o = this.count * 4;
    c[o] = r; c[o + 1] = g; c[o + 2] = b; c[o + 3] = a;
    this.count++;
  }
}

/** Ce que Babylon fait d'un mesh dont les attributs changent (interne : `AbstractMesh`). */
interface AttributesDirty {
  _markSubMeshesAsAttributesDirty(): void;
}

/** Couleur « #rrggbb » en composantes de 0 à 1 (gardée : on la demande à chaque effet). */
export type Rgb = readonly [number, number, number];
const RGB_CACHE = new Map<string, Rgb>();
export function rgb(hex: string): Rgb {
  let c = RGB_CACHE.get(hex);
  if (!c) {
    const n = parseInt(hex.slice(1), 16);
    c = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    RGB_CACHE.set(hex, c);
  }
  return c;
}

/** Hasard des effets : celui du navigateur, pas celui de la simulation (`rand`), qu'ils ne doivent pas déranger. */
export function jitter(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
