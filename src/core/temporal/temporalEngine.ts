/**
 * WAR core — Temporal Engine (Phase 4).
 *
 * Computes velocity (Δsignal/Δt) and acceleration (Δvelocity/Δt) over
 * NORMALIZED, irregular time. Pure and deterministic: no clock, no randomness.
 *
 * NON-NEGOTIABLE: a derivative is NEVER fabricated. With too few points, or a
 * zero time delta, the profile reports null derivatives and method
 * INSUFFICIENT_HISTORY — it does not invent a slope. Missing ≠ zero.
 */

import type {
  FiniteNumber,
  Ratio0to1,
  UnixMillis,
  DurationMillis,
} from "../../shared/scalars.js";
import type {
  TemporalProfile,
  DerivativeMethod,
  SignalDirection,
} from "./types.js";
import { toRatio0to1 } from "../../shared/construct.js";

/** One observation of a scalar signal at a point in time. */
export interface SignalPoint {
  readonly at: UnixMillis;
  readonly value: number;
}

/** Configuration for derivative computation (versioned, no magic numbers inline). */
export interface TemporalConfig {
  /** Minimum points required to attempt a velocity. */
  readonly minPointsForVelocity: number;
  /** Minimum points required to attempt an acceleration. */
  readonly minPointsForAcceleration: number;
  /** |velocity| at or below this is treated as FLAT direction. */
  readonly flatEpsilon: number;
}

export const DEFAULT_TEMPORAL_CONFIG: TemporalConfig = {
  minPointsForVelocity: 2,
  minPointsForAcceleration: 3,
  flatEpsilon: 1e-9,
};

const r0 = 0 as Ratio0to1;

function ratio(n: number): Ratio0to1 {
  const res = toRatio0to1(n);
  return res.ok ? res.value : r0;
}

/**
 * Deterministically sort points by time, then dedupe exact (time,value) pairs.
 * Two different values at the same timestamp are a conflict; we keep the first
 * in stable order rather than guessing — the caller's upstream (timeline)
 * should already have deduped, so this is a defensive, deterministic pass.
 */
function normalize(points: readonly SignalPoint[]): SignalPoint[] {
  const sorted = [...points].sort((a, b) => {
    const ta = a.at as number;
    const tb = b.at as number;
    if (ta !== tb) return ta - tb;
    return a.value - b.value;
  });
  const out: SignalPoint[] = [];
  let lastKey: string | null = null;
  for (const p of sorted) {
    const key = `${p.at}|${p.value}`;
    if (key !== lastKey) {
      out.push(p);
      lastKey = key;
    }
  }
  return out;
}

/** Backward finite-difference velocity between the last two points. */
function lastVelocity(points: SignalPoint[]): number | null {
  if (points.length < 2) return null;
  const b = points[points.length - 1];
  const a = points[points.length - 2];
  if (a === undefined || b === undefined) return null;
  const dt = (b.at as number) - (a.at as number);
  if (dt <= 0) return null; // zero/negative Δt → cannot form a derivative
  return (b.value - a.value) / dt;
}

/** Acceleration from the last three points (change in successive velocities). */
function lastAcceleration(points: SignalPoint[]): number | null {
  if (points.length < 3) return null;
  const c = points[points.length - 1];
  const b = points[points.length - 2];
  const a = points[points.length - 3];
  if (a === undefined || b === undefined || c === undefined) return null;
  const dt1 = (b.at as number) - (a.at as number);
  const dt2 = (c.at as number) - (b.at as number);
  if (dt1 <= 0 || dt2 <= 0) return null;
  const v1 = (b.value - a.value) / dt1;
  const v2 = (c.value - b.value) / dt2;
  const dtv = (c.at as number) - (a.at as number);
  if (dtv <= 0) return null;
  return (v2 - v1) / dtv;
}

/** Fraction of consecutive steps that move in the dominant direction. */
function persistenceOf(points: SignalPoint[]): number {
  if (points.length < 2) return 0;
  let up = 0;
  let down = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    if (prev === undefined || cur === undefined) continue;
    const d = cur.value - prev.value;
    if (d > 0) up++;
    else if (d < 0) down++;
  }
  const total = up + down;
  if (total === 0) return 0;
  return Math.max(up, down) / total;
}

function directionOf(velocity: number | null, flatEpsilon: number): SignalDirection {
  if (velocity === null) return "UNKNOWN";
  if (Math.abs(velocity) <= flatEpsilon) return "FLAT";
  return velocity > 0 ? "UP" : "DOWN";
}

/**
 * Derivative confidence in [0,1]: rises with the number of usable points,
 * saturating. Never a fabricated certainty — sparse history stays low.
 */
function derivativeConfidence(n: number): number {
  if (n < 2) return 0;
  // 2 pts → 0.25, 3 → 0.5, 4 → 0.625, ... asymptotic toward 1.
  return 1 - 1 / (n - 1);
}

const ZERO_WINDOW = 0 as DurationMillis;

/**
 * Build a TemporalProfile from a signal series. Total and deterministic.
 */
export function computeTemporalProfile(
  rawPoints: readonly SignalPoint[],
  config: TemporalConfig = DEFAULT_TEMPORAL_CONFIG,
): TemporalProfile {
  const points = normalize(rawPoints);
  const n = points.length;

  const last = points[n - 1];
  const level = (last !== undefined ? last.value : 0) as FiniteNumber;

  // Insufficient history → explicit, no fabricated derivative.
  if (n < config.minPointsForVelocity) {
    return {
      level,
      velocity: null,
      acceleration: null,
      persistence: r0,
      direction: "UNKNOWN",
      derivativeConfidence: r0,
      window: ZERO_WINDOW,
      method: "INSUFFICIENT_HISTORY",
    };
  }

  const first = points[0];
  const windowMs =
    first !== undefined && last !== undefined
      ? (last.at as number) - (first.at as number)
      : 0;
  const window = (windowMs >= 0 ? windowMs : 0) as DurationMillis;

  const velocity = lastVelocity(points);
  const acceleration =
    n >= config.minPointsForAcceleration ? lastAcceleration(points) : null;

  return {
    level,
    velocity: velocity === null ? null : (velocity as FiniteNumber),
    acceleration: acceleration === null ? null : (acceleration as FiniteNumber),
    persistence: ratio(persistenceOf(points)),
    direction: directionOf(velocity, config.flatEpsilon),
    derivativeConfidence: ratio(derivativeConfidence(n)),
    window,
    method: pickMethod(velocity, acceleration),
  };
}

function pickMethod(
  velocity: number | null,
  acceleration: number | null,
): DerivativeMethod {
  if (velocity === null) return "INSUFFICIENT_HISTORY";
  // Phase 4 uses finite differences; regression/EWMA are reserved for later.
  void acceleration;
  return "FINITE_DIFFERENCE";
}
