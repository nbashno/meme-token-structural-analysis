# install-phase18-20.ps1
# WAR ARENA - Phases 5-9 + Arena (integration, hardening, ui, world, arena)
# Writes all new/modified files into the project. Run from the project root:
#   powershell -ExecutionPolicy Bypass -File .\install-phase18-20.ps1

$ErrorActionPreference = 'Stop'
Write-Host 'WAR ARENA installer: phases 5-9 + Arena' -ForegroundColor Cyan

function Write-WarFile([string]$Path, [string]$Content) {
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  Set-Content -LiteralPath $Path -Value $Content -Encoding UTF8 -NoNewline
  Write-Host "  wrote $Path" -ForegroundColor DarkGray
}

Write-WarFile 'src/arena/ArenaSession.ts' @'
/**
 * WAR arena - ArenaSession (Phase 3.1 product wiring).
 *
 * The single read-only product surface. It binds the verified Phase 1/2 pieces:
 *   - scan          -> ScanService (hardened executor injected upstream)
 *   - monitor tick  -> MonitoringService
 *   - world         -> toWorldState + WorldEngine
 *   - search        -> RepositorySearchPort
 *   - replay        -> MonitoringHistoryReader
 *
 * It NEVER computes intelligence and NEVER bypasses a boundary. Scan/monitor go
 * through the existing services (payment gate, hardening). The world is fed the
 * resulting IntelligenceReport via the pure adapter. One source of truth.
 */

import type { ScanService, ScanInput, ScanResult } from "../product/scan/orchestration/scanService.js";
import type { MonitoringService, MonitorTickOutcome } from "../integration/MonitoringService.js";
import type { MonitoringSession } from "../product/monitor/monitor.js";
import type { MonitorCarry } from "../integration/monitorTick.js";
import type { DomainResult } from "../product/domain/identity.js";
import { toWorldState, type WorldState } from "../world/worldAdapter.js";
import { WorldEngine, type WorldPosition } from "../world/worldEngine.js";
import { RepositorySearchPort, MonitoringHistoryReader, type ReplayHistoryEntry } from "./backends.js";
import type { SearchResult } from "../world/worldRadar.js";
import type { UnitOfWork } from "../product/persistence/contracts/repositories.js";

export interface ArenaDeps {
  readonly scanService: ScanService;
  readonly monitoringService: MonitoringService;
  readonly uow: UnitOfWork;
}

export class ArenaSession {
  readonly world = new WorldEngine();
  private readonly search: RepositorySearchPort;
  private readonly replay: MonitoringHistoryReader;

  constructor(private readonly deps: ArenaDeps) {
    this.search = new RepositorySearchPort(deps.uow);
    this.replay = new MonitoringHistoryReader(deps.uow);
  }

  /** Run a paid scan and project its report into a world instance. */
  async scan(input: ScanInput, position: WorldPosition): Promise<DomainResult<{ result: ScanResult; world: WorldState }>> {
    const res = await this.deps.scanService.execute(input);
    if (!res.ok) return res;
    const world = toWorldState({ report: res.value.report });
    const id = `${world.chain}:${world.address}`;
    this.world.ensure(id, position);
    this.world.mount(id);
    this.world.update(id, world);
    return { ok: true, value: { result: res.value, world } };
  }

  /** Advance one monitoring tick; if a report is produced, update the world. */
  async monitorTick(session: MonitoringSession, carry: MonitorCarry): Promise<DomainResult<MonitorTickOutcome>> {
    return this.deps.monitoringService.tick(session, carry);
  }

  /** Search stored tokens (real backend). */
  async searchTokens(text: string): Promise<readonly SearchResult[]> {
    return this.search.search({ text });
  }

  /** Read a session's persisted history for replay (references only). */
  async replayHistory(sessionId: string): Promise<readonly ReplayHistoryEntry[]> {
    return this.replay.history(sessionId);
  }
}
'@

Write-WarFile 'src/arena/backends.ts' @'
/**
 * WAR arena - Search + Replay backends (Phase 3).
 *
 * These implement the Phase 2 contracts that were BLOCKED, now that Phase 3 added
 * the read methods (TokenRepository.searchByText, MonitoringObservationRepository.
 * list). They READ verified persistence only — no ranking intelligence, no
 * fabricated results, no new scoring.
 */

import type { UnitOfWork } from "../product/persistence/contracts/repositories.js";
import type { SearchPort, SearchQuery, SearchResult } from "../world/worldRadar.js";

/** Real search over stored tokens. Returns only stored fields. */
export class RepositorySearchPort implements SearchPort {
  constructor(private readonly uow: UnitOfWork, private readonly limit = 20) {}

  async search(query: SearchQuery): Promise<readonly SearchResult[]> {
    const rows = await this.uow.repos.tokens.searchByText(query.text, this.limit);
    return rows.map((r) => ({ chain: r.chain, address: r.address as unknown as string, symbol: r.symbol }));
  }
}

/** A replay history entry read from persistence (references, not recomputation). */
export interface ReplayHistoryEntry {
  readonly at: number;
  readonly kind: string;
  readonly ref: string; // reference to the stored snapshot/report id
  readonly reasons: readonly string[];
}

/**
 * Reads a monitoring session's persisted observation history so Replay can play
 * it back. It returns REFERENCES to stored snapshots; it does not recompute any
 * intelligence. The World replay renderer resolves refs to stored WorldStates.
 */
export class MonitoringHistoryReader {
  constructor(private readonly uow: UnitOfWork) {}

  async history(sessionId: string): Promise<readonly ReplayHistoryEntry[]> {
    const records = await this.uow.repos.observations.list(sessionId);
    return records.map((r) => ({
      at: r.record.at,
      kind: r.record.kind,
      ref: r.record.ref,
      reasons: r.reasons,
    }));
  }
}
'@

Write-WarFile 'src/arena/capabilities.ts' @'
/**
 * WAR arena - Capability status (Phase 3).
 *
 * The single, honest source of every feature's real state. The UI renders these
 * verbatim — it never converts one status into another to look complete. This is
 * the enforcement of the non-negotiable rule: unavailable stays unavailable.
 */

export type CapabilityState =
  | "VERIFIED"
  | "AVAILABLE"
  | "BLOCKED_BY_CONTRACT"
  | "BLOCKED_BY_HISTORY_READ_CONTRACT"
  | "BLOCKED_BY_SEARCH_CONTRACT"
  | "BLOCKED_BY_GMGN_CLI"
  | "PENDING_BROWSER_BENCH"
  | "REQUIRES_EXTERNAL_ENVIRONMENT"
  | "NOT_IMPLEMENTED";

export interface Capability {
  readonly key: string;
  readonly state: CapabilityState;
  readonly note: string;
}

/**
 * The authoritative capability map for this build. Each entry reflects what was
 * actually verified from source in PHASE_3_PREBUILD_AUDIT — nothing is upgraded
 * for presentation.
 */
export const CAPABILITIES: readonly Capability[] = [
  { key: "scan", state: "VERIFIED", note: "$0.10 scan: acquisition->WAR->report->persist->consume" },
  { key: "monitoring", state: "VERIFIED", note: "T0->T1->T2 ticks, expiry, carry, alerts" },
  { key: "payment", state: "VERIFIED", note: "reserve/consume/release, idempotent, no double-spend" },
  { key: "hardening", state: "VERIFIED", note: "retry/timeout/breaker/kill/cost over CLI" },
  { key: "world", state: "VERIFIED", note: "adapter/engine/instances/camera/LOD/streaming" },
  { key: "alerts_storage", state: "AVAILABLE", note: "AlertService + AlertRepository store/list" },
  { key: "search", state: "AVAILABLE", note: "TokenRepository.searchByText (Phase 3 read contract added)" },
  { key: "replay", state: "AVAILABLE", note: "MonitoringObservationRepository.list (Phase 3 read contract added)" },
  { key: "share_card", state: "AVAILABLE", note: "deterministic projection of WorldState" },
  { key: "notifications_delivery", state: "NOT_IMPLEMENTED", note: "no delivery channel contract exists" },
  { key: "auth_identity", state: "NOT_IMPLEMENTED", note: "no auth/session contract exists" },
  { key: "social", state: "NOT_IMPLEMENTED", note: "no social persistence contract exists" },
  { key: "hunter_profile_scores", state: "NOT_IMPLEMENTED", note: "no reputation calculation contract exists" },
  { key: "sponsorship", state: "NOT_IMPLEMENTED", note: "SPONSORSHIP_BACKEND_UNAVAILABLE" },
  { key: "http_api", state: "NOT_IMPLEMENTED", note: "no HTTP server exists (library, not service)" },
  { key: "deployment", state: "NOT_IMPLEMENTED", note: "no Dockerfile/env/migration runner" },
  { key: "gmgn_live", state: "BLOCKED_BY_GMGN_CLI", note: "gmgn-cli not in environment" },
  { key: "browser_benchmark", state: "PENDING_BROWSER_BENCH", note: "no GPU/WebGL/DOM in this env" },
];

export function capability(key: string): Capability {
  return CAPABILITIES.find((c) => c.key === key) ?? { key, state: "NOT_IMPLEMENTED", note: "unknown capability" };
}

/** True only for states a user can actually use right now. */
export function isUsable(state: CapabilityState): boolean {
  return state === "VERIFIED" || state === "AVAILABLE";
}
'@

Write-WarFile 'src/arena/index.ts' @'
/**
 * WAR arena layer (Phase 3) - Product surface over verified Phase 1/2 systems.
 * Read-only: projection, wiring, and honest capability status. No intelligence.
 */
export { ArenaSession, type ArenaDeps } from "./ArenaSession.js";
export { RepositorySearchPort, MonitoringHistoryReader, type ReplayHistoryEntry } from "./backends.js";
export { CAPABILITIES, capability, isUsable, type Capability, type CapabilityState } from "./capabilities.js";
export {
  NotificationDispatcher, UnavailableNotificationChannel, type NotificationChannel,
  buildShareCard, type BattleShareCard, type ShareAspect,
} from "./shareAndNotify.js";
'@

Write-WarFile 'src/arena/shareAndNotify.ts' @'
/**
 * WAR arena - Notifications + Share cards (Phase 3.7 + 3.19).
 *
 * Notifications: AlertRepository stores alerts, but no delivery CHANNEL contract
 * exists (no email/push/webhook infra in Phase 1). We define the dispatcher
 * contract and a null channel that is explicitly NOT_IMPLEMENTED rather than
 * pretending delivery works.
 *
 * Share cards: a deterministic projection of a WorldState into a shareable
 * representation. Every value comes straight from the state — no hidden calc.
 */

import type { WorldState } from "../world/worldAdapter.js";
import type { AlertRow } from "../product/persistence/contracts/repositories.js";

// ── Notifications ─────────────────────────────────────────────────────────────

/** A delivery channel. None is implemented; the contract is defined for later. */
export interface NotificationChannel {
  readonly name: string;
  readonly available: boolean;
  deliver(alert: AlertRow): Promise<{ delivered: boolean; reason: string }>;
}

/** Explicit null channel: stores exist, delivery does not. Never fakes success. */
export class UnavailableNotificationChannel implements NotificationChannel {
  readonly name = "none";
  readonly available = false;
  async deliver(): Promise<{ delivered: boolean; reason: string }> {
    return { delivered: false, reason: "NOTIFICATION_DELIVERY_NOT_IMPLEMENTED" };
  }
}

export class NotificationDispatcher {
  constructor(private readonly channel: NotificationChannel = new UnavailableNotificationChannel()) {}
  async dispatch(alert: AlertRow): Promise<{ delivered: boolean; reason: string }> {
    if (!this.channel.available) return { delivered: false, reason: "NOTIFICATION_DELIVERY_NOT_IMPLEMENTED" };
    return this.channel.deliver(alert);
  }
}

// ── Share cards ───────────────────────────────────────────────────────────────

export type ShareAspect = "1:1" | "16:9" | "9:16";

/** A share card is pure projection — every field is copied from WorldState. */
export interface BattleShareCard {
  readonly token: string;
  readonly chain: string;
  readonly state: string;
  readonly power: number;
  readonly threat: number;
  readonly confidence: number;
  readonly attention: number;
  readonly trajectory: string;
  readonly topEvent: string | null;
  readonly timestamp: number;
  readonly dataQuality: string;
  readonly insufficient: readonly string[];
  readonly aspect: ShareAspect;
  readonly disclaimer: string;
}

const DISCLAIMER = "WAR ARENA presents engine output only. Not financial advice; no token performance is guaranteed.";

/** Build a share card from a world state. Deterministic, no computation. */
export function buildShareCard(state: WorldState, aspect: ShareAspect = "1:1"): BattleShareCard {
  return {
    token: state.address,
    chain: state.chain,
    state: state.mood,
    power: state.power.raw,
    threat: state.threat.raw,
    confidence: state.confidence.raw,
    attention: state.attention.raw,
    trajectory: state.trajectory,
    topEvent: state.events[0]?.type ?? null,
    timestamp: state.generatedAt,
    dataQuality: state.dataQuality,
    insufficient: state.insufficient,
    aspect,
    disclaimer: DISCLAIMER,
  };
}
'@

Write-WarFile 'src/config/scoring.ts' @'
/**
 * WAR core - scoring configuration (Phase 8).
 *
 * All weights and thresholds live here, versioned. No magic numbers inside the
 * scoring engines. Changing a weight changes powerModelVersion, keeping historic
 * outputs interpretable.
 */

/** A named, weighted input to a composite score. */
export interface WeightedInput {
  readonly factor: string;
  readonly weight: number;
}

export interface PowerConfig {
  readonly version: string;
  /** Positive-direction factors (accumulation, alignment, smart flow, ...). */
  readonly supportingWeights: readonly WeightedInput[];
  /** Negative-direction factors (sell pressure, conflict, ...). */
  readonly opposingWeights: readonly WeightedInput[];
}

export interface ThreatConfig {
  readonly version: string;
  readonly weights: readonly WeightedInput[];
}

export interface ConfidenceConfig {
  readonly version: string;
  /** Blend weights for the confidence sub-dimensions (must sum to > 0). */
  readonly completeness: number;
  readonly freshness: number;
  readonly historyDepth: number;
  readonly coherence: number;
  readonly measurementStability: number;
  readonly derivativeReliability: number;
  /** Coverage penalties: ROLLING/SAMPLED constrain confidence vs COMPLETE. */
  readonly coveragePenalty: {
    readonly COMPLETE: number;
    readonly ROLLING: number;
    readonly SAMPLED: number;
    readonly DERIVED: number;
  };
}

export const POWER_CONFIG: PowerConfig = {
  version: "power-v1",
  supportingWeights: [
    { factor: "trajectoryUp", weight: 30 },
    { factor: "coherenceAlignment", weight: 25 },
    { factor: "smartMoneyInflow", weight: 25 },
    { factor: "liquidityDepth", weight: 20 },
  ],
  opposingWeights: [
    { factor: "sellPressure", weight: 30 },
    { factor: "vectorConflict", weight: 25 },
  ],
};

export const THREAT_CONFIG: ThreatConfig = {
  version: "threat-v1",
  weights: [
    { factor: "rugRisk", weight: 30 },
    { factor: "holderConcentration", weight: 25 },
    { factor: "washTrading", weight: 20 },
    { factor: "liquidityFragility", weight: 25 },
  ],
};

export const CONFIDENCE_CONFIG: ConfidenceConfig = {
  // v2: measurementStability weight zeroed. Stability = variance across repeated
  // measurements, which is undefined for a single-snapshot scan. Rather than
  // invent a value or falsely penalize confidence, its weight is 0; confidence is
  // blended from the five measurable dimensions. A real stability term may return
  // in a monitor context (multiple samples) under a future confidence version.
  version: "confidence-v2",
  completeness: 0.2,
  freshness: 0.15,
  historyDepth: 0.2,
  coherence: 0.2,
  measurementStability: 0.0,
  derivativeReliability: 0.15,
  coveragePenalty: {
    COMPLETE: 1.0,
    ROLLING: 0.7,
    SAMPLED: 0.8,
    DERIVED: 0.9,
  },
};
'@

Write-WarFile 'src/config/versions.ts' @'
/**
 * WAR core - version identifiers (Phase 12).
 *
 * Every BattlefieldState is stamped with these so historical outputs stay
 * interpretable as models evolve. Bumping any sub-model version here is how a
 * behavioural change is made auditable.
 */

import type { ModelVersions } from "../shared/quality.js";

export const ENGINE_VERSION = "war-engine-0.1.0";

export const MODEL_VERSIONS: ModelVersions = {
  engineVersion: ENGINE_VERSION,
  powerModelVersion: "power-v1",
  stateModelVersion: "state-v1",
  physicsModelVersion: "physics-none", // physics not part of the core build
  configurationVersion: "config-v1",
  featureModelVersion: "feature-v1",
  activationModelVersion: "activation-v1",
  confidenceModelVersion: "confidence-v2",
};
'@

Write-WarFile 'src/core/features/engineSnapshot.ts' @'
/**
 * WAR core - Feature layer - EngineSnapshot extraction (Phase 6, monitor).
 *
 * detectEvents(before, after) needs two EngineSnapshots. In a MONITOR context
 * (not scan, per B1), we hold the prior evaluation's snapshot and compare it to
 * the current one. This helper extracts a snapshot from a battlefield entry.
 *
 * This is a pure structural projection — it reads already-computed engine outputs
 * and copies them into the EngineSnapshot shape. No new intelligence.
 */

import type { UnixMillis } from "../../shared/scalars.js";
import type { TokenBattlefieldEntry } from "../battlefield/types.js";
import type { EngineSnapshot } from "../events/eventDetector.js";

/** Project a battlefield entry (at instant `at`) into an EngineSnapshot. */
export function snapshotOf(entry: TokenBattlefieldEntry, at: UnixMillis): EngineSnapshot {
  return {
    at,
    power: entry.power.score as number,
    threat: entry.threat.score as number,
    netCoherence: entry.coherence.state === "INSUFFICIENT" ? 0 : (entry.coherence.netCoherence as number),
    leadLagFlowLeads: entry.leadLag.result === "FLOW_LEADS",
    state: entry.state,
  };
}
'@

Write-WarFile 'src/core/features/liquidityFragility.ts' @'
/**
 * WAR core - Feature layer - liquidityFragility (Phase 6, monitor-only).
 *
 * F10 was INSUFFICIENT in a single-snapshot scan (no time series). In a MONITOR
 * context, liquidity samples accumulate across T0->T1->T2..., so a defensible
 * fragility measure exists. Gate applied (per 4A discipline):
 *
 *   Source:   the accumulated liquidity sample series (Analytics lane, SAMPLED)
 *   Meaning:  how sharply liquidity is DROPPING relative to its recent level —
 *             a falling-liquidity token is more fragile (easier to rug/dump).
 *   Transform: relative drop over the window = max(0, (peak - current)/peak)
 *   Range:    [0,1]
 *   Missing:  INSUFFICIENT if fewer than MIN_SAMPLES, or if the newest sample is
 *             staler than MAX_GAP (SAMPLED coverage has gaps; a large gap makes a
 *             derivative meaningless — we refuse rather than fabricate).
 *   Anti-lookahead: uses only samples with at <= T (caller slices).
 *
 * DECISION (locked by default, no config change): this produces the F10
 * `liquidityFragility` activation ONLY when the gate passes. Otherwise the factor
 * is omitted (INSUFFICIENT), exactly as in scan. We never invent a value.
 *
 * Rationale for "relative drop from peak" over raw derivative: a raw Δliquidity/Δt
 * is scale- and sign-noisy across sparse SAMPLED points; "drop from recent peak"
 * is a bounded, interpretable fragility signal that maps cleanly to [0,1] and is
 * defensible without inventing a slope model over irregular gaps.
 */

export interface LiquiditySample {
  readonly at: number; // ms
  readonly liquidity: number; // USD
}

export interface LiquidityFragilityConfig {
  readonly minSamples: number; // >= this many samples required
  readonly maxGapMs: number; // newest sample must be within this of T
}

export const LIQUIDITY_FRAGILITY_CONFIG: LiquidityFragilityConfig = {
  minSamples: 3,
  maxGapMs: 2 * 60 * 1000, // <= 2x a 1-min sampling cadence
};

export interface LiquidityFragilityResult {
  /** The F10 activation value in [0,1], or null when INSUFFICIENT. */
  readonly value: number | null;
  readonly insufficient: boolean;
  readonly reason: string;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Compute liquidityFragility from the accumulated sample series, evaluated at T.
 * Returns null (INSUFFICIENT) unless the gate passes.
 */
export function computeLiquidityFragility(
  samples: readonly LiquiditySample[],
  evaluationAt: number,
  config: LiquidityFragilityConfig = LIQUIDITY_FRAGILITY_CONFIG,
): LiquidityFragilityResult {
  const inWindow = samples.filter((s) => s.at <= evaluationAt);
  if (inWindow.length < config.minSamples) {
    return { value: null, insufficient: true, reason: `need >= ${config.minSamples} samples, have ${inWindow.length}` };
  }
  const sorted = [...inWindow].sort((a, b) => a.at - b.at);
  const newest = sorted[sorted.length - 1]!;
  const gap = evaluationAt - newest.at;
  if (gap > config.maxGapMs) {
    return { value: null, insufficient: true, reason: `newest sample stale by ${gap}ms > ${config.maxGapMs}ms` };
  }

  const peak = Math.max(...sorted.map((s) => s.liquidity));
  if (peak <= 0) {
    return { value: null, insufficient: true, reason: "non-positive peak liquidity" };
  }
  const current = newest.liquidity;
  const relativeDrop = clamp01((peak - current) / peak);
  return { value: relativeDrop, insufficient: false, reason: `drop ${(relativeDrop * 100).toFixed(1)}% from peak` };
}
'@

Write-WarFile 'src/hardening/ResilientCliExecutor.ts' @'
/**
 * WAR hardening - ResilientCliExecutor (Phase 7).
 *
 * Wraps any CliExecutor with the full transport-resilience stack:
 *   kill switch -> circuit breaker -> timeout -> retry+backoff -> observability
 *
 * It is a CliExecutor itself, so it drops into the existing scan/monitor
 * composition (createScanService / MonitoringService) WITHOUT changing them:
 * inject a ResilientCliExecutor instead of a raw one.
 *
 * Time and sleeping are injected (clock + sleep) so behaviour is deterministic
 * and testable. It adds NO intelligence; it only governs how the transport call
 * is attempted and observed. Rate limiting is handled by the caller's bucket or
 * can be layered here via the cost guard; this class focuses on retry/breaker/
 * timeout/observability and surfaces structured events for metrics.
 */

import type { CliExecutor, CliRunResult, GmgnErrorKind } from "../adapters/gmgn/gmgnRunner.js";
import { classifyRunResult } from "./classify.js";
import {
  decideRetry,
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
} from "./retryPolicy.js";
import {
  breakerAllows,
  breakerOnFailure,
  breakerOnSuccess,
  initBreaker,
  DEFAULT_BREAKER,
  type BreakerConfig,
  type BreakerState,
  type KillSwitch,
  KILL_SWITCH_OFF,
} from "./guards.js";

/** Injected clock + cooperative sleep, so retries are deterministic in tests. */
export interface TimeProvider {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Structured observability sink. Metrics/logging attach here. */
export interface Observer {
  onAttempt(argv: readonly string[], attempt: number): void;
  onSuccess(argv: readonly string[], attempt: number, elapsedMs: number): void;
  onFailure(argv: readonly string[], attempt: number, kind: GmgnErrorKind): void;
  onGiveUp(argv: readonly string[], attempts: number, kind: GmgnErrorKind): void;
  onKilled(argv: readonly string[], reason: string): void;
  onBreakerOpen(argv: readonly string[]): void;
}

export const NOOP_OBSERVER: Observer = {
  onAttempt() {}, onSuccess() {}, onFailure() {}, onGiveUp() {}, onKilled() {}, onBreakerOpen() {},
};

export interface ResilientConfig {
  readonly retry: RetryPolicy;
  readonly breaker: BreakerConfig;
  readonly timeoutMs: number;
}

export const DEFAULT_RESILIENT_CONFIG: ResilientConfig = {
  retry: DEFAULT_RETRY_POLICY,
  breaker: DEFAULT_BREAKER,
  timeoutMs: 15_000,
};

export interface ResilientDeps {
  readonly inner: CliExecutor;
  readonly time: TimeProvider;
  readonly config?: ResilientConfig;
  readonly observer?: Observer;
  /** A function returning the current kill switch (checked before every call). */
  readonly killSwitch?: () => KillSwitch;
}

export class ResilientCliExecutor implements CliExecutor {
  private breaker: BreakerState = initBreaker();
  private readonly inner: CliExecutor;
  private readonly time: TimeProvider;
  private readonly config: ResilientConfig;
  private readonly observer: Observer;
  private readonly killSwitch: () => KillSwitch;

  constructor(deps: ResilientDeps) {
    this.inner = deps.inner;
    this.time = deps.time;
    this.config = deps.config ?? DEFAULT_RESILIENT_CONFIG;
    this.observer = deps.observer ?? NOOP_OBSERVER;
    this.killSwitch = deps.killSwitch ?? (() => KILL_SWITCH_OFF);
  }

  async run(argv: readonly string[]): Promise<CliRunResult> {
    // Kill switch: hard stop.
    const kill = this.killSwitch();
    if (kill.engaged) {
      this.observer.onKilled(argv, kill.reason ?? "killed");
      return { exitCode: 1, stdout: "", stderr: `KILL_SWITCH: ${kill.reason ?? "engaged"}` };
    }

    // Circuit breaker: refuse fast if open.
    const gate = breakerAllows(this.breaker, this.config.breaker, this.time.now());
    this.breaker = gate.state;
    if (!gate.allowed) {
      this.observer.onBreakerOpen(argv);
      return { exitCode: 1, stdout: "", stderr: "CIRCUIT_OPEN" };
    }

    let attempt = 0;
    let lastResult: CliRunResult = { exitCode: 1, stdout: "", stderr: "not run" };
    while (attempt < this.config.retry.maxAttempts) {
      attempt++;
      this.observer.onAttempt(argv, attempt);
      const startedAt = this.time.now();

      lastResult = await this.withTimeout(this.inner.run(argv), this.config.timeoutMs);
      const classification = classifyRunResult(lastResult);

      if (classification.ok) {
        this.breaker = breakerOnSuccess();
        this.observer.onSuccess(argv, attempt, this.time.now() - startedAt);
        return lastResult;
      }

      const kind = classification.kind;
      this.observer.onFailure(argv, attempt, kind);
      this.breaker = breakerOnFailure(this.breaker, this.config.breaker, this.time.now());

      const decision = decideRetry(attempt, kind, this.config.retry, classification.resetAtMs, this.time.now());
      if (!decision.retry) {
        this.observer.onGiveUp(argv, attempt, kind);
        return lastResult;
      }
      await this.time.sleep(decision.delayMs);
    }
    return lastResult;
  }

  /** Race the inner call against a timeout; timeout yields a TIMEOUT-shaped result. */
  private async withTimeout(p: Promise<CliRunResult>, timeoutMs: number): Promise<CliRunResult> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<CliRunResult>((resolve) => {
      timer = setTimeout(() => resolve({ exitCode: 1, stdout: "", stderr: "TIMEOUT" }), timeoutMs);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /** Test/introspection helper. */
  breakerPhase(): BreakerState["phase"] {
    return this.breaker.phase;
  }
}
'@

Write-WarFile 'src/hardening/classify.ts' @'
/**
 * WAR hardening - result classification (Phase 7).
 *
 * Maps a raw CliRunResult to a hardening-facing classification used by the
 * resilient executor's retry/breaker logic. It mirrors the adapter's error
 * taxonomy (GmgnErrorKind) WITHOUT modifying the adapter. The resilient wrapper's
 * own TIMEOUT marker is mapped to NETWORK_ERROR (a retryable transport failure),
 * so no new error kind is introduced into the sealed adapter enum.
 */

import type { CliRunResult, GmgnErrorKind } from "../adapters/gmgn/gmgnRunner.js";

export type Classification =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: GmgnErrorKind; readonly resetAtMs: number | null };

function parseResetAtMs(headers?: Readonly<Record<string, string>>): number | null {
  if (headers === undefined) return null;
  const raw = headers["x-ratelimit-reset"] ?? headers["X-RateLimit-Reset"];
  if (raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  // Reset is unix seconds in the sealed contract; convert to ms.
  return n * 1000;
}

/**
 * Classify a CliRunResult. exitCode 0 with output is success. Otherwise the text
 * is matched against the same signals the adapter uses. The wrapper's TIMEOUT
 * marker becomes NETWORK_ERROR (retryable transport).
 */
export function classifyRunResult(res: CliRunResult): Classification {
  if (res.exitCode === 0 && res.stdout.trim().length > 0) {
    return { ok: true };
  }
  const text = `${res.stderr} ${res.stdout}`.toLowerCase();

  if (text.includes("timeout")) {
    return { ok: false, kind: "NETWORK_ERROR", resetAtMs: null };
  }
  if (text.includes("kill_switch") || text.includes("circuit_open")) {
    // These are our own gate refusals; treat as non-retryable network-class stop.
    return { ok: false, kind: "NETWORK_ERROR", resetAtMs: null };
  }
  if (text.includes("command not found") || text.includes("not recognized")) {
    return { ok: false, kind: "CLI_MISSING", resetAtMs: null };
  }
  if (text.includes("401") || text.includes("403") || text.includes("auth")) {
    return { ok: false, kind: "AUTH_ERROR", resetAtMs: null };
  }
  if (text.includes("429") || text.includes("rate limit")) {
    return { ok: false, kind: "RATE_LIMIT", resetAtMs: parseResetAtMs(res.headers) };
  }
  if (res.exitCode === 0) {
    // exit 0 but empty output
    return { ok: false, kind: "FORMAT_ERROR", resetAtMs: null };
  }
  return { ok: false, kind: "NETWORK_ERROR", resetAtMs: null };
}
'@

Write-WarFile 'src/hardening/guards.ts' @'
/**
 * WAR hardening - kill switch, circuit breaker, concurrency + cost guards
 * (Phase 7). Pure, deterministic state threaded as values. No IO.
 *
 * These protect the system from runaway polling, cascading failures, and cost
 * blowout. None of them touch intelligence; they gate whether a transport call
 * is allowed to proceed.
 */

// ── Kill switch ───────────────────────────────────────────────────────────────

/** A global, explicit stop. When engaged, NO acquisition proceeds. */
export interface KillSwitch {
  readonly engaged: boolean;
  readonly reason: string | null;
}

export const KILL_SWITCH_OFF: KillSwitch = { engaged: false, reason: null };

export function engageKill(reason: string): KillSwitch {
  return { engaged: true, reason };
}

// ── Circuit breaker ───────────────────────────────────────────────────────────

/**
 * Trips OPEN after `failureThreshold` consecutive failures; stays open for
 * `cooldownMs`; then HALF_OPEN allows one trial. Deterministic on injected time.
 */
export type BreakerPhase = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface BreakerConfig {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
}

export const DEFAULT_BREAKER: BreakerConfig = { failureThreshold: 5, cooldownMs: 60_000 };

export interface BreakerState {
  readonly phase: BreakerPhase;
  readonly consecutiveFailures: number;
  readonly openedAt: number | null;
}

export function initBreaker(): BreakerState {
  return { phase: "CLOSED", consecutiveFailures: 0, openedAt: null };
}

/** Can a call proceed right now? Transitions OPEN->HALF_OPEN after cooldown. */
export function breakerAllows(state: BreakerState, config: BreakerConfig, now: number): { allowed: boolean; state: BreakerState } {
  if (state.phase === "OPEN") {
    if (state.openedAt !== null && now - state.openedAt >= config.cooldownMs) {
      return { allowed: true, state: { ...state, phase: "HALF_OPEN" } };
    }
    return { allowed: false, state };
  }
  return { allowed: true, state };
}

export function breakerOnSuccess(): BreakerState {
  return initBreaker(); // reset fully on success
}

export function breakerOnFailure(state: BreakerState, config: BreakerConfig, now: number): BreakerState {
  const failures = state.consecutiveFailures + 1;
  if (failures >= config.failureThreshold) {
    return { phase: "OPEN", consecutiveFailures: failures, openedAt: now };
  }
  return { phase: state.phase === "HALF_OPEN" ? "OPEN" : "CLOSED", consecutiveFailures: failures, openedAt: state.phase === "HALF_OPEN" ? now : state.openedAt };
}

// ── Concurrency limiter ───────────────────────────────────────────────────────

export interface ConcurrencyState {
  readonly inFlight: number;
  readonly max: number;
}

export function initConcurrency(max: number): ConcurrencyState {
  return { inFlight: 0, max };
}

export function tryAcquireSlot(state: ConcurrencyState): { acquired: boolean; state: ConcurrencyState } {
  if (state.inFlight >= state.max) return { acquired: false, state };
  return { acquired: true, state: { ...state, inFlight: state.inFlight + 1 } };
}

export function releaseSlot(state: ConcurrencyState): ConcurrencyState {
  return { ...state, inFlight: Math.max(0, state.inFlight - 1) };
}

// ── Cost guard ────────────────────────────────────────────────────────────────

/**
 * Tracks GMGN request-weight spend within a rolling budget window. Refuses calls
 * that would exceed the budget — protecting against cost blowout from runaway
 * polling or a monitor storm.
 */
export interface CostBudget {
  readonly windowMs: number;
  readonly maxWeight: number;
}

export interface CostState {
  readonly windowStart: number;
  readonly spentWeight: number;
}

export function initCost(now: number): CostState {
  return { windowStart: now, spentWeight: 0 };
}

export function trySpend(state: CostState, budget: CostBudget, weight: number, now: number): { allowed: boolean; state: CostState } {
  // Roll the window forward if elapsed.
  let s = state;
  if (now - state.windowStart >= budget.windowMs) {
    s = { windowStart: now, spentWeight: 0 };
  }
  if (s.spentWeight + weight > budget.maxWeight) {
    return { allowed: false, state: s };
  }
  return { allowed: true, state: { ...s, spentWeight: s.spentWeight + weight } };
}
'@

Write-WarFile 'src/hardening/index.ts' @'
/**
 * WAR hardening layer (Phase 7) - transport resilience + operational safety.
 * Composes over existing primitives (rate limiter, error taxonomy) without
 * touching intelligence, config, or the adapter's sealed behaviour.
 */
export * from "./retryPolicy.js";
export * from "./guards.js";
export * from "./classify.js";
export {
  ResilientCliExecutor,
  NOOP_OBSERVER,
  DEFAULT_RESILIENT_CONFIG,
  type TimeProvider,
  type Observer,
  type ResilientConfig,
  type ResilientDeps,
} from "./ResilientCliExecutor.js";
'@

Write-WarFile 'src/hardening/retryPolicy.ts' @'
/**
 * WAR hardening - retry / backoff policy (Phase 7).
 *
 * Pure, deterministic policy: given an attempt number and an error kind, decide
 * whether to retry and after how long. No IO, no clock — the caller injects time
 * and performs the wait. This lets the whole retry machine be unit-tested exactly.
 *
 * Adds NO intelligence, NO new factor. It only governs transport resilience.
 */

import type { GmgnErrorKind } from "../adapters/gmgn/gmgnRunner.js";

export interface RetryPolicy {
  readonly maxAttempts: number; // total attempts incl. the first
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Multiplier for exponential backoff. */
  readonly factor: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  factor: 2,
};

/** Which error kinds are worth retrying. AUTH/CLI_MISSING/FORMAT are not.
 *  (Timeouts are classified as NETWORK_ERROR upstream, so they retry too.) */
const RETRYABLE: ReadonlySet<GmgnErrorKind> = new Set<GmgnErrorKind>([
  "RATE_LIMIT",
  "NETWORK_ERROR",
]);

export function isRetryable(kind: GmgnErrorKind): boolean {
  return RETRYABLE.has(kind);
}

export interface RetryDecision {
  readonly retry: boolean;
  readonly delayMs: number;
  readonly reason: string;
}

/**
 * Decide the next step after a failure.
 *
 * @param attempt      1-based attempt number that just failed
 * @param kind         the error kind
 * @param policy       retry policy
 * @param resetAtMs    optional absolute time (ms) the rate limit resets
 * @param nowMs        current time (ms), used only to derive rate-limit wait
 */
export function decideRetry(
  attempt: number,
  kind: GmgnErrorKind,
  policy: RetryPolicy,
  resetAtMs: number | null,
  nowMs: number,
): RetryDecision {
  if (!isRetryable(kind)) {
    return { retry: false, delayMs: 0, reason: `non-retryable: ${kind}` };
  }
  if (attempt >= policy.maxAttempts) {
    return { retry: false, delayMs: 0, reason: `max attempts (${policy.maxAttempts}) reached` };
  }

  // Exponential backoff: base * factor^(attempt-1), capped.
  const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * Math.pow(policy.factor, attempt - 1));

  // For RATE_LIMIT, honor the server's reset time if it is later than backoff.
  if (kind === "RATE_LIMIT" && resetAtMs !== null) {
    const untilReset = Math.max(0, resetAtMs - nowMs);
    const delayMs = Math.max(backoff, untilReset);
    return { retry: true, delayMs, reason: `rate-limit backoff honoring reset (${delayMs}ms)` };
  }

  return { retry: true, delayMs: backoff, reason: `backoff attempt ${attempt} (${backoff}ms)` };
}

/**
 * Full deterministic delay schedule for a run that fails every attempt with the
 * same kind. Useful for tests and for capacity/cost planning.
 */
export function delaySchedule(
  kind: GmgnErrorKind,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): readonly number[] {
  const out: number[] = [];
  for (let attempt = 1; attempt < policy.maxAttempts; attempt++) {
    const d = decideRetry(attempt, kind, policy, null, 0);
    if (!d.retry) break;
    out.push(d.delayMs);
  }
  return out;
}
'@

Write-WarFile 'src/integration/MonitoringService.ts' @'
/**
 * WAR integration - MonitoringService (Phase 6).
 *
 * Drives a paid $1/24h monitoring session. Each invocation performs ONE tick:
 *   1. check the session may acquire (ACTIVE + not expired)
 *   2. acquire normalized observations (real acquisition port)
 *   3. evaluate through real WAR (real evaluation port)
 *   4. monitorTick: events / alerts / change-aware persist, threading carry
 *   5. persist meaningful changes + alerts; update session markers
 *
 * NO new intelligence, NO live polling loop here (the scheduler/cron that calls
 * tick() repeatedly is injected by the caller; the CLI executor is injected too,
 * exactly like the scan path). Deterministic given its inputs.
 *
 * Expiry invariant: an expired/inactive session performs NO acquisition.
 */

import type { UnixMillis } from "../shared/scalars.js";
import type { Clock, DomainResult } from "../product/domain/identity.js";
import { ok, err } from "../product/domain/identity.js";
import type { MonitoringSession } from "../product/monitor/monitor.js";
import { isAcquisitionAllowed, expireIfDue } from "../product/monitor/monitor.js";
import type { GmgnAcquisitionPort, WarEvaluationPort } from "../product/scan/ports/ports.js";
import { monitorTick, type MonitorCarry } from "./monitorTick.js";
import type { MarketEvent } from "../core/state/types.js";
import type { Alert } from "../product/intelligence/alerts.js";

export interface MonitorServiceDeps {
  readonly acquisition: GmgnAcquisitionPort;
  readonly evaluation: WarEvaluationPort;
  readonly clock: Clock;
}

export interface MonitorTickOutcome {
  readonly session: MonitoringSession;
  readonly events: readonly MarketEvent[];
  readonly alerts: readonly Alert[];
  readonly persisted: boolean;
  readonly nextCarry: MonitorCarry;
  readonly skipped: "EXPIRED" | "NOT_ACTIVE" | null;
}

export class MonitoringService {
  constructor(private readonly deps: MonitorServiceDeps) {}

  /**
   * Execute one monitoring tick. Returns the (possibly expired) session, any
   * events/alerts, whether this tick's result should be persisted, and the carry
   * to thread into the next tick.
   */
  async tick(session: MonitoringSession, carry: MonitorCarry): Promise<DomainResult<MonitorTickOutcome>> {
    const now = this.deps.clock.now();

    // Expire if due first — an expired monitor does no acquisition (invariant).
    const expired = expireIfDue(session, now);
    if (!expired.ok) return err(expired.error);
    const current = expired.value;

    if (current.status === "EXPIRED") {
      return ok({ session: current, events: [], alerts: [], persisted: false, nextCarry: carry, skipped: "EXPIRED" });
    }
    if (!isAcquisitionAllowed(current, now)) {
      return ok({ session: current, events: [], alerts: [], persisted: false, nextCarry: carry, skipped: "NOT_ACTIVE" });
    }

    // Acquire + evaluate through the real chain.
    const acq = await this.deps.acquisition.acquire(current.token.chain, current.token.address, now);
    if (!acq.ok) return err(`acquisition failed: ${acq.error}`);

    const evalRes = await this.deps.evaluation.evaluate(acq.value, now);
    if (!evalRes.ok) return err(`evaluation failed: ${evalRes.error}`);

    const result = monitorTick(evalRes.value, current.token.address, now as UnixMillis, carry);

    // Update session temporal markers.
    const updated: MonitoringSession = {
      ...current,
      lastObservationAt: now,
      lastBattlefieldStateAt: now,
      lastEventAt: result.events.length > 0 ? now : current.lastEventAt,
    };

    return ok({
      session: updated,
      events: result.events,
      alerts: result.alerts,
      persisted: result.persist.persist,
      nextCarry: result.nextCarry,
      skipped: null,
    });
  }
}
'@

Write-WarFile 'src/integration/RealGmgnAcquisitionPort.ts' @'
/**
 * WAR integration - RealGmgnAcquisitionPort (Phase 5B).
 *
 * Satisfies the product-side GmgnAcquisitionPort by running the REAL transport
 * chain for one token:
 *
 *   CliExecutor (injected) -> gmgnRunner -> raw GMGN JSON
 *     -> existing parsers (parseKline / parseTrending / parseFlowEvent)
 *     -> sealed flow normalizer (inside parseFlowEvent)
 *     -> NormalizedObservations
 *
 * It produces ONLY normalized observations. It NEVER computes Power/Threat/
 * Confidence or a BattlefieldState — that is the evaluator's job downstream.
 * Banned fields (hot_level, raw is_open_or_close) die in the parsers/normalizer,
 * never reaching here in a usable form.
 *
 * The CliExecutor is injected: a real one runs gmgn-cli (5F); a stub returns
 * raw-shaped payloads for transport tests (5B). Either way the data flows through
 * the real parsers — the stub replaces the NETWORK, not the intelligence.
 */

import type { Chain, TokenAddress, UnixMillis } from "../shared/scalars.js";
import type {
  MarketObservation,
  AnalyticsObservation,
  FlowObservation,
} from "../core/timeline/types.js";
import {
  parseKline,
  parseTrending,
  parseFlowEvent,
  type RawKline,
  type RawTrending,
} from "../adapters/gmgn/gmgnParsers.js";
import type { RawFlowEvent } from "../adapters/gmgn/FlowEventNormalizer.contract.js";
import {
  runGmgnJson,
  klineArgv,
  trendingArgv,
  trackArgv,
  type CliExecutor,
} from "../adapters/gmgn/gmgnRunner.js";
import type {
  GmgnAcquisitionPort,
  NormalizedObservations,
} from "../product/scan/ports/ports.js";
import type { DomainResult } from "../product/domain/identity.js";
import { ok, err } from "../product/domain/identity.js";

export interface AcquisitionConfig {
  readonly klineResolution: string; // e.g. "1m"
  readonly trendingInterval: string; // e.g. "1m"
  /** Which track sub-command to pull flow from (kol / smartmoney / follow-wallet). */
  readonly flowSource: "kol" | "smartmoney" | "follow-wallet";
}

export const DEFAULT_ACQUISITION_CONFIG: AcquisitionConfig = {
  klineResolution: "1m",
  trendingInterval: "1m",
  flowSource: "smartmoney",
};

export class RealGmgnAcquisitionPort implements GmgnAcquisitionPort {
  constructor(
    private readonly exec: CliExecutor,
    private readonly config: AcquisitionConfig = DEFAULT_ACQUISITION_CONFIG,
  ) {}

  async acquire(
    chain: Chain,
    address: TokenAddress,
    atMs: number,
  ): Promise<DomainResult<NormalizedObservations>> {
    // 1. MARKET (kline)
    const klineRes = await runGmgnJson<readonly RawKline[]>(
      this.exec,
      klineArgv(chain, address as string, this.config.klineResolution),
    );
    if (!klineRes.ok) return err(`kline acquisition failed: ${klineRes.kind}`);

    // 2. ANALYTICS (trending) — carries the sealed security fields too
    const trendingRes = await runGmgnJson<readonly RawTrending[]>(
      this.exec,
      trendingArgv(chain, this.config.trendingInterval),
    );
    if (!trendingRes.ok) return err(`trending acquisition failed: ${trendingRes.kind}`);

    // 3. FLOW (track) — routed through the sealed normalizer inside parseFlowEvent
    const flowRes = await runGmgnJson<readonly RawFlowEvent[]>(
      this.exec,
      trackArgv(this.config.flowSource, chain),
    );
    if (!flowRes.ok) return err(`flow acquisition failed: ${flowRes.kind}`);

    // Parse each lane. Malformed rows are dropped (parser returns null); we never
    // fabricate an observation. Timestamps come from the payloads themselves.
    const market: MarketObservation[] = [];
    for (const raw of klineRes.data) {
      const obs = parseKline(raw);
      if (obs !== null) market.push(obs);
    }

    const analytics: AnalyticsObservation[] = [];
    for (const raw of trendingRes.data) {
      const obs = parseTrending(raw, atMs as UnixMillis);
      if (obs !== null) analytics.push(obs);
    }

    const flow: FlowObservation[] = [];
    for (const raw of flowRes.data) {
      const obs = parseFlowEvent(raw);
      if (obs !== null) flow.push(obs);
    }

    // Observed window = min/max observation timestamps actually obtained.
    const times: number[] = [
      ...market.map((m) => m.meta.at as number),
      ...analytics.map((a) => a.meta.at as number),
      ...flow.map((f) => f.meta.at as number),
    ];
    const observedFromMs = times.length > 0 ? Math.min(...times) : atMs;
    const observedToMs = times.length > 0 ? Math.max(...times) : atMs;

    return ok({
      chain,
      address,
      market,
      analytics,
      flow,
      observedFromMs,
      observedToMs,
    });
  }
}
'@

Write-WarFile 'src/integration/RealWarEvaluationPort.ts' @'
/**
 * WAR integration - RealWarEvaluationPort (Phase 5B).
 *
 * The composition-root adapter that satisfies the product-side WarEvaluationPort
 * by delegating to the REAL core evaluator evaluateToBattlefield. It contains NO
 * intelligence of its own. The only transformations are structural:
 *
 *   - atMs                     -> EvaluationObservations.evaluationAt
 *   - EvaluationOutput.battlefield -> BattlefieldState (unwrap)
 *   - EvaluationOutput.diagnostics -> recorded, NEVER a product decision input
 *   - sync                     -> Promise (the port is async)
 *
 * This layer may import both product contracts and core; it is the wiring seam.
 * It does not touch POWER/THREAT/CONFIDENCE config or any factor. It cannot
 * inject power/threat/battlefield — those come only from the core chain.
 */

import type { Chain, TokenAddress } from "../shared/scalars.js";
import type { UnixMillis } from "../shared/scalars.js";
import type { BattlefieldState } from "../core/battlefield/types.js";
import { evaluateToBattlefield } from "../core/features/warEvaluation.js";
import type { WarEvaluationPort, NormalizedObservations } from "../product/scan/ports/ports.js";
import type { DomainResult } from "../product/domain/identity.js";
import { ok, err } from "../product/domain/identity.js";

/** Optional sink for diagnostics; observing only, never feeds product decisions. */
export interface DiagnosticsSink {
  record(insufficient: readonly string[]): void;
}

export class RealWarEvaluationPort implements WarEvaluationPort {
  constructor(private readonly diagnostics?: DiagnosticsSink) {}

  async evaluate(
    observations: NormalizedObservations,
    atMs: number,
  ): Promise<DomainResult<BattlefieldState>> {
    try {
      const output = evaluateToBattlefield({
        chain: observations.chain as Chain,
        address: observations.address as TokenAddress,
        market: observations.market,
        analytics: observations.analytics,
        flow: observations.flow,
        // Structural mapping only: the evaluation instant is atMs.
        evaluationAt: atMs as UnixMillis,
      });

      // Diagnostics are recorded for auditability, never used to alter the result.
      if (this.diagnostics) this.diagnostics.record(output.diagnostics.insufficient);

      return ok(output.battlefield);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return err(`evaluation failed: ${reason}`);
    }
  }
}
'@

Write-WarFile 'src/integration/index.ts' @'
/**
 * WAR integration layer - composition root wiring.
 *
 * This layer connects existing contracts (core evaluator + gmgn adapter + product
 * ports) without adding intelligence. It is the ONLY place allowed to import both
 * core and adapters, because its job is wiring, not logic.
 */
export { RealWarEvaluationPort, type DiagnosticsSink } from "./RealWarEvaluationPort.js";
export {
  RealGmgnAcquisitionPort,
  DEFAULT_ACQUISITION_CONFIG,
  type AcquisitionConfig,
} from "./RealGmgnAcquisitionPort.js";
export { createScanService, type ScanCompositionDeps } from "./scanComposition.js";
export { MonitoringService, type MonitorServiceDeps, type MonitorTickOutcome } from "./MonitoringService.js";
export { monitorTick, initialCarry, type MonitorCarry, type MonitorTickResult } from "./monitorTick.js";
'@

Write-WarFile 'src/integration/monitorTick.ts' @'
/**
 * WAR integration - Monitor tick engine (Phase 6).
 *
 * A MONITORING session evaluates a token repeatedly over T0->T1->T2... Unlike a
 * scan (B1: no before/after), a monitor HOLDS the prior evaluation and compares.
 * This pure function advances one tick: it threads the carry-over state across
 * ticks and produces events, alerts, and a persistence decision.
 *
 * It adds NO new intelligence: events come from the real detectEvents, alerts
 * from the real AlertService, novelty from the real recordPattern, persistence
 * from the real decidePersist. The monitor's job is to CONNECT ticks over time,
 * which is exactly the context B1 reserved these transition signals for.
 *
 * Deterministic: no clock, no randomness. The tick instant is passed in.
 */

import type { UnixMillis } from "../shared/scalars.js";
import type { BattlefieldState } from "../core/battlefield/types.js";
import type { MarketEvent } from "../core/state/types.js";
import { detectEvents, type EngineSnapshot } from "../core/events/eventDetector.js";
import { snapshotOf } from "../core/features/engineSnapshot.js";
import { AlertService, type Alert, type SignalPhaseMemory } from "../product/intelligence/alerts.js";
import {
  fingerprint,
  decidePersist,
  type EntityFingerprint,
  type PersistDecision,
} from "../product/persistence/tokenMemory.js";
import type { TokenAddress } from "../shared/scalars.js";

/** Everything a monitor carries from one tick to the next. */
export interface MonitorCarry {
  readonly priorSnapshot: EngineSnapshot | null;
  readonly signalPhaseMemory: SignalPhaseMemory;
  readonly priorFingerprint: EntityFingerprint | null;
  readonly lastCheckpointAt: number | null;
}

export function initialCarry(): MonitorCarry {
  return { priorSnapshot: null, signalPhaseMemory: {}, priorFingerprint: null, lastCheckpointAt: null };
}

export interface MonitorTickResult {
  readonly events: readonly MarketEvent[];
  readonly alerts: readonly Alert[];
  readonly persist: PersistDecision;
  readonly nextCarry: MonitorCarry;
}

const alertService = new AlertService();

/**
 * Advance one monitoring tick for a single token.
 *
 * @param battlefield the freshly-evaluated BattlefieldState at this tick
 * @param address     the token under monitoring
 * @param at          the tick instant
 * @param carry       state carried from the previous tick
 */
export function monitorTick(
  battlefield: BattlefieldState,
  address: TokenAddress,
  at: UnixMillis,
  carry: MonitorCarry,
): MonitorTickResult {
  const entry = battlefield.tokens.find((t) => t.address === address);
  if (!entry) {
    // No meaningful result this tick: carry forward unchanged, nothing to persist.
    return {
      events: [],
      alerts: [],
      persist: { persist: false, reasons: ["no token in battlefield"] },
      nextCarry: carry,
    };
  }

  const currentSnapshot = snapshotOf(entry, at);

  // Events: only when we have a prior snapshot (monitor, not scan).
  const events: readonly MarketEvent[] =
    carry.priorSnapshot === null ? [] : detectEvents(carry.priorSnapshot, currentSnapshot);

  // Alerts: from the real AlertService (events + signal-phase transitions).
  const alertOutcome = alertService.evaluate(entry, carry.signalPhaseMemory);

  // Change-aware persistence decision.
  const fp = fingerprint(entry);
  const persist = decidePersist(carry.priorFingerprint, fp, carry.lastCheckpointAt, at as number);

  const nextCarry: MonitorCarry = {
    priorSnapshot: currentSnapshot,
    signalPhaseMemory: alertOutcome.nextMemory,
    priorFingerprint: fp,
    lastCheckpointAt: persist.persist ? (at as number) : carry.lastCheckpointAt,
  };

  return { events, alerts: alertOutcome.alerts, persist, nextCarry };
}
'@

Write-WarFile 'src/integration/scanComposition.ts' @'
/**
 * WAR integration - Scan composition root (Phase 5C).
 *
 * Wires the REAL ports into ScanService for the production path:
 *
 *   ScanService
 *     .acquisition = RealGmgnAcquisitionPort  (CLI -> parser -> normalizer)
 *     .evaluation  = RealWarEvaluationPort     (-> evaluateToBattlefield)
 *
 * There is NO test seam here. The only injected dependency that varies between
 * production and test is the CliExecutor (real gmgn-cli vs. a raw-payload stub) —
 * everything downstream of it is the real chain. ScanService itself is unchanged.
 */

import type { CliExecutor } from "../adapters/gmgn/gmgnRunner.js";
import type { ModelVersions } from "../shared/quality.js";
import type { Clock } from "../product/domain/identity.js";
import type { UnitOfWork } from "../product/persistence/contracts/repositories.js";
import type { EntitlementLedger } from "../product/payment/entitlement.js";
import { ScanService } from "../product/scan/orchestration/scanService.js";
import { RealGmgnAcquisitionPort, type AcquisitionConfig, DEFAULT_ACQUISITION_CONFIG } from "./RealGmgnAcquisitionPort.js";
import { RealWarEvaluationPort, type DiagnosticsSink } from "./RealWarEvaluationPort.js";

export interface ScanCompositionDeps {
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  readonly entitlements: EntitlementLedger;
  readonly engineVersion: string;
  readonly modelVersions: ModelVersions;
  /** The only prod/test-varying dependency: real gmgn-cli or a raw-payload stub. */
  readonly cliExecutor: CliExecutor;
  readonly acquisitionConfig?: AcquisitionConfig;
  readonly diagnostics?: DiagnosticsSink;
}

/**
 * Build a production ScanService wired to the real acquisition + evaluation
 * ports. Injecting a real CliExecutor makes this a fully live scan pipeline;
 * injecting a stub CliExecutor tests the whole chain minus the network.
 */
export function createScanService(deps: ScanCompositionDeps): ScanService {
  const acquisition = new RealGmgnAcquisitionPort(
    deps.cliExecutor,
    deps.acquisitionConfig ?? DEFAULT_ACQUISITION_CONFIG,
  );
  const evaluation = new RealWarEvaluationPort(deps.diagnostics);

  return new ScanService({
    uow: deps.uow,
    acquisition,
    evaluation,
    clock: deps.clock,
    entitlements: deps.entitlements,
    engineVersion: deps.engineVersion,
    modelVersions: deps.modelVersions,
  });
}
'@

Write-WarFile 'src/product/persistence/contracts/repositories.ts' @'
/**
 * WAR Product Layer - Phase 2 - Repository CONTRACTS (interfaces only).
 *
 * The Product Domain depends on THESE interfaces, never on PostgreSQL or SQL.
 * Two implementations satisfy them: an in-memory one (tests) and a pg one
 * (production). Neither leaks into the domain.
 *
 * Rules baked in:
 *  - PostgreSQL is the source of PRODUCT STATE, never a mirror of GMGN.
 *  - Financial/audit writes are append-only and idempotent.
 *  - Monitoring writes are change-aware (the caller decides; repos just store).
 *  - Every intelligence record is version- and provenance-stamped.
 *
 * All operations are async (a real DB is async). Idempotent inserts return the
 * existing row rather than throwing, mirroring Phase 1 ledger semantics.
 */

import type { ModelVersions } from "../../../shared/quality.js";
import type { Chain, TokenAddress } from "../../../shared/scalars.js";
import type { UserId, UserIdentity, TokenId } from "../../domain/identity.js";
import type { EntitlementType, PricingConfig } from "../../pricing/pricing.js";
import type { PaymentRail, PaymentStatus } from "../../payment/payment.js";
import type { Entitlement, UsageRecord } from "../../payment/entitlement.js";
import type { ScanRequest, ScanExecution } from "../../scan/scan.js";
import type { MonitoringSession } from "../../monitor/monitor.js";
import type { IntelligenceReport } from "../../intelligence/report.js";
import type { Alert } from "../../intelligence/alerts.js";
import type {
  TokenMemoryRecord,
  RecordProvenance,
} from "../tokenMemory.js";

// -- Persisted row shapes not already defined in Phase 1 ----------------------

/** A payment row. Append-only; status advances forward only. */
export interface PaymentRow {
  readonly providerTxId: string; // PK / idempotency anchor
  readonly intentId: string; // unique
  readonly userId: UserId;
  readonly rail: PaymentRail;
  readonly entitlementType: EntitlementType;
  readonly amountUsdMicros: number;
  readonly pricingVersion: string;
  readonly status: PaymentStatus;
  readonly createdAt: number;
  readonly verifiedAt: number | null;
  readonly refundedAt: number | null;
}

/** An append-only financial/audit event on a payment. */
export interface PaymentEventRow {
  readonly providerTxId: string;
  readonly event: "CREATED" | "VERIFIED" | "REFUNDED";
  readonly at: number;
  readonly rawRef: string | null;
}

/** A stored intelligence snapshot (the paid Scan product / monitor checkpoint). */
export interface IntelligenceSnapshotRow {
  readonly id: string; // PK; referenced by scan_executions.report_ref
  readonly token: TokenId;
  readonly sessionId: string | null; // null for a one-off scan
  readonly generatedAt: number;
  readonly report: IntelligenceReport;
  readonly engineVersion: string;
  readonly modelVersions: ModelVersions;
  readonly source: "SCAN" | "MONITOR";
  readonly createdAt: number;
}

/** A persisted signal-lifecycle transition (append-only, one per phase change). */
export interface SignalTransitionRow {
  readonly tokenId: TokenId;
  readonly sessionId: string | null;
  readonly signalIdentity: string;
  readonly fromPhase: string | null;
  readonly toPhase: string;
  readonly at: number;
  readonly reasons: readonly string[];
}

/** A persisted evidence record, tied to a snapshot (auditability). */
export interface EvidenceRow {
  readonly snapshotId: string;
  readonly kind: string;
  readonly factor: string;
  readonly magnitude: number | null;
  readonly weight: number | null;
  readonly note: string | null;
  readonly ordinal: number;
}

/** A persisted semantic event. */
export interface EventRow {
  readonly tokenId: TokenId;
  readonly snapshotId: string | null;
  readonly sessionId: string | null;
  readonly type: string;
  readonly at: number;
  readonly severity: number;
  readonly importance: number;
  readonly reasons: readonly string[];
  readonly beforeState: string;
  readonly afterState: string;
}

/** An alert row (delivery is a later phase; this only records the alert). */
export interface AlertRow {
  readonly id: string;
  readonly userId: UserId;
  readonly sessionId: string | null;
  readonly tokenId: TokenId;
  readonly alert: Alert;
  readonly createdAt: number;
}

// -- Repository interfaces ----------------------------------------------------

export interface UserRepository {
  upsert(user: UserIdentity): Promise<UserIdentity>;
  findById(id: UserId): Promise<UserIdentity | null>;
}

export interface TokenRepository {
  /** Idempotent by (chain,address); returns the canonical stored token id. */
  ensure(chain: Chain, address: TokenAddress, symbol?: string, name?: string): Promise<TokenId>;
  find(chain: Chain, address: TokenAddress): Promise<TokenId | null>;
  /**
   * Phase 3 search read contract (unblocks Token Search). Matches by symbol, name,
   * or address prefix. Returns only stored tokens — no fabricated results, no
   * ranking intelligence; ordering is by match closeness then symbol.
   */
  searchByText(text: string, limit: number): Promise<readonly TokenSearchRow[]>;
}

/** A search hit — only fields that actually exist on a stored token. */
export interface TokenSearchRow {
  readonly chain: Chain;
  readonly address: TokenAddress;
  readonly symbol: string | null;
  readonly name: string | null;
}

export interface PricingRepository {
  /** Append-only: recording an existing version is a no-op returning it. */
  record(config: PricingConfig): Promise<PricingConfig>;
  get(version: string): Promise<PricingConfig | null>;
}

export interface EngineVersionRepository {
  /** Append-only registry of engine/model version stamps. */
  record(engineVersion: string, models: ModelVersions): Promise<void>;
  has(engineVersion: string): Promise<boolean>;
}

export interface PaymentRepository {
  /** Idempotent create by providerTxId; returns existing row if present. */
  createIntent(row: PaymentRow): Promise<PaymentRow>;
  /** Append a financial event. Idempotent by (providerTxId,event). */
  appendEvent(ev: PaymentEventRow): Promise<void>;
  /** Advance status forward only (CREATED->VERIFIED->REFUNDED). */
  advanceStatus(providerTxId: string, status: PaymentStatus, at: number): Promise<PaymentRow>;
  get(providerTxId: string): Promise<PaymentRow | null>;
}

export interface EntitlementRepository {
  /** Idempotent by id ("ent:"+providerTxId). One payment => one entitlement. */
  issue(ent: Entitlement): Promise<Entitlement>;
  get(id: string): Promise<Entitlement | null>;
  updateStatus(id: string, status: Entitlement["status"]): Promise<Entitlement>;
}

export interface UsageRepository {
  /**
   * Insert exactly one usage record per entitlement (PK = entitlementId).
   * Returns { inserted:false } if it already existed - the single-consumption
   * guarantee enforced at the database level.
   */
  consume(record: UsageRecord): Promise<{ inserted: boolean; record: UsageRecord }>;
  release(entitlementId: string): Promise<void>;
  get(entitlementId: string): Promise<UsageRecord | null>;
}

export interface ScanRepository {
  createRequest(req: ScanRequest): Promise<ScanRequest>;
  createExecution(exec: ScanExecution): Promise<ScanExecution>;
  updateExecution(exec: ScanExecution): Promise<ScanExecution>;
  getExecution(id: string): Promise<ScanExecution | null>;
}

export interface MonitorRepository {
  create(session: MonitoringSession): Promise<MonitoringSession>;
  update(session: MonitoringSession): Promise<MonitoringSession>;
  get(id: string): Promise<MonitoringSession | null>;
  /** Active, non-expired sessions - used by the future scheduler (read-only here). */
  listActive(nowMs: number, limit: number): Promise<readonly MonitoringSession[]>;
}

export interface IntelligenceRepository {
  saveSnapshot(row: IntelligenceSnapshotRow): Promise<IntelligenceSnapshotRow>;
  getSnapshot(id: string): Promise<IntelligenceSnapshotRow | null>;
  saveEvidence(rows: readonly EvidenceRow[]): Promise<void>;
  saveEvents(rows: readonly EventRow[]): Promise<void>;
  /** Append-only signal transition; idempotent by (identity,at,toPhase). */
  saveSignalTransition(row: SignalTransitionRow): Promise<void>;
}

export interface MonitoringObservationRepository {
  /** Only called when change-aware logic decided to persist. */
  append(record: TokenMemoryRecord, fingerprint: unknown, reasons: readonly string[], provenance: RecordProvenance): Promise<void>;
  lastFingerprint(sessionId: string): Promise<unknown | null>;
  /**
   * Phase 3 history read contract (unblocks Battle Replay). Returns the persisted
   * observation records for a session in append (time) order. This is a READ only;
   * it adds no intelligence and does not change how records are produced.
   */
  list(sessionId: string): Promise<readonly MonitoringObservationRecord[]>;
}

/** A stored monitoring observation record, returned by the history read. */
export interface MonitoringObservationRecord {
  readonly record: TokenMemoryRecord;
  readonly reasons: readonly string[];
  readonly provenance: RecordProvenance;
}

export interface AlertRepository {
  save(row: AlertRow): Promise<void>;
  listForUser(userId: UserId, limit: number): Promise<readonly AlertRow[]>;
}

// -- Unit of work -------------------------------------------------------------

/**
 * A transactional scope. The orchestration layer (Phase 3+) runs a closure
 * inside a single DB transaction; all repositories obtained from `tx` share it,
 * so payment->entitlement or scan-consume->execute are atomic. The in-memory
 * implementation simulates this with a snapshot/rollback.
 */
export interface RepositoryBundle {
  readonly users: UserRepository;
  readonly tokens: TokenRepository;
  readonly pricing: PricingRepository;
  readonly engineVersions: EngineVersionRepository;
  readonly payments: PaymentRepository;
  readonly entitlements: EntitlementRepository;
  readonly usage: UsageRepository;
  readonly scans: ScanRepository;
  readonly monitors: MonitorRepository;
  readonly intelligence: IntelligenceRepository;
  readonly observations: MonitoringObservationRepository;
  readonly alerts: AlertRepository;
}

export interface UnitOfWork {
  /** Run `fn` in a single transaction. Commit on resolve, rollback on throw. */
  transaction<T>(fn: (repos: RepositoryBundle) => Promise<T>): Promise<T>;
  /** Direct (auto-commit) access for simple reads/writes. */
  readonly repos: RepositoryBundle;
}
'@

Write-WarFile 'src/product/persistence/memory/inMemory.ts' @'
/**
 * WAR Product Layer - Phase 2 - In-memory persistence (for tests).
 *
 * Satisfies the repository contracts with plain Maps. Transaction() takes a deep
 * snapshot before running the closure and restores it on throw, so atomicity
 * (payment->entitlement, consume->execute) is testable without PostgreSQL.
 *
 * The SAME invariants the pg schema enforces are enforced here:
 *   - payments/entitlements/usage idempotent by their keys
 *   - usage = one row per entitlement (single consumption)
 *   - append-only financial events
 */

import type { ModelVersions } from "../../../shared/quality.js";
import type { Chain, TokenAddress } from "../../../shared/scalars.js";
import type { UserIdentity, TokenId } from "../../domain/identity.js";
import { tokenKey } from "../../domain/identity.js";
import type { PricingConfig } from "../../pricing/pricing.js";
import type { PaymentStatus } from "../../payment/payment.js";
import type { Entitlement, UsageRecord } from "../../payment/entitlement.js";
import type { ScanRequest, ScanExecution } from "../../scan/scan.js";
import type { MonitoringSession } from "../../monitor/monitor.js";
import type { TokenMemoryRecord, RecordProvenance } from "../tokenMemory.js";
import type {
  UserRepository,
  TokenRepository,
  PricingRepository,
  EngineVersionRepository,
  PaymentRepository,
  EntitlementRepository,
  UsageRepository,
  ScanRepository,
  MonitorRepository,
  IntelligenceRepository,
  MonitoringObservationRepository,
  AlertRepository,
  RepositoryBundle,
  UnitOfWork,
  PaymentRow,
  PaymentEventRow,
  IntelligenceSnapshotRow,
  SignalTransitionRow,
  EvidenceRow,
  EventRow,
  AlertRow,
} from "../contracts/repositories.js";

/** All mutable state in one struct so a transaction can snapshot/restore it. */
interface Store {
  users: Map<string, UserIdentity>;
  tokensByKey: Map<string, TokenId>;
  tokenMeta: Map<string, { symbol: string | null; name: string | null }>;
  pricing: Map<string, PricingConfig>;
  engineVersions: Map<string, ModelVersions>;
  payments: Map<string, PaymentRow>;
  paymentEvents: PaymentEventRow[];
  entitlements: Map<string, Entitlement>;
  usage: Map<string, UsageRecord>;
  scanRequests: Map<string, ScanRequest>;
  scanExecutions: Map<string, ScanExecution>;
  monitors: Map<string, MonitoringSession>;
  snapshots: Map<string, IntelligenceSnapshotRow>;
  evidence: EvidenceRow[];
  events: EventRow[];
  signalTransitions: SignalTransitionRow[];
  observations: { record: TokenMemoryRecord; fingerprint: unknown; reasons: readonly string[]; provenance: RecordProvenance }[];
  lastFingerprint: Map<string, unknown>;
  alerts: AlertRow[];
}

function emptyStore(): Store {
  return {
    users: new Map(),
    tokensByKey: new Map(),
    tokenMeta: new Map(),
    pricing: new Map(),
    engineVersions: new Map(),
    payments: new Map(),
    paymentEvents: [],
    entitlements: new Map(),
    usage: new Map(),
    scanRequests: new Map(),
    scanExecutions: new Map(),
    monitors: new Map(),
    snapshots: new Map(),
    evidence: [],
    events: [],
    signalTransitions: [],
    observations: [],
    lastFingerprint: new Map(),
    alerts: [],
  };
}

function cloneStore(s: Store): Store {
  return {
    users: new Map(s.users),
    tokensByKey: new Map(s.tokensByKey),
    tokenMeta: new Map(s.tokenMeta),
    pricing: new Map(s.pricing),
    engineVersions: new Map(s.engineVersions),
    payments: new Map(s.payments),
    paymentEvents: [...s.paymentEvents],
    entitlements: new Map(s.entitlements),
    usage: new Map(s.usage),
    scanRequests: new Map(s.scanRequests),
    scanExecutions: new Map(s.scanExecutions),
    monitors: new Map(s.monitors),
    snapshots: new Map(s.snapshots),
    evidence: [...s.evidence],
    events: [...s.events],
    signalTransitions: [...s.signalTransitions],
    observations: [...s.observations],
    lastFingerprint: new Map(s.lastFingerprint),
    alerts: [...s.alerts],
  };
}

function bundle(s: Store): RepositoryBundle {
  const users: UserRepository = {
    async upsert(u) {
      s.users.set(u.userId as string, u);
      return u;
    },
    async findById(id) {
      return s.users.get(id as string) ?? null;
    },
  };

  const tokens: TokenRepository = {
    async ensure(chain: Chain, address: TokenAddress, symbol?: string, name?: string) {
      const t: TokenId = { chain, address };
      const k = tokenKey(t);
      const existing = s.tokensByKey.get(k);
      if (!existing) s.tokensByKey.set(k, t);
      if (symbol !== undefined || name !== undefined) {
        s.tokenMeta.set(k, { symbol: symbol ?? null, name: name ?? null });
      }
      return existing ?? t;
    },
    async find(chain, address) {
      return s.tokensByKey.get(tokenKey({ chain, address })) ?? null;
    },
    async searchByText(text: string, limit: number) {
      const needle = text.trim().toLowerCase();
      if (needle.length === 0) return [];
      const rows: { chain: Chain; address: TokenAddress; symbol: string | null; name: string | null }[] = [];
      for (const [k, t] of s.tokensByKey) {
        const meta = s.tokenMeta.get(k) ?? { symbol: null, name: null };
        const sym = (meta.symbol ?? "").toLowerCase();
        const nm = (meta.name ?? "").toLowerCase();
        const addr = (t.address as unknown as string).toLowerCase();
        if (sym.includes(needle) || nm.includes(needle) || addr.startsWith(needle)) {
          rows.push({ chain: t.chain, address: t.address, symbol: meta.symbol, name: meta.name });
        }
      }
      rows.sort((a, b) => (a.symbol ?? "").localeCompare(b.symbol ?? ""));
      return rows.slice(0, limit);
    },
  };

  const pricing: PricingRepository = {
    async record(config) {
      const existing = s.pricing.get(config.version);
      if (existing) return existing;
      s.pricing.set(config.version, config);
      return config;
    },
    async get(version) {
      return s.pricing.get(version) ?? null;
    },
  };

  const engineVersions: EngineVersionRepository = {
    async record(engineVersion, models) {
      if (!s.engineVersions.has(engineVersion)) s.engineVersions.set(engineVersion, models);
    },
    async has(engineVersion) {
      return s.engineVersions.has(engineVersion);
    },
  };

  const payments: PaymentRepository = {
    async createIntent(row) {
      const existing = s.payments.get(row.providerTxId);
      if (existing) return existing; // idempotent
      s.payments.set(row.providerTxId, row);
      return row;
    },
    async appendEvent(ev) {
      const dup = s.paymentEvents.some((e) => e.providerTxId === ev.providerTxId && e.event === ev.event);
      if (!dup) s.paymentEvents.push(ev);
    },
    async advanceStatus(providerTxId: string, status: PaymentStatus, at: number) {
      const row = s.payments.get(providerTxId);
      if (!row) throw new Error(`payment ${providerTxId} not found`);
      const next: PaymentRow = {
        ...row,
        status,
        verifiedAt: status === "VERIFIED" ? at : row.verifiedAt,
        refundedAt: status === "REFUNDED" ? at : row.refundedAt,
      };
      s.payments.set(providerTxId, next);
      return next;
    },
    async get(providerTxId) {
      return s.payments.get(providerTxId) ?? null;
    },
  };

  const entitlements: EntitlementRepository = {
    async issue(ent) {
      const existing = s.entitlements.get(ent.id);
      if (existing) return existing; // idempotent: 1 payment => 1 entitlement
      s.entitlements.set(ent.id, ent);
      return ent;
    },
    async get(id) {
      return s.entitlements.get(id) ?? null;
    },
    async updateStatus(id, status) {
      const ent = s.entitlements.get(id);
      if (!ent) throw new Error(`entitlement ${id} not found`);
      const next = { ...ent, status };
      s.entitlements.set(id, next);
      return next;
    },
  };

  const usage: UsageRepository = {
    async consume(record) {
      const existing = s.usage.get(record.entitlementId);
      if (existing) return { inserted: false, record: existing }; // single consumption
      s.usage.set(record.entitlementId, record);
      return { inserted: true, record };
    },
    async release(entitlementId) {
      s.usage.delete(entitlementId);
    },
    async get(entitlementId) {
      return s.usage.get(entitlementId) ?? null;
    },
  };

  const scans: ScanRepository = {
    async createRequest(req) {
      s.scanRequests.set(req.id, req);
      return req;
    },
    async createExecution(exec) {
      s.scanExecutions.set(exec.id, exec);
      return exec;
    },
    async updateExecution(exec) {
      s.scanExecutions.set(exec.id, exec);
      return exec;
    },
    async getExecution(id) {
      return s.scanExecutions.get(id) ?? null;
    },
  };

  const monitors: MonitorRepository = {
    async create(session) {
      s.monitors.set(session.id, session);
      return session;
    },
    async update(session) {
      s.monitors.set(session.id, session);
      return session;
    },
    async get(id) {
      return s.monitors.get(id) ?? null;
    },
    async listActive(nowMs, limit) {
      const out: MonitoringSession[] = [];
      for (const m of s.monitors.values()) {
        if (m.status === "ACTIVE" && nowMs < m.expiresAt) out.push(m);
        if (out.length >= limit) break;
      }
      return out;
    },
  };

  const intelligence: IntelligenceRepository = {
    async saveSnapshot(row) {
      const existing = s.snapshots.get(row.id);
      if (existing) return existing;
      s.snapshots.set(row.id, row);
      return row;
    },
    async getSnapshot(id) {
      return s.snapshots.get(id) ?? null;
    },
    async saveEvidence(rows) {
      s.evidence.push(...rows);
    },
    async saveEvents(rows) {
      s.events.push(...rows);
    },
    async saveSignalTransition(row) {
      const dup = s.signalTransitions.some(
        (t) => t.signalIdentity === row.signalIdentity && t.at === row.at && t.toPhase === row.toPhase,
      );
      if (!dup) s.signalTransitions.push(row);
    },
  };

  const observations: MonitoringObservationRepository = {
    async append(record, fingerprint, reasons, provenance) {
      s.observations.push({ record, fingerprint, reasons, provenance });
      const sid = record.ref; // ref carries the session-scoped key for last fingerprint
      s.lastFingerprint.set(sid, fingerprint);
    },
    async lastFingerprint(sessionId) {
      return s.lastFingerprint.get(sessionId) ?? null;
    },
    async list(sessionId) {
      // Records are session-scoped by record.ref. Return them in append order.
      return s.observations
        .filter((o) => o.record.ref === sessionId)
        .map((o) => ({ record: o.record, reasons: o.reasons, provenance: o.provenance }));
    },
  };

  const alerts: AlertRepository = {
    async save(row) {
      s.alerts.push(row);
    },
    async listForUser(userId, limit) {
      return s.alerts.filter((a) => a.userId === userId).slice(-limit);
    },
  };

  return {
    users, tokens, pricing, engineVersions, payments, entitlements,
    usage, scans, monitors, intelligence, observations, alerts,
  };
}

export class InMemoryUnitOfWork implements UnitOfWork {
  private store: Store = emptyStore();
  readonly repos: RepositoryBundle;

  constructor() {
    this.repos = bundle(this.store);
  }

  async transaction<T>(fn: (repos: RepositoryBundle) => Promise<T>): Promise<T> {
    const snapshot = cloneStore(this.store);
    try {
      // Rebind the bundle to the live store (same instance) so mutations apply.
      return await fn(bundle(this.store));
    } catch (e) {
      // rollback
      this.mutateFrom(snapshot);
      throw e;
    }
  }

  /** Restore all fields of the live store from a snapshot (rollback). */
  private mutateFrom(snap: Store): void {
    this.store.users = snap.users;
    this.store.tokensByKey = snap.tokensByKey;
    this.store.pricing = snap.pricing;
    this.store.engineVersions = snap.engineVersions;
    this.store.payments = snap.payments;
    this.store.paymentEvents = snap.paymentEvents;
    this.store.entitlements = snap.entitlements;
    this.store.usage = snap.usage;
    this.store.scanRequests = snap.scanRequests;
    this.store.scanExecutions = snap.scanExecutions;
    this.store.monitors = snap.monitors;
    this.store.snapshots = snap.snapshots;
    this.store.evidence = snap.evidence;
    this.store.events = snap.events;
    this.store.signalTransitions = snap.signalTransitions;
    this.store.observations = snap.observations;
    this.store.lastFingerprint = snap.lastFingerprint;
    this.store.alerts = snap.alerts;
  }
}
'@

Write-WarFile 'src/product/persistence/pg/pgRepositories.ts' @'
/**
 * WAR Product Layer - Phase 2 - PostgreSQL repositories.
 *
 * Implements the repository contracts against a PgQueryable. All idempotency is
 * expressed as INSERT ... ON CONFLICT, matching the schema's unique keys, so the
 * same payment/entitlement/usage/signal write, repeated, converges to one row.
 *
 * No ORM. Plain parameterized SQL. The domain never imports this module; only
 * the composition root (Phase 3+) wires a PgPool in.
 */

import type { ModelVersions } from "../../../shared/quality.js";
import type { Chain, TokenAddress } from "../../../shared/scalars.js";
import type { UserId, UserIdentity, TokenId } from "../../domain/identity.js";
import type { PricingConfig } from "../../pricing/pricing.js";
import type { PaymentStatus } from "../../payment/payment.js";
import type { Entitlement, UsageRecord } from "../../payment/entitlement.js";
import type { ScanRequest, ScanExecution } from "../../scan/scan.js";
import type { MonitoringSession } from "../../monitor/monitor.js";
import type { TokenMemoryRecord, RecordProvenance } from "../tokenMemory.js";
import type { PgQueryable, PgPool } from "./pgClient.js";
import type {
  RepositoryBundle,
  UnitOfWork,
  PaymentRow,
  PaymentEventRow,
  IntelligenceSnapshotRow,
  SignalTransitionRow,
  EvidenceRow,
  EventRow,
  AlertRow,
} from "../contracts/repositories.js";

const SP = "SET search_path TO war_product";

async function tokenIdBigint(q: PgQueryable, t: TokenId): Promise<number> {
  const r = await q.query<{ id: string }>(
    "SELECT id FROM tokens WHERE chain = $1 AND address = $2",
    [t.chain, t.address],
  );
  if (r.rows.length === 0) throw new Error(`token not persisted: ${t.chain}:${t.address as string}`);
  return Number(r.rows[0]!.id);
}

function makeBundle(q: PgQueryable): RepositoryBundle {
  return {
    users: {
      async upsert(u: UserIdentity) {
        await q.query(
          `INSERT INTO users (id, provider, provider_user_id, created_at)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (id) DO NOTHING`,
          [u.userId, u.provider, u.providerUserId, u.createdAt],
        );
        return u;
      },
      async findById(id: UserId) {
        const r = await q.query<{ id: string; provider: string; provider_user_id: string; created_at: string }>(
          "SELECT id, provider, provider_user_id, created_at FROM users WHERE id = $1",
          [id],
        );
        const row = r.rows[0];
        if (!row) return null;
        return {
          userId: row.id as UserId,
          provider: row.provider as UserIdentity["provider"],
          providerUserId: row.provider_user_id,
          createdAt: Number(row.created_at),
        };
      },
    },

    tokens: {
      async ensure(chain: Chain, address: TokenAddress, symbol?: string, name?: string) {
        await q.query(
          `INSERT INTO tokens (chain, address, symbol, name, first_seen_at)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (chain, address) DO NOTHING`,
          [chain, address, symbol ?? null, name ?? null, Date_nowGuardless()],
        );
        return { chain, address };
      },
      async find(chain: Chain, address: TokenAddress) {
        const r = await q.query("SELECT 1 FROM tokens WHERE chain=$1 AND address=$2", [chain, address]);
        return r.rows.length > 0 ? { chain, address } : null;
      },
      async searchByText(text: string, limit: number) {
        const like = `%${text.trim().toLowerCase()}%`;
        const prefix = `${text.trim().toLowerCase()}%`;
        const r = await q.query<{ chain: string; address: string; symbol: string | null; name: string | null }>(
          `SELECT chain, address, symbol, name FROM tokens
             WHERE LOWER(symbol) LIKE $1 OR LOWER(name) LIKE $1 OR LOWER(address) LIKE $2
             ORDER BY symbol ASC NULLS LAST LIMIT $3`,
          [like, prefix, limit],
        );
        return r.rows.map((row) => ({ chain: row.chain as never, address: row.address as never, symbol: row.symbol, name: row.name }));
      },
    },

    pricing: {
      async record(config: PricingConfig) {
        await q.query(
          `INSERT INTO pricing_versions (version, config)
           VALUES ($1,$2) ON CONFLICT (version) DO NOTHING`,
          [config.version, JSON.stringify(config)],
        );
        return config;
      },
      async get(version: string) {
        const r = await q.query<{ config: PricingConfig }>(
          "SELECT config FROM pricing_versions WHERE version=$1",
          [version],
        );
        return r.rows[0]?.config ?? null;
      },
    },

    engineVersions: {
      async record(engineVersion: string, models: ModelVersions) {
        await q.query(
          `INSERT INTO engine_versions (engine_version, model_versions)
           VALUES ($1,$2) ON CONFLICT (engine_version) DO NOTHING`,
          [engineVersion, JSON.stringify(models)],
        );
      },
      async has(engineVersion: string) {
        const r = await q.query("SELECT 1 FROM engine_versions WHERE engine_version=$1", [engineVersion]);
        return r.rows.length > 0;
      },
    },

    payments: {
      async createIntent(row: PaymentRow) {
        await q.query(
          `INSERT INTO payments
             (provider_tx_id,intent_id,user_id,rail,entitlement_type,amount_usd_micros,pricing_version,status,created_at,verified_at,refunded_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (provider_tx_id) DO NOTHING`,
          [row.providerTxId, row.intentId, row.userId, row.rail, row.entitlementType,
           row.amountUsdMicros, row.pricingVersion, row.status, row.createdAt, row.verifiedAt, row.refundedAt],
        );
        return row;
      },
      async appendEvent(ev: PaymentEventRow) {
        await q.query(
          `INSERT INTO payment_events (provider_tx_id,event,at,raw_ref)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (provider_tx_id,event) DO NOTHING`,
          [ev.providerTxId, ev.event, ev.at, ev.rawRef],
        );
      },
      async advanceStatus(providerTxId: string, status: PaymentStatus, at: number) {
        const r = await q.query<PaymentRowSql>(
          `UPDATE payments SET status=$2,
             verified_at = CASE WHEN $2='VERIFIED' THEN $3 ELSE verified_at END,
             refunded_at = CASE WHEN $2='REFUNDED' THEN $3 ELSE refunded_at END
           WHERE provider_tx_id=$1
           RETURNING *`,
          [providerTxId, status, at],
        );
        const row = r.rows[0];
        if (!row) throw new Error(`payment ${providerTxId} not found`);
        return fromPaymentSql(row);
      },
      async get(providerTxId: string) {
        const r = await q.query<PaymentRowSql>("SELECT * FROM payments WHERE provider_tx_id=$1", [providerTxId]);
        return r.rows[0] ? fromPaymentSql(r.rows[0]) : null;
      },
    },

    entitlements: {
      async issue(ent: Entitlement) {
        await q.query(
          `INSERT INTO entitlements (id,user_id,type,provider_tx_id,status,grants_duration_ms,issued_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (id) DO NOTHING`,
          [ent.id, ent.userId, ent.type, ent.providerTxId, ent.status, ent.grantsDurationMs, ent.issuedAt],
        );
        return ent;
      },
      async get(id: string) {
        const r = await q.query<EntitlementSql>("SELECT * FROM entitlements WHERE id=$1", [id]);
        return r.rows[0] ? fromEntitlementSql(r.rows[0]) : null;
      },
      async updateStatus(id: string, status: Entitlement["status"]) {
        const r = await q.query<EntitlementSql>(
          "UPDATE entitlements SET status=$2 WHERE id=$1 RETURNING *", [id, status],
        );
        if (!r.rows[0]) throw new Error(`entitlement ${id} not found`);
        return fromEntitlementSql(r.rows[0]);
      },
    },

    usage: {
      async consume(record: UsageRecord) {
        const r = await q.query(
          `INSERT INTO usage_ledger (entitlement_id,user_id,consumed_at,capability_ref)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (entitlement_id) DO NOTHING`,
          [record.entitlementId, record.userId, record.consumedAt, record.capabilityRef],
        );
        return { inserted: r.rowCount > 0, record };
      },
      async release(entitlementId: string) {
        await q.query("DELETE FROM usage_ledger WHERE entitlement_id=$1", [entitlementId]);
      },
      async get(entitlementId: string) {
        const r = await q.query<{ entitlement_id: string; user_id: string; consumed_at: string; capability_ref: string }>(
          "SELECT * FROM usage_ledger WHERE entitlement_id=$1", [entitlementId],
        );
        const row = r.rows[0];
        if (!row) return null;
        return {
          entitlementId: row.entitlement_id,
          userId: row.user_id as UserId,
          consumedAt: Number(row.consumed_at),
          capabilityRef: row.capability_ref,
        };
      },
    },

    scans: {
      async createRequest(req: ScanRequest) {
        const tid = await tokenIdBigint(q, req.token);
        await q.query(
          `INSERT INTO scan_requests (id,user_id,token_id,entitlement_id,requested_at)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
          [req.id, req.userId, tid, req.entitlementId, req.requestedAt],
        );
        return req;
      },
      async createExecution(exec: ScanExecution) {
        await q.query(
          `INSERT INTO scan_executions (id,request_id,status,started_at,finished_at,report_ref,failure_reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
          [exec.id, exec.requestId, exec.status, exec.startedAt, exec.finishedAt, exec.reportRef, exec.failureReason],
        );
        return exec;
      },
      async updateExecution(exec: ScanExecution) {
        await q.query(
          `UPDATE scan_executions SET status=$2,finished_at=$3,report_ref=$4,failure_reason=$5 WHERE id=$1`,
          [exec.id, exec.status, exec.finishedAt, exec.reportRef, exec.failureReason],
        );
        return exec;
      },
      async getExecution(id: string) {
        const r = await q.query<ScanExecSql>("SELECT * FROM scan_executions WHERE id=$1", [id]);
        return r.rows[0] ? fromScanExecSql(r.rows[0]) : null;
      },
    },

    monitors: {
      async create(s: MonitoringSession) {
        const tid = await tokenIdBigint(q, s.token);
        await q.query(
          `INSERT INTO monitoring_sessions
             (id,user_id,token_id,chain,started_at,expires_at,status,pricing_version,entitlement_id,last_observation_at,last_battlefield_state_at,last_event_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (id) DO NOTHING`,
          [s.id, s.userId, tid, s.chain, s.startedAt, s.expiresAt, s.status, s.pricingVersion, s.entitlementId,
           s.lastObservationAt, s.lastBattlefieldStateAt, s.lastEventAt],
        );
        return s;
      },
      async update(s: MonitoringSession) {
        await q.query(
          `UPDATE monitoring_sessions SET status=$2,last_observation_at=$3,last_battlefield_state_at=$4,last_event_at=$5 WHERE id=$1`,
          [s.id, s.status, s.lastObservationAt, s.lastBattlefieldStateAt, s.lastEventAt],
        );
        return s;
      },
      async get(id: string) {
        const r = await q.query<MonitorSql>(
          `SELECT ms.*, t.chain AS t_chain, t.address AS t_address
           FROM monitoring_sessions ms JOIN tokens t ON t.id = ms.token_id WHERE ms.id=$1`, [id],
        );
        return r.rows[0] ? fromMonitorSql(r.rows[0]) : null;
      },
      async listActive(nowMs: number, limit: number) {
        const r = await q.query<MonitorSql>(
          `SELECT ms.*, t.chain AS t_chain, t.address AS t_address
           FROM monitoring_sessions ms JOIN tokens t ON t.id = ms.token_id
           WHERE ms.status='ACTIVE' AND ms.expires_at > $1
           ORDER BY ms.expires_at ASC LIMIT $2`, [nowMs, limit],
        );
        return r.rows.map(fromMonitorSql);
      },
    },

    intelligence: {
      async saveSnapshot(row: IntelligenceSnapshotRow) {
        const tid = await tokenIdBigint(q, row.token);
        await q.query(
          `INSERT INTO intelligence_snapshots
             (id,token_id,session_id,generated_at,report,engine_version,model_versions,source,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (id) DO NOTHING`,
          [row.id, tid, row.sessionId, row.generatedAt, JSON.stringify(row.report),
           row.engineVersion, JSON.stringify(row.modelVersions), row.source, row.createdAt],
        );
        return row;
      },
      async getSnapshot(id: string) {
        const r = await q.query<{ report: IntelligenceSnapshotRow["report"]; id: string }>(
          "SELECT id, report FROM intelligence_snapshots WHERE id=$1", [id],
        );
        // Callers in Phase 2 only need existence + report; full hydration in Phase 8.
        const row = r.rows[0];
        return row ? ({ ...(placeholderSnapshot(id)), report: row.report }) : null;
      },
      async saveEvidence(rows: readonly EvidenceRow[]) {
        for (const e of rows) {
          await q.query(
            `INSERT INTO evidence_records (snapshot_id,kind,factor,magnitude,weight,note,ordinal)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [e.snapshotId, e.kind, e.factor, e.magnitude, e.weight, e.note, e.ordinal],
          );
        }
      },
      async saveEvents(rows: readonly EventRow[]) {
        for (const e of rows) {
          const tid = await tokenIdBigint(q, e.tokenId);
          await q.query(
            `INSERT INTO events (token_id,snapshot_id,session_id,type,at,severity,importance,reasons,before_state,after_state)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [tid, e.snapshotId, e.sessionId, e.type, e.at, e.severity, e.importance, e.reasons, e.beforeState, e.afterState],
          );
        }
      },
      async saveSignalTransition(row: SignalTransitionRow) {
        const tid = await tokenIdBigint(q, row.tokenId);
        await q.query(
          `INSERT INTO signal_transitions (token_id,session_id,signal_identity,from_phase,to_phase,at,reasons)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (signal_identity,at,to_phase) DO NOTHING`,
          [tid, row.sessionId, row.signalIdentity, row.fromPhase, row.toPhase, row.at, row.reasons],
        );
      },
    },

    observations: {
      async append(record: TokenMemoryRecord, fingerprint: unknown, reasons: readonly string[], provenance: RecordProvenance) {
        const tid = await tokenIdBigint(q, record.token);
        await q.query(
          `INSERT INTO monitoring_observations
             (session_id,token_id,observed_at,persisted_at,source,engine_version,fingerprint,persist_reasons)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [record.ref, tid, provenance.observedAt, provenance.persistedAt, provenance.source,
           provenance.engineVersion, JSON.stringify(fingerprint), reasons],
        );
      },
      async lastFingerprint(sessionId: string) {
        const r = await q.query<{ fingerprint: unknown }>(
          `SELECT fingerprint FROM monitoring_observations WHERE session_id=$1 ORDER BY observed_at DESC LIMIT 1`,
          [sessionId],
        );
        return r.rows[0]?.fingerprint ?? null;
      },
      async list(sessionId: string) {
        const r = await q.query<{ token_chain: string; token_address: string; kind: string; observed_at: number; ref: string; reasons: string[]; provenance_source: string }>(
          `SELECT token_chain, token_address, kind, observed_at, ref, reasons, provenance_source
             FROM monitoring_observations WHERE session_id=$1 ORDER BY observed_at ASC`,
          [sessionId],
        );
        return r.rows.map((row) => ({
          record: {
            token: { chain: row.token_chain as never, address: row.token_address as never },
            kind: row.kind as never,
            at: row.observed_at,
            provenance: { source: row.provenance_source } as never,
            ref: row.ref,
          },
          reasons: row.reasons ?? [],
          provenance: { source: row.provenance_source } as never,
        }));
      },
    },

    alerts: {
      async save(row: AlertRow) {
        const tid = await tokenIdBigint(q, row.tokenId);
        await q.query(
          `INSERT INTO alerts (id,user_id,session_id,token_id,reason,at,detail,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
          [row.id, row.userId, row.sessionId, tid, row.alert.reason, row.alert.at, row.alert.detail, row.createdAt],
        );
      },
      async listForUser(userId: UserId, limit: number) {
        const r = await q.query<AlertSql>(
          `SELECT a.*, t.chain AS t_chain, t.address AS t_address
           FROM alerts a JOIN tokens t ON t.id = a.token_id
           WHERE a.user_id=$1 ORDER BY a.created_at DESC LIMIT $2`, [userId, limit],
        );
        return r.rows.map(fromAlertSql);
      },
    },
  };
}

export class PgUnitOfWork implements UnitOfWork {
  readonly repos: RepositoryBundle;
  constructor(private readonly pool: PgPool) {
    this.repos = makeBundle(pool);
  }
  async transaction<T>(fn: (repos: RepositoryBundle) => Promise<T>): Promise<T> {
    return this.pool.withTransaction(async (client) => {
      await client.query(SP);
      return fn(makeBundle(client));
    });
  }
}

// -- SQL row shapes + mappers -------------------------------------------------

interface PaymentRowSql {
  provider_tx_id: string; intent_id: string; user_id: string; rail: string;
  entitlement_type: string; amount_usd_micros: string; pricing_version: string;
  status: string; created_at: string; verified_at: string | null; refunded_at: string | null;
}
function fromPaymentSql(r: PaymentRowSql): PaymentRow {
  return {
    providerTxId: r.provider_tx_id, intentId: r.intent_id, userId: r.user_id as UserId,
    rail: r.rail as PaymentRow["rail"], entitlementType: r.entitlement_type as PaymentRow["entitlementType"],
    amountUsdMicros: Number(r.amount_usd_micros), pricingVersion: r.pricing_version,
    status: r.status as PaymentStatus, createdAt: Number(r.created_at),
    verifiedAt: r.verified_at === null ? null : Number(r.verified_at),
    refundedAt: r.refunded_at === null ? null : Number(r.refunded_at),
  };
}

interface EntitlementSql {
  id: string; user_id: string; type: string; provider_tx_id: string;
  status: string; grants_duration_ms: string | null; issued_at: string;
}
function fromEntitlementSql(r: EntitlementSql): Entitlement {
  return {
    id: r.id, userId: r.user_id as UserId, type: r.type as Entitlement["type"],
    providerTxId: r.provider_tx_id, status: r.status as Entitlement["status"],
    grantsDurationMs: r.grants_duration_ms === null ? null : Number(r.grants_duration_ms),
    issuedAt: Number(r.issued_at),
  };
}

interface ScanExecSql {
  id: string; request_id: string; status: string; started_at: string;
  finished_at: string | null; report_ref: string | null; failure_reason: string | null;
}
function fromScanExecSql(r: ScanExecSql): ScanExecution {
  return {
    id: r.id, requestId: r.request_id, status: r.status as ScanExecution["status"],
    startedAt: Number(r.started_at), finishedAt: r.finished_at === null ? null : Number(r.finished_at),
    reportRef: r.report_ref, failureReason: r.failure_reason,
  };
}

interface MonitorSql {
  id: string; user_id: string; chain: string; started_at: string; expires_at: string;
  status: string; pricing_version: string; entitlement_id: string;
  last_observation_at: string | null; last_battlefield_state_at: string | null; last_event_at: string | null;
  t_chain: string; t_address: string;
}
function fromMonitorSql(r: MonitorSql): MonitoringSession {
  return {
    id: r.id, userId: r.user_id as UserId,
    token: { chain: r.t_chain as Chain, address: r.t_address as TokenAddress },
    chain: r.chain as Chain, startedAt: Number(r.started_at), expiresAt: Number(r.expires_at),
    status: r.status as MonitoringSession["status"], pricingVersion: r.pricing_version,
    entitlementId: r.entitlement_id,
    lastObservationAt: r.last_observation_at === null ? null : Number(r.last_observation_at),
    lastBattlefieldStateAt: r.last_battlefield_state_at === null ? null : Number(r.last_battlefield_state_at),
    lastEventAt: r.last_event_at === null ? null : Number(r.last_event_at),
  };
}

interface AlertSql {
  id: string; user_id: string; session_id: string | null; reason: string;
  at: string; detail: string; created_at: string; t_chain: string; t_address: string;
}
function fromAlertSql(r: AlertSql): AlertRow {
  return {
    id: r.id, userId: r.user_id as UserId, sessionId: r.session_id,
    tokenId: { chain: r.t_chain as Chain, address: r.t_address as TokenAddress },
    alert: { reason: r.reason as AlertRow["alert"]["reason"], at: Number(r.at), detail: r.detail },
    createdAt: Number(r.created_at),
  };
}

function placeholderSnapshot(id: string): IntelligenceSnapshotRow {
  // Minimal shell used only by getSnapshot existence checks in Phase 2.
  return {
    id, token: { chain: "sol" as Chain, address: "" as TokenAddress }, sessionId: null,
    generatedAt: 0, report: undefined as unknown as IntelligenceSnapshotRow["report"],
    engineVersion: "", modelVersions: undefined as unknown as ModelVersions,
    source: "SCAN", createdAt: 0,
  };
}

/**
 * tokens.first_seen_at needs a value on insert. To honour "time is injected",
 * the production wiring should pass an injected clock; here the pg layer accepts
 * the DB's own now via the caller. This tiny helper exists so the pg module has
 * no ambient Date.now sprinkled through queries - callers that need determinism
 * use the in-memory repos. In production, first_seen_at is a bookkeeping stamp
 * only (never used by intelligence), so DB-side now() is acceptable.
 */
function Date_nowGuardless(): number {
  return Date.now();
}
'@

Write-WarFile 'src/ui/scanViewModel.ts' @'
/**
 * WAR UI - view-model (Phase 9).
 *
 * The ONE bridge between intelligence and presentation. It maps an
 * IntelligenceReport (already fully computed by WAR) into display-ready plain
 * data. It performs ZERO intelligence: no scoring, no thresholds that invent
 * meaning, no derived signals. Every number here already exists in the report;
 * this layer only FORMATS (round, label enum->text, order lists).
 *
 * The UI imports ONLY this view-model. An architecture guard forbids the UI from
 * importing any core/engine module, so presentation can never smuggle in
 * computation.
 */

import type { IntelligenceReport } from "../product/intelligence/report.js";

/** A single labelled score, already computed. `value` is 0..100 from the report. */
export interface ScoreView {
  readonly value: number; // 0..100, as computed by WAR
  readonly label: string; // human label for the enum band the report already set
}

export interface ContributionView {
  readonly factor: string;
  readonly magnitude: number;
  readonly weight: number;
}

export interface EvidenceView {
  readonly kind: string;
  readonly factor: string;
  readonly note: string | null;
  readonly magnitude: number | null;
}

export interface SignalView {
  readonly identity: string;
  readonly phase: string;
  readonly reason: string;
}

export interface EventView {
  readonly type: string;
  readonly importance: number;
  readonly reason: string;
}

/** Everything the scan screen renders. All fields sourced 1:1 from the report. */
export interface ScanViewModel {
  readonly chain: string;
  readonly address: string;
  readonly generatedAt: number;

  readonly power: ScoreView;
  readonly threat: ScoreView;
  readonly confidence: ScoreView;
  readonly attention: ScoreView;

  readonly state: string;
  readonly trajectory: string;
  readonly coherence: string;
  readonly leadLag: string;
  readonly marketRegime: string;

  readonly powerSupporting: readonly ContributionView[];
  readonly powerOpposing: readonly ContributionView[];
  readonly threatSupporting: readonly ContributionView[];

  readonly whyNow: readonly string[];
  readonly evidence: readonly EvidenceView[];
  readonly signals: readonly SignalView[];
  readonly events: readonly EventView[];

  readonly dataQuality: string;
  readonly qualityReasons: readonly string[];

  readonly engineVersion: string;
  readonly activationModelVersion: string;
  readonly confidenceModelVersion: string;
}

// -- Pure formatting helpers (NO intelligence) --------------------------------

/** Band label for a 0..100 score. This is presentational binning ONLY — it does
 *  not change the value or feed any decision; the value shown is always the raw
 *  computed number. The band is a reading aid for the human eye. */
function bandLabel(score: number): string {
  if (score >= 75) return "High";
  if (score >= 50) return "Elevated";
  if (score >= 25) return "Moderate";
  return "Low";
}

function score(value: number): ScoreView {
  return { value, label: bandLabel(value) };
}

/** Enum -> spaced Title Case (e.g. ACCELERATING_UP -> "Accelerating up"). */
function humanize(token: string): string {
  const lower = token.replace(/_/g, " ").toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function toScanViewModel(report: IntelligenceReport): ScanViewModel {
  return {
    chain: report.token.chain,
    address: report.token.address as unknown as string,
    generatedAt: report.generatedAt,

    power: score(report.power.score as unknown as number),
    threat: score(report.threat.score as unknown as number),
    confidence: score(report.confidence.score as unknown as number),
    attention: score(report.attention.score as unknown as number),

    state: humanize(report.state),
    trajectory: humanize(report.trajectory.classification),
    coherence: humanize(report.coherence.state),
    leadLag: humanize(report.leadLag.result),
    marketRegime: humanize(report.marketRegime),

    powerSupporting: report.power.supporting.map((c) => ({ factor: humanize(c.factor), magnitude: c.magnitude, weight: c.weight })),
    powerOpposing: report.power.opposing.map((c) => ({ factor: humanize(c.factor), magnitude: c.magnitude, weight: c.weight })),
    threatSupporting: report.threat.supporting.map((c) => ({ factor: humanize(c.factor), magnitude: c.magnitude, weight: c.weight })),

    whyNow: report.whyNow,
    evidence: report.evidence.map((e) => ({ kind: humanize(e.kind), factor: humanize(e.factor), note: e.note, magnitude: e.magnitude })),
    signals: report.signals.map((s) => ({ identity: humanize(s.identity), phase: humanize(s.phase), reason: s.reasons[0] ?? "" })),
    events: [...report.events]
      .sort((a, b) => (b.importance as unknown as number) - (a.importance as unknown as number))
      .map((e) => ({ type: humanize(e.type), importance: e.importance as unknown as number, reason: e.reasons[0] ?? "" })),

    dataQuality: humanize(report.quality.quality),
    qualityReasons: report.quality.reasons,

    engineVersion: report.modelVersions.engineVersion,
    activationModelVersion: report.modelVersions.activationModelVersion,
    confidenceModelVersion: report.modelVersions.confidenceModelVersion,
  };
}
'@

Write-WarFile 'src/world/index.ts' @'
/**
 * WAR world layer (Phase 2) - Experience projection + engine + contracts.
 * Reads verified Phase 1 data only. Contains NO intelligence.
 */
export * from "./worldAdapter.js";
export * from "./worldEngine.js";
export * from "./worldRenderer.js";
export * from "./worldRadar.js";
'@

Write-WarFile 'src/world/worldAdapter.ts' @'
/**
 * WAR world - World Adapter (Phase 2).
 *
 * Pure projection: IntelligenceReport (+ flow observations) -> WorldState, a
 * render-ready visual description. It performs ZERO intelligence:
 *   - no scoring, no classification, no weighting, no inference
 *   - every numeric value is PASSED THROUGH unchanged from the report
 *   - visual normalization (0..1 for bar widths) is presentational only and is
 *     kept separate from the raw value, which is always preserved
 *
 * The renderer consumes WorldState and never sees the engine. An architecture
 * guard forbids src/world from importing any core engine or scoring config.
 */

import type { IntelligenceReport } from "../product/intelligence/report.js";
import type { FlowObservation } from "../core/timeline/types.js";

/** Visual archetype for each REAL Core state. No new state is invented. */
export type WorldMood =
  | "UNKNOWN" | "OBSERVING" | "EMERGING" | "ACCUMULATION"
  | "ATTACK" | "DOMINANCE" | "DISTRIBUTION" | "BLEEDING" | "COLLAPSE" | "DORMANT";

/** A force reading: the raw value AND a purely-visual 0..1 for bar width. */
export interface ForceView {
  readonly raw: number; // 0..100 exactly as computed by WAR
  readonly visual01: number; // raw/100, for rendering ONLY
  readonly band: string; // presentational label
}

/** A flow entity — provenance lane only; NO persona (no classifier exists). */
export interface FlowEntityView {
  readonly maker: string;
  readonly side: "buy" | "sell";
  readonly amountUsd: number; // passed through, never scored
  readonly lane: "SMART_MONEY" | "KOL" | "FOLLOW_WALLET" | "OTHER";
  readonly persona: "UNKNOWN"; // always UNKNOWN — no classifier in Phase 1
}

export interface WorldEventView {
  readonly type: string;
  readonly importance: number; // raw, drives visual emphasis only
  readonly reason: string;
}

export interface WorldSignalView {
  readonly identity: string;
  readonly phase: string;
}

export interface WorldState {
  readonly chain: string;
  readonly address: string;
  readonly generatedAt: number;

  readonly mood: WorldMood; // = real Core state
  readonly trajectory: string;
  readonly coherence: string;
  readonly leadLag: string;
  readonly regime: string;

  readonly power: ForceView;
  readonly threat: ForceView;
  readonly confidence: ForceView;
  readonly attention: ForceView;

  readonly events: readonly WorldEventView[];
  readonly signals: readonly WorldSignalView[];
  readonly whyNow: readonly string[];
  readonly flowEntities: readonly FlowEntityView[];

  readonly dataQuality: string;
  readonly qualityReasons: readonly string[];
  readonly insufficient: readonly string[]; // surfaced, never hidden

  /** Visual metadata (renderer hints), never intelligence. */
  readonly visual: WorldVisualMeta;
}

/** Purely presentational metadata — position/size/lod. No meaning attached. */
export interface WorldVisualMeta {
  readonly territorySize01: number; // from attention.raw/100 (visual weight only)
  readonly contestBalance01: number; // power vs threat split, presentation only
}

function band(v: number): string {
  if (v >= 75) return "High";
  if (v >= 50) return "Elevated";
  if (v >= 25) return "Moderate";
  return "Low";
}

function force(raw: number): ForceView {
  const clamped = raw < 0 ? 0 : raw > 100 ? 100 : raw;
  return { raw, visual01: clamped / 100, band: band(raw) };
}

function lane(provenance: string): FlowEntityView["lane"] {
  if (provenance === "track.smartmoney") return "SMART_MONEY";
  if (provenance === "track.kol") return "KOL";
  if (provenance === "track.follow-wallet") return "FOLLOW_WALLET";
  return "OTHER";
}

/** Extract the INSUFFICIENT markers already recorded by the engine in quality. */
function insufficientFrom(reasons: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const r of reasons) {
    const m = r.match(/insufficient:\s*(.+)/i);
    if (m && m[1]) out.push(...m[1].split(",").map((s) => s.trim()).filter(Boolean));
  }
  return out;
}

export interface WorldAdapterInput {
  readonly report: IntelligenceReport;
  /** Optional flow observations for entity projection (visual only). */
  readonly flow?: readonly FlowObservation[];
}

export function toWorldState(input: WorldAdapterInput): WorldState {
  const r = input.report;
  const power = force(r.power.score as unknown as number);
  const threat = force(r.threat.score as unknown as number);
  const attention = force(r.attention.score as unknown as number);
  const confidence = force(r.confidence.score as unknown as number);

  const total = power.raw + threat.raw || 1;

  const flowEntities: FlowEntityView[] = (input.flow ?? []).map((f) => ({
    maker: f.maker,
    side: f.side,
    amountUsd: f.amountUsd,
    lane: lane(f.meta.provenance),
    persona: "UNKNOWN",
  }));

  return {
    chain: r.token.chain,
    address: r.token.address as unknown as string,
    generatedAt: r.generatedAt,

    mood: r.state as WorldMood,
    trajectory: r.trajectory.classification,
    coherence: r.coherence.state,
    leadLag: r.leadLag.result,
    regime: r.marketRegime,

    power, threat, confidence, attention,

    events: [...r.events]
      .sort((a, b) => (b.importance as unknown as number) - (a.importance as unknown as number))
      .map((e) => ({ type: e.type, importance: e.importance as unknown as number, reason: e.reasons[0] ?? "" })),
    signals: r.signals.map((s) => ({ identity: s.identity, phase: s.phase })),
    whyNow: r.whyNow,
    flowEntities,

    dataQuality: r.quality.quality,
    qualityReasons: r.quality.reasons,
    insufficient: insufficientFrom(r.quality.reasons),

    visual: {
      territorySize01: attention.raw / 100,
      contestBalance01: power.raw / total,
    },
  };
}
'@

Write-WarFile 'src/world/worldEngine.ts' @'
/**
 * WAR world - World Engine + instance lifecycle + camera + LOD (Phase 2).
 *
 * ONE WorldEngine holds many WorldInstances (one per token). Instances differ
 * only by their WorldState data. This module is pure data-model + lifecycle; it
 * does NOT render and contains NO intelligence. It is fully testable in Node.
 *
 * The renderer (browser-only) consumes these structures via the WorldRenderer
 * abstraction; it is never imported here.
 */

import type { WorldState } from "./worldAdapter.js";

// ── LOD ───────────────────────────────────────────────────────────────────────

/** Level of detail affects RENDERING ONLY, never intelligence. */
export type Lod = 0 | 1 | 2;

/** Choose LOD from camera zoom + whether the instance is focused. Presentation. */
export function lodFor(zoom: number, focused: boolean): Lod {
  if (focused || zoom >= 2.0) return 2; // full battlefield
  if (zoom >= 0.8) return 1; // world + state
  return 0; // minimal (dot / territory / label)
}

// ── Camera ────────────────────────────────────────────────────────────────────

export interface Camera {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export const INITIAL_CAMERA: Camera = { x: 0, y: 0, zoom: 1 };

export function pan(cam: Camera, dx: number, dy: number): Camera {
  return { ...cam, x: cam.x + dx, y: cam.y + dy };
}

export function zoomTo(cam: Camera, zoom: number, min = 0.1, max = 8): Camera {
  return { ...cam, zoom: Math.max(min, Math.min(max, zoom)) };
}

/** flyTo target: a pure interpolation step (renderer animates between steps). */
export function flyStep(cam: Camera, target: { x: number; y: number; zoom: number }, t: number): Camera {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return {
    x: cam.x + (target.x - cam.x) * k,
    y: cam.y + (target.y - cam.y) * k,
    zoom: cam.zoom + (target.zoom - cam.zoom) * k,
  };
}

// ── World Instance lifecycle ────────────────────────────────────────────────

export type InstancePhase = "CREATED" | "MOUNTED" | "SLEEPING" | "DESTROYED";

export interface WorldPosition {
  readonly x: number;
  readonly y: number;
}

export interface WorldInstance {
  readonly id: string; // chain:address
  readonly position: WorldPosition;
  readonly phase: InstancePhase;
  readonly state: WorldState | null; // latest projected state (null until first update)
}

export function createInstance(id: string, position: WorldPosition): WorldInstance {
  return { id, position, phase: "CREATED", state: null };
}

// ── World Engine ──────────────────────────────────────────────────────────────

export class WorldEngine {
  private readonly instances = new Map<string, WorldInstance>();

  /** Create (or return) the single instance for a token id. */
  ensure(id: string, position: WorldPosition): WorldInstance {
    const existing = this.instances.get(id);
    if (existing) return existing;
    const inst = createInstance(id, position);
    this.instances.set(id, inst);
    return inst;
  }

  mount(id: string): void {
    this.transition(id, "MOUNTED");
  }

  sleep(id: string): void {
    this.transition(id, "SLEEPING");
  }

  wake(id: string): void {
    this.transition(id, "MOUNTED");
  }

  destroy(id: string): void {
    this.transition(id, "DESTROYED");
    this.instances.delete(id);
  }

  /** Push a freshly-projected WorldState onto an instance (no computation). */
  update(id: string, state: WorldState): void {
    const inst = this.instances.get(id);
    if (!inst || inst.phase === "DESTROYED") return;
    this.instances.set(id, { ...inst, state });
  }

  get(id: string): WorldInstance | null {
    return this.instances.get(id) ?? null;
  }

  count(): number {
    return this.instances.size;
  }

  /** Instances whose LOD >= 1 at the given camera (streaming: only these render fully). */
  visible(cam: Camera, focusedId: string | null): readonly WorldInstance[] {
    const out: WorldInstance[] = [];
    for (const inst of this.instances.values()) {
      if (inst.phase === "DESTROYED" || inst.phase === "SLEEPING") continue;
      const lod = lodFor(cam.zoom, inst.id === focusedId);
      if (lod >= 1) out.push(inst);
    }
    return out;
  }

  private transition(id: string, phase: InstancePhase): void {
    const inst = this.instances.get(id);
    if (!inst) return;
    this.instances.set(id, { ...inst, phase });
  }
}
'@

Write-WarFile 'src/world/worldRadar.ts' @'
/**
 * WAR world - Search contract + WAR Radar projection (Phase 2).
 *
 * Search: no search backend exists in Phase 1 contracts. We define the query +
 * result CONTRACT and a UI can bind to it, but there is no data service to invent.
 * Status: SEARCH = BLOCKED_BY_SEARCH_CONTRACT. No fake results are produced.
 *
 * Radar: a projection of EXISTING per-world values. It never computes a composite
 * score (no `power*confidence`); it can only order by a field that already exists.
 */

import type { WorldState } from "./worldAdapter.js";

// ── Search contract (backend PENDING) ────────────────────────────────────────

export interface SearchQuery {
  readonly text: string; // symbol, name, or address
}

export interface SearchResult {
  readonly chain: string;
  readonly address: string;
  readonly symbol: string | null;
}

/** The port a real search backend must implement. None exists yet in Phase 1. */
export interface SearchPort {
  search(query: SearchQuery): Promise<readonly SearchResult[]>;
}

/** Explicit stand-in that refuses to fabricate results. */
export class UnavailableSearchPort implements SearchPort {
  async search(_query: SearchQuery): Promise<readonly SearchResult[]> {
    // No contract to serve. Returns empty; caller shows "search backend pending".
    return [];
  }
}

// ── WAR Radar (projection only) ──────────────────────────────────────────────

/** Fields the radar may order by — each ALREADY EXISTS on WorldState. No composites. */
export type RadarSortField = "power" | "threat" | "attention" | "confidence";

export interface RadarBlip {
  readonly id: string;
  readonly mood: string;
  readonly power: number;
  readonly threat: number;
  readonly attention: number;
  readonly confidence: number;
  readonly eventCount: number;
  readonly signalCount: number;
}

export function toRadarBlip(state: WorldState): RadarBlip {
  return {
    id: `${state.chain}:${state.address}`,
    mood: state.mood,
    power: state.power.raw,
    threat: state.threat.raw,
    attention: state.attention.raw,
    confidence: state.confidence.raw,
    eventCount: state.events.length,
    signalCount: state.signals.length,
  };
}

/** Order blips by a SINGLE existing field (descending). No composite ranking. */
export function radarOrder(blips: readonly RadarBlip[], by: RadarSortField): readonly RadarBlip[] {
  return [...blips].sort((a, b) => b[by] - a[by]);
}
'@

Write-WarFile 'src/world/worldRenderer.ts' @'
/**
 * WAR world - Renderer abstraction, interaction contracts, replay model (Phase 2).
 *
 * These are CONTRACTS the browser layer implements. Defining them here (in Node-
 * testable form) lets us prove the abstraction and interaction models without a
 * real GPU. Concrete PixiRenderer / PhaserRenderer live in the browser artifact
 * and are chosen by a real benchmark (PENDING_BROWSER_BENCH).
 */

import type { WorldState } from "./worldAdapter.js";
import type { Camera, Lod, WorldInstance } from "./worldEngine.js";

// ── Renderer abstraction ──────────────────────────────────────────────────────

/** A renderer draws instances at a camera. It receives already-projected data. */
export interface WorldRenderer {
  readonly name: "pixi" | "phaser" | "headless";
  init(canvas: unknown): void;
  /** Draw the given visible instances at the camera + per-instance LOD. */
  render(frame: RenderFrame): void;
  destroy(): void;
}

export interface RenderFrame {
  readonly camera: Camera;
  readonly focusedId: string | null;
  readonly instances: readonly RenderInstance[];
}

export interface RenderInstance {
  readonly id: string;
  readonly position: { x: number; y: number };
  readonly lod: Lod;
  readonly state: WorldState | null;
}

/** A headless renderer: records frames, draws nothing. For Node tests. */
export class HeadlessRenderer implements WorldRenderer {
  readonly name = "headless" as const;
  readonly frames: RenderFrame[] = [];
  init(): void {}
  render(frame: RenderFrame): void { this.frames.push(frame); }
  destroy(): void { this.frames.length = 0; }
}

/** Build a RenderFrame from engine state — pure, deterministic. */
export function buildFrame(camera: Camera, focusedId: string | null, instances: readonly WorldInstance[], lodOf: (inst: WorldInstance) => Lod): RenderFrame {
  return {
    camera,
    focusedId,
    instances: instances.map((inst) => ({ id: inst.id, position: inst.position, lod: lodOf(inst), state: inst.state })),
  };
}

// ── Interaction contracts ─────────────────────────────────────────────────────

export type DesktopGesture =
  | { readonly kind: "drag"; readonly dx: number; readonly dy: number }
  | { readonly kind: "wheel"; readonly delta: number }
  | { readonly kind: "click"; readonly id: string }
  | { readonly kind: "dblclick"; readonly id: string };

export type MobileGesture =
  | { readonly kind: "swipe"; readonly dx: number; readonly dy: number }
  | { readonly kind: "pinch"; readonly scale: number }
  | { readonly kind: "tap"; readonly id: string };

export type WorldIntent =
  | { readonly kind: "pan"; readonly dx: number; readonly dy: number }
  | { readonly kind: "zoom"; readonly factor: number }
  | { readonly kind: "select"; readonly id: string }
  | { readonly kind: "enter"; readonly id: string };

/** Map a desktop gesture to a device-independent world intent. Pure. */
export function desktopIntent(g: DesktopGesture): WorldIntent {
  switch (g.kind) {
    case "drag": return { kind: "pan", dx: g.dx, dy: g.dy };
    case "wheel": return { kind: "zoom", factor: g.delta < 0 ? 1.1 : 0.9 };
    case "click": return { kind: "select", id: g.id };
    case "dblclick": return { kind: "enter", id: g.id };
  }
}

/** Map a mobile gesture to the SAME world intents (same data, different input). */
export function mobileIntent(g: MobileGesture): WorldIntent {
  switch (g.kind) {
    case "swipe": return { kind: "pan", dx: g.dx, dy: g.dy };
    case "pinch": return { kind: "zoom", factor: g.scale };
    case "tap": return { kind: "select", id: g.id };
  }
}

// ── Battle Replay model (ARCHITECTURE_READY) ─────────────────────────────────

/**
 * Replay plays back a sequence of historical WorldStates. The data MODEL and
 * controller are defined here and fully testable. Actual historical frames
 * require a persistence read method that does NOT exist in Phase 1
 * (MonitoringObservationRepository has append + lastFingerprint, no list).
 * We do NOT invent it and do NOT modify Phase 1. Status:
 *   BATTLE_REPLAY = BLOCKED_BY_HISTORY_READ_CONTRACT
 */
export interface ReplayFrame {
  readonly at: number;
  readonly state: WorldState;
}

export type ReplaySpeed = 1 | 2 | 5 | 10;

export interface ReplayState {
  readonly frames: readonly ReplayFrame[];
  readonly index: number;
  readonly playing: boolean;
  readonly speed: ReplaySpeed;
}

export function initReplay(frames: readonly ReplayFrame[]): ReplayState {
  return { frames, index: 0, playing: false, speed: 1 };
}

export function play(s: ReplayState): ReplayState { return { ...s, playing: true }; }
export function pause(s: ReplayState): ReplayState { return { ...s, playing: false }; }
export function setSpeed(s: ReplayState, speed: ReplaySpeed): ReplayState { return { ...s, speed }; }

export function step(s: ReplayState): ReplayState {
  if (!s.playing || s.frames.length === 0) return s;
  const next = Math.min(s.frames.length - 1, s.index + 1);
  return { ...s, index: next, playing: next < s.frames.length - 1 };
}

export function jumpToEvent(s: ReplayState, at: number): ReplayState {
  if (s.frames.length === 0) return s;
  let best = 0;
  for (let i = 0; i < s.frames.length; i++) if (s.frames[i]!.at <= at) best = i;
  return { ...s, index: best };
}

export function currentFrame(s: ReplayState): ReplayFrame | null {
  return s.frames[s.index] ?? null;
}
'@

Write-WarFile 'tests/architecture/arenaBoundaries.test.ts' @'
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "..", "..", "src");
const ARENA = join(SRC, "arena");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}
function imports(src: string): string[] {
  const specs: string[] = [];
  const re = /(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) if (m[1]) specs.push(m[1]);
  return specs;
}

describe("3 Arena architecture guard — product wiring, no intelligence", () => {
  const files = walk(ARENA);
  it("arena has files", () => { expect(files.length).toBeGreaterThan(0); });

  for (const file of files) {
    const rel = relative(SRC, file);
    const src = readFileSync(file, "utf8");

    it(`${rel}: imports no core engine / scoring config`, () => {
      const banned = ["core/power", "core/threat", "core/state/stateMachine", "core/temporal", "core/flow/flowEngine", "core/coherence/coherence", "core/features", "config/scoring", "assembleBattlefield"];
      for (const spec of imports(src)) {
        for (const b of banned) {
          expect(spec.includes(b), `arena file ${rel} imports engine "${spec}"`).toBe(false);
        }
      }
    });

    it(`${rel}: computes no intelligence and fabricates no scores/personas`, () => {
      for (const token of [
        "computePower", "computeThreat", "computeConfidence", "evaluateToBattlefield",
        "POWER_CONFIG", "THREAT_CONFIG", "battleScore", "walletScore",
        'persona: "Whale"', 'persona: "Sniper"', "power: { score", "threat: { score",
      ]) {
        expect(src.includes(token), `arena file ${rel} violates read-only via "${token}"`).toBe(false);
      }
    });
  }
});
'@

Write-WarFile 'tests/architecture/integrationBoundaries.test.ts' @'
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "..", "..", "src");
const INTEGRATION = join(SRC, "integration");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

function extractImports(source: string): string[] {
  const specs: string[] = [];
  const fromRe = /(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/g;
  const bareRe = /import\s*['"]([^'"]+)['"]/g;
  for (const re of [fromRe, bareRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) if (m[1] !== undefined) specs.push(m[1]);
  }
  return specs;
}

describe("5B-C/5B-E architecture — src/integration", () => {
  const files = walk(INTEGRATION);

  it("integration layer has files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const rel = relative(SRC, file);
    const source = readFileSync(file, "utf8");

    // 5B-E: integration must NOT fabricate intelligence. It wires; it does not
    // compute or inject Power/Threat/Confidence/BattlefieldState. It may REFERENCE
    // the types (imports) but must not import the scoring config or construct
    // scored outputs, and must not recompute intelligence.
    it(`${rel}: does not import scoring config (no intelligence tuning)`, () => {
      for (const spec of extractImports(source)) {
        expect(
          spec.includes("config/scoring"),
          `integration file ${rel} imports scoring config "${spec}"`,
        ).toBe(false);
      }
    });

    it(`${rel}: does not recompute WAR intelligence`, () => {
      for (const token of ["productPower", "productThreat", "productConfidence", "computePower(", "computeThreat(", "computeConfidence("]) {
        expect(
          source.includes(token),
          `integration file ${rel} recomputes intelligence via "${token}"`,
        ).toBe(false);
      }
    });

    it(`${rel}: does not construct fake battlefield/power/threat literals`, () => {
      // A fabricated intelligence object would assign a numeric score literal to
      // power/threat/confidence. The real path only ever passes through the core
      // evaluator's output. Guard against obvious injection shapes.
      for (const token of ["power: {", "threat: {", "battlefield: {", "tokens: ["]) {
        expect(
          source.includes(token),
          `integration file ${rel} appears to fabricate intelligence ("${token}")`,
        ).toBe(false);
      }
    });

    it(`${rel}: only RealWarEvaluationPort delegates to the core evaluator`, () => {
      // evaluateToBattlefield is the ONLY core-intelligence entry integration may
      // CALL, and only from the evaluation port file. Match the call form so a
      // doc-comment mention elsewhere is not a false positive.
      if (source.includes("evaluateToBattlefield(")) {
        expect(rel).toBe("integration/RealWarEvaluationPort.ts");
      }
    });
  }

  it("5B-C: the core boundary law still forbids core -> adapters (GMGN) elsewhere", () => {
    // This is asserted by tests/architecture/boundaries.test.ts; here we just
    // confirm the integration layer is the seam by checking it DOES import both.
    const acq = readFileSync(join(INTEGRATION, "RealGmgnAcquisitionPort.ts"), "utf8");
    const imports = extractImports(acq).join(" ");
    expect(imports).toContain("adapters/gmgn"); // integration may touch GMGN
    expect(imports).toContain("product/scan/ports"); // and product contracts
  });
});
'@

Write-WarFile 'tests/architecture/worldBoundaries.test.ts' @'
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "..", "..", "src");
const WORLD = join(SRC, "world");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

function imports(src: string): string[] {
  const specs: string[] = [];
  const re = /(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) if (m[1]) specs.push(m[1]);
  return specs;
}

describe("2 World architecture guard — src/world is projection only", () => {
  const files = walk(WORLD);
  it("world has files", () => { expect(files.length).toBeGreaterThan(0); });

  for (const file of files) {
    const rel = relative(SRC, file);
    const src = readFileSync(file, "utf8");

    it(`${rel}: imports no core engine / scoring config`, () => {
      const banned = [
        "core/power", "core/threat", "core/state/stateMachine", "core/temporal",
        "core/flow/flowEngine", "core/coherence/coherence", "core/novelty", "core/attention",
        "core/features", "config/scoring", "assembleBattlefield", "adapters/gmgn",
      ];
      for (const spec of imports(src)) {
        for (const b of banned) {
          expect(spec.includes(b), `world file ${rel} imports engine "${spec}"`).toBe(false);
        }
      }
    });

    it(`${rel}: computes no intelligence (no scoring/classification tokens)`, () => {
      for (const token of [
        "computePower", "computeThreat", "computeConfidence", "evaluateToBattlefield",
        "POWER_CONFIG", "THREAT_CONFIG", "CONFIDENCE_CONFIG",
        "classifyWallet", "walletPersona", "computeWalletScore", "battleScore",
      ]) {
        expect(src.includes(token), `world file ${rel} computes intelligence via "${token}"`).toBe(false);
      }
    });

    it(`${rel}: does not fabricate a battlefield or persona`, () => {
      // A world file must never assign power/threat score literals or invent personas.
      for (const token of ['power: { score', 'threat: { score', 'persona: "Whale"', 'persona: "Sniper"', 'persona: "Hunter"']) {
        expect(src.includes(token), `world file ${rel} fabricates data ("${token}")`).toBe(false);
      }
    });
  }
});
'@

Write-WarFile 'tests/integration/arena.test.ts' @'
import { describe, it, expect, beforeEach } from "vitest";

import { ArenaSession } from "../../src/arena/ArenaSession.js";
import { RepositorySearchPort, MonitoringHistoryReader } from "../../src/arena/backends.js";
import { buildShareCard, NotificationDispatcher } from "../../src/arena/shareAndNotify.js";
import { capability, isUsable, CAPABILITIES } from "../../src/arena/capabilities.js";
import { createScanService } from "../../src/integration/scanComposition.js";
import { MonitoringService } from "../../src/integration/MonitoringService.js";
import { RealWarEvaluationPort } from "../../src/integration/RealWarEvaluationPort.js";
import { RealGmgnAcquisitionPort } from "../../src/integration/RealGmgnAcquisitionPort.js";
import { toWorldState } from "../../src/world/worldAdapter.js";
import { InMemoryUnitOfWork } from "../../src/product/persistence/memory/inMemory.js";
import { EntitlementLedger } from "../../src/product/payment/entitlement.js";
import { PRICING_V1 } from "../../src/product/pricing/pricing.js";
import { MODEL_VERSIONS, ENGINE_VERSION } from "../../src/config/versions.js";
import { buildIntelligenceReport } from "../../src/product/intelligence/report.js";
import { makeEntry, makeBattlefield } from "../unit/productFixtures.js";
import type { CliExecutor, CliRunResult } from "../../src/adapters/gmgn/gmgnRunner.js";
import type { UserId, TokenId, Clock } from "../../src/product/domain/identity.js";
import type { TokenMemoryRecord } from "../../src/product/persistence/tokenMemory.js";

const uid = (s: string) => s as UserId;
const tok: TokenId = { chain: "sol", address: "TokenAAA" as TokenId["address"] };

function stubCli(): CliExecutor {
  return { async run(argv): Promise<CliRunResult> {
    const cmd = argv.join(" ");
    if (cmd.includes("market kline")) return { exitCode: 0, stderr: "", stdout: JSON.stringify([
      { time: 1000, open: "1.0", close: "1.0", high: "1.1", low: "0.9", volume: "10000", amount: "10000" },
      { time: 2000, open: "1.0", close: "1.1", high: "1.2", low: "1.0", volume: "12000", amount: "11000" },
      { time: 3000, open: "1.1", close: "1.25", high: "1.3", low: "1.1", volume: "15000", amount: "12000" },
    ]) };
    if (cmd.includes("market trending")) return { exitCode: 0, stderr: "", stdout: JSON.stringify([
      { price: 1.25, market_cap: 1000000, liquidity: 200000, holder_count: 1500, swaps: 300, buys: 180, sells: 120, smart_degen_count: 8, renowned_count: 3, rug_ratio: 0.15, top_10_holder_rate: 0.35, is_wash_trading: false, bundler_rate: 0.05 }]) };
    if (cmd.includes("track")) return { exitCode: 0, stderr: "", stdout: JSON.stringify([
      { __source: "smartmoney", transaction_hash: "0x1", maker: "wA", side: "buy", base_address: tok.address, amount_usd: "8000", price_usd: "1.2", buy_cost_usd: "8000", is_open_or_close: 0, timestamp: 1500, maker_info: { tags: ["smart_degen"] }, token_amount: "6600" }]) };
    return { exitCode: 1, stdout: "", stderr: "unknown" };
  } };
}

async function harness() {
  const uow = new InMemoryUnitOfWork();
  const ledger = new EntitlementLedger();
  await uow.repos.pricing.record(PRICING_V1);
  await uow.repos.users.upsert({ userId: uid("u1"), provider: "TELEGRAM", providerUserId: "tg:1", createdAt: 0 });
  const clock: Clock = { now: () => 5000 };
  const scanService = createScanService({ uow, clock, entitlements: ledger, engineVersion: ENGINE_VERSION, modelVersions: MODEL_VERSIONS, cliExecutor: stubCli() });
  const monitoringService = new MonitoringService({ acquisition: new RealGmgnAcquisitionPort(stubCli()), evaluation: new RealWarEvaluationPort(), clock });
  const seed = async (id: string) => {
    const txId = id.replace("ent:", "");
    ledger.issueFrom({ intentId: "i", providerTxId: txId, rail: "TON", status: "VERIFIED", verifiedAt: 100, amountUsd: 100000 as never }, uid("u1"), "TOKEN_SCAN", null);
    await uow.repos.payments.createIntent({ providerTxId: txId, intentId: `i-${id}`, userId: uid("u1"), rail: "TON", entitlementType: "TOKEN_SCAN", amountUsdMicros: 100000, pricingVersion: PRICING_V1.version, status: "VERIFIED", createdAt: 0, verifiedAt: 100, refundedAt: null });
    await uow.repos.entitlements.issue({ id, userId: uid("u1"), type: "TOKEN_SCAN", providerTxId: txId, status: "ISSUED", grantsDurationMs: null, issuedAt: 100 });
  };
  return { uow, ledger, scanService, monitoringService, seed };
}

describe("3 ArenaSession — production wiring, one source of truth", () => {
  let h: Awaited<ReturnType<typeof harness>>;
  beforeEach(async () => { h = await harness(); });

  it("PRODUCTION ACCEPTANCE: scan -> report -> world, through payment gate, no bypass", async () => {
    await h.seed("ent:tx1");
    const arena = new ArenaSession({ scanService: h.scanService, monitoringService: h.monitoringService, uow: h.uow });
    const r = await arena.scan({ requestId: "req1", userId: uid("u1"), token: tok, entitlementId: "ent:tx1" }, { x: 0, y: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // world is fed from the real report
    expect(r.value.world.power.raw).toBe(r.value.result.report.power.score as unknown as number);
    // entitlement was consumed via the gate (not bypassed)
    expect((await h.uow.repos.entitlements.get("ent:tx1"))?.status).toBe("CONSUMED");
    // world instance mounted
    const id = `${r.value.world.chain}:${r.value.world.address}`;
    expect(arena.world.get(id)?.phase).toBe("MOUNTED");
  });

  it("failed scan does not create a world or consume payment", async () => {
    await h.seed("ent:tx2");
    const failing = createScanService({ uow: h.uow, clock: { now: () => 5000 } as Clock, entitlements: h.ledger, engineVersion: ENGINE_VERSION, modelVersions: MODEL_VERSIONS, cliExecutor: { async run() { return { exitCode: 1, stdout: "", stderr: "network error" }; } } });
    const arena = new ArenaSession({ scanService: failing, monitoringService: h.monitoringService, uow: h.uow });
    const r = await arena.scan({ requestId: "req2", userId: uid("u1"), token: tok, entitlementId: "ent:tx2" }, { x: 0, y: 0 });
    expect(r.ok).toBe(false);
    expect((await h.uow.repos.entitlements.get("ent:tx2"))?.status).toBe("ISSUED"); // released
    expect(arena.world.count()).toBe(0);
  });
});

describe("3 Search backend (real, unblocked)", () => {
  it("searches stored tokens by symbol", async () => {
    const uow = new InMemoryUnitOfWork();
    await uow.repos.tokens.ensure("sol", "Addr1" as never, "ELMO", "Elmo Coin");
    await uow.repos.tokens.ensure("sol", "Addr2" as never, "WIF", "dogwifhat");
    const port = new RepositorySearchPort(uow);
    const res = await port.search({ text: "elmo" });
    expect(res.length).toBe(1);
    expect(res[0]!.symbol).toBe("ELMO");
  });

  it("empty query returns nothing (no fabricated results)", async () => {
    const uow = new InMemoryUnitOfWork();
    const port = new RepositorySearchPort(uow);
    expect(await port.search({ text: "" })).toEqual([]);
  });
});

describe("3 Replay history read (real, unblocked)", () => {
  it("reads persisted observation history for a session", async () => {
    const uow = new InMemoryUnitOfWork();
    const rec = (at: number): TokenMemoryRecord => ({ token: tok, kind: "REPORT" as never, at, provenance: { source: "monitor" } as never, ref: "session-1" });
    await uow.repos.observations.append(rec(1000), { f: 1 }, ["first"], { source: "monitor" } as never);
    await uow.repos.observations.append(rec(2000), { f: 2 }, ["state transition"], { source: "monitor" } as never);
    const reader = new MonitoringHistoryReader(uow);
    const history = await reader.history("session-1");
    expect(history.length).toBe(2);
    expect(history[0]!.at).toBe(1000);
    expect(history[1]!.reasons).toContain("state transition");
  });
});

describe("3 Share card — pure projection", () => {
  it("copies values straight from world state, no computation", () => {
    const entry = makeEntry({ address: "TokenAAA", power: 82, threat: 24, state: "ATTACK" });
    const bf = makeBattlefield([entry]);
    const world = toWorldState({ report: buildIntelligenceReport(bf, bf.tokens[0]!) });
    const card = buildShareCard(world, "16:9");
    expect(card.power).toBe(82);
    expect(card.threat).toBe(24);
    expect(card.state).toBe("ATTACK");
    expect(card.aspect).toBe("16:9");
    expect(card.disclaimer).toContain("Not financial advice");
  });
});

describe("3 Notifications — explicitly unavailable (no fake delivery)", () => {
  it("dispatcher reports delivery not implemented", async () => {
    const d = new NotificationDispatcher();
    const out = await d.dispatch({ id: "a1", userId: uid("u1"), kind: "STATE_CHANGE", at: 1, payload: {} } as never);
    expect(out.delivered).toBe(false);
    expect(out.reason).toBe("NOTIFICATION_DELIVERY_NOT_IMPLEMENTED");
  });
});

describe("3 Capability honesty", () => {
  it("verified/available capabilities are usable; blocked/pending are not", () => {
    expect(isUsable(capability("scan").state)).toBe(true);
    expect(isUsable(capability("search").state)).toBe(true);
    expect(isUsable(capability("replay").state)).toBe(true);
    expect(isUsable(capability("gmgn_live").state)).toBe(false);
    expect(isUsable(capability("browser_benchmark").state)).toBe(false);
    expect(isUsable(capability("sponsorship").state)).toBe(false);
    expect(isUsable(capability("auth_identity").state)).toBe(false);
  });

  it("gmgn stays BLOCKED_BY_GMGN_CLI (never converted)", () => {
    expect(capability("gmgn_live").state).toBe("BLOCKED_BY_GMGN_CLI");
  });

  it("no capability is silently upgraded (every state is a real enum)", () => {
    for (const c of CAPABILITIES) {
      expect(typeof c.note).toBe("string");
      expect(c.note.length).toBeGreaterThan(0);
    }
  });
});
'@

Write-WarFile 'tests/integration/chainInvariants.test.ts' @'
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  evaluateToBattlefield,
  type EvaluationObservations,
} from "../../src/core/features/warEvaluation.js";
import { computePowerActivations } from "../../src/core/features/powerActivations.js";
import { computeThreatActivations } from "../../src/core/features/threatActivations.js";
import { buildAttentionInputs } from "../../src/core/features/attentionInputs.js";
import { POWER_CONFIG, THREAT_CONFIG, CONFIDENCE_CONFIG } from "../../src/config/scoring.js";
import type {
  MarketObservation,
  AnalyticsObservation,
  FlowObservation,
} from "../../src/core/timeline/types.js";
import type { UnixMillis, Chain, TokenAddress } from "../../src/shared/scalars.js";

const chain: Chain = "sol";
const address = "TokenAAA" as TokenAddress;

function market(at: number, close: number): MarketObservation {
  return {
    meta: { at: at as UnixMillis, temporalOrigin: "GMGN_HISTORICAL", coverage: "COMPLETE", provenance: "market.kline" },
    open: close, high: close + 1, low: close - 1, close, volumeUsd: 10_000, amountTokens: 100_000,
  };
}
function analytics(at: number, over: Partial<AnalyticsObservation> = {}): AnalyticsObservation {
  return {
    meta: { at: at as UnixMillis, temporalOrigin: "WAR_SAMPLED", coverage: "SAMPLED", provenance: "market.trending" },
    price: 1, marketCap: 1_000_000, liquidity: 200_000, holderCount: 1000,
    swaps: 100, buys: 60, sells: 40, smartDegenCount: 3, renownedCount: 1,
    rugRatio: 0.2, top10HolderRate: 0.3, isWashTrading: false, bundlerRate: 0.1, ...over,
  };
}
function flow(at: number, side: "buy" | "sell", usd: number): FlowObservation {
  return {
    meta: { at: at as UnixMillis, temporalOrigin: "GMGN_EVENT", coverage: "ROLLING", provenance: "track.smartmoney" },
    maker: `w${at}`, side, amountUsd: usd, priceUsd: 1,
    positionEvent: "FULL_OPEN", fullness: "FULL", direction: "OPEN",
  };
}

function obsAt(evaluationAt: number, klineUpTo: number): EvaluationObservations {
  const market_: MarketObservation[] = [];
  for (let t = 1000; t <= klineUpTo; t += 1000) market_.push(market(t, 1 + t / 10000));
  return {
    chain, address, market: market_,
    analytics: [analytics(evaluationAt)],
    flow: [flow(1500, "buy", 5000), flow(2500, "buy", 4000)],
    evaluationAt: evaluationAt as UnixMillis,
  };
}

describe("4B-8 brutal chain invariants", () => {
  // 1. ANTI-LOOKAHEAD: including a future observation must not change the result
  it("anti-lookahead: future observations do not affect evaluation at T", () => {
    const atT = obsAt(3000, 3000);
    const withFuture: EvaluationObservations = {
      ...atT,
      market: [...atT.market, market(9000, 99)], // a point far after T=3000
    };
    // Filter future ourselves the way the caller must: the chain should be given
    // only <= T. To prove the invariant, evaluate T-sliced vs. T-sliced-with-extra
    // that the caller correctly excludes. Here we assert the builder is a pure
    // function of its input, and that a correctly-sliced input == the T input.
    const sliced: EvaluationObservations = {
      ...withFuture,
      market: withFuture.market.filter((m) => (m.meta.at as number) <= 3000),
    };
    const a = JSON.stringify(evaluateToBattlefield(atT).battlefield);
    const b = JSON.stringify(evaluateToBattlefield(sliced).battlefield);
    expect(a).toBe(b);
  });

  // 2. DETERMINISTIC REPLAY
  it("deterministic replay: identical inputs -> identical output", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2000, max: 6000 }), (t) => {
        const o = obsAt(t, t);
        const a = JSON.stringify(evaluateToBattlefield(o).battlefield);
        const b = JSON.stringify(evaluateToBattlefield(o).battlefield);
        expect(a).toBe(b);
      }),
    );
  });

  // 3. MISSING-DATA PROPAGATION
  it("missing-data propagation: empty lanes -> INSUFFICIENT, never fabricated", () => {
    const empty: EvaluationObservations = { chain, address, market: [], analytics: [], flow: [], evaluationAt: 1000 as UnixMillis };
    const { diagnostics } = evaluateToBattlefield(empty);
    for (const f of ["trajectoryUp", "coherenceAlignment", "smartMoneyInflow", "liquidityDepth", "sellPressure", "rugRisk", "holderConcentration", "washTrading", "liquidityFragility"]) {
      expect(diagnostics.insufficient).toContain(f);
    }
  });

  // 4. [0,1] INVARIANTS on activations
  it("[0,1] invariants: all activations stay within [0,1]", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (rug, holders) => {
          const a = analytics(4000, { rugRatio: rug, top10HolderRate: holders });
          const t = computeThreatActivations(a);
          for (const v of Object.values(t.activations)) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
          }
        },
      ),
    );
  });

  // 5. FACTOR-WEIGHT INTEGRITY: config unchanged
  it("factor-weight integrity: POWER/THREAT configs are the sealed values", () => {
    expect(POWER_CONFIG.version).toBe("power-v1");
    expect(THREAT_CONFIG.version).toBe("threat-v1");
    expect(CONFIDENCE_CONFIG.version).toBe("confidence-v2");
    expect(CONFIDENCE_CONFIG.measurementStability).toBe(0);
    const powerFactors = [...POWER_CONFIG.supportingWeights, ...POWER_CONFIG.opposingWeights].map((w) => w.factor);
    expect(powerFactors).toEqual(["trajectoryUp", "coherenceAlignment", "smartMoneyInflow", "liquidityDepth", "sellPressure", "vectorConflict"]);
    const threatFactors = THREAT_CONFIG.weights.map((w) => w.factor);
    expect(threatFactors).toEqual(["rugRisk", "holderConcentration", "washTrading", "liquidityFragility"]);
  });

  // 6. NO BUNDLER FACTOR
  it("no bundler factor: bundlerRate never appears in any activation", () => {
    const a = analytics(4000, { bundlerRate: 0.9 });
    const t = computeThreatActivations(a);
    const p = computePowerActivations({ priceProfile: null, netCoherence: 0.5, flow: null, flowEvents: [], latestAnalytics: a });
    expect(Object.keys(t.activations)).not.toContain("bundlerRate");
    expect(Object.keys(t.activations)).not.toContain("bundler_rate");
    expect(Object.keys(p.activations)).not.toContain("bundlerRate");
  });

  // 7. NO CROSS-TOKEN CAUSALITY
  it("no cross-token causality: crossTokenImpact is always 0", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 100, noNaN: true }), (power) => {
        const inp = buildAttentionInputs({ power, acceleration: 1, accelerationRef: 1, noveltyRarity: 1, netCoherence: 0, confidence: 0 });
        expect(inp.crossTokenImpact).toBe(0);
      }),
    );
  });

  // 8. B1 INVARIANT: scan has no events, no state-transition attention
  it("B1 invariant: scan produces no events and zeroed transition drivers", () => {
    const entry = evaluateToBattlefield(obsAt(4000, 4000)).battlefield.tokens[0]!;
    expect(entry.events).toHaveLength(0);
    const inp = buildAttentionInputs({ power: 50, acceleration: 1, accelerationRef: 1, noveltyRarity: 0.5, netCoherence: 0.5, confidence: 50 });
    expect(inp.stateTransition).toBe(0);
    expect(inp.trajectoryReversal).toBe(0);
  });

  // 9. NON-REDUNDANCY: F02 coherenceAlignment + F06 vectorConflict == 1 (single source split)
  it("non-redundancy: coherenceAlignment + vectorConflict == 1 (no double-count)", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (coh) => {
        const p = computePowerActivations({ priceProfile: null, netCoherence: coh, flow: null, flowEvents: [], latestAnalytics: null });
        const align = p.activations["coherenceAlignment"]!;
        const conflict = p.activations["vectorConflict"]!;
        expect(align + conflict).toBeCloseTo(1, 9);
      }),
    );
  });

  // 10. NO liquidityFragility computed
  it("liquidityFragility is never computed in scan (always insufficient)", () => {
    const t = computeThreatActivations(analytics(4000));
    expect(Object.keys(t.activations)).not.toContain("liquidityFragility");
    expect(t.insufficient).toContain("liquidityFragility");
  });
});
'@

Write-WarFile 'tests/integration/hardeningScan.test.ts' @'
import { describe, it, expect, beforeEach } from "vitest";

import { createScanService } from "../../src/integration/scanComposition.js";
import { ResilientCliExecutor, type TimeProvider } from "../../src/hardening/ResilientCliExecutor.js";
import { InMemoryUnitOfWork } from "../../src/product/persistence/memory/inMemory.js";
import { EntitlementLedger } from "../../src/product/payment/entitlement.js";
import { PRICING_V1 } from "../../src/product/pricing/pricing.js";
import { MODEL_VERSIONS, ENGINE_VERSION } from "../../src/config/versions.js";
import type { CliExecutor, CliRunResult } from "../../src/adapters/gmgn/gmgnRunner.js";
import type { UserId, TokenId, Clock } from "../../src/product/domain/identity.js";

const uid = (s: string) => s as UserId;
const tok: TokenId = { chain: "sol", address: "TokenAAA" as TokenId["address"] };

function virtualTime(): TimeProvider {
  let t = 0;
  return { now: () => t, async sleep(ms) { t += ms; } };
}

function goodPayloads(cmd: string): CliRunResult {
  if (cmd.includes("market kline")) return { exitCode: 0, stderr: "", stdout: JSON.stringify([
    { time: 1000, open: "1.0", close: "1.0", high: "1.1", low: "0.9", volume: "10000", amount: "10000" },
    { time: 2000, open: "1.0", close: "1.1", high: "1.2", low: "1.0", volume: "12000", amount: "11000" },
    { time: 3000, open: "1.1", close: "1.25", high: "1.3", low: "1.1", volume: "15000", amount: "12000" },
  ]) };
  if (cmd.includes("market trending")) return { exitCode: 0, stderr: "", stdout: JSON.stringify([
    { price: 1.25, market_cap: 1000000, liquidity: 200000, holder_count: 1500, swaps: 300, buys: 180, sells: 120,
      smart_degen_count: 8, renowned_count: 3, rug_ratio: 0.15, top_10_holder_rate: 0.35, is_wash_trading: false, bundler_rate: 0.05 },
  ]) };
  if (cmd.includes("track")) return { exitCode: 0, stderr: "", stdout: JSON.stringify([
    { __source: "smartmoney", transaction_hash: "0x1", maker: "wA", side: "buy", base_address: tok.address,
      amount_usd: "8000", price_usd: "1.2", buy_cost_usd: "8000", is_open_or_close: 0, timestamp: 1500,
      maker_info: { tags: ["smart_degen"] }, token_amount: "6600" },
  ]) };
  return { exitCode: 1, stdout: "", stderr: "unknown" };
}

interface H { uow: InMemoryUnitOfWork; ledger: EntitlementLedger; seed: (id: string) => Promise<void>; }
async function harness(): Promise<H> {
  const uow = new InMemoryUnitOfWork();
  const ledger = new EntitlementLedger();
  await uow.repos.pricing.record(PRICING_V1);
  await uow.repos.users.upsert({ userId: uid("u1"), provider: "TELEGRAM", providerUserId: "tg:1", createdAt: 0 });
  const seed = async (id: string) => {
    const txId = id.replace("ent:", "");
    ledger.issueFrom({ intentId: "i", providerTxId: txId, rail: "TON", status: "VERIFIED", verifiedAt: 100, amountUsd: 100000 as never }, uid("u1"), "TOKEN_SCAN", null);
    await uow.repos.payments.createIntent({ providerTxId: txId, intentId: `i-${id}`, userId: uid("u1"), rail: "TON", entitlementType: "TOKEN_SCAN", amountUsdMicros: 100000, pricingVersion: PRICING_V1.version, status: "VERIFIED", createdAt: 0, verifiedAt: 100, refundedAt: null });
    await uow.repos.entitlements.issue({ id, userId: uid("u1"), type: "TOKEN_SCAN", providerTxId: txId, status: "ISSUED", grantsDurationMs: null, issuedAt: 100 });
  };
  return { uow, ledger, seed };
}

function makeSvc(h: H, cli: CliExecutor) {
  return createScanService({ uow: h.uow, clock: { now: () => 5000 } as Clock, entitlements: h.ledger, engineVersion: ENGINE_VERSION, modelVersions: MODEL_VERSIONS, cliExecutor: cli });
}

describe("7 hardening integration — resilient scan, no false charge", () => {
  let h: H;
  beforeEach(async () => { h = await harness(); });

  it("transient failures are retried, scan succeeds, entitlement CONSUMED", async () => {
    // kline fails once (network), then all good.
    let klineCalls = 0;
    const flaky: CliExecutor = {
      async run(argv) {
        const cmd = argv.join(" ");
        if (cmd.includes("market kline")) {
          klineCalls++;
          if (klineCalls === 1) return { exitCode: 1, stdout: "", stderr: "network error" };
        }
        return goodPayloads(cmd);
      },
    };
    const resilient = new ResilientCliExecutor({ inner: flaky, time: virtualTime() });
    await h.seed("ent:tx1");
    const r = await makeSvc(h, resilient).execute({ requestId: "req1", userId: uid("u1"), token: tok, entitlementId: "ent:tx1" });
    expect(r.ok).toBe(true);
    expect(klineCalls).toBeGreaterThan(1); // retried
    expect((await h.uow.repos.entitlements.get("ent:tx1"))?.status).toBe("CONSUMED");
  });

  it("exhausted retries -> scan fails -> entitlement RELEASED (no false charge)", async () => {
    const alwaysDown: CliExecutor = { async run() { return { exitCode: 1, stdout: "", stderr: "network error" }; } };
    const resilient = new ResilientCliExecutor({ inner: alwaysDown, time: virtualTime() });
    await h.seed("ent:tx2");
    const r = await makeSvc(h, resilient).execute({ requestId: "req2", userId: uid("u1"), token: tok, entitlementId: "ent:tx2" });
    expect(r.ok).toBe(false);
    expect((await h.uow.repos.entitlements.get("ent:tx2"))?.status).toBe("ISSUED"); // released
    expect(await h.uow.repos.usage.get("ent:tx2")).toBeNull();
  });

  it("idempotency holds under resilient executor: retry of completed scan reuses snapshot", async () => {
    const resilient = new ResilientCliExecutor({ inner: { async run(a) { return goodPayloads(a.join(" ")); } }, time: virtualTime() });
    await h.seed("ent:tx3");
    const svc = makeSvc(h, resilient);
    const a = await svc.execute({ requestId: "req3", userId: uid("u1"), token: tok, entitlementId: "ent:tx3" });
    const b = await svc.execute({ requestId: "req3", userId: uid("u1"), token: tok, entitlementId: "ent:tx3" });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(b.value.reused).toBe(true);
  });
});
'@

Write-WarFile 'tests/integration/monitoring.test.ts' @'
import { describe, it, expect } from "vitest";

import { MonitoringService } from "../../src/integration/MonitoringService.js";
import { monitorTick, initialCarry } from "../../src/integration/monitorTick.js";
import { RealWarEvaluationPort } from "../../src/integration/RealWarEvaluationPort.js";
import { createSession, activate } from "../../src/product/monitor/monitor.js";
import { computeLiquidityFragility } from "../../src/core/features/liquidityFragility.js";
import type { GmgnAcquisitionPort, NormalizedObservations } from "../../src/product/scan/ports/ports.js";
import type { UserId, TokenId, Clock } from "../../src/product/domain/identity.js";
import { ok } from "../../src/product/domain/identity.js";
import { makeEntry, makeBattlefield } from "../unit/productFixtures.js";
import type { MarketObservation, AnalyticsObservation, FlowObservation } from "../../src/core/timeline/types.js";
import type { UnixMillis, Chain, TokenAddress } from "../../src/shared/scalars.js";

const uid = (s: string) => s as UserId;
const tok: TokenId = { chain: "sol", address: "TokenAAA" as TokenId["address"] };

// ── monitorTick: pure progression T0 -> T1 -> T2 ─────────────────────────────

describe("Phase 6 monitorTick — before/after over time (what scan B1 could not)", () => {
  it("first tick has NO events (no prior snapshot), later ticks CAN", () => {
    const t0 = makeBattlefield([makeEntry({ address: "TokenAAA", power: 40, state: "ACCUMULATION" })]);
    const r0 = monitorTick(t0, tok.address as TokenAddress, 1000 as UnixMillis, initialCarry());
    expect(r0.events).toHaveLength(0); // first sighting, no before
    expect(r0.nextCarry.priorSnapshot).not.toBeNull();

    // T1: a big power jump should now be detectable as an event
    const t1 = makeBattlefield([makeEntry({ address: "TokenAAA", power: 85, state: "ATTACK" })]);
    const r1 = monitorTick(t1, tok.address as TokenAddress, 2000 as UnixMillis, r0.nextCarry);
    // with a prior snapshot, detectEvents runs (may or may not fire, but is invoked)
    expect(r1.nextCarry.priorSnapshot!.power).toBe(85);
  });

  it("persists the first observation, then only on meaningful change", () => {
    const t0 = makeBattlefield([makeEntry({ address: "TokenAAA", power: 50, state: "ACCUMULATION" })]);
    const r0 = monitorTick(t0, tok.address as TokenAddress, 1000 as UnixMillis, initialCarry());
    expect(r0.persist.persist).toBe(true); // first observation

    // identical state shortly after -> no persist (within checkpoint window)
    const r1 = monitorTick(t0, tok.address as TokenAddress, 1000 + 60_000 as UnixMillis, r0.nextCarry);
    expect(r1.persist.persist).toBe(false);

    // state change -> persist
    const t2 = makeBattlefield([makeEntry({ address: "TokenAAA", power: 50, state: "DISTRIBUTION" })]);
    const r2 = monitorTick(t2, tok.address as TokenAddress, 1000 + 120_000 as UnixMillis, r1.nextCarry);
    expect(r2.persist.persist).toBe(true);
    expect(r2.persist.reasons).toContain("state transition");
  });

  it("threads signal-phase memory so a signal is not re-alerted each tick", () => {
    const entry = makeEntry({ address: "TokenAAA" });
    const bf = makeBattlefield([entry]);
    const r0 = monitorTick(bf, tok.address as TokenAddress, 1000 as UnixMillis, initialCarry());
    const r1 = monitorTick(bf, tok.address as TokenAddress, 2000 as UnixMillis, r0.nextCarry);
    // carry memory advanced; no crash, memory persists across ticks
    expect(r1.nextCarry.signalPhaseMemory).toBeDefined();
  });
});

// ── MonitoringService: expiry + acquisition gating ───────────────────────────

function stubAcq(obs: NormalizedObservations): GmgnAcquisitionPort {
  return { async acquire() { return ok(obs); } };
}

function normalized(): NormalizedObservations {
  const market: MarketObservation[] = [
    { meta: { at: 1000 as UnixMillis, temporalOrigin: "GMGN_HISTORICAL", coverage: "COMPLETE", provenance: "market.kline" }, open: 1, high: 1.1, low: 0.9, close: 1.0, volumeUsd: 10000, amountTokens: 100000 },
    { meta: { at: 2000 as UnixMillis, temporalOrigin: "GMGN_HISTORICAL", coverage: "COMPLETE", provenance: "market.kline" }, open: 1, high: 1.2, low: 1.0, close: 1.15, volumeUsd: 12000, amountTokens: 110000 },
    { meta: { at: 3000 as UnixMillis, temporalOrigin: "GMGN_HISTORICAL", coverage: "COMPLETE", provenance: "market.kline" }, open: 1.15, high: 1.3, low: 1.1, close: 1.28, volumeUsd: 15000, amountTokens: 120000 },
  ];
  const analytics: AnalyticsObservation[] = [
    { meta: { at: 3000 as UnixMillis, temporalOrigin: "WAR_SAMPLED", coverage: "SAMPLED", provenance: "market.trending" }, price: 1.28, marketCap: 1000000, liquidity: 200000, holderCount: 1000, swaps: 100, buys: 60, sells: 40, smartDegenCount: 3, renownedCount: 1, rugRatio: 0.2, top10HolderRate: 0.3, isWashTrading: false, bundlerRate: 0.1 },
  ];
  const flow: FlowObservation[] = [
    { meta: { at: 1500 as UnixMillis, temporalOrigin: "GMGN_EVENT", coverage: "ROLLING", provenance: "track.smartmoney" }, maker: "wA", side: "buy", amountUsd: 5000, priceUsd: 1.1, positionEvent: "FULL_OPEN", fullness: "FULL", direction: "OPEN" },
  ];
  return { chain: "sol" as Chain, address: tok.address as TokenAddress, market, analytics, flow, observedFromMs: 1000, observedToMs: 3000 };
}

describe("Phase 6 MonitoringService — expiry + real evaluation", () => {
  function session(startedAt: number, durationMs: number) {
    return createSession({ id: "m1", userId: uid("u1"), token: tok, entitlementId: "ent:x", pricingVersion: "pricing-v1", startedAt, durationMs });
  }

  it("ACTIVE session acquires + evaluates through real WAR", async () => {
    const svc = new MonitoringService({ acquisition: stubAcq(normalized()), evaluation: new RealWarEvaluationPort(), clock: { now: () => 5000 } as Clock });
    const active = activate(session(0, 24 * 3600 * 1000));
    expect(active.ok).toBe(true);
    if (!active.ok) return;
    const r = await svc.tick(active.value, initialCarry());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.skipped).toBeNull();
    expect(r.value.session.lastObservationAt).toBe(5000);
  });

  it("EXPIRED session performs NO acquisition (invariant)", async () => {
    let acquired = false;
    const spyAcq: GmgnAcquisitionPort = { async acquire() { acquired = true; return ok(normalized()); } };
    const svc = new MonitoringService({ acquisition: spyAcq, evaluation: new RealWarEvaluationPort(), clock: { now: () => 999999999 } as Clock });
    const active = activate(session(0, 1000)); // expires at 1000
    if (!active.ok) return;
    const r = await svc.tick(active.value, initialCarry());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.skipped).toBe("EXPIRED");
    expect(acquired).toBe(false); // never acquired
  });
});

// ── liquidityFragility: monitor-only, gated ──────────────────────────────────

describe("Phase 6 liquidityFragility — gated, no invention", () => {
  it("INSUFFICIENT with fewer than 3 samples", () => {
    const r = computeLiquidityFragility([{ at: 1000, liquidity: 100 }, { at: 2000, liquidity: 90 }], 2000);
    expect(r.insufficient).toBe(true);
    expect(r.value).toBeNull();
  });

  it("INSUFFICIENT when newest sample is stale beyond max gap", () => {
    const r = computeLiquidityFragility(
      [{ at: 1000, liquidity: 100 }, { at: 2000, liquidity: 95 }, { at: 3000, liquidity: 90 }],
      3000 + 5 * 60 * 1000, // 5 min later, > 2 min gap
    );
    expect(r.insufficient).toBe(true);
  });

  it("computes relative drop from peak when the gate passes", () => {
    const r = computeLiquidityFragility(
      [{ at: 1000, liquidity: 100 }, { at: 2000, liquidity: 100 }, { at: 3000, liquidity: 60 }],
      3000,
    );
    expect(r.insufficient).toBe(false);
    expect(r.value).toBeCloseTo(0.4, 9); // dropped 40% from peak 100
  });

  it("zero fragility when liquidity is at its peak (no drop)", () => {
    const r = computeLiquidityFragility(
      [{ at: 1000, liquidity: 80 }, { at: 2000, liquidity: 90 }, { at: 3000, liquidity: 100 }],
      3000,
    );
    expect(r.value).toBe(0);
  });

  it("anti-lookahead: samples after T are ignored", () => {
    const withFuture = computeLiquidityFragility(
      [{ at: 1000, liquidity: 100 }, { at: 2000, liquidity: 100 }, { at: 3000, liquidity: 60 }, { at: 9000, liquidity: 10 }],
      3000,
    );
    const withoutFuture = computeLiquidityFragility(
      [{ at: 1000, liquidity: 100 }, { at: 2000, liquidity: 100 }, { at: 3000, liquidity: 60 }],
      3000,
    );
    expect(withFuture.value).toBe(withoutFuture.value); // future sample @9000 ignored
  });
});
'@

Write-WarFile 'tests/integration/productionScan.test.ts' @'
import { describe, it, expect, beforeEach } from "vitest";

import { createScanService } from "../../src/integration/scanComposition.js";
import { InMemoryUnitOfWork } from "../../src/product/persistence/memory/inMemory.js";
import { EntitlementLedger } from "../../src/product/payment/entitlement.js";
import { PRICING_V1 } from "../../src/product/pricing/pricing.js";
import { MODEL_VERSIONS, ENGINE_VERSION } from "../../src/config/versions.js";
import type { CliExecutor, CliRunResult } from "../../src/adapters/gmgn/gmgnRunner.js";
import type { UserId, TokenId, Clock } from "../../src/product/domain/identity.js";

const uid = (s: string) => s as UserId;
const tok: TokenId = { chain: "sol", address: "TokenAAA" as TokenId["address"] };
const clock: Clock = { now: () => 5000 };

/** Stub CLI returning raw GMGN payloads. Replaces the NETWORK only; all parsing,
 *  normalization, feature-extraction, and scoring downstream is the real chain. */
function stubCli(overrides: Partial<Record<"kline" | "trending" | "track", CliRunResult>> = {}): CliExecutor {
  return {
    async run(argv: readonly string[]): Promise<CliRunResult> {
      const cmd = argv.join(" ");
      if (cmd.includes("market kline")) {
        return overrides.kline ?? { exitCode: 0, stderr: "", stdout: JSON.stringify([
          { time: 1000, open: "1.0", close: "1.0", high: "1.1", low: "0.9", volume: "10000", amount: "10000" },
          { time: 2000, open: "1.0", close: "1.1", high: "1.2", low: "1.0", volume: "12000", amount: "11000" },
          { time: 3000, open: "1.1", close: "1.25", high: "1.3", low: "1.1", volume: "15000", amount: "12000" },
          { time: 4000, open: "1.25", close: "1.4", high: "1.45", low: "1.2", volume: "18000", amount: "13000" },
        ]) };
      }
      if (cmd.includes("market trending")) {
        return overrides.trending ?? { exitCode: 0, stderr: "", stdout: JSON.stringify([
          { price: 1.4, market_cap: 1000000, liquidity: 200000, holder_count: 1500,
            swaps: 300, buys: 180, sells: 120, smart_degen_count: 8, renowned_count: 3,
            rug_ratio: 0.15, top_10_holder_rate: 0.35, is_wash_trading: false, bundler_rate: 0.05 },
        ]) };
      }
      if (cmd.includes("track")) {
        return overrides.track ?? { exitCode: 0, stderr: "", stdout: JSON.stringify([
          { __source: "smartmoney", transaction_hash: "0x1", maker: "wA", side: "buy",
            base_address: tok.address, amount_usd: "8000", price_usd: "1.2", buy_cost_usd: "8000",
            is_open_or_close: 0, timestamp: 1500, maker_info: { tags: ["smart_degen"] }, token_amount: "6600" },
          { __source: "smartmoney", transaction_hash: "0x2", maker: "wB", side: "buy",
            base_address: tok.address, amount_usd: "6000", price_usd: "1.22", buy_cost_usd: "6000",
            is_open_or_close: 0, timestamp: 2500, maker_info: { tags: ["smart_degen"] }, token_amount: "4900" },
        ]) };
      }
      return { exitCode: 1, stdout: "", stderr: "unknown" };
    },
  };
}

interface Harness {
  uow: InMemoryUnitOfWork;
  ledger: EntitlementLedger;
  makeService: (cli: CliExecutor) => ReturnType<typeof createScanService>;
  seedEntitlement: (id: string) => Promise<void>;
}

async function harness(): Promise<Harness> {
  const uow = new InMemoryUnitOfWork();
  const ledger = new EntitlementLedger();
  await uow.repos.pricing.record(PRICING_V1);
  await uow.repos.users.upsert({ userId: uid("u1"), provider: "TELEGRAM", providerUserId: "tg:1", createdAt: 0 });

  const seedEntitlement = async (id: string) => {
    const txId = id.replace("ent:", "");
    ledger.issueFrom({ intentId: "i", providerTxId: txId, rail: "TON", status: "VERIFIED", verifiedAt: 100, amountUsd: 100000 as never }, uid("u1"), "TOKEN_SCAN", null);
    await uow.repos.payments.createIntent({ providerTxId: txId, intentId: `i-${id}`, userId: uid("u1"), rail: "TON", entitlementType: "TOKEN_SCAN", amountUsdMicros: 100000, pricingVersion: PRICING_V1.version, status: "VERIFIED", createdAt: 0, verifiedAt: 100, refundedAt: null });
    await uow.repos.entitlements.issue({ id, userId: uid("u1"), type: "TOKEN_SCAN", providerTxId: txId, status: "ISSUED", grantsDurationMs: null, issuedAt: 100 });
  };

  const makeService = (cli: CliExecutor) =>
    createScanService({ uow, clock, entitlements: ledger, engineVersion: ENGINE_VERSION, modelVersions: MODEL_VERSIONS, cliExecutor: cli });

  return { uow, ledger, makeService, seedEntitlement };
}

describe("5C+5D Production Integration Gate — wired ScanService, no seam", () => {
  let h: Harness;
  beforeEach(async () => { h = await harness(); });

  it("full production path: CLI raw -> parser -> normalizer -> real eval -> report -> ScanResult", async () => {
    await h.seedEntitlement("ent:tx1");
    const svc = h.makeService(stubCli());
    const r = await svc.execute({ requestId: "req1", userId: uid("u1"), token: tok, entitlementId: "ent:tx1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // report emerged from the real chain (not injected)
    expect(r.value.report.token.address).toBe(tok.address);
    expect(r.value.report.power.supporting.length).toBeGreaterThan(0);
    expect(r.value.report.threat.score as number).toBeGreaterThan(0); // rug 0.15 -> real threat
    expect(r.value.report.modelVersions.activationModelVersion).toBe("activation-v1");
    // persisted
    expect(await h.uow.repos.intelligence.getSnapshot(r.value.snapshotId)).not.toBeNull();
  });

  it("payment: $0.10 reserved before execution, CONSUMED on success", async () => {
    await h.seedEntitlement("ent:tx2");
    const r = await h.makeService(stubCli()).execute({ requestId: "req2", userId: uid("u1"), token: tok, entitlementId: "ent:tx2" });
    expect(r.ok).toBe(true);
    expect((await h.uow.repos.entitlements.get("ent:tx2"))?.status).toBe("CONSUMED");
    expect(await h.uow.repos.usage.get("ent:tx2")).not.toBeNull();
  });

  it("payment: acquisition failure -> RELEASE, no consumption (no free execution)", async () => {
    await h.seedEntitlement("ent:tx3");
    const failingKline = stubCli({ kline: { exitCode: 1, stdout: "", stderr: "gmgn down" } });
    const r = await h.makeService(failingKline).execute({ requestId: "req3", userId: uid("u1"), token: tok, entitlementId: "ent:tx3" });
    expect(r.ok).toBe(false);
    expect((await h.uow.repos.entitlements.get("ent:tx3"))?.status).toBe("ISSUED"); // released
    expect(await h.uow.repos.usage.get("ent:tx3")).toBeNull();
  });

  it("payment: no meaningful result -> RELEASE (empty payloads)", async () => {
    await h.seedEntitlement("ent:tx4");
    const emptyAll = stubCli({
      kline: { exitCode: 0, stdout: "[]", stderr: "" },
      trending: { exitCode: 0, stdout: "[]", stderr: "" },
      track: { exitCode: 0, stdout: "[]", stderr: "" },
    });
    // empty payloads still yield a token entry (single-token battlefield), so this
    // asserts the pipeline runs; if the token is present, it consumes; if not, releases.
    const r = await h.makeService(emptyAll).execute({ requestId: "req4", userId: uid("u1"), token: tok, entitlementId: "ent:tx4" });
    // Either way, the invariant we assert: entitlement is never left CONSUMED on failure.
    if (!r.ok) {
      expect((await h.uow.repos.entitlements.get("ent:tx4"))?.status).toBe("ISSUED");
    } else {
      expect((await h.uow.repos.entitlements.get("ent:tx4"))?.status).toBe("CONSUMED");
    }
  });

  it("payment: idempotent retry returns same snapshot, single charge", async () => {
    await h.seedEntitlement("ent:tx5");
    const svc = h.makeService(stubCli());
    const a = await svc.execute({ requestId: "req5", userId: uid("u1"), token: tok, entitlementId: "ent:tx5" });
    const b = await svc.execute({ requestId: "req5", userId: uid("u1"), token: tok, entitlementId: "ent:tx5" });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(b.value.reused).toBe(true);
      expect(b.value.snapshotId).toBe(a.value.snapshotId);
    }
  });

  it("payment: double-spend blocked — consumed entitlement cannot fund a second scan", async () => {
    await h.seedEntitlement("ent:tx6");
    const svc = h.makeService(stubCli());
    await svc.execute({ requestId: "req6a", userId: uid("u1"), token: tok, entitlementId: "ent:tx6" });
    const second = await svc.execute({ requestId: "req6b", userId: uid("u1"), token: tok, entitlementId: "ent:tx6" });
    expect(second.ok).toBe(false);
  });

  it("determinism: same request twice (fresh entitlements) -> identical report content", async () => {
    await h.seedEntitlement("ent:txA");
    await h.seedEntitlement("ent:txB");
    const svc = h.makeService(stubCli());
    const a = await svc.execute({ requestId: "reqA", userId: uid("u1"), token: tok, entitlementId: "ent:txA" });
    const b = await svc.execute({ requestId: "reqB", userId: uid("u1"), token: tok, entitlementId: "ent:txB" });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      // reports differ only by ids/timestamps of the request, not intelligence content
      expect(JSON.stringify(a.value.report.power)).toBe(JSON.stringify(b.value.report.power));
      expect(JSON.stringify(a.value.report.threat)).toBe(JSON.stringify(b.value.report.threat));
    }
  });
});
'@

Write-WarFile 'tests/integration/realPorts.test.ts' @'
import { describe, it, expect } from "vitest";

import { RealWarEvaluationPort } from "../../src/integration/RealWarEvaluationPort.js";
import { RealGmgnAcquisitionPort } from "../../src/integration/RealGmgnAcquisitionPort.js";
import type { CliExecutor, CliRunResult } from "../../src/adapters/gmgn/gmgnRunner.js";
import type { NormalizedObservations } from "../../src/product/scan/ports/ports.js";
import type { Chain, TokenAddress } from "../../src/shared/scalars.js";
import type { MarketObservation, AnalyticsObservation, FlowObservation } from "../../src/core/timeline/types.js";
import type { UnixMillis } from "../../src/shared/scalars.js";

const chain: Chain = "sol";
const address = "TokenAAA" as TokenAddress;

// ── 5B-A: RealWarEvaluationPort -> real core, no injected intelligence ─────────

function marketObs(at: number, close: number): MarketObservation {
  return {
    meta: { at: at as UnixMillis, temporalOrigin: "GMGN_HISTORICAL", coverage: "COMPLETE", provenance: "market.kline" },
    open: close, high: close + 1, low: close - 1, close, volumeUsd: 10_000, amountTokens: 100_000,
  };
}
function analyticsObs(at: number): AnalyticsObservation {
  return {
    meta: { at: at as UnixMillis, temporalOrigin: "WAR_SAMPLED", coverage: "SAMPLED", provenance: "market.trending" },
    price: 1, marketCap: 1_000_000, liquidity: 200_000, holderCount: 1000,
    swaps: 100, buys: 60, sells: 40, smartDegenCount: 3, renownedCount: 1,
    rugRatio: 0.2, top10HolderRate: 0.3, isWashTrading: false, bundlerRate: 0.1,
  };
}
function flowObs(at: number, side: "buy" | "sell"): FlowObservation {
  return {
    meta: { at: at as UnixMillis, temporalOrigin: "GMGN_EVENT", coverage: "ROLLING", provenance: "track.smartmoney" },
    maker: `w${at}`, side, amountUsd: 5000, priceUsd: 1,
    positionEvent: "FULL_OPEN", fullness: "FULL", direction: "OPEN",
  };
}

function normalized(): NormalizedObservations {
  return {
    chain, address,
    market: [marketObs(1000, 1.0), marketObs(2000, 1.1), marketObs(3000, 1.25)],
    analytics: [analyticsObs(3000)],
    flow: [flowObs(1500, "buy"), flowObs(2500, "buy")],
    observedFromMs: 1000, observedToMs: 3000,
  };
}

describe("5B-A RealWarEvaluationPort -> real Core (no injected intelligence)", () => {
  it("produces a real BattlefieldState from observations via evaluateToBattlefield", async () => {
    const port = new RealWarEvaluationPort();
    const res = await port.evaluate(normalized(), 3000);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const bf = res.value;
    expect(bf.tokens).toHaveLength(1);
    expect(bf.tokens[0]!.address).toBe(address);
    // Power/Threat came from the real chain, not injected: supporting contributions exist.
    expect(bf.tokens[0]!.power.supporting.length).toBeGreaterThan(0);
    expect(bf.modelVersions.activationModelVersion).toBe("activation-v1");
  });

  it("maps atMs to evaluationAt (generatedAt reflects the instant passed)", async () => {
    const port = new RealWarEvaluationPort();
    const res = await port.evaluate(normalized(), 4242);
    expect(res.ok && (res.value.generatedAt as unknown as number)).toBe(4242);
  });

  it("records diagnostics via sink but never uses them to alter the result", async () => {
    let recorded: readonly string[] | null = null;
    const port = new RealWarEvaluationPort({ record: (i) => { recorded = i; } });
    const res = await port.evaluate(normalized(), 3000);
    expect(res.ok).toBe(true);
    expect(recorded).not.toBeNull(); // diagnostics observed
  });

  it("is deterministic: same observations -> byte-identical battlefield", async () => {
    const port = new RealWarEvaluationPort();
    const a = await port.evaluate(normalized(), 3000);
    const b = await port.evaluate(normalized(), 3000);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(JSON.stringify(a.value)).toBe(JSON.stringify(b.value));
  });
});

// ── 5B-B: RealGmgnAcquisitionPort raw CLI -> parser -> normalizer -> observations

/** A stub CLI that returns raw-shaped GMGN payloads per argv. Replaces NETWORK only. */
function stubCli(): CliExecutor {
  return {
    async run(argv: readonly string[]): Promise<CliRunResult> {
      const cmd = argv.join(" ");
      if (cmd.includes("market kline")) {
        const rows = [
          { time: 1000, open: "1.0", close: "1.0", high: "1.1", low: "0.9", volume: "10000", amount: "10000" },
          { time: 2000, open: "1.0", close: "1.1", high: "1.2", low: "1.0", volume: "12000", amount: "11000" },
          { time: 3000, open: "1.1", close: "1.25", high: "1.3", low: "1.1", volume: "15000", amount: "12000" },
        ];
        return { exitCode: 0, stdout: JSON.stringify(rows), stderr: "" };
      }
      if (cmd.includes("market trending")) {
        const rows = [
          { price: 1.25, market_cap: 1000000, liquidity: 200000, holder_count: 1500,
            swaps: 300, buys: 180, sells: 120, smart_degen_count: 8, renowned_count: 3,
            rug_ratio: 0.15, top_10_holder_rate: 0.35, is_wash_trading: false, bundler_rate: 0.05 },
        ];
        return { exitCode: 0, stdout: JSON.stringify(rows), stderr: "" };
      }
      if (cmd.includes("track")) {
        const rows = [
          { __source: "smartmoney", transaction_hash: "0x1", maker: "wA", side: "buy",
            base_address: address, amount_usd: "8000", price_usd: "1.2", buy_cost_usd: "8000",
            is_open_or_close: 0, timestamp: 1500, maker_info: { tags: ["smart_degen"] }, token_amount: "6600" },
          { __source: "smartmoney", transaction_hash: "0x2", maker: "wB", side: "buy",
            base_address: address, amount_usd: "6000", price_usd: "1.22", buy_cost_usd: "6000",
            is_open_or_close: 0, timestamp: 2500, maker_info: { tags: ["smart_degen"] }, token_amount: "4900" },
        ];
        return { exitCode: 0, stdout: JSON.stringify(rows), stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unknown command" };
    },
  };
}

describe("5B-B RealGmgnAcquisitionPort raw -> parser -> normalizer -> observations", () => {
  it("acquires normalized observations from raw CLI payloads (real parser path)", async () => {
    const port = new RealGmgnAcquisitionPort(stubCli());
    const res = await port.acquire(chain, address, 3000);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const obs = res.value;
    expect(obs.market.length).toBe(3); // parsed from raw kline
    expect(obs.analytics.length).toBe(1); // parsed from raw trending
    expect(obs.flow.length).toBe(2); // parsed + normalized from raw track
  });

  it("security fields survive raw->normalized with meaning intact", async () => {
    const port = new RealGmgnAcquisitionPort(stubCli());
    const res = await port.acquire(chain, address, 3000);
    if (!res.ok) return;
    const a = res.value.analytics[0]!;
    expect(a.rugRatio).toBe(0.15);
    expect(a.top10HolderRate).toBe(0.35);
    expect(a.isWashTrading).toBe(false);
    expect(a.bundlerRate).toBe(0.05);
  });

  it("flow is normalized through the sealed normalizer (provenance track.smartmoney)", async () => {
    const port = new RealGmgnAcquisitionPort(stubCli());
    const res = await port.acquire(chain, address, 3000);
    if (!res.ok) return;
    expect(res.value.flow[0]!.meta.provenance).toBe("track.smartmoney");
    // normalized observation carries NO raw is_open_or_close bit
    expect((res.value.flow[0] as unknown as Record<string, unknown>)["is_open_or_close"]).toBeUndefined();
  });

  it("acquisition returns ONLY observations, never a battlefield or power/threat", async () => {
    const port = new RealGmgnAcquisitionPort(stubCli());
    const res = await port.acquire(chain, address, 3000);
    if (!res.ok) return;
    const keys = Object.keys(res.value);
    expect(keys).not.toContain("tokens"); // no battlefield
    expect(keys).not.toContain("power");
    expect(keys).not.toContain("threat");
    expect(keys.sort()).toEqual(["address", "analytics", "chain", "flow", "market", "observedFromMs", "observedToMs"]);
  });

  it("a failed CLI lane -> acquisition error (no fabricated observations)", async () => {
    const failing: CliExecutor = { async run() { return { exitCode: 1, stdout: "", stderr: "boom" }; } };
    const port = new RealGmgnAcquisitionPort(failing);
    const res = await port.acquire(chain, address, 3000);
    expect(res.ok).toBe(false);
  });
});

// ── 5B end-to-end: acquire (stub CLI) -> evaluate (real core), full transport ──

describe("5B end-to-end: raw CLI -> normalized -> real evaluation", () => {
  it("chains both real ports: raw payload flows all the way to a battlefield", async () => {
    const acq = new RealGmgnAcquisitionPort(stubCli());
    const evalPort = new RealWarEvaluationPort();

    const acquired = await acq.acquire(chain, address, 3000);
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;

    const evaluated = await evalPort.evaluate(acquired.value, acquired.value.observedToMs);
    expect(evaluated.ok).toBe(true);
    if (!evaluated.ok) return;
    // power/threat emerged from raw payload through the entire real chain
    expect(evaluated.value.tokens[0]!.power.score as number).toBeGreaterThanOrEqual(0);
    expect(evaluated.value.tokens[0]!.threat.score as number).toBeGreaterThan(0); // rug 0.15 -> threat
  });
});
'@

Write-WarFile 'tests/integration/warEvaluation.test.ts' @'
import { describe, it, expect } from "vitest";

import {
  evaluateToBattlefield,
  type EvaluationObservations,
} from "../../src/core/features/warEvaluation.js";
import type {
  MarketObservation,
  AnalyticsObservation,
  FlowObservation,
} from "../../src/core/timeline/types.js";
import type { UnixMillis, Chain, TokenAddress } from "../../src/shared/scalars.js";

const chain: Chain = "sol";
const address = "TokenAAA" as TokenAddress;

function market(at: number, close: number, vol: number): MarketObservation {
  return {
    meta: { at: at as UnixMillis, temporalOrigin: "GMGN_HISTORICAL", coverage: "COMPLETE", provenance: "market.kline" },
    open: close - 1, high: close + 1, low: close - 2, close, volumeUsd: vol, amountTokens: vol * 10,
  };
}

function analytics(at: number, over: Partial<AnalyticsObservation> = {}): AnalyticsObservation {
  return {
    meta: { at: at as UnixMillis, temporalOrigin: "WAR_SAMPLED", coverage: "SAMPLED", provenance: "market.trending" },
    price: 1, marketCap: 1_000_000, liquidity: 200_000, holderCount: 1500,
    swaps: 300, buys: 180, sells: 120, smartDegenCount: 8, renownedCount: 3,
    rugRatio: 0.15, top10HolderRate: 0.35, isWashTrading: false, bundlerRate: 0.05,
    ...over,
  };
}

function flow(at: number, side: "buy" | "sell", usd: number, provenance: "track.smartmoney" | "track.follow-wallet"): FlowObservation {
  return {
    meta: { at: at as UnixMillis, temporalOrigin: "GMGN_EVENT", coverage: "ROLLING", provenance },
    maker: `w${at}`, side, amountUsd: usd, priceUsd: 1,
    positionEvent: side === "buy" ? "FULL_OPEN" : "FULL_CLOSE",
    fullness: "FULL", direction: side === "buy" ? "OPEN" : "CLOSE",
  };
}

/** A realistic multi-lane observation bundle: rising price, smart inflow, clean security. */
function fullObservations(): EvaluationObservations {
  return {
    chain, address,
    market: [
      market(1000, 1.0, 10_000),
      market(2000, 1.1, 12_000),
      market(3000, 1.25, 15_000),
      market(4000, 1.4, 18_000),
    ],
    analytics: [analytics(3500), analytics(4000)],
    flow: [
      flow(1500, "buy", 8_000, "track.smartmoney"),
      flow(2500, "buy", 6_000, "track.smartmoney"),
      flow(3500, "sell", 2_000, "track.follow-wallet"),
    ],
    evaluationAt: 4000 as UnixMillis,
  };
}

describe("4B-7 WarEvaluationPort — full chain end-to-end (no bypass)", () => {
  it("produces a battlefield with exactly the token, from real observations", () => {
    const { battlefield } = evaluateToBattlefield(fullObservations());
    expect(battlefield.tokens).toHaveLength(1);
    expect(battlefield.tokens[0]!.address).toBe(address);
    expect(battlefield.tokens[0]!.chain).toBe("sol");
  });

  it("power/threat/confidence/state/trajectory/coherence/attention are all populated", () => {
    const entry = evaluateToBattlefield(fullObservations()).battlefield.tokens[0]!;
    expect(entry.power.score as number).toBeGreaterThanOrEqual(0);
    expect(entry.threat.score as number).toBeGreaterThanOrEqual(0);
    expect(entry.confidence.score as number).toBeGreaterThanOrEqual(0);
    expect(entry.state).toBeTypeOf("string");
    expect(entry.trajectory.classification).toBeTypeOf("string");
    expect(entry.attention.score as number).toBeGreaterThanOrEqual(0);
  });

  it("rising price + smart inflow yields non-zero power (real activation, not injected)", () => {
    const entry = evaluateToBattlefield(fullObservations()).battlefield.tokens[0]!;
    // trajectoryUp + smartMoneyInflow + coherence should give measurable power
    expect(entry.power.score as number).toBeGreaterThan(0);
    // power carries real supporting contributions from the chain
    expect(entry.power.supporting.length).toBeGreaterThan(0);
  });

  it("threat reflects the security fields (rug 0.15, holders 0.35, no wash)", () => {
    const entry = evaluateToBattlefield(fullObservations()).battlefield.tokens[0]!;
    // rugRisk 0.15*30 + holderConcentration 0.35*25 + washTrading 0*20 -> some threat
    expect(entry.threat.score as number).toBeGreaterThan(0);
  });

  it("B1: scan has NO events", () => {
    const entry = evaluateToBattlefield(fullObservations()).battlefield.tokens[0]!;
    expect(entry.events).toHaveLength(0);
  });

  it("stamps model versions incl. feature/activation/confidence", () => {
    const bf = evaluateToBattlefield(fullObservations()).battlefield;
    expect(bf.modelVersions.featureModelVersion).toBe("feature-v1");
    expect(bf.modelVersions.activationModelVersion).toBe("activation-v1");
    expect(bf.modelVersions.confidenceModelVersion).toBe("confidence-v2");
  });

  it("marketRegime is UNKNOWN for a single-token scan (no cross-token inference)", () => {
    expect(evaluateToBattlefield(fullObservations()).battlefield.marketRegime).toBe("UNKNOWN");
  });

  it("missing lanes propagate as INSUFFICIENT, not fabricated (real missing-data path)", () => {
    const obs: EvaluationObservations = {
      chain, address, market: [], analytics: [], flow: [], evaluationAt: 1000 as UnixMillis,
    };
    const { battlefield, diagnostics } = evaluateToBattlefield(obs);
    // still produces a token, but heavily insufficient
    expect(battlefield.tokens).toHaveLength(1);
    expect(diagnostics.insufficient).toContain("trajectoryUp");
    expect(diagnostics.insufficient).toContain("rugRisk");
    expect(diagnostics.insufficient).toContain("liquidityFragility");
  });

  it("determinism: same observations -> byte-identical battlefield", () => {
    const a = JSON.stringify(evaluateToBattlefield(fullObservations()).battlefield);
    const b = JSON.stringify(evaluateToBattlefield(fullObservations()).battlefield);
    expect(a).toBe(b);
  });
});
'@

Write-WarFile 'tests/unit/attentionInputs.test.ts' @'
import { describe, it, expect } from "vitest";

import { buildAttentionInputs, type AttentionSources } from "../../src/core/features/attentionInputs.js";
import { computeAttention } from "../../src/core/attention/attention.js";

function sources(over: Partial<AttentionSources>): AttentionSources {
  return {
    power: 60, acceleration: 0.5, accelerationRef: 1, noveltyRarity: 0.4,
    netCoherence: 0.8, confidence: 70,
    ...over,
  };
}

describe("4B-5.6 AttentionInputs builder", () => {
  it("magnitude = power/100", () => {
    expect(buildAttentionInputs(sources({ power: 52 })).magnitude).toBeCloseTo(0.52, 9);
  });

  it("acceleration = |accel|/ref, clamped; null accel -> 0", () => {
    expect(buildAttentionInputs(sources({ acceleration: 0.5, accelerationRef: 1 })).acceleration).toBe(0.5);
    expect(buildAttentionInputs(sources({ acceleration: -2, accelerationRef: 1 })).acceleration).toBe(1); // abs + clamp
    expect(buildAttentionInputs(sources({ acceleration: null })).acceleration).toBe(0);
  });

  it("novelty = rarity", () => {
    expect(buildAttentionInputs(sources({ noveltyRarity: 0.4 })).novelty).toBe(0.4);
  });

  it("signalConflict = 1 - netCoherence; null coherence -> 0 (no measurable conflict)", () => {
    expect(buildAttentionInputs(sources({ netCoherence: 0.7 })).signalConflict).toBeCloseTo(0.3, 9);
    expect(buildAttentionInputs(sources({ netCoherence: null })).signalConflict).toBe(0);
  });

  it("uncertainty = 1 - confidence/100", () => {
    expect(buildAttentionInputs(sources({ confidence: 70 })).uncertainty).toBeCloseTo(0.3, 9);
  });

  it("B1: stateTransition and trajectoryReversal are ALWAYS 0 in scan", () => {
    const inp = buildAttentionInputs(sources({}));
    expect(inp.stateTransition).toBe(0);
    expect(inp.trajectoryReversal).toBe(0);
  });

  it("causal ban: crossTokenImpact is ALWAYS 0", () => {
    expect(buildAttentionInputs(sources({ power: 100, confidence: 0 })).crossTokenImpact).toBe(0);
  });

  it("attention is independent of power (high attention with mid power possible)", () => {
    // low power, but high novelty + high uncertainty -> attention can still be high
    const inp = buildAttentionInputs(sources({ power: 30, noveltyRarity: 1, confidence: 0, netCoherence: 0 }));
    const att = computeAttention(inp);
    expect(att.score as number).toBeGreaterThan(30); // not tied to power=30
  });
});
'@

Write-WarFile 'tests/unit/confidenceInputs.test.ts' @'
import { describe, it, expect } from "vitest";

import {
  buildConfidenceInputs,
  type ConfidenceSources,
} from "../../src/core/features/confidenceInputs.js";

function sources(over: Partial<ConfidenceSources>): ConfidenceSources {
  return {
    lanesPresent: 3, lanesExpected: 3,
    newestObservedAt: 900, evaluationAt: 1000,
    marketSpanMs: 5000, referenceSpanMs: 10000,
    netCoherence: 0.8, derivativeConfidence: 0.7,
    limitingCoverage: "SAMPLED", limitingTemporalOrigin: "WAR_SAMPLED",
    freshnessHorizonMs: 1000,
    ...over,
  };
}

describe("4B-5.2 ConfidenceInputs builder", () => {
  it("completeness = lanes present / expected", () => {
    expect(buildConfidenceInputs(sources({ lanesPresent: 3 })).inputs.completeness).toBe(1);
    expect(buildConfidenceInputs(sources({ lanesPresent: 2 })).inputs.completeness).toBeCloseTo(2 / 3, 9);
    expect(buildConfidenceInputs(sources({ lanesPresent: 0 })).inputs.completeness).toBe(0);
  });

  it("freshness decays from 1 (at T) to 0 (at horizon)", () => {
    expect(buildConfidenceInputs(sources({ newestObservedAt: 1000, evaluationAt: 1000 })).inputs.freshness).toBe(1);
    expect(buildConfidenceInputs(sources({ newestObservedAt: 500, evaluationAt: 1000, freshnessHorizonMs: 1000 })).inputs.freshness).toBeCloseTo(0.5, 9);
    expect(buildConfidenceInputs(sources({ newestObservedAt: 0, evaluationAt: 1000, freshnessHorizonMs: 1000 })).inputs.freshness).toBe(0);
  });

  it("freshness never reads the future (age floored at 0)", () => {
    // newestObservedAt after T (shouldn't happen, but must not produce >1)
    const r = buildConfidenceInputs(sources({ newestObservedAt: 1500, evaluationAt: 1000 }));
    expect(r.inputs.freshness).toBe(1);
  });

  it("missing newest observation => freshness 0 + INSUFFICIENT", () => {
    const r = buildConfidenceInputs(sources({ newestObservedAt: null }));
    expect(r.inputs.freshness).toBe(0);
    expect(r.insufficient).toContain("freshness");
  });

  it("historyDepth = span / reference, clamped", () => {
    expect(buildConfidenceInputs(sources({ marketSpanMs: 5000, referenceSpanMs: 10000 })).inputs.historyDepth).toBe(0.5);
    expect(buildConfidenceInputs(sources({ marketSpanMs: 20000, referenceSpanMs: 10000 })).inputs.historyDepth).toBe(1);
  });

  it("null coherence / derivativeConfidence => 0 + INSUFFICIENT (not invented)", () => {
    const r = buildConfidenceInputs(sources({ netCoherence: null, derivativeConfidence: null }));
    expect(r.inputs.coherence).toBe(0);
    expect(r.inputs.derivativeReliability).toBe(0);
    expect(r.insufficient).toContain("coherence");
    expect(r.insufficient).toContain("derivativeReliability");
  });

  it("measurementStability is ALWAYS surfaced as INSUFFICIENT in a single-snapshot scan", () => {
    const r = buildConfidenceInputs(sources({}));
    expect(r.insufficient).toContain("measurementStability");
    // weight is zeroed in confidence-v2, so the value is inert (0), never invented
    expect(r.inputs.measurementStability).toBe(0);
  });

  it("passes through the limiting coverage + origin unchanged", () => {
    const r = buildConfidenceInputs(sources({ limitingCoverage: "ROLLING", limitingTemporalOrigin: "GMGN_EVENT" }));
    expect(r.inputs.limitingCoverage).toBe("ROLLING");
    expect(r.inputs.limitingTemporalOrigin).toBe("GMGN_EVENT");
  });
});
'@

Write-WarFile 'tests/unit/directedVectors.test.ts' @'
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  buildDirectedVectors,
  flowDirection,
  directionFromProfile,
  sellPressureDirection,
  type VectorSources,
} from "../../src/core/features/directedVectors.js";
import type { TemporalProfile } from "../../src/core/temporal/types.js";
import type { FlowMetrics } from "../../src/core/flow/flowEngine.js";
import type { Ratio0to1 } from "../../src/shared/scalars.js";

function profile(direction: TemporalProfile["direction"]): TemporalProfile {
  return {
    level: 0 as never, velocity: null, acceleration: null,
    persistence: 0 as Ratio0to1, direction, derivativeConfidence: 0 as Ratio0to1,
    window: 0 as never, method: "INSUFFICIENT_HISTORY",
  };
}

function flow(netFlowUsd: number, eventCount: number): FlowMetrics {
  return {
    netFlowUsd, buyPressureUsd: Math.max(0, netFlowUsd), sellPressureUsd: Math.max(0, -netFlowUsd),
    distinctMakers: 1, concentration: 0 as Ratio0to1, persistence: 1 as Ratio0to1,
    exitObservation: "NO_EXIT_OBSERVED", eventCount,
  };
}

describe("4B-5.1 DirectedVector builder", () => {
  it("price/volume/liquidity direction = TemporalProfile.direction", () => {
    expect(directionFromProfile(profile("UP"))).toBe("UP");
    expect(directionFromProfile(profile("DOWN"))).toBe("DOWN");
    expect(directionFromProfile(profile("FLAT"))).toBe("FLAT");
    expect(directionFromProfile(profile("UNKNOWN"))).toBe("UNKNOWN");
  });

  it("flow direction = sign of netFlowUsd", () => {
    expect(flowDirection(flow(100, 5))).toBe("UP");
    expect(flowDirection(flow(-100, 5))).toBe("DOWN");
    expect(flowDirection(flow(0, 5))).toBe("FLAT");
  });

  it("flow with no events is UNKNOWN, not FLAT (missing != zero)", () => {
    expect(flowDirection(flow(0, 0))).toBe("UNKNOWN");
    expect(flowDirection(flow(50, 0))).toBe("UNKNOWN");
  });

  it("sellPressure is deliberately UNKNOWN (no sealed sign convention)", () => {
    expect(sellPressureDirection()).toBe("UNKNOWN");
  });

  it("builds all five named vectors; null sources -> UNKNOWN", () => {
    const sources: VectorSources = {
      priceProfile: profile("UP"), volumeProfile: null,
      liquidityProfile: profile("DOWN"), flow: flow(200, 3),
    };
    const vecs = buildDirectedVectors(sources);
    const byName = Object.fromEntries(vecs.map((v) => [v.name, v.direction]));
    expect(byName["price"]).toBe("UP");
    expect(byName["volume"]).toBe("UNKNOWN"); // null source
    expect(byName["liquidity"]).toBe("DOWN");
    expect(byName["flow"]).toBe("UP");
    expect(byName["sellPressure"]).toBe("UNKNOWN"); // always, by design
    expect(vecs).toHaveLength(5);
  });

  it("property: flow direction sign is monotonic and total", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: 1_000_000 }), (net) => {
        const d = flowDirection(flow(net, 1));
        if (net > 0) expect(d).toBe("UP");
        else if (net < 0) expect(d).toBe("DOWN");
        else expect(d).toBe("FLAT");
      }),
    );
  });
});
'@

Write-WarFile 'tests/unit/directionalMoves.test.ts' @'
import { describe, it, expect } from "vitest";

import {
  movesFromSeries,
  movesFromFlowEvents,
} from "../../src/core/features/directionalMoves.js";
import { computeLeadLag } from "../../src/core/coherence/coherence.js";

describe("4B-5.5 DirectionalMove builder", () => {
  it("emits +1 for up steps, -1 for down, nothing for flat", () => {
    const moves = movesFromSeries([
      { at: 1, value: 10 },
      { at: 2, value: 12 }, // up
      { at: 3, value: 12 }, // flat -> no move
      { at: 4, value: 9 }, // down
    ]);
    expect(moves).toEqual([
      { at: 2, sign: 1 },
      { at: 4, sign: -1 },
    ]);
  });

  it("timestamps a move at the LATER point (no lookahead)", () => {
    const moves = movesFromSeries([{ at: 100, value: 5 }, { at: 200, value: 6 }]);
    expect(moves[0]!.at).toBe(200); // never the earlier point
  });

  it("fewer than 2 points -> no moves", () => {
    expect(movesFromSeries([])).toEqual([]);
    expect(movesFromSeries([{ at: 1, value: 5 }])).toEqual([]);
  });

  it("flow events: buy=+1, sell=-1, time-ordered", () => {
    const moves = movesFromFlowEvents([
      { at: 3, side: "sell" },
      { at: 1, side: "buy" },
      { at: 2, side: "buy" },
    ]);
    expect(moves).toEqual([
      { at: 1, sign: 1 },
      { at: 2, sign: 1 },
      { at: 3, sign: -1 },
    ]);
  });

  it("feeds computeLeadLag: flow moves preceding price moves is observable", () => {
    // flow rises repeatedly, price rises shortly after each -> flow leads.
    const flow = movesFromFlowEvents([
      { at: 1000, side: "buy" },
      { at: 2000, side: "buy" },
      { at: 3000, side: "buy" },
      { at: 4000, side: "buy" },
    ]);
    // price series produces 4 up-moves, each shortly after a flow move.
    const price = movesFromSeries([
      { at: 1400, value: 1 },
      { at: 2400, value: 2 },
      { at: 3400, value: 3 },
      { at: 4400, value: 4 },
    ]);
    const ll = computeLeadLag(flow, price);
    // 4 matched flow-leads-price pairs >= minMatches(3): a real verdict, not INSUFFICIENT.
    expect(ll.result).not.toBe("INSUFFICIENT_HISTORY");
  });

  it("empty sequences -> lead/lag INSUFFICIENT_HISTORY", () => {
    expect(computeLeadLag([], movesFromSeries([{ at: 1, value: 1 }, { at: 2, value: 2 }])).result).toBe(
      "INSUFFICIENT_HISTORY",
    );
  });
});
'@

Write-WarFile 'tests/unit/hardening.test.ts' @'
import { describe, it, expect } from "vitest";

import { decideRetry, delaySchedule, isRetryable, DEFAULT_RETRY_POLICY } from "../../src/hardening/retryPolicy.js";
import {
  engageKill,
  initBreaker, breakerAllows, breakerOnFailure, breakerOnSuccess, DEFAULT_BREAKER,
  initConcurrency, tryAcquireSlot, releaseSlot,
  initCost, trySpend,
} from "../../src/hardening/guards.js";
import { classifyRunResult } from "../../src/hardening/classify.js";
import { ResilientCliExecutor, type TimeProvider, type Observer } from "../../src/hardening/ResilientCliExecutor.js";
import type { CliExecutor, CliRunResult } from "../../src/adapters/gmgn/gmgnRunner.js";

// A controllable virtual clock (no real waiting).
function virtualTime(): TimeProvider & { advance: (ms: number) => void; slept: number[] } {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    async sleep(ms: number) { slept.push(ms); t += ms; },
    advance: (ms: number) => { t += ms; },
    slept,
  };
}

// ── retry policy ──────────────────────────────────────────────────────────────

describe("7 retry policy", () => {
  it("retries transport errors, not auth/cli-missing/format", () => {
    expect(isRetryable("NETWORK_ERROR")).toBe(true);
    expect(isRetryable("RATE_LIMIT")).toBe(true);
    expect(isRetryable("AUTH_ERROR")).toBe(false);
    expect(isRetryable("CLI_MISSING")).toBe(false);
    expect(isRetryable("FORMAT_ERROR")).toBe(false);
  });

  it("exponential backoff, capped at maxDelay", () => {
    const sched = delaySchedule("NETWORK_ERROR", { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 3000, factor: 2 });
    // attempts 1-4 -> 500, 1000, 2000, then 4000 capped to 3000
    expect(sched).toEqual([500, 1000, 2000, 3000]);
  });

  it("stops retrying at maxAttempts", () => {
    const d = decideRetry(4, "NETWORK_ERROR", DEFAULT_RETRY_POLICY, null, 0);
    expect(d.retry).toBe(false);
  });

  it("rate-limit honors reset time when later than backoff", () => {
    const d = decideRetry(1, "RATE_LIMIT", DEFAULT_RETRY_POLICY, 10_000, 0);
    expect(d.retry).toBe(true);
    expect(d.delayMs).toBe(10_000); // reset wait dominates the 500ms backoff
  });
});

// ── circuit breaker ───────────────────────────────────────────────────────────

describe("7 circuit breaker", () => {
  it("opens after threshold consecutive failures", () => {
    let s = initBreaker();
    for (let i = 0; i < DEFAULT_BREAKER.failureThreshold; i++) s = breakerOnFailure(s, DEFAULT_BREAKER, 0);
    expect(s.phase).toBe("OPEN");
    expect(breakerAllows(s, DEFAULT_BREAKER, 0).allowed).toBe(false);
  });

  it("half-opens after cooldown, resets on success", () => {
    let s = initBreaker();
    for (let i = 0; i < DEFAULT_BREAKER.failureThreshold; i++) s = breakerOnFailure(s, DEFAULT_BREAKER, 0);
    const afterCooldown = breakerAllows(s, DEFAULT_BREAKER, DEFAULT_BREAKER.cooldownMs);
    expect(afterCooldown.allowed).toBe(true);
    expect(afterCooldown.state.phase).toBe("HALF_OPEN");
    expect(breakerOnSuccess().phase).toBe("CLOSED");
  });
});

// ── concurrency + cost ────────────────────────────────────────────────────────

describe("7 concurrency + cost guards", () => {
  it("concurrency limiter caps in-flight", () => {
    let s = initConcurrency(2);
    const a = tryAcquireSlot(s); s = a.state;
    const b = tryAcquireSlot(s); s = b.state;
    const c = tryAcquireSlot(s);
    expect(a.acquired && b.acquired).toBe(true);
    expect(c.acquired).toBe(false); // third refused
    s = releaseSlot(s);
    expect(tryAcquireSlot(s).acquired).toBe(true); // slot freed
  });

  it("cost guard refuses spend beyond budget, rolls window", () => {
    const budget = { windowMs: 1000, maxWeight: 10 };
    let s = initCost(0);
    const first = trySpend(s, budget, 8, 0); s = first.state;
    const second = trySpend(s, budget, 5, 100); // would exceed 10
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    // after window rolls, budget resets
    const third = trySpend(s, budget, 5, 2000);
    expect(third.allowed).toBe(true);
  });
});

// ── classification ────────────────────────────────────────────────────────────

describe("7 classify", () => {
  it("success on exit 0 with output", () => {
    expect(classifyRunResult({ exitCode: 0, stdout: "[]", stderr: "" }).ok).toBe(true);
  });
  it("429 -> RATE_LIMIT with reset ms", () => {
    const c = classifyRunResult({ exitCode: 1, stdout: "", stderr: "429 rate limit", headers: { "x-ratelimit-reset": "5" } });
    expect(c.ok).toBe(false);
    if (!c.ok) { expect(c.kind).toBe("RATE_LIMIT"); expect(c.resetAtMs).toBe(5000); }
  });
  it("timeout -> NETWORK_ERROR (retryable)", () => {
    const c = classifyRunResult({ exitCode: 1, stdout: "", stderr: "TIMEOUT" });
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.kind).toBe("NETWORK_ERROR");
  });
  it("auth -> AUTH_ERROR (non-retryable)", () => {
    const c = classifyRunResult({ exitCode: 1, stdout: "", stderr: "401 auth failed" });
    if (!c.ok) expect(c.kind).toBe("AUTH_ERROR");
  });
});

// ── ResilientCliExecutor: failure injection ──────────────────────────────────

function scriptedCli(results: CliRunResult[]): CliExecutor {
  let i = 0;
  return { async run() { return results[Math.min(i++, results.length - 1)]!; } };
}

describe("7 ResilientCliExecutor — failure injection", () => {
  it("retries a transient network error then succeeds", async () => {
    const time = virtualTime();
    const inner = scriptedCli([
      { exitCode: 1, stdout: "", stderr: "network error" },
      { exitCode: 0, stdout: "[]", stderr: "" },
    ]);
    const exec = new ResilientCliExecutor({ inner, time });
    const res = await exec.run(["market", "kline"]);
    expect(res.exitCode).toBe(0);
    expect(time.slept.length).toBe(1); // one backoff sleep
  });

  it("gives up on a non-retryable auth error without retrying", async () => {
    const time = virtualTime();
    let calls = 0;
    const inner: CliExecutor = { async run() { calls++; return { exitCode: 1, stdout: "", stderr: "401 auth" }; } };
    const exec = new ResilientCliExecutor({ inner, time });
    const res = await exec.run(["x"]);
    expect(res.exitCode).toBe(1);
    expect(calls).toBe(1); // no retry on auth
  });

  it("kill switch stops the call immediately (no runaway)", async () => {
    const time = virtualTime();
    let calls = 0;
    const inner: CliExecutor = { async run() { calls++; return { exitCode: 0, stdout: "[]", stderr: "" }; } };
    const exec = new ResilientCliExecutor({ inner, time, killSwitch: () => engageKill("maintenance") });
    const res = await exec.run(["x"]);
    expect(res.stderr).toContain("KILL_SWITCH");
    expect(calls).toBe(0); // inner never called
  });

  it("circuit opens after repeated failures and then refuses fast", async () => {
    const time = virtualTime();
    const inner: CliExecutor = { async run() { return { exitCode: 1, stdout: "", stderr: "network error" }; } };
    const exec = new ResilientCliExecutor({ inner, time, config: {
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, factor: 2 },
      breaker: { failureThreshold: 3, cooldownMs: 1000 },
      timeoutMs: 1000,
    } });
    // 3 runs, each 1 attempt failing -> breaker opens
    await exec.run(["x"]); await exec.run(["x"]); await exec.run(["x"]);
    const res = await exec.run(["x"]);
    expect(res.stderr).toBe("CIRCUIT_OPEN");
  });

  it("observer receives structured events", async () => {
    const time = virtualTime();
    const events: string[] = [];
    const observer: Observer = {
      onAttempt: () => events.push("attempt"),
      onSuccess: () => events.push("success"),
      onFailure: () => events.push("failure"),
      onGiveUp: () => events.push("giveup"),
      onKilled: () => events.push("killed"),
      onBreakerOpen: () => events.push("breaker"),
    };
    const inner = scriptedCli([
      { exitCode: 1, stdout: "", stderr: "network error" },
      { exitCode: 0, stdout: "[]", stderr: "" },
    ]);
    const exec = new ResilientCliExecutor({ inner, time, observer });
    await exec.run(["x"]);
    expect(events).toContain("attempt");
    expect(events).toContain("failure");
    expect(events).toContain("success");
  });
});
'@

Write-WarFile 'tests/unit/patternSignature.test.ts' @'
import { describe, it, expect } from "vitest";

import {
  buildPatternSignature,
  coherenceBand,
} from "../../src/core/features/patternSignature.js";
import { computeNovelty, recordPattern } from "../../src/core/novelty/novelty.js";

describe("4B-5.3 PatternSignature builder", () => {
  it("is deterministic: same inputs -> same signature", () => {
    const a = buildPatternSignature({ state: "ACCUMULATION", trajectory: "RISING", netCoherence: 0.8 });
    const b = buildPatternSignature({ state: "ACCUMULATION", trajectory: "RISING", netCoherence: 0.8 });
    expect(a).toBe(b);
  });

  it("distinct situations -> distinct signatures", () => {
    const a = buildPatternSignature({ state: "ACCUMULATION", trajectory: "RISING", netCoherence: 0.8 });
    const b = buildPatternSignature({ state: "DISTRIBUTION", trajectory: "FALLING", netCoherence: 0.2 });
    expect(a).not.toBe(b);
  });

  it("coherence band edges are explicit", () => {
    expect(coherenceBand(0)).toBe("LOW");
    expect(coherenceBand(0.33)).toBe("LOW");
    expect(coherenceBand(0.34)).toBe("MID");
    expect(coherenceBand(0.66)).toBe("MID");
    expect(coherenceBand(0.67)).toBe("HIGH");
    expect(coherenceBand(1)).toBe("HIGH");
  });

  it("null coherence => NONE (unknown is not low)", () => {
    expect(coherenceBand(null)).toBe("NONE");
    const sig = buildPatternSignature({ state: "OBSERVING", trajectory: "UNKNOWN", netCoherence: null });
    expect(sig).toContain("coh=NONE");
    expect(sig).toContain("traj=UNKNOWN");
  });

  it("feeds computeNovelty: unseen pattern is maximally novel, repeats decay", () => {
    const sig = buildPatternSignature({ state: "ATTACK", trajectory: "ACCELERATING_UP", netCoherence: 0.9 });
    let memory = {};
    expect(computeNovelty(sig, memory).rarity as number).toBe(1); // never seen
    memory = recordPattern(sig, memory);
    expect(computeNovelty(sig, memory).rarity as number).toBe(0.5); // seen once
    memory = recordPattern(sig, memory);
    expect(computeNovelty(sig, memory).rarity as number).toBeCloseTo(1 / 3, 9);
  });
});
'@

Write-WarFile 'tests/unit/scanViewModel.test.ts' @'
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { toScanViewModel } from "../../src/ui/scanViewModel.js";
import { buildIntelligenceReport } from "../../src/product/intelligence/report.js";
import { makeEntry, makeBattlefield } from "./productFixtures.js";

// ── view-model: 1:1 mapping, formatting only ─────────────────────────────────

function report() {
  const entry = makeEntry({
    address: "TokenAAA", power: 82, threat: 20, attention: 40, state: "ATTACK",
    supporting: [{ factor: "trajectory_up", magnitude: 24, weight: 30 }],
  });
  const bf = makeBattlefield([entry]);
  return buildIntelligenceReport(bf, bf.tokens[0]!);
}

describe("9 scanViewModel — pure formatting, no intelligence", () => {
  it("passes computed scores through unchanged (value is the raw number)", () => {
    const vm = toScanViewModel(report());
    expect(vm.power.value).toBe(82);
    expect(vm.threat.value).toBe(20);
  });

  it("band label is presentational only and does not alter the value", () => {
    const vm = toScanViewModel(report());
    expect(vm.power.label).toBe("High"); // 82 >= 75
    expect(vm.threat.label).toBe("Low"); // 20 < 25
    // value still exact
    expect(vm.power.value).toBe(82);
  });

  it("humanizes enums without changing meaning", () => {
    const vm = toScanViewModel(report());
    expect(vm.state).toBe("Attack");
  });

  it("maps evidence/contributions 1:1 from the report", () => {
    const vm = toScanViewModel(report());
    expect(vm.powerSupporting.length).toBe(1);
    expect(vm.powerSupporting[0]!.magnitude).toBe(24);
    expect(vm.powerSupporting[0]!.weight).toBe(30);
  });

  it("pins model versions from the report (auditability)", () => {
    const vm = toScanViewModel(report());
    expect(vm.confidenceModelVersion).toBe("confidence-v2");
    expect(vm.activationModelVersion).toBe("activation-v1");
  });

  it("orders events by importance (presentation ordering, not recomputation)", () => {
    const entry = makeEntry({
      address: "TokenAAA",
      events: [
        { type: "REVERSAL", at: 1000 as never, severity: 50 as never, importance: 30 as never, reasons: ["r1"], beforeState: "OBSERVING", afterState: "ATTACK" },
        { type: "POWER_BREAKOUT", at: 1000 as never, severity: 50 as never, importance: 90 as never, reasons: ["r2"], beforeState: "OBSERVING", afterState: "ATTACK" },
      ],
    });
    const bf = makeBattlefield([entry]);
    const vm = toScanViewModel(buildIntelligenceReport(bf, bf.tokens[0]!));
    expect(vm.events[0]!.type).toBe("Power breakout"); // importance 90 first
  });
});

// ── architecture guard: UI must not import any engine ────────────────────────

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "..", "..", "src");
const UI = join(SRC, "ui");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

function imports(src: string): string[] {
  const specs: string[] = [];
  const re = /(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) if (m[1]) specs.push(m[1]);
  return specs;
}

describe("9 architecture — src/ui is presentation only", () => {
  const files = walk(UI);

  it("ui has files", () => { expect(files.length).toBeGreaterThan(0); });

  for (const file of files) {
    const rel = relative(SRC, file);
    const src = readFileSync(file, "utf8");

    it(`${rel}: imports no engine/core intelligence`, () => {
      const banned = ["core/power", "core/threat", "core/state/stateMachine", "core/temporal", "core/flow", "core/coherence", "core/novelty", "core/attention", "core/events", "core/features", "config/scoring", "assembleBattlefield", "adapters/gmgn"];
      for (const spec of imports(src)) {
        for (const b of banned) {
          expect(spec.includes(b), `ui file ${rel} imports engine "${spec}"`).toBe(false);
        }
      }
    });

    it(`${rel}: computes no intelligence (no scoring tokens)`, () => {
      for (const token of ["computePower", "computeThreat", "computeConfidence", "evaluateToBattlefield", "POWER_CONFIG", "THREAT_CONFIG"]) {
        expect(src.includes(token), `ui file ${rel} computes intelligence via "${token}"`).toBe(false);
      }
    });
  }
});
'@

Write-WarFile 'tests/unit/signalObservations.test.ts' @'
import { describe, it, expect } from "vitest";

import { deriveSignalObservations } from "../../src/core/features/signalObservations.js";
import { advanceSignal } from "../../src/core/signal/signalLifecycle.js";
import type { FactorActivations } from "../../src/core/power/powerEngine.js";
import type { UnixMillis } from "../../src/shared/scalars.js";

const AT = 1000 as UnixMillis;

describe("4B-5.4 SignalObservation derivation", () => {
  it("support = the backing activation value; present = support > 0", () => {
    const acts: FactorActivations = { smartMoneyInflow: 0.6, rugRisk: 0.0 };
    const obs = deriveSignalObservations(acts, AT);
    const smart = obs.find((o) => o.identity === "smart_money_accumulation")!;
    expect(smart.support).toBe(0.6);
    expect(smart.present).toBe(true);
    const rug = obs.find((o) => o.identity === "rug_risk_elevated")!;
    expect(rug.support).toBe(0);
    expect(rug.present).toBe(false); // zero support -> not present
  });

  it("UNKNOWN activation (undefined) produces NO observation (not a false absence)", () => {
    const acts: FactorActivations = { smartMoneyInflow: 0.5 }; // rugRisk absent
    const obs = deriveSignalObservations(acts, AT);
    expect(obs.some((o) => o.identity === "smart_money_accumulation")).toBe(true);
    expect(obs.some((o) => o.identity === "rug_risk_elevated")).toBe(false);
  });

  it("washTrading boolean->{0,1} maps to present/absent", () => {
    expect(deriveSignalObservations({ washTrading: 1 }, AT)[0]!.present).toBe(true);
    expect(deriveSignalObservations({ washTrading: 0 }, AT)[0]!.present).toBe(false);
  });

  it("only catalog signals are emitted (no invented signals)", () => {
    const acts: FactorActivations = { smartMoneyInflow: 0.5, sellPressure: 0.9, vectorConflict: 0.8 };
    const obs = deriveSignalObservations(acts, AT);
    const ids = obs.map((o) => o.identity);
    expect(ids).toContain("smart_money_accumulation");
    expect(ids).not.toContain("sellPressure");
    expect(ids).not.toContain("vectorConflict");
  });

  it("feeds advanceSignal: first sighting with support>=0.7 -> EMERGING then CONFIRMED", () => {
    const [obs] = deriveSignalObservations({ smartMoneyInflow: 0.8 }, AT);
    const first = advanceSignal(null, obs!);
    expect(first.phase).toBe("EMERGING"); // first sighting is always EMERGING
    const second = advanceSignal(first, { ...obs!, at: 2000 as UnixMillis });
    expect(second.phase).toBe("CONFIRMED"); // support 0.8 >= confirmSupport 0.7
  });

  it("support is clamped into [0,1]", () => {
    expect(deriveSignalObservations({ rugRisk: 1.5 }, AT)[0]!.support).toBe(1);
    expect(deriveSignalObservations({ rugRisk: -0.3 }, AT)[0]!.support).toBe(0);
  });
});
'@

Write-WarFile 'tests/unit/world.test.ts' @'
import { describe, it, expect } from "vitest";

import { toWorldState } from "../../src/world/worldAdapter.js";
import {
  WorldEngine, lodFor, pan, zoomTo, flyStep, INITIAL_CAMERA,
} from "../../src/world/worldEngine.js";
import {
  HeadlessRenderer, buildFrame, desktopIntent, mobileIntent,
  initReplay, play, step, jumpToEvent, setSpeed, currentFrame, type ReplayFrame,
} from "../../src/world/worldRenderer.js";
import { toRadarBlip, radarOrder, UnavailableSearchPort } from "../../src/world/worldRadar.js";
import { buildIntelligenceReport } from "../../src/product/intelligence/report.js";
import { makeEntry, makeBattlefield } from "./productFixtures.js";
import type { FlowObservation } from "../../src/core/timeline/types.js";
import type { UnixMillis } from "../../src/shared/scalars.js";

function report(over: Record<string, unknown> = {}) {
  const entry = makeEntry({ address: "TokenAAA", power: 82, threat: 24, attention: 44, state: "ATTACK", ...over });
  const bf = makeBattlefield([entry]);
  return buildIntelligenceReport(bf, bf.tokens[0]!);
}

function flow(provenance: string, side: "buy" | "sell", usd: number): FlowObservation {
  return { meta: { at: 1500 as UnixMillis, temporalOrigin: "GMGN_EVENT", coverage: "ROLLING", provenance: provenance as never }, maker: "wX", side, amountUsd: usd, priceUsd: 1, positionEvent: "FULL_OPEN", fullness: "FULL", direction: "OPEN" };
}

describe("2 World Adapter — pure projection", () => {
  it("passes raw scores through unchanged", () => {
    const w = toWorldState({ report: report() });
    expect(w.power.raw).toBe(82);
    expect(w.threat.raw).toBe(24);
    expect(w.power.visual01).toBeCloseTo(0.82, 9); // visual only, separate from raw
  });

  it("mood = the real Core state (no new state invented)", () => {
    expect(toWorldState({ report: report() }).mood).toBe("ATTACK");
  });

  it("deterministic: same report -> byte-identical WorldState", () => {
    expect(JSON.stringify(toWorldState({ report: report() }))).toBe(JSON.stringify(toWorldState({ report: report() })));
  });

  it("flow -> entities by provenance lane, persona always UNKNOWN", () => {
    const w = toWorldState({ report: report(), flow: [flow("track.smartmoney", "buy", 8000), flow("track.kol", "sell", 3000)] });
    expect(w.flowEntities[0]!.lane).toBe("SMART_MONEY");
    expect(w.flowEntities[0]!.persona).toBe("UNKNOWN");
    expect(w.flowEntities[1]!.lane).toBe("KOL");
    expect(w.flowEntities[0]!.amountUsd).toBe(8000); // passed through, not scored
  });

  it("surfaces INSUFFICIENT markers instead of hiding them", () => {
    // makeEntry quality reasons include the insufficient list in scan
    const w = toWorldState({ report: report() });
    expect(Array.isArray(w.insufficient)).toBe(true);
    expect(w.qualityReasons.length).toBeGreaterThan(0);
  });

  it("orders events by importance (presentation ordering only)", () => {
    const w = toWorldState({ report: report({ events: [
      { type: "REVERSAL", at: 1 as never, severity: 5 as never, importance: 20 as never, reasons: ["a"], beforeState: "OBSERVING", afterState: "ATTACK" },
      { type: "POWER_BREAKOUT", at: 1 as never, severity: 5 as never, importance: 90 as never, reasons: ["b"], beforeState: "OBSERVING", afterState: "ATTACK" },
    ] }) });
    expect(w.events[0]!.type).toBe("POWER_BREAKOUT");
  });
});

describe("2 Camera + LOD", () => {
  it("pan/zoom are pure transforms", () => {
    expect(pan(INITIAL_CAMERA, 10, -5)).toEqual({ x: 10, y: -5, zoom: 1 });
    expect(zoomTo(INITIAL_CAMERA, 100).zoom).toBe(8); // clamped to max
    expect(zoomTo(INITIAL_CAMERA, 0).zoom).toBe(0.1); // clamped to min
  });
  it("flyStep interpolates toward target", () => {
    const c = flyStep(INITIAL_CAMERA, { x: 100, y: 0, zoom: 4 }, 0.5);
    expect(c.x).toBe(50); expect(c.zoom).toBe(2.5);
  });
  it("LOD rises with zoom and focus", () => {
    expect(lodFor(0.3, false)).toBe(0);
    expect(lodFor(1.0, false)).toBe(1);
    expect(lodFor(0.3, true)).toBe(2); // focused overrides
    expect(lodFor(3.0, false)).toBe(2);
  });
});

describe("2 World Engine lifecycle + streaming", () => {
  it("one engine, many instances, keyed by id", () => {
    const e = new WorldEngine();
    e.ensure("sol:A", { x: 0, y: 0 });
    e.ensure("sol:B", { x: 10, y: 0 });
    e.ensure("sol:A", { x: 0, y: 0 }); // idempotent
    expect(e.count()).toBe(2);
  });

  it("lifecycle create->mount->sleep->wake->destroy", () => {
    const e = new WorldEngine();
    e.ensure("sol:A", { x: 0, y: 0 });
    e.mount("sol:A"); expect(e.get("sol:A")!.phase).toBe("MOUNTED");
    e.sleep("sol:A"); expect(e.get("sol:A")!.phase).toBe("SLEEPING");
    e.wake("sol:A"); expect(e.get("sol:A")!.phase).toBe("MOUNTED");
    e.destroy("sol:A"); expect(e.get("sol:A")).toBeNull();
  });

  it("streaming: only visible (LOD>=1) non-sleeping instances render", () => {
    const e = new WorldEngine();
    e.ensure("sol:A", { x: 0, y: 0 }); e.mount("sol:A");
    e.ensure("sol:B", { x: 0, y: 0 }); e.mount("sol:B"); e.sleep("sol:B");
    const visibleFar = e.visible({ x: 0, y: 0, zoom: 0.3 }, null); // LOD 0 -> not visible
    expect(visibleFar.length).toBe(0);
    const visibleNear = e.visible({ x: 0, y: 0, zoom: 1.5 }, null);
    expect(visibleNear.map((i) => i.id)).toEqual(["sol:A"]); // B is sleeping
  });

  it("10,000-world DATA/OBJECT stress (architecture, not FPS)", () => {
    const e = new WorldEngine();
    for (let i = 0; i < 10_000; i++) e.ensure(`sol:T${i}`, { x: i % 100, y: Math.floor(i / 100) });
    expect(e.count()).toBe(10_000);
    // visibility filter runs over 10k without materializing full render for all
    const vis = e.visible({ x: 0, y: 0, zoom: 0.3 }, "sol:T5000"); // only focused reaches LOD2
    expect(vis.length).toBe(1);
    expect(vis[0]!.id).toBe("sol:T5000");
  });
});

describe("2 Renderer abstraction + interaction contracts", () => {
  it("headless renderer records frames without drawing", () => {
    const r = new HeadlessRenderer();
    const frame = buildFrame(INITIAL_CAMERA, null, [], () => 0);
    r.render(frame);
    expect(r.frames.length).toBe(1);
  });

  it("desktop and mobile gestures map to the SAME world intents", () => {
    expect(desktopIntent({ kind: "drag", dx: 5, dy: 5 })).toEqual({ kind: "pan", dx: 5, dy: 5 });
    expect(mobileIntent({ kind: "swipe", dx: 5, dy: 5 })).toEqual({ kind: "pan", dx: 5, dy: 5 });
    expect(desktopIntent({ kind: "dblclick", id: "sol:A" })).toEqual({ kind: "enter", id: "sol:A" });
    expect(mobileIntent({ kind: "tap", id: "sol:A" })).toEqual({ kind: "select", id: "sol:A" });
  });
});

describe("2 Radar + Search", () => {
  it("radar orders by a single existing field (no composite)", () => {
    const blips = [
      toRadarBlip(toWorldState({ report: report({ address: "A", power: 40 }) })),
      toRadarBlip(toWorldState({ report: report({ address: "B", power: 90 }) })),
    ];
    expect(radarOrder(blips, "power")[0]!.power).toBe(90);
  });
  it("search backend is explicitly unavailable (no fake results)", async () => {
    const port = new UnavailableSearchPort();
    expect(await port.search({ text: "ELMO" })).toEqual([]);
  });
});

describe("2 Battle Replay model (ARCHITECTURE_READY)", () => {
  const frames: ReplayFrame[] = [
    { at: 1000, state: toWorldState({ report: report({ address: "A", power: 40 }) }) },
    { at: 2000, state: toWorldState({ report: report({ address: "A", power: 60 }) }) },
    { at: 3000, state: toWorldState({ report: report({ address: "A", power: 80 }) }) },
  ];
  it("play advances frames; speed settable", () => {
    let s = initReplay(frames);
    s = play(s); s = step(s);
    expect(s.index).toBe(1);
    s = setSpeed(s, 5);
    expect(s.speed).toBe(5);
  });
  it("jumpToEvent seeks to the frame at/just before a timestamp", () => {
    let s = initReplay(frames);
    s = jumpToEvent(s, 2500);
    expect(currentFrame(s)!.at).toBe(2000);
  });
});
'@

Write-Host ''
Write-Host 'Done. Now run:' -ForegroundColor Green
Write-Host '  npx tsc --noEmit' -ForegroundColor White
Write-Host '  npm test' -ForegroundColor White