# 3D models for props (glTF)

The props are the objects of the scenery: crates, barrels, gas cylinders, walls and roofs, trees, cacti, water towers, storage tanks, cars, wrecks, street lamps. The game draws each one from code (`src/client/render/propModels.ts`). An artist can replace any of them with a **glTF model** made in Blender (or any tool that exports glTF 2.0): drop the file in `public/models/props/`, run one command, and the game uses it. Without a file, nothing changes.

The model is only the look. The prop's collision shape, mass, hit points, resistances and behavior (it burns, it topples, it explodes) stay those of the game's catalog (`src/shared/catalog/props.ts`, also published as data in [`content/catalog.json`](../content/catalog.json), under `props`).

## In five steps

1. **Model the prop in meters, standing on the origin**: the origin is the bottom center of its footprint, the point where it rests on the ground (see [Conventions](#conventions)). Keep its size close to the collision shape given in the [table](#the-props) below.
2. **Export it as glTF Binary**: in Blender, *File → Export → glTF 2.0*, *Format: glTF Binary (.glb)*, *Include: Selected Objects*, *Transform: +Y Up* (the default), *Mesh: Apply Modifiers*, *Normals*, *UVs* if it has textures, *Vertex Colors* if it uses them; *Materials: Export*; no animation. Everything must be in the one `.glb` file (textures embedded).
3. **Save it as `public/models/props/<type>.glb`**, where `<type>` is the prop's identifier: `crate.glb`, `barrel.glb`, `pine.glb`…
4. **Run `npm run models`.** It checks every file of `public/models/`, prints each model's size next to its collision shape, and writes the manifest the game reads (`src/client/render/propModelFiles.ts`). A file the game could not read is reported and left out (exit code 1).
5. **Look at it in the game** (`npm run dev`): the Depot has crates and barrels, the Valley trees and houses, the City cars, lamps and facades. Then `npm run check`: `tests/models.test.ts` fails if the manifest is not up to date (run `npm run models` again after adding, changing or removing a model).

## Conventions

- **Units and axes.** Meters. **+Y is up**; X and Z are the prop's own horizontal axes, which the map rotates with the spot's `yaw`. Blender is Z-up: its exporter's *+Y Up* option turns Blender's +Z into +Y and Blender's −Y (toward you in Blender's front view) into +Z, and keeps +X: a car modeled facing Blender's +X faces +X in the game.
- **Origin: the bottom center of the footprint.** The game puts the model's origin at the bottom of the collision shape: a crate's origin goes to the bottom of its 1 m box, a tree's to the foot of its trunk. A part may go a little below the origin (the steel feet of the example crate stand 8 mm into the ground).
- **Size: as modeled.** A model is drawn at the size it has in the file; the game does not resize it to the collision shape, so match the [table](#the-props). Trees, lamps and other cylinders may be enlarged by a map spot (`scale`): the model is scaled with them, uniformly. A tree's collision is its trunk only: its foliage is pure look, model it freely.
- **Slabs are stretched.** The props of shape `slab` (walls, roofs, facades, cars, wrecks) take their dimensions from each map spot. For them, the model's bounding box is stretched along each axis to fill the spot's box, whatever the model's origin. The walls drawn by code repeat their texture every meter or so; a stretched model doesn't: a wall model suits panels of one size. Cars and wrecks always have the same size (4.2 × 1.44 × 1.84 m, their length along X): a car model fits them well.
- **Oriented props.** A car or a wreck faces **+X** (its length along X). A street lamp's arm and a floodlight mast's projectors point toward **+X**; the light they cast at night stays where the code puts it (`PROP_LIGHTS`, `src/client/render/lightSources.ts`): for the lamp, 1.15 m toward +X and 6.1 m above the base; for the mast, 0.45 m toward +X and 8.9 m above the base. Put the glass there.
- **Static meshes only.** The game merges all the meshes of the file, with their node transforms (mirrored nodes included) and their GPU instances (`EXT_mesh_gpu_instancing`), into one mesh. Animations, skins, morph targets, cameras and lights are ignored.
- **Light.** A prop is drawn hundreds of times (the City has about 500 props): a few hundred to a few thousand triangles, one or a few materials (each material is one more draw call), textures of 512 or 1024 px. The example crate has 1,176 vertices and 2 materials, in 44 KB.

## Materials

The game converts each material of the file to its own standard material, so that a model is lit exactly like the props drawn by code (sun, sky, the clustered lights of the night) without compiling the PBR shaders. What it keeps:

- the **base color**: its factor, its texture (sRGB) and the vertex colors (`COLOR_0`), multiplied together;
- the **emission**: its factor, its strength (`KHR_materials_emissive_strength`) and its texture;
- the **opacity**: alpha blending or alpha masking (with its cutoff), from the factor or the base color texture;
- **double-sided** materials, and **unlit** ones (`KHR_materials_unlit`);
- **roughness and metallic** become a specular highlight, sharper on a smooth material, tinted by the base color on a metal.

Normal maps, metallic-roughness textures and occlusion textures are ignored: bake their detail into the base color (vertex colors work well for the game's look).

Two names have a meaning:

- **`glass`** (any case; Blender's copies `glass.001`, `glass.002`… too) is the glass of a lamp: **it lights up at night**, with the color of the lamp's light for a street lamp or a floodlight, with its own base color for any other prop. Use it only for lamp glass: give car windows another name.
- **Charred wood** needs no extra file: when a prop that burns (a crate, planks, a roof, a tree, a water tower, a car) chars, the game darkens the model's colors in two steps (`CHAR_TINT` in `propModels.ts`: 52 %, then 20 %).

The extensions a file may require: mesh quantization, WebP and AVIF textures, texture transforms, GPU instancing, emissive strength, unlit, specular-glossiness. `npm run models` refuses a file that *requires* another one. **Turn off Draco and meshopt compression** in the exporter, and don't use KTX2 textures: their decoders would be downloaded from Babylon's servers.

## The props

From the game's catalog (`content/catalog.json` has every number). *Anchored* props are fixed bodies (only a blast or a ram makes them fall); *movable* ones are pushed around.

| Type | Name | Collision shape | Behavior |
| --- | --- | --- | --- |
| `crate` | Crate | box, 1 m cube | movable, burns |
| `barrel` | Explosive barrel | cylinder, ⌀ 0.7 m × 1 m high | movable, explodes |
| `gas` | Gas cylinder | cylinder, ⌀ 0.44 m × 1.1 m high | movable, explodes |
| `brick` | Brick wall | slab (per spot) | anchored |
| `concrete` | Concrete | slab (per spot) | anchored |
| `plank` | Planks | slab (per spot) | anchored, burns |
| `sheet` | Sheet metal | slab (per spot) | anchored |
| `roof` | Roof | slab (per spot) | anchored, burns |
| `pine` | Pine | cylinder, ⌀ 0.56 m × 9 m high | anchored, burns, topples |
| `oak` | Oak | cylinder, ⌀ 0.8 m × 6.4 m high | anchored, burns, topples |
| `palm` | Palm tree | cylinder, ⌀ 0.4 m × 8.4 m high | anchored, burns, topples |
| `kapok` | Kapok tree | cylinder, ⌀ 1.2 m × 11 m high | anchored, burns, topples |
| `cactus` | Cactus | cylinder, ⌀ 0.64 m × 4 m high | anchored |
| `watertank` | Water tower | cylinder, ⌀ 3.2 m × 3 m high | anchored, burns |
| `tank` | Storage tank | cylinder, ⌀ 2.8 m × 3.4 m high | anchored, explodes |
| `facade` | Facade | slab (per spot) | anchored |
| `tenement` | Brick facade | slab (per spot) | anchored |
| `car` | Car | slab, 4.2 × 1.44 × 1.84 m | movable, burns, explodes |
| `wreck` | Wreck | slab, 4.2 × 1.44 × 1.84 m | anchored |
| `lamppost` | Lamppost | cylinder, ⌀ 0.26 m × 6.4 m high | anchored, topples |
| `floodlight` | Floodlight mast | cylinder, ⌀ 0.28 m × 9.2 m high | anchored, topples |

## How the game loads a model

- The manifest (`src/client/render/propModelFiles.ts`, written by `npm run models`) lists the files and a hash of each: the game knows which props have a model without asking the network, and a changed file is not served from the browser's cache.
- The glTF reader (Babylon's `@babylonjs/loaders`) is loaded only when the first model is needed, as a separate chunk: the main bundle does not grow, and a game without models never loads it.
- Each file is read once per scene (the game, the map editor), the first time a prop of its type is needed. Until then the prop shows its model drawn by code; then the model takes its place, everywhere at once (its instances and its batches follow). A file the game cannot read leaves the model drawn by code, with a warning in the browser's console.

## The example crate

The crate shipped in `public/models/props/crate.glb` (a frame of beams, planks of varied shades in vertex colors, diagonal braces, steel corner caps; two materials, `wood` and `steel`) is made from code, the way one would make it in Blender: `tools/models/crate.ts` builds it out of boxes, `tools/models/glb.ts` writes it (a dependency-free `.glb` writer and checker), and `npm run models -- example` regenerates it. To try your own crate, overwrite the file and run `npm run models`.

## Licensing your model

The game's code is licensed under the AGPL-3.0-or-later; a model is content: contribute it under a free license, CC0 or CC BY preferably, and say which one in your pull request. You may leave a credits file next to it (`public/models/props/crate.txt` or `.md`): `npm run models` ignores those, and they are published with the game.
