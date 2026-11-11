import RAPIER, { type Collider } from "@dimforge/rapier3d-compat";
import { weaponDef, type WeaponId } from "../catalog/weapons";
import { hipSpread } from "./accuracy";
import { BLOCK_SIZE, GRAVITY, STEP } from "../config";
import { cellKey } from "../design/robotDesign";
import { clamp, rand } from "../math/scalar";
import { add, axisAngle, cross, distance, dot, len, norm, qrot, qrotInv, scale, sub, vec3, type Quat, type Vec3 } from "../math/vec";
import { blockWorldPos } from "../robot/queries";
import { hitTargetOf, ownerBot } from "../robot/colliders";
import type { Block, Bot, HitTarget, Projectile, Turret } from "../sim/entities";
import type { ImpactSurface } from "../sim/events";
import type { Simulation } from "../sim/simulation";
import { groundBelow, ignite, igniteProp, PUDDLE_REACH, spawnGroundFire } from "./burning";
import { explode, strike } from "./damage";
import { DECOY_BURST, seduce } from "./decoys";
import { empPulse } from "./emp";
import { damageProjectile, projectileOnPath, strikesProjectiles } from "./interception";
import { stepMine } from "./mines";
import { sightBlocked } from "./sight";
import { turretFrame } from "./turrets";
import { drainAt, repairAt } from "./repair";
import { barrierOnPath, damageBarrier, deployBarrier } from "./barriers";
import { releaseSmoke } from "./smoke";

/** Nombre maximal d'éléments qu'un projectile perforant traverse en un pas. */
const MAX_PIERCE = 6;
/** Perforation dans un robot : longueur des pas dans sa grille, et distance maximale parcourue (m). */
const PIERCE_STEP = 0.1;
const PIERCE_REACH = 6;
/** Rayon dans lequel un robot est pris en compte pour une fusée de proximité (m), au-delà de son cockpit. */
const PROXIMITY_REACH = 6;

export interface LaunchOptions {
  /** Robot qui tire, ou null pour le joueur. */
  shooter: Bot | null;
  /** Tourelle qui téléguide le missile ; null : il suit le point visé par le joueur. */
  commander?: Turret | null;
  /** Cible d'un missile à tête chercheuse. */
  homing?: Bot | null;
  /** Vitesse du tireur, que le projectile garde en partant. */
  inherit?: Vec3;
  /** Dispersion du tir (rad) ; par défaut, celle de l'arme sans viseur (`hipSpread`), celle de l'IA. */
  spread?: number;
}

/**
 * Lance un projectile de l'arme `weaponId` depuis `origin`, dans la direction unitaire `dir` (plus
 * la dispersion) ; une arme à gerbe en lance plusieurs d'un coup, écartés autour de cette
 * direction, pour un seul tir (`shot`), et une roquette de salve part écartée en éventail.
 * Renvoie le premier.
 */
export function spawnProjectile(sim: Simulation, weaponId: WeaponId, origin: Vec3, dir: Vec3, opts: LaunchOptions): Projectile {
  const weapon = weaponDef(weaponId);
  const d = scatter(dir, opts.spread ?? hipSpread(weapon));
  const { pellets, fan } = weapon.projectile;
  const spray = pellets?.spread ?? fan ?? 0;
  const launched: Projectile[] = [];
  for (let i = 0; i < (pellets?.count ?? 1); i++) {
    const projectile: Projectile = {
      id: sim.nextId(),
      weapon: weaponId,
      shooter: opts.shooter,
      origin,
      pos: origin,
      vel: add(scale(scatter(d, spray), weapon.projectile.speed), opts.inherit ?? vec3(0, 0, 0)),
      age: 0,
      damage: weapon.projectile.damage,
      commander: opts.commander ?? null,
      homing: opts.homing ?? null,
      landed: false,
      fuse: null,
      stuck: null,
      blown: false,
      spotted: [],
      pingAt: 0,
      hp: weapon.projectile.hull?.hp ?? 0,
      decoy: null,
      tried: [],
      lost: false,
      seen: null,
      blind: 0,
      done: false,
    };
    sim.projectiles.push(projectile);
    sim.emit({ type: "projectileAdded", projectile });
    launched.push(projectile);
  }
  sim.emit({ type: "shot", weapon: weaponId, origin, dir: d });
  return launched[0];
}

/** Fait avancer tous les projectiles d'un pas ; ceux qui ont fini leur course disparaissent. */
export function stepProjectiles(sim: Simulation): void {
  const flying: Projectile[] = [];
  for (const p of sim.projectiles) {
    if (advance(sim, p)) flying.push(p);
    else {
      p.done = true;
      sim.emit({ type: "projectileRemoved", projectile: p });
    }
  }
  sim.projectiles = flying;
}

/** Un pas d'un projectile. Renvoie faux quand il a fini sa course. */
function advance(sim: Simulation, p: Projectile): boolean {
  const spec = weaponDef(p.weapon).projectile;
  p.age += STEP;
  if (p.age > spec.life) {
    // Autodestruction d'un missile ; une grenade (fumigène, IEM) éclate en fin de course
    if ((spec.guidance && spec.explosion) || spec.emp || spec.smoke) detonate(sim, p, p.pos, norm(p.vel));
    // Un jet de flammes qui s'éteint près du sol y laisse parfois une flaque de feu
    leavePuddle(sim, p, p.pos);
    return false;
  }

  // Mine posée, collée, qui bondit ou qu'une explosion a atteinte : combat/mines.ts
  if (spec.mine && (p.landed || p.stuck || p.fuse !== null || p.blown)) return stepMine(sim, p, spec.mine);
  // Abattu (balle, explosion : combat/interception.ts) : il éclate là où il est
  if (p.blown) {
    if (spec.explosion || spec.emp || spec.smoke) detonate(sim, p, p.pos, len(p.vel) > 0.1 ? norm(p.vel) : vec3(0, -1, 0));
    return false;
  }

  steer(sim, p);
  p.vel = add(p.vel, vec3(0, -GRAVITY * spec.gravity * STEP, 0));

  // Détourné par un leurre : il éclate en l'atteignant
  if (p.decoy && distance(p.pos, p.decoy.pos) < DECOY_BURST) {
    detonate(sim, p, p.pos, norm(p.vel));
    return false;
  }

  // Fusée de proximité (missile anti-aérien)
  if (spec.proximity && !spec.mine && nearestEnemy(sim, p, spec.proximity, spec.guidance?.airOnly ? "air" : "any")) {
    detonate(sim, p, p.pos, norm(p.vel));
    return false;
  }

  // Déplacement : lancer de rayon entre la position actuelle et la suivante
  const speed = len(p.vel);
  const dir = scale(p.vel, 1 / (speed || 1));
  let from = p.pos;
  let remaining = speed * STEP;
  // Une mine, un leurre, ne touchent pas les robots : ils se posent sur le décor, ou s'éteignent
  const groundOnly = !!spec.mine || !!spec.decoy;
  const interceptor = strikesProjectiles(spec);
  for (let pierced = 0; pierced < MAX_PIERCE && remaining > 1e-4; pierced++) {
    // Projecteur de bouclier : il se déploie au bout de sa course
    if (spec.barrier && p.age >= spec.barrier.reach / spec.speed) {
      deployBarrier(sim, p, p.pos, dir, spec.barrier);
      return false;
    }
    const hit = sim.world.castRay(
      new RAPIER.Ray(from, dir), remaining, true, undefined, undefined, undefined, undefined,
      (c) => canHit(sim, p, c, groundOnly),
    );
    // Un mur d'énergie ennemi sur le trajet, avant ce que touche le rayon : le tir s'y écrase
    const wall = groundOnly || spec.barrier ? null : barrierOnPath(sim, from, dir, hit ? hit.timeOfImpact : remaining, p.shooter?.team ?? null);
    if (wall) {
      const point = add(from, scale(dir, wall.distance));
      damageBarrier(sim, wall.barrier, p.damage + (spec.explosion?.damage ?? 0), point);
      if (spec.explosion || spec.emp || spec.smoke) detonate(sim, p, sub(point, scale(dir, 0.3)), dir);
      return false;
    }
    // Un projectile qu'on peut abattre (missile, ogive, bombe, mine) sur le trajet, avant ce que touche le rayon
    const struck = interceptor ? projectileOnPath(sim, p, from, dir, hit ? hit.timeOfImpact : remaining) : null;
    if (struck) {
      const point = add(from, scale(dir, struck.distance));
      damageProjectile(struck.target, p.damage);
      if (spec.explosion) detonate(sim, p, point, dir);
      else sim.emit({ type: "impact", point, surface: "projectile" });
      return false;
    }
    if (!hit) break;
    const point = add(from, scale(dir, hit.timeOfImpact));
    if (spec.decoy) return false;
    if (spec.barrier) {
      deployBarrier(sim, p, sub(point, scale(dir, 0.6)), dir, spec.barrier);
      return false;
    }
    if (spec.mine) {
      // Une mine se pose là où elle tombe
      p.pos = sub(point, scale(dir, 0.05));
      p.vel = vec3(0, 0, 0);
      p.landed = true;
      return true;
    }
    const target = hitTargetOf(sim.colliders.get(hit.collider.handle), point, dir);
    // Tir réparateur (rayon, nanites) : il remet en état un allié autour du point touché ; sur un
    // ennemi, le rayon vole de la vie (combat/repair.ts)
    if (spec.repair) {
      const bot = target?.kind === "block" ? target.block.bot : target?.kind === "wheel" ? target.wheel.bot : null;
      if (bot && !areEnemies(p.shooter, bot)) repairAt(sim, bot, point, spec.repair);
      else if (target?.kind === "block" && p.shooter && spec.repair.drain) drainAt(sim, target.block, point, dir, spec.repair, p.shooter, p.origin, p.weapon);
      else sim.emit({ type: "impact", point, surface: surfaceOf(target) });
      return false;
    }
    if (spec.explosion || spec.emp || spec.smoke) {
      strike(sim, target, p.damage, spec.damageType, point, dir, spec.impulse, p.origin, p.shooter, p.weapon);
      detonate(sim, p, point, dir, surfaceOf(target));
      return false;
    }
    // Repère du morceau touché, relevé avant le coup : s'il ne restait que ce bloc, le corps disparaît
    const frame = target?.kind === "block" ? { q: target.block.part.rb.rotation(), origin: target.block.part.rb.translation() } : null;
    const result = strike(sim, target, p.damage, spec.damageType, point, dir, spec.impulse, p.origin, p.shooter, p.weapon);
    if (spec.ignite && target?.kind === "block" && target.block.alive && rand(0, 1) < spec.ignite) ignite(sim, target.block);
    // Le bois prend plus vite que l'acier
    if (spec.ignite && target?.kind === "prop" && target.prop.hp > 0 && rand(0, 1) < spec.ignite * WOOD_KINDLING) igniteProp(sim, target.prop);
    // Un jet de flammes sur le sol ou le décor y laisse parfois une flaque de feu (au pied d'un mur)
    if (!target || target.kind === "prop") leavePuddle(sim, p, point);
    if (!spec.penetrating || !result.destroyed || p.damage - result.absorbed <= 0) {
      sim.emit({ type: "impact", point, surface: surfaceOf(target) });
      return false;
    }
    // Perforation : il continue avec les dégâts qui lui restent, à travers le robot puis au-delà
    p.damage -= result.absorbed;
    let exit = point;
    if (target?.kind === "block" && frame) {
      const out = pierceRobot(sim, p, target.block.bot, frame, point, dir);
      if (!out) return false;
      exit = out;
    }
    remaining -= hit.timeOfImpact + distance(point, exit);
    from = exit;
  }
  p.pos = add(p.pos, scale(p.vel, STEP));
  return true;
}

/**
 * Perforation à l'intérieur d'un robot : le projectile avance dans la grille du robot par petits
 * pas et frappe chaque bloc rencontré tant qu'il lui reste des dégâts. On ne passe pas par les
 * lancers de rayon de Rapier : les colliders d'un morceau, reconstruits après chaque destruction,
 * n'y sont visibles qu'au pas suivant. Tous les morceaux du robot partagent son repère, et une
 * séparation ne les déplace pas pendant ce pas. Renvoie le point de sortie, ou null s'il s'arrête.
 */
function pierceRobot(sim: Simulation, p: Projectile, bot: Bot, frame: { q: Quat; origin: Vec3 }, entry: Vec3, dir: Vec3): Vec3 | null {
  const spec = weaponDef(p.weapon).projectile;
  const { q, origin } = frame;
  let last: Block | null = null;
  let point = entry;
  for (let travelled = 0; travelled < PIERCE_REACH; travelled += PIERCE_STEP) {
    point = add(point, scale(dir, PIERCE_STEP));
    const local = qrotInv(q, sub(point, origin));
    const block = bot.blocks.get(cellKey(Math.round(local.x / BLOCK_SIZE), Math.round(local.y / BLOCK_SIZE), Math.round(local.z / BLOCK_SIZE)));
    if (!block || block === last) continue;
    last = block;
    const result = strike(sim, { kind: "block", block }, p.damage, spec.damageType, point, dir, spec.impulse, p.origin, p.shooter, p.weapon);
    p.damage -= result.absorbed;
    if (!result.destroyed || p.damage <= 0) {
      sim.emit({ type: "impact", point, surface: "robot" });
      return null;
    }
  }
  return point;
}

/** Le bois s'enflamme d'autant plus facilement qu'un bloc (facteur sur `ProjectileSpec.ignite`). */
const WOOD_KINDLING = 2;

/** Flaque de feu d'un jet de lance-flammes (`ProjectileSpec.puddle`), s'il y a du sol juste dessous. */
function leavePuddle(sim: Simulation, p: Projectile, at: Vec3): void {
  const puddle = weaponDef(p.weapon).projectile.puddle;
  if (!puddle || rand(0, 1) >= puddle.chance) return;
  const ground = groundBelow(sim, at, PUDDLE_REACH);
  if (ground) spawnGroundFire(sim, ground, puddle, p.shooter);
}

/** Ce que touche un projectile, pour le bruit de l'impact : rien de touché, c'est le décor. */
const surfaceOf = (target: HitTarget | undefined): ImpactSurface =>
  !target ? "scenery" : target.kind === "prop" ? "prop" : "robot";

/**
 * Fin d'un projectile qui éclate : explosion, impulsion électromagnétique, nuage de fumée.
 * `surface` : ce qu'il a touché (une fusée de proximité éclate en l'air : le décor).
 */
export function detonate(sim: Simulation, p: Projectile, point: Vec3, dir: Vec3, surface: ImpactSurface = "scenery"): void {
  const spec = weaponDef(p.weapon).projectile;
  // L'éclat se produit juste devant la surface touchée, pas dedans
  const at = sub(point, scale(dir, 0.15));
  if (spec.emp) empPulse(sim, at, spec.emp);
  if (spec.smoke) releaseSmoke(sim, at, spec.smoke);
  if (spec.explosion) explode(sim, point, spec.explosion, dir, p.origin, p.shooter, p.weapon);
  else if (!spec.emp && !spec.smoke) sim.emit({ type: "impact", point, surface });
}

/**
 * Ce qu'un projectile peut toucher : pas les débris, ni le robot qui l'a tiré. Une mine ne se
 * pose que sur le décor et les accessoires (les robots la déclenchent par proximité) ; un leurre
 * traverse les robots.
 */
function canHit(sim: Simulation, p: Projectile, c: Collider, groundOnly: boolean): boolean {
  const owner = sim.colliders.get(c.handle);
  if (!owner) return true; // sol et décor fixe
  if (owner.kind === "debris") return false;
  const bot = ownerBot(owner);
  if (bot && bot === p.shooter) return false;
  return !(groundOnly && bot);
}

/** Une tête chercheuse qui ne voit plus sa cible file sur son élan pendant ce temps (s), puis la perd. */
const SEEKER_MEMORY = 1.2;

/** Un missile téléguidé vise sa ligne de visée à cette distance devant lui (m) : il la rejoint en douceur. */
const LINE_LEAD = 6;

/**
 * Guidage : un missile téléguidé suit l'axe de visée de son lance-missiles (sans lance-missiles
 * vivant, ou à la caméra libre, le point visé) ; un missile à tête chercheuse
 * poursuit sa cible, en visant là où elle sera ; une ogive pilotée par un joueur va où il regarde
 * (le point visé de ses commandes). Il tourne au plus de `turnRate` rad/s. Un leurre ennemi qu'il
 * voit peut le détourner (combat/decoys.ts) : il le suit, puis, le leurre éteint, file droit.
 */
function steer(sim: Simulation, p: Projectile): void {
  const spec = weaponDef(p.weapon).projectile;
  const guidance = spec.guidance;
  if (!guidance) return;
  // Son moteur lui rend peu à peu la vitesse que ses virages lui ont coûtée (voir `Guidance.recover`)
  if (guidance.recover) {
    const s = len(p.vel);
    if (s > 0.1) p.vel = scale(p.vel, (s + (spec.speed - s) * Math.min(1, guidance.recover * STEP)) / s);
  }
  // Départ : il file d'abord droit dans l'axe de l'arme (voir `Guidance.launch`)
  if (guidance.launch && p.age < guidance.launch) return;
  seduce(sim, p);
  if (p.decoy?.done) {
    p.decoy = null;
    p.lost = true;
  }
  if (p.lost) return;
  let target: Vec3 | null = null;
  if (p.decoy) {
    target = p.decoy.pos;
  } else if (guidance.mode === "piloted" && p.shooter?.controller === "player") {
    target = (p.shooter.input ?? sim.input).aim;
  } else if (guidance.mode === "command" && p.commander?.block.alive) {
    // Téléguidé : il suit l'axe de visée de son lance-missiles (la ligne qui part de sa bouche,
    // dans l'axe du canon), un peu devant lui ; tourner la tourelle le ramène sur la nouvelle ligne
    const { muzzle, dir } = turretFrame(p.commander);
    const along = Math.max(0, dot(sub(p.pos, muzzle), dir));
    target = add(muzzle, scale(dir, along + LINE_LEAD));
  } else if (guidance.mode === "command" || guidance.mode === "piloted") {
    target = p.commander ? p.commander.aim : sim.playerAim;
  } else if (p.homing?.cockpit.alive) {
    const rb = p.homing.cockpit.part.rb;
    const where = rb.worldCom();
    const eta = distance(where, p.pos) / Math.max(1, len(p.vel));
    target = add(where, scale(rb.linvel(), eta));
    // Tête chercheuse : il doit voir sa cible. Cachée par le décor, un accessoire ou la fumée, il
    // file sur son élan sans virer (tiré par-dessus une colline, il monte et la retrouve d'en haut ;
    // piquer vers elle l'aurait jeté dans la colline) ; au-delà de `SEEKER_MEMORY`, il l'a perdue et
    // file droit. (Pas les nanites : elles vont à un allié qui les appelle.)
    if (!spec.repair) {
      if (sightBlocked(sim, p.pos, p.homing)) {
        p.blind += STEP;
        if (p.blind > SEEKER_MEMORY) p.lost = true;
        return;
      }
      p.blind = 0;
      p.seen = target;
    }
  }
  if (!target) return;
  const speed = len(p.vel);
  const heading = scale(p.vel, 1 / speed);
  // Un missile qui a de l'élan ne vire pas plus serré que son accélération latérale ne le permet,
  // et chaque virage lui coûte de la vitesse (voir `Guidance.maxAccel`, `bleed`)
  const rate = guidance.maxAccel ? Math.min(guidance.turnRate, guidance.maxAccel / Math.max(1, speed)) : guidance.turnRate;
  const turned = turnToward(heading, norm(sub(target, p.pos)), rate * STEP);
  const angle = Math.acos(clamp(dot(heading, turned), -1, 1));
  p.vel = scale(turned, speed * (1 - (guidance.bleed ?? 0) * angle));
}

/** Tourne le vecteur unitaire `dir` vers `want` d'au plus `maxAngle` rad. */
function turnToward(dir: Vec3, want: Vec3, maxAngle: number): Vec3 {
  const angle = Math.acos(clamp(dot(dir, want), -1, 1));
  if (angle <= maxAngle) return want;
  let axis = cross(dir, want);
  if (len(axis) < 1e-6) axis = Math.abs(dir.y) < 0.9 ? cross(dir, vec3(0, 1, 0)) : cross(dir, vec3(1, 0, 0));
  return qrot(axisAngle(norm(axis), maxAngle), dir);
}

/** Écarte une direction d'un angle aléatoire d'au plus `spread` rad. */
function scatter(dir: Vec3, spread: number): Vec3 {
  if (!spread) return dir;
  const side = norm(Math.abs(dir.y) < 0.9 ? cross(dir, vec3(0, 1, 0)) : cross(dir, vec3(1, 0, 0)));
  const turned = qrot(axisAngle(side, rand(-spread, spread)), dir);
  return qrot(axisAngle(dir, rand(0, Math.PI * 2)), turned);
}

/** Ogive pilotée en vol tirée par ce robot, s'il y en a une (voir `Guidance`). */
export function pilotedWarhead(sim: Simulation, bot: Bot): Projectile | null {
  return sim.projectiles.find((p) => p.shooter === bot && weaponDef(p.weapon).projectile.guidance?.mode === "piloted") ?? null;
}

/** Le projectile explose au pas suivant, là où il est, comme en fin de course. */
export function fuseNow(p: Projectile): void {
  p.age = Infinity;
}

/** Les deux robots sont-ils ennemis ? Le joueur (null) est l'ennemi de tous. */
export const areEnemies = (a: Bot | null, b: Bot): boolean => !a || (a !== b && a.team !== b.team);

/**
 * Un robot ennemi du tireur dont un bloc passe à moins de `radius` du projectile : robots en vol
 * seulement (`air`), au sol seulement (`ground`), ou tous.
 */
export function nearestEnemy(sim: Simulation, p: Projectile, radius: number, kind: "air" | "ground" | "any"): Bot | null {
  for (const bot of sim.bots) {
    if (!bot.cockpit.alive || !areEnemies(p.shooter, bot)) continue;
    const flying = bot.profile.mobility !== "ground";
    if ((kind === "air" && !flying) || (kind === "ground" && flying)) continue;
    if (distance(bot.lastPos, p.pos) > radius + PROXIMITY_REACH) continue;
    for (const b of bot.cockpit.part.blocks) if (distance(blockWorldPos(b), p.pos) < radius) return bot;
    for (const w of bot.wheels) if (w.part && distance(w.rb.translation(), p.pos) < radius) return bot;
  }
  return null;
}

/**
 * Cible d'une tête chercheuse pour un tir dans la direction `dir` depuis `origin` : le robot
 * ennemi (en vol si `airOnly`) le plus proche de l'axe de tir, dans un cône de 30°.
 */
export function findHomingTarget(sim: Simulation, origin: Vec3, dir: Vec3, airOnly: boolean, shooter: Bot | null): Bot | null {
  let best: Bot | null = null;
  let bestCos = Math.cos(Math.PI / 6);
  for (const bot of sim.bots) {
    if (!bot.cockpit.alive || !areEnemies(shooter, bot)) continue;
    if (airOnly && bot.profile.mobility === "ground") continue;
    const c = dot(norm(sub(bot.lastPos, origin)), dir);
    if (c > bestCos) {
      bestCos = c;
      best = bot;
    }
  }
  return best;
}
