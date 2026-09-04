/**
 * WAR experience — Liquidity view-model (Phase B follow-on).
 *
 * Aggregates the EXISTING WorldState.flowEntities into display-ready liquidity
 * numbers: inflow (buys), outflow (sells), net, total, and per-lane breakdown.
 *
 * This mirrors the aggregation the core flowEngine already performs
 * (buyUsd / sellUsd / netFlowUsd) — it is a presentation re-sum of values the
 * engine produced, NOT new intelligence. It scores nothing, classifies no
 * wallet (persona stays UNKNOWN), and invents no field. When there are no flow
 * entities, it reports zeros honestly and flags `hasFlow=false` so the UI can
 * say "no flow observed" instead of implying activity.
 */

import type { WorldState } from "../world/worldAdapter.js";

export type FlowLane = "SMART_MONEY" | "KOL" | "FOLLOW_WALLET" | "OTHER";

export interface LaneBreakdown {
  readonly lane: FlowLane;
  readonly buyUsd: number;
  readonly sellUsd: number;
  readonly count: number;
}

export interface WalletFlow {
  readonly maker: string;
  readonly side: "buy" | "sell";
  readonly amountUsd: number;
  readonly lane: FlowLane;
  readonly persona: "UNKNOWN";
}

export interface LiquidityView {
  /** Sum of buy amounts (inflow). Mirrors flowEngine.buyPressureUsd. */
  readonly inflowUsd: number;
  /** Sum of sell amounts (outflow). Mirrors flowEngine.sellPressureUsd. */
  readonly outflowUsd: number;
  /** inflow - outflow. Mirrors flowEngine.netFlowUsd. */
  readonly netUsd: number;
  /** inflow + outflow. */
  readonly totalUsd: number;
  /** inflow / total in 0..1 (0.5 when no flow). Presentation split only. */
  readonly inflowShare: number;
  readonly buyCount: number;
  readonly sellCount: number;
  /** Distinct maker count — mirrors flowEngine.distinctMakers. */
  readonly distinctMakers: number;
  /** False when there are zero flow entities (honest emptiness). */
  readonly hasFlow: boolean;
  /** Per-lane aggregation, in a stable lane order. */
  readonly lanes: readonly LaneBreakdown[];
  /** Wallet-level rows, largest amount first (pass-through, persona UNKNOWN). */
  readonly wallets: readonly WalletFlow[];
}

const LANE_ORDER: readonly FlowLane[] = ["SMART_MONEY", "KOL", "FOLLOW_WALLET", "OTHER"];

export function toLiquidityView(state: WorldState): LiquidityView {
  let inflowUsd = 0;
  let outflowUsd = 0;
  let buyCount = 0;
  let sellCount = 0;

  const laneMap = new Map<FlowLane, { buyUsd: number; sellUsd: number; count: number }>();
  const makers = new Set<string>();

  for (const f of state.flowEntities) {
    const amt = Number.isFinite(f.amountUsd) ? f.amountUsd : 0;
    makers.add(f.maker);
    const lane = laneMap.get(f.lane) ?? { buyUsd: 0, sellUsd: 0, count: 0 };
    lane.count += 1;
    if (f.side === "buy") {
      inflowUsd += amt;
      buyCount += 1;
      lane.buyUsd += amt;
    } else {
      outflowUsd += amt;
      sellCount += 1;
      lane.sellUsd += amt;
    }
    laneMap.set(f.lane, lane);
  }

  const totalUsd = inflowUsd + outflowUsd;
  const netUsd = inflowUsd - outflowUsd;
  const inflowShare = totalUsd > 0 ? inflowUsd / totalUsd : 0.5;

  const lanes: LaneBreakdown[] = [];
  for (const lane of LANE_ORDER) {
    const agg = laneMap.get(lane);
    if (agg) lanes.push({ lane, buyUsd: agg.buyUsd, sellUsd: agg.sellUsd, count: agg.count });
  }

  const wallets: WalletFlow[] = state.flowEntities
    .map((f) => ({
      maker: f.maker,
      side: f.side,
      amountUsd: f.amountUsd,
      lane: f.lane,
      persona: f.persona,
    }))
    .sort((a, b) => b.amountUsd - a.amountUsd);

  return {
    inflowUsd,
    outflowUsd,
    netUsd,
    totalUsd,
    inflowShare,
    buyCount,
    sellCount,
    distinctMakers: makers.size,
    hasFlow: state.flowEntities.length > 0,
    lanes,
    wallets,
  };
}
