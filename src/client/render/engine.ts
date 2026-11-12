import * as B from "../babylon";
import { requestedRenderer, type Renderer } from "../settings";

/*
 * Le moteur de rendu : WebGPU si le joueur le choisit (ou le réglage par défaut) et que le navigateur
 * le permet, WebGL 2 sinon (ou WebGL 1 sur un vieux navigateur). Le reste du jeu ne voit qu'un
 * `B.AbstractEngine` : la scène, les matériaux, les shaders (GLSL, convertis en WGSL par Babylon sous
 * WebGPU), les ombres, le halo et les lumières en grappes marchent sur les deux. Le moteur ne change
 * pas en cours de route : un autre choix prend effet au prochain chargement de la page. `?renderer=
 * webgpu` ou `?renderer=webgl` dans l'adresse impose l'un ou l'autre (les outils de mesure).
 */

/** Ce qui dessine vraiment (le navigateur peut refuser WebGPU). */
export type RenderBackend = "webgpu" | "webgl2" | "webgl1";

export function backendOf(engine: B.AbstractEngine): RenderBackend {
  if (engine.isWebGPU) return "webgpu";
  return (engine as B.Engine).webGLVersion >= 2 ? "webgl2" : "webgl1";
}

/** Le navigateur offre-t-il WebGPU (un adaptateur) ? */
async function webGpuAvailable(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

/**
 * Le moteur de la page. Son canvas (`getRenderingCanvas`) peut être un autre que celui donné : un
 * canvas qui a pris un contexte WebGPU n'en prend plus d'autre, et WebGPU qui échoue en cours de
 * route laisse la place à un canvas neuf, au même endroit de la page.
 */
export async function createEngine(canvas: HTMLCanvasElement, chosen: Renderer): Promise<B.AbstractEngine> {
  if (requestedRenderer(chosen) === "webgpu" && (await webGpuAvailable())) {
    let engine: B.AbstractEngine | null = null;
    try {
      const { WebGPUEngine, SHADER_COMPILERS } = await import("../babylonGpu");
      const gpu = new WebGPUEngine(canvas, {
        antialias: true,
        stencil: false,
        adaptToDeviceRatio: true,
        powerPreference: "high-performance",
        // (le minuteur de la carte graphique, si elle l'a : `npm run perf` relève le temps de chaque image)
        deviceDescriptor: { requiredFeatures: ["timestamp-query"] },
      });
      engine = gpu;
      await gpu.initAsync(SHADER_COMPILERS.glslang, SHADER_COMPILERS.twgsl);
      keepLostDevice(gpu);
      return gpu;
    } catch (e) {
      console.warn("WebGPU indisponible, rendu en WebGL :", e);
      engine?.dispose();
      const fresh = canvas.cloneNode(false) as HTMLCanvasElement;
      canvas.replaceWith(fresh);
      canvas = fresh;
    }
  }
  return new B.Engine(canvas, true, { stencil: false, preserveDrawingBuffer: false }, true);
}

/**
 * Le périphérique WebGPU perdu (pilote qui plante, carte réinitialisée) : Babylon 9.28 sait le
 * refaire (`initAsync`), mais ses ressources ne s'y rattachent pas toutes (la première ombre dessinée
 * après la reprise plante dans `getBindGroups`, et le rendu s'arrête). Plutôt qu'un jeu figé sur une
 * erreur, il ne le refait pas : le bandeau de la carte graphique (hud/gpuNotice.ts) propose tout de
 * suite de recharger la page (`restoresAfterLoss`). En WebGL, le contexte rendu, tout repart.
 */
function keepLostDevice(engine: B.AbstractEngine): void {
  (engine as unknown as { _restoreEngineAfterContextLost(init: () => unknown): void })._restoreEngineAfterContextLost = () => undefined;
}

/** Le moteur repart-il seul après une perte de la carte graphique (sinon : recharger la page) ? */
export function restoresAfterLoss(engine: B.AbstractEngine): boolean {
  return !engine.isWebGPU;
}
