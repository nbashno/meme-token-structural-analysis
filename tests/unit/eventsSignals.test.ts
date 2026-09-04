import { describe, it, expect } from "vitest";
import { detectEvents } from "../../src/core/events/eventDetector.js";
import type { EngineSnapshot } from "../../src/core/events/eventDetector.js";
import {
  advanceSignal,
  isTerminalPhase,
} from "../../src/core/signal/signalLifecycle.js";
import type { SignalObservation } from "../../src/core/signal/signalLifecycle.js";
import type { Signal } from "../../src/core/state/types.js";
import type { UnixMillis } from "../../src/shared/scalars.js";

const T0 = 1_700_000_000_000 as UnixMillis;
const at = (ms: number) => (T0 + ms) as UnixMillis;

function snap(over: Partial<EngineSnapshot> = {}): EngineSnapshot {
  return {
    at: over.at ?? T0,
    power: over.power ?? 50,
    threat: over.threat ?? 10,
    netCoherence: over.netCoherence ?? 0.8,
    leadLagFlowLeads: over.leadLagFlowLeads ?? false,
    state: over.state ?? "ACCUMULATION",
  };
}

describe("detectEvents", () => {
  it("emits POWER_BREAKOUT on a large power jump", () => {
    const evs = detectEvents(snap({ power: 40 }), snap({ at: at(1000), power: 70 }));
    expect(evs.some((e) => e.type === "POWER_BREAKOUT")).toBe(true);
  });

  it("emits POWER_COLLAPSE on a large power drop", () => {
    const evs = detectEvents(snap({ power: 80 }), snap({ at: at(1000), power: 50 }));
    expect(evs.some((e) => e.type === "POWER_COLLAPSE")).toBe(true);
  });

  it("emits THREAT_SPIKE on a threat jump", () => {
    const evs = detectEvents(snap({ threat: 10 }), snap({ at: at(1000), threat: 40 }));
    expect(evs.some((e) => e.type === "THREAT_SPIKE")).toBe(true);
  });

  it("emits STATE_CHANGE when state differs", () => {
    const evs = detectEvents(
      snap({ state: "ACCUMULATION" }),
      snap({ at: at(1000), state: "ATTACK" }),
    );
    expect(evs.some((e) => e.type === "STATE_CHANGE")).toBe(true);
  });

  it("emits FLOW_DIVERGENCE when flow leads while power falls and threat rises", () => {
    const evs = detectEvents(
      snap({ power: 70, threat: 10 }),
      snap({ at: at(1000), power: 60, threat: 35, leadLagFlowLeads: true }),
    );
    expect(evs.some((e) => e.type === "FLOW_DIVERGENCE")).toBe(true);
  });

  it("emits nothing when nothing crosses a threshold", () => {
    const evs = detectEvents(snap(), snap({ at: at(1000) }));
    expect(evs.length).toBe(0);
  });

  it("severity and importance stay within [0,100]", () => {
    const evs = detectEvents(snap({ power: 0 }), snap({ at: at(1000), power: 100 }));
    for (const e of evs) {
      expect(e.severity as number).toBeGreaterThanOrEqual(0);
      expect(e.severity as number).toBeLessThanOrEqual(100);
      expect(e.importance as number).toBeLessThanOrEqual(100);
    }
  });

  it("is deterministic", () => {
    const b = snap({ power: 40 });
    const a = snap({ at: at(1000), power: 70 });
    expect(JSON.stringify(detectEvents(b, a))).toBe(
      JSON.stringify(detectEvents(b, a)),
    );
  });
});

const obs = (
  present: boolean,
  support: number,
  ms: number,
  reason = "cond",
): SignalObservation => ({
  identity: "sig-1",
  at: at(ms),
  present,
  support,
  reason,
});

describe("signal lifecycle - one identity evolves (no duplicate notifications)", () => {
  it("first sighting -> EMERGING", () => {
    const s = advanceSignal(null, obs(true, 0.5, 0));
    expect(s.phase).toBe("EMERGING");
    expect(s.identity).toBe("sig-1");
  });

  it("strong support promotes EMERGING -> CONFIRMED", () => {
    const s1 = advanceSignal(null, obs(true, 0.5, 0));
    const s2 = advanceSignal(s1, obs(true, 0.9, 1000));
    expect(s2.phase).toBe("CONFIRMED");
    // identity preserved across updates - not a new signal
    expect(s2.identity).toBe(s1.identity);
    expect(s2.firstObservedAt).toBe(s1.firstObservedAt);
  });

  it("a continuing condition does NOT create new signals - it updates in place", () => {
    let s: Signal = advanceSignal(null, obs(true, 0.9, 0));
    const firstSeen = s.firstObservedAt;
    for (let k = 1; k <= 5; k++) s = advanceSignal(s, obs(true, 0.9, k * 1000));
    expect(s.phase).toBe("CONFIRMED");
    expect(s.firstObservedAt).toBe(firstSeen); // same signal throughout
  });

  it("CONFIRMED -> WEAKENING when condition disappears", () => {
    const s0 = advanceSignal(null, obs(true, 0.9, 0)); // EMERGING
    const s1 = advanceSignal(s0, obs(true, 0.9, 1000)); // CONFIRMED
    expect(s1.phase).toBe("CONFIRMED");
    const s2 = advanceSignal(s1, obs(false, 0, 2000));
    expect(s2.phase).toBe("WEAKENING");
  });

  it("WEAKENING -> EXPIRED after expiry window of absence", () => {
    const s0 = advanceSignal(null, obs(true, 0.9, 0)); // EMERGING
    const s1 = advanceSignal(s0, obs(true, 0.9, 1000)); // CONFIRMED
    const s2 = advanceSignal(s1, obs(false, 0, 2000)); // WEAKENING
    const s3 = advanceSignal(s2, obs(false, 0, 2000 + 300_001)); // expired
    expect(s3.phase).toBe("EXPIRED");
    expect(isTerminalPhase(s3.phase)).toBe(true);
  });

  it("never-confirmed condition that vanishes -> INVALIDATED", () => {
    const s1 = advanceSignal(null, obs(true, 0.3, 0)); // EMERGING
    const s2 = advanceSignal(s1, obs(false, 0, 1000));
    expect(s2.phase).toBe("INVALIDATED");
  });

  it("terminal signals stay terminal", () => {
    const s1 = advanceSignal(null, obs(true, 0.3, 0));
    const s2 = advanceSignal(s1, obs(false, 0, 1000)); // INVALIDATED
    const s3 = advanceSignal(s2, obs(true, 0.9, 2000));
    expect(s3.phase).toBe("INVALIDATED");
  });

  it("is deterministic", () => {
    const s1 = advanceSignal(null, obs(true, 0.9, 0));
    const a = advanceSignal(s1, obs(true, 0.9, 1000));
    const b = advanceSignal(s1, obs(true, 0.9, 1000));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
