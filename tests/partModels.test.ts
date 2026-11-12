import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as B from "../src/client/babylon";
import { hasBlockModel, PartModels } from "../src/client/render/partModels";
import { blockDef } from "../src/shared/catalog/blocks";
import { writeGlb } from "../tools/models/glb";
import { armorModel, cannonHeadModel, wheelModel } from "../tools/models/parts";

/*
 * Les blocs, têtes de tourelle et roues qui ont un modèle glTF (render/partModels.ts), dans une
 * scène Babylon sans carte graphique : leur source est d'abord celle du code, puis elle prend sur
 * place le modèle quand il est lu (ses instances suivent, `generation` compte le changement pour
 * les lots de WorldView) ; la matière `paint` d'un bloc teinté prend la couleur du robot (une source
 * par couleur), celle d'un bloc qui ne l'est pas, non ; un modèle déjà lu sert d'emblée ; un fichier
 * introuvable laisse le modèle du code. Les fichiers viennent d'un manifeste et d'un réseau simulés.
 */

vi.mock("../src/client/render/modelFiles", () => ({
  PROP_MODEL_FILES: {},
  BLOCK_MODEL_FILES: {
    armor: { file: "models/blocks/armor.glb", hash: "essai" },
    cockpit: { file: "models/blocks/cockpit.glb", hash: "essai" },
    battery: { file: "models/blocks/battery.glb", hash: "essai" },
  },
  HEAD_MODEL_FILES: { cannonTurret: { file: "models/heads/cannonTurret.glb", hash: "essai" } },
  WHEEL_MODEL_FILES: { standard: { file: "models/wheels/standard.glb", hash: "essai" } },
}));

const FILES: Record<string, Uint8Array> = {
  "/models/blocks/armor.glb": writeGlb(armorModel()),
  // Un bloc qui ne prend pas la couleur du robot, avec une matière `paint` quand même
  "/models/blocks/cockpit.glb": writeGlb(armorModel()),
  "/models/heads/cannonTurret.glb": writeGlb(cannonHeadModel()),
  "/models/wheels/standard.glb": writeGlb(wheelModel()),
};

/** Le premier chargement du lecteur glTF (un module de plus à transformer, dans Node) prend du temps. */
const WAIT = { timeout: 30_000, interval: 20 };

/** Ce que ferait le code : un cube d'une matière, à instancier. */
function drawn(scene: B.Scene, name: string): B.Mesh {
  const mesh = B.MeshBuilder.CreateBox(name, { size: 0.49 }, scene);
  mesh.material = new B.StandardMaterial(`${name}-mat`, scene);
  mesh.isVisible = false;
  return mesh;
}

function bounds(mesh: B.Mesh): { min: number[]; max: number[] } {
  const p = mesh.getVerticesData(B.VertexBuffer.PositionKind)!;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) {
    min[i % 3] = Math.min(min[i % 3], p[i]);
    max[i % 3] = Math.max(max[i % 3], p[i]);
  }
  return { min, max };
}

describe("blocs, têtes et roues à modèle glTF (render/partModels.ts)", () => {
  let engine: NullEngine;
  let scene: B.Scene;
  let parts: PartModels;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  beforeAll(() => {
    vi.stubGlobal("fetch", async (url: string) => {
      const bytes = FILES[url.replace(/\?.*$/, "")];
      return bytes ? new Response(bytes.slice()) : new Response("", { status: 404, statusText: "Not Found" });
    });
    engine = new NullEngine();
    scene = new B.Scene(engine);
    scene.useRightHandedSystem = true;
    parts = new PartModels(scene);
  });
  afterAll(() => {
    scene.dispose();
    engine.dispose();
    vi.unstubAllGlobals();
    warn.mockRestore();
  });

  it("le manifeste dit, sans rien demander au réseau, quels blocs ont un modèle", () => {
    expect(hasBlockModel("armor")).toBe(true);
    expect(hasBlockModel("armorHeavy")).toBe(false);
  });

  it("un bloc teinté : la source du code prend le modèle à son arrivée ; `paint` prend la couleur du robot", async () => {
    const red = parts.block("armor", "#cc3333", "src-armor-red", () => drawn(scene, "src-armor-red"));
    const instance = red.createInstance("bloc");
    expect(red.getTotalVertices()).toBe(24);
    expect(parts.pending).toBeGreaterThan(0);
    const before = parts.generation;
    await vi.waitFor(() => expect(red.getTotalVertices()).toBeGreaterThan(24), WAIT);
    expect(parts.generation).toBe(before + 1);
    expect(red.subMeshes.map((s) => s.materialIndex)).toEqual([0, 1]);
    const [paint, steel] = (red.material as B.MultiMaterial).subMaterials as B.StandardMaterial[];
    expect([paint.name, steel.name]).toEqual(["paint", "steel"]);
    // Comme les modèles du code : les matières blanches, leur couleur dans celles des sommets ; la
    // lumière ambiante de la scène, comme les blocs du code
    for (const m of [paint, steel]) {
      expect(m.diffuseColor.toHexString()).toBe("#FFFFFF");
      expect(m.ambientColor.toHexString()).toBe("#FFFFFF");
    }
    // `paint` prend la couleur du robot (une plaque : blanche dans le fichier), l'acier la sienne (#5b6066)
    const colorOf = (mesh: B.Mesh, part: number): string => {
      const v = mesh.getIndices()![mesh.subMeshes[part].indexStart];
      const c = mesh.getVerticesData(B.VertexBuffer.ColorKind)!;
      return new B.Color3(c[v * 4], c[v * 4 + 1], c[v * 4 + 2]).toHexString();
    };
    const colors = red.getVerticesData(B.VertexBuffer.ColorKind)!;
    const plates = new Set<string>();
    const sub = red.subMeshes[0];
    for (let i = sub.indexStart; i < sub.indexStart + sub.indexCount; i++) {
      const v = red.getIndices()![i];
      plates.add(new B.Color3(colors[v * 4], colors[v * 4 + 1], colors[v * 4 + 2]).toHexString());
    }
    expect(plates.has("#CC3333")).toBe(true);
    expect(colorOf(red, 1)).not.toBe("#FFFFFF");
    // Dans sa case, centrée sur l'origine ; l'instance a la boîte englobante du modèle
    const { min, max } = bounds(red);
    for (let k = 0; k < 3; k++) {
      expect(min[k]).toBeCloseTo(-0.25, 3);
      expect(max[k]).toBeCloseTo(0.25, 3);
    }
    expect(instance.getBoundingInfo().boundingBox.extendSize.x).toBeCloseTo(0.25, 3);
    // Un modèle déjà lu sert d'emblée, sans passer par le code ; une autre couleur, une autre peinture, les mêmes matières
    const make = vi.fn(() => drawn(scene, "src-armor-blue"));
    const blue = parts.block("armor", "#3366cc", "src-armor-blue", make);
    expect(make).not.toHaveBeenCalled();
    expect(blue.getTotalVertices()).toBe(red.getTotalVertices());
    expect(blue.material).toBe(red.material);
    const blueColors = blue.getVerticesData(B.VertexBuffer.ColorKind)!;
    const v = blue.getIndices()![sub.indexStart];
    const ratio = (k: number): number => blueColors[v * 4 + k] / colors[v * 4 + k];
    // Le même sommet de plaque : bleu au lieu de rouge, dans le rapport des deux couleurs
    expect(ratio(2)).toBeCloseTo(0xcc / 0x33, 3);
    expect(colorOf(blue, 1)).toBe(colorOf(red, 1));
  });

  it("un bloc qui ne prend pas la couleur du robot garde sa matière `paint` telle quelle, une pour toutes les couleurs", async () => {
    expect(blockDef("cockpit").tinted).toBe(false);
    const one = parts.block("cockpit", "#cc3333", "src-cockpit", () => drawn(scene, "src-cockpit"));
    await vi.waitFor(() => expect(one.getTotalVertices()).toBeGreaterThan(24), WAIT);
    const other = parts.block("cockpit", "#3366cc", "src-cockpit-2", () => drawn(scene, "src-cockpit-2"));
    expect(other.material).toBe(one.material);
    // Les couleurs des sommets sont celles du fichier : une plaque reste blanche
    const colors = one.getVerticesData(B.VertexBuffer.ColorKind)!;
    const shades = new Set<string>();
    const sub = one.subMeshes[0];
    for (let i = sub.indexStart; i < sub.indexStart + sub.indexCount; i++) {
      const v = one.getIndices()![i];
      shades.add(new B.Color3(colors[v * 4], colors[v * 4 + 1], colors[v * 4 + 2]).toHexString());
    }
    expect(shades.has("#FFFFFF")).toBe(true);
    expect([...shades].some((s) => s === "#CC3333" || s === "#3366CC")).toBe(false);
  });

  it("une tête de tourelle et une roue prennent leur modèle ; la tête garde son repère (le canon jusqu'à sa bouche)", async () => {
    const head = parts.head("cannonTurret", "src-head-cannonTurret", () => drawn(scene, "src-head-cannonTurret"));
    const wheel = parts.wheel("standard", "src-wheel-standard", () => drawn(scene, "src-wheel-standard"));
    const headInstance = head.createInstance("tête");
    await vi.waitFor(() => {
      expect(head.getTotalVertices()).toBeGreaterThan(24);
      expect(wheel.getTotalVertices()).toBeGreaterThan(24);
    }, WAIT);
    expect(bounds(head).max[2]).toBeCloseTo(blockDef("cannonTurret").turret!.barrel, 3);
    expect(headInstance.getBoundingInfo().boundingBox.maximum.z).toBeCloseTo(blockDef("cannonTurret").turret!.barrel, 3);
    const w = bounds(wheel);
    expect(w.min[0] + w.max[0]).toBeCloseTo(0, 4);
    expect(w.max[1]).toBeCloseTo(0.55, 2);
    expect((wheel.material as B.MultiMaterial).subMaterials.map((m) => m?.name)).toEqual(["rubber", "rim"]);
  });

  it("un fichier introuvable laisse le modèle du code, avec un avertissement", async () => {
    const battery = parts.block("battery", "#cc3333", "src-battery", () => drawn(scene, "src-battery"));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("« battery »"), expect.anything()), WAIT);
    expect(battery.getTotalVertices()).toBe(24);
    expect(parts.pending).toBe(0);
  });
});
