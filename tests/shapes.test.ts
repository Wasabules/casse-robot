import RAPIER from "@dimforge/rapier3d-compat";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { blockDef, BLOCK_TYPES, blockShape, type BlockType } from "../src/shared/catalog/blocks";
import { SHAPE_IDS, shapeFraction, shapePieces } from "../src/shared/catalog/shapes";
import { profileFromDesign } from "../src/shared/design/custom";
import { designMass } from "../src/shared/design/flight";
import { AXES, buriedTurrets, DesignGrid, mirrorFacing, validateDesign, type Axis, type Facing } from "../src/shared/design/robotDesign";
import { cross, dot, qrot, quatFromBasis, sub, vec3, type Vec3 } from "../src/shared/math/vec";
import { aimTurret, lineOfFireBlocked, turretFrame } from "../src/shared/combat/turrets";
import { groundHeight, spawnBot } from "../src/shared/robot/lifecycle";
import { hitTargetOf } from "../src/shared/robot/colliders";
import type { Bot } from "../src/shared/sim/entities";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";

const AXIS_NAMES = Object.keys(AXES) as Axis[];
/** Les 24 orientations d'un bloc. */
const FACINGS: Facing[] = AXIS_NAMES.flatMap((up) => AXIS_NAMES.filter((f) => dot(AXES[up], AXES[f]) === 0).map((forward) => ({ up, forward })));
const rotation = (f: Facing) => quatFromBasis(cross(AXES[f.up], AXES[f.forward]), AXES[f.up], AXES[f.forward]);
const key = (v: Vec3): string => [v.x, v.y, v.z].map((c) => c.toFixed(4).replace("-0.0000", "0.0000")).join(",");

describe("formes des blocs", () => {
  it("chaque forme est un polyèdre fermé, de la part du cube attendue", () => {
    const expected = { wedge: 1 / 2, corner: 1 / 3, innerCorner: 2 / 3, round: Math.PI / 4, roundCorner: 2 / 3, slopeLow: 1 / 4, slopeHigh: 3 / 4, slab: 1 / 2 };
    for (const shape of SHAPE_IDS) {
      // Les arrondis sont des facettes autour du cylindre : un peu plus que le cylindre
      expect(shapeFraction(shape)).toBeGreaterThanOrEqual(expected[shape] - 1e-9);
      expect(shapeFraction(shape)).toBeLessThan(expected[shape] * 1.02);
      for (const piece of shapePieces(shape)) {
        // Fermé : chaque arête est parcourue une fois dans chaque sens
        const edges = new Map<string, number>();
        for (const face of piece.faces) {
          face.points.forEach((p, i) => {
            const q = face.points[(i + 1) % face.points.length];
            edges.set(`${key(p)}>${key(q)}`, (edges.get(`${key(p)}>${key(q)}`) ?? 0) + 1);
          });
        }
        for (const [edge, n] of edges) {
          const [p, q] = edge.split(">");
          expect(n).toBe(1);
          expect(edges.get(`${q}>${p}`)).toBe(1);
        }
        // Convexe : tous les sommets sont du côté intérieur de chaque face
        for (const face of piece.faces) {
          for (const v of piece.points) expect(dot(face.normal, sub(v, face.points[0]))).toBeLessThan(1e-6);
        }
      }
    }
  });

  it("un bloc de forme pèse et encaisse sa part d'un bloc de sa matière", () => {
    expect(blockDef("wedge").mass).toBeCloseTo(BLOCK_TYPES.armor.mass / 2, 6);
    expect(blockDef("wedge").hp).toBe(50);
    expect(blockDef("slabLight").hp).toBe(20);
    expect(blockDef("wedgeHeavy").resist).toEqual(BLOCK_TYPES.armorHeavy.resist);
    for (const type of Object.keys(BLOCK_TYPES) as BlockType[]) {
      const shape = blockShape(type);
      if (shape) expect(blockDef(type).cost).toBeGreaterThanOrEqual(1);
    }
  });

  it("le symétrique d'une forme, dans chacune de ses 24 orientations, est son image dans le miroir", () => {
    for (const shape of SHAPE_IDS) {
      const type = (Object.keys(BLOCK_TYPES) as BlockType[]).find((t) => blockShape(t) === shape)!;
      const points = shapePieces(shape).flatMap((p) => p.points);
      for (const f of FACINGS) {
        // Image dans le miroir x → -x des sommets du bloc orienté ainsi…
        const mirrored = new Set(points.map((p) => qrot(rotation(f), p)).map((p) => key(vec3(-p.x, p.y, p.z))));
        // …et sommets du bloc symétrique posé par le garage
        const twin = new Set(points.map((p) => key(qrot(rotation(mirrorFacing(type, f)), p))));
        expect([...twin].sort()).toEqual([...mirrored].sort());
      }
    }
  });
});

describe("blocs de forme en jeu", () => {
  let sim: Simulation;
  beforeAll(async () => {
    await initPhysics();
  });
  beforeEach(() => {
    sim = new Simulation();
  });
  afterEach(() => sim.dispose());

  const spawn = (g: DesignGrid): Bot => {
    const design = { blocks: g.blocks(), wheels: [] };
    expect(validateDesign(design)).toEqual([]);
    const bot = spawnBot(sim, profileFromDesign("Formes", "#888888", design), vec3(0, groundHeight(design) + 0.02, 0), 0, "blue");
    sim.bots.push(bot);
    return bot;
  };

  it("un robot garde la masse de son plan, et un rayon sur une pente trouve son biseau", () => {
    const g = new DesignGrid().box(-1, 1, 0, 0, -1, 1, "frame").put(0, 1, 0, "cockpit");
    g.box(-1, 1, 0, 0, 2, 2, "wedge").box(-1, 1, 1, 1, 1, 1, "roundLight").put(0, 1, -1, "innerCorner");
    const bot = spawn(g);
    const design = bot.profile.design;
    expect(bot.cockpit.part.rb.mass()).toBeCloseTo(designMass(design), 3);
    // Un rayon qui descend sur la pente du nez (le biseau en z = 2, à 1 m devant l'origine du robot)
    sim.step();
    const p = bot.cockpit.part.rb.translation();
    const down = vec3(0, -1, 0);
    const hit = sim.raycast(vec3(p.x, p.y + 3, p.z + 1), down, 10);
    expect(hit).not.toBeNull();
    // Sur la pente, à mi-hauteur du bloc (un cube serait touché sur son dessus, un quart de mètre plus haut)
    expect(hit!.point.y).toBeLessThan(p.y + 0.05);
    const target = hitTargetOf(hit!.owner, hit!.point, down);
    expect(target?.kind === "block" && target.block.type).toBe("wedge");
  });

  it("une caisse posée sur une pente glisse vers le bas de la pente", () => {
    // Un plateau lourd, et au bord avant une rangée de biseaux, pente vers l'avant (+z)
    const g = new DesignGrid().box(-2, 2, 0, 0, -2, 1, "armorHeavy").box(-2, 2, 1, 1, -2, 0, "armorHeavy");
    g.box(-2, 2, 1, 1, 1, 1, "wedgeHeavy").put(0, 1, -1, "cockpit");
    const bot = spawn(g);
    for (let i = 0; i < 30; i++) sim.step();
    // La caisse tombe sur la pente du biseau (case z = 1, 0,5 m devant l'origine du robot)
    const o = bot.cockpit.part.rb.translation();
    const box = sim.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(o.x + 1, o.y + 1, o.z + 0.45));
    sim.world.createCollider(RAPIER.ColliderDesc.cuboid(0.15, 0.15, 0.15).setDensity(200).setFriction(0.3), box);
    const z0 = box.translation().z;
    for (let i = 0; i < 60; i++) sim.step();
    expect(box.translation().z - z0).toBeGreaterThan(0.3); // elle a descendu la pente, vers l'avant
  });

  it("une tourelle posée sur un flanc vise et tire de côté ; posée dessous, vers le bas", () => {
    const g = new DesignGrid().box(-1, 1, 0, 0, -1, 1, "frame").put(0, 1, 0, "cockpit");
    g.put(2, 0, 0, "gunTurret", { up: "+x", forward: "+z" }); // flanc gauche
    g.put(0, -1, 0, "laserTurret", { up: "-y", forward: "+z" }); // dessous
    const bot = spawn(g);
    const [side, below] = [bot.turrets.find((t) => t.weapon === "rifle")!, bot.turrets.find((t) => t.weapon === "laser")!];
    // À gauche et un peu vers l'avant : la tourelle du flanc y arrive, sans que son robot la masque
    const left = norm3(1, 0.2, 0.6);
    for (let i = 0; i < 120; i++) aimTurret(side, left);
    expect(dot(turretFrame(side).dir, left)).toBeGreaterThan(0.99);
    expect(lineOfFireBlocked(side)).toBe(false);
    // Vers la droite, à travers son robot : hors de son débattement (elle ne sort que de son flanc)
    expect(aimTurret(side, norm3(-1, 0, 0))).toBeGreaterThan(0.3);
    // Dessous : vers le sol devant le robot
    const down = norm3(0, -1, 0.8);
    for (let i = 0; i < 120; i++) aimTurret(below, down);
    expect(dot(turretFrame(below).dir, down)).toBeGreaterThan(0.99);
    expect(lineOfFireBlocked(below)).toBe(false);
  });

  it("une tourelle de flanc recouverte sur son flanc est enfouie", () => {
    const g = new DesignGrid().box(-1, 1, 0, 0, -1, 1, "frame").put(0, 1, 0, "cockpit").put(2, 0, 0, "gunTurret", { up: "+x", forward: "+z" });
    expect(buriedTurrets({ blocks: g.blocks(), wheels: [] })).toHaveLength(0);
    g.put(3, 0, 0, "armor");
    expect(buriedTurrets({ blocks: g.blocks(), wheels: [] })).toHaveLength(1);
  });
});

function norm3(x: number, y: number, z: number): Vec3 {
  const l = Math.hypot(x, y, z);
  return vec3(x / l, y / l, z / l);
}
