import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as B from "../src/client/babylon";
import { InstanceLayer } from "../src/client/render/fx/layer";
import { cascadeLambda, sliceHull, touchesHull } from "../src/client/render/scene";
import { SmokeVeil, veilMaterial, veilState } from "../src/client/render/smokeVeil";
import { WEAPONS } from "../src/shared/catalog/weapons";
import { releaseSmoke, smokeBlocks } from "../src/shared/combat/smoke";
import { vec3 } from "../src/shared/math/vec";
import { initPhysics, Simulation } from "../src/shared/sim/simulation";

/*
 * Ce que les fumigènes cachent (render/smokeVeil.ts), les marques au sol (leur couleur d'instance) et
 * les limites des cascades d'ombres (render/scene.ts).
 */

describe("le voile des fumigènes", () => {
  let engine: NullEngine;
  let scene: B.Scene;
  let sim: Simulation;
  let veil: SmokeVeil;

  beforeAll(async () => {
    await initPhysics();
    engine = new NullEngine();
    scene = new B.Scene(engine);
  });
  afterAll(() => {
    scene.dispose();
    engine.dispose();
  });
  beforeEach(() => {
    sim = new Simulation();
    veil = new SmokeVeil(scene, sim);
  });
  afterEach(() => {
    veil.dispose();
    sim.dispose();
  });
  const run = (seconds: number): void => {
    for (let i = 0; i < seconds * 60; i++) sim.step();
  };

  it("un nuage cache ce qui est derrière lui (comme le voit la simulation), pas ce qui est devant ni à côté", () => {
    const eye = vec3(-20, 3, 0);
    veil.update(eye);
    expect(veil.transmittance(eye, vec3(20, 1, 0))).toBe(1);
    releaseSmoke(sim, vec3(0, 0.5, 0), WEAPONS.smoke.projectile.smoke);
    run(1.5);
    veil.update(eye);
    // Derrière le nuage : presque rien ne passe (la simulation, elle, ne voit pas au travers)
    expect(smokeBlocks(sim, eye, vec3(20, 1, 0))).toBe(true);
    expect(veil.transmittance(eye, vec3(20, 1, 0))).toBeLessThan(0.05);
    // Dedans, en son cœur : à moitié caché, ou plus
    expect(veil.transmittance(eye, vec3(0, 2, 0))).toBeLessThan(0.5);
    // Devant lui, ou loin à côté : rien ne le cache
    expect(veil.transmittance(eye, vec3(-12, 1, 0))).toBe(1);
    expect(veil.transmittance(eye, vec3(20, 1, 25))).toBe(1);
    // Ses deux premiers mètres devant la caméra ne cachent rien (les volutes s'y effacent)
    expect(veil.transmittance(vec3(-7, 2.1, 0), vec3(-5.1, 2.1, 0))).toBe(1);
    expect(veil.transmittance(vec3(-7, 2.1, 0), vec3(-3, 2.1, 0))).toBeLessThan(1);
    // Au ras de son bord, il s'efface sans marche (la densité tombe à rien au bord de l'ellipsoïde,
    // de 1,05 × 6 m à l'horizontale, 0,75 fois moins haut, son centre à 0,35 × 6 m de haut)
    const grazing = [5.7, 6.0, 6.25, 6.4].map((z) => veil.transmittance(vec3(-20, 2.1, z), vec3(20, 2.1, z)));
    expect(grazing[0]).toBeLessThan(grazing[1]);
    expect(grazing[1]).toBeLessThan(grazing[2]);
    expect(grazing[2]).toBeGreaterThan(0.95);
    expect(grazing[3]).toBe(1);
    // Il est moins haut que large : juste au-dessus, presque rien ne le cache ; plus haut, rien
    expect(veil.transmittance(vec3(-20, 6.5, 0), vec3(20, 6.5, 0))).toBeGreaterThan(0.6);
    expect(veil.transmittance(vec3(-20, 7, 0), vec3(20, 7, 0))).toBe(1);
    // Les uniformes des shaders : une boule, sa densité ; rien au-delà
    const state = veilState(scene);
    expect(state.density[0]).toBeGreaterThan(0);
    expect([...state.density.subarray(1)]).toEqual([0, 0, 0]);
  });

  it("le nuage dissipé ne cache plus rien", () => {
    const eye = vec3(-20, 3, 0);
    releaseSmoke(sim, vec3(0, 0.5, 0), WEAPONS.smoke.projectile.smoke);
    run(WEAPONS.smoke.projectile.smoke.duration + 0.5);
    veil.update(eye);
    expect(veil.transmittance(eye, vec3(20, 1, 0))).toBe(1);
    expect(veilState(scene).density[0]).toBe(0);
  });

  it("une matière transparente reçoit le voile, une seule fois", () => {
    const mat = new B.StandardMaterial("essai", scene);
    veilMaterial(mat);
    veilMaterial(mat);
    expect(mat.pluginManager?.getPlugin("SmokeVeil")).toBeTruthy();
    mat.dispose();
  });
});

describe("couches d'effets en instances fines", () => {
  let engine: NullEngine;
  let scene: B.Scene;

  beforeAll(() => {
    engine = new NullEngine();
    scene = new B.Scene(engine);
  });
  afterAll(() => {
    scene.dispose();
    engine.dispose();
  });

  it("une couche vérifiée vide garde la couleur de ses instances quand elle se remplit (marques au sol)", () => {
    const disc = B.MeshBuilder.CreateCylinder("disque", { height: 0.001, diameter: 1, tessellation: 8 }, scene);
    const layer = new InstanceLayer(scene, "essai-marques", disc, { blend: "blend", lit: true, capacity: 4 });
    layer.begin();
    layer.end();
    // La scène vérifiée pendant que la couche est vide (l'écran de chargement le fait)
    disc.setEnabled(true);
    disc.isReady(true);
    layer.begin();
    layer.writeScaled(0, 0, 0, 1, 1, 1, 0.2, 0.1, 0.05, 0.5);
    layer.end();
    // (les défines de la matière revues : sans moteur réel, son shader n'est pas forcément prêt)
    disc.isReady(true);
    const defines = disc.subMeshes[0].materialDefines as B.MaterialDefines;
    expect(defines["INSTANCESCOLOR"]).toBe(true);
    layer.dispose();
  });
});

describe("limites des cascades d'ombres", () => {
  /** La limite de la première cascade, comme Babylon la calcule (`_splitFrustum`). */
  const firstSplit = (lambda: number, near: number, maxZ: number, cascades: number): number => {
    const p = 1 / cascades;
    const log = near * (maxZ / near) ** p;
    const uniform = near + (maxZ - near) * p;
    return lambda * (log - uniform) + uniform;
  };

  it("la première cascade finit où on le demande, dans une petite arène comme dans une grande", () => {
    for (const [maxZ, cascades] of [[110, 2], [240, 3]]) {
      expect(firstSplit(cascadeLambda(28, 0.1, maxZ, cascades), 0.1, maxZ, cascades)).toBeCloseTo(28, 6);
      expect(firstSplit(cascadeLambda(40, 0.1, maxZ, cascades), 0.1, maxZ, cascades)).toBeCloseTo(40, 6);
    }
    // Au-delà du partage égal : le partage égal (lambda 0)
    expect(cascadeLambda(90, 0.1, 110, 2)).toBe(0);
  });

  it("une cascade ne dessine que ce qui touche la tranche du champ de la caméra, vue du soleil", () => {
    // Un tronc de pyramide vu d'en haut : quatre coins proches (petit carré), quatre lointains (grand)
    const points = new Float64Array([-1, 1, 1, 1, 1, 3, -1, 3, -6, 20, 6, 20, 6, 30, -6, 30]);
    const hull = new Float64Array(32);
    const sides = sliceHull(points, hull);
    expect(sides).toBe(6);
    expect(touchesHull(hull, sides, 0, 10, 0.1)).toBe(true);
    // Hors du tronc, mais dans son carré englobant : rien à dessiner, sauf si le disque l'atteint
    expect(touchesHull(hull, sides, -5, 2, 0.5)).toBe(false);
    expect(touchesHull(hull, sides, -5, 2, 4)).toBe(true);
    expect(touchesHull(hull, sides, 8, 25, 1)).toBe(false);
    expect(touchesHull(hull, sides, 8, 25, 2.5)).toBe(true);
  });
});
