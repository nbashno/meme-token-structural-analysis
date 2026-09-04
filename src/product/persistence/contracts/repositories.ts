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
