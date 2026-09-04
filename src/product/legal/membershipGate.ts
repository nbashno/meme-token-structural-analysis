/**
 * WAR Product Layer — channel membership gate.
 *
 * Requires the user to be a member of a Telegram channel/group before they may
 * run operations (scan / monitor). Browsing the galaxy stays open — the gate is
 * applied only at the operation boundary, so a new user sees value first, then
 * joins to use it.
 *
 * The DETERMINISTIC part (which membership statuses count as "in", what happens
 * when no channel is configured) lives here and is fully tested. The NETWORK
 * part (calling Telegram's getChatMember) is an injected async check — at deploy
 * it hits the Bot API with the bot token; in tests it is a stub. Nothing is
 * faked: if the check cannot confirm membership, the gate stays closed.
 */

import type { UserId } from "../domain/identity.js";

/** Telegram chat member statuses that count as "still in the channel". */
const MEMBER_STATUSES = new Set(["creator", "administrator", "member", "restricted"]);
// "left" and "kicked" are NOT members. "restricted" can still be a member
// (is_member handled by the checker when relevant); we treat it as in by status.

export interface MembershipConfig {
  /** Channel @username or numeric id. undefined = no gate (all allowed). */
  readonly requiredChannel: string | undefined;
}

/**
 * The injected network check: ask Telegram for a user's status in the channel.
 * Returns the raw status string, or null if it could not be determined.
 * At deploy this calls getChatMember; in tests it's a stub.
 */
export type MembershipChecker = (channel: string, telegramUserId: string) => Promise<string | null>;

export interface MembershipVerdict {
  readonly allowed: boolean;
  readonly reason: string;
  /** The channel to join, when blocked (for the UI's "Join" button). */
  readonly channel: string | null;
}

export class MembershipGate {
  constructor(
    private readonly cfg: MembershipConfig,
    private readonly checker: MembershipChecker,
  ) {}

  /** Whether a gate is active at all. */
  isEnabled(): boolean {
    return this.cfg.requiredChannel !== undefined && this.cfg.requiredChannel !== "";
  }

  /**
   * Check membership for a user. When no channel is configured, always allows
   * (feature off). When configured, allows only if Telegram confirms an
   * in-channel status. A failed/unknown check stays CLOSED (fail-safe).
   *
   * @param telegramUserId the provider-native Telegram id (not the WAR UserId)
   */
  async check(_userId: UserId, telegramUserId: string): Promise<MembershipVerdict> {
    const channel = this.cfg.requiredChannel;
    if (!channel) return { allowed: true, reason: "no channel required", channel: null };

    let status: string | null;
    try {
      status = await this.checker(channel, telegramUserId);
    } catch {
      status = null;
    }
    if (status === null) {
      return { allowed: false, reason: "could not verify channel membership", channel };
    }
    if (MEMBER_STATUSES.has(status)) {
      return { allowed: true, reason: "member", channel };
    }
    return { allowed: false, reason: "not a channel member", channel };
  }
}

/**
 * Build a real Telegram membership checker from a bot token. Calls getChatMember
 * via the Bot API. Returns the status string, or null on any error / non-ok
 * response (so the gate fails safe/closed). Kept dependency-free (global fetch).
 */
export function telegramMembershipChecker(botToken: string): MembershipChecker {
  return async (channel, telegramUserId) => {
    try {
      const url = `https://api.telegram.org/bot${botToken}/getChatMember`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: channel, user_id: Number(telegramUserId) }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { ok?: boolean; result?: { status?: string } };
      if (!data.ok || !data.result || typeof data.result.status !== "string") return null;
      return data.result.status;
    } catch {
      return null;
    }
  };
}
