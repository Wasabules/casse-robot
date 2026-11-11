import RAPIER from "@dimforge/rapier3d-compat";
import { beforeAll, describe, expect, it } from "vitest";
import { makeTerrain, rayTerrain, terrainHeight } from "../src/shared/arena/terrain";
import { norm, vec3 } from "../src/shared/math/vec";
import { initPhysics } from "../src/shared/sim/simulation";
import { seedRandom } from "./seed";
import { rand } from "../src/shared/math/scalar";

describe("relief", () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it("la hauteur calculée est celle du champ de hauteurs de Rapier, jusque dans ses triangles", () => {
    seedRandom(3);
    const terrain = makeTerrain(40, 8, () => rand(0, 6));
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    world.createCollider(RAPIER.ColliderDesc.heightfield(terrain.cells, terrain.cells, terrain.heights, { x: terrain.size, y: 1, z: terrain.size }), body);
    world.step();
    for (let i = 0; i < 200; i++) {
      const x = rand(-19.5, 19.5);
      const z = rand(-19.5, 19.5);
      const hit = world.castRay(new RAPIER.Ray({ x, y: 30, z }, { x: 0, y: -1, z: 0 }), 60, true);
      expect(hit).not.toBeNull();
      expect(30 - hit!.timeOfImpact).toBeCloseTo(terrainHeight(terrain, x, z), 3);
    }
    world.free();
  });

  it("un rayon trouve le relief qu'il traverse", () => {
    const hill = makeTerrain(100, 20, (x) => Math.max(0, 10 - Math.abs(x)));
    const d = rayTerrain(hill, vec3(-30, 3, 0), vec3(1, 0, 0), 60);
    expect(d).not.toBeNull();
    expect(d!).toBeCloseTo(23, 0); // le flanc de la colline passe 3 m à x = -7
    expect(rayTerrain(hill, vec3(-30, 20, 0), norm(vec3(1, 0, 0)), 60)).toBeNull(); // au-dessus
  });
});
