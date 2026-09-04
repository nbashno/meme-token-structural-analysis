/**
 * WAR auth — Telegram Mini App initData verification.
 *
 * Implements Telegram's official Web App data-check per their documented scheme:
 *   secret_key = HMAC_SHA256(bot_token, key="WebAppData")
 *   check_hash = HMAC_SHA256(data_check_string, key=secret_key)
 * where data_check_string is all fields except `hash`, sorted by key and joined
 * as "key=value" with newlines. The request is authentic iff check_hash == hash.
 *
 * Pure (crypto only, injected time for freshness) and Node-testable. Contains no
 * intelligence, no core imports — it only decides "is this a genuine, fresh
 * Telegram user" and extracts the provider's native user id.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface TelegramUser {
  /** Telegram's native numeric user id, as a string (opaque to the domain). */
  readonly id: string;
  readonly firstName?: string;
  readonly username?: string;
  readonly languageCode?: string;
}

export type VerifyOutcome =
  | { readonly ok: true; readonly user: TelegramUser; readonly authDate: number }
  | { readonly ok: false; readonly reason: string };

export interface VerifyOptions {
  /** Max age of initData in seconds before it is considered stale. */
  readonly maxAgeSeconds?: number;
  /** Current time in seconds (injected for determinism/testing). */
  readonly nowSeconds: number;
}

/**
 * Parse the raw initData query string into a field map. Values are URL-decoded.
 */
function parseInitData(initData: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of initData.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const k = decodeURIComponent(pair.slice(0, eq));
    const v = decodeURIComponent(pair.slice(eq + 1));
    map.set(k, v);
  }
  return map;
}

/** Build the data-check-string: all fields except `hash`, sorted, joined by \n. */
function dataCheckString(fields: Map<string, string>): string {
  const parts: string[] = [];
  for (const [k, v] of fields) {
    if (k === "hash") continue;
    parts.push(`${k}=${v}`);
  }
  parts.sort();
  return parts.join("\n");
}

function hmacSha256Hex(data: string, key: Buffer): string {
  return createHmac("sha256", key).update(data).digest("hex");
}

/**
 * Verify Telegram initData. Returns the authenticated user or a reason for
 * rejection. Never throws on malformed input — it returns ok:false instead.
 */
export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  opts: VerifyOptions,
): VerifyOutcome {
  if (typeof initData !== "string" || initData.length === 0) {
    return { ok: false, reason: "empty initData" };
  }
  if (typeof botToken !== "string" || botToken.length === 0) {
    return { ok: false, reason: "missing bot token" };
  }

  const fields = parseInitData(initData);
  const providedHash = fields.get("hash");
  if (!providedHash) return { ok: false, reason: "missing hash" };

  // secret_key = HMAC_SHA256(botToken, key="WebAppData")
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = hmacSha256Hex(dataCheckString(fields), secretKey);

  // Constant-time comparison.
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(providedHash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "hash mismatch" };
  }

  // Freshness check.
  const authDateRaw = fields.get("auth_date");
  const authDate = authDateRaw ? Number(authDateRaw) : NaN;
  if (!Number.isFinite(authDate)) return { ok: false, reason: "missing auth_date" };
  const maxAge = opts.maxAgeSeconds ?? 86400; // default 24h
  if (opts.nowSeconds - authDate > maxAge) {
    return { ok: false, reason: "initData expired" };
  }
  if (authDate - opts.nowSeconds > 300) {
    return { ok: false, reason: "auth_date in the future" };
  }

  // Extract the user object (Telegram sends it as a JSON string under "user").
  const userRaw = fields.get("user");
  if (!userRaw) return { ok: false, reason: "missing user" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(userRaw);
  } catch {
    return { ok: false, reason: "invalid user json" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "invalid user object" };
  }
  const u = parsed as Record<string, unknown>;
  const id = u["id"];
  if (typeof id !== "number" && typeof id !== "string") {
    return { ok: false, reason: "missing user id" };
  }

  const user: TelegramUser = {
    id: String(id),
    ...(typeof u["first_name"] === "string" ? { firstName: u["first_name"] } : {}),
    ...(typeof u["username"] === "string" ? { username: u["username"] } : {}),
    ...(typeof u["language_code"] === "string" ? { languageCode: u["language_code"] } : {}),
  };

  return { ok: true, user, authDate };
}
