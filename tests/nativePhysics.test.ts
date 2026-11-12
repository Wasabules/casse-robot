import RAPIER from "@dimforge/rapier3d-compat";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/*
 * La sonde de la physique (temps 4) : Rapier 0.36 compilé par nous (crates/casse-sim, fonctionnalité
 * `physics` : `npm run native -- --probe`) et le Rapier du jeu (@dimforge/rapier3d-compat 0.21, le
 * même Rapier compilé par ses auteurs) avancent le même monde ; les poses doivent être les mêmes au
 * bit près. C'est ce qui permettra de vérifier au bit près la simulation portée en Rust contre celle
 * du TypeScript. Sautée si la sonde n'est pas construite (elle demande Rust).
 */

const PROBE = join(process.cwd(), "target", "probe", "wasm32-unknown-unknown", "release", "casse_sim.wasm");

interface Probe {
  memory: { buffer: ArrayBuffer };
  alloc(len: number): number;
  probe_new(gravity: number, dt: number, iterations: number): number;
  probe_add(id: number, kind: number, shape: number, a: number, b: number, c: number, x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number, vx: number, vy: number, vz: number, wx: number, wy: number, wz: number): number;
  probe_step(id: number, n: number): void;
  probe_pose(id: number, index: number, out: number): void;
}

/** Un corps de la scène : fixe ou dynamique, une boîte (demi-tailles) ou une boule (rayon). */
interface Spec {
  dynamic: boolean;
  shape: "box" | "ball";
  size: [number, number, number];
  pos: [number, number, number];
  rot: [number, number, number, number];
  vel?: [number, number, number];
  spin?: [number, number, number];
}

/** Des quaternions unitaires exacts en virgule flottante (sinon, chacun pourrait les normaliser autrement). */
const QUATS: [number, number, number, number][] = [[0, 0, 0, 1], [0.5, 0.5, 0.5, 0.5], [0.5, -0.5, 0.5, 0.5], [0, 0, 1, 0]];

/** Une scène : un sol, un tas de boîtes et de boules lancées les unes sur les autres. */
function scene(count: number): Spec[] {
  const specs: Spec[] = [{ dynamic: false, shape: "box", size: [30, 0.5, 30], pos: [0, -0.5, 0], rot: [0, 0, 0, 1] }];
  for (let i = 0; i < count; i++) {
    const ring = i % 6;
    const layer = Math.floor(i / 6);
    const a = (ring / 6) * Math.PI * 2;
    specs.push({
      dynamic: true,
      shape: i % 3 === 2 ? "ball" : "box",
      size: i % 3 === 2 ? [0.3 + (i % 4) * 0.05, 0, 0] : [0.25 + (i % 5) * 0.05, 0.25, 0.2 + (i % 3) * 0.1],
      pos: [Math.cos(a) * 1.2, 0.6 + layer * 0.9, Math.sin(a) * 1.2],
      rot: QUATS[i % QUATS.length],
      vel: [-Math.cos(a) * 2, 0, -Math.sin(a) * 2],
      spin: [0.3 * (i % 2), 1.5, -0.2 * (i % 3)],
    });
  }
  return specs;
}

/** Le monde avancé par le Rapier du jeu : les poses (position, quaternion) de chaque corps. */
function runRapier(specs: Spec[], steps: number): number[][] {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / 60;
  world.numSolverIterations = 4;
  const bodies = specs.map((s) => {
    const desc = (s.dynamic ? RAPIER.RigidBodyDesc.dynamic() : RAPIER.RigidBodyDesc.fixed())
      .setTranslation(...s.pos)
      .setRotation({ x: s.rot[0], y: s.rot[1], z: s.rot[2], w: s.rot[3] })
      .setLinvel(...(s.vel ?? [0, 0, 0]))
      .setAngvel({ x: s.spin?.[0] ?? 0, y: s.spin?.[1] ?? 0, z: s.spin?.[2] ?? 0 });
    const body = world.createRigidBody(desc);
    world.createCollider(s.shape === "ball" ? RAPIER.ColliderDesc.ball(s.size[0]) : RAPIER.ColliderDesc.cuboid(...s.size), body);
    return body;
  });
  for (let i = 0; i < steps; i++) world.step();
  const poses = bodies.map((b) => {
    const t = b.translation();
    const r = b.rotation();
    return [t.x, t.y, t.z, r.x, r.y, r.z, r.w];
  });
  world.free();
  return poses;
}

/** Le même monde avancé par la sonde. */
function runProbe(probe: Probe, specs: Spec[], steps: number): number[][] {
  const id = probe.probe_new(9.81, 1 / 60, 4);
  const index = specs.map((s) =>
    probe.probe_add(
      id, s.dynamic ? 1 : 0, s.shape === "ball" ? 1 : 0, ...s.size, ...s.pos, ...s.rot,
      ...(s.vel ?? [0, 0, 0]), ...(s.spin ?? [0, 0, 0]),
    ),
  );
  probe.probe_step(id, steps);
  const out = probe.alloc(28);
  return index.map((i) => {
    probe.probe_pose(id, i, out);
    return Array.from(new Float32Array(probe.memory.buffer, out, 7));
  });
}

let probe: Probe;

describe.skipIf(!existsSync(PROBE))("Sonde de la physique (Rapier compilé ici contre celui du jeu)", () => {
  beforeAll(async () => {
    await RAPIER.init();
    const { instance } = await WebAssembly.instantiate(readFileSync(PROBE), {});
    probe = instance.exports as unknown as Probe;
  });

  it("un corps qui tombe : la même chute au bit près", () => {
    const specs = scene(1);
    expect(runProbe(probe, specs, 120)).toEqual(runRapier(specs, 120));
  });

  it("un tas de boîtes et de boules qui se heurtent : les mêmes poses au bit près après 4 s", () => {
    const specs = scene(30);
    const a = runProbe(probe, specs, 240);
    const b = runRapier(specs, 240);
    // (le premier corps qui diffère, pour comprendre)
    const first = a.findIndex((p, i) => p.some((v, k) => !Object.is(v, b[i][k])));
    expect(first, first >= 0 ? `corps ${first} : ${a[first].join(", ")} contre ${b[first].join(", ")}` : "").toBe(-1);
  });
});
