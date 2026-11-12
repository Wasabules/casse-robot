# 3D models (glTF)

The game draws everything from code: the props of the scenery (`src/client/render/propModels.ts`), the blocks of the robots, their turret heads and their wheels (`src/client/render/models/`). An artist can replace any of them with a **glTF model** made in Blender (or any tool that exports glTF 2.0): drop the file in `public/models/<family>/`, run one command, and the game uses it. Without a file, nothing changes. A prop model can also come with one map only, in its package (see [A model for one map](#a-model-for-one-map-map-packages)).

Four families:

| Folder | What | The model's origin |
| --- | --- | --- |
| `public/models/props/<type>.glb` | a prop: crate, barrel, tree, wall, car, street lamp… | the bottom center of its footprint |
| `public/models/blocks/<type>.glb` | a block of a robot: armor, cockpit, engine, battery, turret base… | the center of its cell |
| `public/models/heads/<type>.glb` | the head of a turret, which turns and aims | the head's pivot |
| `public/models/wheels/<type>.glb` | a wheel | its hub, the axle along X |

A model is only the look. Collisions, mass, hit points, resistances and behavior stay those of the game's catalogs (`src/shared/catalog/`, also published as data in [`content/catalog.json`](../content/catalog.json): `props`, `blocks`, `wheels`): a block still collides as its cube, a turret head is still hit where its hitbox is, a wheel still rolls on its radius.

## In five steps

1. **Model the piece in meters, around its origin** (see the conventions of [its family](#props)). Keep its size close to what the game expects: the tables below, and the measurements `npm run models` prints.
2. **Export it as glTF Binary**: in Blender, *File → Export → glTF 2.0*, *Format: glTF Binary (.glb)*, *Include: Selected Objects*, *Transform: +Y Up* (the default), *Mesh: Apply Modifiers*, *Normals*, *UVs* if it has textures, *Vertex Colors* if it uses them; *Materials: Export*; no animation. Everything must be in the one `.glb` file (textures embedded).
3. **Save it as `public/models/<family>/<type>.glb`**, where `<type>` is the identifier of the prop, block, turret or wheel: `props/crate.glb`, `blocks/armor.glb`, `heads/cannonTurret.glb`, `wheels/standard.glb`…
4. **Run `npm run models`.** It checks every file of `public/models/`, prints each model's size next to what the game expects (a prop's collision shape, a block's cell, a head's barrel, a wheel's radius), and writes the manifest the game reads (`src/client/render/modelFiles.ts`). A file the game could not read, or a type that cannot have a model, is reported and left out (exit code 1).
5. **Look at it in the game** (`npm run dev`): the Depot has crates and barrels, the Valley trees and houses, the City cars, lamps and facades; the garage shows blocks, heads and wheels up close (its inventory thumbnails too), and every match shows them at work. Then `npm run check`: `tests/models.test.ts` fails if the manifest is not up to date (run `npm run models` again after adding, changing or removing a model).

## Conventions

- **Units and axes.** Meters. **+Y is up.** Blender is Z-up: its exporter's *+Y Up* option turns Blender's +Z into +Y and Blender's −Y (toward you in Blender's front view) into +Z, and keeps +X. So a block or a turret head, whose front is +Z in the game, is modeled **facing Blender's −Y**, toward you in the front view; a car, whose front is +X, faces Blender's +X.
- **Size: as modeled.** A model is drawn at the size it has in the file; the game does not resize it (except the props of shape `slab`, see [Props](#props)).
- **Static meshes only.** The game merges all the meshes of the file, with their node transforms (mirrored nodes included) and their GPU instances (`EXT_mesh_gpu_instancing`), into one mesh, one part per material. Animations, skins, morph targets, cameras and lights are ignored. What moves is moved by the game: a turret head turns and recoils as a whole, a wheel spins around its axle.
- **Light.** A prop is drawn hundreds of times (the City has about 500 props), a block hundreds of times (the 12 robots of the reference battle have 772 blocks, 342 of them armors and wings): a few hundred to a few thousand triangles, one or a few materials (each material is one more draw call per batch), textures of 512 or 1024 px. The example crate has 1,176 vertices and 2 materials, in 44 KB; the example armor block 936 vertices and 2 materials.

### Props

The objects of the scenery: crates, barrels, gas cylinders, walls and roofs, trees, cacti, water towers, storage tanks, cars, wrecks, street lamps.

- **Origin: the bottom center of the footprint.** The game puts the model's origin at the bottom of the collision shape: a crate's origin goes to the bottom of its 1 m box, a tree's to the foot of its trunk. A part may go a little below the origin (the steel feet of the example crate stand 8 mm into the ground). X and Z are the prop's own horizontal axes, which the map rotates with the spot's `yaw`.
- **Size.** Match the [table](#the-props). Trees, lamps and other cylinders may be enlarged by a map spot (`scale`): the model is scaled with them, uniformly. A tree's collision is its trunk only: its foliage is pure look, model it freely.
- **Slabs are stretched.** The props of shape `slab` (walls, roofs, facades, cars, wrecks) take their dimensions from each map spot. For them, the model's bounding box is stretched along each axis to fill the spot's box, whatever the model's origin. The walls drawn by code repeat their texture every meter or so; a stretched model doesn't: a wall model suits panels of one size. Cars and wrecks always have the same size (4.2 × 1.44 × 1.84 m, their length along X): a car model fits them well.
- **Oriented props.** A car or a wreck faces **+X** (its length along X). A street lamp's arm and a floodlight mast's projectors point toward **+X**; the light they cast at night stays where the code puts it (`PROP_LIGHTS`, `src/client/render/lightSources.ts`): for the lamp, 1.15 m toward +X and 6.1 m above the base; for the mast, 0.45 m toward +X and 8.9 m above the base. Put the glass there.

### Blocks

The cubes a robot is built of, 0.5 m on a side: armors and their shapes (wedges, corners, rounds…), the chassis, the cockpit, engines, batteries, turret bases, lights, equipment.

- **Origin: the center of the cell.** The block's cell goes from −0.25 to +0.25 m on each axis around the origin. **+Y is the block's top, +Z its front**: an engine pushes toward its top, a turret's head sits on its top and looks toward its front, a headlight shines toward its top. The game turns the model with the block (a block placed on its side, upside down, facing backward). Neighboring blocks touch: a model that fills its cell joins its neighbors, one that stays inside it leaves a groove between them.
- **It may stick out a little**, but the block still collides as its cube (or as its shape, for a wedge or a corner), and a neighbor may stand right against it.
- **What the game draws in addition stays drawn by the game**, at its place: the turret head (its own family, below), the blades of a rotor or a propeller, a turbojet's nacelle, the flame of an engine (from its nozzle, opposite its thrust), the legs and the glow of a hover pad, the moving part of a melee weapon (a spinner's bar, a hammer's arm, a saw's disc…), the lit glass of a light. A block model replaces the block only: a turret base, the housing of an engine, the base of a light.
- **Not for the wing and the control surface:** the game shapes each cell of a wing from its neighbors (a rounded leading edge, a tapered trailing edge, merged into one piece); `npm run models` refuses them.
- **The robot's color: a material named `paint`.** A block that takes the robot's color (the armors, their shapes, the reactive armor: `tinted` in [`content/catalog.json`](../content/catalog.json)) multiplies the base color of its `paint` material (any case; Blender's copies `paint.001`… too) by the robot's color: keep it white to get the robot's color as is, gray for a darker shade; vertex colors and the texture multiply it as well. The other materials keep their own colors. A block that does not take the robot's color draws its `paint` material as it is.
- **Wear.** A damaged block darkens and scorches, by patches, and blackens with soot; in a match, the game multiplies every color of the block by this tint (its materials, textures and vertex colors alike), so a model wears like a block drawn by code, with nothing to do. Only emission (a glow) does not darken. In the garage and the previews, a block with a model is not darkened (the lower layers in layer view).
- **Picking in the garage** goes through the block's cell (an invisible box), not through the model's shape.

### Turret heads

The part of a turret that turns (in yaw, around the block's up axis) and aims (in pitch); the block under it is the turret's base, a [block](#blocks) model of its own.

- **Origin: the head's pivot**, where its yaw axis meets its pitch axis. The game places it **`TurretSpec.height` m above the center of the block** (the *axis* column of the [table](#the-turret-heads); 0.25 m: the top face of the block), and turns the model around it. **The barrel points toward +Z.**
- **The muzzle is `TurretSpec.barrel` m in front of the pivot** (the *muzzle* column): the shot leaves from there, the muzzle flash and the smoke appear there, and the hitbox of the barrel ends there. End the barrel at that point, at the pivot's height (a head with several barrels: their mouths around that point). `npm run models` prints how far forward the model goes next to it.
- **Hitbox.** A head is hit within a box of about its *head* size (90 % of it) centered on the pivot, and its barrel within a capsule of its caliber up to the muzzle: keep the model close to them, or shots will go through parts of it, or hit air next to it.
- **Recoil:** the game moves the whole head back along its barrel when it fires, and brings it back.
- **Visible rounds.** The missile launchers, the anti-air launcher, the rocket pod, the lock-on launcher, the warhead launcher, the bomb bay and the smoke launcher show their rounds on the head (the missiles in their tubes, the bombs under the rack), and take them away as the magazine empties. The game draws these rounds itself, at the places of the head it draws (in the head's frame: the mouths of its tubes, `GUIDED_ROUNDS` and `DIRECT_ROUNDS` in `src/client/render/models/`): for the rounds to sit in your tubes, put your tubes where the game's are, open at the front. The places, in meters (x, y, z), each round pointing toward +Z: missile launcher (±0.1, ±0.08, 0.47); anti-air (±0.15, 0, 0.48); rocket pod (0 and ±0.15, ±0.075, 0.445); lock-on launcher (0 and ±0.15, −0.04, 0.47); warhead launcher (0, 0.02, 0.63); bomb bay (±0.1, −0.1, 0), the bombs hanging under the rack; smoke launcher (±0.065, 0.078 and −0.038, 0.4).
- **Fixed turrets.** A mine layer's head drops its mines backward: the game turns it half a turn in a match, but not in the garage, so make it the same front and back (the game's is a drum). A bomb bay's head is the rack under the block (its pivot 0.3 m below the block's center), with no barrel.

### Wheels

- **Origin: the hub. The axle is along X**: the game spins the wheel around X, and steers it around Y. **Radius and width:** those of the catalog (the [table](#the-wheels)); the suspension and the ground contact use the catalog's radius whatever the model.
- **Symmetric:** the same model is mounted on the left and on the right of the robot (it is not mirrored): make it the same on both sides of the plane X = 0 (a rim and a hub on each side).
- **Each type its own file:** a steered wheel (`steered`, `smallSteered`, `heavySteered`) does not take the model of its fixed counterpart; the game draws the steered wheels with an orange rim, to tell them apart at a glance. The fork of a caster, the bracket and the steering arm stay drawn by the game.
- **Not for track rollers:** a track's belt, its shoes and its sprocket are drawn around the game's rollers; `npm run models` refuses `track`.

## Materials

The game converts each material of the file to its own standard material, so that a model is lit exactly like the pieces drawn by code (sun, sky, the clustered lights of the night) without compiling the PBR shaders. What it keeps:

- the **base color**: its factor, its texture (sRGB) and the vertex colors (`COLOR_0`), multiplied together;
- the **emission**: its factor, its strength (`KHR_materials_emissive_strength`) and its texture;
- the **opacity**: alpha blending or alpha masking (with its cutoff), from the factor or the base color texture;
- **double-sided** materials, and **unlit** ones (`KHR_materials_unlit`);
- **roughness and metallic** become a specular highlight, sharper on a smooth material, tinted by the base color on a metal.

Normal maps, metallic-roughness textures and occlusion textures are ignored: bake their detail into the base color (vertex colors work well for the game's look).

Names that have a meaning:

- **`glass`** (props; any case, Blender's copies `glass.001`… too) is the glass of a lamp: **it lights up at night**, with the color of the lamp's light for a street lamp or a floodlight, with its own base color for any other prop. Use it only for lamp glass: give car windows another name.
- **`paint`** (blocks) takes the robot's color, on a block that takes it (see [Blocks](#blocks)).
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

## The blocks

Every block type of [`content/catalog.json`](../content/catalog.json) (`blocks`: its names, whether it is `tinted`) can have a model, except the wing and the control surface (`wing`, `flap`: those with `wing`). `npm run models` lists the types when it does not know a file's name. Their cell is the same for all: 0.5 m, from −0.25 to +0.25 m around the origin.

## The turret heads

From the catalog (`blocks.<type>.turret`): the head's size (width × height × depth, m, centered on the pivot: its hitbox), the muzzle (m in front of the pivot along +Z) and the axis (the pivot's height above the block's center, m).

| Type | Name | Head | Muzzle | Axis |
| --- | --- | --- | --- | --- |
| `gunTurret` | Machine gun turret | 0.32 × 0.22 × 0.34 | 0.6 | 0.35 |
| `sniperTurret` | Sniper turret | 0.28 × 0.24 × 0.4 | 0.95 | 0.35 |
| `cannonTurret` | Cannon turret | 0.46 × 0.3 × 0.5 | 0.85 | 0.4 |
| `missileLauncher` | Missile launcher | 0.46 × 0.34 × 0.5 | 0.5 | 0.4 |
| `flakLauncher` | Anti-air missile launcher | 0.4 × 0.26 × 0.42 | 0.5 | 0.4 |
| `mineLayer` | Mine layer | 0.36 × 0.16 × 0.2 | 0.45 | 0.25 |
| `empMineLayer` | EMP mine layer | 0.36 × 0.16 × 0.2 | 0.45 | 0.25 |
| `fireMineLayer` | Incendiary mine layer | 0.36 × 0.16 × 0.2 | 0.45 | 0.25 |
| `smokeMineLayer` | Smoke mine layer | 0.36 × 0.16 × 0.2 | 0.45 | 0.25 |
| `bounceMineLayer` | Bouncing mine layer | 0.36 × 0.16 × 0.2 | 0.45 | 0.25 |
| `aaMineLayer` | Anti-air mine layer | 0.36 × 0.2 × 0.2 | 0.45 | 0.25 |
| `remoteMineLayer` | Remote mine layer | 0.36 × 0.16 × 0.2 | 0.45 | 0.25 |
| `sensorMineLayer` | Sensor layer | 0.3 × 0.14 × 0.2 | 0.45 | 0.25 |
| `stickyMineLayer` | Sticky mine layer | 0.36 × 0.16 × 0.2 | 0.45 | 0.25 |
| `repairTurret` | Repair turret | 0.32 × 0.24 × 0.36 | 0.5 | 0.35 |
| `naniteLauncher` | Nanite launcher | 0.34 × 0.26 × 0.32 | 0.35 | 0.3 |
| `barrierProjector` | Barrier projector | 0.46 × 0.2 × 0.34 | 0.4 | 0.3 |
| `bombBay` | Bomb bay | 0.36 × 0.1 × 0.42 | — | −0.3 |
| `flamerTurret` | Flamethrower | 0.34 × 0.24 × 0.36 | 0.5 | 0.3 |
| `empTurret` | EMP cannon | 0.4 × 0.3 × 0.44 | 0.7 | 0.4 |
| `smokeLauncher` | Smoke launcher | 0.36 × 0.2 × 0.3 | 0.4 | 0.35 |
| `laserTurret` | Laser turret | 0.3 × 0.22 × 0.36 | 0.55 | 0.35 |
| `railTurret` | Railgun | 0.42 × 0.26 × 0.56 | 1.1 | 0.4 |
| `shotgunTurret` | Shotgun | 0.36 × 0.24 × 0.36 | 0.55 | 0.35 |
| `rocketPod` | Rocket pod | 0.5 × 0.36 × 0.46 | 0.45 | 0.4 |
| `warheadLauncher` | Warhead launcher | 0.5 × 0.4 × 0.56 | 0.7 | 0.45 |
| `lockonLauncher` | Lock-on missile launcher | 0.5 × 0.3 × 0.46 | 0.5 | 0.4 |
| `plasmaTurret` | Plasma projector | 0.34 × 0.26 × 0.4 | 0.5 | 0.35 |

## The wheels

From the catalog (`wheels`): radius and width in meters.

| Type | Name | Kind | Radius | Width |
| --- | --- | --- | --- | --- |
| `standard` | Fixed wheel | fixed | 0.55 | 0.3 |
| `steered` | Steered wheel | steered | 0.55 | 0.3 |
| `small` | Small wheel | fixed | 0.3 | 0.2 |
| `smallSteered` | Small steered wheel | steered | 0.3 | 0.2 |
| `heavy` | Heavy wheel | fixed | 0.75 | 0.45 |
| `heavySteered` | Heavy steered wheel | steered | 0.75 | 0.45 |
| `caster` | Caster | caster | 0.22 | 0.14 |

## How the game loads a model

- The manifest (`src/client/render/modelFiles.ts`, written by `npm run models`) lists the files of each family and a hash of each: the game knows which pieces have a model without asking the network, and a changed file is not served from the browser's cache.
- The glTF reader (Babylon's `@babylonjs/loaders`) is loaded only when the first model is needed, as a separate chunk: the main bundle does not grow, and a game without models never loads it.
- Each file is read once per scene (the game, the garage, the robot picker's preview, the inventory thumbnails, the map editor), the first time a piece of its type is needed. Until then the piece shows its model drawn by code; then the model takes its place, everywhere at once (its instances and its batches follow; an inventory thumbnail waits for it). A file the game cannot read leaves the model drawn by code, with a warning in the browser's console.

## A model for one map (map packages)

A prop model can also belong to **one map** rather than to the game: a [map package](maps.md#map-packages) carries it as `models/props/<type>.glb`, and on that map (in the game, online, in the map editor) it replaces the game's model of that prop type, whether the game has a glTF model for it or draws it by code. The conventions are those of the props above, and the checks those of `npm run models` (made by the same code, `src/shared/media/glb.ts`): one self-contained `.glb`, only the glTF extensions the game reads, at most 4 MB per model and 16 MB for all of a map's. Only props: a package can't change a block, a turret head or a wheel (they belong to the robots, which travel from one map to another).

Such a model is read like the game's, once per scene, but its bytes come from the map: from the browser's library (an imported package), or from the game server that sent the map (`/map-assets/<sha256>`); its source and its materials are apart from those of the game's model (another map, another model for the same type). Until it is read, the prop shows its model drawn by code; a model that can't be read leaves the game's.

## The examples

The crate shipped in `public/models/props/crate.glb` (a frame of beams, planks of varied shades in vertex colors, diagonal braces, steel corner caps; two materials, `wood` and `steel`) is made from code, the way one would make it in Blender: `tools/models/crate.ts` builds it out of boxes (`tools/models/builder.ts`), `tools/models/glb.ts` writes it (a dependency-free `.glb` writer and checker), and `npm run models -- example` regenerates it. To try your own crate, overwrite the file and run `npm run models`.

Three more examples show the conventions of the other families (`tools/models/parts.ts`): an armor block (`blocks/armor.glb`: a riveted plate on each face, steel corners; its `paint` material takes the robot's color), a cannon head (`heads/cannonTurret.glb`: its barrel ends at the muzzle, 0.85 m in front of the pivot) and a fixed wheel (`wheels/standard.glb`: symmetric, its axle along X). They are not shipped with the game (the models drawn by code look better in it); `npm run models -- example all` writes them to `public/models/` to try them in the game (remove them, then run `npm run models` again).

## Licensing your model

The game's code is licensed under the AGPL-3.0-or-later; a model is content: contribute it under a free license, CC0 or CC BY preferably, and say which one in your pull request. You may leave a credits file next to it (`public/models/props/crate.txt` or `.md`): `npm run models` ignores those, and they are published with the game.
