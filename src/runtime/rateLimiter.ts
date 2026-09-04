/**
 * WAR runtime - Leaky Bucket rate limiter (Phase 17).
 *
 * Models the sealed GMGN limit: rate=20, capacity=20, per-route weights. Pure
 * and deterministic - the bucket state is a value that is threaded through time
 * explicitly. Time is injected (ms); nothing here reads a clock.
 *
 * The bucket leaks `rate` tokens per second and holds at most `capacity`. A
 * request of weight W is admitted only if the bucket has >= W available; the
 * caller is told when to retry otherwise.
 */

export interface BucketConfig {
  /** Tokens replenished per second. */
  readonly rate: number;
  /** Maximum tokens the bucket can hold. */
  readonly capacity: number;
}

export const GMGN_BUCKET: BucketConfig = { rate: 20, capacity: 20 };

/** Immutable bucket state: available tokens and the ms timestamp they were valid at. */
export interface BucketState {
  readonly available: number;
  readonly at: number; // ms
}

/** Start a bucket full at time `atMs`. */
export function initBucket(config: BucketConfig, atMs: number): BucketState {
  return { available: config.capacity, at: atMs };
}

/** Refill the bucket up to `now` (deterministic; no clock). */
function refill(state: BucketState, config: BucketConfig, now: number): BucketState {
  if (now <= state.at) return state;
  const elapsedSec = (now - state.at) / 1000;
  const replenished = elapsedSec * config.rate;
  const available = Math.min(config.capacity, state.available + replenished);
  return { available, at: now };
}

export type AdmitResult =
  | { readonly admitted: true; readonly state: BucketState }
  | { readonly admitted: false; readonly state: BucketState; readonly retryAfterMs: number };

/**
 * Attempt to admit a request of the given weight at time `now`. Deterministic.
 * On rejection, reports how long (ms) until enough tokens will have leaked in.
 */
export function tryAdmit(
  state: BucketState,
  config: BucketConfig,
  weight: number,
  now: number,
): AdmitResult {
  const refilled = refill(state, config, now);

  if (refilled.available >= weight) {
    return {
      admitted: true,
      state: { available: refilled.available - weight, at: now },
    };
  }

  const deficit = weight - refilled.available;
  const retryAfterMs = Math.ceil((deficit / config.rate) * 1000);
  return { admitted: false, state: refilled, retryAfterMs };
}
