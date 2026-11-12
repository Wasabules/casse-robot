/*
 * Le moteur WebGPU de Babylon, à part de client/babylon.ts : il n'est chargé (import dynamique,
 * render/engine.ts) que si le joueur le choisit et que le navigateur le permet ; une partie en
 * WebGL ne télécharge pas son code. Les compilateurs de shaders (GLSL → SPIR-V → WGSL : glslang et
 * twgsl) sont servis avec le jeu, pas depuis le CDN de Babylon : nos shaders sont écrits en GLSL.
 */
import glslangJs from "@babylonjs/core/assets/glslang/glslang.js?url";
import glslangWasm from "@babylonjs/core/assets/glslang/glslang.wasm?url";
import twgslJs from "@babylonjs/core/assets/twgsl/twgsl.js?url";
import twgslWasm from "@babylonjs/core/assets/twgsl/twgsl.wasm?url";

export { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";

/** Où trouver les compilateurs de shaders (des fichiers du jeu). */
export const SHADER_COMPILERS = {
  glslang: { jsPath: glslangJs, wasmPath: glslangWasm },
  twgsl: { jsPath: twgslJs, wasmPath: twgslWasm },
} as const;
