/*
 * Moteur de cartes communautaires : ce qu'un éditeur, le client, le serveur et les outils en
 * utilisent. Une carte est une donnée JSON (`MapFile`, format.ts) qu'on lit (`readMap`), vérifie
 * (`checkMap`, `validateMap`), identifie (`mapKey`) et convertit en arène (`arenaFromMap`) ; son
 * relief s'importe d'une image ou d'un RAW (heightmap.ts). Le détail pour les auteurs : docs/maps.md.
 */
export * from "./format";
export { encodeTerrain, decodeTerrain, fromBase64, toBase64 } from "./codec";
export { canonicalJson, mapKey } from "./key";
export { MAP_MIGRATIONS, readMap, readMapText, upgradeMap, type MapMigration, type ReadResult } from "./read";
export { arenaFromMap, boundAt, groundStyle, mapBounds, turnQuat, type ArenaOrigins, type ElementOrigin } from "./build";
export { checkMap, checkMapText, validateMap, validateArena, type MapCheck } from "./validate";
export {
  decodePng, decodeRaw16, heightsFromImage, imageFromBytes, imageFromHeights, isHeightmapError, MAX_IMAGE_SIDE, sampleImage, smoothImage, terrainFromImage,
  type HeightImage, type HeightmapError, type HeightmapErrorCode, type Inflate, type TerrainImport,
} from "./heightmap";
export { crc32, encodePng, type Deflate } from "./png";
export { blankMap, terrainSideFor, type BlankMapOptions } from "./template";
export { registerMap } from "./load";
export {
  applyBrush, BRUSH_KINDS, BRUSH_LIMITS, brushRegion, brushWeight, fieldHeight, fieldOf, terrainOfField, unionRegion,
  type Brush, type BrushKind, type HeightField, type Region,
} from "./brush";
export {
  addElement, centerOf, countOf, duplicateElements, ELEMENT_LISTS, elementCenter, elementPoints, elementsOf, freeZoneLabel, getElement, issueTarget,
  moveElements, movePoint, normalAngle, refAfterRemoval, refKey, refOfPath, removeElements, rotateElements, sameRef, setElement, spawnsOf,
  transformElement, turnPoint, type ElementList, type ElementOf, type ElementRef, type MapElement,
} from "./edit";
export { MapHistory } from "./history";
export {
  PALETTE, PALETTE_TABS, paletteEntry, slabSize, TRACE_KINDS, TRACE_POINTS, traceElement,
  type NamedPaletteId, type PaletteEntry, type PaletteGroup, type PaletteTab, type PlaceContext, type Placed, type TraceKind,
} from "./palette";
export {
  BOX_LOOKS, fieldApplies, fieldValue, FORMS, formOf, PATH_SURFACES, PRESET_ARENAS, TREE_TYPES, withField,
  type ChoiceNames, type FieldKey, type FieldSpec, type FormId,
} from "./fields";
