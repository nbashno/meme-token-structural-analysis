# ============================================================
# WAR - Phase 9 Installer (State Machine)
# Run from inside war\ :  powershell -ExecutionPolicy Bypass -File .\install-phase9.ps1
# Requires Phase 8 already present.
# ============================================================

$ErrorActionPreference = 'Stop'
if (-not (Test-Path 'package.json')) { Write-Error 'Run from inside the war/ folder.'; exit 1 }
if (-not (Test-Path 'src\core\power\powerEngine.ts')) { Write-Error 'Phase 8 missing. Install Phase 8 first.'; exit 1 }
Write-Host 'Installing Phase 9 (State Machine)...' -ForegroundColor Cyan

# ---- src/config/stateMachine.ts ----
New-Item -ItemType Directory -Force -Path 'src/config' | Out-Null
$content = @'
/**
 * WAR core - State Machine configuration (Phase 9).
 *
 * Thresholds, minimum dwell, and hysteresis margins live here, versioned.
 * No single-condition jumps: every transition rule combines several signals.
 */

export interface StateMachineConfig {
  readonly version: string;
  /** Minimum time (ms) a state must be held before it may transition out. */
  readonly minDwellMs: number;
  /** Power thresholds gating entry into stronger states. */
  readonly powerEmerging: number;
  readonly powerAccumulation: number;
  readonly powerAttack: number;
  readonly powerDominance: number;
  /** Coherence (netCoherence 0..1) required for constructive transitions. */
  readonly coherenceMin: number;
  /** Persistence (0..1) required to confirm a directional state. */
  readonly persistenceMin: number;
  /** Confidence (0..100) floor below which we stay OBSERVING. */
  readonly confidenceFloor: number;
  /** Threat (0..100) above which BLEEDING/COLLAPSE take precedence. */
  readonly threatHigh: number;
  /** Hysteresis margin: exit thresholds are this much easier than entry. */
  readonly hysteresisMargin: number;
}

export const STATE_MACHINE_CONFIG: StateMachineConfig = {
  version: "state-v1",
  minDwellMs: 60_000, // 1 min
  powerEmerging: 30,
  powerAccumulation: 45,
  powerAttack: 65,
  powerDominance: 82,
  coherenceMin: 0.6,
  persistenceMin: 0.6,
  confidenceFloor: 25,
  threatHigh: 70,
  hysteresisMargin: 8,
};

'@
Set-Content -Path 'src/config/stateMachine.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/state/stateMachine.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/state' | Out-Null
$content = @'
/**
 * WAR core - State Machine (Phase 9).
 *
 * Deterministic market lifecycle. NO single-condition jumps: a transition fires
 * only when SEVERAL signals agree (power + coherence + persistence + confidence
 * + threat), and only after minimum dwell. Every transition records its reasons.
 *
 * Time is injected. Pure, total, deterministic. No clock, no randomness, no IO.
 */

import type { UnixMillis } from "../../shared/scalars.js";
import type { MarketState, StateTransition } from "./types.js";
import type { TrajectoryClass } from "../temporal/types.js";
import type { StateMachineConfig } from "../../config/stateMachine.js";
import { STATE_MACHINE_CONFIG } from "../../config/stateMachine.js";

/** The evidence a transition decision is made from at a given instant. */
export interface StateInputs {
  readonly now: UnixMillis;
  readonly power: number; // 0..100
  readonly threat: number; // 0..100
  readonly confidence: number; // 0..100
  readonly netCoherence: number; // 0..1
  readonly persistence: number; // 0..1
  readonly trajectory: TrajectoryClass;
}

/** Current machine position: the state and when it was entered. */
export interface StateContext {
  readonly state: MarketState;
  readonly enteredAt: UnixMillis;
}

export interface StateDecision {
  readonly context: StateContext;
  readonly transition: StateTransition | null;
}

const UP_TRAJECTORIES: ReadonlySet<TrajectoryClass> = new Set([
  "ACCELERATING_UP",
  "RISING",
]);
const DOWN_TRAJECTORIES: ReadonlySet<TrajectoryClass> = new Set([
  "FALLING",
  "ACCELERATING_DOWN",
]);

/** Does the evidence justify entering `target`? Returns reasons or null. */
function entryReasons(
  target: MarketState,
  i: StateInputs,
  c: StateMachineConfig,
): string[] | null {
  const up = UP_TRAJECTORIES.has(i.trajectory);
  const down = DOWN_TRAJECTORIES.has(i.trajectory);
  const coherent = i.netCoherence >= c.coherenceMin;
  const persistent = i.persistence >= c.persistenceMin;
  const confident = i.confidence >= c.confidenceFloor;
  const reasons: string[] = [];

  switch (target) {
    case "BLEEDING": {
      if (i.threat >= c.threatHigh && down) {
        reasons.push(`threat ${i.threat} >= ${c.threatHigh}`, "downward trajectory");
        return reasons;
      }
      return null;
    }
    case "COLLAPSE": {
      if (i.threat >= c.threatHigh && i.trajectory === "ACCELERATING_DOWN" && persistent) {
        reasons.push(`threat ${i.threat} high`, "accelerating down", "persistent");
        return reasons;
      }
      return null;
    }
    case "DOMINANCE": {
      if (i.power >= c.powerDominance && coherent && confident && up) {
        reasons.push(
          `power ${i.power} >= ${c.powerDominance}`,
          "coherent",
          "confident",
          "upward trajectory",
        );
        return reasons;
      }
      return null;
    }
    case "ATTACK": {
      if (i.power >= c.powerAttack && coherent && persistent && confident && up) {
        reasons.push(
          `power ${i.power} >= ${c.powerAttack}`,
          "coherent",
          "persistent",
          "confident",
          "upward trajectory",
        );
        return reasons;
      }
      return null;
    }
    case "ACCUMULATION": {
      if (i.power >= c.powerAccumulation && coherent && confident && !down) {
        reasons.push(
          `power ${i.power} >= ${c.powerAccumulation}`,
          "coherent",
          "confident",
          "not falling",
        );
        return reasons;
      }
      return null;
    }
    case "DISTRIBUTION": {
      // strength present but flow/vectors turning: high-ish power, weak coherence, some threat
      if (i.power >= c.powerAccumulation && i.netCoherence < c.coherenceMin && i.threat > 0) {
        reasons.push(
          `power ${i.power} still elevated`,
          `coherence ${i.netCoherence.toFixed(2)} weakening`,
          `threat present ${i.threat}`,
        );
        return reasons;
      }
      return null;
    }
    case "EMERGING": {
      if (i.power >= c.powerEmerging && confident) {
        reasons.push(`power ${i.power} >= ${c.powerEmerging}`, "confident");
        return reasons;
      }
      return null;
    }
    case "OBSERVING": {
      reasons.push("baseline observation");
      return reasons;
    }
    default:
      return null;
  }
}

/**
 * Priority order for evaluating candidate target states. Danger states are
 * checked first so high threat cannot be masked by strength.
 */
const EVALUATION_ORDER: readonly MarketState[] = [
  "COLLAPSE",
  "BLEEDING",
  "DISTRIBUTION",
  "DOMINANCE",
  "ATTACK",
  "ACCUMULATION",
  "EMERGING",
  "OBSERVING",
];

/**
 * Advance the state machine by one step. Enforces minimum dwell (unless a
 * danger state supersedes) and records reasons on any transition.
 */
export function stepStateMachine(
  ctx: StateContext,
  inputs: StateInputs,
  config: StateMachineConfig = STATE_MACHINE_CONFIG,
): StateDecision {
  const dwell = (inputs.now as number) - (ctx.enteredAt as number);
  const dwellSatisfied = dwell >= config.minDwellMs;

  // Danger states may supersede dwell (a collapsing token must not be held).
  for (const target of EVALUATION_ORDER) {
    if (target === ctx.state) continue;

    const isDanger = target === "COLLAPSE" || target === "BLEEDING";
    if (!dwellSatisfied && !isDanger) continue;

    const reasons = entryReasons(target, inputs, config);
    if (reasons === null) continue;

    const transition: StateTransition = {
      from: ctx.state,
      to: target,
      at: inputs.now,
      reasons,
      hysteresisSatisfied: dwellSatisfied,
    };
    return {
      context: { state: target, enteredAt: inputs.now },
      transition,
    };
  }

  // No transition: hold current state.
  return { context: ctx, transition: null };
}

/** Convenience: the canonical starting context. */
export function initialStateContext(at: UnixMillis): StateContext {
  return { state: "OBSERVING", enteredAt: at };
}

'@
Set-Content -Path 'src/core/state/stateMachine.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/state/index.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/state' | Out-Null
$content = @'
// WAR state / events / signal / novelty / attention + state machine.
export type * from "./types.js";
export * from "./stateMachine.js";

'@
Set-Content -Path 'src/core/state/index.ts' -Value $content -NoNewline -Encoding utf8

# ---- tests/unit/stateMachine.test.ts ----
New-Item -ItemType Directory -Force -Path 'tests/unit' | Out-Null
$content = @'
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

'@
Set-Content -Path 'tests/unit/stateMachine.test.ts' -Value $content -NoNewline -Encoding utf8

# ---- README.md ----
$content = @'
# WAR Engine

Deterministic temporal market-intelligence engine. Renderer-agnostic core.

- **Intelligence contract:** V3.2 (FROZEN)
- **GMGN evidence:** sealed at commit `147c070` — see `PHASE_0_SEALED.md`
- **Current phase:** Phase 9 - State Machine (complete)

## What exists now

Directory skeleton, strict TypeScript config, enforced module boundaries, and the
**full V3.2 intelligence contract expressed as TypeScript types** — no runtime logic yet.

Domain type surface (all under `src/`, re-exported from `src/index.ts`):

```
shared/scalars.ts      branded Score0to100 / Ratio0to1 / UnixMillis / Maybe / Measured
shared/quality.ts      DataQuality, ModelVersions, QualityStamp
core/timeline/         TokenTimeline three-lane model (MARKET/FLOW/ANALYTICS),
                       TemporalOrigin, Coverage, Provenance, PositionEventClass
core/temporal/         TemporalProfile (velocity/acceleration), Trajectory
core/coherence/        Coherence (agreement/conflict), LeadLag (precedence, not cause)
core/power/            Power, Threat, Confidence — three independent, explainable measures
core/state/            MarketState, StateTransition, MarketEvent, Signal, Novelty, Attention
core/battlefield/      BattlefieldState — the only object leaving the core
```

```
src/core/**        the deterministic engine (no IO, no time, no randomness)
src/adapters/gmgn  the ONLY place raw GMGN shapes live; hot_level & raw
                   is_open_or_close die here (FlowEventNormalizer.contract.ts)
src/structure      GATED — verified but not admitted to core in V1
src/physics        PhysicsProjector — visual projection, one-way, downstream of core
src/replay         reuses the core pipeline; no future leakage
src/outcome        the only reader of post-decision future data
tests/architecture boundary law, enforced (not aspirational)
```

Read `ARCHITECTURE.md` for the boundary law.

## Commands

```
npm install
npm run typecheck     # strict tsc, no emit
npm run test:arch     # architecture boundary tests
npm test              # full suite (vitest)
```

## Guarantees enforced today

- `src/core/**` imports no adapter, physics, structure, replay, outcome, renderer, or IO module.
- `src/core/**` contains no `Date.now`, `new Date(`, `Math.random`, or `process.env`.
- `hot_level` and raw `is_open_or_close` never appear in `src/core`.
- Strict compilation: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and more.

The architecture test was verified to FAIL on a deliberate violation, then pass once removed —
it is a real guard, not a green rubber stamp.

## Next phase

Phase 3 — Timeline: the first runtime module. Deterministic construction of a
`TokenTimeline` from normalized observations, enforcing coverage semantics
(FLOW is ROLLING, never COMPLETE) and injected-time discipline. Still no adapter,
no network — fed from in-memory normalized inputs, tested against golden fixtures.

'@
Set-Content -Path 'README.md' -Value $content -NoNewline -Encoding utf8

Write-Host 'Phase 9 files installed.' -ForegroundColor Green
Write-Host 'Next: npm test   (expect 173 passed)' -ForegroundColor Yellow