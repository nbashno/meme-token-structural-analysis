/**
 * WAR experience layer (Phase A) — GPU renderer + scene, presentation only.
 *
 * Reads WorldState (via RenderFrame) exclusively. Contains NO intelligence and
 * imports nothing from Core/Product/GMGN. Concrete GPU rendering (PixiJS 8,
 * WebGPU→WebGL2) lives here; the outward contract remains the Phase 2
 * WorldRenderer, so Pixi can be replaced without touching WorldEngine/Adapter.
 */

export * from "./capability.js";
export * from "./adaptiveQuality.js";
export * from "./experienceAdapter.js";
export * from "./pixiRenderer.js";
export * from "./inspectorView.js";
export * from "./liquidityView.js";
export * from "./presentationState.js";
export * from "./arenaInteraction.js";
export * from "./radarBridge.js";
export * from "./cameraAnimator.js";
export * from "./visual/vocabulary.js";
export * from "./visual/battlefieldSeam.js";
export type { SceneLayer } from "./scene/layer.js";
export { ArenaScene } from "./scene/arenaScene.js";
