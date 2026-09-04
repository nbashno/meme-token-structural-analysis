/**
 * WAR auth layer.
 *
 * Verifies Telegram Mini App initData (official HMAC-SHA256 scheme) and maps a
 * verified user to the domain UserIdentity contract. No intelligence, no core
 * imports beyond the identity types, no scoring. Built on node:crypto only.
 */

export * from "./telegramAuth.js";
export * from "./identityMapper.js";
export * from "./authMiddleware.js";
