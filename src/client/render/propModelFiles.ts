import type { PropType } from "../../shared/catalog/props";

/*
 * Les modèles glTF des accessoires livrés avec le jeu (public/models/props/<type>.glb), et une
 * empreinte de chacun : elle change avec le fichier, et le navigateur ne garde pas l'ancien. Fait
 * par `npm run models` (tools/models/) d'après le dossier : ne pas modifier à la main ;
 * tests/models.test.ts vérifie qu'il est à jour. Sans fichier pour son type, un accessoire garde le
 * modèle fait par le code (render/propModels.ts). Les conventions : docs/models.md.
 */
export const PROP_MODEL_FILES: { readonly [T in PropType]?: { readonly file: string; readonly hash: string } } = {
  crate: { file: "models/props/crate.glb", hash: "395721fcf7" },
};
