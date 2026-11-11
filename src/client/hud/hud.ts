import { isOperational } from "../../shared/ai/brain";
import { WEAPON_IDS, WEAPONS, type Weapon, type WeaponId } from "../../shared/catalog/weapons";
import { isMeleeId, meleeDef, type ArmId, type MeleeId, type MeleeSpec } from "../../shared/catalog/melee";
import { canFire } from "../../shared/combat/arsenal";
import { energyFraction } from "../../shared/robot/energy";
import { liftToWeight } from "../../shared/robot/propulsion";
import { drivenWheelCount, integrity, liveThrusters, wheelLoad } from "../../shared/robot/queries";
import { steeringGeometry } from "../../shared/robot/steering";
import { liveSupports } from "../../shared/robot/supports";
import { blockDef } from "../../shared/catalog/blocks";
import { wheelDef } from "../../shared/catalog/wheels";
import type { AiMode, ArmState, Bot, Team } from "../../shared/sim/entities";
import type { SimEvent } from "../../shared/sim/events";
import type { Match } from "../../shared/sim/match";
import type { World } from "../../shared/sim/world";
import { byId } from "../dom";
import type { KeyHelp } from "../keys";
import { TEAM_COLORS } from "../teams";
import { fixed, num, pct } from "../i18n/format";
import { measure, t } from "../i18n/i18n";
import { aiModeName, armName, botName, botTrait } from "../i18n/names";

/** Le tableau se rafraîchit au plus 4 fois par seconde. */
const REFRESH = 0.25;
/** Tab tenu moins longtemps que ça (ms) : un appui, qui épingle le tableau au lieu de ne le montrer que le temps de le tenir. */
const TAP_MS = 250;
/** Nuance de la pastille d'état (classes CSS de style.css). */
type Tone = "" | "warn" | "idle" | "bad";

/** Pourquoi une arme est perdue (barrée dans la barre des armes : `hud.lost.<raison>`) : ses tourelles détruites, ou son coup unique tiré. */
export type LostReason = "offline" | "empty";

/** La nuance de la pastille de chaque mode d'IA (son nom : `aiModeName`, rubrique `aiMode`). */
const MODE_TONES: Record<AiMode, Tone> = {
  patrol: "",
  engage: "warn",
  cover: "idle",
  flee: "warn",
  charge: "warn",
  reverse: "warn",
  hover: "idle",
  paused: "idle",
  gliding: "warn",
  landing: "idle",
  stunned: "bad",
  flipped: "bad",
  stranded: "bad",
  falling: "bad",
  dead: "bad",
  support: "idle",
};

/** Ce qui distingue une arme de tourelle, en deux mots (sous son nom, dans la barre des armes : `hud.tag.<id>`). */
export type WeaponTag =
  | "automatic" | "energyWall" | "repair" | "flares" | "antiAir" | "remote" | "sensor" | "sticky" | "bouncing" | "screen"
  | "stunning" | "incendiary" | "guided" | "trap" | "burst" | "piercing" | "explosive" | "single";

/** Ce qui distingue une arme, en deux mots. */
function weaponTag(w: Weapon): WeaponTag {
  const p = w.projectile;
  if (w.autoSupport) return "automatic";
  if (p.barrier) return "energyWall";
  if (p.repair) return "repair";
  if (p.decoy) return "flares";
  if (p.mine) {
    const m = p.mine;
    if (m.trigger === "air") return "antiAir";
    if (m.trigger === "remote") return "remote";
    if (m.trigger === "none") return "sensor";
    if (m.action?.kind === "stick") return "sticky";
    if (m.action?.kind === "bounce") return "bouncing";
  }
  if (p.smoke) return "screen";
  if (p.emp) return "stunning";
  if (p.damageType === "fire") return "incendiary";
  if (p.guidance) return p.guidance.mode === "command" ? "guided" : "antiAir";
  if (p.explosion?.look === "napalm") return "incendiary";
  if (p.mine) return "trap";
  if (w.automatic) return "burst";
  if (p.penetrating) return "piercing";
  return p.explosion ? "explosive" : "single";
}
const weaponTagText = (w: Weapon): string => t(`hud.tag.${weaponTag(w)}`);

/** Ce qui distingue une arme de contact, en deux mots (selon son allure : `hud.meleeTag.<allure>`). */
const meleeTag = (m: MeleeSpec): string => t(`hud.meleeTag.${m.look}`);

/** Ce que montre la barre des armes d'un rotor : son régime ; d'une lame d'énergie, sa charge. */
const spinText = (m: MeleeSpec, charge: number): string => t(m.quench ? "hud.melee.charge" : "hud.melee.spin", { value: pct(charge) });

/**
 * État d'une arme de contact dans la barre des armes : le régime d'un rotor ou d'un fléau (la charge
 * d'une arme d'énergie), un bras ou une pointe armés ou qui se réarment, un flipper armé ou qui
 * recharge son vérin, une mâchoire ouverte, qui serre ou se rouvre.
 */
function meleeStatus(m: MeleeSpec, charge: number, holding: boolean): string {
  switch (m.motion) {
    case "spin":
    case "driven":
    case "field":
    case "flail":
      return spinText(m, charge);
    case "swing":
    case "thrust":
      return t(charge >= 1 ? "hud.melee.armed" : "hud.melee.rearming");
    case "flip":
      return t(charge >= 1 ? "hud.melee.armed" : "hud.melee.reloading");
    case "grip":
      return t(holding ? "hud.melee.gripping" : charge >= 1 ? "hud.melee.open" : "hud.melee.reopening");
  }
}

/** Propulsion et rapport de puissance d'un robot : ce qui lui reste, et ce que ça lui permet. */
function propulsionLine(bot: Bot): string {
  const count = (role: "lift" | "cruise"): string =>
    `${liveThrusters(bot, role).length}/${bot.thrusters.filter((t) => t.role === role).length}`;
  const energy = (): string => pct(energyFraction(bot));
  switch (bot.profile.mobility) {
    case "hover":
      return t("hud.prop.hover", { count: count("lift"), lift: fixed(liftToWeight(bot), 1), energy: energy() });
    case "plane": {
      const v = bot.cockpit.alive ? bot.cockpit.part.rb.linvel() : { x: 0, y: 0, z: 0 };
      return t("hud.prop.plane", { count: count("cruise"), speed: measure(Math.hypot(v.x, v.y, v.z), "mps") });
    }
    case "ground": {
      if (bot.supports.length) {
        const hover = bot.supports.some((s) => blockDef(s.block.type).support?.kind === "hover");
        const live = `${liveSupports(bot).length}/${bot.supports.length}`;
        return hover ? t("hud.prop.pads", { count: live, energy: energy() }) : t("hud.prop.legs", { count: live });
      }
      const steerable = bot.wheels.filter((w) => w.steerable).length;
      const tracked = bot.wheels.length > 0 && bot.wheels.every((w) => wheelDef(w.type).track);
      const driven = `${drivenWheelCount(bot)}/${bot.wheels.length}`;
      const parts = [
        t(tracked ? "hud.prop.rollers" : "hud.prop.wheels", { count: driven }),
        ...(steerable ? [t("hud.prop.steering", { count: `${steeringGeometry(bot).steered.length}/${steerable}` })] : []),
        t("hud.prop.load", { load: pct(wheelLoad(bot)) }),
        ...(bot.thrusters.some((th) => th.role === "cruise") ? [t("hud.prop.rocket", { count: count("cruise") })] : []),
      ];
      return parts.join(" · ");
    }
  }
}

export interface HudActions {
  selectWeapon(id: ArmId): void;
  newWave(): void;
  togglePause(): void;
  toggleSlowmo(): void;
  /** Clic sur un robot du tableau (index dans `world.bots`). */
  toggleFollow(index: number): void;
}

interface BotRow {
  bot: Bot;
  li: HTMLLIElement;
  button: HTMLButtonElement;
  chip: HTMLElement;
  bar: HTMLElement;
  pct: HTMLElement;
  prop: HTMLElement;
  kd: HTMLElement;
}

/**
 * Une place dans une équipe : un robot, puis ceux qui le remplacent à ses réapparitions (même
 * équipe, même robot). Elle garde ses destructions et ses morts pendant la partie.
 */
interface Seat {
  team: Team;
  profile: string;
  kills: number;
  deaths: number;
  bot: Bot | null;
}

/**
 * HUD en HTML (balisage dans index.html). À l'écran, l'essentiel : la barre des armes (en bas),
 * la mini-carte (hud/minimap.ts), le score et l'état du robot (hud/matchHud.ts). Le reste est dans
 * le tableau, qu'on ouvre avec Tab (tenu : le temps de le tenir ; un appui : épinglé jusqu'au
 * suivant) : les robots des deux équipes (état, propulsion, structure, destructions et morts), la
 * partie, les outils de l'arène libre et les commandes.
 */
export class Hud {
  private readonly actions: HudActions;
  private rows: BotRow[] = [];
  private seats: Seat[] = [];
  private readonly seatOf = new WeakMap<Bot, Seat>();
  /** Partie dont on compte les destructions : une nouvelle partie les remet à zéro. */
  private match: Match | null = null;
  private timer = 0;
  private hintHidden = false;
  /** Ce que l'équipe du joueur a repéré ; null : tout est visible (caméra libre). */
  private detected: ((bot: Bot) => boolean) | null = null;
  /** Tableau ouvert, épinglé (il reste ouvert quand on lâche Tab), et depuis quand Tab est tenu. */
  private open = false;
  private pinned = false;
  private pressedAt = 0;

  constructor(actions: HudActions) {
    this.actions = actions;
    this.setArsenal(WEAPON_IDS);
    byId("reset").addEventListener("click", () => actions.newWave());
    byId("slowmo").addEventListener("click", () => actions.toggleSlowmo());
    byId("pause").addEventListener("click", () => actions.togglePause());
    // Au doigt (sans touche Tab), le bouton sous la mini-carte ouvre et ferme le tableau
    byId("mmTab").addEventListener("click", () => this.toggleTab());
  }

  /** Titre du tableau : le mode et l'arène. */
  setTitle(text: string): void {
    byId("tab-title").textContent = text;
  }

  get tabOpen(): boolean {
    return this.open;
  }

  /** Tab enfoncé : le tableau s'ouvre ; déjà épinglé, il se ferme. */
  pressTab(): void {
    if (this.pinned) {
      this.closeTab();
      return;
    }
    this.pressedAt = performance.now();
    this.showTab(true);
  }

  /** Tab relâché : un simple appui épingle le tableau ; tenu, il se referme. */
  releaseTab(): void {
    if (!this.open || this.pinned) return;
    if (performance.now() - this.pressedAt < TAP_MS) this.pinned = true;
    else this.showTab(false);
  }

  toggleTab(): void {
    if (this.open) this.closeTab();
    else {
      this.pinned = true;
      this.showTab(true);
    }
  }

  /** Ferme le tableau (menu, fin de partie). */
  closeTab(): void {
    this.pinned = false;
    this.showTab(false);
  }

  private showTab(on: boolean): void {
    this.open = on;
    byId("tabPanel").hidden = !on;
    byId("mmTab").setAttribute("aria-pressed", String(on));
    if (on) this.refreshSoon();
  }

  /**
   * Destructions et morts de chaque place, d'après les événements du monde affiché : un robot qui
   * réapparaît reprend la place laissée par le robot détruit de son équipe (même robot).
   */
  onWorldEvent(e: SimEvent): void {
    switch (e.type) {
      case "botRemoved": {
        const seat = this.seatOf.get(e.bot);
        if (seat && seat.bot === e.bot) seat.bot = null;
        break;
      }
      case "botAdded": {
        const bot = e.bot;
        let seat = this.seats.find((s) => !s.bot && s.team === bot.team && s.profile === bot.profile.id);
        if (!seat) this.seats.push((seat = { team: bot.team, profile: bot.profile.id, kills: 0, deaths: 0, bot }));
        seat.bot = bot;
        this.seatOf.set(bot, seat);
        break;
      }
      case "botKilled": {
        const victim = this.seatOf.get(e.bot);
        if (victim) victim.deaths++;
        const killer = e.killer ? this.seatOf.get(e.killer) : undefined;
        if (killer && e.killer?.team !== e.bot.team) killer.kills++;
        this.refreshSoon();
        break;
      }
      default:
        break;
    }
  }

  /** Reconstruit le tableau : les robots de chaque équipe (`player` : celui du joueur local, « toi »). */
  setEnemies(bots: readonly Bot[], player: Bot | null = null): void {
    this.listed = { bots, player };
    const lists: Record<Team, HTMLElement> = { blue: byId("team-blue"), red: byId("team-red") };
    lists.blue.textContent = "";
    lists.red.textContent = "";
    this.rows = bots.map((bot, i) => {
      const { color, id } = bot.profile;
      const name = botName(bot.profile);
      const trait = botTrait(bot.profile);
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.className = "enemy";
      button.id = `enemy-${id}`;
      button.setAttribute("aria-pressed", "false");
      button.innerHTML = `
        <span class="sw" style="background:${TEAM_COLORS[bot.team]}"></span>
        <span class="nm"></span>
        <span class="chip"></span>
        <span class="kd"></span>
        <span class="trait"></span>
        <span class="prop"></span>
        <span class="integ"><span class="bar"><i style="background:${color}"></i></span><span class="pct"></span></span>`;
      const part = (sel: string): HTMLElement => button.querySelector<HTMLElement>(sel)!;
      part(".sw").title = t(`hud.tab.teamOf.${bot.team}`);
      part(".nm").textContent = name;
      if (bot.controller === "player") {
        const who = document.createElement("em");
        who.textContent = t(bot === player ? "hud.tab.you" : "hud.tab.player");
        part(".nm").append(" ", who);
      }
      part(".trait").textContent = trait;
      button.addEventListener("click", () => this.actions.toggleFollow(i));
      li.appendChild(button);
      lists[bot.team].appendChild(li);
      return { bot, li, button, chip: part(".chip"), bar: part(".integ i"), pct: part(".pct"), prop: part(".prop"), kd: part(".kd") };
    });
    this.refreshSoon();
  }

  showWeapon(id: ArmId): void {
    this.selected = id;
    for (const b of this.weaponButtons()) b.setAttribute("aria-pressed", String(b.dataset.w === id));
  }

  /**
   * État des armes : munitions restantes, ou chaleur ; une jauge au pied de chaque bouton, et le
   * bouton s'estompe quand l'arme ne peut pas tirer (surchauffe, chargeur vide). Une arme perdue
   * (`lost` : « hors d'usage », « vide ») est barrée.
   */
  showArsenal(
    arms: ReadonlyMap<WeaponId, ArmState>, lost: ReadonlyMap<ArmId, LostReason> = new Map(), melee: ReadonlyMap<MeleeId, number> = new Map(),
    holding: ReadonlySet<MeleeId> = new Set(),
  ): void {
    for (const button of this.weaponButtons()) {
      const id = button.dataset.w as ArmId;
      const small = button.querySelector("small")!;
      const meter = button.querySelector<HTMLElement>(".meter")!;
      const lostAs = lost.get(id);
      button.classList.toggle("lost", !!lostAs);
      if (lostAs) {
        const reason = t(`hud.lost.${lostAs}`);
        if (small.textContent !== reason) small.textContent = reason;
        meter.style.width = "0%";
        continue;
      }
      // Arme de contact : le régime de son rotor, ou son bras armé ou qui se réarme
      if (isMeleeId(id)) {
        const charge = melee.get(id);
        if (charge === undefined) continue;
        const spec = meleeDef(id);
        const spin = spec.motion === "spin" || spec.motion === "flail";
        const held = holding.has(id);
        const text = meleeStatus(spec, charge, held);
        if (small.textContent !== text) small.textContent = text;
        meter.style.width = `${Math.round(charge * 100)}%`;
        meter.classList.toggle("hot", held);
        button.classList.toggle("off", spin ? charge < 0.25 : charge < 1 && !held);
        continue;
      }
      const w = WEAPONS[id] as Weapon;
      const arm = arms.get(id);
      if (!arm) continue;
      let text = weaponTagText(w);
      let level = 0;
      if (w.ammo) {
        text = `${Math.floor(arm.ammo)} / ${w.ammo.capacity}`;
        level = arm.ammo / w.ammo.capacity;
      } else if (w.heat) {
        if (arm.overheated) text = t("hud.weapon.overheated");
        level = arm.heat;
      }
      if (small.textContent !== text) small.textContent = text;
      meter.style.width = `${Math.round(level * 100)}%`;
      meter.classList.toggle("hot", !!w.heat);
      button.classList.toggle("off", !canFire(arm) && arm.cooldown <= 0);
    }
  }

  /** Commandes du mode en cours, dans le tableau. */
  setHelp(keys: readonly KeyHelp[]): void {
    const dl = byId("helpKeys");
    dl.textContent = "";
    for (const [key, effect] of keys) {
      const dt = document.createElement("dt");
      dt.textContent = key;
      const dd = document.createElement("dd");
      dd.textContent = effect;
      dl.append(dt, dd);
    }
  }

  /** Les ennemis que l'équipe du joueur n'a pas repérés s'affichent comme tels (null : tout est visible). */
  setDetection(detected: ((bot: Bot) => boolean) | null): void {
    this.detected = detected;
  }

  showPaused(paused: boolean): void {
    byId("pause").setAttribute("aria-pressed", String(paused));
  }

  showSlowmo(on: boolean): void {
    byId("slowmo").setAttribute("aria-pressed", String(on));
  }

  showFollow(index: number): void {
    this.rows.forEach((r, j) => r.button.setAttribute("aria-pressed", String(j === index)));
  }

  /** Force un rafraîchissement à la prochaine image. */
  refreshSoon(): void {
    this.timer = 0;
  }

  /** Estompe le bandeau d'aide quelques secondes après la première interaction. */
  hideHintLater(): void {
    if (this.hintHidden) return;
    this.hintHidden = true;
    setTimeout(() => { byId("hint").style.opacity = "0"; }, 4000);
  }

  /**
   * Tableau (seulement s'il est ouvert) : l'état de chaque robot, les destructions et morts de sa
   * place (les meilleures en haut de leur équipe), le score ; `stats` : blocs détruits, corps
   * physiques, temps d'un pas (ms).
   */
  update(dt: number, world: World, stats: { destroyed: number; bodies: number; physMs: number; fps: number }): void {
    // Une nouvelle partie : les compteurs repartent de zéro
    if (world.match !== this.match) {
      this.match = world.match;
      this.seats = this.seats.filter((s) => s.bot);
      for (const seat of this.seats) seat.kills = seat.deaths = 0;
    }
    this.timer -= dt;
    if (!this.open || this.timer > 0) return;
    this.timer = REFRESH;

    const active = { red: 0, blue: 0 };
    for (const row of this.rows) {
      const { bot } = row;
      if (isOperational(bot)) active[bot.team]++;
      const hidden = !!this.detected && bot.cockpit.alive && !this.detected(bot);
      const [label, tone] = hidden ? [t("hud.tab.unseen"), "idle" as Tone] : [aiModeName(bot.ai.mode), MODE_TONES[bot.ai.mode]];
      row.chip.textContent = label;
      row.chip.className = tone ? `chip ${tone}` : "chip";
      row.button.classList.toggle("unseen", hidden);
      row.button.classList.toggle("mine", bot === world.player);
      const level = Math.round(100 * integrity(bot));
      row.bar.style.width = `${level}%`;
      row.pct.textContent = pct(level / 100);
      row.prop.textContent = hidden ? "" : propulsionLine(bot);
      row.button.classList.toggle("dead", !bot.cockpit.alive);
      const seat = this.seatOf.get(bot);
      row.kd.textContent = world.match && seat ? `${seat.kills} / ${seat.deaths}` : "";
    }
    // Les meilleures places en haut de leur équipe
    const rank = (r: BotRow): number => {
      const seat = this.seatOf.get(r.bot);
      return seat ? seat.kills * 100 - seat.deaths : 0;
    };
    for (const team of ["blue", "red"] as const) {
      const ul = byId(`team-${team}`);
      const sorted = this.rows.filter((r) => r.bot.team === team).sort((a, b) => rank(b) - rank(a));
      if (sorted.some((r, k) => ul.children[k] !== r.li)) ul.append(...sorted.map((r) => r.li));
      byId(`tab-count-${team}`).textContent = t("hud.tab.active", { n: active[team] });
      byId(`tab-score-${team}`).textContent = world.match ? String(Math.floor(world.match.score[team])) : "";
    }
    byId("s-alive").textContent = t("hud.tab.alive", { red: active.red, blue: active.blue });
    byId("s-destroyed").textContent = String(stats.destroyed);
    byId("s-bodies").textContent = String(stats.bodies);
    byId("s-phys").textContent = t("unit.ms", { v: fixed(stats.physMs, 2) });
    byId("s-fps").textContent = num(stats.fps);
  }

  /**
   * Un bouton par arme (celles du catalogue, ou celles du robot piloté), dans l'ordre des touches
   * 1, 2, … (au-delà de dix, Maj + chiffre), avec sa touche.
   */
  setArsenal(ids: readonly ArmId[]): void {
    const seg = byId("weapons");
    seg.textContent = "";
    this.arsenal = ids;
    ids.forEach((id) => {
      const button = document.createElement("button");
      button.id = `w-${id}`;
      button.dataset.w = id;
      button.setAttribute("aria-pressed", "false");
      // Sa touche (au-delà de dix armes, le catalogue entier : le bouton, plus petit, n'en montre pas)
      const key = document.createElement("kbd");
      const name = document.createElement("span");
      name.className = "wn";
      name.textContent = armName(id);
      const small = document.createElement("small");
      small.textContent = isMeleeId(id) ? meleeTag(meleeDef(id)) : weaponTagText(WEAPONS[id]);
      const meter = document.createElement("i");
      meter.className = "meter";
      button.append(key, name, small, meter);
      button.addEventListener("click", () => this.actions.selectWeapon(id));
      seg.append(button);
    });
    // Tout le catalogue (caméra libre) : des boutons plus petits, sur plusieurs rangs ; les touches
    // en choisissent dix, avec Maj dix de plus (les suivantes, au clic)
    seg.classList.toggle("many", ids.length > 10);
    this.refreshWeaponKeys();
  }

  /** Armes affichées, dans l'ordre des touches, et celle qui est choisie. */
  private arsenal: readonly ArmId[] = [];
  private selected: ArmId | null = null;
  /** Les robots du tableau et le robot du joueur (pour refaire le tableau dans une autre langue). */
  private listed: { bots: readonly Bot[]; player: Bot | null } = { bots: [], player: null };

  /**
   * La langue a changé : ce qui a été construit une fois (les lignes du tableau, la barre des armes)
   * se refait ; le reste se met à jour de lui-même à l'image suivante.
   */
  refreshTexts(): void {
    const selected = this.selected;
    this.setArsenal(this.arsenal);
    if (selected) this.showWeapon(selected);
    this.setEnemies(this.listed.bots, this.listed.player);
  }
  /** Nom de la touche de l'emplacement d'arme `slot` (0 : la première), choisie par le joueur. */
  weaponKey: (slot: number) => string = (slot) => String((slot + 1) % 10);

  /** Les touches des armes (les touches choisies ont changé, ou le clavier du joueur est connu). */
  refreshWeaponKeys(): void {
    const ids = this.arsenal;
    this.weaponButtons().forEach((button, i) => {
      const key = button.querySelector("kbd");
      if (key) key.textContent = i < 20 ? this.weaponKey(i) : "";
    });
    const k = this.weaponKey;
    const last = Math.min(ids.length, 10) - 1;
    const range = ids.length <= 1 ? k(0) : t("hud.keys.range", { from: k(0), to: k(last) });
    byId("weaponKeys").textContent = ids.length > 10 ? t("hud.keys.shift", { range, shift: t("key.mod.Shift"), from: k(0), to: k(Math.min(ids.length - 10, 10) - 1) }) : range;
  }

  private weaponButtons(): NodeListOf<HTMLButtonElement> {
    return document.querySelectorAll<HTMLButtonElement>("#weapons button");
  }
}
