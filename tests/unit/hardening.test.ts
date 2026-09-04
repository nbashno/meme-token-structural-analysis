import { describe, it, expect } from "vitest";

import { decideRetry, delaySchedule, isRetryable, DEFAULT_RETRY_POLICY } from "../../src/hardening/retryPolicy.js";
import {
  engageKill,
  initBreaker, breakerAllows, breakerOnFailure, breakerOnSuccess, DEFAULT_BREAKER,
  initConcurrency, tryAcquireSlot, releaseSlot,
  initCost, trySpend,
} from "../../src/hardening/guards.js";
import { classifyRunResult } from "../../src/hardening/classify.js";
import { ResilientCliExecutor, type TimeProvider, type Observer } from "../../src/hardening/ResilientCliExecutor.js";
import type { CliExecutor, CliRunResult } from "../../src/adapters/gmgn/gmgnRunner.js";

// A controllable virtual clock (no real waiting).
function virtualTime(): TimeProvider & { advance: (ms: number) => void; slept: number[] } {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    async sleep(ms: number) { slept.push(ms); t += ms; },
    advance: (ms: number) => { t += ms; },
    slept,
  };
}

// ── retry policy ──────────────────────────────────────────────────────────────

describe("7 retry policy", () => {
  it("retries transport errors, not auth/cli-missing/format", () => {
    expect(isRetryable("NETWORK_ERROR")).toBe(true);
    expect(isRetryable("RATE_LIMIT")).toBe(true);
    expect(isRetryable("AUTH_ERROR")).toBe(false);
    expect(isRetryable("CLI_MISSING")).toBe(false);
    expect(isRetryable("FORMAT_ERROR")).toBe(false);
  });

  it("exponential backoff, capped at maxDelay", () => {
    const sched = delaySchedule("NETWORK_ERROR", { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 3000, factor: 2 });
    // attempts 1-4 -> 500, 1000, 2000, then 4000 capped to 3000
    expect(sched).toEqual([500, 1000, 2000, 3000]);
  });

  it("stops retrying at maxAttempts", () => {
    const d = decideRetry(4, "NETWORK_ERROR", DEFAULT_RETRY_POLICY, null, 0);
    expect(d.retry).toBe(false);
  });

  it("rate-limit honors reset time when later than backoff", () => {
    const d = decideRetry(1, "RATE_LIMIT", DEFAULT_RETRY_POLICY, 10_000, 0);
    expect(d.retry).toBe(true);
    expect(d.delayMs).toBe(10_000); // reset wait dominates the 500ms backoff
  });
});

// ── circuit breaker ───────────────────────────────────────────────────────────

describe("7 circuit breaker", () => {
  it("opens after threshold consecutive failures", () => {
    let s = initBreaker();
    for (let i = 0; i < DEFAULT_BREAKER.failureThreshold; i++) s = breakerOnFailure(s, DEFAULT_BREAKER, 0);
    expect(s.phase).toBe("OPEN");
    expect(breakerAllows(s, DEFAULT_BREAKER, 0).allowed).toBe(false);
  });

  it("half-opens after cooldown, resets on success", () => {
    let s = initBreaker();
    for (let i = 0; i < DEFAULT_BREAKER.failureThreshold; i++) s = breakerOnFailure(s, DEFAULT_BREAKER, 0);
    const afterCooldown = breakerAllows(s, DEFAULT_BREAKER, DEFAULT_BREAKER.cooldownMs);
    expect(afterCooldown.allowed).toBe(true);
    expect(afterCooldown.state.phase).toBe("HALF_OPEN");
    expect(breakerOnSuccess().phase).toBe("CLOSED");
  });
});

// ── concurrency + cost ────────────────────────────────────────────────────────

describe("7 concurrency + cost guards", () => {
  it("concurrency limiter caps in-flight", () => {
    let s = initConcurrency(2);
    const a = tryAcquireSlot(s); s = a.state;
    const b = tryAcquireSlot(s); s = b.state;
    const c = tryAcquireSlot(s);
    expect(a.acquired && b.acquired).toBe(true);
    expect(c.acquired).toBe(false); // third refused
    s = releaseSlot(s);
    expect(tryAcquireSlot(s).acquired).toBe(true); // slot freed
  });

  it("cost guard refuses spend beyond budget, rolls window", () => {
    const budget = { windowMs: 1000, maxWeight: 10 };
    let s = initCost(0);
    const first = trySpend(s, budget, 8, 0); s = first.state;
    const second = trySpend(s, budget, 5, 100); // would exceed 10
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    // after window rolls, budget resets
    const third = trySpend(s, budget, 5, 2000);
    expect(third.allowed).toBe(true);
  });
});

// ── classification ────────────────────────────────────────────────────────────

describe("7 classify", () => {
  it("success on exit 0 with output", () => {
    expect(classifyRunResult({ exitCode: 0, stdout: "[]", stderr: "" }).ok).toBe(true);
  });
  it("429 -> RATE_LIMIT with reset ms", () => {
    const c = classifyRunResult({ exitCode: 1, stdout: "", stderr: "429 rate limit", headers: { "x-ratelimit-reset": "5" } });
    expect(c.ok).toBe(false);
    if (!c.ok) { expect(c.kind).toBe("RATE_LIMIT"); expect(c.resetAtMs).toBe(5000); }
  });
  it("timeout -> NETWORK_ERROR (retryable)", () => {
    const c = classifyRunResult({ exitCode: 1, stdout: "", stderr: "TIMEOUT" });
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.kind).toBe("NETWORK_ERROR");
  });
  it("auth -> AUTH_ERROR (non-retryable)", () => {
    const c = classifyRunResult({ exitCode: 1, stdout: "", stderr: "401 auth failed" });
    if (!c.ok) expect(c.kind).toBe("AUTH_ERROR");
  });
});

// ── ResilientCliExecutor: failure injection ──────────────────────────────────

function scriptedCli(results: CliRunResult[]): CliExecutor {
  let i = 0;
  return { async run() { return results[Math.min(i++, results.length - 1)]!; } };
}

describe("7 ResilientCliExecutor — failure injection", () => {
  it("retries a transient network error then succeeds", async () => {
    const time = virtualTime();
    const inner = scriptedCli([
      { exitCode: 1, stdout: "", stderr: "network error" },
      { exitCode: 0, stdout: "[]", stderr: "" },
    ]);
    const exec = new ResilientCliExecutor({ inner, time });
    const res = await exec.run(["market", "kline"]);
    expect(res.exitCode).toBe(0);
    expect(time.slept.length).toBe(1); // one backoff sleep
  });

  it("gives up on a non-retryable auth error without retrying", async () => {
    const time = virtualTime();
    let calls = 0;
    const inner: CliExecutor = { async run() { calls++; return { exitCode: 1, stdout: "", stderr: "401 auth" }; } };
    const exec = new ResilientCliExecutor({ inner, time });
    const res = await exec.run(["x"]);
    expect(res.exitCode).toBe(1);
    expect(calls).toBe(1); // no retry on auth
  });

  it("kill switch stops the call immediately (no runaway)", async () => {
    const time = virtualTime();
    let calls = 0;
    const inner: CliExecutor = { async run() { calls++; return { exitCode: 0, stdout: "[]", stderr: "" }; } };
    const exec = new ResilientCliExecutor({ inner, time, killSwitch: () => engageKill("maintenance") });
    const res = await exec.run(["x"]);
    expect(res.stderr).toContain("KILL_SWITCH");
    expect(calls).toBe(0); // inner never called
  });

  it("circuit opens after repeated failures and then refuses fast", async () => {
    const time = virtualTime();
    const inner: CliExecutor = { async run() { return { exitCode: 1, stdout: "", stderr: "network error" }; } };
    const exec = new ResilientCliExecutor({ inner, time, config: {
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, factor: 2 },
      breaker: { failureThreshold: 3, cooldownMs: 1000 },
      timeoutMs: 1000,
    } });
    // 3 runs, each 1 attempt failing -> breaker opens
    await exec.run(["x"]); await exec.run(["x"]); await exec.run(["x"]);
    const res = await exec.run(["x"]);
    expect(res.stderr).toBe("CIRCUIT_OPEN");
  });

  it("observer receives structured events", async () => {
    const time = virtualTime();
    const events: string[] = [];
    const observer: Observer = {
      onAttempt: () => events.push("attempt"),
      onSuccess: () => events.push("success"),
      onFailure: () => events.push("failure"),
      onGiveUp: () => events.push("giveup"),
      onKilled: () => events.push("killed"),
      onBreakerOpen: () => events.push("breaker"),
    };
    const inner = scriptedCli([
      { exitCode: 1, stdout: "", stderr: "network error" },
      { exitCode: 0, stdout: "[]", stderr: "" },
    ]);
    const exec = new ResilientCliExecutor({ inner, time, observer });
    await exec.run(["x"]);
    expect(events).toContain("attempt");
    expect(events).toContain("failure");
    expect(events).toContain("success");
  });
});
