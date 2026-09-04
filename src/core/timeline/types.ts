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
 *
 * Security fields (4B-1) come from the same `market trending` (GET /v1/market/rank)
 * response, all chains, sealed @147c070c. They are NULLABLE: a missing field stays
 * null (never coerced to 0), because "0.0 rug risk" and "unknown rug risk" are
 * categorically different and must not be conflated.
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
  /** Rug pull risk SCORE [0,1] (not a probability, not binary). null = unknown. */
  readonly rugRatio: number | null;
  /** Ratio of supply held by top-10 wallets [0,1]. null = unknown. */
  readonly top10HolderRate: number | null;
  /** Wash-trading detected — a real boolean (not a 1/0 flag). null = unknown. */
  readonly isWashTrading: boolean | null;
  /** Ratio of bundle-bot trading volume [0,1]. null = unknown. */
  readonly bundlerRate: number | null;
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
