/**
 * WAR INTEL — calibration engine.
 *
 * Derives anti-gaming thresholds from the REAL observed distribution rather than
 * guessing. Given the accumulated performance observations, it computes cost /
 * profit percentiles and picks the SMALLEST threshold that meaningfully cuts
 * trivial "lottery" trades WITHOUT destroying legitimate high-value wallets.
 *
 * Pure and deterministic — no IO, no clock. Fully unit-testable. The decision
 * is the data's, not ours: we report the distribution and the chosen filter so
 * it is always explainable.
 */

import type { PerfObservation } from "./perfObservationStore.js";

export interface Distribution {
  readonly p10: number; readonly p25: number; readonly p50: number;
  readonly p75: number; readonly p90: number; readonly p95: number;
  readonly count: number;
}

export interface CalibrationResult {
  readonly costDist: Distribution;
  readonly profitDist: Distribution;
  /** Chosen anti-gaming filter, derived from the distribution. */
  readonly minCostUsd: number;
  readonly minRealizedProfitUsd: number;
  /** How many observations survive the filter, and the outlier reduction. */
  readonly totalObservations: number;
  readonly qualifying: number;
  readonly retentionPct: number;      // legitimate high-performers kept
  readonly confidence: "LOW" | "MEDIUM" | "HIGH";
}

/** Candidate thresholds the engine may pick from (documented, not arbitrary). */
export interface CalibrationConfig {
  /** Fallback filter when there isn't enough data to calibrate. */
  readonly fallbackMinCostUsd: number;
  readonly fallbackMinProfitUsd: number;
  /** Minimum observations before we trust a calibrated threshold. */
  readonly minObservationsForCalibration: number;
}

export const DEFAULT_CALIBRATION: CalibrationConfig = {
  fallbackMinCostUsd: 500,
  fallbackMinProfitUsd: 1000,
  minObservationsForCalibration: 200,
};

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx]!;
}

function distribution(values: number[]): Distribution {
  const s = [...values].sort((a, b) => a - b);
  return {
    p10: percentile(s, 10), p25: percentile(s, 25), p50: percentile(s, 50),
    p75: percentile(s, 75), p90: percentile(s, 90), p95: percentile(s, 95),
    count: s.length,
  };
}

/**
 * Calibrate thresholds from observations.
 *
 * Cost floor: the P25 of cost — cuts the bottom quarter of trivial-size trades
 * (the sub-lottery buys) while keeping the middle-and-up. Profit floor: max of
 * a small absolute floor and the P25 of positive profits, so we never surface
 * losers or dust as "biggest profit".
 *
 * When there is too little data, we fall back to the documented defaults rather
 * than trusting a noisy distribution.
 */
export function calibrate(
  observations: readonly PerfObservation[],
  cfg: CalibrationConfig = DEFAULT_CALIBRATION,
): CalibrationResult {
  const costs = observations.map((o) => o.costUsd).filter((c) => c > 0);
  const profits = observations.map((o) => o.realizedProfit).filter((p) => p > 0);
  const costDist = distribution(costs);
  const profitDist = distribution(profits);

  let minCostUsd: number, minRealizedProfitUsd: number, confidence: CalibrationResult["confidence"];

  if (observations.length < cfg.minObservationsForCalibration) {
    // Not enough data — use documented fallback, mark low confidence.
    minCostUsd = cfg.fallbackMinCostUsd;
    minRealizedProfitUsd = cfg.fallbackMinProfitUsd;
    confidence = "LOW";
  } else {
    // Data-driven: P25 cost cuts trivial buys; profit floor is the larger of
    // the documented floor and P25 of positive profits.
    minCostUsd = Math.max(cfg.fallbackMinCostUsd, Math.round(costDist.p25));
    minRealizedProfitUsd = Math.max(cfg.fallbackMinProfitUsd, Math.round(profitDist.p25));
    confidence = observations.length >= cfg.minObservationsForCalibration * 5 ? "HIGH" : "MEDIUM";
  }

  const qualifying = observations.filter(
    (o) => o.costUsd >= minCostUsd && o.realizedProfit >= minRealizedProfitUsd,
  ).length;
  const retentionPct = observations.length ? Math.round((qualifying / observations.length) * 1000) / 10 : 0;

  return {
    costDist, profitDist, minCostUsd, minRealizedProfitUsd,
    totalObservations: observations.length, qualifying, retentionPct, confidence,
  };
}
