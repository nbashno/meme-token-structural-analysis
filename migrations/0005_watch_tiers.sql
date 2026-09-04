-- ============================================================================
-- WAR ARENA — migration 0005: wallet-watch subscription tiers
-- ----------------------------------------------------------------------------
-- A user's current watch tier (FREE default; PRO/ELITE after payment) and the
-- monthly period it's valid for. One row per user. Adding wallets checks the
-- tier's maxWallets quota — the subscription is per-USER, not per-wallet.
-- ============================================================================

SET search_path TO war_product;

CREATE TABLE IF NOT EXISTS watch_tiers (
  user_id          TEXT PRIMARY KEY,
  tier             TEXT NOT NULL DEFAULT 'FREE',   -- FREE | PRO | ELITE
  period_start_at  BIGINT,
  period_end_at    BIGINT,                          -- null for FREE
  updated_at       BIGINT NOT NULL
);
