import { describe, it, expect } from "vitest";
import { gmgnTrendingSource, parseTrendingRank, rowToWorldState } from "../../src/integration/gmgnTrendingSource.js";

const SAMPLE = {
  code: 0,
  data: { rank: [
    { chain:"sol", address:"AAA", symbol:"FACTORY", name:"Grok", price:0.0000162, market_cap:15677, liquidity:7518, holder_count:446, top_10_holder_rate:0.21, swaps:9707, buys:5320, sells:4386, smart_degen_count:22, renowned_count:4, rug_ratio:0.01, is_wash_trading:false, is_honeypot:0, is_renounced:0, sniper_count:22, dev_team_hold_rate:0, price_change_percent1h:38.7 },
    { chain:"sol", address:"BBB", symbol:"Baby", name:"Group", price:0.000029, market_cap:28095, liquidity:10567, holder_count:413, top_10_holder_rate:0.20, swaps:3180, buys:1890, sells:1290, smart_degen_count:8, rug_ratio:0, is_wash_trading:false, is_honeypot:0, price_change_percent1h:749 },
  ] },
  message: "success",
};

describe("parseTrendingRank", () => {
  it("extracts rank rows from the CLI envelope", () => {
    const rows = parseTrendingRank(SAMPLE);
    expect(rows).not.toBeNull();
    expect(rows!.length).toBe(2);
    expect(rows![0]!.address).toBe("AAA");
  });
  it("returns null on malformed input", () => {
    expect(parseTrendingRank(null)).toBeNull();
    expect(parseTrendingRank({})).toBeNull();
    expect(parseTrendingRank({ data: {} })).toBeNull();
  });
});

describe("rowToWorldState", () => {
  it("maps a trending row into a WorldState display view with stats", () => {
    const rows = parseTrendingRank(SAMPLE)!;
    const w = rowToWorldState(rows[0]!, "sol");
    expect(w.chain).toBe("sol");
    expect(w.address).toBe("AAA");
    expect(w.power.raw).toBeGreaterThanOrEqual(0);
    expect(w.power.raw).toBeLessThanOrEqual(100);
    expect(["HIGH","MODERATE","LOW"]).toContain(w.power.band);
    // stats payload present
    const stats = (w as unknown as { stats: Record<string, unknown> }).stats;
    expect(stats.holders).toBe(446);
    expect(stats.top10Rate).toBe(0.21);
    expect(stats.honeypot).toBe(false);
    expect(stats.smartMoney).toBe(22);
  });
  it("flags high rug ratio as COLLAPSE mood", () => {
    const w = rowToWorldState({ address:"X", rug_ratio:0.8, buys:1, sells:1 }, "sol");
    expect(w.mood).toBe("COLLAPSE");
  });
});

describe("gmgnTrendingSource", () => {
  it("pulls addresses across chains and evaluates from cached rows", async () => {
    const run = async (chain: string) => chain === "sol" ? parseTrendingRank(SAMPLE) : null;
    const { source, evaluate } = gmgnTrendingSource(run as never, 6);
    const tokens = await source();
    expect(tokens).not.toBeNull();
    expect(tokens!.length).toBe(2);
    const w = await evaluate(tokens![0]!);
    expect(w).not.toBeNull();
    expect(w!.address).toBe("AAA");
  });
  it("returns null when every chain fails", async () => {
    const { source } = gmgnTrendingSource(async () => null, 6);
    expect(await source()).toBeNull();
  });
  it("evaluate returns null for an unknown token", async () => {
    const { evaluate } = gmgnTrendingSource(async () => null, 6);
    expect(await evaluate({ chain:"sol", address:"NOPE" })).toBeNull();
  });
});
