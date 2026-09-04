/**
 * Test fixtures — construct valid Core outputs so the Product Layer can be
 * exercised against real BattlefieldState/TokenBattlefieldEntry shapes.
 * These build Core objects via the public assembleBattlefield contract.
 */

import { assembleBattlefield } from "../../src/core/battlefield/assembleBattlefield.js";
import type { BattlefieldState, TokenBattlefieldEntry } from "../../src/core/battlefield/types.js";
import type {
  Chain,
  TokenAddress,
  UnixMillis,
  Score0to100,
  Ratio0to1,
} from "../../src/shared/scalars.js";
import type { MarketState, Signal, MarketEvent } from "../../src/core/state/types.js";

const S = (n: number) => n as Score0to100;
const R = (n: number) => n as Ratio0to1;
const T = (n: number) => n as UnixMillis;
const addr = (s: string) => s as TokenAddress;

export interface EntryOverrides {
  readonly address?: string;
  readonly state?: MarketState;
  readonly power?: number;
  readonly threat?: number;
  readonly attention?: number;
  readonly signals?: readonly Signal[];
  readonly events?: readonly MarketEvent[];
  readonly supporting?: readonly { factor: string; magnitude: number; weight: number }[];
}

export function makeEntry(o: EntryOverrides = {}): TokenBattlefieldEntry {
  const chain: Chain = "sol";
  return {
    chain,
    address: addr(o.address ?? "TokenAAA"),
    power: {
      score: S(o.power ?? 60),
      supporting: (o.supporting ?? [{ factor: "flow_accel", magnitude: 12, weight: 0.4 }]).map((c) => ({
        factor: c.factor,
        magnitude: c.magnitude,
        weight: c.weight,
      })),
      opposing: [],
      netCoherence: R(0.7),
    },
    threat: { score: S(o.threat ?? 20), supporting: [] },
    confidence: {
      score: S(55),
      completeness: R(0.8),
      freshness: R(0.9),
      historyDepth: R(0.6),
      coherenceContribution: R(0.7),
      measurementStability: R(0.8),
      derivativeReliability: R(0.7),
      limitingCoverage: "ROLLING",
      limitingTemporalOrigin: "GMGN_EVENT",
    },
    state: o.state ?? "ACCUMULATION",
    trajectory: { classification: "RISING", confidence: S(50), basis: [] },
    coherence: { state: "MIXED", netCoherence: R(0.6), vectors: [] },
    leadLag: { result: "FLOW_LEADS", confidence: S(40), observedLag: null },
    attention: { score: S(o.attention ?? 30), contributors: ["MAGNITUDE"] },
    novelty: { rarity: R(0.2), reasons: [] },
    signals: o.signals ?? [],
    events: o.events ?? [],
    quality: { quality: "PARTIAL", assessedAt: T(1000), reasons: ["rolling flow"] },
  };
}

export function makeBattlefield(entries: readonly TokenBattlefieldEntry[]): BattlefieldState {
  return assembleBattlefield({
    generatedAt: T(1000),
    marketRegime: "RISK_ON",
    tokens: entries.map((e) => ({
      chain: e.chain,
      address: e.address,
      power: e.power,
      threat: e.threat,
      confidence: e.confidence,
      state: e.state,
      trajectory: e.trajectory,
      coherence: e.coherence,
      leadLag: e.leadLag,
      attention: e.attention,
      novelty: e.novelty,
      signals: e.signals,
      events: e.events,
      quality: e.quality,
    })),
    correlations: [],
  });
}

export function signal(identity: string, phase: Signal["phase"], at = 1000): Signal {
  return {
    identity,
    phase,
    firstObservedAt: T(at),
    lastUpdatedAt: T(at),
    reasons: [`${identity} ${phase}`],
  };
}

export function event(type: MarketEvent["type"], importance = 50, at = 1000): MarketEvent {
  return {
    type,
    at: T(at),
    severity: S(50),
    importance: S(importance),
    reasons: [`${type} reason`],
    beforeState: "OBSERVING",
    afterState: "ACCUMULATION",
  };
}
