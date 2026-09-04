/**
 * WAR core - Feature layer - liquidityFragility (Phase 6, monitor-only).
 *
 * F10 was INSUFFICIENT in a single-snapshot scan (no time series). In a MONITOR
 * context, liquidity samples accumulate across T0->T1->T2..., so a defensible
 * fragility measure exists. Gate applied (per 4A discipline):
 *
 *   Source:   the accumulated liquidity sample series (Analytics lane, SAMPLED)
 *   Meaning:  how sharply liquidity is DROPPING relative to its recent level —
 *             a falling-liquidity token is more fragile (easier to rug/dump).
 *   Transform: relative drop over the window = max(0, (peak - current)/peak)
 *   Range:    [0,1]
 *   Missing:  INSUFFICIENT if fewer than MIN_SAMPLES, or if the newest sample is
 *             staler than MAX_GAP (SAMPLED coverage has gaps; a large gap makes a
 *             derivative meaningless — we refuse rather than fabricate).
 *   Anti-lookahead: uses only samples with at <= T (caller slices).
 *
 * DECISION (locked by default, no config change): this produces the F10
 * `liquidityFragility` activation ONLY when the gate passes. Otherwise the factor
 * is omitted (INSUFFICIENT), exactly as in scan. We never invent a value.
 *
 * Rationale for "relative drop from peak" over raw derivative: a raw Δliquidity/Δt
 * is scale- and sign-noisy across sparse SAMPLED points; "drop from recent peak"
 * is a bounded, interpretable fragility signal that maps cleanly to [0,1] and is
 * defensible without inventing a slope model over irregular gaps.
 */

export interface LiquiditySample {
  readonly at: number; // ms
  readonly liquidity: number; // USD
}

export interface LiquidityFragilityConfig {
  readonly minSamples: number; // >= this many samples required
  readonly maxGapMs: number; // newest sample must be within this of T
}

export const LIQUIDITY_FRAGILITY_CONFIG: LiquidityFragilityConfig = {
  minSamples: 3,
  maxGapMs: 2 * 60 * 1000, // <= 2x a 1-min sampling cadence
};

export interface LiquidityFragilityResult {
  /** The F10 activation value in [0,1], or null when INSUFFICIENT. */
  readonly value: number | null;
  readonly insufficient: boolean;
  readonly reason: string;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Compute liquidityFragility from the accumulated sample series, evaluated at T.
 * Returns null (INSUFFICIENT) unless the gate passes.
 */
export function computeLiquidityFragility(
  samples: readonly LiquiditySample[],
  evaluationAt: number,
  config: LiquidityFragilityConfig = LIQUIDITY_FRAGILITY_CONFIG,
): LiquidityFragilityResult {
  const inWindow = samples.filter((s) => s.at <= evaluationAt);
  if (inWindow.length < config.minSamples) {
    return { value: null, insufficient: true, reason: `need >= ${config.minSamples} samples, have ${inWindow.length}` };
  }
  const sorted = [...inWindow].sort((a, b) => a.at - b.at);
  const newest = sorted[sorted.length - 1]!;
  const gap = evaluationAt - newest.at;
  if (gap > config.maxGapMs) {
    return { value: null, insufficient: true, reason: `newest sample stale by ${gap}ms > ${config.maxGapMs}ms` };
  }

  const peak = Math.max(...sorted.map((s) => s.liquidity));
  if (peak <= 0) {
    return { value: null, insufficient: true, reason: "non-positive peak liquidity" };
  }
  const current = newest.liquidity;
  const relativeDrop = clamp01((peak - current) / peak);
  return { value: relativeDrop, insufficient: false, reason: `drop ${(relativeDrop * 100).toFixed(1)}% from peak` };
}
