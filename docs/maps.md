# Making a map for Casse-Robot

A **community map** is a JSON file (`.casse-map.json`): terrain, game elements (buildings, trees, rocks, low walls, bridges…), capture zones, spawn lines. The game checks it, then plays it like its own arenas: the AI moves around it, the minimap draws it, the multiplayer server puts it in its rotation and sends it to players who don't have it.

A map is made **in the game, with the map editor** (main menu → **Map editor**): you import and sculpt the terrain, place the elements, set up the map, see its problems and test it against the AI, without touching the JSON (see [The editor](#the-editor)). It can also be written by hand or with a script: this guide describes the format field by field, importing terrain from common terrain tools, the limits, how to test a map and how to submit it to the game.

- [The editor](#the-editor)
- [Quick start](#quick-start)
- [Coordinates and units](#coordinates-and-units)
- [The format, field by field](#the-format-field-by-field)
- [Importing terrain](#importing-terrain)
- [Limits and checks](#limits-and-checks)
- [Level design tips](#level-design-tips)
- [Testing your map](#testing-your-map)
- [Submitting your map to the game](#submitting-your-map-to-the-game)
- [The game's arenas as maps](#the-games-arenas-as-maps)
- [Map packages](#map-packages)
- [For developers](#for-developers)

## The editor

**Main menu → Map editor**: the editor reopens the current draft (otherwise a blank map). From **Play → a mode → Community maps…**, **New map** opens a blank one, and **Edit** opens a map from the library. What you see is what you'll play: the terrain, the water, the lava, the buildings, the trees and the props with the game's rendering; on top of that, the play area (in yellow), the AI roaming area (in light blue), the invisible limit (in red), both teams' spawn lines, the zones, the named places and the map's problems (a red exclamation mark, where they are).

**The view:** right-drag to orbit, middle-drag (or Shift + right-drag) to pan, the wheel to zoom, WASD (ZQSD on AZERTY) to move; **T** toggles the top view (north up, west on the left, like the game's map), **F** frames the selection (or the whole map). All these keys can be changed in **Settings → Controls**, "Map editor" section; the **Controls** button, at the bottom of the editor, lists them.

**The tools** (the left bar, keys 1 to 7):

1. **Select:** a click picks an element (a wall panel picks its house, a tree its woods), Shift + click adds it to the selection; dragging moves it along the ground. **R** and **Shift + R** turn it by 15°, **Ctrl + D** duplicates it, **Delete** removes it. The right panel shows its properties: each field of its type, within its bounds ("auto": the default value). The points of a trace (path, fence, lava flow, bridge) move by their handles. A **spawn line** moves by dragging it, and turns by the ball of its color, at the end of its arrow (see [`spawns`](#spawn-lines-spawns)).
2. **Terrain:** five brushes (raise, dig, smooth, flatten to a height, flatten to the clicked height), their radius (**[** and **]**) and their strength; the terrain redraws while you paint. **Import an image…** takes an 8- or 16-bit PNG, a 16-bit RAW or any image, with its settings (terrain size, grid step, heights of black and white, smoothing, mountains at the edge); **Flat terrain** starts over from flat ground surrounded by mountains.
3. **Place:** the palette, in four tabs (prefabs, props, scenery, markers) and a search (**/**). A click on the terrain places the chosen element; its ghost is green if it can be placed, red otherwise (off the map, too many elements, already five zones). **R** turns what you place, **G** turns on the grid and snapping (a step of 1 to 10 m; a spawn line's arrow then snaps to 15°). Scenery can take a look other than its kind's own (sandstone, timber, quay concrete…).
4. **Traces:** a path (with its surface), a fence, a lava flow, a bridge: one click per point, **Enter** to finish, **Backspace** to remove the last point, **Esc** to cancel. A bridge is made from its two ends (for the AI, along the north-south or east-west axis, its ends at deck height).
5. **Water and lava:** the water level (you see it live), deep water (where you drown) and its color; **Level here** sets the water to the height of the clicked point; **Place a lava lake** places a disc of lava with one click.
6. **Settings:** the name, the author, the license, the description (and in each language), the play dimensions and the limits, the sky, the ground palette (that of one of the game's arenas), the ambient sound, the city (`urban`), the AI's nav grid, the free spawn lines.
7. **File:** new map (name, license, size of the play area), open a map from the library or a file, save, export the map (`.casse-map.json`) and its terrain (16-bit PNG, to take back into a terrain tool).

**Undo, redo:** **Ctrl + Z**, **Ctrl + Y** (or Ctrl + Shift + Z), for any change; a brush stroke counts as one.

**Problems:** the map is checked again after each change (as the game and the server check it), without freezing the editor. The indicator at the top says whether it's playable; the list, at the bottom right (**I**), gives each problem, and a click on one takes the view there (and picks the element at fault).

**Test:** **P** (or the **Test** button) starts a match against the AI on the draft, in the chosen mode (the last one first) and with the chosen robot. The pause menu, or the end of the match, offers **Back to the editor**: you find everything as you left it (the draft, the view, the tool, the undo history). A map that has problems doesn't start: the list opens.

**Save:** **Ctrl + S** keeps the map in the browser's library (it must be playable); it replaces its previous version, and is playable right away under **Play**. A map that ships with the game (or was received from a server) is saved as a copy ("Lake Vale (copy)"). The **draft** is kept automatically at each change: reloading the page loses nothing, and the editor reopens it. **Esc** (with nothing in progress) or **Leave** asks what to do with the unsaved changes: save them, keep the draft for later, or discard them.

To submit the map to the game, export it (**File → Export the map**) and follow [Submitting your map to the game](#submitting-your-map-to-the-game).

## Quick start

1. Start from the example: `maps/val-du-lac.casse-map.json` (a lake, a river and its old bridge, a village, a farm, a ruin, a hill; five zones). Its source terrain is `tools/maps/val-du-lac.png`, and the script that made it, `tools/maps/example.ts`.
2. Make your terrain in your favorite tool (Gaea, World Machine, Blender…) and export it as a 16-bit grayscale PNG (see [Importing terrain](#importing-terrain)), then:

   ```bash
   npm run map:terrain -- mon-relief.png --cells 160 --step 2 --low 0 --high 30 --mountains 108,38 --into maps/ma-carte.casse-map.json --name "My map" --author "Me" --half 100
   ```

   The file is created (or, if it exists, its terrain is replaced): a playable map, with three zones and default spawn lines, ready to fill in.
3. Add your elements to the file (`boxes`, `props`, `prefabs`, `zones`, `places`…), then check it:

   ```bash
   npm run map:check -- maps/ma-carte.casse-map.json
   ```

4. Play it: `npm run dev`, then **Play → Battle → My map** (the files in `maps/` ship with the game; in development, the page reloads when you save). Or, without installing anything, in the online game: **Play → a mode → Community maps… → Import a map…** (the map is kept in the browser).

## Coordinates and units

- **Meters and degrees.** The center of the map is the origin; **north = +z, west = +x, up = +y** (a robot facing north has west on its left). The minimap and the full map (M) show north up and west on the left; a terrain image reads the same way (its top to the north, its left to the west).
- The **reds** start from the north (+z), the **blues** from the south (-z), except with [free spawn lines](#spawn-lines-spawns). A fair map is symmetric about the east-west axis (z → -z) or about the center.
- **Rotations** (`yaw`, `pitch`, `roll`, in degrees): yaw turns around the vertical (90 turns north toward west), then pitch around x, then roll around z. A box or a prop can also have `quat`, an exact orientation as a unit quaternion `[x, y, z, w]` (the export of the game's arenas writes one when degrees don't give a rotation back to the bit); `yaw`, `pitch` and `roll` then turn it further (that's how the editor turns such an element).
- A point on the plane is written `[x, z]`; dimensions, `[largeur (x), hauteur (y), profondeur (z)]` (width, height, depth).
- **Heights:** without `y`, an element is **placed on the ground** (the terrain); with `y`, at that (absolute) height. For a prop and a building, `y` is the height of its **base**; for a scenery box, that of its **center**.

## The format, field by field

A minimal map:

```json
{
  "format": 1,
  "meta": { "name": "My map", "author": "Me", "license": "CC-BY-4.0" },
  "bounds": { "half": 60 },
  "zones": [{ "label": "A", "x": 0, "z": 0, "radius": 6 }]
}
```

All other fields are optional. Unknown fields are ignored.

### The JSON Schema: autocompletion and checking in your editor

The format is also published as a [JSON Schema](https://json-schema.org/) (draft 2020-12): [`schemas/map.schema.json`](../schemas/map.schema.json). It is generated from the game's code (its catalogs and the bounds the game reads a map with), so it always lists what the game accepts: the prop types, box kinds and looks, prefab kinds, path surfaces, ground presets, ambiences, zone letters, and the bounds and lengths of every field. Reference it at the top of your map, and your editor (VS Code, the JetBrains IDEs, any editor with a JSON language server) completes the field names, lists the allowed values, shows each field's description and underlines what's wrong while you type:

```json
{
  "$schema": "https://raw.githubusercontent.com/Wasabules/casse-robot/main/schemas/map.schema.json",
  "format": 1,
  "meta": { "name": "My map", "author": "Me", "license": "CC-BY-4.0" },
  "bounds": { "half": 60 },
  "zones": [{ "label": "A", "x": 0, "z": 0, "radius": 6 }]
}
```

The game ignores the `$schema` key: with or without it, it's the same map, with the same identifier (the server and the players' caches see no difference). Any JSON Schema validator can check a map with it, from a script or another tool (`jsonschema` in Python, `ajv` in JavaScript…).

A schema only says what a schema can say: types, required fields, bounds, lengths, allowed values. The game checks more (see [Limits and checks](#limits-and-checks)): the terrain's data and coverage, consistent dimensions, zones with different letters that the AI reaches, clear and safe spawn lines, the counts once the prefabs are unfolded. `npm run map:check` has the last word.

A robot design (the blocks and wheels the garage saves) has its schema too: [`schemas/robot.schema.json`](../schemas/robot.schema.json). The numbers of the game's elements (the props' shapes, masses and hit points, the blocks, the weapons…) are published as data in [`content/catalog.json`](../content/catalog.json), with [its schema](../content/catalog.schema.json).

### `format` and `meta`

| Field | | |
|---|---|---|
| `format` | required | The format version: `1`. A map from an older version is migrated when it's read; a newer one is rejected (you need to update the game). |
| `meta.name` | required | The map's name (at most 48 characters). Shown as is, in every language. |
| `meta.names` | | The name in other languages: `{ "en": "Lake Vale" }` (ISO 639-1 codes, at most 8 languages). |
| `meta.author` | required | Who made it (48 characters). |
| `meta.description`, `meta.descriptions` | | A sentence for the menu (400 characters), and per language. |
| `meta.license` | required | The map's license: an SPDX identifier (`CC-BY-4.0`, `CC0-1.0`, `CC-BY-SA-4.0`…). A map submitted to the repository must have a free license. |

### `terrain`: the terrain

A square grid of heights, centered on the origin. Without `terrain`, the map is flat (ground at y = 0).

| Field | | |
|---|---|---|
| `cells` | 16 to 440 | Cells per side (there are `cells + 1` vertices per side). |
| `step` | 1, 1.25 or 2 | Grid step (m). The terrain is `cells × step` m per side, **440 m at most**. Steps that are exact in binary: at 1.375 m, physics rays slipped between the terrain's triangles; 1.25 is the Volcanic Island's. |
| `min`, `max` | 0 to 250 | Heights (m) of the lowest and highest code. |
| `heights` | | The heights, coded from 0 (`min`) to 65,535 (`max`) as **little-endian** Uint16, encoded in **base64**. Order: one column per x, from east (-x) to west (+x), and within each column increasing z (south to north): the index of vertex (ix, iz) is `ix × (cells + 1) + iz`. |

Don't write it by hand: `npm run map:terrain` makes it from an image (see [Importing terrain](#importing-terrain)). The terrain must cover the play area and the invisible limit (`limits.bound`); beyond its edge, the world is empty.

### `bounds`: the play dimensions

| Field | Default | |
|---|---|---|
| `half` | required (20 to 200) | Half-side of the play area (m): the play area runs from -`half` to +`half` in x and in z. The aircraft autopilot brings the player's plane back into it. |
| `roam` | 86% of `half` | Where the AI picks its random destinations. |
| `spawnLine` | 80% of `half` | Distance from the center to the spawn lines (reds to the north, blues to the south; no effect with [free lines](#spawn-lines-spawns)). |
| `spawnSpread` | 30% of `half` (30 at most) | Half-width of the spawn lines (from -`spawnSpread` to +`spawnSpread` in x). |
| `circuit` | 70% of `half` | Radius of the aircraft circuit. |
| `airFloor` | the highest scenery + 4 m | Altitude (above the terrain) below which the AI doesn't fly its planes. |
| `hoverFloor` | 0 | Floor altitude of the AI's flying robots (a city's rooftops). |

### `limits`: the edges

| Field | Default | |
|---|---|---|
| `walls` | `false` | Visible perimeter walls at ±`half` (like the small arenas), that follow the terrain. |
| `bound` | `half` + 35 m (within the terrain) | An invisible limit at ±`bound` m, reaching at least 110 m high: nothing leaves the map, not even a robot that flies off. `0`: none. Put it at the back of the mountains along the edge. |

### Atmosphere: `sky`, `ground`, `ambience`

- `sky`: `{ "color": "#bfd0db", "fog": 0.0045, "dust": 0, "night": false }`: color of the sky and the fog, fog density (0 to 0.05), dust in the air (grains per second: a ruined city), and night (`"night": true`: the moon instead of the sun, a starry sky, the `lamppost` lampposts and the `floodlight` floodlight masts lit, the robots' headlights and beacons too; then pick a dark sky, like City by Night: `"color": "#141b2b"`, `"fog": 0.0095`). By default, the Valley's sky.
- `ground`: the ground palette (`#rrggbb` colors). `preset` starts from that of one of the game's arenas (`valley` by default, `canyon`, `island`, `city`, `port`), and each field changes it: `base` (the two tints of the ground, mixed by noise), `dirt` (patches and paths), `sand` (banks), `mud` (bottom of the water), `rock` (steep slopes and heights), `peak` (summits: snow, ash), `rockLine` and `peakLine` (heights where rock and summit begin, m), `rockSpan`, `beach` (width of the beach, m of height), `basalt` and `basaltWidth` (solidified ground around lava), `strata` and `strataStep` (color bands of the cliffs), `patches` (patches: `[{ "x", "z", "r", "color" }]`), `grain` (pattern size, m), `stains` (share of dirt patches), `slope` (`{ "color", "from", "span" }`: the tint of slopes), `lawn` (grass paths).
- `ambience`: the ambient sound of one of the game's arenas (`valley` by default; `depot`, `fort`, `trenches`, `yard`, `canyon`, `island`, `city`, `port`).

### Water, lava, vents, waterfalls

- `water`: `{ "level": 2, "deep": 1.2, "color": "#2b8a9c" }`. Water is drawn wherever the terrain is below `level` (m); you can cross it on foot and on wheels. Beyond `deep` m of depth, it's **deep**: you drown in it, the AI doesn't venture there, hover pads glide over it. Without `deep`, you can cross it everywhere.
- `lava`: a list of shapes. A flow `{ "kind": "flow", "width": 7, "points": [[x, z], …] }`, a lake `{ "kind": "pool", "x", "z", "r" }`. Its surface is the terrain (dig it a little underneath); it burns whatever stands in it, the AI avoids it.
- `vents`: fumaroles `{ "x", "z", "y"?, "size": 0.2–6, "steam"? }` (white steam if `steam`).
- `falls`: waterfalls `{ "x", "z", "top", "bottom", "width", "dir" }` (`dir`: where the water falls, in degrees: 0 toward north, 90 toward west).
- `paths`: paths drawn on the terrain `{ "width", "points": [[x, z], …], "surface"? }`; surfaces: `dirt` (dirt, by default), `grass`, `sand`, `road` (gravel road), `gravel` (gravel walk), `ballast`, `asphalt`. You drive on them like anywhere else; scattered woods avoid them.

### `boxes`: the static scenery

Indestructible boxes: `{ "kind", "x", "z", "y"?, "size": [l, h, p], "yaw"?, "pitch"?, "roll"?, "quat"?, "look"?, "round"?, "underpass"?, "approach"? }` (`[l, h, p]`: width, height, depth; each up to 440 m, from one edge of the map to the other).

| `kind` | |
|---|---|
| `wall` | Perimeter wall. |
| `pillar` | Pillar (you take cover behind it). |
| `platform` | Platform (you climb onto it). |
| `barrier` | Low wall, sandbags (you take cover behind it). |
| `rock` | Rock: a dented ball inscribed in the box; without `y`, half buried. |
| `container` | Container. |
| `deck` | Deck (you drive on it): a bridge, a pontoon. A deck connected to the ground at both ends is a bridge for the AI. |
| `road`, `track` | A road, a railway, flush with the ground (without `y`, laid on the ground). |
| `ramp` | A sloped slab; prefer the `ramp` prefab, which makes it solid down to the ground. |
| `tower` | A building that can't be destroyed (facade with windows). |
| `bound` | An invisible limit. |

`look` changes the appearance: `sandstone`, `timber`, `rail`, `wagon`, `wood`, `basalt`, `rust`, `quay`, `steel`, `hull`, `superstructure`, `hatch`, `funnel`, `lighthouse`, `lamp`, `silo`, `container`. `round`: an upright cylinder inscribed in the box (a silo, a lighthouse). `underpass`: a deck you pass under (an elevated road), `approach`: where to approach it beyond its ends (m).

### `props`: the props

What breaks, burns, explodes or falls: `{ "type", "x", "z", "y"?, "yaw"?, "pitch"?, "roll"?, "quat"?, "size"?, "scale"?, "rests"?, "group"?, "diamond"?, "centered"? }`.

| `type` | Shape | |
|---|---|---|
| `crate`, `barrel`, `gas` | crate, cylinders | **Movable**: you push them; the barrel and the gas cylinder explode. |
| `car` | slab (4.2 × 1.45 × 1.85 m by default) | Movable; when wrecked, it burns then explodes. |
| `wreck` | slab (like `car`) | A burnt-out carcass, anchored. |
| `brick`, `concrete`, `plank`, `sheet`, `roof`, `facade`, `tenement` | slab (`size` required) | Wall panels, roofs, floors: anchored; they fall in pieces. Wood (`plank`, `roof`) burns. |
| `pine`, `oak`, `palm`, `kapok` | cylinder (`scale`) | Trees: they topple, burn. |
| `cactus`, `lamppost`, `floodlight`, `watertank`, `tank` | cylinder (`scale`) | The storage tank (`tank`) explodes and sets off its neighbors. At night (`sky.night`), the lamppost and the floodlight mast (9 m, its floodlights along its `yaw`, like the lamppost's arm) give light; knocked over or broken, they go out. |

`scale` enlarges a cylinder or a crate (0.2 to 4). A movable prop is placed slightly above the ground (it settles onto it); an anchored prop, at the lowest ground under it. `rests`: the props (their **indices** in `props`) it rests on (a roof on its walls: when they're all gone, it falls); `group`: a building number (the AI goes around a building as one piece). `diamond`: a slab set on its corner (a gable under a pitched roof), whose texture the renderer straightens. `centered`: `y` is the height of the prop's **center**, like a box's, rather than of its base (the export of the game's arenas uses it when no base height gives the center back exactly: base + half-height is rounded). A prop with any orientation, even `quat: [0, 0, 0, 1]`, counts as turned for the spawn clearance checks; one with none, as upright.

### `prefabs`: prefabricated elements

A few fields that unfold into props and boxes. All have `kind`; those that have `x`, `z` accept `yaw` (degrees) and, unless stated otherwise, `y` (the building's floor; without it, the lowest ground under its footprint).

| `kind` | Fields | |
|---|---|---|
| `house` | `width`, `depth`, `height`, `wall` (`brick`, `concrete`, `plank`, `sheet`), `roof` (`roof`, `sheet`, `concrete`, `plank`), `roofKind` (`gable` by default, or `flat`), `door` (width of the opening, m), `through` | A house, a hangar: four walls in panels, a gable roof (the ridge along `width`) or a flat one. The opening is in the middle of the long front side (to the south before rotation); `through` repeats it at the back (you drive through the hangar). |
| `tenement` | `width`, `depth`, `floors` (1 to 8), `wall` (`facade`, `tenement`, `brick`, `concrete`), `doors` (`[["s", 0], …]`: side before rotation, `n`, `s`, `w`, `e`, and panel index), `ruin` (0 to 1), `seed` | An apartment block: one facade panel per floor, a flat roof; a ruin has lost the top of a few columns. It collapses floor by floor. |
| `fence` | `points` (polyline), `height`, `material` | A fence or a low wall, in panels of 2.5 m at most. |
| `woods` | `radius`, `count` (200 at most), `trees` (`pine`, `oak`, `palm`, `kapok`, `cactus`), `scale` (`[min, max]`), `spacing` (m), `seed` | A wood: trees scattered in a disc, away from paths, zones, spawn lines, water, lava and scenery. No `y` or `yaw`. |
| `rocks` | `radius`, `count`, `size` (`[min, max]`), `look` (`sandstone`, `basalt`), `seed` | Rocks scattered in a disc. |
| `ramp` | `width`, `length`, `rise`, `base` (no `y`) | A ramp that climbs `rise` m over `length` m toward its front (north before rotation), from `base` (the ground at its foot). |
| `bridge` | `from`, `to` (`[x, z]`), `width`, `y` (the top of the deck; without it, the highest ground at its ends), `parapets` (yes by default), `piers` (number of piers), `look` | A bridge. For the AI, make it **along the north-south or east-west axis**, and set both its ends on ground at deck height (within a meter). |
| `containers` | `count` (12 at most), `levels` (4 at most) | A row of containers, possibly stacked. |

The same `seed` always gives the same wood: the map is data, the same everywhere.

### `zones` and `places`

- `zones`: **one to five** capture zones `{ "label": "A"…"E", "x", "z", "y"?, "radius": 2–30 }`, with different letters, inside the play area. Without `y`, on the ground; on a bridge or a platform, give the height of its top. They're used in Zone Capture and King of the Hill; the AI goes to take them.
- `places`: named places for the full map (M) `{ "name", "names"?, "x", "z" }` (32 characters, 24 places at most). Instead of `name`, `place` takes one of the places of the game's arenas, shown in the player's language: `village`, `fort`, `factory`, `airfield`, `bridge`, `station`, `square`, `park`, `harbourOffice`… (the list is in the JSON Schema).

### Spawn lines: `spawns`

By default, the reds start from a line in the north and the blues from a line in the south (`bounds.spawnLine`, `bounds.spawnSpread`). `spawns` puts them wherever you want, each with its middle, the direction the team faces when starting and its length:

```json
"spawns": {
  "blue": { "x": 60, "z": 0, "facing": -90, "width": 30 },
  "red": { "x": -60, "z": 0, "facing": 90, "width": 30 }
}
```

| Field | | |
|---|---|---|
| `x`, `z` | | The middle of the line (m). |
| `facing` | degrees | Where the team faces when starting: 0 toward north, 90 toward west, -90 toward east, 180 toward south. The line runs crosswise. |
| `width` | 4 to 160 m | Its length. |

Both teams together (one without the other is rejected). Robots line up on them facing `facing` and respawn there; aircraft appear on their circuit on the side of their line; scattered woods and rocks avoid them. The game checks that each line fits inside the play area (2 m from the edge), that it's clear and safe (like the north and south ones), and that the two lines are at least 24 m apart. In the editor: **Settings → Spawn lines: Placed freely**, then each line's handles.

### `urban` and `nav`

- `urban`: `true` for a city (buildings cover a good share of the ground): the AI doesn't take a point inside a building as a destination, it goes as close as it can in the street.
- `nav`: the **AI's nav grid**, computed automatically on a map that has terrain, deep water or lava: cells of `cell` m (2.5 by default, 2 to 6), closed if the slope exceeds `maxSlope` degrees (26 by default), or in lava or deep water. Only the largest connected region stays open. `false`: no grid (the AI goes straight).
- `navGraph`: the **AI's nav graph**, the other way to find routes, for a map that its terrain cuts up (the Canyon: cliffs, trails, a viaduct, an arch): `{ "points": [[x, z], …], "links": [[i, j], …] }`, points (1,024 at most) and the links between them (indices in `points`, both ways; 8,192 at most). When the straight line to its destination isn't passable, a ground robot follows the shortest path in the graph. The game takes the links as given: it doesn't look for the passable ones itself (the Canyon's file has those the game computed on its terrain, plus the two across the void). A map with a graph has no nav grid, unless it asks for one with `nav`.

## Importing terrain

`npm run map:terrain -- <fichier> --cells N --step S --low L --high H [options]` (`<fichier>`: the file) reads terrain and writes it into a map (`--into`, created if it doesn't exist). The image covers **the whole terrain** (its side is `cells × step` m); it's resampled to the map's step.

| Option | |
|---|---|
| `--cells`, `--step` | Terrain size: `--cells 160 --step 2` makes 320 m per side. |
| `--low`, `--high` | Height of black and of white (m): the vertical scale. Keep slopes playable (26° at most for the AI): a 2 km terrain imported over 320 m must be flattened accordingly. |
| `--mountains DEPUIS,HAUTEUR` | Raises the edge into impassable mountains (`DEPUIS`: from, `HAUTEUR`: height): from `DEPUIS` m from the center (in "square" distance, like the play area) out to the edge of the terrain, `HAUTEUR` m high. Then put the invisible limit (`limits.bound`) in those mountains. |
| `--smooth R` | Smoothing (radius in pixels); by default 2 for an 8-bit image (without it, its 256 levels make steps), none for 16 bits. |
| `--big-endian` | A big-endian 16-bit RAW ("Mac" in Unity). |
| `--name`, `--author`, `--half` | For a new map. |

Formats read: **16-bit grayscale PNG** (the best), 8-bit PNG, color or palette PNG (the average of the channels), **square 16-bit RAW** (`.r16`, `.raw`, little-endian by default). No interlaced PNG. 4,097 pixels per side at most. In the browser (soon the editor), any image the browser can read works too, reduced to 8 bits.

The image reads like the map: **top to the north, left to the west**.

### From terrain tools

- **Gaea**: an *Export* (or *Build*) node in **16-bit PNG** format (*Grayscale 16*). Set the terrain size and height in Gaea, then carry the vertical scale over to the import (`--low`, `--high`): Gaea normalizes height between 0 and 1.
- **World Machine**: a *Height Output* in **16-bit PNG** or **RAW16** format (*Normalized*: from the lowest to the highest point of the terrain). Note the project's minimum and maximum heights for `--low` and `--high`.
- **Blender**: sculpt a plane, then bake (*Bake*) its height into a grayscale image, or render it from above (orthographic camera) with a material whose color is the height; save as **PNG, BW, 16 bits**. The *A.N.T. Landscape* add-on gives you terrain quickly.
- **terrain.party** and real elevation maps: you get 16-bit PNGs of a region (often several kilometers): choose a modest vertical scale, real terrain is far too steep once brought down to 300 m per side.
- **Unity**: *Terrain → Export Raw…* in 16 bits (*Windows*: little-endian; *Mac*: `--big-endian`).
- A painting program (GIMP, Krita): a grayscale PNG, preferably 16-bit, painted with a soft brush; a light blur softens the slopes.

And the reverse: a map's terrain exports as a 16-bit PNG (`imageFromHeights` and `encodePng`, see [For developers](#for-developers)).

## Limits and checks

A map that exceeds these bounds is rejected (`npm run map:check` says why): it would cost too much to simulate, or it isn't a map. For comparison, the City has 152 boxes and 530 props, the Harbor 242 boxes, with 78 movable props.

| | At most |
|---|---|
| File | 4 MB |
| Terrain | 440 cells per side, 440 m per side, a 1, 1.25 or 2 m step, heights from 0 to 250 m |
| Play area (`half`) | 20 to 200 m |
| Scenery boxes (prefabs included) | 400 |
| Props (prefabs included) | 900, of which 120 movable (crates, barrels, gas cylinders, cars) |
| Prefabs | 300 |
| Zones, places | 5, 24 |
| Lava shapes, vents, waterfalls, paths | 32, 32, 16, 64 |
| Points of a polyline | 128; 1,024 for all paths, 512 for all lava flows |
| Trees in a wood, rocks in a pile | 200 (1,200 for the whole map) |
| Nav graph (`navGraph`) | 1,024 points, 8,192 links |

The game also checks, while building the arena:

- the terrain covers the play area and the invisible limit;
- the dimensions are consistent (AI area inside the play area, spawn lines at least 10 m from the center and 2 m from the edge, aircraft circuit);
- nothing off the map, zones inside the play area;
- **spawn lines**: at least half of their slots free (no scenery or prop, passable, neither in deep water nor in lava), and **nothing dangerous** within 8 m (lava, barrel, gas cylinder, storage tank, car); free lines (`spawns`) inside the play area, and at least 24 m apart;
- **each zone is reachable** by the AI (the nav grid has an open cell in its disc; without a grid, a point of its disc is outside the scenery boxes: a zone around a monument is playable).

The server runs the same checks on the maps in its folder, and the browser on those it imports or that a server sends it: a malformed or hostile map is rejected without breaking anything.

## Level design tips

- **Fairness:** spawn lines at the same distance from the zones, comparable terrain and cover on both sides; the simplest is a symmetric map (z → -z, or about the center).
- **Clear spawn lines:** a flat area at least `2 × spawnSpread + 10` m wide, without trees or low walls; the game also tries a row behind.
- **Slopes:** the AI doesn't climb more than 26° (adjustable, `nav.maxSlope`); wheeled robots struggle beyond 30°. Cliffs and impassable mountains serve as limits.
- **Bridges:** along the north-south or east-west axis, ends set at deck height (that's how the nav grid and the AI's driving take them).
- **Water:** a shallow river can be crossed anywhere (you see the splashes); deep water is a deadly obstacle, best kept for the middle of a lake or the sea.
- **Aircraft:** leave free air above the circuit (`circuit`); the floor altitude sets itself above the highest scenery.
- **Cost:** anchored props (walls, trees) cost little; movable ones (crates, barrels, cars) more. Lake Vale (253 props, 9 of them movable) costs as much to simulate as the Valley.

## Testing your map

- In the editor: **P** starts a test match, and the pause menu takes you back to the editor, in the same state (see [The editor](#the-editor)).
- `npm run map:check -- maps/ma-carte.casse-map.json`: the same checks as the game (without a file: all the maps in `maps/`; exit code 1 if one isn't playable). `--lang en`: messages in English.
- In the game (`npm run dev`): **Play**, a mode, your map. The **Free Arena** mode gives a free camera (WASD, right click) to roam the map while the AI fights on it; **M** shows the full map and its places; **Zone Capture** shows whether the AI reaches each zone.
- In the browser console: `__casse.testMap(carte)` starts a test match on a map (a JavaScript object), `__casse.maps.list()` lists the known maps.
- Balancing: `BATTLE_ARENA=ma-carte npm run battle` plays eight AI battles on a map from `maps/` (the file name without `.casse-map.json`) and gives a report: match length, kill causes, share of time ground robots are stuck, step cost. `MAP_PERF=1 npx vitest run tests/communityMaps.test.ts --silent=false` compares the cost of a combat step on each map in `maps/` with that of the Depot and the Valley.
- In multiplayer: `npm run server` puts the maps in `maps/` in the rotation, after the game's arenas (`MAPS_DIR`: another folder; `MAPS_ONLY=1`: only the maps); the log says why it drops an invalid map. A player who doesn't have the map receives it once (about 75 KB for Lake Vale) and keeps it.

## Submitting your map to the game

1. Check it (`npm run map:check`) and play it against the AI, in Battle and in Zone Capture.
2. Open a *pull request* that adds **one file** to `maps/` (a short name, lowercase, with hyphens: `maps/ma-carte.casse-map.json`). You can include your source terrain and whatever is used to rebuild the map (in `tools/maps/`, like the example).
3. The map must have a **free license** (`CC-BY-4.0`, `CC-BY-SA-4.0` or `CC0-1.0`: the game is free, its community must be able to reuse it), your name (or your nickname) as author, and a description; a name and a description in English (`names`, `descriptions`) are welcome. Don't reuse terrain you don't have the rights to (a real elevation map is usually free: state its source in the *pull request* description).
4. `npm run check` (which review runs, and which continuous integration will run) checks all the maps in `maps/` and plays a short AI battle on each; `npm run map:check` only runs the checks, in a few seconds.

## The game's arenas as maps

The game's own arenas, from the Depot to the Harbor, are written in this format in [`content/arenas/`](../content/arenas/) (`npm run map:export -- all`; `npm run map:export -- valley canyon --into some/folder` for a few of them elsewhere). They are a reference for what the format can say, and a starting point: copy one into `maps/` under another name, change it (in the editor: **Community maps… → Import a map…**, then **Edit**), and it's yours (their license is the game's, AGPL-3.0-or-later). They are not in `maps/`: the game and the server would load them a second time, next to the arenas they already have.

The export is exact: read back and built, each file gives the same arena as the game's code, to the bit (boxes, props, zones, paths, play dimensions, sky, ground palette, nav grid or nav graph), except the terrain, at the precision of its 16-bit coding (0.4 mm at most), and the direction of the Volcanic Island's waterfalls (an angle that no number of degrees gives back to the bit; only the renderer reads it). A short AI battle on the arena built from its file gives the same world as on the code's arena, with the file's terrain. To get there, a file says everything explicitly:

- the height of every box and prop (`y`), the perimeter walls and the invisible limits as boxes, and `"limits": { "bound": 0 }` (no limit added); `"nav": false` when the arena has no nav grid; the small arenas' sky and their own ambience;
- the angles, in degrees chosen so that they give the rotation back exactly; when no degrees do (a rotation composed by the code, an angle beyond a full turn), a `quat`; an upright prop that the code gave an orientation keeps it (`quat: [0, 0, 0, 1]`);
- a prop's `centered` height when no base height gives its center back exactly.

The files are written one element per line, the terrain last (`mapText`): a map read and written again gives the same text. After changing an arena, run `npm run map:export -- all` again: the tests check that the files are the ones the export makes.

## Map packages

A **map package** is the same map as a folder, easier to make and to read with other tools (no base64 to decode):

| File | |
|---|---|
| `map.json` | The map, whose `terrain` names its image (`"image": "terrain.png"`) instead of holding its `heights`. |
| `terrain.png` | The terrain as a 16-bit grayscale PNG, `cells + 1` pixels per side: each pixel is the code of its height (0: `min`, 65,535: `max`), the top to the north and the left to the west (like an imported terrain image). |
| `LICENSE.txt` | The map's license and author (written from `meta`; the map itself stays the reference). |

`npm run map:pack -- maps/ma-carte.casse-map.json [--into dossier]` (`dossier`: a folder) makes the folder `ma-carte/` (next to the file, or in `--into`); `npm run map:unpack -- ma-carte/ [--into dossier]` makes `ma-carte.casse-map.json` from it again, and checks it like the game does. Nothing is lost either way: the codes go into the image as they are (the Volcanic Island comes back byte for byte; its package weighs 115 KB against 271 KB, the PNG compresses the terrain). The game and the server don't read packages yet: only the tool does.

## For developers

The engine is in `src/shared/map/` (no DOM: it also runs on the server); everything is imported from `src/shared/map/index.ts`.

| Function | File | |
|---|---|---|
| `readMap(json)`, `readMapText(texte)` | read.ts | Reads an untrusted map: bounds, types, migration (`upgradeMap`, `MAP_MIGRATIONS`); returns the clean map or its problems (`MapIssue`). |
| `checkMap(json)`, `checkMapText(texte)`, `validateMap(json)` | validate.ts | Reads, builds and checks: `{ map, arena, key, issues }`. |
| `arenaFromMap(carte)` | build.ts | The map as an arena (`ArenaLayout`): terrain, unfolded prefabs, limits, default values. |
| `mapKey(carte)` | key.ts | Its identifier (`map-` + a hash of its canonical content). |
| `registerMap(carte)` | load.ts | Makes it playable: `Simulation.loadArena(arena)` or `loadArena(identifiant)`. |
| `blankMap(options)` | template.ts | A valid starting map. |
| `mapFromArena(arena, meta?)`, `exactTurn`, `exactDegrees` | export.ts | An arena (a game arena, or any `ArenaLayout`) as a map, exactly (see [The game's arenas as maps](#the-games-arenas-as-maps)). |
| `mapText(carte)` | text.ts | A map as the text of its file: one element per line, the terrain last, `-0` kept. |
| `packMap`, `unpackMap`, `packageImage`, `PACKAGE_FILES` | pack.ts | A map ↔ a map package (see [Map packages](#map-packages)). |
| `decodePng`, `decodeRaw16`, `imageFromBytes`, `terrainFromImage`, `heightsFromImage`, `imageFromHeights` | heightmap.ts | Terrain import and export. |
| `encodePng` | png.ts | A height image as an 8- or 16-bit PNG. |
| `encodeTerrain`, `decodeTerrain`, `terrainCodes` | codec.ts | A map's terrain ↔ the game's heights (the decoded terrain is cached per map terrain: it must not be modified); its raw 16-bit codes. |
| `applyBrush`, `fieldOf`, `terrainOfField` | brush.ts | The terrain brushes (the editor). |
| `addElement`, `setElement`, `moveElements`, `rotateElements`, `duplicateElements`, `removeElements`, `movePoint`, `spawnsOf`, `issueTarget` | edit.ts | The editing operations: each returns a new map (the `rests` supports and the `group` buildings follow). |
| `MapHistory` | history.ts | The undo history (bounded in count and in bytes of terrain). |
| `PALETTE`, `traceElement` | palette.ts | What can be placed, with its default values. |
| `FORMS`, `withField` | fields.ts | The fields of each kind of element, with their bounds (those used when reading). |

On the browser side: `MapLibrary` (`src/client/maps/library.ts`: shipped, imported and received maps; `save`, `replace`, `remove`, `importText`, `list`, `arena`), the files (`src/client/maps/files.ts`: `pickFile`, `downloadMap`, `heightImageFromFile`, `downloadHeightPng`), `App.testMap(carte)` (a test match) and the editor (`src/client/editor/`: `MapEditor`, its view `EditorView`, its panels `EditorUi`, the checking in a Worker, the draft). The texts to translate are in `src/client/i18n/locales/<langue>/maps.ts` (`MapIssue`, map menus) and `editor.ts` (the editor). In the console: `__casse.editor` (its map, its history, `lastRebuild` and `lastCheck` in ms).

The JSON Schemas of the open formats (`schemas/map.schema.json`, `schemas/robot.schema.json`) are written by `npm run schemas` (`tools/schemas/`) from the catalogs and from the reader's bounds (`MAP_LIMITS`, and `MAP_RANGES`, `MAP_LISTS`, `MAP_CHOICES` in read.ts); `tests/schemas.test.ts` fails when they are out of date, and checks that the map schema accepts and rejects like `readMap`. After changing a field, a bound or a catalog, run `npm run schemas`.

A new format version: `MAP_FORMAT` goes to 2, and `MAP_MIGRATIONS[1]` turns a format 1 map into a format 2 map (on the raw JSON); existing maps stay readable.
