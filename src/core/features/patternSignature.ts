/**
 * WAR core - Feature layer - PatternSignature builder (Phase 4B-5, piece 3).
 *
 * The novelty contract defines a PatternSignature as a deterministic string,
 * "e.g. state+trajectory+coherence bucket". This builder produces exactly that:
 * a canonical serialization of ALREADY-COMPUTED Core outputs. It introduces NO
 * new intelligence and NO equation — only a stable, order-independent encoding.
 *
 *   Source:   MarketState (state machine), TrajectoryClass (trajectory engine),
 *             netCoherence (coherence engine)
 *   Meaning:  a coarse fingerprint of "what kind of situation is this token in"
 *   Transform: join(state, trajectory, coherenceBand) into a canonical string
 *   Range:    finite string space (states x trajectories x bands)
 *   Missing:  UNKNOWN trajectory / INSUFFICIENT coherence encode explicitly as
 *             their own tokens (never dropped, never defaulted to a real band)
 *   Anti-lookahead: consumes only outputs already derived from observations <= T
 *
 * The coherence BAND (not the raw ratio) keeps the signature space small so that
 * "seen before" is meaningful rather than every float being unique. Band edges
 * are explicit and versioned via featureModelVersion.
 */

import type { MarketState } from "../state/types.js";
import type { TrajectoryClass } from "../temporal/types.js";
import type { PatternSignature } from "../novelty/novelty.js";

/** Coherence bands. Coarse on purpose so novelty memory is meaningful. */
export type CoherenceBand = "NONE" | "LOW" | "MID" | "HIGH";

/**
 * Bucket a netCoherence ratio into a band. null (coherence INSUFFICIENT) maps to
 * the explicit "NONE" token rather than a numeric band — unknown is not low.
 */
export function coherenceBand(netCoherence: number | null): CoherenceBand {
  if (netCoherence === null) return "NONE";
  if (netCoherence < 0.34) return "LOW";
  if (netCoherence < 0.67) return "MID";
  return "HIGH";
}

export interface PatternSignatureSources {
  readonly state: MarketState;
  readonly trajectory: TrajectoryClass; // includes "UNKNOWN" when derivatives missing
  readonly netCoherence: number | null;
}

/**
 * Build a canonical, deterministic pattern signature. Field order is fixed, so
 * the same situation always yields the same string (order-independent by
 * construction).
 */
export function buildPatternSignature(s: PatternSignatureSources): PatternSignature {
  const band = coherenceBand(s.netCoherence);
  return `state=${s.state}|traj=${s.trajectory}|coh=${band}`;
}
