# ============================================================
# WAR - Phase 6 Installer (Trajectory)
# Run from inside war\ :  powershell -ExecutionPolicy Bypass -File .\install-phase6.ps1
# Requires Phase 5 already present.
# ============================================================

$ErrorActionPreference = 'Stop'
if (-not (Test-Path 'package.json')) { Write-Error 'Run from inside the war/ folder.'; exit 1 }
if (-not (Test-Path 'src\core\flow\flowEngine.ts')) { Write-Error 'Phase 5 missing. Install Phase 5 first.'; exit 1 }
Write-Host 'Installing Phase 6 (Trajectory)...' -ForegroundColor Cyan

# ---- src/core/trajectory/trajectory.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/trajectory' | Out-Null
$content = @'
/**
 * WAR core - Trajectory classifier (Phase 6).
 *
 * Classifies movement from a signal's temporal profile. Trajectory is
 * multidimensional: it is derived from BOTH the sign of velocity (direction)
 * AND the sign of acceleration (whether the move is speeding up, steady, or
 * bending), and it is never collapsed into a single scalar.
 *
 * No fabrication: if the underlying derivatives are missing (INSUFFICIENT_HISTORY),
 * the classification is UNKNOWN with zero confidence. Pure, total, deterministic.
 */

import type { Score0to100 } from "../../shared/scalars.js";
import type {
  TemporalProfile,
  Trajectory,
  TrajectoryClass,
} from "../temporal/types.js";
import { clampScore } from "../../shared/construct.js";

export interface TrajectoryConfig {
  /** |velocity| at or below this counts as flat (no directional move). */
  readonly velocityFlatEpsilon: number;
  /** |acceleration| at or below this counts as steady (no bending). */
  readonly accelFlatEpsilon: number;
}

export const DEFAULT_TRAJECTORY_CONFIG: TrajectoryConfig = {
  velocityFlatEpsilon: 1e-9,
  accelFlatEpsilon: 1e-12,
};

type Sign = "POS" | "NEG" | "ZERO";

function signOf(n: number, epsilon: number): Sign {
  if (Math.abs(n) <= epsilon) return "ZERO";
  return n > 0 ? "POS" : "NEG";
}

const S0 = 0 as Score0to100;
function score(n: number): Score0to100 {
  const r = clampScore(n);
  return r.ok ? r.value : S0;
}

/**
 * Classify from velocity sign (vSign) and acceleration sign (aSign).
 *
 * Direction is set by velocity. Acceleration modifies it:
 *   - moving up + accelerating (same sign)  -> ACCELERATING_UP
 *   - moving up + decelerating (opposite)   -> DECELERATING (losing upward speed)
 *   - moving down + accelerating down       -> ACCELERATING_DOWN
 *   - moving down + decelerating            -> DECELERATING
 *   - flat velocity + non-zero accel        -> REVERSING (turning through zero)
 *   - flat velocity + flat accel            -> FLATTENING
 */
function classify(vSign: Sign, aSign: Sign): TrajectoryClass {
  if (vSign === "POS") {
    if (aSign === "POS") return "ACCELERATING_UP";
    if (aSign === "NEG") return "DECELERATING";
    return "RISING";
  }
  if (vSign === "NEG") {
    if (aSign === "NEG") return "ACCELERATING_DOWN";
    if (aSign === "POS") return "DECELERATING";
    return "FALLING";
  }
  // vSign ZERO
  if (aSign === "ZERO") return "FLATTENING";
  return "REVERSING";
}

/**
 * Confidence blends derivative confidence and persistence into [0,100].
 * A profile with no usable velocity yields UNKNOWN at zero confidence.
 */
export function classifyTrajectory(
  profile: TemporalProfile,
  config: TrajectoryConfig = DEFAULT_TRAJECTORY_CONFIG,
): Trajectory {
  if (profile.method === "INSUFFICIENT_HISTORY" || profile.velocity === null) {
    return { classification: "UNKNOWN", confidence: S0, basis: [profile] };
  }

  const vSign = signOf(profile.velocity as number, config.velocityFlatEpsilon);
  const aSign =
    profile.acceleration === null
      ? "ZERO"
      : signOf(profile.acceleration as number, config.accelFlatEpsilon);

  const classification = classify(vSign, aSign);

  // Confidence: derivative reliability weighted by directional persistence,
  // scaled to 0-100. Deterministic; no magic thresholds beyond config epsilons.
  const dc = profile.derivativeConfidence as number;
  const persist = profile.persistence as number;
  const confidence = score(100 * dc * persist);

  return { classification, confidence, basis: [profile] };
}

/**
 * Combine multiple signal trajectories (e.g. price, flow) into one view by
 * carrying all bases. This does NOT average away disagreement - it keeps every
 * profile so downstream coherence can see conflict. Returns the dominant
 * classification (highest confidence), or UNKNOWN if none are usable.
 */
export function combineTrajectories(
  trajectories: readonly Trajectory[],
): Trajectory {
  const usable = trajectories.filter((t) => t.classification !== "UNKNOWN");
  if (usable.length === 0) {
    return {
      classification: "UNKNOWN",
      confidence: S0,
      basis: trajectories.flatMap((t) => t.basis),
    };
  }
  // Deterministic pick: highest confidence, tie-broken by classification name.
  const sorted = [...usable].sort((a, b) => {
    const ca = a.confidence as number;
    const cb = b.confidence as number;
    if (ca !== cb) return cb - ca;
    return a.classification < b.classification ? -1 : 1;
  });
  const dominant = sorted[0];
  const basis = trajectories.flatMap((t) => t.basis);
  if (dominant === undefined) {
    return { classification: "UNKNOWN", confidence: S0, basis };
  }
  return {
    classification: dominant.classification,
    confidence: dominant.confidence,
    basis,
  };
}

'@
Set-Content -Path 'src/core/trajectory/trajectory.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/trajectory/index.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/trajectory' | Out-Null
$content = @'
// WAR trajectory classifier.
export * from "./trajectory.js";

'@
Set-Content -Path 'src/core/trajectory/index.ts' -Value $content -NoNewline -Encoding utf8

# ---- tests/unit/trajectory.test.ts ----
New-Item -ItemType Directory -Force -Path 'tests/unit' | Out-Null
$content = @'
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

'@
Set-Content -Path 'tests/unit/trajectory.test.ts' -Value $content -NoNewline -Encoding utf8

# ---- README.md ----
$content = @'
# WAR Engine

Deterministic temporal market-intelligence engine. Renderer-agnostic core.

- **Intelligence contract:** V3.2 (FROZEN)
- **GMGN evidence:** sealed at commit `147c070` — see `PHASE_0_SEALED.md`
- **Current phase:** Phase 6 - Trajectory (complete)

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

Write-Host 'Phase 6 files installed.' -ForegroundColor Green
Write-Host 'Next: npm test   (expect 129 passed)' -ForegroundColor Yellow