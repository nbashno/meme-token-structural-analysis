/**
 * WAR core - Flow Engine (Phase 5).
 *
 * Consumes NORMALIZED flow observations (never raw GMGN, never the raw source position bit).
 * Flow is not reduced to a single smart-money score; it is decomposed.
 *
 * Coverage discipline: flow is ROLLING. Absence of an exit within the observed
 * window is reported as NO_EXIT_OBSERVED - never OBSERVED_NO_EXIT. Absence is not
 * proof of non-occurrence.
 *
 * Pure, total, deterministic. No clock, no randomness, no IO.
 */

import type { Ratio0to1, UnixMillis, DurationMillis } from "../../shared/scalars.js";
import type { FlowObservation } from "../timeline/types.js";
import { toRatio0to1 } from "../../shared/construct.js";

const R0 = 0 as Ratio0to1;
function ratio(n: number): Ratio0to1 {
  const r = toRatio0to1(n);
  return r.ok ? r.value : R0;
}

/** Exit-observation status under ROLLING coverage. */
export type ExitObservation = "EXIT_OBSERVED" | "NO_EXIT_OBSERVED";

/** A detected convergence of makers on one direction within a time window. */
export interface FlowCluster {
  readonly direction: "buy" | "sell";
  readonly distinctMakers: number;
  readonly totalUsd: number;
  readonly windowStart: UnixMillis;
  readonly windowEnd: UnixMillis;
}

/** The decomposed flow picture for a token over its observed window. */
export interface FlowMetrics {
  readonly netFlowUsd: number;
  readonly buyPressureUsd: number;
  readonly sellPressureUsd: number;
  readonly distinctMakers: number;
  /** Ratio of the largest single maker's USD to total USD (0-1). */
  readonly concentration: Ratio0to1;
  /** Fraction of events agreeing with the dominant direction (0-1). */
  readonly persistence: Ratio0to1;
  /** Whether any exit (sell / close) was seen in the window. */
  readonly exitObservation: ExitObservation;
  readonly eventCount: number;
}

export interface FlowConfig {
  /** Minimum distinct makers, same direction, within window -> a cluster. */
  readonly clusterMinMakers: number;
  /** Cluster time window. */
  readonly clusterWindow: DurationMillis;
}

export const DEFAULT_FLOW_CONFIG: FlowConfig = {
  clusterMinMakers: 3,
  clusterWindow: 1_800_000 as DurationMillis, // 30 min
};

/** Deterministic chronological sort by (time, maker, side, amount). */
function sortFlow(obs: readonly FlowObservation[]): FlowObservation[] {
  return [...obs].sort((a, b) => {
    const ta = a.meta.at as number;
    const tb = b.meta.at as number;
    if (ta !== tb) return ta - tb;
    if (a.maker !== b.maker) return a.maker < b.maker ? -1 : 1;
    if (a.side !== b.side) return a.side < b.side ? -1 : 1;
    return a.amountUsd - b.amountUsd;
  });
}

function parseUsd(v: string | number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function computeFlowMetrics(
  observations: readonly FlowObservation[],
): FlowMetrics {
  const obs = sortFlow(observations);

  let buyUsd = 0;
  let sellUsd = 0;
  let sawExit = false;
  const makerUsd = new Map<string, number>();

  for (const o of obs) {
    const usd = parseUsd(o.amountUsd);
    if (o.side === "buy") buyUsd += usd;
    else {
      sellUsd += usd;
      sawExit = true;
    }
    // Also treat an explicit CLOSE direction as an exit signal.
    if (o.direction === "CLOSE") sawExit = true;
    makerUsd.set(o.maker, (makerUsd.get(o.maker) ?? 0) + usd);
  }

  const totalUsd = buyUsd + sellUsd;
  const netFlowUsd = buyUsd - sellUsd;

  let maxMakerUsd = 0;
  for (const v of makerUsd.values()) if (v > maxMakerUsd) maxMakerUsd = v;
  const concentration = totalUsd > 0 ? ratio(maxMakerUsd / totalUsd) : R0;

  // Persistence: fraction of events in the dominant direction.
  const buyCount = obs.filter((o) => o.side === "buy").length;
  const sellCount = obs.length - buyCount;
  const dominant = Math.max(buyCount, sellCount);
  const persistence = obs.length > 0 ? ratio(dominant / obs.length) : R0;

  return {
    netFlowUsd,
    buyPressureUsd: buyUsd,
    sellPressureUsd: sellUsd,
    distinctMakers: makerUsd.size,
    concentration,
    persistence,
    // ROLLING coverage: absence of a sell is NOT proof no exit occurred.
    exitObservation: sawExit ? "EXIT_OBSERVED" : "NO_EXIT_OBSERVED",
    eventCount: obs.length,
  };
}

/**
 * Detect flow clusters: >= clusterMinMakers distinct makers trading the same
 * direction within clusterWindow. Deterministic sliding-window over sorted events.
 */
export function detectFlowClusters(
  observations: readonly FlowObservation[],
  config: FlowConfig = DEFAULT_FLOW_CONFIG,
): readonly FlowCluster[] {
  const clusters: FlowCluster[] = [];
  for (const side of ["buy", "sell"] as const) {
    const sideObs = sortFlow(observations.filter((o) => o.side === side));
    const windowMs = config.clusterWindow as number;

    let start = 0;
    for (let end = 0; end < sideObs.length; end++) {
      const endObs = sideObs[end];
      if (endObs === undefined) continue;
      const endAt = endObs.meta.at as number;
      while (start < end) {
        const startObs = sideObs[start];
        if (startObs === undefined) break;
        if (endAt - (startObs.meta.at as number) > windowMs) start++;
        else break;
      }
      const slice = sideObs.slice(start, end + 1);
      const makers = new Set(slice.map((o) => o.maker));
      if (makers.size >= config.clusterMinMakers) {
        const first = slice[0];
        const last = slice[slice.length - 1];
        if (first === undefined || last === undefined) continue;
        clusters.push({
          direction: side,
          distinctMakers: makers.size,
          totalUsd: slice.reduce((s, o) => s + parseUsd(o.amountUsd), 0),
          windowStart: first.meta.at,
          windowEnd: last.meta.at,
        });
      }
    }
  }
  return clusters;
}
