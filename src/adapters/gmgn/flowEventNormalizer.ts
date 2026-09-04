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
