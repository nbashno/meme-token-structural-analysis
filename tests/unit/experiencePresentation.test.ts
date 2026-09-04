import { describe, it, expect } from "vitest";
import {
  resolveField,
  resolveWorldState,
  loadingField,
  errorField,
} from "../../src/experience/presentationState.js";
import type { WorldState } from "../../src/world/worldAdapter.js";

function ws(over: Partial<WorldState> = {}): WorldState {
  return {
    chain: "solana", address: "abc", generatedAt: 1,
    mood: "DORMANT", trajectory: "STABLE", coherence: "UNKNOWN", leadLag: "INSUFFICIENT", regime: "NEUTRAL",
    power: { raw: 0, visual01: 0, band: "Low" },
    threat: { raw: 0, visual01: 0, band: "Low" },
    confidence: { raw: 0, visual01: 0, band: "Low" },
    attention: { raw: 0, visual01: 0, band: "Low" },
    events: [], signals: [], whyNow: [], flowEntities: [],
    dataQuality: "COMPLETE", qualityReasons: [], insufficient: [],
    visual: { territorySize01: 0, contestBalance01: 0.5 },
    ...over,
  };
}

describe("C6 presentation state — INSUFFICIENT never becomes 0", () => {
  it("returns INSUFFICIENT (value null) for a gated key — not zero", () => {
    const f = resolveField("liquidityFragility", 0, ["liquidityFragility"]);
    expect(f.state).toBe("INSUFFICIENT");
    expect(f.value).toBeNull();
    expect(f.label).toBe("INSUFFICIENT");
  });

  it("returns INSUFFICIENT for null/undefined raw", () => {
    expect(resolveField("x", null, []).state).toBe("INSUFFICIENT");
    expect(resolveField("x", undefined, []).state).toBe("INSUFFICIENT");
  });

  it("returns READY with the real value when present and not gated", () => {
    const f = resolveField("power", 71, []);
    expect(f.state).toBe("READY");
    expect(f.value).toBe(71);
  });

  it("returns ERROR for non-finite", () => {
    expect(resolveField("x", NaN, []).state).toBe("ERROR");
    expect(resolveField("x", Infinity, []).state).toBe("ERROR");
  });

  it("a real zero value is READY (0), distinct from INSUFFICIENT", () => {
    const f = resolveField("threat", 0, []);
    expect(f.state).toBe("READY");
    expect(f.value).toBe(0); // genuine zero, not gated
  });
});

describe("C6 world presentation state", () => {
  it("INSUFFICIENT quality -> INSUFFICIENT", () => {
    expect(resolveWorldState(ws({ dataQuality: "INSUFFICIENT" }))).toBe("INSUFFICIENT");
  });
  it("CONFLICTED quality -> ERROR", () => {
    expect(resolveWorldState(ws({ dataQuality: "CONFLICTED" }))).toBe("ERROR");
  });
  it("quiet but COMPLETE -> EMPTY (real quiet, not broken)", () => {
    expect(resolveWorldState(ws({ dataQuality: "COMPLETE" }))).toBe("EMPTY");
  });
  it("active + COMPLETE -> READY", () => {
    expect(resolveWorldState(ws({
      dataQuality: "COMPLETE",
      flowEntities: [{ maker: "a", side: "buy", amountUsd: 100, lane: "OTHER", persona: "UNKNOWN" }],
    }))).toBe("READY");
  });
  it("loading and error placeholders are honest", () => {
    expect(loadingField().state).toBe("LOADING");
    expect(loadingField().value).toBeNull();
    expect(errorField("acquire failed").state).toBe("ERROR");
  });
});
