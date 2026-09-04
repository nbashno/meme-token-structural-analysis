/**
 * WAR hardening - kill switch, circuit breaker, concurrency + cost guards
 * (Phase 7). Pure, deterministic state threaded as values. No IO.
 *
 * These protect the system from runaway polling, cascading failures, and cost
 * blowout. None of them touch intelligence; they gate whether a transport call
 * is allowed to proceed.
 */

// ── Kill switch ───────────────────────────────────────────────────────────────

/** A global, explicit stop. When engaged, NO acquisition proceeds. */
export interface KillSwitch {
  readonly engaged: boolean;
  readonly reason: string | null;
}

export const KILL_SWITCH_OFF: KillSwitch = { engaged: false, reason: null };

export function engageKill(reason: string): KillSwitch {
  return { engaged: true, reason };
}

// ── Circuit breaker ───────────────────────────────────────────────────────────

/**
 * Trips OPEN after `failureThreshold` consecutive failures; stays open for
 * `cooldownMs`; then HALF_OPEN allows one trial. Deterministic on injected time.
 */
export type BreakerPhase = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface BreakerConfig {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
}

export const DEFAULT_BREAKER: BreakerConfig = { failureThreshold: 5, cooldownMs: 60_000 };

export interface BreakerState {
  readonly phase: BreakerPhase;
  readonly consecutiveFailures: number;
  readonly openedAt: number | null;
}

export function initBreaker(): BreakerState {
  return { phase: "CLOSED", consecutiveFailures: 0, openedAt: null };
}

/** Can a call proceed right now? Transitions OPEN->HALF_OPEN after cooldown. */
export function breakerAllows(state: BreakerState, config: BreakerConfig, now: number): { allowed: boolean; state: BreakerState } {
  if (state.phase === "OPEN") {
    if (state.openedAt !== null && now - state.openedAt >= config.cooldownMs) {
      return { allowed: true, state: { ...state, phase: "HALF_OPEN" } };
    }
    return { allowed: false, state };
  }
  return { allowed: true, state };
}

export function breakerOnSuccess(): BreakerState {
  return initBreaker(); // reset fully on success
}

export function breakerOnFailure(state: BreakerState, config: BreakerConfig, now: number): BreakerState {
  const failures = state.consecutiveFailures + 1;
  if (failures >= config.failureThreshold) {
    return { phase: "OPEN", consecutiveFailures: failures, openedAt: now };
  }
  return { phase: state.phase === "HALF_OPEN" ? "OPEN" : "CLOSED", consecutiveFailures: failures, openedAt: state.phase === "HALF_OPEN" ? now : state.openedAt };
}

// ── Concurrency limiter ───────────────────────────────────────────────────────

export interface ConcurrencyState {
  readonly inFlight: number;
  readonly max: number;
}

export function initConcurrency(max: number): ConcurrencyState {
  return { inFlight: 0, max };
}

export function tryAcquireSlot(state: ConcurrencyState): { acquired: boolean; state: ConcurrencyState } {
  if (state.inFlight >= state.max) return { acquired: false, state };
  return { acquired: true, state: { ...state, inFlight: state.inFlight + 1 } };
}

export function releaseSlot(state: ConcurrencyState): ConcurrencyState {
  return { ...state, inFlight: Math.max(0, state.inFlight - 1) };
}

// ── Cost guard ────────────────────────────────────────────────────────────────

/**
 * Tracks GMGN request-weight spend within a rolling budget window. Refuses calls
 * that would exceed the budget — protecting against cost blowout from runaway
 * polling or a monitor storm.
 */
export interface CostBudget {
  readonly windowMs: number;
  readonly maxWeight: number;
}

export interface CostState {
  readonly windowStart: number;
  readonly spentWeight: number;
}

export function initCost(now: number): CostState {
  return { windowStart: now, spentWeight: 0 };
}

export function trySpend(state: CostState, budget: CostBudget, weight: number, now: number): { allowed: boolean; state: CostState } {
  // Roll the window forward if elapsed.
  let s = state;
  if (now - state.windowStart >= budget.windowMs) {
    s = { windowStart: now, spentWeight: 0 };
  }
  if (s.spentWeight + weight > budget.maxWeight) {
    return { allowed: false, state: s };
  }
  return { allowed: true, state: { ...s, spentWeight: s.spentWeight + weight } };
}
