# ============================================================
# WAR - Phase 7 Installer (Coherence + Lead/Lag)
# Run from inside war\ :  powershell -ExecutionPolicy Bypass -File .\install-phase7.ps1
# Requires Phase 6 already present.
# ============================================================

$ErrorActionPreference = 'Stop'
if (-not (Test-Path 'package.json')) { Write-Error 'Run from inside the war/ folder.'; exit 1 }
if (-not (Test-Path 'src\core\trajectory\trajectory.ts')) { Write-Error 'Phase 6 missing. Install Phase 6 first.'; exit 1 }
Write-Host 'Installing Phase 7 (Coherence + Lead/Lag)...' -ForegroundColor Cyan

# ---- src/core/coherence/coherence.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/coherence' | Out-Null
$content = @'
/**
 * WAR core - Coherence + Lead/Lag engine (Phase 7).
 *
 * Coherence measures whether directional vectors (price, volume, flow,
 * liquidity, sell-pressure) agree or conflict. CONFLICT MUST REDUCE coherence -
 * a token with contradictory vectors cannot be scored as coherent regardless of
 * data quality.
 *
 * Lead/Lag measures observed PRECEDENCE only. Permitted meaning: "flow
 * historically preceded price movement within the observed window." FORBIDDEN
 * meaning: causation. This module never asserts one series caused another.
 *
 * Pure, total, deterministic. No clock, no randomness, no IO.
 */

import type { Ratio0to1, DurationMillis, Score0to100 } from "../../shared/scalars.js";
import type {
  Coherence,
  CoherenceState,
  CoherenceVector,
  LeadLag,
  LeadLagResult,
} from "./types.js";
import type { SignalDirection } from "../temporal/types.js";
import { toRatio0to1, clampScore } from "../../shared/construct.js";

const R0 = 0 as Ratio0to1;
const S0 = 0 as Score0to100;
function ratio(n: number): Ratio0to1 {
  const r = toRatio0to1(n);
  return r.ok ? r.value : R0;
}
function score(n: number): Score0to100 {
  const r = clampScore(n);
  return r.ok ? r.value : S0;
}

/** A named directional vector fed into coherence. */
export interface DirectedVector {
  readonly name: CoherenceVector["name"];
  readonly direction: SignalDirection;
}

/** Map a signal direction to a comparable sign, or null if unusable. */
function dirSign(d: SignalDirection): 1 | -1 | 0 | null {
  if (d === "UP") return 1;
  if (d === "DOWN") return -1;
  if (d === "FLAT") return 0;
  return null; // UNKNOWN
}

export interface CoherenceConfig {
  /** netCoherence at/above this -> STRONG_MULTI_VECTOR_ALIGNMENT. */
  readonly strongAlign: number;
  /** netCoherence at/above this (but below strong) -> MULTI_VECTOR_ALIGNMENT. */
  readonly align: number;
  /** netCoherence at/below this -> MULTI_VECTOR_CONFLICT. */
  readonly conflict: number;
  /** Minimum usable vectors required to judge coherence at all. */
  readonly minVectors: number;
}

export const DEFAULT_COHERENCE_CONFIG: CoherenceConfig = {
  strongAlign: 0.85,
  align: 0.6,
  conflict: 0.4,
  minVectors: 2,
};

/**
 * Compute coherence across directional vectors. The consensus is the majority
 * sign; each vector "agrees" if it shares that sign. netCoherence is the share
 * of usable vectors agreeing with the consensus - so conflict pulls it down.
 */
export function computeCoherence(
  vectors: readonly DirectedVector[],
  config: CoherenceConfig = DEFAULT_COHERENCE_CONFIG,
): Coherence {
  const usable = vectors
    .map((v) => ({ name: v.name, sign: dirSign(v.direction) }))
    .filter((v): v is { name: CoherenceVector["name"]; sign: 1 | -1 | 0 } =>
      v.sign !== null,
    );

  if (usable.length < config.minVectors) {
    return {
      state: "INSUFFICIENT",
      netCoherence: R0,
      vectors: vectors
        .map((v) => ({ name: v.name, agrees: null }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    };
  }

  // Consensus = the most common non-zero sign; ties or all-flat -> 0.
  let pos = 0;
  let neg = 0;
  for (const v of usable) {
    if (v.sign === 1) pos++;
    else if (v.sign === -1) neg++;
  }
  const consensus: 1 | -1 | 0 = pos > neg ? 1 : neg > pos ? -1 : 0;

  const agreeing = usable.filter((v) => v.sign === consensus).length;
  const netCoherence = ratio(agreeing / usable.length);

  const state = classifyCoherence(netCoherence as number, config);

  const vectorReport: CoherenceVector[] = vectors
    .map((v) => {
      const s = dirSign(v.direction);
      return { name: v.name, agrees: s === null ? null : s === consensus };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return { state, netCoherence, vectors: vectorReport };
}

function classifyCoherence(nc: number, config: CoherenceConfig): CoherenceState {
  if (nc >= config.strongAlign) return "STRONG_MULTI_VECTOR_ALIGNMENT";
  if (nc >= config.align) return "MULTI_VECTOR_ALIGNMENT";
  if (nc <= config.conflict) return "MULTI_VECTOR_CONFLICT";
  return "MIXED";
}

// -- Lead/Lag ----------------------------------------------------------------

/** A time-ordered directional change on a single series. */
export interface DirectionalMove {
  readonly at: number; // ms
  readonly sign: 1 | -1;
}

export interface LeadLagConfig {
  /** Max lag to consider a relationship "stable" (ms). */
  readonly maxLagMs: number;
  /** Minimum matched move pairs required to conclude a relationship. */
  readonly minMatches: number;
}

export const DEFAULT_LEADLAG_CONFIG: LeadLagConfig = {
  maxLagMs: 600_000, // 10 min
  minMatches: 3,
};

/**
 * Determine whether flow moves historically preceded price moves within the
 * observed window. Matches each price move to the nearest earlier same-sign
 * flow move within maxLagMs. Reports observed precedence only - not causation.
 */
export function computeLeadLag(
  flowMoves: readonly DirectionalMove[],
  priceMoves: readonly DirectionalMove[],
  config: LeadLagConfig = DEFAULT_LEADLAG_CONFIG,
): LeadLag {
  if (flowMoves.length === 0 || priceMoves.length === 0) {
    return { result: "INSUFFICIENT_HISTORY", confidence: S0, observedLag: null };
  }

  const flow = [...flowMoves].sort((a, b) => a.at - b.at);
  const price = [...priceMoves].sort((a, b) => a.at - b.at);

  let flowLeads = 0;
  let priceLeads = 0;
  let synchronized = 0;
  const lags: number[] = [];

  for (const pm of price) {
    // nearest earlier same-sign flow move within window
    let best: DirectionalMove | null = null;
    for (const fm of flow) {
      if (fm.sign !== pm.sign) continue;
      const lag = pm.at - fm.at;
      if (lag < 0) continue;
      if (lag > config.maxLagMs) continue;
      if (best === null || pm.at - fm.at < pm.at - best.at) best = fm;
    }
    if (best !== null) {
      const lag = pm.at - best.at;
      lags.push(lag);
      if (lag === 0) synchronized++;
      else flowLeads++;
    }
  }

  // Symmetric check: did price ever precede flow?
  for (const fm of flow) {
    for (const pm of price) {
      if (pm.sign !== fm.sign) continue;
      const lag = fm.at - pm.at;
      if (lag > 0 && lag <= config.maxLagMs) {
        priceLeads++;
        break;
      }
    }
  }

  const matches = flowLeads + synchronized;
  if (matches < config.minMatches) {
    return { result: "INSUFFICIENT_HISTORY", confidence: S0, observedLag: null };
  }

  const result = decideLeadLag(flowLeads, priceLeads, synchronized);
  const medianLag = lags.length > 0 ? median(lags) : null;

  // Confidence scales with match count, saturating; deterministic.
  const conf = clamp0to100(100 * (1 - 1 / (matches + 1)));

  return {
    result,
    confidence: score(conf),
    observedLag: medianLag === null ? null : (medianLag as DurationMillis),
  };
}

function decideLeadLag(
  flowLeads: number,
  priceLeads: number,
  synchronized: number,
): LeadLagResult {
  if (flowLeads > priceLeads && flowLeads > synchronized) return "FLOW_LEADS";
  if (priceLeads > flowLeads && priceLeads > synchronized) return "PRICE_LEADS";
  if (synchronized >= flowLeads && synchronized >= priceLeads) return "SYNCHRONIZED";
  return "NO_STABLE_RELATIONSHIP";
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return s[mid] as number;
  const a = s[mid - 1] as number;
  const b = s[mid] as number;
  return (a + b) / 2;
}

function clamp0to100(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 100 ? 100 : n;
}

'@
Set-Content -Path 'src/core/coherence/coherence.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/coherence/index.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/coherence' | Out-Null
$content = @'
// WAR coherence + lead/lag.
export type * from "./types.js";
export * from "./coherence.js";

'@
Set-Content -Path 'src/core/coherence/index.ts' -Value $content -NoNewline -Encoding utf8

# ---- tests/unit/coherence.test.ts ----
New-Item -ItemType Directory -Force -Path 'tests/unit' | Out-Null
$content = @'
import { describe, it, expect } from "vitest";
import {
  computeCoherence,
  computeLeadLag,
  DEFAULT_LEADLAG_CONFIG,
} from "../../src/core/coherence/coherence.js";
import type { DirectedVector, DirectionalMove } from "../../src/core/coherence/coherence.js";

const v = (
  name: DirectedVector["name"],
  direction: DirectedVector["direction"],
): DirectedVector => ({ name, direction });

describe("computeCoherence - agreement vs conflict", () => {
  it("all vectors up -> STRONG alignment, high netCoherence", () => {
    const c = computeCoherence([
      v("price", "UP"),
      v("volume", "UP"),
      v("flow", "UP"),
    ]);
    expect(c.state).toBe("STRONG_MULTI_VECTOR_ALIGNMENT");
    expect(c.netCoherence as number).toBe(1);
  });

  it("split vectors -> conflict lowers netCoherence below full alignment", () => {
    const c = computeCoherence([
      v("price", "UP"),
      v("flow", "DOWN"),
      v("sellPressure", "DOWN"),
      v("volume", "DOWN"),
    ]);
    // consensus is DOWN (3 of 4); price disagrees -> netCoherence 0.75 < 1
    expect(c.netCoherence as number).toBeLessThan(1);
    expect(c.netCoherence as number).toBeCloseTo(0.75, 12);
    // 0.75 is alignment, not full conflict - the point is it dropped below 1
    expect(c.state).toBe("MULTI_VECTOR_ALIGNMENT");
  });

  it("genuine conflict (half disagree) -> low coherence, MIXED or CONFLICT", () => {
    const c = computeCoherence([
      v("price", "UP"),
      v("volume", "UP"),
      v("flow", "DOWN"),
      v("sellPressure", "DOWN"),
    ]);
    // 2 up, 2 down -> consensus tie (0); nothing shares sign 0 -> netCoherence 0
    expect(c.netCoherence as number).toBeLessThan(0.6);
    expect(["MIXED", "MULTI_VECTOR_CONFLICT"]).toContain(c.state);
  });

  it("even split flags the disagreeing vector explicitly", () => {
    const c = computeCoherence([v("price", "UP"), v("flow", "DOWN")]);
    const price = c.vectors.find((x) => x.name === "price");
    const flow = c.vectors.find((x) => x.name === "flow");
    // consensus is 0 (tie) -> neither shares sign
    expect(price?.agrees).toBe(false);
    expect(flow?.agrees).toBe(false);
  });

  it("too few usable vectors -> INSUFFICIENT", () => {
    const c = computeCoherence([v("price", "UP"), v("flow", "UNKNOWN")]);
    expect(c.state).toBe("INSUFFICIENT");
    expect(c.netCoherence as number).toBe(0);
  });

  it("UNKNOWN vectors are excluded, not counted as agreement", () => {
    const c = computeCoherence([
      v("price", "UP"),
      v("volume", "UP"),
      v("flow", "UNKNOWN"),
    ]);
    const flow = c.vectors.find((x) => x.name === "flow");
    expect(flow?.agrees).toBeNull();
  });

  it("is deterministic", () => {
    const vs = [v("price", "UP"), v("flow", "DOWN"), v("volume", "UP")];
    expect(JSON.stringify(computeCoherence(vs))).toBe(
      JSON.stringify(computeCoherence([...vs].reverse())),
    );
  });
});

const m = (at: number, sign: 1 | -1): DirectionalMove => ({ at, sign });

describe("computeLeadLag - observed precedence, not causation", () => {
  it("flow consistently before price -> FLOW_LEADS", () => {
    const flow = [m(0, 1), m(1000, 1), m(2000, 1)];
    const price = [m(300, 1), m(1300, 1), m(2300, 1)];
    const r = computeLeadLag(flow, price);
    expect(r.result).toBe("FLOW_LEADS");
    expect(r.observedLag as number).toBe(300);
  });

  it("simultaneous moves -> SYNCHRONIZED", () => {
    const flow = [m(0, 1), m(1000, 1), m(2000, 1)];
    const price = [m(0, 1), m(1000, 1), m(2000, 1)];
    const r = computeLeadLag(flow, price);
    expect(r.result).toBe("SYNCHRONIZED");
  });

  it("empty series -> INSUFFICIENT_HISTORY, null lag", () => {
    const r = computeLeadLag([], [m(0, 1)]);
    expect(r.result).toBe("INSUFFICIENT_HISTORY");
    expect(r.observedLag).toBeNull();
    expect(r.confidence as number).toBe(0);
  });

  it("too few matches -> INSUFFICIENT_HISTORY", () => {
    const flow = [m(0, 1)];
    const price = [m(300, 1)];
    const r = computeLeadLag(flow, price);
    expect(r.result).toBe("INSUFFICIENT_HISTORY");
  });

  it("moves beyond max lag are not matched", () => {
    const far = DEFAULT_LEADLAG_CONFIG.maxLagMs + 1000;
    const flow = [m(0, 1), m(1000, 1), m(2000, 1)];
    const price = [m(far, 1), m(far + 1000, 1), m(far + 2000, 1)];
    const r = computeLeadLag(flow, price);
    expect(r.result).toBe("INSUFFICIENT_HISTORY");
  });

  it("confidence stays within [0,100] and is deterministic", () => {
    const flow = [m(0, 1), m(1000, 1), m(2000, 1), m(3000, 1)];
    const price = [m(300, 1), m(1300, 1), m(2300, 1), m(3300, 1)];
    const a = computeLeadLag(flow, price);
    const b = computeLeadLag(flow, price);
    expect(a.confidence as number).toBeGreaterThanOrEqual(0);
    expect(a.confidence as number).toBeLessThanOrEqual(100);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

'@
Set-Content -Path 'tests/unit/coherence.test.ts' -Value $content -NoNewline -Encoding utf8

# ---- README.md ----
$content = @'
# WAR Engine

Deterministic temporal market-intelligence engine. Renderer-agnostic core.

- **Intelligence contract:** V3.2 (FROZEN)
- **GMGN evidence:** sealed at commit `147c070` — see `PHASE_0_SEALED.md`
- **Current phase:** Phase 7 - Coherence + Lead/Lag (complete)

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

Write-Host 'Phase 7 files installed.' -ForegroundColor Green
Write-Host 'Next: npm test   (expect 145 passed)' -ForegroundColor Yellow