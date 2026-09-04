/**
 * WAR Product Layer - Phase 3 - Scan Orchestration.
 *
 * Implements the literal, billable scan path:
 *
 *   Payment verified -> Entitlement issued -> Scan reserved -> GMGN acquisition
 *   -> Normalization -> WAR Core -> IntelligenceReport -> Evidence + WHY_NOW
 *   -> Persist snapshot -> Consume entitlement -> Return result
 *
 * The $0.10 buys a WAR result built live on GMGN data, not GMGN data.
 *
 * Enforced conditions (spec Phase 3):
 *   1. No raw GMGN in product      - acquisition returns normalized observations.
 *   2. No intelligence recompute   - evaluation goes through WarEvaluationPort.
 *   3. No consume before result    - entitlement consumed only after a meaningful
 *                                    WAR result + persisted snapshot.
 *   4. GMGN/WAR failure => FAILED, entitlement NOT consumed.
 *   5. Retry is idempotent         - a completed request returns the same snapshot.
 *   6. One scan_request_id => at most one paid result.
 *   7. Every result carries engineVersion/modelVersions/generatedAt/evidence/
 *      whyNow/provenance.
 *   8. Cache is not memory (no cache here; snapshots are product memory).
 *   9. Acquire only what the report needs (single-token, demand-driven).
 *  10. No UI/Telegram - ports are injected.
 */

import type { ModelVersions } from "../../../shared/quality.js";
import type { BattlefieldState, TokenBattlefieldEntry } from "../../../core/battlefield/types.js";
import type { UserId, TokenId, Clock, DomainResult } from "../../domain/identity.js";
import { ok, err } from "../../domain/identity.js";
import type { UnitOfWork } from "../../persistence/contracts/repositories.js";
import type {
  IntelligenceSnapshotRow,
  EvidenceRow,
  EventRow,
  SignalTransitionRow,
} from "../../persistence/contracts/repositories.js";
import type { EntitlementLedger as EntitlementLedgerType } from "../../payment/entitlement.js";
import {
  buildIntelligenceReport,
  aggregateEvidence,
  type IntelligenceReport,
} from "../../intelligence/report.js";
import type { GmgnAcquisitionPort, WarEvaluationPort } from "../ports/ports.js";
import { hasMeaningfulResult } from "../ports/ports.js";
import * as Scan from "../scan.js";

export interface ScanServiceDeps {
  readonly uow: UnitOfWork;
  readonly acquisition: GmgnAcquisitionPort;
  readonly evaluation: WarEvaluationPort;
  readonly clock: Clock;
  /** The entitlement ledger enforcing single consumption + release on failure. */
  readonly entitlements: EntitlementLedgerType;
  readonly engineVersion: string;
  readonly modelVersions: ModelVersions;
}

export interface ScanInput {
  readonly requestId: string; // idempotency anchor for the whole scan
  readonly userId: UserId;
  readonly token: TokenId;
  readonly entitlementId: string;
}

export interface ScanResult {
  readonly requestId: string;
  readonly snapshotId: string;
  readonly report: IntelligenceReport;
  readonly reused: boolean; // true if an existing completed result was returned
}

export class ScanService {
  constructor(private readonly deps: ScanServiceDeps) {}

  /**
   * Execute a scan. Idempotent by requestId: a completed execution returns its
   * existing snapshot (condition 5/6); a failed one can be retried cleanly.
   */
  async execute(input: ScanInput): Promise<DomainResult<ScanResult>> {
    const { uow, acquisition, evaluation, clock } = this.deps;
    const now = clock.now();

    // -- Idempotency gate: has this request already completed? ----------------
    const priorExec = await uow.repos.scans.getExecution(execId(input.requestId));
    if (priorExec && priorExec.status === "COMPLETED" && priorExec.reportRef) {
      const snap = await uow.repos.intelligence.getSnapshot(priorExec.reportRef);
      if (snap) {
        return ok({
          requestId: input.requestId,
          snapshotId: priorExec.reportRef,
          report: snap.report,
          reused: true, // condition 5/6: no second paid result
        });
      }
    }

    // -- Reserve: persist request + execution in RESERVED --------------------
    // Consume the entitlement as a RESERVATION now (atomic), but we will RELEASE
    // it if we fail before a meaningful result (condition 3/4). The usage row is
    // the single-consumption guard (condition 6).
    const reserve = await this.reserve(input, now);
    if (!reserve.ok) return err(reserve.error);
    let exec = reserve.value;

    // -- Acquire (GMGN, normalized at the boundary) --------------------------
    exec = await this.mark(exec, (e) => Scan.beginExecuting(e), now);
    const acq = await acquisition.acquire(input.token.chain, input.token.address, now);
    if (!acq.ok) {
      return this.failAndRelease(input, exec, `acquisition failed: ${acq.error}`, now);
    }

    // -- Evaluate (WAR core via port; no product-side intelligence) ----------
    const evalRes = await evaluation.evaluate(acq.value, now);
    if (!evalRes.ok) {
      return this.failAndRelease(input, exec, `evaluation failed: ${evalRes.error}`, now);
    }
    const battlefield = evalRes.value;

    // -- Meaningful-result gate (condition 3) --------------------------------
    if (!hasMeaningfulResult(battlefield, input.token.address)) {
      return this.failAndRelease(input, exec, "no meaningful WAR result for token", now);
    }
    const entry = battlefield.tokens.find((t) => t.address === input.token.address)!;

    // -- Build report + evidence + whyNow (condition 7) ----------------------
    const report = buildIntelligenceReport(battlefield, entry);
    const snapshotId = snapId(input.requestId);

    // -- Persist snapshot + evidence + events + signal transitions -----------
    // then COMPLETE the execution and finalize consumption - all atomically.
    try {
      await uow.transaction(async (repos) => {
        await repos.engineVersions.record(this.deps.engineVersion, this.deps.modelVersions);
        await repos.tokens.ensure(input.token.chain, input.token.address);

        const snapRow = this.snapshotRow(snapshotId, input.token, battlefield, report, now);
        await repos.intelligence.saveSnapshot(snapRow);
        await repos.intelligence.saveEvidence(this.evidenceRows(snapshotId, entry));
        await repos.intelligence.saveEvents(this.eventRows(snapshotId, input.token, entry));
        for (const tr of this.signalRows(input.token, entry)) {
          await repos.intelligence.saveSignalTransition(tr);
        }

        const completed = Scan.complete(exec, snapshotId, this.deps.clock.now());
        if (!completed.ok) throw new Error(completed.error);
        await repos.scans.updateExecution(completed.value);
        // Finalize entitlement status (usage row already written at reserve).
        await repos.entitlements.updateStatus(input.entitlementId, "CONSUMED");
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return this.failAndRelease(input, exec, `persist failed: ${reason}`, now);
    }

    return ok({ requestId: input.requestId, snapshotId, report, reused: false });
  }

  // -- helpers ---------------------------------------------------------------

  /** Reserve request+execution and consume the entitlement as a reservation. */
  private async reserve(input: ScanInput, now: number): Promise<DomainResult<Scan.ScanExecution>> {
    const { uow, entitlements } = this.deps;

    // Ledger-level single-consumption guard (condition 6) BEFORE any work.
    const consumed = entitlements.consume(input.entitlementId, input.userId, execId(input.requestId), now);
    if (!consumed.ok) return err(`entitlement not consumable: ${consumed.error}`);

    const exec = Scan.newExecution(execId(input.requestId), input.requestId, now);
    try {
      await uow.transaction(async (repos) => {
        await repos.tokens.ensure(input.token.chain, input.token.address);
        await repos.scans.createRequest({
          id: input.requestId, userId: input.userId, token: input.token,
          entitlementId: input.entitlementId, requestedAt: now,
        });
        await repos.scans.createExecution(exec);
        // Mirror the ledger consumption into the usage table (single-row PK).
        await repos.usage.consume({
          entitlementId: input.entitlementId, userId: input.userId,
          consumedAt: now, capabilityRef: execId(input.requestId),
        });
      });
    } catch (e) {
      // Roll the ledger reservation back so a retry is clean (condition 4/5).
      entitlements.releaseIfUnused(input.entitlementId);
      const reason = e instanceof Error ? e.message : String(e);
      return err(`reserve failed: ${reason}`);
    }
    return ok(exec);
  }

  private async mark(
    exec: Scan.ScanExecution,
    fn: (e: Scan.ScanExecution) => DomainResult<Scan.ScanExecution>,
    _now: number,
  ): Promise<Scan.ScanExecution> {
    const r = fn(exec);
    if (!r.ok) return exec;
    await this.deps.uow.repos.scans.updateExecution(r.value);
    return r.value;
  }

  /** Mark FAILED and RELEASE the entitlement (condition 3/4). */
  private async failAndRelease(
    input: ScanInput,
    exec: Scan.ScanExecution,
    reason: string,
    now: number,
  ): Promise<DomainResult<ScanResult>> {
    const { uow, entitlements } = this.deps;
    const failed = Scan.fail(exec.status === "RESERVED" ? exec : exec, reason, now);
    await uow.transaction(async (repos) => {
      if (failed.ok) await repos.scans.updateExecution(failed.value);
      // release both ledger + usage row + entitlement status
      await repos.usage.release(input.entitlementId);
      await repos.entitlements.updateStatus(input.entitlementId, "ISSUED");
    });
    entitlements.releaseIfUnused(input.entitlementId);
    return err(reason);
  }

  private snapshotRow(
    id: string,
    token: TokenId,
    battlefield: BattlefieldState,
    report: IntelligenceReport,
    now: number,
  ): IntelligenceSnapshotRow {
    return {
      id, token, sessionId: null,
      generatedAt: battlefield.generatedAt as unknown as number,
      report,
      engineVersion: this.deps.engineVersion,
      modelVersions: this.deps.modelVersions,
      source: "SCAN",
      createdAt: now,
    };
  }

  private evidenceRows(snapshotId: string, entry: TokenBattlefieldEntry): readonly EvidenceRow[] {
    return aggregateEvidence(entry).map((e, i) => ({
      snapshotId, kind: e.kind, factor: e.factor,
      magnitude: e.magnitude, weight: e.weight, note: e.note, ordinal: i,
    }));
  }

  private eventRows(snapshotId: string, token: TokenId, entry: TokenBattlefieldEntry): readonly EventRow[] {
    return entry.events.map((ev) => ({
      tokenId: token, snapshotId, sessionId: null,
      type: ev.type, at: ev.at as unknown as number,
      severity: ev.severity as unknown as number,
      importance: ev.importance as unknown as number,
      reasons: ev.reasons, beforeState: ev.beforeState, afterState: ev.afterState,
    }));
  }

  private signalRows(token: TokenId, entry: TokenBattlefieldEntry): readonly SignalTransitionRow[] {
    // On a one-shot scan, every observed signal's current phase is recorded as a
    // transition into that phase (fromPhase null - first sighting in this scan).
    return entry.signals.map((s) => ({
      tokenId: token, sessionId: null, signalIdentity: s.identity,
      fromPhase: null, toPhase: s.phase, at: s.lastUpdatedAt as unknown as number,
      reasons: s.reasons,
    }));
  }
}

// Deterministic ids derived from requestId (idempotency, conditions 5/6).
function execId(requestId: string): string {
  return `exec:${requestId}`;
}
function snapId(requestId: string): string {
  return `snap:${requestId}`;
}
