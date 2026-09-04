import { describe, it, expect } from "vitest";

import {
  evaluateToBattlefield,
  type EvaluationObservations,
} from "../../src/core/features/warEvaluation.js";
import type {
  MarketObservation,
  AnalyticsObservation,
  FlowObservation,
} from "../../src/core/timeline/types.js";
import type { UnixMillis, Chain, TokenAddress } from "../../src/shared/scalars.js";

const chain: Chain = "sol";
const address = "TokenAAA" as TokenAddress;

function market(at: number, close: number, vol: number): MarketObservation {
  return {
    meta: { at: at as UnixMillis, temporalOrigin: "GMGN_HISTORICAL", coverage: "COMPLETE", provenance: "market.kline" },
    open: close - 1, high: close + 1, low: close - 2, close, volumeUsd: vol, amountTokens: vol * 10,
  };
}

function analytics(at: number, over: Partial<AnalyticsObservation> = {}): AnalyticsObservation {
  return {
    meta: { at: at as UnixMillis, temporalOrigin: "WAR_SAMPLED", coverage: "SAMPLED", provenance: "market.trending" },
    price: 1, marketCap: 1_000_000, liquidity: 200_000, holderCount: 1500,
    swaps: 300, buys: 180, sells: 120, smartDegenCount: 8, renownedCount: 3,
    rugRatio: 0.15, top10HolderRate: 0.35, isWashTrading: false, bundlerRate: 0.05,
    ...over,
  };
}

function flow(at: number, side: "buy" | "sell", usd: number, provenance: "track.smartmoney" | "track.follow-wallet"): FlowObservation {
  return {
    meta: { at: at as UnixMillis, temporalOrigin: "GMGN_EVENT", coverage: "ROLLING", provenance },
    maker: `w${at}`, side, amountUsd: usd, priceUsd: 1,
    positionEvent: side === "buy" ? "FULL_OPEN" : "FULL_CLOSE",
    fullness: "FULL", direction: side === "buy" ? "OPEN" : "CLOSE",
  };
}

/** A realistic multi-lane observation bundle: rising price, smart inflow, clean security. */
function fullObservations(): EvaluationObservations {
  return {
    chain, address,
    market: [
      market(1000, 1.0, 10_000),
      market(2000, 1.1, 12_000),
      market(3000, 1.25, 15_000),
      market(4000, 1.4, 18_000),
    ],
    analytics: [analytics(3500), analytics(4000)],
    flow: [
      flow(1500, "buy", 8_000, "track.smartmoney"),
      flow(2500, "buy", 6_000, "track.smartmoney"),
      flow(3500, "sell", 2_000, "track.follow-wallet"),
    ],
    evaluationAt: 4000 as UnixMillis,
  };
}

describe("4B-7 WarEvaluationPort — full chain end-to-end (no bypass)", () => {
  it("produces a battlefield with exactly the token, from real observations", () => {
    const { battlefield } = evaluateToBattlefield(fullObservations());
    expect(battlefield.tokens).toHaveLength(1);
    expect(battlefield.tokens[0]!.address).toBe(address);
    expect(battlefield.tokens[0]!.chain).toBe("sol");
  });

  it("power/threat/confidence/state/trajectory/coherence/attention are all populated", () => {
    const entry = evaluateToBattlefield(fullObservations()).battlefield.tokens[0]!;
    expect(entry.power.score as number).toBeGreaterThanOrEqual(0);
    expect(entry.threat.score as number).toBeGreaterThanOrEqual(0);
    expect(entry.confidence.score as number).toBeGreaterThanOrEqual(0);
    expect(entry.state).toBeTypeOf("string");
    expect(entry.trajectory.classification).toBeTypeOf("string");
    expect(entry.attention.score as number).toBeGreaterThanOrEqual(0);
  });

  it("rising price + smart inflow yields non-zero power (real activation, not injected)", () => {
    const entry = evaluateToBattlefield(fullObservations()).battlefield.tokens[0]!;
    // trajectoryUp + smartMoneyInflow + coherence should give measurable power
    expect(entry.power.score as number).toBeGreaterThan(0);
    // power carries real supporting contributions from the chain
    expect(entry.power.supporting.length).toBeGreaterThan(0);
  });

  it("threat reflects the security fields (rug 0.15, holders 0.35, no wash)", () => {
    const entry = evaluateToBattlefield(fullObservations()).battlefield.tokens[0]!;
    // rugRisk 0.15*30 + holderConcentration 0.35*25 + washTrading 0*20 -> some threat
    expect(entry.threat.score as number).toBeGreaterThan(0);
  });

  it("B1: scan has NO events", () => {
    const entry = evaluateToBattlefield(fullObservations()).battlefield.tokens[0]!;
    expect(entry.events).toHaveLength(0);
  });

  it("stamps model versions incl. feature/activation/confidence", () => {
    const bf = evaluateToBattlefield(fullObservations()).battlefield;
    expect(bf.modelVersions.featureModelVersion).toBe("feature-v1");
    expect(bf.modelVersions.activationModelVersion).toBe("activation-v1");
    expect(bf.modelVersions.confidenceModelVersion).toBe("confidence-v2");
  });

  it("marketRegime is UNKNOWN for a single-token scan (no cross-token inference)", () => {
    expect(evaluateToBattlefield(fullObservations()).battlefield.marketRegime).toBe("UNKNOWN");
  });

  it("missing lanes propagate as INSUFFICIENT, not fabricated (real missing-data path)", () => {
    const obs: EvaluationObservations = {
      chain, address, market: [], analytics: [], flow: [], evaluationAt: 1000 as UnixMillis,
    };
    const { battlefield, diagnostics } = evaluateToBattlefield(obs);
    // still produces a token, but heavily insufficient
    expect(battlefield.tokens).toHaveLength(1);
    expect(diagnostics.insufficient).toContain("trajectoryUp");
    expect(diagnostics.insufficient).toContain("rugRisk");
    expect(diagnostics.insufficient).toContain("liquidityFragility");
  });

  it("determinism: same observations -> byte-identical battlefield", () => {
    const a = JSON.stringify(evaluateToBattlefield(fullObservations()).battlefield);
    const b = JSON.stringify(evaluateToBattlefield(fullObservations()).battlefield);
    expect(a).toBe(b);
  });
});
