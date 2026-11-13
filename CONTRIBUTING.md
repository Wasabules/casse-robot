# Contributing to Casse-Robot

Thanks for wanting to help! Casse-Robot is an open game: new weapons, robots, maps, translations, fixes, balance measurements, everything is welcome.

*The documentation is in English. The code comments are still in French; issues and pull requests are welcome in English or French.*

## Setting up

1. Install **Node.js 20 or newer**.
2. In the project folder:

   ```bash
   npm install
   npm run dev
   ```

   The game opens on `http://localhost:5173` and reloads every time you save a file.

No engine to install and no account to create: everything runs in the browser, and the simulation (physics, robots, AI) also runs in Node, headless, for the tests. Part of the simulation is being ported to Rust (`crates/casse-sim`, compiled to WebAssembly); the built module is committed, so you only need Rust ([rustup](https://rustup.rs): it reads `rust-toolchain.toml`) if you change something under `crates/`, and then run `npm run native`.

## Before sending a change

- **`npm run check` must pass** (type checking and tests). Continuous integration runs it on every pull request too.
- **One topic per pull request**: one weapon, one fix, one map. Say what you changed, why, and how you checked it (a test, a measurement, a screenshot).
- **A game rule comes with its test** in `tests/` (Vitest, in Node). A test that depends on randomness calls `seedRandom(n)` (`tests/seed.ts`) to be reproducible.
- **Balance:** `npm run battle` plays eight AI battles and prints a per-robot report; attach it if your change affects balance.
- **Performance:** `npm run bench` measures the cost of a simulation step, `npm run perf` the time of a frame in the browser (save one with `--json=before.json` before your change, then `--compare=before.json`); a change that makes them climb must say so.
- **Rendering:** a change to shaders, materials or screens must pass `npm run render:check` (CI runs it without a graphics card), and `npm run render:check -- --gpu --renderer=webgpu` if your machine has WebGPU: a shader that compiles in WebGL can be refused by WebGPU.
- **Compiled simulation:** a change under `crates/` is followed by `npm run native` (it rebuilds the embedded module and the whole simulation, `src/shared/native/casse-sim.wasm`: commit both) and `npm run native:test`; a ported module must return exactly what its TypeScript returns (`tests/native.test.ts`). The ported simulation that owns its Rapier world (`crates/casse-sim/src/sim/`) lives in the probe, `npm run native -- --probe` (`--dev` to iterate faster), and must drive, fly, crash and fight its robots (`npm test` plays a current set of its long runs, `SIM_ALL=1` all of them, as CI's `native` job does) (piloted, or driven by the AI, with or without combat, in the small arenas, the large ones and on the community maps), and break, blow up and burn its props, exactly as the TypeScript does (`tests/nativeSim.test.ts`: parts, wheels, blocks and their fire and local stuns, broken links, debris, props, engines, supports, control surfaces, melee weapons, the pilot's and the AI's state, tactics and navigation, turrets, projectiles, what each team has spotted, and random draws compared every second, to the bit). Plugged into the game (`?sim=rust`, `SIM=rust`), it must also send the same frames as the TypeScript session and server room, byte for byte (`tests/nativeSession.test.ts`, and the random long parity, `tests/nativeParity.test.ts`: a short series in `npm test`, a long one every night; a difference names the first event or snapshot field that differs and writes what replays it to `artifacts/parity/`), and replay the reference battles exactly (`SIM=rust BATTLE_RECORD=<file> npm run battle`, compared with `tests/reference/battles-depot.json`). A change in what the simulation does (an event, a field of the snapshot, a rule of the match) is made on both sides.

## Where things go

The architecture and the step-by-step recipes are described in [`docs/architecture.md`](docs/architecture.md), especially the "Architecture rules" section: adding a block, a weapon, a melee weapon, a wheel, a prop, an arena, a preset robot, a key binding, an effects system, a language. The catalogs are typed: TypeScript rejects an incomplete addition (a block without a look, a weapon without a sound, a text without a translation).

- **Tuning or adding a game element through its file:** the blocks, the wheels, the weapons, the melee weapons and the props are data files, one per element: `content/blocks/<type>.json`, `content/wheels/<type>.json`, `content/weapons/<id>.json`, `content/melee/<id>.json`, `content/props/<type>.json` (the shaped blocks, cut out of the armors, are computed: they have no file; see "Element files" in [`docs/architecture.md`](docs/architecture.md)). To tune one (a mass, hit points, a price), edit its file, run `npm run schemas` (the content catalog, `content/catalog.json`, carries the numbers) and rewrite the snapshot of the catalogs in the same commit (`CATALOG_SNAPSHOT=write npx vitest run tests/catalogSnapshot.test.ts`: its diff shows the change), then `npm run check`: a malformed file is reported by its name and field (`content/props/crate.json: hp: …`), and your editor checks it as you type through its `$schema`. To add one, copy a neighbor's file under the new identifier, add its import line to the family's catalog (`FILES` in `src/shared/catalog/blocks.ts`, `wheels.ts`, `weapons.ts`, `melee.ts` or `props.ts`), then what TypeScript asks for (its look, its sound, its name in each language), and run `npm run schemas` (the content catalog and the schemas list it).

A few rules we don't bend:

- **`src/shared/` is the pure simulation:** no Babylon, no DOM. It also runs on the server.
- **No hard-coded user-facing text:** everything goes through the message catalogs (`src/client/i18n/locales/<language>/`), in French and English; no hard-coded key names either. Tests check this.
- **Simulation randomness goes through `rand`** (`src/shared/math/scalar.ts`), never `Math.random`.
- **Simulation sines, cosines, logarithms and powers go through `dsin`, `dcos`, `dlog`, `dpow`** (`src/shared/math/det.ts`), never `Math.sin`, `Math.cos`, `Math.log`, `Math.pow` or `**`: their last bit depends on the JavaScript engine, and the compiled simulation must give the same bits.
- **Every change to a robot's structure emits its event** (`SimEvent`) and its network event: rendering and multiplayer depend on them.

## Special contributions

- **Maps:** the map editor is in the game (main menu → Map editor); the format, its JSON Schema (`schemas/map.schema.json`, for your editor) and how to submit a map are in [`docs/maps.md`](docs/maps.md). After changing a format field, a bound or a catalog (a block, wheel or prop type, an arena), run `npm run schemas`: the tests check that the schemas, and the content catalog (`content/catalog.json`, the game's elements as open data), are up to date. The repository takes map files (`maps/<name>.casse-map.json`); a map with its own prop models or ambience is a map package (`.casse-map.zip`, see "Map packages" in the guide), shared as one file or played by a server, not shipped with the game. Packages come from anyone: what reads them (`src/shared/map/pack.ts`, `src/shared/media/`) bounds everything before reading it and never throws; keep it that way (`tests/mapArchive.test.ts` feeds it damaged archives).
- **3D models:** a prop (crate, barrel, tree, wall, car, lamp…), a block of a robot, a turret head or a wheel can have a glTF model made in Blender instead of the one the game draws: save it as `public/models/<family>/<type>.glb` (`props`, `blocks`, `heads`, `wheels`) and run `npm run models`. The conventions (meters, +Y up; a prop's origin at the bottom center, a block's at the center of its cell, a head's at its pivot, a wheel's at its hub; a `glass` material that lights up at night, a `paint` material that takes the robot's color) are in [`docs/models.md`](docs/models.md). Contribute a model under a free license (CC0 or CC BY preferred), and say which one.
- **The game's arenas as maps:** `content/arenas/` holds each of the game's arenas written in the map format (`npm run map:export -- all`), and the game, the server and the tests play these files, not the code in `src/shared/arena/`. After changing an arena (its scenery, props, terrain, zones…) or its name, run that command again (without it, your change isn't in the game): the tests check that the files are the ones the export makes, and that each one, read back, gives the same arena to the bit.
- **Translations:** see the "Languages" section of the [`README`](README.md) and "Languages (i18n)" in `docs/architecture.md`. To start a language, copy `src/client/i18n/locales/en/` to a new folder. An incomplete language already shows, in English where a translation is missing.
- **Sounds and music:** the files in `public/sounds/` were generated with ElevenLabs and are not covered by the code license (see the README). Only add a sound you may publish under a free license (CC0 or CC BY preferred), and say which one. The game synthesizes a fallback for every sound: it works without the files.

## License of your contributions

Casse-Robot's code is licensed under the **GNU AGPL-3.0 or any later version** (see [`LICENSE`](LICENSE)). By submitting a change, you agree that it is published under that same license.
