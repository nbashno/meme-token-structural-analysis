import { describe, it, expect } from "vitest";
import { computeAttention } from "../../src/core/attention/attention.js";
import type { AttentionInputs } from "../../src/core/attention/attention.js";
import {
  computeNovelty,
  recordPattern,
} from "../../src/core/novelty/novelty.js";
import type { PatternMemory } from "../../src/core/novelty/novelty.js";
import { buildEvidence } from "../../src/core/evidence/evidence.js";
import type { EvidenceInput } from "../../src/core/evidence/evidence.js";
import type { UnixMillis } from "../../src/shared/scalars.js";

function att(over: Partial<AttentionInputs> = {}): AttentionInputs {
  return {
    magnitude: over.magnitude ?? 0,
    acceleration: over.acceleration ?? 0,
    novelty: over.novelty ?? 0,
    stateTransition: over.stateTransition ?? 0,
    trajectoryReversal: over.trajectoryReversal ?? 0,
    signalConflict: over.signalConflict ?? 0,
    uncertainty: over.uncertainty ?? 0,
    crossTokenImpact: over.crossTokenImpact ?? 0,
  };
}

describe("computeAttention - independent of Power", () => {
  it("high novelty + acceleration yields high attention regardless of any power", () => {
    const a = computeAttention(
      att({ novelty: 1, acceleration: 1, trajectoryReversal: 1, stateTransition: 1 }),
    );
    expect(a.score as number).toBeGreaterThan(60);
  });

  it("lists the drivers that materially contributed", () => {
    const a = computeAttention(att({ novelty: 1, acceleration: 0.5 }));
    expect(a.contributors).toContain("NOVELTY");
    expect(a.contributors).toContain("ACCELERATION");
    expect(a.contributors).not.toContain("UNCERTAINTY");
  });

  it("zero inputs yield zero attention, not a fabricated value", () => {
    expect(computeAttention(att()).score as number).toBe(0);
  });

  it("stays within [0,100] even if all drivers maxed", () => {
    const a = computeAttention(
      att({
        magnitude: 1, acceleration: 1, novelty: 1, stateTransition: 1,
        trajectoryReversal: 1, signalConflict: 1, uncertainty: 1, crossTokenImpact: 1,
      }),
    );
    expect(a.score as number).toBeLessThanOrEqual(100);
  });

  it("is deterministic", () => {
    const i = att({ novelty: 0.7, acceleration: 0.4 });
    expect(JSON.stringify(computeAttention(i))).toBe(
      JSON.stringify(computeAttention(i)),
    );
  });
});

describe("computeNovelty - rarity, distinct from anomaly", () => {
  it("a never-seen pattern is maximally novel (rarity 1)", () => {
    const n = computeNovelty("state=ATTACK|traj=ACCEL_UP", {});
    expect(n.rarity as number).toBe(1);
  });

  it("a frequently seen pattern has low novelty", () => {
    const memory: PatternMemory = { "state=DORMANT|traj=FLAT": 99 };
    const n = computeNovelty("state=DORMANT|traj=FLAT", memory);
    expect(n.rarity as number).toBeLessThan(0.02);
  });

  it("recording a pattern lowers its future novelty (immutably)", () => {
    const sig = "state=EMERGING|traj=RISING";
    const before = computeNovelty(sig, {});
    const mem2 = recordPattern(sig, {});
    const after = computeNovelty(sig, mem2);
    expect(after.rarity as number).toBeLessThan(before.rarity as number);
    // original memory not mutated
    expect(computeNovelty(sig, {}).rarity as number).toBe(1);
  });

  it("is deterministic", () => {
    const mem: PatternMemory = { x: 3 };
    expect(JSON.stringify(computeNovelty("x", mem))).toBe(
      JSON.stringify(computeNovelty("x", mem)),
    );
  });
});

describe("buildEvidence - opposing evidence is retained", () => {
  const at = (ms: number) => ms as UnixMillis;
  const supp: EvidenceInput[] = [
    { claim: "smart money inflow", weight: 0.8, provenance: "track.smartmoney", at: at(1) },
    { claim: "liquidity expanding", weight: 0.6, provenance: "market.trending", at: at(2) },
  ];
  const opp: EvidenceInput[] = [
    { claim: "sell pressure rising", weight: 0.5, provenance: "track.kol", at: at(3) },
  ];

  it("keeps both supporting and opposing evidence", () => {
    const e = buildEvidence("ACCUMULATION likely", supp, opp);
    expect(e.supporting.length).toBe(2);
    expect(e.opposing.length).toBe(1);
  });

  it("net support reflects the balance and stays in [-1,1]", () => {
    const e = buildEvidence("ACCUMULATION likely", supp, opp);
    expect(e.netSupport).toBeGreaterThan(0);
    expect(e.netSupport).toBeLessThanOrEqual(1);
  });

  it("all-opposing yields negative net support", () => {
    const e = buildEvidence("bullish", [], opp);
    expect(e.netSupport).toBeLessThan(0);
  });

  it("no evidence yields zero net support, not a fabricated lean", () => {
    const e = buildEvidence("unknown", [], []);
    expect(e.netSupport).toBe(0);
  });

  it("is order-independent (deterministic sort by claim)", () => {
    const a = buildEvidence("c", supp, opp);
    const b = buildEvidence("c", [...supp].reverse(), opp);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
