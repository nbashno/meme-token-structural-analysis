import { describe, it, expect } from "vitest";
import { buildTokenTimeline } from "../../src/core/timeline/buildTimeline.js";
import type { TimelineBuildInput } from "../../src/core/timeline/buildTimeline.js";
import {
  CHAIN,
  ADDRESS,
  NOW,
  marketObs,
  analyticsObs,
  flowObs,
} from "../golden/fixtures.js";

function baseInput(): TimelineBuildInput {
  return {
    chain: CHAIN,
    address: ADDRESS,
    now: NOW,
    // deliberately out-of-order + one exact duplicate market candle
    market: [
      marketObs(1_700_000_300_000, 12, 500),
      marketObs(1_700_000_100_000, 10, 300),
      marketObs(1_700_000_200_000, 11, 400),
      marketObs(1_700_000_200_000, 11, 400), // exact dup
    ],
    analytics: [analyticsObs(1_700_000_250_000, 1.1, 1_000_000)],
    flow: [
      flowObs(1_700_000_150_000, "walletB", "buy", 1000),
      flowObs(1_700_000_120_000, "walletA", "buy", 500),
      // same instant, different maker → must NOT be deduped
      flowObs(1_700_000_120_000, "walletC", "sell", 700),
    ],
  };
}

describe("buildTokenTimeline", () => {
  it("sorts market lane chronologically and drops exact duplicates", () => {
    const r = buildTokenTimeline(baseInput());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const times = r.timeline.market.map((o) => o.meta.at as number);
    expect(times).toEqual([
      1_700_000_100_000, 1_700_000_200_000, 1_700_000_300_000,
    ]);
  });

  it("keeps distinct flow trades at the same instant (no over-dedupe)", () => {
    const r = buildTokenTimeline(baseInput());
    if (!r.ok) throw new Error(r.reason);
    const sameInstant = r.timeline.flow.filter(
      (o) => (o.meta.at as number) === 1_700_000_120_000,
    );
    expect(sameInstant.length).toBe(2); // walletA buy + walletC sell
  });

  it("computes window bounds from actual data", () => {
    const r = buildTokenTimeline(baseInput());
    if (!r.ok) throw new Error(r.reason);
    expect(r.timeline.windowStart as number).toBe(1_700_000_100_000);
    expect(r.timeline.windowEnd as number).toBe(1_700_000_300_000);
  });

  it("reports FLOW observed-for as now minus earliest flow (ROLLING made explicit)", () => {
    const r = buildTokenTimeline(baseInput());
    if (!r.ok) throw new Error(r.reason);
    // earliest flow = 1_700_000_120_000, now = 1_700_000_600_000
    expect(r.timeline.flowObservedFor as number).toBe(480_000);
  });

  it("rejects a market observation whose coverage is not COMPLETE", () => {
    const bad = baseInput();
    const mutated: TimelineBuildInput = {
      ...bad,
      market: [
        {
          ...marketObs(1_700_000_100_000, 10, 300),
          meta: {
            at: 1_700_000_100_000 as never,
            temporalOrigin: "GMGN_HISTORICAL",
            coverage: "ROLLING", // wrong
            provenance: "market.kline",
          },
        },
      ],
    };
    const r = buildTokenTimeline(mutated);
    expect(r.ok).toBe(false);
  });

  it("is deterministic: identical input yields byte-identical output", () => {
    const a = buildTokenTimeline(baseInput());
    const b = buildTokenTimeline(baseInput());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("input order does not change output (order-independence)", () => {
    const forward = baseInput();
    const reversed: TimelineBuildInput = {
      ...forward,
      market: [...forward.market].reverse(),
      flow: [...forward.flow].reverse(),
    };
    const a = buildTokenTimeline(forward);
    const b = buildTokenTimeline(reversed);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("buildTokenTimeline — golden snapshot", () => {
  it("matches the frozen golden output", () => {
    const r = buildTokenTimeline(baseInput());
    expect(r).toMatchSnapshot();
  });
});
