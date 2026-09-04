# ============================================================
# WAR - Phase 17 Installer (Runtime / Scheduler) - BACKEND COMPLETE
# Run from inside war\ :  powershell -ExecutionPolicy Bypass -File .\install-phase17.ps1
# Requires Phase 16 already present.
# ============================================================

$ErrorActionPreference = 'Stop'
if (-not (Test-Path 'package.json')) { Write-Error 'Run from inside the war/ folder.'; exit 1 }
if (-not (Test-Path 'src\adapters\gmgn\gmgnRunner.ts')) { Write-Error 'Phase 16 missing. Install Phase 16 first.'; exit 1 }
Write-Host 'Installing Phase 17 (Runtime / Scheduler)...' -ForegroundColor Cyan

# ---- src/runtime/rateLimiter.ts ----
New-Item -ItemType Directory -Force -Path 'src/runtime' | Out-Null
$content = @'
/**
 * WAR runtime - Leaky Bucket rate limiter (Phase 17).
 *
 * Models the sealed GMGN limit: rate=20, capacity=20, per-route weights. Pure
 * and deterministic - the bucket state is a value that is threaded through time
 * explicitly. Time is injected (ms); nothing here reads a clock.
 *
 * The bucket leaks `rate` tokens per second and holds at most `capacity`. A
 * request of weight W is admitted only if the bucket has >= W available; the
 * caller is told when to retry otherwise.
 */

export interface BucketConfig {
  /** Tokens replenished per second. */
  readonly rate: number;
  /** Maximum tokens the bucket can hold. */
  readonly capacity: number;
}

export const GMGN_BUCKET: BucketConfig = { rate: 20, capacity: 20 };

/** Immutable bucket state: available tokens and the ms timestamp they were valid at. */
export interface BucketState {
  readonly available: number;
  readonly at: number; // ms
}

/** Start a bucket full at time `atMs`. */
export function initBucket(config: BucketConfig, atMs: number): BucketState {
  return { available: config.capacity, at: atMs };
}

/** Refill the bucket up to `now` (deterministic; no clock). */
function refill(state: BucketState, config: BucketConfig, now: number): BucketState {
  if (now <= state.at) return state;
  const elapsedSec = (now - state.at) / 1000;
  const replenished = elapsedSec * config.rate;
  const available = Math.min(config.capacity, state.available + replenished);
  return { available, at: now };
}

export type AdmitResult =
  | { readonly admitted: true; readonly state: BucketState }
  | { readonly admitted: false; readonly state: BucketState; readonly retryAfterMs: number };

/**
 * Attempt to admit a request of the given weight at time `now`. Deterministic.
 * On rejection, reports how long (ms) until enough tokens will have leaked in.
 */
export function tryAdmit(
  state: BucketState,
  config: BucketConfig,
  weight: number,
  now: number,
): AdmitResult {
  const refilled = refill(state, config, now);

  if (refilled.available >= weight) {
    return {
      admitted: true,
      state: { available: refilled.available - weight, at: now },
    };
  }

  const deficit = weight - refilled.available;
  const retryAfterMs = Math.ceil((deficit / config.rate) * 1000);
  return { admitted: false, state: refilled, retryAfterMs };
}

'@
Set-Content -Path 'src/runtime/rateLimiter.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/runtime/scheduler.ts ----
New-Item -ItemType Directory -Force -Path 'src/runtime' | Out-Null
$content = @'
/**
 * WAR runtime - Scheduler (Phase 17).
 *
 * Orchestrates data acquisition: it schedules weighted fetch requests through
 * the leaky-bucket limiter and returns admitted requests in a deterministic
 * order. It does NOT itself perform IO - fetchers are injected - so it is fully
 * testable and deterministic. Time is injected.
 *
 * This is the seam where adapter (IO) meets core (intelligence): the scheduler
 * decides WHEN a request may run; the caller wires the actual adapter call.
 */

import type { BucketConfig, BucketState } from "./rateLimiter.js";
import { GMGN_BUCKET, initBucket, tryAdmit } from "./rateLimiter.js";
import { ROUTE_WEIGHTS } from "../adapters/gmgn/gmgnRunner.js";

/** A unit of work to schedule: a named route (for its weight) and a payload id. */
export interface FetchRequest {
  readonly id: string;
  readonly route: keyof typeof ROUTE_WEIGHTS | string;
}

/** The scheduler's decision for one request. */
export interface ScheduledRequest {
  readonly id: string;
  readonly route: string;
  readonly weight: number;
  readonly runAtMs: number;
}

export interface SchedulePlan {
  readonly scheduled: readonly ScheduledRequest[];
  readonly finalBucket: BucketState;
}

function weightOf(route: string): number {
  const w = ROUTE_WEIGHTS[route];
  return typeof w === "number" ? w : 1;
}

/**
 * Plan the execution times for a batch of requests starting at `startMs`,
 * respecting the leaky bucket. Requests are processed in a stable order (by id)
 * so the plan is deterministic. When the bucket lacks tokens, the request is
 * deferred by exactly the limiter's retryAfterMs (no busy spinning).
 */
export function planSchedule(
  requests: readonly FetchRequest[],
  startMs: number,
  config: BucketConfig = GMGN_BUCKET,
): SchedulePlan {
  // Deterministic processing order.
  const ordered = [...requests].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  let bucket = initBucket(config, startMs);
  let now = startMs;
  const scheduled: ScheduledRequest[] = [];

  for (const req of ordered) {
    const weight = weightOf(req.route);

    // Advance time until this request is admitted.
    let result = tryAdmit(bucket, config, weight, now);
    while (!result.admitted) {
      now += result.retryAfterMs;
      bucket = result.state;
      result = tryAdmit(bucket, config, weight, now);
    }

    bucket = result.state;
    scheduled.push({ id: req.id, route: req.route, weight, runAtMs: now });
  }

  return { scheduled, finalBucket: bucket };
}

/**
 * Total weight of a batch - a quick capacity check callers can use before
 * planning (e.g. to warn that a very large batch will span a long window).
 */
export function totalWeight(requests: readonly FetchRequest[]): number {
  return requests.reduce((sum, r) => sum + weightOf(r.route), 0);
}

'@
Set-Content -Path 'src/runtime/scheduler.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/runtime/index.ts ----
New-Item -ItemType Directory -Force -Path 'src/runtime' | Out-Null
$content = @'
// WAR runtime - rate limiter + scheduler.
export * from "./rateLimiter.js";
export * from "./scheduler.js";

'@
Set-Content -Path 'src/runtime/index.ts' -Value $content -NoNewline -Encoding utf8

# ---- tests/unit/runtime.test.ts ----
New-Item -ItemType Directory -Force -Path 'tests/unit' | Out-Null
$content = @'
import { describe, it, expect } from "vitest";
import {
  initBucket,
  tryAdmit,
  GMGN_BUCKET,
} from "../../src/runtime/rateLimiter.js";
import {
  planSchedule,
  totalWeight,
} from "../../src/runtime/scheduler.js";
import type { FetchRequest } from "../../src/runtime/scheduler.js";

describe("leaky bucket rate limiter", () => {
  it("starts full at capacity", () => {
    const b = initBucket(GMGN_BUCKET, 0);
    expect(b.available).toBe(20);
  });

  it("admits a request within capacity and deducts weight", () => {
    const b = initBucket(GMGN_BUCKET, 0);
    const r = tryAdmit(b, GMGN_BUCKET, 5, 0);
    expect(r.admitted).toBe(true);
    if (r.admitted) expect(r.state.available).toBe(15);
  });

  it("rejects when weight exceeds available and reports retry time", () => {
    let b = initBucket(GMGN_BUCKET, 0);
    // drain the bucket
    const drain = tryAdmit(b, GMGN_BUCKET, 20, 0);
    if (drain.admitted) b = drain.state;
    const r = tryAdmit(b, GMGN_BUCKET, 5, 0);
    expect(r.admitted).toBe(false);
    if (!r.admitted) {
      // need 5 tokens at 20/sec -> 250ms
      expect(r.retryAfterMs).toBe(250);
    }
  });

  it("refills over time (deterministic, injected clock)", () => {
    let b = initBucket(GMGN_BUCKET, 0);
    const drain = tryAdmit(b, GMGN_BUCKET, 20, 0);
    if (drain.admitted) b = drain.state;
    // 500ms later -> 10 tokens leaked back in
    const r = tryAdmit(b, GMGN_BUCKET, 10, 500);
    expect(r.admitted).toBe(true);
  });

  it("never exceeds capacity when refilling", () => {
    const b = initBucket(GMGN_BUCKET, 0);
    // long idle then a small request: still capped at capacity
    const r = tryAdmit(b, GMGN_BUCKET, 1, 10_000);
    expect(r.admitted).toBe(true);
    if (r.admitted) expect(r.state.available).toBeLessThanOrEqual(20);
  });

  it("is deterministic", () => {
    const b = initBucket(GMGN_BUCKET, 0);
    const a = tryAdmit(b, GMGN_BUCKET, 7, 100);
    const c = tryAdmit(b, GMGN_BUCKET, 7, 100);
    expect(JSON.stringify(a)).toBe(JSON.stringify(c));
  });
});

describe("scheduler", () => {
  const reqs: FetchRequest[] = [
    { id: "r1", route: "kline" }, // weight 2
    { id: "r2", route: "trending" }, // weight 1
    { id: "r3", route: "follow-wallet" }, // weight 3
  ];

  it("computes total weight from sealed route weights", () => {
    expect(totalWeight(reqs)).toBe(6);
  });

  it("schedules a small batch immediately (fits in capacity)", () => {
    const plan = planSchedule(reqs, 1000);
    for (const s of plan.scheduled) {
      expect(s.runAtMs).toBe(1000); // all fit at once
    }
  });

  it("defers requests that exceed capacity to a later time", () => {
    // 30 kline requests * weight 2 = 60 weight; capacity 20 -> must span time
    const many: FetchRequest[] = Array.from({ length: 30 }, (_, i) => ({
      id: `k${String(i).padStart(2, "0")}`,
      route: "kline",
    }));
    const plan = planSchedule(many, 0);
    const times = plan.scheduled.map((s) => s.runAtMs);
    expect(Math.max(...times)).toBeGreaterThan(0); // some deferred
  });

  it("produces a stable, deterministic plan regardless of input order", () => {
    const a = planSchedule(reqs, 0);
    const b = planSchedule([...reqs].reverse(), 0);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("assigns the correct weight per route", () => {
    const plan = planSchedule(reqs, 0);
    const byId = Object.fromEntries(plan.scheduled.map((s) => [s.id, s.weight]));
    expect(byId["r1"]).toBe(2);
    expect(byId["r2"]).toBe(1);
    expect(byId["r3"]).toBe(3);
  });

  it("unknown routes default to weight 1", () => {
    const plan = planSchedule([{ id: "x", route: "mystery" }], 0);
    expect(plan.scheduled[0]?.weight).toBe(1);
  });
});

'@
Set-Content -Path 'tests/unit/runtime.test.ts' -Value $content -NoNewline -Encoding utf8

# ---- README.md ----
$content = @'
# WAR Engine

Deterministic temporal market-intelligence engine. Renderer-agnostic core.

- **Intelligence contract:** V3.2 (FROZEN)
- **GMGN evidence:** sealed at commit `147c070` — see `PHASE_0_SEALED.md`
- **Current phase:** Phase 17 - Runtime/Scheduler (complete) - BACKEND DONE

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

Write-Host 'Phase 17 installed. BACKEND COMPLETE (core + adapter + runtime).' -ForegroundColor Green
Write-Host 'Next: npm test   (expect 269 passed)' -ForegroundColor Yellow