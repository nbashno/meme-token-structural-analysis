/**
 * WAR core — temporal derivatives + trajectory (Phase 2, types only).
 *
 * Time-blindness is the fatal flaw V3.2 was built to avoid. Every usable signal
 * can produce derivatives. A derivative is NEVER fabricated: if history is
 * insufficient, the confidence/method must say so, not invent a number.
 */

import type {
  Score0to100,
  Ratio0to1,
  FiniteNumber,
  DurationMillis,
} from "../../shared/scalars.js";

/** The method used to compute a derivative — carried for explainability. */
export type DerivativeMethod =
  | "FINITE_DIFFERENCE"
  | "REGRESSION_SLOPE"
  | "EWMA"
  | "INSUFFICIENT_HISTORY";

/** Direction of movement of a signal. */
export type SignalDirection = "UP" | "DOWN" | "FLAT" | "UNKNOWN";

/**
 * A single signal's temporal profile. Velocity = Δsignal/Δt,
 * acceleration = Δvelocity/Δt, both over normalized time.
 */
export interface TemporalProfile {
  readonly level: FiniteNumber;
  readonly velocity: FiniteNumber | null;
  readonly acceleration: FiniteNumber | null;
  /** How persistent the current direction has been. */
  readonly persistence: Ratio0to1;
  readonly direction: SignalDirection;
  /** Confidence in the derivative itself (short/sparse history lowers this). */
  readonly derivativeConfidence: Ratio0to1;
  readonly window: DurationMillis;
  readonly method: DerivativeMethod;
}

/**
 * Multidimensional trajectory classification. Never collapsed to a single number.
 */
export type TrajectoryClass =
  | "ACCELERATING_UP"
  | "RISING"
  | "FLATTENING"
  | "DECELERATING"
  | "REVERSING"
  | "FALLING"
  | "ACCELERATING_DOWN"
  | "UNKNOWN";

export interface Trajectory {
  readonly classification: TrajectoryClass;
  readonly confidence: Score0to100;
  /** The temporal profiles that produced this classification (explainability). */
  readonly basis: readonly TemporalProfile[];
}
