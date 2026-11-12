import * as B from "../babylon";
import { blockDef, blockShape, type BlockType } from "../../shared/catalog/blocks";
import { meleeDef } from "../../shared/catalog/melee";
import { wheelDef, type WheelType } from "../../shared/catalog/wheels";
import { lockedParts, partPrice, type Part } from "../../shared/design/progression";
import { blockName, conflictLine, conflictText, designIssueText, partName } from "../i18n/names";
import { fixed } from "../i18n/format";
import { measure, t } from "../i18n/i18n";
import { onLocaleChange } from "../i18n/state";
import { buriedTurrets } from "../../shared/design/robotDesign";
import {
  blockBody, designConflicts, headLift, pieceZones, placementConflicts, type Conflict, type Piece,
} from "../../shared/design/clearance";
import { jetObstructions } from "../../shared/robot/exhaust";
import { designSurfaceSides } from "../../shared/robot/surfaces";
import type { Progress } from "../progress";
import { BLOCK_SIZE } from "../../shared/config";
import { designCost, ROBOT_BUDGET } from "../../shared/design/budget";
import { inferMobility, profileFromDesign } from "../../shared/design/custom";
import { designCenterOfMass, designMass, flightStats } from "../../shared/design/flight";
import type { BotProfile, Mobility } from "../../shared/design/presets";
import {
  AXES, axisOf, cellKey, DEFAULT_FACING, mirrorFacing, TRACK_LAYERS, TRACK_RISE, validateDesign, type Axis, type BlockPlacement, type Facing,
  type RobotDesign, type WheelMount,
} from "../../shared/design/robotDesign";
import { cross, quatFromBasis, type Quat } from "../../shared/math/vec";
import { wheelLocalPos } from "../../shared/robot/lifecycle";
import { byId } from "../dom";
import { stillBelts } from "../render/belts";
import { Assets, context2d } from "../render/materials";
import type { TurretBlockType } from "../render/models";
import { stillMelee } from "../render/meleeView";
import { stillBlockParts, stillWheelParts } from "../render/stillParts";
import type { SavedRobot } from "./storage";
import { ClearanceView, type ZoneShow } from "./clearanceView";
import { Inventory } from "./inventory";
import {
  actionsFor, chordCode, DEFAULT_BINDINGS, eventChords, keyLabel, RECENT_SLOTS,
  type ActionId, type Bindings,
} from "../input/bindings";

/** Ce qu'on pose : un type de bloc, ou un type de roue. */
/** Outil de pose : une pièce (voir shared/design/progression.ts). */
type Tool = Part;

/** Au-delà de ce déplacement (px), un clic devient un glisser (la caméra tourne) : on ne pose ni n'enlève rien. */
const CLICK_SLOP = 6;
/** Étendue de la grille d'édition (cases, de part et d'autre du centre), et étages permis. */
const REACH = 16;
const LOWEST = -4;
const HIGHEST = 20;
/** Nombre de modifications que l'on peut annuler. */
const HISTORY = 100;
/** Assombrissement des blocs sous l'étage affiché, et opacité de la grille au-dessus du sol, en vue par étage. */
const BELOW_SHADE = 0.45;
const FLOOR_SEE_THROUGH = 0.55;

/** Une case de la grille. */
interface Cell {
  x: number;
  y: number;
  z: number;
}

/** Ce qu'on a copié : un étage (collé sur l'étage de travail), ou une zone (collée sous le pointeur, coordonnées relatives à son coin). */
interface Clipboard {
  kind: "layer" | "zone";
  blocks: BlockPlacement[];
  wheels: WheelMount[];
}

/** Couleur de l'aperçu d'une pièce qui passe, et d'une pièce qui gênerait (ou serait gênée). */
const FREE_COLOR = "#57d38c";
const CLASH_COLOR = "#ff6150";

/**
 * Une pose vérifiée : la pièce, le plan où on la pose et ce qu'elle y gênerait ; sa symétrique (en
 * mode symétrie, posée après elle) et ce qu'elle gênerait.
 */
interface PlacementCheck {
  piece: Piece;
  design: RobotDesign;
  clash: Conflict[];
  twin: Piece | null;
  twinDesign: RobotDesign;
  twinClash: Conflict[];
}

/** Un bloc posé là, orienté ainsi (sans orientation notée : celle par défaut). */
function placementOf(x: number, y: number, z: number, type: BlockType, facing: Facing): BlockPlacement {
  const same = facing.up === DEFAULT_FACING.up && facing.forward === DEFAULT_FACING.forward;
  return { x, y, z, type, ...(same ? {} : { facing: { ...facing } }) };
}

/** Roue symétrique par rapport au plan x = 0 (un décalage le long d'un flanc avant ou arrière change de sens). */
function mirrorWheel(w: WheelMount): WheelMount {
  const m: WheelMount = { ...w, x: -w.x, dx: -w.dx };
  if (w.shift && w.dz !== 0) m.shift = -w.shift;
  return m;
}

/** Même roue : même bloc, même flanc (ou dessous), même décalage, même place dans sa chenille. */
const sameMount = (a: WheelMount, b: WheelMount): boolean =>
  a.x === b.x && a.y === b.y && a.z === b.z && a.dx === b.dx && a.dz === b.dz && (a.dy ?? 0) === (b.dy ?? 0) &&
  (a.shift ?? 0) === (b.shift ?? 0) && (a.rise ?? 0) === (b.rise ?? 0) && (a.layer ?? 0) === (b.layer ?? 0);

/** Décalage d'une roue le long de la face visée, en demi-cases (-1, 0 ou 1), d'après l'écart au milieu de la face (m). */
const shiftFrom = (along: number): number => Math.max(-1, Math.min(1, Math.round(along / (BLOCK_SIZE / 2))));

const AXIS_LIST: readonly Axis[] = ["+y", "-y", "+x", "-x", "+z", "-z"];
/** Repères peints au sol autour du robot (avant, arrière, gauche, droite) : leur distance au bord du robot (m). */
const MARK_GAP = 0.9;

/**
 * Blocs qui s'orientent d'eux-mêmes selon la face où on les pose (orientation auto) : leur haut
 * sort de cette face. Une tourelle posée sous un bloc pend, posée sur un flanc elle sort de côté ;
 * une arme de contact aussi (une toupie posée sous un bloc tourne dessous, sur un flanc elle tourne
 * debout) ; une forme a son dessous plein collé à son support. Pas les moteurs (ils poussent vers leur
 * haut : un propulseur posé à l'arrière pousserait à reculons ; l'hélice tranchante en est un), ni
 * les ailes, les appuis ou les tourelles fixes (une soute à bombes lâche vers le bas de son bloc), ni
 * un rotor couché (axe `left` : le disque d'une toupie verticale, un tambour) : il se pose sur l'avant
 * du robot, debout, et y resterait couché sur le dos.
 */
function orientsToFace(type: BlockType): boolean {
  const d = blockDef(type);
  const melee = d.melee && !d.thruster ? meleeDef(d.melee) : null;
  const byFace = !!melee && !(melee.motion !== "swing" && melee.axis === "left");
  return (!!d.turret && !d.turret.fixed) || !!blockShape(type) || !!d.flares || !!d.radar || !!d.jammer || !!d.light || byFace;
}

/**
 * Avant d'un bloc orienté selon la face `up` : l'avant du robot quand c'est possible (une tourelle
 * au repos regarde devant), sinon le haut (sur la face avant ou arrière) ; une forme posée sur un
 * flanc regarde vers le haut (un biseau de flanc penche vers le haut, comme une jupe de char).
 */
function faceForward(up: Axis, type: BlockType): Axis {
  if (up === "+y" || up === "-y") return "+z";
  if (up === "+z" || up === "-z") return "+y";
  return blockShape(type) ? "+y" : "+z";
}

/** L'axe `a` tourné de `turns` quarts de tour autour de l'axe `up` (qui lui est perpendiculaire). */
function spinAxis(a: Axis, up: Axis, turns: number): Axis {
  let v = AXES[a];
  for (let i = 0; i < ((turns % 4) + 4) % 4; i++) v = cross(AXES[up], v);
  return axisOf(v);
}

/** Direction d'un axe du robot, en mots (pour le panneau) : `garage.axis.<mot>` des catalogues de messages. */
export type AxisWord = "up" | "down" | "front" | "back" | "left" | "right";
const AXIS_WORDS: Record<Axis, AxisWord> = {
  "+y": "up", "-y": "down", "+z": "front", "-z": "back", "+x": "left", "-x": "right",
};
const axisWord = (a: Axis): string => t(`garage.axis.${AXIS_WORDS[a]}`);

/** Les côtés du robot que montrent les repères au sol et la boussole (`garage.mark.<côté>`, `garage.compass.<côté>`). */
export type MarkSide = "front" | "back" | "left" | "right";

/** Rotation d'un bloc orienté ainsi. */
function facingQuat(f: Facing): Quat {
  const up = AXES[f.up];
  const forward = AXES[f.forward];
  return quatFromBasis(cross(up, forward), up, forward);
}

/** Robot de départ : un cockpit sur un plateau, prêt à recevoir des roues. */
export function starterRobot(): SavedRobot {
  const blocks: BlockPlacement[] = [];
  for (let x = -1; x <= 1; x++) for (let z = -2; z <= 2; z++) blocks.push({ x, y: 0, z, type: "frame" });
  blocks.push({ x: 0, y: 1, z: 0, type: "cockpit" });
  return { name: t("garage.starterName"), color: "#6f93a8", design: { blocks, wheels: [] } };
}

/**
 * Garage : l'éditeur de robots, sur une grille de blocs. Sa propre scène (le moteur de rendu est
 * partagé : l'arène est en veille pendant ce temps) et son panneau HTML : palette des blocs et des
 * roues, orientation, symétrie, coût, défauts du plan, et les commandes (essayer, enregistrer…).
 */
/** Les bruits du garage (des sons d'interface, voir audio/sound.ts). */
export type GarageSound = "place" | "remove" | "rotate" | "wheel" | "error" | "unlock";

export class Garage {
  /** Essayer le robot (au stand de tir) ; enregistrer ; ouvrir une liste de robots ; quitter. */
  onTest: ((profile: BotProfile, robot: SavedRobot) => void) | null = null;
  onSave: ((robot: SavedRobot) => void) | null = null;
  /** Bruit d'une action du garage (pose, retrait, rotation, roue, erreur, déblocage). */
  onSound: (kind: GarageSound) => void = () => {};
  /**
   * Touches choisies par le joueur (la rubrique Garage de la table des actions, input/bindings.ts) et
   * leurs noms (selon son clavier) ; l'application les donne, et refait le panneau quand elles changent.
   */
  bindings: Bindings = DEFAULT_BINDINGS;
  keyName: (id: ActionId) => string = keyLabel;
  onBrowse: ((robot: SavedRobot) => void) | null = null;
  onExit: (() => void) | null = null;
  /** Pièces débloquées et crédits du joueur ; sans elle, tout est disponible. */
  progress: Progress | null = null;

  private readonly scene: B.Scene;
  private readonly camera: B.ArcRotateCamera;
  private readonly canvas: HTMLCanvasElement;
  private readonly assets: Assets;
  /**
   * Aperçu du bloc à poser, là où il ira et orienté comme il le sera : sa forme, la tête d'une
   * tourelle, une flèche pour un moteur (le sens de sa poussée) ou un lance-leurres. Vert si la
   * case est libre, rouge sinon.
   */
  private readonly ghost: B.TransformNode;
  private readonly ghostMat: B.StandardMaterial;
  private readonly arrowMat: B.StandardMaterial;
  private ghostParts: B.Mesh[] = [];
  private ghostType: BlockType | null = null;
  /** Le nombre de sources qui avaient pris leur modèle glTF quand l'aperçu a été fait (voir `buildGhost`). */
  private ghostModels = 0;
  /** Dernière position du pointeur sur le canvas (pour remettre l'aperçu à jour après une rotation au clavier). */
  private pointer: { x: number; y: number } | null = null;
  private readonly panel = byId("garage");
  private meshes: B.AbstractMesh[] = [];
  private open_ = false;

  private name = t("garage.starterName");
  private color = "#6f93a8";
  private readonly blocks = new Map<string, BlockPlacement>();
  private wheels: WheelMount[] = [];
  private tool: Tool = { kind: "block", type: "frame" };
  /** Orientation choisie à la main (orientation auto coupée, ou bloc qui ne s'oriente pas selon la face). */
  private facing: Facing = { ...DEFAULT_FACING };
  /** Orientation auto : le bloc s'oriente selon la face visée (`orientsToFace`) ; R le fait pivoter de `spin` quarts de tour. */
  private autoOrient = true;
  private spin = 0;
  /**
   * Copie au clic du milieu : l'orientation du bloc copié (dans `facing`) prime sur l'orientation
   * selon la face, jusqu'au prochain choix de pièce : chaque clic gauche en pose le double exact.
   */
  private copied = false;
  /** Face visée (le haut d'un bloc qu'on y poserait) : celle du bloc sous le pointeur, ou le sol. */
  private hoverFace: Axis = "+y";
  private mirror = true;
  /** Matériau des bandes de chenille (texture du motif), créé à la première chenille. */
  private down: { x: number; y: number; button: number } | null = null;
  private floor!: B.Mesh;
  /** Plans d'avant chaque modification (JSON), pour annuler ; et ceux que l'on a annulés, pour rétablir. */
  private history: string[] = [];
  private future: string[] = [];
  /** Vue par étage : l'étage de travail (le sol de la grille y monte, les étages au-dessus sont masqués), ou null. */
  private layer: number | null = null;
  /** Étage ou zone copiés. */
  private clipboard: Clipboard | null = null;
  /** Zone sélectionnée (Maj + clic sur deux blocs) : ses deux coins opposés ; le second manque tant qu'on ne l'a pas désigné. */
  private selection: { a: Cell; b: Cell | null } | null = null;
  private readonly selectionBox: B.Mesh;
  /** Case sous le pointeur, là où l'on poserait un bloc : on y colle une zone copiée. */
  private hover: Cell | null = null;
  /** Aperçu de la roue à poser, et repère du centre de masse (une boule vue à travers les blocs, un fil à plomb). */
  private readonly wheelGhost: B.Mesh;
  private readonly comBall: B.Mesh;
  private readonly comLine: B.Mesh;
  /** Inventaire des pièces (panneau de droite). */
  private readonly inventory: Inventory;
  /**
   * Encombrement de la pièce qu'on va poser, en transparence (vert : elle passe ; rouge : elle gêne,
   * avec ce qu'elle gênerait), et pourquoi elle ne passe pas (une ligne du panneau, sous la pièce).
   */
  private readonly clearance: ClearanceView;
  private clashText = "";
  /**
   * Sens du robot : au sol, une flèche « AVANT » devant lui, « ARRIÈRE », « GAUCHE » et « DROITE »
   * autour, et l'axe de symétrie ; à l'écran, une boussole qui suit la caméra.
   */
  private readonly marks: { front: B.Mesh; back: B.Mesh; left: B.Mesh; right: B.Mesh; axis: B.Mesh };
  /** Les panneaux des repères au sol qui portent un mot, et de quoi les redessiner (la langue a changé). */
  private readonly words: { texture: B.DynamicTexture; draw: () => void }[] = [];
  private readonly compass = byId("garageCompass");
  private compassHtml = "";
  /** Initiales de la boussole, dans la langue affichée. */
  private compassLabels = compassLabels();

  constructor(engine: B.AbstractEngine, canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const scene = new B.Scene(engine);
    scene.useRightHandedSystem = true;
    scene.clearColor = new B.Color4(0.16, 0.19, 0.22, 1);
    scene.ambientColor = new B.Color3(0.3, 0.32, 0.35);
    const hemi = new B.HemisphericLight("hemi", new B.Vector3(0.2, 1, -0.1), scene);
    hemi.intensity = 0.7;
    const sun = new B.DirectionalLight("sun", new B.Vector3(-0.45, -1, 0.32).normalize(), scene);
    sun.intensity = 0.9;
    this.scene = scene;
    this.assets = new Assets(scene);
    this.camera = new B.ArcRotateCamera("garage-cam", -Math.PI / 2 - 0.6, 1.0, 11, new B.Vector3(0, 0.5, 0), scene);
    this.camera.lowerRadiusLimit = 3;
    this.camera.upperRadiusLimit = 30;
    this.camera.wheelPrecision = 20;
    this.camera.minZ = 0.1;
    this.createFloor();
    this.ghost = new B.TransformNode("ghost", scene);
    this.ghost.rotationQuaternion = new B.Quaternion();
    const gm = new B.StandardMaterial("ghost", scene);
    gm.emissiveColor = B.Color3.FromHexString("#57d38c");
    gm.alpha = 0.4;
    gm.disableLighting = true;
    this.ghostMat = gm;
    const glow = (name: string, color: string, alpha: number): B.StandardMaterial => {
      const m = new B.StandardMaterial(name, scene);
      m.emissiveColor = B.Color3.FromHexString(color);
      m.disableLighting = true;
      m.alpha = alpha;
      return m;
    };
    this.arrowMat = glow("ghost-arrow", "#ffcf5a", 0.9);
    const hidden = (mesh: B.Mesh, material: B.StandardMaterial): B.Mesh => {
      mesh.material = material;
      mesh.isPickable = false;
      mesh.isVisible = false;
      return mesh;
    };
    this.selectionBox = hidden(B.MeshBuilder.CreateBox("selection", { size: 1 }, scene), glow("selection", "#ffcf5a", 0.22));
    // Contour net : sur un plateau sombre, le voile seul ne se voit guère
    this.selectionBox.enableEdgesRendering();
    this.selectionBox.edgesWidth = 3;
    this.selectionBox.edgesColor = new B.Color4(1, 0.81, 0.35, 1);
    this.wheelGhost = hidden(B.MeshBuilder.CreateCylinder("wheel-ghost", { height: 1, diameter: 1, tessellation: 24 }, scene), glow("wheel-ghost", "#57d38c", 0.4));
    this.comBall = hidden(B.MeshBuilder.CreateSphere("com", { diameter: 0.22, segments: 12 }, scene), glow("com", "#ff6b5a", 0.95));
    this.comLine = hidden(B.MeshBuilder.CreateCylinder("com-line", { height: 1, diameter: 0.025, tessellation: 6 }, scene), glow("com-line", "#ff6b5a", 0.8));
    // Par-dessus les blocs : on voit le centre de masse même à l'intérieur du robot
    this.comBall.renderingGroupId = 1;
    this.comLine.renderingGroupId = 1;
    this.marks = this.createMarks();
    this.clearance = new ClearanceView(scene);
    scene.onBeforeRenderObservable.add(() => this.updateCompass());
    // Une autre langue : les mots peints au sol et la boussole se refont ; le panneau et l'inventaire
    // se reconstruisent à la prochaine ouverture (ou tout de suite, garage ouvert)
    onLocaleChange(() => {
      for (const w of this.words) w.draw();
      this.compassLabels = compassLabels();
      this.compassHtml = "";
      if (this.open_) {
        this.buildPanel();
        this.inventory.refresh();
      }
    });
    this.inventory = new Inventory({
      has: (part) => this.has(part),
      price: (part) => partPrice(part),
      credits: () => (this.progress && !this.progress.sandbox ? this.progress.credits : null),
      unlock: (part) => {
        const done = this.progress?.buy(part) ?? false;
        if (done) {
          this.notify(t("garage.note.unlocked", { part: partName(part) }));
          this.onSound("unlock");
          this.buildPanel();
        } else this.onSound("error");
        return done;
      },
      pick: (part) => this.setTool(part),
      color: () => this.color,
      searchKey: () => this.keyName("garageSearch"),
    });

    engine.runRenderLoop(() => {
      if (this.open_) scene.render();
    });
    canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    // Clic du milieu : copier la pièce visée (pas le défilement automatique du navigateur)
    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 1 && this.open_) e.preventDefault();
    });
    canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
    canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
    window.addEventListener("keydown", (e) => this.onKey(e));
  }

  /** Les touches (ou leurs noms) ont changé : le panneau et l'inventaire les nomment de nouveau. */
  refreshKeys(): void {
    if (!this.open_) return;
    this.inventory.refreshSearchHint();
    // (pas pendant qu'on tape un nom : le panneau refait perdrait le champ ; il se refera au prochain geste)
    if ((document.activeElement as Element | null)?.closest?.("input")) return;
    this.buildPanel();
  }

  get active(): boolean {
    return this.open_;
  }

  /** Message bref dans le panneau (« Enregistré »…) ; `bad` : un refus (en rouge, un peu plus longtemps). */
  notify(text: string, bad = false): void {
    const note = this.panel.querySelector(".g-note");
    if (!note) return;
    note.textContent = text;
    note.classList.toggle("bad", bad);
    setTimeout(() => {
      if (note.textContent === text) note.textContent = "";
    }, bad ? 3500 : 2000);
  }

  /** Pose impossible : rien n'est posé, le bruit d'erreur, et pourquoi. */
  private refuse(reason: string): void {
    this.notify(reason, true);
    this.onSound("error");
  }

  /** Le robot en cours d'édition. */
  get robot(): SavedRobot {
    return { name: this.name, color: this.color, design: this.design() };
  }

  open(robot: SavedRobot): void {
    this.load(robot);
    this.open_ = true;
    this.panel.hidden = false;
    this.compass.hidden = false;
    this.camera.attachControl(this.canvas, true);
    this.buildPanel();
    this.rebuild();
    this.inventory.open(this.tool);
  }

  close(): void {
    this.open_ = false;
    this.panel.hidden = true;
    this.compass.hidden = true;
    this.inventory.close();
    this.camera.detachControl();
    this.showGhost(false);
    this.clearance.hide();
  }

  /** La pièce à poser (choisie dans l'inventaire, copiée au clic du milieu, ou parmi les récentes). */
  private setTool(part: Part, copied = false): void {
    this.tool = part;
    this.copied = copied;
    this.updateGhost();
    this.buildPanel();
  }

  /** Remplace le robot en cours d'édition (on peut l'annuler, garage ouvert). */
  load(robot: SavedRobot): void {
    this.name = robot.name;
    this.color = robot.color;
    const apply = (): void => this.setDesign(robot.design);
    if (!this.open_) {
      apply();
      this.history = [];
      this.future = [];
      return;
    }
    this.edit(apply);
    this.buildPanel();
  }

  private design(): RobotDesign {
    return { blocks: [...this.blocks.values()], wheels: this.wheels.map((w) => ({ ...w })) };
  }

  private setDesign(design: RobotDesign): void {
    this.blocks.clear();
    for (const b of design.blocks) this.blocks.set(cellKey(b.x, b.y, b.z), { ...b });
    this.wheels = design.wheels.map((w) => ({ ...w }));
  }

  // --- Historique ---

  /** Applique une modification du plan ; si elle change quelque chose, on pourra l'annuler. */
  private edit(change: () => void): void {
    const before = JSON.stringify(this.design());
    change();
    if (JSON.stringify(this.design()) === before) return;
    this.history.push(before);
    if (this.history.length > HISTORY) this.history.shift();
    this.future = [];
    this.rebuild();
  }

  undo(): void {
    const previous = this.history.pop();
    if (previous === undefined) return;
    this.future.push(JSON.stringify(this.design()));
    this.setDesign(JSON.parse(previous) as RobotDesign);
    this.rebuild();
  }

  redo(): void {
    const next = this.future.pop();
    if (next === undefined) return;
    this.history.push(JSON.stringify(this.design()));
    this.setDesign(JSON.parse(next) as RobotDesign);
    this.rebuild();
  }

  // --- Étages ---

  /** Vue par étage : on travaille à l'étage `y` (null : tout le robot, sol à l'étage 0). */
  private setLayer(y: number | null): void {
    this.layer = y === null ? null : Math.max(LOWEST, Math.min(HIGHEST, y));
    this.rebuild();
    this.buildPanel();
  }

  /** Copie les blocs et les roues de l'étage de travail. */
  private copyLayer(): void {
    const y = this.layer;
    if (y === null) {
      this.notify(t("garage.note.copyLayerHint", { key: this.keyName("garageLayers") }));
      return;
    }
    const blocks = [...this.blocks.values()].filter((b) => b.y === y).map((b) => ({ ...b }));
    const wheels = this.wheels.filter((w) => w.y === y).map((w) => ({ ...w }));
    this.clipboard = { kind: "layer", blocks, wheels };
    this.refreshControls();
    this.notify(t("garage.note.layerCopied", { layer: y, blocks: t("garage.count.blocks", { n: blocks.length }), wheels: t("garage.count.wheels", { n: wheels.length }) }));
  }

  /** Colle l'étage copié sur l'étage de travail, dans les cases libres (sans second cockpit). */
  private pasteLayer(): void {
    const y = this.layer;
    const clip = this.clipboard;
    if (y === null || !clip || clip.kind !== "layer") return;
    this.pastePieces(clip.blocks.map((b) => ({ ...b, y })), clip.wheels.map((w) => ({ ...w, y })));
  }

  /**
   * Colle des blocs puis des roues, l'un après l'autre, là où ils passent : pas sur une case occupée,
   * pas de second cockpit, pas de roue sans bloc ni en double (en silence, comme avant), et pas de
   * pièce qui en gênerait une autre (encombrement : on la laisse de côté, et on le dit).
   */
  private pastePieces(blocks: readonly BlockPlacement[], wheels: readonly WheelMount[]): void {
    let pasted = 0;
    const refused: Conflict[] = [];
    const fits = (piece: Piece): boolean => {
      const clash = placementConflicts(this.design(), piece);
      if (clash.length) refused.push(clash[0]);
      return !clash.length;
    };
    this.edit(() => {
      for (const b of blocks) {
        const key = cellKey(b.x, b.y, b.z);
        if (Math.abs(b.x) > REACH || Math.abs(b.z) > REACH || b.y < LOWEST || b.y > HIGHEST) continue;
        if (b.type === "cockpit" || this.blocks.has(key) || !fits({ kind: "block", block: b })) continue;
        this.blocks.set(key, { ...b });
        pasted++;
      }
      for (const w of wheels) {
        if (!this.blocks.has(cellKey(w.x, w.y, w.z)) || this.wheels.some((o) => sameMount(o, w)) || !fits({ kind: "wheel", wheel: w })) continue;
        this.wheels.push({ ...w });
        pasted++;
      }
    });
    if (refused.length) {
      const left = t("garage.count.leftOut", { n: refused.length });
      this.notify(t("garage.note.pastedSome", { pasted: t("garage.count.parts", { n: pasted }), left, reason: conflictText(refused[0].reason) }), true);
      this.onSound(pasted ? "place" : "error");
    } else if (pasted) {
      this.notify(t("garage.note.pasted", { pasted: t("garage.count.parts", { n: pasted }) }));
      this.onSound("place");
    }
  }

  // --- Zones ---

  /**
   * Maj + clic sur un bloc : un coin de la zone (le premier, puis le second ; un troisième clic en
   * recommence une). Maj + clic à côté du robot : plus de sélection.
   */
  private select(x: number, y: number): void {
    const meta = this.pick(x, y)?.pickedMesh?.metadata as { cell?: string } | null;
    const b = meta?.cell ? this.blocks.get(meta.cell) : undefined;
    const cell = b ? { x: b.x, y: b.y, z: b.z } : null;
    if (!cell) this.selection = null;
    else if (!this.selection || this.selection.b) this.selection = { a: cell, b: null };
    else this.selection = { a: this.selection.a, b: cell };
    this.showSelection();
    this.buildPanel();
  }

  /** Bornes de la zone sélectionnée, cases comprises (un seul coin : cette case-là). */
  private get zone(): { min: Cell; max: Cell } | null {
    const s = this.selection;
    if (!s) return null;
    const b = s.b ?? s.a;
    return {
      min: { x: Math.min(s.a.x, b.x), y: Math.min(s.a.y, b.y), z: Math.min(s.a.z, b.z) },
      max: { x: Math.max(s.a.x, b.x), y: Math.max(s.a.y, b.y), z: Math.max(s.a.z, b.z) },
    };
  }

  private inZone(c: Cell): boolean {
    const zone = this.zone;
    return !!zone && c.x >= zone.min.x && c.x <= zone.max.x && c.y >= zone.min.y && c.y <= zone.max.y && c.z >= zone.min.z && c.z <= zone.max.z;
  }

  private showSelection(): void {
    const zone = this.zone;
    this.selectionBox.isVisible = !!zone;
    if (!zone) return;
    const { min, max } = zone;
    const size = (a: number, b: number): number => (b - a + 1) * BLOCK_SIZE + 0.04;
    this.selectionBox.scaling.set(size(min.x, max.x), size(min.y, max.y), size(min.z, max.z));
    this.selectionBox.position.set(((min.x + max.x) / 2) * BLOCK_SIZE, ((min.y + max.y) / 2) * BLOCK_SIZE, ((min.z + max.z) / 2) * BLOCK_SIZE);
  }

  /** Copie les blocs et les roues de la zone, par rapport à son coin inférieur. */
  private copyZone(): void {
    const zone = this.zone;
    if (!zone) return;
    const rel = (c: Cell): Cell => ({ x: c.x - zone.min.x, y: c.y - zone.min.y, z: c.z - zone.min.z });
    const blocks = [...this.blocks.values()].filter((b) => this.inZone(b)).map((b) => ({ ...b, ...rel(b) }));
    const wheels = this.wheels.filter((w) => this.inZone(w)).map((w) => ({ ...w, ...rel(w) }));
    this.clipboard = { kind: "zone", blocks, wheels };
    this.refreshControls();
    this.notify(t("garage.note.zoneCopied", { blocks: t("garage.count.blocks", { n: blocks.length }), wheels: t("garage.count.wheels", { n: wheels.length }), key: this.keyName("garagePaste") }));
  }

  /** Colle la zone copiée : son coin inférieur dans la case sous le pointeur, dans les cases libres (sans second cockpit). */
  private pasteZone(): void {
    const at = this.hover;
    const clip = this.clipboard;
    if (!clip || clip.kind !== "zone") return;
    if (!at) {
      this.notify(t("garage.note.pasteZoneHint", { key: this.keyName("garagePaste") }));
      return;
    }
    const shift = <T extends Cell>(p: T): T => ({ ...p, x: at.x + p.x, y: at.y + p.y, z: at.z + p.z });
    this.pastePieces(clip.blocks.map(shift), clip.wheels.map(shift));
  }

  /** Suppr : vide la zone (ses blocs et les roues qu'ils portent). */
  private clearZone(): void {
    if (!this.zone) return;
    this.edit(() => {
      for (const [key, b] of this.blocks) if (this.inZone(b)) this.blocks.delete(key);
      this.wheels = this.wheels.filter((w) => !this.inZone(w));
    });
    this.selection = null;
    this.showSelection();
    this.buildPanel();
  }

  // --- Scène ---

  /**
   * Repères au sol : une flèche et le mot AVANT devant le robot, ARRIÈRE, GAUCHE et DROITE autour
   * (dessinés sur des panneaux posés à plat), et l'axe de symétrie (le plan x = 0), en pointillé.
   */
  private createMarks(): { front: B.Mesh; back: B.Mesh; left: B.Mesh; right: B.Mesh; axis: B.Mesh } {
    const scene = this.scene;
    const decal = (name: string, width: number, depth: number, draw: (c: CanvasRenderingContext2D, w: number, h: number) => void): B.Mesh => {
      const w = 512;
      const h = Math.round((w * depth) / width);
      const texture = new B.DynamicTexture(`t-${name}`, { width: w, height: h }, scene, true);
      texture.hasAlpha = true;
      // Redessiné tel quel quand la langue change (ses mots sont lus à chaque fois)
      const paint = (): void => {
        const c = context2d(texture);
        c.clearRect(0, 0, w, h);
        // Le sol reçoit sa texture retournée de gauche à droite (repère direct) : on dessine en miroir
        c.save();
        c.translate(w, 0);
        c.scale(-1, 1);
        draw(c, w, h);
        c.restore();
        texture.update();
      };
      paint();
      this.words.push({ texture, draw: paint });
      const mat = new B.StandardMaterial(name, scene);
      mat.diffuseTexture = texture;
      mat.emissiveTexture = texture;
      mat.useAlphaFromDiffuseTexture = true;
      mat.disableLighting = true;
      mat.specularColor = B.Color3.Black();
      const mesh = B.MeshBuilder.CreateGround(name, { width, height: depth }, scene);
      mesh.material = mat;
      mesh.isPickable = false;
      return mesh;
    };
    const word = (side: MarkSide, color: string) => (c: CanvasRenderingContext2D, w: number, h: number): void => {
      c.fillStyle = color;
      c.font = `700 ${Math.round(h * 0.62)}px "Chakra Petch", system-ui, sans-serif`;
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(t(`garage.mark.${side}`), w / 2, h / 2);
    };
    // Le sol est vu d'en haut, l'avant (+z) vers le haut de la texture : le texte se lit depuis l'arrière du robot
    const front = decal("mark-front", 2.4, 1.6, (c, w, h) => {
      c.fillStyle = "#f2c94c";
      c.beginPath();
      c.moveTo(w / 2, h * 0.04);
      c.lineTo(w * 0.8, h * 0.42);
      c.lineTo(w * 0.62, h * 0.42);
      c.lineTo(w * 0.62, h * 0.58);
      c.lineTo(w * 0.38, h * 0.58);
      c.lineTo(w * 0.38, h * 0.42);
      c.lineTo(w * 0.2, h * 0.42);
      c.closePath();
      c.fill();
      c.font = `700 ${Math.round(h * 0.28)}px "Chakra Petch", system-ui, sans-serif`;
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(t("garage.mark.front"), w / 2, h * 0.8);
    });
    const back = decal("mark-back", 2, 0.5, word("back", "rgba(220, 228, 234, 0.55)"));
    const side = (name: string, text: MarkSide): B.Mesh => {
      // Couché le long du flanc, lisible depuis le robot
      const m = decal(name, 2, 0.5, word(text, "rgba(220, 228, 234, 0.55)"));
      m.rotation.y = name === "mark-left" ? Math.PI / 2 : -Math.PI / 2;
      return m;
    };
    const left = side("mark-left", "left");
    const right = side("mark-right", "right");
    // L'axe : un tiret répété sur toute la grille
    const reach = (REACH * 2 + 1) * BLOCK_SIZE;
    const dash = new B.DynamicTexture("t-mark-axis", { width: 8, height: 32 }, scene, true);
    dash.hasAlpha = true;
    const dc = context2d(dash);
    dc.clearRect(0, 0, 8, 32);
    dc.fillStyle = "rgba(242, 201, 76, 0.45)";
    dc.fillRect(0, 0, 8, 18);
    dash.update();
    dash.vScale = reach / 0.5;
    const dashMat = new B.StandardMaterial("mark-axis", scene);
    dashMat.diffuseTexture = dash;
    dashMat.emissiveTexture = dash;
    dashMat.useAlphaFromDiffuseTexture = true;
    dashMat.disableLighting = true;
    dashMat.specularColor = B.Color3.Black();
    const axis = B.MeshBuilder.CreateGround("mark-axis", { width: 0.06, height: reach }, scene);
    axis.material = dashMat;
    axis.isPickable = false;
    return { front, back, left, right, axis };
  }

  /** Place les repères au sol autour du robot, sur le sol de la grille. */
  private placeMarks(floorY: number): void {
    const cells = [...this.blocks.values()];
    const xs = cells.map((b) => b.x);
    const zs = cells.map((b) => b.z);
    const half = BLOCK_SIZE / 2;
    const minX = (xs.length ? Math.min(...xs) : 0) * BLOCK_SIZE - half;
    const maxX = (xs.length ? Math.max(...xs) : 0) * BLOCK_SIZE + half;
    const minZ = (zs.length ? Math.min(...zs) : 0) * BLOCK_SIZE - half;
    const maxZ = (zs.length ? Math.max(...zs) : 0) * BLOCK_SIZE + half;
    // Les roues dépassent sur les flancs
    const wheelOut = Math.max(0, ...this.wheels.map((w) => Math.abs(wheelLocalPos(w).x) + wheelDef(w.type).width / 2));
    const limit = REACH * BLOCK_SIZE;
    const clamp = (v: number): number => Math.max(-limit, Math.min(limit, v));
    const y = floorY + 0.004;
    const midZ = (minZ + maxZ) / 2;
    this.marks.front.position.set(0, y, clamp(maxZ + MARK_GAP + 0.8));
    this.marks.back.position.set(0, y, clamp(minZ - MARK_GAP - 0.25));
    this.marks.left.position.set(clamp(Math.max(maxX, wheelOut) + MARK_GAP), y, midZ);
    this.marks.right.position.set(clamp(Math.min(minX, -wheelOut) - MARK_GAP), y, midZ);
    this.marks.axis.position.set(0, y - 0.001, 0);
  }

  /**
   * Boussole à l'écran : où sont l'avant, l'arrière, la gauche et la droite du robot, vus de la
   * caméra (les axes du robot projetés à l'écran), mise à jour à chaque image.
   */
  private updateCompass(): void {
    if (!this.open_) return;
    const engine = this.scene.getEngine();
    const viewport = this.camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
    const transform = this.scene.getTransformMatrix();
    const center = this.camera.target;
    const at = (dx: number, dz: number): B.Vector3 =>
      B.Vector3.Project(new B.Vector3(center.x + dx, center.y, center.z + dz), B.Matrix.IdentityReadOnly, transform, viewport);
    const o = at(0, 0);
    const dirs: [MarkSide, number, number][] = [["front", 0, 1], ["back", 0, -1], ["left", 1, 0], ["right", -1, 0]];
    let html = "";
    for (const [side, dx, dz] of dirs) {
      const p = at(dx, dz);
      const a = Math.atan2(p.y - o.y, p.x - o.x);
      const x = 32 + Math.cos(a) * 24;
      const y = 32 + Math.sin(a) * 24;
      html += `<span class="${side === "front" ? "front" : ""}" style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px">${this.compassLabels[side]}</span>`;
      if (side === "front") html += `<i style="transform:rotate(${((a * 180) / Math.PI + 90).toFixed(1)}deg)"></i>`;
    }
    if (html !== this.compassHtml) {
      this.compass.innerHTML = html;
      this.compassHtml = html;
    }
  }

  private createFloor(): void {
    const size = (REACH * 2 + 1) * BLOCK_SIZE;
    const floor = B.MeshBuilder.CreateGround("floor", { width: size, height: size }, this.scene);
    floor.position.y = -BLOCK_SIZE / 2;
    this.floor = floor;
    const t = new B.DynamicTexture("t-floor", { width: 256, height: 256 }, this.scene, true);
    const c = context2d(t);
    c.fillStyle = "#2b3238";
    c.fillRect(0, 0, 256, 256);
    c.strokeStyle = "#46515a";
    c.lineWidth = 3;
    c.strokeRect(0, 0, 256, 256);
    t.update();
    t.uScale = t.vScale = REACH * 2 + 1;
    const mat = new B.StandardMaterial("floor", this.scene);
    mat.diffuseTexture = t;
    mat.specularColor = B.Color3.Black();
    floor.material = mat;
    floor.metadata = { floor: true };
  }

  /**
   * Redessine le robot, et met à jour le coût et les défauts. En vue par étage, le sol de la grille
   * est sous l'étage de travail, les étages au-dessus sont masqués et ceux en dessous assombris.
   */
  private rebuild(): void {
    for (const m of this.meshes) if (!m.isDisposed()) m.dispose(); // (les enfants partent avec leur parent)
    this.meshes = [];
    // Hors vue par étage, le robot se tient sur le sol de la grille : ce qui pend sous ses blocs
    // (roues posées dessous, chenilles plus hautes) reste en vue, et il se tient sur ses pattes
    const bottom = Math.min(
      -BLOCK_SIZE / 2,
      ...[...this.blocks.values()].map((b) => (b.y - 0.5) * BLOCK_SIZE - (blockDef(b.type).support?.kind === "leg" ? blockDef(b.type).support!.height - BLOCK_SIZE / 2 : 0)),
      ...this.wheels.map((w) => wheelLocalPos(w).y - wheelDef(w.type).radius),
    );
    this.floor.position.y = this.layer === null ? bottom : (this.layer - 0.5) * BLOCK_SIZE;
    // Au-dessus du sol, la grille laisse voir les étages inférieurs
    (this.floor.material as B.StandardMaterial).alpha = this.layer !== null && this.layer > 0 ? FLOOR_SEE_THROUGH : 1;
    // Seules les sources de blocs ont une couleur par instance : les roues d'en dessous restent claires
    const layerOf = (mesh: B.AbstractMesh, y: number, shade: boolean): void => {
      if (this.layer === null) return;
      if (y > this.layer) mesh.setEnabled(false);
      else if (y < this.layer && shade && mesh.instancedBuffers) mesh.instancedBuffers.color = new B.Color4(BELOW_SHADE, BELOW_SHADE, BELOW_SHADE, 1);
    };
    const com = designCenterOfMass(this.design());
    // Ailes et gouvernes voisines : une seule aile, comme en jeu (chaque case selon ce qui la touche)
    const surfaces = designSurfaceSides([...this.blocks.values()]);
    for (const b of this.blocks.values()) {
      const q = facingQuat(b.facing ?? DEFAULT_FACING);
      const sides = surfaces.get(cellKey(b.x, b.y, b.z));
      const source = sides === undefined ? this.assets.blockSource(b.type, this.color) : this.assets.surfaceSource(b.type, this.color, sides);
      const mesh = source.createInstance("block");
      mesh.position.set(b.x * BLOCK_SIZE, b.y * BLOCK_SIZE, b.z * BLOCK_SIZE);
      mesh.rotationQuaternion = new B.Quaternion(q.x, q.y, q.z, q.w);
      mesh.metadata = { cell: cellKey(b.x, b.y, b.z) };
      layerOf(mesh, b.y, true);
      this.meshes.push(mesh);
      // Un bloc à modèle 3D (une tuyère, un moteur…) se vise par sa case : une boîte invisible
      // (sinon on viserait entre ses pièces, et la face visée suivrait leurs courbes)
      if (this.assets.hasModel(b.type)) {
        mesh.isPickable = false;
        const box = this.assets.pickBoxSource().createInstance("pick");
        box.position.copyFrom(mesh.position);
        box.isVisible = false;
        box.metadata = mesh.metadata;
        layerOf(box, b.y, false);
        this.meshes.push(box);
      }
      // Ce que le jeu dessine en plus du bloc (tête de tourelle et munitions, pales, nacelle, patte,
      // lueur d'un patin), immobile ; ce qui ne le suit pas (une patte) suit son étage
      for (const part of stillBlockParts(this.assets, b, mesh, com)) {
        if (part.parent !== mesh) layerOf(part, b.y, false);
        this.meshes.push(part);
      }
    }
    this.wheels.forEach((w, i) => {
      const p = wheelLocalPos(w);
      const mesh = this.assets.wheelSource(w.type).createInstance("wheel");
      mesh.position.set(p.x, p.y, p.z);
      mesh.metadata = { wheel: i };
      layerOf(mesh, w.y, false);
      this.meshes.push(mesh);
      // Ferrures : fourche d'une roulette ou d'une roue posée dessous, potence, bras de direction
      for (const fitting of stillWheelParts(this.assets, w)) {
        layerOf(fitting, w.y, false);
        this.meshes.push(fitting);
      }
    });
    this.showBelts();
    // Centre de masse : la boule, et un fil à plomb jusqu'au sol de la grille
    const floorY = this.floor.position.y;
    this.placeMarks(floorY);
    const shown = this.blocks.size > 0;
    this.comBall.isVisible = shown;
    this.comLine.isVisible = shown && com.y > floorY;
    this.comBall.position.set(com.x, com.y, com.z);
    this.comLine.position.set(com.x, (com.y + floorY) / 2, com.z);
    this.comLine.scaling.y = Math.max(0.01, com.y - floorY);
    this.showSelection();
    this.showStats();
    this.refreshControls();
    // Le plan a changé : la pièce visée passe peut-être plus (ou de nouveau)
    if (this.open_) this.updateGhost();
  }

  // --- Souris et clavier ---

  private onPointerDown(e: PointerEvent): void {
    if (!this.open_) return;
    this.down = { x: e.clientX, y: e.clientY, button: e.button };
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.open_) return;
    this.pointer = { x: e.offsetX, y: e.offsetY };
    this.updateGhost();
  }

  // --- Aperçu de la pièce à poser ---

  /**
   * L'aperçu sous le pointeur : case visée, orientation de la pose (selon la face visée), et si la
   * pièce passe (vert) ou non (rouge : case occupée, ou elle gênerait une autre pièce, ou une autre
   * la gênerait), avec son encombrement en transparence et ce qu'elle gênerait en rouge. Une roue :
   * où elle irait, sur la face visée, avec son décalage.
   */
  private updateGhost(): void {
    const at = this.pointer;
    const target = at ? this.target(at.x, at.y) : null;
    this.hover = target;
    if (target) this.hoverFace = target.face;
    const wheel = this.tool.kind === "wheel" && at ? this.wheelAt(at.x, at.y) : null;
    this.wheelGhost.isVisible = !!wheel;
    const shown = !!target && this.tool.kind === "block";
    this.showGhost(shown);
    if (wheel) {
      const def = wheelDef(wheel.type);
      const p = wheelLocalPos(wheel);
      this.wheelGhost.position.set(p.x, p.y, p.z);
      // Le cylindre est dressé selon y : on couche son axe selon celui de l'essieu (toujours x)
      this.wheelGhost.scaling.set(def.radius * 2, def.width, def.radius * 2);
      this.wheelGhost.rotation.set(0, 0, Math.PI / 2);
      const check = this.wheelCheck(wheel);
      (this.wheelGhost.material as B.StandardMaterial).emissiveColor = B.Color3.FromHexString(check.clash.length ? CLASH_COLOR : FREE_COLOR);
      this.showClearance(JSON.stringify(wheel), check);
      return;
    }
    if (!shown || this.tool.kind !== "block") {
      this.showClearance("", null);
      return;
    }
    this.buildGhost(this.tool.type);
    this.ghost.position.set(target.x * BLOCK_SIZE, target.y * BLOCK_SIZE, target.z * BLOCK_SIZE);
    const facing = this.placing();
    const q = facingQuat(facing);
    this.ghost.rotationQuaternion!.set(q.x, q.y, q.z, q.w);
    const check = this.blockCheck(target, this.tool.type, facing);
    this.ghostMat.emissiveColor = B.Color3.FromHexString(check.clash.length ? CLASH_COLOR : FREE_COLOR);
    this.showClearance(JSON.stringify(check.piece), check);
  }

  /**
   * Montre l'encombrement de la pièce qu'on poserait (et de sa symétrique), et ce qu'elles
   * gêneraient ; et pourquoi la pose est impossible, dans le panneau. `key` : la pose montrée.
   */
  private showClearance(key: string, check: PlacementCheck | null): void {
    if (!check) {
      this.clearance.hide();
      this.setClashText("");
      return;
    }
    const zones: ZoneShow[] = [];
    const add = (piece: Piece, design: RobotDesign, clash: Conflict[]): void => {
      zones.push(...pieceZones(design, piece).map((z) => ({ solids: z.solids, clash: clash.length > 0 })));
      for (const c of clash) zones.push({ solids: c.solids, clash: true });
    };
    add(check.piece, check.design, check.clash);
    // Le symétrique : seulement s'il gênerait (sinon, l'image de la pièce dans le miroir), sa case comprise
    if (check.twin && check.twinClash.length) {
      add(check.twin, check.twinDesign, check.twinClash);
      if (check.twin.kind === "block") zones.push({ solids: [blockBody(check.twin.block)], clash: true });
    }
    this.clearance.show(`${key}|${check.clash.length}|${check.twinClash.length}|${this.history.length}/${this.future.length}`, zones);
    const first = check.clash[0];
    const text = first ? conflictText(first.reason) : check.twinClash.length ? t("garage.clash.twin", { reason: conflictText(check.twinClash[0].reason) }) : "";
    this.setClashText(text);
  }

  /** La ligne du panneau qui dit pourquoi la pièce visée ne passe pas (vide : elle passe). */
  private setClashText(text: string): void {
    if (text === this.clashText) return;
    this.clashText = text;
    const line = this.panel.querySelector(".g-clash");
    if (line) line.textContent = text;
  }

  /**
   * Poser ce bloc (et son symétrique, en mode symétrie) : ce qu'ils gêneraient. Le symétrique n'est
   * vérifié que si le bloc passe (il est posé après lui) ; une case symétrique déjà occupée n'est pas
   * un conflit (on ne l'y pose pas, en silence, comme avant).
   */
  private blockCheck(cell: Cell, type: BlockType, facing: Facing): PlacementCheck {
    const before = this.design();
    // Un seul cockpit : poser le nouveau retire l'ancien
    const design = type === "cockpit" ? { ...before, blocks: before.blocks.filter((b) => b.type !== "cockpit") } : before;
    const block = placementOf(cell.x, cell.y, cell.z, type, facing);
    const piece: Piece = { kind: "block", block };
    const clash = placementConflicts(design, piece);
    const check: PlacementCheck = { piece, design, clash, twin: null, twinDesign: design, twinClash: [] };
    if (!this.mirror || cell.x === 0 || type === "cockpit" || this.blocks.has(cellKey(-cell.x, cell.y, cell.z))) return check;
    check.twin = { kind: "block", block: placementOf(-cell.x, cell.y, cell.z, type, mirrorFacing(type, facing)) };
    check.twinDesign = { ...design, blocks: [...design.blocks, block] };
    if (!clash.length) check.twinClash = placementConflicts(check.twinDesign, check.twin);
    return check;
  }

  /** Poser cette roue (et sa symétrique) : ce qu'elles gêneraient. */
  private wheelCheck(w: WheelMount): PlacementCheck {
    const design = this.design();
    const piece: Piece = { kind: "wheel", wheel: w };
    const clash = this.wheels.some((o) => sameMount(o, w)) ? [] : placementConflicts(design, piece);
    const check: PlacementCheck = { piece, design, clash, twin: null, twinDesign: design, twinClash: [] };
    const twin = mirrorWheel(w);
    if (!this.mirror || sameMount(twin, w) || !this.blocks.has(cellKey(twin.x, twin.y, twin.z)) || this.wheels.some((o) => sameMount(o, twin))) return check;
    check.twin = { kind: "wheel", wheel: twin };
    check.twinDesign = { ...design, wheels: [...design.wheels, w] };
    if (!clash.length) check.twinClash = placementConflicts(check.twinDesign, check.twin);
    return check;
  }

  private showGhost(on: boolean): void {
    for (const m of this.ghostParts) m.isVisible = on;
  }

  /**
   * Construit l'aperçu d'un type de bloc (une fois par type choisi ; de nouveau quand un modèle glTF
   * est arrivé entre-temps : l'aperçu copie la géométrie de ses sources).
   */
  private buildGhost(type: BlockType): void {
    if (this.ghostType === type && this.ghostModels === this.assets.modelGeneration) return;
    for (const m of this.ghostParts) m.dispose();
    this.ghostParts = [];
    this.ghostType = type;
    this.ghostModels = this.assets.modelGeneration;
    const part = (source: B.Mesh, name: string, material: B.Material = this.ghostMat): B.Mesh => {
      const m = new B.Mesh(name, this.scene);
      source.geometry?.copy(`${name}-geo`).applyToMesh(m);
      m.material = material;
      m.isPickable = false;
      m.parent = this.ghost;
      this.ghostParts.push(m);
      return m;
    };
    const body = part(this.assets.blockSource(type, this.color), "ghost-body");
    body.scaling.setAll(1.03);
    const def = blockDef(type);
    if (def.turret) part(this.assets.turretHeadSource(type as TurretBlockType), "ghost-head").position.y = headLift(def.turret);
    // Une arme de contact : sa barre, son bras, sa lance, son plateau, ses mâchoires, la boule d'un
    // fléau, à son moyeu, au repos comme hors du jeu (`stillMelee`) ; son encombrement se montre aussi
    // en transparence
    if (def.melee) stillMelee(this.assets, def.melee, (source, name) => part(source, name));
    // Un moteur pousse vers le haut de son bloc, un lance-leurres y éjecte ses leurres : une flèche le montre
    if (def.thruster || def.flares || def.light?.kind === "spot") {
      const arrow = B.MeshBuilder.CreateCylinder("ghost-arrow", { height: 0.32, diameterTop: 0, diameterBottom: 0.2, tessellation: 12 }, this.scene);
      arrow.material = this.arrowMat;
      arrow.isPickable = false;
      arrow.parent = this.ghost;
      arrow.position.y = BLOCK_SIZE / 2 + 0.22;
      this.ghostParts.push(arrow);
    }
  }

  /**
   * Orientation du bloc qu'on poserait : selon la face visée pour un bloc qui s'oriente de lui-même
   * (orientation auto), pivoté de `spin` quarts de tour autour de son haut ; sinon, celle qu'on a
   * choisie (R, Maj + R).
   */
  private placing(): Facing {
    if (this.tool.kind === "block" && this.autoApplies) {
      const up = this.hoverFace;
      return { up, forward: spinAxis(faceForward(up, this.tool.type), up, this.spin) };
    }
    return this.facing;
  }

  /** L'orientation auto vaut-elle pour le bloc choisi ? */
  private get autoApplies(): boolean {
    return this.tool.kind === "block" && this.autoOrient && !this.copied && orientsToFace(this.tool.type);
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.open_ || !this.down) return;
    const moved = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y);
    const button = this.down.button;
    this.down = null;
    if (moved > CLICK_SLOP) return; // la caméra a tourné
    // Un bouton (avec ses touches de modification : Maj + clic, une zone) porte une action du garage
    const action = this.actionFor([chordCode(`Mouse${button}`, e)]);
    if (action) this.run(action, { x: e.offsetX, y: e.offsetY });
  }

  /** L'action du garage que portent ces codes (le premier qui en porte une), ou null. */
  private actionFor(codes: readonly string[]): ActionId | null {
    for (const code of codes) {
      const found = actionsFor(this.bindings, code, false, (c) => c === "garage");
      if (found.length) return found[0];
    }
    return null;
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.open_ || (e.target as Element | null)?.closest?.("input")) return;
    // Au clavier, une action de la souris (poser, enlever…) vaut sous le pointeur
    const action = this.actionFor(eventChords(e));
    if (action && this.run(action, this.pointer)) e.preventDefault();
  }

  /**
   * Fait une action du garage (`at` : le pointeur, pour poser, enlever, copier la pièce visée ou
   * délimiter une zone). Faux si elle ne s'appliquait pas (rien à vider, pas de pièce récente).
   */
  private run(action: ActionId, at: { x: number; y: number } | null): boolean {
    const recent = (RECENT_SLOTS as readonly ActionId[]).indexOf(action);
    if (recent >= 0) {
      const part = this.inventory.recentPart(recent);
      if (!part) return false;
      this.setTool(part);
      this.inventory.select(part);
      return true;
    }
    switch (action) {
      case "garagePlace":
      case "garageRemove":
      case "garageEyedrop":
      case "garageSelect":
        if (!at) return false;
        if (action === "garagePlace") this.place(at.x, at.y);
        else if (action === "garageRemove") this.remove(at.x, at.y);
        else if (action === "garageEyedrop") this.eyedrop(at.x, at.y);
        else this.select(at.x, at.y);
        return true;
      case "garageUndo":
        this.undo();
        return true;
      case "garageRedo":
        this.redo();
        return true;
      case "garageCopy":
        if (this.selection) this.copyZone();
        else this.copyLayer();
        return true;
      case "garagePaste":
        if (this.clipboard?.kind === "zone") this.pasteZone();
        else this.pasteLayer();
        return true;
      case "garageClear":
        if (!this.selection) return false;
        this.clearZone();
        return true;
      case "garageLayerUp":
      case "garageLayerDown":
        this.setLayer((this.layer ?? 0) + (action === "garageLayerUp" ? 1 : -1));
        return true;
      case "garageLayers":
        this.setLayer(this.layer === null ? 0 : null);
        return true;
      case "garageSearch":
        this.inventory.focusSearch();
        return true;
      // Pivoter autour du haut ; basculer (le haut passe à l'axe suivant) ; orientation selon la face ; symétrie
      case "garageSpin":
        this.turnForward();
        break;
      case "garageTilt":
        this.turnUp();
        break;
      case "garageAutoOrient":
        this.autoOrient = !this.autoOrient;
        this.copied = false;
        this.spin = 0;
        this.onSound("rotate");
        break;
      case "garageMirror":
        this.setMirror(!this.mirror);
        break;
      default:
        return false;
    }
    this.updateGhost();
    this.buildPanel();
    return true;
  }

  /**
   * Case visée : à côté de la face du bloc sous le pointeur, ou sur le sol de la grille ; et cette
   * face (l'axe dominant de sa normale : sur une pente à 45°, le dessus).
   */
  private target(x: number, y: number): (Cell & { face: Axis }) | null {
    const pick = this.pick(x, y);
    if (!pick?.hit || !pick.pickedMesh) return null;
    const meta = pick.pickedMesh.metadata as { cell?: string; floor?: boolean } | null;
    if (meta?.cell) {
      const b = this.blocks.get(meta.cell)!;
      const n = pick.getNormal(true);
      if (!n) return null;
      const face = axisOf(n);
      const d = AXES[face];
      return { x: b.x + d.x, y: b.y + d.y, z: b.z + d.z, face };
    }
    if (meta?.floor && pick.pickedPoint) {
      const p = pick.pickedPoint;
      const cx = Math.round(p.x / BLOCK_SIZE);
      const cz = Math.round(p.z / BLOCK_SIZE);
      if (Math.abs(cx) > REACH || Math.abs(cz) > REACH) return null;
      return { x: cx, y: this.layer ?? 0, z: cz, face: "+y" };
    }
    return null;
  }

  /** Mesh sous le pointeur, parmi ceux qu'on voit (pas l'aperçu, pas les étages masqués). */
  private pick(x: number, y: number): B.PickingInfo | null {
    return this.scene.pick(x, y, (m) => m.isPickable && m.isEnabled());
  }

  /** Le joueur a-t-il cette pièce ? */
  private has(part: Part): boolean {
    return this.progress?.has(part) ?? true;
  }

  private place(x: number, y: number): void {
    if (!this.has(this.tool)) {
      this.notify(t("garage.note.locked", { part: partName(this.tool), n: partPrice(this.tool) }));
      this.onSound("error");
      return;
    }
    if (this.tool.kind === "wheel") {
      this.mountWheel(x, y);
      return;
    }
    const cell = this.target(x, y);
    if (!cell || Math.abs(cell.x) > REACH || Math.abs(cell.z) > REACH || cell.y < LOWEST || cell.y > HIGHEST) return;
    const type = this.tool.type;
    this.hoverFace = cell.face;
    // Case occupée, ou une pièce qui en gênerait une autre (le canon d'une tourelle, une roue…) : rien
    const check = this.blockCheck(cell, type, this.placing());
    if (check.clash.length) {
      this.refuse(conflictText(check.clash[0].reason));
      return;
    }
    const put = (piece: Piece | null): void => {
      if (piece?.kind !== "block") return;
      // Un seul cockpit : poser le nouveau retire l'ancien
      if (type === "cockpit") for (const [k, b] of this.blocks) if (b.type === "cockpit") this.blocks.delete(k);
      this.blocks.set(cellKey(piece.block.x, piece.block.y, piece.block.z), piece.block);
    };
    this.edit(() => {
      put(check.piece);
      // Le symétrique : son image dans le miroir (une tourelle sur le flanc gauche sort à droite), s'il passe
      if (!check.twinClash.length) put(check.twin);
    });
    if (check.twinClash.length) this.notify(t("garage.note.twinRefused", { reason: conflictText(check.twinClash[0].reason) }), true);
    this.onSound("place");
  }

  /**
   * Roue à poser sous le pointeur : sur la face (gauche, droite, avant, arrière ou dessous) du bloc
   * visé, décalée d'une demi-case vers le bord de la face qu'on vise (au milieu : centrée). Un galet
   * de chenille se pose aussi sur un autre galet (voir `stackOn`).
   */
  private wheelAt(x: number, y: number): WheelMount | null {
    const pick = this.pick(x, y);
    const meta = pick?.pickedMesh?.metadata as { cell?: string; wheel?: number } | null;
    const n = pick?.getNormal(true);
    if (!meta || !n || !pick?.pickedPoint) return null;
    const type = this.tool.type as WheelType;
    if (meta.wheel !== undefined) return this.stackOn(this.wheels[meta.wheel], type, n);
    if (!meta.cell || n.y > 0.5) return null;
    const b = this.blocks.get(meta.cell)!;
    // Dessous : la roue pend sous le bloc, décalée vers l'avant ou l'arrière
    if (n.y < -0.5) {
      const shift = shiftFrom(pick.pickedPoint.z - b.z * BLOCK_SIZE);
      return { x: b.x, y: b.y, z: b.z, dx: 0, dz: 0, dy: -1, type, ...(shift ? { shift } : {}) };
    }
    const dx = Math.round(n.x);
    const dz = Math.round(n.z);
    const shift = shiftFrom(dx !== 0 ? pick.pickedPoint.z - b.z * BLOCK_SIZE : pick.pickedPoint.x - b.x * BLOCK_SIZE);
    return { x: b.x, y: b.y, z: b.z, dx, dz, type, ...(shift ? { shift } : {}) };
  }

  /**
   * Galet de chenille posé sur un galet d'un flanc gauche ou droit : sur son dessus ou son dessous,
   * la chenille monte ou descend d'une case (`rise`) ; sur sa face extérieure, elle s'élargit d'un
   * galet (`layer`). Il reste monté sur le même bloc.
   */
  private stackOn(base: WheelMount, type: WheelType, n: B.Vector3): WheelMount | null {
    if (type !== base.type || !wheelDef(type).track || base.dx === 0) return null;
    const { rise: r, layer: l, ...mount } = base;
    let rise = r ?? 0;
    let layer = l ?? 0;
    if (n.y > 0.6) rise++;
    else if (n.y < -0.6) rise--;
    else if (Math.abs(n.x) > 0.6 && Math.sign(n.x) === base.dx) layer++;
    else return null;
    if (Math.abs(rise) > TRACK_RISE || layer > TRACK_LAYERS) return null;
    return { ...mount, ...(rise ? { rise } : {}), ...(layer ? { layer } : {}) };
  }

  /**
   * Chenilles : autour de chaque groupe de galets voisins, une bande et ses patins, immobiles, et un
   * barbotin sur le galet arrière, comme en jeu (render/belts.ts).
   */
  private showBelts(): void {
    for (const belt of stillBelts("garage-belt", this.scene, this.assets, this.wheels)) {
      // Au-dessus de l'étage de travail, masquée comme les blocs
      const above = this.layer !== null && belt.rollers.some((w) => w.y > this.layer!);
      for (const m of [belt.band, ...belt.sprockets]) {
        if (above) m.setEnabled(false);
        this.meshes.push(m);
      }
    }
  }

  /** Pose la roue visée (et sa symétrique), si elle ne gêne rien. */
  private mountWheel(x: number, y: number): void {
    const w = this.wheelAt(x, y);
    if (!w) return;
    const check = this.wheelCheck(w);
    if (check.clash.length) {
      this.refuse(conflictText(check.clash[0].reason));
      return;
    }
    const add = (piece: Piece | null): void => {
      if (piece?.kind === "wheel" && !this.wheels.some((o) => sameMount(o, piece.wheel))) this.wheels.push(piece.wheel);
    };
    this.edit(() => {
      add(check.piece);
      if (!check.twinClash.length) add(check.twin);
    });
    if (check.twinClash.length) this.notify(t("garage.note.twinRefused", { reason: conflictText(check.twinClash[0].reason) }), true);
    this.onSound("wheel");
  }

  /**
   * Clic du milieu : copie la pièce visée. Elle devient celle qu'on pose, avec l'orientation exacte
   * du bloc copié (une tourelle couchée, un biseau retourné) : chaque clic gauche en pose le double.
   * Une roue copiée se pose, elle, sur la face visée.
   */
  private eyedrop(x: number, y: number): void {
    const meta = this.pick(x, y)?.pickedMesh?.metadata as { cell?: string; wheel?: number } | null;
    const block = meta?.cell ? this.blocks.get(meta.cell) : undefined;
    const wheel = meta?.wheel !== undefined ? this.wheels[meta.wheel] : undefined;
    const part: Part | null = block ? { kind: "block", type: block.type } : wheel ? { kind: "wheel", type: wheel.type } : null;
    if (!part) return;
    if (block) this.facing = { ...(block.facing ?? DEFAULT_FACING) };
    this.setTool(part, !!block);
    this.inventory.select(part);
    this.notify(t("garage.note.copied", { part: partName(part), key: this.keyName("garagePlace") }));
    this.onSound("rotate");
  }

  /** Clic droit : enlève le bloc visé (et ses roues) ou la roue visée, et son symétrique. */
  private remove(x: number, y: number): void {
    const pick = this.pick(x, y);
    const meta = pick?.pickedMesh?.metadata as { cell?: string; wheel?: number } | null;
    if (meta?.wheel !== undefined) {
      const w = this.wheels[meta.wheel];
      const twin = mirrorWheel(w);
      this.edit(() => {
        this.wheels = this.wheels.filter((o) => o !== w && !(this.mirror && sameMount(o, twin)));
      });
      this.onSound("remove");
    } else if (meta?.cell) {
      const b = this.blocks.get(meta.cell)!;
      const doomed = [meta.cell];
      if (this.mirror && b.x !== 0) doomed.push(cellKey(-b.x, b.y, b.z));
      this.edit(() => {
        for (const key of doomed) {
          this.blocks.delete(key);
          this.wheels = this.wheels.filter((w) => cellKey(w.x, w.y, w.z) !== key);
        }
      });
      this.onSound("remove");
    }
  }

  // --- Orientation, symétrie ---

  /**
   * Maj + R : bascule le bloc à poser, son haut passe à l'axe suivant (l'avant reste perpendiculaire
   * au haut). L'orientation devient manuelle : on part de celle que montrait l'aperçu.
   */
  private turnUp(): void {
    if (this.autoApplies) {
      this.facing = this.placing();
      this.autoOrient = false;
      this.notify(t("garage.note.manualOrientation", { key: this.keyName("garageAutoOrient") }));
    }
    const up = AXIS_LIST[(AXIS_LIST.indexOf(this.facing.up) + 1) % AXIS_LIST.length];
    const keep = this.facing.forward !== up && this.facing.forward !== opposite(up);
    const forward = keep ? this.facing.forward : AXIS_LIST.find((a) => a !== up && a !== opposite(up))!;
    this.facing = { up, forward };
    this.onSound("rotate");
  }

  /** R : fait pivoter le bloc à poser d'un quart de tour autour de son haut. */
  private turnForward(): void {
    if (this.autoApplies) {
      this.spin = (this.spin + 1) % 4;
    } else {
      this.facing = { ...this.facing, forward: spinAxis(this.facing.forward, this.facing.up, 1) };
    }
    this.onSound("rotate");
  }

  private setMirror(on: boolean): void {
    this.mirror = on;
  }

  // --- Panneau ---

  private buildPanel(): void {
    const p = this.panel;
    p.textContent = "";

    const head = el("div", "g-head");
    const name = document.createElement("input");
    name.className = "g-name";
    name.value = this.name;
    name.maxLength = 24;
    name.setAttribute("aria-label", t("garage.panel.nameLabel"));
    name.addEventListener("input", () => (this.name = name.value.trim() || t("garage.unnamed")));
    const color = document.createElement("input");
    color.type = "color";
    color.value = this.color;
    color.setAttribute("aria-label", t("garage.panel.colorLabel"));
    color.addEventListener("input", () => {
      this.color = color.value;
      this.rebuild();
    });
    // Les vignettes des blocs peints à la couleur du robot se refont quand on a fini de la choisir
    color.addEventListener("change", () => this.inventory.refresh());
    head.append(name, color);
    p.append(head);
    if (this.progress) {
      const pr = this.progress;
      p.append(el("div", "g-credits", pr.sandbox ? t("garage.panel.sandbox") : t("garage.panel.credits", { n: pr.credits })));
    }

    // La pièce choisie (dans l'inventaire, à droite)
    const tool = el("div", "g-current");
    tool.append(el("span", "g-hint", t("garage.panel.part")), el("strong", "", partName(this.tool)));
    if (!this.has(this.tool)) tool.append(el("span", "g-bad", t("garage.panel.price", { n: partPrice(this.tool) })));
    // Pourquoi la pièce visée ne passe pas (son aperçu est rouge)
    p.append(tool, el("div", "g-clash", this.clashText));

    // Options de pose
    const opts = el("div", "g-options");
    const k = this.keyName;
    opts.append(this.toggle(t("garage.panel.mirror", { key: k("garageMirror") }), this.mirror, (on) => this.setMirror(on)));
    opts.append(this.toggle(t("garage.panel.faceOrient", { key: k("garageAutoOrient") }), this.autoOrient, (on) => {
      this.autoOrient = on;
      this.copied = false;
      this.spin = 0;
      this.buildPanel();
    }));
    opts.append(el("div", "g-facing", this.facingText()));
    const turn = el("div", "g-edit");
    turn.append(
      this.small(t("garage.panel.spin"), k("garageSpin"), "spin", () => {
        this.turnForward();
        this.updateGhost();
        this.buildPanel();
      }),
      this.small(t("garage.panel.tilt"), k("garageTilt"), "tilt", () => {
        this.turnUp();
        this.updateGhost();
        this.buildPanel();
      }),
    );
    opts.append(turn);
    p.append(opts);

    // Historique et étages
    const edit = el("div", "g-edit");
    edit.append(
      this.small(t("garage.panel.undo"), k("garageUndo"), "undo", () => this.undo()),
      this.small(t("garage.panel.redo"), k("garageRedo"), "redo", () => this.redo()),
    );
    p.append(edit);
    const layers = el("div", "g-layers");
    layers.append(this.toggle(t("garage.panel.layerView", { key: k("garageLayers") }), this.layer !== null, (on) => this.setLayer(on ? 0 : null)));
    if (this.layer !== null) {
      const row = el("div", "g-edit");
      row.append(
        this.small("▼", k("garageLayerDown"), "down", () => this.setLayer(this.layer! - 1)),
        el("span", "g-layer", t("garage.panel.layer", { n: this.layer })),
        this.small("▲", k("garageLayerUp"), "up", () => this.setLayer(this.layer! + 1)),
      );
      const clip = el("div", "g-edit");
      clip.append(
        this.small(t("garage.panel.copyLayer"), k("garageCopy"), "copy", () => this.copyLayer()),
        this.small(t("garage.panel.paste"), k("garagePaste"), "paste", () => this.pasteLayer()),
      );
      layers.append(row, clip);
    }
    p.append(layers);

    // Zone : Maj + clic sur deux blocs
    const zone = this.zone;
    const zoneRow = el("div", "g-zone");
    if (zone) {
      const { min, max } = zone;
      const count = [...this.blocks.values()].filter((b) => this.inZone(b)).length;
      const size = `${max.x - min.x + 1}×${max.y - min.y + 1}×${max.z - min.z + 1}`;
      zoneRow.append(el("span", "g-layer", t("garage.panel.zone", { size, blocks: t("garage.count.blocks", { n: count }) })));
      const row = el("div", "g-edit");
      row.append(
        this.small(t("garage.panel.copyZone"), k("garageCopy"), "zone-copy", () => this.copyZone()),
        this.small(t("garage.panel.clearZone"), k("garageClear"), "zone-clear", () => this.clearZone()),
        this.small(t("garage.panel.deselect"), t("garage.panel.deselectHint", { key: k("garageSelect") }), "zone-none", () => {
          this.selection = null;
          this.showSelection();
          this.buildPanel();
        }),
      );
      zoneRow.append(row);
    } else {
      zoneRow.append(el("span", "g-hint", t("garage.panel.zoneHint", { key: k("garageSelect") })));
    }
    p.append(zoneRow);

    p.append(el("div", "g-stats"));
    p.append(el("div", "g-note"));
    const help = el("details", "g-help");
    help.append(el("summary", "", t("garage.help.title")), el("p", "", t("garage.help.text", {
      search: k("garageSearch"), recent: t("garage.help.range", { from: k("garageRecent1"), to: k("garageRecent9") }), eyedrop: k("garageEyedrop"),
      place: k("garagePlace"), spin: k("garageSpin"), tilt: k("garageTilt"), orient: k("garageAutoOrient"), remove: k("garageRemove"),
      select: k("garageSelect"), copy: k("garageCopy"), paste: k("garagePaste"), clear: k("garageClear"), undo: k("garageUndo"), redo: k("garageRedo"),
      mirror: k("garageMirror"), layers: k("garageLayers"), up: k("garageLayerUp"), down: k("garageLayerDown"),
    })));
    p.append(help);

    const actions = el("div", "g-actions");
    actions.append(
      this.action(t("garage.action.test"), true, () => this.onTest?.(profileFromDesign(this.name, this.color, this.design()), this.robot)),
      this.action(t("garage.action.save"), false, () => this.onSave?.(this.robot)),
      this.action(t("garage.action.browse"), false, () => this.onBrowse?.(this.robot)),
      this.action(t("garage.action.new"), false, () => this.load(starterRobot())), // annulable
      this.action(t("common.back"), false, () => this.onExit?.()),
    );
    p.append(actions);
    this.showStats();
    this.refreshControls();
  }

  /** L'orientation du bloc à poser, en mots : selon la face visée, ou vers où pointent son haut et son avant. */
  private facingText(): string {
    if (this.tool.kind === "wheel") return t("garage.facing.wheel");
    const f = this.placing();
    const words = t("garage.facing.words", { up: axisWord(f.up), forward: axisWord(f.forward) });
    const type = this.tool.type;
    const thrust = blockDef(type).thruster ? t("garage.facing.thrust") : "";
    // Selon la face : elle change avec le pointeur, l'aperçu la montre
    const k = this.keyName;
    const spin = k("garageSpin");
    if (this.autoApplies) return this.spin ? t("garage.facing.autoSpin", { deg: this.spin * 90, spin }) : t("garage.facing.auto", { spin });
    if (this.copied) return t("garage.facing.copied", { words, thrust, spin, tilt: k("garageTilt"), orient: k("garageAutoOrient") });
    return t("garage.facing.manual", { words, thrust, spin, tilt: k("garageTilt") });
  }

  /** Petit bouton de commande, avec son raccourci en info-bulle ; `role` sert à le retrouver pour l'activer ou non. */
  private small(label: string, shortcut: string, role: string, run: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "g-small";
    b.textContent = label;
    b.title = shortcut;
    b.dataset.role = role;
    b.addEventListener("click", run);
    return b;
  }

  /** Boutons actifs ou non : annuler, rétablir, coller, étages extrêmes. */
  private refreshControls(): void {
    const set = (role: string, enabled: boolean): void => {
      const b = this.panel.querySelector<HTMLButtonElement>(`[data-role="${role}"]`);
      if (b) b.disabled = !enabled;
    };
    set("undo", this.history.length > 0);
    set("redo", this.future.length > 0);
    set("paste", this.clipboard !== null);
    set("down", this.layer !== null && this.layer > LOWEST);
    set("up", this.layer !== null && this.layer < HIGHEST);
  }

  private toggle(label: string, on: boolean, set: (on: boolean) => void): HTMLLabelElement {
    const l = document.createElement("label");
    l.className = "g-toggle";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = on;
    box.addEventListener("change", () => set(box.checked));
    l.append(box, label);
    return l;
  }

  private action(label: string, primary: boolean, run: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = primary ? "g-action primary" : "g-action";
    b.textContent = label;
    b.addEventListener("click", run);
    return b;
  }

  /** Coût (et budget), masse, mobilité déduite, et les défauts qui empêchent de jouer le robot. */
  private showStats(): void {
    const stats = this.panel.querySelector(".g-stats");
    if (!stats) return;
    const design = this.design();
    const cost = designCost(design);
    const mass = designMass(design);
    const mobility = inferMobility(design);
    const problems = validateDesign(design);
    stats.textContent = "";
    const bar = el("div", "g-budget");
    const fill = el("i", cost > ROBOT_BUDGET ? "over" : "");
    fill.style.width = `${Math.min(100, (100 * cost) / ROBOT_BUDGET)}%`;
    bar.append(fill);
    stats.append(
      el("div", "g-line", t("garage.stats.cost", {
        cost, budget: ROBOT_BUDGET, blocks: t("garage.count.blocks", { n: design.blocks.length }), wheels: t("garage.count.wheels", { n: design.wheels.length }),
      })),
      bar,
      el("div", "g-line", t("garage.stats.mass", { mass: measure(mass, "kg"), mobility: t(`garage.mobility.${mobility}`) })),
      el("div", "g-line", comLine(designCenterOfMass(design))),
    );
    const flight = flightLine(design, mobility);
    if (flight) stats.append(flight);
    if (problems.length) {
      const ul = el("ul", "g-problems");
      for (const issue of problems.slice(0, 4)) ul.append(el("li", "", designIssueText(issue)));
      stats.append(ul);
    } else {
      stats.append(el("div", "g-ok", t("garage.stats.ready")));
    }
    // Une tourelle sous un bloc ne tirera jamais : le robot ne tire pas à travers lui-même
    const buried = buriedTurrets(design);
    if (buried.length) {
      const names = buried.map((b) => t("garage.blockAt", { name: blockName(b.type), at: cellKey(b.x, b.y, b.z) })).join(", ");
      stats.append(el("div", "g-warn", t("garage.warn.buried", { names })));
    }
    // Un bloc derrière la tuyère d'un moteur à flamme brûlera dès qu'il poussera (robot/exhaust.ts)
    const scorched = jetObstructions(design);
    if (scorched.length) {
      const names = scorched.map(({ block: b }) => t("garage.blockAt", { name: blockName(b.type), at: cellKey(b.x, b.y, b.z) })).join(", ");
      stats.append(el("div", "g-warn", t("garage.warn.scorched", { names })));
    }
    // Des pièces qui se gênent (un plan d'avant, ou un robot prédéfini) : on ne peut plus en poser
    // ainsi, mais le robot reste jouable
    const clashes = designConflicts(design);
    if (clashes.length) {
      const list = clashes.slice(0, 3).map((c) => conflictLine(design, c)).join(" · ");
      stats.append(el("div", "g-warn", clashes.length > 3 ? t("garage.warn.clashesMore", { list, n: clashes.length - 3 }) : t("garage.warn.clashes", { list })));
    }
    // Des pièces encore verrouillées : on peut l'essayer, pas le jouer en partie
    const locked = lockedParts(design, (part) => this.has(part));
    if (locked.length) {
      stats.append(el("div", "g-warn", t("garage.warn.locked", { parts: locked.map(partName).join(", ") })));
    }
    const test = this.panel.querySelector<HTMLButtonElement>(".g-action.primary");
    if (test) test.disabled = problems.length > 0;
  }
}

/** Les initiales de la boussole, dans la langue affichée. */
function compassLabels(): Record<MarkSide, string> {
  return { front: t("garage.compass.front"), back: t("garage.compass.back"), left: t("garage.compass.left"), right: t("garage.compass.right") };
}

/**
 * Ce que peut un robot volant : portance de ses rotors (au-dessus de 1, il décolle ; il faut de
 * la marge pour tenir l'assiette et survivre à une panne) et autonomie ; pour un avion, sa poussée.
 */
function flightLine(design: RobotDesign, mobility: Mobility): HTMLDivElement | null {
  const f = flightStats(design);
  if (mobility === "hover") {
    const time = f.hoverTime === null ? t("garage.flight.noLift")
      : f.hoverTime === Infinity ? t("garage.flight.unlimited") : t("garage.flight.endurance", { time: measure(f.hoverTime, "s") });
    const tone = f.liftRatio < 1 ? "g-bad" : f.liftRatio < 1.3 ? "g-warn" : "g-line";
    return el("div", tone, t("garage.flight.lift", { ratio: fixed(f.liftRatio, 2), time, battery: measure(f.battery, "kJ") }));
  }
  if (mobility === "plane") return el("div", "g-line", t("garage.flight.thrust", { ratio: fixed(f.thrustRatio, 2), thrust: measure(f.cruise, "N") }));
  return null;
}

/** Où est le centre de masse : devant ou derrière le centre de la grille, décalé sur le côté, à quelle hauteur au-dessus du sol. */
function comLine(com: { x: number; y: number; z: number }): string {
  const metres = (v: number): string => measure(Math.abs(v), "m", 2);
  const depth = Math.abs(com.z) < 0.05 ? t("garage.com.center") : t(com.z > 0 ? "garage.com.front" : "garage.com.behind", { d: metres(com.z) });
  const height = metres(com.y + BLOCK_SIZE / 2);
  if (Math.abs(com.x) < 0.05) return t("garage.com.line", { depth, height });
  const side = t(com.x > 0 ? "garage.com.left" : "garage.com.right", { d: metres(com.x) });
  return t("garage.com.lineSide", { depth, side, height });
}

const opposite = (a: Axis): Axis => ((a[0] === "+" ? "-" : "+") + a[1]) as Axis;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}
