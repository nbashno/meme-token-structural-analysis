/**
 * WAR core - Attention (Phase 11).
 *
 * Attention answers "why should the operator look HERE, right NOW?" - it is
 * INDEPENDENT of Power. Power 52 with Attention 96 is valid: a low-strength
 * token doing something rare/accelerating/conflicting deserves a look.
 *
 * Config-driven weights, no magic numbers. Pure, total, deterministic.
 */

import type { Score0to100 } from "../../shared/scalars.js";
import type { Attention, AttentionContributor } from "../state/types.js";
import { clampScore } from "../../shared/construct.js";

const S0 = 0 as Score0to100;
function score(n: number): Score0to100 {
  const r = clampScore(n);
  return r.ok ? r.value : S0;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Each attention driver as an activation in [0,1]. */
export interface AttentionInputs {
  readonly magnitude: number;
  readonly acceleration: number;
  readonly novelty: number;
  readonly stateTransition: number;
  readonly trajectoryReversal: number;
  readonly signalConflict: number;
  readonly uncertainty: number;
  readonly crossTokenImpact: number;
}

export interface AttentionConfig {
  readonly version: string;
  readonly weights: Readonly<Record<AttentionContributor, number>>;
  /** Activation at/above this counts a driver as a listed contributor. */
  readonly contributorThreshold: number;
}

export const ATTENTION_CONFIG: AttentionConfig = {
  version: "attention-v1",
  weights: {
    MAGNITUDE: 15,
    ACCELERATION: 20,
    NOVELTY: 20,
    STATE_TRANSITION: 15,
    TRAJECTORY_REVERSAL: 15,
    SIGNAL_CONFLICT: 10,
    UNCERTAINTY: 5,
    CROSS_TOKEN_IMPACT: 10,
  },
  contributorThreshold: 0.3,
};

const DRIVERS: readonly (readonly [AttentionContributor, keyof AttentionInputs])[] = [
  ["MAGNITUDE", "magnitude"],
  ["ACCELERATION", "acceleration"],
  ["NOVELTY", "novelty"],
  ["STATE_TRANSITION", "stateTransition"],
  ["TRAJECTORY_REVERSAL", "trajectoryReversal"],
  ["SIGNAL_CONFLICT", "signalConflict"],
  ["UNCERTAINTY", "uncertainty"],
  ["CROSS_TOKEN_IMPACT", "crossTokenImpact"],
];

/**
 * Compute attention as a weighted sum of drivers, independent of Power.
 * Lists which drivers materially contributed (>= threshold) for explainability.
 */
export function computeAttention(
  inputs: AttentionInputs,
  config: AttentionConfig = ATTENTION_CONFIG,
): Attention {
  let total = 0;
  const contributors: AttentionContributor[] = [];

  for (const [name, key] of DRIVERS) {
    const act = clamp01(inputs[key]);
    total += act * config.weights[name];
    if (act >= config.contributorThreshold) contributors.push(name);
  }

  return { score: score(total), contributors };
}
