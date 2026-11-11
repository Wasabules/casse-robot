import { groundLevel, spawnLineOf, spawnPoint } from "../arena/layout";
import { passable } from "../arena/navgrid";
import { resetProps } from "../arena/props";
import { clearDebris } from "../combat/debris";
import { propHalf } from "../catalog/props";
import type { BotProfile } from "../design/presets";
import { clamp, rand } from "../math/scalar";
import { vec3 } from "../math/vec";
import { designRadius, groundHeight, removeBot, setBotVelocity, spawnBot } from "../robot/lifecycle";
import type { Bot, Team } from "./entities";
import type { Simulation } from "./simulation";

/**
 * Cercles sur lesquels les robots apparaissent, en part de la ligne de départ de l'arène
 * (`bounds.spawnLine`) : le premier, puis des cercles intérieurs s'il est plein, et en dernier
 * recours un cercle près des murs (sans lui, une très grande vague posait ses derniers robots à
 * cheval sur leurs voisins). Dans les petites arènes : 23, 15, 8 et 30 m.
 */
const SPAWN_RINGS = [0.8, 0.52, 0.28, 1.03];
/** Altitude d'apparition des robots à rotors, et des avions, au-dessus du sol (m). */
const HOVER_SPAWN_Y = 5;
const PLANE_SPAWN_Y = 12;
/** Écart minimal entre deux robots, ou entre un robot et le décor, à l'apparition (m). */
const SPAWN_CLEARANCE = 1;
/** Écart minimal entre un robot et le centre d'un accessoire, à l'apparition (m). */
const PROP_CLEARANCE = 1.5;
/** Marge aux extrémités du demi-cercle d'une équipe (rad) : les deux camps ne se touchent pas. */
const SIDE_MARGIN = 0.35;

/** Robot à faire apparaître, et son équipe. */
export interface WaveEntry {
  profile: BotProfile;
  team: Team;
}

interface Spot {
  x: number;
  z: number;
  r: number;
}

/** Vide l'arène : robots, débris, projectiles, fumées, murs d'énergie ; remet les accessoires en place. */
function clearArena(sim: Simulation): void {
  for (const bot of sim.bots) removeBot(sim, bot);
  sim.bots = [];
  clearDebris(sim);
  sim.destroyedCount = 0;
  for (const p of sim.projectiles) {
    p.done = true;
    sim.emit({ type: "projectileRemoved", projectile: p });
  }
  sim.projectiles = [];
  for (const cloud of sim.smokes) sim.emit({ type: "smokeRemoved", cloud });
  sim.smokes = [];
  for (const barrier of sim.barriers) sim.emit({ type: "barrierRemoved", barrier, broken: false });
  sim.barriers = [];
  resetProps(sim);
}

/**
 * Vide l'arène, remet les accessoires en place et fait apparaître les robots en cercle, chacun à la
 * première place libre (loin du décor, des caisses et des autres robots). Les équipes alternent
 * autour du cercle. Les avions apparaissent en vol sur leur circuit, déjà lancés à leur vitesse
 * de croisière.
 */
export function spawnWave(sim: Simulation, profiles: readonly BotProfile[]): void {
  clearArena(sim);
  const planes = profiles.filter((p) => p.mobility === "plane");
  const others = profiles.filter((p) => p.mobility !== "plane");
  const placed: Spot[] = [];
  others.forEach((profile, i) => {
    const bot = placeOnCircle(sim, profile, i % 2 ? "blue" : "red", (i / others.length) * Math.PI * 2 + 0.3, placed);
    sim.bots.push(bot);
  });
  planes.forEach((profile, i) => sim.bots.push(launchPlane(sim, profile, i % 2 ? "red" : "blue", (i / planes.length) * Math.PI * 2 + 0.3)));
}

/**
 * Vide l'arène et fait apparaître deux équipes, chacune sur sa ligne de départ : les bleus au sud
 * (z < 0), les rouges au nord, ou là où la carte les a placées (`ArenaBounds.spawns`). Renvoie les
 * robots, dans l'ordre des entrées.
 */
export function spawnTeams(sim: Simulation, entries: readonly WaveEntry[]): Bot[] {
  clearArena(sim);
  const placed: Spot[] = [];
  const bots = entries.map((entry) => {
    const mates = entries.filter((e) => e.team === entry.team);
    const i = mates.indexOf(entry);
    return spawnOnSide(sim, entry.profile, entry.team, (i + 0.5) / mates.length, placed);
  });
  sim.bots.push(...bots);
  return bots;
}

/**
 * Nouveau robot de l'équipe `team`, à une place libre de son côté (réapparition en cours de
 * partie). L'appelant l'ajoute à `sim.bots`.
 */
export function respawnBot(sim: Simulation, profile: BotProfile, team: Team): Bot {
  const placed: Spot[] = sim.bots.filter((b) => b.cockpit.alive).map((b) => ({ x: b.lastPos.x, z: b.lastPos.z, r: b.radius }));
  return spawnOnSide(sim, profile, team, rand(0, 1), placed);
}

/**
 * Angle sur le cercle d'apparition (des avions), du côté de l'équipe : `t` de 0 à 1 le parcourt d'un
 * bout à l'autre. Le demi-cercle du sud pour les bleus, du nord pour les rouges ; celui qui fait face
 * à leur ligne de départ si elle est placée ailleurs (derrière elle, si elle passe par le centre).
 */
function sideAngle(sim: Simulation, team: Team, t: number): number {
  let from = team === "blue" ? Math.PI + SIDE_MARGIN : SIDE_MARGIN;
  if (sim.arena.bounds.spawns) {
    const line = spawnLineOf(sim.arena.bounds, team);
    const toward = Math.hypot(line.x, line.z) > 1 ? Math.atan2(line.z, line.x) : Math.atan2(-Math.cos(line.facing), -Math.sin(line.facing));
    from = toward - Math.PI / 2 + SIDE_MARGIN;
  }
  return from + t * (Math.PI - 2 * SIDE_MARGIN);
}

/** Robot de l'équipe `team` à la place `t` (de 0 à 1) de sa ligne de départ ; un avion, sur son circuit, de son côté. */
function spawnOnSide(sim: Simulation, profile: BotProfile, team: Team, t: number, placed: Spot[]): Bot {
  return profile.mobility === "plane" ? launchPlane(sim, profile, team, sideAngle(sim, team, t)) : placeInLine(sim, profile, team, t, placed);
}

/**
 * Un robot au sol (ou en vol stationnaire) sur la ligne de départ de son équipe, tourné comme elle
 * (face au camp adverse) : à la première place libre en partant de `t`, puis un rang plus en arrière
 * si la ligne est pleine.
 */
function placeInLine(sim: Simulation, profile: BotProfile, team: Team, t: number, placed: Spot[]): Bot {
  const r = designRadius(profile.design);
  const bounds = sim.arena.bounds;
  const line = spawnLineOf(bounds, team);
  const a0 = (t * 2 - 1) * line.spread;
  let { x, z } = spawnPoint(bounds, team, a0);
  search: for (const back of [0, 3, -3, 5]) {
    for (let k = 0; k < 40; k++) {
      ({ x, z } = spawnPoint(bounds, team, clamp(a0 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.6, -line.spread - 4, line.spread + 4), back));
      if (isClear(sim, x, z, r, placed)) break search;
    }
  }
  placed.push({ x, z, r });
  return spawnBot(sim, profile, vec3(x, spawnHeight(sim, profile, x, z, r), z), line.facing, team);
}

/** Un robot au sol (ou en vol stationnaire) à la première place libre du cercle, en partant de `start`. */
function placeOnCircle(sim: Simulation, profile: BotProfile, team: Team, start: number, placed: Spot[]): Bot {
  const r = designRadius(profile.design);
  let a = start;
  const rings = SPAWN_RINGS.map((f) => f * sim.arena.bounds.spawnLine);
  let radius = rings[0];
  // Le cercle plein (une grande vague), on passe sur un cercle intérieur
  search: for (const ring of rings) {
    for (let k = 0; k < 72; k++) {
      a = start + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.05;
      radius = ring;
      if (isClear(sim, Math.cos(a) * ring, Math.sin(a) * ring, r, placed)) break search;
    }
  }
  const x = Math.cos(a) * radius;
  const z = Math.sin(a) * radius;
  placed.push({ x, z, r });
  // Face à peu près tangente au cercle
  return spawnBot(sim, profile, vec3(x, spawnHeight(sim, profile, x, z, r), z), -a + Math.PI, team);
}

/**
 * Hauteur où poser un robot en (x, z) : au ras du sol (le point le plus haut du relief sous lui,
 * sans quoi il apparaîtrait enfoncé dans une pente), ou en vol stationnaire au-dessus.
 */
function spawnHeight(sim: Simulation, profile: BotProfile, x: number, z: number, r: number): number {
  let ground = groundLevel(sim.arena, x, z);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ground = Math.max(ground, groundLevel(sim.arena, x + Math.cos(a) * r, z + Math.sin(a) * r));
  }
  return ground + (profile.mobility === "hover" ? HOVER_SPAWN_Y : groundHeight(profile.design) + 0.03);
}

/** Un avion en vol sur son circuit, à l'angle `a`, face à la tangente, déjà à sa vitesse de croisière. */
function launchPlane(sim: Simulation, profile: BotProfile, team: Team, a: number): Bot {
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const R = sim.arena.bounds.circuit;
  const floor = sim.arena.bounds.airFloor ?? 0;
  const y = groundLevel(sim.arena, cos * R, sin * R) + Math.max(PLANE_SPAWN_Y, floor);
  const bot = spawnBot(sim, profile, vec3(cos * R, y, sin * R), -a, team);
  bot.ai.alt = Math.max(bot.ai.alt, floor);
  setBotVelocity(bot, vec3(-sin * profile.speed, 0, cos * profile.speed));
  return bot;
}

/**
 * Un disque de rayon `r` en (x, z) ne touche ni le décor (une piste, un pont, une voie ferrée, sur
 * lesquels on roule, ne comptent pas), ni un accessoire (un mur par son emprise), ni un robot déjà
 * placé, et l'IA peut y aller (arena/navgrid.ts : pas dans la lave ni dans la mer).
 */
function isClear(sim: Simulation, x: number, z: number, r: number, placed: readonly Spot[]): boolean {
  // Ni dans la lave, ni dans l'eau profonde, ni sur un flanc trop raide (arène à grille de passage)
  if (![[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]].every(([dx, dz]) => passable(sim.arena, x + dx, z + dz))) return false;
  for (const { kind, pos, half } of sim.arena.boxes) {
    if (kind === "road" || kind === "deck" || kind === "track") continue;
    const dx = x - clamp(x, pos.x - half.x, pos.x + half.x);
    const dz = z - clamp(z, pos.z - half.z, pos.z + half.z);
    if (Math.hypot(dx, dz) < r + SPAWN_CLEARANCE) return false;
  }
  for (const spot of sim.arena.props) {
    const { pos } = spot;
    const half = propHalf(spot.type, spot);
    // Emprise au sol d'un accessoire : un cercle de PROP_CLEARANCE pour les petits, son rectangle pour un mur
    // (celui d'une dalle tournée, un peu plus large)
    const reach = Math.hypot(half.x, half.z);
    const dx = Math.max(0, Math.abs(x - pos.x) - (spot.rot ? reach : half.x));
    const dz = Math.max(0, Math.abs(z - pos.z) - (spot.rot ? reach : half.z));
    if (Math.hypot(dx, dz) < r + PROP_CLEARANCE - 0.5) return false;
  }
  return placed.every((p) => Math.hypot(x - p.x, z - p.z) >= r + p.r + SPAWN_CLEARANCE);
}
