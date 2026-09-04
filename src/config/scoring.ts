/**
 * WAR core - scoring configuration (Phase 8).
 *
 * All weights and thresholds live here, versioned. No magic numbers inside the
 * scoring engines. Changing a weight changes powerModelVersion, keeping historic
 * outputs interpretable.
 */

/** A named, weighted input to a composite score. */
export interface WeightedInput {
  readonly factor: string;
  readonly weight: number;
}

export interface PowerConfig {
  readonly version: string;
  /** Positive-direction factors (accumulation, alignment, smart flow, ...). */
  readonly supportingWeights: readonly WeightedInput[];
  /** Negative-direction factors (sell pressure, conflict, ...). */
  readonly opposingWeights: readonly WeightedInput[];
}

export interface ThreatConfig {
  readonly version: string;
  readonly weights: readonly WeightedInput[];
}

export interface ConfidenceConfig {
  readonly version: string;
  /** Blend weights for the confidence sub-dimensions (must sum to > 0). */
  readonly completeness: number;
  readonly freshness: number;
  readonly historyDepth: number;
  readonly coherence: number;
  readonly measurementStability: number;
  readonly derivativeReliability: number;
  /** Coverage penalties: ROLLING/SAMPLED constrain confidence vs COMPLETE. */
  readonly coveragePenalty: {
    readonly COMPLETE: number;
    readonly ROLLING: number;
    readonly SAMPLED: number;
    readonly DERIVED: number;
  };
}

export const POWER_CONFIG: PowerConfig = {
  version: "power-v1",
  supportingWeights: [
    { factor: "trajectoryUp", weight: 30 },
    { factor: "coherenceAlignment", weight: 25 },
    { factor: "smartMoneyInflow", weight: 25 },
    { factor: "liquidityDepth", weight: 20 },
  ],
  opposingWeights: [
    { factor: "sellPressure", weight: 30 },
    { factor: "vectorConflict", weight: 25 },
  ],
};

export const THREAT_CONFIG: ThreatConfig = {
  version: "threat-v1",
  weights: [
    { factor: "rugRisk", weight: 30 },
    { factor: "holderConcentration", weight: 25 },
    { factor: "washTrading", weight: 20 },
    { factor: "liquidityFragility", weight: 25 },
  ],
};

export const CONFIDENCE_CONFIG: ConfidenceConfig = {
  // v2: measurementStability weight zeroed. Stability = variance across repeated
  // measurements, which is undefined for a single-snapshot scan. Rather than
  // invent a value or falsely penalize confidence, its weight is 0; confidence is
  // blended from the five measurable dimensions. A real stability term may return
  // in a monitor context (multiple samples) under a future confidence version.
  version: "confidence-v2",
  completeness: 0.2,
  freshness: 0.15,
  historyDepth: 0.2,
  coherence: 0.2,
  measurementStability: 0.0,
  derivativeReliability: 0.15,
  coveragePenalty: {
    COMPLETE: 1.0,
    ROLLING: 0.7,
    SAMPLED: 0.8,
    DERIVED: 0.9,
  },
};
