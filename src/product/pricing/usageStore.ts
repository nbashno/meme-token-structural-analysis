/**
 * WAR Product Layer — durable daily usage quota store (calendar-day, UTC).
 *
 * This is the async, persistent counterpart to the in-memory `UsageLimiter`.
 * It enforces a per-user, per-UTC-day cap on scans and new monitors. Chosen
 * model: calendar-day counters (reset at UTC midnight), which are the cheapest
 * to store — one row per user per day, two integers — and the clearest for
 * users ("your free quota resets daily").
 *
 * Deterministic: every method takes an explicit `nowMs`. The "day" is derived
 * from nowMs as a UTC date string (YYYY-MM-DD). No ambient clock.
 *
 * A null cap means unlimited (COMMAND tier) — check() short-circuits to allow.
 */

import type { UserId } from "../domain/identity.js";

export type UsageKind = "scan" | "monitor";

export interface UsageVerdict {
  readonly allowed: boolean;
  /** Remaining today after this check (only meaningful when allowed). null = unlimited. */
  readonly remaining: number | null;
  /** Epoch-ms of the next UTC midnight, when the quota resets (if blocked). */
  readonly retryAtMs: number | null;
}

export interface UsageStore {
  /** Check (without consuming) whether the user may perform `kind` today. */
  check(userId: UserId, kind: UsageKind, cap: number | null, nowMs: number): Promise<UsageVerdict>;
  /** Record one performed action (call only after a successful op). */
  record(userId: UserId, kind: UsageKind, nowMs: number): Promise<void>;
  /** How many of `kind` the user has used today (UTC). */
  used(userId: UserId, kind: UsageKind, nowMs: number): Promise<number>;
}

/** UTC calendar-day key (YYYY-MM-DD) for a given epoch-ms. */
export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Epoch-ms of the next UTC midnight strictly after nowMs (the reset boundary). */
export function nextUtcMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

// -- In-memory implementation (tests + fallback when no DATABASE_URL) ---------
interface DayRow { day: string; scans: number; monitors: number; }

export class InMemoryUsageStore implements UsageStore {
  private readonly rows = new Map<UserId, DayRow>();

  private current(userId: UserId, nowMs: number): DayRow {
    const day = utcDay(nowMs);
    let r = this.rows.get(userId);
    if (!r || r.day !== day) { r = { day, scans: 0, monitors: 0 }; this.rows.set(userId, r); }
    return r;
  }

  async check(userId: UserId, kind: UsageKind, cap: number | null, nowMs: number): Promise<UsageVerdict> {
    if (cap === null) return { allowed: true, remaining: null, retryAtMs: null };
    const r = this.current(userId, nowMs);
    const usedN = kind === "scan" ? r.scans : r.monitors;
    if (usedN < cap) return { allowed: true, remaining: cap - usedN - 1, retryAtMs: null };
    return { allowed: false, remaining: 0, retryAtMs: nextUtcMidnight(nowMs) };
  }

  async record(userId: UserId, kind: UsageKind, nowMs: number): Promise<void> {
    const r = this.current(userId, nowMs);
    if (kind === "scan") r.scans += 1; else r.monitors += 1;
  }

  async used(userId: UserId, kind: UsageKind, nowMs: number): Promise<number> {
    const r = this.current(userId, nowMs);
    return kind === "scan" ? r.scans : r.monitors;
  }
}
