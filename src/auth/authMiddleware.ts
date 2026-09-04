/**
 * WAR auth — API authentication middleware.
 *
 * Bridges Telegram initData verification into the API layer. It reads the
 * initData from a request (header `x-telegram-init-data` or an `initData` field
 * in the body/query), verifies it, and yields either an authenticated
 * UserIdentity or a reason to reject with 401.
 *
 * Pure decision logic over injected config/clock; no socket, no intelligence.
 * The API layer calls this before handlers that require a user.
 */

import type { UserIdentity } from "../product/domain/identity.js";
import { verifyTelegramInitData } from "./telegramAuth.js";
import { telegramIdentity } from "./identityMapper.js";

export interface AuthConfig {
  readonly botToken: string;
  readonly maxAgeSeconds?: number;
}

export type AuthResult =
  | { readonly ok: true; readonly identity: UserIdentity }
  | { readonly ok: false; readonly status: 401; readonly error: string };

export interface AuthInputs {
  /** Raw initData string (from header/body/query — the caller extracts it). */
  readonly initData: string | undefined;
  /** Current time in seconds (injected). */
  readonly nowSeconds: number;
  /** Current time in millis (injected) for identity.createdAt. */
  readonly nowMillis: number;
}

/**
 * Authenticate a request's initData. Returns an authenticated identity or a
 * 401 with a safe reason. Never throws.
 */
export function authenticate(cfg: AuthConfig, inputs: AuthInputs): AuthResult {
  if (typeof inputs.initData !== "string" || inputs.initData.length === 0) {
    return { ok: false, status: 401, error: "missing Telegram initData" };
  }
  const verified = verifyTelegramInitData(inputs.initData, cfg.botToken, {
    nowSeconds: inputs.nowSeconds,
    ...(cfg.maxAgeSeconds !== undefined ? { maxAgeSeconds: cfg.maxAgeSeconds } : {}),
  });
  if (!verified.ok) {
    return { ok: false, status: 401, error: `unauthenticated: ${verified.reason}` };
  }
  return { ok: true, identity: telegramIdentity(verified.user, inputs.nowMillis) };
}

/**
 * Extract initData from common request locations, in priority order:
 * header `x-telegram-init-data`, then body.initData, then query.initData.
 */
export function extractInitData(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  body: unknown,
  query: Readonly<Record<string, string>>,
): string | undefined {
  const h = headers["x-telegram-init-data"];
  if (typeof h === "string" && h.length > 0) return h;
  if (Array.isArray(h) && typeof h[0] === "string" && h[0].length > 0) return h[0];
  if (typeof body === "object" && body !== null) {
    const b = (body as Record<string, unknown>)["initData"];
    if (typeof b === "string" && b.length > 0) return b;
  }
  const q = query["initData"];
  if (typeof q === "string" && q.length > 0) return q;
  return undefined;
}
