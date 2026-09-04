/**
 * WAR Product Layer — wallet-watch subscriptions.
 *
 * A paid monthly subscription to watch ONE wallet for BUY/SELL activity. This
 * store owns the subscription lifecycle and the per-watch "cursor" (the last
 * activity we've already alerted on), so the scheduler (phase 4) only fires on
 * genuinely new events and never double-notifies.
 *
 * buy/sell direction itself comes from the follow-wallet feed's `side` field
 * via FlowEventNormalizer — NOT invented here. This store is bookkeeping only.
 *
 * Deterministic: explicit nowMs everywhere.
 */

import type { UserId } from "../domain/identity.js";
import type { Chain } from "../../shared/scalars.js";

export type WatchStatus = "ACTIVE" | "EXPIRED" | "CANCELLED";

export interface WalletWatch {
  readonly id: string;
  readonly userId: UserId;
  readonly chain: Chain;
  readonly walletAddress: string;
  readonly entitlementId: string;
  readonly status: WatchStatus;
  readonly periodStartAt: number;
  readonly periodEndAt: number;
  readonly createdAt: number;
}

export interface WatchCursor {
  readonly watchId: string;
  readonly lastEventSig: string | null;
  readonly lastEventAt: number | null;
}

/** 30-day monthly period in ms. */
export const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

export interface WalletWatchStore {
  /** Create or renew a subscription for (user, chain, wallet). Idempotent per key. */
  subscribe(w: {
    id: string; userId: UserId; chain: Chain; walletAddress: string;
    entitlementId: string; nowMs: number;
  }): Promise<WalletWatch>;
  /** Cancel a watch (status → CANCELLED). */
  cancel(userId: UserId, watchId: string): Promise<boolean>;
  /** All ACTIVE (non-expired) watches — the scheduler iterates these. */
  activeWatches(nowMs: number): Promise<readonly WalletWatch[]>;
  /** Watches for one user (any status). */
  forUser(userId: UserId): Promise<readonly WalletWatch[]>;
  /** Read the alert cursor for a watch. */
  cursor(watchId: string): Promise<WatchCursor>;
  /** Advance the cursor after alerting on an event. */
  advanceCursor(watchId: string, sig: string, atMs: number, nowMs: number): Promise<void>;
  /** The user's current watch tier id ("FREE" | "PRO" | "ELITE"). */
  tierOf(userId: UserId, nowMs: number): Promise<string>;
  /** Set the user's watch tier with a monthly period. */
  setTier(userId: UserId, tier: string, nowMs: number, periodMs: number): Promise<void>;
  /** Count a user's ACTIVE watches (for quota checks). */
  activeCountForUser(userId: UserId, nowMs: number): Promise<number>;
}

// -- In-memory implementation ------------------------------------------------
export class InMemoryWalletWatchStore implements WalletWatchStore {
  private readonly watches = new Map<string, WalletWatch>();          // id -> watch
  private readonly byKey = new Map<string, string>();                 // key -> id
  private readonly cursors = new Map<string, WatchCursor>();

  private key(userId: UserId, chain: Chain, wallet: string): string {
    return `${userId}|${chain}|${wallet}`;
  }

  async subscribe(w: { id: string; userId: UserId; chain: Chain; walletAddress: string; entitlementId: string; nowMs: number; }): Promise<WalletWatch> {
    const key = this.key(w.userId, w.chain, w.walletAddress);
    const existingId = this.byKey.get(key);
    if (existingId) {
      const cur = this.watches.get(existingId)!;
      // Renew: extend the period from now.
      const renewed: WalletWatch = { ...cur, status: "ACTIVE", periodStartAt: w.nowMs, periodEndAt: w.nowMs + MONTH_MS, entitlementId: w.entitlementId };
      this.watches.set(existingId, renewed);
      return renewed;
    }
    const watch: WalletWatch = {
      id: w.id, userId: w.userId, chain: w.chain, walletAddress: w.walletAddress,
      entitlementId: w.entitlementId, status: "ACTIVE",
      periodStartAt: w.nowMs, periodEndAt: w.nowMs + MONTH_MS, createdAt: w.nowMs,
    };
    this.watches.set(w.id, watch);
    this.byKey.set(key, w.id);
    return watch;
  }

  async cancel(userId: UserId, watchId: string): Promise<boolean> {
    const w = this.watches.get(watchId);
    if (!w || w.userId !== userId) return false;
    this.watches.set(watchId, { ...w, status: "CANCELLED" });
    return true;
  }

  async activeWatches(nowMs: number): Promise<readonly WalletWatch[]> {
    const out: WalletWatch[] = [];
    for (const w of this.watches.values()) {
      if (w.status === "ACTIVE" && w.periodEndAt > nowMs) out.push(w);
    }
    return out;
  }

  async forUser(userId: UserId): Promise<readonly WalletWatch[]> {
    return [...this.watches.values()].filter((w) => w.userId === userId);
  }

  async cursor(watchId: string): Promise<WatchCursor> {
    return this.cursors.get(watchId) ?? { watchId, lastEventSig: null, lastEventAt: null };
  }

  async advanceCursor(watchId: string, sig: string, atMs: number, _nowMs: number): Promise<void> {
    this.cursors.set(watchId, { watchId, lastEventSig: sig, lastEventAt: atMs });
  }

  private readonly tiers = new Map<UserId, { tier: string; endAt: number | null }>();

  async tierOf(userId: UserId, nowMs: number): Promise<string> {
    const t = this.tiers.get(userId);
    if (!t) return "FREE";
    if (t.endAt != null && t.endAt <= nowMs) return "FREE"; // expired → back to FREE
    return t.tier;
  }

  async setTier(userId: UserId, tier: string, nowMs: number, periodMs: number): Promise<void> {
    this.tiers.set(userId, { tier, endAt: tier === "FREE" ? null : nowMs + periodMs });
  }

  async activeCountForUser(userId: UserId, nowMs: number): Promise<number> {
    let n = 0;
    for (const w of this.watches.values()) {
      if (w.userId === userId && w.status === "ACTIVE" && w.periodEndAt > nowMs) n++;
    }
    return n;
  }
}
