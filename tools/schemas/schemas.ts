import { ARENA_IDS } from "../../src/shared/arena/layout";
import { BLOCK_TYPES } from "../../src/shared/catalog/blocks";
import { PROP_TYPES, type PropType } from "../../src/shared/catalog/props";
import { WHEEL_TYPES, wheelDef, type WheelType } from "../../src/shared/catalog/wheels";
import { ROBOT_BUDGET } from "../../src/shared/design/budget";
import { AXES, TRACK_LAYERS, TRACK_RISE, type Axis } from "../../src/shared/design/robotDesign";
import {
  MAP_CHOICES, MAP_FORMAT, MAP_LIMITS, MAP_LISTS, MAP_PATTERNS, MAP_RANGES, MAX_ANGLE, needsSize, PACKAGE_LIMITS, QUAT_SLACK, ZONE_LABELS, type NumberRange,
} from "../../src/shared/map";
import { CONTENT_FAMILY_IDS, catalogData, catalogSchema, catalogText, familySchema, familySchemaPath } from "./catalog";

/*
 * Les schémas JSON des deux formats ouverts du jeu : une carte communautaire (`MapFile`,
 * .casse-map.json) et le plan d'un robot (`RobotDesign`). Ils sont faits d'après le code : les
 * sortes (accessoires, boîtes, blocs, roues, arènes…) viennent des catalogues, les bornes de la
 * lecture des cartes (`MAP_LIMITS`, `MAP_RANGES`, `MAP_LISTS`, map/read.ts). `npm run schemas` les
 * écrit dans schemas/ (tools/schemas/build.ts) ; tests/schemas.test.ts vérifie que les fichiers
 * livrés sont à jour, que les cartes et les robots du jeu s'y conforment, et que le schéma des
 * cartes refuse ce que refuse la lecture. Les schémas n'emploient qu'un sous-ensemble de JSON
 * Schema (draft 2020-12) : celui que connaît le validateur des tests (tests/jsonSchema.ts).
 * Les descriptions sont en anglais : elles s'affichent dans l'éditeur de texte des auteurs.
 */

/** Un schéma JSON (un objet : nos schémas n'emploient pas les schémas booléens). */
export type Schema = { readonly [keyword: string]: unknown };

const DIALECT = "https://json-schema.org/draft/2020-12/schema";
const BASE = "https://raw.githubusercontent.com/Wasabules/casse-robot/main/schemas/";
export const MAP_SCHEMA_ID = `${BASE}map.schema.json`;
export const ROBOT_SCHEMA_ID = `${BASE}robot.schema.json`;

/** Un texte qui n'est pas que des blancs ou des caractères de contrôle (la lecture les retire avant de le juger vide). */
const NOT_BLANK = "[^\\s\\u0000-\\u001f\\u007f]";

const ref = (name: string, description?: string): Schema => (description ? { description, $ref: `#/$defs/${name}` } : { $ref: `#/$defs/${name}` });

/** Un nombre dans ces bornes. */
function num(range: NumberRange, description?: string): Schema {
  return { ...(description ? { description } : {}), type: range.int ? "integer" : "number", minimum: range.min, maximum: range.max };
}

/** Un choix parmi ces valeurs (les clés d'un catalogue, ou une liste). */
function choice(values: readonly string[] | object, description?: string): Schema {
  return { ...(description ? { description } : {}), type: "string", enum: Array.isArray(values) ? [...values] : Object.keys(values) };
}

const bool = (description: string): Schema => ({ description, type: "boolean" });

/** Un objet : ses champs, ceux qu'il faut donner (les autres sont facultatifs ; un champ inconnu est permis : la lecture l'ignore). */
function object(description: string, properties: Record<string, Schema>, required: readonly string[] = [], more: Schema = {}): Schema {
  return { description, type: "object", properties, ...(required.length ? { required: [...required] } : {}), ...more };
}

function list(description: string, items: Schema, max: number, min = 0): Schema {
  return { description, type: "array", ...(min ? { minItems: min } : {}), maxItems: max, items };
}

/** Une ressource d'un paquet : l'empreinte SHA-256 de son fichier, et sa taille (octets). */
function asset(range: NumberRange, description: string): Schema {
  return object(description, {
    sha256: { description: "The SHA-256 of the file, 64 lowercase hexadecimal digits.", type: "string", pattern: MAP_PATTERNS.sha256.source },
    bytes: num(range, "Its size (bytes)."),
  }, ["sha256", "bytes"]);
}

/** Deux nombres [a, b] (a ≤ b). */
function pair(range: NumberRange, description: string): Schema {
  return { description, type: "array", minItems: 2, maxItems: 2, items: num(range) };
}

/** Un texte écrit par une personne, d'au plus `max` caractères (sans les blancs aux bouts) ; obligatoire : pas vide. */
function text(max: number, required: boolean, description?: string): Schema {
  return { ...(description ? { description } : {}), type: "string", ...(required ? { minLength: 1, pattern: NOT_BLANK } : {}), maxLength: max };
}

/** Un texte par langue (code ISO 639-1). */
function translations(max: number, description: string): Schema {
  return {
    description,
    type: "object",
    maxProperties: MAP_LIMITS.languages,
    propertyNames: { pattern: MAP_PATTERNS.language.source },
    additionalProperties: text(max, true),
  };
}

/** Le centre d'un élément dans le plan. */
const at = (what: string): Record<string, Schema> => ({
  x: ref("coord", `X of ${what} (m; +x is west).`),
  z: ref("coord", `Z of ${what} (m; +z is north).`),
});

const yaw = ref("angle", "Rotation around the vertical (degrees; 90 turns north toward west).");
const turn: Record<string, Schema> = {
  yaw,
  pitch: ref("angle", "Rotation around x (degrees), after the yaw."),
  roll: ref("angle", "Rotation around z (degrees), after the pitch."),
  quat: ref("quat", "An exact orientation, as a unit quaternion [x, y, z, w]; yaw, pitch and roll turn it further. "
    + "Written by the export of the game's arenas when degrees don't give a rotation back to the bit."),
};

/** Sans `y` : posé sur le sol. */
const groundY = (what: string): Schema => ref("height", `Absolute height of ${what} (m); without it, on the ground.`);

const L = MAP_LIMITS;
const R = MAP_RANGES;

/** Les sortes d'accessoires qui doivent donner leurs dimensions (map/validate.ts). */
const SIZED_PROPS = (Object.keys(PROP_TYPES) as PropType[]).filter(needsSize);

function mapDefs(): Record<string, Schema> {
  const prefab = (kind: string, description: string, properties: Record<string, Schema>, required: readonly string[]): Schema =>
    object(description, { kind: { const: kind }, ...properties }, ["kind", ...required]);
  return {
    coord: num(R.coord, "A horizontal coordinate (m), from the center of the map."),
    height: num(R.height, "An absolute height (m)."),
    angle: { description: "An angle in degrees (any finite number, taken modulo 360).", type: "number", exclusiveMinimum: -MAX_ANGLE, exclusiveMaximum: MAX_ANGLE },
    color: { description: "A color, #rrggbb.", type: "string", pattern: MAP_PATTERNS.color.source },
    point: { description: "A point on the plane: [x, z] (m).", type: "array", minItems: 2, maxItems: 2, items: ref("coord") },
    polyline: list(`A polyline: [[x, z], …], 2 to ${L.points} points.`, ref("point"), L.points, 2),
    size: { description: "Dimensions: [width (x), height (y), depth (z)] (m).", type: "array", minItems: 3, maxItems: 3, items: num(R.size) },
    quat: {
      description: `A unit quaternion [x, y, z, w] (the game checks that its norm is 1, within ${QUAT_SLACK}).`,
      type: "array", minItems: 4, maxItems: 4, items: num(R.quat),
    },
    seed: num(R.seed, "Seed of the scattering: the same seed always gives the same result."),
    meta: object("What the author says about the map: shown as is, in every language.", {
      name: text(L.name, true, "The map's name."),
      names: translations(L.name, "The name in other languages: { \"en\": \"Lake Vale\" } (ISO 639-1 codes)."),
      author: text(L.author, true, "Who made it."),
      description: text(L.description, false, "A sentence for the menu."),
      descriptions: translations(L.description, "The description in other languages."),
      license: text(L.license, true, "The map's license: an SPDX identifier (CC-BY-4.0, CC0-1.0, CC-BY-SA-4.0…)."),
    }, ["name", "author", "license"]),
    terrain: object(
      "The terrain: a square grid of heights centered on the origin, cells × step m per side (at most " + L.maxSide + " m). "
        + "Without it, the map is flat (ground at y = 0). The game also checks that the heights hold (cells + 1)² values and that max > min.",
      {
        cells: num(R.terrain.cells, "Cells per side (cells + 1 vertices per side)."),
        step: { description: "Grid step (m).", enum: [...L.steps] },
        min: num(R.terrain.height, "Height (m) of the lowest code (0)."),
        max: num(R.terrain.height, "Height (m) of the highest code (65535)."),
        heights: {
          description: "The heights as little-endian Uint16 codes, in base64: one column per x from east (-x) to west (+x), "
            + "and within each column increasing z; the index of vertex (ix, iz) is ix × (cells + 1) + iz.",
          type: "string",
          pattern: "^[A-Za-z0-9+/\\s]*(=\\s*){0,2}$",
          maxLength: L.bytes,
        },
      },
      ["cells", "step", "min", "max", "heights"],
      // Le côté du relief : cells × step ≤ maxSide
      { anyOf: L.steps.map((step) => ({ properties: { step: { const: step }, cells: { maximum: Math.floor(L.maxSide / step) } } })) },
    ),
    bounds: object("The play dimensions (m). Only half is required: the rest follows from it.", {
      half: num(R.bounds.half, "Half-side of the play area: it runs from -half to +half in x and in z."),
      roam: num(R.bounds.roam, "Where the AI picks its random destinations (86% of half by default)."),
      spawnLine: num(R.bounds.spawnLine, "Distance from the center to the spawn lines: reds to the north, blues to the south (80% of half by default)."),
      spawnSpread: num(R.bounds.spawnSpread, "Half-width of the spawn lines (30% of half by default, 30 at most)."),
      circuit: num(R.bounds.circuit, "Radius of the aircraft circuit (70% of half by default)."),
      airFloor: num(R.bounds.airFloor, "Altitude above the terrain below which the AI doesn't fly its planes (by default, the highest scenery + 4 m)."),
      hoverFloor: num(R.bounds.hoverFloor, "Floor altitude of the AI's flying robots (0 by default)."),
    }, ["half"]),
    limits: object("The edges of the map.", {
      walls: bool("Visible perimeter walls at ±half, that follow the terrain."),
      bound: num(R.limits.bound, "An invisible limit at ±bound m (half + 35 by default); 0: none."),
    }),
    sky: object("The sky and the fog (the Valley's by default).", {
      color: ref("color", "Color of the sky and the fog."),
      fog: num(R.sky.fog, "Fog density."),
      dust: num(R.sky.dust, "Dust in the air (grains per second: a ruined city)."),
      night: bool("Night: the moon, a starry sky, lampposts, floodlights and headlights lit."),
    }, ["color", "fog"]),
    ground: object("The ground palette: that of one of the game's arenas (preset), with any field changed.", {
      preset: choice(ARENA_IDS, "Start from the palette of one of the game's arenas (valley by default)."),
      base: { description: "The two tints of the ground, mixed by noise.", type: "array", minItems: 2, maxItems: 2, items: ref("color") },
      dirt: ref("color", "Dirt patches and paths."),
      sand: ref("color", "Banks."),
      mud: ref("color", "Bottom of the water."),
      rock: ref("color", "Steep slopes and heights."),
      peak: ref("color", "Summits (snow, ash)."),
      rockLine: num(R.ground.rockLine, "Height where rock begins (m)."),
      peakLine: num(R.ground.peakLine, "Height where the summit begins (m)."),
      beach: num(R.ground.beach, "Width of the beach above the water (m of height)."),
      basalt: ref("color", "Solidified ground around lava."),
      basaltWidth: num(R.ground.basaltWidth, "Width of the solidified ground around lava (m)."),
      strata: list("Color bands of the cliffs.", ref("color"), MAP_LISTS.strata),
      strataStep: num(R.ground.strataStep, "Height of each band of the cliffs (m)."),
      patches: list("Patches of color: a disc where the ground takes this tint.", object("A patch of color.", {
        ...at("the patch"),
        r: num(R.ground.patchRadius, "Its radius (m)."),
        color: ref("color"),
      }, ["x", "z", "r", "color"]), MAP_LISTS.patches),
      grain: num(R.ground.grain, "Size of the pattern of the two tints (m)."),
      stains: num(R.ground.stains, "Share of dirt patches."),
      slope: object("The tint of slopes.", {
        color: ref("color", "Their tint (the rock by default)."),
        from: num(R.ground.slopeFrom, "From which vertical component of the normal."),
        span: num(R.ground.slopeSpan, "Over which span."),
      }, ["from", "span"]),
      rockSpan: num(R.ground.rockSpan, "Height span over which the ground turns to rock above rockLine (m)."),
      lawn: ref("color", "Grass paths."),
    }),
    water: object("The water: drawn wherever the terrain is below its level; you can cross it, except where it's deep.", {
      level: num(R.water.level, "Its level (m)."),
      deep: num(R.water.deep, "Beyond this depth (m), you drown in it; without it, you cross it everywhere."),
      color: ref("color"),
    }, ["level"]),
    lavaFlow: prefab("flow", "A lava flow along a polyline. Its surface is the terrain; it burns whatever stands in it.", {
      width: num(R.lava.width, "Its width (m)."),
      points: ref("polyline"),
    }, ["width", "points"]),
    lavaPool: prefab("pool", "A lava lake (a disc).", {
      ...at("its center"),
      r: num(R.lava.r, "Its radius (m)."),
    }, ["x", "z", "r"]),
    vent: object("A fumarole.", {
      ...at("the vent"),
      y: groundY("the vent"),
      size: num(R.vent.size, "Its size."),
      steam: bool("White steam."),
    }, ["x", "z", "size"]),
    fall: object("A waterfall.", {
      ...at("the waterfall"),
      top: ref("height", "Height of its top (m)."),
      bottom: ref("height", "Height of its bottom (m), below its top."),
      width: num(R.fall.width, "Its width (m)."),
      dir: ref("angle", "Where the water falls (degrees: 0 toward north, 90 toward west); 0 by default."),
    }, ["x", "z", "top", "bottom", "width"]),
    path: object("A path drawn on the terrain.", {
      width: num(R.path.width, "Its width (m)."),
      points: ref("polyline"),
      surface: choice(MAP_CHOICES.surface, "Its surface (dirt by default)."),
    }, ["width", "points"]),
    box: object("An indestructible scenery box. Without y, it's placed on the ground (a rock, half buried).", {
      kind: choice(MAP_CHOICES.boxKind, "What it is: wall, pillar, platform, barrier (low wall), rock, container, deck, road, track, ramp, tower, bound (invisible)."),
      ...at("its center"),
      y: ref("height", "Height of its center (m); without it, on the ground."),
      size: ref("size"),
      ...turn,
      look: choice(MAP_CHOICES.boxLook, "Its appearance, other than its kind's own."),
      round: bool("An upright cylinder inscribed in the box (a silo, a lighthouse)."),
      underpass: bool("A deck you pass under (an elevated road)."),
      approach: num(R.box.approach, "Where to approach the deck beyond its ends (m)."),
    }, ["kind", "x", "z", "size"]),
    prop: object(`A prop: what breaks, burns, explodes or falls. A slab (${SIZED_PROPS.join(", ")}) needs its size.`, {
      type: choice(PROP_TYPES, "What it is."),
      ...at("its base"),
      y: groundY("its base"),
      ...turn,
      size: ref("size", "Dimensions of a slab."),
      scale: num(R.prop.scale, "Enlarges a cylinder or a crate."),
      rests: list("The props (their indices in props) it rests on: when they're all gone, it falls.", { type: "integer", minimum: 0, maximum: L.props - 1 }, MAP_LISTS.rests),
      group: num(R.prop.group, "A building number: the AI goes around a building as one piece."),
      diamond: bool("Set on its corner (a gable under a pitched roof): the renderer straightens its texture."),
      centered: bool("y is the height of its center (like a box's), not of its base."),
    }, ["type", "x", "z"], {
      if: { required: ["type"], properties: { type: { enum: SIZED_PROPS } } },
      then: { required: ["size"] },
    }),
    house: prefab("house", "A house, a hangar: four walls in panels and a roof; the opening is in the middle of the long front side (south before rotation).", {
      ...at("its center"),
      y: groundY("its floor"),
      yaw,
      width: num(R.house.width, "Along the ridge (x before rotation, m)."),
      depth: num(R.house.depth, "Crosswise (m)."),
      height: num(R.house.height, "Height of the walls (m)."),
      wall: choice(MAP_CHOICES.wall, "Material of the walls."),
      roof: choice(MAP_CHOICES.roof, "Material of the roof."),
      roofKind: choice(MAP_CHOICES.roofKind, "Gable (by default) or flat roof."),
      door: num(R.house.door, "Width of the opening (m)."),
      through: bool("Repeats the opening at the back (you drive through)."),
    }, ["x", "z", "width", "depth", "height", "wall", "roof"]),
    tenement: prefab("tenement", "An apartment block: one facade panel per floor and a flat roof; it collapses floor by floor.", {
      ...at("its center"),
      y: groundY("its floor"),
      yaw,
      width: num(R.tenement.width, "Width (m)."),
      depth: num(R.tenement.depth, "Depth (m)."),
      floors: num(R.tenement.floors, "Number of floors."),
      wall: choice(MAP_CHOICES.facade, "Material of the facade."),
      doors: list("Openings on the ground floor: [side before rotation (n, s, w, e), panel index].", {
        type: "array", minItems: 2, maxItems: 2, prefixItems: [choice(MAP_CHOICES.side), num(R.tenement.door)],
      }, MAP_LISTS.doors),
      ruin: num(R.tenement.ruin, "Share of columns that lost their top."),
      seed: ref("seed"),
    }, ["x", "z", "width", "depth", "floors", "wall"]),
    fence: prefab("fence", "A fence or a low wall along a polyline, in panels of 2.5 m at most.", {
      points: ref("polyline"),
      height: num(R.fence.height, "Its height (m)."),
      material: choice(MAP_CHOICES.wall, "Its material."),
    }, ["points"]),
    woods: prefab("woods", "A wood: trees scattered in a disc, away from paths, zones, spawn lines, water, lava and scenery.", {
      ...at("its center"),
      radius: num(R.woods.radius, "Radius of the disc (m)."),
      count: num(R.woods.count, "Number of trees."),
      trees: list("The species to pick from.", choice(MAP_CHOICES.tree), MAP_LISTS.trees),
      scale: pair(R.woods.scale, "Size of the trees: [min, max]."),
      spacing: num(R.woods.spacing, "Spacing between trees (m)."),
      seed: ref("seed"),
    }, ["x", "z", "radius", "count"]),
    rocks: prefab("rocks", "Rocks scattered in a disc.", {
      ...at("its center"),
      radius: num(R.rocks.radius, "Radius of the disc (m)."),
      count: num(R.rocks.count, "Number of rocks."),
      size: pair(R.rocks.size, "Size of the rocks: [min, max] (m)."),
      look: choice(MAP_CHOICES.rockLook, "Their stone."),
      seed: ref("seed"),
    }, ["x", "z", "radius", "count"]),
    ramp: prefab("ramp", "A ramp that climbs rise m over length m toward its front (north before rotation).", {
      ...at("its center"),
      yaw,
      width: num(R.ramp.width, "Width (m)."),
      length: num(R.ramp.length, "Length (m)."),
      rise: num(R.ramp.rise, "Height it climbs (m)."),
      base: ref("height", "Height of its foot (m); without it, the ground."),
    }, ["x", "z", "width", "length", "rise"]),
    bridge: prefab("bridge", "A bridge from one end to the other; for the AI, along the north-south or east-west axis, its ends on ground at deck height.", {
      from: ref("point", "One end: [x, z]."),
      to: ref("point", "The other end: [x, z]."),
      width: num(R.bridge.width, "Width (m)."),
      y: ref("height", "Top of the deck (m); without it, the highest ground at its ends."),
      parapets: bool("Parapets (yes by default)."),
      piers: num(R.bridge.piers, "Number of piers."),
      look: choice(MAP_CHOICES.boxLook, "Appearance of the deck."),
    }, ["from", "to", "width"]),
    containers: prefab("containers", "A row of containers, possibly stacked.", {
      ...at("its center"),
      y: groundY("the row"),
      yaw,
      count: num(R.containers.count, "Containers in the row."),
      levels: num(R.containers.levels, "Levels of the stack."),
    }, ["x", "z"]),
    zone: object("A capture zone.", {
      label: choice(ZONE_LABELS, "Its letter (each zone has its own)."),
      ...at("its center"),
      y: ref("height", "Height (m) of what it's on (a bridge, a platform); without it, on the ground."),
      radius: num(R.zone.radius, "Its radius (m)."),
    }, ["label", "x", "z", "radius"]),
    place: object("A named place for the full map (M): its name, or one of the places of the game's arenas (place), translated.", {
      name: text(L.place, true, "Its name."),
      names: translations(L.place, "Its name in other languages."),
      place: choice(MAP_CHOICES.place, "One of the places of the game's arenas, shown in the player's language (instead of name)."),
      ...at("the place"),
    }, ["x", "z"], { anyOf: [{ required: ["name"] }, { required: ["place"] }] }),
    navGraph: object(
      "The AI's nav graph (a map that the terrain cuts up, like the Canyon): points and the links between them, taken as given. "
        + "A map that has one has no nav grid unless it asks for one (nav). The game also checks that each link joins two of its points.",
      {
        points: list("Its points: [[x, z], …].", ref("point"), L.navPoints),
        links: list("Its links, both ways: [[i, j], …] (indices in points).", {
          type: "array", minItems: 2, maxItems: 2, items: { type: "integer", minimum: 0, maximum: L.navPoints - 1 },
        }, L.navLinks),
      },
      ["points", "links"],
    ),
    spawn: object("A team's spawn line.", {
      ...at("its middle"),
      facing: ref("angle", "Where the team faces when starting (degrees: 0 toward north, 90 toward west); 0 by default."),
      width: num(R.spawn.width, "Its length (m)."),
    }, ["x", "z", "width"]),
  };
}

/** Le schéma d'une carte communautaire (`MapFile`, map/format.ts), fidèle à sa lecture (`readMap`, map/read.ts). */
export function mapSchema(): Schema {
  const prefabKinds = ["house", "tenement", "fence", "woods", "rocks", "ramp", "bridge", "containers"];
  return {
    $schema: DIALECT,
    $id: MAP_SCHEMA_ID,
    title: "Casse-Robot community map",
    description: `A community map (.casse-map.json), format ${MAP_FORMAT}: meters and degrees, north = +z, west = +x, up = +y. `
      + "Generated from the game's code (npm run schemas); the guide is docs/maps.md. Unknown fields are ignored. "
      + "The game checks more than a schema can say: consistent dimensions, the terrain covering the play area, nothing off the map, "
      + `zones with different letters that the AI reaches, clear and safe spawn lines at least 24 m apart, at most ${L.boxes} boxes and ${L.props} props `
      + `(${L.dynamicProps} movable) once the prefabs are unfolded, ${L.scattered} scattered trees and rocks, ${L.pathPoints} points for all paths, `
      + `${L.lavaPoints} for all lava; a [min, max] pair needs min ≤ max, a waterfall's bottom below its top, a prop's rests below the number of props, `
      + "a quaternion of norm 1, a nav graph's links below its number of points. "
      + "Texts are measured once trimmed. Run npm run map:check.",
    type: "object",
    properties: {
      $schema: { description: "The URL of this schema, for editor autocompletion; the game ignores it.", type: "string" },
      format: { description: "The format version.", const: MAP_FORMAT },
      meta: ref("meta"),
      terrain: ref("terrain"),
      bounds: ref("bounds"),
      limits: ref("limits"),
      sky: ref("sky"),
      ground: ref("ground"),
      water: ref("water"),
      lava: list("Lava flows and lakes.", { oneOf: [ref("lavaFlow"), ref("lavaPool")] }, L.lava),
      vents: list("Fumaroles.", ref("vent"), L.vents),
      falls: list("Waterfalls.", ref("fall"), L.falls),
      paths: list("Paths drawn on the terrain.", ref("path"), L.paths),
      urban: bool("A city: the AI doesn't take a point inside a building as a destination."),
      ambience: choice(ARENA_IDS, "The ambient sound of one of the game's arenas (valley by default)."),
      nav: {
        description: "The AI's nav grid, computed by default on a map with terrain, deep water or lava; false: none (the AI goes straight).",
        anyOf: [
          { const: false },
          object("Its settings.", {
            cell: num(R.nav.cell, "Size of a cell (m; 2.5 by default)."),
            maxSlope: num(R.nav.maxSlope, "Steepest slope the AI takes (degrees; 26 by default)."),
          }),
        ],
      },
      navGraph: ref("navGraph"),
      boxes: list("The static scenery: indestructible boxes.", ref("box"), L.boxes),
      props: list("The props.", ref("prop"), L.props),
      prefabs: list("Prefabricated elements, unfolded into props and boxes.", { oneOf: prefabKinds.map((kind) => ref(kind)) }, L.prefabs),
      zones: list(`One to ${L.zones} capture zones.`, ref("zone"), L.zones, 1),
      places: list("Named places for the full map (M).", ref("place"), L.places),
      spawns: object("Spawn lines placed freely, both teams together; without them, reds to the north and blues to the south.", {
        blue: ref("spawn"),
        red: ref("spawn"),
      }, ["blue", "red"]),
      assets: object(
        "The resources of a map package (models/props/<prop type>.glb, sounds/ambience.ogg): the SHA-256 and size of each file, which the map's "
          + "identifier covers. The files travel beside the map (the package, the browser's library, the server that sent it). Reading a package "
          + "writes this field from its files (in a package's map.json, it's ignored); a map without resources doesn't have it.",
        {
          models: {
            description: `glTF binary models that replace, on this map only, the game's model of an existing prop type (at most ${PACKAGE_LIMITS.models} bytes in all).`,
            type: "object",
            maxProperties: Object.keys(PROP_TYPES).length,
            propertyNames: choice(PROP_TYPES),
            additionalProperties: asset(R.asset.model, "A model (models/props/<prop type>.glb)."),
          },
          ambience: asset(R.asset.ambience, `The ambient sound (sounds/ambience.ogg): an Ogg Opus loop, mono or stereo, ${PACKAGE_LIMITS.ambienceMin} to ${PACKAGE_LIMITS.ambienceMax} s; it replaces \`ambience\`.`),
        },
      ),
    },
    required: ["format", "meta", "bounds", "zones"],
    $defs: mapDefs(),
  };
}

/** Les galets de chenille : seuls eux s'empilent (`rise`, `layer`). */
const TRACK_TYPES = (Object.keys(WHEEL_TYPES) as WheelType[]).filter((type) => wheelDef(type).track);

/** Pour chaque haut, les avants qui lui sont perpendiculaires (`validateDesign`). */
function facings(): Schema[] {
  const axes = Object.keys(AXES) as Axis[];
  const dot = (a: Axis, b: Axis): number => AXES[a].x * AXES[b].x + AXES[a].y * AXES[b].y + AXES[a].z * AXES[b].z;
  return axes.map((up) => ({ properties: { up: { const: up }, forward: { enum: axes.filter((forward) => dot(up, forward) === 0) } } }));
}

/** Le schéma du plan d'un robot (`RobotDesign`, design/robotDesign.ts), pour ce qu'en dit `validateDesign`. */
export function robotSchema(): Schema {
  const cell = (description: string): Schema => ({ description, type: "integer" });
  return {
    $schema: DIALECT,
    $id: ROBOT_SCHEMA_ID,
    title: "Casse-Robot robot design",
    description: "A robot design: blocks on a grid of 0.5 m cells, and wheels mounted on their faces. Frame: +z forward, +x left, +y up. "
      + "Generated from the game's code (npm run schemas). Unknown fields are ignored. The game also checks what a schema can't say "
      + "(validateDesign): one block per cell, all blocks connected by their faces, each wheel on an existing block, a free cell under a wheel "
      + `mounted underneath, no overlapping wheels, and a cost within the budget (${ROBOT_BUDGET}). The garage keeps a robot as { name, color, design }: `
      + "this schema describes the design.",
    type: "object",
    properties: {
      $schema: { description: "The URL of this schema, for editor autocompletion; the game ignores it.", type: "string" },
      blocks: {
        description: "The blocks, exactly one of them a cockpit.",
        type: "array",
        items: ref("block"),
        contains: { required: ["type"], properties: { type: { const: "cockpit" } } },
        minContains: 1,
        maxContains: 1,
      },
      wheels: { description: "The wheels and track rollers.", type: "array", items: ref("wheel") },
    },
    required: ["blocks", "wheels"],
    $defs: {
      axis: choice(Object.keys(AXES), "One of the robot's six axes."),
      facing: {
        description: "Where the block's top and front point, in the robot's frame (two perpendicular axes); without it, up +y and forward +z. "
          + "An engine pushes toward its top; a wing lifts toward its top, the air meets its front.",
        type: "object",
        properties: { up: ref("axis"), forward: ref("axis") },
        required: ["up", "forward"],
        anyOf: facings(),
      },
      block: object("A block on the grid.", {
        x: cell("X of its cell (an integer; one cell is 0.5 m)."),
        y: cell("Y of its cell."),
        z: cell("Z of its cell."),
        type: choice(BLOCK_TYPES, "The block type."),
        facing: ref("facing"),
      }, ["x", "y", "z", "type"]),
      wheel: object(
        "A wheel mounted on a face of its supporting block (x, y, z): on the left or right side (dx = ±1), the front or back face (dz = ±1), "
          + "or underneath (dy = -1). Its axle always runs along x.",
        {
          x: cell("X of the supporting block's cell."),
          y: cell("Y of the supporting block's cell."),
          z: cell("Z of the supporting block's cell."),
          dx: { description: "1: on the left side (+x); -1: on the right side; 0 otherwise.", enum: [-1, 0, 1] },
          dz: { description: "1: on the front face (+z); -1: on the back face; 0 otherwise.", enum: [-1, 0, 1] },
          dy: { description: "-1: under the block; absent (or 0): on a side or face.", enum: [-1, 0] },
          type: choice(WHEEL_TYPES, "The wheel type."),
          shift: { description: "Offset along the face, in half cells.", type: "integer", minimum: -1, maximum: 1 },
          rise: { description: "A track roller on the left or right side: raised or lowered by this many cells.", type: "integer", minimum: -TRACK_RISE, maximum: TRACK_RISE },
          layer: { description: "A track roller on the left or right side: laid on this many rollers outward (a wider track).", type: "integer", minimum: 0, maximum: TRACK_LAYERS },
          steer: { description: "Former format: a steered wheel was a fixed wheel with steer: true. The game upgrades it to the steered type.", type: "boolean", deprecated: true },
        },
        ["x", "y", "z", "dx", "dz", "type"],
        {
          anyOf: [
            { properties: { dx: { enum: [-1, 1] }, dz: { const: 0 }, dy: { const: 0 } } },
            { properties: { dx: { const: 0 }, dz: { enum: [-1, 1] }, dy: { const: 0 } } },
            { required: ["dy"], properties: { dx: { const: 0 }, dz: { const: 0 }, dy: { const: -1 } } },
          ],
          if: { anyOf: [{ required: ["rise"] }, { required: ["layer"] }] },
          then: { properties: { type: { enum: TRACK_TYPES }, dx: { enum: [-1, 1] } } },
        },
      ),
    },
  };
}

/** Le texte d'un fichier de schéma. */
export const schemaText = (schema: Schema): string => `${JSON.stringify(schema, null, 2)}\n`;

/**
 * Les fichiers que fait `npm run schemas`, par chemin depuis la racine du dépôt : les schémas des
 * deux formats ouverts, et le catalogue du jeu en données ouvertes avec son schéma (tools/schemas/catalog.ts).
 */
export function schemaFiles(): Record<string, string> {
  return {
    "schemas/map.schema.json": schemaText(mapSchema()),
    "schemas/robot.schema.json": schemaText(robotSchema()),
    "content/catalog.schema.json": schemaText(catalogSchema()),
    ...Object.fromEntries(CONTENT_FAMILY_IDS.map((family) => [familySchemaPath(family), schemaText(familySchema(family))])),
    "content/catalog.json": catalogText(catalogData()),
  };
}
