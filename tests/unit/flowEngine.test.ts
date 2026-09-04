import { describe, it, expect } from "vitest";
import {
  computeFlowMetrics,
  detectFlowClusters,
  DEFAULT_FLOW_CONFIG,
} from "../../src/core/flow/flowEngine.js";
import { flowObs } from "../golden/fixtures.js";

describe("computeFlowMetrics", () => {
  it("computes net flow, pressures, and distinct makers", () => {
    const m = computeFlowMetrics([
      flowObs(1000, "A", "buy", 500),
      flowObs(2000, "B", "buy", 1000),
      flowObs(3000, "A", "sell", 300),
    ]);
    expect(m.buyPressureUsd).toBe(1500);
    expect(m.sellPressureUsd).toBe(300);
    expect(m.netFlowUsd).toBe(1200);
    expect(m.distinctMakers).toBe(2);
    expect(m.eventCount).toBe(3);
  });

  it("reports NO_EXIT_OBSERVED when only buys are seen (ROLLING discipline)", () => {
    const m = computeFlowMetrics([
      flowObs(1000, "A", "buy", 500),
      flowObs(2000, "B", "buy", 1000),
    ]);
    expect(m.exitObservation).toBe("NO_EXIT_OBSERVED");
  });

  it("reports EXIT_OBSERVED when a sell appears", () => {
    const m = computeFlowMetrics([
      flowObs(1000, "A", "buy", 500),
      flowObs(2000, "A", "sell", 500),
    ]);
    expect(m.exitObservation).toBe("EXIT_OBSERVED");
  });

  it("concentration reflects a dominant single maker", () => {
    const m = computeFlowMetrics([
      flowObs(1000, "whale", "buy", 9000),
      flowObs(2000, "small", "buy", 1000),
    ]);
    expect(m.concentration as number).toBeCloseTo(0.9, 12);
  });

  it("empty input yields zeroes and NO_EXIT_OBSERVED, not fabricated values", () => {
    const m = computeFlowMetrics([]);
    expect(m.eventCount).toBe(0);
    expect(m.netFlowUsd).toBe(0);
    expect(m.distinctMakers).toBe(0);
    expect(m.exitObservation).toBe("NO_EXIT_OBSERVED");
  });

  it("is deterministic and order-independent", () => {
    const forward = [
      flowObs(1000, "A", "buy", 500),
      flowObs(2000, "B", "sell", 300),
      flowObs(3000, "C", "buy", 700),
    ];
    const a = computeFlowMetrics(forward);
    const b = computeFlowMetrics([...forward].reverse());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("detectFlowClusters", () => {
  it("flags 3 distinct makers buying within the window as a cluster", () => {
    const clusters = detectFlowClusters([
      flowObs(1_000_000, "A", "buy", 100),
      flowObs(1_000_100, "B", "buy", 100),
      flowObs(1_000_200, "C", "buy", 100),
    ]);
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    const buyCluster = clusters.find((c) => c.direction === "buy");
    expect(buyCluster?.distinctMakers).toBe(3);
  });

  it("does not flag the same maker repeated (distinct makers, not events)", () => {
    const clusters = detectFlowClusters([
      flowObs(1_000_000, "A", "buy", 100),
      flowObs(1_000_100, "A", "buy", 100),
      flowObs(1_000_200, "A", "buy", 100),
    ]);
    expect(clusters.find((c) => c.direction === "buy")).toBeUndefined();
  });

  it("does not flag makers spread beyond the cluster window", () => {
    const far = DEFAULT_FLOW_CONFIG.clusterWindow as number;
    const clusters = detectFlowClusters([
      flowObs(0, "A", "buy", 100),
      flowObs(far + 1000, "B", "buy", 100),
      flowObs(2 * far + 2000, "C", "buy", 100),
    ]);
    expect(clusters.find((c) => c.direction === "buy")).toBeUndefined();
  });

  it("is deterministic", () => {
    const evs = [
      flowObs(1_000_000, "A", "buy", 100),
      flowObs(1_000_100, "B", "buy", 100),
      flowObs(1_000_200, "C", "buy", 100),
    ];
    expect(JSON.stringify(detectFlowClusters(evs))).toBe(
      JSON.stringify(detectFlowClusters([...evs].reverse())),
    );
  });
});
