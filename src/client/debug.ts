import { WEAPONS, type Weapon } from "../shared/catalog/weapons";
import { PRESET_BOTS } from "../shared/design/presets";
import { applyDamage } from "../shared/combat/damage";
import type { Vec3 } from "../shared/math/vec";
import type { HitTarget } from "../shared/sim/entities";
import type { ArenaKey } from "../shared/arena/layout";
import type { MapFile } from "../shared/map/format";
import type { GameModeId } from "../shared/modes";
import type { App, SettingsTab } from "./app";
import type { GraphicsPreset, Settings } from "./settings";
import type { ArenaGame } from "./game";
import type { Garage } from "./garage/garage";
import { LOAD_TIMES, loadArena, loadedArena, readyArenas } from "./maps/gameArenas";

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
    /**
     * Les arènes du jeu (client/maps/gameArenas.ts) : charger le fichier de l'une (`load(id)`), l'avoir
     * construite (`loaded(id)`), celles qui sont là (`ready()`), ce qu'a coûté chaque chargement (`times`, ms).
     */
    arenas: { load: loadArena, loaded: loadedArena, ready: readyArenas, times: LOAD_TIMES },
    /**
     * Les écrans, sans passer par les menus (outils de tools/browser/) : l'écran titre, le garage,
     * l'éditeur de cartes (une carte vierge), la bataille de la mesure du rendu dans une arène, le
     * choix de l'arène d'un mode, une partie en réseau (le serveur des réglages, avec ce robot de départ).
     */
    screens: {
      title: () => app?.showTitle(),
      garage: () => app?.showGarage(),
      editor: () => app?.showEditor(),
      benchmark: (arena: ArenaKey) => app?.benchmark(arena),
      arenas: (mode?: GameModeId) => app?.showArenas(mode),
      online: (preset?: string) => app?.joinServer(preset),
      /** Une partie pilotée (un robot de départ : "tank", "buggy"… ; une arène ; un mode). */
      pilot: (preset?: string, arena?: ArenaKey, mode?: GameModeId) => app?.pilotMatch(preset, arena, mode),
      /** Les paramètres (`tab` : "graphics", "controls", "touch", "sound", "profile"), et l'écran des touches. */
      settings: (tab?: SettingsTab) => app?.openSettings(tab),
      bindings: () => app?.openBindings(),
    },
    /** Passe à un préréglage graphique : "low", "medium", "high". */
    graphics: (preset: GraphicsPreset) => app?.useGraphicsPreset(preset),
    /** Change des réglages (appliqués et enregistrés, comme depuis les paramètres) ; rend les réglages. */
    settings: (patch?: Partial<Settings>) => app?.patchSettings(patch),
    /** Le monde affiché : la simulation de la page, ou la réplique de la partie (solo dans un Worker, en réseau). */
    get world() { return game.world; },
    get bots() { return game.world.bots; },
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
      game.debugDamage(point, dir, weapon, target ?? null, (sim) => applyDamage(sim, point, dir, weapon, target, game.rig.position)),
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
