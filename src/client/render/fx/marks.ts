import * as B from "../../babylon";
import { groundLevel, type ArenaLayout } from "../../../shared/arena/layout";
import { rayArena } from "../../../shared/arena/ray";
import { vec3, type Vec3 } from "../../../shared/math/vec";
import { InstanceLayer, rgb } from "./layer";

/**
 * Marque au sol : un disque (cratère, brûlure, tache) ou une bande (trace de pneu, de chenille,
 * sillon), posée à plat sur le sol ou le décor, qui s'efface à la fin de sa vie.
 */
export interface MarkSpec {
  color: string;
  /** Durée de vie (s). */
  life: number;
  /** Opacité (1 par défaut). */
  alpha?: number;
  /** Part de la fin de sa vie pendant laquelle elle s'efface (0,3 par défaut). */
  fade?: number;
}

type MarkShape = "disc" | "strip";

const CAPACITY: Record<MarkShape, number> = { disc: 700, strip: 3000 };
const REDUCED_SHARE = 0.4;
/** Hauteur au-dessus du sol (m) : la marque ne se mêle pas à lui. */
const LIFT = 0.025;
/**
 * Rang de dessin des marques parmi les surfaces transparentes : juste après l'eau (0), avant tous
 * les effets (la fumée : 10). Elles collent au sol, ce qui flotte au-dessus passe par-dessus. Au
 * rang par défaut (le dernier), elles se dessinaient après la fumée, et les traces de pneus et les
 * cratères se voyaient à travers un fumigène comme des ombres.
 */
const MARKS_ALPHA_INDEX = 1;

interface Mark {
  x: number; y: number; z: number;
  /** Axes de la marque, mis à l'échelle : largeur, normale (épaisseur nulle), longueur. */
  ax: number; ay: number; az: number;
  nx: number; ny: number; nz: number;
  cx: number; cy: number; cz: number;
  age: number; life: number; alpha: number; fade: number;
  r: number; g: number; b: number;
}

/**
 * Marques au sol, en instances fines (voir `InstanceLayer`). Une marque vit longtemps (des
 * dizaines de secondes) : plein, le champ remplace la plus ancienne.
 */
export class MarkField {
  private readonly layers: Record<MarkShape, InstanceLayer>;
  /** Marques de chaque forme, dans un anneau : `next` est la place de la prochaine (la plus ancienne, plein). */
  private readonly rings: Record<MarkShape, Mark[]> = { disc: [], strip: [] };
  private readonly next: Record<MarkShape, number> = { disc: 0, strip: 0 };
  private limit: Record<MarkShape, number> = { ...CAPACITY };
  /**
   * Bandes provisoires : le bout d'une trace entre sa dernière bande posée et la roue qui la laisse,
   * redessiné à chaque image (`liveStrip`) ; une bande qu'on n'a pas redonnée depuis la dernière
   * image disparaît. Hors de l'anneau : elles ne chassent pas les vraies marques.
   */
  private readonly live = new Map<object, { mark: Mark; fresh: boolean }>();

  constructor(scene: B.Scene) {
    const disc = B.MeshBuilder.CreateCylinder("fx-mark-disc", { height: 0.001, diameter: 1, tessellation: 18 }, scene);
    const strip = B.MeshBuilder.CreateGround("fx-mark-strip", { width: 1, height: 1 }, scene);
    const options = { blend: "blend", lit: true, zOffset: -2, selfLight: 0.2, alphaIndex: MARKS_ALPHA_INDEX } as const;
    this.layers = {
      disc: new InstanceLayer(scene, "fx-mark-disc", disc, { ...options, capacity: CAPACITY.disc }),
      strip: new InstanceLayer(scene, "fx-mark-strip", strip, { ...options, capacity: CAPACITY.strip }),
    };
  }

  /** Un disque de `radius` m, centré en `at` sur la surface de normale `normal`. */
  disc(at: Vec3, normal: Vec3, radius: number, spec: MarkSpec): void {
    const [ax, ay, az] = tangent(normal);
    const d = radius * 2;
    // (l'axe z du disque : x × normale, pour que la base reste directe et que la face du dessus ne soit pas cachée)
    const cx = ay * normal.z - az * normal.y, cy = az * normal.x - ax * normal.z, cz = ax * normal.y - ay * normal.x;
    this.add("disc", at, normal, ax * d, ay * d, az * d, cx * d, cy * d, cz * d, spec);
  }

  /** Une bande de `a` à `b` (sur la surface de normale `normal`), large de `width` m. */
  strip(a: Vec3, b: Vec3, normal: Vec3, width: number, spec: MarkSpec): void {
    // (trop courte : on ne prend pas de place dans l'anneau)
    if (Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) < 1e-3) return;
    const m = this.slot("strip");
    stripAxes(m, a, b, normal, width);
    fill(m, spec);
  }

  /**
   * Bande provisoire de `a` à `b` pour `key` (la roue qui trace) : dessinée à cette image seulement ;
   * redonnée à chaque image, la trace va jusque sous la roue.
   */
  liveStrip(key: object, a: Vec3, b: Vec3, normal: Vec3, width: number, spec: MarkSpec): void {
    let entry = this.live.get(key);
    if (!entry) {
      entry = { mark: {} as Mark, fresh: true };
      this.live.set(key, entry);
    }
    entry.fresh = true;
    if (!stripAxes(entry.mark, a, b, normal, width)) {
      this.live.delete(key);
      return;
    }
    fill(entry.mark, spec);
  }

  setReduced(on: boolean): void {
    for (const shape of ["disc", "strip"] as const) {
      this.limit[shape] = Math.round(CAPACITY[shape] * (on ? REDUCED_SHARE : 1));
      if (this.rings[shape].length > this.limit[shape]) {
        this.rings[shape].length = this.limit[shape];
        this.next[shape] = 0;
      }
    }
  }

  clear(): void {
    for (const shape of ["disc", "strip"] as const) {
      this.rings[shape].length = 0;
      this.next[shape] = 0;
    }
    this.live.clear();
  }

  update(dt: number): void {
    for (const shape of ["disc", "strip"] as const) {
      const layer = this.layers[shape];
      layer.begin();
      for (const m of this.rings[shape]) {
        if (m.age >= m.life) continue;
        m.age += dt;
        const left = 1 - m.age / m.life;
        if (left <= 0) continue;
        const a = m.alpha * Math.min(1, left / m.fade);
        layer.writeBasis(m.x, m.y, m.z, m.ax, m.ay, m.az, m.nx, m.ny, m.nz, m.cx, m.cy, m.cz, m.r, m.g, m.b, a);
      }
      if (shape === "strip") {
        for (const [key, { mark: m, fresh }] of this.live) {
          if (!fresh) {
            this.live.delete(key);
            continue;
          }
          this.live.get(key)!.fresh = false;
          layer.writeBasis(m.x, m.y, m.z, m.ax, m.ay, m.az, m.nx, m.ny, m.nz, m.cx, m.cy, m.cz, m.r, m.g, m.b, m.alpha);
        }
      }
      layer.end();
    }
  }

  dispose(): void {
    for (const layer of Object.values(this.layers)) layer.dispose();
  }

  private add(shape: MarkShape, at: Vec3, normal: Vec3, ax: number, ay: number, az: number, cx: number, cy: number, cz: number, spec: MarkSpec): void {
    const m = this.slot(shape);
    place(m, at, normal, ax, ay, az, cx, cy, cz);
    fill(m, spec);
  }

  /** Place de la prochaine marque de cette forme : une nouvelle, ou la plus ancienne, plein. */
  private slot(shape: MarkShape): Mark {
    const ring = this.rings[shape];
    if (ring.length < this.limit[shape]) {
      const m = {} as Mark;
      ring.push(m);
      return m;
    }
    const m = ring[this.next[shape]];
    this.next[shape] = (this.next[shape] + 1) % ring.length;
    return m;
  }
}

/** Pose une marque en `at` (un peu au-dessus de la surface de normale `normal`), d'axes x `a` et z `c` déjà mis à l'échelle. */
function place(m: Mark, at: Vec3, normal: Vec3, ax: number, ay: number, az: number, cx: number, cy: number, cz: number): void {
  m.x = at.x + normal.x * LIFT; m.y = at.y + normal.y * LIFT; m.z = at.z + normal.z * LIFT;
  m.ax = ax; m.ay = ay; m.az = az;
  // (épaisseur presque nulle : la normale ne sert qu'à orienter la marque)
  m.nx = normal.x * 0.01; m.ny = normal.y * 0.01; m.nz = normal.z * 0.01;
  m.cx = cx; m.cy = cy; m.cz = cz;
}

/** Couleur, opacité et vie d'une marque (elle naît). */
function fill(m: Mark, spec: MarkSpec): void {
  const [r, g, b] = rgb(spec.color);
  m.age = 0; m.life = spec.life; m.alpha = spec.alpha ?? 1; m.fade = spec.fade ?? 0.3;
  m.r = r; m.g = g; m.b = b;
}

/** Axes d'une bande de `a` à `b`, large de `width` ; faux si elle est trop courte pour être dessinée. */
function stripAxes(m: Mark, a: Vec3, b: Vec3, normal: Vec3, width: number): boolean {
  let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-3) return false;
  dx /= len; dy /= len; dz /= len;
  // Largeur : normale × longueur
  let wx = normal.y * dz - normal.z * dy, wy = normal.z * dx - normal.x * dz, wz = normal.x * dy - normal.y * dx;
  const n = Math.hypot(wx, wy, wz) || 1;
  wx /= n; wy /= n; wz /= n;
  place(m, vec3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2), normal, wx * width, wy * width, wz * width, dx * len, dy * len, dz * len);
  return true;
}

/** Un axe unitaire dans le plan de la surface de normale `n` : l'axe x, moins sa part le long de la normale. */
function tangent(n: Vec3): [number, number, number] {
  let x = 1 - n.x * n.x, y = -n.x * n.y, z = -n.x * n.z;
  const len = Math.hypot(x, y, z) || 1;
  x /= len; y /= len; z /= len;
  return [x, y, z];
}

/** Hauteur (m) sous laquelle on cherche le sol ou le décor. */
const PROBE = 3;

/**
 * Le sol sous (x, z) près de la hauteur `near` : sa hauteur et sa normale, sur le relief comme sur
 * le décor (plateformes, ponts, pistes). Null s'il n'y a rien à moins de `PROBE` m dessous.
 */
export function surfaceAt(arena: ArenaLayout, x: number, z: number, near: number): { point: Vec3; normal: Vec3 } | null {
  const y = heightAt(arena, x, z, near);
  if (y === null) return null;
  const e = 0.35;
  const hx = heightAt(arena, x + e, z, near) ?? y;
  const hz = heightAt(arena, x, z + e, near) ?? y;
  // Normale : (−∂h/∂x, 1, −∂h/∂z), normalisée
  const gx = (hx - y) / e, gz = (hz - y) / e;
  const n = Math.hypot(gx, 1, gz);
  return { point: vec3(x, y, z), normal: vec3(-gx / n, 1 / n, -gz / n) };
}

function heightAt(arena: ArenaLayout, x: number, z: number, near: number): number | null {
  const top = near + 0.6;
  const hit = rayArena(arena, vec3(x, top, z), vec3(0, -1, 0), PROBE);
  const ground = groundLevel(arena, x, z);
  const y = hit !== null ? Math.max(top - hit, ground) : ground;
  return top - y <= PROBE ? y : null;
}
