/**
 * WAR core - Event Detector (Phase 10).
 *
 * Produces SEMANTIC market events by comparing two engine snapshots (before ->
 * after). Events are facts, not animations. Each carries severity, importance,
 * reasons, and the before/after states. Config-driven thresholds; no magic
 * numbers. Pure, total, deterministic.
 */

import type { Score0to100, UnixMillis } from "../../shared/scalars.js";
import type { MarketEvent, EventType, MarketState } from "../state/types.js";
import { clampScore } from "../../shared/construct.js";

const S0 = 0 as Score0to100;
function score(n: number): Score0to100 {
  const r = clampScore(n);
  return r.ok ? r.value : S0;
}

/** The comparable slice of engine output at one instant. */
export interface EngineSnapshot {
  readonly at: UnixMillis;
  readonly power: number; // 0..100
  readonly threat: number; // 0..100
  readonly netCoherence: number; // 0..1
  readonly leadLagFlowLeads: boolean;
  readonly state: MarketState;
}

export interface EventConfig {
  readonly version: string;
  /** Power jump (absolute points) to flag a breakout/collapse. */
  readonly powerBreakoutDelta: number;
  /** Threat jump to flag a spike. */
  readonly threatSpikeDelta: number;
  /** netCoherence drop to flag conflict emergence. */
  readonly coherenceConflictDrop: number;
}

export const EVENT_CONFIG: EventConfig = {
  version: "event-v1",
  powerBreakoutDelta: 15,
  threatSpikeDelta: 20,
  coherenceConflictDrop: 0.3,
};

function ev(
  type: EventType,
  at: UnixMillis,
  severity: number,
  importance: number,
  reasons: readonly string[],
  before: MarketState,
  after: MarketState,
): MarketEvent {
  return {
    type,
    at,
    severity: score(severity),
    importance: score(importance),
    reasons,
    beforeState: before,
    afterState: after,
  };
}

/**
 * Detect events between two snapshots. Deterministic emission order (fixed
 * checks in fixed order). Returns [] when nothing crosses a threshold.
 */
export function detectEvents(
  before: EngineSnapshot,
  after: EngineSnapshot,
  config: EventConfig = EVENT_CONFIG,
): readonly MarketEvent[] {
  const out: MarketEvent[] = [];
  const at = after.at;

  const powerDelta = after.power - before.power;
  const threatDelta = after.threat - before.threat;
  const coherenceDrop = before.netCoherence - after.netCoherence;

  // Power breakout / collapse
  if (powerDelta >= config.powerBreakoutDelta) {
    out.push(
      ev("POWER_BREAKOUT", at, powerDelta, after.power,
        [`power +${powerDelta.toFixed(1)}`], before.state, after.state),
    );
  } else if (-powerDelta >= config.powerBreakoutDelta) {
    out.push(
      ev("POWER_COLLAPSE", at, -powerDelta, before.power,
        [`power ${powerDelta.toFixed(1)}`], before.state, after.state),
    );
  }

  // Threat spike
  if (threatDelta >= config.threatSpikeDelta) {
    out.push(
      ev("THREAT_SPIKE", at, threatDelta, after.threat,
        [`threat +${threatDelta.toFixed(1)}`], before.state, after.state),
    );
  }

  // Coherence conflict emerging
  if (coherenceDrop >= config.coherenceConflictDrop) {
    out.push(
      ev("SIGNAL_CONFLICT", at, coherenceDrop * 100, coherenceDrop * 100,
        [`coherence -${coherenceDrop.toFixed(2)}`], before.state, after.state),
    );
  }

  // Flow divergence: flow leads but power/price direction diverges from threat rising
  if (after.leadLagFlowLeads && threatDelta > 0 && powerDelta < 0) {
    out.push(
      ev("FLOW_DIVERGENCE", at, Math.abs(powerDelta) + threatDelta, 70,
        ["flow leads while power falls and threat rises"], before.state, after.state),
    );
  }

  // State change
  if (before.state !== after.state) {
    out.push(
      ev("STATE_CHANGE", at, 50, 60,
        [`state ${before.state} -> ${after.state}`], before.state, after.state),
    );
  }

  return out;
}
