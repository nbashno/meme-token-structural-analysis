import { describe, it, expect } from "vitest";

import {
  buildConfidenceInputs,
  type ConfidenceSources,
} from "../../src/core/features/confidenceInputs.js";

function sources(over: Partial<ConfidenceSources>): ConfidenceSources {
  return {
    lanesPresent: 3, lanesExpected: 3,
    newestObservedAt: 900, evaluationAt: 1000,
    marketSpanMs: 5000, referenceSpanMs: 10000,
    netCoherence: 0.8, derivativeConfidence: 0.7,
    limitingCoverage: "SAMPLED", limitingTemporalOrigin: "WAR_SAMPLED",
    freshnessHorizonMs: 1000,
    ...over,
  };
}

describe("4B-5.2 ConfidenceInputs builder", () => {
  it("completeness = lanes present / expected", () => {
    expect(buildConfidenceInputs(sources({ lanesPresent: 3 })).inputs.completeness).toBe(1);
    expect(buildConfidenceInputs(sources({ lanesPresent: 2 })).inputs.completeness).toBeCloseTo(2 / 3, 9);
    expect(buildConfidenceInputs(sources({ lanesPresent: 0 })).inputs.completeness).toBe(0);
  });

  it("freshness decays from 1 (at T) to 0 (at horizon)", () => {
    expect(buildConfidenceInputs(sources({ newestObservedAt: 1000, evaluationAt: 1000 })).inputs.freshness).toBe(1);
    expect(buildConfidenceInputs(sources({ newestObservedAt: 500, evaluationAt: 1000, freshnessHorizonMs: 1000 })).inputs.freshness).toBeCloseTo(0.5, 9);
    expect(buildConfidenceInputs(sources({ newestObservedAt: 0, evaluationAt: 1000, freshnessHorizonMs: 1000 })).inputs.freshness).toBe(0);
  });

  it("freshness never reads the future (age floored at 0)", () => {
    // newestObservedAt after T (shouldn't happen, but must not produce >1)
    const r = buildConfidenceInputs(sources({ newestObservedAt: 1500, evaluationAt: 1000 }));
    expect(r.inputs.freshness).toBe(1);
  });

  it("missing newest observation => freshness 0 + INSUFFICIENT", () => {
    const r = buildConfidenceInputs(sources({ newestObservedAt: null }));
    expect(r.inputs.freshness).toBe(0);
    expect(r.insufficient).toContain("freshness");
  });

  it("historyDepth = span / reference, clamped", () => {
    expect(buildConfidenceInputs(sources({ marketSpanMs: 5000, referenceSpanMs: 10000 })).inputs.historyDepth).toBe(0.5);
    expect(buildConfidenceInputs(sources({ marketSpanMs: 20000, referenceSpanMs: 10000 })).inputs.historyDepth).toBe(1);
  });

  it("null coherence / derivativeConfidence => 0 + INSUFFICIENT (not invented)", () => {
    const r = buildConfidenceInputs(sources({ netCoherence: null, derivativeConfidence: null }));
    expect(r.inputs.coherence).toBe(0);
    expect(r.inputs.derivativeReliability).toBe(0);
    expect(r.insufficient).toContain("coherence");
    expect(r.insufficient).toContain("derivativeReliability");
  });

  it("measurementStability is ALWAYS surfaced as INSUFFICIENT in a single-snapshot scan", () => {
    const r = buildConfidenceInputs(sources({}));
    expect(r.insufficient).toContain("measurementStability");
    // weight is zeroed in confidence-v2, so the value is inert (0), never invented
    expect(r.inputs.measurementStability).toBe(0);
  });

  it("passes through the limiting coverage + origin unchanged", () => {
    const r = buildConfidenceInputs(sources({ limitingCoverage: "ROLLING", limitingTemporalOrigin: "GMGN_EVENT" }));
    expect(r.inputs.limitingCoverage).toBe("ROLLING");
    expect(r.inputs.limitingTemporalOrigin).toBe("GMGN_EVENT");
  });
});
