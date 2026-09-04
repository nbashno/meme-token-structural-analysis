/**
 * WAR experience — Experience Adapter (Phase A / A2-A3).
 *
 * The seam between the pure World engine and the GPU renderer. It reuses the
 * EXISTING Phase 2 abstractions unchanged:
 *   - WorldEngine.visible(camera, focusedId)  → viewport streaming (culling)
 *   - lodFor(...)                              → per-instance LOD
 *   - buildFrame(...)                          → the RenderFrame the renderer draws
 *
 * It performs ZERO intelligence: no scoring, no classification, no new state.
 * It only selects which existing instances render and packages existing data
 * into the existing RenderFrame contract.
 */

import type { Camera, WorldEngine, WorldInstance } from "../world/worldEngine.js";
import { lodFor } from "../world/worldEngine.js";
import { buildFrame, type RenderFrame } from "../world/worldRenderer.js";

/**
 * Build the RenderFrame for the current camera + focus from the live engine.
 * Streaming: only instances the engine reports as visible are packaged, so a
 * 10k-token world ships only the on-screen subset to the GPU each frame.
 */
export function frameFor(engine: WorldEngine, camera: Camera, focusedId: string | null): RenderFrame {
  const visible: readonly WorldInstance[] = engine.visible(camera, focusedId);
  return buildFrame(camera, focusedId, visible, (inst) => lodFor(camera.zoom, inst.id === focusedId));
}
