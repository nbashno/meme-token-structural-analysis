-- ============================================================================
-- WAR ARENA — migration 0006: WAR Founder Wallet followers
-- ----------------------------------------------------------------------------
-- Per the Founder Wallet spec (Rule 5 + Rule 14): users can FOLLOW the public
-- founder wallet WITHOUT connecting a crypto wallet — following requires only a
-- WAR/Telegram identity. One row per follower (unique), so the count is a plain
-- COUNT and a user can only be counted once. No funds, no signatures, no keys.
-- ============================================================================

SET search_path TO war_product;

CREATE TABLE IF NOT EXISTS founder_followers (
  user_id      TEXT PRIMARY KEY,       -- the WAR/Telegram identity (unique)
  followed_at  BIGINT NOT NULL
);
