/**
 * WAR Product Layer — referral system.
 *
 * Model: "invite N friends → earn a reward" (default: 10 invites → one free
 * 24h monitor). Deterministic and idempotent:
 *  • Each user has ONE stable invite code.
 *  • A person can be counted as invited exactly once (invitee is unique), so a
 *    referrer cannot farm the same account repeatedly.
 *  • Rewards are milestone-based and granted at most once per milestone.
 *
 * This store only records the social graph and reward bookkeeping. Actually
 * GRANTING the monitor (issuing the entitlement) is done by the caller, which
 * passes a reward_ref back so the grant is auditable and idempotent.
 */

import type { UserId } from "../domain/identity.js";

/** How many successful invites earn one reward, and what each reward is. */
export interface ReferralPolicy {
  readonly invitesPerReward: number;   // default 10
}

export const DEFAULT_REFERRAL_POLICY: ReferralPolicy = { invitesPerReward: 10 };

export interface ReferralProgress {
  readonly code: string;
  readonly invited: number;            // total successful invites
  readonly rewardsEarned: number;      // milestones reached
  readonly rewardsGranted: number;     // milestones actually paid out
  readonly toNextReward: number;       // invites remaining to next milestone
}

/** A milestone that has been earned but not yet granted (caller must fulfil). */
export interface PendingReward {
  readonly milestone: number;          // e.g. 10, 20
}

export interface ReferralStore {
  /** Get (or lazily create) the user's stable invite code. */
  codeFor(userId: UserId, nowMs: number): Promise<string>;
  /** Resolve a code back to its owner (for attributing a new join). null if unknown. */
  ownerOf(code: string): Promise<UserId | null>;
  /**
   * Record that `invitee` joined via `code`. Returns false if the invitee was
   * already attributed (no double-count) or the code is the invitee's own.
   */
  recordInvite(code: string, invitee: UserId, nowMs: number): Promise<boolean>;
  /** Current progress for a referrer. */
  progress(userId: UserId, policy: ReferralPolicy, nowMs: number): Promise<ReferralProgress>;
  /**
   * Return milestones earned but not yet granted. The caller grants the reward,
   * then calls markGranted() with the reward_ref. Keeps granting idempotent.
   */
  pendingRewards(userId: UserId, policy: ReferralPolicy, nowMs: number): Promise<readonly PendingReward[]>;
  /** Mark a milestone as granted (idempotent). Returns false if already granted. */
  markGranted(userId: UserId, milestone: number, rewardRef: string, nowMs: number): Promise<boolean>;
}

// -- Helpers -----------------------------------------------------------------

/** Deterministic, URL-safe code from a user id. Stable for the same id. */
export function deriveCode(userId: UserId): string {
  // Simple stable hash → base36. Not secret (codes are shareable by design).
  let h = 2166136261 >>> 0;
  const s = String(userId);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return "w" + h.toString(36);
}

// -- In-memory implementation (tests + fallback) -----------------------------
export class InMemoryReferralStore implements ReferralStore {
  private readonly codes = new Map<UserId, string>();
  private readonly byCode = new Map<string, UserId>();
  private readonly invites = new Map<UserId, UserId>();          // invitee -> referrer
  private readonly granted = new Map<string, number>();          // `${user}:${milestone}` -> ts

  async codeFor(userId: UserId, _nowMs: number): Promise<string> {
    let c = this.codes.get(userId);
    if (!c) { c = deriveCode(userId); this.codes.set(userId, c); this.byCode.set(c, userId); }
    return c;
  }
  async ownerOf(code: string): Promise<UserId | null> {
    return this.byCode.get(code) ?? null;
  }
  async recordInvite(code: string, invitee: UserId, _nowMs: number): Promise<boolean> {
    const owner = this.byCode.get(code);
    if (!owner || owner === invitee) return false;      // unknown code or self-invite
    if (this.invites.has(invitee)) return false;         // already attributed
    this.invites.set(invitee, owner);
    return true;
  }
  private invitedCount(userId: UserId): number {
    let n = 0; for (const ref of this.invites.values()) if (ref === userId) n++; return n;
  }
  async progress(userId: UserId, policy: ReferralPolicy, nowMs: number): Promise<ReferralProgress> {
    await this.codeFor(userId, nowMs);
    const invited = this.invitedCount(userId);
    const rewardsEarned = Math.floor(invited / policy.invitesPerReward);
    let rewardsGranted = 0;
    for (const key of this.granted.keys()) if (key.startsWith(userId + ":")) rewardsGranted++;
    const toNext = policy.invitesPerReward - (invited % policy.invitesPerReward);
    return {
      code: this.codes.get(userId)!,
      invited, rewardsEarned, rewardsGranted,
      toNextReward: invited === 0 ? policy.invitesPerReward : (rewardsEarned * policy.invitesPerReward === invited ? policy.invitesPerReward : toNext),
    };
  }
  async pendingRewards(userId: UserId, policy: ReferralPolicy, _nowMs: number): Promise<readonly PendingReward[]> {
    const invited = this.invitedCount(userId);
    const earned = Math.floor(invited / policy.invitesPerReward);
    const out: PendingReward[] = [];
    for (let k = 1; k <= earned; k++) {
      const milestone = k * policy.invitesPerReward;
      if (!this.granted.has(userId + ":" + milestone)) out.push({ milestone });
    }
    return out;
  }
  async markGranted(userId: UserId, milestone: number, _rewardRef: string, nowMs: number): Promise<boolean> {
    const key = userId + ":" + milestone;
    if (this.granted.has(key)) return false;
    this.granted.set(key, nowMs);
    return true;
  }
}
