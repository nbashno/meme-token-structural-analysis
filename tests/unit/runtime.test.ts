import { describe, it, expect } from "vitest";
import {
  initBucket,
  tryAdmit,
  GMGN_BUCKET,
} from "../../src/runtime/rateLimiter.js";
import {
  planSchedule,
  totalWeight,
} from "../../src/runtime/scheduler.js";
import type { FetchRequest } from "../../src/runtime/scheduler.js";

describe("leaky bucket rate limiter", () => {
  it("starts full at capacity", () => {
    const b = initBucket(GMGN_BUCKET, 0);
    expect(b.available).toBe(20);
  });

  it("admits a request within capacity and deducts weight", () => {
    const b = initBucket(GMGN_BUCKET, 0);
    const r = tryAdmit(b, GMGN_BUCKET, 5, 0);
    expect(r.admitted).toBe(true);
    if (r.admitted) expect(r.state.available).toBe(15);
  });

  it("rejects when weight exceeds available and reports retry time", () => {
    let b = initBucket(GMGN_BUCKET, 0);
    // drain the bucket
    const drain = tryAdmit(b, GMGN_BUCKET, 20, 0);
    if (drain.admitted) b = drain.state;
    const r = tryAdmit(b, GMGN_BUCKET, 5, 0);
    expect(r.admitted).toBe(false);
    if (!r.admitted) {
      // need 5 tokens at 20/sec -> 250ms
      expect(r.retryAfterMs).toBe(250);
    }
  });

  it("refills over time (deterministic, injected clock)", () => {
    let b = initBucket(GMGN_BUCKET, 0);
    const drain = tryAdmit(b, GMGN_BUCKET, 20, 0);
    if (drain.admitted) b = drain.state;
    // 500ms later -> 10 tokens leaked back in
    const r = tryAdmit(b, GMGN_BUCKET, 10, 500);
    expect(r.admitted).toBe(true);
  });

  it("never exceeds capacity when refilling", () => {
    const b = initBucket(GMGN_BUCKET, 0);
    // long idle then a small request: still capped at capacity
    const r = tryAdmit(b, GMGN_BUCKET, 1, 10_000);
    expect(r.admitted).toBe(true);
    if (r.admitted) expect(r.state.available).toBeLessThanOrEqual(20);
  });

  it("is deterministic", () => {
    const b = initBucket(GMGN_BUCKET, 0);
    const a = tryAdmit(b, GMGN_BUCKET, 7, 100);
    const c = tryAdmit(b, GMGN_BUCKET, 7, 100);
    expect(JSON.stringify(a)).toBe(JSON.stringify(c));
  });
});

describe("scheduler", () => {
  const reqs: FetchRequest[] = [
    { id: "r1", route: "kline" }, // weight 2
    { id: "r2", route: "trending" }, // weight 1
    { id: "r3", route: "follow-wallet" }, // weight 3
  ];

  it("computes total weight from sealed route weights", () => {
    expect(totalWeight(reqs)).toBe(6);
  });

  it("schedules a small batch immediately (fits in capacity)", () => {
    const plan = planSchedule(reqs, 1000);
    for (const s of plan.scheduled) {
      expect(s.runAtMs).toBe(1000); // all fit at once
    }
  });

  it("defers requests that exceed capacity to a later time", () => {
    // 30 kline requests * weight 2 = 60 weight; capacity 20 -> must span time
    const many: FetchRequest[] = Array.from({ length: 30 }, (_, i) => ({
      id: `k${String(i).padStart(2, "0")}`,
      route: "kline",
    }));
    const plan = planSchedule(many, 0);
    const times = plan.scheduled.map((s) => s.runAtMs);
    expect(Math.max(...times)).toBeGreaterThan(0); // some deferred
  });

  it("produces a stable, deterministic plan regardless of input order", () => {
    const a = planSchedule(reqs, 0);
    const b = planSchedule([...reqs].reverse(), 0);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("assigns the correct weight per route", () => {
    const plan = planSchedule(reqs, 0);
    const byId = Object.fromEntries(plan.scheduled.map((s) => [s.id, s.weight]));
    expect(byId["r1"]).toBe(2);
    expect(byId["r2"]).toBe(1);
    expect(byId["r3"]).toBe(3);
  });

  it("unknown routes default to weight 1", () => {
    const plan = planSchedule([{ id: "x", route: "mystery" }], 0);
    expect(plan.scheduled[0]?.weight).toBe(1);
  });
});
