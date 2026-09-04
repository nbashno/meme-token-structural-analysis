/**
 * WAR Product Layer - Phase 1 - TokenMemory + change-aware persistence.
 *
 * TokenMemory is a BOUNDED, VERSIONED intelligence history for tokens WAR has
 * actually observed - NOT an infinite market warehouse (spec sec.6, sec.63).
 * Every persisted record pins provenance + versions for auditability (sec.44/45).
 *
 * Change-aware rule (spec sec.15): do not write N identical product snapshots.
 * Persist state transitions, meaningful metric changes, events, signal-lifecycle
 * transitions, and periodic checkpoints. This module decides WHAT to persist; it
 * does not own a database (repositories arrive in spec Phase 2).
 */

import type { ModelVersions } from "../../shared/quality.js";
import type { MarketState } from "../../core/state/types.js";
import type { TokenBattlefieldEntry } from "../../core/battlefield/types.js";
import type { TokenId } from "../domain/identity.js";

/** Metadata every persisted product record must preserve (spec sec.6). */
export interface RecordProvenance {
  readonly observedAt: number; // when the underlying observation was made
  readonly persistedAt: number; // when the product stored it
  readonly source: "SCAN" | "MONITOR";
  readonly engineVersion: string;
  readonly modelVersions: ModelVersions;
}

export type MemoryRecordKind =
  | "BATTLEFIELD_SNAPSHOT"
  | "STATE_TRANSITION"
  | "EVENT"
  | "SIGNAL_TRANSITION"
  | "CHECKPOINT";

export interface TokenMemoryRecord {
  readonly token: TokenId;
  readonly kind: MemoryRecordKind;
  readonly at: number; // UnixMillis
  readonly provenance: RecordProvenance;
  /** A reference to the heavier payload (e.g. a stored report id). */
  readonly ref: string;
}

/** The minimal fingerprint used to decide whether something meaningfully changed. */
export interface EntityFingerprint {
  readonly state: MarketState;
  readonly powerBucket: number; // Power score bucketed (change-aware, not per-point)
  readonly threatBucket: number;
  readonly eventCount: number;
  readonly signalPhaseKey: string; // concatenation of identity:phase, sorted
}

/** Persistence tuning (configurable sampling / checkpoint cadence, spec sec.15). */
export interface PersistencePolicy {
  /** Power/Threat score delta (0..100) considered "meaningful". */
  readonly scoreBucketSize: number;
  /** Force a checkpoint at least this often, even without change (ms). */
  readonly checkpointIntervalMs: number;
}

export const DEFAULT_PERSISTENCE_POLICY: PersistencePolicy = {
  scoreBucketSize: 10,
  checkpointIntervalMs: 15 * 60 * 1000,
};

function bucket(score: number, size: number): number {
  return Math.floor(score / size);
}

function signalPhaseKey(entry: TokenBattlefieldEntry): string {
  return [...entry.signals]
    .map((s) => `${s.identity}:${s.phase}`)
    .sort()
    .join("|");
}

export function fingerprint(
  entry: TokenBattlefieldEntry,
  policy: PersistencePolicy = DEFAULT_PERSISTENCE_POLICY,
): EntityFingerprint {
  return {
    state: entry.state,
    powerBucket: bucket(entry.power.score as number, policy.scoreBucketSize),
    threatBucket: bucket(entry.threat.score as number, policy.scoreBucketSize),
    eventCount: entry.events.length,
    signalPhaseKey: signalPhaseKey(entry),
  };
}

export interface PersistDecision {
  readonly persist: boolean;
  readonly reasons: readonly string[];
}

/**
 * Decide whether a new observation is worth persisting, given the previous
 * fingerprint and the time of the last checkpoint. Pure and deterministic.
 */
export function decidePersist(
  prev: EntityFingerprint | null,
  next: EntityFingerprint,
  lastCheckpointAt: number | null,
  nowMs: number,
  policy: PersistencePolicy = DEFAULT_PERSISTENCE_POLICY,
): PersistDecision {
  const reasons: string[] = [];
  if (prev === null) {
    return { persist: true, reasons: ["first observation"] };
  }
  if (prev.state !== next.state) reasons.push("state transition");
  if (prev.powerBucket !== next.powerBucket) reasons.push("power change");
  if (prev.threatBucket !== next.threatBucket) reasons.push("threat change");
  if (prev.eventCount !== next.eventCount) reasons.push("new events");
  if (prev.signalPhaseKey !== next.signalPhaseKey) reasons.push("signal lifecycle change");

  if (
    lastCheckpointAt === null ||
    nowMs - lastCheckpointAt >= policy.checkpointIntervalMs
  ) {
    reasons.push("checkpoint interval");
  }

  return { persist: reasons.length > 0, reasons };
}
