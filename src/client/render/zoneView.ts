import * as B from "../babylon";
import type { ArenaLayout, CaptureZone } from "../../shared/arena/layout";
import type { Team } from "../../shared/sim/entities";
import type { ZoneState } from "../../shared/sim/match";
import type { World } from "../../shared/sim/world";
import { TEAM_COLORS } from "../teams";
import { context2d } from "./materials";

/** Couleur d'une zone neutre. */
const NEUTRAL = B.Color3.FromHexString("#c9d2d8");
const COLORS: Record<Team, B.Color3> = { red: B.Color3.FromHexString(TEAM_COLORS.red), blue: B.Color3.FromHexString(TEAM_COLORS.blue) };
/** Hauteur de la colonne de lumière, et de la lettre au-dessus (m). */
const BEAM_HEIGHT = 7;
const LABEL_HEIGHT = 8.2;
/** Clignotement d'une zone disputée (rad/s). */
const CONTEST_BLINK = 9;

interface ZoneMeshes {
  disc: B.Mesh;
  ring: B.Mesh;
  beam: B.Mesh;
  label: B.Mesh;
  discMat: B.StandardMaterial;
  ringMat: B.StandardMaterial;
  beamMat: B.StandardMaterial;
}

/**
 * Zones à capturer (mode Capture de zones) : un disque au sol à la couleur de l'équipe qui la
 * tient, un anneau qui prend la couleur de l'équipe qui la prend à mesure qu'elle avance, une
 * colonne de lumière visible de loin et sa lettre au-dessus. Une zone disputée clignote.
 */
export class ZoneView {
  private readonly scene: B.Scene;
  private zones: ZoneMeshes[] = [];
  private layout: ArenaLayout | null = null;

  constructor(scene: B.Scene) {
    this.scene = scene;
  }

  sync(world: World, time: number): void {
    const states = world.match?.zones ?? [];
    if (!states.length) {
      if (this.layout) this.clear();
      return;
    }
    if (world.arena !== this.layout) {
      this.clear();
      this.layout = world.arena;
      this.zones = world.arena.zones.map((z) => this.build(z));
    }
    states.forEach((state, i) => {
      const meshes = this.zones[i];
      if (meshes) paint(meshes, state, time);
    });
  }

  private clear(): void {
    for (const z of this.zones) {
      for (const m of [z.disc, z.ring, z.beam, z.label]) {
        m.material?.dispose(true, true);
        m.dispose();
      }
    }
    this.zones = [];
    this.layout = null;
  }

  private build(zone: CaptureZone): ZoneMeshes {
    const { pos, radius, label: letter } = zone;
    const glow = (name: string, alpha: number): B.StandardMaterial => {
      const mat = new B.StandardMaterial(name, this.scene);
      mat.disableLighting = true;
      mat.emissiveColor = NEUTRAL.clone();
      mat.alpha = alpha;
      return mat;
    };
    const discMat = glow("zone-disc", 0.22);
    const disc = B.MeshBuilder.CreateCylinder("zone-disc", { height: 0.02, diameter: radius * 2, tessellation: 48 }, this.scene);
    disc.position.set(pos.x, pos.y + 0.03, pos.z);
    disc.material = discMat;

    const ringMat = glow("zone-ring", 0.85);
    const ring = B.MeshBuilder.CreateTorus("zone-ring", { diameter: radius * 2, thickness: 0.14, tessellation: 64 }, this.scene);
    ring.position.set(pos.x, pos.y + 0.07, pos.z);
    ring.material = ringMat;

    const beamMat = glow("zone-beam", 0.3);
    const beam = B.MeshBuilder.CreateCylinder("zone-beam", { height: BEAM_HEIGHT, diameter: 0.35, tessellation: 12 }, this.scene);
    beam.position.set(pos.x, pos.y + BEAM_HEIGHT / 2, pos.z);
    beam.material = beamMat;

    const tex = new B.DynamicTexture("zone-label", { width: 128, height: 128 }, this.scene, true);
    tex.hasAlpha = true;
    const ctx = context2d(tex);
    ctx.clearRect(0, 0, 128, 128);
    ctx.fillStyle = "rgba(17, 22, 28, 0.85)";
    ctx.beginPath();
    ctx.arc(64, 64, 58, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#e5ecf1";
    ctx.font = "700 76px 'Chakra Petch', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(letter, 64, 68);
    tex.update();
    const labelMat = new B.StandardMaterial("zone-label", this.scene);
    labelMat.diffuseTexture = tex;
    labelMat.emissiveColor = B.Color3.White();
    labelMat.disableLighting = true;
    labelMat.useAlphaFromDiffuseTexture = true;
    const label = B.MeshBuilder.CreatePlane("zone-label", { size: 1.6 }, this.scene);
    label.position.set(pos.x, pos.y + LABEL_HEIGHT, pos.z);
    label.billboardMode = B.Mesh.BILLBOARDMODE_ALL;
    label.material = labelMat;
    label.renderingGroupId = 1;

    for (const m of [disc, ring, beam, label]) m.isPickable = false;
    return { disc, ring, beam, label, discMat, ringMat, beamMat };
  }
}

/** Couleurs d'une zone d'après son état : disque et colonne à l'équipe qui la tient, anneau à celle qui la prend. */
function paint(z: ZoneMeshes, state: ZoneState, time: number): void {
  // Hors jeu (roi de la colline) : on ne la montre pas
  for (const m of [z.disc, z.ring, z.beam, z.label]) if (m.isEnabled() !== state.active) m.setEnabled(state.active);
  if (!state.active) return;
  const held = state.owner ? COLORS[state.owner] : NEUTRAL;
  z.discMat.emissiveColor.copyFrom(held);
  z.beamMat.emissiveColor.copyFrom(held);
  const toward = state.progress > 0 ? COLORS.blue : COLORS.red;
  B.Color3.LerpToRef(NEUTRAL, toward, Math.min(1, Math.abs(state.progress)), z.ringMat.emissiveColor);
  const blink = state.contested ? 0.5 + 0.5 * Math.sin(time * CONTEST_BLINK) : 1;
  z.ringMat.alpha = 0.35 + 0.5 * blink;
  z.discMat.alpha = state.owner ? 0.3 : 0.16;
}
