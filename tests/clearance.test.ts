import { describe, expect, it } from "vitest";
import type { BlockType } from "../src/shared/catalog/blocks";
import type { WheelType } from "../src/shared/catalog/wheels";
import {
  blockZones, designConflicts, designZones, placementConflicts, solidCells, zoneCells, type Piece,
} from "../src/shared/design/clearance";
import { PRESET_BOTS } from "../src/shared/design/presets";
import { validateDesign, type BlockPlacement, type Facing, type RobotDesign, type WheelMount } from "../src/shared/design/robotDesign";
import { conflictLine, conflictText } from "../src/client/i18n/names";

const block = (x: number, y: number, z: number, type: BlockType, facing?: Facing): Piece => ({
  kind: "block", block: facing ? { x, y, z, type, facing } : { x, y, z, type },
});
const wheel = (mount: Omit<WheelMount, "type">, type: WheelType = "standard"): Piece => ({ kind: "wheel", wheel: { ...mount, type } });
const plan = (blocks: BlockPlacement[], wheels: WheelMount[] = []): RobotDesign => ({ blocks, wheels });
/** Raisons des conflits d'une pose (vide : elle passe). */
const reasons = (design: RobotDesign, piece: Piece): string[] => placementConflicts(design, piece).map((c) => conflictText(c.reason));

const PUSH_FORWARD: Facing = { up: "+z", forward: "+y" };
const HANGING: Facing = { up: "-y", forward: "+z" };

describe("encombrement des pièces", () => {
  // Un cockpit, et une mitrailleuse à sa gauche : tête au-dessus d'elle, canon vers l'avant
  const gun = plan([{ x: 0, y: 0, z: 0, type: "cockpit" }, { x: 1, y: 0, z: 0, type: "gunTurret" }]);

  it("un bloc devant le canon d'une tourelle est refusé, à côté il passe", () => {
    expect(reasons(gun, block(1, 1, 1, "armor"))).toEqual(["Gêne le canon (Tourelle mitrailleuse)"]);
    expect(reasons(gun, block(1, 1, 0, "armor"))[0]).toBe("Gêne la tête (Tourelle mitrailleuse)");
    // À côté de la tête ou du canon : il ne réserve que sa pose de repos, pas le cercle qu'il balaie
    expect(reasons(gun, block(0, 1, 0, "armor"))).toEqual([]);
    expect(reasons(gun, block(2, 1, 1, "armor"))).toEqual([]);
    expect(reasons(gun, block(1, 1, -1, "armor"))).toEqual([]);
    expect(reasons(gun, block(1, 1, 2, "armor"))).toEqual([]);
    // Un canon plus long va plus loin
    const sniper = plan([{ x: 0, y: 0, z: 0, type: "cockpit" }, { x: 1, y: 0, z: 0, type: "sniperTurret" }]);
    expect(reasons(sniper, block(1, 1, 2, "armor"))).toEqual(["Gêne le canon (Tourelle sniper)"]);
  });

  it("une tourelle dont le canon traverserait un bloc est refusée ; tournée, elle passe", () => {
    // Un mur devant la case où l'on pose la tourelle, à hauteur de son canon
    const wall = plan([
      { x: 0, y: 0, z: 0, type: "cockpit" }, { x: 1, y: 0, z: 0, type: "frame" }, { x: 1, y: 0, z: 1, type: "frame" },
      { x: 1, y: 1, z: 1, type: "frame" }, { x: 1, y: 2, z: 1, type: "armor" },
    ]);
    expect(reasons(wall, block(1, 1, 0, "gunTurret"))).toEqual(["Le canon entrerait dans un bloc (Blindage)"]);
    // Tournée vers l'arrière, elle passe
    expect(reasons(wall, block(1, 1, 0, "gunTurret", { up: "+y", forward: "-z" }))).toEqual([]);
    // Une tête sous un bloc : refusée aussi
    expect(reasons(wall, block(0, 1, 1, "gunTurret"))).toEqual([]);
    expect(reasons(plan([...wall.blocks, { x: 0, y: 2, z: 1, type: "armor" }]), block(0, 1, 1, "gunTurret"))[0]).toBe("La tête entrerait dans un bloc (Blindage)");
  });

  it("une case occupée est refusée", () => {
    expect(reasons(gun, block(1, 0, 0, "armor"))).toEqual(["Case occupée (Tourelle mitrailleuse)"]);
  });

  it("une roue sous un bloc où pend une tourelle heurte sa tête", () => {
    const hanging = plan([{ x: 0, y: 0, z: 0, type: "cockpit" }, { x: 0, y: -1, z: 0, type: "gunTurret", facing: HANGING }]);
    const under = reasons(hanging, wheel({ x: 0, y: -1, z: 0, dx: 0, dz: 0, dy: -1 }));
    expect(under.length).toBeGreaterThan(0);
    expect(under[0]).toMatch(/^La roue heurterait (la tête|le canon) \(Tourelle mitrailleuse\)$/);
    // Sur le flanc du cockpit, la roue est loin de la tête qui pend
    expect(reasons(hanging, wheel({ x: 0, y: 0, z: 0, dx: 1, dz: 0 }))).toEqual([]);
    // La tourelle elle-même ne peut plus pendre sous une roue posée dessous
    const wheeled = plan([{ x: 0, y: 0, z: 0, type: "cockpit" }, { x: 0, y: -1, z: 0, type: "frame" }], [{ x: 0, y: -1, z: 0, dx: 0, dz: 0, dy: -1, type: "standard" }]);
    expect(reasons(wheeled, block(0, -1, 1, "gunTurret", HANGING))).toEqual([]);
    expect(reasons(wheeled, block(0, -1, 1, "gunTurret", { up: "-y", forward: "-z" }))).toEqual(["Le canon heurterait la roue (Roue fixe)"]);
  });

  it("une roue occupe la case voisine de son bloc ; une directrice balaie plus loin", () => {
    const base = plan([{ x: 0, y: 0, z: 0, type: "cockpit" }]);
    const fixed = plan(base.blocks, [{ x: 0, y: 0, z: 0, dx: 1, dz: 0, type: "standard" }]);
    expect(reasons(fixed, block(1, 1, 0, "armor"))).toEqual(["Gêne la roue (Roue fixe)"]);
    expect(reasons(fixed, block(1, 2, 0, "armor"))).toEqual([]);
    expect(reasons(fixed, block(2, 0, 0, "armor"))).toEqual([]);
    const steered = plan(base.blocks, [{ x: 0, y: 0, z: 0, dx: 1, dz: 0, type: "steered" }]);
    expect(reasons(steered, block(2, 0, 0, "armor"))).toEqual(["Gêne la roue (Roue directrice)"]);
    // Dans l'autre sens : une roue posée contre un bloc
    expect(reasons(plan([...base.blocks, { x: 1, y: 1, z: 0, type: "armor" }]), wheel({ x: 0, y: 0, z: 0, dx: 1, dz: 0 }))).toEqual([
      "La roue entrerait dans un bloc (Blindage)",
    ]);
    // Deux roues qui se chevauchent : la règle de validateDesign
    const two = plan([...base.blocks, { x: 0, y: 0, z: 1, type: "frame" }], [{ x: 0, y: 0, z: 0, dx: 1, dz: 0, type: "standard" }]);
    expect(reasons(two, wheel({ x: 0, y: 0, z: 1, dx: 1, dz: 0 }))).toEqual(["Chevauche une roue (Roue fixe)"]);
  });

  it("une roue passe sous une aile (une plaque n'occupe qu'une dalle de sa case)", () => {
    const wing = plan([
      { x: 0, y: 0, z: 0, type: "cockpit" }, { x: 1, y: 0, z: 0, type: "wing" }, { x: 2, y: 0, z: 0, type: "wing" }, { x: 1, y: -1, z: 0, type: "frame" },
    ]);
    expect(reasons(wing, wheel({ x: 1, y: -1, z: 0, dx: 1, dz: 0 }, "small"))).toEqual([]);
    const armored = plan(wing.blocks.map((b) => (b.x === 2 ? { ...b, type: "armor" as const } : b)));
    expect(reasons(armored, wheel({ x: 1, y: -1, z: 0, dx: 1, dz: 0 }, "small"))).toEqual(["La roue entrerait dans un bloc (Blindage)"]);
  });

  it("la bande d'une chenille, entre ses galets, est réservée", () => {
    const hull = plan(
      [{ x: 0, y: 0, z: 0, type: "cockpit" }, { x: 0, y: 0, z: 1, type: "frame" }, { x: 0, y: 0, z: 2, type: "frame" }],
      [{ x: 0, y: 0, z: 0, dx: 1, dz: 0, type: "track" }, { x: 0, y: 0, z: 2, dx: 1, dz: 0, type: "track" }],
    );
    expect(reasons(hull, block(1, 0, 1, "armor"))).toEqual(["Gêne la chenille (Chenille)"]);
    expect(reasons(hull, block(1, 1, 1, "armor"))).toEqual([]);
  });

  it("soute à bombes : la case du dessous reste libre ; poseur de mines : la case de derrière", () => {
    const bay = plan([{ x: 0, y: 0, z: 0, type: "cockpit" }, { x: 0, y: -1, z: 0, type: "bombBay" }]);
    expect(reasons(bay, block(0, -2, 0, "armor"))).toContain("Gêne le passage des bombes (Soute à bombes)");
    expect(reasons(bay, block(1, -1, 0, "armor"))).toEqual([]);
    const floor = plan([{ x: 0, y: 0, z: 0, type: "cockpit" }, { x: 0, y: -2, z: 0, type: "armor" }, { x: 1, y: -2, z: 0, type: "armor" }, { x: 1, y: -1, z: 0, type: "armor" }]);
    expect(reasons(floor, block(0, -1, 0, "bombBay"))).toContain("Le passage des bombes entrerait dans un bloc (Blindage)");
    const mines = plan([{ x: 0, y: 0, z: 0, type: "cockpit" }, { x: 0, y: 0, z: 1, type: "mineLayer" }]);
    expect(reasons(mines, block(1, 0, 1, "armor"))).toEqual([]);
    expect(reasons(plan([{ x: 0, y: 0, z: 0, type: "cockpit" }]), block(0, 0, 1, "mineLayer"))).toEqual(["La sortie des mines entrerait dans un bloc (Cockpit)"]);
  });

  it("hélice, rotor, rotor de queue, nacelle : ce qui dépasse du bloc", () => {
    const cockpit = { x: 0, y: 0, z: -1, type: "cockpit" as const };
    // Hélice au nez : un disque de près de 2 m, juste devant son bloc
    const prop = plan([cockpit, { x: 0, y: 0, z: 0, type: "propeller", facing: PUSH_FORWARD }]);
    expect(reasons(prop, block(2, 1, 1, "armor"))).toEqual(["Gêne l'hélice (Hélice)"]);
    expect(reasons(prop, block(0, 0, 1, "armor"))).toEqual(["Gêne l'hélice (Hélice)"]);
    expect(reasons(prop, block(2, 2, 1, "armor"))).toEqual([]);
    expect(reasons(prop, block(1, 0, 0, "armor"))).toEqual([]);
    // Rotor orientable : quatre pales de 3,2 m au-dessus de son bloc
    const rotor = plan([cockpit, { x: 0, y: 0, z: 0, type: "rotor" }]);
    expect(reasons(rotor, block(3, 1, 0, "armor"))).toEqual(["Gêne les pales du rotor (Rotor orientable)"]);
    expect(reasons(rotor, block(0, 2, 0, "armor"))).toEqual([]);
    // Un réacteur couché sur le côté : une hélice de queue ; dressé vers le haut, une flamme
    const tail = plan([cockpit, { x: 0, y: 0, z: 0, type: "thruster", facing: { up: "+x", forward: "+z" } }]);
    expect(reasons(tail, block(1, 1, 1, "armor"))).toEqual(["Gêne l'hélice de queue (Réacteur)"]);
    expect(reasons(tail, block(1, 2, 0, "armor"))).toEqual([]);
    expect(reasons(plan([cockpit, { x: 0, y: 0, z: 0, type: "thruster" }]), block(0, 1, 0, "armor"))).toEqual([]);
    // Turboréacteur : sa nacelle dépasse devant et derrière, pas sur les côtés
    const jet = plan([{ x: 0, y: 0, z: 2, type: "cockpit" }, { x: 0, y: 0, z: 0, type: "jet", facing: PUSH_FORWARD }]);
    expect(reasons(jet, block(0, 0, 1, "armor"))).toEqual(["Gêne la nacelle (Turboréacteur)"]);
    expect(reasons(jet, block(0, 0, -1, "armor"))).toEqual(["Gêne la nacelle (Turboréacteur)"]);
    expect(reasons(jet, block(1, 0, 0, "armor"))).toEqual([]);
    // Une hélice et une roue qui se croisent
    const gear = plan([cockpit, { x: 0, y: 0, z: 0, type: "propeller", facing: PUSH_FORWARD }]);
    expect(reasons(gear, wheel({ x: 0, y: 0, z: 0, dx: 0, dz: 0, dy: -1, shift: 1 }, "small"))).toEqual(["La roue heurterait l'hélice (Hélice)"]);
  });

  it("une patte part vers l'extérieur du robot", () => {
    // Un plateau de 5 × 5, le cockpit au milieu, une patte à chaque coin
    const blocks: BlockPlacement[] = [{ x: 0, y: 1, z: 0, type: "cockpit" }];
    for (let x = -2; x <= 2; x++) {
      for (let z = -2; z <= 2; z++) blocks.push({ x, y: 0, z, type: Math.abs(x) === 2 && Math.abs(z) === 2 ? "leg" : "frame" });
    }
    const legged = plan(blocks);
    const leg = designZones(legged).find((z) => z.part === "leg" && z.owners[0] === "b:2,0,2")!;
    // Le genou monte vers l'extérieur (en diagonale), le pied se pose plus loin et plus bas
    const cells = zoneCells(leg).map((k) => k.split(",").map(Number));
    expect(cells.length).toBeGreaterThan(2);
    for (const [x, y, z] of cells) {
      expect(x).toBeGreaterThanOrEqual(2);
      expect(z).toBeGreaterThanOrEqual(2);
      expect(y).toBeLessThanOrEqual(0);
    }
    const [x, y, z] = cells.find(([cx, , cz]) => cx > 2 || cz > 2)!;
    expect(reasons(legged, block(x, y, z, "armor"))).toEqual(["Gêne la patte (Patte)"]);
    expect(reasons(legged, block(1, 1, 1, "armor"))).toEqual([]);
  });

  it("la tête d'une tourelle suit son orientation", () => {
    const side = blockZones({ x: 0, y: 0, z: 0, type: "gunTurret", facing: { up: "+x", forward: "+z" } });
    const head = side.find((z) => z.part === "head")!;
    expect(head.solids.flatMap(solidCells)).toEqual(["1,0,0"]);
  });

  it("validateDesign ignore l'encombrement : un plan d'avant reste jouable", () => {
    const blocked = plan([{ x: 0, y: 0, z: 0, type: "cockpit" }, { x: 1, y: 0, z: 0, type: "gunTurret" }, { x: 1, y: 1, z: 1, type: "armor" }, { x: 1, y: 0, z: 1, type: "frame" }]);
    expect(designConflicts(blocked).length).toBeGreaterThan(0);
    expect(validateDesign(blocked)).toEqual([]);
  });

  it("robots prédéfinis : aucun n'a de pièces qui se gênent", () => {
    for (const p of PRESET_BOTS) {
      expect(designConflicts(p.design).map((c) => conflictLine(p.design, c)), p.id).toEqual([]);
      expect(validateDesign(p.design), p.id).toEqual([]);
    }
  });

  it("le Bolide : la case devant chaque turboréacteur reste libre, l'entrée d'air de sa nacelle y dépasse", () => {
    const design = PRESET_BOTS.find((p) => p.id === "dragster")!.design;
    const jets = design.blocks.filter((b) => b.type === "jet");
    expect(jets.length).toBe(4);
    const taken = new Set(design.blocks.map((b) => `${b.x},${b.y},${b.z}`));
    for (const jet of jets) {
      // Ils poussent vers l'avant (+z) : la case devant est celle de l'entrée d'air
      expect(jet.facing).toEqual(PUSH_FORWARD);
      expect(taken.has(`${jet.x},${jet.y},${jet.z + 1}`), `${jet.x},${jet.y},${jet.z}`).toBe(false);
    }
    // Remis contre le châssis (l'ancien plan), leurs entrées d'air y entraient : la règle mord bien
    const pushed: RobotDesign = { ...design, blocks: design.blocks.map((b) => (b.type === "jet" ? { ...b, z: b.z + 1 } : b)) };
    const clashes = designConflicts(pushed);
    expect(clashes.length).toBe(4);
    for (const c of clashes) expect([c.zone?.part, c.other?.part]).toContain("nacelle");
  });
});
