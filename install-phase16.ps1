# ============================================================
# WAR - Phase 16 Installer (GMGN Adapter)
# Run from inside war\ :  powershell -ExecutionPolicy Bypass -File .\install-phase16.ps1
# Requires Phase 13-15 (full core) already present.
# ============================================================

$ErrorActionPreference = 'Stop'
if (-not (Test-Path 'package.json')) { Write-Error 'Run from inside the war/ folder.'; exit 1 }
if (-not (Test-Path 'src\replay\replay.ts')) { Write-Error 'Full core (Phase 13-15) missing. Install it first.'; exit 1 }
Write-Host 'Installing Phase 16 (GMGN Adapter)...' -ForegroundColor Cyan

# ---- src/adapters/gmgn/gmgnParsers.ts ----
New-Item -ItemType Directory -Force -Path 'src/adapters/gmgn' | Out-Null
$content = @'
/**
 * WAR adapter - GMGN parsers (Phase 16).
 *
 * Converts raw gmgn-cli JSON into normalized core observations. This is the
 * boundary: raw GMGN shapes exist ONLY here. hot_level is dropped here and never
 * reaches the core. is_open_or_close is normalized here (via flowEventNormalizer)
 * per source semantics.
 *
 * Confirmed field facts (sealed at 147c070):
 *   kline: time(ms number), open/close/high/low(string USD), volume(string USD),
 *          amount(string token units).
 * Pure, total, deterministic. Parsing only; the network runner is separate.
 */

import type {
  MarketObservation,
  AnalyticsObservation,
  FlowObservation,
} from "../../core/timeline/types.js";
import type { UnixMillis } from "../../shared/scalars.js";
import { flowEventNormalizer } from "./flowEventNormalizer.js";
import type { RawFlowEvent } from "./FlowEventNormalizer.contract.js";

/** Safely coerce a possibly-string numeric field to a finite number, or null. */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Raw kline row as returned by `gmgn-cli market kline`. */
export interface RawKline {
  readonly time: number;
  readonly open: string;
  readonly close: string;
  readonly high: string;
  readonly low: string;
  readonly volume: string;
  readonly amount: string;
}

/** Parse one raw kline row into a MarketObservation. Returns null if malformed. */
export function parseKline(raw: RawKline): MarketObservation | null {
  const time = num(raw.time);
  const open = num(raw.open);
  const close = num(raw.close);
  const high = num(raw.high);
  const low = num(raw.low);
  const volume = num(raw.volume);
  const amount = num(raw.amount);

  if (
    time === null || open === null || close === null ||
    high === null || low === null || volume === null || amount === null
  ) {
    return null; // malformed -> explicit null, never a fabricated zero row
  }

  return {
    meta: {
      at: time as UnixMillis, // already ms per sealed contract
      temporalOrigin: "GMGN_HISTORICAL",
      coverage: "COMPLETE",
      provenance: "market.kline",
    },
    open, high, low, close,
    volumeUsd: volume,
    amountTokens: amount,
  };
}

/** Raw trending row (subset). hot_level intentionally NOT read into the core. */
export interface RawTrending {
  readonly price?: unknown;
  readonly market_cap?: unknown;
  readonly liquidity?: unknown;
  readonly holder_count?: unknown;
  readonly swaps?: unknown;
  readonly buys?: unknown;
  readonly sells?: unknown;
  readonly smart_degen_count?: unknown;
  readonly renowned_count?: unknown;
  // NOTE: hot_level is deliberately absent from this interface - banned from core.
}

/** Parse a trending row into an AnalyticsObservation at sampling time `sampledAt`. */
export function parseTrending(
  raw: RawTrending,
  sampledAt: UnixMillis,
): AnalyticsObservation | null {
  const price = num(raw.price);
  const marketCap = num(raw.market_cap);
  const liquidity = num(raw.liquidity);
  const holderCount = num(raw.holder_count);
  const swaps = num(raw.swaps);
  const buys = num(raw.buys);
  const sells = num(raw.sells);
  const smartDegenCount = num(raw.smart_degen_count);
  const renownedCount = num(raw.renowned_count);

  if (price === null || marketCap === null || liquidity === null) {
    return null;
  }

  return {
    meta: {
      at: sampledAt,
      temporalOrigin: "WAR_SAMPLED",
      coverage: "SAMPLED",
      provenance: "market.trending",
    },
    price,
    marketCap,
    liquidity,
    holderCount: holderCount ?? 0,
    swaps: swaps ?? 0,
    buys: buys ?? 0,
    sells: sells ?? 0,
    smartDegenCount: smartDegenCount ?? 0,
    renownedCount: renownedCount ?? 0,
  };
}

/**
 * Parse a raw track event into a normalized FlowObservation. Routes through the
 * sealed flowEventNormalizer so is_open_or_close is interpreted per source (Sec D).
 * Returns null if the amount is unparseable.
 */
export function parseFlowEvent(raw: RawFlowEvent): FlowObservation | null {
  const normalized = flowEventNormalizer.normalize(raw);
  const amountUsd = num(normalized.amountUsd);
  const priceUsd = num(normalized.priceUsd);
  if (amountUsd === null || priceUsd === null) return null;

  return {
    meta: {
      at: normalized.timestamp as UnixMillis,
      temporalOrigin: "GMGN_EVENT",
      coverage: "ROLLING",
      provenance:
        normalized.source === "follow-wallet"
          ? "track.follow-wallet"
          : normalized.source === "kol"
            ? "track.kol"
            : "track.smartmoney",
    },
    maker: normalized.maker,
    side: normalized.side,
    amountUsd,
    priceUsd,
    positionEvent: normalized.positionEvent,
    fullness: normalized.fullness,
    direction: normalized.direction,
  };
}

/** Assert a raw object does not carry hot_level into anything the core sees. */
export function stripBannedFields<T extends Record<string, unknown>>(
  raw: T,
): Omit<T, "hot_level"> {
  const clone: Record<string, unknown> = { ...raw };
  delete clone["hot_level"];
  return clone as Omit<T, "hot_level">;
}

'@
Set-Content -Path 'src/adapters/gmgn/gmgnParsers.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/adapters/gmgn/gmgnRunner.ts ----
New-Item -ItemType Directory -Force -Path 'src/adapters/gmgn' | Out-Null
$content = @'
/**
 * WAR adapter - GMGN CLI runner (Phase 16).
 *
 * A thin, INJECTABLE wrapper over `gmgn-cli`. The actual command executor is
 * passed in, so this module is fully testable without a network or the CLI
 * installed. The core never imports this - it lives at the adapter boundary.
 *
 * Rate limits (sealed at 147c070): leaky bucket rate=20 cap=20 for market/track/
 * portfolio; weights per route. On 429, honor X-RateLimit-Reset / reset_at.
 */

import type { Chain } from "../../shared/scalars.js";

/** Error taxonomy - callers distinguish these explicitly (never collapse to 0). */
export type GmgnErrorKind =
  | "AUTH_ERROR"
  | "RATE_LIMIT"
  | "MALFORMED_FIELD"
  | "MISSING_FIELD"
  | "CHAIN_ERROR"
  | "FORMAT_ERROR"
  | "CLI_MISSING"
  | "NETWORK_ERROR";

export interface GmgnError {
  readonly ok: false;
  readonly kind: GmgnErrorKind;
  readonly message: string;
  /** For RATE_LIMIT: when the bucket resets (unix seconds), if known. */
  readonly resetAt?: number;
}

export interface GmgnSuccess<T> {
  readonly ok: true;
  readonly data: T;
}

export type GmgnResult<T> = GmgnSuccess<T> | GmgnError;

/** The injected executor: runs argv, returns stdout or throws a typed-ish error. */
export interface CliExecutor {
  run(argv: readonly string[]): Promise<CliRunResult>;
}

export interface CliRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Optional response headers surfaced by the CLI (e.g. X-RateLimit-Reset). */
  readonly headers?: Readonly<Record<string, string>>;
}

/** Weights per route group (sealed). Used for local rate accounting. */
export const ROUTE_WEIGHTS: Readonly<Record<string, number>> = {
  kline: 2,
  trending: 1,
  trenches: 3,
  signal: 3,
  "hot-searches": 3,
  search: 1,
  "follow-wallet": 3,
  kol: 1,
  smartmoney: 1,
  "token-holders": 5,
  "token-traders": 5,
};

export const RATE_LIMIT = { rate: 20, capacity: 20 } as const;

function classifyError(res: CliRunResult): GmgnError {
  const text = `${res.stderr} ${res.stdout}`.toLowerCase();
  if (res.exitCode === 0) {
    return { ok: false, kind: "FORMAT_ERROR", message: "empty/unparseable output" };
  }
  if (text.includes("command not found") || text.includes("not recognized")) {
    return { ok: false, kind: "CLI_MISSING", message: "gmgn-cli not installed" };
  }
  if (text.includes("401") || text.includes("403") || text.includes("auth")) {
    return { ok: false, kind: "AUTH_ERROR", message: "authentication failed" };
  }
  if (text.includes("429") || text.includes("rate limit")) {
    const resetAt = parseResetAt(res.headers);
    return resetAt === null
      ? { ok: false, kind: "RATE_LIMIT", message: "rate limited" }
      : { ok: false, kind: "RATE_LIMIT", message: "rate limited", resetAt };
  }
  if (text.includes("chain")) {
    return { ok: false, kind: "CHAIN_ERROR", message: "chain error" };
  }
  return { ok: false, kind: "NETWORK_ERROR", message: res.stderr || "unknown error" };
}

function parseResetAt(headers?: Readonly<Record<string, string>>): number | null {
  if (headers === undefined) return null;
  const raw = headers["x-ratelimit-reset"] ?? headers["X-RateLimit-Reset"];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Run a gmgn-cli command and parse JSON stdout. Deterministic given the injected
 * executor. Returns a typed result - errors are classified, never thrown to the
 * core, never coerced to zero.
 */
export async function runGmgnJson<T>(
  exec: CliExecutor,
  argv: readonly string[],
): Promise<GmgnResult<T>> {
  let res: CliRunResult;
  try {
    res = await exec.run(argv);
  } catch (e) {
    return {
      ok: false,
      kind: "NETWORK_ERROR",
      message: e instanceof Error ? e.message : "executor threw",
    };
  }

  if (res.exitCode !== 0) return classifyError(res);

  const trimmed = res.stdout.trim();
  if (trimmed.length === 0) {
    return { ok: false, kind: "FORMAT_ERROR", message: "empty stdout" };
  }

  try {
    const data = JSON.parse(trimmed) as T;
    return { ok: true, data };
  } catch {
    return { ok: false, kind: "FORMAT_ERROR", message: "invalid JSON" };
  }
}

/** Build argv for `gmgn-cli market kline`. */
export function klineArgv(chain: Chain, address: string, resolution: string): string[] {
  return ["market", "kline", "--chain", chain, "--address", address, "--resolution", resolution];
}

/** Build argv for `gmgn-cli market trending`. */
export function trendingArgv(chain: Chain, interval: string): string[] {
  return ["market", "trending", "--chain", chain, "--interval", interval];
}

/** Build argv for `gmgn-cli track <sub>`. */
export function trackArgv(sub: "kol" | "smartmoney" | "follow-wallet", chain: Chain): string[] {
  return ["track", sub, "--chain", chain];
}

'@
Set-Content -Path 'src/adapters/gmgn/gmgnRunner.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/adapters/gmgn/index.ts ----
New-Item -ItemType Directory -Force -Path 'src/adapters/gmgn' | Out-Null
$content = @'
// GMGN adapter boundary. Raw shapes + normalization + CLI runner live here only.
export type * from "./FlowEventNormalizer.contract.js";
export * from "./flowEventNormalizer.js";
export * from "./gmgnParsers.js";
export * from "./gmgnRunner.js";

'@
Set-Content -Path 'src/adapters/gmgn/index.ts' -Value $content -NoNewline -Encoding utf8

# ---- tests/unit/gmgnAdapter.test.ts ----
New-Item -ItemType Directory -Force -Path 'tests/unit' | Out-Null
$content = @'
import { describe, it, expect } from "vitest";
import {
  parseKline,
  parseTrending,
  parseFlowEvent,
  stripBannedFields,
} from "../../src/adapters/gmgn/gmgnParsers.js";
import type { RawKline, RawTrending } from "../../src/adapters/gmgn/gmgnParsers.js";
import {
  runGmgnJson,
  klineArgv,
  trackArgv,
  ROUTE_WEIGHTS,
  RATE_LIMIT,
} from "../../src/adapters/gmgn/gmgnRunner.js";
import type {
  CliExecutor,
  CliRunResult,
} from "../../src/adapters/gmgn/gmgnRunner.js";
import type {
  RawKolSmartMoneyEvent,
  RawFollowWalletEvent,
} from "../../src/adapters/gmgn/FlowEventNormalizer.contract.js";
import type { UnixMillis } from "../../src/shared/scalars.js";

describe("parseKline", () => {
  const raw: RawKline = {
    time: 1_700_000_000_000,
    open: "1.5",
    close: "1.8",
    high: "2.0",
    low: "1.4",
    volume: "50000", // USD
    amount: "27000", // token units
  };

  it("parses string numerics and keeps ms time", () => {
    const o = parseKline(raw);
    expect(o).not.toBeNull();
    expect(o?.close).toBe(1.8);
    expect(o?.volumeUsd).toBe(50000);
    expect(o?.amountTokens).toBe(27000);
    expect(o?.meta.coverage).toBe("COMPLETE");
    expect(o?.meta.at as number).toBe(1_700_000_000_000);
  });

  it("returns null on a malformed row (never a fabricated zero candle)", () => {
    const bad = { ...raw, close: "not-a-number" };
    expect(parseKline(bad)).toBeNull();
  });
});

describe("parseTrending - hot_level never enters the core", () => {
  it("parses core analytics fields", () => {
    const raw: RawTrending = {
      price: "0.0002",
      market_cap: "2000000",
      liquidity: "80000",
      holder_count: 1500,
      swaps: 400,
      buys: 250,
      sells: 150,
      smart_degen_count: 8,
      renowned_count: 3,
    };
    const o = parseTrending(raw, 1_700_000_000_000 as UnixMillis);
    expect(o?.price).toBe(0.0002);
    expect(o?.meta.coverage).toBe("SAMPLED");
  });

  it("stripBannedFields removes hot_level so it cannot leak", () => {
    const withHot = { price: "1", hot_level: 99 } as Record<string, unknown>;
    const stripped = stripBannedFields(withHot);
    expect("hot_level" in stripped).toBe(false);
  });

  it("the output observation contains no hot_level key", () => {
    const raw = { price: "1", market_cap: "1", liquidity: "1", hot_level: 99 } as RawTrending;
    const o = parseTrending(raw, 0 as UnixMillis);
    expect(JSON.stringify(o).includes("hot_level")).toBe(false);
  });
});

describe("parseFlowEvent - Sec D applied to live-shaped data", () => {
  it("follow-wallet full buy -> FULL_OPEN via normalizer", () => {
    const raw: RawFollowWalletEvent = {
      __source: "follow-wallet",
      transaction_hash: "0x1", maker: "w1", side: "buy",
      base_address: "T", amount_usd: "1000", price_usd: "1", buy_cost_usd: "0",
      is_open_or_close: 1, timestamp: 1_700_000_000_000,
      quote_address: "SOL", base_amount: "1000", quote_amount: "5",
      price_change: "1", price_now: "1", maker_info: { tags: [] },
    };
    const o = parseFlowEvent(raw);
    expect(o?.positionEvent).toBe("FULL_OPEN");
    expect(o?.meta.provenance).toBe("track.follow-wallet");
    expect(o?.meta.coverage).toBe("ROLLING");
  });

  it("kol event fullness stays UNKNOWN (Sec D I1 preserved through the parser)", () => {
    const raw: RawKolSmartMoneyEvent = {
      __source: "kol",
      transaction_hash: "0x2", maker: "w2", side: "buy",
      base_address: "T", amount_usd: "2000", price_usd: "1", buy_cost_usd: "0",
      is_open_or_close: 0, timestamp: 1_700_000_000_001,
      token_amount: "2000", maker_info: { tags: ["smart_degen"] },
    };
    const o = parseFlowEvent(raw);
    expect(o?.positionEvent).toBe("OPEN_OR_ADD");
    expect(o?.fullness).toBe("UNKNOWN");
  });
});

describe("runGmgnJson - error taxonomy, never throws to core", () => {
  const execOf = (res: Partial<CliRunResult>): CliExecutor => ({
    run: async () => ({
      exitCode: res.exitCode ?? 0,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      ...(res.headers !== undefined ? { headers: res.headers } : {}),
    }),
  });

  it("parses valid JSON stdout", async () => {
    const r = await runGmgnJson<{ x: number }>(
      execOf({ exitCode: 0, stdout: '{"x":1}' }),
      klineArgv("sol", "T", "1m"),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.x).toBe(1);
  });

  it("classifies 429 as RATE_LIMIT and surfaces reset time", async () => {
    const r = await runGmgnJson(
      execOf({ exitCode: 1, stderr: "HTTP 429 rate limit", headers: { "x-ratelimit-reset": "1700000123" } }),
      trackArgv("kol", "sol"),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("RATE_LIMIT");
      expect(r.resetAt).toBe(1700000123);
    }
  });

  it("classifies auth failures", async () => {
    const r = await runGmgnJson(execOf({ exitCode: 1, stderr: "401 Unauthorized" }), []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("AUTH_ERROR");
  });

  it("classifies missing CLI", async () => {
    const r = await runGmgnJson(execOf({ exitCode: 127, stderr: "command not found" }), []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("CLI_MISSING");
  });

  it("classifies invalid JSON as FORMAT_ERROR", async () => {
    const r = await runGmgnJson(execOf({ exitCode: 0, stdout: "not json" }), []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("FORMAT_ERROR");
  });

  it("a thrown executor becomes NETWORK_ERROR, not an exception to the core", async () => {
    const exec: CliExecutor = { run: async () => { throw new Error("boom"); } };
    const r = await runGmgnJson(exec, []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("NETWORK_ERROR");
  });
});

describe("sealed rate-limit facts", () => {
  it("kline weight is 2, track weights are 1/1/3, holders/traders 5", () => {
    expect(ROUTE_WEIGHTS["kline"]).toBe(2);
    expect(ROUTE_WEIGHTS["kol"]).toBe(1);
    expect(ROUTE_WEIGHTS["smartmoney"]).toBe(1);
    expect(ROUTE_WEIGHTS["follow-wallet"]).toBe(3);
    expect(ROUTE_WEIGHTS["token-holders"]).toBe(5);
  });
  it("leaky bucket is 20/20", () => {
    expect(RATE_LIMIT.rate).toBe(20);
    expect(RATE_LIMIT.capacity).toBe(20);
  });
});

'@
Set-Content -Path 'tests/unit/gmgnAdapter.test.ts' -Value $content -NoNewline -Encoding utf8

# ---- README.md ----
$content = @'
# WAR Engine

Deterministic temporal market-intelligence engine. Renderer-agnostic core.

- **Intelligence contract:** V3.2 (FROZEN)
- **GMGN evidence:** sealed at commit `147c070` — see `PHASE_0_SEALED.md`
- **Current phase:** Phase 16 - GMGN Adapter (complete)

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

Write-Host 'Phase 16 installed.' -ForegroundColor Green
Write-Host 'Next: npm test   (expect 257 passed)' -ForegroundColor Yellow