/**
 * WAR core — Power / Threat / Confidence (Phase 2, types only).
 *
 * Three INDEPENDENT measures. Power is not probability, prediction, or a buy
 * signal — it is current observable condition strength. Threat is independent
 * of Power (Power 94 + Threat 91 is valid). Confidence is NOT probability — it
 * measures evidence quality. All three are explainable: a bare number is invalid.
 */

import type { Score0to100, Ratio0to1 } from "../../shared/scalars.js";
import type { Coverage, TemporalOrigin } from "../timeline/types.js";

/** A single contributing factor to a composite score, signed and weighted. */
export interface Contribution {
  readonly factor: string;
  /** Signed contribution to the score (explainability). */
  readonly magnitude: number;
  /** The config-driven weight applied (versioned; no magic numbers). */
  readonly weight: number;
}

/**
 * Power — current observable condition strength in [0,100].
 * A Power value without its breakdown is considered incomplete.
 */
export interface Power {
  readonly score: Score0to100;
  readonly supporting: readonly Contribution[];
  readonly opposing: readonly Contribution[];
  /** Net cross-vector coherence backing this Power (links to Coherence). */
  readonly netCoherence: Ratio0to1;
}

/** Threat — dangerous-structure strength in [0,100]. Independent of Power. */
export interface Threat {
  readonly score: Score0to100;
  readonly supporting: readonly Contribution[];
}

/**
 * Confidence — evidence quality, NOT probability. Constrained by completeness,
 * freshness, history depth, coherence, measurement stability, derivative
 * reliability, coverage, and temporal origin. A short FLOW capture (ROLLING
 * coverage) automatically constrains confidence.
 */
export interface Confidence {
  readonly score: Score0to100;
  readonly completeness: Ratio0to1;
  readonly freshness: Ratio0to1;
  readonly historyDepth: Ratio0to1;
  readonly coherenceContribution: Ratio0to1;
  readonly measurementStability: Ratio0to1;
  readonly derivativeReliability: Ratio0to1;
  /** The weakest coverage among the substrates feeding this assessment. */
  readonly limitingCoverage: Coverage;
  readonly limitingTemporalOrigin: TemporalOrigin;
}
