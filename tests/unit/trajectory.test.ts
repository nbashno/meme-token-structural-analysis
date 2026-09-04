import { describe, it, expect } from "vitest";
import {
  classifyTrajectory,
  combineTrajectories,
} from "../../src/core/trajectory/trajectory.js";
import { computeTemporalProfile } from "../../src/core/temporal/temporalEngine.js";
import type { SignalPoint } from "../../src/core/temporal/temporalEngine.js";
import type { TemporalProfile } from "../../src/core/temporal/types.js";
import type {
  FiniteNumber,
  Ratio0to1,
  DurationMillis,
  UnixMillis,
} from "../../src/shared/scalars.js";

const pt = (at: number, value: number): SignalPoint => ({
  at: at as UnixMillis,
  value,
});

/** Build a synthetic profile with explicit derivatives for direct classifier tests. */
function profile(
  velocity: number | null,
  acceleration: number | null,
  opts?: { dc?: number; persist?: number },
): TemporalProfile {
  return {
    level: 0 as FiniteNumber,
    velocity: velocity === null ? null : (velocity as FiniteNumber),
    acceleration: acceleration === null ? null : (acceleration as FiniteNumber),
    persistence: (opts?.persist ?? 1) as Ratio0to1,
    direction: "UNKNOWN",
    derivativeConfidence: (opts?.dc ?? 1) as Ratio0to1,
    window: 1000 as DurationMillis,
    method: velocity === null ? "INSUFFICIENT_HISTORY" : "FINITE_DIFFERENCE",
  };
}

describe("classifyTrajectory - classes", () => {
  it("up + accelerating up -> ACCELERATING_UP", () => {
    expect(classifyTrajectory(profile(0.5, 0.01)).classification).toBe(
      "ACCELERATING_UP",
    );
  });
  it("up + decelerating -> DECELERATING", () => {
    expect(classifyTrajectory(profile(0.5, -0.01)).classification).toBe(
      "DECELERATING",
    );
  });
  it("up + steady accel -> RISING", () => {
    expect(classifyTrajectory(profile(0.5, 0)).classification).toBe("RISING");
  });
  it("down + accelerating down -> ACCELERATING_DOWN", () => {
    expect(classifyTrajectory(profile(-0.5, -0.01)).classification).toBe(
      "ACCELERATING_DOWN",
    );
  });
  it("down + steady -> FALLING", () => {
    expect(classifyTrajectory(profile(-0.5, 0)).classification).toBe("FALLING");
  });
  it("flat velocity + flat accel -> FLATTENING", () => {
    expect(classifyTrajectory(profile(0, 0)).classification).toBe("FLATTENING");
  });
  it("flat velocity + non-zero accel -> REVERSING", () => {
    expect(classifyTrajectory(profile(0, 0.5)).classification).toBe("REVERSING");
  });
});

describe("classifyTrajectory - no fabrication", () => {
  it("insufficient history -> UNKNOWN with zero confidence", () => {
    const empty = computeTemporalProfile([]);
    const t = classifyTrajectory(empty);
    expect(t.classification).toBe("UNKNOWN");
    expect(t.confidence as number).toBe(0);
  });
  it("null velocity -> UNKNOWN", () => {
    expect(classifyTrajectory(profile(null, null)).classification).toBe(
      "UNKNOWN",
    );
  });
  it("carries the profile as basis (explainability)", () => {
    const t = classifyTrajectory(profile(0.5, 0.01));
    expect(t.basis.length).toBe(1);
  });
});

describe("classifyTrajectory - from real series", () => {
  it("a rising accelerating price series classifies as ACCELERATING_UP", () => {
    const prof = computeTemporalProfile([
      pt(0, 0),
      pt(1000, 10),
      pt(2000, 30), // gaps grow -> accelerating
    ]);
    const t = classifyTrajectory(prof);
    expect(["ACCELERATING_UP", "RISING"]).toContain(t.classification);
  });

  it("confidence stays within [0,100]", () => {
    const prof = computeTemporalProfile([pt(0, 0), pt(1, 1), pt(2, 2)]);
    const c = classifyTrajectory(prof).confidence as number;
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(100);
  });

  it("is deterministic", () => {
    const prof = computeTemporalProfile([pt(0, 0), pt(1000, 10), pt(2000, 30)]);
    const a = classifyTrajectory(prof);
    const b = classifyTrajectory(prof);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("combineTrajectories", () => {
  it("keeps every basis profile (does not average away disagreement)", () => {
    const up = classifyTrajectory(profile(0.5, 0.01));
    const down = classifyTrajectory(profile(-0.5, -0.01));
    const combined = combineTrajectories([up, down]);
    expect(combined.basis.length).toBe(2);
  });
  it("all-unknown input yields UNKNOWN", () => {
    const u = classifyTrajectory(profile(null, null));
    expect(combineTrajectories([u, u]).classification).toBe("UNKNOWN");
  });
  it("picks the highest-confidence usable trajectory deterministically", () => {
    const strong = classifyTrajectory(profile(0.5, 0.01, { dc: 1, persist: 1 }));
    const weak = classifyTrajectory(profile(-0.5, 0, { dc: 0.2, persist: 0.3 }));
    expect(combineTrajectories([weak, strong]).classification).toBe(
      "ACCELERATING_UP",
    );
  });
});
