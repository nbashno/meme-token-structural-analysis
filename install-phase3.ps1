# ============================================================
# WAR — Phase 3 Installer (Timeline)
# Run from inside war\ :  powershell -ExecutionPolicy Bypass -File .\install-phase3.ps1
# Creates/updates Phase 3 files. Requires Phase 2 already present.
# ============================================================

$ErrorActionPreference = 'Stop'
if (-not (Test-Path 'package.json')) { Write-Error 'Run from inside the war/ folder.'; exit 1 }
if (-not (Test-Path 'src\shared\scalars.ts')) { Write-Error 'Phase 2 missing. Install Phase 2 first.'; exit 1 }
Write-Host 'Installing Phase 3 (Timeline)...' -ForegroundColor Cyan

# ---- src/shared/construct.ts ----
New-Item -ItemType Directory -Force -Path 'src/shared' | Out-Null
$content = @'
/**
 * WAR core — scalar constructors (Phase 3).
 *
 * The ONLY sanctioned way to produce branded scalars. Every constructor is
 * pure, total, and deterministic: same input → same output, no time, no
 * randomness, no throwing on the hot path where a typed failure is meaningful.
 *
 * Design rule: illegal numbers (NaN, Infinity, out-of-range) never silently
 * become a valid brand. They yield an explicit failure the caller must handle.
 */

import type {
  Score0to100,
  Ratio0to1,
  FiniteNumber,
  UnixMillis,
  UnixSeconds,
  DurationMillis,
} from "./scalars.js";

/** Result of a validating constructor: either a branded value or a reason. */
export type ScalarResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

function ok<T>(value: T): ScalarResult<T> {
  return { ok: true, value };
}
function fail<T>(reason: string): ScalarResult<T> {
  return { ok: false, reason };
}

/** True only for a finite, non-NaN JavaScript number. */
function isFiniteNumber(n: number): boolean {
  return typeof n === "number" && Number.isFinite(n);
}

export function toFiniteNumber(n: number): ScalarResult<FiniteNumber> {
  if (!isFiniteNumber(n)) return fail(`not a finite number: ${String(n)}`);
  return ok(n as FiniteNumber);
}

export function toScore0to100(n: number): ScalarResult<Score0to100> {
  if (!isFiniteNumber(n)) return fail(`score not finite: ${String(n)}`);
  if (n < 0 || n > 100) return fail(`score out of [0,100]: ${n}`);
  return ok(n as Score0to100);
}

export function toRatio0to1(n: number): ScalarResult<Ratio0to1> {
  if (!isFiniteNumber(n)) return fail(`ratio not finite: ${String(n)}`);
  if (n < 0 || n > 1) return fail(`ratio out of [0,1]: ${n}`);
  return ok(n as Ratio0to1);
}

export function toUnixMillis(n: number): ScalarResult<UnixMillis> {
  if (!isFiniteNumber(n)) return fail(`timestamp not finite: ${String(n)}`);
  if (!Number.isInteger(n)) return fail(`timestamp not integer ms: ${n}`);
  if (n < 0) return fail(`timestamp negative: ${n}`);
  return ok(n as UnixMillis);
}

/** Convert adapter-boundary seconds to internal milliseconds, deterministically. */
export function secondsToMillis(s: UnixSeconds): ScalarResult<UnixMillis> {
  const ms = (s as number) * 1000;
  return toUnixMillis(ms);
}

export function toDurationMillis(n: number): ScalarResult<DurationMillis> {
  if (!isFiniteNumber(n)) return fail(`duration not finite: ${String(n)}`);
  if (n < 0) return fail(`duration negative: ${n}`);
  return ok(n as DurationMillis);
}

/** Clamp a finite number into [0,100]. Non-finite input is a typed failure. */
export function clampScore(n: number): ScalarResult<Score0to100> {
  if (!isFiniteNumber(n)) return fail(`clamp input not finite: ${String(n)}`);
  const clamped = n < 0 ? 0 : n > 100 ? 100 : n;
  return ok(clamped as Score0to100);
}

'@
Set-Content -Path 'src/shared/construct.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/shared/index.ts ----
New-Item -ItemType Directory -Force -Path 'src/shared' | Out-Null
$content = @'
// WAR shared scalars, quality contracts, and validating constructors.
export type * from "./scalars.js";
export type * from "./quality.js";
export * from "./construct.js";

'@
Set-Content -Path 'src/shared/index.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/timeline/buildTimeline.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/timeline' | Out-Null
$content = @'
/**
 * WAR core — Timeline builder (Phase 3).
 *
 * Deterministic construction of a TokenTimeline from already-normalized
 * observations. This module:
 *   - injects time (never reads a clock);
 *   - sorts each lane chronologically with a stable, total order;
 *   - drops exact duplicates deterministically;
 *   - enforces coverage semantics (FLOW is ROLLING — never COMPLETE);
 *   - reports the observed FLOW window without pretending it is complete.
 *
 * It contains no IO, no randomness, no adapter/raw knowledge.
 */

import type {
  Chain,
  TokenAddress,
  UnixMillis,
  DurationMillis,
} from "../../shared/scalars.js";
import type {
  TokenTimeline,
  MarketObservation,
  AnalyticsObservation,
  FlowObservation,
  Coverage,
} from "./types.js";
import { toDurationMillis } from "../../shared/construct.js";

/** Inputs to the builder. Time is injected via `now`, never read from a clock. */
export interface TimelineBuildInput {
  readonly chain: Chain;
  readonly address: TokenAddress;
  readonly now: UnixMillis;
  readonly market: readonly MarketObservation[];
  readonly analytics: readonly AnalyticsObservation[];
  readonly flow: readonly FlowObservation[];
}

/** Coverage each lane MUST carry. Enforced, not assumed. */
const REQUIRED_COVERAGE: {
  readonly market: Coverage;
  readonly analytics: Coverage;
  readonly flow: Coverage;
} = {
  market: "COMPLETE",
  analytics: "SAMPLED",
  flow: "ROLLING",
};

/** A stable, total chronological comparator: by time, then by a tiebreak key. */
function byTimeThen<T>(
  timeOf: (x: T) => number,
  tiebreak: (x: T) => string,
): (a: T, b: T) => number {
  return (a, b) => {
    const ta = timeOf(a);
    const tb = timeOf(b);
    if (ta !== tb) return ta - tb;
    const ka = tiebreak(a);
    const kb = tiebreak(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };
}

/** Deterministically sort + dedupe by a stable identity key. */
function sortDedupe<T>(
  items: readonly T[],
  cmp: (a: T, b: T) => number,
  identity: (x: T) => string,
): readonly T[] {
  const sorted = [...items].sort(cmp);
  const out: T[] = [];
  let lastKey: string | null = null;
  for (const item of sorted) {
    const key = identity(item);
    if (key !== lastKey) {
      out.push(item);
      lastKey = key;
    }
  }
  return out;
}

/** Assert a lane carries its required coverage; return the offending index or -1. */
function firstCoverageViolation<T extends { readonly meta: { readonly coverage: Coverage } }>(
  items: readonly T[],
  required: Coverage,
): number {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item !== undefined && item.meta.coverage !== required) return i;
  }
  return -1;
}

/** The result of a build: a timeline, or a typed reason it could not be built. */
export type TimelineBuildResult =
  | { readonly ok: true; readonly timeline: TokenTimeline }
  | { readonly ok: false; readonly reason: string };

export function buildTokenTimeline(
  input: TimelineBuildInput,
): TimelineBuildResult {
  // 1. Enforce coverage semantics before anything else.
  const mViol = firstCoverageViolation(input.market, REQUIRED_COVERAGE.market);
  if (mViol >= 0) {
    return { ok: false, reason: `market obs ${mViol} coverage != COMPLETE` };
  }
  const aViol = firstCoverageViolation(input.analytics, REQUIRED_COVERAGE.analytics);
  if (aViol >= 0) {
    return { ok: false, reason: `analytics obs ${aViol} coverage != SAMPLED` };
  }
  const fViol = firstCoverageViolation(input.flow, REQUIRED_COVERAGE.flow);
  if (fViol >= 0) {
    return { ok: false, reason: `flow obs ${fViol} coverage != ROLLING` };
  }

  // 2. Sort + dedupe each lane deterministically.
  const market = sortDedupe(
    input.market,
    byTimeThen(
      (o) => o.meta.at as number,
      (o) => `${o.close}|${o.volumeUsd}`,
    ),
    (o) => `${o.meta.at}`,
  );
  const analytics = sortDedupe(
    input.analytics,
    byTimeThen(
      (o) => o.meta.at as number,
      (o) => `${o.price}|${o.marketCap}`,
    ),
    (o) => `${o.meta.at}`,
  );
  const flow = sortDedupe(
    input.flow,
    byTimeThen(
      (o) => o.meta.at as number,
      (o) => `${o.maker}|${o.side}|${o.amountUsd}`,
    ),
    // Flow identity includes maker+side+amount so distinct trades at the same
    // instant are NOT collapsed — only exact duplicates are removed.
    (o) => `${o.meta.at}|${o.maker}|${o.side}|${o.amountUsd}`,
  );

  // 3. Compute window bounds from actual data (falling back to `now`).
  const allTimes: number[] = [
    ...market.map((o) => o.meta.at as number),
    ...analytics.map((o) => o.meta.at as number),
    ...flow.map((o) => o.meta.at as number),
  ];
  const windowStart = (allTimes.length > 0 ? Math.min(...allTimes) : (input.now as number)) as UnixMillis;
  const windowEnd = (allTimes.length > 0 ? Math.max(...allTimes) : (input.now as number)) as UnixMillis;

  // 4. FLOW observed-for duration: from earliest flow event to `now`.
  //    This is ROLLING coverage made explicit — absence before this span is
  //    NOT evidence of non-occurrence.
  const flowTimes = flow.map((o) => o.meta.at as number);
  const rawObservedFor =
    flowTimes.length > 0 ? (input.now as number) - Math.min(...flowTimes) : 0;
  const observed = toDurationMillis(rawObservedFor);
  const flowObservedFor: DurationMillis = observed.ok
    ? observed.value
    : (0 as DurationMillis);

  return {
    ok: true,
    timeline: {
      chain: input.chain,
      address: input.address,
      market,
      analytics,
      flow,
      windowStart,
      windowEnd,
      flowObservedFor,
    },
  };
}

'@
Set-Content -Path 'src/core/timeline/buildTimeline.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/timeline/index.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/timeline' | Out-Null
$content = @'
// WAR timeline substrate + deterministic builder.
export type * from "./types.js";
export * from "./buildTimeline.js";

'@
Set-Content -Path 'src/core/timeline/index.ts' -Value $content -NoNewline -Encoding utf8

# ---- tests/golden/fixtures.ts ----
New-Item -ItemType Directory -Force -Path 'tests/golden' | Out-Null
$content = @'
/**
 * Deterministic fixtures for timeline tests. No randomness, no clock.
 * Timestamps are fixed integers (ms). These double as golden inputs.
 */

import type {
  MarketObservation,
  AnalyticsObservation,
  FlowObservation,
} from "../../src/core/timeline/types.js";
import type {
  Chain,
  TokenAddress,
  UnixMillis,
} from "../../src/shared/scalars.js";

export const CHAIN: Chain = "sol";
export const ADDRESS = "So11111111111111111111111111111111111111112" as TokenAddress;
export const NOW = 1_700_000_600_000 as UnixMillis;

const t = (ms: number) => ms as UnixMillis;

export function marketObs(at: number, close: number, vol: number): MarketObservation {
  return {
    meta: { at: t(at), temporalOrigin: "GMGN_HISTORICAL", coverage: "COMPLETE", provenance: "market.kline" },
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close,
    volumeUsd: vol,
    amountTokens: vol * 10,
  };
}

export function analyticsObs(at: number, price: number, mc: number): AnalyticsObservation {
  return {
    meta: { at: t(at), temporalOrigin: "WAR_SAMPLED", coverage: "SAMPLED", provenance: "market.trending" },
    price,
    marketCap: mc,
    liquidity: 50_000,
    holderCount: 1200,
    swaps: 300,
    buys: 180,
    sells: 120,
    smartDegenCount: 5,
    renownedCount: 2,
  };
}

export function flowObs(
  at: number,
  maker: string,
  side: "buy" | "sell",
  amountUsd: number,
): FlowObservation {
  return {
    meta: { at: t(at), temporalOrigin: "GMGN_EVENT", coverage: "ROLLING", provenance: "track.smartmoney" },
    maker,
    side,
    amountUsd,
    priceUsd: 1.0,
    positionEvent: side === "buy" ? "OPEN_OR_ADD" : "CLOSE_OR_REDUCE",
    fullness: "UNKNOWN",
    direction: side === "buy" ? "OPEN" : "CLOSE",
  };
}

'@
Set-Content -Path 'tests/golden/fixtures.ts' -Value $content -NoNewline -Encoding utf8

# ---- tests/unit/buildTimeline.test.ts ----
New-Item -ItemType Directory -Force -Path 'tests/unit' | Out-Null
$content = @'
import { describe, it, expect } from "vitest";
import { buildTokenTimeline } from "../../src/core/timeline/buildTimeline.js";
import type { TimelineBuildInput } from "../../src/core/timeline/buildTimeline.js";
import {
  CHAIN,
  ADDRESS,
  NOW,
  marketObs,
  analyticsObs,
  flowObs,
} from "../golden/fixtures.js";

function baseInput(): TimelineBuildInput {
  return {
    chain: CHAIN,
    address: ADDRESS,
    now: NOW,
    // deliberately out-of-order + one exact duplicate market candle
    market: [
      marketObs(1_700_000_300_000, 12, 500),
      marketObs(1_700_000_100_000, 10, 300),
      marketObs(1_700_000_200_000, 11, 400),
      marketObs(1_700_000_200_000, 11, 400), // exact dup
    ],
    analytics: [analyticsObs(1_700_000_250_000, 1.1, 1_000_000)],
    flow: [
      flowObs(1_700_000_150_000, "walletB", "buy", 1000),
      flowObs(1_700_000_120_000, "walletA", "buy", 500),
      // same instant, different maker → must NOT be deduped
      flowObs(1_700_000_120_000, "walletC", "sell", 700),
    ],
  };
}

describe("buildTokenTimeline", () => {
  it("sorts market lane chronologically and drops exact duplicates", () => {
    const r = buildTokenTimeline(baseInput());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const times = r.timeline.market.map((o) => o.meta.at as number);
    expect(times).toEqual([
      1_700_000_100_000, 1_700_000_200_000, 1_700_000_300_000,
    ]);
  });

  it("keeps distinct flow trades at the same instant (no over-dedupe)", () => {
    const r = buildTokenTimeline(baseInput());
    if (!r.ok) throw new Error(r.reason);
    const sameInstant = r.timeline.flow.filter(
      (o) => (o.meta.at as number) === 1_700_000_120_000,
    );
    expect(sameInstant.length).toBe(2); // walletA buy + walletC sell
  });

  it("computes window bounds from actual data", () => {
    const r = buildTokenTimeline(baseInput());
    if (!r.ok) throw new Error(r.reason);
    expect(r.timeline.windowStart as number).toBe(1_700_000_100_000);
    expect(r.timeline.windowEnd as number).toBe(1_700_000_300_000);
  });

  it("reports FLOW observed-for as now minus earliest flow (ROLLING made explicit)", () => {
    const r = buildTokenTimeline(baseInput());
    if (!r.ok) throw new Error(r.reason);
    // earliest flow = 1_700_000_120_000, now = 1_700_000_600_000
    expect(r.timeline.flowObservedFor as number).toBe(480_000);
  });

  it("rejects a market observation whose coverage is not COMPLETE", () => {
    const bad = baseInput();
    const mutated: TimelineBuildInput = {
      ...bad,
      market: [
        {
          ...marketObs(1_700_000_100_000, 10, 300),
          meta: {
            at: 1_700_000_100_000 as never,
            temporalOrigin: "GMGN_HISTORICAL",
            coverage: "ROLLING", // wrong
            provenance: "market.kline",
          },
        },
      ],
    };
    const r = buildTokenTimeline(mutated);
    expect(r.ok).toBe(false);
  });

  it("is deterministic: identical input yields byte-identical output", () => {
    const a = buildTokenTimeline(baseInput());
    const b = buildTokenTimeline(baseInput());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("input order does not change output (order-independence)", () => {
    const forward = baseInput();
    const reversed: TimelineBuildInput = {
      ...forward,
      market: [...forward.market].reverse(),
      flow: [...forward.flow].reverse(),
    };
    const a = buildTokenTimeline(forward);
    const b = buildTokenTimeline(reversed);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("buildTokenTimeline — golden snapshot", () => {
  it("matches the frozen golden output", () => {
    const r = buildTokenTimeline(baseInput());
    expect(r).toMatchSnapshot();
  });
});

'@
Set-Content -Path 'tests/unit/buildTimeline.test.ts' -Value $content -NoNewline -Encoding utf8

# ---- README.md ----
$content = @'
# WAR Engine

Deterministic temporal market-intelligence engine. Renderer-agnostic core.

- **Intelligence contract:** V3.2 (FROZEN)
- **GMGN evidence:** sealed at commit `147c070` — see `PHASE_0_SEALED.md`
- **Current phase:** Phase 3 — Timeline (complete)

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

Write-Host 'Phase 3 files installed.' -ForegroundColor Green
Write-Host 'Next: npm test   (expect 71 passed)' -ForegroundColor Yellow