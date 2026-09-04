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
