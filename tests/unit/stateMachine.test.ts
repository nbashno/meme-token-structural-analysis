import { describe, it, expect } from "vitest";
import {
  stepStateMachine,
  initialStateContext,
} from "../../src/core/state/stateMachine.js";
import type {
  StateInputs,
  StateContext,
} from "../../src/core/state/stateMachine.js";
import type { UnixMillis } from "../../src/shared/scalars.js";
import type { TrajectoryClass } from "../../src/core/temporal/types.js";

const T0 = 1_700_000_000_000 as UnixMillis;
const later = (base: number, addMs: number) => (base + addMs) as UnixMillis;

function inputs(
  now: UnixMillis,
  over: Partial<Omit<StateInputs, "now">> = {},
): StateInputs {
  return {
    now,
    power: over.power ?? 0,
    threat: over.threat ?? 0,
    confidence: over.confidence ?? 50,
    netCoherence: over.netCoherence ?? 0.9,
    persistence: over.persistence ?? 0.9,
    trajectory: over.trajectory ?? ("RISING" as TrajectoryClass),
  };
}

describe("stepStateMachine - no single-condition jumps", () => {
  it("high power ALONE does not jump to ATTACK without coherence/persistence", () => {
    const ctx: StateContext = { state: "ACCUMULATION", enteredAt: T0 };
    const dec = stepStateMachine(
      ctx,
      inputs(later(T0, 120_000), {
        power: 90,
        netCoherence: 0.1, // incoherent
        persistence: 0.1, // not persistent
        trajectory: "RISING",
      }),
    );
    expect(dec.context.state).not.toBe("ATTACK");
  });

  it("ATTACK requires power + coherence + persistence + confidence + up trajectory together", () => {
    const ctx: StateContext = { state: "ACCUMULATION", enteredAt: T0 };
    const dec = stepStateMachine(
      ctx,
      inputs(later(T0, 120_000), {
        power: 70,
        netCoherence: 0.9,
        persistence: 0.9,
        confidence: 60,
        trajectory: "ACCELERATING_UP",
      }),
    );
    expect(dec.context.state).toBe("ATTACK");
    expect(dec.transition?.reasons.length).toBeGreaterThanOrEqual(4);
  });
});

describe("stepStateMachine - minimum dwell", () => {
  it("does not transition to a non-danger state before minDwell elapses", () => {
    const ctx: StateContext = { state: "ACCUMULATION", enteredAt: T0 };
    const dec = stepStateMachine(
      ctx,
      inputs(later(T0, 1000), {
        power: 90,
        netCoherence: 0.9,
        persistence: 0.9,
        confidence: 80,
        trajectory: "ACCELERATING_UP",
      }),
    );
    // only 1s elapsed, minDwell is 60s -> hold
    expect(dec.context.state).toBe("ACCUMULATION");
    expect(dec.transition).toBeNull();
  });

  it("allows transition once dwell is satisfied", () => {
    const ctx: StateContext = { state: "ACCUMULATION", enteredAt: T0 };
    const dec = stepStateMachine(
      ctx,
      inputs(later(T0, 61_000), {
        power: 85,
        netCoherence: 0.9,
        persistence: 0.9,
        confidence: 80,
        trajectory: "ACCELERATING_UP",
      }),
    );
    expect(dec.transition).not.toBeNull();
  });
});

describe("stepStateMachine - danger overrides dwell", () => {
  it("COLLAPSE can fire even before minDwell (a collapsing token is not held)", () => {
    const ctx: StateContext = { state: "DOMINANCE", enteredAt: T0 };
    const dec = stepStateMachine(
      ctx,
      inputs(later(T0, 1000), {
        power: 20,
        threat: 90,
        persistence: 0.9,
        trajectory: "ACCELERATING_DOWN",
      }),
    );
    expect(dec.context.state).toBe("COLLAPSE");
    expect(dec.transition?.hysteresisSatisfied).toBe(false); // dwell not met, but danger
  });

  it("high threat is not masked by strength (danger checked first)", () => {
    const ctx: StateContext = { state: "ATTACK", enteredAt: T0 };
    const dec = stepStateMachine(
      ctx,
      inputs(later(T0, 120_000), {
        power: 85,
        threat: 90,
        persistence: 0.9,
        trajectory: "ACCELERATING_DOWN",
      }),
    );
    expect(["COLLAPSE", "BLEEDING"]).toContain(dec.context.state);
  });
});

describe("stepStateMachine - determinism + reasons", () => {
  it("every transition records reasons", () => {
    const ctx = initialStateContext(T0);
    const dec = stepStateMachine(
      ctx,
      inputs(later(T0, 61_000), { power: 40, confidence: 60 }),
    );
    if (dec.transition) {
      expect(dec.transition.reasons.length).toBeGreaterThan(0);
    }
  });

  it("is deterministic", () => {
    const ctx: StateContext = { state: "EMERGING", enteredAt: T0 };
    const inp = inputs(later(T0, 120_000), { power: 70, confidence: 70 });
    const a = stepStateMachine(ctx, inp);
    const b = stepStateMachine(ctx, inp);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("holds state when no transition condition is met", () => {
    const ctx: StateContext = { state: "OBSERVING", enteredAt: T0 };
    const dec = stepStateMachine(
      ctx,
      inputs(later(T0, 120_000), { power: 5, confidence: 10 }),
    );
    expect(dec.context.state).toBe("OBSERVING");
  });
});
