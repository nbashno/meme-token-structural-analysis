/**
 * WAR core - Feature layer - SignalObservation derivation (Phase 4B-5, piece 4).
 *
 * The signal lifecycle machinery (advanceSignal) is complete. What was missing is
 * WHICH signals exist and HOW their `present`/`support` are derived. Per the gate,
 * we do NOT invent tuned detection thresholds. Instead each signal maps to an
 * ALREADY-DEFENSIBLE Core value:
 *
 *   support = an existing [0,1] activation (NOT a new formula — it IS the value)
 *   present = support > 0 (presence means "non-zero supporting evidence")
 *
 * This yields a minimal, honest signal catalog. Signals that would require a tuned
 * threshold or a new equation are NOT added here — they are surfaced as future
 * work rather than invented.
 *
 * ANTI-LOOKAHEAD: every input activation was derived from observations <= T.
 * In a single-snapshot scan (B1) each signal is seen for the first time, so its
 * lifecycle phase will be EMERGING (or EXPIRED if absent) — no historical
 * transitions, consistent with the B1 decision.
 */

import type { UnixMillis } from "../../shared/scalars.js";
import type { SignalObservation } from "../signal/signalLifecycle.js";
import type { FactorActivations } from "../power/powerEngine.js";

/**
 * The minimal defensible signal catalog. Each entry names a signal identity and
 * the activation key whose value IS its support. Presence = support > 0.
 *
 * Only factors that already passed the 4A/4B gate appear here:
 *   - smart_money_accumulation  <- smartMoneyInflow (F03, CONFIRMED)
 *   - rug_risk_elevated         <- rugRisk           (F07, CONFIRMED)
 *   - holder_concentration_high <- holderConcentration (F08, CONFIRMED)
 *   - wash_trading_flagged      <- washTrading       (F09, CONFIRMED, boolean->{0,1})
 *
 * sellPressure and vectorConflict are Power-negative magnitudes, not standalone
 * "signals" a user watches emerge; they are intentionally omitted (avoids
 * double-representation and needs no invented presence rule).
 */
const SIGNAL_CATALOG: readonly (readonly [identity: string, activationKey: string])[] = [
  ["smart_money_accumulation", "smartMoneyInflow"],
  ["rug_risk_elevated", "rugRisk"],
  ["holder_concentration_high", "holderConcentration"],
  ["wash_trading_flagged", "washTrading"],
];

/**
 * Derive signal observations from the current activations at instant `at`.
 * Only signals whose backing activation is PRESENT (defined) are emitted; an
 * absent activation means the underlying evidence is UNKNOWN, so no observation
 * is produced for it (we don't assert absence we can't measure).
 */
export function deriveSignalObservations(
  activations: FactorActivations,
  at: UnixMillis,
): readonly SignalObservation[] {
  const out: SignalObservation[] = [];
  for (const [identity, key] of SIGNAL_CATALOG) {
    const value = activations[key];
    if (value === undefined) continue; // UNKNOWN evidence -> no observation
    const support = value < 0 ? 0 : value > 1 ? 1 : value;
    out.push({
      identity,
      at,
      present: support > 0,
      support,
      reason: `${identity}: ${key}=${support.toFixed(3)}`,
    });
  }
  return out;
}
