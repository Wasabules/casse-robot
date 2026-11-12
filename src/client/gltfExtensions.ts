/*
 * Les extensions de glTF que lit le jeu : celles qu'un modèle (accessoire, bloc, tête, roue, et
 * l'accessoire d'un paquet de carte) peut exiger. La liste est dans le code partagé
 * (shared/media/glb.ts) : le serveur et l'outil des cartes refusent avec elle le modèle d'un paquet
 * qui en exige une autre, comme `npm run models` (tools/models/glb.ts). Le lecteur les charge à la
 * demande (client/babylonGltf.ts : TypeScript y réclame chacune). Pas la compression Draco ni
 * meshopt, ni les textures KTX2 : leurs décodeurs viendraient du CDN de Babylon (docs/models.md).
 */
export { GLTF_EXTENSIONS, type GltfExtension } from "../shared/media/glb";
