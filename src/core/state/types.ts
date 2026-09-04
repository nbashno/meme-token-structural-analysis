/**
 * WAR core — state / events / signal lifecycle / novelty / attention
 * (Phase 2, types only).
 */

import type { Score0to100, Ratio0to1, UnixMillis } from "../../shared/scalars.js";

// ── State machine ────────────────────────────────────────────────────────────

/** Deterministic market lifecycle states. */
export type MarketState =
  | "UNKNOWN"
  | "OBSERVING"
  | "EMERGING"
  | "ACCUMULATION"
  | "ATTACK"
  | "DOMINANCE"
  | "DISTRIBUTION"
  | "BLEEDING"
  | "COLLAPSE"
  | "DORMANT";

/**
 * A recorded transition. Never a single-condition jump (e.g. "Power>80 → ATTACK").
 * Transitions require multiple conditions and record every reason.
 */
export interface StateTransition {
  readonly from: MarketState;
  readonly to: MarketState;
  readonly at: UnixMillis;
  readonly reasons: readonly string[];
  /** Whether hysteresis / minimum-dwell gates were satisfied. */
  readonly hysteresisSatisfied: boolean;
}

// ── Events ───────────────────────────────────────────────────────────────────

export type EventType =
  | "POWER_BREAKOUT"
  | "POWER_COLLAPSE"
  | "TRAJECTORY_ACCELERATION"
  | "TRAJECTORY_DECELERATION"
  | "REVERSAL"
  | "SIGNAL_CONFLICT"
  | "SIGNAL_ALIGNMENT"
  | "LIQUIDITY_EXPANSION"
  | "LIQUIDITY_COLLAPSE"
  | "SMART_MONEY_SURGE"
  | "SMART_MONEY_EXIT"
  | "THREAT_SPIKE"
  | "STABILITY_BREAK"
  | "STATE_CHANGE"
  | "FLOW_DIVERGENCE"
  | "FLOW_CLUSTER";

/** A semantic market fact — not an animation. Severity/importance are market meaning. */
export interface MarketEvent {
  readonly type: EventType;
  readonly at: UnixMillis;
  readonly severity: Score0to100;
  readonly importance: Score0to100;
  readonly reasons: readonly string[];
  readonly beforeState: MarketState;
  readonly afterState: MarketState;
}

// ── Signal lifecycle ─────────────────────────────────────────────────────────

/** A persistent signal evolves through phases; it does not re-fire per tick. */
export type SignalPhase =
  | "EMERGING"
  | "CONFIRMING"
  | "CONFIRMED"
  | "WEAKENING"
  | "INVALIDATED"
  | "EXPIRED";

/** Stable identity so one continuing condition is one signal, not 20 notifications. */
export type SignalIdentity = string;

export interface Signal {
  readonly identity: SignalIdentity;
  readonly phase: SignalPhase;
  readonly firstObservedAt: UnixMillis;
  readonly lastUpdatedAt: UnixMillis;
  readonly reasons: readonly string[];
}

// ── Novelty ──────────────────────────────────────────────────────────────────

/**
 * Novelty ≠ anomaly. Anomaly = how unusual is the current value. Novelty = how
 * rarely WAR has seen this pattern. A recurring anomaly may be low-novelty.
 * Novelty feeds Attention, never Power.
 */
export interface Novelty {
  readonly rarity: Ratio0to1;
  readonly reasons: readonly string[];
}

// ── Attention ────────────────────────────────────────────────────────────────

/** Why the operator should look here now. Independent of Power. */
export type AttentionContributor =
  | "MAGNITUDE"
  | "ACCELERATION"
  | "NOVELTY"
  | "STATE_TRANSITION"
  | "TRAJECTORY_REVERSAL"
  | "SIGNAL_CONFLICT"
  | "UNCERTAINTY"
  | "CROSS_TOKEN_IMPACT";

export interface Attention {
  readonly score: Score0to100;
  readonly contributors: readonly AttentionContributor[];
}
