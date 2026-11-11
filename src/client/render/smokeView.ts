import * as B from "../babylon";
import { smokeRadius } from "../../shared/combat/smoke";
import type { SmokeCloud } from "../../shared/sim/entities";
import type { SimEvent } from "../../shared/sim/events";
import type { World } from "../../shared/sim/world";
import type { FxLook } from "../settings";

/** Nombre de bulles d'un nuage. */
const PUFFS = 7;

interface CloudMeshes {
  cloud: SmokeCloud;
  puffs: { mesh: B.Mesh; offset: B.Vector3; size: number }[];
}

/**
 * Nuages de fumée (voir combat/smoke.ts), en effets simples : quelques grosses bulles grises
 * translucides autour du centre, qui grossissent avec le nuage puis s'effacent. En effets
 * réalistes, c'est un effet (render/fx/smokeCloudFx.ts) : les bulles sont cachées.
 */
export class SmokeView {
  private readonly sim: World;
  private readonly scene: B.Scene;
  private readonly material: B.StandardMaterial;
  private readonly clouds = new Map<number, CloudMeshes>();
  private readonly unsubscribe: () => void;
  private hidden = false;

  constructor(sim: World, scene: B.Scene) {
    this.sim = sim;
    this.scene = scene;
    this.material = new B.StandardMaterial("smoke", scene);
    this.material.diffuseColor = B.Color3.FromHexString("#9aa3aa");
    this.material.emissiveColor = B.Color3.FromHexString("#3a4046");
    this.material.specularColor = B.Color3.Black();
    this.material.alpha = 0.6;
    this.unsubscribe = sim.on((e) => this.onEvent(e));
  }

  /** Allure de la fumée : en effets réalistes, les bulles sont cachées (un effet dessine le nuage). */
  setFxLook(look: FxLook): void {
    this.hidden = look === "realistic";
    for (const { puffs } of this.clouds.values()) for (const { mesh } of puffs) mesh.setEnabled(!this.hidden);
  }

  sync(): void {
    if (this.hidden) return;
    for (const { cloud, puffs } of this.clouds.values()) {
      const r = smokeRadius(cloud, this.sim.time);
      const k = r / cloud.radius;
      for (const { mesh, offset, size } of puffs) {
        mesh.position.set(cloud.pos.x + offset.x * r, cloud.pos.y + offset.y * r, cloud.pos.z + offset.z * r);
        mesh.scaling.setAll(Math.max(0.01, size * r));
        mesh.visibility = Math.min(1, k * 1.5);
      }
    }
  }

  /** Préparation (écran de chargement) : une bulle en `at`, pour que sa matière soit compilée avant la partie. Rend de quoi la retirer. */
  warmUp(at: { x: number; y: number; z: number }): () => void {
    const mesh = B.MeshBuilder.CreateSphere("smoke-warm-up", { diameter: 2, segments: 6 }, this.scene);
    mesh.material = this.material;
    mesh.isPickable = false;
    mesh.position.set(at.x, at.y, at.z);
    mesh.visibility = 0.5;
    return () => mesh.dispose();
  }

  dispose(): void {
    this.unsubscribe();
    for (const id of [...this.clouds.keys()]) this.remove(id);
    this.material.dispose();
  }

  private onEvent(e: SimEvent): void {
    if (e.type === "smokeAdded") this.add(e.cloud);
    else if (e.type === "smokeRemoved") this.remove(e.cloud.id);
  }

  private add(cloud: SmokeCloud): void {
    const puffs = Array.from({ length: PUFFS }, (_, i) => {
      const mesh = B.MeshBuilder.CreateSphere(`smoke${cloud.id}-${i}`, { diameter: 2, segments: 6 }, this.scene);
      mesh.material = this.material;
      mesh.isPickable = false;
      mesh.setEnabled(!this.hidden);
      const a = Math.random() * Math.PI * 2;
      const d = i === 0 ? 0 : 0.35 + Math.random() * 0.3;
      const offset = new B.Vector3(Math.cos(a) * d, Math.random() * 0.4 - 0.1, Math.sin(a) * d);
      return { mesh, offset, size: 0.5 + Math.random() * 0.25 };
    });
    this.clouds.set(cloud.id, { cloud, puffs });
  }

  private remove(id: number): void {
    for (const { mesh } of this.clouds.get(id)?.puffs ?? []) mesh.dispose();
    this.clouds.delete(id);
  }
}
