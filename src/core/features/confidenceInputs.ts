/**
 * WAR core - Feature layer - ConfidenceInputs builder (Phase 4B-5, piece 2).
 *
 * computeConfidence needs six ratios + two limiting tags. Gate applied per input.
 * Five have defensible sources; measurementStability does NOT for a single-
 * snapshot scan, and is handled explicitly (see the decision block below) — NOT
 * invented and NOT silently set to 0.
 *
 * ANTI-LOOKAHEAD: freshness/historyDepth are computed from observation
 * timestamps <= T only. No future observation is read.
 */

import type { Coverage, TemporalOrigin } from "../timeline/types.js";
import type { ConfidenceInputs } from "../power/powerEngine.js";

/** Inputs available at evaluation instant T to derive confidence. */
export interface ConfidenceSources {
  /** How many of the 3 expected lanes (MARKET/ANALYTICS/FLOW) produced data. */
  readonly lanesPresent: number; // 0..3
  readonly lanesExpected: number; // usually 3
  /** Newest observation timestamp across lanes, and the evaluation instant T. */
  readonly newestObservedAt: number | null;
  readonly evaluationAt: number;
  /** Observed history span (ms) of the MARKET lane, and a reference full span. */
  readonly marketSpanMs: number;
  readonly referenceSpanMs: number;
  /** netCoherence from computeCoherence (0..1), or null if coherence INSUFFICIENT. */
  readonly netCoherence: number | null;
  /** TemporalProfile.derivativeConfidence for the primary (price) series (0..1). */
  readonly derivativeConfidence: number | null;
  /** The most-constraining coverage + origin across the lanes used. */
  readonly limitingCoverage: Coverage;
  readonly limitingTemporalOrigin: TemporalOrigin;
  /** Freshness horizon: an observation older than this (ms) is fully stale. */
  readonly freshnessHorizonMs: number;
}

/** What was derivable vs. INSUFFICIENT, surfaced for auditability. */
export interface ConfidenceBuildResult {
  readonly inputs: ConfidenceInputs;
  readonly insufficient: readonly string[];
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * DECISION (resolved) — measurementStability in a single-snapshot scan:
 *
 * Stability = variance across repeated measurements, which is UNDEFINED when only
 * one snapshot exists. Rather than invent a formula or pass a value that would
 * skew the blend, its weight was zeroed in CONFIDENCE_CONFIG (confidence-v2).
 * With weight 0 the value is inert, so we pass 0 and always surface it as
 * INSUFFICIENT. A real stability term may return in a monitor context (multiple
 * samples) under a future confidence version.
 */
const MEASUREMENT_STABILITY_INERT = 0;

export function buildConfidenceInputs(s: ConfidenceSources): ConfidenceBuildResult {
  const insufficient: string[] = [];

  // completeness: lanes present / expected.
  const completeness = s.lanesExpected > 0 ? clamp01(s.lanesPresent / s.lanesExpected) : 0;
  if (s.lanesExpected <= 0) insufficient.push("completeness");

  // freshness: 1 at T, decaying to 0 at the freshness horizon. Missing -> 0 + flag.
  let freshness = 0;
  if (s.newestObservedAt === null || s.freshnessHorizonMs <= 0) {
    insufficient.push("freshness");
  } else {
    const age = Math.max(0, s.evaluationAt - s.newestObservedAt);
    freshness = clamp01(1 - age / s.freshnessHorizonMs);
  }

  // historyDepth: observed span / reference span. Missing -> 0 + flag.
  let historyDepth = 0;
  if (s.referenceSpanMs <= 0) insufficient.push("historyDepth");
  else historyDepth = clamp01(s.marketSpanMs / s.referenceSpanMs);

  // coherence: netCoherence, or INSUFFICIENT.
  let coherence = 0;
  if (s.netCoherence === null) insufficient.push("coherence");
  else coherence = clamp01(s.netCoherence);

  // derivativeReliability: TemporalProfile.derivativeConfidence, or INSUFFICIENT.
  let derivativeReliability = 0;
  if (s.derivativeConfidence === null) insufficient.push("derivativeReliability");
  else derivativeReliability = clamp01(s.derivativeConfidence);

  // measurementStability: UNMEASURED in a single snapshot (see DECISION above).
  insufficient.push("measurementStability");

  return {
    inputs: {
      completeness,
      freshness,
      historyDepth,
      coherence,
      measurementStability: MEASUREMENT_STABILITY_INERT,
      derivativeReliability,
      limitingCoverage: s.limitingCoverage,
      limitingTemporalOrigin: s.limitingTemporalOrigin,
    },
    insufficient,
  };
}
