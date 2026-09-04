/**
 * WAR core - Feature layer - DirectedVector builder (Phase 4B-5, piece 1).
 *
 * Produces the DirectedVector[] that computeCoherence consumes. Each vector's
 * direction is derived ONLY from a defensible source. Gate applied per vector:
 *   Source -> Meaning -> Transform -> Range -> Missing -> Anti-lookahead.
 *
 * The five coherence vectors are named by the Core: price, volume, flow,
 * liquidity, sellPressure. We build the ones with a defensible directional
 * definition and mark the rest UNKNOWN (never invent a direction).
 *
 * DIRECTION CONVENTION: UP = bullish contribution, DOWN = bearish, FLAT = neutral,
 * UNKNOWN = not derivable. computeCoherence compares signs for consensus.
 *
 * ANTI-LOOKAHEAD: every series passed in must contain only points <= T. This
 * module never reads future points; it consumes what the caller sliced at T.
 */

import type { SignalDirection } from "../temporal/types.js";
import type { DirectedVector } from "../coherence/coherence.js";
import type { TemporalProfile } from "../temporal/types.js";
import type { FlowMetrics } from "../flow/flowEngine.js";

/**
 * price / volume / liquidity: direction = the sign of the temporal derivative of
 * that series. This is exactly TemporalProfile.direction, already defined and
 * anti-lookahead-safe (computeTemporalProfile uses points <= T).
 *
 *   Source:   OHLCV close / OHLCV volumeUsd / Analytics liquidity series
 *   Meaning:  is this quantity rising, falling, or flat over observed time?
 *   Transform: TemporalProfile.direction (UP/DOWN/FLAT/UNKNOWN)
 *   Range:    enum
 *   Missing:  INSUFFICIENT_HISTORY -> UNKNOWN (from the profile itself)
 */
export function directionFromProfile(profile: TemporalProfile): SignalDirection {
  return profile.direction;
}

/**
 * flow: direction = sign of net flow (buy USD - sell USD) over the window.
 *
 *   Source:   FlowMetrics.netFlowUsd (= buyPressureUsd - sellPressureUsd)
 *   Meaning:  net capital direction — positive is inflow (bullish), negative
 *             outflow (bearish). This is a documented level-sign, NOT a fabricated
 *             derivative: netFlowUsd's sign IS its meaning.
 *   Transform: sign(netFlowUsd) -> UP / DOWN / FLAT
 *   Range:    enum
 *   Missing:  eventCount === 0 -> UNKNOWN (no flow observed, not "flat")
 *   Anti-lookahead: FlowMetrics is computed only from events <= T by the caller.
 */
export function flowDirection(flow: FlowMetrics, flatEpsilonUsd = 0): SignalDirection {
  if (flow.eventCount === 0) return "UNKNOWN";
  const net = flow.netFlowUsd;
  if (net > flatEpsilonUsd) return "UP";
  if (net < -flatEpsilonUsd) return "DOWN";
  return "FLAT";
}

/**
 * sellPressure: NOT built as a directional vector here.
 *
 * WHY INSUFFICIENT: "sell pressure" is a bearish MAGNITUDE, not a signed
 * directional series. Turning it into an UP/DOWN coherence vector requires a
 * sign-convention CHOICE (e.g. "DOWN when sell dominates") that has no sealed
 * mathematical definition. Per the gate, we do NOT invent that convention. The
 * sellPressure force already enters intelligence as the F05 `sellPressure` Power
 * factor (magnitude-based) and as the flow vector's sign; representing it AGAIN
 * as a coherence vector would risk double-counting AND require invented glue.
 *
 * Result: the sellPressure coherence vector is emitted as UNKNOWN, so
 * computeCoherence ignores it (dirSign(UNKNOWN) = null). This is deliberate and
 * surfaced, not an oversight.
 */
export function sellPressureDirection(): SignalDirection {
  return "UNKNOWN";
}

export interface VectorSources {
  readonly priceProfile: TemporalProfile | null;
  readonly volumeProfile: TemporalProfile | null;
  readonly liquidityProfile: TemporalProfile | null;
  readonly flow: FlowMetrics | null;
}

/**
 * Assemble the five named DirectedVectors. Any source that is null yields an
 * UNKNOWN direction for that vector (which computeCoherence then ignores).
 */
export function buildDirectedVectors(sources: VectorSources): readonly DirectedVector[] {
  return [
    { name: "price", direction: sources.priceProfile ? directionFromProfile(sources.priceProfile) : "UNKNOWN" },
    { name: "volume", direction: sources.volumeProfile ? directionFromProfile(sources.volumeProfile) : "UNKNOWN" },
    { name: "liquidity", direction: sources.liquidityProfile ? directionFromProfile(sources.liquidityProfile) : "UNKNOWN" },
    { name: "flow", direction: sources.flow ? flowDirection(sources.flow) : "UNKNOWN" },
    { name: "sellPressure", direction: sellPressureDirection() },
  ];
}
