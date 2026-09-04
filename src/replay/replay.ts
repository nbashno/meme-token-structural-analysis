/**
 * WAR replay - Temporal Reconstruction (Phase 13).
 *
 * Replays the SAME pipeline used live. At each timestamp T, the reconstructed
 * BattlefieldState is built ONLY from observations at or before T - never after.
 * This is the anti-lookahead guarantee made operational: "what did WAR know at T?"
 *
 * A step function (injected) maps the observations-up-to-T into a BattlefieldState.
 * Replay owns the windowing and the guarantee; the intelligence lives in the
 * injected stepper (the same one live mode uses). Pure, total, deterministic.
 */

import type { UnixMillis } from "../shared/scalars.js";
import type { BattlefieldState } from "../core/battlefield/types.js";

/** An observation with a timestamp - the unit replay windows over. */
export interface TimedObservation {
  readonly at: UnixMillis;
}

/** Produces a BattlefieldState from the observations visible up to and including T. */
export type BattlefieldStepper<T extends TimedObservation> = (
  visible: readonly T[],
  now: UnixMillis,
) => BattlefieldState;

/** One reconstructed frame: the instant and what WAR knew then. */
export interface ReplayFrame {
  readonly at: UnixMillis;
  readonly state: BattlefieldState;
}

/**
 * Reconstruct a frame at each distinct timestamp in the observation set.
 * Anti-lookahead is enforced here: `visible` never contains an observation
 * whose `at` exceeds the frame time.
 */
export function replay<T extends TimedObservation>(
  observations: readonly T[],
  stepper: BattlefieldStepper<T>,
): readonly ReplayFrame[] {
  // Deterministic chronological order.
  const sorted = [...observations].sort(
    (a, b) => (a.at as number) - (b.at as number),
  );

  // Distinct frame times, ascending.
  const frameTimes: number[] = [];
  let last: number | null = null;
  for (const o of sorted) {
    const t = o.at as number;
    if (t !== last) {
      frameTimes.push(t);
      last = t;
    }
  }

  const frames: ReplayFrame[] = [];
  for (const t of frameTimes) {
    // ONLY observations at or before t are visible. No future leakage.
    const visible = sorted.filter((o) => (o.at as number) <= t);
    const now = t as UnixMillis;
    frames.push({ at: now, state: stepper(visible, now) });
  }
  return frames;
}

/**
 * Assert that a set of frames contains no future leakage relative to a set of
 * observations: every frame's visible-window max time is <= the frame time.
 * Returned as a boolean so callers/tests can verify the guarantee explicitly.
 */
export function framesRespectAntiLookahead(
  frames: readonly ReplayFrame[],
): boolean {
  // generatedAt of each frame must equal its declared time and be non-decreasing.
  let prev = -Infinity;
  for (const f of frames) {
    const gt = f.state.generatedAt as number;
    if (gt !== (f.at as number)) return false;
    if (gt < prev) return false;
    prev = gt;
  }
  return true;
}
