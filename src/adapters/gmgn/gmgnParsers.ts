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

/**
 * Coerce a field that MUST be a ratio in [0,1]. Out-of-range values are treated
 * as INVALID (returned as null), NOT silently clamped — a rug_ratio of 1.7 is a
 * data error we surface, not a 1.0 we invent. Missing stays null.
 */
function ratio01(v: unknown): number | null {
  const n = num(v);
  if (n === null) return null;
  if (n < 0 || n > 1) return null; // invalid, not clamped
  return n;
}

/**
 * Coerce a field that MUST be a real boolean. GMGN `is_wash_trading` is a true
 * boolean per the sealed schema — distinct from `is_honeypot`/`is_renounced`
 * which are 1/0 flags. We accept only actual booleans (and the exact strings
 * "true"/"false"); anything else (including 1/0) is null, to avoid conflation.
 */
function boolStrict(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
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
  // Security & Risk (sealed @147c070, market trending / GET /v1/market/rank, all chains)
  readonly rug_ratio?: unknown;
  readonly top_10_holder_rate?: unknown;
  readonly is_wash_trading?: unknown;
  readonly bundler_rate?: unknown;
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

  // Security fields: nullable, strict. bundler_rate maps from the trending name
  // (== bundler_trader_amount_rate in token-security). is_wash_trading is a real
  // boolean, never conflated with 1/0 flags like is_honeypot / is_renounced.
  const rugRatio = ratio01(raw.rug_ratio);
  const top10HolderRate = ratio01(raw.top_10_holder_rate);
  const isWashTrading = boolStrict(raw.is_wash_trading);
  const bundlerRate = ratio01(raw.bundler_rate);

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
    // Security fields keep null when missing/invalid (no missing -> 0 coercion).
    rugRatio,
    top10HolderRate,
    isWashTrading,
    bundlerRate,
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
