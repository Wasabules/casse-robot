import type { BlockType } from "../../shared/catalog/blocks";
import type { PropType } from "../../shared/catalog/props";
import type { WheelType } from "../../shared/catalog/wheels";
import type { TurretBlockType } from "./models";

/*
 * Les modèles glTF livrés avec le jeu (public/models/<famille>/<type>.glb : accessoires, blocs,
 * têtes de tourelle, roues), et une empreinte de chacun : elle change avec le fichier, et le
 * navigateur ne garde pas l'ancien. Fait par `npm run models` (tools/models/) d'après le dossier :
 * ne pas modifier à la main ; tests/models.test.ts vérifie qu'il est à jour. Sans fichier pour son
 * type, une pièce garde le modèle fait par le code (render/propModels.ts, render/partModels.ts).
 * Les conventions : docs/models.md.
 */

/** Un fichier de modèle : son chemin dans la page, une empreinte de son contenu. */
export interface ModelFile {
  readonly file: string;
  readonly hash: string;
}

export const PROP_MODEL_FILES: { readonly [T in PropType]?: ModelFile } = {
  crate: { file: "models/props/crate.glb", hash: "395721fcf7" },
};

export const BLOCK_MODEL_FILES: { readonly [T in BlockType]?: ModelFile } = {};

export const HEAD_MODEL_FILES: { readonly [T in TurretBlockType]?: ModelFile } = {};

export const WHEEL_MODEL_FILES: { readonly [T in WheelType]?: ModelFile } = {};
