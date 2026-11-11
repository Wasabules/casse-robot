import { groundLevel, type ArenaLayout, type NavGraph, type StaticBox } from "../arena/layout";
import { LINK_REACH, neighbours, walkable } from "../arena/navGraph";
import { approachPath, bridgeDecks, cellAt, cellCenter, clearLine, findPath, nearestOpenCell, navGrid, type NavGrid } from "../arena/navgrid";
import { weaponDef } from "../catalog/weapons";
import { areEnemies } from "../combat/projectiles";
import { add, flatDistance, qrot, scale, sub, vec3, type Quat, type Vec3 } from "../math/vec";
import type { AiMode, Bot, Prop } from "../sim/entities";
import type { Simulation } from "../sim/simulation";

/*
 * Navigation d'un robot au sol autour du décor fixe. L'évitement local (trois rayons, brain.ts)
 * écarte le robot de ce qu'il a devant lui, mais ne sait pas contourner un muret ni trouver une
 * rampe. Ici, on regarde le trajet en ligne droite vers la destination :
 * - si le premier obstacle qu'il traverse est un pilier, un muret ou une plateforme, le robot
 *   vise d'abord le coin de cet obstacle qui fait le trajet le plus court (au large de son rayon) ;
 * - si la destination est sur une plateforme, il va au pied de la rampe la plus commode, la monte
 *   dans son axe jusqu'au bord de la plateforme, puis va à sa destination ;
 * - un pont (tablier) se prend par l'un de ses bouts, et se quitte par un bout : pas par-dessous
 *   (on passerait dans la rivière) ni par-dessus le parapet. Sous une voie surélevée (`underpass`),
 *   on passe : seule une destination sur son tablier (une zone) y fait monter ;
 * - dans une ville (`ArenaLayout.urban`), une destination dans un bâtiment ou un obstacle est
 *   ramenée au plus près, dehors : le robot fait le tour du pâté de maisons par les rues.
 * Le décor est fait de boîtes presque toutes alignées sur les axes : les calculs se font dans le
 * plan (x, z), sur leur emprise au sol (un rectangle). Les accessoires ancrés comptent aussi : un
 * bâtiment d'un bloc (l'emprise de ses murs encore debout), un arbre, une citerne.
 *
 * Dans une arène qui a une grille de passage (arena/navgrid.ts : pentes trop raides, lave, eau
 * profonde), la destination passe d'abord par elle : une destination fermée devient la case
 * franchissable la plus proche, et si la ligne droite traverse une case fermée, le robot suit un
 * chemin (A*) dont il vise le point le plus lointain qu'il voit en ligne droite.
 *
 * Dans une arène dont le relief coupe les routes (le Canyon), un réseau de passage (`NavGraph`)
 * prend le relais en amont : si la ligne droite vers la destination franchit une falaise, le robot
 * suit le plus court chemin du réseau (`routeGoal`) ; et seuls comptent les obstacles à sa hauteur
 * (pas le toit d'un tunnel au-dessus de lui, ni un rocher au pied de la falaise qu'il longe).
 */

/** Ce qu'on contourne : ce qui arrête un robot au sol. */
const OBSTACLES: ReadonlySet<StaticBox["kind"]> = new Set(["pillar", "barrier", "platform", "rock", "container", "tower"]);
/** Un accessoire ancré dont le bas est à plus de cette hauteur au-dessus du sol ne gêne pas (un toit) (m). */
const OVERHEAD = 1.2;
/**
 * Un accessoire ancré dont l'emprise est plus étroite que cela (demi-côté, m) ne se contourne pas :
 * un lampadaire, que l'évitement local suffit à éviter (et qu'un robot lancé couche).
 */
const SLENDER = 0.15;
/** Marge autour d'un obstacle, en plus du rayon du robot (m). */
const CLEARANCE = 0.8;
/** Distance au pied d'une rampe à laquelle on monte droit vers la destination (m). */
const FOOT_REACHED = 2.5;
/** Le pied d'une rampe est pris un peu en avant de son bas (m), et son haut un peu sur la plateforme (m). */
const FOOT_APPROACH = 1.5;
const TOP_INSIDE = 1.5;
/** Un pont s'aborde à DECK_APPROACH m de son bout, dans son axe ; on est dessus à moins de DECK_ABOARD m sous son tablier. */
const DECK_APPROACH = 5;
const DECK_ABOARD = 1.5;
/**
 * Dans une arène à grille de passage, aux abords d'un pont (à moins de DECK_LANE m de son axe), le
 * robot vise un point de l'axe PURSUIT m plus loin : il s'y aligne en roulant, même arrivé de biais.
 */
const DECK_LANE = 3;
const PURSUIT = 6;
/** Un obstacle dont le haut est à plus de LOWER m sous le centre de masse du robot est sous lui (m). */
const LOWER = 0.4;
/** Avec un réseau de passage : un obstacle dont le bas est à plus de ABOVE m au-dessus du centre de masse du robot est au-dessus de lui (m). */
const ABOVE = 1.5;
/** En ville, un coin à moins de cela est atteint : il vise le suivant (m). */
const CORNER_REACHED = 1.5;
/** Ce qui est à plus de BEYOND m au-delà du bord de l'arène (`bounds.half`) ne compte pas (m). */
const BEYOND = 5;
/**
 * Une rampe qui monte de plus que cela (m) est un mur pour qui l'aborde par le flanc : on la
 * contourne pour gagner son pied (le parking à étage de la Cité).
 */
const TALL_RAMP = 2;
/**
 * Un mur est sur un côté de son bâtiment s'il en est à moins de ON_SIDE m ; une ouverture plus
 * large que DOOR m est une sortie (il est entré par là : son rayon englobant, qui compte sa
 * longueur, la jugerait trop étroite).
 */
const ON_SIDE = 0.6;
const DOOR = 2.4;
/**
 * En ville, le corps d'un robot : cette part de son rayon (au plus BODY_MAX m) autour de son centre.
 * Il doit passer à côté d'un mur ; plus près, il s'en écarte d'abord.
 */
const BODY = 0.9;
const BODY_MAX = 2.2;

export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Demi-emprise au sol (x, z) d'une boîte orientée, et sa demi-hauteur (y). */
function footprint(half: Vec3, rot: Readonly<Quat>): { x: number; y: number; z: number } {
  const ax = qrot(rot, vec3(half.x, 0, 0));
  const ay = qrot(rot, vec3(0, half.y, 0));
  const az = qrot(rot, vec3(0, 0, half.z));
  return {
    x: Math.abs(ax.x) + Math.abs(ay.x) + Math.abs(az.x),
    y: Math.abs(ax.y) + Math.abs(ay.y) + Math.abs(az.y),
    z: Math.abs(ax.z) + Math.abs(ay.z) + Math.abs(az.z),
  };
}

const rectOf = (box: { pos: Vec3; half: Vec3; rot: Readonly<Quat> }, grow: number): Rect => {
  const f = footprint(box.half, box.rot);
  return { minX: box.pos.x - f.x - grow, maxX: box.pos.x + f.x + grow, minZ: box.pos.z - f.z - grow, maxZ: box.pos.z + f.z + grow };
};
const grown = (r: Rect, grow: number): Rect => ({ minX: r.minX - grow, maxX: r.maxX + grow, minZ: r.minZ - grow, maxZ: r.maxZ + grow });

/** Obstacle au sol : une boîte du décor, ou l'emprise d'un bâtiment ou d'un accessoire ancré. */
export interface Obstacle {
  rect: Rect;
  /** La boîte du décor, s'il en est une (une plateforme se traite à part). */
  box: StaticBox | null;
  /** Assez haut et large pour qu'un robot s'abrite derrière (pas un arbre). */
  shelter: boolean;
  /** Un bâtiment : l'emprise de chacun de ses murs encore debout (ce qui manque entre eux : ses ouvertures). */
  walls?: Rect[];
  /** Hauteurs de son bas et de son haut (m). */
  bottom: number;
  top: number;
}

/**
 * L'obstacle est à la hauteur d'un robot dont le centre de masse est à `y` : ni sous lui, ni
 * au-dessus de lui. Ne compte que dans une arène à réseau de passage, où les niveaux se superposent.
 */
export const atLevel = (o: Obstacle, y: number): boolean => o.top >= y - LOWER && o.bottom <= y + ABOVE;

/**
 * Ce qu'un accessoire ancré oppose à un robot au sol : son emprise, et s'il gêne (ni au-dessus des
 * têtes comme un toit, ni mince comme un lampadaire). Un accessoire ancré ne bouge pas : c'est
 * calculé une fois (sans relire son corps à chaque pas).
 */
interface Footing {
  rect: Rect;
  blocks: boolean;
  /** Assez large pour qu'on s'abrite derrière. */
  wide: boolean;
  /** Hauteurs de son bas et de son haut (m). */
  bottom: number;
  top: number;
}
const footings = new WeakMap<Prop, Footing>();

function footingOf(sim: Simulation, prop: Prop): Footing {
  let footing = footings.get(prop);
  if (footing) return footing;
  const pos = prop.rb.translation();
  const rot = prop.rb.rotation();
  const f = footprint(prop.half, rot);
  const bottom = pos.y - Math.abs(qrot(rot, vec3(0, prop.half.y, 0)).y);
  const blocks = bottom <= groundLevel(sim.arena, pos.x, pos.z) + OVERHEAD && Math.max(f.x, f.z) >= SLENDER;
  footing = { rect: { minX: pos.x - f.x, maxX: pos.x + f.x, minZ: pos.z - f.z, maxZ: pos.z + f.z }, blocks, wide: Math.min(f.x, f.z) > 1, bottom, top: pos.y + f.y };
  footings.set(prop, footing);
  return footing;
}

/**
 * Obstacles du pas en cours, revus quand le temps avance (les murs tombent) : refaits si un
 * accessoire ancré est tombé ou a disparu depuis (la liste des accessoires est alors refaite, ou
 * l'un d'eux n'est plus ancré), ou qu'on a changé d'arène ; sinon, les mêmes.
 */
const cache = new WeakMap<Simulation, { time: number; arena: ArenaLayout; props: readonly Prop[]; fixed: number; list: Obstacle[] }>();

/**
 * Ce qui arrête un robot au sol : piliers, murets, plateformes, rochers, conteneurs, immeubles ;
 * chaque bâtiment (l'emprise de ses murs encore debout, d'un bloc), chaque arbre ou citerne debout.
 */
export function obstacles(sim: Simulation): Obstacle[] {
  const hit = cache.get(sim);
  if (hit && hit.time === sim.time) return hit.list;
  let fixed = 0;
  for (const prop of sim.props) if (prop.fixed) fixed++;
  if (hit && hit.arena === sim.arena && hit.props === sim.props && hit.fixed === fixed) {
    hit.time = sim.time;
    return hit.list;
  }
  const list: Obstacle[] = [];
  // Au-delà du bord de l'arène (les immeubles qui ferment une ville), rien ne gêne personne
  const edge = sim.arena.bounds.half + BEYOND;
  const within = (r: Rect): boolean => r.maxX > -edge && r.minX < edge && r.maxZ > -edge && r.minZ < edge;
  for (const box of sim.arena.boxes) {
    if (!OBSTACLES.has(box.kind)) continue;
    // Une plateforme et ses hautes rampes : un seul obstacle (on ne se glisse pas entre elles)
    const rect = box.kind === "platform" ? withRamps(sim.arena, box) : rectOf(box, 0);
    const dy = footprint(box.half, box.rot).y;
    if (within(rect)) list.push({ rect, box, shelter: box.kind !== "platform", bottom: box.pos.y - dy, top: box.pos.y + dy });
  }
  const buildings = new Map<number, { rect: Rect; walls: Rect[]; bottom: number; top: number }>();
  for (const prop of sim.props) {
    if (!prop.fixed) continue;
    const spot = sim.arena.props[prop.spot];
    if (!spot) continue;
    const { rect: r, blocks, wide, bottom, top } = footingOf(sim, prop);
    if (!blocks) continue;
    if (spot.building === undefined) {
      list.push({ rect: r, box: null, shelter: wide, bottom, top });
      continue;
    }
    const b = buildings.get(spot.building);
    if (!b) {
      buildings.set(spot.building, { rect: r, walls: [r], bottom, top });
      continue;
    }
    b.rect = { minX: Math.min(b.rect.minX, r.minX), maxX: Math.max(b.rect.maxX, r.maxX), minZ: Math.min(b.rect.minZ, r.minZ), maxZ: Math.max(b.rect.maxZ, r.maxZ) };
    b.walls.push(r);
    b.bottom = Math.min(b.bottom, bottom);
    b.top = Math.max(b.top, top);
  }
  for (const { rect, walls, bottom, top } of buildings.values()) list.push({ rect, box: null, shelter: true, walls, bottom, top });
  cache.set(sim, { time: sim.time, arena: sim.arena, props: sim.props, fixed, list });
  return list;
}

/**
 * Le point `p` est-il dans un obstacle au sol (hors plateformes, où l'on monte), à `margin` m près ?
 * Une destination ainsi placée ne s'atteint pas.
 */
export function insideObstacle(sim: Simulation, p: Vec3, margin: number): boolean {
  return obstacles(sim).some(({ rect, box }) => box?.kind !== "platform" && inside(p, grown(rect, margin)));
}

/**
 * Une destination dans un obstacle (hors plateformes) ou à moins de `margin` m de lui est ramenée
 * au point le plus proche à `margin` m de son bord : le robot y tient sans toucher le mur, et ne
 * tourne pas sans fin autour d'un coin pour l'atteindre. Deux obstacles serrés se règlent l'un
 * après l'autre.
 */
function clearOf(sim: Simulation, goal: Vec3, margin: number): Vec3 {
  let p = goal;
  const m = margin - 0.05;
  for (let pass = 0; pass < 3; pass++) {
    const q = p;
    const hit = obstacles(sim).find(({ rect: r, box }) => box?.kind !== "platform" && !(box && box.pos.y + box.half.y < q.y - LOWER) && q.x > r.minX - m && q.x < r.maxX + m && q.z > r.minZ - m && q.z < r.maxZ + m);
    if (!hit) break;
    const r = grown(hit.rect, margin);
    const exits = [vec3(r.minX, p.y, p.z), vec3(r.maxX, p.y, p.z), vec3(p.x, p.y, r.minZ), vec3(p.x, p.y, r.maxZ)];
    p = exits.reduce((a, b) => (flatDistance(a, p) <= flatDistance(b, p) ? a : b));
  }
  return p;
}
const inside = (p: Vec3, r: Rect): boolean => p.x > r.minX && p.x < r.maxX && p.z > r.minZ && p.z < r.maxZ;

/** Part (0 à 1) du segment a → b à laquelle il entre dans le rectangle, ou null s'il ne le traverse pas. */
function entry(a: Vec3, b: Vec3, r: Rect): number | null {
  // Le long de x, puis de z (sans tableau intermédiaire : appelé pour chaque obstacle, à chaque pas)
  const span = { t0: 0, t1: 1 };
  if (!clip(a.x, b.x - a.x, r.minX, r.maxX, span) || !clip(a.z, b.z - a.z, r.minZ, r.maxZ, span)) return null;
  return span.t0;
}

/** Restreint `span` à la part du segment (départ `p`, déplacement `d`) comprise entre `lo` et `hi` ; faux s'il n'en reste rien. */
function clip(p: number, d: number, lo: number, hi: number, span: { t0: number; t1: number }): boolean {
  if (Math.abs(d) < 1e-9) return !(p <= lo || p >= hi);
  let near = (lo - p) / d;
  let far = (hi - p) / d;
  if (near > far) [near, far] = [far, near];
  span.t0 = Math.max(span.t0, near);
  span.t1 = Math.min(span.t1, far);
  return span.t0 < span.t1;
}

interface RampPath {
  ramp: StaticBox;
  /** Devant son bas, et un peu au-delà de son haut, sur la plateforme. */
  foot: Vec3;
  top: Vec3;
  /** Une haute rampe (voir TALL_RAMP). */
  tall: boolean;
}

/** Sur une haute rampe, il vise un point de son axe à cette distance devant lui (m) : il reste au milieu. */
const RAMP_LEAD = 4;

/** Le point de l'axe d'une rampe (du pied au haut) à RAMP_LEAD m devant la projection de `pos`. */
function alongRamp(path: RampPath, pos: Vec3): Vec3 {
  const dx = path.top.x - path.foot.x;
  const dz = path.top.z - path.foot.z;
  const length = Math.hypot(dx, dz) || 1;
  const t = ((pos.x - path.foot.x) * dx + (pos.z - path.foot.z) * dz) / length;
  const k = Math.min(length, Math.max(0, t) + RAMP_LEAD) / length;
  return vec3(path.foot.x + dx * k, path.top.y, path.foot.z + dz * k);
}

/**
 * La rampe de cette plateforme la plus commode pour aller de `from` à `to`, ou null (pas de rampe).
 * Le pied d'une haute rampe se prend plus loin (de `reach` m de plus) : on s'y aligne avant de monter.
 */
function rampPath(sim: Simulation, platform: StaticBox, from: Vec3, to: Vec3, reach: number): RampPath | null {
  const top = rectOf(platform, 1);
  let best: RampPath | null = null;
  let bestCost = Infinity;
  for (const box of sim.arena.boxes) {
    if (box.kind !== "ramp") continue;
    // Les deux bouts de la rampe, le long de sa plus grande longueur
    const along = box.half.x > box.half.z ? vec3(box.half.x, 0, 0) : vec3(0, 0, box.half.z);
    const ends = [add(box.pos, qrot(box.rot, along)), sub(box.pos, qrot(box.rot, along))];
    const [low, high] = ends[0].y < ends[1].y ? ends : [ends[1], ends[0]];
    if (!inside(high, top)) continue;
    const out = sub(low, high);
    const length = Math.hypot(out.x, out.z) || 1;
    const lead = high.y - low.y >= TALL_RAMP ? FOOT_APPROACH + reach : FOOT_APPROACH;
    const foot = add(vec3(low.x, 0, low.z), scale(vec3(out.x, 0, out.z), lead / length));
    const upper = add(vec3(high.x, 0, high.z), scale(vec3(out.x, 0, out.z), -TOP_INSIDE / length));
    const cost = flatDistance(from, foot) + flatDistance(foot, to);
    if (cost < bestCost) {
      bestCost = cost;
      best = { ramp: box, foot, top: upper, tall: high.y - low.y >= TALL_RAMP };
    }
  }
  return best;
}

/**
 * Point vers lequel rouler pour aller à `target` depuis `pos` : la destination elle-même si la
 * voie est libre ; sinon le pied d'une rampe ou le coin d'un obstacle.
 */
export function navigate(sim: Simulation, bot: Bot, pos: Vec3, target: Vec3): Vec3 {
  // Grille de passage (lave, mer, pentes) : la destination passe d'abord par elle
  const grid = navGrid(sim.arena);
  // (la destination elle-même reste celle qu'on monte rejoindre par une rampe : le pont d'un navire)
  const final = target;
  if (grid) target = gridWaypoint(sim, grid, bot, pos, target);
  const bridged = bridgeGoal(sim, bot, pos, target);
  let goal = bridged ?? target;
  // Le relief coupe la route : par le réseau de passage (sauf sur un pont, ou pour y monter : le pont s'en charge)
  const nav = sim.arena.nav;
  if (nav && bridged !== target && !onDeck(sim, pos)) {
    const to = goal;
    sim.measure("ia › réseau", () => (goal = routeGoal(sim, nav, bot, pos, to)));
  }
  // Destination sur une plateforme : par une rampe, sauf s'il y est déjà ou qu'il en est au pied
  let aboard: StaticBox | null = null;
  let climbing: StaticBox | null = null;
  for (const box of sim.arena.boxes) {
    if (box.kind !== "platform") continue;
    const top = rectOf(box, 0);
    if (inside(pos, rectOf(box, 0.3))) aboard = box;
    if (!inside(final, top) || aboard === box) continue;
    const path = rampPath(sim, box, pos, final, bot.radius);
    if (!path) break;
    // Avec une grille de passage, il ne vise le pied de la rampe que d'où il le voit (sinon, l'étape de son chemin)
    if (grid && final !== target && !clearLine(grid, pos, path.foot)) break;
    // Au pied ou déjà sur la rampe : il la monte dans son axe, sans déborder sur ses côtés
    if (inside(pos, rectOf(path.ramp, 0.3)) || flatDistance(pos, path.foot) <= FOOT_REACHED) climbing = path.ramp;
    goal = !climbing ? path.foot : path.tall ? alongRamp(path, pos) : path.top;
    break;
  }

  const grow = bot.radius + CLEARANCE;
  if (sim.arena.urban) {
    // Entré dans un bâtiment : il en ressort par une ouverture
    const exit = buildingExit(sim, bot, pos, goal);
    if (exit) return exit;
    // Une destination dans un bâtiment se prend dans la rue, au plus près
    goal = clearOf(sim, goal, grow);
  }
  // Le long d'une haute rampe : il la longe jusqu'à son bas plutôt que de buter contre son flanc
  const ramps = tallRamps(sim.arena);
  const along = besideRamp(bot, pos, goal, climbing, ramps);
  if (along) return along;

  // Premier obstacle sur le trajet : on vise son coin le plus commode
  let first: Rect | null = null;
  let firstT = Infinity;
  // En ville, un robot qui longe un mur (dans sa marge) le contourne quand même s'il allait le
  // traverser : il suit le mur jusqu'au coin au lieu de pousser contre lui
  const hugging = !!sim.arena.urban;
  let core: Rect | null = null;
  let away: Vec3 | null = null;
  let awayD = Infinity;
  // Ce qui est loin du trajet (au-delà de la marge) ne peut pas le couper : écarté sans calcul
  const reach: Rect = grown({ minX: Math.min(pos.x, goal.x), maxX: Math.max(pos.x, goal.x), minZ: Math.min(pos.z, goal.z), maxZ: Math.max(pos.z, goal.z) }, grow);
  for (const o of obstacles(sim)) {
    const { rect, box } = o;
    if (rect.minX >= reach.maxX || rect.maxX <= reach.minX || rect.minZ >= reach.maxZ || rect.maxZ <= reach.minZ) continue;
    if (box && box === aboard) continue;
    // Les niveaux se superposent (un tunnel, le pied d'une falaise) : seuls comptent les obstacles à sa hauteur
    if (nav && !atLevel(o, pos.y)) continue;
    // Plus bas que lui (les piles d'un pont sur lequel il roule, un muret au pied de la colline) : rien à contourner
    // (en ville, plus bas aussi que sa destination : la culée sous le tablier où il monte)
    if (box && box.pos.y + box.half.y < (hugging ? Math.max(pos.y, goal.y) : pos.y) - LOWER) continue;
    if (box?.kind === "platform" && (inside(goal, rect) || onRamp(sim, pos))) continue;
    // Destination dans l'emprise (au pied d'un mur) : il y va tout droit, l'évitement local fait le reste
    if (!box && inside(goal, rect)) continue;
    const r = grown(rect, grow);
    if (inside(pos, r)) {
      // Déjà contre lui : l'évitement local s'en charge (en ville, s'il ne le traverse pas)
      if (!hugging || inside(pos, rect)) continue;
      // En ville, son corps (une part de son rayon) doit passer à côté du mur, pas seulement son centre
      const body = grown(rect, Math.min(bot.radius * BODY, BODY_MAX));
      if (inside(pos, body)) {
        // Si près du mur que son corps le frotte (sauf au pied d'une plateforme, où il va pour
        // monter, ou si sa destination est là) : il s'en écarte d'abord
        if (box?.kind === "platform" || climbing) continue;
        const near = vec3(Math.max(rect.minX, Math.min(pos.x, rect.maxX)), pos.y, Math.max(rect.minZ, Math.min(pos.z, rect.maxZ)));
        const d = flatDistance(pos, near);
        if (d > 1e-3 && !inside(goal, body) && d < awayD) {
          awayD = d;
          away = vec3(near.x + ((pos.x - near.x) / d) * grow, goal.y, near.z + ((pos.z - near.z) / d) * grow);
        }
        continue;
      }
      const t = entry(pos, goal, body);
      if (t !== null && t < firstT) {
        firstT = t;
        first = r;
        core = body;
      }
      continue;
    }
    const t = entry(pos, goal, r);
    if (t !== null && t < firstT) {
      firstT = t;
      first = r;
      core = null;
    }
  }
  if (away) return away;
  if (!first) return goal;
  const r = first;
  const corners = [vec3(r.minX, 0, r.minZ), vec3(r.minX, 0, r.maxZ), vec3(r.maxX, 0, r.minZ), vec3(r.maxX, 0, r.maxZ)];
  // Un coin est derrière l'obstacle si on le traverse pour l'atteindre (dans sa marge : l'obstacle lui-même)
  const shrunk: Rect = core ? grown(core, -0.05) : { minX: r.minX + 0.05, maxX: r.maxX - 0.05, minZ: r.minZ + 0.05, maxZ: r.maxZ - 0.05 };
  let best = goal;
  let bestCost = Infinity;
  for (const c of corners) {
    if (entry(pos, c, shrunk) !== null) continue; // ce coin est derrière l'obstacle
    // En ville : pas le coin où il est déjà ; et d'un coin d'où l'obstacle cache encore la
    // destination, il faudra passer par un coin voisin (sans quoi il resterait à tourner sur place)
    if (hugging && flatDistance(pos, c) < CORNER_REACHED) continue;
    const onward = hugging && entry(c, goal, shrunk) !== null
      ? Math.min(...corners.filter((n) => n !== c && (n.x === c.x || n.z === c.z)).map((n) => flatDistance(c, n) + flatDistance(n, goal)))
      : flatDistance(c, goal);
    // (en ville, il garde le coin qu'il visait, à moins qu'un autre ne soit nettement meilleur :
    // sinon, d'un pas à l'autre, il hésite entre deux coins presque équivalents)
    const kept = hugging && aimed.get(bot);
    const cost = flatDistance(pos, c) + onward - (kept && flatDistance(kept, c) < 0.5 ? CORNER_KEEP : 0);
    if (cost < bestCost) {
      bestCost = cost;
      best = c;
    }
  }
  if (hugging) aimed.set(bot, best);
  return best;
}

/** En ville, le coin que vise chaque robot (il le garde tant qu'aucun autre n'est plus court de CORNER_KEEP m). */
const aimed = new WeakMap<Bot, Vec3>();
const CORNER_KEEP = 3;

/**
 * Un pont sur le trajet : une destination sur son tablier se prend par le bout le plus commode
 * (d'abord son abord, dans l'axe, puis droit dessus) ; un robot sur le tablier qui va ailleurs
 * en sort par le bout le plus proche de sa destination. Sous une voie surélevée (`underpass`), une
 * destination reste en bas, sauf à sa hauteur (une zone sur le tablier) ou pour qui est déjà
 * dessus. Dans une arène à grille de passage (une gorge sous le pont, qu'on ne traverse pas
 * autrement), un pont que le trajet traverse se prend aussi par un bout, et se suit dans son axe
 * jusqu'à l'autre. Null : pas de pont en jeu.
 */
function bridgeGoal(sim: Simulation, bot: Bot, pos: Vec3, target: Vec3): Vec3 | null {
  const grid = navGrid(sim.arena) !== null;
  const decks = grid ? bridgeDecks(sim.arena) : sim.arena.boxes.filter(isBridge);
  for (const box of decks) {
    const r = rectOf(box, 0);
    const deck = box.pos.y + box.half.y - DECK_ABOARD;
    const aboard = isAboard(box, r, pos);
    const wanted = inside(target, r) && (!box.underpass || aboard || target.y > deck);
    const crossing = grid && !aboard && !wanted && entry(pos, target, r) !== null;
    if (aboard === wanted && !crossing) continue; // dessus et y reste, ou ni l'un ni l'autre
    // Les deux bouts, le long de sa plus grande longueur, et leurs abords (le pied de son remblai, s'il en a un)
    const axis = box.half.x > box.half.z ? vec3(1, 0, 0) : vec3(0, 0, 1);
    const length = Math.max(box.half.x, box.half.z);
    const approach = box.approach ?? DECK_APPROACH;
    const ends = [1, -1].map((s) => ({
      s,
      end: add(vec3(box.pos.x, 0, box.pos.z), scale(axis, s * length)),
      /** Juste après le bout, sur le tablier. */
      onto: add(vec3(box.pos.x, box.pos.y + box.half.y, box.pos.z), scale(axis, s * (length - DECK_ABOARD))),
      approach: add(vec3(box.pos.x, 0, box.pos.z), scale(axis, s * (length + approach))),
    }));
    if (aboard) {
      // Il sort par le bout le plus proche de sa destination
      const exit = ends.reduce((a, b) => (flatDistance(a.end, target) <= flatDistance(b.end, target) ? a : b));
      return exit.approach;
    }
    const entrance = ends.reduce((a, b) => (flatDistance(pos, a.approach) + flatDistance(a.approach, target) <= flatDistance(pos, b.approach) + flatDistance(b.approach, target) ? a : b));
    // Une voie surélevée : il monte jusqu'au bout du tablier, dans l'axe (ce qui est sous le
    // tablier, comme sa culée, ne lui barre pas la route), puis, dessus, va à sa destination
    const onto = box.underpass ? entrance.onto : target;
    // À l'abord, ou déjà dans l'axe du pont devant son bout : droit dessus
    const lateral = Math.abs((pos.x - box.pos.x) * (1 - axis.x) + (pos.z - box.pos.z) * (1 - axis.z));
    const width = Math.min(box.half.x, box.half.z);
    if (grid) {
      // Aux abords, dans l'axe : un point de l'axe un peu plus loin, jusqu'à l'abord de l'autre bout
      // (pour le traverser) ou jusqu'à monter dessus (pour y aller)
      const u = entrance.s * ((pos.x - box.pos.x) * axis.x + (pos.z - box.pos.z) * axis.z);
      if (u < length + approach + 2 && lateral < width + DECK_LANE) {
        if (!crossing && u < length) return onto;
        const next = Math.max(u - PURSUIT, -(length + approach));
        return add(vec3(box.pos.x, 0, box.pos.z), scale(axis, entrance.s * next));
      }
      return entrance.approach;
    }
    // (sous une voie surélevée, il faut d'abord en être sorti par ce bout)
    const along = Math.abs((pos.x - box.pos.x) * axis.x + (pos.z - box.pos.z) * axis.z);
    const inLine = lateral < width - bot.radius * 0.5 && flatDistance(pos, entrance.end) < approach + 2 && (!box.underpass || along > length);
    if (flatDistance(pos, entrance.approach) > FOOT_REACHED && !inLine) return entrance.approach;
    return onto;
  }
  return null;
}

/**
 * Un robot entré dans un bâtiment (par une porte, une brèche) en ressort par l'ouverture la plus
 * commode : un trou entre ses murs encore debout, assez large pour lui ; il se place d'abord en face
 * (un peu en dedans), puis sort. Null : il n'est dans aucun bâtiment, ou celui-ci est fermé.
 */
function buildingExit(sim: Simulation, bot: Bot, pos: Vec3, target: Vec3): Vec3 | null {
  const home = obstacles(sim).find((o) => o.walls && inside(pos, o.rect));
  if (!home?.walls) return null;
  const r = home.rect;
  const need = DOOR;
  let best: Vec3 | null = null;
  let bestCost = Infinity;
  // Chaque côté : s'il court le long de x, sa position, son sens vers l'extérieur
  const sides = [
    { alongX: true, at: r.minZ, out: -1 }, { alongX: true, at: r.maxZ, out: 1 },
    { alongX: false, at: r.minX, out: -1 }, { alongX: false, at: r.maxX, out: 1 },
  ];
  for (const side of sides) {
    const gap = (w: Rect): number => (side.alongX ? (side.out < 0 ? w.minZ - r.minZ : r.maxZ - w.maxZ) : (side.out < 0 ? w.minX - r.minX : r.maxX - w.maxX));
    const covered = home.walls.filter((w) => gap(w) < ON_SIDE).map((w) => (side.alongX ? [w.minX, w.maxX] : [w.minZ, w.maxZ])).sort((a, b) => a[0] - b[0]);
    const [from, to] = side.alongX ? [r.minX, r.maxX] : [r.minZ, r.maxZ];
    const openings: [number, number][] = [];
    let reached = from;
    for (const [a, b] of covered) {
      if (a - reached >= need) openings.push([reached, a]);
      reached = Math.max(reached, b);
    }
    if (to - reached >= need) openings.push([reached, to]);
    for (const [a, b] of openings) {
      const mid = (a + b) / 2;
      const point = (depth: number): Vec3 => (side.alongX ? vec3(mid, 0, side.at + side.out * depth) : vec3(side.at + side.out * depth, 0, mid));
      const inner = point(-(bot.radius + 1));
      const outer = point(bot.radius + CLEARANCE);
      const cost = flatDistance(pos, inner) + flatDistance(outer, target);
      if (cost >= bestCost) continue;
      bestCost = cost;
      // En face de l'ouverture, il sort ; sinon, il s'y présente d'abord
      const lateral = Math.abs((side.alongX ? pos.x : pos.z) - mid);
      best = lateral < (b - a) / 2 - bot.radius * 0.7 ? outer : inner;
    }
  }
  return best;
}

/** Une haute rampe dans le plan : son centre, son axe (vers son bas) et son travers, sa demi-longueur et sa demi-largeur (m). */
interface TallRamp {
  box: StaticBox;
  /** Son emprise ; son haut. */
  rect: Rect;
  top: Vec3;
  center: Vec3;
  down: Vec3;
  across: Vec3;
  half: number;
  width: number;
}
const rampCache = new WeakMap<ArenaLayout, TallRamp[]>();

/** Les rampes qui montent de plus de TALL_RAMP m (calculées une fois par arène). */
function tallRamps(arena: ArenaLayout): TallRamp[] {
  let list = rampCache.get(arena);
  if (list) return list;
  list = [];
  for (const box of arena.boxes) {
    if (box.kind !== "ramp") continue;
    const alongX = box.half.x > box.half.z;
    const along = alongX ? vec3(box.half.x, 0, 0) : vec3(0, 0, box.half.z);
    const ends = [add(box.pos, qrot(box.rot, along)), sub(box.pos, qrot(box.rot, along))];
    const [low, high] = ends[0].y < ends[1].y ? ends : [ends[1], ends[0]];
    if (high.y - low.y < TALL_RAMP) continue;
    const length = Math.hypot(low.x - high.x, low.z - high.z);
    const down = vec3((low.x - high.x) / length, 0, (low.z - high.z) / length);
    list.push({
      box, rect: rectOf(box, 0), top: high, center: vec3((low.x + high.x) / 2, 0, (low.z + high.z) / 2),
      down, across: vec3(-down.z, 0, down.x), half: length / 2, width: alongX ? box.half.z : box.half.x,
    });
  }
  rampCache.set(arena, list);
  return list;
}

/** Coordonnées d'un point dans le repère d'une rampe : le long de son axe (+ vers son bas), en travers. */
function rampCoords(ramp: TallRamp, p: Vec3): { u: number; v: number } {
  const dx = p.x - ramp.center.x;
  const dz = p.z - ramp.center.z;
  return { u: dx * ramp.down.x + dz * ramp.down.z, v: dx * ramp.across.x + dz * ramp.across.z };
}

/** L'emprise d'une plateforme, étendue à celle de ses hautes rampes (celles dont le haut arrive sur elle). */
function withRamps(arena: ArenaLayout, platform: StaticBox): Rect {
  const r = rectOf(platform, 0);
  const landing = rectOf(platform, 1);
  for (const ramp of tallRamps(arena)) {
    if (!inside(ramp.top, landing)) continue;
    r.minX = Math.min(r.minX, ramp.rect.minX);
    r.maxX = Math.max(r.maxX, ramp.rect.maxX);
    r.minZ = Math.min(r.minZ, ramp.rect.minZ);
    r.maxZ = Math.max(r.maxZ, ramp.rect.maxZ);
  }
  return r;
}

/**
 * Un robot au pied du flanc d'une haute rampe (qu'il ne monte pas), qui va au-delà de son bas ou de
 * l'autre côté : il la longe jusqu'à son bas, de son côté. Null : rien de tel.
 */
function besideRamp(bot: Bot, pos: Vec3, goal: Vec3, climbing: StaticBox | null, ramps: readonly TallRamp[]): Vec3 | null {
  for (const ramp of ramps) {
    if (ramp.box === climbing) continue;
    const { u, v } = rampCoords(ramp, pos);
    const side = ramp.width + bot.radius + CLEARANCE;
    if (Math.abs(v) < ramp.width - 0.3 || Math.abs(v) > side || u > ramp.half || u < -ramp.half - side) continue;
    const g = rampCoords(ramp, goal);
    // Sa destination est de son côté, sans dépasser le bas de la rampe : rien à faire
    if (g.u <= ramp.half && Math.sign(g.v) === Math.sign(v) && Math.abs(g.v) >= ramp.width) continue;
    const s = Math.sign(v) || 1;
    const lu = ramp.half + 0.8;
    const lv = s * (ramp.width + bot.radius + 0.6);
    return vec3(ramp.center.x + ramp.down.x * lu + ramp.across.x * lv, goal.y, ramp.center.z + ramp.down.z * lu + ramp.across.z * lv);
  }
  return null;
}

/** Le robot est sur une rampe (dans son emprise au sol). */
function onRamp(sim: Simulation, pos: Vec3): boolean {
  return sim.arena.boxes.some((b) => b.kind === "ramp" && inside(pos, rectOf(b, 0)));
}

/** Un tablier de pont (pas un parapet, ni une poutre). */
const isBridge = (box: StaticBox): boolean => box.kind === "deck" && Math.min(box.half.x, box.half.z) >= 1;
/** Le robot est sur ce tablier (dans son emprise, à sa hauteur), pas dessous. */
const isAboard = (box: StaticBox, r: Rect, pos: Vec3): boolean => inside(pos, r) && pos.y > box.pos.y + box.half.y - DECK_ABOARD;
/** Le robot est sur un pont. */
const onDeck = (sim: Simulation, pos: Vec3): boolean => sim.arena.boxes.some((b) => isBridge(b) && isAboard(b, rectOf(b, 0), pos));

/**
 * Suivi du réseau de passage, par robot : la destination pour laquelle sa route a été calculée,
 * les points du réseau qui lui restent à passer, et quand elle a été calculée, puis vérifiée.
 */
interface NavRoute {
  goal: Vec3;
  path: number[];
  planned: number;
  checked: number;
}
const navRoutes = new WeakMap<Bot, NavRoute>();
/** Voisins de chaque point d'un réseau (calculés une fois). */
const adjacency = new WeakMap<NavGraph, number[][]>();
/** La route se recalcule quand la destination a bougé de plus de REPLAN_SHIFT m, ou toutes les REPLAN_EVERY s. */
const REPLAN_SHIFT = 6;
const REPLAN_EVERY = 2;
/** Un point du réseau est passé à moins de WAYPOINT_REACHED m ; toutes les SKIP_EVERY s, on regarde si l'on peut couper au suivant. */
const WAYPOINT_REACHED = 3.5;
const SKIP_EVERY = 0.4;
/** Destination injoignable : on va vers les GOAL_FALLBACK points du réseau les plus proches d'elle. */
const GOAL_FALLBACK = 3;
/** Marge de côté d'une ligne droite qu'il prend hors du réseau (m), selon sa taille : ses roues restent sur le sentier. */
const sideMargin = (bot: Bot): number => Math.min(1.2, bot.radius * 0.5);

/**
 * Point vers lequel rouler pour aller de `pos` à `goal` par le réseau de passage : la destination
 * elle-même si la ligne droite est praticable, sinon le prochain point du plus court chemin.
 * Hors de portée du réseau, la destination (l'évitement local fait ce qu'il peut).
 */
export function routeGoal(sim: Simulation, nav: NavGraph, bot: Bot, pos: Vec3, goal: Vec3): Vec3 {
  const terrain = sim.arena.terrain;
  if (!terrain) return goal;
  let route = navRoutes.get(bot);
  if (!route || flatDistance(route.goal, goal) > REPLAN_SHIFT || sim.time - route.planned > REPLAN_EVERY) {
    route = { goal, path: planRoute(terrain, nav, pos, goal, sideMargin(bot)), planned: sim.time, checked: sim.time };
    navRoutes.set(bot, route);
  }
  const path = route.path;
  const node = (i: number): Vec3 => vec3(nav.points[i][0], 0, nav.points[i][1]);
  while (path.length && flatDistance(pos, node(path[0])) < WAYPOINT_REACHED) path.shift();
  // Couper au plus court : le point suivant (ou la destination) est-il déjà en vue directe ?
  if (path.length && sim.time - route.checked > SKIP_EVERY) {
    route.checked = sim.time;
    const next = path.length > 1 ? node(path[1]) : goal;
    if (walkable(terrain, pos.x, pos.z, next.x, next.z, sideMargin(bot))) path.shift();
  }
  return path.length ? node(path[0]) : goal;
}

/**
 * Plus court chemin du réseau de `pos` à `goal` (les points à passer) ; vide si la ligne droite est
 * praticable (à `margin` m de chaque côté), ou sans issue.
 */
function planRoute(terrain: NonNullable<Simulation["arena"]["terrain"]>, nav: NavGraph, pos: Vec3, goal: Vec3, margin: number): number[] {
  if (walkable(terrain, pos.x, pos.z, goal.x, goal.z, margin)) return [];
  let next = adjacency.get(nav);
  if (!next) adjacency.set(nav, (next = neighbours(nav.points, nav.links)));
  const n = nav.points.length;
  const span = (i: number, p: Vec3): number => Math.hypot(nav.points[i][0] - p.x, nav.points[i][1] - p.z);
  // Départs : les points du réseau qu'il voit en ligne droite ; arrivées : ceux d'où l'on voit la destination
  const dist = new Float64Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const d = span(i, pos);
    if (d <= LINK_REACH && walkable(terrain, pos.x, pos.z, nav.points[i][0], nav.points[i][1])) dist[i] = d;
  }
  const exit = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const d = span(i, goal);
    if (d <= LINK_REACH && walkable(terrain, nav.points[i][0], nav.points[i][1], goal.x, goal.z, margin)) exit.set(i, d);
  }
  if (!exit.size) {
    // Destination injoignable (en haut d'une butte, au pied d'une falaise) : au plus près
    const nearest = [...Array(n).keys()].sort((a, b) => span(a, goal) - span(b, goal)).slice(0, GOAL_FALLBACK);
    for (const i of nearest) exit.set(i, span(i, goal));
  }
  // Dijkstra (le réseau a quelques centaines de points)
  const done = new Uint8Array(n);
  let best = -1;
  let bestCost = Infinity;
  for (;;) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || dist[u] >= bestCost) break;
    done[u] = 1;
    const out = exit.get(u);
    if (out !== undefined && dist[u] + out < bestCost) {
      bestCost = dist[u] + out;
      best = u;
    }
    for (const v of next[u]) {
      const d = dist[u] + Math.hypot(nav.points[u][0] - nav.points[v][0], nav.points[u][1] - nav.points[v][1]);
      if (d < dist[v]) {
        dist[v] = d;
        from[v] = u;
      }
    }
  }
  const path: number[] = [];
  for (let i = best; i >= 0; i = from[i]) path.unshift(i);
  return path;
}

/** Chemin suivi par un robot sur la grille de passage : ses cases, celle qu'il vise, quand et vers où il a été calculé. */
interface GridRoute {
  goal: number;
  cells: number[];
  at: number;
  time: number;
  /** Il ne va pas jusqu'à la destination, seulement au plus près sans long détour (voir `DETOUR_FACTOR`). */
  short: boolean;
}
const gridRoutes = new WeakMap<Bot, GridRoute>();
/**
 * Un chemin se recalcule au bout de REPLAN s, si le robot s'en est écarté de plus de OFF_ROUTE
 * cases, ou si sa destination a bougé de plus de GOAL_DRIFT cases (un ennemi qui roule) ; jamais
 * moins de MIN_REPLAN s après le précédent : un robot qui tourne autour d'un ennemi derrière un
 * obstacle ne cherche pas son chemin à chaque pas.
 */
const REPLAN = 4;
const MIN_REPLAN = 1;
const OFF_ROUTE = 3;
const GOAL_DRIFT = 4;
/**
 * En combat (pas pour rejoindre une zone), un chemin plus long que DETOUR_FACTOR fois la ligne
 * droite, plus DETOUR_SLACK m, ne vaut pas le détour (l'ennemi est sur l'autre lacet d'une route de
 * montagne) : il va seulement au plus près, parmi les DETOUR_REACH cases autour de lui.
 */
const DETOUR_MODES: ReadonlySet<AiMode> = new Set(["engage", "support", "charge"]);
const DETOUR_FACTOR = 2.5;
const DETOUR_SLACK = 25;
const DETOUR_REACH = 120;
/** Le robot vise la plus lointaine des LOOKAHEAD cases suivantes de son chemin qu'il voit en ligne droite. */
const LOOKAHEAD = 14;
/** Recherches de chemin par pas, tous robots confondus (une recherche coûte de 0,1 à 1 ms) : les autres attendent le pas suivant. */
const SEARCHES_PER_STEP = 1;
const searches = new WeakMap<Simulation, { time: number; count: number }>();

/** Une recherche de chemin est-elle permise à ce pas ? (Et la compte.) */
function maySearch(sim: Simulation): boolean {
  let s = searches.get(sim);
  if (!s || s.time !== sim.time) {
    s = { time: sim.time, count: 0 };
    searches.set(sim, s);
  }
  return s.count++ < SEARCHES_PER_STEP;
}

/**
 * Étape vers `target` sur la grille de passage : la destination (ou la case franchissable la plus
 * proche) si la ligne droite est libre ; sinon un point de son chemin. Sans chemin possible (une
 * île coupée du reste), la destination elle-même.
 */
function gridWaypoint(sim: Simulation, grid: NavGrid, bot: Bot, pos: Vec3, target: Vec3): Vec3 {
  const goalCell = nearestOpenCell(grid, cellAt(grid, target.x, target.z));
  if (goalCell < 0) return target;
  const goal = grid.open[cellAt(grid, target.x, target.z)] ? target : cellCenter(grid, goalCell);
  // Ligne droite libre : il y va (et garde son chemin, s'il en a un, pour quand elle ne le sera plus)
  if (clearLine(grid, pos, goal)) return goal;
  let route = gridRoutes.get(bot);
  const age = route ? sim.time - route.time : Infinity;
  const off = route && flatDistance(pos, cellCenter(grid, route.cells[route.at])) > OFF_ROUTE * grid.cell;
  // Une destination qui bouge un peu (un ennemi qui roule) garde le chemin : sa fin mène à elle
  const moved = route && Math.max(Math.abs(Math.floor(route.goal / grid.n) - Math.floor(goalCell / grid.n)), Math.abs((route.goal % grid.n) - (goalCell % grid.n))) > GOAL_DRIFT;
  // Trop tôt, ou trop de recherches à ce pas : il garde son ancien chemin, ou va droit, en attendant
  if ((!route || moved || off || age > REPLAN) && age >= MIN_REPLAN && maySearch(sim)) {
    let start = cellAt(grid, pos.x, pos.z);
    // Poussé dans une case fermée dont aucune voisine n'est ouverte : il rejoint d'abord la plus proche
    let cells = findPath(grid, start, goalCell);
    if (!cells) {
      start = nearestOpenCell(grid, start);
      if (start < 0) return goal;
      cells = findPath(grid, start, goalCell);
      if (!cells) {
        gridRoutes.delete(bot);
        return cellCenter(grid, start);
      }
      cells.unshift(start);
    }
    const short = DETOUR_MODES.has(bot.ai.mode) && cells.length * grid.cell > DETOUR_FACTOR * flatDistance(pos, goal) + DETOUR_SLACK;
    if (short) cells = approachPath(grid, start, goalCell, DETOUR_REACH);
    route = { goal: goalCell, cells, at: 0, time: sim.time, short };
    gridRoutes.set(bot, route);
  }
  // Sans chemin (en attendant d'en chercher un) : droit vers la destination, l'évitement local fait le reste
  if (!route) return goal;
  // Le point le plus lointain du chemin qu'il voit en ligne droite (il avance sur son chemin)
  let best = route.at;
  for (let k = route.at; k < Math.min(route.cells.length, route.at + LOOKAHEAD); k++) {
    if (clearLine(grid, pos, cellCenter(grid, route.cells[k]))) best = k;
  }
  route.at = best;
  return best === route.cells.length - 1 && !route.short ? goal : cellCenter(grid, route.cells[best]);
}


/** Évitement des mines : il regarde ce qui est sur sa route jusqu'à MINE_LOOKAHEAD m, et passe à MINE_MARGIN m de plus que leur rayon. */
const MINE_LOOKAHEAD = 18;
const MINE_MARGIN = 1.2;

/**
 * Mines ennemies que son équipe a repérées (voir sim/detection.ts) : s'il allait passer sur l'une
 * d'elles en allant vers `goal`, il vise d'abord un point à côté d'elle, du côté où elle ne se
 * trouve pas. Les mines qui ne visent pas les robots au sol (anti-aériennes, capteurs) ne comptent pas.
 */
export function avoidMines(sim: Simulation, bot: Bot, pos: Vec3, goal: Vec3): Vec3 {
  const dx = goal.x - pos.x;
  const dz = goal.z - pos.z;
  const length = Math.hypot(dx, dz);
  if (length < 0.5) return goal;
  const ux = dx / length;
  const uz = dz / length;
  let detour: Vec3 | null = null;
  let nearest = Math.min(length, MINE_LOOKAHEAD);
  for (const p of sim.projectiles) {
    if (!p.landed || !p.spotted.includes(bot.team)) continue;
    const mine = weaponDef(p.weapon).projectile.mine;
    if (!mine || mine.trigger === "air" || mine.trigger === "none" || (p.shooter && !areEnemies(p.shooter, bot))) continue;
    const mx = p.pos.x - pos.x;
    const mz = p.pos.z - pos.z;
    const along = mx * ux + mz * uz;
    if (along < 0 || along > nearest) continue;
    // > 0 : la mine est à gauche de la route (la gauche de (x, z) est (z, -x))
    const across = mx * uz - mz * ux;
    const clear = mine.radius + bot.radius + MINE_MARGIN;
    if (Math.abs(across) >= clear) continue;
    nearest = along;
    const side = across >= 0 ? -clear : clear;
    detour = vec3(p.pos.x + uz * side, 0, p.pos.z - ux * side);
  }
  return detour ?? goal;
}
