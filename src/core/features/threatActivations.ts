/**
 * WAR core - Feature layer - Threat activations (Phase 4B-3).
 *
 * Maps sealed GMGN security fields (verified @147c070c) to the Threat factor
 * activations that THREAT_CONFIG already names. This adds NO new factor and does
 * NOT touch scoring config. It only PRODUCES the activation values the existing
 * computeThreat consumes.
 *
 * Sealed semantics (official repo, market trending / GET /v1/market/rank):
 *   rug_ratio          : rug-pull risk SCORE [0,1] (not probability, not binary)
 *   top_10_holder_rate : ratio of SUPPLY held by top-10 wallets [0,1]
 *   is_wash_trading    : real boolean (wash trading detected)
 *
 * Factor mapping (proved 1:1, no transformation beyond identity/boolean):
 *   rugRisk             = rugRatio
 *   holderConcentration = top10HolderRate
 *   washTrading         = isWashTrading ? 1 : 0
 *
 * liquidityFragility (F10) is DELIBERATELY ABSENT here. Its equation is not yet
 * proved from a sealed definition; in a single-snapshot scan it is INSUFFICIENT.
 * Omitting the key makes computeThreat treat it as 0 contribution (verified:
 * contributionsOf uses `activations[factor] ?? 0`) — i.e. no invented threat.
 *
 * NULLABILITY: a null security field means UNKNOWN, not zero. An unknown field
 * contributes NOTHING (its factor key is omitted), and is reported as insufficient
 * — we never turn "unknown rug risk" into "0.0 rug risk".
 */

import type { AnalyticsObservation } from "../timeline/types.js";
import type { FactorActivations } from "../power/powerEngine.js";

/** Which Threat factors could be computed vs. were UNKNOWN (null source). */
export interface ThreatActivationResult {
  readonly activations: FactorActivations;
  /** Factor keys that are UNKNOWN because their sealed source was null. */
  readonly insufficient: readonly string[];
}

/**
 * Build Threat factor activations from the most recent analytics observation.
 * Only factors whose sealed source is present are emitted; unknown ones are
 * listed in `insufficient` and omitted (contribute 0, not invented).
 *
 * @param latest the newest AnalyticsObservation <= T (anti-lookahead: caller
 *   must pass an observation at or before the evaluation instant).
 */
export function computeThreatActivations(
  latest: AnalyticsObservation | null,
): ThreatActivationResult {
  const activations: Record<string, number> = {};
  const insufficient: string[] = [];

  if (latest === null) {
    // No analytics at all: every threat factor is unknown.
    return {
      activations,
      insufficient: ["rugRisk", "holderConcentration", "washTrading", "liquidityFragility"],
    };
  }

  // F07 rugRisk = rugRatio (identity; already [0,1], validated at parser).
  if (latest.rugRatio !== null) activations["rugRisk"] = latest.rugRatio;
  else insufficient.push("rugRisk");

  // F08 holderConcentration = top10HolderRate (identity; ratio of supply).
  if (latest.top10HolderRate !== null) activations["holderConcentration"] = latest.top10HolderRate;
  else insufficient.push("holderConcentration");

  // F09 washTrading = isWashTrading ? 1 : 0 (boolean -> {0,1}).
  if (latest.isWashTrading !== null) activations["washTrading"] = latest.isWashTrading ? 1 : 0;
  else insufficient.push("washTrading");

  // F10 liquidityFragility: NOT computed in a single-snapshot scan (INSUFFICIENT).
  // Its equation is unproved; omitted deliberately (see module header).
  insufficient.push("liquidityFragility");

  return { activations, insufficient };
}
