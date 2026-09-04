-- ============================================================================
-- WAR ARENA — migration 0004: wallet-watch subscriptions (buy/sell alerts)
-- ----------------------------------------------------------------------------
-- A paid, monthly subscription to watch ONE specific wallet and get notified
-- when it BUYS or SELLS. Two tables:
--  • wallet_watches       — one row per (user, wallet) subscription, with the
--    monthly period boundaries. status flips to EXPIRED when the month ends
--    (renewal creates/extends the period).
--  • wallet_watch_cursor  — the last activity signature we've already alerted
--    on for each watch, so the scheduler only fires on NEW buy/sell events and
--    never double-notifies. This is the anti-replay guard for live polling.
-- The actual live polling + buy/sell detection runs in the scheduler (phase 4);
-- these tables + the subscription/pricing are the durable foundation.
-- ============================================================================

SET search_path TO war_product;

CREATE TABLE IF NOT EXISTS wallet_watches (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  chain             TEXT NOT NULL,
  wallet_address    TEXT NOT NULL,
  entitlement_id    TEXT NOT NULL,
  status            TEXT NOT NULL,            -- ACTIVE | EXPIRED | CANCELLED
  period_start_at   BIGINT NOT NULL,
  period_end_at     BIGINT NOT NULL,          -- monthly boundary
  created_at        BIGINT NOT NULL,
  -- A user watches a given wallet at most once concurrently.
  UNIQUE (user_id, chain, wallet_address)
);
CREATE INDEX IF NOT EXISTS idx_wallet_watches_user   ON wallet_watches(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_watches_status ON wallet_watches(status);

-- Last activity we've already processed for a watch. The scheduler compares new
-- activity against last_event_sig / last_event_at and only alerts on newer ones.
CREATE TABLE IF NOT EXISTS wallet_watch_cursor (
  watch_id        TEXT PRIMARY KEY,
  last_event_sig  TEXT,                       -- tx hash / stable signature
  last_event_at   BIGINT,
  updated_at      BIGINT NOT NULL
);
