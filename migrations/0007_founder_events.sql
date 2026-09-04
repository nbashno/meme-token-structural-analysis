-- ============================================================================
-- WAR ARENA — migration 0007: Founder Wallet token snapshot + RECEIVED events
-- ----------------------------------------------------------------------------
-- Discovery uses Solana getTokenAccountsByOwner (public address, NO private key)
-- to list the wallet's token mints. We snapshot them so we can detect NEW mints
-- between ticks. When a new mint appears, GMGN token-holders verifies it was
-- transfer_in (received, not bought), and we record a RECEIVED event — dedup'd
-- by (chain, wallet, token, tx_hash) so a transfer never notifies twice.
-- Spec Rules 6,7,14,17. No keys, no funds.
-- ============================================================================

SET search_path TO war_product;

-- Current known token mints per founder wallet (the discovery snapshot).
CREATE TABLE IF NOT EXISTS founder_wallet_tokens (
  chain       TEXT NOT NULL,
  wallet      TEXT NOT NULL,
  mint        TEXT NOT NULL,
  first_seen  BIGINT NOT NULL,
  last_seen   BIGINT NOT NULL,
  PRIMARY KEY (chain, wallet, mint)
);

-- Detected wallet events (RECEIVED for now; BUY/SELL/TRANSFER future). Dedup by
-- the natural transaction identity so re-processing is a no-op.
CREATE TABLE IF NOT EXISTS founder_wallet_events (
  id              BIGSERIAL PRIMARY KEY,
  chain           TEXT NOT NULL,
  wallet          TEXT NOT NULL,
  event_type      TEXT NOT NULL,          -- RECEIVED | BUY | SELL | TRANSFER | UNKNOWN
  token_mint      TEXT NOT NULL,
  token_symbol    TEXT,
  tx_hash         TEXT NOT NULL,
  from_address    TEXT,                   -- NULL when the source is unavailable
  from_name       TEXT,                   -- e.g. "Coinbase Hot Wallet" if GMGN knows it
  occurred_at     BIGINT,                 -- on-chain time when known
  detected_at     BIGINT NOT NULL,
  notified        BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (chain, wallet, token_mint, tx_hash)
);
CREATE INDEX IF NOT EXISTS idx_founder_events_notified ON founder_wallet_events(notified);
