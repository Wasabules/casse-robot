import * as B from "../babylon";
import { blockDef } from "../../shared/catalog/blocks";
import { wheelDef } from "../../shared/catalog/wheels";
import { BLOCK_SIZE } from "../../shared/config";
import { add, cross, len, norm, quatFromBasis, scale, sub, vec3, type Vec3 } from "../../shared/math/vec";
import { BLADES, bladeKind, headLift, legOut, restLeg } from "../../shared/design/clearance";
import { DEFAULT_FACING, wheelLocalPos, type BlockPlacement, type WheelMount } from "../../shared/design/robotDesign";
import { mountFace, wheelFittings } from "./fittings";
import type { Assets } from "./materials";
import { stillMelee } from "./meleeView";
import type { TurretBlockType } from "./models";
import { lampColors } from "./lightSources";

/*
 * Ce que le jeu dessine en plus du modèle d'un bloc ou d'une roue, immobile, pour le garage, l'aperçu
 * du choix du robot et les vignettes de l'inventaire : la tête d'une tourelle et ses munitions, les
 * pales d'un rotor ou d'une hélice, la nacelle d'un turboréacteur, une patte, la lueur d'un patin, la
 * barre d'une toupie ou le bras d'un marteau (armé), et
 * les ferrures d'une roue (fourche, potence, bras de direction). Mêmes sources et mêmes cotes qu'en
 * jeu (WorldView, LocomotionView), là où l'encombrement les réserve (shared/design/clearance.ts) ; les
 * chenilles ont leur pendant (`stillBelts`, render/belts.ts). Rien n'est visable : on vise le bloc.
 */

/** Angle des pales au repos (rad, autour de leur axe) : en croix de biais pour un rotor, une pale vers le haut pour une hélice. */
const REST_ANGLE = { rotor: Math.PI / 4, propeller: Math.PI / 2, tail: Math.PI / 4 } as const;

/** Lueur sous un patin au repos (il porte sa charge) : sous la face du dessous de son bloc (m), comme en jeu. */
const GLOW_BELOW = BLOCK_SIZE / 2 + 0.04;

/**
 * Parties d'un bloc, sous `mesh` (le bloc posé et orienté, dans le repère du robot) pour ce qui le
 * suit, dans le repère du robot pour une patte (elle part vers l'extérieur, d'après `com`, le
 * centre de masse du robot). Renvoie tout ce qui a été créé.
 */
export function stillBlockParts(assets: Assets, b: BlockPlacement, mesh: B.TransformNode, com: Vec3): B.AbstractMesh[] {
  const def = blockDef(b.type);
  const made: B.AbstractMesh[] = [];
  const child = (source: B.Mesh, name: string, y: number): B.InstancedMesh => {
    const m = source.createInstance(name);
    m.parent = mesh;
    m.position.set(0, y, 0);
    m.isPickable = false;
    made.push(m);
    return m;
  };
  if (def.turret) {
    const head = child(assets.turretHeadSource(b.type as TurretBlockType), "still-head", headLift(def.turret));
    // Ses munitions visibles, au complet (libérées avec la tête, leur parent)
    made.push(...assets.addRounds(b.type as TurretBlockType, head));
  }
  const blades = bladeKind(b.type, (b.facing ?? DEFAULT_FACING).up);
  if (blades) child(assets.bladeSource(blades), "still-blades", BLOCK_SIZE / 2 + BLADES[blades].offset).rotation.y = REST_ANGLE[blades];
  if (def.thruster?.look === "jet") child(assets.jetNacelleSource(), "still-nacelle", 0);
  if (def.support?.kind === "hover") child(assets.hoverGlowSource(), "still-glow", -GLOW_BELOW);
  // Le verre d'une lumière, allumé (une balise, aux couleurs des bleus ; un feu de position, de son côté)
  if (def.light) lampColors(b.type, b.x, "blue").forEach((hex, i) => child(assets.lightLensSource(b.type, i, hex), "still-lens", 0));
  // Arme de contact : sa barre (de biais, comme arrêtée), son bras (armé), sa lance (rentrée), son
  // plateau (en coin), ses mâchoires (ouvertes), la manivelle d'un fléau et sa boule au bout de sa
  // chaîne (lancée), à son moyeu ; et ce qui brille d'une arme d'énergie, allumé (render/meleeView.ts)
  if (def.melee) stillMelee(assets, def.melee, (source, name) => child(source, name, 0));
  if (def.support?.kind === "leg") {
    const hip = vec3(b.x * BLOCK_SIZE, b.y * BLOCK_SIZE, b.z * BLOCK_SIZE);
    const { knee, foot } = restLeg(hip, legOut(hip, com, vec3(1, 0, 0)), def.support.height);
    const source = assets.legSegmentSource();
    made.push(segment(source, hip, knee), segment(source, knee, foot));
  }
  return made;
}

/** Un segment de patte (source de longueur 1 le long de z) entre `a` et `b`, comme en jeu. */
function segment(source: B.Mesh, a: Vec3, b: Vec3): B.InstancedMesh {
  const mesh = source.createInstance("still-leg");
  const d = sub(b, a);
  const z = scale(d, 1 / Math.max(len(d), 1e-6));
  const x = norm(Math.abs(z.y) < 0.95 ? cross(vec3(0, 1, 0), z) : cross(vec3(1, 0, 0), z));
  const q = quatFromBasis(x, cross(z, x), z);
  const mid = scale(add(a, b), 0.5);
  mesh.position.set(mid.x, mid.y, mid.z);
  mesh.rotationQuaternion = new B.Quaternion(q.x, q.y, q.z, q.w);
  mesh.scaling.set(1, 1, len(d));
  mesh.isPickable = false;
  return mesh;
}

/**
 * Ferrures d'une roue au repos, dans le repère du robot : fourche d'une roulette ou d'une roue posée
 * dessous, potence d'une roulette posée sur un flanc, bras de direction d'une roue directrice posée
 * sur un flanc gauche ou droit.
 */
export function stillWheelParts(assets: Assets, w: WheelMount): B.AbstractMesh[] {
  const def = wheelDef(w.type);
  const p = wheelLocalPos(w);
  const support = vec3(w.x * BLOCK_SIZE, w.y * BLOCK_SIZE, w.z * BLOCK_SIZE);
  const made: B.AbstractMesh[] = [];
  const fitting = (source: B.Mesh, at: Vec3, turn = 0): void => {
    const m = source.createInstance("still-fitting");
    m.position.set(at.x, at.y, at.z);
    m.rotation.y = turn;
    m.isPickable = false;
    made.push(m);
  };
  const { fork, stem } = wheelFittings(def, p, support);
  if (fork !== null) fitting(assets.forkSource(w.type, fork), p);
  if (stem) fitting(assets.steeringArmSource(stem.length), stem.center, stem.alongZ ? Math.PI / 2 : 0);
  if (def.steering && mountFace(p, support) === "side") {
    const dx = support.x - p.x;
    const length = Math.abs(dx) - BLOCK_SIZE / 2;
    fitting(assets.steeringArmSource(length), vec3(p.x + (Math.sign(dx) * length) / 2, p.y, p.z));
  }
  return made;
}
