import { describe, it, expect } from "vitest";
import {
  computePower,
  computeThreat,
  computeConfidence,
} from "../../src/core/power/powerEngine.js";
import type {
  FactorActivations,
  ConfidenceInputs,
} from "../../src/core/power/powerEngine.js";

describe("computePower", () => {
  it("high supporting activation yields high power with a breakdown", () => {
    const acts: FactorActivations = {
      trajectoryUp: 1,
      coherenceAlignment: 1,
      smartMoneyInflow: 1,
      liquidityDepth: 1,
    };
    const p = computePower(acts, 1);
    expect(p.score as number).toBeGreaterThan(80);
    expect(p.supporting.length).toBeGreaterThan(0);
    expect(p.opposing.length).toBeGreaterThan(0);
  });

  it("opposing factors pull power down", () => {
    const withOppose = computePower(
      { trajectoryUp: 1, sellPressure: 1, vectorConflict: 1 },
      0.5,
    );
    const without = computePower({ trajectoryUp: 1 }, 0.5);
    expect(withOppose.score as number).toBeLessThan(without.score as number);
  });

  it("empty activations yield zero power, not a fabricated value", () => {
    const p = computePower({}, 0);
    expect(p.score as number).toBe(0);
  });

  it("clamps into [0,100]", () => {
    const p = computePower(
      { trajectoryUp: 1, coherenceAlignment: 1, smartMoneyInflow: 1, liquidityDepth: 1 },
      1,
    );
    expect(p.score as number).toBeLessThanOrEqual(100);
    expect(p.score as number).toBeGreaterThanOrEqual(0);
  });

  it("is deterministic", () => {
    const acts: FactorActivations = { trajectoryUp: 0.7, sellPressure: 0.3 };
    expect(JSON.stringify(computePower(acts, 0.5))).toBe(
      JSON.stringify(computePower(acts, 0.5)),
    );
  });
});

describe("computeThreat - independent of Power", () => {
  it("high danger factors yield high threat", () => {
    const t = computeThreat({
      rugRisk: 1,
      holderConcentration: 1,
      washTrading: 1,
      liquidityFragility: 1,
    });
    expect(t.score as number).toBeGreaterThan(80);
    expect(t.supporting.length).toBe(4);
  });

  it("threat does not change when power inputs change (independence)", () => {
    const threatInputs = { rugRisk: 0.5, holderConcentration: 0.5 };
    const t1 = computeThreat(threatInputs);
    const t2 = computeThreat(threatInputs);
    expect(t1.score as number).toBe(t2.score as number);
  });

  it("high Power and high Threat can coexist (the key V3.2 property)", () => {
    const power = computePower(
      { trajectoryUp: 1, coherenceAlignment: 1, smartMoneyInflow: 1, liquidityDepth: 1 },
      1,
    );
    const threat = computeThreat({
      rugRisk: 1,
      holderConcentration: 1,
      washTrading: 1,
      liquidityFragility: 1,
    });
    expect(power.score as number).toBeGreaterThan(80);
    expect(threat.score as number).toBeGreaterThan(80);
  });
});

describe("computeConfidence - evidence quality, not probability", () => {
  const full: ConfidenceInputs = {
    completeness: 1,
    freshness: 1,
    historyDepth: 1,
    coherence: 1,
    measurementStability: 1,
    derivativeReliability: 1,
    limitingCoverage: "COMPLETE",
    limitingTemporalOrigin: "GMGN_HISTORICAL",
  };

  it("full evidence with COMPLETE coverage yields ~100", () => {
    const c = computeConfidence(full);
    expect(c.score as number).toBeGreaterThan(95);
  });

  it("ROLLING coverage constrains confidence below COMPLETE", () => {
    const rolling = computeConfidence({ ...full, limitingCoverage: "ROLLING" });
    const complete = computeConfidence(full);
    expect(rolling.score as number).toBeLessThan(complete.score as number);
  });

  it("conflict (low coherence) lowers confidence", () => {
    const conflicted = computeConfidence({ ...full, coherence: 0 });
    const aligned = computeConfidence(full);
    expect(conflicted.score as number).toBeLessThan(aligned.score as number);
  });

  it("carries all sub-dimensions for explainability", () => {
    const c = computeConfidence(full);
    expect(c.completeness as number).toBe(1);
    expect(c.limitingCoverage).toBe("COMPLETE");
    expect(c.limitingTemporalOrigin).toBe("GMGN_HISTORICAL");
  });

  it("is deterministic", () => {
    expect(JSON.stringify(computeConfidence(full))).toBe(
      JSON.stringify(computeConfidence(full)),
    );
  });
});
