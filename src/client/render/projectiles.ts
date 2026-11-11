import * as B from "../babylon";
import { WEAPONS, weaponDef, type MineWeaponId, type WeaponId } from "../../shared/catalog/weapons";
import { cross, distance, len, norm, quatFromBasis, scale, vec3, type Vec3 } from "../../shared/math/vec";
import type { Bot, Projectile, Team } from "../../shared/sim/entities";
import type { SimEvent } from "../../shared/sim/events";
import type { World } from "../../shared/sim/world";
import type { FxLook } from "../settings";
import { TEAM_COLORS } from "../teams";
import type { Assets } from "./materials";
import { blinkOn, MINE_MODELS } from "./models/mines";
import { isTracer } from "./tracers";

/** Longueur d'une traçante : la distance parcourue pendant ce temps (s), pour donner une impression de vitesse. */
const TRACER_TIME = 0.02;
/** Plasma : chaque tir est étiré sur la distance parcourue pendant ce temps (s) ; ils se suivent en un jet continu. */
const PLASMA_TIME = 0.055;
/**
 * Au viseur, ses propres projectiles ne sont dessinés qu'à partir de cette distance de la caméra
 * (m) : partis de canons voisins de l'objectif, ils boucheraient la vue, d'un côté puis de l'autre.
 */
const OWN_NEAR = 6;

const isMineWeapon = (weapon: WeaponId): weapon is MineWeaponId => !!weaponDef(weapon).projectile.mine;

/** Une traçante (voir `isTracer`) : plus longue, plus épaisse, à la couleur de l'équipe du tireur. */
const TRACER_STRETCH = 1.8;

/** Traçante d'une équipe (ou de la caméra libre, `free`), une par scène. */
const TRACERS = new WeakMap<B.Scene, Map<Team | "free", B.Mesh>>();
function tracerSource(scene: B.Scene, team: Team | null): B.Mesh {
  let byTeam = TRACERS.get(scene);
  if (!byTeam) {
    byTeam = new Map();
    TRACERS.set(scene, byTeam);
  }
  const key = team ?? "free";
  let mesh = byTeam.get(key);
  if (!mesh) {
    mesh = B.MeshBuilder.CreateBox(`src-tracer-${key}`, { width: 0.08, height: 0.08, depth: 1 }, scene);
    const mat = new B.StandardMaterial(`tracer-${key}`, scene);
    // Le cœur blanchit la couleur de l'équipe : elle se lit sans se confondre avec le décor
    const color = B.Color3.FromHexString(team ? TEAM_COLORS[team] : "#ffd24a");
    mat.emissiveColor = B.Color3.Lerp(color, B.Color3.White(), 0.25);
    mat.diffuseColor = B.Color3.Black();
    mat.specularColor = B.Color3.Black();
    mat.disableLighting = true;
    mesh.material = mat;
    mesh.isVisible = false;
    mesh.isPickable = false;
    byTeam.set(key, mesh);
  }
  return mesh;
}

/** Une balle de fusil est-elle une traçante ? */

/** Projectiles en vol : une instance par projectile, orientée selon sa vitesse. */
export class ProjectileView {
  private readonly world: World;
  private readonly assets: Assets;
  /** Chaque projectile et son instance ; une mine a en plus son voyant, accroché à elle. */
  private readonly meshes = new Map<number, { projectile: Projectile; mesh: B.InstancedMesh; light: B.InstancedMesh | null }>();
  private readonly unsubscribe: () => void;
  /** Au viseur : le robot dont la caméra est dans l'arme, et où elle est (voir `OWN_NEAR`). */
  near: { shooter: Bot; eye: Vec3 } | null = null;
  /** Effets réalistes : le jet du lance-flammes est fait de particules (render/fx/projectileTrails.ts), ses boules sont cachées. */
  private flamesHidden = false;

  setFxLook(look: FxLook): void {
    this.flamesHidden = look === "realistic";
  }

  constructor(sim: World, assets: Assets) {
    this.world = sim;
    this.assets = assets;
    this.unsubscribe = sim.on((e) => this.onEvent(e));
  }

  sync(): void {
    const near = this.near;
    for (const { projectile: p, mesh, light } of this.meshes.values()) {
      const look = weaponDef(p.weapon).projectile.look;
      const hide = (near !== null && p.shooter === near.shooter && distance(p.pos, near.eye) < OWN_NEAR) || (this.flamesHidden && look === "flame");
      if (mesh.isEnabled() === hide) mesh.setEnabled(!hide);
      if (hide) continue;
      mesh.position.set(p.pos.x, p.pos.y, p.pos.z);
      if (look === "mine") {
        // Une mine reste à plat, en vol comme posée : elle ne tourne qu'autour de la verticale
        if (Math.hypot(p.vel.x, p.vel.z) > 0.1) B.Quaternion.RotationYawPitchRollToRef(Math.atan2(p.vel.x, p.vel.z), 0, 0, mesh.rotationQuaternion!);
        // Son voyant ne s'allume qu'une fois posée (ou collée), et clignote à son rythme
        if (light) {
          const on = (p.landed || p.stuck !== null) && blinkOn(MINE_MODELS[p.weapon as MineWeaponId].light.blink, this.world.time, p.id);
          if (light.isEnabled() !== on) light.setEnabled(on);
        }
        continue;
      }
      const speed = len(p.vel);
      if (speed < 0.1) continue;
      const z = scale(p.vel, 1 / speed);
      const x = norm(Math.abs(z.y) < 0.95 ? cross(vec3(0, 1, 0), z) : cross(vec3(1, 0, 0), z));
      const q = quatFromBasis(x, cross(z, x), z);
      mesh.rotationQuaternion!.set(q.x, q.y, q.z, q.w);
      if (look === "bullet" && isTracer(p)) mesh.scaling.set(1, 1, Math.max(0.5, speed * TRACER_TIME * TRACER_STRETCH));
      else if (look === "bullet" || look === "beam" || look === "rail" || look === "repair") mesh.scaling.set(1, 1, Math.max(0.3, speed * TRACER_TIME));
      else if (look === "pellet") mesh.scaling.set(1, 1, Math.max(0.2, speed * TRACER_TIME * 0.6));
      else if (look === "flame") mesh.scaling.setAll(0.6 + p.age * 3.5);
      else if (look === "flare") mesh.scaling.setAll(0.8 + 0.35 * Math.sin(p.age * 47 + p.id)); // il crépite
      else if (look === "plasma") {
        // Le jet s'épaissit un peu en s'éloignant
        const width = 0.22 + p.age * 0.5;
        mesh.scaling.set(width, width, Math.max(width, speed * PLASMA_TIME));
      }
    }
  }

  /**
   * Préparation (écran de chargement) : une instance de chaque projectile, de chaque mine (et de son
   * voyant) et de chaque traçante, en `at`, pour que leurs modèles soient construits et leurs
   * matières compilées avant la partie. Rend de quoi les retirer.
   */
  warmUp(at: Vec3): () => void {
    const made: B.InstancedMesh[] = [];
    const add = (source: B.Mesh): void => {
      const m = source.createInstance("warm-up");
      m.position.set(at.x, at.y, at.z);
      m.isPickable = false;
      made.push(m);
    };
    for (const id of Object.keys(WEAPONS) as WeaponId[]) {
      if (isMineWeapon(id)) {
        add(this.assets.mineSource(id));
        add(this.assets.mineLightSource(id));
      } else {
        add(this.assets.projectileSource(weaponDef(id).projectile.look));
      }
    }
    const scene = this.assets.projectileSource("bullet").getScene();
    for (const team of [null, "red", "blue"] as const) add(tracerSource(scene, team));
    return () => {
      for (const m of made) m.dispose();
    };
  }

  dispose(): void {
    this.unsubscribe();
    for (const { mesh, light } of this.meshes.values()) {
      light?.dispose();
      mesh.dispose();
    }
    this.meshes.clear();
  }

  private onEvent(e: SimEvent): void {
    if (e.type === "projectileAdded") {
      const weapon = e.projectile.weapon;
      const look = weaponDef(weapon).projectile.look;
      // Les nanites n'ont pas de corps : c'est une nuée d'étincelles (render/fx/projectileTrails.ts)
      if (look === "nanites") return;
      const mine = isMineWeapon(weapon);
      const source = mine
        ? this.assets.mineSource(weapon)
        : isTracer(e.projectile)
          ? tracerSource(this.assets.projectileSource("bullet").getScene(), e.projectile.shooter?.team ?? null)
          : this.assets.projectileSource(look);
      const mesh = source.createInstance("projectile");
      mesh.rotationQuaternion = new B.Quaternion();
      mesh.isPickable = false;
      let light: B.InstancedMesh | null = null;
      if (mine) {
        light = this.assets.mineLightSource(weapon).createInstance("mine-light");
        light.parent = mesh;
        light.position.set(...MINE_MODELS[weapon].light.at);
        light.isPickable = false;
        light.setEnabled(false);
      }
      this.meshes.set(e.projectile.id, { projectile: e.projectile, mesh, light });
    } else if (e.type === "projectileRemoved") {
      const entry = this.meshes.get(e.projectile.id);
      entry?.light?.dispose();
      entry?.mesh.dispose();
      this.meshes.delete(e.projectile.id);
    }
  }
}
