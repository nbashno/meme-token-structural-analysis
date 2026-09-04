/**
 * WAR Product Layer - Phase 1 - Signal continuity + Alerts.
 *
 * The Product Layer reacts to WAR's semantic events and signal-lifecycle
 * transitions. It NEVER calculates intelligence and NEVER invents events.
 *
 *   - Signal continuity: one SignalIdentity is one evolving signal. A user is
 *     alerted on meaningful PHASE transitions, not once per tick (spec sec.17).
 *   - Attention != Alert (spec sec.19): high Attention does NOT auto-alert.
 *     Alert policy is a product-level configuration applied to Core events.
 *
 * AlertService is a pure reducer over (previous signal phases, new Core outputs).
 */

import type { MarketEvent, Signal, SignalPhase } from "../../core/state/types.js";
import type { TokenBattlefieldEntry } from "../../core/battlefield/types.js";

export type AlertReason =
  | "NEW_SIGNAL"
  | "SIGNAL_CONFIRMED"
  | "SIGNAL_WEAKENING"
  | "SIGNAL_INVALIDATED"
  | "STATE_CHANGED"
  | "THREAT_SPIKE"
  | "REVERSAL"
  | "FLOW_DIVERGENCE"
  | "UNUSUAL_EVENT";

export interface Alert {
  readonly reason: AlertReason;
  readonly at: number; // UnixMillis (from the Core event/signal timestamp)
  readonly detail: string;
}

/** Snapshot of the last-known phase per signal identity, threaded as a value. */
export type SignalPhaseMemory = Readonly<Record<string, SignalPhase>>;

/** Alert policy: which event types raise an alert. Product-level, configurable. */
export interface AlertPolicy {
  readonly eventTypesToAlert: ReadonlySet<MarketEvent["type"]>;
}

export const DEFAULT_ALERT_POLICY: AlertPolicy = {
  eventTypesToAlert: new Set<MarketEvent["type"]>([
    "STATE_CHANGE",
    "THREAT_SPIKE",
    "REVERSAL",
    "FLOW_DIVERGENCE",
    "POWER_BREAKOUT",
    "POWER_COLLAPSE",
    "SMART_MONEY_SURGE",
    "SMART_MONEY_EXIT",
    "LIQUIDITY_COLLAPSE",
  ]),
};

function eventReason(type: MarketEvent["type"]): AlertReason {
  switch (type) {
    case "STATE_CHANGE":
      return "STATE_CHANGED";
    case "THREAT_SPIKE":
      return "THREAT_SPIKE";
    case "REVERSAL":
      return "REVERSAL";
    case "FLOW_DIVERGENCE":
      return "FLOW_DIVERGENCE";
    default:
      return "UNUSUAL_EVENT";
  }
}

/** Alerts derived from a signal's phase change relative to memory. */
function signalAlert(sig: Signal, prev: SignalPhase | undefined): Alert | null {
  if (prev === sig.phase) return null; // no change => no notification
  switch (sig.phase) {
    case "EMERGING":
      if (prev === undefined) {
        return { reason: "NEW_SIGNAL", at: sig.lastUpdatedAt as number, detail: sig.identity };
      }
      return null;
    case "CONFIRMED":
      return { reason: "SIGNAL_CONFIRMED", at: sig.lastUpdatedAt as number, detail: sig.identity };
    case "WEAKENING":
      return { reason: "SIGNAL_WEAKENING", at: sig.lastUpdatedAt as number, detail: sig.identity };
    case "INVALIDATED":
      return { reason: "SIGNAL_INVALIDATED", at: sig.lastUpdatedAt as number, detail: sig.identity };
    default:
      return null; // CONFIRMING / EXPIRED do not raise a user alert by default
  }
}

export interface AlertOutcome {
  readonly alerts: readonly Alert[];
  readonly nextMemory: SignalPhaseMemory;
}

export class AlertService {
  private readonly policy: AlertPolicy;
  constructor(policy: AlertPolicy = DEFAULT_ALERT_POLICY) {
    this.policy = policy;
  }

  /**
   * Pure evaluation for one token entry against prior signal-phase memory.
   * Returns alerts + the updated memory to thread forward. No side effects.
   */
  evaluate(entry: TokenBattlefieldEntry, memory: SignalPhaseMemory): AlertOutcome {
    const alerts: Alert[] = [];

    // Event-driven alerts (Core events only, filtered by product policy).
    for (const ev of entry.events) {
      if (this.policy.eventTypesToAlert.has(ev.type)) {
        alerts.push({
          reason: eventReason(ev.type),
          at: ev.at as number,
          detail: ev.reasons.length > 0 ? ev.reasons[0]! : ev.type,
        });
      }
    }

    // Signal-lifecycle alerts (phase transitions vs memory).
    const nextMemory: Record<string, SignalPhase> = { ...memory };
    for (const sig of entry.signals) {
      const prev = memory[sig.identity];
      const a = signalAlert(sig, prev);
      if (a) alerts.push(a);
      nextMemory[sig.identity] = sig.phase;
    }

    return { alerts, nextMemory };
  }
}
