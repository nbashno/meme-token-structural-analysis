/**
 * WAR auth — identity mapping.
 *
 * Turns a verified TelegramUser into the domain's UserIdentity contract. The
 * domain treats `providerUserId` as opaque; we derive a stable, provider-scoped
 * `userId` from (provider + providerUserId) so the same Telegram account always
 * maps to the same UserId, and two providers never collide.
 *
 * No intelligence; a pure identity transform over an injected clock.
 */

import { createHash } from "node:crypto";
import type { UserIdentity, UserId, IdentityProvider } from "../product/domain/identity.js";
import type { TelegramUser } from "./telegramAuth.js";

/** Stable UserId = provider-prefixed hash of the provider's native id. */
export function deriveUserId(provider: IdentityProvider, providerUserId: string): UserId {
  const digest = createHash("sha256").update(`${provider}:${providerUserId}`).digest("hex").slice(0, 32);
  return `${provider.toLowerCase()}_${digest}` as UserId;
}

/** Build a domain UserIdentity from a verified Telegram user. */
export function telegramIdentity(user: TelegramUser, nowMillis: number): UserIdentity {
  const provider: IdentityProvider = "TELEGRAM";
  return {
    userId: deriveUserId(provider, user.id),
    provider,
    providerUserId: user.id,
    createdAt: nowMillis,
  };
}
