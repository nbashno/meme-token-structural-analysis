/**
 * WAR integration - Monitor tick engine (Phase 6).
 *
 * A MONITORING session evaluates a token repeatedly over T0->T1->T2... Unlike a
 * scan (B1: no before/after), a monitor HOLDS the prior evaluation and compares.
 * This pure function advances one tick: it threads the carry-over state across
 * ticks and produces events, alerts, and a persistence decision.
 *
 * It adds NO new intelligence: events come from the real detectEvents, alerts
 * from the real AlertService, novelty from the real recordPattern, persistence
 * from the real decidePersist. The monitor's job is to CONNECT ticks over time,
 * which is exactly the context B1 reserved these transition signals for.
 *
 * Deterministic: no clock, no randomness. The tick instant is passed in.
 */

import type { UnixMillis } from "../shared/scalars.js";
import type { BattlefieldState } from "../core/battlefield/types.js";
import type { MarketEvent } from "../core/state/types.js";
import { detectEvents, type EngineSnapshot } from "../core/events/eventDetector.js";
import { snapshotOf } from "../core/features/engineSnapshot.js";
import { AlertService, type Alert, type SignalPhaseMemory } from "../product/intelligence/alerts.js";
import {
  fingerprint,
  decidePersist,
  type EntityFingerprint,
  type PersistDecision,
} from "../product/persistence/tokenMemory.js";
import type { TokenAddress } from "../shared/scalars.js";

/** Everything a monitor carries from one tick to the next. */
export interface MonitorCarry {
  readonly priorSnapshot: EngineSnapshot | null;
  readonly signalPhaseMemory: SignalPhaseMemory;
  readonly priorFingerprint: EntityFingerprint | null;
  readonly lastCheckpointAt: number | null;
}

export function initialCarry(): MonitorCarry {
  return { priorSnapshot: null, signalPhaseMemory: {}, priorFingerprint: null, lastCheckpointAt: null };
}

export interface MonitorTickResult {
  readonly events: readonly MarketEvent[];
  readonly alerts: readonly Alert[];
  readonly persist: PersistDecision;
  readonly nextCarry: MonitorCarry;
}

const alertService = new AlertService();

/**
 * Advance one monitoring tick for a single token.
 *
 * @param battlefield the freshly-evaluated BattlefieldState at this tick
 * @param address     the token under monitoring
 * @param at          the tick instant
 * @param carry       state carried from the previous tick
 */
export function monitorTick(
  battlefield: BattlefieldState,
  address: TokenAddress,
  at: UnixMillis,
  carry: MonitorCarry,
): MonitorTickResult {
  const entry = battlefield.tokens.find((t) => t.address === address);
  if (!entry) {
    // No meaningful result this tick: carry forward unchanged, nothing to persist.
    return {
      events: [],
      alerts: [],
      persist: { persist: false, reasons: ["no token in battlefield"] },
      nextCarry: carry,
    };
  }

  const currentSnapshot = snapshotOf(entry, at);

  // Events: only when we have a prior snapshot (monitor, not scan).
  const events: readonly MarketEvent[] =
    carry.priorSnapshot === null ? [] : detectEvents(carry.priorSnapshot, currentSnapshot);

  // Alerts: from the real AlertService (events + signal-phase transitions).
  const alertOutcome = alertService.evaluate(entry, carry.signalPhaseMemory);

  // Change-aware persistence decision.
  const fp = fingerprint(entry);
  const persist = decidePersist(carry.priorFingerprint, fp, carry.lastCheckpointAt, at as number);

  const nextCarry: MonitorCarry = {
    priorSnapshot: currentSnapshot,
    signalPhaseMemory: alertOutcome.nextMemory,
    priorFingerprint: fp,
    lastCheckpointAt: persist.persist ? (at as number) : carry.lastCheckpointAt,
  };

  return { events, alerts: alertOutcome.alerts, persist, nextCarry };
}
