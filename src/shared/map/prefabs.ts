import { box, incline } from "../arena/builders";
import { lavaAt, type LavaShape } from "../arena/features";
import type { ArenaBounds, PropSpot, StaticBox } from "../arena/layout";
import { building, house, PropList, seeded } from "../arena/buildings";
import { propDef, propHalf, type PropType } from "../catalog/props";
import { axisAngle, NO_ROTATION, qmul, qrot, vec3, type Quat, type Vec3 } from "../math/vec";
import { MAP_LIMITS, type MapPath, type MapPrefab, type MapZone, type TreeType } from "./format";
import { dcos, dpow, dsin } from "../math/det";

/*
 * Éléments préfabriqués d'une carte (`MapPrefab`) : quelques champs qui se déplient en accessoires
 * et en boîtes, avec les briques des arènes du jeu (`house` de la Vallée, `building` de la Cité,
 * `incline`). Un bâtiment est construit à l'origine, puis tourné et posé : ses pans gardent ce sur
 * quoi ils reposent (leurs rangs dans la liste), et forment un seul bâtiment pour l'IA. Les bois et
 * les tas de rochers sont semés par un tirage fixe (`seed`) : la carte est une donnée, la même
 * partout.
 */

/** Ce qu'un préfabriqué sait de la carte qu'on construit : le sol, ce qu'il doit éviter, ce qui est déjà posé. */
export interface Site {
  /** Hauteur du sol (m). */
  ground(x: number, z: number): number;
  /** Demi-côté de la zone de jeu, et jusqu'où l'on sème (m). */
  readonly half: number;
  readonly reach: number;
  /** Ce point est-il sur une ligne de départ (à 8 m près) ? On n'y sème rien (voir `spawnGuard`). */
  onSpawnLine(x: number, z: number): boolean;
  readonly zones: readonly MapZone[];
  readonly paths: readonly MapPath[];
  readonly water?: number;
  readonly lava?: readonly LavaShape[];
  readonly boxes: StaticBox[];
  readonly props: PropList;
}

const DEG = Math.PI / 180;
const yawQuat = (deg: number): Quat => axisAngle(vec3(0, 1, 0), deg * DEG);

/** Tourne de `yaw` degrés autour de la verticale, puis pose en (x, z), ce qui a été construit à l'origine. */
function placeSpots(spots: PropSpot[], from: number, x: number, z: number, yaw: number): void {
  const q = yawQuat(yaw);
  for (let i = from; i < spots.length; i++) {
    const s = spots[i];
    const p = yaw ? qrot(q, s.pos) : s.pos;
    spots[i] = { ...s, pos: vec3(p.x + x, p.y, p.z + z), rot: yaw ? qmul(q, s.rot ?? NO_ROTATION) : s.rot };
  }
}

function placeBoxes(boxes: StaticBox[], from: number, x: number, z: number, yaw: number): void {
  const q = yawQuat(yaw);
  for (let i = from; i < boxes.length; i++) {
    const b = boxes[i];
    const p = yaw ? qrot(q, b.pos) : b.pos;
    boxes[i] = { ...b, pos: vec3(p.x + x, p.y, p.z + z), rot: yaw ? qmul(q, b.rot) : b.rot };
  }
}

/** Le plus bas du sol sous un rectangle (demi-côtés `hw`, `hd`) tourné de `yaw` degrés : un bâtiment n'y flotte pas. */
export function lowestUnder(site: Pick<Site, "ground">, x: number, z: number, hw: number, hd: number, yaw = 0): number {
  const c = dcos(yaw * DEG);
  const s = dsin(yaw * DEG);
  let low = site.ground(x, z);
  for (const [u, v] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]) {
    const lx = u * hw;
    const lz = v * hd;
    // Rotation autour de y : (x, z) → (x cos + z sin, -x sin + z cos)
    low = Math.min(low, site.ground(x + lx * c + lz * s, z - lx * s + lz * c));
  }
  return low;
}

/** Demi-emprise au sol (x, z) d'une boîte orientée. */
function footprint(b: StaticBox): { x: number; z: number } {
  const ax = qrot(b.rot, vec3(b.half.x, 0, 0));
  const ay = qrot(b.rot, vec3(0, b.half.y, 0));
  const az = qrot(b.rot, vec3(0, 0, b.half.z));
  return { x: Math.abs(ax.x) + Math.abs(ay.x) + Math.abs(az.x), z: Math.abs(ax.z) + Math.abs(ay.z) + Math.abs(az.z) };
}

/** Points déjà pris (arbres, rochers, accessoires), rangés par cases de 8 m : on sème sans tout reparcourir. */
class Taken {
  private readonly cells = new Map<string, Vec3[]>();
  private static readonly CELL = 8;

  add(x: number, z: number, r: number): void {
    const k = `${Math.floor(x / Taken.CELL)},${Math.floor(z / Taken.CELL)}`;
    let list = this.cells.get(k);
    if (!list) this.cells.set(k, (list = []));
    list.push(vec3(x, r, z));
  }

  /** Rien à moins de `spacing` m (plus le rayon de ce qui est déjà là). */
  clear(x: number, z: number, spacing: number): boolean {
    const reach = Math.ceil((spacing + 4) / Taken.CELL);
    const cx = Math.floor(x / Taken.CELL);
    const cz = Math.floor(z / Taken.CELL);
    for (let i = -reach; i <= reach; i++) {
      for (let j = -reach; j <= reach; j++) {
        for (const p of this.cells.get(`${cx + i},${cz + j}`) ?? []) if (Math.hypot(p.x - x, p.z - z) < spacing + p.y) return false;
      }
    }
    return true;
  }
}

/** Ce qui est déjà posé sur la carte, pour semer à l'écart. */
function takenOf(site: Site): Taken {
  const taken = new Taken();
  for (const s of site.props.spots) {
    const h = propHalf(s.type, s);
    taken.add(s.pos.x, s.pos.z, Math.min(6, Math.max(h.x, h.z)));
  }
  return taken;
}

/** Emprise d'un chemin (m), calculée une fois : on écarte d'emblée ceux qui sont loin. */
const PATH_BOUNDS = new WeakMap<MapPath, { minX: number; maxX: number; minZ: number; maxZ: number }>();
function pathBounds(p: MapPath): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let b = PATH_BOUNDS.get(p);
  if (!b) {
    const w = p.width / 2;
    b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const [x, z] of p.points) {
      b.minX = Math.min(b.minX, x - w);
      b.maxX = Math.max(b.maxX, x + w);
      b.minZ = Math.min(b.minZ, z - w);
      b.maxZ = Math.max(b.maxZ, z + w);
    }
    PATH_BOUNDS.set(p, b);
  }
  return b;
}

/** (x, z) est-il sur ce chemin (à `margin` m près) ? (Distances au carré : on y passe des millions de fois sur une carte chargée.) */
function onPath(p: MapPath, x: number, z: number, margin: number): boolean {
  const b = pathBounds(p);
  if (x < b.minX - margin || x > b.maxX + margin || z < b.minZ - margin || z > b.maxZ + margin) return false;
  const reach = dpow(p.width / 2 + margin, 2);
  for (let i = 1; i < p.points.length; i++) {
    const [ax, az] = p.points[i - 1];
    const dx = p.points[i][0] - ax;
    const dz = p.points[i][1] - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    const ex = x - ax - dx * t;
    const ez = z - az - dz * t;
    if (ex * ex + ez * ez < reach) return true;
  }
  return false;
}

/**
 * Les lignes de départ, à garder libres de ce qu'on sème : un point à moins de 8 m d'une ligne (en
 * travers), sur sa longueur et 8 m de plus. On sème des millions de fois sur une carte chargée : rien
 * n'est alloué, et les lignes du nord et du sud gardent leur calcul d'avant (le même tirage).
 */
export function spawnGuard(bounds: ArenaBounds): (x: number, z: number) => boolean {
  const { spawnLine, spawnSpread, spawns } = bounds;
  if (!spawns) return (x, z) => Math.abs(x) < spawnSpread + 8 && Math.abs(Math.abs(z) - spawnLine) < 8;
  const lines = [spawns.blue, spawns.red].map((l) => ({ x: l.x, z: l.z, c: dcos(l.facing), s: dsin(l.facing), reach: l.spread + 8 }));
  return (x, z) => {
    for (const l of lines) {
      const dx = x - l.x;
      const dz = z - l.z;
      // Le long de la ligne (vers la gauche de l'équipe), et en travers (devant elle)
      if (Math.abs(dx * l.c - dz * l.s) < l.reach && Math.abs(dx * l.s + dz * l.c) < 8) return true;
    }
    return false;
  };
}

/** Un point où semer : ni sur un chemin, une zone, une ligne de départ, dans l'eau ou la lave, ni contre une boîte (le moins coûteux d'abord). */
function sowable(site: Site, x: number, z: number, margin: number): boolean {
  if (Math.abs(x) > site.reach || Math.abs(z) > site.reach) return false;
  if (site.onSpawnLine(x, z)) return false;
  if (site.zones.some((zn) => Math.hypot(zn.x - x, zn.z - z) < zn.radius + 3)) return false;
  if (site.water !== undefined && site.ground(x, z) < site.water + 0.1) return false;
  if (lavaAt(site.lava, x, z, 3) > -3) return false;
  if (site.paths.some((p) => onPath(p, x, z, margin))) return false;
  return !site.boxes.some((b) => {
    if (b.kind === "bound" || b.kind === "road") return false;
    const f = footprint(b);
    return Math.abs(x - b.pos.x) < f.x + margin && Math.abs(z - b.pos.z) < f.z + margin;
  });
}

/** Demi-hauteur nominale des arbres (à l'échelle 1) : leur pied est au sol. */
const TREE_HALF: Record<TreeType, number> = {
  pine: propHalf("pine").y, oak: propHalf("oak").y, palm: propHalf("palm").y, kapok: propHalf("kapok").y, cactus: propHalf("cactus").y,
};

/** Hauteur d'une clôture, d'un muret, selon sa matière (m), et son épaisseur. */
const FENCE_THICK: Record<"brick" | "concrete" | "plank" | "sheet", number> = { plank: 0.1, sheet: 0.08, brick: 0.3, concrete: 0.3 };
const FENCE_PANEL = 2.5;

/** Un conteneur : 6 × 2,6 × 2,4 m (comme ceux de la Vallée), le long de z. */
const CONTAINER = vec3(1.2, 1.3, 3);
const CONTAINER_GAP = 2.6;

/**
 * Déplie un préfabriqué : ses accessoires vont dans `site.props`, ses boîtes dans `site.boxes`.
 * Chaque sorte borne ce qu'elle produit (`MAP_LIMITS`) : une carte ne fait jamais exploser la mémoire.
 */
export function expandPrefab(site: Site, p: MapPrefab): void {
  const P = site.props;
  switch (p.kind) {
    case "house": {
      const yaw = p.yaw ?? 0;
      const ground = p.y ?? lowestUnder(site, p.x, p.z, p.width / 2, p.depth / 2, yaw);
      const from = P.spots.length;
      house(P, {
        x: 0, z: 0, w: p.width, d: p.depth, h: p.height, ground, wall: p.wall, roof: p.roof, roofKind: p.roofKind ?? "gable",
        ridge: "x", door: p.door, through: p.through,
      });
      placeSpots(P.spots, from, p.x, p.z, yaw);
      return;
    }
    case "tenement": {
      const yaw = p.yaw ?? 0;
      const ground = p.y ?? lowestUnder(site, p.x, p.z, p.width / 2, p.depth / 2, yaw);
      const from = P.spots.length;
      building(P, {
        at: { minX: -p.width / 2, maxX: p.width / 2, minZ: -p.depth / 2, maxZ: p.depth / 2 }, ground,
        floors: p.floors, wall: p.wall, doors: p.doors?.map(([side, i]) => [side, i]), ruin: p.ruin, seed: p.seed ?? 1,
      });
      placeSpots(P.spots, from, p.x, p.z, yaw);
      return;
    }
    case "fence": {
      const material = p.material ?? "plank";
      const height = p.height ?? (material === "plank" ? 1.1 : 1.4);
      let panels = 0;
      for (let i = 1; i < p.points.length && panels < MAP_LIMITS.fencePanels; i++) {
        const [ax, az] = p.points[i - 1];
        const [bx, bz] = p.points[i];
        const length = Math.hypot(bx - ax, bz - az);
        if (length < 0.2) continue;
        const n = Math.min(Math.ceil(length / FENCE_PANEL), MAP_LIMITS.fencePanels - panels);
        // La rotation qui porte le x local le long du segment
        const rot = axisAngle(vec3(0, 1, 0), Math.atan2(-(bz - az), bx - ax));
        for (let k = 0; k < n; k++, panels++) {
          const t0 = k / n;
          const t1 = (k + 1) / n;
          const x = ax + (bx - ax) * (t0 + t1) / 2;
          const z = az + (bz - az) * (t0 + t1) / 2;
          const base = Math.min(site.ground(ax + (bx - ax) * t0, az + (bz - az) * t0), site.ground(ax + (bx - ax) * t1, az + (bz - az) * t1));
          P.add({ type: material, pos: vec3(x, base + height / 2, z), half: vec3(length / (2 * n), height / 2, FENCE_THICK[material] / 2), rot });
        }
      }
      return;
    }
    case "woods": {
      const random = seeded(p.seed ?? 7);
      const kinds = p.trees?.length ? p.trees : (["pine", "oak"] as const);
      const [lo, hi] = p.scale ?? [0.8, 1.25];
      const spacing = p.spacing ?? 6;
      const taken = takenOf(site);
      let placed = 0;
      for (let k = 0; k < p.count * 8 && placed < p.count; k++) {
        const angle = random() * Math.PI * 2;
        const r = Math.sqrt(random()) * p.radius;
        const x = p.x + dcos(angle) * r;
        const z = p.z + dsin(angle) * r;
        const type = kinds[Math.floor(random() * kinds.length)] as PropType & TreeType;
        const scale = lo + random() * (hi - lo);
        if (!sowable(site, x, z, 1.5) || !taken.clear(x, z, spacing)) continue;
        P.add({ type, pos: vec3(x, site.ground(x, z) + TREE_HALF[type] * scale, z), scale });
        taken.add(x, z, 1);
        placed++;
      }
      return;
    }
    case "rocks": {
      const random = seeded(p.seed ?? 11);
      const [lo, hi] = p.size ?? [1, 2];
      const taken = takenOf(site);
      let placed = 0;
      for (let k = 0; k < p.count * 8 && placed < p.count; k++) {
        const angle = random() * Math.PI * 2;
        const r = Math.sqrt(random()) * p.radius;
        const x = p.x + dcos(angle) * r;
        const z = p.z + dsin(angle) * r;
        const size = lo + random() * (hi - lo);
        if (!sowable(site, x, z, size) || !taken.clear(x, z, size * 2)) continue;
        const half = vec3(size * (0.9 + random() * 0.5), size * (0.55 + random() * 0.3), size * (0.8 + random() * 0.4));
        const rot = qmul(yawQuat(random() * 180), axisAngle(vec3(1, 0, 0), (random() - 0.5) * 0.25));
        site.boxes.push({ ...box("rock", x, site.ground(x, z) + half.y * 0.55, z, half.x, half.y, half.z, rot), look: p.look });
        taken.add(x, z, size * 1.2);
        placed++;
      }
      return;
    }
    case "ramp": {
      const yaw = p.yaw ?? 0;
      // Le pied de la rampe : au sud de son centre avant rotation (elle monte vers +z)
      const c = dcos(yaw * DEG);
      const s = dsin(yaw * DEG);
      const footX = p.x + (-p.length / 2) * s;
      const footZ = p.z + (-p.length / 2) * c;
      const base = p.base ?? site.ground(footX, footZ);
      const from = site.boxes.length;
      site.boxes.push(incline(0, 0, "z", 1, p.width, p.length, p.rise, base));
      placeBoxes(site.boxes, from, p.x, p.z, yaw);
      return;
    }
    case "bridge": {
      const [ax, az] = p.from;
      const [bx, bz] = p.to;
      const length = Math.hypot(bx - ax, bz - az);
      if (length < 1) return;
      const top = p.y ?? Math.max(site.ground(ax, az), site.ground(bx, bz));
      const yaw = Math.atan2(bx - ax, bz - az) / DEG;
      const mx = (ax + bx) / 2;
      const mz = (az + bz) / 2;
      const w = p.width / 2;
      const from = site.boxes.length;
      const look = (b: StaticBox): StaticBox => (p.look ? { ...b, look: p.look } : b);
      site.boxes.push(look(box("deck", 0, top - 0.3, 0, w, 0.3, length / 2)));
      if (p.parapets ?? true) {
        for (const side of [-1, 1]) site.boxes.push(look(box("deck", side * (w + 0.3), top + 0.45, 0, 0.3, 0.45, Math.max(0.5, length / 2 - 0.5))));
      }
      const piers = p.piers ?? Math.floor(length / 12);
      for (let k = 0; k < piers; k++) {
        const t = (k + 1) / (piers + 1) - 0.5;
        // Une pile descend jusqu'au sol, s'il est assez bas sous le tablier
        const gx = mx + (bx - ax) * t;
        const gz = mz + (bz - az) * t;
        const bottom = site.ground(gx, gz) - 0.6;
        const high = top - 0.5;
        if (high - bottom < 1.5) continue;
        site.boxes.push(look(box("pillar", 0, (bottom + high) / 2, length * t, Math.max(0.5, w - 0.6), (high - bottom) / 2, 0.7)));
      }
      placeBoxes(site.boxes, from, mx, mz, yaw);
      return;
    }
    case "containers": {
      const yaw = p.yaw ?? 0;
      const count = p.count ?? 3;
      const levels = p.levels ?? 1;
      const width = count * CONTAINER_GAP;
      const ground = p.y ?? lowestUnder(site, p.x, p.z, width / 2, CONTAINER.z, yaw);
      const from = site.boxes.length;
      for (let level = 0; level < levels; level++) {
        for (let i = 0; i < count; i++) {
          const x = -width / 2 + CONTAINER_GAP * (i + 0.5);
          site.boxes.push(box("container", x, ground + CONTAINER.y + level * 2 * CONTAINER.y, 0, CONTAINER.x, CONTAINER.y, CONTAINER.z));
        }
      }
      placeBoxes(site.boxes, from, p.x, p.z, yaw);
      return;
    }
  }
}

/** Un accessoire mobile (caisse, baril, voiture) : un corps que la physique fait bouger, qu'on compte à part. */
export const isDynamicProp = (type: PropType): boolean => !propDef(type).anchored;
