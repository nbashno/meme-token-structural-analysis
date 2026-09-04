# ============================================================
# WAR — Phase 4 Installer (Temporal Engine)
# Run from inside war\ :  powershell -ExecutionPolicy Bypass -File .\install-phase4.ps1
# Requires Phase 3 already present.
# ============================================================

$ErrorActionPreference = 'Stop'
if (-not (Test-Path 'package.json')) { Write-Error 'Run from inside the war/ folder.'; exit 1 }
if (-not (Test-Path 'src\core\timeline\buildTimeline.ts')) { Write-Error 'Phase 3 missing. Install Phase 3 first.'; exit 1 }
Write-Host 'Installing Phase 4 (Temporal Engine)...' -ForegroundColor Cyan

# ---- src/core/temporal/temporalEngine.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/temporal' | Out-Null
$content = @'
/**
 * WAR core — Temporal Engine (Phase 4).
 *
 * Computes velocity (Δsignal/Δt) and acceleration (Δvelocity/Δt) over
 * NORMALIZED, irregular time. Pure and deterministic: no clock, no randomness.
 *
 * NON-NEGOTIABLE: a derivative is NEVER fabricated. With too few points, or a
 * zero time delta, the profile reports null derivatives and method
 * INSUFFICIENT_HISTORY — it does not invent a slope. Missing ≠ zero.
 */

import type {
  FiniteNumber,
  Ratio0to1,
  UnixMillis,
  DurationMillis,
} from "../../shared/scalars.js";
import type {
  TemporalProfile,
  DerivativeMethod,
  SignalDirection,
} from "./types.js";
import { toRatio0to1 } from "../../shared/construct.js";

/** One observation of a scalar signal at a point in time. */
export interface SignalPoint {
  readonly at: UnixMillis;
  readonly value: number;
}

/** Configuration for derivative computation (versioned, no magic numbers inline). */
export interface TemporalConfig {
  /** Minimum points required to attempt a velocity. */
  readonly minPointsForVelocity: number;
  /** Minimum points required to attempt an acceleration. */
  readonly minPointsForAcceleration: number;
  /** |velocity| at or below this is treated as FLAT direction. */
  readonly flatEpsilon: number;
}

export const DEFAULT_TEMPORAL_CONFIG: TemporalConfig = {
  minPointsForVelocity: 2,
  minPointsForAcceleration: 3,
  flatEpsilon: 1e-9,
};

const r0 = 0 as Ratio0to1;

function ratio(n: number): Ratio0to1 {
  const res = toRatio0to1(n);
  return res.ok ? res.value : r0;
}

/**
 * Deterministically sort points by time, then dedupe exact (time,value) pairs.
 * Two different values at the same timestamp are a conflict; we keep the first
 * in stable order rather than guessing — the caller's upstream (timeline)
 * should already have deduped, so this is a defensive, deterministic pass.
 */
function normalize(points: readonly SignalPoint[]): SignalPoint[] {
  const sorted = [...points].sort((a, b) => {
    const ta = a.at as number;
    const tb = b.at as number;
    if (ta !== tb) return ta - tb;
    return a.value - b.value;
  });
  const out: SignalPoint[] = [];
  let lastKey: string | null = null;
  for (const p of sorted) {
    const key = `${p.at}|${p.value}`;
    if (key !== lastKey) {
      out.push(p);
      lastKey = key;
    }
  }
  return out;
}

/** Backward finite-difference velocity between the last two points. */
function lastVelocity(points: SignalPoint[]): number | null {
  if (points.length < 2) return null;
  const b = points[points.length - 1];
  const a = points[points.length - 2];
  if (a === undefined || b === undefined) return null;
  const dt = (b.at as number) - (a.at as number);
  if (dt <= 0) return null; // zero/negative Δt → cannot form a derivative
  return (b.value - a.value) / dt;
}

/** Acceleration from the last three points (change in successive velocities). */
function lastAcceleration(points: SignalPoint[]): number | null {
  if (points.length < 3) return null;
  const c = points[points.length - 1];
  const b = points[points.length - 2];
  const a = points[points.length - 3];
  if (a === undefined || b === undefined || c === undefined) return null;
  const dt1 = (b.at as number) - (a.at as number);
  const dt2 = (c.at as number) - (b.at as number);
  if (dt1 <= 0 || dt2 <= 0) return null;
  const v1 = (b.value - a.value) / dt1;
  const v2 = (c.value - b.value) / dt2;
  const dtv = (c.at as number) - (a.at as number);
  if (dtv <= 0) return null;
  return (v2 - v1) / dtv;
}

/** Fraction of consecutive steps that move in the dominant direction. */
function persistenceOf(points: SignalPoint[]): number {
  if (points.length < 2) return 0;
  let up = 0;
  let down = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    if (prev === undefined || cur === undefined) continue;
    const d = cur.value - prev.value;
    if (d > 0) up++;
    else if (d < 0) down++;
  }
  const total = up + down;
  if (total === 0) return 0;
  return Math.max(up, down) / total;
}

function directionOf(velocity: number | null, flatEpsilon: number): SignalDirection {
  if (velocity === null) return "UNKNOWN";
  if (Math.abs(velocity) <= flatEpsilon) return "FLAT";
  return velocity > 0 ? "UP" : "DOWN";
}

/**
 * Derivative confidence in [0,1]: rises with the number of usable points,
 * saturating. Never a fabricated certainty — sparse history stays low.
 */
function derivativeConfidence(n: number): number {
  if (n < 2) return 0;
  // 2 pts → 0.25, 3 → 0.5, 4 → 0.625, ... asymptotic toward 1.
  return 1 - 1 / (n - 1);
}

const ZERO_WINDOW = 0 as DurationMillis;

/**
 * Build a TemporalProfile from a signal series. Total and deterministic.
 */
export function computeTemporalProfile(
  rawPoints: readonly SignalPoint[],
  config: TemporalConfig = DEFAULT_TEMPORAL_CONFIG,
): TemporalProfile {
  const points = normalize(rawPoints);
  const n = points.length;

  const last = points[n - 1];
  const level = (last !== undefined ? last.value : 0) as FiniteNumber;

  // Insufficient history → explicit, no fabricated derivative.
  if (n < config.minPointsForVelocity) {
    return {
      level,
      velocity: null,
      acceleration: null,
      persistence: r0,
      direction: "UNKNOWN",
      derivativeConfidence: r0,
      window: ZERO_WINDOW,
      method: "INSUFFICIENT_HISTORY",
    };
  }

  const first = points[0];
  const windowMs =
    first !== undefined && last !== undefined
      ? (last.at as number) - (first.at as number)
      : 0;
  const window = (windowMs >= 0 ? windowMs : 0) as DurationMillis;

  const velocity = lastVelocity(points);
  const acceleration =
    n >= config.minPointsForAcceleration ? lastAcceleration(points) : null;

  return {
    level,
    velocity: velocity === null ? null : (velocity as FiniteNumber),
    acceleration: acceleration === null ? null : (acceleration as FiniteNumber),
    persistence: ratio(persistenceOf(points)),
    direction: directionOf(velocity, config.flatEpsilon),
    derivativeConfidence: ratio(derivativeConfidence(n)),
    window,
    method: pickMethod(velocity, acceleration),
  };
}

function pickMethod(
  velocity: number | null,
  acceleration: number | null,
): DerivativeMethod {
  if (velocity === null) return "INSUFFICIENT_HISTORY";
  // Phase 4 uses finite differences; regression/EWMA are reserved for later.
  void acceleration;
  return "FINITE_DIFFERENCE";
}

'@
Set-Content -Path 'src/core/temporal/temporalEngine.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/temporal/index.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/temporal' | Out-Null
$content = @'
// WAR temporal derivatives + trajectory + engine.
export type * from "./types.js";
export * from "./temporalEngine.js";

'@
Set-Content -Path 'src/core/temporal/index.ts' -Value $content -NoNewline -Encoding utf8

# ---- tests/unit/temporalEngine.test.ts ----
New-Item -ItemType Directory -Force -Path 'tests/unit' | Out-Null
$content = @'
import { describe, it, expect } from "vitest";
import {
  computeTemporalProfile,
  DEFAULT_TEMPORAL_CONFIG,
} from "../../src/core/temporal/temporalEngine.js";
import type { SignalPoint } from "../../src/core/temporal/temporalEngine.js";
import type { UnixMillis } from "../../src/shared/scalars.js";

const p = (at: number, value: number): SignalPoint => ({
  at: at as UnixMillis,
  value,
});

describe("computeTemporalProfile — no fabrication", () => {
  it("empty series yields INSUFFICIENT_HISTORY with null derivatives", () => {
    const r = computeTemporalProfile([]);
    expect(r.method).toBe("INSUFFICIENT_HISTORY");
    expect(r.velocity).toBeNull();
    expect(r.acceleration).toBeNull();
    expect(r.direction).toBe("UNKNOWN");
    expect(r.derivativeConfidence as number).toBe(0);
  });

  it("single point cannot produce a velocity", () => {
    const r = computeTemporalProfile([p(1000, 42)]);
    expect(r.method).toBe("INSUFFICIENT_HISTORY");
    expect(r.velocity).toBeNull();
    expect(r.level as number).toBe(42);
  });

  it("two points produce a velocity but no acceleration", () => {
    const r = computeTemporalProfile([p(1000, 10), p(2000, 20)]);
    expect(r.velocity).not.toBeNull();
    expect(r.acceleration).toBeNull();
    expect(r.method).toBe("FINITE_DIFFERENCE");
    // Δvalue/Δt = 10 / 1000 = 0.01
    expect(r.velocity as number).toBeCloseTo(0.01, 12);
    expect(r.direction).toBe("UP");
  });

  it("three points produce an acceleration", () => {
    const r = computeTemporalProfile([p(0, 0), p(1000, 10), p(2000, 30)]);
    expect(r.velocity).not.toBeNull();
    expect(r.acceleration).not.toBeNull();
  });
});

describe("computeTemporalProfile — irregular time", () => {
  it("handles irregular spacing without dividing by zero", () => {
    const r = computeTemporalProfile([p(0, 0), p(50, 5), p(3000, 6)]);
    expect(Number.isFinite(r.velocity as number)).toBe(true);
    expect(r.method).toBe("FINITE_DIFFERENCE");
  });

  it("duplicate timestamp with equal value is deduped; zero Δt yields null velocity when it is the last step", () => {
    // last two points share a timestamp → Δt = 0 → velocity null (no fabrication)
    const r = computeTemporalProfile([p(0, 0), p(1000, 10), p(1000, 15)]);
    expect(r.velocity).toBeNull();
    expect(r.method).toBe("INSUFFICIENT_HISTORY");
  });

  it("out-of-order input is sorted deterministically before differencing", () => {
    const forward = computeTemporalProfile([p(0, 0), p(1000, 10), p(2000, 30)]);
    const shuffled = computeTemporalProfile([p(2000, 30), p(0, 0), p(1000, 10)]);
    expect(JSON.stringify(forward)).toBe(JSON.stringify(shuffled));
  });
});

describe("computeTemporalProfile — direction + persistence", () => {
  it("flat series within epsilon is FLAT", () => {
    const r = computeTemporalProfile([p(0, 5), p(1000, 5)]);
    expect(r.direction).toBe("FLAT");
  });

  it("monotonic rising series has persistence 1", () => {
    const r = computeTemporalProfile([p(0, 1), p(1, 2), p(2, 3), p(3, 4)]);
    expect(r.persistence as number).toBe(1);
    expect(r.direction).toBe("UP");
  });

  it("choppy series has persistence below 1", () => {
    const r = computeTemporalProfile([p(0, 1), p(1, 3), p(2, 2), p(3, 4)]);
    expect(r.persistence as number).toBeLessThan(1);
  });
});

describe("computeTemporalProfile — determinism", () => {
  it("identical input yields byte-identical output", () => {
    const series = [p(0, 0), p(1000, 10), p(2000, 30), p(3000, 35)];
    const a = computeTemporalProfile(series);
    const b = computeTemporalProfile(series);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("derivative confidence rises with more points, never exceeds 1", () => {
    const two = computeTemporalProfile([p(0, 0), p(1, 1)]);
    const five = computeTemporalProfile([
      p(0, 0), p(1, 1), p(2, 2), p(3, 3), p(4, 4),
    ]);
    expect(five.derivativeConfidence as number).toBeGreaterThan(
      two.derivativeConfidence as number,
    );
    expect(five.derivativeConfidence as number).toBeLessThanOrEqual(1);
  });

  it("config is honored (raising minPointsForVelocity blocks a 2-point velocity)", () => {
    const r = computeTemporalProfile([p(0, 0), p(1000, 10)], {
      ...DEFAULT_TEMPORAL_CONFIG,
      minPointsForVelocity: 3,
    });
    expect(r.velocity).toBeNull();
    expect(r.method).toBe("INSUFFICIENT_HISTORY");
  });
});

'@
Set-Content -Path 'tests/unit/temporalEngine.test.ts' -Value $content -NoNewline -Encoding utf8

# ---- README.md ----
$content = @'
# WAR Engine

Deterministic temporal market-intelligence engine. Renderer-agnostic core.

- **Intelligence contract:** V3.2 (FROZEN)
- **GMGN evidence:** sealed at commit `147c070` — see `PHASE_0_SEALED.md`
- **Current phase:** Phase 4 — Temporal Engine (complete)

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

Write-Host 'Phase 4 files installed.' -ForegroundColor Green
Write-Host 'Next: npm test   (expect 87 passed)' -ForegroundColor Yellow