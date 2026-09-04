/**
 * WAR core - Feature layer - Power factor activations F01-F06 (Phase 4B-7).
 *
 * Produces the Power supporting/opposing FactorActivations that POWER_CONFIG
 * names. No new factor, no config change. Each factor maps to a defensible source
 * from the feature layer; unknown sources are surfaced as INSUFFICIENT and omitted
 * (contribute 0 via contributionsOf's `?? 0`), never invented.
 *
 * Factor sourcing (gate applied, per 4A):
 *   F01 trajectoryUp        = (direction==UP) ? clamp01(|velocity|/velRef)*derivConf : 0
 *   F02 coherenceAlignment  = netCoherence
 *   F03 smartMoneyInflow    = clamp01((smartBuyUsd - smartSellUsd)/netRef), where
 *                             "smart" = flow provenance track.smartmoney / track.kol
 *                             (sealed provenance IS the smart-money identity signal)
 *   F04 liquidityDepth      = clamp01((liquidity/marketCap)/depthRef)
 *   F05 sellPressure        = sellUsd/(buyUsd+sellUsd)
 *   F06 vectorConflict      = 1 - netCoherence
 *
 * Reference constants live here and are versioned by activationModelVersion.
 * Missing inputs -> factor OMITTED (contributes 0) + listed in `insufficient`,
 * never fabricated.
 *
 * ANTI-LOOKAHEAD: all inputs derive from observations <= T.
 */

import type { FactorActivations } from "../power/powerEngine.js";
import type { TemporalProfile } from "../temporal/types.js";
import type { FlowObservation, AnalyticsObservation } from "../timeline/types.js";
import type { FlowMetrics } from "../flow/flowEngine.js";

/** Calibration references (versioned via activationModelVersion). */
export interface PowerActivationConfig {
  readonly velRefUp: number; // reference |velocity| -> full trajectoryUp
  readonly depthRef: number; // reference liquidity/marketCap -> full depth
  readonly smartNetRef: number; // reference smart net USD -> full inflow
}

export const POWER_ACTIVATION_CONFIG: PowerActivationConfig = {
  velRefUp: 1,
  depthRef: 0.4,
  smartNetRef: 20_000,
};

export interface PowerActivationSources {
  readonly priceProfile: TemporalProfile | null;
  readonly netCoherence: number | null;
  readonly flow: FlowMetrics | null;
  readonly flowEvents: readonly FlowObservation[];
  readonly latestAnalytics: AnalyticsObservation | null;
}

export interface PowerActivationResult {
  readonly activations: FactorActivations;
  readonly insufficient: readonly string[];
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Smart-money lanes per sealed provenance semantics. */
function isSmartLane(p: string): boolean {
  return p === "track.smartmoney" || p === "track.kol";
}

export function computePowerActivations(
  s: PowerActivationSources,
  config: PowerActivationConfig = POWER_ACTIVATION_CONFIG,
): PowerActivationResult {
  const activations: Record<string, number> = {};
  const insufficient: string[] = [];

  // F01 trajectoryUp
  if (
    s.priceProfile === null ||
    s.priceProfile.method === "INSUFFICIENT_HISTORY" ||
    s.priceProfile.velocity === null
  ) {
    insufficient.push("trajectoryUp");
  } else if (s.priceProfile.direction === "UP") {
    const v = Math.abs(s.priceProfile.velocity as number);
    const conf = s.priceProfile.derivativeConfidence as number;
    activations["trajectoryUp"] = clamp01((v / config.velRefUp) * conf);
  } else {
    activations["trajectoryUp"] = 0; // defined, not up -> genuinely 0 (not missing)
  }

  // F02 coherenceAlignment / F06 vectorConflict (both from netCoherence)
  if (s.netCoherence === null) {
    insufficient.push("coherenceAlignment", "vectorConflict");
  } else {
    activations["coherenceAlignment"] = clamp01(s.netCoherence);
    activations["vectorConflict"] = clamp01(1 - s.netCoherence);
  }

  // F03 smartMoneyInflow (smart-lane net USD, normalized)
  if (s.flowEvents.length === 0) {
    insufficient.push("smartMoneyInflow");
  } else {
    let smartBuy = 0;
    let smartSell = 0;
    let sawSmart = false;
    for (const e of s.flowEvents) {
      if (!isSmartLane(e.meta.provenance)) continue;
      sawSmart = true;
      if (e.side === "buy") smartBuy += e.amountUsd;
      else smartSell += e.amountUsd;
    }
    if (!sawSmart) insufficient.push("smartMoneyInflow");
    else activations["smartMoneyInflow"] = clamp01((smartBuy - smartSell) / config.smartNetRef);
  }

  // F04 liquidityDepth (liquidity / marketCap, normalized)
  if (s.latestAnalytics === null || s.latestAnalytics.marketCap <= 0) {
    insufficient.push("liquidityDepth");
  } else {
    const ratio = s.latestAnalytics.liquidity / s.latestAnalytics.marketCap;
    activations["liquidityDepth"] = clamp01(ratio / config.depthRef);
  }

  // F05 sellPressure (sellUsd / total)
  if (s.flow === null || s.flow.eventCount === 0) {
    insufficient.push("sellPressure");
  } else {
    const total = s.flow.buyPressureUsd + s.flow.sellPressureUsd;
    activations["sellPressure"] = total > 0 ? clamp01(s.flow.sellPressureUsd / total) : 0;
  }

  return { activations, insufficient };
}
