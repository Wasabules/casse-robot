import { WEAPON_IDS } from "../../shared/catalog/weapons";
import { clamp } from "../../shared/math/scalar";
import type { ArenaGame } from "../game";
import { byId } from "../dom";
import {
  ACTION_IDS, actionDef, actionsFor, bindingName, codeLabel, DEFAULT_BINDINGS, padLabel, setKeyNamer, WEAPON_SLOTS,
  type ActionId, type Bindings, type InputContext,
} from "./bindings";
import { GamepadInput } from "./gamepad";
import { TouchPad } from "./touchPad";
import { t } from "../i18n/i18n";

/** Au-delà de ce déplacement (px), un glisser tourne la caméra au lieu de tirer. */
const DRAG_THRESHOLD = 8;
/** Durée maximale d'un toucher pour qu'il compte comme un tir (ms). */
const TAP_MAX_MS = 400;
/** Boutons de la souris : bit du masque `buttons` d'un événement, et code (`Mouse` + `button`). */
const MOUSE_BUTTONS: readonly (readonly [number, string])[] = [[1, "Mouse0"], [2, "Mouse2"], [4, "Mouse1"], [8, "Mouse3"], [16, "Mouse4"]];
/**
 * Stick droit poussé à fond : vitesse de rotation de la caméra (rad/s), à la sensibilité 1 ; la
 * réponse suit la course à la puissance PAD_LOOK_CURVE (précise près du centre, vive au bord).
 */
const PAD_LOOK_YAW = 2.6;
const PAD_LOOK_PITCH = 1.7;
const PAD_LOOK_CURVE = 1.7;
/** Menus à la manette : une direction tenue se répète après NAV_DELAY s, puis toutes les NAV_REPEAT s. */
const NAV_DELAY = 0.4;
const NAV_REPEAT = 0.13;
/** Le stick gauche compte comme une direction des menus au-delà de cette course. */
const NAV_STICK = 0.55;
/** Boutons de la manette dans les menus (disposition standard) : A valide, B et Menu reviennent, LB et RB changent d'onglet. */
const PAD_A = "Pad0";
const PAD_B = "Pad1";
const PAD_MENU = "Pad9";

/** Ce que la manette demande aux menus. */
export type MenuCommand = "up" | "down" | "left" | "right" | "accept" | "back" | "prevTab" | "nextTab";

/** Réglages de la manette : regard au stick droit (sensibilité, axes inversés). */
export interface PadLook {
  sensitivity: number;
  invertX: boolean;
  invertY: boolean;
}

/** Hauteur du réticule en vue de dos (part de la hauteur de l'écran, depuis le haut). Voir `.crosshair` dans style.css. */
export const RETICLE_HEIGHT = 0.45;

/**
 * Clavier, souris, manette et tactile pendant la partie (rien derrière le menu ni en pause ; Échap
 * est géré par l'application). Chaque commande passe par la table des actions (input/bindings.ts) :
 * les touches choisies par le joueur (`bindings`), lues par leur position physique (`code`) : ZQSD
 * en AZERTY, WASD en QWERTY. Une action ne vaut qu'à son moment (au sol, en vol, en pilotant, à la
 * caméra libre) : Espace freine au sol et fait monter en vol.
 *
 * En pilotant à la souris, un clic dans l'arène la capture (verrouillage du pointeur) : le curseur
 * disparaît, la souris tourne la caméra autour du robot, et l'on vise au réticule, au centre de
 * l'écran, comme dans un jeu de tir à la troisième personne ; ses boutons sont alors des touches
 * comme les autres (par défaut : gauche, tirer ; droit, viseur). Échap rend la souris (et ouvre la
 * pause). À la manette, le stick gauche conduit, le droit tourne la caméra, et l'on vise au
 * réticule ; derrière un menu, elle le parcourt (`onMenu`).
 */
export class Controls {
  /** Touches choisies (réglages du joueur). */
  bindings: Bindings = DEFAULT_BINDINGS;
  /** Touches du clavier et boutons de la souris capturée tenus (codes). */
  readonly held = new Set<string>();
  /** Dernière position du pointeur sur le canvas (px). */
  pointer = { x: 0, y: 0 };
  /** Bouton gauche tenu, souris libre (caméra libre : tir au pointeur, rafale). */
  triggerHeld = false;
  /** Viseur basculé (réglage : un appui met au viseur, un autre l'enlève). */
  private scopeOn = false;
  /**
   * Souris tout juste capturée : le bouton du clic qui l'a capturée est peut-être encore enfoncé ;
   * on ignore les boutons jusqu'à ce qu'ils soient tous relâchés (ce clic ne tire pas).
   */
  private waitRelease = false;
  /** Réglage : le viseur bascule au lieu de devoir être maintenu. */
  scopeToggle = false;
  /** Commandes tactiles du pilote, montrées dès que l'on pilote au doigt. */
  readonly touch = new TouchPad();
  /** Manette, et ses réglages de regard. */
  readonly pad = new GamepadInput();
  padLook: PadLook = { sensitivity: 1, invertX: false, invertY: false };
  /** Caractère de chaque touche du clavier du joueur (pour nommer les touches) : `getLayoutMap`, ou appris en jouant. */
  readonly layout = new Map<string, string>();

  private readonly game: ArenaGame;
  private readonly canvas: HTMLCanvasElement;
  /** Le joueur s'est servi d'un écran tactile (ou n'a qu'un pointeur grossier). */
  private touchUsed = matchMedia("(pointer: coarse)").matches;
  /** Souris capturée par le canvas (regard à la souris). */
  private locked = false;
  /** On peut capturer la souris (on pilote, sans menu). */
  private aiming = false;
  /** La souris vient d'être rendue (Échap) : appelé pour ouvrir la pause. */
  onRelease: (() => void) | null = null;
  /** Les noms des touches ont changé (clavier du joueur appris, manette prise ou lâchée) : les aides à l'écran sont à refaire. */
  onLabels: (() => void) | null = null;
  /** Une manette est branchée (son nom) ou débranchée (null). */
  onPadChange: ((id: string | null) => void) | null = null;
  /** Bouton Menu de la manette en partie : la pause (comme Échap). */
  onPadPause: (() => void) | null = null;
  /** Un menu est-il ouvert ? La manette le parcourt alors (`onMenu`) au lieu de piloter. */
  menuOpen: () => boolean = () => false;
  onMenu: ((command: MenuCommand) => void) | null = null;
  /** Réattribution d'un bouton de la manette en cours : le prochain bouton appuyé lui revient. */
  padCapture: ((code: string) => void) | null = null;
  private drag: { x: number; y: number; moved: number; t: number } | null = null;
  /** Direction des menus tenue à la manette, et prochaine répétition (s). */
  private nav: { dir: MenuCommand | null; next: number } = { dir: null, next: 0 };

  constructor(canvas: HTMLCanvasElement, game: ArenaGame) {
    this.game = game;
    this.canvas = canvas;
    window.addEventListener("keydown", (e) => this.onKeyDown(e));
    window.addEventListener("keyup", (e) => {
      this.held.delete(e.code);
      this.release(e.code, false);
    });
    window.addEventListener("blur", () => {
      this.held.clear();
      this.releaseButtons();
    });
    // La souris reprend la main sur la manette (les aides nomment de nouveau les touches)
    window.addEventListener("pointermove", (e) => {
      if (e.pointerType === "mouse" && (e.movementX || e.movementY)) this.usePad(false);
    });

    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("pointerdown", (e) => this.onPointerDown(canvas, e));
    canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
    canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
    canvas.addEventListener("pointercancel", () => {
      this.drag = null;
      this.releaseButtons();
    });
    // Souris capturée : les boutons latéraux ne font pas revenir la page en arrière
    canvas.addEventListener("mouseup", (e) => {
      if (this.locked && e.button >= 3) e.preventDefault();
    });
    document.addEventListener("pointerlockchange", () => {
      const was = this.locked;
      this.locked = document.pointerLockElement === canvas;
      if (!was && this.locked) this.waitRelease = true;
      if (was && !this.locked) {
        this.releaseButtons();
        this.onRelease?.();
      }
    });
    // La molette, si elle porte une action (sinon, elle zoome)
    game.rig.wheelClaim = (up) => this.game.inputEnabled && !this.game.frozen && this.press(up ? "WheelUp" : "WheelDown", false, false);
    this.pad.onChange = (id) => {
      this.onPadChange?.(id);
      this.onLabels?.();
    };
    this.readLayout();
    // Les textes du jeu qui citent une touche nomment celle choisie (fiches des pièces, traits des robots…)
    setKeyNamer((id) => this.keyName(id));
  }

  /** Le caractère de chaque touche du clavier du joueur, si le navigateur le donne (Chrome, Edge). */
  private readLayout(): void {
    const keyboard = (navigator as Navigator & { keyboard?: { getLayoutMap?: () => Promise<ReadonlyMap<string, string>> } }).keyboard;
    keyboard?.getLayoutMap?.()
      .then((map) => {
        for (const [code, key] of map) this.layout.set(code, key);
        this.onLabels?.();
      })
      .catch(() => {});
  }

  /** Sans `getLayoutMap`, on apprend en jouant le caractère de chaque lettre : les noms suivent le clavier. */
  private learn(e: KeyboardEvent): void {
    if (!/^Key[A-Z]$/.test(e.code) || e.key.length !== 1 || e.ctrlKey || e.altKey || e.metaKey) return;
    const key = e.key.toLowerCase();
    if (this.layout.get(e.code) === key) return;
    this.layout.set(e.code, key);
    this.onLabels?.();
  }

  /** La manette (ou le clavier et la souris) devient l'entrée du joueur. */
  private usePad(on: boolean): void {
    if (this.pad.active === on) return;
    this.pad.active = on;
    document.body.classList.toggle("pad-nav", on);
    this.onLabels?.();
  }

  /**
   * Capture la souris pour le regard à la souris (à appeler sur un geste du joueur : clic, touche).
   * Le navigateur peut refuser (juste après un Échap, à la manette) : il faudra alors cliquer.
   */
  captureMouse(): void {
    if (this.locked || this.touch.visible || !this.canvas.requestPointerLock) return;
    try {
      const request = this.canvas.requestPointerLock() as Promise<void> | undefined;
      request?.catch?.(() => {});
    } catch {
      // Refusé sans geste du joueur
    }
  }

  /** La souris est-elle capturée (regard à la souris) ? */
  get mouseLook(): boolean {
    return this.locked;
  }

  /** Cette action vaut-elle maintenant (au sol, en vol, en pilotant, à la caméra libre) ? */
  private contextOn(context: InputContext): boolean {
    const g = this.game;
    switch (context) {
      case "any": return true;
      case "pilot": return g.piloting;
      case "ground": return g.piloting && !g.flying;
      case "flight": return g.piloting && g.flying;
      case "free": return !g.piloting;
      // (le garage lit ses touches lui-même, partie en veille)
      case "garage": return false;
      // (l'éditeur de cartes aussi)
      case "editor": return false;
    }
  }

  /** Une touche (ou un bouton) de cette action est-elle tenue, et l'action vaut-elle maintenant ? */
  holding(id: ActionId): boolean {
    if (!this.contextOn(actionDef(id).context)) return false;
    const b = this.bindings[id];
    return (b.keys[0] !== null && this.held.has(b.keys[0])) || (b.keys[1] !== null && this.held.has(b.keys[1])) || (b.pad !== null && this.pad.held(b.pad));
  }

  /**
   * Commandes de pilotage, clavier, manette et commandes tactiles réunis : avancer, tourner (> 0 :
   * à gauche), monter, boost, frein.
   */
  pilotAxes(): { throttle: number; steer: number; climb: number; boost: boolean; brake: number } {
    const { forward, side } = this.moveAxes();
    const touch = this.touch;
    const climb = (this.holding("climb") ? 1 : 0) - (this.holding("descend") ? 1 : 0);
    return {
      throttle: clamp(forward + touch.throttle, -1, 1),
      steer: clamp(-side + touch.steer, -1, 1),
      climb: clamp(climb + touch.climb, -1, 1),
      boost: this.holding("boost") || touch.boost,
      brake: this.holding("brake") ? 1 : 0,
    };
  }

  /** Lancer des leurres : touche tenue. */
  get launchingFlares(): boolean {
    return this.holding("flares");
  }

  /** Faire sauter ses mines télécommandées : touche tenue (une au sol, une autre en vol, où la première sert souvent au lacet). */
  get detonating(): boolean {
    return this.holding("detonate") || this.holding("detonateAir");
  }

  /** Lacet en vol (palonnier d'un avion, pivot d'un drone ou d'un hélicoptère) : > 0 vers la gauche. */
  get rudder(): number {
    return (this.holding("yawLeft") ? 1 : 0) - (this.holding("yawRight") ? 1 : 0);
  }

  /** Gâchette du pilote : sa touche (souris capturée, clavier, manette), ou le bouton de tir tactile. */
  get firing(): boolean {
    return this.holding("fire") || this.touch.fire;
  }

  /** Caméra libre : tir continu (arme automatique) tant que le bouton gauche ou la touche de tir est tenu. */
  get freeTrigger(): boolean {
    return this.triggerHeld || this.holding("fire");
  }

  /** Au viseur : sa touche tenue (ou basculée), en visant au réticule ; ou le bouton du viseur tactile. */
  get scoping(): boolean {
    const on = this.scopeToggle ? this.scopeOn : this.holding("scope");
    return (this.reticleAim && on) || this.touch.scope;
  }

  /**
   * Point de l'écran visé (px, dans le canvas) : le réticule (souris capturée, au doigt, à la
   * manette), sinon le pointeur. Le réticule est un peu au-dessus du centre en vue de dos (le robot
   * est dessous), au centre exact au viseur. Voir le réticule, hud/reticle.ts.
   */
  aimPoint(): { x: number; y: number } {
    if (!this.touch.visible && !this.locked && !this.pad.active) return this.pointer;
    const centered = this.scoping || this.centerAim || !this.game.piloting;
    return { x: this.canvas.clientWidth / 2, y: this.canvas.clientHeight * (centered ? 0.5 : RETICLE_HEIGHT) };
  }

  /** Visée au centre exact de l'écran, même sans viseur (ogive pilotée : la caméra est à son nez). */
  centerAim = false;

  /** On vise au réticule : souris capturée, commandes tactiles, ou manette. */
  get reticleAim(): boolean {
    return this.locked || this.touch.visible || this.pad.active;
  }

  /**
   * À chaque image : `piloting`, le joueur pilote sans menu ouvert. Commandes tactiles au doigt ;
   * souris rendue dès qu'on ne pilote plus (menu, fin de partie) ; invitation à cliquer (pas à la manette).
   */
  updatePointer(piloting: boolean): void {
    this.aiming = piloting;
    this.touch.show(this.touchUsed && piloting);
    if (!piloting && this.locked) document.exitPointerLock();
    if (!piloting) this.scopeOn = false;
    byId("lockHint").hidden = !(piloting && !this.touch.visible && !this.locked && !this.pad.active);
  }

  /**
   * À chaque image, avant de lire les commandes : la manette. Derrière un menu, elle le parcourt ;
   * en partie, ses boutons sont des touches comme les autres, son stick droit tourne la caméra.
   */
  poll(dt: number): void {
    this.pad.poll();
    const pressed = this.pad.pressed();
    if (this.pad.touched) this.usePad(true);
    else if (!this.pad.id) this.usePad(false);
    // Réattribution d'un bouton : il revient à l'écran des réglages
    if (this.padCapture) {
      if (pressed.length) this.padCapture(pressed[0]);
      return;
    }
    if (this.menuOpen()) {
      this.navigateMenu(dt, pressed);
      return;
    }
    this.nav.dir = null;
    if (pressed.includes(PAD_MENU)) this.onPadPause?.();
    if (!this.game.inputEnabled || this.game.frozen) return;
    for (const code of pressed) this.press(code, true, false);
    for (const code of this.pad.released()) this.release(code, true);
    // Stick droit : la caméra
    const { x, y } = this.pad.right;
    if (x || y) {
      const look = this.padLook;
      const curve = (v: number): number => Math.sign(v) * Math.abs(v) ** PAD_LOOK_CURVE;
      this.game.rig.turn(
        curve(x) * PAD_LOOK_YAW * look.sensitivity * dt * (look.invertX ? -1 : 1),
        curve(y) * PAD_LOOK_PITCH * look.sensitivity * dt * (look.invertY ? -1 : 1),
      );
    }
  }

  /** Menus à la manette : croix ou stick gauche (avec répétition), A, B, Menu, LB et RB. */
  private navigateMenu(dt: number, pressed: readonly string[]): void {
    const send = (command: MenuCommand): void => this.onMenu?.(command);
    for (const code of pressed) {
      if (code === PAD_A) send("accept");
      else if (code === PAD_B || code === PAD_MENU) send("back");
      else if (code === "Pad4") send("prevTab");
      else if (code === "Pad5") send("nextTab");
    }
    const { x, y } = this.pad.left;
    const p = this.pad;
    const dir: MenuCommand | null = p.held("Pad12") || y < -NAV_STICK ? "up"
      : p.held("Pad13") || y > NAV_STICK ? "down"
        : p.held("Pad14") || x < -NAV_STICK ? "left"
          : p.held("Pad15") || x > NAV_STICK ? "right" : null;
    if (dir !== this.nav.dir) {
      this.nav = { dir, next: NAV_DELAY };
      if (dir) send(dir);
      return;
    }
    if (!dir) return;
    this.nav.next -= dt;
    if (this.nav.next <= 0) {
      this.nav.next = NAV_REPEAT;
      send(dir);
    }
  }

  /**
   * Une touche, un bouton de la souris capturée ou de la manette vient d'être appuyé : les actions
   * qu'il porte et qui valent maintenant (`shift` : Maj tenue, pour les armes au-delà de dix).
   * Vrai s'il en portait une.
   */
  private press(code: string, pad: boolean, shift: boolean): boolean {
    const actions = actionsFor(this.bindings, code, pad, (c) => this.contextOn(c));
    for (const id of actions) this.trigger(id, shift);
    return actions.length > 0;
  }

  /** Une touche relâchée : le tableau (tenu) se referme. */
  private release(code: string, pad: boolean): void {
    const b = this.bindings.scoreboard;
    if (pad ? b.pad === code : b.keys.includes(code)) this.game.releaseTab();
  }

  private trigger(id: ActionId, shift: boolean): void {
    const g = this.game;
    const slot = (WEAPON_SLOTS as readonly ActionId[]).indexOf(id);
    if (slot >= 0) {
      // Armes du catalogue, ou celles du robot piloté, dans l'ordre ; avec Maj, les dix suivantes
      // (Maj sert aussi au boost : sans onzième arme, la touche seule compte)
      const weapons = g.piloting ? g.pilotWeapons : WEAPON_IDS;
      const weapon = (shift ? weapons[slot + 10] : undefined) ?? weapons[slot];
      if (weapon) g.selectWeapon(weapon);
      return;
    }
    switch (id) {
      case "nextWeapon": g.cycleWeapon(1); break;
      case "prevWeapon": g.cycleWeapon(-1); break;
      case "scoreboard": g.pressTab(); break;
      case "map": g.toggleMap(); break;
      case "selfDestruct": g.selfDestruct(); break;
      case "flightMode": g.toggleFlight(); break;
      case "cutEngine": g.cutEngine(); break;
      case "followNext": g.followNext(); break;
      case "newWave": g.newWave(); break;
      case "freezeAi": g.setPaused(!g.sim.aiPaused); break;
      case "slowmo": g.toggleSlowmo(); break;
      case "scope":
        if (this.scopeToggle && this.reticleAim) this.scopeOn = !this.scopeOn;
        break;
      case "fire": {
        // Caméra libre : un coup vers ce que l'on vise (la rafale d'une arme automatique : `freeTrigger`)
        if (g.piloting) break;
        const p = this.aimPoint();
        g.tryFire(p.x, p.y);
        break;
      }
      default: break;
    }
  }

  // --- Noms des touches, pour les aides à l'écran ---

  /**
   * Nom de la touche de cette action, pour une aide à l'écran : son bouton de manette quand on joue
   * à la manette (s'il en a un), sinon celle du clavier ou de la souris (`bindingName` : la carte,
   * M, en QWERTY comme en AZERTY) ; « — » si elle n'en a pas.
   */
  keyName(id: ActionId, device: "auto" | "keys" = "auto"): string {
    const def = actionDef(id);
    const b = this.bindings[id];
    if (device === "auto" && this.pad.active) {
      const code = b.pad ?? def.fixedPad;
      if (code) return padLabel(code, this.pad.style);
    }
    return bindingName(id, b, this.layout);
  }

  /** Nom du bouton (ou du stick) de la manette de cette action, selon sa disposition ; « — » s'il n'en a pas. */
  padName(id: ActionId): string {
    const code = this.bindings[id].pad ?? actionDef(id).fixedPad;
    return code ? padLabel(code, this.pad.style) : "—";
  }

  /** Les touches d'une action (clavier et souris), séparées : « Z · ↑ ». */
  keysText(id: ActionId): string {
    const def = actionDef(id);
    const codes = def.fixedKey ? [def.fixedKey] : this.bindings[id].keys.filter((c): c is string => c !== null);
    return codes.length ? codes.map((c) => codeLabel(c, this.layout)).join(" · ") : "—";
  }

  private releaseButtons(): void {
    this.triggerHeld = false;
    this.scopeOn = false;
    for (const [, code] of MOUSE_BUTTONS) this.held.delete(code);
  }

  /**
   * Souris capturée : ses boutons d'après le masque `buttons` de chaque événement. On ne peut pas se
   * fier à `pointerdown` et `pointerup` : quand un bouton est déjà enfoncé, appuyer sur un autre ou
   * le relâcher n'émet qu'un `pointermove`. `fresh` : un `pointerdown`, qui n'arrive que quand aucun
   * bouton n'était enfoncé.
   */
  private syncButtons(buttons: number, fresh: boolean): void {
    if (this.waitRelease) {
      if (!fresh && buttons !== 0) return;
      this.waitRelease = false;
    }
    for (const [bit, code] of MOUSE_BUTTONS) {
      const down = (buttons & bit) !== 0;
      if (down === this.held.has(code)) continue;
      if (down) {
        this.held.add(code);
        if (this.game.inputEnabled && !this.game.frozen) this.press(code, false, false);
      } else {
        this.held.delete(code);
        this.release(code, false);
      }
    }
  }

  /** Rappel sous le réticule : l'arme choisie ne tire qu'au viseur. */
  showScopeHint(on: boolean): void {
    byId("scopeHint").hidden = !on;
  }

  /** Missile ennemi en approche : l'alerte, et la touche des leurres (`flares` : salves prêtes ; null : pas de lance-leurres). */
  showMissileHint(on: boolean, flares: number | null): void {
    const hint = byId("missileHint");
    hint.hidden = !on;
    if (!on) return;
    hint.textContent = flares === null ? t("hud.missile.incoming")
      : flares > 0 ? t("hud.missile.flares", { key: this.keyName("flares"), n: flares }) : t("hud.missile.noFlares");
  }

  /** Mines télécommandées posées (0 : aucune) : l'aide dit quelle touche les fait sauter (au sol ou en vol). */
  showDetonateHint(count: number, flying: boolean): void {
    const hint = byId("detonateHint");
    hint.hidden = count === 0;
    if (count) hint.textContent = t("hud.detonate", { key: this.keyName(flying ? "detonateAir" : "detonate"), n: count });
  }

  /** Axes de déplacement (conduite, caméra libre), de -1 à 1 : touches et stick gauche. */
  moveAxes(): { forward: number; side: number } {
    const keys = (plus: ActionId, minus: ActionId): number => (this.holding(plus) ? 1 : 0) - (this.holding(minus) ? 1 : 0);
    const stick = this.pad.left;
    return {
      forward: clamp(keys("forward", "back") - stick.y, -1, 1),
      side: clamp(keys("right", "left") + stick.x, -1, 1),
    };
  }

  private onKeyDown(e: KeyboardEvent): void {
    // Les flèches que la manette envoie aux menus (menu/menu.ts) ne sont pas le clavier du joueur
    if (!e.isTrusted) return;
    this.learn(e);
    this.usePad(false);
    if (!this.game.inputEnabled || this.game.frozen) return;
    // Espace et Entrée activent le bouton du HUD qui a le focus
    if ((e.target as Element | null)?.closest?.("button") && (e.code === "Space" || e.code === "Enter")) return;
    const bound = ACTION_IDS.some((id) => this.bindings[id].keys.includes(e.code) && this.contextOn(actionDef(id).context));
    // Une touche du jeu ne fait rien d'autre (Espace ne fait pas défiler, Tab ne change pas le focus)
    if (bound) e.preventDefault();
    this.held.add(e.code);
    if (e.repeat) return;
    this.press(e.code, false, e.shiftKey);
  }

  private onPointerDown(canvas: HTMLCanvasElement, e: PointerEvent): void {
    if (e.pointerType === "touch") this.touchUsed = true;
    if (e.pointerType === "mouse") this.usePad(false);
    if (!this.game.inputEnabled || this.game.frozen) return;
    canvas.focus();
    // En pilotant à la souris, le premier clic capture la souris (il ne tire pas)
    if (e.pointerType === "mouse" && this.aiming && !this.locked && !this.touch.visible) {
      this.captureMouse();
      return;
    }
    // Souris capturée : ses boutons sont des touches (par défaut : gauche, tirer ; droit, viseur)
    if (e.pointerType === "mouse" && this.locked) {
      this.syncButtons(e.buttons, true);
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    this.pointer = { x: e.offsetX, y: e.offsetY };
    this.game.hud.hideHintLater();
    if (e.pointerType === "mouse") {
      if (e.button === 2) {
        this.drag = { x: e.clientX, y: e.clientY, moved: Infinity, t: 0 };
      } else if (e.button === 0) {
        if (!this.game.piloting) this.game.tryFire(e.offsetX, e.offsetY);
        this.triggerHeld = true;
      }
    } else {
      this.drag = { x: e.clientX, y: e.clientY, moved: 0, t: performance.now() };
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.locked) {
      if (e.pointerType === "mouse") this.syncButtons(e.buttons, false);
      this.game.rig.lookBy(e.movementX, e.movementY);
      return;
    }
    // Bouton gauche relâché pendant que le droit était tenu : pas de pointerup, seulement ce pointermove
    if (e.pointerType === "mouse" && !(e.buttons & 1)) this.triggerHeld = false;
    this.pointer = { x: e.offsetX, y: e.offsetY };
    const drag = this.drag;
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.moved > DRAG_THRESHOLD) this.game.rig.orbit(dx, dy);
  }

  private onPointerUp(e: PointerEvent): void {
    const isMouse = e.pointerType === "mouse";
    // Toucher bref sans glisser : un tir
    if (!isMouse && !this.game.piloting && this.drag && this.drag.moved <= DRAG_THRESHOLD && performance.now() - this.drag.t < TAP_MAX_MS) {
      this.game.fireAt(e.offsetX, e.offsetY);
    }
    if (isMouse && this.locked) {
      this.syncButtons(e.buttons, false);
      return;
    }
    if (isMouse && !(e.buttons & 1)) this.triggerHeld = false;
    if (!isMouse || e.button === 2) this.drag = null;
  }
}
