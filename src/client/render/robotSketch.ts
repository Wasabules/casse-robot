import { blockDef } from "../../shared/catalog/blocks";
import { wheelDef } from "../../shared/catalog/wheels";
import { BLOCK_SIZE, PLATE_THICKNESS } from "../../shared/config";
import { add, cross, dot, norm, scale, sub, vec3, type Vec3 } from "../../shared/math/vec";
import { allAround, flailOrbit, headOffset, isBit, meleeAxes, meleeDef, pivotDir, tipOffset } from "../../shared/catalog/melee";
import { BLADES, bladeKind, FLAIL_MAST, HAMMER_ARM, headLift, JET_NACELLE, LEG_THICKNESS, legOut, restLeg } from "../../shared/design/clearance";
import { designCenterOfMass } from "../../shared/design/flight";
import { AXES, cellKey, DEFAULT_FACING, wheelLocalPos, type BlockPlacement, type RobotDesign } from "../../shared/design/robotDesign";
import { blockColors, wheelColors } from "./materials";
import { beltPath, beltShape, trackGroups, type BeltShape } from "./trackShape";

/*
 * Vignette d'un robot, dessinée en 2D (canvas) : ses blocs en perspective cavalière (une projection
 * orthogonale vue de l'avant droit, un peu d'en haut), ses roues, ses chenilles et les têtes de ses tourelles.
 * Aucun WebGL : une trentaine de vignettes se dessinent en quelques millisecondes, et la liste du
 * choix du robot n'a besoin que d'une seule scène 3D, pour l'aperçu (render/robotPreview.ts).
 */

/** Direction de la vue (de l'objet vers l'œil) : de l'avant (+z) et de la droite (-x) du robot, d'en haut. */
const EYE = norm(vec3(-0.55, 0.62, 0.72));
const RIGHT = norm(vec3(EYE.z, 0, -EYE.x));
const UP = cross(EYE, RIGHT);
/** Lumière (vers la source) : les dessus sont clairs, les flancs plus sombres. */
const LIGHT = norm(vec3(0.35, 1, 0.55));
/** Bande d'une chenille : sa couleur. */
const BELT_COLOR = "#2b2f33";
/** Tête de tourelle et son canon (au moins `BARREL_MIN` m d'épaisseur, pour qu'on le voie). */
const HEAD_COLOR = "#2f353b";
const BARREL_MIN = 0.06;
/** Disque des pales qui tournent (translucide), nacelle d'un turboréacteur, patte. */
const BLADE_FILL = "rgba(38, 42, 48, 0.38)";
const BLADE_EDGE = "rgba(240, 189, 44, 0.85)";
const NACELLE_COLOR = "#8a9096";
const LEG_COLOR = "#5a6168";
/** Disque d'une toupie verticale, tambour, anneau d'un anneau-coque : de l'acier. */
const STEEL_COLOR = "#9aa2a8";
const SHELL_COLOR = "#a7afb5";
/** La mèche d'une foreuse. */
const BIT_COLOR = "#b8bec4";

/** Une chose à dessiner, avec sa profondeur (plus grande : plus près de l'œil) et ses points (pour le cadrage). */
interface Shape {
  depth: number;
  points: readonly Vec3[];
  draw: (c: CanvasRenderingContext2D, at: (p: Vec3) => [number, number]) => void;
}

/** Couleur hexadécimale assombrie ou éclaircie d'un facteur `k` (1 : inchangée). */
function shade(hex: string, k: number): string {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  const channel = (v: number): number => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${channel((n >> 16) & 255)}, ${channel((n >> 8) & 255)}, ${channel(n & 255)})`;
}

/**
 * Boîte alignée sur les axes du robot, centrée en `center`, de demi-côtés `half` : ses trois faces
 * tournées vers l'œil (sauf celles qu'un voisin cache, `hidden`), ombrées selon la lumière.
 */
function box(center: Vec3, half: Vec3, fill: string, edge: string, hidden: (axis: Vec3) => boolean = () => false): Shape {
  const faces: { corners: Vec3[]; tone: number }[] = [];
  for (const axis of [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)]) {
    const sign = Math.sign(dot(axis, EYE)) || 1;
    const n = scale(axis, sign);
    if (hidden(n)) continue;
    // Les deux autres axes de la face
    const [a, b] = axis.x ? [vec3(0, 1, 0), vec3(0, 0, 1)] : axis.y ? [vec3(1, 0, 0), vec3(0, 0, 1)] : [vec3(1, 0, 0), vec3(0, 1, 0)];
    const ha = Math.abs(dot(half, a));
    const hb = Math.abs(dot(half, b));
    const c = vec3(center.x + n.x * half.x, center.y + n.y * half.y, center.z + n.z * half.z);
    const corner = (sa: number, sb: number): Vec3 => add(c, add(scale(a, ha * sa), scale(b, hb * sb)));
    faces.push({ corners: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)], tone: 0.62 + 0.42 * Math.max(0, dot(n, LIGHT)) });
  }
  return {
    depth: dot(center, EYE),
    points: faces.flatMap((f) => f.corners),
    draw: (ctx, at) => {
      for (const face of faces) {
        ctx.beginPath();
        face.corners.forEach((p, i) => {
          const [x, y] = at(p);
          if (i) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        });
        ctx.closePath();
        ctx.fillStyle = shade(fill, face.tone);
        ctx.fill();
        ctx.strokeStyle = edge;
        ctx.stroke();
      }
    },
  };
}

/** Roue : un disque dans le plan de la roue (son essieu suit l'axe x du robot), pneu et moyeu. */
function wheel(center: Vec3, radius: number, width: number, tire: string, hub: string): Shape {
  const side = Math.sign(EYE.x) || 1;
  const ring = (x: number, r: number): Vec3[] =>
    Array.from({ length: 18 }, (_, i) => {
      const t = (i / 18) * Math.PI * 2;
      return vec3(x, center.y + Math.cos(t) * r, center.z + Math.sin(t) * r);
    });
  const far = ring(center.x - (side * width) / 2, radius);
  const near = ring(center.x + (side * width) / 2, radius);
  const cap = ring(center.x + (side * width) / 2, radius * 0.45);
  const fill = (ctx: CanvasRenderingContext2D, at: (p: Vec3) => [number, number], points: Vec3[], color: string): void => {
    ctx.beginPath();
    points.forEach((p, i) => {
      const [x, y] = at(p);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };
  return {
    depth: dot(center, EYE),
    points: [...far, ...near],
    draw: (ctx, at) => {
      fill(ctx, at, far, shade(tire, 0.8));
      fill(ctx, at, near, tire);
      fill(ctx, at, cap, hub);
    },
  };
}

/** Deux axes perpendiculaires à `axis` (unitaire, aligné sur un axe du robot). */
function across(axis: Vec3): [Vec3, Vec3] {
  return Math.abs(axis.x) > 0.5 ? [vec3(0, 1, 0), vec3(0, 0, 1)] : Math.abs(axis.y) > 0.5 ? [vec3(1, 0, 0), vec3(0, 0, 1)] : [vec3(1, 0, 0), vec3(0, 1, 0)];
}

/** Cercle de rayon `r` autour de `center`, perpendiculaire à `axis`. */
function circle(center: Vec3, axis: Vec3, r: number, n = 24): Vec3[] {
  const [u, v] = across(axis);
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return add(center, add(scale(u, Math.cos(t) * r), scale(v, Math.sin(t) * r)));
  });
}

function polygon(ctx: CanvasRenderingContext2D, at: (p: Vec3) => [number, number], points: readonly Vec3[]): void {
  ctx.beginPath();
  points.forEach((p, i) => {
    const [x, y] = at(p);
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  });
  ctx.closePath();
}

/**
 * Cylindre d'axe `axis` (une nacelle, le disque d'une toupie, un tambour) : son flanc (l'enveloppe
 * des deux cercles, dessinée par tranches) puis le cercle tourné vers l'œil, percé au centre d'un
 * rond sombre de `hole` fois son rayon (l'entrée d'air, le moyeu).
 */
function drum(center: Vec3, axis: Vec3, radius: number, length: number, color: string, hole = 0.7): Shape {
  const side = Math.sign(dot(axis, EYE)) || 1;
  const far = circle(add(center, scale(axis, (-side * length) / 2)), axis, radius);
  const near = circle(add(center, scale(axis, (side * length) / 2)), axis, radius);
  return {
    depth: dot(center, EYE),
    points: [...far, ...near],
    draw: (ctx, at) => {
      ctx.fillStyle = shade(color, 0.7);
      for (let i = 0; i < far.length; i++) {
        const j = (i + 1) % far.length;
        polygon(ctx, at, [far[i], far[j], near[j], near[i]]);
        ctx.fill();
      }
      polygon(ctx, at, near);
      ctx.fillStyle = shade(color, 1.05);
      ctx.fill();
      polygon(ctx, at, circle(add(center, scale(axis, (side * length) / 2)), axis, radius * hole));
      ctx.fillStyle = "#15171a";
      ctx.fill();
    },
  };
}

/**
 * Anneau d'un anneau-coque, d'axe vertical autour de `center` : sa bande en pans (chacun à sa
 * profondeur : ceux de derrière passent sous le robot, ceux de devant dessus) et ses rayons, du moyeu
 * à la bande, sur le dessus (`top`, au-dessus du centre).
 */
function shellBand(center: Vec3, radius: number, half: number, top: number): Shape[] {
  const n = 24;
  const list: Shape[] = [];
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    const at = (a: number, y: number): Vec3 => add(center, vec3(Math.sin(a) * radius, y, Math.cos(a) * radius));
    const corners = [at(a0, -half), at(a1, -half), at(a1, half), at(a0, half)];
    const mid = (a0 + a1) / 2;
    const n0 = vec3(Math.sin(mid), 0, Math.cos(mid));
    // Vue de l'extérieur (devant), ou l'intérieur de la bande (derrière)
    const outward = dot(n0, EYE) > 0;
    const tone = 0.62 + 0.42 * Math.max(0, dot(outward ? n0 : scale(n0, -1), LIGHT));
    const color = i % 6 === 3 ? "#f0bd2c" : SHELL_COLOR;
    list.push({
      depth: dot(at(mid, 0), EYE),
      points: corners,
      draw: (ctx, toScreen) => {
        polygon(ctx, toScreen, corners);
        ctx.fillStyle = shade(color, outward ? tone : tone * 0.7);
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.25)";
        ctx.stroke();
      },
    });
  }
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    list.push(rod(add(center, vec3(0, top, 0)), add(center, vec3(Math.sin(a) * radius, top, Math.cos(a) * radius)), 0.1, "#3b4147"));
  }
  return list;
}

/** Disque des pales qui tournent : translucide, cerclé de la couleur des bouts des pales. */
function bladeDisc(center: Vec3, axis: Vec3, radius: number): Shape {
  const rim = circle(center, axis, radius, 36);
  return {
    depth: dot(center, EYE),
    points: rim,
    draw: (ctx, at) => {
      polygon(ctx, at, rim);
      ctx.fillStyle = BLADE_FILL;
      ctx.fill();
      ctx.strokeStyle = BLADE_EDGE;
      ctx.stroke();
    },
  };
}

/** Tige de `a` à `b`, de `width` m d'épaisseur (un canon, un segment de patte). */
function rod(a: Vec3, b: Vec3, width: number, color: string): Shape {
  return {
    depth: dot(scale(add(a, b), 0.5), EYE),
    points: [a, b],
    draw: (ctx, at) => {
      const [ax, ay] = at(a);
      const [bx, by] = at(b);
      const [wx, wy] = at(add(a, scale(RIGHT, width)));
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineWidth = Math.max(1, Math.hypot(wx - ax, wy - ay));
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.restore();
    },
  };
}

/**
 * Ce qui dépasse d'un bloc, comme le dessine le jeu et à la place que lui réserve son encombrement
 * (shared/design/clearance.ts) : tête et canon d'une tourelle, disque des pales d'un rotor ou d'une
 * hélice, nacelle d'un turboréacteur, patte (vers l'extérieur, d'après le centre de masse `com`).
 */
function protrusions(b: BlockPlacement, com: Vec3): Shape[] {
  const def = blockDef(b.type);
  const f = b.facing ?? DEFAULT_FACING;
  const up = AXES[f.up];
  const forward = AXES[f.forward];
  const left = cross(up, forward);
  const center = vec3(b.x * BLOCK_SIZE, b.y * BLOCK_SIZE, b.z * BLOCK_SIZE);
  const list: Shape[] = [];
  const turret = def.turret;
  if (turret) {
    const head = add(center, scale(up, headLift(turret)));
    const [w, h, d] = turret.head;
    const abs = (v: Vec3): Vec3 => vec3(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z));
    const half = add(abs(scale(left, w / 2)), add(abs(scale(up, h / 2)), abs(scale(forward, d / 2))));
    list.push(box(head, half, HEAD_COLOR, "rgba(0,0,0,0.35)"));
    // Le canon au repos, droit devant (pas pour une arme qu'on largue : mines, bombes)
    if (!turret.fixed) list.push(rod(head, add(head, scale(forward, turret.barrel)), Math.max(BARREL_MIN, turret.caliber), shade(HEAD_COLOR, 0.8)));
  }
  const blades = bladeKind(b.type, f.up);
  if (blades) list.push(bladeDisc(add(center, scale(up, BLOCK_SIZE / 2 + BLADES[blades].offset)), up, BLADES[blades].diameter / 2));
  if (def.thruster?.look === "jet") {
    const { radius, intake, nozzle } = JET_NACELLE;
    list.push(drum(add(center, scale(up, (intake - nozzle) / 2)), up, radius, intake + nozzle, NACELLE_COLOR));
  }
  if (def.support?.kind === "leg") {
    const { knee, foot } = restLeg(center, legOut(center, com, vec3(1, 0, 0)), def.support.height);
    list.push(rod(center, knee, LEG_THICKNESS, LEG_COLOR), rod(knee, foot, LEG_THICKNESS, LEG_COLOR));
  }
  // Arme de contact : le disque que balaie la barre d'une toupie, le disque plein d'une toupie
  // verticale, un tambour, l'anneau d'un anneau-coque, le bras armé d'un marteau (une hélice
  // tranchante : ses pales, ci-dessus)
  if (def.melee && meleeDef(def.melee).motion !== "driven") {
    const spec = meleeDef(def.melee);
    const at = (p: Vec3): Vec3 => add(center, add(scale(left, p.x), add(scale(up, p.y), scale(forward, p.z))));
    const hub = at(vec3(spec.hub[0], spec.hub[1], spec.hub[2]));
    const axes = meleeAxes(spec.axis);
    const axis = sub(at(axes.axis), center);
    const blade = spec.blade;
    // La mèche d'une foreuse (plus longue que large : un cylindre le long de son axe) ; une lame à bras
    // (une barre), d'énergie ou qui mord (une scie) : le disque translucide qu'elle balaie ; un anneau
    // qui entoure le robot : sa bande ; un disque plein, un tambour : un cylindre d'acier
    if (blade && isBit(blade)) list.push(drum(hub, axis, blade.outer, 2 * blade.half, BIT_COLOR));
    else if (blade && (blade.arms || spec.quench || spec.bite)) list.push(bladeDisc(hub, axis, blade.outer));
    else if (blade && allAround(spec)) list.push(...shellBand(hub, (blade.inner + blade.outer) / 2, blade.half, blade.web?.at ?? blade.half));
    else if (blade) list.push(drum(hub, axis, blade.outer, 2 * blade.half, STEEL_COLOR, 0.3));
    // Une lance, rentrée : sa pointe dépasse du bloc
    if (spec.thrust) list.push(rod(hub, at(add(vec3(spec.hub[0], spec.hub[1], spec.hub[2]), tipOffset(spec.axis, spec.thrust.retracted))), spec.thrust.radius, shade(HEAD_COLOR, 0.9)));
    // (le filament d'un fouet n'existe que quand il claque : rien au repos)
    if (spec.swing && spec.look !== "whip") {
      const head = at(add(vec3(spec.hub[0], spec.hub[1], spec.hub[2]), headOffset(spec.axis, spec.swing, spec.swing.rest)));
      list.push(rod(hub, head, HAMMER_ARM, shade(HEAD_COLOR, 0.8)), rod(head, add(head, scale(sub(head, hub), 0.001)), spec.swing.radius * 2, HEAD_COLOR));
    }
    // Le plateau d'un flipper en coin, les mâchoires ouvertes : des barres de leur largeur
    const local = vec3(spec.hub[0], spec.hub[1], spec.hub[2]);
    if (spec.plate) list.push(rod(hub, at(add(local, scale(pivotDir(spec.axis, spec.plate.rest), spec.plate.length))), 2 * spec.plate.half, shade(HEAD_COLOR, 0.9)));
    if (spec.jaw) {
      for (const side of [1, -1]) list.push(rod(hub, at(add(local, scale(pivotDir(spec.axis, side * spec.jaw.open), spec.jaw.length))), 2 * spec.jaw.half, shade(HEAD_COLOR, 0.8)));
    }
    // Le tour de la boule d'un fléau, et son mât
    if (spec.flail) {
      const orbit = flailOrbit(spec.flail);
      list.push(rod(center, hub, 2 * FLAIL_MAST, shade(HEAD_COLOR, 0.8)));
      list.push(bladeDisc(at(sub(local, scale(axes.axis, orbit.drop))), sub(axis, center), orbit.radius + spec.flail.radius));
    }
  }
  return list;
}

/**
 * Bande d'une chenille : les facettes de son parcours tournées vers l'œil (le dessus, les arcs), de
 * part en part de sa largeur ; ouverte sur les flancs, elle laisse voir ses galets. Dessinée juste
 * après eux (`depth`) : son brin du dessus passe devant leur haut.
 */
function belt(shape: BeltShape, depth: number): Shape {
  const path = beltPath(shape);
  const x0 = shape.x - shape.width / 2;
  const x1 = shape.x + shape.width / 2;
  const faces: { corners: Vec3[]; tone: number }[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const [za, ya, nza, nya] = path[i];
    const [zb, yb, nzb, nyb] = path[i + 1];
    const n = norm(vec3(0, nya + nyb, nza + nzb));
    if (dot(n, EYE) <= 0) continue;
    faces.push({
      corners: [vec3(x0, ya, za), vec3(x1, ya, za), vec3(x1, yb, zb), vec3(x0, yb, zb)],
      tone: 0.62 + 0.42 * Math.max(0, dot(n, LIGHT)),
    });
  }
  return {
    depth,
    points: path.flatMap(([z, y]) => [vec3(x0, y, z), vec3(x1, y, z)]),
    draw: (ctx, at) => {
      for (const face of faces) {
        ctx.beginPath();
        face.corners.forEach((p, i) => {
          const [x, y] = at(p);
          if (i) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        });
        ctx.closePath();
        ctx.fillStyle = shade(BELT_COLOR, face.tone);
        ctx.strokeStyle = ctx.fillStyle;
        ctx.fill();
        ctx.stroke();
      }
    },
  };
}

/**
 * Ce qu'on dessine d'un plan : ses blocs (les faces cachées par un bloc plein voisin en moins), ce
 * qui en dépasse (têtes et canons des tourelles, pales, nacelles, pattes), ses roues, ses chenilles.
 */
function shapes(design: RobotDesign, color: string): Shape[] {
  const solid = new Set(design.blocks.filter((b) => blockDef(b.type).shape !== "plate").map((b) => cellKey(b.x, b.y, b.z)));
  const list: Shape[] = [];
  const half = BLOCK_SIZE / 2;
  const com = designCenterOfMass(design);
  for (const b of design.blocks) {
    const def = blockDef(b.type);
    const center = vec3(b.x * BLOCK_SIZE, b.y * BLOCK_SIZE, b.z * BLOCK_SIZE);
    // Une plaque (aile, gouverne) est mince le long du haut de son bloc
    const up = AXES[(b.facing ?? DEFAULT_FACING).up];
    const thin = def.shape === "plate" ? PLATE_THICKNESS / 2 : half;
    const size = vec3(up.x ? thin : half, up.y ? thin : half, up.z ? thin : half);
    const { fill, edge } = blockColors(b.type, color);
    const plate = def.shape === "plate";
    list.push(box(center, size, fill, shade(edge, 0.75), (n) => !plate && solid.has(cellKey(b.x + n.x, b.y + n.y, b.z + n.z))));
    list.push(...protrusions(b, com));
  }
  for (const w of design.wheels) {
    const def = wheelDef(w.type);
    const { tire, hub } = wheelColors(w.type);
    list.push(wheel(wheelLocalPos(w), def.radius, def.width, tire, hub));
  }
  const rollers = design.wheels.filter((w) => wheelDef(w.type).track);
  if (rollers.length) {
    const def = wheelDef(rollers[0].type);
    for (const group of trackGroups(rollers, wheelLocalPos, def)) {
      const centers = group.map(wheelLocalPos);
      list.push(belt(beltShape(centers, def), Math.max(...centers.map((c) => dot(c, EYE))) + 0.01));
    }
  }
  return list.sort((a, b) => a.depth - b.depth);
}

/**
 * Dessine la vignette d'un plan dans `canvas`, de `width` × `height` px à l'écran (sa taille en CSS),
 * le robot centré et à l'échelle de la vignette.
 */
export function sketchRobot(canvas: HTMLCanvasElement, design: RobotDesign, color: string, width: number, height: number): void {
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const list = shapes(design, color);
  if (!list.length) return;
  // Cadrage : l'encombrement projeté de tout ce qu'on dessine
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const s of list) {
    for (const p of s.points) {
      const x = dot(p, RIGHT);
      const y = -dot(p, UP);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  const pad = 6 * ratio;
  const k = Math.min((canvas.width - 2 * pad) / Math.max(0.01, maxX - minX), (canvas.height - 2 * pad) / Math.max(0.01, maxY - minY));
  const ox = canvas.width / 2 - ((minX + maxX) / 2) * k;
  const oy = canvas.height / 2 - ((minY + maxY) / 2) * k;
  ctx.lineWidth = Math.max(0.5, k * 0.012);
  ctx.lineJoin = "round";
  for (const s of list) s.draw(ctx, (p) => [ox + dot(p, RIGHT) * k, oy - dot(p, UP) * k]);
}
