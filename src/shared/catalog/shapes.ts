import { add, cross, dot, len, norm, scale, sub, vec3, type Vec3 } from "../math/vec";

/*
 * Formes de blocs autres que le cube : biseau, coins, arrondis, pentes, demi-bloc. Chacune est
 * définie dans le repère de son bloc (gauche +x, haut +y, avant +z), dans un cube de demi-côté 1,
 * comme l'intersection du cube et de demi-espaces (n·p ≤ d) : un polyèdre convexe, ou l'union de
 * deux (le coin rentrant). Un arrondi est approché par des facettes (plans tangents au cylindre).
 * La physique en fait des enveloppes convexes (robot/colliders.ts) et le rendu les dessine
 * (client/render/materials.ts) : les deux ont la même forme.
 *
 * Convention : une forme a toujours son dessous (−haut) plein, collé à ce qui la porte quand elle
 * est orientée selon la face où on la pose (garage) ; sa pente regarde vers le haut et l'avant.
 */

export type ShapeId = "wedge" | "corner" | "innerCorner" | "round" | "roundCorner" | "slopeLow" | "slopeHigh" | "slab";

/** Demi-espace n·p ≤ d. */
interface HalfSpace {
  n: Vec3;
  d: number;
}

/** Une face : son contour (sens trigonométrique vu de dehors) et sa normale sortante. */
export interface ShapeFace {
  normal: Vec3;
  points: Vec3[];
}

/** Un morceau convexe d'une forme : ses faces, ses sommets et son volume (cube de demi-côté 1 : 8). */
export interface ShapePiece {
  faces: ShapeFace[];
  points: Vec3[];
  volume: number;
}

/** Facettes d'un quart d'arrondi. */
const ROUND_FACETS = 6;

/** Plans tangents au cylindre d'axe `axis` (x ou z) qui arrondit l'arête du haut, de rayon 2, centré sur l'arête opposée. */
function roundPlanes(axis: "x" | "z"): HalfSpace[] {
  const planes: HalfSpace[] = [];
  for (let k = 0; k < ROUND_FACETS; k++) {
    const t = ((k + 0.5) * Math.PI) / 2 / ROUND_FACETS;
    // Autour de l'axe x : l'arête du haut et de l'avant ; autour de l'axe z : celle du haut et de la gauche
    const n = axis === "x" ? vec3(0, Math.sin(t), Math.cos(t)) : vec3(Math.cos(t), Math.sin(t), 0);
    planes.push({ n, d: 2 - Math.sin(t) - Math.cos(t) });
  }
  return planes;
}

const SLOPE_FRONT: HalfSpace = { n: vec3(0, 1, 1), d: 0 };
const SLOPE_LEFT: HalfSpace = { n: vec3(1, 1, 0), d: 0 };

/**
 * Chaque forme : ses morceaux convexes (des demi-espaces qui coupent le cube), et si sa symétrie
 * par rapport à un miroir échange sa gauche et son avant (`swap` : les coins ; sinon, elle est
 * symétrique de gauche à droite).
 */
const SHAPE_SPECS: Record<ShapeId, { pieces: HalfSpace[][]; swap?: boolean }> = {
  // Biseau : prisme triangulaire, dessous et arrière pleins, pente vers le haut et l'avant (45°)
  wedge: { pieces: [[SLOPE_FRONT]] },
  // Coin (de toit en croupe) : deux pentes, vers l'avant et vers la gauche, qui se rejoignent
  corner: { pieces: [[SLOPE_FRONT, SLOPE_LEFT]], swap: true },
  // Coin rentrant : deux biseaux croisés (l'union, qui n'est pas convexe : deux morceaux)
  innerCorner: { pieces: [[SLOPE_FRONT], [SLOPE_LEFT]], swap: true },
  // Arrondi : l'arête du haut et de l'avant arrondie sur toute la hauteur (quart de cylindre)
  round: { pieces: [roundPlanes("x")] },
  // Coin arrondi : deux arrondis qui se rejoignent, comme le coin de deux biseaux
  roundCorner: { pieces: [[...roundPlanes("x"), ...roundPlanes("z")]], swap: true },
  // Pente douce en deux blocs (27°) : le bas, d'une demi-hauteur à rien ; le haut, du plein à une demi-hauteur
  slopeLow: { pieces: [[{ n: vec3(0, 1, 0.5), d: -0.5 }]] },
  slopeHigh: { pieces: [[{ n: vec3(0, 1, 0.5), d: 0.5 }]] },
  // Demi-bloc : la moitié du bas
  slab: { pieces: [[{ n: vec3(0, 1, 0), d: 0 }]] },
};

export const SHAPE_IDS = Object.keys(SHAPE_SPECS) as ShapeId[];

export const isShapeId = (value: string): value is ShapeId => Object.hasOwn(SHAPE_SPECS, value);

/** La symétrie de la forme échange-t-elle sa gauche et son avant (voir `mirrorFacing`, design/robotDesign.ts) ? */
export const shapeSwaps = (shape: ShapeId): boolean => !!SHAPE_SPECS[shape].swap;

const EPS = 1e-7;

/** Contour ordonné dans le sens trigonométrique autour de `normal` (vu de son côté). */
function around(points: Vec3[], normal: Vec3): Vec3[] {
  const c = scale(points.reduce((s, p) => add(s, p), vec3(0, 0, 0)), 1 / points.length);
  const u = norm(Math.abs(normal.x) < 0.9 ? cross(vec3(1, 0, 0), normal) : cross(vec3(0, 1, 0), normal));
  const v = cross(normal, u);
  const angle = (p: Vec3): number => Math.atan2(dot(sub(p, c), v), dot(sub(p, c), u));
  return [...points].sort((a, b) => angle(a) - angle(b));
}

/** Sans les points en double (à EPS près). */
function unique(points: Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  for (const p of points) if (!out.some((q) => len(sub(p, q)) < 1e-6)) out.push(p);
  return out;
}

/** Aire d'un contour plan. */
function area(points: Vec3[]): number {
  let s = vec3(0, 0, 0);
  for (let i = 1; i + 1 < points.length; i++) s = add(s, cross(sub(points[i], points[0]), sub(points[i + 1], points[0])));
  return len(s) / 2;
}

/** Le cube de demi-côté 1, face par face. */
function cube(): ShapeFace[] {
  const faces: ShapeFace[] = [];
  for (const axis of ["x", "y", "z"] as const) {
    for (const s of [-1, 1]) {
      const normal = vec3(axis === "x" ? s : 0, axis === "y" ? s : 0, axis === "z" ? s : 0);
      const points: Vec3[] = [];
      for (const a of [-1, 1]) {
        for (const b of [-1, 1]) {
          points.push(axis === "x" ? vec3(s, a, b) : axis === "y" ? vec3(a, s, b) : vec3(a, b, s));
        }
      }
      faces.push({ normal, points: around(points, normal) });
    }
  }
  return faces;
}

/** Coupe un polyèdre convexe par le demi-espace n·p ≤ d, et le referme par la face de coupe. */
function clip(faces: ShapeFace[], h: HalfSpace): ShapeFace[] {
  const n = norm(h.n);
  const d = h.d / len(h.n);
  const out: ShapeFace[] = [];
  const cut: Vec3[] = [];
  for (const face of faces) {
    const kept: Vec3[] = [];
    const pts = face.points;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const da = dot(n, a) - d;
      const db = dot(n, b) - d;
      if (da <= EPS) kept.push(a);
      if (Math.abs(da) <= EPS) cut.push(a);
      if ((da < -EPS && db > EPS) || (da > EPS && db < -EPS)) {
        const p = add(a, scale(sub(b, a), da / (da - db)));
        kept.push(p);
        cut.push(p);
      }
    }
    const poly = unique(kept);
    if (poly.length >= 3 && area(poly) > 1e-6) out.push({ normal: face.normal, points: poly });
  }
  // Le plan de coupe ferme le polyèdre (sauf s'il porte déjà une face : même normale sortante)
  const cap = unique(cut);
  const flush = out.some((f) => dot(f.normal, n) > 1 - 1e-9);
  if (!flush && cap.length >= 3) {
    const points = around(cap, n);
    if (area(points) > 1e-6) out.push({ normal: n, points });
  }
  return out;
}

/** Volume d'un polyèdre fermé (faces orientées vers dehors). */
function volume(faces: ShapeFace[]): number {
  let v = 0;
  for (const { points } of faces) {
    for (let i = 1; i + 1 < points.length; i++) v += dot(points[0], cross(points[i], points[i + 1])) / 6;
  }
  return v;
}

function piece(planes: HalfSpace[]): ShapePiece {
  let faces = cube();
  for (const h of planes) faces = clip(faces, h);
  return { faces, points: unique(faces.flatMap((f) => f.points)), volume: volume(faces) };
}

const PIECES = new Map<ShapeId, ShapePiece[]>();

/** Les morceaux convexes d'une forme, dans un cube de demi-côté 1 (calculés une fois). */
export function shapePieces(shape: ShapeId): readonly ShapePiece[] {
  let pieces = PIECES.get(shape);
  if (!pieces) {
    pieces = SHAPE_SPECS[shape].pieces.map(piece);
    PIECES.set(shape, pieces);
  }
  return pieces;
}

/** Part du cube qu'occupe la forme (0 à 1) : sa masse et ses points de structure en découlent. */
export function shapeFraction(shape: ShapeId): number {
  const specs = SHAPE_SPECS[shape].pieces;
  const pieces = shapePieces(shape);
  // Deux morceaux : on retire ce qu'ils ont en commun
  const total = pieces.length === 2 ? pieces[0].volume + pieces[1].volume - piece([...specs[0], ...specs[1]]).volume : pieces[0].volume;
  return total / 8;
}
