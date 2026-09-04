/**
 * WAR outcome - OutcomeEvaluator (Phase 14).
 *
 * The ONLY component permitted to read post-decision future data - and only
 * AFTER a DecisionRecord is sealed. It never feeds back into the core; it
 * measures what happened after a decision, for evaluation and (later) the
 * early-detection benchmark. No automatic training in this phase.
 *
 * Pure, total, deterministic. No clock, no randomness, no IO.
 */

import type { UnixMillis } from "../shared/scalars.js";

/** A sealed decision: the instant it was made and the price then. */
export interface DecisionRecord {
  readonly id: string;
  readonly at: UnixMillis;
  readonly direction: "UP" | "DOWN"; // what WAR flagged
  readonly referencePrice: number;
  readonly sealed: true;
}

/** A future price observation (strictly after the decision). */
export interface FuturePrice {
  readonly at: UnixMillis;
  readonly price: number;
}

export type Verdict =
  | "CONFIRMED"
  | "REJECTED"
  | "INCONCLUSIVE"
  | "NO_FUTURE_DATA";

export interface Outcome {
  readonly decisionId: string;
  readonly actualDirection: "UP" | "DOWN" | "FLAT" | "UNKNOWN";
  readonly actualMagnitude: number; // fractional move from reference
  /** Max favorable excursion (best move in the flagged direction). */
  readonly mfe: number;
  /** Max adverse excursion (worst move against the flagged direction). */
  readonly mae: number;
  readonly timeToOutcome: number | null; // ms to first threshold cross, or null
  readonly verdict: Verdict;
}

export interface OutcomeConfig {
  /** Fractional move (e.g. 0.05 = 5%) that confirms/rejects a direction. */
  readonly threshold: number;
}

export const OUTCOME_CONFIG: OutcomeConfig = { threshold: 0.05 };

/**
 * Evaluate a sealed decision against future prices. Enforces that only prices
 * strictly AFTER the decision are considered - this is the temporal firewall.
 */
export function evaluateOutcome(
  decision: DecisionRecord,
  futurePrices: readonly FuturePrice[],
  config: OutcomeConfig = OUTCOME_CONFIG,
): Outcome {
  // Temporal firewall: keep only strictly-future prices, sorted.
  const future = futurePrices
    .filter((p) => (p.at as number) > (decision.at as number))
    .sort((a, b) => (a.at as number) - (b.at as number));

  if (future.length === 0) {
    return {
      decisionId: decision.id,
      actualDirection: "UNKNOWN",
      actualMagnitude: 0,
      mfe: 0,
      mae: 0,
      timeToOutcome: null,
      verdict: "NO_FUTURE_DATA",
    };
  }

  const ref = decision.referencePrice;
  const flaggedUp = decision.direction === "UP";

  let mfe = 0; // best favorable fractional move
  let mae = 0; // worst adverse fractional move (as a positive number)
  let timeToOutcome: number | null = null;

  for (const p of future) {
    const move = ref !== 0 ? (p.price - ref) / ref : 0;
    const favorable = flaggedUp ? move : -move;
    const adverse = -favorable;
    if (favorable > mfe) mfe = favorable;
    if (adverse > mae) mae = adverse;
    if (timeToOutcome === null && favorable >= config.threshold) {
      timeToOutcome = (p.at as number) - (decision.at as number);
    }
  }

  const lastPrice = future[future.length - 1];
  const finalMove =
    lastPrice !== undefined && ref !== 0
      ? (lastPrice.price - ref) / ref
      : 0;
  const finalFavorable = flaggedUp ? finalMove : -finalMove;

  const actualDirection: Outcome["actualDirection"] =
    finalMove > 0 ? "UP" : finalMove < 0 ? "DOWN" : "FLAT";

  let verdict: Verdict;
  if (finalFavorable >= config.threshold) verdict = "CONFIRMED";
  else if (finalFavorable <= -config.threshold) verdict = "REJECTED";
  else verdict = "INCONCLUSIVE";

  return {
    decisionId: decision.id,
    actualDirection,
    actualMagnitude: finalMove,
    mfe,
    mae,
    timeToOutcome,
    verdict,
  };
}
