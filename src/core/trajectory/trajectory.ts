/**
 * WAR core - Trajectory classifier (Phase 6).
 *
 * Classifies movement from a signal's temporal profile. Trajectory is
 * multidimensional: it is derived from BOTH the sign of velocity (direction)
 * AND the sign of acceleration (whether the move is speeding up, steady, or
 * bending), and it is never collapsed into a single scalar.
 *
 * No fabrication: if the underlying derivatives are missing (INSUFFICIENT_HISTORY),
 * the classification is UNKNOWN with zero confidence. Pure, total, deterministic.
 */

import type { Score0to100 } from "../../shared/scalars.js";
import type {
  TemporalProfile,
  Trajectory,
  TrajectoryClass,
} from "../temporal/types.js";
import { clampScore } from "../../shared/construct.js";

export interface TrajectoryConfig {
  /** |velocity| at or below this counts as flat (no directional move). */
  readonly velocityFlatEpsilon: number;
  /** |acceleration| at or below this counts as steady (no bending). */
  readonly accelFlatEpsilon: number;
}

export const DEFAULT_TRAJECTORY_CONFIG: TrajectoryConfig = {
  velocityFlatEpsilon: 1e-9,
  accelFlatEpsilon: 1e-12,
};

type Sign = "POS" | "NEG" | "ZERO";

function signOf(n: number, epsilon: number): Sign {
  if (Math.abs(n) <= epsilon) return "ZERO";
  return n > 0 ? "POS" : "NEG";
}

const S0 = 0 as Score0to100;
function score(n: number): Score0to100 {
  const r = clampScore(n);
  return r.ok ? r.value : S0;
}

/**
 * Classify from velocity sign (vSign) and acceleration sign (aSign).
 *
 * Direction is set by velocity. Acceleration modifies it:
 *   - moving up + accelerating (same sign)  -> ACCELERATING_UP
 *   - moving up + decelerating (opposite)   -> DECELERATING (losing upward speed)
 *   - moving down + accelerating down       -> ACCELERATING_DOWN
 *   - moving down + decelerating            -> DECELERATING
 *   - flat velocity + non-zero accel        -> REVERSING (turning through zero)
 *   - flat velocity + flat accel            -> FLATTENING
 */
function classify(vSign: Sign, aSign: Sign): TrajectoryClass {
  if (vSign === "POS") {
    if (aSign === "POS") return "ACCELERATING_UP";
    if (aSign === "NEG") return "DECELERATING";
    return "RISING";
  }
  if (vSign === "NEG") {
    if (aSign === "NEG") return "ACCELERATING_DOWN";
    if (aSign === "POS") return "DECELERATING";
    return "FALLING";
  }
  // vSign ZERO
  if (aSign === "ZERO") return "FLATTENING";
  return "REVERSING";
}

/**
 * Confidence blends derivative confidence and persistence into [0,100].
 * A profile with no usable velocity yields UNKNOWN at zero confidence.
 */
export function classifyTrajectory(
  profile: TemporalProfile,
  config: TrajectoryConfig = DEFAULT_TRAJECTORY_CONFIG,
): Trajectory {
  if (profile.method === "INSUFFICIENT_HISTORY" || profile.velocity === null) {
    return { classification: "UNKNOWN", confidence: S0, basis: [profile] };
  }

  const vSign = signOf(profile.velocity as number, config.velocityFlatEpsilon);
  const aSign =
    profile.acceleration === null
      ? "ZERO"
      : signOf(profile.acceleration as number, config.accelFlatEpsilon);

  const classification = classify(vSign, aSign);

  // Confidence: derivative reliability weighted by directional persistence,
  // scaled to 0-100. Deterministic; no magic thresholds beyond config epsilons.
  const dc = profile.derivativeConfidence as number;
  const persist = profile.persistence as number;
  const confidence = score(100 * dc * persist);

  return { classification, confidence, basis: [profile] };
}

/**
 * Combine multiple signal trajectories (e.g. price, flow) into one view by
 * carrying all bases. This does NOT average away disagreement - it keeps every
 * profile so downstream coherence can see conflict. Returns the dominant
 * classification (highest confidence), or UNKNOWN if none are usable.
 */
export function combineTrajectories(
  trajectories: readonly Trajectory[],
): Trajectory {
  const usable = trajectories.filter((t) => t.classification !== "UNKNOWN");
  if (usable.length === 0) {
    return {
      classification: "UNKNOWN",
      confidence: S0,
      basis: trajectories.flatMap((t) => t.basis),
    };
  }
  // Deterministic pick: highest confidence, tie-broken by classification name.
  const sorted = [...usable].sort((a, b) => {
    const ca = a.confidence as number;
    const cb = b.confidence as number;
    if (ca !== cb) return cb - ca;
    return a.classification < b.classification ? -1 : 1;
  });
  const dominant = sorted[0];
  const basis = trajectories.flatMap((t) => t.basis);
  if (dominant === undefined) {
    return { classification: "UNKNOWN", confidence: S0, basis };
  }
  return {
    classification: dominant.classification,
    confidence: dominant.confidence,
    basis,
  };
}
