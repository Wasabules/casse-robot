import { blockDef, isBlockType, type BlockType, type TurretSpec } from "../catalog/blocks";
import { flailOrbit, headOffset, meleeAxes, meleeDef, pivotDir, tipOffset, type MeleeSpec } from "../catalog/melee";
import { isWheelType, steerClearance, wheelDef } from "../catalog/wheels";
import { BLOCK_SIZE, PLATE_THICKNESS } from "../config";
import { add, cross, distance, dot, norm, scale, sub, vec3, type Vec3 } from "../math/vec";
import { designCenterOfMass } from "./flight";
import type { Part } from "./progression";
import {
  AXES, cellKey, DEFAULT_FACING, wheelLocalPos, wheelsOverlap, type Axis, type BlockPlacement, type Facing, type RobotDesign,
  type WheelMount,
} from "./robotDesign";
import { BELT_CLEARANCE, BELT_MARGIN, trackGroups } from "./tracks";
import { dcos, dpow, dsin } from "../math/det";

/*
 * Encombrement des pièces d'un plan : ce que chacune occupe au-delà de sa case, en volumes simples
 * (pavés, cylindres, capsules) dans le repère du robot. La tête et le canon d'une tourelle, la
 * sortie d'un poseur de mines, le passage des bombes sous une soute, une roue (et ce qu'elle balaie
 * en braquant), la bande d'une chenille, les pales d'un rotor ou d'une hélice, la nacelle d'un
 * turboréacteur, une patte. Le garage refuse une pièce qui en gêne une
 * autre (`placementConflicts`) ; le rendu dessine ces parties avec les mêmes cotes (`BLADES`,
 * `JET_NACELLE`, `headLift`, `restLeg`), là où l'encombrement les réserve.
 *
 * Une tourelle réserve sa pose de repos (tête dans l'axe de son bloc, canon droit devant, à
 * l'horizontale) et non le cercle que balaie son canon en tournant : un bloc à côté de la tête ne la
 * heurte pas (sa zone touchable ne cogne rien, robot/colliders.ts), il borne seulement son champ de
 * tir, que le jeu respecte déjà (une tourelle ne tire pas à travers son robot, `lineOfFireBlocked`) :
 * c'est un choix de construction (une arme derrière une superstructure, en casemate). Réserver le
 * cercle interdirait presque tout robot compact (le canon d'un sniper balaie un disque de 2 m).
 * Les flammes des moteurs, les leurres, la lueur des patins ne sont pas des volumes : ils ne
 * réservent rien.
 *
 * `validateDesign` ne tient pas compte de l'encombrement : un plan enregistré avant reste jouable
 * (le garage signale seulement ses pièces qui se gênent, `designConflicts`).
 */

/**
 * Un volume, dans le repère du robot (m) : pavé aligné sur les axes, cylindre d'axe x, y ou z (creux
 * jusqu'au rayon `inner`, s'il en a un : un tube, l'anneau d'un anneau-coque), ou capsule.
 */
export type Solid =
  | { kind: "box"; center: Vec3; half: Vec3 }
  | { kind: "cylinder"; axis: "x" | "y" | "z"; center: Vec3; radius: number; half: number; inner?: number }
  | { kind: "capsule"; a: Vec3; b: Vec3; radius: number };

/**
 * Ce qu'est une zone réservée : la tête d'une tourelle, son canon, le passage des bombes, la sortie
 * des mines, des pales, une nacelle, une patte, une roue, un galet, une chenille, ou ce que balaie
 * une arme de contact (selon son allure). Dit dans la langue du joueur (`zonePart.<id>` : « le
 * canon », « les pales du rotor »…).
 */
export type ZonePart =
  | "head" | "bombDrop" | "mineExit" | "barrel" | "rotorBlades" | "propeller" | "tailRotor" | "nacelle" | "leg"
  | "wheel" | "roller" | "track" | MeleeSpec["look"];

/** Ce qu'une pièce réserve au-delà de sa case. */
export interface Zone {
  /** La pièce (ou les galets d'une chenille) à qui elle appartient : clés de `pieceKey`. */
  owners: string[];
  /** Ce qu'elle est ; `plural` : faite de plusieurs pièces (des mâchoires, des pales), d'où l'accord des phrases. */
  part: ZonePart;
  plural: boolean;
  solids: Solid[];
  /** Cases où elle a le droit d'empiéter : celle de son bloc, celle du bloc qui porte une roue. */
  own: string[];
}

/** Une pièce d'un plan : un bloc (posé avec son orientation) ou une roue. */
export type Piece = { kind: "block"; block: BlockPlacement } | { kind: "wheel"; wheel: WheelMount };

/** Clé d'une pièce : un bloc par sa case, une roue par son rang dans `design.wheels`. */
export const blockKey = (b: { x: number; y: number; z: number }): string => `b:${cellKey(b.x, b.y, b.z)}`;
export const wheelKey = (index: number): string => `w:${index}`;

/**
 * Une pièce empiète sur une case voisine de moins que cela (m) sans la gêner : une tête qui affleure
 * la face de son bloc, une nacelle un peu plus large que sa case.
 */
export const CLEARANCE_SLACK = 0.04;

// --- Cotes des parties qui dépassent (le rendu les dessine avec elles) ---

/**
 * Pales des moteurs qui en ont : diamètre (m), hauteur de leur plan au-dessus de la face du bloc vers
 * laquelle il pousse (m), et épaisseur du disque qu'elles balaient (m). Rotor orientable (quatre
 * grandes pales), hélice d'avion (trois pales calées), hélice d'un rotor de queue (un moteur à
 * flamme couché sur le côté ou vers l'arrière : deux pales).
 */
export const BLADES = {
  rotor: { diameter: 3.2, offset: 0.15, thickness: 0.04 },
  propeller: { diameter: 1.95, offset: 0.1, thickness: 0.07 },
  tail: { diameter: 1.15, offset: 0.07, thickness: 0.03 },
} as const;
export type BladeKind = keyof typeof BLADES;

/**
 * Nacelle d'un turboréacteur, centrée sur son bloc le long de son axe de poussée : son rayon, et
 * jusqu'où elle dépasse devant (l'entrée d'air) et derrière (la tuyère, d'où part la flamme) (m).
 */
export const JET_NACELLE = { radius: 0.28, intake: 0.43, nozzle: 0.68 } as const;

/** Patte : longueur de la cuisse et du tibia, écart du pied vers l'extérieur du robot, épaisseur (m). */
export const LEG_SEGMENT = 0.95;
export const FOOT_OUT = 0.7;
export const LEG_THICKNESS = 0.13;

/**
 * Hauteur de l'axe de la tête d'une tourelle au-dessus du centre de son bloc, telle qu'on la dessine
 * (m) : celle du catalogue, ou le dessus du bloc pour une tête posée sur lui (le tambour d'un poseur
 * de mines, dont la goulotte est dans le socle).
 */
export const headLift = (spec: TurretSpec): number => spec.height || BLOCK_SIZE / 2;

/**
 * Pales d'un moteur, comme les dessine le jeu (LocomotionView) : une hélice d'avion ; une hélice de
 * queue pour un moteur (à flamme, ou un rotor orientable) qui ne pousse ni vers le haut ni vers
 * l'avant (rôle `trim`, comme le décide `addThrusters`) ; les grandes pales d'un rotor orientable ;
 * null : il a une flamme, ou une nacelle.
 */
export function bladeKind(type: BlockType, up: Axis): BladeKind | null {
  const thruster = blockDef(type).thruster;
  if (!thruster || thruster.look === "jet") return null;
  if (thruster.look === "propeller") return "propeller";
  if (up !== "+y" && up !== "+z") return "tail";
  return thruster.look === "rotor" ? "rotor" : null;
}

/**
 * Genou d'une patte entre sa hanche et son pied (cinématique inverse, deux segments égaux), plié
 * vers le haut et vers `out`, l'extérieur du robot.
 */
export function kneeOf(hip: Vec3, foot: Vec3, out: Vec3): Vec3 {
  const d = Math.min(distance(hip, foot), 2 * LEG_SEGMENT - 0.01);
  const axis = norm(sub(foot, hip));
  let bend = add(vec3(0, 1.2, 0), out);
  bend = norm(sub(bend, scale(axis, dot(bend, axis))));
  return add(scale(add(hip, foot), 0.5), scale(bend, Math.sqrt(dpow(LEG_SEGMENT, 2) - dpow(d / 2, 2))));
}

/** L'extérieur d'une patte : à l'horizontale, du centre de masse vers sa hanche (`fallback` si elle est dessous). */
export function legOut(hip: Vec3, com: Vec3, fallback: Vec3): Vec3 {
  const out = vec3(hip.x - com.x, 0, hip.z - com.z);
  return Math.hypot(out.x, out.z) > 0.05 ? norm(out) : fallback;
}

/** Une patte au repos, pied posé `drop` m sous la hanche, un peu en dehors du robot. */
export function restLeg(hip: Vec3, out: Vec3, drop: number): { knee: Vec3; foot: Vec3 } {
  const foot = add(hip, add(scale(out, FOOT_OUT), vec3(0, -drop, 0)));
  return { knee: kneeOf(hip, foot, out), foot };
}

// --- Encombrement de chaque pièce ---

const center = (b: { x: number; y: number; z: number }): Vec3 => vec3(b.x * BLOCK_SIZE, b.y * BLOCK_SIZE, b.z * BLOCK_SIZE);

/** Passe du repère d'un bloc (gauche +x, haut +y, avant +z) à celui du robot. */
function frame(b: BlockPlacement): { at: (p: Vec3) => Vec3; size: (h: Vec3) => Vec3; axis: (a: "x" | "y" | "z") => "x" | "y" | "z" } {
  const f: Facing = b.facing ?? DEFAULT_FACING;
  const up = AXES[f.up];
  const forward = AXES[f.forward];
  const left = cross(up, forward);
  const c = center(b);
  const abs = (v: Vec3): Vec3 => vec3(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z));
  const basis = { x: left, y: up, z: forward };
  return {
    at: (p) => add(c, add(scale(left, p.x), add(scale(up, p.y), scale(forward, p.z)))),
    size: (h) => add(abs(scale(left, h.x)), add(abs(scale(up, h.y)), abs(scale(forward, h.z)))),
    axis: (a) => {
      const v = basis[a];
      return Math.abs(v.x) > 0.5 ? "x" : Math.abs(v.y) > 0.5 ? "y" : "z";
    },
  };
}

/**
 * Corps d'une plaque (aile, gouverne) : une dalle mince perpendiculaire au haut de son bloc, que la
 * gouverne épaissit de ce qu'elle balaie en braquant ; null : le bloc remplit sa case (une forme
 * aussi : la grille reste la vérité). Une roue peut passer juste sous une aile.
 */
export function plateBody(b: BlockPlacement): Solid | null {
  if (!isBlockType(b.type) || blockDef(b.type).shape !== "plate") return null;
  const tilt = blockDef(b.type).aero?.maxDeflection ?? 0;
  const thick = (BLOCK_SIZE / 2) * dsin(tilt) + (PLATE_THICKNESS / 2) * dcos(tilt);
  return { kind: "box", center: center(b), half: frame(b).size(vec3(BLOCK_SIZE / 2, thick, BLOCK_SIZE / 2)) };
}

/** Ce que réserve un bloc au-delà de sa case ; `com` : centre de masse du robot (il oriente les pattes). */
export function blockZones(b: BlockPlacement, com: Vec3 = center(b)): Zone[] {
  if (!isBlockType(b.type)) return [];
  const def = blockDef(b.type);
  const owners = [blockKey(b)];
  const own = [cellKey(b.x, b.y, b.z)];
  const f = frame(b);
  const zone = (part: ZonePart, solids: Solid[], plural = false): Zone => ({ owners, part, plural, solids, own });
  const box = (c: Vec3, h: Vec3): Solid => ({ kind: "box", center: f.at(c), half: f.size(h) });
  const zones: Zone[] = [];
  const turret = def.turret;
  if (turret) {
    const lift = headLift(turret);
    const [w, h, d] = turret.head;
    zones.push(zone("head", [box(vec3(0, lift, 0), vec3(w / 2, h / 2, d / 2))]));
    const r = turret.caliber / 2;
    if (turret.fixed === "down") {
      // Les bombes tombent par la case du dessous : elle doit rester libre (voir buriedTurrets)
      zones.push(zone("bombDrop", [box(vec3(0, -BLOCK_SIZE, 0), vec3(BLOCK_SIZE / 2, BLOCK_SIZE / 2, BLOCK_SIZE / 2))]));
    } else if (turret.fixed === "back") {
      // Les mines sortent derrière le bloc, au bout de la goulotte
      const a = vec3(0, turret.height, 0);
      zones.push(zone("mineExit", [{ kind: "capsule", a: f.at(a), b: f.at(vec3(0, turret.height, -turret.barrel)), radius: r }]));
    } else {
      // Au repos : le canon droit devant, à l'horizontale, de l'axe de la tête à sa bouche
      zones.push(zone("barrel", [{ kind: "capsule", a: f.at(vec3(0, lift, 0)), b: f.at(vec3(0, lift, turret.barrel)), radius: r }]));
    }
  }
  const blades = bladeKind(b.type, (b.facing ?? DEFAULT_FACING).up);
  if (blades) {
    const { diameter, offset, thickness } = BLADES[blades];
    const part: ZonePart = blades === "rotor" ? "rotorBlades" : blades === "propeller" ? "propeller" : "tailRotor";
    zones.push(zone(part, [{ kind: "cylinder", axis: f.axis("y"), center: f.at(vec3(0, BLOCK_SIZE / 2 + offset, 0)), radius: diameter / 2, half: thickness / 2 }], blades === "rotor"));
  }
  if (def.thruster?.look === "jet") {
    const { radius, intake, nozzle } = JET_NACELLE;
    zones.push(zone("nacelle", [{ kind: "cylinder", axis: f.axis("y"), center: f.at(vec3(0, (intake - nozzle) / 2, 0)), radius, half: (intake + nozzle) / 2 }]));
  }
  if (def.support?.kind === "leg") {
    const hip = center(b);
    const { knee, foot } = restLeg(hip, legOut(hip, com, vec3(1, 0, 0)), def.support.height);
    const radius = LEG_THICKNESS / 2;
    zones.push(zone("leg", [{ kind: "capsule", a: hip, b: knee, radius }, { kind: "capsule", a: knee, b: foot, radius }]));
  }
  if (def.melee) {
    const spec = meleeDef(def.melee);
    const melee = meleeSolids(spec, f);
    if (melee.length) zones.push(zone(spec.look, melee, MELEE_ZONES[spec.look]));
  }
  return zones;
}

/**
 * Ce que réserve une arme de contact, selon son allure : fait de plusieurs pièces (des mâchoires) ou
 * non. Son nom est dans chaque langue (`zonePart.<allure>`).
 */
const MELEE_ZONES: Record<MeleeSpec["look"], boolean> = {
  bar: false, hammer: false, disc: false, drum: false, shell: false,
  // (ses pales sont celles du moteur : `BLADES.propeller`, réservées comme celles de toute hélice)
  propeller: false,
  saber: false, whip: false, lance: false, field: false, saw: false, drill: false, plate: false, flail: false,
  jaw: true,
};

/** Épaisseur du plateau d'un flipper et des mâchoires (m), pour leur encombrement et leur dessin. */
export const PLATE_THICK = 0.08;
export const JAW_THICK = 0.1;
/** Rayon du mât d'un fléau (m), de son bloc jusqu'au moyeu de sa manivelle. */
export const FLAIL_MAST = 0.07;

/** Épaisseur du bras d'un marteau (m), pour son encombrement (le rendu le dessine de cette largeur). */
export const HAMMER_ARM = 0.1;
/** Pas (rad) des positions du bras d'un marteau qui couvrent l'arc qu'il balaie. */
const ARC_SAMPLE = 0.15;

/**
 * Ce que balaie une arme de contact, dans le repère du robot (`f` : le repère de son bloc) : tout le
 * disque de la lame d'un rotor (il tourne), l'arc entier du bras d'un marteau ou d'un fouet, de son
 * repos à la fin de sa frappe (un éventail de positions du bras, et le chemin de sa tête), la course
 * d'une lance sortie, le tube d'un anneau et le voile qui le relie à son moyeu. Un champ ne réserve
 * rien : il entoure la coque ; une hélice non plus : ses pales sont déjà réservées (`BLADES`).
 */
function meleeSolids(spec: MeleeSpec, f: ReturnType<typeof frame>): Solid[] {
  const hub = vec3(spec.hub[0], spec.hub[1], spec.hub[2]);
  const axisLetter = spec.axis === "up" ? "y" : spec.axis === "left" ? "x" : "z";
  if (spec.motion === "driven") return [];
  const blade = spec.blade;
  if (blade) {
    const axis = f.axis(axisLetter);
    const ring: Solid = { kind: "cylinder", axis, center: f.at(hub), radius: blade.outer, half: blade.half, ...(blade.inner > 0 ? { inner: blade.inner } : {}) };
    if (!blade.web) return [ring];
    const along = meleeAxes(spec.axis).axis;
    return [ring, { kind: "cylinder", axis, center: f.at(add(hub, scale(along, blade.web.at))), radius: blade.outer, half: blade.web.half }];
  }
  if (spec.thrust) {
    // La pointe sortie au bout de sa course, et la hampe qui la porte depuis le moyeu
    return [{ kind: "capsule", a: f.at(hub), b: f.at(add(hub, tipOffset(spec.axis, spec.thrust.reach))), radius: spec.thrust.radius }];
  }
  if (spec.plate || spec.jaw) return pivotSolids(spec, f);
  const flail = spec.flail;
  if (flail) {
    // Le mât jusqu'au moyeu, et le tour de la boule lancée (elle pend un peu sous la manivelle)
    const axis = meleeAxes(spec.axis).axis;
    const orbit = flailOrbit(flail);
    return [
      { kind: "capsule", a: f.at(scale(axis, BLOCK_SIZE / 2)), b: f.at(hub), radius: FLAIL_MAST },
      {
        kind: "cylinder", axis: f.axis(axisLetter), center: f.at(sub(hub, scale(axis, orbit.drop / 2))),
        radius: orbit.radius + flail.radius, half: orbit.drop / 2 + flail.radius,
      },
    ];
  }
  const swing = spec.swing;
  if (!swing) return [];
  const solids: Solid[] = [];
  const steps = Math.max(1, Math.ceil(Math.abs(swing.rest - swing.end) / ARC_SAMPLE));
  let prev: Vec3 | null = null;
  for (let i = 0; i <= steps; i++) {
    const angle = swing.rest + ((swing.end - swing.rest) * i) / steps;
    const head = f.at(add(hub, headOffset(spec.axis, swing, angle)));
    solids.push({ kind: "capsule", a: f.at(hub), b: head, radius: HAMMER_ARM / 2 });
    if (prev) solids.push({ kind: "capsule", a: prev, b: head, radius: swing.radius });
    prev = head;
  }
  return solids;
}

/**
 * Ce que balaie le plateau d'un flipper (de son coin au repos à sa levée) ou les deux mâchoires (de
 * grandes ouvertes à fermées) : un éventail de positions, chacune en capsules sur toute sa largeur.
 */
function pivotSolids(spec: MeleeSpec, f: ReturnType<typeof frame>): Solid[] {
  const hub = vec3(spec.hub[0], spec.hub[1], spec.hub[2]);
  const axis = meleeAxes(spec.axis).axis;
  const plate = spec.plate;
  const jaw = spec.jaw;
  const [from, to, length, half, thick] = plate
    ? [plate.rest, plate.end, plate.length, plate.half, PLATE_THICK]
    : [-jaw!.open, jaw!.open, jaw!.length, jaw!.half, JAW_THICK];
  const r = thick / 2;
  const solids: Solid[] = [];
  const steps = Math.max(1, Math.ceil(Math.abs(to - from) / ARC_SAMPLE));
  for (let i = 0; i <= steps; i++) {
    const dir = pivotDir(spec.axis, from + ((to - from) * i) / steps);
    for (const across of [-1, -0.5, 0, 0.5, 1]) {
      const side = scale(axis, across * (half - r));
      solids.push({ kind: "capsule", a: f.at(add(hub, side)), b: f.at(add(hub, add(side, scale(dir, length - r)))), radius: r });
    }
  }
  return solids;
}

/**
 * Ce que réserve une roue : son disque au repos, élargi de ce qu'elle balaie en braquant (une roue
 * directrice, une roulette qui fait le tour : `steerClearance`, que le jeu laisse déjà entre elle et
 * son bloc). Pas le débattement de sa suspension : comme une tourelle, elle réserve sa pose de repos
 * (et une roue posée sous son bloc y remonte en jeu). `index` : son rang dans le plan.
 */
export function wheelZone(w: WheelMount, index: number): Zone | null {
  if (!isWheelType(w.type)) return null;
  const def = wheelDef(w.type);
  const p = wheelLocalPos(w);
  const half = def.width / 2 + steerClearance(def);
  return {
    owners: [wheelKey(index)],
    part: def.track ? "roller" : "wheel",
    plural: false,
    solids: [{ kind: "cylinder", axis: "x", center: p, radius: def.radius, half }],
    own: [cellKey(w.x, w.y, w.z)],
  };
}

/** Bandes des chenilles : un pavé autour de chaque groupe de galets (ce qu'enveloppe la bande). */
function beltZones(wheels: readonly WheelMount[]): Zone[] {
  const rollers = wheels.map((w, index) => ({ w, index })).filter(({ w }) => isWheelType(w.type) && wheelDef(w.type).track);
  if (!rollers.length) return [];
  const def = wheelDef(rollers[0].w.type);
  return trackGroups(rollers, ({ w }) => wheelLocalPos(w), def).map((group) => {
    const at = group.map(({ w }) => wheelLocalPos(w));
    const reach = def.radius + BELT_CLEARANCE;
    const lo = vec3(Math.min(...at.map((p) => p.x)) - def.width / 2 - BELT_MARGIN, Math.min(...at.map((p) => p.y)) - reach, Math.min(...at.map((p) => p.z)) - reach);
    const hi = vec3(Math.max(...at.map((p) => p.x)) + def.width / 2 + BELT_MARGIN, Math.max(...at.map((p) => p.y)) + reach, Math.max(...at.map((p) => p.z)) + reach);
    return {
      owners: group.map(({ index }) => wheelKey(index)),
      part: "track",
      plural: false,
      solids: [{ kind: "box", center: scale(add(lo, hi), 0.5), half: scale(sub(hi, lo), 0.5) }],
      own: group.map(({ w }) => cellKey(w.x, w.y, w.z)),
    };
  });
}

/** Tout ce que réservent les pièces d'un plan au-delà de leur case. */
export function designZones(design: RobotDesign): Zone[] {
  const com = designCenterOfMass(design);
  const zones = design.blocks.flatMap((b) => blockZones(b, com));
  design.wheels.forEach((w, i) => {
    const zone = wheelZone(w, i);
    if (zone) zones.push(zone);
  });
  return [...zones, ...beltZones(design.wheels)];
}

// --- Géométrie ---

/** Boîte englobante d'un volume. */
export function solidBounds(s: Solid): { min: Vec3; max: Vec3 } {
  if (s.kind === "box") return { min: sub(s.center, s.half), max: add(s.center, s.half) };
  if (s.kind === "capsule") {
    const r = vec3(s.radius, s.radius, s.radius);
    const min = vec3(Math.min(s.a.x, s.b.x), Math.min(s.a.y, s.b.y), Math.min(s.a.z, s.b.z));
    const max = vec3(Math.max(s.a.x, s.b.x), Math.max(s.a.y, s.b.y), Math.max(s.a.z, s.b.z));
    return { min: sub(min, r), max: add(max, r) };
  }
  const h = vec3(s.axis === "x" ? s.half : s.radius, s.axis === "y" ? s.half : s.radius, s.axis === "z" ? s.half : s.radius);
  return { min: sub(s.center, h), max: add(s.center, h) };
}

/** Distance signée d'un point à un volume (négative dedans). */
function signedDistance(s: Solid, p: Vec3): number {
  if (s.kind === "box") {
    const q = [Math.abs(p.x - s.center.x) - s.half.x, Math.abs(p.y - s.center.y) - s.half.y, Math.abs(p.z - s.center.z) - s.half.z];
    return Math.hypot(...q.map((v) => Math.max(v, 0))) + Math.min(Math.max(...q), 0);
  }
  if (s.kind === "capsule") return distance(p, closestOnSegment(s.a, s.b, p)) - s.radius;
  const d = sub(p, s.center);
  const along = s.axis === "x" ? d.x : s.axis === "y" ? d.y : d.z;
  const across = Math.sqrt(Math.max(0, dot(d, d) - along * along));
  // (un tube : hors de lui aussi en deçà de son rayon intérieur)
  const dr = Math.max(across - s.radius, (s.inner ?? -Infinity) - across);
  const da = Math.abs(along) - s.half;
  return Math.min(Math.max(dr, da), 0) + Math.hypot(Math.max(dr, 0), Math.max(da, 0));
}

function closestOnSegment(a: Vec3, b: Vec3, p: Vec3): Vec3 {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
  return add(a, scale(ab, t));
}

/** Demi-côté d'une case, rétréci de la marge tolérée : une pièce doit y entrer de plus que `CLEARANCE_SLACK`. */
const CELL_INNER = BLOCK_SIZE / 2 - CLEARANCE_SLACK;

/** Le volume entre-t-il dans cette case (de plus que la marge tolérée) ? */
function entersCell(s: Solid, cell: Vec3): boolean {
  const h = CELL_INNER;
  const { min, max } = solidBounds(s);
  if (min.x >= cell.x + h || max.x <= cell.x - h || min.y >= cell.y + h || max.y <= cell.y - h || min.z >= cell.z + h || max.z <= cell.z - h) {
    return false;
  }
  if (s.kind === "box") {
    return Math.abs(s.center.x - cell.x) < s.half.x + h && Math.abs(s.center.y - cell.y) < s.half.y + h && Math.abs(s.center.z - cell.z) < s.half.z + h;
  }
  if (s.kind === "cylinder") {
    const d = sub(s.center, cell);
    const [along, u, v] = s.axis === "x" ? [d.x, d.y, d.z] : s.axis === "y" ? [d.y, d.x, d.z] : [d.z, d.x, d.y];
    if (Math.abs(along) >= s.half + h) return false;
    // Le disque et le carré de la case, dans le plan perpendiculaire à l'axe
    const du = Math.max(0, Math.abs(u) - h);
    const dv = Math.max(0, Math.abs(v) - h);
    // Un tube : le coin du carré le plus loin de l'axe doit dépasser son rayon intérieur
    return Math.hypot(du, dv) < s.radius && (!s.inner || Math.hypot(Math.abs(u) + h, Math.abs(v) + h) > s.inner);
  }
  // Capsule : la plus courte distance du segment à la case, au centimètre près
  const steps = Math.max(1, Math.ceil(distance(s.a, s.b) / 0.01));
  const inner: Solid = { kind: "box", center: cell, half: vec3(h, h, h) };
  for (let i = 0; i <= steps; i++) {
    const p = add(s.a, scale(sub(s.b, s.a), i / steps));
    if (signedDistance(inner, p) < s.radius) return true;
  }
  return false;
}

/** Cases (clés) où entre un volume. */
export function solidCells(s: Solid): string[] {
  const { min, max } = solidBounds(s);
  const lo = (v: number): number => Math.ceil((v - CELL_INNER) / BLOCK_SIZE - 1e-9);
  const hi = (v: number): number => Math.floor((v + CELL_INNER) / BLOCK_SIZE + 1e-9);
  const cells: string[] = [];
  for (let x = lo(min.x); x <= hi(max.x); x++) {
    for (let y = lo(min.y); y <= hi(max.y); y++) {
      for (let z = lo(min.z); z <= hi(max.z); z++) {
        if (entersCell(s, vec3(x * BLOCK_SIZE, y * BLOCK_SIZE, z * BLOCK_SIZE))) cells.push(cellKey(x, y, z));
      }
    }
  }
  return cells;
}

/** Cases où entre une zone, hors celles où elle a le droit d'empiéter. */
export function zoneCells(zone: Zone): string[] {
  const own = new Set(zone.own);
  return [...new Set(zone.solids.flatMap(solidCells))].filter((key) => !own.has(key));
}

/** Pas de l'échantillonnage du recouvrement de deux volumes (m), et profondeur dont ils doivent s'interpénétrer (m). */
const SAMPLE = 0.02;
const TOUCH = CLEARANCE_SLACK;

/** Profondeur dont il faut entrer dans un volume pour le gêner : `TOUCH`, ou moins pour un volume mince (le disque des pales). */
function depthOf(s: Solid): number {
  const { min, max } = solidBounds(s);
  return Math.min(TOUCH, Math.min(max.x - min.x, max.y - min.y, max.z - min.z) / 4);
}

/**
 * Deux volumes s'interpénètrent-ils, chacun d'au moins sa profondeur tolérée (`depthOf`) ? Une
 * capsule est une suite de boules le long de son segment : on le parcourt au centimètre ; deux pavés
 * se comparent axe par axe ; sinon, on cherche un point assez profond dans les deux, sur une grille
 * fine de leur recouvrement.
 */
export function solidsOverlap(a: Solid, b: Solid): boolean {
  const ba = solidBounds(a);
  const bb = solidBounds(b);
  const min = vec3(Math.max(ba.min.x, bb.min.x), Math.max(ba.min.y, bb.min.y), Math.max(ba.min.z, bb.min.z));
  const max = vec3(Math.min(ba.max.x, bb.max.x), Math.min(ba.max.y, bb.max.y), Math.min(ba.max.z, bb.max.z));
  if (min.x >= max.x || min.y >= max.y || min.z >= max.z) return false;
  const [ea, eb] = [depthOf(a), depthOf(b)];
  // Tout l'un dans le creux d'un tube (le robot dans son anneau-coque) : rien à chercher
  if (inHole(a, bb) || inHole(b, ba)) return false;
  if (a.kind === "capsule" || b.kind === "capsule") {
    const [c, o, ec, eo] = a.kind === "capsule" ? [a, b, ea, eb] : [b as Extract<Solid, { kind: "capsule" }>, a, eb, ea];
    const steps = Math.max(1, Math.ceil(distance(c.a, c.b) / 0.01));
    for (let i = 0; i <= steps; i++) {
      if (signedDistance(o, add(c.a, scale(sub(c.b, c.a), i / steps))) < c.radius - ec - eo) return true;
    }
    return false;
  }
  if (a.kind === "box" && b.kind === "box") {
    const meets = (k: "x" | "y" | "z"): boolean => Math.abs(a.center[k] - b.center[k]) < a.half[k] - ea + b.half[k] - eb;
    return meets("x") && meets("y") && meets("z");
  }
  const n =(lo: number, hi: number): number => Math.max(2, Math.ceil((hi - lo) / SAMPLE));
  const [nx, ny, nz] = [n(min.x, max.x), n(min.y, max.y), n(min.z, max.z)];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      for (let k = 0; k < nz; k++) {
        const p = vec3(
          min.x + ((i + 0.5) / nx) * (max.x - min.x),
          min.y + ((j + 0.5) / ny) * (max.y - min.y),
          min.z + ((k + 0.5) / nz) * (max.z - min.z),
        );
        if (signedDistance(a, p) < -ea && signedDistance(b, p) < -eb) return true;
      }
    }
  }
  return false;
}

/** Une boîte (`bounds`) tient-elle tout entière dans le creux du tube `s`, vue le long de son axe ? */
function inHole(s: Solid, bounds: { min: Vec3; max: Vec3 }): boolean {
  if (s.kind !== "cylinder" || !s.inner) return false;
  const k = s.axis;
  const [u, v] = k === "x" ? (["y", "z"] as const) : k === "y" ? (["x", "z"] as const) : (["x", "y"] as const);
  const du = Math.max(Math.abs(bounds.min[u] - s.center[u]), Math.abs(bounds.max[u] - s.center[u]));
  const dv = Math.max(Math.abs(bounds.min[v] - s.center[v]), Math.abs(bounds.max[v] - s.center[v]));
  return Math.hypot(du, dv) <= s.inner;
}

/** Deux zones se gênent-elles ? (Pas deux parties d'une même pièce, ni un galet et sa chenille.) */
function zonesClash(a: Zone, b: Zone): boolean {
  if (a.owners.some((o) => b.owners.includes(o))) return false;
  return a.solids.some((sa) => b.solids.some((sb) => solidsOverlap(sa, sb)));
}

// --- Conflits ---

/** Ce qui se gêne dans un plan : une pièce `a` (sa zone `zone`) et une autre `b` (son bloc, sa zone, ou sa roue). */
export interface Clash {
  a: string;
  b: string;
  /** Zone de `a` en cause (absente : `a` est un bloc posé dans la zone de `b`, ou une roue sur une roue). */
  zone?: Zone;
  /** Zone de `b` en cause (absente : la case du bloc `b`, ou la roue `b` elle-même). */
  other?: Zone;
  /** Deux roues qui se chevauchent. */
  wheels?: boolean;
}

/** La pièce d'un plan (son type) d'après sa clé ; null : une case vide ou un type inconnu. */
export function piecePart(design: RobotDesign, key: string): Part | null {
  if (key.startsWith("w:")) {
    const w = design.wheels[Number(key.slice(2))];
    return w && isWheelType(w.type) ? { kind: "wheel", type: w.type } : null;
  }
  const [x, y, z] = key.slice(2).split(",").map(Number);
  const b = design.blocks.find((o) => o.x === x && o.y === y && o.z === z);
  return b && isBlockType(b.type) ? { kind: "block", type: b.type } : null;
}

/** Tous les conflits d'encombrement d'un plan (une fois chacun). Le garage les signale, `validateDesign` les ignore. */
export function designConflicts(design: RobotDesign): Clash[] {
  return findClashes(design, null);
}

/**
 * Conflits d'un plan qui mettent en cause la pièce `key` ; `null` : tous. Une case pleine dans la
 * zone d'une autre pièce, deux zones qui se recouvrent, deux roues qui se chevauchent.
 */
function findClashes(design: RobotDesign, key: string | null): Clash[] {
  const zones = designZones(design);
  const blocks = new Map(design.blocks.map((b) => [cellKey(b.x, b.y, b.z), b]));
  const concerns = (z: Zone): boolean => key === null || z.owners.includes(key);
  const clashes: Clash[] = [];
  // Une plaque n'occupe qu'une dalle de sa case
  const fills = (zone: Zone, b: BlockPlacement): boolean => {
    const plate = plateBody(b);
    return !plate || zone.solids.some((s) => solidsOverlap(s, plate));
  };
  // Le bloc qu'on pose, s'il en est un : dans les zones des autres, on ne regarde que sa case
  const placed = key?.startsWith("b:") ? blocks.get(key.slice(2)) : undefined;
  // Un bloc dans la zone d'une autre pièce
  for (const zone of zones) {
    if (!concerns(zone)) {
      if (!placed || zone.own.includes(key!.slice(2))) continue;
      const at = center(placed);
      if (zone.solids.some((s) => entersCell(s, at)) && fills(zone, placed)) clashes.push({ a: key!, b: zone.owners[0], other: zone });
      continue;
    }
    for (const cell of zoneCells(zone)) {
      const b = blocks.get(cell);
      if (!b || zone.owners.includes(blockKey(b)) || !fills(zone, b)) continue;
      clashes.push({ a: key ?? zone.owners[0], b: blockKey(b), zone });
    }
  }
  // Deux zones qui se recouvrent (pas deux roues : voir plus bas)
  for (let i = 0; i < zones.length; i++) {
    for (let j = i + 1; j < zones.length; j++) {
      const [za, zb] = [zones[i], zones[j]];
      if (!concerns(za) && !concerns(zb)) continue;
      const wheels = za.owners.length === 1 && zb.owners.length === 1 && za.owners[0].startsWith("w:") && zb.owners[0].startsWith("w:");
      if (wheels || !zonesClash(za, zb)) continue;
      const [mine, theirs] = concerns(za) ? [za, zb] : [zb, za];
      clashes.push({ a: key ?? mine.owners[0], b: theirs.owners[0], zone: mine, other: theirs });
    }
  }
  // Deux roues qui se chevauchent : la règle de validateDesign
  design.wheels.forEach((w, i) => {
    design.wheels.forEach((o, j) => {
      if (j <= i || !isWheelType(w.type) || !isWheelType(o.type)) return;
      const [ka, kb] = [wheelKey(i), wheelKey(j)];
      if (key !== null && key !== ka && key !== kb) return;
      if (!wheelsOverlap(w, o)) return;
      clashes.push(key === kb ? { a: kb, b: ka, wheels: true } : { a: ka, b: kb, wheels: true });
    });
  });
  return clashes;
}

/** Ce qu'est une zone, pour le dire (son nom, et s'il est au pluriel). */
export type ZoneName = Pick<Zone, "part" | "plural">;

/**
 * Pourquoi une pièce qu'on pose gêne, vu d'elle ; `other` : l'autre pièce (son type). Le client le
 * dit en une ligne dans la langue du joueur (« Gêne le canon (Tourelle mitrailleuse) », « La roue
 * heurterait l'hélice (Hélice) ») : `conflictText`, client/i18n/names.ts.
 */
export type ConflictReason =
  /** Un bloc sur une case déjà prise. */
  | { code: "occupied"; other: Part | null }
  /** Deux roues qui se chevauchent. */
  | { code: "overlapsWheel"; other: Part | null }
  /** La pièce posée entre dans la zone de l'autre (`zone`). */
  | { code: "blocks"; zone: ZoneName; other: Part | null }
  /** La zone de la pièce posée (`zone`) entrerait dans un bloc. */
  | { code: "enters"; zone: ZoneName; other: Part | null }
  /** La zone de la pièce posée (`zone`) heurterait celle de l'autre (`otherZone`). */
  | { code: "hits"; zone: ZoneName; otherZone: ZoneName; other: Part | null };

/**
 * Un conflit vu de la pièce qu'on pose : l'autre pièce (sa clé), pourquoi, et ce qui gêne chez elle
 * (sa zone, ou le corps de son bloc), pour le montrer.
 */
export interface Conflict {
  other: string;
  reason: ConflictReason;
  solids: Solid[];
}

/** Corps d'un bloc : sa case, ou la dalle d'une plaque. */
export function blockBody(b: BlockPlacement): Solid {
  const h = BLOCK_SIZE / 2;
  return plateBody(b) ?? { kind: "box", center: center(b), half: vec3(h, h, h) };
}

/** Le plan avec la pièce posée, et la clé qu'elle y a. */
function withPiece(design: RobotDesign, piece: Piece): { after: RobotDesign; key: string } {
  return piece.kind === "block"
    ? { after: { blocks: [...design.blocks, piece.block], wheels: design.wheels }, key: blockKey(piece.block) }
    : { after: { blocks: design.blocks, wheels: [...design.wheels, piece.wheel] }, key: wheelKey(design.wheels.length) };
}

/** Ce que réserverait une pièce une fois posée dans ce plan (pour une roue de chenille, la bande comprise). */
export function pieceZones(design: RobotDesign, piece: Piece): Zone[] {
  const { after, key } = withPiece(design, piece);
  return designZones(after).filter((z) => z.owners.includes(key));
}

/** Ce qui gêne chez l'autre pièce d'un conflit. */
function otherSolids(design: RobotDesign, clash: Clash): Solid[] {
  if (clash.other) return clash.other.solids;
  if (clash.wheels) {
    const index = Number(clash.b.slice(2));
    return wheelZone(design.wheels[index], index)?.solids ?? [];
  }
  const [x, y, z] = clash.b.slice(2).split(",").map(Number);
  const b = design.blocks.find((o) => o.x === x && o.y === y && o.z === z);
  return b ? [blockBody(b)] : [];
}

const zoneName = (z: Zone): ZoneName => ({ part: z.part, plural: z.plural });

/** Pourquoi une pièce qu'on pose gêne : vu d'elle (`clash.a`). */
function reasonOf(design: RobotDesign, clash: Clash): ConflictReason {
  const other = piecePart(design, clash.b);
  if (clash.wheels) return { code: "overlapsWheel", other };
  if (!clash.zone) return { code: "blocks", zone: zoneName(clash.other!), other };
  if (!clash.other) return { code: "enters", zone: zoneName(clash.zone), other };
  return { code: "hits", zone: zoneName(clash.zone), otherZone: zoneName(clash.other), other };
}

/**
 * Peut-on poser cette pièce dans ce plan ? La liste de ce qu'elle gênerait (vide : oui), dans les
 * deux sens : un bloc posé dans la zone d'une pièce (le canon d'une tourelle, une roue…), ou une
 * pièce dont la zone entrerait dans un bloc ou dans la zone d'une autre. Un bloc sur une case
 * occupée est refusé aussi.
 */
export function placementConflicts(design: RobotDesign, piece: Piece): Conflict[] {
  if (piece.kind === "block") {
    const { x, y, z } = piece.block;
    const there = design.blocks.find((b) => b.x === x && b.y === y && b.z === z);
    if (there) return [{ other: blockKey(there), reason: { code: "occupied", other: piecePart(design, blockKey(there)) }, solids: [blockBody(there)] }];
  }
  const { after, key } = withPiece(design, piece);
  return findClashes(after, key).map((c) => ({ other: c.b, reason: reasonOf(after, c), solids: otherSolids(after, c) }));
}
