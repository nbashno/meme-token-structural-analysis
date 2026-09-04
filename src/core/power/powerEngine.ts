/**
 * WAR core - Power / Threat / Confidence engines (Phase 8).
 *
 * THREE INDEPENDENT MEASURES. None is computed from another:
 *   - Power   = current observable condition strength (NOT probability/prediction).
 *   - Threat  = dangerous-structure strength, computed from its OWN inputs.
 *   - Confidence = evidence quality (NOT probability). Conflict + ROLLING coverage
 *                  constrain it.
 *
 * Every score carries its breakdown - a bare number is invalid. Weights come
 * from versioned config; no magic numbers here. Pure, total, deterministic.
 */

import type { Score0to100, Ratio0to1 } from "../../shared/scalars.js";
import type { Power, Threat, Confidence, Contribution } from "./types.js";
import type { Coverage, TemporalOrigin } from "../timeline/types.js";
import { clampScore, toRatio0to1 } from "../../shared/construct.js";
import type {
  PowerConfig,
  ThreatConfig,
  ConfidenceConfig,
} from "../../config/scoring.js";
import {
  POWER_CONFIG,
  THREAT_CONFIG,
  CONFIDENCE_CONFIG,
} from "../../config/scoring.js";

const S0 = 0 as Score0to100;
const R0 = 0 as Ratio0to1;
function score(n: number): Score0to100 {
  const r = clampScore(n);
  return r.ok ? r.value : S0;
}
function ratio(n: number): Ratio0to1 {
  const r = toRatio0to1(n);
  return r.ok ? r.value : R0;
}

/** A factor's activation in [0,1]; how strongly this factor is present now. */
export type FactorActivations = Readonly<Record<string, number>>;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Build contributions from weighted config + activations. */
function contributionsOf(
  weights: readonly { factor: string; weight: number }[],
  activations: FactorActivations,
): { contributions: Contribution[]; total: number } {
  const contributions: Contribution[] = [];
  let total = 0;
  for (const w of weights) {
    const act = clamp01(activations[w.factor] ?? 0);
    const magnitude = act * w.weight;
    total += magnitude;
    contributions.push({ factor: w.factor, magnitude, weight: w.weight });
  }
  return { contributions, total };
}

/**
 * Power = supporting activation minus opposing activation, clamped to [0,100].
 * netCoherence is carried through (from Phase 7) for explainability, but Power
 * is its own measure.
 */
export function computePower(
  activations: FactorActivations,
  netCoherence: number,
  config: PowerConfig = POWER_CONFIG,
): Power {
  const support = contributionsOf(config.supportingWeights, activations);
  const oppose = contributionsOf(config.opposingWeights, activations);
  const raw = support.total - oppose.total;
  return {
    score: score(raw),
    supporting: support.contributions,
    opposing: oppose.contributions,
    netCoherence: ratio(clamp01(netCoherence)),
  };
}

/**
 * Threat = weighted sum of danger factors, clamped to [0,100]. Computed ONLY
 * from its own inputs - never from Power. High Power + high Threat is valid.
 */
export function computeThreat(
  activations: FactorActivations,
  config: ThreatConfig = THREAT_CONFIG,
): Threat {
  const t = contributionsOf(config.weights, activations);
  return { score: score(t.total), supporting: t.contributions };
}

/** Inputs to confidence. Each dimension is already a ratio in [0,1]. */
export interface ConfidenceInputs {
  readonly completeness: number;
  readonly freshness: number;
  readonly historyDepth: number;
  /** Coherence contribution: alignment raises, conflict lowers (0..1). */
  readonly coherence: number;
  readonly measurementStability: number;
  readonly derivativeReliability: number;
  readonly limitingCoverage: Coverage;
  readonly limitingTemporalOrigin: TemporalOrigin;
}

/**
 * Confidence = weighted blend of evidence-quality dimensions, then scaled by a
 * coverage penalty. A short FLOW capture (ROLLING) cannot yield full confidence.
 * This is evidence quality - NOT a probability of any outcome.
 */
export function computeConfidence(
  inputs: ConfidenceInputs,
  config: ConfidenceConfig = CONFIDENCE_CONFIG,
): Confidence {
  const c = clamp01(inputs.completeness);
  const f = clamp01(inputs.freshness);
  const h = clamp01(inputs.historyDepth);
  const co = clamp01(inputs.coherence);
  const ms = clamp01(inputs.measurementStability);
  const dr = clamp01(inputs.derivativeReliability);

  const weightSum =
    config.completeness +
    config.freshness +
    config.historyDepth +
    config.coherence +
    config.measurementStability +
    config.derivativeReliability;

  const blended =
    weightSum > 0
      ? (c * config.completeness +
          f * config.freshness +
          h * config.historyDepth +
          co * config.coherence +
          ms * config.measurementStability +
          dr * config.derivativeReliability) /
        weightSum
      : 0;

  const penalty = config.coveragePenalty[inputs.limitingCoverage];
  const constrained = blended * penalty;

  return {
    score: score(constrained * 100),
    completeness: ratio(c),
    freshness: ratio(f),
    historyDepth: ratio(h),
    coherenceContribution: ratio(co),
    measurementStability: ratio(ms),
    derivativeReliability: ratio(dr),
    limitingCoverage: inputs.limitingCoverage,
    limitingTemporalOrigin: inputs.limitingTemporalOrigin,
  };
}
