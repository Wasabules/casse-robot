/*
 * Le lecteur glTF de Babylon (`@babylonjs/loaders`), à part de client/babylon.ts : seul
 * render/gltfModel.ts l'importe, et lui-même ne se charge qu'à la demande (`import()` dans
 * render/gltfModels.ts, quand un accessoire, un bloc, une tête de tourelle ou une roue a un modèle
 * glTF à lire). Rien de tout cela n'entre donc
 * dans le paquet principal (tests/architecture.test.ts le vérifie). Seules les extensions que lit le
 * jeu (client/gltfExtensions.ts) sont enregistrées, sans être chargées : chacune ne l'est que si un
 * fichier s'en sert.
 */
import "@babylonjs/loaders/glTF/2.0/glTFLoader";
import { registerGLTFExtension, type GLTFExtensionFactory } from "@babylonjs/loaders/glTF/2.0/glTFLoaderExtensionRegistry";
import type { GltfExtension } from "./gltfExtensions";

const EXTENSIONS: Record<GltfExtension, GLTFExtensionFactory> = {
  KHR_mesh_quantization: async (loader) => new (await import("@babylonjs/loaders/glTF/2.0/Extensions/KHR_mesh_quantization.pure")).KHR_mesh_quantization(loader),
  KHR_texture_transform: async (loader) => new (await import("@babylonjs/loaders/glTF/2.0/Extensions/KHR_texture_transform.pure")).KHR_texture_transform(loader),
  KHR_materials_unlit: async (loader) => new (await import("@babylonjs/loaders/glTF/2.0/Extensions/KHR_materials_unlit.pure")).KHR_materials_unlit(loader),
  KHR_materials_emissive_strength: async (loader) =>
    new (await import("@babylonjs/loaders/glTF/2.0/Extensions/KHR_materials_emissive_strength.pure")).KHR_materials_emissive_strength(loader),
  KHR_materials_pbrSpecularGlossiness: async (loader) =>
    new (await import("@babylonjs/loaders/glTF/2.0/Extensions/KHR_materials_pbrSpecularGlossiness.pure")).KHR_materials_pbrSpecularGlossiness(loader),
  EXT_texture_webp: async (loader) => new (await import("@babylonjs/loaders/glTF/2.0/Extensions/EXT_texture_webp.pure")).EXT_texture_webp(loader),
  EXT_texture_avif: async (loader) => new (await import("@babylonjs/loaders/glTF/2.0/Extensions/EXT_texture_avif.pure")).EXT_texture_avif(loader),
  // (les instances fines sont déjà enregistrées par client/babylon.ts)
  EXT_mesh_gpu_instancing: async (loader) => new (await import("@babylonjs/loaders/glTF/2.0/Extensions/EXT_mesh_gpu_instancing.pure")).EXT_mesh_gpu_instancing(loader),
};

for (const [name, factory] of Object.entries(EXTENSIONS)) registerGLTFExtension(name, true, factory);

export { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
export type { AssetContainer } from "@babylonjs/core/assetContainer";
