/**
 * WAR Product Layer — Postgres-backed referral store.
 *
 * Durable counterpart to InMemoryReferralStore. Invite counts are a COUNT over
 * the referrals table; rewards are idempotent via the referral_rewards PK
 * (referrer, milestone). All SQL is confined here per the architecture guard.
 */

import type { PgPool } from "./pgClient.js";
import type { UserId } from "../../domain/identity.js";
import {
  type ReferralStore, type ReferralPolicy, type ReferralProgress, type PendingReward,
  deriveCode,
} from "../../referral/referralStore.js";

export class PgReferralStore implements ReferralStore {
  constructor(private readonly pool: PgPool) {}

  async codeFor(userId: UserId, nowMs: number): Promise<string> {
    const code = deriveCode(userId);
    await this.pool.query(
      `INSERT INTO referral_codes (user_id, code, created_at)
         VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING`,
      [userId, code, nowMs],
    );
    const r = await this.pool.query<{ code: string }>(
      "SELECT code FROM referral_codes WHERE user_id = $1", [userId],
    );
    return r.rows[0]?.code ?? code;
  }

  async ownerOf(code: string): Promise<UserId | null> {
    const r = await this.pool.query<{ user_id: string }>(
      "SELECT user_id FROM referral_codes WHERE code = $1", [code],
    );
    return (r.rows[0]?.user_id as UserId) ?? null;
  }

  async recordInvite(code: string, invitee: UserId, nowMs: number): Promise<boolean> {
    const owner = await this.ownerOf(code);
    if (!owner || owner === invitee) return false;
    // invitee is PK — ON CONFLICT DO NOTHING makes double-attribution a no-op.
    const r = await this.pool.query(
      `INSERT INTO referrals (invitee_user_id, referrer_user_id, code, joined_at)
         VALUES ($1, $2, $3, $4) ON CONFLICT (invitee_user_id) DO NOTHING`,
      [invitee, owner, code, nowMs],
    );
    return r.rowCount > 0;
  }

  private async invitedCount(userId: UserId): Promise<number> {
    const r = await this.pool.query<{ n: string | number }>(
      "SELECT COUNT(*) AS n FROM referrals WHERE referrer_user_id = $1", [userId],
    );
    const n = r.rows[0]?.n ?? 0;
    return typeof n === "number" ? n : Number(n);
  }

  async progress(userId: UserId, policy: ReferralPolicy, nowMs: number): Promise<ReferralProgress> {
    const code = await this.codeFor(userId, nowMs);
    const invited = await this.invitedCount(userId);
    const rewardsEarned = Math.floor(invited / policy.invitesPerReward);
    const gr = await this.pool.query<{ n: string | number }>(
      "SELECT COUNT(*) AS n FROM referral_rewards WHERE referrer_user_id = $1", [userId],
    );
    const rewardsGranted = typeof gr.rows[0]?.n === "number" ? (gr.rows[0]!.n as number) : Number(gr.rows[0]?.n ?? 0);
    const rem = invited % policy.invitesPerReward;
    const toNextReward = rem === 0 ? policy.invitesPerReward : policy.invitesPerReward - rem;
    return { code, invited, rewardsEarned, rewardsGranted, toNextReward };
  }

  async pendingRewards(userId: UserId, policy: ReferralPolicy, _nowMs: number): Promise<readonly PendingReward[]> {
    const invited = await this.invitedCount(userId);
    const earned = Math.floor(invited / policy.invitesPerReward);
    if (earned === 0) return [];
    const gr = await this.pool.query<{ milestone: string | number }>(
      "SELECT milestone FROM referral_rewards WHERE referrer_user_id = $1", [userId],
    );
    const grantedSet = new Set(gr.rows.map((x) => Number(x.milestone)));
    const out: PendingReward[] = [];
    for (let k = 1; k <= earned; k++) {
      const milestone = k * policy.invitesPerReward;
      if (!grantedSet.has(milestone)) out.push({ milestone });
    }
    return out;
  }

  async markGranted(userId: UserId, milestone: number, rewardRef: string, nowMs: number): Promise<boolean> {
    const r = await this.pool.query(
      `INSERT INTO referral_rewards (referrer_user_id, milestone, granted_at, reward_ref)
         VALUES ($1, $2, $3, $4) ON CONFLICT (referrer_user_id, milestone) DO NOTHING`,
      [userId, milestone, nowMs, rewardRef],
    );
    return r.rowCount > 0;
  }
}
