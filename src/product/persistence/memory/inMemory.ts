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
