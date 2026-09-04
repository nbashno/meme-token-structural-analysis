/**
 * WAR Product Layer — Account profile (read-only aggregation).
 *
 * Assembles everything the UI shows for "my account" from the pieces that
 * already exist: the BalanceLedger (balance, free quota, tier) and the
 * MonitorRepository (active monitors). It is a pure read/projection surface —
 * it charges nothing, computes no intelligence, and mutates no state. Limits
 * come from the pricing config's per-tier policy, applied here only for display
 * (the actual enforcement happens where monitors/alerts are created).
 */

import type { UserId } from "../domain/identity.js";
import type { BalanceLedger, AccountTier } from "../payment/balance.js";
import type { MonitorRepository } from "../persistence/contracts/repositories.js";
import type { PricingService, TierLimits } from "../pricing/pricing.js";
import { usdMicrosToDollars } from "../domain/identity.js";

export interface AccountProfile {
  readonly userId: UserId;
  readonly tier: AccountTier;
  /** Balance in whole dollars, for display. */
  readonly balanceUsd: number;
  readonly freeScansRemaining: number;
  /** Count of currently-active (non-expired) monitors. */
  readonly activeMonitors: number;
  /** The tier's limits (for showing caps / upsell). */
  readonly limits: TierLimits;
  /** Whether the account is at its concurrent-monitor cap (false if unlimited). */
  readonly atMonitorCap: boolean;
}

export class AccountProfileService {
  constructor(
    private readonly balances: BalanceLedger,
    private readonly monitors: MonitorRepository,
    private readonly pricing: PricingService,
  ) {}

  /**
   * Build the profile for a user at time nowMs. Registers a fresh account (with
   * the free-scan grant) on first read so a new user always has a coherent view.
   */
  async profile(userId: UserId, nowMs: number): Promise<AccountProfile> {
    const acct = this.balances.get(userId) ?? this.balances.register(userId, nowMs);
    const limits = this.pricing.tierLimits(acct.tier);

    // Active monitors owned by this user. listActive is a bounded read; we filter
    // by owner here (the repo lists globally for the scheduler).
    const active = await this.monitors.listActive(nowMs, 1000);
    const mine = active.filter((s) => s.userId === userId).length;

    const atMonitorCap =
      limits.maxConcurrentMonitors !== null && mine >= limits.maxConcurrentMonitors;

    return {
      userId,
      tier: acct.tier,
      balanceUsd: usdMicrosToDollars(acct.balanceMicros),
      freeScansRemaining: acct.freeScans,
      activeMonitors: mine,
      limits,
      atMonitorCap,
    };
  }

  /**
   * Guard used before starting a new monitor: may this account open another one?
   * Pure policy read — the caller enforces it. COMMAND (unlimited) always true.
   */
  async canStartMonitor(userId: UserId, nowMs: number): Promise<boolean> {
    const p = await this.profile(userId, nowMs);
    return !p.atMonitorCap;
  }
}
