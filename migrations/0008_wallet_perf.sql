-- ============================================================================
-- WAR ARENA — migration 0008: wallet performance observations (Alpha Memory)
-- ----------------------------------------------------------------------------
-- The foundation of WAR INTEL / WAR Alpha Memory. Each row is ONE observed
-- realized-performance data point for a (wallet, token) pair, captured from
-- GMGN token-top-traders (API-key only, no private key). Over time these
-- accumulate into a real dataset WAR can calibrate thresholds against and use
-- to find wallets that REPEATEDLY perform — not one lucky outlier.
--
-- Every field is REAL, sourced from GMGN. realized_pnl is GMGN's ratio (e.g.
-- 57888 = 57,888x). We store the exact value — never capped or truncated.
-- Dedup by (chain, wallet, token, observed_day) so re-collecting the same day
-- updates rather than duplicates.
-- ============================================================================

SET search_path TO war_product;

CREATE TABLE IF NOT EXISTS wallet_perf_observations (
  chain            TEXT NOT NULL,
  wallet           TEXT NOT NULL,
  token            TEXT NOT NULL,
  token_symbol     TEXT,
  realized_profit  DOUBLE PRECISION NOT NULL,   -- USD, can be negative
  realized_roi     DOUBLE PRECISION,            -- GMGN realized_pnl ratio (exact)
  cost_usd         DOUBLE PRECISION NOT NULL,   -- total_cost / cost
  wallet_tag       TEXT,                        -- smart_degen | renowned | whale | ...
  source           TEXT NOT NULL,               -- e.g. "gmgn:token_top_traders"
  observed_day     DATE NOT NULL,               -- UTC day of observation (dedup key)
  observed_at      BIGINT NOT NULL,             -- epoch-ms of capture
  PRIMARY KEY (chain, wallet, token, observed_day)
);
CREATE INDEX IF NOT EXISTS idx_wpo_profit ON wallet_perf_observations(realized_profit);
CREATE INDEX IF NOT EXISTS idx_wpo_wallet ON wallet_perf_observations(chain, wallet);
CREATE INDEX IF NOT EXISTS idx_wpo_day    ON wallet_perf_observations(observed_day);
