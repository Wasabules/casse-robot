import { WEAPONS, type Weapon } from "../shared/catalog/weapons";
import { PRESET_BOTS } from "../shared/design/presets";
import { applyDamage } from "../shared/combat/damage";
import type { Vec3 } from "../shared/math/vec";
import type { HitTarget } from "../shared/sim/entities";
import type { MapFile } from "../shared/map/format";
import type { App } from "./app";
import type { ArenaGame } from "./game";
import type { Garage } from "./garage/garage";

/** Accès de débogage depuis la console du navigateur : `__casse`. */
function debugApi(game: ArenaGame, garage: Garage, app: App | null) {
  return {
    game,
    /** Le garage : `garage.load({ name, color, design })` y ouvre un plan (par exemple `presets[i].design`). */
    garage,
    presets: PRESET_BOTS,
    /** Les cartes communautaires (`maps.list()`, `maps.save(carte)`…) ; `testMap(carte)` : une partie d'essai dessus. */
    maps: app?.maps,
    /** L'éditeur de cartes : sa carte (`editor.map`), son historique, ses mesures (`lastRebuild`, `lastCheck`, en ms). */
    editor: app?.editor,
    testMap: (map: MapFile) => app?.testMap(map),
    get world() { return game.sim.world; },
    get bots() { return game.sim.bots; },
    get camera() { return game.rig.camera; },
    get scene() { return game.scene; },
    WEAPONS,
    /** Avance la simulation de `n` pas de 1/60 s d'un coup (600 = 10 s). */
    sim: (n: number) => game.simulate(n),
    /** Fige ou relance l'IA. */
    pause: (paused: boolean) => game.setPaused(paused),
    /** Nouvelle vague ; `ids` : ces robots-là (identifiants de PRESET_BOTS : "tank", "heli"…). */
    spawnWave: (ids?: string[]) => (ids ? game.spawn(PRESET_BOTS.filter((p) => ids.includes(p.id))) : game.newWave()),
    /** Tir au pixel (x, y), sans tenir compte de la cadence ni des munitions. */
    fireAt: (x: number, y: number) => game.fireAt(x, y, true),
    /** Impact en `point`, comme si le tir venait de la caméra. */
    applyDamage: (point: Vec3, dir: Vec3, weapon: Weapon, target?: HitTarget) =>
      applyDamage(game.sim, point, dir, weapon, target, game.rig.position),
  };
}

declare global {
  interface Window {
    __casse?: ReturnType<typeof debugApi>;
  }
}

export function installDebugApi(game: ArenaGame, garage: Garage, app: App | null = null): void {
  window.__casse = debugApi(game, garage, app);
}
