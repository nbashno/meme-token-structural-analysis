# ============================================================
# WAR - Phase 5 Installer (Flow Engine + Normalizer)
# Run from inside war\ :  powershell -ExecutionPolicy Bypass -File .\install-phase5.ps1
# Requires Phase 4 already present.
# ============================================================

$ErrorActionPreference = 'Stop'
if (-not (Test-Path 'package.json')) { Write-Error 'Run from inside the war/ folder.'; exit 1 }
if (-not (Test-Path 'src\core\temporal\temporalEngine.ts')) { Write-Error 'Phase 4 missing. Install Phase 4 first.'; exit 1 }
Write-Host 'Installing Phase 5 (Flow Engine + Normalizer)...' -ForegroundColor Cyan

# ---- src/adapters/gmgn/flowEventNormalizer.ts ----
New-Item -ItemType Directory -Force -Path 'src/adapters/gmgn' | Out-Null
$content = @'
/**
 * WAR adapter - FlowEventNormalizer implementation (Phase 5).
 *
 * Implements the sealed contract. This is the ONLY place the raw is_open_or_close
 * bit is interpreted, and it is interpreted DIFFERENTLY per source (Phase 0 section D):
 *
 *   follow-wallet:  bit = FULLNESS.  1 = full, 0 = partial. Direction from `side`.
 *   kol/smartmoney: bit = DIRECTION. 0 = open/add, 1 = close/reduce. Fullness UNKNOWN.
 *
 * Invariants enforced (I1-I5 from the contract):
 *   I1. kol/smartmoney NEVER yields a FULL or PARTIAL classification.
 *   I2. follow-wallet: bit 1 to a FULL event, bit 0 to a PARTIAL event; direction from side.
 *   I3. the raw bit appears in NO output field.
 *   I4. interpretedUnder === source, always.
 *   I5. malformed input to UNKNOWN, never a fabricated FULL/PARTIAL, never a 0.
 *
 * Pure, total, deterministic. No clock, no randomness, no IO.
 */

import type {
  RawFlowEvent,
  RawFollowWalletEvent,
  RawKolSmartMoneyEvent,
  NormalizedFlowEvent,
  FlowEventNormalizer,
  PositionEvent,
  Fullness,
  PositionDirection,
  TradeSide,
} from "./FlowEventNormalizer.contract.js";

/** Map a follow-wallet event: bit encodes fullness; direction comes from side. */
function normalizeFollowWallet(
  raw: RawFollowWalletEvent,
): {
  positionEvent: PositionEvent;
  fullness: Fullness;
  direction: PositionDirection;
} {
  const side: TradeSide = raw.side;
  const isFull = raw.is_open_or_close === 1;

  // A buy is an OPEN-side move; a sell is a CLOSE-side move.
  const direction: PositionDirection =
    side === "buy" ? "OPEN" : side === "sell" ? "CLOSE" : "UNKNOWN";

  if (direction === "UNKNOWN") {
    return { positionEvent: "UNKNOWN", fullness: "UNKNOWN", direction };
  }

  if (isFull) {
    return {
      positionEvent: direction === "OPEN" ? "FULL_OPEN" : "FULL_CLOSE",
      fullness: "FULL",
      direction,
    };
  }
  return {
    positionEvent: direction === "OPEN" ? "PARTIAL_ADD" : "PARTIAL_REDUCE",
    fullness: "PARTIAL",
    direction,
  };
}

/**
 * Map a kol/smartmoney event: bit encodes DIRECTION only. Fullness is
 * permanently UNKNOWN here - synthesizing any FULL or PARTIAL class is forbidden (I1).
 */
function normalizeKolSmartMoney(
  raw: RawKolSmartMoneyEvent,
): {
  positionEvent: PositionEvent;
  fullness: Fullness;
  direction: PositionDirection;
} {
  // 0 = opened/added -> OPEN side; 1 = closed/reduced -> CLOSE side.
  if (raw.is_open_or_close === 0) {
    return { positionEvent: "OPEN_OR_ADD", fullness: "UNKNOWN", direction: "OPEN" };
  }
  if (raw.is_open_or_close === 1) {
    return { positionEvent: "CLOSE_OR_REDUCE", fullness: "UNKNOWN", direction: "CLOSE" };
  }
  // Unreachable under the type, but defensive per I5.
  return { positionEvent: "UNKNOWN", fullness: "UNKNOWN", direction: "UNKNOWN" };
}

export const flowEventNormalizer: FlowEventNormalizer = {
  normalize(raw: RawFlowEvent): NormalizedFlowEvent {
    const source = raw.__source;

    const mapped =
      source === "follow-wallet"
        ? normalizeFollowWallet(raw)
        : normalizeKolSmartMoney(raw);

    return {
      source,
      transactionHash: raw.transaction_hash,
      maker: raw.maker,
      side: raw.side,
      baseAddress: raw.base_address,
      amountUsd: raw.amount_usd,
      priceUsd: raw.price_usd,
      timestamp: raw.timestamp,
      tags: raw.maker_info.tags,
      positionEvent: mapped.positionEvent,
      fullness: mapped.fullness,
      direction: mapped.direction,
      // I4: interpretation is always under the event's own source.
      interpretedUnder: source,
    };
  },
};

'@
Set-Content -Path 'src/adapters/gmgn/flowEventNormalizer.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/adapters/gmgn/index.ts ----
New-Item -ItemType Directory -Force -Path 'src/adapters/gmgn' | Out-Null
$content = @'
// GMGN adapter boundary. Raw shapes + normalization live here only.
export type * from "./FlowEventNormalizer.contract.js";
export * from "./flowEventNormalizer.js";

'@
Set-Content -Path 'src/adapters/gmgn/index.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/flow/flowEngine.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/flow' | Out-Null
$content = @'
/**
 * WAR core - Flow Engine (Phase 5).
 *
 * Consumes NORMALIZED flow observations (never raw GMGN, never the raw source position bit).
 * Flow is not reduced to a single smart-money score; it is decomposed.
 *
 * Coverage discipline: flow is ROLLING. Absence of an exit within the observed
 * window is reported as NO_EXIT_OBSERVED - never OBSERVED_NO_EXIT. Absence is not
 * proof of non-occurrence.
 *
 * Pure, total, deterministic. No clock, no randomness, no IO.
 */

import type { Ratio0to1, UnixMillis, DurationMillis } from "../../shared/scalars.js";
import type { FlowObservation } from "../timeline/types.js";
import { toRatio0to1 } from "../../shared/construct.js";

const R0 = 0 as Ratio0to1;
function ratio(n: number): Ratio0to1 {
  const r = toRatio0to1(n);
  return r.ok ? r.value : R0;
}

/** Exit-observation status under ROLLING coverage. */
export type ExitObservation = "EXIT_OBSERVED" | "NO_EXIT_OBSERVED";

/** A detected convergence of makers on one direction within a time window. */
export interface FlowCluster {
  readonly direction: "buy" | "sell";
  readonly distinctMakers: number;
  readonly totalUsd: number;
  readonly windowStart: UnixMillis;
  readonly windowEnd: UnixMillis;
}

/** The decomposed flow picture for a token over its observed window. */
export interface FlowMetrics {
  readonly netFlowUsd: number;
  readonly buyPressureUsd: number;
  readonly sellPressureUsd: number;
  readonly distinctMakers: number;
  /** Ratio of the largest single maker's USD to total USD (0-1). */
  readonly concentration: Ratio0to1;
  /** Fraction of events agreeing with the dominant direction (0-1). */
  readonly persistence: Ratio0to1;
  /** Whether any exit (sell / close) was seen in the window. */
  readonly exitObservation: ExitObservation;
  readonly eventCount: number;
}

export interface FlowConfig {
  /** Minimum distinct makers, same direction, within window -> a cluster. */
  readonly clusterMinMakers: number;
  /** Cluster time window. */
  readonly clusterWindow: DurationMillis;
}

export const DEFAULT_FLOW_CONFIG: FlowConfig = {
  clusterMinMakers: 3,
  clusterWindow: 1_800_000 as DurationMillis, // 30 min
};

/** Deterministic chronological sort by (time, maker, side, amount). */
function sortFlow(obs: readonly FlowObservation[]): FlowObservation[] {
  return [...obs].sort((a, b) => {
    const ta = a.meta.at as number;
    const tb = b.meta.at as number;
    if (ta !== tb) return ta - tb;
    if (a.maker !== b.maker) return a.maker < b.maker ? -1 : 1;
    if (a.side !== b.side) return a.side < b.side ? -1 : 1;
    return a.amountUsd - b.amountUsd;
  });
}

function parseUsd(v: string | number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function computeFlowMetrics(
  observations: readonly FlowObservation[],
): FlowMetrics {
  const obs = sortFlow(observations);

  let buyUsd = 0;
  let sellUsd = 0;
  let sawExit = false;
  const makerUsd = new Map<string, number>();

  for (const o of obs) {
    const usd = parseUsd(o.amountUsd);
    if (o.side === "buy") buyUsd += usd;
    else {
      sellUsd += usd;
      sawExit = true;
    }
    // Also treat an explicit CLOSE direction as an exit signal.
    if (o.direction === "CLOSE") sawExit = true;
    makerUsd.set(o.maker, (makerUsd.get(o.maker) ?? 0) + usd);
  }

  const totalUsd = buyUsd + sellUsd;
  const netFlowUsd = buyUsd - sellUsd;

  let maxMakerUsd = 0;
  for (const v of makerUsd.values()) if (v > maxMakerUsd) maxMakerUsd = v;
  const concentration = totalUsd > 0 ? ratio(maxMakerUsd / totalUsd) : R0;

  // Persistence: fraction of events in the dominant direction.
  const buyCount = obs.filter((o) => o.side === "buy").length;
  const sellCount = obs.length - buyCount;
  const dominant = Math.max(buyCount, sellCount);
  const persistence = obs.length > 0 ? ratio(dominant / obs.length) : R0;

  return {
    netFlowUsd,
    buyPressureUsd: buyUsd,
    sellPressureUsd: sellUsd,
    distinctMakers: makerUsd.size,
    concentration,
    persistence,
    // ROLLING coverage: absence of a sell is NOT proof no exit occurred.
    exitObservation: sawExit ? "EXIT_OBSERVED" : "NO_EXIT_OBSERVED",
    eventCount: obs.length,
  };
}

/**
 * Detect flow clusters: >= clusterMinMakers distinct makers trading the same
 * direction within clusterWindow. Deterministic sliding-window over sorted events.
 */
export function detectFlowClusters(
  observations: readonly FlowObservation[],
  config: FlowConfig = DEFAULT_FLOW_CONFIG,
): readonly FlowCluster[] {
  const clusters: FlowCluster[] = [];
  for (const side of ["buy", "sell"] as const) {
    const sideObs = sortFlow(observations.filter((o) => o.side === side));
    const windowMs = config.clusterWindow as number;

    let start = 0;
    for (let end = 0; end < sideObs.length; end++) {
      const endObs = sideObs[end];
      if (endObs === undefined) continue;
      const endAt = endObs.meta.at as number;
      while (start < end) {
        const startObs = sideObs[start];
        if (startObs === undefined) break;
        if (endAt - (startObs.meta.at as number) > windowMs) start++;
        else break;
      }
      const slice = sideObs.slice(start, end + 1);
      const makers = new Set(slice.map((o) => o.maker));
      if (makers.size >= config.clusterMinMakers) {
        const first = slice[0];
        const last = slice[slice.length - 1];
        if (first === undefined || last === undefined) continue;
        clusters.push({
          direction: side,
          distinctMakers: makers.size,
          totalUsd: slice.reduce((s, o) => s + parseUsd(o.amountUsd), 0),
          windowStart: first.meta.at,
          windowEnd: last.meta.at,
        });
      }
    }
  }
  return clusters;
}

'@
Set-Content -Path 'src/core/flow/flowEngine.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/flow/index.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/flow' | Out-Null
$content = @'
// WAR flow engine.
export * from "./flowEngine.js";

'@
Set-Content -Path 'src/core/flow/index.ts' -Value $content -NoNewline -Encoding utf8

# ---- tests/unit/flowEventNormalizer.test.ts ----
New-Item -ItemType Directory -Force -Path 'tests/unit' | Out-Null
$content = @'
import { describe, it, expect } from "vitest";
import { flowEventNormalizer } from "../../src/adapters/gmgn/flowEventNormalizer.js";
import type {
  RawFollowWalletEvent,
  RawKolSmartMoneyEvent,
} from "../../src/adapters/gmgn/FlowEventNormalizer.contract.js";

function fw(
  side: "buy" | "sell",
  bit: 0 | 1,
): RawFollowWalletEvent {
  return {
    __source: "follow-wallet",
    transaction_hash: "0xabc",
    maker: "walletA",
    side,
    base_address: "TOKEN",
    amount_usd: "1000",
    price_usd: "1.0",
    buy_cost_usd: "0",
    is_open_or_close: bit,
    timestamp: 1700000000,
    quote_address: "SOL",
    base_amount: "1000",
    quote_amount: "5",
    price_change: "1.2",
    price_now: "1.2",
    maker_info: { tags: ["kol"], tag_rank: { kol: 10 } },
  };
}

function km(
  source: "kol" | "smartmoney",
  side: "buy" | "sell",
  bit: 0 | 1,
): RawKolSmartMoneyEvent {
  return {
    __source: source,
    transaction_hash: "0xdef",
    maker: "walletB",
    side,
    base_address: "TOKEN",
    amount_usd: "2000",
    price_usd: "1.0",
    buy_cost_usd: "0",
    is_open_or_close: bit,
    timestamp: 1700000001,
    token_amount: "2000",
    maker_info: { tags: ["smart_degen"] },
  };
}

describe("FlowEventNormalizer - section D follow-wallet (bit = FULLNESS)", () => {
  it("bit 1 + buy -> FULL_OPEN", () => {
    const n = flowEventNormalizer.normalize(fw("buy", 1));
    expect(n.positionEvent).toBe("FULL_OPEN");
    expect(n.fullness).toBe("FULL");
    expect(n.direction).toBe("OPEN");
  });
  it("bit 1 + sell -> FULL_CLOSE", () => {
    const n = flowEventNormalizer.normalize(fw("sell", 1));
    expect(n.positionEvent).toBe("FULL_CLOSE");
    expect(n.fullness).toBe("FULL");
    expect(n.direction).toBe("CLOSE");
  });
  it("bit 0 + buy -> PARTIAL_ADD", () => {
    const n = flowEventNormalizer.normalize(fw("buy", 0));
    expect(n.positionEvent).toBe("PARTIAL_ADD");
    expect(n.fullness).toBe("PARTIAL");
  });
  it("bit 0 + sell -> PARTIAL_REDUCE", () => {
    const n = flowEventNormalizer.normalize(fw("sell", 0));
    expect(n.positionEvent).toBe("PARTIAL_REDUCE");
    expect(n.fullness).toBe("PARTIAL");
  });
});

describe("FlowEventNormalizer - section D kol/smartmoney (bit = DIRECTION, fullness UNKNOWN)", () => {
  it("bit 0 -> OPEN_OR_ADD, fullness UNKNOWN (I1: never FULL/PARTIAL)", () => {
    for (const src of ["kol", "smartmoney"] as const) {
      const n = flowEventNormalizer.normalize(km(src, "buy", 0));
      expect(n.positionEvent).toBe("OPEN_OR_ADD");
      expect(n.fullness).toBe("UNKNOWN");
      expect(n.direction).toBe("OPEN");
    }
  });
  it("bit 1 -> CLOSE_OR_REDUCE, fullness UNKNOWN", () => {
    const n = flowEventNormalizer.normalize(km("smartmoney", "sell", 1));
    expect(n.positionEvent).toBe("CLOSE_OR_REDUCE");
    expect(n.fullness).toBe("UNKNOWN");
    expect(n.direction).toBe("CLOSE");
  });
  it("I1: kol/smartmoney NEVER produce FULL_* or PARTIAL_* across all bit/side combos", () => {
    const forbidden = new Set([
      "FULL_OPEN", "FULL_CLOSE", "PARTIAL_ADD", "PARTIAL_REDUCE",
    ]);
    for (const src of ["kol", "smartmoney"] as const) {
      for (const side of ["buy", "sell"] as const) {
        for (const bit of [0, 1] as const) {
          const n = flowEventNormalizer.normalize(km(src, side, bit));
          expect(forbidden.has(n.positionEvent)).toBe(false);
        }
      }
    }
  });
});

describe("FlowEventNormalizer - invariants", () => {
  it("I3: the raw bit name never leaks into the normalized output", () => {
    const n = flowEventNormalizer.normalize(fw("buy", 1));
    expect(JSON.stringify(n).includes("is_open_or_close")).toBe(false);
  });
  it("I4: interpretedUnder always equals source", () => {
    expect(flowEventNormalizer.normalize(fw("buy", 1)).interpretedUnder).toBe(
      "follow-wallet",
    );
    expect(
      flowEventNormalizer.normalize(km("kol", "buy", 0)).interpretedUnder,
    ).toBe("kol");
  });
  it("is deterministic", () => {
    const a = flowEventNormalizer.normalize(fw("sell", 0));
    const b = flowEventNormalizer.normalize(fw("sell", 0));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

'@
Set-Content -Path 'tests/unit/flowEventNormalizer.test.ts' -Value $content -NoNewline -Encoding utf8

# ---- tests/unit/flowEngine.test.ts ----
New-Item -ItemType Directory -Force -Path 'tests/unit' | Out-Null
$content = @'
import { describe, it, expect } from "vitest";
import {
  computeFlowMetrics,
  detectFlowClusters,
  DEFAULT_FLOW_CONFIG,
} from "../../src/core/flow/flowEngine.js";
import { flowObs } from "../golden/fixtures.js";

describe("computeFlowMetrics", () => {
  it("computes net flow, pressures, and distinct makers", () => {
    const m = computeFlowMetrics([
      flowObs(1000, "A", "buy", 500),
      flowObs(2000, "B", "buy", 1000),
      flowObs(3000, "A", "sell", 300),
    ]);
    expect(m.buyPressureUsd).toBe(1500);
    expect(m.sellPressureUsd).toBe(300);
    expect(m.netFlowUsd).toBe(1200);
    expect(m.distinctMakers).toBe(2);
    expect(m.eventCount).toBe(3);
  });

  it("reports NO_EXIT_OBSERVED when only buys are seen (ROLLING discipline)", () => {
    const m = computeFlowMetrics([
      flowObs(1000, "A", "buy", 500),
      flowObs(2000, "B", "buy", 1000),
    ]);
    expect(m.exitObservation).toBe("NO_EXIT_OBSERVED");
  });

  it("reports EXIT_OBSERVED when a sell appears", () => {
    const m = computeFlowMetrics([
      flowObs(1000, "A", "buy", 500),
      flowObs(2000, "A", "sell", 500),
    ]);
    expect(m.exitObservation).toBe("EXIT_OBSERVED");
  });

  it("concentration reflects a dominant single maker", () => {
    const m = computeFlowMetrics([
      flowObs(1000, "whale", "buy", 9000),
      flowObs(2000, "small", "buy", 1000),
    ]);
    expect(m.concentration as number).toBeCloseTo(0.9, 12);
  });

  it("empty input yields zeroes and NO_EXIT_OBSERVED, not fabricated values", () => {
    const m = computeFlowMetrics([]);
    expect(m.eventCount).toBe(0);
    expect(m.netFlowUsd).toBe(0);
    expect(m.distinctMakers).toBe(0);
    expect(m.exitObservation).toBe("NO_EXIT_OBSERVED");
  });

  it("is deterministic and order-independent", () => {
    const forward = [
      flowObs(1000, "A", "buy", 500),
      flowObs(2000, "B", "sell", 300),
      flowObs(3000, "C", "buy", 700),
    ];
    const a = computeFlowMetrics(forward);
    const b = computeFlowMetrics([...forward].reverse());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("detectFlowClusters", () => {
  it("flags 3 distinct makers buying within the window as a cluster", () => {
    const clusters = detectFlowClusters([
      flowObs(1_000_000, "A", "buy", 100),
      flowObs(1_000_100, "B", "buy", 100),
      flowObs(1_000_200, "C", "buy", 100),
    ]);
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    const buyCluster = clusters.find((c) => c.direction === "buy");
    expect(buyCluster?.distinctMakers).toBe(3);
  });

  it("does not flag the same maker repeated (distinct makers, not events)", () => {
    const clusters = detectFlowClusters([
      flowObs(1_000_000, "A", "buy", 100),
      flowObs(1_000_100, "A", "buy", 100),
      flowObs(1_000_200, "A", "buy", 100),
    ]);
    expect(clusters.find((c) => c.direction === "buy")).toBeUndefined();
  });

  it("does not flag makers spread beyond the cluster window", () => {
    const far = DEFAULT_FLOW_CONFIG.clusterWindow as number;
    const clusters = detectFlowClusters([
      flowObs(0, "A", "buy", 100),
      flowObs(far + 1000, "B", "buy", 100),
      flowObs(2 * far + 2000, "C", "buy", 100),
    ]);
    expect(clusters.find((c) => c.direction === "buy")).toBeUndefined();
  });

  it("is deterministic", () => {
    const evs = [
      flowObs(1_000_000, "A", "buy", 100),
      flowObs(1_000_100, "B", "buy", 100),
      flowObs(1_000_200, "C", "buy", 100),
    ];
    expect(JSON.stringify(detectFlowClusters(evs))).toBe(
      JSON.stringify(detectFlowClusters([...evs].reverse())),
    );
  });
});

'@
Set-Content -Path 'tests/unit/flowEngine.test.ts' -Value $content -NoNewline -Encoding utf8

# ---- README.md ----
$content = @'
# WAR Engine

Deterministic temporal market-intelligence engine. Renderer-agnostic core.

- **Intelligence contract:** V3.2 (FROZEN)
- **GMGN evidence:** sealed at commit `147c070` — see `PHASE_0_SEALED.md`
- **Current phase:** Phase 5 — Flow Engine (complete)

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

Write-Host 'Phase 5 files installed.' -ForegroundColor Green
Write-Host 'Next: npm test   (expect 110 passed)' -ForegroundColor Yellow