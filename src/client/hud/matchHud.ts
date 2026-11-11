import { flareCapacity } from "../../shared/combat/decoys";
import { weaponDef, type KillCause } from "../../shared/catalog/weapons";
import { isStunned, localStuns } from "../../shared/combat/emp";
import { energyCapacity, energyFraction } from "../../shared/robot/energy";
import { integrity } from "../../shared/robot/queries";
import { RIGHTING_DELAY } from "../../shared/robot/righting";
import type { Bot, Team } from "../../shared/sim/entities";
import type { World } from "../../shared/sim/world";
import { byId } from "../dom";
import { TEAM_COLORS } from "../teams";
import { codeLabel } from "../input/bindings";
import { fixed, pct } from "../i18n/format";
import { measure, t } from "../i18n/i18n";
import { botName, causeName } from "../i18n/names";

/** Nombre de lignes du fil des destructions, et leur durée d'affichage (ms). */
const FEED_LINES = 5;
const FEED_TIME = 6000;

/** Le temps qui reste, à un dixième de seconde (« 2,3 s ») : il change à chaque image sans sauter. */
const tenths = (seconds: number): string => t("unit.s", { v: fixed(Math.max(0, seconds), 1) });

/**
 * Paralysie locale du robot piloté (lance électrique, shared/combat/emp.ts), en mots : ses organes
 * coupés (roues, du côté gauche ou droit, moteurs, tourelles, armes, appuis) et le temps qui reste ;
 * null s'il n'y en a pas.
 */
function localStunNote(sim: World, bot: Bot): string | null {
  const { blocks, wheels, until } = localStuns(sim, bot);
  if (!blocks.length && !wheels.length) return null;
  const parts: string[] = [];
  if (wheels.length) {
    const sides = new Set(wheels.map((w) => w.side));
    const side = sides.size === 1 && !sides.has(0) ? (sides.has(1) ? "Left" : "Right") : "";
    parts.push(t(`hud.stun.wheels${side}`, { n: wheels.length }));
  }
  const organs = (has: (b: (typeof blocks)[number]) => boolean, key: "thrusters" | "turrets" | "melee" | "supports" | "shields"): void => {
    const n = blocks.filter(has).length;
    if (n) parts.push(t(`hud.stun.${key}`, { n }));
  };
  organs((b) => bot.thrusters.some((t) => t.block === b), "thrusters");
  organs((b) => bot.turrets.some((t) => t.block === b), "turrets");
  organs((b) => bot.melee.some((m) => m.block === b), "melee");
  organs((b) => bot.supports.some((s) => s.block === b), "supports");
  organs((b) => bot.shields.includes(b), "shields");
  if (!parts.length) return null;
  return t("hud.stun.note", { organs: parts.join(", "), time: tenths(until - sim.time) });
}

/**
 * Une ligne du fil faite d'un message et d'éléments (les noms aux couleurs des équipes) : chaque
 * `{nom}` du message reçoit son élément, à sa place dans la phrase (elle change d'une langue à l'autre).
 */
function compose(text: (marks: Record<string, string>) => string, nodes: Record<string, Node>): (string | Node)[] {
  const marks = Object.fromEntries(Object.keys(nodes).map((k) => [k, `\u0001${k}\u0001`]));
  return text(marks).split(/\u0001(\w+)\u0001/).map((piece, i) => (i % 2 ? nodes[piece] : piece)).filter((piece) => piece !== "");
}

const clock = (seconds: number): string => {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * HUD d'une partie : score et temps restant en haut, fil des destructions dessous, et l'état du
 * robot du joueur en bas (structure, énergie, paralysie, réapparition).
 */
export class MatchHud {
  private readonly feed = byId("killfeed");
  /** Roi de la colline : la zone en jeu à la dernière mise à jour (-1 : pas de colline). */
  private hill = -1;
  /** Nom de la touche pour se saborder (choisie par le joueur : ArenaGame la donne). */
  selfDestructKey: () => string = () => codeLabel("Backspace");

  /** Met à jour le score, le temps, et l'état du robot du joueur. */
  update(sim: World): void {
    const match = sim.match;
    byId("scoreboard").hidden = !match;
    if (match) {
      byId("score-blue").textContent = String(Math.floor(match.score.blue));
      byId("score-red").textContent = String(Math.floor(match.score.red));
      const left = match.rules.timeLimit ? match.rules.timeLimit - match.elapsed : match.elapsed;
      byId("match-clock").textContent = clock(left);
      this.showZones(sim);
    }
    this.showPlayer(sim, sim.player);
  }

  /** Ajoute une ligne au fil des destructions : « tueur [arme] victime », aux couleurs des équipes. */
  onKill(victim: Bot, killer: Bot | null, cause: KillCause | null): void {
    const name = (bot: Bot): HTMLSpanElement => {
      const span = document.createElement("span");
      span.textContent = bot.controller === "player" ? t("hud.feed.you", { name: botName(bot.profile) }) : botName(bot.profile);
      span.style.color = TEAM_COLORS[bot.team];
      return span;
    };
    const how = document.createElement("span");
    how.className = "kf-cause";
    how.textContent = cause ? causeName(cause) : "✕";
    if (killer) this.addLine([name(killer), " ", how, " ", name(victim)]);
    else this.addLine(compose((m) => t("hud.feed.destroyed", { victim: m.victim, cause: m.cause }), { victim: name(victim), cause: how }));
  }

  private addLine(parts: (string | Node)[]): void {
    const li = document.createElement("li");
    li.append(...parts);
    this.feed.prepend(li);
    while (this.feed.children.length > FEED_LINES) this.feed.lastElementChild?.remove();
    setTimeout(() => li.classList.add("fade"), FEED_TIME);
    setTimeout(() => li.remove(), FEED_TIME + 700);
  }

  /** Une ligne de texte dans le fil. */
  note(text: string): void {
    this.addLine([text]);
  }

  /** Une zone change de mains : une ligne dans le fil (« Zone B prise par les bleus »). */
  onZone(label: string, owner: Team | null, by: Team): void {
    const team = document.createElement("span");
    team.textContent = t(`hud.feed.team.${by}`);
    team.style.color = TEAM_COLORS[by];
    this.addLine(compose((m) => t(owner ? "hud.feed.zoneTaken" : "hud.feed.zoneNeutralized", { zone: label, team: m.team }), { team }));
  }

  /** Pastilles des zones sous le score : la lettre, à la couleur de l'équipe qui la tient, et la prise en cours. */
  private showZones(sim: World): void {
    const box = byId("match-zones");
    const zones = sim.match?.zones ?? [];
    box.hidden = !zones.length;
    if (!zones.length) return;
    while (box.children.length < zones.length) box.append(document.createElement("i"));
    while (box.children.length > zones.length) box.lastElementChild?.remove();
    // Au roi de la colline, une ligne dans le fil quand la colline se déplace
    const hill = zones.filter((z) => z.active).length === 1 && zones.length > 1 ? zones.findIndex((z) => z.active) : -1;
    if (hill >= 0 && this.hill >= 0 && hill !== this.hill) this.addLine([t("hud.feed.hillMoves", { zone: sim.arena.zones[hill]?.label ?? "?" })]);
    this.hill = hill;
    zones.forEach((z, i) => {
      const chip = box.children[i] as HTMLElement;
      chip.classList.toggle("inactive", !z.active);
      chip.textContent = sim.arena.zones[i]?.label ?? "?";
      chip.dataset.owner = z.owner ?? "";
      chip.classList.toggle("contested", z.contested);
      chip.style.setProperty("--progress", String(Math.abs(z.progress)));
      chip.style.setProperty("--toward", z.progress > 0 ? TEAM_COLORS.blue : TEAM_COLORS.red);
    });
  }

  clearFeed(): void {
    this.feed.textContent = "";
  }

  private showPlayer(sim: World, bot: Bot | null): void {
    const panel = byId("playerStatus");
    panel.hidden = !bot;
    if (!bot) return;
    byId("st-name").textContent = botName(bot.profile);
    const alive = bot.cockpit.alive;
    const level = alive ? Math.round(100 * integrity(bot)) : 0;
    byId("st-integrity").style.width = `${level}%`;
    byId("st-integrity-pct").textContent = pct(level / 100);
    const flies = bot.thrusters.length > 0 || bot.supports.length > 0;
    // (une arme de contact puise aussi dans les batteries : un rotor qui monte en régime, un vérin)
    const powered = flies || bot.shields.length > 0 || bot.melee.length > 0 || bot.turrets.some((t) => weaponDef(t.weapon).power);
    byId("st-energy-row").hidden = !powered || energyCapacity(bot) === 0;
    const energy = Math.round(100 * energyFraction(bot));
    byId("st-energy").style.width = `${energy}%`;
    byId("st-energy-pct").textContent = pct(energy / 100);
    // Lance-leurres : une pastille par salve, pleine si elle est prête
    const capacity = alive ? flareCapacity(bot) : 0;
    byId("st-flares-row").hidden = capacity === 0;
    const pips = byId("st-flares");
    if (pips.childElementCount !== capacity) pips.replaceChildren(...Array.from({ length: capacity }, () => document.createElement("i")));
    [...pips.children].forEach((pip, i) => pip.classList.toggle("full", i < bot.flares.charges));

    let mode = "";
    let note = "";
    let shock: string | null = null;
    if (!alive) {
      mode = t("hud.status.destroyed");
      const by = bot.lastAttacker ? t("hud.status.destroyedBy", { killer: botName(bot.lastAttacker.profile) }) : mode;
      const respawn = sim.match?.respawns.find((r) => r.bot === bot);
      note = respawn ? `${by} · ${t("hud.status.respawnIn", { time: measure(Math.max(0, Math.ceil(respawn.at - sim.time)), "s") })}` : by;
    } else if (isStunned(sim, bot)) {
      mode = t("hud.status.stunned");
      note = t("hud.status.emp");
    } else if ((shock = localStunNote(sim, bot))) {
      mode = t("hud.status.shortCircuit");
      note = shock;
    } else if (bot.righting > 0) {
      mode = t("hud.status.righting");
      note = t("hud.status.rightingNote");
    } else if (bot.ai.mode === "flipped") {
      mode = t("hud.status.flipped");
      note = t("hud.status.flippedNote", { time: measure(Math.max(0, Math.ceil(RIGHTING_DELAY - bot.flippedFor)), "s"), key: this.selfDestructKey() });
    } else if (energy < 15 && flies) {
      note = t("hud.status.lowBattery");
    }
    const chip = byId("st-mode");
    chip.textContent = mode;
    chip.hidden = !mode;
    chip.className = mode ? "chip bad" : "chip";
    byId("st-note").textContent = note;
  }
}
