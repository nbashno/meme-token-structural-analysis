/**
 * WAR Product Layer - Phase 3 - Scan orchestration PORTS.
 *
 * The orchestrator depends only on these injectable interfaces. Two rules are
 * enforced structurally by them:
 *
 *  1. NO raw GMGN inside the Product Domain. GmgnAcquisitionPort returns already
 *     NORMALIZED core observations (MarketObservation / AnalyticsObservation /
 *     FlowObservation). Raw payloads + the raw->normalized mapping live behind
 *     the port, at the adapter boundary. The product never sees raw fields.
 *
 *  2. NO WAR intelligence recomputed in the Product Layer. WarEvaluationPort
 *     takes normalized observations and returns a Core BattlefieldState. Its
 *     production implementation wires the REAL verified core engines; the
 *     product consumes the output, never the formulas.
 *
 * This is the "thin façade only if orchestration needs it" the spec allows: the
 * façade is an interface at the boundary, not a reimplementation of the engine.
 */

import type { Chain, TokenAddress } from "../../../shared/scalars.js";
import type {
  MarketObservation,
  AnalyticsObservation,
  FlowObservation,
} from "../../../core/timeline/types.js";
import type { BattlefieldState } from "../../../core/battlefield/types.js";
import type { DomainResult } from "../../domain/identity.js";

/** Normalized observation bundle for one token, produced at the adapter boundary. */
export interface NormalizedObservations {
  readonly chain: Chain;
  readonly address: TokenAddress;
  /** MARKET lane (OHLCV), COMPLETE coverage. */
  readonly market: readonly MarketObservation[];
  /** ANALYTICS lane, SAMPLED coverage. */
  readonly analytics: readonly AnalyticsObservation[];
  /** FLOW lane, ROLLING coverage. Already normalized (no raw position bit). */
  readonly flow: readonly FlowObservation[];
  /** The window actually observed, for provenance + coverage honesty. */
  readonly observedFromMs: number;
  readonly observedToMs: number;
}

/**
 * Acquires + normalizes GMGN data for exactly one token. The implementation
 * lives at the adapter boundary (it may call gmgn-cli via the injectable runner,
 * route flow through the sealed normalizer, and drop banned fields). Only a
 * one-token, demand-driven acquisition — never a market-wide crawl.
 */
export interface GmgnAcquisitionPort {
  acquire(
    chain: Chain,
    address: TokenAddress,
    atMs: number,
  ): Promise<DomainResult<NormalizedObservations>>;
}

/**
 * Evaluates normalized observations into a Core BattlefieldState. The production
 * implementation composes the real verified engines (temporal, flow, power,
 * threat, confidence, trajectory, coherence, lead/lag, state, events, novelty,
 * attention) and assembleBattlefield. It performs NO product-side intelligence;
 * it is the single legitimate entry the orchestrator calls into the core through.
 */
export interface WarEvaluationPort {
  evaluate(
    observations: NormalizedObservations,
    atMs: number,
  ): Promise<DomainResult<BattlefieldState>>;
}

/** A "meaningful WAR result" gate: does the battlefield contain this token? */
export function hasMeaningfulResult(
  battlefield: BattlefieldState,
  address: TokenAddress,
): boolean {
  return battlefield.tokens.some((t) => t.address === address);
}
