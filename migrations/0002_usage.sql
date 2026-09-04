-- ============================================================================
-- WAR ARENA — migration 0002: daily usage quotas
-- ----------------------------------------------------------------------------
-- Calendar-day quota model (UTC), chosen for MINIMAL storage: exactly one row
-- per (user, day) holding two small integers. No per-action timestamp arrays —
-- the whole day's usage is a counter that resets at UTC midnight simply by
-- keying on the date. This is the cheapest possible representation on a
-- constrained free-tier Postgres, and the clearest for users ("resets daily").
--
-- The counter row is created lazily on first use (INSERT ... ON CONFLICT) and
-- incremented atomically, so concurrent scans can't over-consume.
-- ============================================================================

SET search_path TO war_product;

-- One row per user per UTC day. day_utc is a plain DATE (no time/zone drift).
CREATE TABLE IF NOT EXISTS usage_daily (
  user_id        TEXT NOT NULL,
  day_utc        DATE NOT NULL,
  scans_used     INTEGER NOT NULL DEFAULT 0,
  monitors_used  INTEGER NOT NULL DEFAULT 0,
  updated_at     BIGINT  NOT NULL,
  PRIMARY KEY (user_id, day_utc)
);

-- Old rows are harmless but pointless to keep; this index makes any future
-- cleanup / "usage history" read cheap without scanning the whole table.
CREATE INDEX IF NOT EXISTS idx_usage_daily_day ON usage_daily(day_utc);
