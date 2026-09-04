/**
 * WAR experience — Camera animator (Phase B / B1 camera transitions).
 *
 * Deterministic, cancellable flyTo. It reuses the EXISTING pure `flyStep`
 * interpolation (src/world/worldEngine.ts) — this module only sequences the
 * interpolation parameter `t` over injected time so the transition is smooth
 * and testable without a real clock. Presentation only; no data, no intelligence.
 */

import type { Camera } from "../world/worldEngine.js";
import { flyStep } from "../world/worldEngine.js";

export interface FlyTarget {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface CameraAnimation {
  readonly from: Camera;
  readonly target: FlyTarget;
  /** Total duration in ms. */
  readonly durationMs: number;
  /** Elapsed ms since start. */
  readonly elapsedMs: number;
  readonly done: boolean;
}

export function startFly(from: Camera, target: FlyTarget, durationMs = 500): CameraAnimation {
  return { from, target, durationMs, elapsedMs: 0, done: durationMs <= 0 };
}

/** Ease-in-out cubic. Presentational easing only. */
function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Advance the animation by `deltaMs` and return the next camera + animation.
 * Pure: no ambient clock. When elapsed reaches duration, `done` is true and the
 * camera equals the target exactly.
 */
export function advanceFly(anim: CameraAnimation, deltaMs: number): { camera: Camera; anim: CameraAnimation } {
  if (anim.done || anim.durationMs <= 0) {
    return {
      camera: { x: anim.target.x, y: anim.target.y, zoom: anim.target.zoom },
      anim: { ...anim, elapsedMs: anim.durationMs, done: true },
    };
  }
  const elapsed = Math.min(anim.durationMs, anim.elapsedMs + Math.max(0, deltaMs));
  const t = ease(elapsed / anim.durationMs);
  const camera = flyStep(anim.from, anim.target, t);
  const done = elapsed >= anim.durationMs;
  return { camera, anim: { ...anim, elapsedMs: elapsed, done } };
}

/** Cancel: freeze at the current camera (caller keeps it), animation marked done. */
export function cancelFly(anim: CameraAnimation): CameraAnimation {
  return { ...anim, done: true };
}
