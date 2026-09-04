/**
 * WAR core - Novelty (Phase 11).
 *
 * Novelty is NOT anomaly. Anomaly asks "how unusual is the current value?".
 * Novelty asks "how rarely has WAR seen this PATTERN before?". A recurring
 * anomaly can be low-novelty; a brand-new combination can be high-novelty.
 *
 * Novelty feeds ATTENTION, never Power. Pure, total, deterministic: the pattern
 * memory (seen-counts) is passed in, not held as hidden state.
 */

import type { Ratio0to1 } from "../../shared/scalars.js";
import type { Novelty } from "../state/types.js";
import { toRatio0to1 } from "../../shared/construct.js";

const R0 = 0 as Ratio0to1;
function ratio(n: number): Ratio0to1 {
  const r = toRatio0to1(n);
  return r.ok ? r.value : R0;
}

/** A deterministic signature describing the current pattern (e.g. state+trajectory+coherence bucket). */
export type PatternSignature = string;

/** Read-only view of how many times each pattern has been seen before. */
export type PatternMemory = Readonly<Record<PatternSignature, number>>;

/**
 * Compute novelty for a pattern given prior sightings. rarity = 1/(1+seen):
 *   - never seen (0)      -> rarity 1.0  (maximally novel)
 *   - seen once           -> rarity 0.5
 *   - seen many times     -> rarity -> 0 (familiar, low novelty)
 */
export function computeNovelty(
  signature: PatternSignature,
  memory: PatternMemory,
): Novelty {
  const seen = memory[signature] ?? 0;
  const safeSeen = seen < 0 || !Number.isFinite(seen) ? 0 : seen;
  const rarity = 1 / (1 + safeSeen);
  const reasons =
    safeSeen === 0
      ? [`pattern "${signature}" not seen before`]
      : [`pattern "${signature}" seen ${safeSeen}x`];
  return { rarity: ratio(rarity), reasons };
}

/**
 * Record a pattern sighting, returning a NEW memory (immutable update).
 * Deterministic; callers thread the memory through time explicitly.
 */
export function recordPattern(
  signature: PatternSignature,
  memory: PatternMemory,
): PatternMemory {
  const seen = memory[signature] ?? 0;
  return { ...memory, [signature]: seen + 1 };
}
