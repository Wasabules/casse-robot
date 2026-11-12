/*
 * Babylon.js, importé morceau par morceau : seulement ce dont le client se sert (tout le paquet
 * `@babylonjs/core` pèse plus de 10 Mo). Le client importe `* as B from "./babylon"` (chemin
 * relatif) et jamais `@babylonjs/core` directement. Pour une classe de plus, l'ajouter ici, depuis
 * son module (`@babylonjs/core/<Dossier>/<module>`). Ces modules enregistrent aussi leurs effets
 * de bord : lancer de rayon (`scene.pick`), ombres, instances (`createInstance`), instances
 * fines (`thinInstanceAdd`) et contours (`enableEdgesRendering`, la zone sélectionnée du garage).
 * Le lecteur glTF n'est pas ici : il est à part (client/babylonGltf.ts) et ne se charge qu'à la
 * demande, quand un accessoire a un modèle glTF (render/propModels.ts).
 */
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder";
import { CreateIcoSphere } from "@babylonjs/core/Meshes/Builders/icoSphereBuilder";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import { CreateTorus } from "@babylonjs/core/Meshes/Builders/torusBuilder";
import "@babylonjs/core/Culling/ray";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import "@babylonjs/core/Rendering/edgesRenderer";

export { Engine } from "@babylonjs/core/Engines/engine";
// Le moteur du jeu peut être WebGL ou WebGPU (render/engine.ts, client/babylonGpu.ts) : le reste du client ne voit que celui-ci
export type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
export { Scene } from "@babylonjs/core/scene";
export { Node } from "@babylonjs/core/node";
export { Camera } from "@babylonjs/core/Cameras/camera";
export { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
export { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
export { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
export { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
export { CascadedShadowGenerator } from "@babylonjs/core/Lights/Shadows/cascadedShadowGenerator";
export { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
export { Matrix, Quaternion, Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector";
export { TransformNode } from "@babylonjs/core/Meshes/transformNode";
export { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
export { Mesh } from "@babylonjs/core/Meshes/mesh";
export { SubMesh } from "@babylonjs/core/Meshes/subMesh";
export type { Geometry } from "@babylonjs/core/Meshes/geometry";
export { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
export { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
export { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
export { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
export { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial";
export type { Material } from "@babylonjs/core/Materials/material";
export { Texture } from "@babylonjs/core/Materials/Textures/texture";
export type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
export { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
// Fumée et flammes réalistes (render/fx/sprites.ts, render/fx/fxMaterial.ts) : leurs shaders et leurs textures calculées
export { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
export { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
export type { PickingInfo } from "@babylonjs/core/Collisions/pickingInfo";
export { Ray } from "@babylonjs/core/Culling/ray";
// Éclairage en option (render/lighting.ts) : halo, lumières ponctuelles, distorsion de chaleur
export { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
export { PointLight } from "@babylonjs/core/Lights/pointLight";
// Lumières de la nuit (render/nightLights.ts) : des dizaines de lumières à la fois, en grappes
export { SpotLight } from "@babylonjs/core/Lights/spotLight";
export { ClusteredLightContainer } from "@babylonjs/core/Lights/Clustered/clusteredLightContainer";
export { PostProcess } from "@babylonjs/core/PostProcesses/postProcess";
export { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
export type { Effect } from "@babylonjs/core/Materials/effect";

/** Les seules formes que construit le client. */
export const MeshBuilder = { CreateBox, CreateCylinder, CreateGround, CreateIcoSphere, CreatePlane, CreateSphere, CreateTorus };
