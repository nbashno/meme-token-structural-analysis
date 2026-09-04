/**
 * WAR — Postgres-backed wallet-watch store. SQL confined here per the guard.
 */

import type { PgPool } from "./pgClient.js";
import type { UserId } from "../../domain/identity.js";
import type { Chain } from "../../../shared/scalars.js";
import {
  type WalletWatchStore, type WalletWatch, type WatchCursor, type WatchStatus,
  MONTH_MS,
} from "../../watch/walletWatchStore.js";

interface WatchSql {
  id: string; user_id: string; chain: string; wallet_address: string;
  entitlement_id: string; status: string;
  period_start_at: string; period_end_at: string; created_at: string;
}

function fromSql(r: WatchSql): WalletWatch {
  return {
    id: r.id, userId: r.user_id as UserId, chain: r.chain as Chain,
    walletAddress: r.wallet_address, entitlementId: r.entitlement_id,
    status: r.status as WatchStatus,
    periodStartAt: Number(r.period_start_at), periodEndAt: Number(r.period_end_at),
    createdAt: Number(r.created_at),
  };
}

export class PgWalletWatchStore implements WalletWatchStore {
  constructor(private readonly pool: PgPool) {}

  async subscribe(w: { id: string; userId: UserId; chain: Chain; walletAddress: string; entitlementId: string; nowMs: number; }): Promise<WalletWatch> {
    const start = w.nowMs, end = w.nowMs + MONTH_MS;
    // Upsert on the unique (user, chain, wallet) key: insert new, or renew the
    // period + reactivate an existing one.
    await this.pool.query(
      `INSERT INTO wallet_watches
         (id,user_id,chain,wallet_address,entitlement_id,status,period_start_at,period_end_at,created_at)
       VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6,$7,$8)
       ON CONFLICT (user_id, chain, wallet_address) DO UPDATE
         SET status='ACTIVE', period_start_at=$6, period_end_at=$7, entitlement_id=$5`,
      [w.id, w.userId, w.chain, w.walletAddress, w.entitlementId, start, end, w.nowMs],
    );
    const r = await this.pool.query<WatchSql>(
      "SELECT * FROM wallet_watches WHERE user_id=$1 AND chain=$2 AND wallet_address=$3",
      [w.userId, w.chain, w.walletAddress],
    );
    return fromSql(r.rows[0]!);
  }

  async cancel(userId: UserId, watchId: string): Promise<boolean> {
    const r = await this.pool.query(
      "UPDATE wallet_watches SET status='CANCELLED' WHERE id=$1 AND user_id=$2 AND status<>'CANCELLED'",
      [watchId, userId],
    );
    return r.rowCount > 0;
  }

  async activeWatches(nowMs: number): Promise<readonly WalletWatch[]> {
    const r = await this.pool.query<WatchSql>(
      "SELECT * FROM wallet_watches WHERE status='ACTIVE' AND period_end_at > $1", [nowMs],
    );
    return r.rows.map(fromSql);
  }

  async forUser(userId: UserId): Promise<readonly WalletWatch[]> {
    const r = await this.pool.query<WatchSql>(
      "SELECT * FROM wallet_watches WHERE user_id=$1 ORDER BY created_at DESC", [userId],
    );
    return r.rows.map(fromSql);
  }

  async cursor(watchId: string): Promise<WatchCursor> {
    const r = await this.pool.query<{ last_event_sig: string | null; last_event_at: string | null }>(
      "SELECT last_event_sig, last_event_at FROM wallet_watch_cursor WHERE watch_id=$1", [watchId],
    );
    const row = r.rows[0];
    if (!row) return { watchId, lastEventSig: null, lastEventAt: null };
    return { watchId, lastEventSig: row.last_event_sig, lastEventAt: row.last_event_at ? Number(row.last_event_at) : null };
  }

  async advanceCursor(watchId: string, sig: string, atMs: number, nowMs: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO wallet_watch_cursor (watch_id,last_event_sig,last_event_at,updated_at)
         VALUES ($1,$2,$3,$4)
       ON CONFLICT (watch_id) DO UPDATE SET last_event_sig=$2, last_event_at=$3, updated_at=$4`,
      [watchId, sig, atMs, nowMs],
    );
  }

  async tierOf(userId: UserId, nowMs: number): Promise<string> {
    const r = await this.pool.query<{ tier: string; period_end_at: string | null }>(
      "SELECT tier, period_end_at FROM watch_tiers WHERE user_id=$1", [userId],
    );
    const row = r.rows[0];
    if (!row) return "FREE";
    if (row.period_end_at != null && Number(row.period_end_at) <= nowMs) return "FREE";
    return row.tier;
  }

  async setTier(userId: UserId, tier: string, nowMs: number, periodMs: number): Promise<void> {
    const endAt = tier === "FREE" ? null : nowMs + periodMs;
    await this.pool.query(
      `INSERT INTO watch_tiers (user_id, tier, period_start_at, period_end_at, updated_at)
         VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id) DO UPDATE SET tier=$2, period_start_at=$3, period_end_at=$4, updated_at=$5`,
      [userId, tier, nowMs, endAt, nowMs],
    );
  }

  async activeCountForUser(userId: UserId, nowMs: number): Promise<number> {
    const r = await this.pool.query<{ n: string | number }>(
      "SELECT COUNT(*) AS n FROM wallet_watches WHERE user_id=$1 AND status='ACTIVE' AND period_end_at > $2",
      [userId, nowMs],
    );
    const n = r.rows[0]?.n ?? 0;
    return typeof n === "number" ? n : Number(n);
  }
}
