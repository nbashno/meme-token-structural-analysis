import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  buildDirectedVectors,
  flowDirection,
  directionFromProfile,
  sellPressureDirection,
  type VectorSources,
} from "../../src/core/features/directedVectors.js";
import type { TemporalProfile } from "../../src/core/temporal/types.js";
import type { FlowMetrics } from "../../src/core/flow/flowEngine.js";
import type { Ratio0to1 } from "../../src/shared/scalars.js";

function profile(direction: TemporalProfile["direction"]): TemporalProfile {
  return {
    level: 0 as never, velocity: null, acceleration: null,
    persistence: 0 as Ratio0to1, direction, derivativeConfidence: 0 as Ratio0to1,
    window: 0 as never, method: "INSUFFICIENT_HISTORY",
  };
}

function flow(netFlowUsd: number, eventCount: number): FlowMetrics {
  return {
    netFlowUsd, buyPressureUsd: Math.max(0, netFlowUsd), sellPressureUsd: Math.max(0, -netFlowUsd),
    distinctMakers: 1, concentration: 0 as Ratio0to1, persistence: 1 as Ratio0to1,
    exitObservation: "NO_EXIT_OBSERVED", eventCount,
  };
}

describe("4B-5.1 DirectedVector builder", () => {
  it("price/volume/liquidity direction = TemporalProfile.direction", () => {
    expect(directionFromProfile(profile("UP"))).toBe("UP");
    expect(directionFromProfile(profile("DOWN"))).toBe("DOWN");
    expect(directionFromProfile(profile("FLAT"))).toBe("FLAT");
    expect(directionFromProfile(profile("UNKNOWN"))).toBe("UNKNOWN");
  });

  it("flow direction = sign of netFlowUsd", () => {
    expect(flowDirection(flow(100, 5))).toBe("UP");
    expect(flowDirection(flow(-100, 5))).toBe("DOWN");
    expect(flowDirection(flow(0, 5))).toBe("FLAT");
  });

  it("flow with no events is UNKNOWN, not FLAT (missing != zero)", () => {
    expect(flowDirection(flow(0, 0))).toBe("UNKNOWN");
    expect(flowDirection(flow(50, 0))).toBe("UNKNOWN");
  });

  it("sellPressure is deliberately UNKNOWN (no sealed sign convention)", () => {
    expect(sellPressureDirection()).toBe("UNKNOWN");
  });

  it("builds all five named vectors; null sources -> UNKNOWN", () => {
    const sources: VectorSources = {
      priceProfile: profile("UP"), volumeProfile: null,
      liquidityProfile: profile("DOWN"), flow: flow(200, 3),
    };
    const vecs = buildDirectedVectors(sources);
    const byName = Object.fromEntries(vecs.map((v) => [v.name, v.direction]));
    expect(byName["price"]).toBe("UP");
    expect(byName["volume"]).toBe("UNKNOWN"); // null source
    expect(byName["liquidity"]).toBe("DOWN");
    expect(byName["flow"]).toBe("UP");
    expect(byName["sellPressure"]).toBe("UNKNOWN"); // always, by design
    expect(vecs).toHaveLength(5);
  });

  it("property: flow direction sign is monotonic and total", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: 1_000_000 }), (net) => {
        const d = flowDirection(flow(net, 1));
        if (net > 0) expect(d).toBe("UP");
        else if (net < 0) expect(d).toBe("DOWN");
        else expect(d).toBe("FLAT");
      }),
    );
  });
});
