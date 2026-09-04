import { describe, it, expect } from "vitest";
import {
  computeTemporalProfile,
  DEFAULT_TEMPORAL_CONFIG,
} from "../../src/core/temporal/temporalEngine.js";
import type { SignalPoint } from "../../src/core/temporal/temporalEngine.js";
import type { UnixMillis } from "../../src/shared/scalars.js";

const p = (at: number, value: number): SignalPoint => ({
  at: at as UnixMillis,
  value,
});

describe("computeTemporalProfile — no fabrication", () => {
  it("empty series yields INSUFFICIENT_HISTORY with null derivatives", () => {
    const r = computeTemporalProfile([]);
    expect(r.method).toBe("INSUFFICIENT_HISTORY");
    expect(r.velocity).toBeNull();
    expect(r.acceleration).toBeNull();
    expect(r.direction).toBe("UNKNOWN");
    expect(r.derivativeConfidence as number).toBe(0);
  });

  it("single point cannot produce a velocity", () => {
    const r = computeTemporalProfile([p(1000, 42)]);
    expect(r.method).toBe("INSUFFICIENT_HISTORY");
    expect(r.velocity).toBeNull();
    expect(r.level as number).toBe(42);
  });

  it("two points produce a velocity but no acceleration", () => {
    const r = computeTemporalProfile([p(1000, 10), p(2000, 20)]);
    expect(r.velocity).not.toBeNull();
    expect(r.acceleration).toBeNull();
    expect(r.method).toBe("FINITE_DIFFERENCE");
    // Δvalue/Δt = 10 / 1000 = 0.01
    expect(r.velocity as number).toBeCloseTo(0.01, 12);
    expect(r.direction).toBe("UP");
  });

  it("three points produce an acceleration", () => {
    const r = computeTemporalProfile([p(0, 0), p(1000, 10), p(2000, 30)]);
    expect(r.velocity).not.toBeNull();
    expect(r.acceleration).not.toBeNull();
  });
});

describe("computeTemporalProfile — irregular time", () => {
  it("handles irregular spacing without dividing by zero", () => {
    const r = computeTemporalProfile([p(0, 0), p(50, 5), p(3000, 6)]);
    expect(Number.isFinite(r.velocity as number)).toBe(true);
    expect(r.method).toBe("FINITE_DIFFERENCE");
  });

  it("duplicate timestamp with equal value is deduped; zero Δt yields null velocity when it is the last step", () => {
    // last two points share a timestamp → Δt = 0 → velocity null (no fabrication)
    const r = computeTemporalProfile([p(0, 0), p(1000, 10), p(1000, 15)]);
    expect(r.velocity).toBeNull();
    expect(r.method).toBe("INSUFFICIENT_HISTORY");
  });

  it("out-of-order input is sorted deterministically before differencing", () => {
    const forward = computeTemporalProfile([p(0, 0), p(1000, 10), p(2000, 30)]);
    const shuffled = computeTemporalProfile([p(2000, 30), p(0, 0), p(1000, 10)]);
    expect(JSON.stringify(forward)).toBe(JSON.stringify(shuffled));
  });
});

describe("computeTemporalProfile — direction + persistence", () => {
  it("flat series within epsilon is FLAT", () => {
    const r = computeTemporalProfile([p(0, 5), p(1000, 5)]);
    expect(r.direction).toBe("FLAT");
  });

  it("monotonic rising series has persistence 1", () => {
    const r = computeTemporalProfile([p(0, 1), p(1, 2), p(2, 3), p(3, 4)]);
    expect(r.persistence as number).toBe(1);
    expect(r.direction).toBe("UP");
  });

  it("choppy series has persistence below 1", () => {
    const r = computeTemporalProfile([p(0, 1), p(1, 3), p(2, 2), p(3, 4)]);
    expect(r.persistence as number).toBeLessThan(1);
  });
});

describe("computeTemporalProfile — determinism", () => {
  it("identical input yields byte-identical output", () => {
    const series = [p(0, 0), p(1000, 10), p(2000, 30), p(3000, 35)];
    const a = computeTemporalProfile(series);
    const b = computeTemporalProfile(series);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("derivative confidence rises with more points, never exceeds 1", () => {
    const two = computeTemporalProfile([p(0, 0), p(1, 1)]);
    const five = computeTemporalProfile([
      p(0, 0), p(1, 1), p(2, 2), p(3, 3), p(4, 4),
    ]);
    expect(five.derivativeConfidence as number).toBeGreaterThan(
      two.derivativeConfidence as number,
    );
    expect(five.derivativeConfidence as number).toBeLessThanOrEqual(1);
  });

  it("config is honored (raising minPointsForVelocity blocks a 2-point velocity)", () => {
    const r = computeTemporalProfile([p(0, 0), p(1000, 10)], {
      ...DEFAULT_TEMPORAL_CONFIG,
      minPointsForVelocity: 3,
    });
    expect(r.velocity).toBeNull();
    expect(r.method).toBe("INSUFFICIENT_HISTORY");
  });
});
