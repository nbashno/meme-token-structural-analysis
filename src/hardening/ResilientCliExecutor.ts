/**
 * WAR hardening - ResilientCliExecutor (Phase 7).
 *
 * Wraps any CliExecutor with the full transport-resilience stack:
 *   kill switch -> circuit breaker -> timeout -> retry+backoff -> observability
 *
 * It is a CliExecutor itself, so it drops into the existing scan/monitor
 * composition (createScanService / MonitoringService) WITHOUT changing them:
 * inject a ResilientCliExecutor instead of a raw one.
 *
 * Time and sleeping are injected (clock + sleep) so behaviour is deterministic
 * and testable. It adds NO intelligence; it only governs how the transport call
 * is attempted and observed. Rate limiting is handled by the caller's bucket or
 * can be layered here via the cost guard; this class focuses on retry/breaker/
 * timeout/observability and surfaces structured events for metrics.
 */

import type { CliExecutor, CliRunResult, GmgnErrorKind } from "../adapters/gmgn/gmgnRunner.js";
import { classifyRunResult } from "./classify.js";
import {
  decideRetry,
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
} from "./retryPolicy.js";
import {
  breakerAllows,
  breakerOnFailure,
  breakerOnSuccess,
  initBreaker,
  DEFAULT_BREAKER,
  type BreakerConfig,
  type BreakerState,
  type KillSwitch,
  KILL_SWITCH_OFF,
} from "./guards.js";

/** Injected clock + cooperative sleep, so retries are deterministic in tests. */
export interface TimeProvider {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Structured observability sink. Metrics/logging attach here. */
export interface Observer {
  onAttempt(argv: readonly string[], attempt: number): void;
  onSuccess(argv: readonly string[], attempt: number, elapsedMs: number): void;
  onFailure(argv: readonly string[], attempt: number, kind: GmgnErrorKind): void;
  onGiveUp(argv: readonly string[], attempts: number, kind: GmgnErrorKind): void;
  onKilled(argv: readonly string[], reason: string): void;
  onBreakerOpen(argv: readonly string[]): void;
}

export const NOOP_OBSERVER: Observer = {
  onAttempt() {}, onSuccess() {}, onFailure() {}, onGiveUp() {}, onKilled() {}, onBreakerOpen() {},
};

export interface ResilientConfig {
  readonly retry: RetryPolicy;
  readonly breaker: BreakerConfig;
  readonly timeoutMs: number;
}

export const DEFAULT_RESILIENT_CONFIG: ResilientConfig = {
  retry: DEFAULT_RETRY_POLICY,
  breaker: DEFAULT_BREAKER,
  timeoutMs: 15_000,
};

export interface ResilientDeps {
  readonly inner: CliExecutor;
  readonly time: TimeProvider;
  readonly config?: ResilientConfig;
  readonly observer?: Observer;
  /** A function returning the current kill switch (checked before every call). */
  readonly killSwitch?: () => KillSwitch;
}

export class ResilientCliExecutor implements CliExecutor {
  private breaker: BreakerState = initBreaker();
  private readonly inner: CliExecutor;
  private readonly time: TimeProvider;
  private readonly config: ResilientConfig;
  private readonly observer: Observer;
  private readonly killSwitch: () => KillSwitch;

  constructor(deps: ResilientDeps) {
    this.inner = deps.inner;
    this.time = deps.time;
    this.config = deps.config ?? DEFAULT_RESILIENT_CONFIG;
    this.observer = deps.observer ?? NOOP_OBSERVER;
    this.killSwitch = deps.killSwitch ?? (() => KILL_SWITCH_OFF);
  }

  async run(argv: readonly string[]): Promise<CliRunResult> {
    // Kill switch: hard stop.
    const kill = this.killSwitch();
    if (kill.engaged) {
      this.observer.onKilled(argv, kill.reason ?? "killed");
      return { exitCode: 1, stdout: "", stderr: `KILL_SWITCH: ${kill.reason ?? "engaged"}` };
    }

    // Circuit breaker: refuse fast if open.
    const gate = breakerAllows(this.breaker, this.config.breaker, this.time.now());
    this.breaker = gate.state;
    if (!gate.allowed) {
      this.observer.onBreakerOpen(argv);
      return { exitCode: 1, stdout: "", stderr: "CIRCUIT_OPEN" };
    }

    let attempt = 0;
    let lastResult: CliRunResult = { exitCode: 1, stdout: "", stderr: "not run" };
    while (attempt < this.config.retry.maxAttempts) {
      attempt++;
      this.observer.onAttempt(argv, attempt);
      const startedAt = this.time.now();

      lastResult = await this.withTimeout(this.inner.run(argv), this.config.timeoutMs);
      const classification = classifyRunResult(lastResult);

      if (classification.ok) {
        this.breaker = breakerOnSuccess();
        this.observer.onSuccess(argv, attempt, this.time.now() - startedAt);
        return lastResult;
      }

      const kind = classification.kind;
      this.observer.onFailure(argv, attempt, kind);
      this.breaker = breakerOnFailure(this.breaker, this.config.breaker, this.time.now());

      const decision = decideRetry(attempt, kind, this.config.retry, classification.resetAtMs, this.time.now());
      if (!decision.retry) {
        this.observer.onGiveUp(argv, attempt, kind);
        return lastResult;
      }
      await this.time.sleep(decision.delayMs);
    }
    return lastResult;
  }

  /** Race the inner call against a timeout; timeout yields a TIMEOUT-shaped result. */
  private async withTimeout(p: Promise<CliRunResult>, timeoutMs: number): Promise<CliRunResult> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<CliRunResult>((resolve) => {
      timer = setTimeout(() => resolve({ exitCode: 1, stdout: "", stderr: "TIMEOUT" }), timeoutMs);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /** Test/introspection helper. */
  breakerPhase(): BreakerState["phase"] {
    return this.breaker.phase;
  }
}
