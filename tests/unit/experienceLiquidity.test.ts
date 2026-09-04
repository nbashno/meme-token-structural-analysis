import { describe, it, expect } from "vitest";
import { toLiquidityView } from "../../src/experience/liquidityView.js";
import type { WorldState } from "../../src/world/worldAdapter.js";

function fixture(flowEntities: WorldState["flowEntities"]): WorldState {
  return {
    chain: "solana", address: "abc", generatedAt: 1000,
    mood: "ATTACK", trajectory: "STABLE", coherence: "ALIGNED", leadLag: "FLOW_LEADS", regime: "RISK_ON",
    power: { raw: 70, visual01: 0.7, band: "Elevated" },
    threat: { raw: 30, visual01: 0.3, band: "Moderate" },
    confidence: { raw: 60, visual01: 0.6, band: "Elevated" },
    attention: { raw: 80, visual01: 0.8, band: "High" },
    events: [], signals: [], whyNow: [],
    flowEntities,
    dataQuality: "GOOD", qualityReasons: [], insufficient: [],
    visual: { territorySize01: 0.8, contestBalance01: 0.7 },
  };
}

describe("liquidity view — pure aggregation, mirrors flowEngine", () => {
  it("sums inflow/outflow/net exactly", () => {
    const v = toLiquidityView(fixture([
      { maker: "a", side: "buy", amountUsd: 1000, lane: "SMART_MONEY", persona: "UNKNOWN" },
      { maker: "b", side: "buy", amountUsd: 500, lane: "KOL", persona: "UNKNOWN" },
      { maker: "c", side: "sell", amountUsd: 300, lane: "FOLLOW_WALLET", persona: "UNKNOWN" },
    ]));
    expect(v.inflowUsd).toBe(1500);
    expect(v.outflowUsd).toBe(300);
    expect(v.netUsd).toBe(1200);
    expect(v.totalUsd).toBe(1800);
    expect(v.buyCount).toBe(2);
    expect(v.sellCount).toBe(1);
    expect(v.distinctMakers).toBe(3);
    expect(v.hasFlow).toBe(true);
  });

  it("inflowShare is 0.5 and hasFlow false when empty", () => {
    const v = toLiquidityView(fixture([]));
    expect(v.hasFlow).toBe(false);
    expect(v.inflowShare).toBe(0.5);
    expect(v.totalUsd).toBe(0);
    expect(v.wallets).toEqual([]);
  });

  it("breaks down by lane in stable order", () => {
    const v = toLiquidityView(fixture([
      { maker: "a", side: "buy", amountUsd: 100, lane: "OTHER", persona: "UNKNOWN" },
      { maker: "b", side: "buy", amountUsd: 200, lane: "SMART_MONEY", persona: "UNKNOWN" },
    ]));
    expect(v.lanes[0]!.lane).toBe("SMART_MONEY"); // stable order, SMART_MONEY first
    expect(v.lanes.find((l) => l.lane === "SMART_MONEY")!.buyUsd).toBe(200);
  });

  it("sorts wallets by amount descending, keeps persona UNKNOWN", () => {
    const v = toLiquidityView(fixture([
      { maker: "small", side: "buy", amountUsd: 100, lane: "KOL", persona: "UNKNOWN" },
      { maker: "big", side: "sell", amountUsd: 900, lane: "SMART_MONEY", persona: "UNKNOWN" },
    ]));
    expect(v.wallets[0]!.maker).toBe("big");
    expect(v.wallets[0]!.persona).toBe("UNKNOWN");
  });

  it("guards non-finite amounts to 0", () => {
    const v = toLiquidityView(fixture([
      { maker: "a", side: "buy", amountUsd: NaN, lane: "OTHER", persona: "UNKNOWN" },
    ]));
    expect(v.inflowUsd).toBe(0);
  });
});
