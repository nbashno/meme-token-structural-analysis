-- ============================================================================
-- WAR ARENA — migration 0003: referrals ("invite 10 → free 24h monitor")
-- ----------------------------------------------------------------------------
-- Two tables, minimal:
--  • referral_codes  — one stable code per user (their invite link payload).
--  • referrals       — one row per successful invite (invitee joined via code).
--    invitee_user_id is UNIQUE: a person can only ever count as invited once,
--    which prevents a referrer from farming the same person for many rewards.
--  • referral_rewards — one row per reward granted, so we never grant twice for
--    the same milestone (idempotent by (referrer, milestone)).
-- The counter "how many did user X invite" is a cheap COUNT over referrals.
-- ============================================================================

SET search_path TO war_product;

-- Stable invite code per user (generated once, reused forever).
CREATE TABLE IF NOT EXISTS referral_codes (
  user_id     TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  created_at  BIGINT NOT NULL
);

-- One row per person who joined via someone's code. invitee is unique globally.
CREATE TABLE IF NOT EXISTS referrals (
  invitee_user_id   TEXT PRIMARY KEY,
  referrer_user_id  TEXT NOT NULL,
  code              TEXT NOT NULL,
  joined_at         BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_user_id);

-- One row per reward milestone granted to a referrer. Idempotent: the PK stops
-- the same milestone being paid twice even under concurrent grants.
CREATE TABLE IF NOT EXISTS referral_rewards (
  referrer_user_id  TEXT NOT NULL,
  milestone         INTEGER NOT NULL,   -- e.g. 10, 20, 30 invites
  granted_at        BIGINT NOT NULL,
  reward_ref        TEXT NOT NULL,      -- what was granted (e.g. entitlement id)
  PRIMARY KEY (referrer_user_id, milestone)
);
