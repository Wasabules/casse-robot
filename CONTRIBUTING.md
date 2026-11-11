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

No engine to install and no account to create: everything runs in the browser, and the simulation (physics, robots, AI) also runs in Node, headless, for the tests.

## Before sending a change

- **`npm run check` must pass** (type checking and tests). Continuous integration runs it on every pull request too.
- **One topic per pull request**: one weapon, one fix, one map. Say what you changed, why, and how you checked it (a test, a measurement, a screenshot).
- **A game rule comes with its test** in `tests/` (Vitest, in Node). A test that depends on randomness calls `seedRandom(n)` (`tests/seed.ts`) to be reproducible.
- **Balance:** `npm run battle` plays eight AI battles and prints a per-robot report; attach it if your change affects balance.
- **Performance:** `npm run bench` measures the cost of a simulation step; a change that makes it climb must say so.

## Where things go

The architecture and the step-by-step recipes are described in [`docs/architecture.md`](docs/architecture.md), especially the "Architecture rules" section: adding a block, a weapon, a melee weapon, a wheel, a prop, an arena, a preset robot, a key binding, an effects system, a language. The catalogs are typed: TypeScript rejects an incomplete addition (a block without a look, a weapon without a sound, a text without a translation).

A few rules we don't bend:

- **`src/shared/` is the pure simulation:** no Babylon, no DOM. It also runs on the server.
- **No hard-coded user-facing text:** everything goes through the message catalogs (`src/client/i18n/locales/<language>/`), in French and English; no hard-coded key names either. Tests check this.
- **Simulation randomness goes through `rand`** (`src/shared/math/scalar.ts`), never `Math.random`.
- **Every change to a robot's structure emits its event** (`SimEvent`) and its network event: rendering and multiplayer depend on them.

## Special contributions

- **Maps:** the map editor is in the game (main menu → Map editor); the format and how to submit a map are in [`docs/maps.md`](docs/maps.md).
- **Translations:** see the "Languages" section of the [`README`](README.md) and "Languages (i18n)" in `docs/architecture.md`. To start a language, copy `src/client/i18n/locales/en/` to a new folder. An incomplete language already shows, in English where a translation is missing.
- **Sounds and music:** the files in `public/sounds/` were generated with ElevenLabs and are not covered by the code license (see the README). Only add a sound you may publish under a free license (CC0 or CC BY preferred), and say which one. The game synthesizes a fallback for every sound: it works without the files.

## License of your contributions

Casse-Robot's code is licensed under the **GNU AGPL-3.0 or any later version** (see [`LICENSE`](LICENSE)). By submitting a change, you agree that it is published under that same license.
