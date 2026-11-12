import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as B from "../src/client/babylon";
import { readPropModel, type PropModelData } from "../src/client/render/propGltf";
import { crateModel } from "../tools/models/crate";
import { readGlb, writeGlb, type GlbModel, type GlbPrimitive } from "../tools/models/glb";
import { MANIFEST_FILE, manifestText, scanModels } from "../tools/models/manifest";

/*
 * Les modèles glTF des accessoires (public/models/props/<type>.glb, docs/models.md) : le manifeste
 * livré est celui que fait `npm run models` d'après le dossier, chaque modèle livré se lit, l'outil
 * refuse ce que le jeu ne saurait pas lire ; et la lecture du jeu (render/propGltf.ts, dans une
 * scène Babylon sans carte graphique) garde la géométrie, les nœuds, les matières et le sens des
 * faces que le jeu attend.
 */

const ROOT = resolve(__dirname, "..");

describe("modèles glTF des accessoires : fichiers et manifeste", () => {
  it("le manifeste est celui que fait `npm run models` d'après public/models/, et chaque modèle se lit", () => {
    const scan = scanModels(ROOT);
    expect(scan.problems).toEqual([]);
    const file = readFileSync(join(ROOT, MANIFEST_FILE), "utf8").replace(/\r\n/g, "\n");
    expect(file === manifestText(scan.entries), `${MANIFEST_FILE} n'est plus à jour : lancer \`npm run models\``).toBe(true);
  });

  it("le modèle d'exemple (la caisse) : un .glb lisible, d'un mètre de côté, posé sur son origine", () => {
    const report = readGlb(writeGlb(crateModel()));
    expect(report.problems).toEqual([]);
    expect(report.json?.materials?.map((m) => m.name)).toEqual(["wood", "steel"]);
    const { min, max } = report.bounds!;
    for (const k of [0, 2]) {
      expect(min[k]).toBeCloseTo(-0.508, 3);
      expect(max[k]).toBeCloseTo(0.508, 3);
    }
    expect(min[1]).toBeCloseTo(-0.008, 3);
    expect(max[1]).toBeCloseTo(1.008, 3);
    // Le même modèle donne les mêmes octets
    expect(writeGlb(crateModel())).toEqual(writeGlb(crateModel()));
  });

  it("une extension exigée : celles que lit le jeu passent, les autres (Draco…) sont refusées", () => {
    const model = (extensionsRequired: string[]): GlbModel => ({ ...crateModel(), extensionsRequired });
    expect(readGlb(writeGlb(model(["KHR_texture_transform", "EXT_mesh_gpu_instancing"]))).problems).toEqual([]);
    expect(readGlb(writeGlb(model(["KHR_draco_mesh_compression"]))).problems.join()).toMatch(/KHR_draco_mesh_compression/);
  });

  it("l'outil refuse ce que le jeu ne lit pas : un autre dossier, un .gltf, un type inconnu, un fichier abîmé", () => {
    const root = mkdtempSync(join(tmpdir(), "casse-models-"));
    try {
      const props = join(root, "public", "models", "props");
      mkdirSync(props, { recursive: true });
      mkdirSync(join(root, "public", "models", "blocks"));
      const glb = writeGlb(crateModel());
      writeFileSync(join(props, "crate.glb"), glb);
      writeFileSync(join(props, "barrel.gltf"), "{}");
      writeFileSync(join(props, "crates.glb"), glb);
      writeFileSync(join(props, "pine.glb"), glb.subarray(0, 100));
      writeFileSync(join(props, "CREDITS.md"), "Caisse : CC0");
      const scan = scanModels(root);
      expect(scan.entries.map((e) => e.type)).toEqual(["crate"]);
      expect(scan.problems).toHaveLength(4);
      expect(scan.problems.join("\n")).toMatch(/blocks/);
      expect(scan.problems.join("\n")).toMatch(/barrel\.gltf/);
      expect(scan.problems.join("\n")).toMatch(/crates/);
      expect(scan.problems.join("\n")).toMatch(/pine\.glb/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** Une boîte (24 sommets, normales, en sens trigonométrique vu de dehors), et sans ses normales si `bare`. */
function cube(half: number, material: number, bare = false): GlbPrimitive {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let face = 0; face < 6; face++) {
    const k = face >> 1;
    const sign = face & 1 ? -1 : 1;
    const [u, v] = [(k + 1) % 3, (k + 2) % 3];
    const base = positions.length / 3;
    for (const [du, dv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = [0, 0, 0];
      p[k] = sign * half;
      p[u] = du * sign * half;
      p[v] = dv * half;
      positions.push(...p);
      const n = [0, 0, 0];
      n[k] = sign;
      normals.push(...n);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, ...(bare ? {} : { normals }), indices, material };
}

/** Le signe du produit (p1 − p0) × (p2 − p0) · n de chaque triangle : le sens des faces par rapport à leur normale. */
function windings(positions: ArrayLike<number>, normals: ArrayLike<number>, indices: ArrayLike<number>): Set<number> {
  const signs = new Set<number>();
  const at = (i: number, a: ArrayLike<number>): number[] => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
  for (let t = 0; t < indices.length; t += 3) {
    const [p0, p1, p2] = [0, 1, 2].map((k) => at(indices[t + k], positions));
    const n = at(indices[t], normals);
    const e1 = [0, 1, 2].map((k) => p1[k] - p0[k]);
    const e2 = [0, 1, 2].map((k) => p2[k] - p0[k]);
    const c = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    signs.add(Math.sign(c[0] * n[0] + c[1] * n[1] + c[2] * n[2]));
  }
  return signs;
}

describe("modèles glTF des accessoires : lecture par le jeu (render/propGltf.ts)", () => {
  let engine: NullEngine;
  let scene: B.Scene;
  const read = (model: GlbModel): Promise<PropModelData> => {
    const bytes = writeGlb(model);
    return readPropModel(scene, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, "essai.glb");
  };

  beforeAll(() => {
    engine = new NullEngine();
    scene = new B.Scene(engine);
    // (le repère du jeu : render/scene.ts)
    scene.useRightHandedSystem = true;
  });
  afterAll(() => {
    scene.dispose();
    engine.dispose();
  });

  it("la caisse : sa géométrie fusionnée, une part par matière, ses couleurs, ses matières du jeu", async () => {
    const model = await read(crateModel());
    expect(model.materials.map((m) => m.name)).toEqual(["wood", "steel"]);
    expect(model.materials.every((m) => m instanceof B.StandardMaterial)).toBe(true);
    // Les couleurs reviennent comme on les a écrites (sRGB) : l'acier #5b6066
    expect(model.materials[1].diffuseColor.toHexString()).toBe("#5B6066");
    expect(model.parts.map((p) => p.material)).toEqual([0, 1]);
    expect(model.parts.reduce((n, p) => n + p.indexCount, 0)).toBe(model.indices.length);
    expect(model.colors).not.toBeNull();
    // Les planches gardent leur teinte (des couleurs de sommets, en gamma), l'acier n'en a pas (blanc)
    const last = model.colors!.length - 4;
    expect([...model.colors!.subarray(last)]).toEqual([1, 1, 1, 1]);
    let ys = [Infinity, -Infinity];
    for (let i = 1; i < model.positions.length; i += 3) ys = [Math.min(ys[0], model.positions[i]), Math.max(ys[1], model.positions[i])];
    expect(ys[0]).toBeCloseTo(-0.008, 4);
    expect(ys[1]).toBeCloseTo(1.008, 4);
  });

  it("les faces tournent dans le même sens que celles des meshes du jeu, nœuds en miroir compris ; une pièce sans normales en reçoit", async () => {
    // Le sens des faces d'un mesh fait par le jeu dans une scène en repère direct
    const box = B.MeshBuilder.CreateBox("box", { size: 1 }, scene);
    const game = windings(box.getVerticesData(B.VertexBuffer.PositionKind)!, box.getVerticesData(B.VertexBuffer.NormalKind)!, box.getIndices()!);
    box.dispose();
    expect(game.size).toBe(1);
    const model = await read({
      generator: "essai",
      meshes: [[cube(0.5, 0)], [cube(0.25, 1)], [cube(0.2, 0, true)]],
      materials: [{ name: "Body", color: [0.8, 0.2, 0.1] }, { name: "glass.001", color: [1, 0.9, 0.6], emissive: [0.1, 0.1, 0.1] }],
      nodes: [
        { mesh: 0, translation: [0, 0.5, 0] },
        // En miroir (un déterminant négatif) et tourné d'un quart de tour autour de y
        { mesh: 1, translation: [2, 1, 0], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2], scale: [-1, 1, 1] },
        { mesh: 2, translation: [0, 0, -3] },
      ],
    });
    expect(windings(model.positions, model.normals, model.indices)).toEqual(game);
    expect(model.materials.map((m) => m.name)).toEqual(["Body", "glass.001"]);
    // Les nœuds sont appliqués : la boîte en miroir autour de (2, 1, 0), la troisième autour de (0, 0, -3)
    const xs: number[] = [];
    const zs: number[] = [];
    for (let i = 0; i < model.positions.length; i += 3) {
      xs.push(model.positions[i]);
      zs.push(model.positions[i + 2]);
    }
    expect(Math.max(...xs)).toBeCloseTo(2.25, 4);
    expect(Math.min(...zs)).toBeCloseTo(-3.2, 4);
    // Deux matières, mais trois pièces : les deux pièces du corps sont dans la même part
    expect(model.parts).toHaveLength(2);
    expect(model.parts[0].indexCount).toBe(72);
  });

  it("le lecteur du jeu connaît les extensions que l'outil accepte, et refuse les autres", async () => {
    const box = (extensionsRequired: string[]): GlbModel => ({ generator: "essai", meshes: [[cube(0.5, 0)]], materials: [{ name: "m", color: [1, 1, 1] }], extensionsRequired });
    const model = await read(box(["KHR_materials_unlit", "KHR_mesh_quantization", "KHR_texture_transform"]));
    expect(model.positions.length).toBe(72);
    await expect(read(box(["KHR_draco_mesh_compression"]))).rejects.toThrow();
  });
});
