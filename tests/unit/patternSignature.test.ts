import { describe, it, expect } from "vitest";

import {
  buildPatternSignature,
  coherenceBand,
} from "../../src/core/features/patternSignature.js";
import { computeNovelty, recordPattern } from "../../src/core/novelty/novelty.js";

describe("4B-5.3 PatternSignature builder", () => {
  it("is deterministic: same inputs -> same signature", () => {
    const a = buildPatternSignature({ state: "ACCUMULATION", trajectory: "RISING", netCoherence: 0.8 });
    const b = buildPatternSignature({ state: "ACCUMULATION", trajectory: "RISING", netCoherence: 0.8 });
    expect(a).toBe(b);
  });

  it("distinct situations -> distinct signatures", () => {
    const a = buildPatternSignature({ state: "ACCUMULATION", trajectory: "RISING", netCoherence: 0.8 });
    const b = buildPatternSignature({ state: "DISTRIBUTION", trajectory: "FALLING", netCoherence: 0.2 });
    expect(a).not.toBe(b);
  });

  it("coherence band edges are explicit", () => {
    expect(coherenceBand(0)).toBe("LOW");
    expect(coherenceBand(0.33)).toBe("LOW");
    expect(coherenceBand(0.34)).toBe("MID");
    expect(coherenceBand(0.66)).toBe("MID");
    expect(coherenceBand(0.67)).toBe("HIGH");
    expect(coherenceBand(1)).toBe("HIGH");
  });

  it("null coherence => NONE (unknown is not low)", () => {
    expect(coherenceBand(null)).toBe("NONE");
    const sig = buildPatternSignature({ state: "OBSERVING", trajectory: "UNKNOWN", netCoherence: null });
    expect(sig).toContain("coh=NONE");
    expect(sig).toContain("traj=UNKNOWN");
  });

  it("feeds computeNovelty: unseen pattern is maximally novel, repeats decay", () => {
    const sig = buildPatternSignature({ state: "ATTACK", trajectory: "ACCELERATING_UP", netCoherence: 0.9 });
    let memory = {};
    expect(computeNovelty(sig, memory).rarity as number).toBe(1); // never seen
    memory = recordPattern(sig, memory);
    expect(computeNovelty(sig, memory).rarity as number).toBe(0.5); // seen once
    memory = recordPattern(sig, memory);
    expect(computeNovelty(sig, memory).rarity as number).toBeCloseTo(1 / 3, 9);
  });
});
