/**
 * WAR Product Layer - Phase 1 - Monitoring session lifecycle (domain only).
 *
 * Monitoring answers "what happens to this token while WAR watches it" over a
 * paid window (24h). Phase 1 defines the session record + lifecycle + expiry.
 * It does NOT run the scheduler or acquire from GMGN (spec Phase 4). Expiry is
 * computed against an INJECTED clock, never Date.now.
 *
 * States: PENDING -> ACTIVE -> PAUSED <-> ACTIVE, and -> EXPIRED | CANCELLED | FAILED.
 * Invariant (spec sec.62): an expired monitor performs NO new acquisition.
 */

import type { Chain } from "../../shared/scalars.js";
import type { UserId, TokenId, DomainResult } from "../domain/identity.js";
import { ok, err } from "../domain/identity.js";

export type MonitorStatus =
  | "PENDING"
  | "ACTIVE"
  | "PAUSED"
  | "EXPIRED"
  | "CANCELLED"
  | "FAILED";

export interface MonitoringSession {
  readonly id: string;
  readonly userId: UserId;
  readonly token: TokenId;
  readonly chain: Chain;
  readonly startedAt: number; // UnixMillis
  readonly expiresAt: number; // UnixMillis (startedAt + granted duration)
  readonly status: MonitorStatus;
  readonly pricingVersion: string;
  readonly entitlementId: string;
  /** Last-observed markers, used by the scheduler for change-aware persistence. */
  readonly lastObservationAt: number | null;
  readonly lastBattlefieldStateAt: number | null;
  readonly lastEventAt: number | null;
}

const ALLOWED: Readonly<Record<MonitorStatus, readonly MonitorStatus[]>> = {
  PENDING: ["ACTIVE", "CANCELLED", "FAILED"],
  ACTIVE: ["PAUSED", "EXPIRED", "CANCELLED", "FAILED"],
  PAUSED: ["ACTIVE", "EXPIRED", "CANCELLED", "FAILED"],
  EXPIRED: [],
  CANCELLED: [],
  FAILED: [],
};

export function canTransition(from: MonitorStatus, to: MonitorStatus): boolean {
  return ALLOWED[from].includes(to);
}

export interface CreateSessionArgs {
  readonly id: string;
  readonly userId: UserId;
  readonly token: TokenId;
  readonly entitlementId: string;
  readonly pricingVersion: string;
  readonly startedAt: number;
  readonly durationMs: number;
}

export function createSession(a: CreateSessionArgs): MonitoringSession {
  return {
    id: a.id,
    userId: a.userId,
    token: a.token,
    chain: a.token.chain,
    startedAt: a.startedAt,
    expiresAt: a.startedAt + a.durationMs,
    status: "PENDING",
    pricingVersion: a.pricingVersion,
    entitlementId: a.entitlementId,
    lastObservationAt: null,
    lastBattlefieldStateAt: null,
    lastEventAt: null,
  };
}

export function activate(s: MonitoringSession): DomainResult<MonitoringSession> {
  if (!canTransition(s.status, "ACTIVE")) return err(`cannot ACTIVE from ${s.status}`);
  return ok({ ...s, status: "ACTIVE" });
}

export function pause(s: MonitoringSession): DomainResult<MonitoringSession> {
  if (!canTransition(s.status, "PAUSED")) return err(`cannot PAUSE from ${s.status}`);
  return ok({ ...s, status: "PAUSED" });
}

export function cancel(s: MonitoringSession): DomainResult<MonitoringSession> {
  if (!canTransition(s.status, "CANCELLED")) return err(`cannot CANCEL from ${s.status}`);
  return ok({ ...s, status: "CANCELLED" });
}

/**
 * Expire the session IF the injected clock is at/after expiresAt. Returns the
 * session unchanged (ok) if not yet due, an expired session if due, or an error
 * if the current status cannot expire.
 */
export function expireIfDue(s: MonitoringSession, nowMs: number): DomainResult<MonitoringSession> {
  if (nowMs < s.expiresAt) return ok(s);
  if (!canTransition(s.status, "EXPIRED")) {
    // Terminal states are simply left as-is.
    if (s.status === "EXPIRED" || s.status === "CANCELLED" || s.status === "FAILED") return ok(s);
    return err(`cannot EXPIRE from ${s.status}`);
  }
  return ok({ ...s, status: "EXPIRED" });
}

/** The scheduler MUST consult this before any acquisition. */
export function isAcquisitionAllowed(s: MonitoringSession, nowMs: number): boolean {
  return s.status === "ACTIVE" && nowMs < s.expiresAt;
}

export function timeRemainingMs(s: MonitoringSession, nowMs: number): number {
  return Math.max(0, s.expiresAt - nowMs);
}
