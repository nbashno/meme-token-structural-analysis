/**
 * WAR core — BattlefieldState (Phase 2, types only).
 *
 * The ONLY intelligence object that leaves the core. The renderer consumes this
 * without knowing how it was calculated. Everything below the battlefield in the
 * data flow (physics, renderer) reads this and never writes back.
 */

import type {
  Chain,
  TokenAddress,
  UnixMillis,
  Score0to100,
} from "../../shared/scalars.js";
import type { ModelVersions, QualityStamp } from "../../shared/quality.js";
import type { Trajectory } from "../temporal/types.js";
import type { Coherence, LeadLag } from "../coherence/types.js";
import type { Power, Threat, Confidence } from "../power/types.js";
import type {
  MarketState,
  MarketEvent,
  Signal,
  Novelty,
  Attention,
} from "../state/types.js";

/** Market-wide regime context (the backdrop every token is read against). */
export type MarketRegime =
  | "RISK_ON"
  | "RISK_OFF"
  | "ROTATIONAL"
  | "QUIET"
  | "UNKNOWN";

/** The complete intelligence picture for one token at one instant. */
export interface TokenBattlefieldEntry {
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

/** Co-movement only (correlational). InfluenceGraph does not exist. */
export interface CorrelationEdge {
  readonly a: TokenAddress;
  readonly b: TokenAddress;
  /** Observed co-movement strength within the window; not causation. */
  readonly comovement: Score0to100;
}

/** The renderer-independent battlefield snapshot. */
export interface BattlefieldState {
  readonly generatedAt: UnixMillis;
  readonly modelVersions: ModelVersions;
  readonly marketRegime: MarketRegime;
  readonly tokens: readonly TokenBattlefieldEntry[];
  /** Attention-ranked token addresses (highest first). */
  readonly rankings: readonly TokenAddress[];
  readonly correlations: readonly CorrelationEdge[];
  readonly globalAttention: Score0to100;
}
