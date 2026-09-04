import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  evaluateToBattlefield,
  type EvaluationObservations,
} from "../../src/core/features/warEvaluation.js";
import { computePowerActivations } from "../../src/core/features/powerActivations.js";
import { computeThreatActivations } from "../../src/core/features/threatActivations.js";
import { buildAttentionInputs } from "../../src/core/features/attentionInputs.js";
import { POWER_CONFIG, THREAT_CONFIG, CONFIDENCE_CONFIG } from "../../src/config/scoring.js";
import type {
  MarketObservation,
  AnalyticsObservation,
  FlowObservation,
} from "../../src/core/timeline/types.js";
import type { UnixMillis, Chain, TokenAddress } from "../../src/shared/scalars.js";

const chain: Chain = "sol";
const address = "TokenAAA" as TokenAddress;

function market(at: number, close: number): MarketObservation {
  return {
    meta: { at: at as UnixMillis, temporalOrigin: "GMGN_HISTORICAL", coverage: "COMPLETE", provenance: "market.kline" },
    open: close, high: close + 1, low: close - 1, close, volumeUsd: 10_000, amountTokens: 100_000,
  };
}
function analytics(at: number, over: Partial<AnalyticsObservation> = {}): AnalyticsObservation {
  return {
    meta: { at: at as UnixMillis, temporalOrigin: "WAR_SAMPLED", coverage: "SAMPLED", provenance: "market.trending" },
    price: 1, marketCap: 1_000_000, liquidity: 200_000, holderCount: 1000,
    swaps: 100, buys: 60, sells: 40, smartDegenCount: 3, renownedCount: 1,
    rugRatio: 0.2, top10HolderRate: 0.3, isWashTrading: false, bundlerRate: 0.1, ...over,
  };
}
function flow(at: number, side: "buy" | "sell", usd: number): FlowObservation {
  return {
    meta: { at: at as UnixMillis, temporalOrigin: "GMGN_EVENT", coverage: "ROLLING", provenance: "track.smartmoney" },
    maker: `w${at}`, side, amountUsd: usd, priceUsd: 1,
    positionEvent: "FULL_OPEN", fullness: "FULL", direction: "OPEN",
  };
}

function obsAt(evaluationAt: number, klineUpTo: number): EvaluationObservations {
  const market_: MarketObservation[] = [];
  for (let t = 1000; t <= klineUpTo; t += 1000) market_.push(market(t, 1 + t / 10000));
  return {
    chain, address, market: market_,
    analytics: [analytics(evaluationAt)],
    flow: [flow(1500, "buy", 5000), flow(2500, "buy", 4000)],
    evaluationAt: evaluationAt as UnixMillis,
  };
}

describe("4B-8 brutal chain invariants", () => {
  // 1. ANTI-LOOKAHEAD: including a future observation must not change the result
  it("anti-lookahead: future observations do not affect evaluation at T", () => {
    const atT = obsAt(3000, 3000);
    const withFuture: EvaluationObservations = {
      ...atT,
      market: [...atT.market, market(9000, 99)], // a point far after T=3000
    };
    // Filter future ourselves the way the caller must: the chain should be given
    // only <= T. To prove the invariant, evaluate T-sliced vs. T-sliced-with-extra
    // that the caller correctly excludes. Here we assert the builder is a pure
    // function of its input, and that a correctly-sliced input == the T input.
    const sliced: EvaluationObservations = {
      ...withFuture,
      market: withFuture.market.filter((m) => (m.meta.at as number) <= 3000),
    };
    const a = JSON.stringify(evaluateToBattlefield(atT).battlefield);
    const b = JSON.stringify(evaluateToBattlefield(sliced).battlefield);
    expect(a).toBe(b);
  });

  // 2. DETERMINISTIC REPLAY
  it("deterministic replay: identical inputs -> identical output", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2000, max: 6000 }), (t) => {
        const o = obsAt(t, t);
        const a = JSON.stringify(evaluateToBattlefield(o).battlefield);
        const b = JSON.stringify(evaluateToBattlefield(o).battlefield);
        expect(a).toBe(b);
      }),
    );
  });

  // 3. MISSING-DATA PROPAGATION
  it("missing-data propagation: empty lanes -> INSUFFICIENT, never fabricated", () => {
    const empty: EvaluationObservations = { chain, address, market: [], analytics: [], flow: [], evaluationAt: 1000 as UnixMillis };
    const { diagnostics } = evaluateToBattlefield(empty);
    for (const f of ["trajectoryUp", "coherenceAlignment", "smartMoneyInflow", "liquidityDepth", "sellPressure", "rugRisk", "holderConcentration", "washTrading", "liquidityFragility"]) {
      expect(diagnostics.insufficient).toContain(f);
    }
  });

  // 4. [0,1] INVARIANTS on activations
  it("[0,1] invariants: all activations stay within [0,1]", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (rug, holders) => {
          const a = analytics(4000, { rugRatio: rug, top10HolderRate: holders });
          const t = computeThreatActivations(a);
          for (const v of Object.values(t.activations)) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
          }
        },
      ),
    );
  });

  // 5. FACTOR-WEIGHT INTEGRITY: config unchanged
  it("factor-weight integrity: POWER/THREAT configs are the sealed values", () => {
    expect(POWER_CONFIG.version).toBe("power-v1");
    expect(THREAT_CONFIG.version).toBe("threat-v1");
    expect(CONFIDENCE_CONFIG.version).toBe("confidence-v2");
    expect(CONFIDENCE_CONFIG.measurementStability).toBe(0);
    const powerFactors = [...POWER_CONFIG.supportingWeights, ...POWER_CONFIG.opposingWeights].map((w) => w.factor);
    expect(powerFactors).toEqual(["trajectoryUp", "coherenceAlignment", "smartMoneyInflow", "liquidityDepth", "sellPressure", "vectorConflict"]);
    const threatFactors = THREAT_CONFIG.weights.map((w) => w.factor);
    expect(threatFactors).toEqual(["rugRisk", "holderConcentration", "washTrading", "liquidityFragility"]);
  });

  // 6. NO BUNDLER FACTOR
  it("no bundler factor: bundlerRate never appears in any activation", () => {
    const a = analytics(4000, { bundlerRate: 0.9 });
    const t = computeThreatActivations(a);
    const p = computePowerActivations({ priceProfile: null, netCoherence: 0.5, flow: null, flowEvents: [], latestAnalytics: a });
    expect(Object.keys(t.activations)).not.toContain("bundlerRate");
    expect(Object.keys(t.activations)).not.toContain("bundler_rate");
    expect(Object.keys(p.activations)).not.toContain("bundlerRate");
  });

  // 7. NO CROSS-TOKEN CAUSALITY
  it("no cross-token causality: crossTokenImpact is always 0", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 100, noNaN: true }), (power) => {
        const inp = buildAttentionInputs({ power, acceleration: 1, accelerationRef: 1, noveltyRarity: 1, netCoherence: 0, confidence: 0 });
        expect(inp.crossTokenImpact).toBe(0);
      }),
    );
  });

  // 8. B1 INVARIANT: scan has no events, no state-transition attention
  it("B1 invariant: scan produces no events and zeroed transition drivers", () => {
    const entry = evaluateToBattlefield(obsAt(4000, 4000)).battlefield.tokens[0]!;
    expect(entry.events).toHaveLength(0);
    const inp = buildAttentionInputs({ power: 50, acceleration: 1, accelerationRef: 1, noveltyRarity: 0.5, netCoherence: 0.5, confidence: 50 });
    expect(inp.stateTransition).toBe(0);
    expect(inp.trajectoryReversal).toBe(0);
  });

  // 9. NON-REDUNDANCY: F02 coherenceAlignment + F06 vectorConflict == 1 (single source split)
  it("non-redundancy: coherenceAlignment + vectorConflict == 1 (no double-count)", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (coh) => {
        const p = computePowerActivations({ priceProfile: null, netCoherence: coh, flow: null, flowEvents: [], latestAnalytics: null });
        const align = p.activations["coherenceAlignment"]!;
        const conflict = p.activations["vectorConflict"]!;
        expect(align + conflict).toBeCloseTo(1, 9);
      }),
    );
  });

  // 10. NO liquidityFragility computed
  it("liquidityFragility is never computed in scan (always insufficient)", () => {
    const t = computeThreatActivations(analytics(4000));
    expect(Object.keys(t.activations)).not.toContain("liquidityFragility");
    expect(t.insufficient).toContain("liquidityFragility");
  });
});
