# ============================================================
# WAR — Phase 2 Installer (Domain Types)
# Run from inside the war\ folder:  .\install-phase2.ps1
# Creates/overwrites all Phase 2 files in their correct paths.
# ============================================================

$ErrorActionPreference = 'Stop'
if (-not (Test-Path 'package.json')) { Write-Error 'Run this from inside the war/ folder.'; exit 1 }
Write-Host 'Installing Phase 2 domain types...' -ForegroundColor Cyan

# ---- src/shared/scalars.ts ----
New-Item -ItemType Directory -Force -Path 'src/shared' | Out-Null
$content = @'
/**
 * WAR core — shared scalar contracts (Phase 2, types only).
 *
 * Branded nominal types make illegal states unrepresentable at the boundary.
 * A raw `number` cannot be assigned where a `Score0to100` is expected; it must
 * pass through a validating constructor (implemented in a later phase). These
 * brands carry no runtime cost — they are erased at compile time.
 *
 * LAW: Missing data is NEVER 0. Absence is modelled explicitly (see Maybe / Availability).
 */

declare const BRAND: unique symbol;
type Brand<T, B extends string> = T & { readonly [BRAND]: B };

/** A score constrained to the inclusive range [0, 100]. Never NaN, never Infinity. */
export type Score0to100 = Brand<number, "Score0to100">;

/** A ratio constrained to the inclusive range [0, 1]. Never NaN, never Infinity. */
export type Ratio0to1 = Brand<number, "Ratio0to1">;

/** A finite real number that is guaranteed neither NaN nor Infinity. */
export type FiniteNumber = Brand<number, "FiniteNumber">;

/** Unix timestamp in MILLISECONDS. WAR normalizes all time to ms internally. */
export type UnixMillis = Brand<number, "UnixMillis">;

/** Unix timestamp in SECONDS — only used at the adapter boundary before normalization. */
export type UnixSeconds = Brand<number, "UnixSeconds">;

/** A duration in milliseconds (non-negative). */
export type DurationMillis = Brand<number, "DurationMillis">;

/** A chain-scoped token contract address (opaque; validated at adapter). */
export type TokenAddress = Brand<string, "TokenAddress">;

/** A wallet address (opaque; validated at adapter). */
export type WalletAddress = Brand<string, "WalletAddress">;

/** The chains WAR supports, per sealed GMGN evidence. */
export type Chain = "sol" | "bsc" | "base" | "eth";

/**
 * Explicit optionality. Distinguishes "we looked and there is nothing"
 * (present:false) from "we have a value" (present:true). Prevents the
 * missing→zero collapse the intelligence contract forbids.
 */
export type Maybe<T> =
  | { readonly present: true; readonly value: T }
  | { readonly present: false };

/**
 * A measured quantity that may be unavailable, always paired with an
 * availability flag so downstream code cannot silently treat absence as 0.
 */
export interface Measured<T> {
  readonly value: T | null;
  readonly available: boolean;
}

'@
Set-Content -Path 'src/shared/scalars.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/shared/quality.ts ----
New-Item -ItemType Directory -Force -Path 'src/shared' | Out-Null
$content = @'
/**
 * WAR core — data quality + versioning (Phase 2, types only).
 */

import type { UnixMillis } from "./scalars.js";

/**
 * Data quality classification. Per V3.2: the engine must distinguish these,
 * and missing data must not silently become zero.
 */
export type DataQuality =
  | "COMPLETE"
  | "PARTIAL"
  | "STALE"
  | "CONFLICTED"
  | "INSUFFICIENT";

/**
 * Version identity stamped on every engine output so historical results stay
 * interpretable as models evolve. All fields required — an unstamped output
 * is not a valid engine output.
 */
export interface ModelVersions {
  readonly engineVersion: string;
  readonly powerModelVersion: string;
  readonly stateModelVersion: string;
  readonly physicsModelVersion: string;
  readonly configurationVersion: string;
}

/** A quality assessment attached to a computed value, with the moment it was assessed. */
export interface QualityStamp {
  readonly quality: DataQuality;
  readonly assessedAt: UnixMillis;
  /** Human-readable reasons the quality was classified this way (explainability). */
  readonly reasons: readonly string[];
}

'@
Set-Content -Path 'src/shared/quality.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/shared/index.ts ----
New-Item -ItemType Directory -Force -Path 'src/shared' | Out-Null
$content = @'
// WAR shared scalars + quality contracts.
export type * from "./scalars.js";
export type * from "./quality.js";

'@
Set-Content -Path 'src/shared/index.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/timeline/types.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/timeline' | Out-Null
$content = @'
/**
 * WAR core — Timeline substrate model (Phase 2, types only).
 *
 * The three confirmed core substrates (V3.2 §15): MARKET, FLOW, ANALYTICS.
 * Each observation carries where it came from in time (TemporalOrigin) and how
 * completely that lane covers time (Coverage). Coverage is first-class: a FLOW
 * lane is ROLLING, never COMPLETE — its window must never be treated as a full
 * historical record.
 */

import type {
  Chain,
  TokenAddress,
  UnixMillis,
  DurationMillis,
} from "../../shared/scalars.js";

/** Where an observation originates on the time axis. */
export type TemporalOrigin =
  | "GMGN_HISTORICAL" // MARKET: real historical series (kline)
  | "GMGN_EVENT" // FLOW: captured event stream
  | "WAR_SAMPLED" // ANALYTICS: WAR-sampled snapshots of GMGN analytics
  | "WAR_DERIVED"; // anything WAR computes from the above

/**
 * How completely a lane covers the time range it claims.
 * - COMPLETE: full historical coverage (kline).
 * - ROLLING: a moving capture window; absence of an event is NOT proof of non-occurrence.
 * - SAMPLED: point-in-time snapshots at WAR's sampling cadence, with gaps between.
 * - DERIVED: coverage inherited from whatever inputs produced it.
 */
export type Coverage = "COMPLETE" | "ROLLING" | "SAMPLED" | "DERIVED";

/** Provenance tag: identifies the exact source command/lane an observation came from. */
export type Provenance =
  | "market.kline"
  | "market.trending"
  | "track.kol"
  | "track.smartmoney"
  | "track.follow-wallet"
  | "war.derived";

/** Common metadata carried by every observation regardless of lane. */
export interface ObservationMeta {
  readonly at: UnixMillis;
  readonly temporalOrigin: TemporalOrigin;
  readonly coverage: Coverage;
  readonly provenance: Provenance;
}

/** MARKET lane — historical OHLCV. Coverage is COMPLETE. */
export interface MarketObservation {
  readonly meta: ObservationMeta;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  /** USD value of trades in the candle (GMGN `volume`). */
  readonly volumeUsd: number;
  /** Token units traded in the candle (GMGN `amount`). */
  readonly amountTokens: number;
}

/**
 * ANALYTICS lane — WAR-sampled snapshot of GMGN analytics.
 * Coverage is SAMPLED. Fields are intentionally a curated subset of the
 * confirmed trending schema; the trending-intensity heat field is deliberately
 * excluded (banned from core — un-normalized, time-incomparable, dies at adapter).
 */
export interface AnalyticsObservation {
  readonly meta: ObservationMeta;
  readonly price: number;
  readonly marketCap: number;
  readonly liquidity: number;
  readonly holderCount: number;
  readonly swaps: number;
  readonly buys: number;
  readonly sells: number;
  readonly smartDegenCount: number;
  readonly renownedCount: number;
}

/**
 * FLOW lane — a normalized position event. Coverage is ROLLING.
 * This carries the NORMALIZED classification, never the raw source position bit.
 * (The raw→normalized mapping lives at the adapter; see FlowEventNormalizer.contract.)
 */
export interface FlowObservation {
  readonly meta: ObservationMeta;
  readonly maker: string;
  readonly side: "buy" | "sell";
  readonly amountUsd: number;
  readonly priceUsd: number;
  /** Normalized position classification — see FlowEventNormalizer contract. */
  readonly positionEvent: PositionEventClass;
  readonly fullness: "FULL" | "PARTIAL" | "UNKNOWN";
  readonly direction: "OPEN" | "CLOSE" | "UNKNOWN";
}

/** Mirror of the normalizer's output classification, for core-side consumption. */
export type PositionEventClass =
  | "FULL_OPEN"
  | "FULL_CLOSE"
  | "PARTIAL_ADD"
  | "PARTIAL_REDUCE"
  | "OPEN_OR_ADD"
  | "CLOSE_OR_REDUCE"
  | "UNKNOWN";

/**
 * A token's full timeline: three lanes with distinct coverage semantics.
 * The identity (chain + address) plus the sampled window bounds.
 */
export interface TokenTimeline {
  readonly chain: Chain;
  readonly address: TokenAddress;
  readonly market: readonly MarketObservation[];
  readonly analytics: readonly AnalyticsObservation[];
  readonly flow: readonly FlowObservation[];
  /** Bounds of the window this timeline represents. */
  readonly windowStart: UnixMillis;
  readonly windowEnd: UnixMillis;
  /** How long the FLOW rolling capture has actually been observing. */
  readonly flowObservedFor: DurationMillis;
}

'@
Set-Content -Path 'src/core/timeline/types.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/timeline/index.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/timeline' | Out-Null
$content = @'
// WAR timeline substrate (MARKET / FLOW / ANALYTICS).
export type * from "./types.js";

'@
Set-Content -Path 'src/core/timeline/index.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/temporal/types.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/temporal' | Out-Null
$content = @'
/**
 * WAR core — temporal derivatives + trajectory (Phase 2, types only).
 *
 * Time-blindness is the fatal flaw V3.2 was built to avoid. Every usable signal
 * can produce derivatives. A derivative is NEVER fabricated: if history is
 * insufficient, the confidence/method must say so, not invent a number.
 */

import type {
  Score0to100,
  Ratio0to1,
  FiniteNumber,
  DurationMillis,
} from "../../shared/scalars.js";

/** The method used to compute a derivative — carried for explainability. */
export type DerivativeMethod =
  | "FINITE_DIFFERENCE"
  | "REGRESSION_SLOPE"
  | "EWMA"
  | "INSUFFICIENT_HISTORY";

/** Direction of movement of a signal. */
export type SignalDirection = "UP" | "DOWN" | "FLAT" | "UNKNOWN";

/**
 * A single signal's temporal profile. Velocity = Δsignal/Δt,
 * acceleration = Δvelocity/Δt, both over normalized time.
 */
export interface TemporalProfile {
  readonly level: FiniteNumber;
  readonly velocity: FiniteNumber | null;
  readonly acceleration: FiniteNumber | null;
  /** How persistent the current direction has been. */
  readonly persistence: Ratio0to1;
  readonly direction: SignalDirection;
  /** Confidence in the derivative itself (short/sparse history lowers this). */
  readonly derivativeConfidence: Ratio0to1;
  readonly window: DurationMillis;
  readonly method: DerivativeMethod;
}

/**
 * Multidimensional trajectory classification. Never collapsed to a single number.
 */
export type TrajectoryClass =
  | "ACCELERATING_UP"
  | "RISING"
  | "FLATTENING"
  | "DECELERATING"
  | "REVERSING"
  | "FALLING"
  | "ACCELERATING_DOWN"
  | "UNKNOWN";

export interface Trajectory {
  readonly classification: TrajectoryClass;
  readonly confidence: Score0to100;
  /** The temporal profiles that produced this classification (explainability). */
  readonly basis: readonly TemporalProfile[];
}

'@
Set-Content -Path 'src/core/temporal/types.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/temporal/index.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/temporal' | Out-Null
$content = @'
// WAR temporal derivatives + trajectory.
export type * from "./types.js";

'@
Set-Content -Path 'src/core/temporal/index.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/coherence/types.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/coherence' | Out-Null
$content = @'
/**
 * WAR core — coherence + lead/lag (Phase 2, types only).
 *
 * Coherence measures whether vectors agree or conflict. Conflict must REDUCE
 * confidence — a token with perfect data but contradictory vectors cannot earn
 * high confidence. Lead/Lag is observed PRECEDENCE only; causality is forbidden.
 */

import type { Score0to100, Ratio0to1, DurationMillis } from "../../shared/scalars.js";

/** Cross-vector agreement state across price/volume/flow/liquidity/sell-pressure. */
export type CoherenceState =
  | "STRONG_MULTI_VECTOR_ALIGNMENT"
  | "MULTI_VECTOR_ALIGNMENT"
  | "MIXED"
  | "MULTI_VECTOR_CONFLICT"
  | "INSUFFICIENT";

export interface Coherence {
  readonly state: CoherenceState;
  /** Net coherence in [0,1]; conflict pulls this down. */
  readonly netCoherence: Ratio0to1;
  /** The vectors compared and whether each agreed with the consensus. */
  readonly vectors: readonly CoherenceVector[];
}

export interface CoherenceVector {
  readonly name: "price" | "volume" | "flow" | "liquidity" | "sellPressure";
  readonly agrees: boolean | null; // null = insufficient to judge
}

/**
 * Lead/Lag relationship between flow and price. Allowed language: "flow
 * historically preceded price within the observed window." Forbidden: "flow
 * caused price." This type carries precedence, never causation.
 */
export type LeadLagResult =
  | "FLOW_LEADS"
  | "PRICE_LEADS"
  | "SYNCHRONIZED"
  | "NO_STABLE_RELATIONSHIP"
  | "INSUFFICIENT_HISTORY";

export interface LeadLag {
  readonly result: LeadLagResult;
  readonly confidence: Score0to100;
  /** Observed lag magnitude, if a stable relationship exists. */
  readonly observedLag: DurationMillis | null;
}

'@
Set-Content -Path 'src/core/coherence/types.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/coherence/index.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/coherence' | Out-Null
$content = @'
// WAR coherence + lead/lag.
export type * from "./types.js";

'@
Set-Content -Path 'src/core/coherence/index.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/power/types.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/power' | Out-Null
$content = @'
/**
 * WAR core — Power / Threat / Confidence (Phase 2, types only).
 *
 * Three INDEPENDENT measures. Power is not probability, prediction, or a buy
 * signal — it is current observable condition strength. Threat is independent
 * of Power (Power 94 + Threat 91 is valid). Confidence is NOT probability — it
 * measures evidence quality. All three are explainable: a bare number is invalid.
 */

import type { Score0to100, Ratio0to1 } from "../../shared/scalars.js";
import type { Coverage, TemporalOrigin } from "../timeline/types.js";

/** A single contributing factor to a composite score, signed and weighted. */
export interface Contribution {
  readonly factor: string;
  /** Signed contribution to the score (explainability). */
  readonly magnitude: number;
  /** The config-driven weight applied (versioned; no magic numbers). */
  readonly weight: number;
}

/**
 * Power — current observable condition strength in [0,100].
 * A Power value without its breakdown is considered incomplete.
 */
export interface Power {
  readonly score: Score0to100;
  readonly supporting: readonly Contribution[];
  readonly opposing: readonly Contribution[];
  /** Net cross-vector coherence backing this Power (links to Coherence). */
  readonly netCoherence: Ratio0to1;
}

/** Threat — dangerous-structure strength in [0,100]. Independent of Power. */
export interface Threat {
  readonly score: Score0to100;
  readonly supporting: readonly Contribution[];
}

/**
 * Confidence — evidence quality, NOT probability. Constrained by completeness,
 * freshness, history depth, coherence, measurement stability, derivative
 * reliability, coverage, and temporal origin. A short FLOW capture (ROLLING
 * coverage) automatically constrains confidence.
 */
export interface Confidence {
  readonly score: Score0to100;
  readonly completeness: Ratio0to1;
  readonly freshness: Ratio0to1;
  readonly historyDepth: Ratio0to1;
  readonly coherenceContribution: Ratio0to1;
  readonly measurementStability: Ratio0to1;
  readonly derivativeReliability: Ratio0to1;
  /** The weakest coverage among the substrates feeding this assessment. */
  readonly limitingCoverage: Coverage;
  readonly limitingTemporalOrigin: TemporalOrigin;
}

'@
Set-Content -Path 'src/core/power/types.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/power/index.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/power' | Out-Null
$content = @'
// WAR Power / Threat / Confidence.
export type * from "./types.js";

'@
Set-Content -Path 'src/core/power/index.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/state/types.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/state' | Out-Null
$content = @'
/**
 * WAR core — state / events / signal lifecycle / novelty / attention
 * (Phase 2, types only).
 */

import type { Score0to100, Ratio0to1, UnixMillis } from "../../shared/scalars.js";

// ── State machine ────────────────────────────────────────────────────────────

/** Deterministic market lifecycle states. */
export type MarketState =
  | "UNKNOWN"
  | "OBSERVING"
  | "EMERGING"
  | "ACCUMULATION"
  | "ATTACK"
  | "DOMINANCE"
  | "DISTRIBUTION"
  | "BLEEDING"
  | "COLLAPSE"
  | "DORMANT";

/**
 * A recorded transition. Never a single-condition jump (e.g. "Power>80 → ATTACK").
 * Transitions require multiple conditions and record every reason.
 */
export interface StateTransition {
  readonly from: MarketState;
  readonly to: MarketState;
  readonly at: UnixMillis;
  readonly reasons: readonly string[];
  /** Whether hysteresis / minimum-dwell gates were satisfied. */
  readonly hysteresisSatisfied: boolean;
}

// ── Events ───────────────────────────────────────────────────────────────────

export type EventType =
  | "POWER_BREAKOUT"
  | "POWER_COLLAPSE"
  | "TRAJECTORY_ACCELERATION"
  | "TRAJECTORY_DECELERATION"
  | "REVERSAL"
  | "SIGNAL_CONFLICT"
  | "SIGNAL_ALIGNMENT"
  | "LIQUIDITY_EXPANSION"
  | "LIQUIDITY_COLLAPSE"
  | "SMART_MONEY_SURGE"
  | "SMART_MONEY_EXIT"
  | "THREAT_SPIKE"
  | "STABILITY_BREAK"
  | "STATE_CHANGE"
  | "FLOW_DIVERGENCE"
  | "FLOW_CLUSTER";

/** A semantic market fact — not an animation. Severity/importance are market meaning. */
export interface MarketEvent {
  readonly type: EventType;
  readonly at: UnixMillis;
  readonly severity: Score0to100;
  readonly importance: Score0to100;
  readonly reasons: readonly string[];
  readonly beforeState: MarketState;
  readonly afterState: MarketState;
}

// ── Signal lifecycle ─────────────────────────────────────────────────────────

/** A persistent signal evolves through phases; it does not re-fire per tick. */
export type SignalPhase =
  | "EMERGING"
  | "CONFIRMING"
  | "CONFIRMED"
  | "WEAKENING"
  | "INVALIDATED"
  | "EXPIRED";

/** Stable identity so one continuing condition is one signal, not 20 notifications. */
export type SignalIdentity = string;

export interface Signal {
  readonly identity: SignalIdentity;
  readonly phase: SignalPhase;
  readonly firstObservedAt: UnixMillis;
  readonly lastUpdatedAt: UnixMillis;
  readonly reasons: readonly string[];
}

// ── Novelty ──────────────────────────────────────────────────────────────────

/**
 * Novelty ≠ anomaly. Anomaly = how unusual is the current value. Novelty = how
 * rarely WAR has seen this pattern. A recurring anomaly may be low-novelty.
 * Novelty feeds Attention, never Power.
 */
export interface Novelty {
  readonly rarity: Ratio0to1;
  readonly reasons: readonly string[];
}

// ── Attention ────────────────────────────────────────────────────────────────

/** Why the operator should look here now. Independent of Power. */
export type AttentionContributor =
  | "MAGNITUDE"
  | "ACCELERATION"
  | "NOVELTY"
  | "STATE_TRANSITION"
  | "TRAJECTORY_REVERSAL"
  | "SIGNAL_CONFLICT"
  | "UNCERTAINTY"
  | "CROSS_TOKEN_IMPACT";

export interface Attention {
  readonly score: Score0to100;
  readonly contributors: readonly AttentionContributor[];
}

'@
Set-Content -Path 'src/core/state/types.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/state/index.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/state' | Out-Null
$content = @'
// WAR state / events / signal / novelty / attention.
export type * from "./types.js";

'@
Set-Content -Path 'src/core/state/index.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/battlefield/types.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/battlefield' | Out-Null
$content = @'
/**
 * WAR core — BattlefieldState (Phase 2, types only).
 *
 * The ONLY intelligence object that leaves the core. The renderer consumes this
 * without knowing how it was calculated. Everything below the battlefield in the
 * data flow (physics, renderer) reads this and never writes back.
 */

import type {
  Chain,
  TokenAddress,
  UnixMillis,
  Score0to100,
} from "../../shared/scalars.js";
import type { ModelVersions, QualityStamp } from "../../shared/quality.js";
import type { Trajectory } from "../temporal/types.js";
import type { Coherence, LeadLag } from "../coherence/types.js";
import type { Power, Threat, Confidence } from "../power/types.js";
import type {
  MarketState,
  MarketEvent,
  Signal,
  Novelty,
  Attention,
} from "../state/types.js";

/** Market-wide regime context (the backdrop every token is read against). */
export type MarketRegime =
  | "RISK_ON"
  | "RISK_OFF"
  | "ROTATIONAL"
  | "QUIET"
  | "UNKNOWN";

/** The complete intelligence picture for one token at one instant. */
export interface TokenBattlefieldEntry {
  readonly chain: Chain;
  readonly address: TokenAddress;
  readonly power: Power;
  readonly threat: Threat;
  readonly confidence: Confidence;
  readonly state: MarketState;
  readonly trajectory: Trajectory;
  readonly coherence: Coherence;
  readonly leadLag: LeadLag;
  readonly attention: Attention;
  readonly novelty: Novelty;
  readonly signals: readonly Signal[];
  readonly events: readonly MarketEvent[];
  readonly quality: QualityStamp;
}

/** Co-movement only (correlational). InfluenceGraph does not exist. */
export interface CorrelationEdge {
  readonly a: TokenAddress;
  readonly b: TokenAddress;
  /** Observed co-movement strength within the window; not causation. */
  readonly comovement: Score0to100;
}

/** The renderer-independent battlefield snapshot. */
export interface BattlefieldState {
  readonly generatedAt: UnixMillis;
  readonly modelVersions: ModelVersions;
  readonly marketRegime: MarketRegime;
  readonly tokens: readonly TokenBattlefieldEntry[];
  /** Attention-ranked token addresses (highest first). */
  readonly rankings: readonly TokenAddress[];
  readonly correlations: readonly CorrelationEdge[];
  readonly globalAttention: Score0to100;
}

'@
Set-Content -Path 'src/core/battlefield/types.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/battlefield/index.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/battlefield' | Out-Null
$content = @'
// WAR BattlefieldState — the only object leaving the core.
export type * from "./types.js";

'@
Set-Content -Path 'src/core/battlefield/index.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/index.ts ----
New-Item -ItemType Directory -Force -Path 'src' | Out-Null
$content = @'
/**
 * WAR core — public type surface (Phase 2).
 *
 * The complete frozen V3.2 intelligence contract, expressed as TypeScript types.
 * No runtime implementation yet. Consumers (adapters, physics, replay, tests)
 * import domain types from here.
 */

export type * from "./shared/index.js";
export type * from "./core/timeline/index.js";
export type * from "./core/temporal/index.js";
export type * from "./core/coherence/index.js";
export type * from "./core/power/index.js";
export type * from "./core/state/index.js";
export type * from "./core/battlefield/index.js";

'@
Set-Content -Path 'src/index.ts' -Value $content -NoNewline -Encoding utf8

# ---- tests/unit/types.composition.test.ts ----
New-Item -ItemType Directory -Force -Path 'tests/unit' | Out-Null
$content = @'
import { describe, it, expectTypeOf } from "vitest";
import type { BattlefieldState, TokenBattlefieldEntry } from "../../src/index.js";

/**
 * Phase 2 has no runtime logic — these are compile-time proofs that the frozen
 * V3.2 contract composes. If the types stop assembling, this file fails to
 * typecheck and `npm run typecheck` breaks the build.
 */
describe("domain type composition", () => {
  it("BattlefieldState exposes the required top-level shape", () => {
    expectTypeOf<BattlefieldState>().toHaveProperty("generatedAt");
    expectTypeOf<BattlefieldState>().toHaveProperty("modelVersions");
    expectTypeOf<BattlefieldState>().toHaveProperty("marketRegime");
    expectTypeOf<BattlefieldState>().toHaveProperty("tokens");
    expectTypeOf<BattlefieldState>().toHaveProperty("rankings");
  });

  it("a token entry carries Power, Threat and Confidence as separate members", () => {
    expectTypeOf<TokenBattlefieldEntry>().toHaveProperty("power");
    expectTypeOf<TokenBattlefieldEntry>().toHaveProperty("threat");
    expectTypeOf<TokenBattlefieldEntry>().toHaveProperty("confidence");
    // Independence is structural: three distinct members, not one fused score.
    expectTypeOf<TokenBattlefieldEntry["power"]>().not.toEqualTypeOf<
      TokenBattlefieldEntry["threat"]
    >();
  });
});

'@
Set-Content -Path 'tests/unit/types.composition.test.ts' -Value $content -NoNewline -Encoding utf8

# ---- README.md ----
$content = @'
# WAR Engine

Deterministic temporal market-intelligence engine. Renderer-agnostic core.

- **Intelligence contract:** V3.2 (FROZEN)
- **GMGN evidence:** sealed at commit `147c070` — see `PHASE_0_SEALED.md`
- **Current phase:** Phase 2 — Domain Types (complete)

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

Write-Host 'Phase 2 files installed.' -ForegroundColor Green
Write-Host 'Next: run  npm test   (expect 60 passed)' -ForegroundColor Yellow