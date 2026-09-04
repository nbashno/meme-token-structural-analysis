/**
 * WAR Product Layer - Phase 1 - Entitlements + Usage Ledger.
 *
 * Critical invariants (spec sec.26, sec.27, sec.62):
 *   - 1 verified payment  => exactly 1 entitlement (idempotent by providerTxId).
 *   - 1 TOKEN_SCAN entitlement => at most 1 successful scan (single consumption).
 *   - A failed capability run must NOT silently consume the entitlement.
 *
 * All state is threaded explicitly; no ambient IO. This module is the source of
 * truth for "what has this user paid for, and has it been used".
 */

import type { UserId, DomainResult } from "../domain/identity.js";
import { ok, err } from "../domain/identity.js";
import type { EntitlementType } from "../pricing/pricing.js";
import type { VerifiedPayment } from "./payment.js";

export type EntitlementStatus = "ISSUED" | "CONSUMED" | "REFUNDED";

export interface Entitlement {
  readonly id: string; // deterministic: derived from providerTxId
  readonly userId: UserId;
  readonly type: EntitlementType;
  readonly providerTxId: string; // idempotency anchor
  readonly issuedAt: number; // UnixMillis
  readonly status: EntitlementStatus;
  /** For monitor entitlements, the window granted (ms). Scans leave this null. */
  readonly grantsDurationMs: number | null;
}

/** A single, immutable usage record - one per successful consumption. */
export interface UsageRecord {
  readonly entitlementId: string;
  readonly userId: UserId;
  readonly consumedAt: number; // UnixMillis
  readonly capabilityRef: string; // e.g. scanExecutionId / monitorSessionId
}

/**
 * Deterministic id for an entitlement derived from its payment. Because it is a
 * pure function of providerTxId, re-processing the same payment maps to the same
 * entitlement id - which is what makes issuance idempotent.
 */
export function entitlementIdFor(providerTxId: string): string {
  return `ent:${providerTxId}`;
}

export class EntitlementLedger {
  private readonly entitlements = new Map<string, Entitlement>();
  private readonly usage = new Map<string, UsageRecord>(); // key = entitlementId

  /**
   * Issue an entitlement from a verified payment. Idempotent: calling twice with
   * the same providerTxId returns the SAME entitlement, never a second one.
   */
  issueFrom(
    payment: VerifiedPayment,
    userId: UserId,
    type: EntitlementType,
    grantsDurationMs: number | null,
  ): DomainResult<Entitlement> {
    const id = entitlementIdFor(payment.providerTxId);
    const existing = this.entitlements.get(id);
    if (existing) return ok(existing); // <-- idempotency guarantee

    const ent: Entitlement = {
      id,
      userId,
      type,
      providerTxId: payment.providerTxId,
      issuedAt: payment.verifiedAt,
      status: "ISSUED",
      grantsDurationMs,
    };
    this.entitlements.set(id, ent);
    return ok(ent);
  }

  get(id: string): Entitlement | undefined {
    return this.entitlements.get(id);
  }

  /**
   * Reserve-and-consume for a capability run. Returns a usage record on success.
   * Refuses if the entitlement is missing, already consumed, refunded, or owned
   * by another user. This is the single-consumption gate.
   */
  consume(
    entitlementId: string,
    userId: UserId,
    capabilityRef: string,
    atMs: number,
  ): DomainResult<UsageRecord> {
    const ent = this.entitlements.get(entitlementId);
    if (!ent) return err(`no such entitlement ${entitlementId}`);
    if (ent.userId !== userId) return err(`entitlement ${entitlementId} not owned by user`);
    if (ent.status === "REFUNDED") return err(`entitlement ${entitlementId} refunded`);
    if (ent.status === "CONSUMED" || this.usage.has(entitlementId)) {
      return err(`entitlement ${entitlementId} already consumed`);
    }
    const record: UsageRecord = { entitlementId, userId, consumedAt: atMs, capabilityRef };
    this.usage.set(entitlementId, record);
    this.entitlements.set(entitlementId, { ...ent, status: "CONSUMED" });
    return ok(record);
  }

  /** Roll back a consumption if the capability failed before a meaningful result. */
  releaseIfUnused(entitlementId: string): DomainResult<Entitlement> {
    const ent = this.entitlements.get(entitlementId);
    if (!ent) return err(`no such entitlement ${entitlementId}`);
    if (ent.status !== "CONSUMED") return ok(ent); // nothing to release
    this.usage.delete(entitlementId);
    const restored: Entitlement = { ...ent, status: "ISSUED" };
    this.entitlements.set(entitlementId, restored);
    return ok(restored);
  }

  usageFor(entitlementId: string): UsageRecord | undefined {
    return this.usage.get(entitlementId);
  }
}
