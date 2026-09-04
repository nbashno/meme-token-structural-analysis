/**
 * WAR experience — Inspector view-model (Phase B / B8).
 *
 * When a world is selected, the HUD shows its full tactical read. This module
 * projects an EXISTING WorldState into display-ready fields. It performs ZERO
 * intelligence: every field traces 1:1 to WorldState (which itself passed
 * through from the IntelligenceReport). It only formats — rounds, orders,
 * surfaces INSUFFICIENT honestly. It never converts INSUFFICIENT to 0.
 */

import type { WorldState } from "../world/worldAdapter.js";
import { toLiquidityView, type LiquidityView } from "./liquidityView.js";

export interface InspectorForce {
  readonly raw: number; // 0..100 exactly as computed
  readonly band: string; // WorldState-provided band label (passed through)
}

export interface InspectorEvent {
  readonly type: string;
  readonly importance: number;
  readonly reason: string;
}

export interface InspectorSignal {
  readonly identity: string;
  readonly phase: string;
}

export interface InspectorFlow {
  readonly lane: string;
  readonly side: "buy" | "sell";
  readonly amountUsd: number;
  readonly persona: "UNKNOWN"; // always UNKNOWN — no classifier exists
}

export interface InspectorView {
  readonly chain: string;
  readonly address: string;
  readonly generatedAt: number;

  readonly mood: string; // = real Core state
  readonly trajectory: string;
  readonly coherence: string;
  readonly leadLag: string;
  readonly regime: string;

  readonly power: InspectorForce;
  readonly threat: InspectorForce;
  readonly confidence: InspectorForce;
  readonly attention: InspectorForce;

  readonly whyNow: readonly string[];
  readonly events: readonly InspectorEvent[];
  readonly signals: readonly InspectorSignal[];
  readonly flows: readonly InspectorFlow[];
  /** Aggregated liquidity (in/out/net) — see liquidityView. */
  readonly liquidity: LiquidityView;

  readonly dataQuality: string;
  readonly qualityReasons: readonly string[];
  /** Surfaced, never hidden, never replaced with 0. */
  readonly insufficient: readonly string[];
}

function force(f: { raw: number; band: string }): InspectorForce {
  return { raw: f.raw, band: f.band };
}

/**
 * Project a WorldState into the inspector view. Events are ordered by their
 * ALREADY-COMPUTED importance (descending) — an ordering of existing values,
 * not a new score. Nothing here decides what changed or what matters.
 */
export function toInspectorView(state: WorldState): InspectorView {
  return {
    chain: state.chain,
    address: state.address,
    generatedAt: state.generatedAt,

    mood: state.mood,
    trajectory: state.trajectory,
    coherence: state.coherence,
    leadLag: state.leadLag,
    regime: state.regime,

    power: force(state.power),
    threat: force(state.threat),
    confidence: force(state.confidence),
    attention: force(state.attention),

    whyNow: state.whyNow,
    events: [...state.events]
      .sort((a, b) => b.importance - a.importance)
      .map((e) => ({ type: e.type, importance: e.importance, reason: e.reason })),
    signals: state.signals.map((s) => ({ identity: s.identity, phase: s.phase })),
    flows: state.flowEntities.map((f) => ({
      lane: f.lane,
      side: f.side,
      amountUsd: f.amountUsd,
      persona: f.persona,
    })),
    liquidity: toLiquidityView(state),

    dataQuality: state.dataQuality,
    qualityReasons: state.qualityReasons,
    insufficient: state.insufficient,
  };
}
