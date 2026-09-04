/**
 * WAR core — scalar constructors (Phase 3).
 *
 * The ONLY sanctioned way to produce branded scalars. Every constructor is
 * pure, total, and deterministic: same input → same output, no time, no
 * randomness, no throwing on the hot path where a typed failure is meaningful.
 *
 * Design rule: illegal numbers (NaN, Infinity, out-of-range) never silently
 * become a valid brand. They yield an explicit failure the caller must handle.
 */

import type {
  Score0to100,
  Ratio0to1,
  FiniteNumber,
  UnixMillis,
  UnixSeconds,
  DurationMillis,
} from "./scalars.js";

/** Result of a validating constructor: either a branded value or a reason. */
export type ScalarResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

function ok<T>(value: T): ScalarResult<T> {
  return { ok: true, value };
}
function fail<T>(reason: string): ScalarResult<T> {
  return { ok: false, reason };
}

/** True only for a finite, non-NaN JavaScript number. */
function isFiniteNumber(n: number): boolean {
  return typeof n === "number" && Number.isFinite(n);
}

export function toFiniteNumber(n: number): ScalarResult<FiniteNumber> {
  if (!isFiniteNumber(n)) return fail(`not a finite number: ${String(n)}`);
  return ok(n as FiniteNumber);
}

export function toScore0to100(n: number): ScalarResult<Score0to100> {
  if (!isFiniteNumber(n)) return fail(`score not finite: ${String(n)}`);
  if (n < 0 || n > 100) return fail(`score out of [0,100]: ${n}`);
  return ok(n as Score0to100);
}

export function toRatio0to1(n: number): ScalarResult<Ratio0to1> {
  if (!isFiniteNumber(n)) return fail(`ratio not finite: ${String(n)}`);
  if (n < 0 || n > 1) return fail(`ratio out of [0,1]: ${n}`);
  return ok(n as Ratio0to1);
}

export function toUnixMillis(n: number): ScalarResult<UnixMillis> {
  if (!isFiniteNumber(n)) return fail(`timestamp not finite: ${String(n)}`);
  if (!Number.isInteger(n)) return fail(`timestamp not integer ms: ${n}`);
  if (n < 0) return fail(`timestamp negative: ${n}`);
  return ok(n as UnixMillis);
}

/** Convert adapter-boundary seconds to internal milliseconds, deterministically. */
export function secondsToMillis(s: UnixSeconds): ScalarResult<UnixMillis> {
  const ms = (s as number) * 1000;
  return toUnixMillis(ms);
}

export function toDurationMillis(n: number): ScalarResult<DurationMillis> {
  if (!isFiniteNumber(n)) return fail(`duration not finite: ${String(n)}`);
  if (n < 0) return fail(`duration negative: ${n}`);
  return ok(n as DurationMillis);
}

/** Clamp a finite number into [0,100]. Non-finite input is a typed failure. */
export function clampScore(n: number): ScalarResult<Score0to100> {
  if (!isFiniteNumber(n)) return fail(`clamp input not finite: ${String(n)}`);
  const clamped = n < 0 ? 0 : n > 100 ? 100 : n;
  return ok(clamped as Score0to100);
}
