import { propDef } from "../../../shared/catalog/props";
import { BLOCK_SIZE } from "../../../shared/config";
import { add, cross, distance, dot, qrot, scale, sub, vec3, type Vec3 } from "../../../shared/math/vec";
import type { Block, GroundFire, Prop } from "../../../shared/sim/entities";
import { emissions, FX_RANGE, type FxContext, type FxSystem } from "./fx";
import { jitter } from "./layer";
import { surfaceAt } from "./marks";
import { FLAME_LEAN, FLAME_LEAN_MAX, type PuffSpec } from "./particles";
import { LiveSet } from "./tracking";

/*
 * Le feu du décor : le bois qui brûle (caisses, planches, toits, arbres) crache des flammes et une
 * colonne de fumée ; une flaque de feu (lance-flammes, napalm) brûle au ras du sol et roussit la
 * terre. Tout se lit sur le monde affiché (`prop.burn`, `world.groundFires`) : en réseau aussi.
 * Le bois noirci, lui, est dessiné par WorldView (une autre matière).
 */

/** Flamme : une lueur qui monte en rapetissant (en effets réalistes, une langue de feu qui ondule et refroidit). */
const FLAME: PuffSpec = { color: "#ff9a2e", kind: "fire", size: 0.5, grow: 0.1, life: 0.55, alpha: 0.72, gravity: -4, drag: 1.2, fadeIn: 0.12, heat: 0.85 };
/** Cœur de la flamme, jaune et bref ; langue rouge, plus haute. */
const FLAME_HOT: PuffSpec = { ...FLAME, color: "#ffe08a", size: 0.32, life: 0.38, alpha: 0.85, heat: 1 };
const FLAME_RED: PuffSpec = { ...FLAME, color: "#ff4d1a", size: 0.6, life: 0.7, alpha: 0.62, heat: 0.6 };
/** Fumée d'un bois qui brûle : sombre, épaisse, qui monte et s'étale. */
const WOOD_SMOKE: PuffSpec = { color: "#3b3835", kind: "smoke", size: 1, grow: 3.6, life: 5, alpha: 0.32, gravity: -0.9, drag: 0.6, fadeIn: 0.12 };
/** Braise qui s'envole. */
const EMBER: PuffSpec = { color: "#ffb347", kind: "glow", size: 0.07, life: 1.6, alpha: 0.95, gravity: -1.2, drag: 0.8, stretch: 0.04 };
/** Fumée d'une flaque : plus claire et plus basse. */
const PUDDLE_SMOKE: PuffSpec = { color: "#4a4540", kind: "smoke", size: 0.6, grow: 2.2, life: 2.6, alpha: 0.35, gravity: -1.1, drag: 0.8, fadeIn: 0.15 };
/** Terre roussie sous une flaque (disque au sol) : elle reste après l'extinction. */
const SCORCH = { color: "#1d1813", life: 45, alpha: 0.7, fade: 0.4 };

/**
 * Les flammes réalistes sont des langues qui ne remplissent pas leur sprite : elles sont plus
 * grandes que les lueurs des effets simples, pour un feu de la même taille.
 */
const flameScale = (ctx: FxContext): number => (ctx.look === "realistic" ? 1.45 : 1);

/** Flammes par seconde d'un accessoire en feu : selon sa taille (m², demi-côtés), dans ces bornes. */
const FLAMES_MIN = 16;
const FLAMES_MAX = 70;
/** Au-delà de cette distance (m), un feu émet deux fois moins (on ne distingue plus les flammes). */
const FAR = 60;

interface Burning {
  flames: { acc: number };
  smoke: { acc: number };
  embers: { acc: number };
}

/** Le feu du bois et des flaques. */
export function fireFx(ctx: FxContext): FxSystem {
  const burning = new Map<Prop, Burning>();
  const puddles = new Map<GroundFire, Burning>();
  const track = (prop: Prop): void => {
    if (prop.burn > 0 && !burning.has(prop)) burning.set(prop, { flames: { acc: 0 }, smoke: { acc: 0 }, embers: { acc: 0 } });
    if (prop.burn <= 0) burning.delete(prop);
  };
  const scorch = (fire: GroundFire): void => {
    const ground = surfaceAt(ctx.world.arena, fire.pos.x, fire.pos.z, fire.pos.y);
    ctx.marks.disc(ground?.point ?? fire.pos, ground?.normal ?? vec3(0, 1, 0), fire.radius * 1.05, SCORCH);
  };
  const light = (fire: GroundFire): void => {
    puddles.set(fire, { flames: { acc: 0 }, smoke: { acc: 0 }, embers: { acc: 0 } });
    scorch(fire);
  };
  // Ce qui brûle déjà (rattaché en cours de partie)
  for (const prop of ctx.world.props) track(prop);
  for (const fire of ctx.world.groundFires) light(fire);
  const off = ctx.world.on((e) => {
    if (e.type === "propFire") track(e.prop);
    else if (e.type === "propRemoved") burning.delete(e.prop);
    else if (e.type === "groundFireAdded") light(e.fire);
    else if (e.type === "groundFireRemoved") puddles.delete(e.fire);
  });

  return {
    update(dt) {
      for (const [prop, s] of burning) burnProp(ctx, prop, s, dt);
      for (const [fire, s] of puddles) burnPuddle(ctx, fire, s, dt);
    },
    dispose() {
      off();
      burning.clear();
      puddles.clear();
    },
  };
}

/**
 * Un point au hasard sur ce qui brûle (en coordonnées du monde) : la surface du feuillage d'un
 * arbre (le cône d'un sapin, la boule d'un chêne : des flammes nées dedans seraient cachées), ou
 * une face d'une caisse, d'un mur, d'un toit, plus souvent celle du haut.
 */
function pointOn(prop: Prop): Vec3 {
  const c = prop.rb.translation();
  const q = prop.rb.rotation();
  const h = prop.half;
  const shape = propDef(prop.type).shape;
  let local: Vec3;
  if (shape.kind === "cylinder") {
    const s = h.y / shape.halfHeight;
    const a = Math.random() * Math.PI * 2;
    if (prop.type === "oak") {
      // Boule de feuillage vers la cime (voir PropModels.tree), la moitié du haut surtout
      const up = jitter(-0.3, 1);
      const side = Math.sqrt(1 - up * up);
      const r = 2.5 * s * jitter(0.9, 1.05);
      local = vec3(Math.cos(a) * side * r, h.y * 0.75 + up * r, Math.sin(a) * side * r);
    } else if (prop.type === "palm") {
      // La couronne de palmes, en haut du stipe
      const r = 2.2 * s * Math.sqrt(Math.random());
      local = vec3(Math.cos(a) * r, h.y - r * 0.35 + jitter(-0.2, 0.3), Math.sin(a) * r);
    } else if (prop.type === "kapok") {
      // La cime en parasol : un disque large et plat au-dessus du tronc
      const r = 4.2 * s * Math.sqrt(Math.random());
      local = vec3(Math.cos(a) * r, h.y + jitter(-0.6, 1.3) * s, Math.sin(a) * r);
    } else {
      // Cône de branches, large en bas, pointu en haut
      const t = Math.random();
      const r = 2.2 * s * (1 - 0.85 * t) * jitter(0.85, 1.05);
      local = vec3(Math.cos(a) * r, h.y * (-0.25 + 1.3 * t), Math.sin(a) * r);
    }
  } else {
    // Une face : le dessus une fois sur deux, sinon un côté (la face mince d'un mur compte peu)
    local = vec3(jitter(-1, 1) * h.x, jitter(-1, 1) * h.y, jitter(-1, 1) * h.z);
    if (Math.random() < 0.5) local = vec3(local.x, h.y, local.z);
    else if (Math.random() < h.z / (h.x + h.z)) local = vec3(local.x, local.y, Math.sign(local.z || 1) * h.z);
    else local = vec3(Math.sign(local.x || 1) * h.x, local.y, local.z);
  }
  return add(c, qrot(q, local));
}

function burnProp(ctx: FxContext, prop: Prop, s: Burning, dt: number): void {
  const c = prop.rb.translation();
  const far = distance(c, ctx.eye);
  if (far > FX_RANGE + 40) return;
  const h = prop.half;
  const tree = propDef(prop.type).shape.kind === "cylinder";
  // Taille du feu : la plus grande face du bois (un arbre, son feuillage)
  const area = tree ? h.y * h.y * 0.5 : Math.max(h.x * h.y, h.y * h.z, h.x * h.z) * 4;
  const scale = Math.min(2.2, 0.7 + Math.sqrt(area) * 0.35);
  const thin = (far > FAR ? 0.5 : 1) * ctx.density;
  const rate = Math.min(FLAMES_MAX, FLAMES_MIN + area * 4.5) * thin;
  for (let i = emissions(s.flames, rate, dt); i > 0; i--) {
    const at = pointOn(prop);
    const spec = Math.random() < 0.3 ? FLAME_HOT : Math.random() < 0.5 ? FLAME_RED : FLAME;
    ctx.particles.emit(at, spec, vec3(jitter(-0.4, 0.4), jitter(0.5, 1.5), jitter(-0.4, 0.4)), scale * jitter(0.75, 1.2) * flameScale(ctx));
  }
  for (let i = emissions(s.smoke, (2 + area * 0.4) * thin, dt); i > 0; i--) {
    const at = pointOn(prop);
    const top = vec3(at.x, c.y + h.y * (tree ? 1 : 0.9), at.z);
    ctx.particles.emit(top, WOOD_SMOKE, vec3(jitter(-0.3, 0.3), jitter(0.8, 1.6), jitter(-0.3, 0.3)), scale * jitter(0.8, 1.3));
  }
  for (let i = emissions(s.embers, 3 * thin, dt); i > 0; i--) {
    ctx.particles.emit(pointOn(prop), EMBER, vec3(jitter(-1.5, 1.5), jitter(2, 5), jitter(-1.5, 1.5)));
  }
}

/**
 * Flammes d'un bloc en feu (effets réalistes : en effets simples, WorldView pose une flamme en
 * cônes sur le bloc). Le feu reste accroché au bloc : trois langues de feu (`Tongue`) reposées à
 * chaque image sur sa face libre la plus haute (`ParticleField.flame`), qui ondulent sur place (le
 * bruit de leur shader défile, leur taille bat) et se couchent à l'opposé de sa course quand le
 * robot roule ou vole ; des langues plus petites s'en détachent et montent, parties à la vitesse
 * du bloc (elles filent avec le robot, l'air les freine et les rabat derrière lui) ; une fumée
 * sombre régulière, d'autant plus serrée qu'il va vite (une traînée continue, pas des bouffées
 * éparses), et quelques braises. Il prend en un instant (`CATCH`) et retombe en s'éteignant
 * (`DIE`). Avant, chaque flamme était une particule lâchée dans le monde : elle restait sur place
 * quand le robot avançait, et le feu se voyait par à-coups, des images qui sautaient.
 *
 * Les blocs en feu se suivent par leurs événements (`fireStarted`, `fireEnded`, `blockDestroyed`) ;
 * leur pose et leur vitesse se lisent à travers `LiveSet` (jamais le corps d'un morceau retiré).
 */
interface Tongue {
  /** Sa place sur la face (repère du robot, avant d'être ramenée dans le plan de la face). */
  off: Vec3;
  /** Largeur (m) et hauteur (en part de sa largeur). */
  size: number;
  tall: number;
  heat: number;
  color: string;
  seed: number;
}

interface BlockFire {
  tongues: Tongue[];
  /** Faces libres du bloc (normales dans le repère du robot), revues de temps en temps (`FACES_EVERY`). */
  faces: Vec3[];
  facesAt: number;
  /** La face d'où montent les flammes (repère du robot). */
  face: Vec3;
  licks: { acc: number };
  smoke: { acc: number };
  embers: { acc: number };
  /** De 0 (rien) à 1 (il brûle) : il prend, puis retombe une fois éteint (`out`). */
  level: number;
  out: boolean;
  /** Couchée par la course (vers l'arrière, rapporté à sa hauteur), lissée d'une image à l'autre. */
  leanX: number;
  leanZ: number;
}

/** Les trois langues d'un bloc : la flamme, son cœur jaune et une langue rouge, plus haute. */
const TONGUES: readonly Omit<Tongue, "off" | "seed">[] = [
  { size: 0.38, tall: 1.2, heat: 0.85, color: "#ff8a24" },
  { size: 0.28, tall: 1, heat: 1, color: "#ffd27a" },
  { size: 0.32, tall: 1.45, heat: 0.6, color: "#ff4d1a" },
];
/** Écart de chaque langue au milieu de la face (m, au plus). */
const TONGUE_SPREAD = [0.1, 0.06, 0.14];
/** Hauteur de la base des langues au-dessus de la face (m) : son pied serait coupé net dans le bloc. */
const ROOT = 0.04;
/** Le feu prend en tant de secondes, et retombe en tant une fois éteint. */
const CATCH = 0.35;
const DIE = 0.6;
/** Les faces libres d'un bloc se revoient tous les tant (s) : un voisin détruit en libère une. */
const FACES_EVERY = 0.5;
/**
 * Les flammes changent de face quand une autre est plus haute de tant (en cosinus) : sans cette
 * marge, un robot qui penche à 45° les ferait sauter d'une face à l'autre à chaque image.
 */
const FACE_KEEP = 0.2;
/** Temps (s) pour que la flamme suive un changement de course (la vitesse lue en réseau est hachée). */
const LEAN_TIME = 0.12;
/** Elle s'allonge avec la vitesse : de tant par m/s, au plus `STRETCH_MAX`. */
const STRETCH = 0.035;
const STRETCH_MAX = 0.5;

/** Langue qui se détache et monte : petite, brève. */
const BLOCK_LICK: PuffSpec = { color: "#ff8a24", kind: "fire", size: 0.32, grow: 0.08, life: 0.42, alpha: 0.85, gravity: -3.4, drag: 1.4, fadeIn: 0.1, heat: 0.8 };
const BLOCK_LICK_HOT: PuffSpec = { ...BLOCK_LICK, color: "#ffd27a", size: 0.24, life: 0.3, alpha: 0.95, heat: 1 };
const BLOCK_SMOKE: PuffSpec = { color: "#2f2d2b", kind: "smoke", size: 0.3, grow: 1.5, life: 2, alpha: 0.36, fadeIn: 0.12, drag: 1, gravity: -1.2 };
/** Langues détachées et braises par seconde ; fumée : par seconde, plus une tous les `SMOKE_SPACING` m parcourus. */
const BLOCK_LICKS = 5;
const BLOCK_EMBERS = 1.2;
const BLOCK_SMOKES = 2.2;
const SMOKE_SPACING = 0.7;
const SMOKE_MAX = 12;
/** Part de la vitesse du bloc que gardent la fumée et les braises en partant. */
const SMOKE_CARRY = 0.6;
const EMBER_CARRY = 0.8;

const AXES: readonly Vec3[] = [vec3(1, 0, 0), vec3(-1, 0, 0), vec3(0, 1, 0), vec3(0, -1, 0), vec3(0, 0, 1), vec3(0, 0, -1)];

/** Les faces du bloc qu'aucun bloc de son robot ne couvre (toutes, s'il est enfoui : le feu sort quand même par le haut). */
function freeFaces(block: Block): Vec3[] {
  const blocks = block.bot.blocks;
  const free = AXES.filter((n) => !blocks.has(`${block.x + n.x},${block.y + n.y},${block.z + n.z}`));
  return free.length ? free : [AXES[2]];
}

/** Un battement qui ne se répète pas (somme de sinus de périodes sans commune mesure), de -1 à 1. */
function flicker(t: number, seed: number): number {
  return 0.5 * Math.sin(t * 7.1 + seed * 40) + 0.3 * Math.sin(t * 12.7 + seed * 23) + 0.2 * Math.sin(t * 19.3 + seed * 61);
}

export function blockFireFx(ctx: FxContext): FxSystem {
  const live = new LiveSet(ctx.world);
  const burning = new Map<Block, BlockFire>();
  const light = (block: Block): void => {
    if (!block.alive) return;
    const lit = burning.get(block);
    if (lit) {
      lit.out = false;
      return;
    }
    const tongues = TONGUES.map((t, i) => ({ ...t, off: scale(vec3(jitter(-1, 1), jitter(-1, 1), jitter(-1, 1)), TONGUE_SPREAD[i]), seed: Math.random() }));
    const faces = freeFaces(block);
    burning.set(block, {
      tongues, faces, facesAt: ctx.now, face: faces[0],
      licks: { acc: Math.random() }, smoke: { acc: Math.random() }, embers: { acc: Math.random() },
      level: 0, out: false, leanX: 0, leanZ: 0,
    });
  };
  // Ce qui brûle déjà (rattaché en cours de partie)
  for (const bot of ctx.world.bots) for (const block of bot.blocks.values()) if (block.burn > 0) light(block);
  const off = ctx.world.on((e) => {
    if (e.type === "fireStarted") light(e.block);
    else if (e.type === "fireEnded") {
      const fire = burning.get(e.block);
      if (fire) fire.out = true;
    } else if (e.type === "blockDestroyed") burning.delete(e.block);
  });
  return {
    update(dt) {
      if (ctx.look !== "realistic") return;
      for (const [block, fire] of burning) {
        fire.level = fire.out ? fire.level - dt / DIE : Math.min(1, fire.level + dt / CATCH);
        if (fire.level <= 0 || !block.alive) {
          burning.delete(block);
          continue;
        }
        if (!live.blockOk(block)) continue;
        burnBlock(ctx, block, fire, dt);
      }
    },
    dispose() {
      off();
      live.dispose();
      burning.clear();
    },
  };
}

function burnBlock(ctx: FxContext, block: Block, fire: BlockFire, dt: number): void {
  const rb = block.part.rb;
  const q = rb.rotation();
  const at = add(rb.translation(), qrot(q, block.local));
  const far = distance(at, ctx.eye);
  if (far > FX_RANGE) return;
  // Au viseur, pas de flammes de son propre robot tout contre l'objectif
  if (ctx.inside === block.bot && far < 2) return;
  // La vitesse du bloc (celle du morceau en son point) : les flammes s'y couchent, ce qui s'en détache part avec elle
  const v = add(rb.linvel(), cross(rb.angvel(), sub(at, rb.worldCom())));
  let hx = -v.x * FLAME_LEAN, hz = -v.z * FLAME_LEAN;
  const h = Math.hypot(hx, hz);
  if (h > FLAME_LEAN_MAX) { hx *= FLAME_LEAN_MAX / h; hz *= FLAME_LEAN_MAX / h; }
  const follow = 1 - Math.exp(-dt / LEAN_TIME);
  fire.leanX += (hx - fire.leanX) * follow;
  fire.leanZ += (hz - fire.leanZ) * follow;
  const k = 1 / Math.hypot(fire.leanX, 1, fire.leanZ);
  const up = vec3(fire.leanX * k, k, fire.leanZ * k);
  const speed = Math.hypot(v.x, v.z);
  const stretch = 1 + Math.min(STRETCH_MAX, speed * STRETCH);

  // Sa face libre la plus haute (vue dans le monde : le robot peut être penché, retourné)
  if (ctx.now - fire.facesAt > FACES_EVERY) {
    fire.faces = freeFaces(block);
    fire.facesAt = ctx.now;
  }
  let face = fire.faces.includes(fire.face) ? fire.face : fire.faces[0];
  let best = qrot(q, face).y + FACE_KEEP;
  for (const n of fire.faces) {
    const y = qrot(q, n).y;
    if (y > best) { best = y; face = n; }
  }
  fire.face = face;
  best = qrot(q, face).y;
  // (sur une face de côté, la base un peu plus haut : la flamme lèche le haut du flanc)
  const root = add(add(at, qrot(q, scale(face, BLOCK_SIZE / 2 + ROOT))), vec3(0, best > 0.7 ? 0 : 0.1, 0));

  const level = fire.level;
  const thin = (far > FAR ? 0.5 : 1) * ctx.density;
  const shown = thin < 1 ? 2 : 3;
  for (let i = 0; i < shown; i++) {
    const t = fire.tongues[i];
    // Sa place sur la face, dans le plan de la face
    const off = sub(t.off, scale(face, dot(t.off, face)));
    const base = add(root, qrot(q, off));
    const beat = flicker(ctx.now, t.seed);
    const size = t.size * (1 + 0.08 * flicker(ctx.now * 0.9, t.seed + 0.37)) * Math.sqrt(level);
    const tall = t.tall * (1 + 0.22 * beat) * stretch;
    ctx.particles.flame(base, size, scale(up, tall), t.heat * (0.7 + 0.3 * level), 0.55 + 0.45 * level, t.seed, t.color);
  }
  if (fire.out) return;
  for (let i = emissions(fire.licks, BLOCK_LICKS * thin, dt); i > 0; i--) {
    const spot = vec3(jitter(-0.16, 0.16), jitter(-0.16, 0.16), jitter(-0.16, 0.16));
    const p = add(root, qrot(q, sub(spot, scale(face, dot(spot, face)))));
    const vel = add(v, vec3(jitter(-0.25, 0.25), jitter(0.5, 1.1), jitter(-0.25, 0.25)));
    ctx.particles.emit(add(p, scale(up, 0.18)), Math.random() < 0.35 ? BLOCK_LICK_HOT : BLOCK_LICK, vel, jitter(0.8, 1.15));
  }
  // Une traînée régulière : d'autant plus de fumée qu'il file (sinon des bouffées éparses derrière lui)
  for (let i = emissions(fire.smoke, Math.min(SMOKE_MAX, BLOCK_SMOKES + speed / SMOKE_SPACING) * thin, dt); i > 0; i--) {
    const vel = add(scale(v, SMOKE_CARRY), vec3(jitter(-0.2, 0.2), jitter(0.6, 1.2), jitter(-0.2, 0.2)));
    ctx.particles.emit(add(root, vec3(jitter(-0.1, 0.1), 0.5, jitter(-0.1, 0.1))), BLOCK_SMOKE, vel, jitter(0.8, 1.3));
  }
  for (let i = emissions(fire.embers, BLOCK_EMBERS * thin, dt); i > 0; i--) {
    const vel = add(scale(v, EMBER_CARRY), vec3(jitter(-1, 1), jitter(1.5, 3.5), jitter(-1, 1)));
    ctx.particles.emit(add(root, vec3(0, 0.2, 0)), EMBER, vel);
  }
}

function burnPuddle(ctx: FxContext, fire: GroundFire, s: Burning, dt: number): void {
  const far = distance(fire.pos, ctx.eye);
  if (far > FX_RANGE) return;
  const r = fire.radius;
  const thin = (far > FAR ? 0.5 : 1) * ctx.density;
  for (let i = emissions(s.flames, (8 + 13 * r * r) * thin, dt); i > 0; i--) {
    // Au hasard dans le disque (uniformément), au ras du sol
    const a = Math.random() * Math.PI * 2;
    const d = Math.sqrt(Math.random()) * r;
    const at = vec3(fire.pos.x + Math.cos(a) * d, fire.pos.y + 0.1, fire.pos.z + Math.sin(a) * d);
    const spec = Math.random() < 0.35 ? FLAME_HOT : Math.random() < 0.5 ? FLAME_RED : FLAME;
    // Les flammes sont plus hautes au centre
    ctx.particles.emit(at, spec, vec3(jitter(-0.2, 0.2), jitter(0.8, 1.8) * (1.2 - d / r), jitter(-0.2, 0.2)), jitter(0.5, 0.85) * flameScale(ctx));
  }
  for (let i = emissions(s.smoke, (0.8 + r) * thin, dt); i > 0; i--) {
    const at = vec3(fire.pos.x + jitter(-r, r) * 0.6, fire.pos.y + 0.4, fire.pos.z + jitter(-r, r) * 0.6);
    ctx.particles.emit(at, PUDDLE_SMOKE, vec3(0, jitter(0.6, 1.2), 0), jitter(0.8, 1.2) * Math.min(1.8, 0.6 + r * 0.4));
  }
}
