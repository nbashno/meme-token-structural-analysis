/**
 * WAR — Postgres-backed Founder Wallet follower store. SQL confined here.
 */

import type { PgPool } from "./pgClient.js";
import type { UserId } from "../../domain/identity.js";
import type { FounderFollowerStore, FounderStatus } from "../../founder/founderFollowerStore.js";

export class PgFounderFollowerStore implements FounderFollowerStore {
  constructor(private readonly pool: PgPool) {}

  private async count(): Promise<number> {
    const r = await this.pool.query<{ n: string | number }>(
      "SELECT COUNT(*) AS n FROM founder_followers", [],
    );
    const n = r.rows[0]?.n ?? 0;
    return typeof n === "number" ? n : Number(n);
  }

  async follow(userId: UserId, nowMs: number): Promise<FounderStatus> {
    await this.pool.query(
      `INSERT INTO founder_followers (user_id, followed_at)
         VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`,
      [userId, nowMs],
    );
    return { following: true, followers: await this.count() };
  }

  async unfollow(userId: UserId): Promise<FounderStatus> {
    await this.pool.query("DELETE FROM founder_followers WHERE user_id = $1", [userId]);
    return { following: false, followers: await this.count() };
  }

  async status(userId: UserId): Promise<FounderStatus> {
    const r = await this.pool.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM founder_followers WHERE user_id = $1", [userId],
    );
    const following = Number(r.rows[0]?.n ?? 0) > 0;
    return { following, followers: await this.count() };
  }

  /**
   * Resolve every follower's Telegram chat id, for broadcasting. Joins the
   * follower set to the users table (provider_user_id = the Telegram id stored
   * at auth). Followers with no resolvable id are skipped (never invented).
   */
  async followerChatIds(pool: PgPool): Promise<readonly string[]> {
    const r = await pool.query<{ provider_user_id: string }>(
      `SELECT u.provider_user_id
         FROM founder_followers f
         JOIN users u ON u.id = f.user_id
        WHERE u.provider_user_id IS NOT NULL`,
      [],
    );
    return r.rows.map((x) => x.provider_user_id).filter((x) => typeof x === "string" && x.length > 0);
  }
}
