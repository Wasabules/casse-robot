import * as B from "../babylon";
import { clamp } from "../../shared/math/scalar";
import type { Vec3 } from "../../shared/math/vec";
import type { Bot } from "../../shared/sim/entities";
import { TEAM_COLORS } from "../teams";
import { context2d } from "./materials";
import { botName } from "../i18n/names";

/** Hauteur de l'étiquette au-dessus du bloc le plus haut (m). */
const OFFSET = 1.4;
/** Champ de vision (rad) pour lequel l'étiquette garde sa taille ; plus étroit (viseur), elle rapetisse d'autant. */
const BASE_FOV = 0.8;

/** Étiquette flottante avec le nom du robot, barrée quand son cockpit est détruit. */
export class BotTag {
  readonly bot: Bot;
  private readonly mesh: B.Mesh;
  private readonly tex: B.DynamicTexture;
  private readonly mat: B.StandardMaterial;
  private alive = true;

  constructor(scene: B.Scene, bot: Bot) {
    this.bot = bot;
    this.tex = new B.DynamicTexture("tag", { width: 256, height: 64 }, scene, true);
    this.tex.hasAlpha = true;
    this.mat = new B.StandardMaterial("tagMat", scene);
    this.mat.diffuseTexture = this.tex;
    this.mat.emissiveTexture = this.tex;
    this.mat.useAlphaFromDiffuseTexture = true;
    this.mat.disableLighting = true;
    this.mat.fogEnabled = false;
    this.mat.backFaceCulling = false;
    this.mesh = B.MeshBuilder.CreatePlane("tag", { width: 2.2, height: 0.55 }, scene);
    this.mesh.material = this.mat;
    this.mesh.billboardMode = B.Mesh.BILLBOARDMODE_ALL;
    this.mesh.isPickable = false;
    this.mesh.renderingGroupId = 1;
    this.redraw();
  }

  /** Où est le robot (son cockpit, ou là où il était) : ce que l'étiquette désigne. */
  anchor(): Vec3 {
    const ck = this.bot.cockpit;
    return ck.alive ? ck.part.rb.translation() : this.bot.lastPos;
  }

  /**
   * Suit le cockpit et garde une taille lisible à distance, et la même au viseur (la caméra zoome) ;
   * `opacity` : 1, ou moins quand le robot est caché (un fumigène entre la caméra et lui).
   */
  update(camera: B.Camera, visible: boolean, opacity = 1): void {
    this.mesh.isVisible = visible && opacity > 0.01;
    if (!this.mesh.isVisible) return;
    this.mesh.visibility = opacity;
    const p = this.anchor();
    this.mesh.position.set(p.x, p.y + this.bot.top + OFFSET, p.z);
    const dist = B.Vector3.Distance(camera.position, this.mesh.position);
    const zoom = Math.tan(camera.fov / 2) / Math.tan(BASE_FOV / 2);
    this.mesh.scaling.setAll(clamp(dist / 20, 0.9, 2.6) * zoom);
    const alive = this.bot.cockpit.alive;
    if (alive !== this.alive) {
      this.alive = alive;
      this.redraw();
    }
  }

  dispose(): void {
    this.tex.dispose();
    this.mat.dispose();
    this.mesh.dispose();
  }

  /** Dessine l'étiquette (aussi quand la langue change : le nom d'un robot prédéfini se traduit). */
  redraw(): void {
    const { alive } = this;
    const name = botName(this.bot.profile);
    const c = context2d(this.tex);
    c.clearRect(0, 0, 256, 64);
    c.fillStyle = alive ? "rgba(17,22,28,0.82)" : "rgba(17,22,28,0.45)";
    c.beginPath();
    c.roundRect(2, 8, 252, 48, 6);
    c.fill();
    c.fillStyle = alive ? TEAM_COLORS[this.bot.team] : "#6b7680";
    c.fillRect(12, 18, 8, 28);
    c.fillStyle = alive ? "#e5ecf1" : "#93a2ae";
    c.font = "600 28px 'Chakra Petch', 'Arial Narrow', sans-serif";
    c.textBaseline = "middle";
    c.fillText(alive ? name : `${name} ✕`, 32, 33);
    this.tex.update();
  }
}
