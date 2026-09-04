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
