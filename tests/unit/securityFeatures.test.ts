import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { parseTrending, type RawTrending } from "../../src/adapters/gmgn/gmgnParsers.js";
import { computeThreatActivations } from "../../src/core/features/threatActivations.js";
import type { AnalyticsObservation } from "../../src/core/timeline/types.js";
import type { UnixMillis } from "../../src/shared/scalars.js";

const AT = 1000 as UnixMillis;

function base(): RawTrending {
  return { price: 1, market_cap: 1_000_000, liquidity: 50_000 };
}

// ── 4B-2: parser mapping proof ────────────────────────────────────────────────

describe("4B-2 parser: security field mapping", () => {
  it("maps rug_ratio -> rugRatio, top_10_holder_rate -> top10HolderRate, bundler_rate -> bundlerRate", () => {
    const obs = parseTrending(
      { ...base(), rug_ratio: 0.25, top_10_holder_rate: 0.4, bundler_rate: 0.1 },
      AT,
    )!;
    expect(obs.rugRatio).toBe(0.25);
    expect(obs.top10HolderRate).toBe(0.4);
    expect(obs.bundlerRate).toBe(0.1);
  });

  it("is_wash_trading is a REAL boolean (true/false and \"true\"/\"false\")", () => {
    expect(parseTrending({ ...base(), is_wash_trading: true }, AT)!.isWashTrading).toBe(true);
    expect(parseTrending({ ...base(), is_wash_trading: false }, AT)!.isWashTrading).toBe(false);
    expect(parseTrending({ ...base(), is_wash_trading: "true" }, AT)!.isWashTrading).toBe(true);
    expect(parseTrending({ ...base(), is_wash_trading: "false" }, AT)!.isWashTrading).toBe(false);
  });

  it("does NOT conflate is_wash_trading with 1/0 flags (is_honeypot/is_renounced style)", () => {
    // 1 and 0 are the encoding for is_honeypot / is_renounced, NOT wash trading.
    expect(parseTrending({ ...base(), is_wash_trading: 1 }, AT)!.isWashTrading).toBeNull();
    expect(parseTrending({ ...base(), is_wash_trading: 0 }, AT)!.isWashTrading).toBeNull();
    expect(parseTrending({ ...base(), is_wash_trading: "yes" }, AT)!.isWashTrading).toBeNull();
  });

  it("missing security fields stay null (no missing -> 0 coercion)", () => {
    const obs = parseTrending(base(), AT)!;
    expect(obs.rugRatio).toBeNull();
    expect(obs.top10HolderRate).toBeNull();
    expect(obs.isWashTrading).toBeNull();
    expect(obs.bundlerRate).toBeNull();
  });

  it("out-of-[0,1] ratios are rejected as invalid (null), NOT silently clamped", () => {
    expect(parseTrending({ ...base(), rug_ratio: 1.7 }, AT)!.rugRatio).toBeNull();
    expect(parseTrending({ ...base(), rug_ratio: -0.2 }, AT)!.rugRatio).toBeNull();
    expect(parseTrending({ ...base(), top_10_holder_rate: 2 }, AT)!.top10HolderRate).toBeNull();
    expect(parseTrending({ ...base(), bundler_rate: 5 }, AT)!.bundlerRate).toBeNull();
  });

  it("property: any in-range ratio round-trips exactly; any out-of-range -> null", () => {
    fc.assert(
      fc.property(fc.double({ min: -5, max: 5, noNaN: true }), (v) => {
        const obs = parseTrending({ ...base(), rug_ratio: v }, AT)!;
        if (v >= 0 && v <= 1) expect(obs.rugRatio).toBe(v);
        else expect(obs.rugRatio).toBeNull();
      }),
    );
  });

  it("preserves the existing analytics fields unchanged", () => {
    const obs = parseTrending({ ...base(), holder_count: 900, swaps: 40 }, AT)!;
    expect(obs.price).toBe(1);
    expect(obs.marketCap).toBe(1_000_000);
    expect(obs.holderCount).toBe(900);
    expect(obs.swaps).toBe(40);
  });
});

// ── 4B-3: threat activation math ──────────────────────────────────────────────

function analytics(over: Partial<AnalyticsObservation>): AnalyticsObservation {
  return {
    meta: { at: AT, temporalOrigin: "WAR_SAMPLED", coverage: "SAMPLED", provenance: "market.trending" },
    price: 1, marketCap: 1_000_000, liquidity: 50_000, holderCount: 1000,
    swaps: 100, buys: 60, sells: 40, smartDegenCount: 3, renownedCount: 1,
    rugRatio: null, top10HolderRate: null, isWashTrading: null, bundlerRate: null,
    ...over,
  };
}

describe("4B-3 threat activations: sealed factor mapping", () => {
  it("rugRisk = rugRatio (identity)", () => {
    const r = computeThreatActivations(analytics({ rugRatio: 0.42 }));
    expect(r.activations["rugRisk"]).toBe(0.42);
  });

  it("holderConcentration = top10HolderRate (identity)", () => {
    const r = computeThreatActivations(analytics({ top10HolderRate: 0.6 }));
    expect(r.activations["holderConcentration"]).toBe(0.6);
  });

  it("washTrading = isWashTrading ? 1 : 0", () => {
    expect(computeThreatActivations(analytics({ isWashTrading: true })).activations["washTrading"]).toBe(1);
    expect(computeThreatActivations(analytics({ isWashTrading: false })).activations["washTrading"]).toBe(0);
  });

  it("null security source => factor UNKNOWN (omitted + listed insufficient), never 0-invented", () => {
    const r = computeThreatActivations(analytics({ rugRatio: null, top10HolderRate: null, isWashTrading: null }));
    expect(r.activations["rugRisk"]).toBeUndefined();
    expect(r.insufficient).toContain("rugRisk");
    expect(r.insufficient).toContain("holderConcentration");
    expect(r.insufficient).toContain("washTrading");
  });

  it("liquidityFragility is ALWAYS insufficient in scan (unproved equation, deliberately omitted)", () => {
    const r = computeThreatActivations(analytics({ rugRatio: 0.1, top10HolderRate: 0.1, isWashTrading: false }));
    expect(r.activations["liquidityFragility"]).toBeUndefined();
    expect(r.insufficient).toContain("liquidityFragility");
  });

  it("null analytics => all four threat factors insufficient", () => {
    const r = computeThreatActivations(null);
    expect(r.insufficient).toEqual(
      expect.arrayContaining(["rugRisk", "holderConcentration", "washTrading", "liquidityFragility"]),
    );
    expect(Object.keys(r.activations)).toHaveLength(0);
  });

  it("does not emit any factor name outside THREAT_CONFIG", () => {
    const r = computeThreatActivations(analytics({ rugRatio: 0.2, top10HolderRate: 0.3, isWashTrading: true, bundlerRate: 0.5 }));
    const allowed = new Set(["rugRisk", "holderConcentration", "washTrading", "liquidityFragility"]);
    for (const k of Object.keys(r.activations)) expect(allowed.has(k)).toBe(true);
    // bundlerRate must NOT become a factor
    expect(r.activations["bundlerRate"]).toBeUndefined();
    expect(r.activations["bundler_rate"]).toBeUndefined();
  });
});
