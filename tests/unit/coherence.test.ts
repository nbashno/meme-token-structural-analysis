import { describe, it, expect } from "vitest";
import {
  computeCoherence,
  computeLeadLag,
  DEFAULT_LEADLAG_CONFIG,
} from "../../src/core/coherence/coherence.js";
import type { DirectedVector, DirectionalMove } from "../../src/core/coherence/coherence.js";

const v = (
  name: DirectedVector["name"],
  direction: DirectedVector["direction"],
): DirectedVector => ({ name, direction });

describe("computeCoherence - agreement vs conflict", () => {
  it("all vectors up -> STRONG alignment, high netCoherence", () => {
    const c = computeCoherence([
      v("price", "UP"),
      v("volume", "UP"),
      v("flow", "UP"),
    ]);
    expect(c.state).toBe("STRONG_MULTI_VECTOR_ALIGNMENT");
    expect(c.netCoherence as number).toBe(1);
  });

  it("split vectors -> conflict lowers netCoherence below full alignment", () => {
    const c = computeCoherence([
      v("price", "UP"),
      v("flow", "DOWN"),
      v("sellPressure", "DOWN"),
      v("volume", "DOWN"),
    ]);
    // consensus is DOWN (3 of 4); price disagrees -> netCoherence 0.75 < 1
    expect(c.netCoherence as number).toBeLessThan(1);
    expect(c.netCoherence as number).toBeCloseTo(0.75, 12);
    // 0.75 is alignment, not full conflict - the point is it dropped below 1
    expect(c.state).toBe("MULTI_VECTOR_ALIGNMENT");
  });

  it("genuine conflict (half disagree) -> low coherence, MIXED or CONFLICT", () => {
    const c = computeCoherence([
      v("price", "UP"),
      v("volume", "UP"),
      v("flow", "DOWN"),
      v("sellPressure", "DOWN"),
    ]);
    // 2 up, 2 down -> consensus tie (0); nothing shares sign 0 -> netCoherence 0
    expect(c.netCoherence as number).toBeLessThan(0.6);
    expect(["MIXED", "MULTI_VECTOR_CONFLICT"]).toContain(c.state);
  });

  it("even split flags the disagreeing vector explicitly", () => {
    const c = computeCoherence([v("price", "UP"), v("flow", "DOWN")]);
    const price = c.vectors.find((x) => x.name === "price");
    const flow = c.vectors.find((x) => x.name === "flow");
    // consensus is 0 (tie) -> neither shares sign
    expect(price?.agrees).toBe(false);
    expect(flow?.agrees).toBe(false);
  });

  it("too few usable vectors -> INSUFFICIENT", () => {
    const c = computeCoherence([v("price", "UP"), v("flow", "UNKNOWN")]);
    expect(c.state).toBe("INSUFFICIENT");
    expect(c.netCoherence as number).toBe(0);
  });

  it("UNKNOWN vectors are excluded, not counted as agreement", () => {
    const c = computeCoherence([
      v("price", "UP"),
      v("volume", "UP"),
      v("flow", "UNKNOWN"),
    ]);
    const flow = c.vectors.find((x) => x.name === "flow");
    expect(flow?.agrees).toBeNull();
  });

  it("is deterministic", () => {
    const vs = [v("price", "UP"), v("flow", "DOWN"), v("volume", "UP")];
    expect(JSON.stringify(computeCoherence(vs))).toBe(
      JSON.stringify(computeCoherence([...vs].reverse())),
    );
  });
});

const m = (at: number, sign: 1 | -1): DirectionalMove => ({ at, sign });

describe("computeLeadLag - observed precedence, not causation", () => {
  it("flow consistently before price -> FLOW_LEADS", () => {
    const flow = [m(0, 1), m(1000, 1), m(2000, 1)];
    const price = [m(300, 1), m(1300, 1), m(2300, 1)];
    const r = computeLeadLag(flow, price);
    expect(r.result).toBe("FLOW_LEADS");
    expect(r.observedLag as number).toBe(300);
  });

  it("simultaneous moves -> SYNCHRONIZED", () => {
    const flow = [m(0, 1), m(1000, 1), m(2000, 1)];
    const price = [m(0, 1), m(1000, 1), m(2000, 1)];
    const r = computeLeadLag(flow, price);
    expect(r.result).toBe("SYNCHRONIZED");
  });

  it("empty series -> INSUFFICIENT_HISTORY, null lag", () => {
    const r = computeLeadLag([], [m(0, 1)]);
    expect(r.result).toBe("INSUFFICIENT_HISTORY");
    expect(r.observedLag).toBeNull();
    expect(r.confidence as number).toBe(0);
  });

  it("too few matches -> INSUFFICIENT_HISTORY", () => {
    const flow = [m(0, 1)];
    const price = [m(300, 1)];
    const r = computeLeadLag(flow, price);
    expect(r.result).toBe("INSUFFICIENT_HISTORY");
  });

  it("moves beyond max lag are not matched", () => {
    const far = DEFAULT_LEADLAG_CONFIG.maxLagMs + 1000;
    const flow = [m(0, 1), m(1000, 1), m(2000, 1)];
    const price = [m(far, 1), m(far + 1000, 1), m(far + 2000, 1)];
    const r = computeLeadLag(flow, price);
    expect(r.result).toBe("INSUFFICIENT_HISTORY");
  });

  it("confidence stays within [0,100] and is deterministic", () => {
    const flow = [m(0, 1), m(1000, 1), m(2000, 1), m(3000, 1)];
    const price = [m(300, 1), m(1300, 1), m(2300, 1), m(3300, 1)];
    const a = computeLeadLag(flow, price);
    const b = computeLeadLag(flow, price);
    expect(a.confidence as number).toBeGreaterThanOrEqual(0);
    expect(a.confidence as number).toBeLessThanOrEqual(100);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
