import { ARENA_GROUNDS } from "../../shared/arena/grounds";
import { ARENA_IDS, type ArenaId, type BoxLook, type PathSurface, type StaticKind } from "../../shared/arena/layout";
import { PROP_TYPES, type PropType } from "../../shared/catalog/props";
import { boundAt, mapBounds } from "../../shared/map/build";
import {
  assetEntries, BOX_LOOKS, BRUSH_KINDS, BRUSH_LIMITS, fieldApplies, fieldValue, FORMS, formOf, getElement, MAP_LIMITS, PALETTE, PALETTE_TABS, terrainSideFor, TRACE_KINDS, TREE_TYPES,
  type ChoiceNames, type ElementRef, type FieldSpec, type MapFile, type NamedPaletteId, type PaletteEntry,
} from "../../shared/map";
import { compareText, fold } from "../i18n/format";
import { LOCALE_IDS, LOCALES, measure, t } from "../i18n/i18n";
import { arenaName, mapIssueText, propName } from "../i18n/names";
import { editorKeys } from "../keys";
import { mapName } from "../maps/library";
import type { MapEditor } from "./editor";
import { TOOL_ACTIONS, TOOLS, type ToolId } from "./tools";

/*
 * Les panneaux HTML de l'éditeur de cartes, construits d'après son état (`MapEditor`) et refaits
 * quand il change : la barre du haut (nom, état de la carte, essayer, enregistrer, quitter), la
 * barre des outils, le panneau de l'outil, les propriétés de la sélection (chaque champ de son type,
 * d'après `FORMS`, shared/map/fields.ts), la liste des problèmes, l'aide des touches et les notes.
 * Tout est retiré en partant (`dispose`).
 */

type Child = Node | string | null | undefined | false;

/** Un élément HTML, ses attributs et ses enfants. */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | undefined> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "class") el.className = String(v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** Remplace les enfants d'un élément (les absents ne comptent pas). */
function fill(el: Element, ...children: Child[]): void {
  el.replaceChildren(...children.filter((c): c is Node | string => c !== null && c !== undefined && c !== false));
}

/** Un bouton. */
function button(label: string, onClick: () => void, attrs: Record<string, string | boolean | undefined> = {}): HTMLButtonElement {
  const b = h("button", { type: "button", class: "ed-btn", ...attrs }, label);
  b.addEventListener("click", onClick);
  return b;
}

/** Une ligne : un libellé et sa commande. */
function row(label: string, control: Node, detail?: string): HTMLElement {
  return h("label", { class: "ed-row" }, h("span", { class: "ed-row-label" }, label, detail ? h("small", {}, detail) : null), control);
}

/** Un nombre, borné ; `commit` au changement (pas à chaque touche). */
function numberInput(value: number | undefined, min: number, max: number, step: number, commit: (v: number) => void, disabled = false): HTMLInputElement {
  const input = h("input", { type: "number", class: "ed-num", min: String(min), max: String(max), step: String(step), disabled });
  if (value !== undefined) input.value = String(Math.round(value * 1000) / 1000);
  input.addEventListener("change", () => {
    const v = Number(input.value);
    if (input.value === "" || !Number.isFinite(v)) return;
    commit(Math.min(max, Math.max(min, v)));
  });
  return input;
}

/** Un curseur : `live` pendant le glissement, `commit` au lâcher. */
function slider(value: number, min: number, max: number, step: number, format: (v: number) => string, live: (v: number) => void, commit: (v: number) => void): HTMLElement {
  const input = h("input", { type: "range", min: String(min), max: String(max), step: String(step) });
  input.value = String(value);
  const out = h("output", { class: "ed-out" }, format(value));
  input.addEventListener("input", () => {
    out.textContent = format(Number(input.value));
    live(Number(input.value));
  });
  input.addEventListener("change", () => commit(Number(input.value)));
  return h("span", { class: "ed-slider" }, input, out);
}

function checkbox(value: boolean, change: (v: boolean) => void): HTMLInputElement {
  const box = h("input", { type: "checkbox" });
  box.checked = value;
  box.addEventListener("change", () => change(box.checked));
  return box;
}

function select<T extends string>(value: T | "", options: readonly { value: T | ""; label: string }[], change: (v: T | "") => void): HTMLSelectElement {
  const s = h("select", { class: "ed-select" });
  for (const o of options) {
    const opt = h("option", { value: o.value }, o.label);
    if (o.value === value) opt.selected = true;
    s.append(opt);
  }
  s.addEventListener("change", () => change(s.value as T | ""));
  return s;
}

function textInput(value: string, max: number, commit: (v: string) => void, multiline = false): HTMLInputElement | HTMLTextAreaElement {
  const input = multiline ? h("textarea", { class: "ed-text", maxlength: String(max), rows: "3" }) : h("input", { type: "text", class: "ed-text", maxlength: String(max) });
  input.value = value;
  input.addEventListener("change", () => commit(input.value));
  return input;
}

/** Le nom d'un choix d'un champ. */
function choiceName(names: ChoiceNames, value: string): string {
  switch (names) {
    case "boxKind": return t(`editor.boxKind.${value as StaticKind}`);
    case "look":
    case "rockLook": return t(`editor.look.${value as BoxLook}`);
    case "prop": return t(`prop.${value as PropType}`);
    case "surface": return t(`editor.surface.${value as PathSurface}`);
    case "roofKind": return t(`editor.roofKind.${value as "gable" | "flat"}`);
    case "letter": return value;
  }
}

/** Le nom d'une entrée de la palette. */
export function paletteName(e: PaletteEntry): string {
  if (e.id.startsWith("prop.")) return t(`prop.${e.id.slice(5) as PropType}`);
  if (e.id.startsWith("box.")) return t(`editor.boxKind.${e.id.slice(4) as StaticKind}`);
  return t(`editor.palette.${e.id as NamedPaletteId}`);
}

/** Les arènes du jeu qui ont leur palette du sol (et la Vallée, par défaut). */
const GROUND_PRESETS: readonly ArenaId[] = ARENA_IDS.filter((id) => id === "valley" || !!ARENA_GROUNDS[id]);

export class EditorUi {
  readonly root: HTMLElement;
  readonly labelRoot: HTMLElement;
  private readonly editor: MapEditor;
  private readonly top = h("header", { class: "ed-top" });
  private readonly tools = h("nav", { class: "ed-tools" });
  private readonly panel = h("aside", { class: "ed-panel" });
  private readonly props = h("aside", { class: "ed-props" });
  private readonly issues = h("section", { class: "ed-issues" });
  private readonly help = h("footer", { class: "ed-help" });
  private readonly noteEl = h("div", { class: "ed-note", role: "status" });
  private noteTimer: number | undefined;
  private helpOpen = false;
  /** Confirmation en attente (un bouton cliqué une fois qui demande un second clic). */
  private confirming: string | null = null;
  /** Ce qu'on a écrit dans le formulaire d'une nouvelle carte (il survit au panneau refait : une confirmation). */
  private newMap: { name: string; half: number; license: string } | null = null;

  constructor(editor: MapEditor) {
    this.editor = editor;
    this.labelRoot = h("div", { class: "ed-labels" });
    this.root = h("div", { class: "editor", id: "editor" }, this.labelRoot, this.top, this.tools, this.panel, this.props, this.issues, this.help, this.noteEl);
    document.body.append(this.root);
    document.body.classList.add("in-editor");
  }

  dispose(): void {
    clearTimeout(this.noteTimer);
    this.root.remove();
    document.body.classList.remove("in-editor");
  }

  render(): void {
    this.refresh("all");
  }

  /** Refait une part des panneaux. */
  refresh(part: "all" | "top" | "panel" | "props" | "issues"): void {
    if (part === "all" || part === "top") this.renderTop();
    if (part === "all") this.renderTools();
    if (part === "all" || part === "panel") this.renderPanel();
    if (part === "all" || part === "props") this.renderProps();
    if (part === "all" || part === "issues") {
      this.renderIssues();
      this.renderTop();
    }
    if (part === "all") this.renderHelp();
  }

  notify(text: string, bad = false): void {
    this.noteEl.textContent = text;
    this.noteEl.classList.toggle("bad", bad);
    this.noteEl.classList.add("shown");
    clearTimeout(this.noteTimer);
    this.noteTimer = window.setTimeout(() => this.noteEl.classList.remove("shown"), bad ? 4500 : 2600);
  }

  focusSearch(): void {
    this.panel.querySelector<HTMLInputElement>(".ed-search")?.focus();
  }

  // --- Barre du haut ---

  private renderTop(): void {
    const e = this.editor;
    const playable = e.playable;
    const status = playable === null ? t("editor.top.checking") : playable ? t("editor.top.ok") : t("editor.top.issues", { n: e.issues.length });
    const originKey = e.source.origin === null ? "fresh" : e.source.origin;
    const k = e.keys;
    const statusButton = button(status, () => {
      e.issuesOpen = !e.issuesOpen;
      this.refresh("issues");
    }, { class: `ed-status ${playable === null ? "busy" : playable ? "ok" : "bad"}` });
    fill(this.top, 
      h("div", { class: "ed-name" },
        h("strong", {}, mapName(e.map)),
        e.dirty ? h("span", { class: "ed-dirty" }, `• ${t("editor.top.modified")}`) : null,
        h("small", {}, t(`editor.origin.${originKey}`))),
      statusButton,
      h("div", { class: "ed-actions" },
        button(`${t("editor.top.test")} (${k("editorTest")})`, () => e.test(), { class: "ed-btn primary" }),
        button(`${t("editor.top.save")} (${k("editorSave")})`, () => void e.save()),
        // Quitter : comme Échap, l'application demande confirmation s'il le faut
        button(t("editor.top.quit"), () => e.requestLeave())),
    );
  }

  // --- Barre des outils ---

  private renderTools(): void {
    const e = this.editor;
    fill(this.tools, ...TOOLS.map((id) => {
      const b = button("", () => e.setTool(id), { class: "ed-tool", "aria-pressed": e.tool === id ? "true" : "false", title: t(`editor.toolHint.${id}`, this.hintKeys()) });
      fill(b, h("span", {}, t(`editor.tool.${id}`)), h("kbd", {}, e.keys(TOOL_ACTIONS[id])));
      return b;
    }));
  }

  /** Les touches que citent les aides des outils. */
  private hintKeys(): { pick: string; add: string; smaller: string; bigger: string; rotate: string; snap: string; finish: string; remove: string } {
    const k = this.editor.keys;
    return {
      pick: k("editorPick"), add: k("editorAddPick"), smaller: k("editorBrushSmaller"), bigger: k("editorBrushBigger"),
      rotate: k("editorRotate"), snap: k("editorSnap"), finish: k("editorFinish"), remove: k("editorRemovePoint"),
    };
  }

  // --- Panneau de l'outil ---

  private renderPanel(): void {
    const e = this.editor;
    // Un panneau refait pendant qu'on y écrit perdrait ce qu'on écrit : la recherche de la palette garde son focus
    const searching = document.activeElement?.classList.contains("ed-search");
    const parts: Record<ToolId, () => Child[]> = {
      select: () => this.selectPanel(),
      terrain: () => this.terrainPanel(),
      place: () => this.placePanel(),
      trace: () => this.tracePanel(),
      water: () => this.waterPanel(),
      settings: () => this.settingsPanel(),
      file: () => this.filePanel(),
    };
    fill(this.panel, 
      h("h2", {}, t(`editor.tool.${e.tool}`)),
      h("p", { class: "ed-hint" }, t(`editor.toolHint.${e.tool}`, this.hintKeys())),
      ...parts[e.tool](),
    );
    if (searching) this.focusSearch();
  }

  private snapRows(): Child[] {
    const e = this.editor;
    return [
      row(`${t("editor.place.snap")} (${e.keys("editorSnap")})`, checkbox(e.snap, (v) => e.setSnap(v))),
      row(t("editor.place.grid"), select(String(e.gridStep), [1, 2, 4, 5, 10].map((s) => ({ value: String(s), label: measure(s, "m") })), (v) => e.setGridStep(Number(v)))),
    ];
  }

  private selectPanel(): Child[] {
    const e = this.editor;
    return [
      ...this.snapRows(),
      h("div", { class: "ed-buttons" },
        button(`${t("editor.props.focus")} (${e.keys("editorFocus")})`, () => e.focusSelection()),
        button(`${t("action.editorTopView")} (${e.keys("editorTopView")})`, () => e.run("editorTopView"))),
    ];
  }

  private terrainPanel(): Child[] {
    const e = this.editor;
    const out: Child[] = [];
    const terrain = e.map.terrain;
    if (terrain) {
      out.push(h("p", { class: "ed-info" }, t("editor.terrain.info", { side: terrain.cells * terrain.step, step: terrain.step, min: Math.round(terrain.min * 10) / 10, max: Math.round(terrain.max * 10) / 10 })));
    } else out.push(h("p", { class: "ed-info" }, t("editor.terrain.none")));
    if (e.importing) return [...out, ...this.importForm()];
    out.push(h("h3", {}, t("editor.brush.title")));
    out.push(h("div", { class: "ed-choices" }, ...BRUSH_KINDS.map((kind) => button(t(`editor.brush.${kind}`), () => e.setBrush({ kind }), { class: "ed-chip", "aria-pressed": e.brush.kind === kind ? "true" : "false" }))));
    out.push(row(`${t("editor.brush.radius")} (${e.keys("editorBrushSmaller")} · ${e.keys("editorBrushBigger")})`, slider(e.brush.radius, BRUSH_LIMITS.minRadius, BRUSH_LIMITS.maxRadius, 0.5, (v) => measure(v, "m", 1), (v) => {
      e.brush = { ...e.brush, radius: v };
    }, (v) => e.setBrush({ radius: v }))));
    out.push(row(t("editor.brush.strength"), slider(e.brush.strength, BRUSH_LIMITS.minStrength, BRUSH_LIMITS.maxStrength, 0.05, (v) => `${Math.round(v * 100)} %`, (v) => {
      e.brush = { ...e.brush, strength: v };
    }, (v) => e.setBrush({ strength: v }))));
    if (e.brush.kind === "flatten") out.push(row(t("editor.brush.height"), numberInput(e.brush.height, MAP_LIMITS.minHeight, MAP_LIMITS.maxHeight, 0.1, (v) => e.setBrush({ height: v }))));
    out.push(h("div", { class: "ed-buttons" },
      button(t("editor.terrain.import"), () => void e.importImage(), { title: t("editor.terrain.importDetail") }),
      button(t("editor.terrain.flat"), () => e.flatTerrain(), { title: t("editor.terrain.flatDetail") })));
    return out;
  }

  private importForm(): Child[] {
    const e = this.editor;
    const p = e.importing!;
    const o = p.options;
    const set = (change: Partial<typeof o>): void => {
      p.options = { ...o, ...change };
      this.refresh("panel");
    };
    const side = o.cells * o.step;
    // Le côté du relief : celui de la zone de jeu et de ses montagnes, des tailles courantes, et le choix en cours
    const sides = [...new Set([side, terrainSideFor(e.map.bounds.half), 160, 200, 240, 256, 300, 320, 360, 400, 440])].sort((a, b) => a - b);
    return [
      h("p", { class: "ed-info" }, t("editor.terrain.image", { name: p.name, width: p.image.width, height: p.image.height, bits: p.image.bits })),
      row(t("editor.terrain.step"), select(String(o.step), [1, 2].map((s) => ({ value: String(s), label: measure(s, "m") })), (v) => {
        const step = Number(v);
        set({ step, cells: Math.min(MAP_LIMITS.maxCells, Math.round(side / step)) });
      })),
      row(t("editor.terrain.size"), select(String(side), sides.filter((s) => s % o.step === 0 && s / o.step <= MAP_LIMITS.maxCells && s / o.step >= MAP_LIMITS.minCells && s <= MAP_LIMITS.maxSide).map((s) => ({ value: String(s), label: measure(s, "m") })), (v) => set({ cells: Number(v) / o.step }))),
      row(t("editor.terrain.low"), numberInput(o.low, 0, MAP_LIMITS.maxHeight, 0.5, (v) => set({ low: v }))),
      row(t("editor.terrain.high"), numberInput(o.high, 0, MAP_LIMITS.maxHeight, 0.5, (v) => set({ high: v }))),
      row(t("editor.terrain.smooth"), numberInput(o.smooth ?? 0, 0, 8, 1, (v) => set({ smooth: v }))),
      row(t("editor.terrain.mountains"), checkbox(!!o.mountains, (v) => set({ mountains: v ? { from: e.map.bounds.half + 6, height: 30 } : undefined }))),
      o.mountains ? row(t("editor.terrain.mountainsFrom"), numberInput(o.mountains.from, 10, 220, 1, (v) => set({ mountains: { ...o.mountains!, from: v } }))) : null,
      o.mountains ? row(t("editor.terrain.mountainsHeight"), numberInput(o.mountains.height, 0, 120, 1, (v) => set({ mountains: { ...o.mountains!, height: v } }))) : null,
      h("div", { class: "ed-buttons" }, button(t("editor.terrain.apply"), () => e.applyImport(), { class: "ed-btn primary" }), button(t("editor.terrain.cancel"), () => e.cancelImport())),
    ];
  }

  private placePanel(): Child[] {
    const e = this.editor;
    const search = h("input", { type: "search", class: "ed-search", placeholder: t("editor.place.search") });
    search.value = e.palette.search;
    search.addEventListener("input", () => {
      e.palette.search = search.value;
      this.renderPalette(grid);
    });
    const tabs = h("div", { class: "ed-tabs" }, ...PALETTE_TABS.map((tab) => button(t(`editor.place.tab.${tab}`), () => {
      e.palette.tab = tab;
      e.palette.search = "";
      this.refresh("panel");
    }, { class: "ed-tab", "aria-selected": e.palette.tab === tab && !e.palette.search ? "true" : "false" })));
    const grid = h("div", { class: "ed-palette" });
    this.renderPalette(grid);
    const arena = e.built;
    const boxes = arena ? arena.boxes.filter((b) => b.kind !== "bound").length : 0;
    return [
      search, tabs, grid,
      h("p", { class: "ed-info" }, t("editor.place.yaw", { angle: measure(e.yaw, "deg") }), ` (${e.keys("editorRotate")} · ${e.keys("editorRotateBack")})`),
      e.palette.tab === "boxes" ? row(t("editor.place.look"), select<BoxLook>(e.boxLook ?? "", [{ value: "", label: t("editor.place.lookDefault") }, ...BOX_LOOKS.map((l) => ({ value: l, label: t(`editor.look.${l}`) }))], (v) => {
        e.boxLook = v || undefined;
      })) : null,
      ...this.snapRows(),
      arena ? h("p", { class: "ed-info" }, t("editor.place.count", { props: arena.props.length, maxProps: MAP_LIMITS.props, boxes, maxBoxes: MAP_LIMITS.boxes })) : null,
    ];
  }

  /** Les entrées de la palette : l'onglet, ou ce que trouve la recherche (sans accents, dans la langue affichée). */
  private renderPalette(grid: HTMLElement): void {
    const e = this.editor;
    const query = fold(e.palette.search.trim());
    const entries = PALETTE.filter((p) => (query ? fold(paletteName(p)).includes(query) || fold(t(`editor.group.${p.group}`)).includes(query) : p.tab === e.palette.tab));
    const items: HTMLElement[] = [];
    let group = "";
    for (const p of entries) {
      if (p.group !== group) {
        group = p.group;
        items.push(h("div", { class: "ed-group" }, t(`editor.group.${p.group}`)));
      }
      items.push(button(paletteName(p), () => e.pick(p.id), { class: "ed-item", "aria-pressed": e.palette.id === p.id ? "true" : "false" }));
    }
    fill(grid, ...(items.length ? items : [h("p", { class: "ed-info" }, t("editor.place.empty"))]));
  }

  private tracePanel(): Child[] {
    const e = this.editor;
    const n = e.trace.points.length;
    return [
      h("div", { class: "ed-choices" }, ...TRACE_KINDS.map((kind) => button(t(`editor.trace.${kind}`), () => e.pickTrace(kind), { class: "ed-chip", "aria-pressed": e.trace.kind === kind ? "true" : "false" }))),
      e.trace.kind === "bridge" ? h("p", { class: "ed-hint" }, t("editor.trace.bridgeHint")) : null,
      h("p", { class: "ed-info" }, t("editor.trace.points", { n })),
      h("div", { class: "ed-buttons" },
        button(`${t("editor.trace.finish")} (${e.keys("editorFinish")})`, () => e.finishTrace(), { class: "ed-btn primary", disabled: n < 2 }),
        button(t("editor.trace.cancel"), () => e.cancelTrace(), { disabled: n === 0 })),
      ...this.snapRows(),
    ];
  }

  private waterPanel(): Child[] {
    const e = this.editor;
    const map = e.map;
    const water = map.water;
    const lo = Math.floor(map.terrain?.min ?? 0);
    const hi = Math.ceil(Math.min(MAP_LIMITS.maxHeight, (map.terrain?.max ?? 10)));
    const set = (w: MapFile["water"]): void => e.update((m) => {
      const out = { ...m, water: w };
      if (!w) delete (out as { water?: unknown }).water;
      return out;
    });
    const out: Child[] = [row(t("editor.water.on"), checkbox(!!water, (v) => set(v ? { level: Math.round((lo + 1.5) * 10) / 10, color: "#2b8a9c" } : undefined)))];
    if (water) {
      out.push(row(t("editor.water.level"), slider(water.level, lo, hi, 0.1, (v) => measure(v, "m", 1), (v) => e.previewWater(v), (v) => set({ ...water, level: v }))));
      out.push(row(t("editor.water.deep"), checkbox(water.deep !== undefined, (v) => set(v ? { ...water, deep: 1.2 } : { level: water.level, ...(water.color ? { color: water.color } : {}) })), t("editor.water.deepDetail")));
      if (water.deep !== undefined) out.push(row(t("editor.water.depth"), numberInput(water.deep, 0.3, 50, 0.1, (v) => set({ ...water, deep: v }))));
      const color = h("input", { type: "color", class: "ed-color" });
      color.value = water.color ?? "#3f6f86";
      color.addEventListener("change", () => set({ ...water, color: color.value.toLowerCase() }));
      out.push(row(t("editor.water.color"), color));
      out.push(button(t("editor.water.clickLevel"), () => e.setWaterClick("level"), { class: "ed-chip", "aria-pressed": e.waterClick === "level" ? "true" : "false", title: t("editor.water.clickLevelDetail", this.hintKeys()) }));
    }
    out.push(h("h3", {}, t("editor.palette.lavaPool")));
    out.push(h("div", { class: "ed-buttons" },
      button(t("editor.water.lavaPool"), () => e.setWaterClick("pool"), { class: "ed-chip", "aria-pressed": e.waterClick === "pool" ? "true" : "false", title: t("editor.water.lavaPoolDetail", this.hintKeys()) }),
      button(t("editor.water.lavaFlow"), () => e.pickTrace("lavaFlow"))));
    out.push(h("p", { class: "ed-info" }, t("editor.water.lava", { n: map.lava?.length ?? 0 })));
    return out;
  }

  private settingsPanel(): Child[] {
    const e = this.editor;
    const m = e.map;
    const meta = m.meta;
    const L = MAP_LIMITS;
    const setMeta = (change: Partial<MapFile["meta"]>): void => e.update((map) => {
      const next = { ...map.meta, ...change } as Record<string, unknown>;
      for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === "") delete next[k];
      return { ...map, meta: next as unknown as MapFile["meta"] };
    });
    const perLanguage = (key: "names" | "descriptions", lang: string, value: string): void => {
      const current = { ...(meta[key] ?? {}) };
      if (value.trim()) current[lang] = value.trim();
      else delete current[lang];
      setMeta({ [key]: Object.keys(current).length ? current : undefined });
    };
    const b = m.bounds;
    // Les valeurs « auto » : celles de l'arène construite (l'altitude plancher des avions vient du plus haut du décor)
    const auto = e.built?.bounds ?? mapBounds(m, 0);
    const setBounds = (key: keyof MapFile["bounds"], v: number | undefined): void => e.update((map) => {
      const next = { ...map.bounds, [key]: v } as Record<string, unknown>;
      if (v === undefined) delete next[key];
      return { ...map, bounds: next as unknown as MapFile["bounds"] };
    });
    const optBound = (key: "roam" | "spawnLine" | "spawnSpread" | "circuit" | "airFloor" | "hoverFloor", label: string, min: number, max: number): HTMLElement => {
      const value = b[key];
      const input = numberInput(value ?? auto[key] ?? 0, min, max, 1, (v) => setBounds(key, v), value === undefined);
      const isAuto = checkbox(value === undefined, (v) => setBounds(key, v ? undefined : Math.round(auto[key] ?? min)));
      return row(label, h("span", { class: "ed-auto" }, input, h("label", {}, isAuto, t("editor.settings.auto"))));
    };
    const limits = m.limits ?? {};
    const setLimits = (change: Partial<NonNullable<MapFile["limits"]>>): void => e.update((map) => {
      const next = { ...(map.limits ?? {}), ...change } as Record<string, unknown>;
      for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === false) delete next[k];
      const out = { ...map, limits: next as NonNullable<MapFile["limits"]> };
      if (!Object.keys(next).length) delete (out as { limits?: unknown }).limits;
      return out;
    });
    const boundMode = limits.bound === undefined ? "default" : limits.bound === 0 ? "none" : "at";
    const sky = m.sky ?? { color: "#bfd0db", fog: 0.0045 };
    const setSky = (change: Partial<NonNullable<MapFile["sky"]>>): void => e.update((map) => ({ ...map, sky: { ...(map.sky ?? sky), ...change } }));
    const skyColor = h("input", { type: "color", class: "ed-color" });
    skyColor.value = sky.color;
    skyColor.addEventListener("change", () => setSky({ color: skyColor.value.toLowerCase() }));
    const setTop = <K extends "ground" | "ambience" | "urban" | "nav">(key: K, value: MapFile[K] | undefined): void => e.update((map) => {
      const out = { ...map, [key]: value } as Record<string, unknown>;
      if (value === undefined) delete out[key];
      return out as unknown as MapFile;
    });
    const nav = m.nav;
    const navMode = nav === false ? "off" : nav ? "custom" : "default";
    const arenas = (ids: readonly ArenaId[]): { value: ArenaId; label: string }[] => ids.map((id) => ({ value: id, label: arenaName(id) }));
    return [
      h("h3", {}, t("editor.settings.meta")),
      row(t("editor.settings.name"), textInput(meta.name, L.name, (v) => v.trim() && setMeta({ name: v.trim() }))),
      row(t("editor.settings.author"), textInput(meta.author, L.author, (v) => v.trim() && setMeta({ author: v.trim() }))),
      row(t("editor.settings.license"), textInput(meta.license, L.license, (v) => v.trim() && setMeta({ license: v.trim() }))),
      row(t("editor.settings.description"), textInput(meta.description ?? "", L.description, (v) => setMeta({ description: v.trim() || undefined }), true)),
      ...LOCALE_IDS.flatMap((lang) => [
        row(t("editor.settings.nameIn", { language: LOCALES[lang].name }), textInput(meta.names?.[lang] ?? "", L.name, (v) => perLanguage("names", lang, v))),
        row(t("editor.settings.descriptionIn", { language: LOCALES[lang].name }), textInput(meta.descriptions?.[lang] ?? "", L.description, (v) => perLanguage("descriptions", lang, v), true)),
      ]),
      h("h3", {}, t("editor.settings.play")),
      row(t("editor.settings.half"), numberInput(b.half, L.minHalf, L.maxHalf, 1, (v) => setBounds("half", v))),
      optBound("roam", t("editor.settings.roam"), 5, L.maxHalf),
      optBound("spawnLine", t("editor.settings.spawnLine"), 5, L.maxHalf),
      optBound("spawnSpread", t("editor.settings.spawnSpread"), 2, L.maxHalf),
      optBound("circuit", t("editor.settings.circuit"), 10, L.maxHalf + 40),
      optBound("airFloor", t("editor.settings.airFloor"), 0, 80),
      optBound("hoverFloor", t("editor.settings.hoverFloor"), 0, 40),
      h("h3", {}, t("editor.settings.spawns")),
      row(t("editor.settings.spawnsFree"), checkbox(!!m.spawns, (v) => e.setFreeSpawns(v)), t("editor.settings.spawnsFreeDetail")),
      h("h3", {}, t("editor.settings.limits")),
      row(t("editor.settings.walls"), checkbox(!!limits.walls, (v) => setLimits({ walls: v }))),
      row(t("editor.settings.bound"), select(boundMode, [
        { value: "default", label: t("editor.settings.boundDefault") }, { value: "none", label: t("editor.settings.boundNone") }, { value: "at", label: t("editor.settings.boundAt") },
      ], (v) => setLimits({ bound: v === "default" ? undefined : v === "none" ? 0 : Math.round(boundAt(m) ?? b.half + 35) }))),
      boundMode === "at" ? row(t("editor.settings.boundAt"), numberInput(limits.bound, b.half + 2, L.reach, 1, (v) => setLimits({ bound: v }))) : null,
      h("h3", {}, t("editor.settings.sky")),
      row(t("editor.settings.skyColor"), skyColor),
      row(t("editor.settings.fog"), numberInput(sky.fog, 0, 0.05, 0.0005, (v) => setSky({ fog: v }))),
      row(t("editor.settings.dust"), numberInput(sky.dust ?? 0, 0, 200, 1, (v) => setSky({ dust: v || undefined }))),
      row(t("editor.settings.night"), checkbox(!!sky.night, (v) => setSky({ night: v || undefined })), t("editor.settings.nightDetail")),
      row(t("editor.settings.ground"), select<ArenaId>(m.ground?.preset ?? "valley", arenas(GROUND_PRESETS), (v) => setTop("ground", v ? { ...(m.ground ?? {}), preset: v as ArenaId } : undefined))),
      row(t("editor.settings.ambience"), select<ArenaId>(m.ambience ?? "valley", arenas(ARENA_IDS), (v) => setTop("ambience", (v || undefined) as ArenaId | undefined))),
      h("h3", {}, t("editor.settings.ai")),
      row(t("editor.settings.urban"), checkbox(!!m.urban, (v) => setTop("urban", v || undefined)), t("editor.settings.urbanDetail")),
      row(t("editor.settings.nav"), select(navMode, [
        { value: "default", label: t("editor.settings.navDefault") }, { value: "off", label: t("editor.settings.navOff") }, { value: "custom", label: t("editor.settings.navCustom") },
      ], (v) => setTop("nav", v === "off" ? false : v === "custom" ? { cell: 2.5, maxSlope: 26 } : undefined))),
      nav ? row(t("editor.settings.navCell"), numberInput(nav.cell ?? 2.5, L.minNavCell, L.maxNavCell, 0.5, (v) => setTop("nav", { ...nav, cell: v }))) : null,
      nav ? row(t("editor.settings.navSlope"), numberInput(nav.maxSlope ?? 26, 5, 45, 1, (v) => setTop("nav", { ...nav, maxSlope: v }))) : null,
    ];
  }

  /** Un bouton qui demande un second clic quand des modifications ne sont pas enregistrées. */
  private guarded(id: string, label: string, run: () => void, attrs: Record<string, string | boolean | undefined> = {}): HTMLButtonElement {
    const e = this.editor;
    const waiting = this.confirming === id;
    return button(waiting ? t("editor.file.confirm") : label, () => {
      if (e.dirty && !waiting) {
        this.confirming = id;
        this.refresh("panel");
        return;
      }
      this.confirming = null;
      run();
    }, { ...attrs, class: `ed-btn${waiting ? " warn" : ""}${attrs.class ? ` ${attrs.class}` : ""}` });
  }

  private filePanel(): Child[] {
    const e = this.editor;
    const form = (this.newMap ??= { name: t("editor.untitled"), half: 80, license: "CC-BY-4.0" });
    const nameInput = textInput(form.name, MAP_LIMITS.name, (v) => (form.name = v));
    nameInput.addEventListener("input", () => (form.name = nameInput.value));
    const licenseInput = textInput(form.license, MAP_LIMITS.license, (v) => (form.license = v));
    licenseInput.addEventListener("input", () => (form.license = licenseInput.value));
    const entries = e.library.list(["bundled", "library", "server"]);
    return [
      h("h3", {}, t("editor.file.new")),
      row(t("editor.settings.name"), nameInput),
      row(t("editor.settings.license"), licenseInput),
      row(t("editor.file.size"), numberInput(form.half, MAP_LIMITS.minHalf, MAP_LIMITS.maxHalf, 5, (v) => (form.half = v))),
      this.guarded("new", t("editor.file.create"), () => {
        this.newMap = null;
        e.newMap(form.name, form.half, form.license);
      }, { class: "primary" }),
      h("h3", {}, t("editor.file.library")),
      h("ul", { class: "ed-list" }, ...entries.map((entry) => h("li", {},
        h("span", {}, mapName(entry.map), h("small", {}, t(`maps.origin.${entry.origin}`))),
        entry.key === e.source.key ? h("em", {}, t("editor.file.current")) : this.guarded(`open-${entry.key}`, t("editor.file.open"), () => e.openEntry(entry))))),
      this.guarded("file", t("editor.file.openFile"), () => void e.openFile()),
      h("h3", {}, t("editor.top.save")),
      h("div", { class: "ed-buttons ed-column" },
        button(`${t("editor.top.save")} (${e.keys("editorSave")})`, () => void e.save(), { class: "ed-btn primary" }),
        // (une carte qui a des ressources s'exporte en paquet)
        button(t(e.map.assets ? "editor.file.exportPackage" : "editor.file.export"), () => void e.exportMap()),
        button(t("editor.file.exportTerrain"), () => void e.exportTerrain(), { disabled: !e.map.terrain })),
      ...this.renderAssets(),
    ];
  }

  /** Les ressources de la carte (un paquet) : la liste (chacune se retire), et en ajouter une. */
  private renderAssets(): Child[] {
    const e = this.editor;
    const types = (Object.keys(PROP_TYPES) as PropType[]).map((type) => ({ value: type, label: propName(type) })).sort((a, b) => compareText(a.label, b.label));
    let chosen: PropType = this.assetType;
    return [
      h("h3", {}, t("editor.file.assets")),
      h("p", { class: "ed-hint" }, t("editor.file.assetsHint")),
      h("ul", { class: "ed-list" }, ...assetEntries(e.map.assets).map((entry) => h("li", {},
        h("span", {}, entry.path, h("small", {}, measure(entry.asset.bytes / 1024, "kB"))),
        button(t("editor.file.assetRemove"), () => e.removeAsset(entry.type))))),
      row(t("editor.file.assetType"), select<PropType>(chosen, types, (v) => {
        if (v) chosen = this.assetType = v;
      })),
      h("div", { class: "ed-buttons ed-column" },
        button(t("editor.file.assetModel"), () => void e.addAsset(chosen)),
        button(t("editor.file.assetAmbience"), () => void e.addAsset(null))),
    ];
  }

  /** Le type d'accessoire choisi pour un modèle à ajouter (gardé d'un dessin du panneau à l'autre). */
  private assetType: PropType = "crate";

  // --- Propriétés de la sélection ---

  private renderProps(): void {
    const e = this.editor;
    const sel = e.selection;
    if (!sel.length) {
      this.props.hidden = true;
      fill(this.props);
      return;
    }
    this.props.hidden = false;
    const actions = h("div", { class: "ed-buttons" },
      button(`↺ ${e.keys("editorRotateBack")}`, () => e.rotateSelection(-1), { title: t("editor.props.rotate") }),
      button(`↻ ${e.keys("editorRotate")}`, () => e.rotateSelection(1), { title: t("editor.props.rotate") }),
      button(t("editor.props.focus"), () => e.focusSelection()),
      sel.some((r) => r.list !== "spawns") ? button(`${t("editor.props.duplicate")} (${e.keys("editorDuplicate")})`, () => e.duplicateSelection()) : null,
      sel.some((r) => r.list !== "spawns") ? button(`${t("editor.props.delete")} (${e.keys("editorDelete")})`, () => e.deleteSelection(), { class: "ed-btn bad" }) : null);
    if (sel.length > 1) {
      fill(this.props, h("h2", {}, t("editor.props.multi", { n: sel.length })), actions);
      return;
    }
    const ref = sel[0];
    const el = getElement(e.map, ref);
    if (!el) {
      this.props.hidden = true;
      return;
    }
    const form = formOf(ref.list, el);
    const title = ref.list === "spawns" ? `${t("editor.kind.spawn")} · ${t(`team.${ref.index === 0 ? "blue" : "red"}`)}` : t(`editor.kind.${form}`);
    const fields = FORMS[form].filter((f) => fieldApplies(form, f, el)).map((f) => this.field(ref, f));
    fill(this.props, h("h2", {}, title), ...fields, actions);
  }

  /** La commande d'un champ d'un élément. */
  private field(ref: ElementRef, f: FieldSpec): HTMLElement {
    const e = this.editor;
    const el = getElement(e.map, ref)!;
    const value = fieldValue(el, f);
    const set = (v: unknown): void => e.setField(ref, f, v);
    const label = t(`editor.field.${f.key}`);
    switch (f.type) {
      case "number": {
        const input = numberInput(value as number | undefined, f.min, f.max, f.step, (v) => set(f.int ? Math.round(v) : v), value === undefined);
        if (!f.optional) return row(label, input);
        // Sans « auto » : une hauteur part du sol sous l'élément, le reste de 1 (dans ses bornes)
        const fallback = f.key === "y" || f.key === "base" ? Math.round(e.groundUnder(ref) * 10) / 10 : 1;
        return row(label, h("span", { class: "ed-auto" }, input, h("label", {}, checkbox(value === undefined, (on) => set(on ? undefined : Math.min(f.max, Math.max(f.min, fallback)))), t("editor.props.auto"))));
      }
      case "angle":
        return row(label, numberInput((value as number | undefined) ?? 0, -180, 180, 1, (v) => set(v)));
      case "choice":
        return row(label, select<string>((value as string | undefined) ?? "", [
          ...(f.optional ? [{ value: "", label: t("editor.props.default") }] : []),
          ...f.options.map((o) => ({ value: o, label: choiceName(f.names, o) })),
        ], (v) => set(v === "" ? undefined : v)));
      case "bool":
        return row(label, checkbox(value as boolean, (v) => set(v)));
      case "size": {
        const size = (value as readonly number[] | undefined) ?? [1, 1, 1];
        const one = (i: number): HTMLInputElement => numberInput(size[i], f.min, f.max, 0.1, (v) => set(size.map((s, k) => (k === i ? v : s))));
        return row(label, h("span", { class: "ed-size" }, one(0), one(1), one(2)));
      }
      case "range": {
        const range = value as readonly [number, number] | undefined;
        const [a, b] = range ?? [f.min, f.max];
        const pair = h("span", { class: "ed-size" },
          numberInput(a, f.min, f.max, f.step, (v) => set([Math.min(v, b), b]), !range),
          numberInput(b, f.min, f.max, f.step, (v) => set([a, Math.max(v, a)]), !range));
        if (!f.optional) return row(label, pair);
        return row(label, h("span", { class: "ed-auto" }, pair, h("label", {}, checkbox(!range, (on) => set(on ? undefined : [f.min, f.max])), t("editor.props.auto"))));
      }
      case "text":
        return row(label, textInput((value as string | undefined) ?? "", f.max, (v) => v.trim() && set(v.trim())));
      case "trees": {
        const trees = (value as readonly string[] | undefined) ?? [];
        return row(label, h("span", { class: "ed-trees" }, ...TREE_TYPES.map((type) => h("label", {},
          checkbox(trees.includes(type), (on) => {
            const next = on ? [...trees, type] : trees.filter((x) => x !== type);
            set(next.length ? next : undefined);
          }), t(`prop.${type}`)))));
      }
    }
  }

  // --- Problèmes ---

  private renderIssues(): void {
    const e = this.editor;
    const playable = e.playable;
    const header = button(playable === null ? t("editor.top.checking") : playable ? t("editor.issues.ok") : `${t("editor.issues.title")} · ${e.issues.length}`, () => {
      e.issuesOpen = !e.issuesOpen;
      this.renderIssues();
    }, { class: `ed-issues-head ${playable === false ? "bad" : playable ? "ok" : ""}` });
    const list = e.issuesOpen && e.issues.length && playable === false
      ? h("ul", {}, ...e.issues.map((issue) => h("li", {}, button(mapIssueText(issue), () => e.goToIssue(issue), { class: "ed-issue" }))))
      : null;
    fill(this.issues, header, list, list ? h("p", { class: "ed-hint" }, t("editor.issues.hint")) : null);
  }

  // --- Aide ---

  private renderHelp(): void {
    const toggle = button(t("editor.help.show"), () => {
      this.helpOpen = !this.helpOpen;
      this.renderHelp();
    }, { class: "ed-help-toggle", "aria-expanded": this.helpOpen ? "true" : "false" });
    const lines = this.helpOpen
      ? h("dl", {}, ...editorKeys(this.editor.keys).flatMap(([key, effect]) => [h("dt", {}, h("kbd", {}, key)), h("dd", {}, effect)]))
      : null;
    fill(this.help, toggle, lines);
  }
}
