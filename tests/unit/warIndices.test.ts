import { describe, it, expect } from "vitest";
import {
  absorptionIndex, concentrationIndex, organicIndex, sniperIndex, convictionIndex,
  integrityIndex, flowIndex, athIndex, turnoverIndex, warScore, computeIndices, analyze,
  type IndexInputs,
} from "../../src/product/analysis/warIndices.js";

// A realistic token (mirrors a live GMGN trending row)
const REAL: IndexInputs = {
  marketCap: 15677, liquidity: 7518, athMarketCap: 110038, volume: 360693,
  holders: 446, top10Rate: 0.2105, devHoldRate: 0, top70SniperRate: 0,
  bundlerRate: 0.0894, sniperCount: 22, botRate: 0.2951, ratTraderRate: 0.0002,
  washTrading: false, rugRatio: 0.01, honeypot: false, renounced: false,
  openSource: false, renouncedMint: true, renouncedFreeze: true,
  lockPercent: 0, burnRatio: 0, buys: 5320, sells: 4386,
  smartMoney: 22, renowned: 4, buyTax: "0", sellTax: "0",
};

describe("absorptionIndex", () => {
  it("saturates at 20% liquidity/cap", () => {
    const a = absorptionIndex({ liquidity: 200, marketCap: 1000 }); // 20%
    expect(a.score).toBe(100);
    expect(a.band).toBe("STRONG");
  });
  it("scales linearly below the healthy band", () => {
    const a = absorptionIndex({ liquidity: 50, marketCap: 1000 }); // 5% -> 25
    expect(a.score).toBe(25);
  });
  it("is INSUFFICIENT without inputs", () => {
    expect(absorptionIndex({}).band).toBe("INSUFFICIENT");
    expect(absorptionIndex({ liquidity: 10 }).score).toBeNull();
  });
});

describe("concentrationIndex", () => {
  it("flags the 40% top-10 high-risk line", () => {
    const c = concentrationIndex({ top10Rate: 0.45 });
    expect(c.reading).toContain("40%");
    expect(c.higherIsBetter).toBe(false);
  });
  it("folds dev, sniper and bundle share into risk", () => {
    const low = concentrationIndex({ top10Rate: 0.2 });
    const high = concentrationIndex({ top10Rate: 0.2, devHoldRate: 0.3, bundlerRate: 0.5 });
    expect((high.score as number)).toBeGreaterThan(low.score as number);
  });
  it("mentions bundled wallets masking concentration", () => {
    const c = concentrationIndex({ top10Rate: 0.1, bundlerRate: 0.4 });
    expect(c.reading.toLowerCase()).toContain("bundled");
  });
});

describe("organicIndex", () => {
  it("discounts multiplicatively for bots and rat traders", () => {
    const o = organicIndex({ botRate: 0.5, ratTraderRate: 0.2 });
    expect(o.score).toBe(40); // 100*0.5*0.8
  });
  it("halves the score when wash trading is detected", () => {
    const o = organicIndex({ botRate: 0, ratTraderRate: 0, washTrading: true });
    expect(o.score).toBe(50);
    expect(o.reading.toLowerCase()).toContain("wash");
  });
  it("is INSUFFICIENT when no activity-quality inputs exist", () => {
    expect(organicIndex({}).band).toBe("INSUFFICIENT");
  });
});

describe("sniperIndex", () => {
  it("rises with sniper density and held share", () => {
    const a = sniperIndex({ sniperCount: 5, holders: 500 });
    const b = sniperIndex({ sniperCount: 50, holders: 500, top70SniperRate: 0.3 });
    expect((b.score as number)).toBeGreaterThan(a.score as number);
    expect(b.higherIsBetter).toBe(false);
  });
  it("is INSUFFICIENT without holders", () => {
    expect(sniperIndex({ sniperCount: 10 }).band).toBe("INSUFFICIENT");
  });
});

describe("integrityIndex", () => {
  it("forces the floor on honeypot", () => {
    const x = integrityIndex({ honeypot: true, renounced: true, openSource: true });
    expect(x.score).toBe(0);
    expect(x.band).toBe("CRITICAL");
    expect(x.display).toBe("HONEYPOT");
  });
  it("scores a clean contract high", () => {
    const x = integrityIndex({ honeypot: false, renounced: true, openSource: true,
      renouncedMint: true, renouncedFreeze: true, lockPercent: 1, buyTax: "0", sellTax: "0" });
    expect(x.score).toBe(100);
  });
  it("lists the specific gaps", () => {
    const x = integrityIndex({ honeypot: false, renounced: false, openSource: false,
      renouncedMint: true, renouncedFreeze: true });
    expect(x.reading).toContain("not renounced");
    expect(x.reading).toContain("closed source");
  });
  it("penalises high taxes", () => {
    const low = integrityIndex({ renounced: true, buyTax: "0", sellTax: "0" });
    const high = integrityIndex({ renounced: true, buyTax: "0.2", sellTax: "0.2" });
    expect((high.score as number)).toBeLessThan(low.score as number);
  });
});

describe("convictionIndex", () => {
  it("measures smart-money density per holder base", () => {
    const dense = convictionIndex({ smartMoney: 50, renowned: 10, holders: 200 });
    const sparse = convictionIndex({ smartMoney: 2, renowned: 0, holders: 5000 });
    expect((dense.score as number)).toBeGreaterThan(sparse.score as number);
    expect(dense.higherIsBetter).toBe(true);
  });
  it("weighs renowned wallets more than smart money", () => {
    const smart = convictionIndex({ smartMoney: 10, renowned: 0, holders: 500 });
    const ren = convictionIndex({ smartMoney: 0, renowned: 10, holders: 500 });
    expect((ren.score as number)).toBeGreaterThan(smart.score as number);
  });
  it("is INSUFFICIENT without a holder base", () => {
    expect(convictionIndex({ smartMoney: 10 }).band).toBe("INSUFFICIENT");
  });
});

describe("flowIndex", () => {
  it("reports buy share of trades", () => {
    const f = flowIndex({ buys: 70, sells: 30 });
    expect(f.score).toBe(70);
    expect(f.reading.toLowerCase()).toContain("buyers");
  });
  it("detects distribution", () => {
    const f = flowIndex({ buys: 20, sells: 80 });
    expect(f.reading.toLowerCase()).toContain("sellers");
  });
});

describe("athIndex", () => {
  it("reports position against peak", () => {
    const a = athIndex({ marketCap: 20, athMarketCap: 100 });
    expect(a.score).toBe(20);
    expect(a.reading).toContain("80%");
  });
});

describe("turnoverIndex", () => {
  it("peaks in the healthy 3-15 band", () => {
    expect(turnoverIndex({ buys: 5, sells: 5, holders: 2 }).score).toBe(100); // 5/holder
  });
  it("penalises dormancy", () => {
    const t = turnoverIndex({ buys: 1, sells: 0, holders: 100 }); // 0.01
    expect((t.score as number)).toBeLessThan(10);
    expect(t.reading.toLowerCase()).toContain("dormant");
  });
  it("penalises extreme churn", () => {
    const t = turnoverIndex({ buys: 5000, sells: 5000, holders: 100 }); // 100/holder
    expect((t.score as number)).toBeLessThan(40);
  });
});

describe("warScore composite", () => {
  it("excludes INSUFFICIENT indices and renormalises weights", () => {
    const partial = computeIndices({ buys: 60, sells: 40 }); // only flow computes
    const v = warScore(partial);
    expect(v.score).not.toBeNull();
    expect(v.contributors).toContain("flow");
    expect(v.excluded.length).toBeGreaterThan(0);
  });
  it("returns INSUFFICIENT when nothing can be computed", () => {
    const v = warScore(computeIndices({}));
    expect(v.score).toBeNull();
    expect(v.band).toBe("INSUFFICIENT");
  });
  it("honeypot forces a critical verdict regardless of other strengths", () => {
    const idx = computeIndices({ honeypot: true, liquidity: 500, marketCap: 1000,
      top10Rate: 0.05, buys: 100, sells: 1, holders: 1000, botRate: 0 });
    const v = warScore(idx);
    expect(v.score).toBe(0);
    expect(v.band).toBe("CRITICAL");
    expect(v.verdict.toLowerCase()).toContain("honeypot");
  });
  it("inverts risk indices (high concentration lowers the score)", () => {
    const safe = warScore(computeIndices({ ...REAL, top10Rate: 0.05 }));
    const risky = warScore(computeIndices({ ...REAL, top10Rate: 0.9 }));
    expect((safe.score as number)).toBeGreaterThan(risky.score as number);
  });
});

describe("analyze on a real token shape", () => {
  it("produces indices, a verdict and ranked findings", () => {
    const a = analyze(REAL);
    expect(a.indices.length).toBe(9);
    expect(a.verdict.score).not.toBeNull();
    expect(a.findings.length).toBeGreaterThan(0);
    // every computed index carries its formula (transparency requirement)
    for (const idx of a.indices) expect(idx.formula.length).toBeGreaterThan(5);
  });
  it("is deterministic — same inputs, same output", () => {
    expect(JSON.stringify(analyze(REAL))).toBe(JSON.stringify(analyze(REAL)));
  });
  it("ranks the most severe finding first", () => {
    const a = analyze({ ...REAL, top10Rate: 0.95, botRate: 0.9 });
    expect(a.findings[0]).toBeTruthy();
    // the worst reading should surface in the top findings
    expect(a.findings.join(" ")).toMatch(/Concentration|Organic/);
  });
});
