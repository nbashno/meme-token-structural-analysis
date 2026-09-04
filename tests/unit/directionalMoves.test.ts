import { describe, it, expect } from "vitest";

import {
  movesFromSeries,
  movesFromFlowEvents,
} from "../../src/core/features/directionalMoves.js";
import { computeLeadLag } from "../../src/core/coherence/coherence.js";

describe("4B-5.5 DirectionalMove builder", () => {
  it("emits +1 for up steps, -1 for down, nothing for flat", () => {
    const moves = movesFromSeries([
      { at: 1, value: 10 },
      { at: 2, value: 12 }, // up
      { at: 3, value: 12 }, // flat -> no move
      { at: 4, value: 9 }, // down
    ]);
    expect(moves).toEqual([
      { at: 2, sign: 1 },
      { at: 4, sign: -1 },
    ]);
  });

  it("timestamps a move at the LATER point (no lookahead)", () => {
    const moves = movesFromSeries([{ at: 100, value: 5 }, { at: 200, value: 6 }]);
    expect(moves[0]!.at).toBe(200); // never the earlier point
  });

  it("fewer than 2 points -> no moves", () => {
    expect(movesFromSeries([])).toEqual([]);
    expect(movesFromSeries([{ at: 1, value: 5 }])).toEqual([]);
  });

  it("flow events: buy=+1, sell=-1, time-ordered", () => {
    const moves = movesFromFlowEvents([
      { at: 3, side: "sell" },
      { at: 1, side: "buy" },
      { at: 2, side: "buy" },
    ]);
    expect(moves).toEqual([
      { at: 1, sign: 1 },
      { at: 2, sign: 1 },
      { at: 3, sign: -1 },
    ]);
  });

  it("feeds computeLeadLag: flow moves preceding price moves is observable", () => {
    // flow rises repeatedly, price rises shortly after each -> flow leads.
    const flow = movesFromFlowEvents([
      { at: 1000, side: "buy" },
      { at: 2000, side: "buy" },
      { at: 3000, side: "buy" },
      { at: 4000, side: "buy" },
    ]);
    // price series produces 4 up-moves, each shortly after a flow move.
    const price = movesFromSeries([
      { at: 1400, value: 1 },
      { at: 2400, value: 2 },
      { at: 3400, value: 3 },
      { at: 4400, value: 4 },
    ]);
    const ll = computeLeadLag(flow, price);
    // 4 matched flow-leads-price pairs >= minMatches(3): a real verdict, not INSUFFICIENT.
    expect(ll.result).not.toBe("INSUFFICIENT_HISTORY");
  });

  it("empty sequences -> lead/lag INSUFFICIENT_HISTORY", () => {
    expect(computeLeadLag([], movesFromSeries([{ at: 1, value: 1 }, { at: 2, value: 2 }])).result).toBe(
      "INSUFFICIENT_HISTORY",
    );
  });
});
