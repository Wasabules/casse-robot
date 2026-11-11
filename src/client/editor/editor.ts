import type * as B from "../babylon";
import type { ArenaLayout, BoxLook, MapKey } from "../../shared/arena/layout";
import type { Terrain } from "../../shared/arena/terrain";
import { CAR_HALF, propDef, propHalf } from "../../shared/catalog/props";
import {
  addElement, applyBrush, arenaFromMap, blankMap, centerOf, checkMap, duplicateElements, elementCenter, elementsOf, fieldHeight, fieldOf, getElement,
  imageFromHeights, issueTarget, MAP_LIMITS, MapHistory, moveElements, movePoint, paletteEntry, readMapText, removeElements, rotateElements,
  setElement, slabSize, spawnsOf, terrainFromImage, terrainOfField, terrainSideFor, traceElement, TRACE_POINTS, unionRegion, withField,
  type ArenaOrigins, type Brush, type ElementRef, type FieldSpec, type HeightField, type HeightImage, type MapElement, type MapFile,
  type MapBox, type MapIssue, type MapLava, type MapPoint, type MapPrefab, type MapSpawn, type PaletteTab, type Placed, type Region, type TerrainImport, type TraceKind,
} from "../../shared/map";
import { wallCount } from "../../shared/map/build";
import { isDynamicProp } from "../../shared/map/prefabs";
import type { GameModeId } from "../../shared/modes";
import { actionsFor, chordCode, eventChords, isChord, type ActionId, type Bindings } from "../input/bindings";
import { t } from "../i18n/i18n";
import { mapIssueText } from "../i18n/names";
import { isHeightmapError } from "../../shared/map/heightmap";
import { heightmapErrorText } from "../i18n/names";
import { downloadHeightPng, downloadMap, heightImageFromFile, mapFileName, pickFile } from "../maps/files";
import { mapName, type MapEntry, type MapLibrary } from "../maps/library";
import { MapChecker } from "./checker";
import { dropDraft, loadDraft, saveDraft, type DraftSource, type DraftView } from "./drafts";
import { EditorUi } from "./editorUi";
import { EditorView, type Footprint, type Label } from "./editorView";
import { TOOL_ACTIONS, TOOLS, type ToolId } from "./tools";

/*
 * L'éditeur de cartes : un écran à lui, comme le garage (sa propre scène sur le moteur du jeu,
 * l'arène en veille derrière). On y part d'une carte vierge, d'une carte de la bibliothèque ou d'un
 * fichier ; on importe et on sculpte le relief, on pose les éléments de jeu, on règle la carte, on
 * voit ses problèmes, on l'essaie contre l'IA (puis on revient au même état) et on l'enregistre.
 * La carte est une `MapFile` (shared/map/format.ts) : chaque modification passe par les opérations
 * pures de shared/map/edit.ts, et rend une nouvelle carte que l'historique garde (annuler, rétablir).
 *
 * Ici : l'état de l'éditeur (la carte, l'historique, l'outil, la sélection, les réglages des outils)
 * et ce que font les commandes. Le dessin est dans `EditorView` (editorView.ts), les panneaux HTML
 * dans `EditorUi` (editorUi.ts), la vérification dans un Worker (`MapChecker`, checker.ts), le
 * brouillon dans IndexedDB (drafts.ts). Ouvert, l'état vit même pendant un essai (`suspend`,
 * `resume`) ; fermé, tout est libéré (scène, panneaux, écouteurs, Worker).
 */

/** Ce que l'application donne à l'éditeur. */
export interface EditorHost {
  readonly engine: B.Engine;
  readonly canvas: HTMLCanvasElement;
  readonly maps: MapLibrary;
  /** Touches choisies par le joueur, et le nom à l'écran de celle d'une action. */
  bindings(): Bindings;
  keyName(id: ActionId): string;
  /** Le nom du joueur (l'auteur d'une nouvelle carte). */
  author(): string;
  /** Un menu de l'application est-il ouvert par-dessus l'éditeur (confirmation, choix du mode) ? */
  menuOpen(): boolean;
  sound(kind: "click" | "error" | "save" | "place" | "remove" | "rotate"): void;
  /** Quitter (l'application demande confirmation si des modifications ne sont pas enregistrées). */
  leave(): void;
  /** Essayer la carte (vérifiée, sans problème). */
  test(map: MapFile): void;
}

/** D'où part l'éditeur : le brouillon gardé (sinon une carte vierge), une carte vierge, une carte de la bibliothèque. */
export type EditorSource = { kind: "resume" } | { kind: "new" } | { kind: "entry"; entry: MapEntry };

/** Ce qu'un clic fait avec l'outil Eau et lave. */
export type WaterClick = "none" | "level" | "pool";

/** Un relief importé d'une image, en attente de ses réglages. */
export interface PendingImport {
  readonly name: string;
  readonly image: HeightImage;
  options: TerrainImport & { readonly bigEndian?: boolean };
}

/** Identifiant de l'arène que dessine l'éditeur (elle n'est connue de personne d'autre). */
const EDIT_KEY: MapKey = "map-editor";
/** Écart entre un clic et un glisser (px). */
const CLICK_SLOP = 4;
/** Pas de rotation (degrés). */
const TURN = 15;
/** Délai avant de garder le brouillon (ms). */
const AUTOSAVE = 1200;

/** Ce qu'on fait glisser. */
type Drag =
  | { kind: "orbit" | "pan"; x: number; y: number }
  | { kind: "move"; refs: ElementRef[]; sx: number; sy: number; from: { x: number; z: number }; center: MapPoint; dx: number; dz: number; moved: boolean }
  | { kind: "rotate"; ref: ElementRef; preview: MapFile | null }
  | { kind: "point"; ref: ElementRef; point: number; preview: MapFile | null }
  | { kind: "stroke" };

/** Un coup de pinceau : le champ qu'on modifie, la zone touchée, le pinceau (sa hauteur visée fixée au début). */
interface Stroke {
  readonly field: HeightField;
  readonly terrain: Terrain;
  readonly brush: Brush;
  region: Region | null;
  at: { x: number; z: number } | null;
}

export class MapEditor {
  private readonly host: EditorHost;
  // --- L'état (lu par les panneaux) ---
  map: MapFile;
  readonly history: MapHistory;
  source: DraftSource = { key: null, origin: null };
  dirty = false;
  tool: ToolId = "select";
  selection: ElementRef[] = [];
  /**
   * La sélection qu'avait chaque état de la carte, la dernière fois qu'il était affiché : annuler et
   * rétablir la remettent (une référence désigne un élément par sa place dans sa liste : elle ne vaut
   * que pour la carte où on l'a prise).
   */
  private readonly selections = new WeakMap<MapFile, ElementRef[]>();
  palette: { tab: PaletteTab; id: string | null; search: string } = { tab: "prefabs", id: "house", search: "" };
  brush: Brush = { kind: "raise", radius: 10, strength: 0.5, height: 4 };
  /** Orientation de la pose (degrés). */
  yaw = 0;
  snap = false;
  gridStep = 2;
  boxLook: BoxLook | undefined = undefined;
  trace: { kind: TraceKind; points: MapPoint[] } = { kind: "path", points: [] };
  waterClick: WaterClick = "none";
  issues: readonly MapIssue[] = [];
  /** La carte dont `issues` sont les problèmes (une autre : la vérification est en cours). */
  checked: MapFile | null = null;
  issuesOpen = true;
  importing: PendingImport | null = null;
  /** Le dernier mode d'essai choisi. */
  testMode: GameModeId = "battle";
  /** Mesures : la dernière reconstruction (ms), la dernière vérification (ms). */
  lastRebuild = 0;
  lastCheck = 0;
  // --- Ce qui ne vit que l'éditeur affiché ---
  private view: EditorView | null = null;
  private ui: EditorUi | null = null;
  private checker: MapChecker | null = null;
  private arena: ArenaLayout | null = null;
  private origins: ArenaOrigins = { boxes: [], props: [] };
  /** La carte dessinée (pour savoir ce qui a changé). */
  private shown: MapFile | null = null;
  private drag: Drag | null = null;
  private stroke: Stroke | null = null;
  /**
   * Le relief est déjà dessiné tel qu'il est : un coup de pinceau l'a remodelé en direct. La
   * reconstruction qui suit ne refait pas le sol (le plus long : ~120 ms sur le Val du Lac), sauf s'il
   * y a de la lave (elle suit le relief).
   */
  private groundDrawn = false;
  private pointer: { x: number; y: number } | null = null;
  private readonly held = new Set<string>();
  private savedView: DraftView | null = null;
  private autosaveTimer: number | undefined;
  private readonly listeners: (() => void)[] = [];
  private open_ = false;
  private suspended_ = false;

  constructor(host: EditorHost) {
    this.host = host;
    this.map = blankMap({ name: t("editor.untitled"), author: t("editor.anonymous") });
    this.history = new MapHistory(this.map);
  }

  /** Ouvert (affiché ou suspendu pour un essai) ? */
  get active(): boolean {
    return this.open_;
  }

  /** Suspendu pendant un essai ? */
  get suspended(): boolean {
    return this.suspended_;
  }

  get keys(): (id: ActionId) => string {
    return (id) => this.host.keyName(id);
  }

  get library(): MapLibrary {
    return this.host.maps;
  }

  /** L'arène construite d'après la carte (ses nombres d'accessoires et de boîtes). */
  get built(): ArenaLayout | null {
    return this.arena;
  }

  // --- Ouvrir, fermer ---

  async open(source: EditorSource): Promise<void> {
    let restored = false;
    if (source.kind === "resume") {
      const draft = await loadDraft();
      if (draft) {
        this.load(draft.map, draft.source, draft.dirty);
        this.savedView = draft.view ?? null;
        restored = true;
      } else this.load(this.blank(), { key: null, origin: null }, false);
    } else if (source.kind === "new") this.load(this.blank(), { key: null, origin: null }, false);
    else this.load(source.entry.map, { key: source.entry.key, origin: source.entry.origin, file: source.entry.file }, false);
    this.open_ = true;
    this.attach();
    if (restored) this.note(t("editor.note.draft", { name: mapName(this.map) }));
    if (!this.host.maps.persistent) this.note(t("editor.note.storage"), true);
  }

  /** Une carte vierge, au nom du joueur. */
  private blank(name = t("editor.untitled"), half?: number, license?: string): MapFile {
    return blankMap({ name, author: this.host.author().trim() || t("editor.anonymous"), half, license });
  }

  /** Remplace la carte (une autre carte ouverte) : l'historique repart de là. */
  private load(map: MapFile, source: DraftSource, dirty: boolean): void {
    this.map = map;
    this.history.reset(map);
    this.source = source;
    this.dirty = dirty;
    this.selection = [];
    this.trace.points = [];
    this.importing = null;
    this.issues = [];
    this.checked = null;
    this.savedView = null;
    this.shown = null;
  }

  /** Ferme l'éditeur : tout est libéré ; le brouillon reste gardé (sauf `drop`). */
  close(drop = false): void {
    if (this.open_ && !this.suspended_) this.savedView = this.view?.pose ?? this.savedView;
    this.detach();
    this.open_ = false;
    this.suspended_ = false;
    clearTimeout(this.autosaveTimer);
    if (drop) void dropDraft();
    else void this.keepDraft();
  }

  /** Pendant un essai : la scène et les panneaux sont libérés, l'état reste (carte, historique, vue, outil). */
  suspend(): void {
    if (!this.open_ || this.suspended_) return;
    this.savedView = this.view?.pose ?? this.savedView;
    void this.keepDraft();
    this.detach();
    this.suspended_ = true;
  }

  /** Retour d'un essai : au même état. */
  resume(): void {
    if (!this.open_ || !this.suspended_) return;
    this.suspended_ = false;
    this.attach();
  }

  private attach(): void {
    const ui = new EditorUi(this);
    this.ui = ui;
    const view = new EditorView(this.host.engine, ui.labelRoot);
    this.view = view;
    view.onFrame = (dt) => this.frame(dt);
    this.checker = new MapChecker();
    this.checker.onResult = (map, issues, ms) => {
      this.lastCheck = ms;
      if (map !== this.map) return;
      this.issues = issues;
      this.checked = map;
      this.refreshLabels();
      this.ui?.refresh("issues");
    };
    this.shown = null;
    this.rebuild();
    if (this.savedView) view.pose = this.savedView;
    else this.frameMap();
    this.check();
    this.listen();
    ui.render();
  }

  private detach(): void {
    for (const stop of this.listeners.splice(0)) stop();
    this.checker?.dispose();
    this.checker = null;
    this.view?.dispose();
    this.view = null;
    this.ui?.dispose();
    this.ui = null;
    this.arena = null;
    this.shown = null;
    this.drag = null;
    this.stroke = null;
    this.held.clear();
  }

  /** Les écouteurs du canvas et de la fenêtre (retirés en partant). */
  private listen(): void {
    const canvas = this.host.canvas;
    const on = <K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions): void => {
      target.addEventListener(type, fn as EventListener, options);
      this.listeners.push(() => target.removeEventListener(type, fn as EventListener, options));
    };
    const onWindow = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void): void => {
      window.addEventListener(type, fn as EventListener);
      this.listeners.push(() => window.removeEventListener(type, fn as EventListener));
    };
    on(canvas, "pointerdown", (e) => this.onPointerDown(e));
    on(canvas, "pointermove", (e) => this.onPointerMove(e));
    on(canvas, "pointerup", (e) => this.onPointerUp(e));
    on(canvas, "pointerleave", () => this.hover(null));
    on(canvas, "wheel", (e) => {
      if (this.host.menuOpen()) return;
      e.preventDefault();
      this.view?.zoom(e.deltaY);
    }, { passive: false });
    on(canvas, "contextmenu", (e) => e.preventDefault());
    // Le clic du milieu ne fait pas défiler la page
    on(canvas, "mousedown", (e) => e.button === 1 && e.preventDefault());
    onWindow("keydown", (e) => this.onKey(e));
    onWindow("keyup", (e) => this.held.delete(e.code));
    onWindow("blur", () => this.held.clear());
  }

  // --- Construire, dessiner, vérifier ---

  /** Reconstruit l'arène de la carte et la redessine (seulement ce qui a changé). */
  private rebuild(): void {
    const view = this.view;
    if (!view) return;
    const start = performance.now();
    const origins: ArenaOrigins = { boxes: [], props: [] };
    let arena: ArenaLayout;
    try {
      arena = arenaFromMap(this.map, EDIT_KEY, origins);
    } catch (e) {
      console.error("Éditeur de cartes : construction impossible", e);
      this.note(t("editor.note.buildFailed"), true);
      return;
    }
    const changes = changesBetween(this.shown, this.map);
    const before = this.shown;
    if (this.groundDrawn && before && !this.map.lava?.length && before.water === this.map.water && before.paths === this.map.paths
      && before.ground === this.map.ground && before.falls === this.map.falls) changes.ground = false;
    this.groundDrawn = false;
    view.show(this.map, arena, origins, changes);
    this.arena = arena;
    this.origins = origins;
    this.shown = this.map;
    this.selection = this.selection.filter((r) => getElement(this.map, r) !== undefined);
    view.showSelection(this.selection);
    this.refreshLabels();
    this.lastRebuild = performance.now() - start;
  }

  /** Vérifie la carte (dans le Worker, après un délai d'attente). */
  private check(): void {
    this.checker?.request(this.map);
    this.ui?.refresh("issues");
  }

  /** Une modification : la carte change, l'historique la garde, tout suit. */
  commit(map: MapFile, selection?: ElementRef[]): void {
    if (map === this.map) return;
    this.history.push(map);
    this.map = map;
    this.dirty = true;
    if (selection) this.selection = selection;
    this.selections.set(map, this.selection);
    this.changed();
  }

  /** La carte a changé (modification, annulation) : dessin, vérification, brouillon, panneaux. */
  private changed(): void {
    this.rebuild();
    this.check();
    this.scheduleDraft();
    this.ui?.refresh("all");
  }

  undo(): void {
    this.revisit(this.history.undo());
  }

  redo(): void {
    this.revisit(this.history.redo());
  }

  /** Revient à un état de la carte (annuler, rétablir), avec ce qui y était sélectionné. */
  private revisit(map: MapFile | null): void {
    if (!map) return;
    this.map = map;
    this.dirty = true;
    this.selection = this.selections.get(map) ?? [];
    this.changed();
  }

  /** La carte vérifiée a-t-elle des problèmes (null : pas encore vérifiée) ? */
  get playable(): boolean | null {
    return this.checked === this.map ? this.issues.length === 0 : null;
  }

  // --- Brouillon ---

  private scheduleDraft(): void {
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => void this.keepDraft(), AUTOSAVE);
  }

  private async keepDraft(): Promise<void> {
    clearTimeout(this.autosaveTimer);
    const view = this.view?.pose ?? this.savedView ?? undefined;
    await saveDraft({ map: this.map, source: this.source, dirty: this.dirty, view, saved: Date.now() });
  }

  // --- Vue ---

  /** Toute la carte à l'écran. */
  frameMap(): void {
    const half = this.map.bounds.half;
    this.view?.focus(0, 0, half * 1.3);
  }

  /** Recentre la vue sur la sélection (ou sur toute la carte). */
  focusSelection(): void {
    const view = this.view;
    if (!view) return;
    const center = centerOf(this.map, this.selection);
    if (!center) {
      this.frameMap();
      return;
    }
    let size = 12;
    for (const ref of this.selection) {
      for (const m of view.meshesOf(ref)) {
        const ext = m.getBoundingInfo().boundingBox.extendSizeWorld;
        size = Math.max(size, 2 * Math.max(ext.x, ext.z));
      }
      const e = getElement(this.map, ref);
      if (e && "radius" in e && typeof e.radius === "number") size = Math.max(size, 2 * e.radius);
    }
    view.focus(center[0], center[1], size);
  }

  private frame(dt: number): void {
    const view = this.view;
    if (!view) return;
    // Déplacer la vue au clavier
    if (!this.host.menuOpen()) {
      const f = (this.holding("editorForward") ? 1 : 0) - (this.holding("editorBack") ? 1 : 0);
      const r = (this.holding("editorRight") ? 1 : 0) - (this.holding("editorLeft") ? 1 : 0);
      if (f || r) {
        const speed = Math.max(10, view.camera.radius * 0.9) * dt;
        view.shift(r * speed, f * speed);
        if (this.snap) view.showGrid(this.gridStep);
      }
    }
    // Un pinceau tenu immobile continue de peindre
    const stroke = this.stroke;
    if (stroke?.at) this.dab(stroke, stroke.at, dt);
  }

  /** Une touche de cette action est-elle tenue (sans touche de modification) ? */
  private holding(id: ActionId): boolean {
    const b = this.host.bindings()[id];
    return b.keys.some((k) => k !== null && !isChord(k) && this.held.has(k));
  }

  // --- Étiquettes ---

  private refreshLabels(): void {
    const view = this.view;
    if (!view) return;
    const g = view.ground;
    const labels: Label[] = [];
    for (const z of this.map.zones) labels.push({ text: z.label, cls: "zone", x: z.x, y: (z.y ?? g(z.x, z.z)) + 3, z: z.z });
    for (const p of this.map.places ?? []) labels.push({ text: p.name, cls: "place", x: p.x, y: g(p.x, p.z) + 7.5, z: p.z });
    const spawns = spawnsOf(this.map);
    for (const team of ["blue", "red"] as const) {
      const s = spawns[team];
      labels.push({ text: t("editor.label.spawn", { team: t(`team.${team}`) }), cls: team, x: s.x, y: g(s.x, s.z) + 3, z: s.z });
    }
    // Les problèmes, là où ils sont
    if (this.checked === this.map) {
      for (const issue of this.issues) {
        const target = issueTarget(this.map, issue);
        if (!target) continue;
        const [x, z] = target.at;
        // (plus haut que l'étiquette d'une zone ou d'une ligne de départ, qu'elle ne cache pas)
        labels.push({ text: "!", cls: "issue", x, y: g(x, z) + 11, z, onClick: () => this.goToIssue(issue) });
      }
    }
    view.setLabels(labels);
  }

  /** La vue va au problème, et choisit l'élément en cause. */
  goToIssue(issue: MapIssue): void {
    const target = issueTarget(this.map, issue);
    if (!target) return;
    if (target.ref) this.select([target.ref]);
    this.view?.focus(target.at[0], target.at[1], 30);
  }

  // --- Outils ---

  setTool(tool: ToolId): void {
    if (tool === this.tool) return;
    if (this.tool === "trace" || paletteEntry(this.palette.id ?? "")?.trace) this.trace.points = [];
    this.tool = tool;
    this.waterClick = "none";
    this.view?.showGhost(null, null, true);
    this.view?.showBrush(null, 0);
    this.view?.showTrace([], null, 0);
    this.ui?.refresh("all");
  }

  /** Choisit une entrée de la palette (passe à l'outil Poser). */
  pick(id: string): void {
    const entry = paletteEntry(id);
    if (!entry) return;
    this.palette.id = id;
    if (entry.trace) this.trace = { kind: entry.trace, points: [] };
    this.setTool("place");
    this.ui?.refresh("panel");
  }

  /** Choisit ce qu'on trace (passe à l'outil Tracés). */
  pickTrace(kind: TraceKind): void {
    this.trace = { kind, points: [] };
    this.setTool("trace");
    this.ui?.refresh("panel");
  }

  setSnap(on: boolean): void {
    this.snap = on;
    this.view?.showGrid(on ? this.gridStep : null);
    this.ui?.refresh("panel");
  }

  setGridStep(step: number): void {
    this.gridStep = step;
    if (this.snap) this.view?.showGrid(step);
  }

  /** Un point aimanté à la grille (si l'aimantage est mis). */
  private snapped(x: number, z: number): { x: number; z: number } {
    // (sans aimantage, au décimètre : une carte n'a pas besoin de plus)
    if (!this.snap) return { x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10 };
    const s = this.gridStep;
    return { x: Math.round(x / s) * s, z: Math.round(z / s) * s };
  }

  /** Un angle aimanté à 15° (si l'aimantage est mis). */
  private snappedAngle(deg: number): number {
    return this.snap ? Math.round(deg / TURN) * TURN : Math.round(deg);
  }

  // --- Sélection ---

  select(refs: ElementRef[]): void {
    this.selection = refs;
    this.selections.set(this.map, refs);
    this.view?.showSelection(refs);
    this.ui?.refresh("props");
  }

  private toggleSelected(ref: ElementRef): void {
    const i = this.selection.findIndex((r) => r.list === ref.list && r.index === ref.index);
    this.select(i >= 0 ? this.selection.filter((_, k) => k !== i) : [...this.selection, ref]);
  }

  private isSelected(ref: ElementRef): boolean {
    return this.selection.some((r) => r.list === ref.list && r.index === ref.index);
  }

  /** Change un champ d'un élément (le panneau des propriétés). */
  setField(ref: ElementRef, field: FieldSpec, value: unknown): void {
    const e = getElement(this.map, ref);
    if (!e) return;
    let next = withField(e, field, value);
    // Un accessoire qui devient une dalle prend des dimensions ; une dalle qui ne l'est plus les perd
    if (ref.list === "props" && field.key === "type") {
      const p = next as MapElement & { type: Parameters<typeof propDef>[0]; size?: unknown };
      const slab = propDef(p.type).shape.kind === "slab";
      const size = slabSize(p.type);
      if (slab && !p.size && size) next = { ...p, size } as MapElement;
      if (!slab && p.size) {
        const { size: _drop, ...rest } = p;
        void _drop;
        next = rest as MapElement;
      }
    }
    this.commit(setElement(this.map, ref, next));
  }

  /** Change la carte par une fonction (réglages de la carte, eau). */
  update(change: (map: MapFile) => MapFile): void {
    this.commit(change(this.map));
  }

  rotateSelection(sign: number): void {
    if (!this.selection.length) return;
    this.commit(rotateElements(this.map, this.selection, sign * TURN));
    this.host.sound("rotate");
  }

  duplicateSelection(): void {
    if (!this.selection.length) {
      this.note(t("editor.note.nothing"));
      return;
    }
    const step = this.snap ? this.gridStep * 2 : 4;
    const { map, refs } = duplicateElements(this.map, this.selection, step, step);
    if (!refs.length) return;
    this.commit(map, refs);
    this.note(t("editor.note.duplicated", { n: refs.length }));
    this.host.sound("place");
  }

  deleteSelection(): void {
    const refs = this.selection.filter((r) => r.list !== "spawns");
    if (!refs.length) {
      this.note(t("editor.note.nothing"));
      return;
    }
    this.commit(removeElements(this.map, refs), []);
    this.note(t("editor.note.deleted", { n: refs.length }));
    this.host.sound("remove");
  }

  // --- Poser ---

  /** L'élément que poserait l'outil en (x, z) (null : rien à poser, ou plus de place). */
  private placed(at: { x: number; z: number }): Placed | null {
    const view = this.view;
    const id = this.tool === "water" && this.waterClick === "pool" ? "lavaPool" : this.palette.id;
    const entry = id ? paletteEntry(id) : undefined;
    if (!view || !entry?.make) return null;
    return entry.make({
      x: at.x, z: at.z, yaw: this.yaw, map: this.map, ground: view.ground, placeName: t("editor.place.newPlace"), look: this.boxLook,
    });
  }

  /** Peut-on poser cet élément là (dans la carte, dans les bornes de `MAP_LIMITS`) ? */
  private placeable(p: Placed | null, at: { x: number; z: number }): boolean {
    if (!p) return false;
    const L = MAP_LIMITS;
    const edge = Math.min(L.reach, (this.map.terrain ? this.map.terrain.cells * this.map.terrain.step : 440) / 2) - 2;
    if (Math.abs(at.x) > edge || Math.abs(at.z) > edge) return false;
    if (p.list === "zones" && (Math.abs(at.x) > this.map.bounds.half || Math.abs(at.z) > this.map.bounds.half)) return false;
    const arena = this.arena;
    const limits: Partial<Record<Placed["list"], number>> = {
      prefabs: L.prefabs, places: L.places, vents: L.vents, falls: L.falls, lava: L.lava, paths: L.paths,
    };
    const max = limits[p.list];
    if (max !== undefined && elementsOf(this.map, p.list).length >= max) return false;
    if (arena) {
      if (arena.props.length >= L.props && (p.list === "props" || p.list === "prefabs")) return false;
      const boxes = arena.boxes.filter((b) => b.kind !== "bound").length - (this.map.limits?.walls ? wallCount(this.map.bounds.half) : 0);
      if (boxes >= L.boxes && (p.list === "boxes" || p.list === "prefabs")) return false;
      if (p.list === "props" && isDynamicProp((p.element as { type: Parameters<typeof isDynamicProp>[0] }).type)
        && arena.props.filter((s) => isDynamicProp(s.type)).length >= L.dynamicProps) return false;
    }
    return true;
  }

  private placeAt(ground: { x: number; z: number }): void {
    const at = this.snapped(ground.x, ground.z);
    const p = this.placed(at);
    if (!p || !this.placeable(p, at)) {
      const zone = this.palette.id === "zone" && this.tool === "place" && this.map.zones.length >= MAP_LIMITS.zones;
      this.note(t(zone ? "editor.note.zonesFull" : "editor.note.placeRefused"), true);
      this.host.sound("error");
      return;
    }
    const { map, ref } = addElement(this.map, p.list, p.element);
    this.commit(map, [ref]);
    this.host.sound("place");
  }

  // --- Tracés ---

  private addTracePoint(ground: { x: number; z: number }): void {
    const at = this.snapped(ground.x, ground.z);
    const pts = this.trace.points;
    if (pts.length >= TRACE_POINTS[this.trace.kind].max) return;
    pts.push([Math.round(at.x * 10) / 10, Math.round(at.z * 10) / 10]);
    this.host.sound("click");
    if (pts.length >= TRACE_POINTS[this.trace.kind].max) this.finishTrace();
    else {
      this.view?.showTrace(pts, null, 1);
      this.ui?.refresh("panel");
    }
  }

  finishTrace(): void {
    const p = traceElement(this.trace.kind, this.trace.points);
    if (!p) return;
    const max = { paths: MAP_LIMITS.paths, lava: MAP_LIMITS.lava, prefabs: MAP_LIMITS.prefabs }[p.list as "paths" | "lava" | "prefabs"];
    if (max !== undefined && elementsOf(this.map, p.list).length >= max) {
      this.note(t("editor.note.tooMany"), true);
      this.host.sound("error");
      return;
    }
    this.trace.points = [];
    this.view?.showTrace([], null, 0);
    const { map, ref } = addElement(this.map, p.list, p.element);
    this.commit(map, [ref]);
    this.host.sound("place");
  }

  cancelTrace(): void {
    this.trace.points = [];
    this.view?.showTrace([], null, 0);
    this.ui?.refresh("panel");
  }

  private removeTracePoint(): void {
    if (!this.trace.points.length) return;
    this.trace.points.pop();
    this.view?.showTrace(this.trace.points, null, 1);
    this.ui?.refresh("panel");
  }

  /** On trace en ce moment (l'outil Tracés, ou une entrée de la palette qui se trace) ? */
  private get tracing(): boolean {
    return this.tool === "trace" || (this.tool === "place" && !!paletteEntry(this.palette.id ?? "")?.trace);
  }

  // --- Relief ---

  setBrush(change: Partial<Brush>): void {
    this.brush = { ...this.brush, ...change };
    if (this.pointer) this.hover(this.pointer);
    this.ui?.refresh("panel");
  }

  private beginStroke(at: { x: number; z: number }): void {
    if (!this.map.terrain) {
      this.note(t("editor.note.noTerrain"), true);
      this.host.sound("error");
      return;
    }
    const field = fieldOf(this.map.terrain);
    if (!field) return;
    const terrain: Terrain = { size: field.cells * field.step, cells: field.cells, heights: field.heights };
    // Aplanir à la hauteur cliquée : celle du sol au début du coup
    const brush = this.brush.kind === "level" ? { ...this.brush, height: fieldHeight(field, at.x, at.z) } : this.brush;
    this.stroke = { field, terrain, brush, region: null, at };
    this.view?.setTerrain(terrain);
    this.drag = { kind: "stroke" };
    this.dab(this.stroke, at, 1 / 30);
  }

  private dab(stroke: Stroke, at: { x: number; z: number }, dt: number): void {
    const region = applyBrush(stroke.field, stroke.brush, at.x, at.z, dt);
    if (!region) return;
    stroke.region = unionRegion(stroke.region, region);
    this.view?.reshape(stroke.field.heights, region);
    this.view?.showBrush(at, stroke.brush.radius);
  }

  private endStroke(): void {
    const stroke = this.stroke;
    this.stroke = null;
    if (!stroke) return;
    if (!stroke.region) {
      this.view?.setTerrain(this.arena?.terrain ?? null);
      return;
    }
    this.groundDrawn = true;
    this.commit({ ...this.map, terrain: terrainOfField(stroke.field) });
  }

  /** Un relief plat, à la taille de la zone de jeu, entouré de montagnes (remplace le relief). */
  flatTerrain(): void {
    const blank = blankMap({ name: "-", author: "-", half: this.map.bounds.half });
    this.commit({ ...this.map, terrain: blank.terrain });
    this.note(t("editor.note.terrainApplied", { side: terrainSideFor(this.map.bounds.half) }));
  }

  /** Choisit une image de relief, et propose ses réglages. */
  async importImage(): Promise<void> {
    const file = await pickFile(".png,.r16,.raw,image/*");
    if (!file) return;
    try {
      const image = await heightImageFromFile(file);
      const half = this.map.bounds.half;
      const side = this.map.terrain ? this.map.terrain.cells * this.map.terrain.step : terrainSideFor(half);
      this.importing = {
        name: file.name,
        image,
        options: { cells: side / 2, step: 2, low: 0, high: 30, mountains: { from: half + 6, height: 30 }, smooth: image.bits <= 8 ? 2 : 0 },
      };
      this.setTool("terrain");
      this.ui?.refresh("panel");
    } catch (e) {
      this.note(isHeightmapError(e) ? heightmapErrorText(e.code) : t("editor.note.fileRefused", { issue: String(e) }), true);
      this.host.sound("error");
    }
  }

  /** Applique le relief importé, avec ses réglages. */
  applyImport(): void {
    const pending = this.importing;
    if (!pending) return;
    const terrain = terrainFromImage(pending.image, pending.options);
    this.importing = null;
    this.commit({ ...this.map, terrain });
    this.note(t("editor.note.terrainApplied", { side: terrain.cells * terrain.step }));
  }

  cancelImport(): void {
    this.importing = null;
    this.ui?.refresh("panel");
  }

  // --- Eau ---

  /** L'eau à cette hauteur, en direct (sans modifier la carte : `update` le fera au lâcher). */
  previewWater(level: number): void {
    this.view?.setWaterLevel(level);
  }

  setWaterClick(mode: WaterClick): void {
    this.waterClick = this.waterClick === mode ? "none" : mode;
    this.ui?.refresh("panel");
  }

  // --- Lignes de départ ---

  /** Lignes de départ placées librement (à partir de celles du nord et du sud), ou remises au nord et au sud. */
  setFreeSpawns(on: boolean): void {
    if (on) this.commit({ ...this.map, spawns: spawnsOf(this.map) });
    else {
      const { spawns: _drop, ...rest } = this.map;
      void _drop;
      this.commit(rest as MapFile, this.selection.filter((r) => r.list !== "spawns"));
    }
  }

  // --- Fichier ---

  /** Une nouvelle carte (le panneau a déjà demandé confirmation s'il le fallait). */
  newMap(name: string, half: number, license: string): void {
    this.load(this.blank(name.trim() || t("editor.untitled"), half, license.trim() || undefined), { key: null, origin: null }, false);
    this.shown = null;
    this.rebuild();
    this.frameMap();
    this.check();
    void this.keepDraft();
    this.ui?.refresh("all");
    this.note(t("editor.note.created", { name: mapName(this.map) }));
  }

  /** Ouvre une carte de la bibliothèque. */
  openEntry(entry: MapEntry): void {
    this.load(entry.map, { key: entry.key, origin: entry.origin, file: entry.file }, false);
    this.rebuild();
    this.frameMap();
    this.check();
    void this.keepDraft();
    this.ui?.refresh("all");
    this.note(t("editor.note.opened", { name: mapName(this.map) }));
  }

  /** Ouvre un fichier de carte (lisible : il peut avoir des problèmes, l'éditeur est là pour les corriger). */
  async openFile(): Promise<void> {
    const file = await pickFile(".json,application/json");
    if (!file) return;
    const read = readMapText(await file.text());
    if (!read.ok) {
      this.note(t("editor.note.fileRefused", { issue: mapIssueText(read.issues[0] ?? { code: "json" }) }), true);
      this.host.sound("error");
      return;
    }
    this.load(read.map, { key: null, origin: "file", file: file.name }, true);
    this.rebuild();
    this.frameMap();
    this.check();
    void this.keepDraft();
    this.ui?.refresh("all");
    this.note(t("editor.note.opened", { name: mapName(this.map) }));
  }

  exportMap(): void {
    downloadMap(this.map);
    this.note(t("editor.note.exported", { file: mapFileName(this.map) }));
  }

  async exportTerrain(): Promise<void> {
    const terrain = this.arena?.terrain;
    if (!terrain) return;
    const { image } = imageFromHeights(terrain.heights, terrain.cells);
    const file = mapFileName(this.map).replace(/\.casse-map\.json$/, ".png");
    await downloadHeightPng(file, image);
    this.note(t("editor.note.exported", { file }));
  }

  /**
   * Enregistre la carte dans la bibliothèque : elle doit se jouer. Elle remplace sa version
   * précédente (une carte de ce navigateur) ; une carte livrée avec le jeu ou reçue d'un serveur
   * s'enregistre en copie. Faux si elle a des problèmes (la liste s'ouvre).
   */
  async save(): Promise<boolean> {
    let map = this.map;
    const copy = this.source.origin === "bundled" || this.source.origin === "server";
    if (copy) {
      const base = this.source.key ? this.host.maps.get(this.source.key)?.map.meta.name : undefined;
      if (base !== undefined && map.meta.name === base) map = { ...map, meta: { ...map.meta, name: t("editor.copyName", { name: base }).slice(0, MAP_LIMITS.name) } };
    }
    const check = checkMap(map);
    if (!check.map || check.issues.length) {
      this.issues = check.issues;
      this.checked = map === this.map ? map : null;
      this.issuesOpen = true;
      this.note(t("editor.note.saveRefused"), true);
      this.host.sound("error");
      this.refreshLabels();
      this.ui?.refresh("all");
      return false;
    }
    if (map !== this.map) this.commit(map);
    const entry = await this.host.maps.replace(this.source.origin === "library" ? this.source.key : null, check.map, this.source.file);
    this.source = { key: entry.key, origin: "library", file: entry.file };
    this.dirty = false;
    await this.keepDraft();
    this.ui?.refresh("all");
    this.note(t("editor.note.saved", { name: mapName(this.map) }));
    this.host.sound("save");
    return true;
  }

  /** Essayer : la carte doit se jouer (sinon la liste des problèmes s'ouvre). */
  test(): void {
    const check = checkMap(this.map);
    if (!check.map || check.issues.length) {
      this.issues = check.issues;
      this.checked = this.map;
      this.issuesOpen = true;
      this.refreshLabels();
      this.ui?.refresh("all");
      this.note(t("editor.note.testRefused"), true);
      this.host.sound("error");
      return;
    }
    this.host.test(check.map);
  }

  // --- Échap ---

  /**
   * Échap : annule ce qui est en cours (un glisser, un tracé, un import, la sélection), et rend
   * vrai ; faux s'il n'y avait rien (l'application propose alors de quitter).
   */
  escape(): boolean {
    const active = document.activeElement as HTMLElement | null;
    if (active && this.ui?.root.contains(active) && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName)) {
      active.blur();
      return true;
    }
    if (this.drag) {
      this.cancelDrag();
      return true;
    }
    if (this.trace.points.length) {
      this.cancelTrace();
      return true;
    }
    if (this.importing) {
      this.cancelImport();
      return true;
    }
    if (this.waterClick !== "none") {
      this.setWaterClick(this.waterClick);
      return true;
    }
    if (this.selection.length) {
      this.select([]);
      return true;
    }
    return false;
  }

  private cancelDrag(): void {
    const drag = this.drag;
    this.drag = null;
    if (drag?.kind === "move") this.view?.endDrag(true);
    if (drag?.kind === "rotate" || drag?.kind === "point") this.rebuild();
    if (drag?.kind === "stroke") {
      this.stroke = null;
      this.shown = null;
      this.rebuild();
    }
  }

  // --- Commandes : touches et souris ---

  /** L'action de l'éditeur que portent ces codes (le premier qui en porte une), ou null. */
  private actionFor(codes: readonly string[]): ActionId | null {
    for (const code of codes) {
      const found = actionsFor(this.host.bindings(), code, false, (c) => c === "editor");
      if (found.length) return found[0];
    }
    return null;
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.view || this.host.menuOpen()) return;
    const target = e.target as Element | null;
    if (target?.closest?.("input, select, textarea")) return;
    this.held.add(e.code);
    const action = this.actionFor(eventChords(e));
    if (!action) return;
    e.preventDefault();
    if (e.repeat && !["editorRotate", "editorRotateBack", "editorBrushSmaller", "editorBrushBigger"].includes(action)) return;
    this.run(action);
  }

  /** Fait une action de l'éditeur (une touche). */
  run(action: ActionId): void {
    const tool = (Object.keys(TOOL_ACTIONS) as ToolId[]).find((id) => TOOL_ACTIONS[id] === action);
    if (tool) {
      this.setTool(tool);
      return;
    }
    switch (action) {
      case "editorTopView":
        this.view?.toggleTop();
        break;
      case "editorFocus":
        this.focusSelection();
        break;
      case "editorRotate":
      case "editorRotateBack": {
        const sign = action === "editorRotate" ? 1 : -1;
        if ((this.tool === "place" && !this.tracing) || (this.tool === "water" && this.waterClick === "pool")) {
          this.yaw = ((this.yaw + sign * TURN + 540) % 360) - 180;
          if (this.pointer) this.hover(this.pointer);
          this.ui?.refresh("panel");
        } else this.rotateSelection(sign);
        break;
      }
      case "editorSnap":
        this.setSnap(!this.snap);
        break;
      case "editorDuplicate":
        this.duplicateSelection();
        break;
      case "editorDelete":
        this.deleteSelection();
        break;
      case "editorUndo":
        this.undo();
        break;
      case "editorRedo":
        this.redo();
        break;
      case "editorSave":
        void this.save();
        break;
      case "editorTest":
        this.test();
        break;
      case "editorFinish":
        this.finishTrace();
        break;
      case "editorRemovePoint":
        this.removeTracePoint();
        break;
      case "editorBrushSmaller":
      case "editorBrushBigger": {
        const k = action === "editorBrushBigger" ? 1.2 : 1 / 1.2;
        this.setBrush({ radius: Math.min(60, Math.max(1, Math.round(this.brush.radius * k * 10) / 10)) });
        break;
      }
      case "editorIssues":
        this.issuesOpen = !this.issuesOpen;
        this.ui?.refresh("issues");
        break;
      case "editorSearch":
        this.setTool("place");
        this.ui?.focusSearch();
        break;
      default:
        break;
    }
  }

  private onPointerDown(e: PointerEvent): void {
    const view = this.view;
    if (!view || this.host.menuOpen()) return;
    const action = this.actionFor([chordCode(`Mouse${e.button}`, e)]);
    if (!action) return;
    e.preventDefault();
    this.host.canvas.focus();
    this.host.canvas.setPointerCapture(e.pointerId);
    this.pointer = { x: e.offsetX, y: e.offsetY };
    if (action === "editorOrbit" || action === "editorPan") {
      this.drag = { kind: action === "editorOrbit" ? "orbit" : "pan", x: e.clientX, y: e.clientY };
      return;
    }
    if (action !== "editorPick" && action !== "editorAddPick") return;
    const add = action === "editorAddPick";
    const ground = view.groundAt(e.offsetX, e.offsetY);
    // Relief : peindre ; Poser : poser ou tracer ; Tracés : un point ; Eau : le niveau ou un lac de lave
    if (this.tool === "terrain") {
      if (ground) this.beginStroke(ground);
      return;
    }
    if (this.tracing) {
      if (ground) this.addTracePoint(ground);
      return;
    }
    if (this.tool === "place") {
      if (ground) this.placeAt(ground);
      return;
    }
    if (this.tool === "water" && this.waterClick !== "none") {
      if (!ground) return;
      if (this.waterClick === "pool") this.placeAt(ground);
      else this.update((m) => ({ ...m, water: { ...(m.water ?? {}), level: Math.round(ground.y * 10) / 10 } }));
      return;
    }
    // Sélection : choisir, puis glisser
    const hit = view.pickAt(e.offsetX, e.offsetY);
    if (!hit) {
      if (!add) this.select([]);
      return;
    }
    if (hit.handle === "rotate") {
      this.select([hit.ref]);
      this.drag = { kind: "rotate", ref: hit.ref, preview: null };
      return;
    }
    if (hit.handle === "point") {
      this.drag = { kind: "point", ref: hit.ref, point: hit.point ?? 0, preview: null };
      return;
    }
    if (add) {
      this.toggleSelected(hit.ref);
      if (!this.isSelected(hit.ref)) return;
    } else if (!this.isSelected(hit.ref)) this.select([hit.ref]);
    if (!ground) return;
    const center = centerOf(this.map, this.selection) ?? [ground.x, ground.z];
    this.drag = { kind: "move", refs: [...this.selection], sx: e.clientX, sy: e.clientY, from: ground, center, dx: 0, dz: 0, moved: false };
  }

  private onPointerMove(e: PointerEvent): void {
    const view = this.view;
    if (!view) return;
    this.pointer = { x: e.offsetX, y: e.offsetY };
    const drag = this.drag;
    if (!drag) {
      if (!this.host.menuOpen()) this.hover(this.pointer);
      return;
    }
    switch (drag.kind) {
      case "orbit":
      case "pan": {
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        drag.x = e.clientX;
        drag.y = e.clientY;
        if (drag.kind === "orbit") view.orbit(dx, dy);
        else view.pan(dx, dy);
        if (this.snap) view.showGrid(this.gridStep);
        return;
      }
      case "stroke": {
        const at = view.groundAt(e.offsetX, e.offsetY);
        if (this.stroke) this.stroke.at = at;
        if (at && this.stroke) this.dab(this.stroke, at, 1 / 60);
        return;
      }
      case "move": {
        if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < CLICK_SLOP) return;
        const at = view.groundAt(e.offsetX, e.offsetY);
        if (!at) return;
        drag.moved = true;
        const target = this.snapped(drag.center[0] + at.x - drag.from.x, drag.center[1] + at.z - drag.from.z);
        drag.dx = target.x - drag.center[0];
        drag.dz = target.z - drag.center[1];
        view.dragBy(drag.refs, drag.dx, drag.dz);
        return;
      }
      case "rotate": {
        const at = view.groundAt(e.offsetX, e.offsetY);
        const e0 = getElement(this.map, drag.ref) as MapSpawn | undefined;
        if (!at || !e0) return;
        const facing = this.snappedAngle((Math.atan2(at.x - e0.x, at.z - e0.z) * 180) / Math.PI);
        drag.preview = setElement(this.map, drag.ref, { ...e0, facing: ((facing + 540) % 360) - 180 });
        this.preview(drag.preview);
        return;
      }
      case "point": {
        const at = view.groundAt(e.offsetX, e.offsetY);
        if (!at) return;
        const p = this.snapped(at.x, at.z);
        drag.preview = movePoint(this.map, drag.ref, drag.point, p.x, p.z);
        this.preview(drag.preview);
        return;
      }
    }
  }

  /** Montre une carte en cours de modification (sa surimpression seulement : la carte est refaite au relâchement). */
  private preview(map: MapFile): void {
    const view = this.view;
    if (!view || !this.arena) return;
    view.show(map, this.arena, this.origins, { ground: false, boxes: false, props: false });
    view.showSelection(this.selection);
    // (`shown` reste la carte vraiment dessinée : au relâchement, tout ce qui a changé depuis sera refait)
  }

  private onPointerUp(e: PointerEvent): void {
    const drag = this.drag;
    this.drag = null;
    if (this.host.canvas.hasPointerCapture(e.pointerId)) this.host.canvas.releasePointerCapture(e.pointerId);
    if (!drag) return;
    switch (drag.kind) {
      case "stroke":
        this.endStroke();
        return;
      case "move":
        if (!drag.moved || (!drag.dx && !drag.dz)) {
          this.view?.endDrag(true);
          return;
        }
        this.view?.endDrag(false);
        this.commit(moveElements(this.map, drag.refs, drag.dx, drag.dz));
        return;
      case "rotate":
      case "point":
        if (drag.preview) this.commit(drag.preview);
        return;
      default:
        return;
    }
  }

  /** Ce que montre le pointeur au repos : le fantôme de la pose, l'anneau du pinceau, le tracé. */
  private hover(pointer: { x: number; y: number } | null): void {
    const view = this.view;
    if (!view || this.drag) return;
    const ground = pointer ? view.groundAt(pointer.x, pointer.y) : null;
    if (this.tool === "terrain") {
      view.showBrush(ground, this.brush.radius);
      return;
    }
    if (this.tracing) {
      const at = ground ? this.snapped(ground.x, ground.z) : null;
      view.showTrace(this.trace.points, at ? [at.x, at.z] : null, 1);
      return;
    }
    const placing = this.tool === "place" || (this.tool === "water" && this.waterClick === "pool");
    if (!placing || !ground) {
      view.showGhost(null, null, true);
      return;
    }
    const at = this.snapped(ground.x, ground.z);
    const p = this.placed(at);
    view.showGhost(at, p ? footprintOf(p.element) : { kind: "disc", r: 2 }, this.placeable(p, at));
  }

  /** Quitter (l'application demande confirmation s'il le faut). */
  requestLeave(): void {
    this.host.leave();
  }

  /** La hauteur du sol sous un élément (m). */
  groundUnder(ref: ElementRef): number {
    const e = getElement(this.map, ref);
    if (!e || !this.view) return 0;
    const [x, z] = elementCenter(e);
    return this.view.ground(x, z);
  }

  // --- Notes ---

  note(text: string, bad = false): void {
    this.ui?.notify(text, bad);
  }
}

/** Ce qu'il faut refaire entre deux cartes (null : la première, tout). */
export function changesBetween(a: MapFile | null, b: MapFile): { ground: boolean; boxes: boolean; props: boolean } {
  if (!a) return { ground: true, boxes: true, props: true };
  const ground = a.terrain !== b.terrain || a.water !== b.water || a.paths !== b.paths || a.lava !== b.lava || a.ground !== b.ground || a.falls !== b.falls;
  // Les bois et les rochers semés évitent les zones, les lignes de départ, les chemins, l'eau, la lave et les boîtes
  const sown = (b.prefabs ?? []).some((p) => p.kind === "woods" || p.kind === "rocks");
  const layout = ground || a.zones !== b.zones || a.spawns !== b.spawns || a.bounds !== b.bounds || a.boxes !== b.boxes;
  const boxes = a.boxes !== b.boxes || a.prefabs !== b.prefabs || a.terrain !== b.terrain || a.limits !== b.limits || a.bounds !== b.bounds || (sown && layout);
  const props = a.props !== b.props || a.prefabs !== b.prefabs || a.terrain !== b.terrain || (sown && layout);
  return { ground, boxes, props };
}

/** Une boîte du décor (et pas un préfabriqué : elle a ses trois dimensions). */
const isBox = (e: MapElement): e is MapBox => "kind" in e && "size" in e && Array.isArray(e.size) && e.size.length === 3;

/** L'empreinte du fantôme d'un élément qu'on va poser. */
function footprintOf(e: MapElement): Footprint {
  const yaw = (e as { yaw?: number }).yaw ?? 0;
  if ("type" in e) {
    const def = propDef(e.type);
    const slab = def.shape.kind === "slab";
    const size = e.size ? { x: e.size[0] / 2, y: e.size[1] / 2, z: e.size[2] / 2 } : e.type === "car" || e.type === "wreck" ? CAR_HALF : undefined;
    const h = propHalf(e.type, { half: slab && size ? { x: size.x, y: size.y, z: size.z } : undefined, scale: e.scale });
    return { kind: "box", w: 2 * h.x, h: 2 * h.y, d: 2 * h.z, yaw };
  }
  if (isBox(e)) return { kind: "box", w: e.size[0], h: e.size[1], d: e.size[2], yaw };
  if ("kind" in e) {
    const k = e as MapPrefab | MapLava;
    switch (k.kind) {
      case "house": return { kind: "box", w: k.width, h: k.height + k.depth / 3, d: k.depth, yaw };
      case "tenement": return { kind: "box", w: k.width, h: k.floors * 3.6, d: k.depth, yaw };
      case "ramp": return { kind: "box", w: k.width, h: k.rise, d: k.length, yaw };
      case "containers": return { kind: "box", w: (k.count ?? 3) * 2.6, h: 2.6 * (k.levels ?? 1), d: 6, yaw };
      case "woods":
      case "rocks": return { kind: "disc", r: k.radius };
      case "pool": return { kind: "disc", r: k.r };
      default: break;
    }
  }
  if ("radius" in e && "label" in e) return { kind: "disc", r: e.radius };
  return { kind: "box", w: 1.2, h: 3, d: 1.2, yaw: 0 };
}

/** Les outils, pour la barre (exportés pour les panneaux). */
export { TOOLS };
/** Le centre d'un élément (exporté pour les panneaux). */
export { elementCenter };
