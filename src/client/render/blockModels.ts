import type { BlockType } from "../../shared/catalog/blocks";
import type { WheelType } from "../../shared/catalog/wheels";
import type { BlockModel, HeadModel, RoundsModel, WheelModel } from "./modelKit";
import type { TurretBlockType } from "./models";
import { PROPULSION_MODELS } from "./models/propulsion";
import { DIRECT_BASES, DIRECT_HEADS, DIRECT_ROUNDS } from "./models/weaponsDirect";
import { GUIDED_BASES, GUIDED_HEADS, GUIDED_ROUNDS } from "./models/weaponsGuided";
import { TRACK_MODELS } from "./models/tracks";
import { MELEE_BASES } from "./models/melee";
import { LIGHT_MODELS } from "./models/lights";
import { WHEEL_MODELS as ROAD_WHEELS } from "./models/wheels";

/*
 * Registre des modèles 3D : un bloc qui a le sien n'est plus un cube texturé (`Assets.blockSource`),
 * une tourelle qui a sa tête la dessine (`Assets.turretHeadSource`) au lieu du pavé et des tubes de
 * `TURRET_LOOKS`. Chaque famille a son fichier (render/models/) : on les réunit ici.
 */
export const BLOCK_MODELS: Partial<Record<BlockType, BlockModel>> = { ...PROPULSION_MODELS, ...DIRECT_BASES, ...GUIDED_BASES, ...MELEE_BASES, ...LIGHT_MODELS };
export const HEAD_MODELS: Partial<Record<TurretBlockType, HeadModel>> = { ...DIRECT_HEADS, ...GUIDED_HEADS };
/** Modèles des roues et des galets (à la place du cylindre et du moyeu de `createWheelSource`). */
export const WHEEL_MODELS: Partial<Record<WheelType, WheelModel>> = { ...ROAD_WHEELS, ...TRACK_MODELS };
/** Munitions qu'on voit sur la tête, et qui partent quand on tire (voir `Rounds`). */
export const HEAD_ROUNDS: Partial<Record<TurretBlockType, RoundsModel>> = { ...DIRECT_ROUNDS, ...GUIDED_ROUNDS };
