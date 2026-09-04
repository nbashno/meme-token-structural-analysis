/**
 * WAR core - Battlefield Assembler (Phase 12).
 *
 * Combines the per-token outputs of every engine into a single BattlefieldState
 * - the ONLY object that leaves the core. A renderer consumes this without
 * knowing how any of it was computed.
 *
 * Deterministic: tokens are sorted by a stable key, rankings by attention with a
 * stable tiebreak, and correlations sorted by endpoints. Time is injected via
 * `generatedAt`. Pure, total. No clock, no randomness, no IO.
 */

import type {
  Chain,
  TokenAddress,
  UnixMillis,
  Score0to100,
} from "../../shared/scalars.js";
import type { ModelVersions, QualityStamp } from "../../shared/quality.js";
import type { Power, Threat, Confidence } from "../power/types.js";
import type { Trajectory } from "../temporal/types.js";
import type { Coherence, LeadLag } from "../coherence/types.js";
import type {
  MarketState,
  MarketEvent,
  Signal,
  Novelty,
  Attention,
} from "../state/types.js";
import type {
  BattlefieldState,
  TokenBattlefieldEntry,
  CorrelationEdge,
  MarketRegime,
} from "./types.js";
import { clampScore } from "../../shared/construct.js";
import { MODEL_VERSIONS } from "../../config/versions.js";

const S0 = 0 as Score0to100;
function score(n: number): Score0to100 {
  const r = clampScore(n);
  return r.ok ? r.value : S0;
}

/** Fully-computed intelligence for one token, ready to be placed on the field. */
export interface TokenAssemblyInput {
  readonly chain: Chain;
  readonly address: TokenAddress;
  readonly power: Power;
  readonly threat: Threat;
  readonly confidence: Confidence;
  readonly state: MarketState;
  readonly trajectory: Trajectory;
  readonly coherence: Coherence;
  readonly leadLag: LeadLag;
  readonly attention: Attention;
  readonly novelty: Novelty;
  readonly signals: readonly Signal[];
  readonly events: readonly MarketEvent[];
  readonly quality: QualityStamp;
}

export interface AssemblyInput {
  readonly generatedAt: UnixMillis;
  readonly marketRegime: MarketRegime;
  readonly tokens: readonly TokenAssemblyInput[];
  readonly correlations: readonly CorrelationEdge[];
  readonly modelVersions?: ModelVersions;
}

function toEntry(t: TokenAssemblyInput): TokenBattlefieldEntry {
  return {
    chain: t.chain,
    address: t.address,
    power: t.power,
    threat: t.threat,
    confidence: t.confidence,
    state: t.state,
    trajectory: t.trajectory,
    coherence: t.coherence,
    leadLag: t.leadLag,
    attention: t.attention,
    novelty: t.novelty,
    signals: t.signals,
    events: t.events,
    quality: t.quality,
  };
}

/** Assemble the renderer-independent battlefield snapshot. */
export function assembleBattlefield(input: AssemblyInput): BattlefieldState {
  // Deterministic token order: by address (stable, total).
  const entries = [...input.tokens]
    .map(toEntry)
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));

  // Rankings: highest attention first, tie-broken by address for stability.
  const rankings: TokenAddress[] = [...entries]
    .sort((a, b) => {
      const ca = a.attention.score as number;
      const cb = b.attention.score as number;
      if (ca !== cb) return cb - ca;
      return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
    })
    .map((e) => e.address);

  // Global attention: the peak token attention (what most demands a look).
  let peak = 0;
  for (const e of entries) {
    const s = e.attention.score as number;
    if (s > peak) peak = s;
  }

  // Correlations sorted deterministically by endpoints.
  const correlations = [...input.correlations].sort((x, y) => {
    if (x.a !== y.a) return x.a < y.a ? -1 : 1;
    if (x.b !== y.b) return x.b < y.b ? -1 : 1;
    return 0;
  });

  return {
    generatedAt: input.generatedAt,
    modelVersions: input.modelVersions ?? MODEL_VERSIONS,
    marketRegime: input.marketRegime,
    tokens: entries,
    rankings,
    correlations,
    globalAttention: score(peak),
  };
}
