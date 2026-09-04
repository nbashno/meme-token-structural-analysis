/**
 * WAR Product Layer — per-user usage limiter.
 *
 * Enforces a rolling-24h cap on how many scans / new monitors a single user may
 * run, based on their tier's TierLimits. This protects scarce free-tier
 * resources (host CPU, GMGN quota) from being drained by any one account — and
 * it applies ALWAYS, including during the launch free window (a free scan is
 * still a real resource cost).
 *
 * Deterministic: every check takes an explicit `nowMs`; counts are timestamps
 * pruned against a 24h window. No ambient clock, no intelligence.
 *
 * COMMAND (null caps) is unlimited — the limiter short-circuits to allow.
 */

import type { UserId } from "../domain/identity.js";

export type UsageKind = "scan" | "monitor";

const DAY_MS = 24 * 60 * 60 * 1000;

interface UserUsage {
  scans: number[];    // timestamps (ms) of scans in window
  monitors: number[]; // timestamps (ms) of monitor starts in window
}

export interface UsageVerdict {
  readonly allowed: boolean;
  /** Remaining in the window after this check (only meaningful when allowed). */
  readonly remaining: number | null; // null = unlimited
  /** When the oldest counted action falls out of the window (ms), if blocked. */
  readonly retryAtMs: number | null;
}

export class UsageLimiter {
  private readonly usage = new Map<UserId, UserUsage>();

  private bucket(userId: UserId): UserUsage {
    let u = this.usage.get(userId);
    if (!u) { u = { scans: [], monitors: [] }; this.usage.set(userId, u); }
    return u;
  }

  private prune(list: number[], nowMs: number): void {
    const cutoff = nowMs - DAY_MS;
    // Drop timestamps older than the window (in place, from the front).
    let i = 0;
    while (i < list.length && list[i]! <= cutoff) i++;
    if (i > 0) list.splice(0, i);
  }

  /**
   * Check (without consuming) whether the user may perform `kind` now, given
   * their tier cap (null = unlimited).
   */
  check(userId: UserId, kind: UsageKind, cap: number | null, nowMs: number): UsageVerdict {
    if (cap === null) return { allowed: true, remaining: null, retryAtMs: null };
    const u = this.bucket(userId);
    const list = kind === "scan" ? u.scans : u.monitors;
    this.prune(list, nowMs);
    if (list.length < cap) {
      return { allowed: true, remaining: cap - list.length - 1, retryAtMs: null };
    }
    // Blocked: the oldest action must age out of the window before another fits.
    const retryAtMs = (list[0] ?? nowMs) + DAY_MS;
    return { allowed: false, remaining: 0, retryAtMs };
  }

  /**
   * Record a performed action (call only after a successful, charged/free op).
   * Keeps the window pruned.
   */
  record(userId: UserId, kind: UsageKind, nowMs: number): void {
    const u = this.bucket(userId);
    const list = kind === "scan" ? u.scans : u.monitors;
    list.push(nowMs);
    this.prune(list, nowMs);
  }

  /** How many of `kind` the user has used in the current window. */
  used(userId: UserId, kind: UsageKind, nowMs: number): number {
    const u = this.usage.get(userId);
    if (!u) return 0;
    const list = kind === "scan" ? u.scans : u.monitors;
    this.prune(list, nowMs);
    return list.length;
  }
}
