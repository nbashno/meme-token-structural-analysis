/**
 * WAR core - Feature layer - AttentionInputs builder (Phase 4B-5, piece 6).
 *
 * Attention is a weighted sum of 8 drivers, independent of Power. Each driver is
 * mapped to an ALREADY-DEFENSIBLE value or set to 0 for a principled reason. No
 * new equation is invented.
 *
 * Drivers and their sourcing (gate applied):
 *   magnitude        <- power/100            (how big is the current signal)
 *   acceleration     <- |temporal accel| norm (rate of change of change)
 *   novelty          <- novelty.rarity        (pattern rarity)
 *   stateTransition  <- 0 IN SCAN             (B1: no prior state to transition
 *                                              from; this is a MONITOR driver)
 *   trajectoryReversal <- 0 IN SCAN           (B1: no prior trajectory; MONITOR)
 *   signalConflict   <- (1 - netCoherence)    (vector disagreement)
 *   uncertainty      <- 1 - confidence/100    (evidence-quality gap)
 *   crossTokenImpact <- 0 ALWAYS              (causal inference is PERMANENTLY
 *                                              forbidden; no source, never invented)
 *
 * ANTI-LOOKAHEAD: all sourced values derive from observations <= T. The two
 * transition drivers are 0 in scan precisely because computing them would require
 * a prior frame, which B1 forbids.
 */

import type { AttentionInputs } from "../attention/attention.js";

export interface AttentionSources {
  /** Power score 0..100 (already computed). */
  readonly power: number;
  /** Temporal acceleration (signed), or null if INSUFFICIENT. */
  readonly acceleration: number | null;
  /** A reference acceleration magnitude used to normalize into [0,1]. */
  readonly accelerationRef: number;
  /** Novelty rarity 0..1 (already computed). */
  readonly noveltyRarity: number;
  /** netCoherence 0..1, or null if coherence INSUFFICIENT. */
  readonly netCoherence: number | null;
  /** Confidence score 0..100 (already computed). */
  readonly confidence: number;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Build attention inputs for a single-snapshot scan (B1). Transition-based
 * drivers are 0 (no prior frame); crossTokenImpact is 0 (causal ban).
 */
export function buildAttentionInputs(s: AttentionSources): AttentionInputs {
  const magnitude = clamp01(s.power / 100);

  const acceleration =
    s.acceleration === null || s.accelerationRef <= 0
      ? 0
      : clamp01(Math.abs(s.acceleration) / s.accelerationRef);

  const novelty = clamp01(s.noveltyRarity);

  // netCoherence null => coherence INSUFFICIENT => no measurable conflict => 0
  const signalConflict = s.netCoherence === null ? 0 : clamp01(1 - s.netCoherence);

  const uncertainty = clamp01(1 - s.confidence / 100);

  return {
    magnitude,
    acceleration,
    novelty,
    stateTransition: 0, // B1: transitions are a monitor phenomenon
    trajectoryReversal: 0, // B1: reversals need a prior trajectory
    signalConflict,
    uncertainty,
    crossTokenImpact: 0, // causal inference permanently forbidden
  };
}
