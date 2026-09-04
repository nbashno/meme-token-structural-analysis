/**
 * WAR core - Signal Lifecycle (Phase 10).
 *
 * A persistent condition is ONE signal that evolves, not a stream of duplicate
 * notifications. Given a stable SignalIdentity, the manager advances its phase:
 *
 *   EMERGING -> CONFIRMING -> CONFIRMED -> WEAKENING -> INVALIDATED / EXPIRED
 *
 * The same continuing condition updates the existing signal instead of creating
 * a new one. Time is injected. Pure, total, deterministic.
 */

import type { UnixMillis } from "../../shared/scalars.js";
import type { Signal, SignalPhase, SignalIdentity } from "../state/types.js";

/** Observation about a signal at one instant: is its condition currently present? */
export interface SignalObservation {
  readonly identity: SignalIdentity;
  readonly at: UnixMillis;
  /** True if the underlying condition is currently supported by evidence. */
  readonly present: boolean;
  /** Strength of support in [0,1]; drives CONFIRMING -> CONFIRMED. */
  readonly support: number;
  readonly reason: string;
}

export interface SignalConfig {
  readonly version: string;
  /** Support at/above this promotes CONFIRMING -> CONFIRMED. */
  readonly confirmSupport: number;
  /** Time (ms) absent before a WEAKENING signal becomes EXPIRED. */
  readonly expiryMs: number;
}

export const SIGNAL_CONFIG: SignalConfig = {
  version: "signal-v1",
  confirmSupport: 0.7,
  expiryMs: 300_000, // 5 min
};

/**
 * Advance one signal given the prior signal (or null for first sighting) and a
 * new observation. Returns the updated signal. Never creates a duplicate: the
 * identity is preserved and the phase transitions in place.
 */
export function advanceSignal(
  prior: Signal | null,
  obs: SignalObservation,
  config: SignalConfig = SIGNAL_CONFIG,
): Signal {
  // First sighting.
  if (prior === null) {
    return {
      identity: obs.identity,
      phase: obs.present ? "EMERGING" : "EXPIRED",
      firstObservedAt: obs.at,
      lastUpdatedAt: obs.at,
      reasons: [obs.reason],
    };
  }

  const nextPhase = nextSignalPhase(prior.phase, obs, prior, config);

  return {
    identity: prior.identity,
    phase: nextPhase,
    firstObservedAt: prior.firstObservedAt,
    lastUpdatedAt: obs.at,
    // Keep a bounded, deterministic reason trail (latest last).
    reasons: [...prior.reasons, obs.reason].slice(-8),
  };
}

function nextSignalPhase(
  current: SignalPhase,
  obs: SignalObservation,
  prior: Signal,
  config: SignalConfig,
): SignalPhase {
  const confirmed = obs.support >= config.confirmSupport;

  if (obs.present) {
    switch (current) {
      case "EMERGING":
        return confirmed ? "CONFIRMED" : "CONFIRMING";
      case "CONFIRMING":
        return confirmed ? "CONFIRMED" : "CONFIRMING";
      case "CONFIRMED":
        return "CONFIRMED";
      case "WEAKENING":
        // condition returned -> re-confirm
        return confirmed ? "CONFIRMED" : "CONFIRMING";
      case "INVALIDATED":
      case "EXPIRED":
        // a terminal signal stays terminal; a genuinely new occurrence should
        // arrive under a fresh identity, not resurrect this one.
        return current;
      default:
        return current;
    }
  }

  // condition absent this observation
  switch (current) {
    case "EMERGING":
    case "CONFIRMING":
      return "INVALIDATED"; // never confirmed, condition gone
    case "CONFIRMED":
      return "WEAKENING";
    case "WEAKENING": {
      const absentFor = (obs.at as number) - (prior.lastUpdatedAt as number);
      return absentFor >= config.expiryMs ? "EXPIRED" : "WEAKENING";
    }
    case "INVALIDATED":
    case "EXPIRED":
      return current;
    default:
      return current;
  }
}

/** Terminal phases: a signal here will not evolve further. */
export function isTerminalPhase(phase: SignalPhase): boolean {
  return phase === "INVALIDATED" || phase === "EXPIRED";
}
