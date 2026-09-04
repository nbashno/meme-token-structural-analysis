/**
 * WAR core - Feature layer - DirectionalMove builder (Phase 4B-5, piece 5).
 *
 * computeLeadLag needs two sequences of DirectionalMove {at, sign} — one for
 * price, one for flow — to report observed precedence (never causation). A
 * DirectionalMove is a same-direction step between consecutive points in a
 * time-ordered series.
 *
 *   Source (price): OHLCV close series (kline), multiple candles.
 *   Source (flow):  the time-ordered flow event sequence (each event has a
 *                   timestamp and a buy/sell side).
 *   Meaning:  a directional change point on the series.
 *   Transform: for consecutive points, emit sign(next - prev); skip flats.
 *   Range:    sign in {+1, -1}; flats produce no move.
 *   Missing:  fewer than 2 points -> no moves (computeLeadLag then reports
 *             INSUFFICIENT_HISTORY on its own).
 *   Anti-lookahead: moves are emitted at the LATER of the two points' times, so a
 *             move at T never encodes information from after T. The builder reads
 *             only the series slice <= T supplied by the caller.
 *
 * NOTE ON B1: in a single-snapshot scan the price series (kline) can still yield
 * moves (it is a historical series), and the flow window yields moves from its
 * event sequence. Lead/lag here is WITHIN the observed window only — it is not a
 * cross-time "since last scan" comparison. This respects B1 (no before/after
 * across scans) because all moves come from one acquisition's own series.
 */

import type { DirectionalMove } from "../coherence/coherence.js";

/** A time-ordered numeric point on a series. */
export interface SeriesPoint {
  readonly at: number; // ms
  readonly value: number;
}

/**
 * Build directional moves from a numeric series. A move is emitted between each
 * pair of consecutive points whose values differ; its sign is the direction of
 * change and its timestamp is the LATER point (never lookahead). Equal values
 * (flat) produce no move.
 */
export function movesFromSeries(points: readonly SeriesPoint[]): readonly DirectionalMove[] {
  const sorted = [...points].sort((a, b) => a.at - b.at);
  const out: DirectionalMove[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    const delta = cur.value - prev.value;
    if (delta > 0) out.push({ at: cur.at, sign: 1 });
    else if (delta < 0) out.push({ at: cur.at, sign: -1 });
    // delta === 0 -> flat, no move
  }
  return out;
}

/** A flow event reduced to what a directional move needs. */
export interface FlowMovePoint {
  readonly at: number;
  readonly side: "buy" | "sell";
}

/**
 * Build directional moves from the flow event sequence. Each buy is a +1 move,
 * each sell a -1 move, at the event's own timestamp. This is the flow analogue of
 * price moves: the sequence of directional pressure over the observed window.
 */
export function movesFromFlowEvents(events: readonly FlowMovePoint[]): readonly DirectionalMove[] {
  return [...events]
    .sort((a, b) => a.at - b.at)
    .map((e) => ({ at: e.at, sign: e.side === "buy" ? 1 : (-1 as 1 | -1) }));
}
