import { blockDef, BLOCK_TYPES, type BlockType, type LightColor, type LightPattern } from "../../shared/catalog/blocks";
import type { MeleeId } from "../../shared/catalog/melee";
import { propDef, type PropType } from "../../shared/catalog/props";
import { weaponDef, type MineWeaponId, type ProjectileSpec } from "../../shared/catalog/weapons";
import { BLOCK_SIZE, GRAVITY } from "../../shared/config";
import { organStunned } from "../../shared/combat/emp";
import { JET_NACELLE } from "../../shared/design/clearance";
import { add, qmul, qrot, scale, vec3, type Vec3 } from "../../shared/math/vec";
import { blockWorldPos, liveThrusters } from "../../shared/robot/queries";
import type { Barrier, Block, Bot, Prop, Team } from "../../shared/sim/entities";
import type { World } from "../../shared/sim/world";
import { TEAM_COLORS } from "../teams";
import type { LightRequest } from "./lightChoice";
import { LIGHT_LENSES } from "./models/lights";
import { blinkOn, MINE_MODELS } from "./models/mines";
import { isTracer } from "./tracers";

/*
 * Ce qui éclaire (sans Babylon : tests/nightLights.test.ts le lit dans Node). À chaque image,
 * `gatherLights` demande une lumière pour chaque source, d'après le monde affiché (la réplique
 * comprise) ; la réserve de lumières (render/nightLights.ts) allume les plus utiles. La nuit : les
 * lampadaires et les mâts d'éclairage debout, les phares et les balises des robots alimentés. Jour
 * et nuit, si les lumières dynamiques sont permises (réglage « Lumières dynamiques », `Settings.lights`) : les
 * projectiles qui brillent (missiles, roquettes, traçantes, plasma, laser, leurres…), les voyants
 * des mines posées, les feux (blocs, bois, flaques), les flammes des moteurs, la lueur des patins,
 * les armes d'énergie et les murs d'énergie. Les éclairs (explosions, coups de feu) sont demandés à
 * part, par render/lighting.ts.
 */

type Rgb = readonly [number, number, number];
/** Une couleur « #rrggbb » en trois nombres de 0 à 1. */
const rgb = (hex: string): Rgb => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];

// --- Ce qui éclaire ---

/**
 * Lampes du décor (la nuit) : la place de l'ampoule dans le repère de l'accessoire debout (son +x,
 * le bras), la direction de son cône, son angle total (rad), sa portée (m), sa force et sa couleur.
 * Un lampadaire éclaire sous lui un grand disque ; un mât d'éclairage, loin devant lui.
 */
interface PropLight {
  at: Vec3;
  dir: Vec3;
  angle: number;
  range: number;
  intensity: number;
  color: Rgb;
  /** Longueur du cône de lumière visible dans l'air (m). */
  beam: number;
}
const PROP_LIGHTS: Partial<Record<PropType, PropLight>> = {
  // (une portée courte : ces lumières ne font pas d'ombre, et celle d'un lampadaire de la voie rapide passerait à travers le tablier jusqu'à la rue)
  lamppost: { at: vec3(1.15, 2.9, 0), dir: vec3(0.12, -1, 0), angle: 2.3, range: 12, intensity: 2.8, color: rgb("#ffc98a"), beam: 6.5 },
  floodlight: { at: vec3(0.45, 4.3, 0), dir: vec3(0.78, -0.62, 0), angle: 1.5, range: 36, intensity: 1.1, color: rgb("#eef3ff"), beam: 15 },
};
/** Une lampe sous cette part de ses points vacille ; couchée (son haut à plus de 25° de la verticale), elle est éteinte. */
const FLICKER_BELOW = 0.5;
const UPRIGHT = Math.cos(0.45);

/** Phare d'un robot : sa force, la longueur visible de son cône (m) ; gyrophare : de même. */
const HEADLIGHT = { intensity: 1.9, beam: 9 };
const SWEEP = { intensity: 2.2, beam: 7, period: 0.9, tilt: 0.22 };
/** Force des feux d'un robot selon leur rythme (au plus fort de leur battement). */
const LAMP_INTENSITY: Record<LightPattern, number> = { steady: 0.6, pulse: 0.9, beacon: 1.4, strobe: 2.6, wigwag: 1.8, rotate: SWEEP.intensity };

/** Les couleurs des lumières de robot (TypeScript refuse une couleur sans la sienne). */
const LIGHT_COLORS: Record<Exclude<LightColor, "team" | "side" | "police">, string> = {
  warm: "#fff1d6", white: "#f4f8ff", red: "#ff2a1e", amber: "#ffa018", blue: "#2f78ff",
};
/** Feux de position : rouge à gauche du robot (+x), vert à droite, blanc au milieu ; rampe de police : bleu, puis rouge. */
const SIDE = { left: "#ff2a1e", right: "#1eff5a", middle: "#f4f8ff" } as const;
const POLICE = ["#2f78ff", "#ff2a1e"] as const;

/**
 * Les couleurs des feux d'un bloc à lumière, une par verre (`LIGHT_LENSES` : une rampe de police en
 * a deux ; le miroir d'un gyrophare a celle de son dôme). `x` : sa case (son côté du robot).
 */
export function lampColors(type: BlockType, x: number, team: Team): string[] {
  const spec = blockDef(type).light;
  if (!spec) return [];
  const count = LIGHT_LENSES[type]?.length ?? 1;
  const one = spec.color === "team" ? TEAM_COLORS[team] : spec.color === "side" ? (x > 0 ? SIDE.left : x < 0 ? SIDE.right : SIDE.middle) : spec.color === "police" ? null : LIGHT_COLORS[spec.color];
  return Array.from({ length: count }, (_, i) => one ?? POLICE[i] ?? POLICE[0]);
}

/**
 * La force de chaque feu d'un bloc à l'instant `t` (le temps du monde, s : la réplique a le même),
 * de 0 à 1, au rythme de sa lumière ; `id` décale les blocs (deux feux ne battent pas ensemble).
 * Une rampe de police en a deux, en alternance ; les autres, un.
 */
export function lampLevels(pattern: LightPattern, t: number, id: number): number[] {
  const phase = (period: number): number => {
    const x = t / period + id * 0.1373;
    return x - Math.floor(x);
  };
  switch (pattern) {
    case "steady":
    case "rotate":
      return [1];
    case "pulse":
      return [0.75 + 0.25 * Math.sin(t * 3 + id)];
    case "beacon": {
      // Un feu qui tourne : un éclat bref par tour
      const c = Math.cos(phase(1) * Math.PI * 2);
      return [c > 0 ? c ** 8 : 0];
    }
    case "strobe": {
      // Un double éclat
      const f = phase(1.2);
      return [f < 0.04 || (f > 0.11 && f < 0.15) ? 1 : 0];
    }
    case "wigwag": {
      // Trois éclats d'un feu, puis trois de l'autre
      const f = phase(0.9) * 2;
      const half = Math.floor(f);
      const flash = (f - half) * 3;
      const on = flash - Math.floor(flash) < 0.55 ? 1 : 0;
      return half === 0 ? [on, 0] : [0, on];
    }
  }
}

/** Angle (rad) du cône d'un gyrophare autour du haut de son bloc, à l'instant `t`. */
export const sweepAngle = (t: number, id: number): number => (t / SWEEP.period) * Math.PI * 2 + id * 1.7;

/** La direction du cône d'un gyrophare dans le repère de son bloc : il tourne, un peu penché vers le bas. */
export function sweepDirection(t: number, id: number): Vec3 {
  const a = sweepAngle(t, id);
  const k = 1 / Math.hypot(1, SWEEP.tilt);
  return vec3(Math.cos(a) * k, -SWEEP.tilt * k, Math.sin(a) * k);
}

/**
 * Ce qui brille en vol, par allure de projectile (TypeScript refuse une allure sans sa ligne) :
 * couleur, force, portée ; null : rien (une balle, un obus, une bombe ne brillent pas). Une balle de
 * fusil traçante brille (de la couleur de l'équipe) ; une mine posée, son voyant, quand il clignote.
 */
type ProjectileLook = ProjectileSpec["look"];
const PROJECTILE_LIGHTS: Record<ProjectileLook, { color: Rgb; intensity: number; range: number } | null> = {
  bullet: { color: rgb("#ffd890"), intensity: 0.55, range: 4.5 },
  pellet: null,
  shell: null,
  missile: { color: rgb("#ffb070"), intensity: 1.4, range: 9 },
  rocket: { color: rgb("#ffbf70"), intensity: 1, range: 6 },
  warhead: { color: rgb("#ffb060"), intensity: 1.8, range: 12 },
  mine: { color: rgb("#ff3b30"), intensity: 0.9, range: 2.6 },
  bomb: null,
  flame: { color: rgb("#ff8a2a"), intensity: 1.3, range: 6.5 },
  plasma: { color: rgb("#c77dff"), intensity: 1.1, range: 6 },
  orb: { color: rgb("#7fd8ff"), intensity: 1, range: 7 },
  grenade: null,
  beam: { color: rgb("#ff4d5e"), intensity: 0.9, range: 5 },
  rail: { color: rgb("#9fe3ff"), intensity: 1.2, range: 6 },
  repair: { color: rgb("#7fffb0"), intensity: 0.6, range: 4 },
  flare: { color: rgb("#ff8a4a"), intensity: 2.4, range: 16 },
  nanites: { color: rgb("#b8ffcf"), intensity: 0.6, range: 4 },
  barrier: { color: rgb("#8fd0ff"), intensity: 0.7, range: 5 },
};
/** Du jet du lance-flammes, une boule sur tant éclaire (il en crache des dizaines par seconde). */
const FLAME_EVERY = 3;

/** Feu : un bloc, un accessoire en bois, une flaque (couleur, force ; la portée suit sa taille). */
const FIRE = { color: rgb("#ff8a3a"), intensity: 1.2 };
/** Flamme d'un moteur (réacteur, propulseur ; turboréacteur, plus grande) et lueur d'un patin. */
const ENGINE_FLAME = { color: rgb("#ff9c4a"), jet: rgb("#ffc08a") };
const HOVER_GLOW = { color: rgb("#5fe0ff"), intensity: 0.55, range: 3.2 };
/** Les armes d'énergie, quand elles brillent : la lame allumée, le fouet qui claque, la lance chargée, le champ armé. */
const MELEE_LIGHTS: Partial<Record<MeleeId, { color: Rgb; intensity: number; range: number }>> = {
  laserBlade: { color: rgb("#46d6ff"), intensity: 1.2, range: 6 },
  plasmaWhip: { color: rgb("#d070ff"), intensity: 1.1, range: 6 },
  shockLance: { color: rgb("#8fd0ff"), intensity: 0.6, range: 3 },
  crusherField: { color: rgb("#9a7cff"), intensity: 0.7, range: 5 },
};
/** Un mur d'énergie luit de la couleur de son équipe. */
const BARRIER_LIGHT = { intensity: 0.7, range: 7 };

/** Ce que voient les sources de lumière à cette image. */
export interface LightContext {
  readonly world: World;
  /** La nuit : les lampes et les phares s'allument. */
  readonly night: boolean;
  /** Les lumières dynamiques (projectiles, feux, moteurs…) sont permises. */
  readonly effects: boolean;
  /** Heure de la page (s), pour ce qui bat. */
  readonly now: number;
  /** Les murs d'énergie déployés (suivis par leurs événements). */
  readonly barriers: Iterable<Barrier>;
  /** Les blocs en feu (suivis par leurs événements). */
  readonly burning: Iterable<Block>;
}

/** Une demande de lumière ponctuelle ou en cône. */
function request(out: LightRequest[], key: unknown, at: Vec3, color: Rgb, intensity: number, range: number, dir?: Vec3, angle?: number, beam?: number): void {
  out.push({ key, x: at.x, y: at.y, z: at.z, r: color[0], g: color[1], b: color[2], intensity, range, dir, angle, beam });
}

/** Tout ce qui éclaire, à cette image. */
export function gatherLights(c: LightContext, out: LightRequest[]): void {
  const world = c.world;
  if (c.night) {
    for (const prop of world.props) propLight(prop, c.now, out);
    for (const bot of world.bots) botLights(c, bot, out);
  }
  if (!c.effects) return;
  for (const p of world.projectiles) {
    const look = weaponDef(p.weapon).projectile.look;
    const spec = PROJECTILE_LIGHTS[look];
    if (!spec) continue;
    if (look === "bullet" && !isTracer(p)) continue;
    if (look === "flame" && p.id % FLAME_EVERY !== 0) continue;
    if (look === "mine") {
      // Le voyant d'une mine posée, quand il clignote
      const model = MINE_MODELS[p.weapon as MineWeaponId];
      if (!model || !(p.landed || p.stuck) || !blinkOn(model.light.blink, world.time, p.id)) continue;
      request(out, p, add(p.pos, vec3(0, 0.25, 0)), rgb(model.light.color), spec.intensity, spec.range);
      continue;
    }
    const color = look === "bullet" && p.shooter ? brighten(TEAM_COLORS[p.shooter.team]) : spec.color;
    // (le lance-flammes : une boule de plus en plus faible)
    const fade = look === "flame" ? Math.max(0.2, 1 - p.age / weaponDef(p.weapon).projectile.life) : 1;
    request(out, p, p.pos, color, spec.intensity * fade, spec.range);
  }
  // Les feux
  for (const block of c.burning) {
    if (!block.alive) continue;
    const flick = 0.85 + 0.2 * Math.sin(c.now * 17 + block.id) + 0.1 * Math.sin(c.now * 31 + block.id * 1.7);
    request(out, block, add(blockWorldPos(block), vec3(0, 0.45, 0)), FIRE.color, FIRE.intensity * flick, 6);
  }
  for (const prop of world.props) {
    if (prop.burn <= 0) continue;
    const at = prop.rb.translation();
    const size = Math.max(prop.half.x, prop.half.z, 1);
    // (une clé qui reste la même d'une image à l'autre : l'accessoire est déjà celle de sa lampe)
    request(out, `fire:${prop.id}`, add(at, vec3(0, prop.half.y * 0.6, 0)), FIRE.color, (FIRE.intensity + 0.3) * (0.9 + 0.15 * Math.sin(c.now * 13 + prop.id)), 5 + size * 2.5);
  }
  for (const fire of world.groundFires) {
    request(out, fire, add(fire.pos, vec3(0, 0.6, 0)), FIRE.color, FIRE.intensity * (0.9 + 0.12 * Math.sin(c.now * 15 + fire.pos.x)), 3 + fire.radius * 2.5);
  }
  // Les murs d'énergie
  for (const b of c.barriers) {
    if (b.until < world.time) continue;
    request(out, b, add(b.center, scale(b.normal, -0.4)), rgb(TEAM_COLORS[b.team]), BARRIER_LIGHT.intensity, BARRIER_LIGHT.range);
  }
  // Ce qui brille sur les robots : flammes des moteurs, patins, armes d'énergie
  for (const bot of world.bots) robotGlow(bot, out);
}

/** Une couleur d'équipe éclaircie (une traçante). */
function brighten(hex: string): Rgb {
  const [r, g, b] = rgb(hex);
  return [r + (1 - r) * 0.45, g + (1 - g) * 0.45, b + (1 - b) * 0.45];
}

/** Lampadaire, mât d'éclairage : debout et entier, il éclaire ; abîmé, il vacille ; couché, il est éteint. */
function propLight(prop: Prop, now: number, out: LightRequest[]): void {
  const spec = PROP_LIGHTS[prop.type];
  if (!spec || prop.state.kind !== "intact") return;
  const q = prop.rb.rotation();
  if (qrot(q, vec3(0, 1, 0)).y < UPRIGHT) return;
  // (un mât d'éclairage plus grand que nature : ses cotes à son échelle)
  const shape = propDef(prop.type).shape;
  const k = shape.kind === "cylinder" ? prop.half.y / shape.halfHeight : 1;
  const at = add(prop.rb.translation(), qrot(q, scale(spec.at, k)));
  const health = prop.hp / Math.max(1, propDef(prop.type).hp);
  let intensity = spec.intensity;
  if (health < FLICKER_BELOW) {
    const buzz = Math.sin(now * 23 + prop.id * 3.1) * Math.sin(now * 7.3 + prop.id);
    intensity *= buzz > 0.55 ? 0.15 : 1;
  }
  request(out, prop, at, spec.color, intensity, spec.range * k, qrot(q, spec.dir), spec.angle, intensity > 0.5 ? spec.beam * k : undefined);
}

/**
 * Les lumières d'un robot (phares, balises, feux d'avion, gyrophares, rampes de police) : alimentées
 * (reliées au cockpit, ni le bloc ni le robot paralysés), elles éclairent, à leur rythme. Un phare
 * éclaire en cône devant lui, un gyrophare en cône qui tourne, les autres tout autour, depuis leur
 * verre ; un éclat s'allume d'un coup (`sudden`).
 */
function botLights(c: LightContext, bot: Bot, out: LightRequest[]): void {
  if (!bot.lights.length || !bot.cockpit.alive) return;
  for (const block of bot.lights) {
    if (!lightPowered(c.world, block)) continue;
    const spec = blockDef(block.type).light!;
    const q = qmul(block.part.rb.rotation(), block.rot);
    const up = qrot(q, vec3(0, 1, 0));
    const at = blockWorldPos(block);
    const colors = lampColors(block.type, block.x, bot.team);
    if (spec.kind === "spot") {
      request(out, block, add(at, scale(up, BLOCK_SIZE / 2 + 0.05)), rgb(colors[0]), HEADLIGHT.intensity, spec.range, up, spec.cone ?? 1, HEADLIGHT.beam);
      continue;
    }
    const lenses = LIGHT_LENSES[block.type] ?? [];
    if (spec.kind === "sweep") {
      const from = add(at, qrot(q, vec3(...(lenses[0]?.at ?? [0, 0, 0]))));
      request(out, block, add(from, scale(up, 0.08)), rgb(colors[0]), SWEEP.intensity, spec.range, qrot(q, sweepDirection(c.world.time, block.id)), spec.cone ?? 0.7, SWEEP.beam);
      continue;
    }
    const levels = lampLevels(spec.pattern, c.world.time, block.id);
    const sudden = spec.pattern !== "steady" && spec.pattern !== "pulse";
    levels.forEach((level, i) => {
      if (level < 0.02) return;
      const lens = lenses[i];
      const from = add(at, qrot(q, lens ? vec3(lens.at[0], lens.at[1] + lens.size[1] / 2, lens.at[2]) : vec3(0, 0.15, 0)));
      // (une clé stable par feu : le bloc pour le premier, un texte pour le second)
      const key = i === 0 ? block : `lamp:${block.id}:${i}`;
      out.push({ ...lightAt(key, add(from, scale(up, 0.05)), rgb(colors[i] ?? colors[0]), LAMP_INTENSITY[spec.pattern] * level, spec.range), sudden });
    });
  }
}

/** Une demande de lumière ponctuelle. */
const lightAt = (key: unknown, at: Vec3, color: Rgb, intensity: number, range: number): LightRequest =>
  ({ key, x: at.x, y: at.y, z: at.z, r: color[0], g: color[1], b: color[2], intensity, range });

/** Les types de blocs qui portent une lumière. */
export const LIGHT_BLOCKS = (Object.keys(BLOCK_TYPES) as BlockType[]).filter((type) => !!blockDef(type).light);

/** Une lumière de robot (phare, balise) est-elle alimentée ? Reliée au cockpit, ni elle ni son robot paralysés. */
export function lightPowered(world: World, block: Block): boolean {
  const bot = block.bot;
  return block.alive && bot.cockpit.alive && block.part === bot.cockpit.part && !organStunned(world, block);
}

/** Flammes des moteurs qui poussent, lueur des patins qui portent, armes d'énergie qui brillent. */
function robotGlow(bot: Bot, out: LightRequest[]): void {
  if (!bot.cockpit.alive) return;
  for (const t of liveThrusters(bot)) {
    const spec = blockDef(t.block.type).thruster;
    if (!spec || spec.look === "rotor" || spec.look === "propeller" || t.role === "trim") continue;
    const ratio = Math.min(1, t.thrust / (spec.maxThrust || 1));
    if (ratio < 0.08) continue;
    const jet = spec.look === "jet";
    const q = qmul(t.block.part.rb.rotation(), t.block.rot);
    const down = qrot(q, vec3(0, -1, 0));
    const nozzle = jet ? JET_NACELLE.nozzle : BLOCK_SIZE / 2;
    const at = add(blockWorldPos(t.block), scale(down, nozzle + (jet ? 0.9 : 0.4) * ratio));
    request(out, t, at, jet ? ENGINE_FLAME.jet : ENGINE_FLAME.color, 0.45 + 1.1 * ratio, (jet ? 5 : 3) + (jet ? 9 : 5) * ratio);
  }
  for (const s of bot.supports) {
    const spec = blockDef(s.block.type).support;
    if (spec?.kind !== "hover" || !s.block.alive || s.block.part !== bot.cockpit.part) continue;
    const load = Math.min(1.5, s.force / (spec.ratedLoad * GRAVITY));
    if (load < 0.05) continue;
    const q = qmul(s.block.part.rb.rotation(), s.block.rot);
    request(out, s, add(blockWorldPos(s.block), qrot(q, vec3(0, -BLOCK_SIZE / 2 - 0.2, 0))), HOVER_GLOW.color, HOVER_GLOW.intensity * Math.min(1, 0.4 + load), HOVER_GLOW.range);
  }
  for (const arm of bot.melee) {
    const spec = MELEE_LIGHTS[arm.weapon];
    if (!spec || !arm.block.alive) continue;
    const lit = arm.weapon === "plasmaWhip" ? arm.phase === "strike" : arm.weapon === "shockLance" ? arm.phase !== "recover" : arm.spin > 0.5;
    if (!lit) continue;
    request(out, arm, add(blockWorldPos(arm.block), vec3(0, 0.4, 0)), spec.color, spec.intensity, spec.range);
  }
}

