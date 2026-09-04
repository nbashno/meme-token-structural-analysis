/**
 * WAR runtime - Scheduler (Phase 17).
 *
 * Orchestrates data acquisition: it schedules weighted fetch requests through
 * the leaky-bucket limiter and returns admitted requests in a deterministic
 * order. It does NOT itself perform IO - fetchers are injected - so it is fully
 * testable and deterministic. Time is injected.
 *
 * This is the seam where adapter (IO) meets core (intelligence): the scheduler
 * decides WHEN a request may run; the caller wires the actual adapter call.
 */

import type { BucketConfig, BucketState } from "./rateLimiter.js";
import { GMGN_BUCKET, initBucket, tryAdmit } from "./rateLimiter.js";
import { ROUTE_WEIGHTS } from "../adapters/gmgn/gmgnRunner.js";

/** A unit of work to schedule: a named route (for its weight) and a payload id. */
export interface FetchRequest {
  readonly id: string;
  readonly route: keyof typeof ROUTE_WEIGHTS | string;
}

/** The scheduler's decision for one request. */
export interface ScheduledRequest {
  readonly id: string;
  readonly route: string;
  readonly weight: number;
  readonly runAtMs: number;
}

export interface SchedulePlan {
  readonly scheduled: readonly ScheduledRequest[];
  readonly finalBucket: BucketState;
}

function weightOf(route: string): number {
  const w = ROUTE_WEIGHTS[route];
  return typeof w === "number" ? w : 1;
}

/**
 * Plan the execution times for a batch of requests starting at `startMs`,
 * respecting the leaky bucket. Requests are processed in a stable order (by id)
 * so the plan is deterministic. When the bucket lacks tokens, the request is
 * deferred by exactly the limiter's retryAfterMs (no busy spinning).
 */
export function planSchedule(
  requests: readonly FetchRequest[],
  startMs: number,
  config: BucketConfig = GMGN_BUCKET,
): SchedulePlan {
  // Deterministic processing order.
  const ordered = [...requests].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  let bucket = initBucket(config, startMs);
  let now = startMs;
  const scheduled: ScheduledRequest[] = [];

  for (const req of ordered) {
    const weight = weightOf(req.route);

    // Advance time until this request is admitted.
    let result = tryAdmit(bucket, config, weight, now);
    while (!result.admitted) {
      now += result.retryAfterMs;
      bucket = result.state;
      result = tryAdmit(bucket, config, weight, now);
    }

    bucket = result.state;
    scheduled.push({ id: req.id, route: req.route, weight, runAtMs: now });
  }

  return { scheduled, finalBucket: bucket };
}

/**
 * Total weight of a batch - a quick capacity check callers can use before
 * planning (e.g. to warn that a very large batch will span a long window).
 */
export function totalWeight(requests: readonly FetchRequest[]): number {
  return requests.reduce((sum, r) => sum + weightOf(r.route), 0);
}
