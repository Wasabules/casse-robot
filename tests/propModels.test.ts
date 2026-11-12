import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as B from "../src/client/babylon";
import { PropBatches } from "../src/client/render/propBatches";
import { PropModels } from "../src/client/render/propModels";
import { CAR_HALF, PROP_TYPES } from "../src/shared/catalog/props";
import { writeGlb, type GlbModel, type GlbPrimitive } from "../tools/models/glb";

/*
 * Un accessoire qui a un modèle glTF (render/propModels.ts), dans une scène Babylon sans carte
 * graphique : sa source est d'abord celle du code, puis elle prend sur place le modèle quand il est
 * lu (ses instances et ses lots d'instances fines suivent) ; le modèle est posé comme l'accessoire
 * (l'origine du fichier au pied, celle de la source au centre du corps ; une dalle étirée à ses
 * dimensions) ; le bois noirci assombrit ses matières ; le verre s'allume la nuit ; un fichier
 * illisible laisse le modèle du code. Les fichiers viennent d'un manifeste et d'un réseau simulés.
 */

vi.mock("../src/client/render/propModelFiles", () => ({
  PROP_MODEL_FILES: {
    pine: { file: "models/props/pine.glb", hash: "essai" },
    lamppost: { file: "models/props/lamppost.glb", hash: "essai" },
    car: { file: "models/props/car.glb", hash: "essai" },
    oak: { file: "models/props/oak.glb", hash: "essai" },
  },
}));

/** Une boîte de `min` à `max`, en sens trigonométrique vu de dehors (glTF), d'une matière. */
function box(min: readonly number[], max: readonly number[], material: number): GlbPrimitive {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const center = [0, 1, 2].map((k) => (min[k] + max[k]) / 2);
  const half = [0, 1, 2].map((k) => (max[k] - min[k]) / 2);
  for (let face = 0; face < 6; face++) {
    const k = face >> 1;
    const sign = face & 1 ? -1 : 1;
    const [u, v] = [(k + 1) % 3, (k + 2) % 3];
    const base = positions.length / 3;
    for (const [du, dv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = [...center];
      p[k] += sign * half[k];
      p[u] += du * sign * half[u];
      p[v] += dv * half[v];
      positions.push(...p);
      const n = [0, 0, 0];
      n[k] = sign;
      normals.push(...n);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, normals, indices, material };
}

/** Un sapin : un tronc et un feuillage, posés sur l'origine, de 9 m (la hauteur de l'accessoire). */
const PINE: GlbModel = {
  generator: "essai",
  meshes: [[box([-0.3, 0, -0.3], [0.3, 4, 0.3], 0), box([-2, 3, -2], [2, 9, 2], 1)]],
  materials: [{ name: "bark", color: [0.4, 0.3, 0.2] }, { name: "leaves", color: [0.2, 0.5, 0.2] }],
};
/** Un lampadaire, et son verre. */
const LAMPPOST: GlbModel = {
  generator: "essai",
  meshes: [[box([-0.1, 0, -0.1], [0.1, 6.4, 0.1], 0), box([0.9, 5.9, -0.15], [1.4, 6, 0.15], 1)]],
  materials: [{ name: "metal", color: [0.25, 0.25, 0.28] }, { name: "Glass", color: [0.85, 0.83, 0.72] }],
};
/** Une voiture d'une autre taille que celle du jeu : elle sera étirée à ses dimensions. */
const CAR: GlbModel = {
  generator: "essai",
  meshes: [[box([-1, 0, -0.5], [1, 1, 0.5], 0)]],
  materials: [{ name: "paint", color: [0.6, 0.1, 0.1] }],
};
const FILES: Record<string, Uint8Array> = {
  "/models/props/pine.glb": writeGlb(PINE),
  "/models/props/lamppost.glb": writeGlb(LAMPPOST),
  "/models/props/car.glb": writeGlb(CAR),
};

/** Le premier chargement du lecteur glTF (un module de plus à transformer, dans Node) prend du temps. */
const WAIT = { timeout: 30_000, interval: 20 };

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

describe("accessoires à modèle glTF (render/propModels.ts)", () => {
  let engine: NullEngine;
  let scene: B.Scene;
  let models: PropModels;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  beforeAll(() => {
    vi.stubGlobal("fetch", async (url: string) => {
      const bytes = FILES[url.replace(/\?.*$/, "")];
      return bytes ? new Response(bytes.slice()) : new Response("", { status: 404, statusText: "Not Found" });
    });
    engine = new NullEngine();
    scene = new B.Scene(engine);
    scene.useRightHandedSystem = true;
    models = new PropModels(scene);
  });
  afterAll(() => {
    scene.dispose();
    engine.dispose();
    vi.unstubAllGlobals();
    warn.mockRestore();
  });

  it("la source faite par le code prend le modèle quand il arrive ; ses instances et ses lots suivent", async () => {
    const pine = models.source("pine", null, false);
    const drawn = pine.getTotalVertices();
    const instance = pine.createInstance("sapin");
    const batches = new PropBatches(scene, { addShadowCaster: () => {} } as unknown as B.ShadowGenerator);
    batches.add(1, pine, B.Matrix.Translation(10, 4.5, 0));
    batches.flush();
    const batchBefore = scene.getMeshByName("props-src-prop-pine") as B.Mesh;
    await vi.waitFor(() => expect(pine.getTotalVertices()).toBe(48), WAIT);
    expect(drawn).not.toBe(48);
    // Posé comme l'accessoire : le pied du fichier (y = 0) au bas du corps, le centre à l'origine
    const shape = PROP_TYPES.pine.shape;
    const { min, max } = bounds(pine);
    expect(min[1]).toBeCloseTo(-shape.halfHeight, 5);
    expect(max[1]).toBeCloseTo(9 - shape.halfHeight, 5);
    expect(pine.subMeshes.map((s) => s.materialIndex)).toEqual([0, 1]);
    expect(pine.material).toBeInstanceOf(B.MultiMaterial);
    expect((pine.material as B.MultiMaterial).subMaterials.map((m) => m?.name)).toEqual(["bark", "leaves"]);
    // L'instance a la boîte englobante du modèle
    expect(instance.getBoundingInfo().boundingBox.extendSize.x).toBeCloseTo(2, 5);
    // Le lot se refait sur la nouvelle géométrie, avec ses deux matières et son instance
    batches.flush();
    const batch = scene.getMeshByName("props-src-prop-pine") as B.Mesh;
    expect(batch).not.toBe(batchBefore);
    expect(batchBefore.isDisposed()).toBe(true);
    expect(batch.getTotalVertices()).toBe(48);
    expect(batch.subMeshes.map((s) => s.materialIndex)).toEqual([0, 1]);
    expect(batch.thinInstanceCount).toBe(1);
    // Une fois lu, le modèle sert d'emblée : le bois noirci a ses matières assombries
    const burnt = models.source("pine", null, false, 2);
    expect(burnt.getTotalVertices()).toBe(48);
    const fresh = (pine.material as B.MultiMaterial).subMaterials[0] as B.StandardMaterial;
    const dark = (burnt.material as B.MultiMaterial).subMaterials[0] as B.StandardMaterial;
    expect(dark).not.toBe(fresh);
    expect(dark.diffuseColor.r).toBeLessThan(fresh.diffuseColor.r * 0.5);
    batches.dispose();
  });

  it("le verre d'une lampe s'allume la nuit, à la couleur de sa lumière", async () => {
    const lamp = models.source("lamppost", null, false);
    await vi.waitFor(() => expect(lamp.getTotalVertices()).toBe(48), WAIT);
    const glass = (lamp.material as B.MultiMaterial).subMaterials[1] as B.StandardMaterial;
    expect(glass.name).toBe("Glass");
    expect(glass.disableLighting).toBe(false);
    models.setNight(true);
    expect(glass.disableLighting).toBe(true);
    expect(glass.emissiveColor.toHexString()).toBe("#FFD59A");
    // Le métal, lui, ne s'allume pas
    const metal = (lamp.material as B.MultiMaterial).subMaterials[0] as B.StandardMaterial;
    expect(metal.disableLighting).toBe(false);
    models.setNight(false);
    expect(glass.disableLighting).toBe(false);
    expect(glass.emissiveColor.toHexString()).toBe("#000000");
  });

  it("une dalle (une voiture) : le modèle est étiré aux dimensions de l'emplacement", async () => {
    const car = models.source("car", CAR_HALF, false);
    await vi.waitFor(() => expect(car.getTotalVertices()).toBe(24), WAIT);
    const { min, max } = bounds(car);
    expect(min).toEqual([-CAR_HALF.x, -CAR_HALF.y, -CAR_HALF.z].map((v) => expect.closeTo(v, 5)));
    expect(max).toEqual([CAR_HALF.x, CAR_HALF.y, CAR_HALF.z].map((v) => expect.closeTo(v, 5)));
    // Un seul matériau : pas de matière multiple
    expect(car.material).toBeInstanceOf(B.StandardMaterial);
  });

  it("un fichier introuvable laisse le modèle du code, avec un avertissement", async () => {
    const oak = models.source("oak", null, false);
    const drawn = oak.getTotalVertices();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("« oak »"), expect.anything()), WAIT);
    expect(oak.getTotalVertices()).toBe(drawn);
    expect(models.source("oak", null, false, 1).getTotalVertices()).toBe(drawn);
  });
});
