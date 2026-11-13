import { byId } from "./dom";
import { SoundLog } from "./hud/soundLog";
import { ARENA_IDS, isMapKey, unregisterArena, type ArenaKey } from "../shared/arena/layout";
import type { MapFile, MapIssue } from "../shared/map/format";
import { assetEntries } from "../shared/map/pack";
import { registerMap } from "../shared/map/load";
import { checkMap } from "../shared/map/validate";
import { profileFromDesign } from "../shared/design/custom";
import { BATTLE_ROSTER, PRESET_BOTS, type BotProfile } from "../shared/design/presets";
import { validateDesign } from "../shared/design/robotDesign";
import { GAME_MODES, PILOTABLE, type GameModeId } from "../shared/modes";
import { DEFAULT_PORT, PROTOCOL_VERSION, type RobotChoice } from "../shared/net/protocol";
import type { Team } from "../shared/sim/entities";
import type { ArenaGame } from "./game";
import type { MusicChange, MusicNow, MusicTheme, Track } from "./audio/music";
import { musicScreen, NowPlaying, trackTitle } from "./hud/nowPlaying";
import { nextPaint, type LoadingScreen } from "./menu/loading";
import { Garage, starterRobot } from "./garage/garage";
import type { SoundScreen } from "./audio/soundScene";
import { loadRobots, saveRobot, type SavedRobot } from "./garage/storage";
import { editorKeys, freeKeys, garageKeys, pilotKeys } from "./keys";
import {
  ACTION_CATEGORIES, ACTION_IDS, actionDef, actionDetail, actionLabel, assignBinding, categoryLabel, chordCode, codeLabel, DEFAULT_BINDINGS, eventChords,
  isDefault, isEditable, isModifierKey, isToolAction, padLabel, resetAction,
  slotCode, type ActionId, type Displaced, type Slot,
} from "./input/bindings";
import type { MenuCommand } from "./input/controls";
import { PadBadge } from "./hud/padBadge";
import { TouchHud } from "./hud/touchHud";
import { fullscreenSupported, isFullscreen, onFullscreenChange, toggleFullscreen } from "./hud/fullscreen";
import { lockedParts, matchReward } from "../shared/design/progression";
import { FpsBadge } from "./hud/fpsBadge";
import { setLocale } from "./i18n/state";
import { LOCALE_IDS, LOCALES, measure, t, type MessageKey } from "./i18n/i18n";
import { pct } from "./i18n/format";
import { playerToken, Progress } from "./progress";
import { choiceRow, Menu, type BindingSlotView, type MenuEntry, type SettingRow } from "./menu/menu";
import { robotCard, type RobotCard } from "./menu/robotCatalog";
import { lastPick, rememberPick, RobotPicker, type PickerOptions } from "./menu/robotPicker";
import { ArenaPicker, lastArena, rememberArena, type ArenaOption } from "./menu/arenaPicker";
import { defaultServer, NetClient } from "./net/netClient";
import {
  DEADZONE_RANGE, defaultSettings, FOV_RANGE, GRAPHICS_PRESETS, graphicsPreset, loadSettings, saveSettings, SENSITIVITY_RANGE,
  TOUCH_OPACITY_RANGE, TOUCH_SIZE_RANGE,
  type GraphicsPreset, type MusicPlayerMode, type NumberSetting, type Settings,
  requestedRenderer, requestedSimulation,
} from "./settings";
import { arenaInfo, arenaName, botName, communityInfo, mapIssueText, modeInfo, modeName, partName, rewardLineText } from "./i18n/names";
import { downloadMap, downloadPackage, pickFile } from "./maps/files";
import { mapName, MapLibrary, type ImportResult, type MapEntry } from "./maps/library";
import { arenaFacts, loadArena, loadedArena } from "./maps/gameArenas";
import { MapEditor, type EditorSource } from "./editor/editor";
import { backendOf, type RenderBackend } from "./render/engine";

/** Les ressources d'une carte venue d'un paquet, en une ligne (« Paquet : 2 modèles d'accessoires, son ambiance »). */
function assetsLine(map: MapFile): string {
  const entries = assetEntries(map.assets);
  const models = entries.filter((e) => e.type).length;
  const parts = [...(models ? [t("maps.assetModels", { n: models })] : []), ...(map.assets?.ambience ? [t("maps.assetAmbience")] : [])];
  return t("maps.assets", { list: parts.join(", ") });
}

/** Onglets des paramètres, et leurs titres. */
export type SettingsTab = "graphics" | "controls" | "touch" | "sound" | "profile";
const SETTINGS_TABS = {
  graphics: "menu.settings.graphics", controls: "menu.settings.controls", touch: "menu.settings.touch", sound: "menu.settings.sound", profile: "menu.settings.profile",
} as const satisfies Record<SettingsTab, MessageKey>;
/** Ce que fait chaque réglage du lecteur de musique (onglet Son). */
const PLAYER_DETAILS = {
  always: "menu.snd.playerAlwaysDetail", auto: "menu.snd.playerAutoDetail", hidden: "menu.snd.playerHiddenDetail",
} as const satisfies Record<MusicPlayerMode, MessageKey>;
/** Change un réglage : il est appliqué, enregistré, puis l'écran des paramètres est redessiné. */
type Setter = <K extends keyof Settings>(key: K) => (value: Settings[K]) => void;

/** Écrans de l'application. */
type AppState = "title" | "playing" | "paused" | "over" | "garage" | "editor" | "connecting" | "loading";

/** Ce que chaque écran laisse entendre (voir audio/soundScene.ts) : derrière un menu, la bataille de démonstration ; l'éditeur de cartes, comme le garage. */
const SCREEN_SOUND: Record<AppState, SoundScreen> = {
  title: "menu", connecting: "menu", playing: "playing", paused: "paused", over: "over", garage: "garage", editor: "garage", loading: "loading",
};

/**
 * L'application : l'écran titre (une bataille tourne derrière), le choix du robot, la partie, la
 * pause et la fin de partie. `ArenaGame` fait la partie ; ici, on enchaîne les écrans et on tient
 * les réglages.
 */
export class App {
  private readonly game: ArenaGame;
  private readonly canvas: HTMLCanvasElement;
  private readonly loading: LoadingScreen;
  /** Chargement en cours : un nouveau (ou un retour au menu) rend le précédent caduc. */
  private loadTicket = 0;
  private readonly menu = new Menu();
  private readonly settings: Settings = loadSettings();
  /** Le moteur de rendu demandé au chargement de la page (render/engine.ts : il ne change qu'en la rechargeant). */
  private readonly bootRenderer = requestedRenderer(this.settings.renderer);
  private readonly bootSimulation = requestedSimulation(this.settings.simulation);
  private readonly fps: FpsBadge;
  private readonly soundLog: SoundLog;
  private readonly progress = new Progress();
  /** Les cartes communautaires de ce navigateur (aussi dans la console : `__casse.maps`). */
  readonly maps = new MapLibrary();
  /** Le garage (aussi dans la console : `__casse.garage`). */
  readonly garage: Garage;
  /** L'éditeur de cartes (aussi dans la console : `__casse.editor`). */
  readonly editor: MapEditor;
  /** Une partie d'essai lancée de l'éditeur de cartes (on y revient depuis la pause et la fin de partie). */
  private editorTest = false;
  /** L'arène de la dernière carte essayée (oubliée quand on en essaie une autre). */
  private testArena: ArenaKey | null = null;
  private state: AppState = "title";
  /** Robot du garage en cours d'essai (on y revient depuis la pause), ou null. */
  private trial: SavedRobot | null = null;
  /** Dernier robot ouvert au garage. */
  private lastRobot: SavedRobot | null = null;
  /** Dernier onglet ouvert des paramètres (null : le premier). */
  private settingsTab: SettingsTab | null = null;
  /** Réattribution en cours (la case qui attend sa touche), et de quoi cesser d'écouter. */
  private listening: { action: ActionId; slot: Slot; stop: () => void } | null = null;
  /** Dernier mot de l'écran des touches (un échange, un refus), sous la ligne de l'action réglée. */
  private keyNote: { action: ActionId; text: string } | null = null;
  /** Redessine l'écran des paramètres affiché (null : il ne l'est pas). */
  private redrawSettings: (() => void) | null = null;
  private readonly padBadge = new PadBadge();
  /** Le lecteur de musique : le morceau en cours, et ses boutons dans les menus et au garage. */
  private readonly nowPlaying: NowPlaying;
  /** Au doigt : la pause en partie, le mot du garage et de l'éditeur. */
  private readonly touchHud = new TouchHud();

  constructor(game: ArenaGame, canvas: HTMLCanvasElement, loading: LoadingScreen) {
    this.game = game;
    this.canvas = canvas;
    this.loading = loading;
    this.garage = new Garage(game.engine, canvas);
    this.garage.progress = this.progress;
    this.garage.onTest = (profile, robot) => this.tryRobot(profile, robot);
    this.garage.onSave = (robot) => {
      saveRobot(robot);
      this.lastRobot = robot;
      this.garage.notify(t("menu.robots.saved", { name: robot.name }));
      game.sound.ui("save");
    };
    this.garage.onSound = (kind) => game.sound.ui(kind);
    this.garage.onBrowse = () => this.browseRobots();
    this.garage.onExit = () => this.closeGarage();
    this.editor = new MapEditor({
      engine: game.engine,
      canvas,
      maps: this.maps,
      bindings: () => this.settings.bindings,
      keyName: (id) => game.controls.keyName(id, "keys"),
      author: () => this.settings.name,
      menuOpen: () => this.menu.visible,
      sound: (kind) => game.sound.ui(kind),
      leave: () => this.leaveEditor(),
      test: (map) => this.chooseTestMode(map),
    });
    // Les raccourcis du garage : ceux choisis par le joueur, nommés selon son clavier
    this.garage.keyName = (id) => game.controls.keyName(id, "keys");
    this.fps = new FpsBadge(game.engine);
    this.soundLog = new SoundLog();
    // La musique : ses titres, et de quoi changer de morceau (les touches en partie passent par les commandes)
    this.nowPlaying = new NowPlaying({
      previous: () => this.skipMusic(-1),
      next: () => this.skipMusic(1),
      toggle: () => game.sound.ui("click"),
    });
    game.sound.onMusic = (now, change, manual, track) => this.musicChanged(now, change, manual, track);
    this.applySettings();
    // Les boutons des menus : un clic, et un léger son au survol
    const menuRoot = byId("menu");
    menuRoot.addEventListener("click", (e) => {
      if ((e.target as Element).closest("button")) game.sound.ui("click");
    });
    menuRoot.addEventListener("pointerover", (e) => {
      const button = (e.target as Element).closest("button");
      if (button && !button.contains(e.relatedTarget as Node | null)) game.sound.ui("hover");
    });
    game.onMatchOver = (winner) => this.showResult(winner);
    // Le pilotage de l'avion, basculé en vol, reste le réglage
    game.onFlightChange = (manual) => {
      this.settings.flight = manual ? "manual" : "mouse";
      saveSettings(this.settings);
    };
    // Échap rend d'abord la souris capturée (le navigateur s'en charge) : on ouvre alors la pause
    let released = -Infinity;
    game.controls.onRelease = () => {
      released = performance.now();
      if (this.state === "playing") this.pause();
    };
    window.addEventListener("keydown", (e) => {
      if (e.code !== "Escape" || e.repeat) return;
      // Certains navigateurs transmettent aussi cet Échap : il ne doit pas refermer la pause
      if (performance.now() - released < 400) return;
      this.escape();
    });
    // Manette : Menu met en pause ; derrière un menu, elle le parcourt ; branchée, débranchée : l'indicateur
    const controls = game.controls;
    controls.onPadPause = () => this.escape();
    controls.menuOpen = () => this.menu.visible;
    controls.onMenu = (command) => this.padMenu(command);
    controls.onPadChange = (id) => {
      this.padBadge.show(id);
      this.redrawSettings?.();
    };
    // Au doigt, pas de touche Échap : le bouton de pause
    this.touchHud.onPause = () => {
      if (this.state === "playing") this.pause();
    };
    // Entré en plein écran ou sorti (par le menu, ou par le navigateur : Échap, le geste retour) :
    // l'accueil et la pause, qui le proposent, disent ce que fera leur entrée
    onFullscreenChange(() => {
      if (this.menu.screen === "title") this.renderTitle();
      else if (this.menu.screen === "pause" && this.state === "paused") this.pause();
    });
    // Le clavier du joueur appris (ou la manette prise) : les noms des touches changent, au garage aussi
    const labels = controls.onLabels;
    controls.onLabels = () => {
      labels?.();
      this.garage.refreshKeys();
    };
  }

  /**
   * Échap (ou B, Menu à la manette) : dans un sous-menu (paramètres, choix du robot…), revient à
   * l'écran précédent ; en partie, la pause ; en pause, la partie.
   */
  private escape(): void {
    if (this.menu.goBack()) {
      this.game.sound.ui("back");
      return;
    }
    if (this.state === "playing") this.pause();
    else if (this.state === "paused") this.resume();
    else if (this.state === "garage" && !this.menu.visible) this.closeGarage();
    // L'éditeur de cartes annule d'abord ce qui est en cours (un tracé, la sélection), puis propose de quitter
    else if (this.state === "editor" && !this.menu.visible && !this.editor.escape()) this.leaveEditor();
  }

  /** La manette parcourt le menu affiché. */
  private padMenu(command: MenuCommand): void {
    switch (command) {
      case "accept": this.menu.accept(); break;
      case "back": this.escape(); break;
      case "prevTab": this.menu.cycleTab(-1); break;
      case "nextTab": this.menu.cycleTab(1); break;
      default:
        this.menu.navigate(command);
        this.game.sound.ui("hover");
        break;
    }
  }

  /**
   * Passe à un écran : le seul endroit où il change, et d'où le son apprend ce qu'il doit laisser
   * entendre (audio/soundScene.ts : la partie, la pause, la fin de partie, les menus devant la
   * démonstration, le garage).
   */
  private enter(state: AppState): void {
    this.state = state;
    this.game.sound.setScreen(SCREEN_SOUND[state], this.game.online);
    // Au doigt, le garage et l'éditeur disent ce qui demande une souris
    this.touchHud.note(state === "garage" || state === "editor" ? state : null);
  }

  /**
   * L'entrée « Plein écran » (ou « Quitter le plein écran ») de l'accueil et du menu pause, là où le
   * navigateur le permet (pas sur l'iPhone) ; au doigt, elle tourne aussi l'écran à l'horizontale, là
   * où c'est possible. Le menu se redessine quand la page entre en plein écran ou en sort
   * (`onFullscreenChange`, dans le constructeur).
   */
  private fullscreenEntry(): MenuEntry[] {
    if (!fullscreenSupported()) return [];
    const on = isFullscreen();
    return [{
      label: on ? t("hud.page.exitFullscreen") : t("hud.page.fullscreen"),
      // (l'explication sur une tuile, au doigt ; sur ordinateur, l'accueil tient ainsi en 720 px de haut)
      detail: on || !this.touchHud.active ? undefined : t("menu.fullscreenDetail"),
      onSelect: () => void toggleFullscreen(this.touchHud.active),
    }];
  }

  /**
   * Démarrage du jeu, derrière l'écran de chargement (l'écran titre et sa démonstration sont déjà
   * là, cachés) : tous les sons et la musique de l'accueil décodés, les effets et leurs shaders
   * préparés. Puis, si le navigateur attend un geste pour le son, « Cliquer pour commencer » : la
   * musique de l'accueil part dès ce clic, sans attendre.
   */
  async boot(): Promise<void> {
    let sounds = 0;
    let effects = 0;
    const report = (): void => this.loading.progress(
      0.1 + 0.9 * (0.75 * sounds + 0.25 * effects),
      sounds < 1 ? t("menu.loading.sounds", { pct: pct(sounds) }) : t("menu.loading.effects"),
    );
    await Promise.all([
      this.game.sound.preload((done) => {
        sounds = done;
        report();
      }),
      this.game.prewarm((done) => {
        effects = done;
        report();
      }),
      // Les cartes communautaires (livrées avec le jeu, et celles de ce navigateur) : pour le choix de l'arène
      this.maps.load(),
    ]);
    if (this.game.sound.needsGesture) await this.loading.awaitClick(t("menu.loading.start"), () => void this.game.sound.resume());
    this.loading.hide();
    this.menu.focus();
  }

  /** Écran titre, par-dessus une bataille de démonstration. */
  showTitle(): void {
    this.cancelLoading();
    // Une partie d'essai de l'éditeur de cartes, abandonnée : l'éditeur se ferme (son brouillon reste gardé)
    if (this.editor.active) this.editor.close();
    this.editorTest = false;
    this.enter("title");
    this.trial = null;
    this.game.stopOnline();
    this.game.startDemo();
    this.game.sound.playMusic("menu");
    this.renderTitle();
  }

  private renderTitle(): void {
    const modes = this.listedModes().map((id) => modeName(id).toLocaleLowerCase());
    const progress = this.progress.sandbox ? t("menu.title.sandbox") : t("menu.title.credits", { n: this.progress.credits });
    this.menu.show({
      id: "title",
      // Le nom du jeu ne se traduit pas
      title: "Casse-Robot", // i18n-ignore
      subtitle: t("menu.title.tagline"),
      hero: true,
      tiles: true,
      entries: [
        { label: t("menu.title.play"), detail: t("menu.title.playDetail", { modes: modes.join(", ") }), primary: true, onSelect: () => this.showPlay() },
        { label: t("menu.multi.title"), detail: t("menu.title.multiDetail"), onSelect: () => this.showMultiplayer() },
        {
          label: t("menu.title.garage"),
          detail: t("menu.title.garageDetail", { progress }),
          onSelect: () => this.openGarage(this.lastRobot),
        },
        { label: t("editor.menu"), detail: t("editor.menuDetail"), onSelect: () => void this.openEditor({ kind: "resume" }) },
        { label: t("menu.settings.title"), detail: t("menu.title.settingsDetail"), onSelect: () => this.showSettings(() => this.renderTitle()) },
        ...this.fullscreenEntry(),
      ],
      footer: t("menu.title.footer"),
    });
  }

  private listedModes(): GameModeId[] {
    return (Object.keys(GAME_MODES) as GameModeId[]).filter((id) => GAME_MODES[id].listed);
  }

  /** Choix du mode de jeu, puis de l'arène, puis du robot pour les modes pilotés. */
  private showPlay(): void {
    const back = (): void => this.renderTitle();
    const modes = this.listedModes().map((id, i): MenuEntry => ({
      label: modeName(id),
      detail: modeInfo(id),
      primary: i === 0,
      onSelect: () => this.pickArena(id),
    }));
    this.menu.show({
      id: "play",
      tiles: true,
      title: t("menu.title.play"),
      subtitle: t("menu.play.subtitle"),
      entries: [...modes, { label: t("common.back"), onSelect: back }],
      back,
    });
  }

  /**
   * Choix de l'arène pour ce mode (la dernière jouée en premier) : celles du jeu, puis les cartes
   * communautaires ; puis du robot pour un mode piloté.
   */
  private pickArena(mode: GameModeId): void {
    const back = (): void => this.showPlay();
    const label = modeName(mode);
    const go = (arena: ArenaKey): void => {
      // Une carte communautaire devient une arène jouable (connue de la simulation par son identifiant)
      if (isMapKey(arena)) this.maps.arena(arena);
      if (GAME_MODES[mode].pilot) this.pickRobot(`${label} · ${arenaName(arena)}`, (p) => this.play(mode, p, arena), () => this.pickArena(mode));
      else this.play(mode, null, arena);
    };
    // Les arènes du jeu, puis les cartes communautaires (leurs faits lus dans la carte : son arène ne se
    // construit que pour son plan). Une grande arène du jeu : son fichier se charge pour sa carte de la
    // grille (son plan, ses faits), toutes en même temps ; les plans se dessinent l'un après l'autre
    const arenas: ArenaOption[] = [
      ...ARENA_IDS.map((id): ArenaOption => ({ key: id, name: arenaName(id), info: arenaInfo(id), facts: () => arenaFacts(id), layout: () => loadedArena(id) })),
      ...this.maps.list().map((e): ArenaOption => ({
        key: e.key,
        name: mapName(e.map),
        info: communityInfo(e.map.meta),
        community: e.map.meta,
        facts: () => ({ half: e.map.bounds.half, zones: e.map.zones.length, night: !!e.map.sky?.night }),
        layout: () => this.maps.arena(e.key),
      })),
    ];
    const keys = arenas.map((a) => a.key);
    const last = lastArena();
    const picker = new ArenaPicker({
      arenas,
      selected: keys.find((k) => k === last) ?? keys.find((k) => k === this.game.arenaId) ?? null,
      last: keys.find((k) => k === last) ?? null,
      onPick: (choice) => {
        const arena = choice === "random" ? keys[Math.floor(Math.random() * keys.length)] : choice;
        if (choice !== "random") rememberArena(arena);
        go(arena);
      },
    });
    this.menu.show({
      id: "arena",
      title: t("menu.arena.title"),
      subtitle: label,
      content: picker.element,
      onClose: () => picker.dispose(),
      entries: [
        { label: t("maps.manage"), detail: t("maps.manageDetail"), onSelect: () => this.showMaps(() => this.pickArena(mode)) },
        { label: t("common.back"), onSelect: back },
      ],
      back,
    });
    picker.focus();
  }

  // --- Cartes communautaires ---

  /** Les cartes communautaires : chacune (exporter, supprimer), et en importer une ; `note` : ce qui vient de se passer. */
  private showMaps(back: () => void, note?: string): void {
    // (celles reçues d'un serveur aussi : on peut les garder pour soi, en les exportant, ou les supprimer)
    const list = this.maps.list(["bundled", "library", "server"]);
    this.menu.show({
      id: "maps",
      title: t("maps.title"),
      subtitle: note ?? t("maps.subtitle"),
      entries: [
        ...list.map((e): MenuEntry => ({
          label: mapName(e.map),
          detail: `${t(`maps.origin.${e.origin}`)} · ${communityInfo(e.map.meta)}`,
          onSelect: () => this.showMapEntry(e, back),
        })),
        { label: t("maps.import"), detail: t("maps.importDetail"), primary: !list.length, onSelect: () => void this.importMap(back) },
        { label: t("editor.mapsNew"), detail: t("editor.mapsNewDetail"), onSelect: () => void this.openEditor({ kind: "new" }) },
        { label: t("common.back"), onSelect: back },
      ],
      footer: !this.maps.persistent ? t("maps.storage") : list.length ? undefined : t("maps.empty"),
      back,
    });
  }

  /** Une carte : qui l'a faite, sa licence, ses ressources (un paquet) ; l'exporter, la supprimer. `note` : ce qui vient de se passer. */
  private showMapEntry(entry: MapEntry, outer: () => void, note?: string): void {
    const back = (): void => this.showMaps(outer);
    const meta = entry.map.meta;
    const name = mapName(entry.map);
    const packaged = !!entry.map.assets;
    const exported = async (): Promise<void> => {
      if (!packaged) downloadMap(entry.map);
      else if (!(await downloadPackage(entry.map, this.maps.assets))) this.showMapEntry(entry, outer, t("maps.exportMissing"));
    };
    this.menu.show({
      id: `map-${entry.key}`,
      title: name,
      subtitle: note ?? [t("maps.by", { author: meta.author }), t("maps.license", { license: meta.license }), t(`maps.origin.${entry.origin}`), ...(packaged ? [assetsLine(entry.map)] : [])].join(" · "),
      entries: [
        { label: t("maps.export"), detail: t(packaged ? "maps.exportPackageDetail" : "maps.exportDetail"), primary: true, onSelect: () => void exported() },
        { label: t("editor.mapsEdit"), detail: t("editor.mapsEditDetail"), onSelect: () => void this.openEditor({ kind: "entry", entry }) },
        {
          label: t("maps.delete"),
          detail: t("maps.deleteDetail"),
          disabled: entry.origin === "bundled",
          onSelect: () => void this.maps.remove(entry.key).then(() => this.showMaps(outer, t("maps.deleted", { name }))),
        },
        { label: t("common.back"), onSelect: back },
      ],
      footer: meta.description ? communityInfo(meta) : undefined,
      back,
    });
  }

  /**
   * Importe une carte (un fichier .casse-map.json, ou un paquet .casse-map.zip avec ses modèles et son
   * ambiance) : vérifiée, puis gardée dans ce navigateur ; refusée, on dit pourquoi.
   */
  private async importMap(back: () => void): Promise<void> {
    const file = await pickFile(".json,.zip,application/json,application/zip");
    if (!file) return;
    let result: ImportResult;
    try {
      result = await this.maps.importFile(file);
    } catch {
      this.showMaps(back, t("maps.unreadable"));
      return;
    }
    if (!result.ok) {
      this.showMapIssues(file.name, result.issues, () => this.showMaps(back));
      return;
    }
    const name = mapName(result.entry.map);
    this.showMaps(back, result.fresh ? t("maps.imported", { name }) : t("maps.already", { name }));
  }

  /** Pourquoi une carte est refusée : une ligne par problème. */
  private showMapIssues(file: string, issues: readonly MapIssue[], back: () => void): void {
    this.menu.show({
      id: "mapIssues",
      title: t("maps.invalidTitle"),
      subtitle: file,
      rows: issues.map((issue): SettingRow => ({ kind: "note", label: mapIssueText(issue) })),
      entries: [{ label: t("common.back"), onSelect: back }],
      back,
    });
  }

  /**
   * Partie d'essai sur une carte (pour l'éditeur de cartes) : la carte est vérifiée et devient une
   * arène jouable, puis on choisit un robot (sauf s'il est donné, `pilot`) et la partie commence
   * (mode Bataille par défaut) derrière l'écran de chargement. `back` : le retour du choix du robot.
   * Rend les problèmes de la carte : s'il y en a, rien n'est lancé.
   */
  testMap(map: MapFile, options: { mode?: GameModeId; pilot?: BotProfile; back?: () => void } = {}): readonly MapIssue[] {
    const check = checkMap(map);
    if (!check.map || check.issues.length) return check.issues.length ? check.issues : [{ code: "json" }];
    const arena = registerMap(check.map).id;
    // La carte essayée avant (une autre version du brouillon) : oubliée, si personne d'autre ne la connaît
    if (this.testArena && this.testArena !== arena && isMapKey(this.testArena) && !this.maps.get(this.testArena) && this.game.arenaId !== this.testArena) unregisterArena(this.testArena);
    this.testArena = arena;
    const mode = options.mode ?? "battle";
    if (!GAME_MODES[mode].pilot) this.play(mode, null, arena);
    else if (options.pilot) this.play(mode, options.pilot, arena);
    else {
      this.enter("title");
      this.pickRobot(`${modeName(mode)} · ${arenaName(arena)}`, (p) => this.play(mode, p, arena), options.back ?? (() => this.renderTitle()));
    }
    return [];
  }

  /**
   * Choix du robot à piloter (partie, multijoueur) : ceux du garage d'abord (ceux auxquels il manque
   * des pièces à débloquer se voient, sans se jouer), puis les robots prédéfinis ; le dernier choisi
   * est sélectionné d'emblée.
   */
  private pickRobot(subtitle: string, onPick: (profile: BotProfile) => void, back: () => void): void {
    const own = loadRobots()
      .filter((r) => !validateDesign(r.design).length)
      .map((r) => profileFromDesign(r.name, r.color, r.design));
    const cards = [
      ...own.map((profile, i) => robotCard(profile, true, i, lockedParts(profile.design, (part) => this.progress.has(part)))),
      ...PILOTABLE.map((profile, i) => robotCard(profile, false, own.length + i)),
    ];
    this.showPicker(t("menu.robot.title"), subtitle, back, {
      cards,
      last: lastPick(),
      action: () => t("menu.robot.pilot"),
      allowLocked: false,
      onPick: (card) => {
        rememberPick(card.profile.id);
        onPick(card.profile);
      },
    });
  }

  /** Écran de choix d'un robot (liste, filtres, aperçu) ; Échap ou « Retour » : `back`. */
  private showPicker(title: string, subtitle: string, back: () => void, options: PickerOptions): void {
    const picker = new RobotPicker(options);
    this.menu.show({
      title,
      subtitle,
      content: picker.element,
      onClose: () => picker.dispose(),
      entries: [{ label: t("common.back"), onSelect: back }],
      back,
    });
    picker.focus();
  }

  /**
   * Lance une partie, derrière l'écran de chargement : l'arène et les robots sont construits, la
   * partie reste figée pendant qu'on prépare ce qu'elle montrera (effets, shaders) et sa musique ;
   * elle ne commence (sirène, compte à rebours, commandes) qu'une fois tout prêt.
   */
  private play(mode: GameModeId, pilot: BotProfile | null, arena?: ArenaKey, roster: readonly BotProfile[] | null = null): void {
    const ticket = ++this.loadTicket;
    this.enter("loading");
    this.menu.hide();
    // L'essai d'un robot du garage garde la musique du garage
    const theme: MusicTheme = mode === "trial" ? "garage" : "battle";
    const target = arena ?? this.game.arenaId;
    const where = arenaName(target);
    this.loading.show([modeName(mode), where, pilot && botName(pilot)].filter(Boolean).join(" · "));
    this.loading.progress(0.03, t("menu.loading.arena"));
    void (async () => {
      // Une grande arène du jeu : son fichier d'abord (téléchargé une fois : client/maps/gameArenas.ts)
      try {
        await loadArena(target);
      } catch (e) {
        console.warn(`Arène ${target} : fichier impossible à charger`, e);
        if (ticket === this.loadTicket) this.arenaUnavailable(where);
        return;
      }
      if (ticket !== this.loadTicket) return;
      this.loading.progress(0.05, t("menu.loading.match"));
      // L'écran de chargement s'affiche avant la construction (un travail d'un bloc)
      await nextPaint();
      if (ticket !== this.loadTicket) return;
      this.game.startMode(mode, pilot, arena, roster);
      this.game.hold();
      // La partie solo dans un Worker : son monde arrive à la première image
      await this.game.worldReady();
      if (ticket !== this.loadTicket) return;
      if (!(await this.prepareMatch(ticket, theme))) return;
      this.beginMatch(theme);
    })();
  }

  /** Prépare ce que la partie montrera et sa musique ; faux si ce chargement a été abandonné entre-temps. */
  private async prepareMatch(ticket: number, theme: MusicTheme): Promise<boolean> {
    let music = 0;
    let effects = 0;
    const report = (): void => this.loading.progress(0.3 + 0.7 * (0.25 * music + 0.75 * effects), effects < 1 ? t("menu.loading.effects") : t("menu.loading.music"));
    report();
    await Promise.all([
      this.game.sound.prepareMusic(theme).then(() => {
        music = 1;
        report();
      }),
      this.game.prewarm((done) => {
        effects = done;
        report();
      }),
    ]);
    return ticket === this.loadTicket && this.state === "loading";
  }

  /** Tout est prêt : la partie commence. */
  private beginMatch(theme: MusicTheme): void {
    this.loading.progress(1, t("menu.loading.go"));
    this.loading.hide();
    this.enter("playing");
    this.game.sound.playMusic(theme);
    this.game.release();
    this.canvas.focus();
    if (this.game.piloting) this.game.controls.captureMouse();
  }

  /**
   * Abandonne le chargement d'une partie en cours (retour au menu, liaison coupée). Pas celui du
   * démarrage du jeu, que l'écran titre attend derrière l'écran de chargement (voir `boot`).
   */
  private cancelLoading(): void {
    this.loadTicket++;
    if (this.state === "loading") this.loading.hide();
  }

  /** Le fichier d'une arène du jeu n'a pas pu se charger (le réseau) : on le dit, par-dessus l'écran titre. */
  private arenaUnavailable(name: string): void {
    this.showTitle();
    const back = (): void => this.showTitle();
    this.menu.show({
      id: "arenaUnavailable",
      title: t("menu.arena.unavailable"),
      subtitle: t("menu.arena.unavailableDetail", { name }),
      entries: [{ label: t("common.back"), primary: true, onSelect: back }],
      back,
    });
  }

  /** La touche qui reprend la partie, sous « Reprendre » (au doigt, il n'y en a pas : le bouton de pause). */
  private get escapeHint(): string | undefined {
    return this.touchHud.active ? undefined : codeLabel("Escape");
  }

  private pause(): void {
    this.enter("paused");
    this.game.frozen = true;
    this.game.closeOverlays();
    if (this.game.online) {
      // En réseau, la partie continue sur le serveur : la pause ne fait que relâcher les commandes
      this.menu.show({
        id: "pause",
        tiles: true,
        title: t("menu.pause.title"),
        subtitle: t("menu.pause.online"),
        entries: [
          { label: t("menu.pause.resume"), detail: this.escapeHint, primary: true, onSelect: () => this.resume() },
          { label: t("menu.settings.title"), onSelect: () => this.showSettings(() => this.pause()) },
          ...this.fullscreenEntry(),
          { label: t("menu.pause.quit"), onSelect: () => this.showTitle() },
        ],
      });
      return;
    }
    const mode = this.game.mode;
    const pilot = this.game.playerProfile;
    this.menu.show({
      id: "pause",
      tiles: true,
      title: t("menu.pause.title"),
      subtitle: pilot ? `${modeName(mode)} · ${botName(pilot)}` : modeName(mode),
      entries: [
        { label: t("menu.pause.resume"), detail: this.escapeHint, primary: true, onSelect: () => this.resume() },
        ...(this.trial ? [{ label: t("menu.pause.garage"), onSelect: () => this.openGarage(this.trial) }] : []),
        ...(this.editorTest ? [{ label: t("editor.back"), onSelect: () => this.returnToEditor() }] : []),
        { label: t("menu.pause.restart"), detail: t("menu.pause.restartDetail"), onSelect: () => this.play(mode, pilot) },
        ...(GAME_MODES[mode].pilot && !this.trial
          ? [{ label: t("menu.pause.changeRobot"), onSelect: () => this.pickRobot(modeName(mode), (p) => this.play(mode, p), () => this.pause()) }]
          : []),
        { label: t("menu.settings.title"), onSelect: () => this.showSettings(() => this.pause()) },
        ...this.fullscreenEntry(),
        { label: t("menu.pause.main"), onSelect: () => this.showTitle() },
      ],
    });
  }

  private resume(): void {
    this.enter("playing");
    if (!this.trial) this.game.sound.playMusic("battle");
    this.menu.hide();
    this.game.frozen = false;
    this.game.inputEnabled = true;
    this.canvas.focus();
    if (this.game.piloting) this.game.controls.captureMouse();
  }

  /** Fin de partie : le résultat et le score ; la bataille continue derrière, sans le joueur. */
  private showResult(winner: Team | "draw"): void {
    if (this.state !== "playing") return;
    this.enter("over");
    this.game.inputEnabled = false;
    const score = this.game.world.match?.score ?? { blue: 0, red: 0 };
    const team = this.game.world.player?.team ?? "blue";
    const title = winner === "draw" ? t("menu.result.draw") : winner === team ? t("menu.result.victory") : t("menu.result.defeat");
    this.game.sound.stinger(winner === team ? "victory" : "defeat");
    // Crédits de la partie, et leur détail
    const reward = matchReward({ outcome: winner === "draw" ? "draw" : winner === team ? "win" : "loss", ...this.game.matchStats });
    this.progress.earn(reward.total);
    this.game.resetMatchStats();
    // Les crédits tombent juste après le motif de fin
    if (reward.total > 0) window.setTimeout(() => this.game.sound.ui("credits"), 1400);
    const keys: [string, string][] = [
      ...reward.lines.map((line): [string, string] => [`+${line.credits}`, rewardLineText(line)]),
      [`+${reward.total}`, t("menu.result.earned", { n: reward.total, total: this.progress.credits })],
    ];
    const scoreLine = t("menu.result.score", { blue: Math.floor(score.blue), red: Math.floor(score.red) });
    if (this.game.online) {
      this.menu.show({
        id: "result",
        tiles: true,
        title,
        subtitle: t("menu.result.nextMatch", { score: scoreLine }),
        entries: [
          { label: t("menu.result.continue"), primary: true, onSelect: () => this.resume() },
          { label: t("menu.pause.quit"), onSelect: () => this.showTitle() },
        ],
        keys,
      });
      return;
    }
    const mode = this.game.mode;
    const pilot = this.game.playerProfile;
    this.menu.show({
      id: "result",
      tiles: true,
      title,
      subtitle: scoreLine,
      keys,
      entries: [
        ...(this.editorTest ? [{ label: t("editor.back"), primary: true, onSelect: () => this.returnToEditor() }] : []),
        { label: t("menu.result.replay"), primary: !this.editorTest, onSelect: () => this.play(mode, pilot) },
        { label: t("menu.pause.changeRobot"), onSelect: () => this.pickRobot(modeName(mode), (p) => this.play(mode, p), () => this.showTitle()) },
        { label: t("menu.pause.main"), onSelect: () => this.showTitle() },
      ],
    });
  }

  // --- Multijoueur ---

  /** Nom du joueur et adresse du serveur, puis choix du robot. */
  private showMultiplayer(note?: string): void {
    this.enter("title");
    this.menu.show({
      id: "multiplayer",
      title: t("menu.multi.title"),
      subtitle: note ?? t("menu.multi.subtitle"),
      fields: [
        { label: t("menu.multi.name"), value: this.settings.name, placeholder: t("menu.multi.namePlaceholder"), onInput: (v) => this.remember({ name: v }) },
        { label: t("menu.multi.server"), value: this.settings.server, placeholder: defaultServer(), onInput: (v) => this.remember({ server: v }) },
      ],
      entries: [
        {
          label: t("menu.multi.join"),
          primary: true,
          onSelect: () => this.pickRobot(t("menu.multi.title"), (p) => this.connect(p), () => this.showMultiplayer()),
        },
        { label: t("common.back"), onSelect: () => this.renderTitle() },
      ],
      footer: t("menu.multi.footer", { port: DEFAULT_PORT }),
      back: () => this.renderTitle(),
    });
  }

  private remember(change: Partial<{ name: string; server: string }>): void {
    Object.assign(this.settings, change);
    saveSettings(this.settings);
  }

  /** Connexion au serveur avec ce robot ; la partie commence quand le serveur accepte le joueur. */
  private connect(profile: BotProfile): void {
    this.enter("connecting");
    const url = this.settings.server.trim() || defaultServer();
    const robot: RobotChoice = profile.id.startsWith("garage:")
      ? { name: profile.name ?? "", color: profile.color, design: profile.design }
      : { preset: profile.id };
    // Les cartes communautaires de ce navigateur : le serveur ne renvoie pas celles qu'on a, on garde celles qu'il envoie
    const net = new NetClient(url, { t: "join", version: PROTOCOL_VERSION, name: this.settings.name.trim(), robot, token: playerToken() }, this.maps);
    // Crédits et pièces sur ce serveur : une ligne dans le fil de la partie
    net.onProgress = (msg) => {
      const credits = t("net.credits", { n: msg.progress.credits });
      if (msg.t === "progress") this.game.note(t("net.earned", { total: msg.reward.total, lines: msg.reward.lines.map(rewardLineText).join(", "), credits }));
      else if (msg.bought) this.game.note(t("net.unlocked", { parts: msg.bought.parts.map(partName).join(", "), price: msg.bought.price, credits }));
      else this.game.note(credits);
    };
    // Le serveur a relancé sa salle après une erreur de la simulation : on y est toujours, dans une partie neuve
    net.onRestart = () => {
      this.game.resetMatchStats();
      this.game.notice(t("net.restarted"));
    };
    // Accepté : la partie se charge (le monde reçu du serveur, puis les effets et la musique) avant de s'afficher
    net.onWelcome = () => {
      if (this.state !== "connecting") return;
      const ticket = ++this.loadTicket;
      this.enter("loading");
      this.menu.hide();
      this.loading.show(`${t("menu.multi.title")} · ${url}`);
      this.loading.progress(0.05, t("menu.loading.receive"));
      this.game.startOnline(net);
      this.game.hold();
      void (async () => {
        await this.game.waitForOnlineWorld();
        if (ticket !== this.loadTicket || this.state !== "loading") return;
        if (!(await this.prepareMatch(ticket, "battle"))) return;
        this.beginMatch("battle");
      })();
    };
    net.onEnd = (reason) => {
      this.game.stopOnline();
      if (this.state === "connecting" || this.state === "loading" || this.state === "playing" || this.state === "paused" || this.state === "over") {
        this.cancelLoading();
        this.game.startDemo();
        this.showMultiplayer(reason);
      }
    };
    const cancel = (): void => {
      net.close();
      this.showMultiplayer();
    };
    this.menu.show({ id: "connecting", title: t("menu.multi.connecting"), subtitle: url, entries: [{ label: t("common.cancel"), onSelect: cancel }], back: cancel });
  }

  // --- Pour les outils qui pilotent le jeu dans un navigateur ---

  /*
   * La mesure du rendu et l'essai du rendu (tools/browser/) passent par la console (`__casse.screens`)
   * plutôt que par les menus, dont les libellés changent avec la langue.
   */

  /**
   * La bataille de la mesure du rendu (`npm run perf`) : les douze robots de `BATTLE_ROSTER` (ceux de
   * `npm run bench`), sans joueur, à la caméra libre, dans cette arène ; chargée comme une partie.
   */
  benchmark(arena: ArenaKey): void {
    this.play("arena", null, arena, BATTLE_ROSTER);
  }

  /** Le choix de l'arène d'un mode, sans passer par les menus (outils de tools/browser/). */
  showArenas(mode: GameModeId = "battle"): void {
    this.enter("title");
    this.pickArena(mode);
  }

  /** Rejoint le serveur de jeu (celui des réglages, sinon celui par défaut) avec ce robot de départ, sans passer par les menus. */
  joinServer(preset?: string): void {
    this.connect(PRESET_BOTS.find((p) => p.id === preset) ?? PRESET_BOTS[0]);
  }

  /** Ouvre le garage sur un robot de départ. */
  showGarage(): void {
    this.openGarage(null);
  }

  /** Ouvre l'éditeur de cartes sur une carte vierge. */
  showEditor(): Promise<void> {
    return this.openEditor({ kind: "new" });
  }

  /** Passe à ce préréglage graphique (enregistré et appliqué comme depuis les paramètres). */
  useGraphicsPreset(id: GraphicsPreset): void {
    Object.assign(this.settings, GRAPHICS_PRESETS[id]);
    this.commitSettings();
  }

  /** Une partie pilotée avec ce robot de départ (le premier sinon), dans cette arène, sans passer par les menus. */
  pilotMatch(preset?: string, arena?: ArenaKey, mode: GameModeId = "battle"): void {
    this.play(mode, PRESET_BOTS.find((p) => p.id === preset) ?? PRESET_BOTS[0], arena);
  }

  /** Les paramètres, à cet onglet (par-dessus l'écran titre), sans passer par les menus. */
  openSettings(tab?: SettingsTab): void {
    this.showSettings(() => this.renderTitle(), tab);
  }

  /** L'écran des touches, sans passer par les menus (il revient aux paramètres, onglet Contrôles). */
  openBindings(): void {
    this.showBindings(() => this.openSettings("controls"));
  }

  /** Change des réglages comme depuis les paramètres (appliqués, enregistrés) ; rend les réglages. */
  patchSettings(patch: Partial<Settings> = {}): Settings {
    Object.assign(this.settings, patch);
    this.commitSettings();
    return { ...this.settings };
  }

  // --- Éditeur de cartes ---

  /** Ouvre l'éditeur de cartes (le brouillon gardé, une carte vierge ou une carte de la bibliothèque) ; l'arène se met en veille. */
  private async openEditor(source: EditorSource): Promise<void> {
    if (this.editor.active) this.editor.close();
    this.enter("editor");
    this.trial = null;
    this.editorTest = false;
    this.menu.hide();
    this.game.inputEnabled = false;
    this.game.frozen = true;
    this.game.suspended = true;
    this.game.sound.playMusic("garage");
    await this.editor.open(source);
  }

  /**
   * Quitter l'éditeur : sans modification à perdre, tout de suite ; sinon, enregistrer, garder le
   * brouillon (l'éditeur le rouvrira), abandonner les modifications, ou revenir.
   */
  private leaveEditor(): void {
    if (!this.editor.dirty) {
      this.closeEditor(false);
      return;
    }
    const stay = (): void => this.menu.hide();
    this.menu.show({
      id: "editorLeave",
      title: t("editor.leave.title"),
      subtitle: t("editor.leave.subtitle"),
      entries: [
        {
          label: t("editor.leave.save"), detail: t("editor.leave.saveDetail"), primary: true,
          onSelect: () => {
            this.menu.hide();
            void this.editor.save().then((ok) => ok && this.closeEditor(false));
          },
        },
        { label: t("editor.leave.keep"), detail: t("editor.leave.keepDetail"), onSelect: () => this.closeEditor(false) },
        { label: t("editor.leave.discard"), detail: t("editor.leave.discardDetail"), onSelect: () => this.closeEditor(true) },
        { label: t("editor.leave.stay"), onSelect: stay },
      ],
      back: stay,
    });
  }

  /** Ferme l'éditeur (`drop` : son brouillon est effacé) et revient à l'écran titre. */
  private closeEditor(drop: boolean): void {
    this.editor.close(drop);
    this.game.suspended = false;
    this.showTitle();
  }

  /** Essayer la carte de l'éditeur : le mode (le dernier pris d'abord), puis le robot pour un mode piloté. */
  private chooseTestMode(map: MapFile): void {
    const back = (): void => this.menu.hide();
    this.menu.show({
      id: "editorTest",
      title: t("editor.test.title"),
      subtitle: t("editor.test.subtitle"),
      entries: [
        ...this.listedModes().map((id): MenuEntry => ({
          label: modeName(id),
          detail: modeInfo(id),
          primary: id === this.editor.testMode,
          onSelect: () => {
            this.editor.testMode = id;
            if (GAME_MODES[id].pilot) this.pickRobot(`${modeName(id)} · ${mapName(map)}`, (p) => this.startTest(map, id, p), () => this.chooseTestMode(map));
            else this.startTest(map, id, null);
          },
        })),
        { label: t("editor.back"), onSelect: back },
      ],
      back,
    });
  }

  /** La partie d'essai commence (l'éditeur se met de côté, au même état). */
  private startTest(map: MapFile, mode: GameModeId, pilot: BotProfile | null): void {
    this.editor.suspend();
    this.editorTest = true;
    this.game.suspended = false;
    const issues = this.testMap(map, { mode, pilot: pilot ?? undefined });
    if (issues.length) this.returnToEditor();
  }

  /** Retour à l'éditeur depuis la partie d'essai (la pause, la fin de partie) : au même état. */
  private returnToEditor(): void {
    this.cancelLoading();
    this.editorTest = false;
    this.enter("editor");
    this.menu.hide();
    if (document.pointerLockElement) document.exitPointerLock();
    this.game.inputEnabled = false;
    this.game.frozen = true;
    this.game.suspended = true;
    this.game.sound.playMusic("garage");
    this.editor.resume();
  }

  // --- Garage ---

  /** Ouvre le garage sur ce robot (ou sur un robot de départ) ; l'arène se met en veille. */
  private openGarage(robot: SavedRobot | null): void {
    this.enter("garage");
    this.trial = null;
    this.menu.hide();
    this.game.inputEnabled = false;
    this.game.frozen = true;
    this.game.suspended = true;
    document.body.classList.add("in-garage");
    this.game.sound.playMusic("garage");
    this.garage.open(robot ?? starterRobot());
  }

  private closeGarage(): void {
    this.lastRobot = this.garage.robot;
    this.garage.close();
    document.body.classList.remove("in-garage");
    this.game.suspended = false;
    this.showTitle();
  }

  /** Essai du robot du garage : on le pilote au milieu de robots qui ne tirent pas. */
  private tryRobot(profile: BotProfile, robot: SavedRobot): void {
    this.lastRobot = robot;
    this.garage.close();
    document.body.classList.remove("in-garage");
    this.game.suspended = false;
    this.play("trial", profile);
    this.trial = robot;
  }

  /**
   * Robots enregistrés (même inachevés : on les ouvre pour les finir), et robots prédéfinis à copier
   * comme point de départ.
   */
  private browseRobots(): void {
    const back = (): void => this.menu.hide();
    const own = loadRobots();
    const saved = new Map<RobotCard, SavedRobot>();
    const cards = [
      ...own.map((r, i) => {
        const card = robotCard(profileFromDesign(r.name, r.color, r.design), true, i);
        saved.set(card, r);
        return card;
      }),
      ...PRESET_BOTS.map((profile, i) => robotCard(profile, false, own.length + i)),
    ];
    this.showPicker(t("menu.robots.title"), own.length ? t("menu.robots.subtitle") : t("menu.robots.empty"), back, {
      cards,
      last: null,
      action: (card) => (card.own ? t("menu.robots.open") : t("menu.robots.copy")),
      allowLocked: true,
      onPick: (card) => {
        const p = card.profile;
        this.garage.load(saved.get(card) ?? { name: t("menu.robots.modified", { name: botName(p) }), color: p.color, design: structuredClone(p.design) });
        back();
      },
    });
  }

  private showKeys(back: () => void): void {
    const c = this.game.controls;
    const k = (id: ActionId): string => c.keyName(id, "keys");
    const p = (id: ActionId): string => c.padName(id);
    this.menu.show({
      id: "keys",
      title: t("menu.keys.title"),
      subtitle: t("menu.keys.subtitle"),
      entries: [{ label: t("common.back"), primary: true, onSelect: back }],
      keys: [...pilotKeys(k, p), ["", ""], ...freeKeys(k, p), ["", ""], [t("help.garage"), ""], ...garageKeys(k), ["", ""], [t("help.editor"), ""], ...editorKeys(k)],
      back,
    });
  }

  // --- Paramètres ---

  /**
   * Les onglets des paramètres : au doigt, le jeu au doigt d'abord, et le clavier, la souris et la
   * manette en dernier (ils restent là : une tablette avec un clavier, une manette branchée) ; sans
   * écran tactile, pas d'onglet Tactile.
   */
  private settingsTabs(): SettingsTab[] {
    return this.touchHud.active ? ["touch", "graphics", "sound", "profile", "controls"] : ["graphics", "controls", "sound", "profile"];
  }

  /** Paramètres, par onglets ; chaque changement est appliqué et enregistré tout de suite. */
  private showSettings(back: () => void, tab?: SettingsTab): void {
    const tabs = this.settingsTabs();
    const shown = tab ?? (this.settingsTab && tabs.includes(this.settingsTab) ? this.settingsTab : tabs[0]);
    this.settingsTab = shown;
    const redraw = (): void => this.showSettings(back, shown);
    const set: Setter = (key) => (value) => {
      this.settings[key] = value;
      this.commitSettings();
      redraw();
    };
    const again = (): void => this.showSettings(back, "controls");
    const rows = {
      graphics: () => this.graphicsRows(set, redraw),
      controls: () => this.controlRows(set, () => this.showKeys(again), () => this.showBindings(again)),
      touch: () => this.touchRows(set),
      sound: () => this.soundRows(set, redraw),
      profile: () => this.profileRows(set),
    }[shown]();
    this.redrawSettings = redraw;
    this.menu.show({
      id: "settings",
      title: t("menu.settings.title"),
      tabs: { labels: tabs.map((id) => t(SETTINGS_TABS[id])), active: tabs.indexOf(shown), onSelect: (i) => this.showSettings(back, tabs[i]) },
      rows,
      onClose: () => {
        if (this.redrawSettings === redraw) this.redrawSettings = null;
      },
      entries: [
        { label: t("common.back"), primary: true, onSelect: back },
        {
          label: t("menu.settings.defaults"),
          detail: t("menu.settings.defaultsDetail"),
          onSelect: () => {
            const { name, server, language } = this.settings;
            this.keyNote = null;
            Object.assign(this.settings, defaultSettings(), { name, server, language });
            this.commitSettings();
            redraw();
          },
        },
      ],
      back,
    });
  }

  /**
   * Les touches de chaque action, au clavier, à la souris et à la manette : un écran à part, ouvert
   * depuis l'onglet Contrôles (il encombrait l'onglet). Clic sur une case, puis la touche ; ↺ remet
   * celles par défaut d'une action. Le quitter (Retour, Échap, B) abandonne la réattribution en cours.
   */
  private showBindings(back: () => void): void {
    const redraw = (): void => this.showBindings(back);
    const k = (id: ActionId): string => this.game.controls.keyName(id, "keys");
    const leave = (): void => {
      this.stopListening();
      this.keyNote = null;
      back();
    };
    this.redrawSettings = redraw;
    this.menu.show({
      id: "bindings",
      title: t("menu.bind.title"),
      subtitle: t("menu.ctl.chooseDetail", { cancel: codeLabel("Escape"), clear: codeLabel("Mouse2"), example: k("garageUndo") }),
      rows: ACTION_CATEGORIES.flatMap((category): SettingRow[] => [
        { kind: "heading", label: categoryLabel(category), columns: [t("menu.ctl.colKey"), t("menu.ctl.colOther"), t("menu.ctl.colPad")] },
        ...ACTION_IDS.filter((id) => actionDef(id).category === category).map((id) => this.bindingRow(id, redraw)),
      ]),
      onClose: () => {
        if (this.redrawSettings === redraw) this.redrawSettings = null;
      },
      entries: [
        { label: t("common.back"), primary: true, onSelect: leave },
        {
          label: t("menu.ctl.allDefault"),
          detail: t("menu.bind.allDefaultDetail"),
          onSelect: () => {
            this.stopListening();
            this.settings.bindings = DEFAULT_BINDINGS;
            this.keyNote = null;
            this.commitSettings();
            redraw();
          },
        },
      ],
      back: leave,
    });
  }

  /**
   * Le moteur de rendu (render/engine.ts) : WebGPU ou WebGL. Il est pris au chargement de la page :
   * un autre choix le dit, et propose de recharger.
   */
  private rendererRows(set: Setter): SettingRow[] {
    const s = this.settings;
    const now = backendOf(this.game.engine);
    const names: Record<RenderBackend, string> = { webgpu: "WebGPU", webgl2: "WebGL 2", webgl1: "WebGL 1" };
    // (l'adresse de la page peut imposer l'un ou l'autre : `?renderer=`)
    const pending = requestedRenderer(s.renderer) !== this.bootRenderer;
    const detail = pending
      ? "menu.gfx.rendererPending"
      : this.bootRenderer === "webgpu" && now !== "webgpu"
        ? "menu.gfx.rendererRefused"
        : "menu.gfx.rendererDetail";
    const rows: SettingRow[] = [
      choiceRow(t("menu.gfx.renderer"), [{ value: "webgpu", label: "WebGPU" }, { value: "webgl", label: "WebGL" }], s.renderer, set("renderer"), t(detail, { now: names[now] })),
    ];
    if (pending) rows.push({ kind: "button", label: t("menu.gfx.rendererReload"), action: t("menu.gfx.rendererReloadAction"), onSelect: () => location.reload() });
    return rows;
  }

  /**
   * La simulation de la partie solo : celle du TypeScript, ou celle portée en Rust. Elle est prise au
   * chargement de la page : un autre choix le dit, et propose de recharger. Choisie ici, elle ne suit
   * plus celle par défaut (`simulationChosen`).
   */
  private simulationRows(set: Setter): SettingRow[] {
    const s = this.settings;
    const now = this.game.simulationEngine;
    const names = { ts: "TypeScript", rust: "Rust", page: t("menu.gfx.simulationPage") };
    const pending = requestedSimulation(s.simulation) !== this.bootSimulation;
    const detail = pending ? "menu.gfx.simulationPending" : "menu.gfx.simulationDetail";
    const choose = (value: Settings["simulation"]): void => {
      s.simulationChosen = true;
      set("simulation")(value);
    };
    const rows: SettingRow[] = [
      choiceRow(t("menu.gfx.simulation"), [{ value: "rust", label: "Rust" }, { value: "ts", label: "TypeScript" }], s.simulation, choose, t(detail, { now: names[now] })),
    ];
    if (pending) rows.push({ kind: "button", label: t("menu.gfx.simulationReload"), action: t("menu.gfx.rendererReloadAction"), onSelect: () => location.reload() });
    return rows;
  }

  private graphicsRows(set: Setter, redraw: () => void): SettingRow[] {
    const s = this.settings;
    const preset = graphicsPreset(s);
    const levels = (): { value: "low" | "medium" | "high"; label: string }[] => [
      { value: "low", label: t("menu.gfx.low") },
      { value: "medium", label: t("menu.gfx.medium") },
      { value: "high", label: t("menu.gfx.high") },
    ];
    const presets: { value: GraphicsPreset | "custom"; label: string }[] = [
      ...levels(),
      ...(preset ? [] : [{ value: "custom" as const, label: t("menu.gfx.custom") }]),
    ];
    const engine = this.game.engine;
    return [
      choiceRow(t("menu.gfx.quality"), presets, preset ?? "custom", (id) => {
        if (id === "custom") return;
        Object.assign(s, GRAPHICS_PRESETS[id]);
        this.commitSettings();
        redraw();
      }, t("menu.gfx.qualityDetail")),
      ...this.rendererRows(set),
      ...this.simulationRows(set),
      { kind: "toggle", label: t("menu.gfx.shadows"), detail: t("menu.gfx.shadowsDetail"), value: s.shadows, onChange: set("shadows") },
      choiceRow(
        t("menu.gfx.shadowQuality"),
        levels(),
        s.shadowQuality,
        set("shadowQuality"),
        s.shadows ? t("menu.gfx.shadowQualityDetail") : t("menu.gfx.shadowQualityOff"),
      ),
      choiceRow(
        t("menu.gfx.farShadows"),
        [{ value: "every", label: t("menu.gfx.farShadowsEvery") }, { value: "half", label: t("menu.gfx.farShadowsHalf") }],
        s.farShadows,
        set("farShadows"),
        s.shadows ? t("menu.gfx.farShadowsDetail") : t("menu.gfx.shadowQualityOff"),
      ),
      choiceRow(
        t("menu.gfx.renderScale"),
        [0.5, 0.75, 1].map((value) => ({ value, label: pct(value) })),
        s.renderScale,
        set("renderScale"),
        t("menu.gfx.renderScaleDetail", { width: engine.getRenderWidth(), height: engine.getRenderHeight() }),
      ),
      choiceRow(
        t("menu.gfx.effects"),
        [{ value: "full", label: t("menu.gfx.effectsFull") }, { value: "reduced", label: t("menu.gfx.effectsReduced") }],
        s.effects,
        set("effects"),
        t("menu.gfx.effectsDetail"),
      ),
      choiceRow(
        t("menu.gfx.fxLook"),
        [{ value: "realistic", label: t("menu.gfx.fxLookRealistic") }, { value: "simple", label: t("menu.gfx.fxLookSimple") }],
        s.fxLook,
        set("fxLook"),
        t("menu.gfx.fxLookDetail"),
      ),
      { kind: "toggle", label: t("menu.gfx.glow"), detail: t("menu.gfx.glowDetail"), value: s.glow, onChange: set("glow") },
      { kind: "toggle", label: t("menu.gfx.lights"), detail: t("menu.gfx.lightsDetail"), value: s.lights, onChange: set("lights") },
      { kind: "toggle", label: t("menu.gfx.haze"), detail: t("menu.gfx.hazeDetail"), value: s.heatHaze, onChange: set("heatHaze") },
      {
        kind: "slider", label: t("menu.gfx.fov"), detail: t("menu.gfx.fovDetail"),
        value: s.fov, min: FOV_RANGE.min, max: FOV_RANGE.max, step: 1, format: (v) => measure(v, "deg"),
        onChange: (v, done) => this.slide("fov", v, done, redraw),
      },
      { kind: "toggle", label: t("menu.gfx.fps"), detail: t("menu.gfx.fpsDetail"), value: s.showFps, onChange: set("showFps") },
    ];
  }

  private controlRows(set: Setter, showKeys: () => void, showBindings: () => void): SettingRow[] {
    const s = this.settings;
    const c = this.game.controls;
    const k = (id: ActionId): string => c.keyName(id, "keys");
    return [
      { kind: "heading", label: t("menu.ctl.mouse") },
      {
        kind: "slider", label: t("menu.ctl.sensitivity"), detail: t("menu.ctl.sensitivityDetail"),
        value: s.sensitivity, min: SENSITIVITY_RANGE.min, max: SENSITIVITY_RANGE.max, step: 0.05,
        format: (v) => measure(v, "times", 2),
        onChange: (v, done) => this.slide("sensitivity", v, done),
      },
      { kind: "toggle", label: t("menu.ctl.invertX"), detail: t("menu.ctl.invertXDetail"), value: s.invertX, onChange: set("invertX") },
      { kind: "toggle", label: t("menu.ctl.invertY"), detail: t("menu.ctl.invertYDetail"), value: s.invertY, onChange: set("invertY") },
      choiceRow(
        t("menu.ctl.scope", { key: k("scope") }),
        [{ value: "hold", label: t("menu.ctl.scopeHold") }, { value: "toggle", label: t("menu.ctl.scopeToggle") }],
        s.scopeToggle ? "toggle" : "hold",
        (v) => set("scopeToggle")(v === "toggle"),
        s.scopeToggle ? t("menu.ctl.scopeToggleDetail") : t("menu.ctl.scopeHoldDetail"),
      ),
      { kind: "heading", label: t("menu.ctl.driving") },
      choiceRow(
        t("menu.ctl.ground"),
        [{ value: "camera", label: t("menu.ctl.groundCamera") }, { value: "tank", label: t("menu.ctl.groundTank") }],
        s.drive,
        set("drive"),
        t(s.drive === "camera" ? "menu.ctl.groundCameraDetail" : "menu.ctl.groundTankDetail", {
          forward: k("forward"), left: k("left"), back: k("back"), right: k("right"), yawLeft: k("yawLeft"), yawRight: k("yawRight"),
        }),
      ),
      choiceRow(
        t("menu.ctl.plane"),
        [{ value: "mouse", label: t("menu.ctl.planeMouse") }, { value: "manual", label: t("menu.ctl.planeManual") }],
        s.flight,
        set("flight"),
        t(s.flight === "manual" ? "menu.ctl.planeManualDetail" : "menu.ctl.planeMouseDetail", {
          forward: k("forward"), back: k("back"), left: k("left"), right: k("right"), yawLeft: k("yawLeft"), yawRight: k("yawRight"),
          climb: k("climb"), descend: k("descend"), cut: k("cutEngine"), mode: k("flightMode"),
        }),
      ),
      ...this.padRows(set),
      { kind: "heading", label: t("menu.ctl.keys") },
      { kind: "button", label: t("menu.ctl.choose"), detail: t("menu.ctl.openDetail"), action: t("menu.ctl.open"), onSelect: showBindings },
      { kind: "button", label: t("menu.ctl.all"), detail: t("menu.ctl.allDetail"), action: t("menu.ctl.see"), onSelect: showKeys },
    ];
  }

  /**
   * Le jeu au doigt (onglet Tactile, le premier au doigt) : la visée (en glissant le doigt ou au
   * manche de visée, ses sensibilités, l'axe vertical, le viseur), les commandes à l'écran (taille,
   * opacité, gaucher) et la direction du robot.
   */
  private touchRows(set: Setter): SettingRow[] {
    const s = this.settings;
    const stick = s.touchAim === "stick";
    const times = (v: number): string => measure(v, "times", 2);
    const rows: SettingRow[] = [
      { kind: "heading", label: t("menu.touch.aimHeading") },
      choiceRow(
        t("menu.touch.aim"),
        [{ value: "swipe", label: t("menu.touch.aimSwipe") }, { value: "stick", label: t("menu.touch.aimStick") }],
        s.touchAim,
        set("touchAim"),
        t(stick ? "menu.touch.aimStickDetail" : "menu.touch.aimSwipeDetail"),
      ),
      {
        kind: "slider", label: t("menu.touch.sensitivity"), detail: t("menu.touch.sensitivityDetail"),
        value: s.touchSensitivity, min: SENSITIVITY_RANGE.min, max: SENSITIVITY_RANGE.max, step: 0.05, format: times,
        onChange: (v, done) => this.slide("touchSensitivity", v, done),
      },
    ];
    if (stick) {
      rows.push({
        kind: "slider", label: t("menu.touch.stickSensitivity"), detail: t("menu.touch.stickSensitivityDetail"),
        value: s.touchStickSensitivity, min: SENSITIVITY_RANGE.min, max: SENSITIVITY_RANGE.max, step: 0.05, format: times,
        onChange: (v, done) => this.slide("touchStickSensitivity", v, done),
      });
    }
    rows.push(
      { kind: "toggle", label: t("menu.touch.invertY"), detail: t("menu.touch.invertYDetail"), value: s.touchInvertY, onChange: set("touchInvertY") },
      choiceRow(
        t("menu.touch.scope"),
        [{ value: "toggle", label: t("menu.ctl.scopeToggle") }, { value: "hold", label: t("menu.ctl.scopeHold") }],
        s.touchScopeToggle ? "toggle" : "hold",
        (v) => set("touchScopeToggle")(v === "toggle"),
        t(s.touchScopeToggle ? "menu.touch.scopeToggleDetail" : "menu.touch.scopeHoldDetail"),
      ),
      { kind: "heading", label: t("menu.touch.layoutHeading") },
      {
        kind: "slider", label: t("menu.touch.size"), detail: t("menu.touch.sizeDetail"),
        value: Math.round(s.touchSize * 100), min: TOUCH_SIZE_RANGE.min * 100, max: TOUCH_SIZE_RANGE.max * 100, step: 5,
        format: (v) => pct(v / 100),
        onChange: (v, done) => this.slide("touchSize", v / 100, done),
      },
      {
        kind: "slider", label: t("menu.touch.opacity"), detail: t("menu.touch.opacityDetail"),
        value: Math.round(s.touchOpacity * 100), min: TOUCH_OPACITY_RANGE.min * 100, max: TOUCH_OPACITY_RANGE.max * 100, step: 5,
        format: (v) => pct(v / 100),
        onChange: (v, done) => this.slide("touchOpacity", v / 100, done),
      },
      { kind: "toggle", label: t("menu.touch.leftHanded"), detail: t("menu.touch.leftHandedDetail"), value: s.touchLeftHanded, onChange: set("touchLeftHanded") },
      { kind: "heading", label: t("menu.ctl.driving") },
      choiceRow(
        t("menu.ctl.ground"),
        [{ value: "camera", label: t("menu.ctl.groundCamera") }, { value: "tank", label: t("menu.touch.groundTank") }],
        s.drive,
        set("drive"),
        t(s.drive === "camera" ? "menu.touch.groundCameraDetail" : "menu.touch.groundTankDetail"),
      ),
    );
    return rows;
  }

  /** Réglages de la manette : son état, le regard au stick droit, la zone morte. */
  private padRows(set: Setter): SettingRow[] {
    const s = this.settings;
    const pad = this.game.controls.pad;
    return [
      { kind: "heading", label: t("menu.pad.heading") },
      {
        kind: "note",
        label: pad.id ? t("menu.pad.connected") : t("menu.pad.none"),
        detail: pad.id
          ? t("menu.pad.connectedDetail", {
            id: pad.id, move: padLabel("StickL"), look: padLabel("StickR"), scope: this.game.controls.padName("scope"), fire: this.game.controls.padName("fire"),
            accept: padLabel("Pad0", pad.style), back: padLabel("Pad1", pad.style),
          })
          : t("menu.pad.noneDetail"),
      },
      {
        kind: "slider", label: t("menu.pad.sensitivity"), detail: t("menu.pad.sensitivityDetail"),
        value: s.padSensitivity, min: SENSITIVITY_RANGE.min, max: SENSITIVITY_RANGE.max, step: 0.05,
        format: (v) => measure(v, "times", 2),
        onChange: (v, done) => this.slide("padSensitivity", v, done),
      },
      { kind: "toggle", label: t("menu.pad.invertX"), value: s.padInvertX, onChange: set("padInvertX") },
      { kind: "toggle", label: t("menu.pad.invertY"), detail: t("menu.pad.invertYDetail"), value: s.padInvertY, onChange: set("padInvertY") },
      {
        kind: "slider", label: t("menu.pad.deadzone"), detail: t("menu.pad.deadzoneDetail"),
        value: Math.round(s.padDeadzone * 100), min: DEADZONE_RANGE.min * 100, max: DEADZONE_RANGE.max * 100, step: 1,
        format: (v) => pct(v / 100),
        onChange: (v, done) => this.slide("padDeadzone", v / 100, done),
      },
    ];
  }

  /** La ligne des touches d'une action : deux cases au clavier (ou à la souris), une à la manette. */
  private bindingRow(id: ActionId, redraw: () => void): SettingRow {
    const def = actionDef(id);
    const c = this.game.controls;
    const b = this.settings.bindings[id];
    const slot = (which: Slot): BindingSlotView => {
      const editable = isEditable(id, which);
      const code = editable ? slotCode(b, which) : which === "pad" ? def.fixedPad ?? null : which === 0 ? def.fixedKey ?? null : null;
      const listening = this.listening?.action === id && this.listening.slot === which;
      const name = code ? (which === "pad" ? padLabel(code, c.pad.style) : codeLabel(code, c.layout)) : "—";
      return {
        text: listening ? t("menu.bind.listening") : name,
        listening,
        fixed: !editable,
        title: !editable ? t(which === "pad" && isToolAction(id) ? "menu.bind.noPad" : "menu.bind.fixed")
          : listening ? t("menu.bind.cancel", { key: codeLabel("Escape") })
            : t(which === "pad" ? "menu.bind.choosePad" : "menu.bind.chooseKey", { clear: codeLabel("Mouse2") }),
        onSelect: editable ? () => this.listen(id, which, redraw) : undefined,
        onClear: editable ? () => this.assignKey(id, which, null, redraw) : undefined,
      };
    };
    const reset = (): void => {
      this.stopListening();
      const r = resetAction(this.settings.bindings, id);
      this.settings.bindings = r.bindings;
      this.keyNote = r.displaced.length ? { action: id, text: this.displacedText(r.displaced) } : null;
      this.commitSettings();
      redraw();
    };
    return {
      kind: "binding",
      label: actionLabel(id),
      detail: actionDetail(id),
      note: this.keyNote?.action === id ? this.keyNote.text : undefined,
      slots: [slot(0), slot(1), slot("pad")],
      onReset: isDefault(this.settings.bindings, id) ? undefined : reset,
    };
  }

  /** Ce qu'une attribution a changé ailleurs, en une phrase. */
  private displacedText(displaced: readonly Displaced[]): string {
    const c = this.game.controls;
    const name = (code: string, slot: Slot): string => (slot === "pad" ? padLabel(code, c.pad.style) : codeLabel(code, c.layout));
    return displaced.map((d) => {
      const action = actionLabel(d.action);
      const key = name(d.code, d.slot);
      return d.replacement
        ? t("menu.bind.swapped", { key, action, replacement: name(d.replacement, d.slot) })
        : t("menu.bind.removed", { key, action });
    }).join(" ");
  }

  /** Donne une touche (null : aucune) à une case, et dit ce que cela change ailleurs. */
  private assignKey(action: ActionId, slot: Slot, code: string | null, redraw: () => void): void {
    const r = assignBinding(this.settings.bindings, action, slot, code);
    const c = this.game.controls;
    if (r.refused) {
      const key = code ? (slot === "pad" ? padLabel(code, c.pad.style) : codeLabel(code, c.layout)) : t("common.none");
      const text = r.refused === "reserved" ? t("menu.bind.reserved", { key })
        : r.refused === "wheel" ? t("menu.bind.wheel")
          : t("menu.bind.invalid", { key });
      this.keyNote = { action, text };
      this.game.sound.ui("error");
    } else {
      this.settings.bindings = r.bindings;
      this.keyNote = r.displaced.length ? { action, text: this.displacedText(r.displaced) } : null;
      this.commitSettings();
    }
    redraw();
  }

  /**
   * Écoute la prochaine touche, bouton de la souris (molette comprise) ou de la manette pour cette
   * case. Échap (ou Menu à la manette) annule ; rien d'autre ne réagit à cet appui.
   */
  private listen(action: ActionId, slot: Slot, redraw: () => void): void {
    this.stopListening();
    this.keyNote = null;
    const c = this.game.controls;
    const pad = slot === "pad";
    const swallow = (e: Event): void => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    // Une seule fois (une touche de modification relâchée après le clic qu'elle accompagnait ne compte pas)
    let finished = false;
    const done = (code: string | null): void => {
      if (finished) return;
      finished = true;
      this.stopListening();
      if (code) this.assignKey(action, slot, code, redraw);
      else redraw();
    };
    // Au garage, une combinaison : les touches de modification tenues comptent (Ctrl+Z, Maj+R, Maj + clic)
    const chords = isToolAction(action);
    /** Une touche de modification seule, appuyée : elle compte si on la relâche sans rien d'autre. */
    let lone: string | null = null;
    const onKey = (e: KeyboardEvent): void => {
      if (!e.isTrusted) return;
      swallow(e);
      if (e.repeat) return;
      // Le relâchement de cette touche ne doit rien activer non plus (Espace sur un bouton)
      const up = (u: KeyboardEvent): void => {
        if (u.code !== e.code) return;
        swallow(u);
        window.removeEventListener("keyup", up, true);
        if (lone === u.code) done(lone);
      };
      window.addEventListener("keyup", up, true);
      if (e.code === "Escape" || pad) return done(null);
      if (chords && isModifierKey(e.code)) {
        lone = e.code;
        return;
      }
      lone = null;
      done(chords ? eventChords(e)[0] : e.code);
    };
    const onMouse = (e: MouseEvent): void => {
      swallow(e);
      // Le clic qui suit (et le menu du clic droit) ne doit rien activer
      const after = (a: Event): void => swallow(a);
      for (const type of ["click", "auxclick", "contextmenu"]) window.addEventListener(type, after, true);
      window.addEventListener("mouseup", () => window.setTimeout(() => {
        for (const type of ["click", "auxclick", "contextmenu"]) window.removeEventListener(type, after, true);
      }, 0), { capture: true, once: true });
      done(chords ? chordCode(`Mouse${e.button}`, e) : `Mouse${e.button}`);
    };
    const onWheel = (e: WheelEvent): void => {
      if (!e.deltaY) return;
      swallow(e);
      done(e.deltaY < 0 ? "WheelUp" : "WheelDown");
    };
    window.addEventListener("keydown", onKey, true);
    if (!pad) {
      window.addEventListener("mousedown", onMouse, true);
      window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    }
    // Manette : le prochain bouton (Menu annule) ; pour une touche du clavier, B et Menu annulent
    c.padCapture = (code) => {
      if (code === "Pad9" || (!pad && code === "Pad1")) done(null);
      else if (pad) done(code);
    };
    this.listening = {
      action, slot,
      stop: () => {
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("mousedown", onMouse, true);
        window.removeEventListener("wheel", onWheel, true);
        c.padCapture = null;
      },
    };
    redraw();
  }

  /** Cesse d'écouter une nouvelle touche (choisie, annulée, ou l'écran a changé). */
  private stopListening(): void {
    this.listening?.stop();
    this.listening = null;
  }

  private soundRows(set: Setter, redraw: () => void): SettingRow[] {
    const s = this.settings;
    return [
      { kind: "toggle", label: t("menu.snd.sound"), detail: t("menu.snd.soundDetail"), value: s.sound, onChange: set("sound") },
      {
        kind: "slider", label: t("menu.snd.volume"), value: Math.round(s.volume * 100), min: 0, max: 100, step: 5,
        format: (v) => pct(v / 100),
        onChange: (v, done) => {
          this.slide("volume", v / 100, done, redraw);
          // Un son d'essai, au niveau choisi
          if (done) this.game.sound.ui("kill");
        },
      },
      {
        kind: "toggle", label: t("menu.snd.log"), detail: t("menu.snd.logDetail"),
        value: s.soundLog, onChange: set("soundLog"),
      },
      {
        kind: "slider", label: t("menu.snd.music"), value: Math.round(s.music * 100), min: 0, max: 100, step: 5,
        format: (v) => (v === 0 ? t("menu.snd.musicOff") : pct(v / 100)),
        onChange: (v, done) => this.slide("music", v / 100, done, redraw),
      },
      // Le lecteur des menus et du garage (par défaut : au doigt, il se réduit tout seul)
      choiceRow(
        t("menu.snd.player"),
        [
          { value: "always", label: t("menu.snd.playerAlways") },
          { value: "auto", label: t("menu.snd.playerAuto") },
          { value: "hidden", label: t("menu.snd.playerHidden") },
        ],
        s.musicPlayer,
        set("musicPlayer"),
        t(PLAYER_DETAILS[s.musicPlayer]),
      ),
      ...this.musicRows(),
    ];
  }

  /** La musique en cours, et de quoi passer au morceau suivant ou revenir au précédent (onglet Son). */
  private musicRows(): SettingRow[] {
    const now = this.game.sound.musicNow();
    const shown = now?.pending ?? now?.track ?? null;
    const title = shown ? trackTitle(shown) : "";
    const canSkip = !!now?.canSkip;
    return [
      {
        kind: "button", label: t("menu.snd.track"),
        detail: !now || !shown ? t("menu.snd.trackNone")
          : now.pending ? t("menu.snd.trackLoading", { title })
          : t("menu.snd.trackDetail", { title, screen: musicScreen(now) }),
        action: t("menu.snd.next"), disabled: !canSkip, onSelect: () => void this.game.sound.nextMusic(),
      },
      {
        kind: "button", label: t("menu.snd.previousTrack"),
        detail: now?.previous ? t("menu.snd.previousTitle", { title: trackTitle(now.previous) }) : t("menu.snd.previousNone"),
        action: t("menu.snd.previous"), disabled: !canSkip || !now?.previous, onSelect: () => void this.game.sound.previousMusic(),
      },
    ];
  }

  /**
   * La musique a changé : le lecteur l'annonce (un mot quelques secondes quand un morceau d'écran
   * commence, ou quand le joueur a demandé autre chose ; rien si la musique est coupée : `setMuted`) ;
   * l'onglet Son des paramètres se redessine.
   */
  private musicChanged(now: MusicNow, change: MusicChange, manual: boolean, track: Track | null): void {
    const toast = manual || (change === "start" && now.theme !== null);
    this.nowPlaying.update({ now, change, toast, asked: manual, track });
    if (this.settingsTab === "sound" && this.menu.screen === "settings") this.redrawSettings?.();
  }

  /** Les boutons du lecteur : morceau suivant (1) ou précédent (-1). */
  private skipMusic(direction: 1 | -1): void {
    this.game.sound.ui("click");
    if (direction > 0) this.game.sound.nextMusic();
    else this.game.sound.previousMusic();
  }

  private profileRows(set: Setter): SettingRow[] {
    const s = this.settings;
    const pr = this.progress;
    return [
      // La langue d'abord ; chaque langue est nommée dans sa propre langue
      choiceRow(t("menu.prof.language"), LOCALE_IDS.map((id) => ({ value: id, label: LOCALES[id].name })), s.language, set("language"), t("menu.prof.languageDetail")),
      {
        kind: "toggle", label: t("menu.prof.sandbox"), value: s.allParts,
        detail: t("menu.prof.sandboxDetail", { credits: t("menu.prof.credits", { n: pr.credits }), parts: t("menu.prof.parts", { n: pr.count }) }),
        onChange: set("allParts"),
      },
      {
        kind: "text", label: t("menu.prof.name"), detail: t("menu.prof.nameDetail"), value: s.name, placeholder: t("menu.multi.namePlaceholder"),
        onChange: (v) => this.remember({ name: v }),
      },
      {
        kind: "text", label: t("menu.prof.server"), detail: t("menu.prof.serverDetail", { port: DEFAULT_PORT }),
        value: s.server, placeholder: defaultServer(), onChange: (v) => this.remember({ server: v }),
      },
    ];
  }

  /** Curseur : le réglage s'applique pendant le glissement ; au lâcher, il est enregistré. */
  private slide(key: NumberSetting, value: number, done: boolean, redraw?: () => void): void {
    this.settings[key] = value;
    this.applySettings();
    if (!done) return;
    saveSettings(this.settings);
    redraw?.();
  }

  private commitSettings(): void {
    saveSettings(this.settings);
    this.applySettings();
  }

  /** Applique tous les réglages au jeu (chaque réglage inchangé ne coûte rien). */
  private applySettings(): void {
    const s = this.settings;
    const game = this.game;
    // La langue d'abord : ce qui suit peut écrire des textes (l'aide des touches)
    setLocale(s.language);
    game.setShadows(s.shadows);
    game.setShadowQuality(s.shadowQuality);
    game.setFarShadows(s.farShadows);
    game.setRenderScale(s.renderScale);
    game.setReducedEffects(s.effects === "reduced");
    game.setFxLook(s.fxLook);
    game.setGlow(s.glow);
    game.setDynamicLights(s.lights);
    game.setHeatHaze(s.heatHaze);
    game.rig.setFov((s.fov * Math.PI) / 180);
    game.rig.look = { sensitivity: s.sensitivity, invertX: s.invertX, invertY: s.invertY };
    game.controls.scopeToggle = s.scopeToggle;
    game.controls.bindings = s.bindings;
    this.garage.bindings = s.bindings;
    this.garage.refreshKeys();
    game.controls.padLook = { sensitivity: s.padSensitivity, invertX: s.padInvertX, invertY: s.padInvertY };
    game.controls.pad.deadzone = s.padDeadzone;
    game.controls.setTouch({
      sensitivity: s.touchSensitivity, stickSensitivity: s.touchStickSensitivity, invertY: s.touchInvertY,
      aim: s.touchAim, scopeToggle: s.touchScopeToggle, leftHanded: s.touchLeftHanded, size: s.touchSize, opacity: s.touchOpacity,
    });
    game.refreshKeyHelp();
    game.relativeDrive = s.drive === "camera";
    game.manualFlight = s.flight === "manual";
    game.sound.setEnabled(s.sound);
    game.sound.setVolume(s.volume);
    game.sound.setMusicVolume(s.music);
    this.nowPlaying.setMuted(!game.sound.musicAudible);
    this.nowPlaying.setMode(s.musicPlayer);
    this.soundLog.setVisible(s.soundLog);
    game.sound.setTrace(s.soundLog ? (label) => this.soundLog.push(label) : null);
    this.fps.setVisible(s.showFps);
    this.progress.sandbox = s.allParts;
  }
}
