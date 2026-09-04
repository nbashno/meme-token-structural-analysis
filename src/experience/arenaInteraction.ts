/**
 * WAR experience — Arena interaction reducer (Phase B / B1, B11).
 *
 * A pure, deterministic reducer that turns a device-independent WorldIntent
 * (the EXISTING Phase 2 contract, produced by desktopIntent/mobileIntent) into
 * the next ArenaInteractionState (camera + focus). It reuses the existing camera
 * math (pan/zoomTo) unchanged. It contains NO intelligence: selecting or
 * entering a world changes focus/camera only — it never scores or ranks.
 *
 * Desktop and mobile share this ONE path: same intents, same reducer, no
 * separate mobile intelligence.
 */

import type { Camera } from "../world/worldEngine.js";
import { pan, zoomTo } from "../world/worldEngine.js";
import type { WorldIntent } from "../world/worldRenderer.js";

export interface ArenaInteractionState {
  readonly camera: Camera;
  /** Currently selected/focused world id, or null. */
  readonly focusedId: string | null;
  /** A world the user asked to "enter" (double-click / double-tap). */
  readonly enteredId: string | null;
  /** flyTo target set when entering; the renderer animates toward it. */
  readonly flyTarget: { readonly x: number; readonly y: number; readonly zoom: number } | null;
}

export function initInteraction(camera: Camera): ArenaInteractionState {
  return { camera, focusedId: null, enteredId: null, flyTarget: null };
}

/** Zoom level a focused/entered world flies to. Presentation constant. */
const ENTER_ZOOM = 2.5;

/**
 * Apply one intent. Pure: state in, state out. `positionOf` resolves a world id
 * to its world-space position (from the WorldEngine) so "enter" can set a flyTo
 * target; it returns null for unknown ids (then focus changes without a fly).
 */
export function reduceIntent(
  state: ArenaInteractionState,
  intent: WorldIntent,
  positionOf: (id: string) => { x: number; y: number } | null,
): ArenaInteractionState {
  switch (intent.kind) {
    case "pan":
      // Pan is in screen delta; convert to world delta by dividing by zoom so
      // dragging feels 1:1 at any zoom. Presentation only.
      return {
        ...state,
        camera: pan(state.camera, -intent.dx / state.camera.zoom, -intent.dy / state.camera.zoom),
        flyTarget: null,
      };

    case "zoom":
      return {
        ...state,
        camera: zoomTo(state.camera, state.camera.zoom * intent.factor),
        flyTarget: null,
      };

    case "select":
      return { ...state, focusedId: intent.id, flyTarget: null };

    case "enter": {
      const pos = positionOf(intent.id);
      return {
        ...state,
        focusedId: intent.id,
        enteredId: intent.id,
        flyTarget: pos ? { x: pos.x, y: pos.y, zoom: ENTER_ZOOM } : null,
      };
    }
  }
}

/** Clear a consumed flyTo target once the camera reaches it (renderer calls this). */
export function clearFly(state: ArenaInteractionState): ArenaInteractionState {
  return { ...state, flyTarget: null };
}
