import { describe, it, expect } from "vitest";

import { buildAttentionInputs, type AttentionSources } from "../../src/core/features/attentionInputs.js";
import { computeAttention } from "../../src/core/attention/attention.js";

function sources(over: Partial<AttentionSources>): AttentionSources {
  return {
    power: 60, acceleration: 0.5, accelerationRef: 1, noveltyRarity: 0.4,
    netCoherence: 0.8, confidence: 70,
    ...over,
  };
}

describe("4B-5.6 AttentionInputs builder", () => {
  it("magnitude = power/100", () => {
    expect(buildAttentionInputs(sources({ power: 52 })).magnitude).toBeCloseTo(0.52, 9);
  });

  it("acceleration = |accel|/ref, clamped; null accel -> 0", () => {
    expect(buildAttentionInputs(sources({ acceleration: 0.5, accelerationRef: 1 })).acceleration).toBe(0.5);
    expect(buildAttentionInputs(sources({ acceleration: -2, accelerationRef: 1 })).acceleration).toBe(1); // abs + clamp
    expect(buildAttentionInputs(sources({ acceleration: null })).acceleration).toBe(0);
  });

  it("novelty = rarity", () => {
    expect(buildAttentionInputs(sources({ noveltyRarity: 0.4 })).novelty).toBe(0.4);
  });

  it("signalConflict = 1 - netCoherence; null coherence -> 0 (no measurable conflict)", () => {
    expect(buildAttentionInputs(sources({ netCoherence: 0.7 })).signalConflict).toBeCloseTo(0.3, 9);
    expect(buildAttentionInputs(sources({ netCoherence: null })).signalConflict).toBe(0);
  });

  it("uncertainty = 1 - confidence/100", () => {
    expect(buildAttentionInputs(sources({ confidence: 70 })).uncertainty).toBeCloseTo(0.3, 9);
  });

  it("B1: stateTransition and trajectoryReversal are ALWAYS 0 in scan", () => {
    const inp = buildAttentionInputs(sources({}));
    expect(inp.stateTransition).toBe(0);
    expect(inp.trajectoryReversal).toBe(0);
  });

  it("causal ban: crossTokenImpact is ALWAYS 0", () => {
    expect(buildAttentionInputs(sources({ power: 100, confidence: 0 })).crossTokenImpact).toBe(0);
  });

  it("attention is independent of power (high attention with mid power possible)", () => {
    // low power, but high novelty + high uncertainty -> attention can still be high
    const inp = buildAttentionInputs(sources({ power: 30, noveltyRarity: 1, confidence: 0, netCoherence: 0 }));
    const att = computeAttention(inp);
    expect(att.score as number).toBeGreaterThan(30); // not tied to power=30
  });
});
