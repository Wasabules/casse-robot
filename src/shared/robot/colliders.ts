import RAPIER from "@dimforge/rapier3d-compat";
import { blockDef, blockShape, type BlockType } from "../catalog/blocks";
import { headOffset, meleeAxes, meleeDef } from "../catalog/melee";
import { shapePieces, type ShapeId } from "../catalog/shapes";
import { BLOCK_FRICTION, BLOCK_HALF, BLOCK_RESTITUTION, BLOCK_SIZE, PLATE_THICKNESS } from "../config";
import { cellKey } from "../design/robotDesign";
import { add, axisAngle, cross, distance, qmul, qrot, qrotInv, quatFromBasis, scale, sub, vec3, type Quat, type Vec3 } from "../math/vec";
import { CONTACT_FORCE_THRESHOLD } from "../combat/collisions";
import { COLLISION_GROUPS } from "../physics/groups";
import type { Block, Bot, ColliderOwner, HitTarget, MeleeHitbox, Part, Turret, TurretHitbox } from "../sim/entities";
import type { Simulation } from "../sim/simulation";

/** Jeu laissé entre un bloc et ses voisins d'un autre morceau (m). */
const GAP = BLOCK_SIZE / 2 - BLOCK_HALF;

/**
 * Reconstruit les colliders d'un morceau. Les cubes voisins de même type sont fusionnés en
 * grandes boîtes (fusion gloutonne : on étend chaque boîte en x, puis en y, puis en z tant que
 * toutes les cases sont pleines) ; les plaques (ailes, gouvernes) et les blocs de forme (biseaux,
 * coins, arrondis : une enveloppe convexe par morceau) gardent chacun leur collider.
 * Moins de colliders, c'est beaucoup moins de travail pour le moteur physique. La densité de
 * chaque boîte donne exactement la masse nominale de ses blocs.
 */
export function rebuildColliders(sim: Simulation, part: Part): void {
  for (const c of part.colliders) {
    sim.colliders.delete(c.handle);
    sim.world.removeCollider(c, false);
  }
  part.colliders = [];
  part.heads = [];
  part.blades = [];
  part.dirty = false;

  const cubes = new Map<string, Block>();
  for (const b of part.blocks) {
    if (blockDef(b.type).shape === "plate") addPlate(sim, part, b);
    else if (blockShape(b.type)) addShape(sim, part, b);
    else cubes.set(b.key, b);
  }

  const used = new Set<Block>();
  const free = (x: number, y: number, z: number, type: BlockType): boolean => {
    const b = cubes.get(cellKey(x, y, z));
    return !!b && b.type === type && !used.has(b);
  };
  // Parcours dans un ordre fixe, pour que le résultat ne dépende pas de l'historique du morceau
  const ordered = [...cubes.values()].sort((a, b) => a.x - b.x || a.y - b.y || a.z - b.z);
  for (const start of ordered) {
    if (used.has(start)) continue;
    const { x, y, z, type } = start;
    let x1 = x;
    while (free(x1 + 1, y, z, type)) x1++;
    let y1 = y;
    while (range(x, x1).every((i) => free(i, y1 + 1, z, type))) y1++;
    let z1 = z;
    while (range(x, x1).every((i) => range(y, y1).every((j) => free(i, j, z1 + 1, type)))) z1++;
    for (const i of range(x, x1)) for (const j of range(y, y1)) for (const k of range(z, z1)) used.add(cubes.get(cellKey(i, j, k))!);
    addBox(sim, part, type, [x, y, z], [x1, y1, z1]);
  }
  addHeads(sim, part);
  addBlades(sim, part);
  // Sans cela, Rapier ne retirerait la masse des anciens colliders qu'au pas suivant
  part.rb.recomputeMassPropertiesFromColliders();
}

const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** Boîte couvrant les cases de `min` à `max` (incluses). */
function addBox(sim: Simulation, part: Part, type: BlockType, min: number[], max: number[]): void {
  const half = min.map((m, i) => ((max[i] - m + 1) * BLOCK_SIZE) / 2 - GAP);
  const center = min.map((m, i) => ((m + max[i]) / 2) * BLOCK_SIZE);
  const cells = (max[0] - min[0] + 1) * (max[1] - min[1] + 1) * (max[2] - min[2] + 1);
  const density = (cells * blockDef(type).mass) / (8 * half[0] * half[1] * half[2]);
  const desc = RAPIER.ColliderDesc.cuboid(half[0], half[1], half[2]).setTranslation(center[0], center[1], center[2]);
  attach(sim, part, desc, density);
}

/** Plaque d'une case, orientée comme son bloc. */
function addPlate(sim: Simulation, part: Part, b: Block): void {
  const desc = RAPIER.ColliderDesc.cuboid(BLOCK_HALF, PLATE_THICKNESS / 2, BLOCK_HALF)
    .setTranslation(b.local.x, b.local.y, b.local.z)
    .setRotation(b.rot);
  attach(sim, part, desc, blockDef(b.type).mass / (8 * BLOCK_HALF * BLOCK_HALF * (PLATE_THICKNESS / 2)));
}

/** Sommets de chaque morceau convexe d'une forme, à la taille d'un bloc (repère du bloc), calculés une fois. */
const HULLS = new Map<ShapeId, { points: Float32Array; volume: number }[]>();

function shapeHulls(shape: ShapeId): { points: Float32Array; volume: number }[] {
  let hulls = HULLS.get(shape);
  if (!hulls) {
    hulls = shapePieces(shape).map((p) => ({
      points: Float32Array.from(p.points.flatMap((v) => [v.x * BLOCK_HALF, v.y * BLOCK_HALF, v.z * BLOCK_HALF])),
      volume: p.volume * BLOCK_HALF ** 3,
    }));
    HULLS.set(shape, hulls);
  }
  return hulls;
}

/**
 * Bloc de forme (biseau, coin, arrondi…) : l'enveloppe convexe de chacun de ses morceaux, orientée
 * comme lui ; il ne se fond pas avec ses voisins. Les morceaux d'un coin rentrant se recouvrent :
 * la densité est répartie sur leur volume total, pour la masse nominale.
 */
function addShape(sim: Simulation, part: Part, b: Block): void {
  const hulls = shapeHulls(blockShape(b.type)!);
  const density = blockDef(b.type).mass / hulls.reduce((s, h) => s + h.volume, 0);
  for (const hull of hulls) {
    const desc = RAPIER.ColliderDesc.convexHull(hull.points);
    if (!desc) continue;
    attach(sim, part, desc.setTranslation(b.local.x, b.local.y, b.local.z).setRotation(b.rot), density);
  }
}

function attach(sim: Simulation, part: Part, desc: RAPIER.ColliderDesc, density: number): void {
  desc.setDensity(density).setFriction(BLOCK_FRICTION).setRestitution(BLOCK_RESTITUTION).setCollisionGroups(COLLISION_GROUPS.robot)
    .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(CONTACT_FORCE_THRESHOLD);
  const collider = sim.world.createCollider(desc, part.rb);
  sim.colliders.set(collider.handle, { kind: "part", part });
  part.colliders.push(collider);
}

/**
 * Zones touchables des têtes des tourelles du morceau. La tête et le canon dépassent du bloc, et
 * les collisions d'un bloc ne sont que son cube : sans elles, un tir passait à travers l'arme et
 * ne touchait que le bloc dessous, ou rien. Un pavé pour la tête (`TurretSpec.head`), un cylindre
 * pour le canon (`caliber`, jusqu'à sa bouche), sans masse (la densité nulle laisse au bloc sa
 * masse nominale) et sans contact (`COLLISION_GROUPS.hitbox` : un canon qui frôle le sol ou un mur
 * n'y accroche pas) ; les tirs et les rayons les voient, et un coup dessus frappe le bloc de la
 * tourelle (`hitTargetOf`). Posés d'après le lacet et le site de la tête, puis suivis par `syncHeads`.
 */
function addHeads(sim: Simulation, part: Part): void {
  for (const turret of part.bot.turrets) {
    if (turret.block.part !== part || !part.blocks.has(turret.block)) continue;
    const spec = blockDef(turret.block.type).turret!;
    const [w, h, d] = spec.head;
    const head = attachHitbox(sim, part, turret, RAPIER.ColliderDesc.cuboid((w * HITBOX_SHARE) / 2, (h * HITBOX_SHARE) / 2, (d * HITBOX_SHARE) / 2));
    // Un canon le long de la tête (pas pour la soute à bombes : son râtelier, c'est la tête)
    const radius = Math.max(MIN_CALIBER, spec.caliber) / 2;
    const half = spec.barrel / 2 - radius;
    const barrel = spec.fixed !== "down" && half > 0.02 ? attachHitbox(sim, part, turret, RAPIER.ColliderDesc.capsule(half, radius)) : null;
    const hitbox: TurretHitbox = { turret, head, barrel, yaw: NaN, pitch: NaN };
    placeHead(hitbox);
    part.heads.push(hitbox);
  }
}

/** Part des dimensions de la tête dessinée que couvre sa zone touchable : un peu en dedans, pour ne pas toucher à côté. */
const HITBOX_SHARE = 0.9;
/** Calibre minimal d'un canon (m) : un tube de fusil de 7 cm se toucherait à peine. */
const MIN_CALIBER = 0.1;

function attachHitbox(sim: Simulation, part: Part, turret: Turret, desc: RAPIER.ColliderDesc): RAPIER.Collider {
  desc.setDensity(0).setCollisionGroups(COLLISION_GROUPS.hitbox);
  const collider = sim.world.createCollider(desc, part.rb);
  sim.colliders.set(collider.handle, { kind: "head", turret });
  part.colliders.push(collider);
  return collider;
}

/** Quart de tour autour de x : l'axe d'une capsule de Rapier (y) devient celui du canon (z). */
const CAPSULE_TO_Z = axisAngle(vec3(1, 0, 0), Math.PI / 2);

/**
 * Pose la zone touchable d'une tête d'après son lacet et son site (comme la dessine le rendu :
 * lacet, puis site ; un poseur de mines est tourné vers l'arrière), dans le repère du morceau.
 */
function placeHead(h: TurretHitbox): void {
  const t = h.turret;
  const spec = blockDef(t.block.type).turret!;
  const turn: Quat = spec.fixed === "back" ? axisAngle(vec3(0, 1, 0), Math.PI) : spec.fixed === "down"
    ? { x: 0, y: 0, z: 0, w: 1 }
    : qmul(axisAngle(vec3(0, 1, 0), t.yaw), axisAngle(vec3(1, 0, 0), -t.pitch));
  const q = qmul(t.block.rot, turn);
  const pivot = add(t.block.local, qrot(t.block.rot, vec3(0, spec.height, 0)));
  h.head.setTranslationWrtParent(pivot);
  h.head.setRotationWrtParent(q);
  if (h.barrel) {
    h.barrel.setTranslationWrtParent(add(pivot, qrot(q, vec3(0, 0, spec.barrel / 2))));
    h.barrel.setRotationWrtParent(qmul(q, CAPSULE_TO_Z));
  }
  h.yaw = t.yaw;
  h.pitch = t.pitch;
}

/**
 * Les zones touchables suivent les têtes qui ont tourné, les bras des rotors qui tournent et les
 * bras des armes de contact qui frappent (une fois par pas, avant la physique).
 */
export function syncHeads(sim: Simulation): void {
  for (const part of sim.parts) {
    for (const h of part.heads) {
      const t = h.turret;
      if (Math.abs(t.yaw - h.yaw) > HEAD_TURN || Math.abs(t.pitch - h.pitch) > HEAD_TURN) placeHead(h);
    }
    for (const h of part.blades) {
      if (h.moves === "rotor" ? Math.abs(h.arm.angle - h.angle) > HEAD_TURN : h.moves === "swing" && Math.abs(h.arm.swing - h.swing) > HEAD_TURN) {
        placeBlade(h);
      }
    }
  }
}

/** Épaisseur minimale (m, de part et d'autre) de la zone touchable d'une lame : une hélice est mince. */
const MIN_BLADE = 0.03;
/** Pavés de la zone touchable d'un anneau (tout autour de son axe). */
const RING_SEGMENTS = 16;

/**
 * Zones touchables des armes de contact du morceau : leur lame ou la tête de leur bras dépassent de
 * leur bloc, comme la tête d'une tourelle, et un tir les traversait. Un rotor à bras (une barre, une
 * hélice) : un pavé par bras, qui tourne avec lui (un tir passe entre) ; un rotor plein (un disque,
 * un tambour) : un cylindre, tout ce qu'il balaie ; un anneau (anneau-coque) : des pavés tout
 * autour (un tir sur le flanc du robot le touche, pas un tir d'en haut) ; un bras : une boule à la
 * place de sa tête. Sans masse ni contact (`COLLISION_GROUPS.hitbox`) ; un coup dessus frappe le bloc
 * de l'arme (`hitTargetOf`). Posées d'après l'angle du rotor ou du bras, puis suivies par `syncHeads`.
 */
function addBlades(sim: Simulation, part: Part): void {
  for (const arm of part.bot.melee) {
    if (arm.block.part !== part || !part.blocks.has(arm.block)) continue;
    const spec = meleeDef(arm.weapon);
    // (une arme d'énergie, `quench` : son arc ou son filament n'a rien qu'une balle puisse toucher)
    if (spec.quench) continue;
    const colliders: RAPIER.Collider[] = [];
    const attachTo = (desc: RAPIER.ColliderDesc): void => {
      desc.setDensity(0).setCollisionGroups(COLLISION_GROUPS.hitbox);
      const collider = sim.world.createCollider(desc, part.rb);
      sim.colliders.set(collider.handle, { kind: "blade", arm });
      part.colliders.push(collider);
      colliders.push(collider);
    };
    let moves: MeleeHitbox["moves"] = null;
    const blade = spec.blade;
    if (blade) {
      const half = Math.max(MIN_BLADE, blade.half);
      const reach = (blade.outer - blade.inner) / 2;
      if (blade.arms) {
        moves = "rotor";
        for (let i = 0; i < blade.arms.count; i++) attachTo(RAPIER.ColliderDesc.cuboid(blade.arms.width / 2, half, reach));
      } else if (blade.inner > 0) {
        const chord = blade.outer * Math.sin(Math.PI / RING_SEGMENTS);
        for (let i = 0; i < RING_SEGMENTS; i++) attachTo(RAPIER.ColliderDesc.cuboid(chord, half, reach));
      } else {
        attachTo(RAPIER.ColliderDesc.cylinder(half, blade.outer));
      }
    } else if (spec.swing) {
      moves = "swing";
      attachTo(RAPIER.ColliderDesc.ball(spec.swing.radius));
    }
    if (!colliders.length) continue;
    const hitbox: MeleeHitbox = { arm, colliders, moves, angle: NaN, swing: NaN };
    placeBlade(hitbox);
    part.blades.push(hitbox);
  }
}

/**
 * Pose la zone touchable d'une arme de contact dans le repère du morceau : les bras d'un rotor à
 * l'angle du rotor (le bras k le long de cos a·e1 + sin a·e2, a = angle + 2πk/n, comme la barre que
 * dessine le rendu), les pavés d'un anneau tout autour, le cylindre d'un rotor plein le long de son
 * axe, la boule d'un bras à la place de sa tête.
 */
function placeBlade(h: MeleeHitbox): void {
  const { arm } = h;
  const spec = meleeDef(arm.weapon);
  const block = arm.block;
  const hub = vec3(spec.hub[0], spec.hub[1], spec.hub[2]);
  const { axis, e1, e2 } = meleeAxes(spec.axis);
  // Du repère du bloc à celui du morceau
  const put = (c: RAPIER.Collider, at: Vec3, rot: Quat): void => {
    c.setTranslationWrtParent(add(block.local, qrot(block.rot, at)));
    c.setRotationWrtParent(qmul(block.rot, rot));
  };
  const blade = spec.blade;
  if (blade) {
    const along = (a: number): Vec3 => add(scale(e1, Math.cos(a)), scale(e2, Math.sin(a)));
    const middle = (blade.inner + blade.outer) / 2;
    if (blade.arms || blade.inner > 0) {
      const n = h.colliders.length;
      const start = blade.arms ? arm.angle : 0;
      h.colliders.forEach((c, k) => {
        const d = along(start + (2 * Math.PI * k) / n);
        // Le pavé : sa largeur de travers (x), son épaisseur le long de l'axe (y), sa longueur le long du bras (z)
        put(c, add(hub, scale(d, middle)), quatFromBasis(cross(axis, d), axis, d));
      });
    } else {
      // Le cylindre de Rapier est dressé selon y : le long de l'axe du rotor
      put(h.colliders[0], hub, quatFromBasis(e2, axis, e1));
    }
  } else if (spec.swing) {
    put(h.colliders[0], add(hub, headOffset(spec.axis, spec.swing, arm.swing)), { x: 0, y: 0, z: 0, w: 1 });
  }
  h.angle = arm.angle;
  h.swing = arm.swing;
}

/** Écart de lacet ou de site (rad) en deçà duquel on ne repose pas une zone touchable. */
const HEAD_TURN = 0.01;

/** Reconstruit les colliders des morceaux d'un robot qui ont changé. */
export function rebuildDirtyParts(sim: Simulation, bot: Bot): void {
  for (const part of bot.parts) if (part.dirty) rebuildColliders(sim, part);
}

/** Robot auquel appartient un collider (bloc ou roue), s'il y en a un. */
export function ownerBot(owner: ColliderOwner | undefined): Bot | null {
  if (owner?.kind === "part") return owner.part.bot;
  if (owner?.kind === "head") return owner.turret.block.bot;
  if (owner?.kind === "blade") return owner.arm.block.bot;
  if (owner?.kind === "wheel") return owner.wheel.bot;
  return null;
}

/** Ce qu'un rayon de direction `dir` touche en `point` sur ce collider : un bloc précis, une roue, un accessoire. */
export function hitTargetOf(owner: ColliderOwner | undefined, point: Vec3, dir: Vec3): HitTarget | undefined {
  if (!owner) return undefined;
  switch (owner.kind) {
    case "part": {
      const block = blockAt(owner.part, point, dir);
      return block ? { kind: "block", block } : undefined;
    }
    // La tête ou le canon d'une tourelle : c'est son bloc qui encaisse
    case "head":
      return owner.turret.block.alive ? { kind: "block", block: owner.turret.block } : undefined;
    // La lame ou le bras d'une arme de contact : c'est son bloc qui encaisse
    case "blade":
      return owner.arm.block.alive ? { kind: "block", block: owner.arm.block } : undefined;
    case "wheel":
    case "prop":
      return owner;
    case "debris":
      return undefined;
  }
}

/**
 * Bloc d'un morceau touché en `point` par un rayon de direction `dir` : la case de la grille
 * juste derrière le point d'impact. À défaut, le bloc du morceau le plus proche du point.
 */
export function blockAt(part: Part, point: Vec3, dir: Vec3): Block | undefined {
  const rb = part.rb;
  const local = qrotInv(rb.rotation(), sub(add(point, scale(dir, 0.02)), rb.translation()));
  const key = cellKey(Math.round(local.x / BLOCK_SIZE), Math.round(local.y / BLOCK_SIZE), Math.round(local.z / BLOCK_SIZE));
  const hit = part.bot.blocks.get(key);
  if (hit && hit.part === part) return hit;
  let best: Block | undefined;
  let bestDist = Infinity;
  for (const b of part.blocks) {
    const d = distance(b.local, local);
    if (d < bestDist) {
      bestDist = d;
      best = b;
    }
  }
  return best;
}
