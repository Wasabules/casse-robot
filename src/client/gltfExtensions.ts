/*
 * Les extensions de glTF que lit le jeu : celles qu'un modèle d'accessoire peut exiger. Le lecteur
 * les charge à la demande (client/babylonGltf.ts : TypeScript y réclame chacune), et `npm run models`
 * refuse un fichier qui en exige une autre (tools/models/glb.ts). Pas la compression Draco ni
 * meshopt, ni les textures KTX2 : leurs décodeurs viendraient du CDN de Babylon (docs/models.md).
 */
export const GLTF_EXTENSIONS = [
  "KHR_mesh_quantization",
  "KHR_texture_transform",
  "KHR_materials_unlit",
  "KHR_materials_emissive_strength",
  "KHR_materials_pbrSpecularGlossiness",
  "EXT_texture_webp",
  "EXT_texture_avif",
  "EXT_mesh_gpu_instancing",
] as const;

export type GltfExtension = (typeof GLTF_EXTENSIONS)[number];
