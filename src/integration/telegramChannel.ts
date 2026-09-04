/**
 * WAR — Telegram notification channel.
 *
 * Implements NotificationChannel by calling the Telegram Bot API sendMessage.
 * Because our domain userId is a one-way hash of the Telegram id, this channel
 * needs a `resolveChatId` function to turn a userId into the numeric Telegram
 * chat id (looked up from the users table by the caller). If the chat id can't
 * be resolved, delivery fails honestly — it never fakes success.
 *
 * Kept transport-only: no intelligence, no formatting decisions beyond a plain
 * message string built from the alert.
 */

import type { NotificationChannel } from "../arena/shareAndNotify.js";
import type { AlertRow } from "../product/persistence/contracts/repositories.js";
import type { UserId } from "../product/domain/identity.js";

export interface TelegramChannelConfig {
  readonly botToken: string;
  /** Resolve a domain userId to a Telegram chat id (numeric string). */
  readonly resolveChatId: (userId: UserId) => Promise<string | null>;
  /** Injectable fetch for testing; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

export class TelegramNotificationChannel implements NotificationChannel {
  readonly name = "telegram";
  readonly available = true;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: TelegramChannelConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async deliver(alert: AlertRow): Promise<{ delivered: boolean; reason: string }> {
    const chatId = await this.cfg.resolveChatId(alert.userId);
    if (!chatId) return { delivered: false, reason: "NO_CHAT_ID_FOR_USER" };

    const text = formatAlert(alert);
    const url = `https://api.telegram.org/bot${this.cfg.botToken}/sendMessage`;
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
      });
      if (!res.ok) {
        return { delivered: false, reason: `TELEGRAM_HTTP_${res.status}` };
      }
      const data = (await res.json()) as { ok?: boolean; description?: string };
      if (!data.ok) return { delivered: false, reason: `TELEGRAM_API_${data.description ?? "ERROR"}` };
      return { delivered: true, reason: "OK" };
    } catch (err) {
      return { delivered: false, reason: `TELEGRAM_FETCH_FAILED_${(err as Error).message}` };
    }
  }
}

/** Build a plain, honest message from an alert. No prediction language. */
export function formatAlert(alert: AlertRow): string {
  const a = alert.alert;
  const reason = a.reason ?? "structural change";
  const detail = a.detail ? `\n${a.detail}` : "";
  return `⚔️ <b>WAR Alert</b>\n${reason}${detail}`;
}
