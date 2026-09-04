/**
 * WAR core - Feature layer - real WarEvaluationPort (Phase 4B-7).
 *
 * This is where WAR becomes ONE connected engine. It consumes NormalizedObservations
 * and produces a BattlefieldState by driving the ENTIRE real pipeline in order:
 *
 *   NormalizedObservations
 *     -> SignalPoints (price/volume/liquidity series)
 *     -> TemporalProfiles + FlowMetrics
 *     -> DirectedVectors -> Coherence + Lead/Lag
 *     -> Power/Threat activations -> Power, Threat
 *     -> ConfidenceInputs -> Confidence
 *     -> Trajectory
 *     -> State (single step from OBSERVING; B1: no prior context)
 *     -> PatternSignature -> Novelty
 *     -> AttentionInputs -> Attention
 *     -> SignalObservations -> Signals (first sighting; B1: EMERGING only)
 *     -> assembleBattlefield
 *
 * B1 INVARIANTS enforced here:
 *   - NO EngineSnapshot before/after; events are NOT detected in a scan (empty).
 *   - stateTransition/trajectoryReversal attention drivers are 0 (in builder).
 *   - crossTokenImpact = 0 (causal ban, in builder).
 *
 * NO CONFIG CHANGE. No POWER/THREAT weight touched. liquidityFragility and
 * measurementStability remain INSUFFICIENT. bundlerRate is never a factor.
 *
 * DETERMINISTIC: no wall-clock reads, no randomness. Time is the observation
 * instant passed in as evaluationAt; nothing is sampled from the environment.
 */

import type { Chain, TokenAddress, UnixMillis } from "../../shared/scalars.js";
import type { BattlefieldState } from "../battlefield/types.js";
import { assembleBattlefield } from "../battlefield/assembleBattlefield.js";
import { MODEL_VERSIONS } from "../../config/versions.js";

import { computeTemporalProfile, type SignalPoint } from "../temporal/temporalEngine.js";
import { computeFlowMetrics } from "../flow/flowEngine.js";
import { computeCoherence, computeLeadLag } from "../coherence/coherence.js";
import { computePower, computeThreat, computeConfidence } from "../power/powerEngine.js";
import { classifyTrajectory } from "../trajectory/trajectory.js";
import { stepStateMachine, initialStateContext, type StateInputs } from "../state/stateMachine.js";
import { computeNovelty } from "../novelty/novelty.js";
import { computeAttention } from "../attention/attention.js";
import { advanceSignal } from "../signal/signalLifecycle.js";

import { buildDirectedVectors } from "./directedVectors.js";
import { movesFromSeries, movesFromFlowEvents } from "./directionalMoves.js";
import { computeThreatActivations } from "./threatActivations.js";
import { computePowerActivations } from "./powerActivations.js";
import { buildConfidenceInputs } from "./confidenceInputs.js";
import { buildPatternSignature } from "./patternSignature.js";
import { buildAttentionInputs } from "./attentionInputs.js";
import { deriveSignalObservations } from "./signalObservations.js";

import type {
  MarketObservation,
  AnalyticsObservation,
  FlowObservation,
} from "../timeline/types.js";

/** Normalized, single-token observation bundle (mirror of the product-layer port input). */
export interface EvaluationObservations {
  readonly chain: Chain;
  readonly address: TokenAddress;
  readonly market: readonly MarketObservation[];
  readonly analytics: readonly AnalyticsObservation[];
  readonly flow: readonly FlowObservation[];
  readonly evaluationAt: UnixMillis;
}

/** Diagnostics: what the chain could and could not derive. */
export interface EvaluationDiagnostics {
  readonly insufficient: readonly string[];
}

export interface EvaluationOutput {
  readonly battlefield: BattlefieldState;
  readonly diagnostics: EvaluationDiagnostics;
}

function seriesFromMarket(market: readonly MarketObservation[], pick: (m: MarketObservation) => number): readonly SignalPoint[] {
  return market.map((m) => ({ at: m.meta.at, value: pick(m) }));
}

/**
 * Evaluate one token's normalized observations into a BattlefieldState by running
 * the real engine chain. Pure and deterministic.
 */
export function evaluateToBattlefield(obs: EvaluationObservations): EvaluationOutput {
  const insufficient: string[] = [];
  const at = obs.evaluationAt;

  // -- 1. SignalPoints + TemporalProfiles ----------------------------------
  const priceSeries = seriesFromMarket(obs.market, (m) => m.close);
  const volumeSeries = seriesFromMarket(obs.market, (m) => m.volumeUsd);
  const liquiditySeries: readonly SignalPoint[] = obs.analytics.map((a) => ({ at: a.meta.at, value: a.liquidity }));

  const priceProfile = priceSeries.length > 0 ? computeTemporalProfile(priceSeries) : null;
  const volumeProfile = volumeSeries.length > 0 ? computeTemporalProfile(volumeSeries) : null;
  const liquidityProfile = liquiditySeries.length > 0 ? computeTemporalProfile(liquiditySeries) : null;

  // -- 2. FlowMetrics -------------------------------------------------------
  const flowMetrics = obs.flow.length > 0 ? computeFlowMetrics(obs.flow) : null;

  // -- 3. DirectedVectors -> Coherence -------------------------------------
  const vectors = buildDirectedVectors({
    priceProfile,
    volumeProfile,
    liquidityProfile,
    flow: flowMetrics,
  });
  const coherence = computeCoherence(vectors);
  const netCoherence =
    coherence.state === "INSUFFICIENT" ? null : (coherence.netCoherence as number);
  if (netCoherence === null) insufficient.push("coherence");

  // -- 4. Lead/Lag ----------------------------------------------------------
  const priceMoves = movesFromSeries(priceSeries.map((p) => ({ at: p.at as number, value: p.value })));
  const flowMoves = movesFromFlowEvents(obs.flow.map((f) => ({ at: f.meta.at as number, side: f.side })));
  const leadLag = computeLeadLag(flowMoves, priceMoves);

  // -- 5. Activations -> Power / Threat ------------------------------------
  const latestAnalytics = obs.analytics.length > 0 ? obs.analytics[obs.analytics.length - 1]! : null;

  const powerAct = computePowerActivations({
    priceProfile, netCoherence, flow: flowMetrics, flowEvents: obs.flow, latestAnalytics,
  });
  const threatAct = computeThreatActivations(latestAnalytics);
  insufficient.push(...powerAct.insufficient, ...threatAct.insufficient);

  const power = computePower(powerAct.activations, netCoherence ?? 0);
  const threat = computeThreat(threatAct.activations);

  // -- 6. Confidence --------------------------------------------------------
  const newestAt = newestObservation(obs);
  const marketSpanMs = spanOf(priceSeries);
  const confBuild = buildConfidenceInputs({
    lanesPresent: (obs.market.length > 0 ? 1 : 0) + (obs.analytics.length > 0 ? 1 : 0) + (obs.flow.length > 0 ? 1 : 0),
    lanesExpected: 3,
    newestObservedAt: newestAt,
    evaluationAt: at as number,
    marketSpanMs,
    referenceSpanMs: 3_600_000, // 1h reference window (featureModelVersion-scoped)
    netCoherence,
    derivativeConfidence: priceProfile ? (priceProfile.derivativeConfidence as number) : null,
    limitingCoverage: obs.flow.length > 0 ? "ROLLING" : obs.analytics.length > 0 ? "SAMPLED" : "COMPLETE",
    limitingTemporalOrigin: obs.flow.length > 0 ? "GMGN_EVENT" : "WAR_SAMPLED",
    freshnessHorizonMs: 3_600_000,
  });
  insufficient.push(...confBuild.insufficient);
  const confidence = computeConfidence(confBuild.inputs);

  // -- 7. Trajectory --------------------------------------------------------
  const trajectory = priceProfile
    ? classifyTrajectory(priceProfile)
    : ({ classification: "UNKNOWN", confidence: 0 as never, basis: [] } as ReturnType<typeof classifyTrajectory>);

  // -- 8. State (single step from OBSERVING; B1: no prior context) ----------
  const stateInputs: StateInputs = {
    now: at,
    power: power.score as number,
    threat: threat.score as number,
    confidence: confidence.score as number,
    netCoherence: netCoherence ?? 0,
    persistence: flowMetrics ? (flowMetrics.persistence as number) : 0,
    trajectory: trajectory.classification,
  };
  const stateDecision = stepStateMachine(initialStateContext(at), stateInputs);
  const state = stateDecision.context.state;

  // -- 9. Novelty -----------------------------------------------------------
  const signature = buildPatternSignature({ state, trajectory: trajectory.classification, netCoherence });
  const novelty = computeNovelty(signature, {}); // scan has no persisted pattern memory

  // -- 10. Attention --------------------------------------------------------
  const attentionInputs = buildAttentionInputs({
    power: power.score as number,
    acceleration: priceProfile ? (priceProfile.acceleration as number | null) : null,
    accelerationRef: 1,
    noveltyRarity: novelty.rarity as number,
    netCoherence,
    confidence: confidence.score as number,
  });
  const attention = computeAttention(attentionInputs);

  // -- 11. Signals (first sighting only; B1: EMERGING) ----------------------
  const allActivations = { ...powerAct.activations, ...threatAct.activations };
  const signalObs = deriveSignalObservations(allActivations, at);
  const signals = signalObs.map((o) => advanceSignal(null, o));

  // -- 12. assembleBattlefield ---------------------------------------------
  // B1: NO events in a scan (event detection needs a before/after snapshot).
  const battlefield = assembleBattlefield({
    generatedAt: at,
    marketRegime: "UNKNOWN", // single-token scan cannot determine market-wide regime
    tokens: [
      {
        chain: obs.chain,
        address: obs.address,
        power,
        threat,
        confidence,
        state,
        trajectory,
        coherence,
        leadLag,
        attention,
        novelty,
        signals,
        events: [], // B1: no transitional events in a single-snapshot scan
        quality: {
          quality: netCoherence === null ? "PARTIAL" : "PARTIAL",
          assessedAt: at,
          reasons: insufficient.length > 0 ? [`insufficient: ${insufficient.join(",")}`] : ["scan snapshot"],
        },
      },
    ],
    correlations: [],
    modelVersions: MODEL_VERSIONS,
  });

  return { battlefield, diagnostics: { insufficient } };
}

function newestObservation(obs: EvaluationObservations): number | null {
  let newest: number | null = null;
  for (const m of obs.market) newest = newest === null ? (m.meta.at as number) : Math.max(newest, m.meta.at as number);
  for (const a of obs.analytics) newest = newest === null ? (a.meta.at as number) : Math.max(newest, a.meta.at as number);
  for (const f of obs.flow) newest = newest === null ? (f.meta.at as number) : Math.max(newest, f.meta.at as number);
  return newest;
}

function spanOf(series: readonly SignalPoint[]): number {
  if (series.length < 2) return 0;
  const times = series.map((p) => p.at as number).sort((a, b) => a - b);
  return times[times.length - 1]! - times[0]!;
}
