/**
 * WAR core - Feature layer - EngineSnapshot extraction (Phase 6, monitor).
 *
 * detectEvents(before, after) needs two EngineSnapshots. In a MONITOR context
 * (not scan, per B1), we hold the prior evaluation's snapshot and compare it to
 * the current one. This helper extracts a snapshot from a battlefield entry.
 *
 * This is a pure structural projection — it reads already-computed engine outputs
 * and copies them into the EngineSnapshot shape. No new intelligence.
 */

import type { UnixMillis } from "../../shared/scalars.js";
import type { TokenBattlefieldEntry } from "../battlefield/types.js";
import type { EngineSnapshot } from "../events/eventDetector.js";

/** Project a battlefield entry (at instant `at`) into an EngineSnapshot. */
export function snapshotOf(entry: TokenBattlefieldEntry, at: UnixMillis): EngineSnapshot {
  return {
    at,
    power: entry.power.score as number,
    threat: entry.threat.score as number,
    netCoherence: entry.coherence.state === "INSUFFICIENT" ? 0 : (entry.coherence.netCoherence as number),
    leadLagFlowLeads: entry.leadLag.result === "FLOW_LEADS",
    state: entry.state,
  };
}
