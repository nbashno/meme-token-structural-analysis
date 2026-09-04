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
