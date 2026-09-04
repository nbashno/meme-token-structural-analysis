/**
 * WAR Product Layer — Postgres-backed daily usage store.
 *
 * Durable counterpart to InMemoryUsageStore. Keys on (user_id, day_utc) so the
 * quota resets at UTC midnight with zero bookkeeping — a new day is simply a new
 * key. Increments are atomic via INSERT ... ON CONFLICT ... DO UPDATE, so two
 * concurrent scans can never both slip past the cap.
 *
 * Reads/writes go through the same PgQueryable the repositories use, so it
 * shares the pool and the war_product search_path.
 */

import type { PgPool } from "./pgClient.js";
import type { UserId } from "../../domain/identity.js";
import {
  type UsageStore, type UsageKind, type UsageVerdict,
  utcDay, nextUtcMidnight,
} from "../../pricing/usageStore.js";

export class PgUsageStore implements UsageStore {
  constructor(private readonly pool: PgPool) {}

  async check(userId: UserId, kind: UsageKind, cap: number | null, nowMs: number): Promise<UsageVerdict> {
    if (cap === null) return { allowed: true, remaining: null, retryAtMs: null };
    const usedN = await this.used(userId, kind, nowMs);
    if (usedN < cap) return { allowed: true, remaining: cap - usedN - 1, retryAtMs: null };
    return { allowed: false, remaining: 0, retryAtMs: nextUtcMidnight(nowMs) };
  }

  async record(userId: UserId, kind: UsageKind, nowMs: number): Promise<void> {
    const day = utcDay(nowMs);
    const col = kind === "scan" ? "scans_used" : "monitors_used";
    // Atomic upsert-increment. The row is created on first use for the day, then
    // the relevant counter is bumped. updated_at always reflects last touch.
    await this.pool.query(
      `INSERT INTO usage_daily (user_id, day_utc, scans_used, monitors_used, updated_at)
         VALUES ($1, $2, ${kind === "scan" ? "1" : "0"}, ${kind === "monitor" ? "1" : "0"}, $3)
       ON CONFLICT (user_id, day_utc)
         DO UPDATE SET ${col} = usage_daily.${col} + 1, updated_at = $3`,
      [userId, day, nowMs],
    );
  }

  async used(userId: UserId, kind: UsageKind, nowMs: number): Promise<number> {
    const day = utcDay(nowMs);
    const col = kind === "scan" ? "scans_used" : "monitors_used";
    const r = await this.pool.query<{ n: string | number }>(
      `SELECT ${col} AS n FROM usage_daily WHERE user_id = $1 AND day_utc = $2`,
      [userId, day],
    );
    const row = r.rows[0];
    if (!row) return 0;
    return typeof row.n === "number" ? row.n : Number(row.n);
  }
}
