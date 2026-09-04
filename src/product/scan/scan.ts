/**
 * WAR Product Layer - Phase 1 - Scan lifecycle (domain only).
 *
 * A Scan is a paid, one-time intelligence request. Phase 1 defines the lifecycle
 * state machine + records. It does NOT perform GMGN acquisition or call the Core
 * runner (that orchestration is spec Phase 3). Here we guarantee the lifecycle
 * transitions and the transactional rule:
 *
 *   a valid paid Scan that FAILS before a meaningful WAR result must not
 *   silently consume the entitlement (spec sec.28).
 *
 * States: RESERVED -> EXECUTING -> COMPLETED | FAILED (-> REFUNDED).
 */

import type { UserId, TokenId, DomainResult } from "../domain/identity.js";
import { ok, err } from "../domain/identity.js";

export type ScanStatus =
  | "RESERVED"
  | "EXECUTING"
  | "COMPLETED"
  | "FAILED"
  | "REFUNDED";

export interface ScanRequest {
  readonly id: string;
  readonly userId: UserId;
  readonly token: TokenId;
  readonly entitlementId: string;
  readonly requestedAt: number; // UnixMillis
}

/** One execution attempt. Carries the version stamp of the produced result. */
export interface ScanExecution {
  readonly id: string;
  readonly requestId: string;
  readonly status: ScanStatus;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  /** Set only when COMPLETED - a reference to the persisted IntelligenceReport. */
  readonly reportRef: string | null;
  readonly failureReason: string | null;
}

const ALLOWED: Readonly<Record<ScanStatus, readonly ScanStatus[]>> = {
  RESERVED: ["EXECUTING", "FAILED"],
  EXECUTING: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  FAILED: ["REFUNDED"],
  REFUNDED: [],
};

export function canTransition(from: ScanStatus, to: ScanStatus): boolean {
  return ALLOWED[from].includes(to);
}

export function newExecution(id: string, requestId: string, atMs: number): ScanExecution {
  return {
    id,
    requestId,
    status: "RESERVED",
    startedAt: atMs,
    finishedAt: null,
    reportRef: null,
    failureReason: null,
  };
}

export function beginExecuting(exec: ScanExecution): DomainResult<ScanExecution> {
  if (!canTransition(exec.status, "EXECUTING")) {
    return err(`cannot EXECUTING from ${exec.status}`);
  }
  return ok({ ...exec, status: "EXECUTING" });
}

export function complete(
  exec: ScanExecution,
  reportRef: string,
  atMs: number,
): DomainResult<ScanExecution> {
  if (!canTransition(exec.status, "COMPLETED")) {
    return err(`cannot COMPLETE from ${exec.status}`);
  }
  return ok({ ...exec, status: "COMPLETED", finishedAt: atMs, reportRef });
}

export function fail(
  exec: ScanExecution,
  reason: string,
  atMs: number,
): DomainResult<ScanExecution> {
  if (!canTransition(exec.status, "FAILED")) {
    return err(`cannot FAIL from ${exec.status}`);
  }
  return ok({ ...exec, status: "FAILED", finishedAt: atMs, failureReason: reason });
}

export function refund(exec: ScanExecution): DomainResult<ScanExecution> {
  if (!canTransition(exec.status, "REFUNDED")) {
    return err(`cannot REFUND from ${exec.status}`);
  }
  return ok({ ...exec, status: "REFUNDED" });
}

/** True when the entitlement should be released back (failure path). */
export function shouldReleaseEntitlement(exec: ScanExecution): boolean {
  return exec.status === "FAILED" || exec.status === "REFUNDED";
}
