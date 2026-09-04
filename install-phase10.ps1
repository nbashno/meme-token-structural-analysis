# ============================================================
# WAR - Phase 10 Installer (Events + Signal Lifecycle)
# Run from inside war\ :  powershell -ExecutionPolicy Bypass -File .\install-phase10.ps1
# Requires Phase 9 already present.
# ============================================================

$ErrorActionPreference = 'Stop'
if (-not (Test-Path 'package.json')) { Write-Error 'Run from inside the war/ folder.'; exit 1 }
if (-not (Test-Path 'src\core\state\stateMachine.ts')) { Write-Error 'Phase 9 missing. Install Phase 9 first.'; exit 1 }
Write-Host 'Installing Phase 10 (Events + Signal Lifecycle)...' -ForegroundColor Cyan

# ---- src/core/events/eventDetector.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/events' | Out-Null
$content = @'
/**
 * WAR core - Event Detector (Phase 10).
 *
 * Produces SEMANTIC market events by comparing two engine snapshots (before ->
 * after). Events are facts, not animations. Each carries severity, importance,
 * reasons, and the before/after states. Config-driven thresholds; no magic
 * numbers. Pure, total, deterministic.
 */

import type { Score0to100, UnixMillis } from "../../shared/scalars.js";
import type { MarketEvent, EventType, MarketState } from "../state/types.js";
import { clampScore } from "../../shared/construct.js";

const S0 = 0 as Score0to100;
function score(n: number): Score0to100 {
  const r = clampScore(n);
  return r.ok ? r.value : S0;
}

/** The comparable slice of engine output at one instant. */
export interface EngineSnapshot {
  readonly at: UnixMillis;
  readonly power: number; // 0..100
  readonly threat: number; // 0..100
  readonly netCoherence: number; // 0..1
  readonly leadLagFlowLeads: boolean;
  readonly state: MarketState;
}

export interface EventConfig {
  readonly version: string;
  /** Power jump (absolute points) to flag a breakout/collapse. */
  readonly powerBreakoutDelta: number;
  /** Threat jump to flag a spike. */
  readonly threatSpikeDelta: number;
  /** netCoherence drop to flag conflict emergence. */
  readonly coherenceConflictDrop: number;
}

export const EVENT_CONFIG: EventConfig = {
  version: "event-v1",
  powerBreakoutDelta: 15,
  threatSpikeDelta: 20,
  coherenceConflictDrop: 0.3,
};

function ev(
  type: EventType,
  at: UnixMillis,
  severity: number,
  importance: number,
  reasons: readonly string[],
  before: MarketState,
  after: MarketState,
): MarketEvent {
  return {
    type,
    at,
    severity: score(severity),
    importance: score(importance),
    reasons,
    beforeState: before,
    afterState: after,
  };
}

/**
 * Detect events between two snapshots. Deterministic emission order (fixed
 * checks in fixed order). Returns [] when nothing crosses a threshold.
 */
export function detectEvents(
  before: EngineSnapshot,
  after: EngineSnapshot,
  config: EventConfig = EVENT_CONFIG,
): readonly MarketEvent[] {
  const out: MarketEvent[] = [];
  const at = after.at;

  const powerDelta = after.power - before.power;
  const threatDelta = after.threat - before.threat;
  const coherenceDrop = before.netCoherence - after.netCoherence;

  // Power breakout / collapse
  if (powerDelta >= config.powerBreakoutDelta) {
    out.push(
      ev("POWER_BREAKOUT", at, powerDelta, after.power,
        [`power +${powerDelta.toFixed(1)}`], before.state, after.state),
    );
  } else if (-powerDelta >= config.powerBreakoutDelta) {
    out.push(
      ev("POWER_COLLAPSE", at, -powerDelta, before.power,
        [`power ${powerDelta.toFixed(1)}`], before.state, after.state),
    );
  }

  // Threat spike
  if (threatDelta >= config.threatSpikeDelta) {
    out.push(
      ev("THREAT_SPIKE", at, threatDelta, after.threat,
        [`threat +${threatDelta.toFixed(1)}`], before.state, after.state),
    );
  }

  // Coherence conflict emerging
  if (coherenceDrop >= config.coherenceConflictDrop) {
    out.push(
      ev("SIGNAL_CONFLICT", at, coherenceDrop * 100, coherenceDrop * 100,
        [`coherence -${coherenceDrop.toFixed(2)}`], before.state, after.state),
    );
  }

  // Flow divergence: flow leads but power/price direction diverges from threat rising
  if (after.leadLagFlowLeads && threatDelta > 0 && powerDelta < 0) {
    out.push(
      ev("FLOW_DIVERGENCE", at, Math.abs(powerDelta) + threatDelta, 70,
        ["flow leads while power falls and threat rises"], before.state, after.state),
    );
  }

  // State change
  if (before.state !== after.state) {
    out.push(
      ev("STATE_CHANGE", at, 50, 60,
        [`state ${before.state} -> ${after.state}`], before.state, after.state),
    );
  }

  return out;
}

'@
Set-Content -Path 'src/core/events/eventDetector.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/events/index.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/events' | Out-Null
$content = @'
// WAR event detector.
export * from "./eventDetector.js";

'@
Set-Content -Path 'src/core/events/index.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/signal/signalLifecycle.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/signal' | Out-Null
$content = @'
/**
 * WAR core - Signal Lifecycle (Phase 10).
 *
 * A persistent condition is ONE signal that evolves, not a stream of duplicate
 * notifications. Given a stable SignalIdentity, the manager advances its phase:
 *
 *   EMERGING -> CONFIRMING -> CONFIRMED -> WEAKENING -> INVALIDATED / EXPIRED
 *
 * The same continuing condition updates the existing signal instead of creating
 * a new one. Time is injected. Pure, total, deterministic.
 */

import type { UnixMillis } from "../../shared/scalars.js";
import type { Signal, SignalPhase, SignalIdentity } from "../state/types.js";

/** Observation about a signal at one instant: is its condition currently present? */
export interface SignalObservation {
  readonly identity: SignalIdentity;
  readonly at: UnixMillis;
  /** True if the underlying condition is currently supported by evidence. */
  readonly present: boolean;
  /** Strength of support in [0,1]; drives CONFIRMING -> CONFIRMED. */
  readonly support: number;
  readonly reason: string;
}

export interface SignalConfig {
  readonly version: string;
  /** Support at/above this promotes CONFIRMING -> CONFIRMED. */
  readonly confirmSupport: number;
  /** Time (ms) absent before a WEAKENING signal becomes EXPIRED. */
  readonly expiryMs: number;
}

export const SIGNAL_CONFIG: SignalConfig = {
  version: "signal-v1",
  confirmSupport: 0.7,
  expiryMs: 300_000, // 5 min
};

/**
 * Advance one signal given the prior signal (or null for first sighting) and a
 * new observation. Returns the updated signal. Never creates a duplicate: the
 * identity is preserved and the phase transitions in place.
 */
export function advanceSignal(
  prior: Signal | null,
  obs: SignalObservation,
  config: SignalConfig = SIGNAL_CONFIG,
): Signal {
  // First sighting.
  if (prior === null) {
    return {
      identity: obs.identity,
      phase: obs.present ? "EMERGING" : "EXPIRED",
      firstObservedAt: obs.at,
      lastUpdatedAt: obs.at,
      reasons: [obs.reason],
    };
  }

  const nextPhase = nextSignalPhase(prior.phase, obs, prior, config);

  return {
    identity: prior.identity,
    phase: nextPhase,
    firstObservedAt: prior.firstObservedAt,
    lastUpdatedAt: obs.at,
    // Keep a bounded, deterministic reason trail (latest last).
    reasons: [...prior.reasons, obs.reason].slice(-8),
  };
}

function nextSignalPhase(
  current: SignalPhase,
  obs: SignalObservation,
  prior: Signal,
  config: SignalConfig,
): SignalPhase {
  const confirmed = obs.support >= config.confirmSupport;

  if (obs.present) {
    switch (current) {
      case "EMERGING":
        return confirmed ? "CONFIRMED" : "CONFIRMING";
      case "CONFIRMING":
        return confirmed ? "CONFIRMED" : "CONFIRMING";
      case "CONFIRMED":
        return "CONFIRMED";
      case "WEAKENING":
        // condition returned -> re-confirm
        return confirmed ? "CONFIRMED" : "CONFIRMING";
      case "INVALIDATED":
      case "EXPIRED":
        // a terminal signal stays terminal; a genuinely new occurrence should
        // arrive under a fresh identity, not resurrect this one.
        return current;
      default:
        return current;
    }
  }

  // condition absent this observation
  switch (current) {
    case "EMERGING":
    case "CONFIRMING":
      return "INVALIDATED"; // never confirmed, condition gone
    case "CONFIRMED":
      return "WEAKENING";
    case "WEAKENING": {
      const absentFor = (obs.at as number) - (prior.lastUpdatedAt as number);
      return absentFor >= config.expiryMs ? "EXPIRED" : "WEAKENING";
    }
    case "INVALIDATED":
    case "EXPIRED":
      return current;
    default:
      return current;
  }
}

/** Terminal phases: a signal here will not evolve further. */
export function isTerminalPhase(phase: SignalPhase): boolean {
  return phase === "INVALIDATED" || phase === "EXPIRED";
}

'@
Set-Content -Path 'src/core/signal/signalLifecycle.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/signal/index.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/signal' | Out-Null
$content = @'
// WAR signal lifecycle.
export * from "./signalLifecycle.js";

'@
Set-Content -Path 'src/core/signal/index.ts' -Value $content -NoNewline -Encoding utf8

# ---- tests/unit/eventsSignals.test.ts ----
New-Item -ItemType Directory -Force -Path 'tests/unit' | Out-Null
$content = @'
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

'@
Set-Content -Path 'tests/unit/eventsSignals.test.ts' -Value $content -NoNewline -Encoding utf8

# ---- README.md ----
$content = @'
# WAR Engine

Deterministic temporal market-intelligence engine. Renderer-agnostic core.

- **Intelligence contract:** V3.2 (FROZEN)
- **GMGN evidence:** sealed at commit `147c070` — see `PHASE_0_SEALED.md`
- **Current phase:** Phase 10 - Events + Signal Lifecycle (complete)

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

Write-Host 'Phase 10 files installed.' -ForegroundColor Green
Write-Host 'Next: npm test   (expect 195 passed)' -ForegroundColor Yellow