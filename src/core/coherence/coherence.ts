/**
 * WAR core - Coherence + Lead/Lag engine (Phase 7).
 *
 * Coherence measures whether directional vectors (price, volume, flow,
 * liquidity, sell-pressure) agree or conflict. CONFLICT MUST REDUCE coherence -
 * a token with contradictory vectors cannot be scored as coherent regardless of
 * data quality.
 *
 * Lead/Lag measures observed PRECEDENCE only. Permitted meaning: "flow
 * historically preceded price movement within the observed window." FORBIDDEN
 * meaning: causation. This module never asserts one series caused another.
 *
 * Pure, total, deterministic. No clock, no randomness, no IO.
 */

import type { Ratio0to1, DurationMillis, Score0to100 } from "../../shared/scalars.js";
import type {
  Coherence,
  CoherenceState,
  CoherenceVector,
  LeadLag,
  LeadLagResult,
} from "./types.js";
import type { SignalDirection } from "../temporal/types.js";
import { toRatio0to1, clampScore } from "../../shared/construct.js";

const R0 = 0 as Ratio0to1;
const S0 = 0 as Score0to100;
function ratio(n: number): Ratio0to1 {
  const r = toRatio0to1(n);
  return r.ok ? r.value : R0;
}
function score(n: number): Score0to100 {
  const r = clampScore(n);
  return r.ok ? r.value : S0;
}

/** A named directional vector fed into coherence. */
export interface DirectedVector {
  readonly name: CoherenceVector["name"];
  readonly direction: SignalDirection;
}

/** Map a signal direction to a comparable sign, or null if unusable. */
function dirSign(d: SignalDirection): 1 | -1 | 0 | null {
  if (d === "UP") return 1;
  if (d === "DOWN") return -1;
  if (d === "FLAT") return 0;
  return null; // UNKNOWN
}

export interface CoherenceConfig {
  /** netCoherence at/above this -> STRONG_MULTI_VECTOR_ALIGNMENT. */
  readonly strongAlign: number;
  /** netCoherence at/above this (but below strong) -> MULTI_VECTOR_ALIGNMENT. */
  readonly align: number;
  /** netCoherence at/below this -> MULTI_VECTOR_CONFLICT. */
  readonly conflict: number;
  /** Minimum usable vectors required to judge coherence at all. */
  readonly minVectors: number;
}

export const DEFAULT_COHERENCE_CONFIG: CoherenceConfig = {
  strongAlign: 0.85,
  align: 0.6,
  conflict: 0.4,
  minVectors: 2,
};

/**
 * Compute coherence across directional vectors. The consensus is the majority
 * sign; each vector "agrees" if it shares that sign. netCoherence is the share
 * of usable vectors agreeing with the consensus - so conflict pulls it down.
 */
export function computeCoherence(
  vectors: readonly DirectedVector[],
  config: CoherenceConfig = DEFAULT_COHERENCE_CONFIG,
): Coherence {
  const usable = vectors
    .map((v) => ({ name: v.name, sign: dirSign(v.direction) }))
    .filter((v): v is { name: CoherenceVector["name"]; sign: 1 | -1 | 0 } =>
      v.sign !== null,
    );

  if (usable.length < config.minVectors) {
    return {
      state: "INSUFFICIENT",
      netCoherence: R0,
      vectors: vectors
        .map((v) => ({ name: v.name, agrees: null }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    };
  }

  // Consensus = the most common non-zero sign; ties or all-flat -> 0.
  let pos = 0;
  let neg = 0;
  for (const v of usable) {
    if (v.sign === 1) pos++;
    else if (v.sign === -1) neg++;
  }
  const consensus: 1 | -1 | 0 = pos > neg ? 1 : neg > pos ? -1 : 0;

  const agreeing = usable.filter((v) => v.sign === consensus).length;
  const netCoherence = ratio(agreeing / usable.length);

  const state = classifyCoherence(netCoherence as number, config);

  const vectorReport: CoherenceVector[] = vectors
    .map((v) => {
      const s = dirSign(v.direction);
      return { name: v.name, agrees: s === null ? null : s === consensus };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return { state, netCoherence, vectors: vectorReport };
}

function classifyCoherence(nc: number, config: CoherenceConfig): CoherenceState {
  if (nc >= config.strongAlign) return "STRONG_MULTI_VECTOR_ALIGNMENT";
  if (nc >= config.align) return "MULTI_VECTOR_ALIGNMENT";
  if (nc <= config.conflict) return "MULTI_VECTOR_CONFLICT";
  return "MIXED";
}

// -- Lead/Lag ----------------------------------------------------------------

/** A time-ordered directional change on a single series. */
export interface DirectionalMove {
  readonly at: number; // ms
  readonly sign: 1 | -1;
}

export interface LeadLagConfig {
  /** Max lag to consider a relationship "stable" (ms). */
  readonly maxLagMs: number;
  /** Minimum matched move pairs required to conclude a relationship. */
  readonly minMatches: number;
}

export const DEFAULT_LEADLAG_CONFIG: LeadLagConfig = {
  maxLagMs: 600_000, // 10 min
  minMatches: 3,
};

/**
 * Determine whether flow moves historically preceded price moves within the
 * observed window. Matches each price move to the nearest earlier same-sign
 * flow move within maxLagMs. Reports observed precedence only - not causation.
 */
export function computeLeadLag(
  flowMoves: readonly DirectionalMove[],
  priceMoves: readonly DirectionalMove[],
  config: LeadLagConfig = DEFAULT_LEADLAG_CONFIG,
): LeadLag {
  if (flowMoves.length === 0 || priceMoves.length === 0) {
    return { result: "INSUFFICIENT_HISTORY", confidence: S0, observedLag: null };
  }

  const flow = [...flowMoves].sort((a, b) => a.at - b.at);
  const price = [...priceMoves].sort((a, b) => a.at - b.at);

  let flowLeads = 0;
  let priceLeads = 0;
  let synchronized = 0;
  const lags: number[] = [];

  for (const pm of price) {
    // nearest earlier same-sign flow move within window
    let best: DirectionalMove | null = null;
    for (const fm of flow) {
      if (fm.sign !== pm.sign) continue;
      const lag = pm.at - fm.at;
      if (lag < 0) continue;
      if (lag > config.maxLagMs) continue;
      if (best === null || pm.at - fm.at < pm.at - best.at) best = fm;
    }
    if (best !== null) {
      const lag = pm.at - best.at;
      lags.push(lag);
      if (lag === 0) synchronized++;
      else flowLeads++;
    }
  }

  // Symmetric check: did price ever precede flow?
  for (const fm of flow) {
    for (const pm of price) {
      if (pm.sign !== fm.sign) continue;
      const lag = fm.at - pm.at;
      if (lag > 0 && lag <= config.maxLagMs) {
        priceLeads++;
        break;
      }
    }
  }

  const matches = flowLeads + synchronized;
  if (matches < config.minMatches) {
    return { result: "INSUFFICIENT_HISTORY", confidence: S0, observedLag: null };
  }

  const result = decideLeadLag(flowLeads, priceLeads, synchronized);
  const medianLag = lags.length > 0 ? median(lags) : null;

  // Confidence scales with match count, saturating; deterministic.
  const conf = clamp0to100(100 * (1 - 1 / (matches + 1)));

  return {
    result,
    confidence: score(conf),
    observedLag: medianLag === null ? null : (medianLag as DurationMillis),
  };
}

function decideLeadLag(
  flowLeads: number,
  priceLeads: number,
  synchronized: number,
): LeadLagResult {
  if (flowLeads > priceLeads && flowLeads > synchronized) return "FLOW_LEADS";
  if (priceLeads > flowLeads && priceLeads > synchronized) return "PRICE_LEADS";
  if (synchronized >= flowLeads && synchronized >= priceLeads) return "SYNCHRONIZED";
  return "NO_STABLE_RELATIONSHIP";
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return s[mid] as number;
  const a = s[mid - 1] as number;
  const b = s[mid] as number;
  return (a + b) / 2;
}

function clamp0to100(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 100 ? 100 : n;
}
