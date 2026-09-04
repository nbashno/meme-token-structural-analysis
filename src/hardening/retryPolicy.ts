/**
 * WAR hardening - retry / backoff policy (Phase 7).
 *
 * Pure, deterministic policy: given an attempt number and an error kind, decide
 * whether to retry and after how long. No IO, no clock — the caller injects time
 * and performs the wait. This lets the whole retry machine be unit-tested exactly.
 *
 * Adds NO intelligence, NO new factor. It only governs transport resilience.
 */

import type { GmgnErrorKind } from "../adapters/gmgn/gmgnRunner.js";

export interface RetryPolicy {
  readonly maxAttempts: number; // total attempts incl. the first
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Multiplier for exponential backoff. */
  readonly factor: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  factor: 2,
};

/** Which error kinds are worth retrying. AUTH/CLI_MISSING/FORMAT are not.
 *  (Timeouts are classified as NETWORK_ERROR upstream, so they retry too.) */
const RETRYABLE: ReadonlySet<GmgnErrorKind> = new Set<GmgnErrorKind>([
  "RATE_LIMIT",
  "NETWORK_ERROR",
]);

export function isRetryable(kind: GmgnErrorKind): boolean {
  return RETRYABLE.has(kind);
}

export interface RetryDecision {
  readonly retry: boolean;
  readonly delayMs: number;
  readonly reason: string;
}

/**
 * Decide the next step after a failure.
 *
 * @param attempt      1-based attempt number that just failed
 * @param kind         the error kind
 * @param policy       retry policy
 * @param resetAtMs    optional absolute time (ms) the rate limit resets
 * @param nowMs        current time (ms), used only to derive rate-limit wait
 */
export function decideRetry(
  attempt: number,
  kind: GmgnErrorKind,
  policy: RetryPolicy,
  resetAtMs: number | null,
  nowMs: number,
): RetryDecision {
  if (!isRetryable(kind)) {
    return { retry: false, delayMs: 0, reason: `non-retryable: ${kind}` };
  }
  if (attempt >= policy.maxAttempts) {
    return { retry: false, delayMs: 0, reason: `max attempts (${policy.maxAttempts}) reached` };
  }

  // Exponential backoff: base * factor^(attempt-1), capped.
  const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * Math.pow(policy.factor, attempt - 1));

  // For RATE_LIMIT, honor the server's reset time if it is later than backoff.
  if (kind === "RATE_LIMIT" && resetAtMs !== null) {
    const untilReset = Math.max(0, resetAtMs - nowMs);
    const delayMs = Math.max(backoff, untilReset);
    return { retry: true, delayMs, reason: `rate-limit backoff honoring reset (${delayMs}ms)` };
  }

  return { retry: true, delayMs: backoff, reason: `backoff attempt ${attempt} (${backoff}ms)` };
}

/**
 * Full deterministic delay schedule for a run that fails every attempt with the
 * same kind. Useful for tests and for capacity/cost planning.
 */
export function delaySchedule(
  kind: GmgnErrorKind,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): readonly number[] {
  const out: number[] = [];
  for (let attempt = 1; attempt < policy.maxAttempts; attempt++) {
    const d = decideRetry(attempt, kind, policy, null, 0);
    if (!d.retry) break;
    out.push(d.delayMs);
  }
  return out;
}
