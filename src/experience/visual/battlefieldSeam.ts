/**
 * WAR experience — battlefield seam (Phase A / A2, B3 groundwork).
 *
 * The central visual metaphor: POWER ←── battlefield ──→ THREAT.
 *
 * It renders the TWO values that already exist in WorldState (`power.raw`,
 * `threat.raw`). It does NOT compute a new ratio, score, winner, or advantage.
 * The seam position is a purely geometric split of a shared bar so the eye can
 * read the contested boundary. Both raw values are preserved and returned.
 */

import { forceWidth01, PALETTE } from "./vocabulary.js";

export interface SeamGeometry {
  /** Raw Power, exactly as computed by WAR (0..100). Never derived here. */
  readonly powerRaw: number;
  /** Raw Threat, exactly as computed by WAR (0..100). Never derived here. */
  readonly threatRaw: number;
  /** Seam split point in 0..1 across the bar (presentational geometry only). */
  readonly seam01: number;
  readonly powerColor: number;
  readonly threatColor: number;
}

/**
 * Compute seam geometry from the two existing forces.
 *
 * IMPORTANT: `seam01` is NOT an intelligence signal. It is where a shared bar
 * is visually divided so both forces are legible side by side. When both are
 * zero (or missing), the seam sits at the exact middle — a neutral, honest
 * "no contest visible" position, not an invented advantage.
 */
export function seamGeometry(powerRaw: number, threatRaw: number): SeamGeometry {
  const p = forceWidth01(powerRaw);
  const t = forceWidth01(threatRaw);
  const sum = p + t;
  const seam01 = sum === 0 ? 0.5 : p / sum;

  return {
    powerRaw,
    threatRaw,
    seam01,
    powerColor: PALETTE.power,
    threatColor: PALETTE.threat,
  };
}
