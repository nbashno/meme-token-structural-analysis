/**
 * WAR core - State Machine configuration (Phase 9).
 *
 * Thresholds, minimum dwell, and hysteresis margins live here, versioned.
 * No single-condition jumps: every transition rule combines several signals.
 */

export interface StateMachineConfig {
  readonly version: string;
  /** Minimum time (ms) a state must be held before it may transition out. */
  readonly minDwellMs: number;
  /** Power thresholds gating entry into stronger states. */
  readonly powerEmerging: number;
  readonly powerAccumulation: number;
  readonly powerAttack: number;
  readonly powerDominance: number;
  /** Coherence (netCoherence 0..1) required for constructive transitions. */
  readonly coherenceMin: number;
  /** Persistence (0..1) required to confirm a directional state. */
  readonly persistenceMin: number;
  /** Confidence (0..100) floor below which we stay OBSERVING. */
  readonly confidenceFloor: number;
  /** Threat (0..100) above which BLEEDING/COLLAPSE take precedence. */
  readonly threatHigh: number;
  /** Hysteresis margin: exit thresholds are this much easier than entry. */
  readonly hysteresisMargin: number;
}

export const STATE_MACHINE_CONFIG: StateMachineConfig = {
  version: "state-v1",
  minDwellMs: 60_000, // 1 min
  powerEmerging: 30,
  powerAccumulation: 45,
  powerAttack: 65,
  powerDominance: 82,
  coherenceMin: 0.6,
  persistenceMin: 0.6,
  confidenceFloor: 25,
  threatHigh: 70,
  hysteresisMargin: 8,
};
