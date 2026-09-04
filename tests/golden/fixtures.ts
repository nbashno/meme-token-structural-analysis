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
    rugRatio: null,
    top10HolderRate: null,
    isWashTrading: null,
    bundlerRate: null,
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
