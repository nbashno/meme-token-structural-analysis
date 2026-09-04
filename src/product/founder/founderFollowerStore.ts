/**
 * WAR Product Layer — Founder Wallet followers.
 *
 * Implements the spec's Follow function (Rule 5): a user can follow the public
 * founder wallet using only their WAR/Telegram identity — no wallet connection,
 * no signature, no on-chain transaction. The follower set is a simple unique
 * membership, so the public count is an honest COUNT (each user counted once).
 *
 * This store holds NO funds and NO keys. It only records who chose to follow.
 */

import type { UserId } from "../domain/identity.js";

export interface FounderStatus {
  readonly following: boolean;
  readonly followers: number;
}

export interface FounderFollowerStore {
  /** Follow (idempotent). Returns the new status. */
  follow(userId: UserId, nowMs: number): Promise<FounderStatus>;
  /** Unfollow (idempotent). Returns the new status. */
  unfollow(userId: UserId): Promise<FounderStatus>;
  /** Current follow state + public follower count. */
  status(userId: UserId): Promise<FounderStatus>;
}

// -- In-memory implementation (tests + fallback) -----------------------------
export class InMemoryFounderFollowerStore implements FounderFollowerStore {
  private readonly followers = new Set<UserId>();

  async follow(userId: UserId, _nowMs: number): Promise<FounderStatus> {
    this.followers.add(userId);
    return { following: true, followers: this.followers.size };
  }
  async unfollow(userId: UserId): Promise<FounderStatus> {
    this.followers.delete(userId);
    return { following: false, followers: this.followers.size };
  }
  async status(userId: UserId): Promise<FounderStatus> {
    return { following: this.followers.has(userId), followers: this.followers.size };
  }
}
