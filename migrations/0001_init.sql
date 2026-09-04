-- ============================================================================
-- WAR ARENA — initial schema (migration 0001)
-- ----------------------------------------------------------------------------
-- This schema is the durable backing store for the product layer. It mirrors
-- EXACTLY the columns and unique keys that src/product/persistence/pg/
-- pgRepositories.ts writes and reads — every INSERT ... ON CONFLICT here has a
-- matching table + unique constraint, so the repositories are idempotent and
-- survive restarts (which the in-memory store does not).
--
-- Design notes:
--  • Timestamps are stored as BIGINT epoch-ms to match the engine's numeric
--    time model (the code passes/reads numbers, never Date objects). This keeps
--    the persistence layer free of timezone ambiguity.
--  • Money is amount_usd_micros (BIGINT) — integer micros, never floats.
--  • Reasons / arrays are TEXT[] (Postgres native array) to match the code.
--  • This file is idempotent: safe to run more than once (IF NOT EXISTS).
-- ============================================================================

-- ---- schema isolation --------------------------------------------------------
-- All WAR product tables live in a dedicated `war_product` schema, not `public`.
-- This isolates the app's tables from anything else in the database (important
-- on Supabase, whose `public` schema also hosts auth/storage helpers) and lets
-- the app pin its search_path to exactly its own namespace.
CREATE SCHEMA IF NOT EXISTS war_product;
SET search_path TO war_product;

-- ---- users -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  provider          TEXT NOT NULL,
  provider_user_id  TEXT NOT NULL,
  created_at        BIGINT NOT NULL
);

-- ---- tokens ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tokens (
  id             BIGSERIAL PRIMARY KEY,
  chain          TEXT NOT NULL,
  address        TEXT NOT NULL,
  symbol         TEXT,
  name           TEXT,
  first_seen_at  BIGINT NOT NULL,
  UNIQUE (chain, address)
);

-- ---- pricing_versions ------------------------------------------------------
CREATE TABLE IF NOT EXISTS pricing_versions (
  version  TEXT PRIMARY KEY,
  config   JSONB NOT NULL
);

-- ---- engine_versions -------------------------------------------------------
CREATE TABLE IF NOT EXISTS engine_versions (
  engine_version  TEXT PRIMARY KEY,
  model_versions  JSONB NOT NULL
);

-- ---- payments --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  provider_tx_id     TEXT PRIMARY KEY,
  intent_id          TEXT NOT NULL,
  user_id            TEXT NOT NULL,
  rail               TEXT NOT NULL,
  entitlement_type   TEXT NOT NULL,
  amount_usd_micros  BIGINT NOT NULL,
  pricing_version    TEXT NOT NULL,
  status             TEXT NOT NULL,
  created_at         BIGINT NOT NULL,
  verified_at        BIGINT,
  refunded_at        BIGINT
);

-- ---- payment_events (append-only audit of payment state changes) -----------
CREATE TABLE IF NOT EXISTS payment_events (
  provider_tx_id  TEXT NOT NULL,
  event           TEXT NOT NULL,
  at              BIGINT NOT NULL,
  raw_ref         TEXT,
  UNIQUE (provider_tx_id, event)
);

-- ---- entitlements ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS entitlements (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  type                TEXT NOT NULL,
  provider_tx_id      TEXT NOT NULL,
  status              TEXT NOT NULL,
  grants_duration_ms  BIGINT,
  issued_at           BIGINT NOT NULL
);

-- ---- usage_ledger (single-consumption ledger; unique on entitlement) -------
-- NOTE: entitlement_id is the PRIMARY KEY (the single-consumption guarantee),
-- NOT a foreign key. The ledger guards consumption independently and must accept
-- a consume() even when no entitlements row was pre-inserted — this mirrors the
-- in-memory implementation exactly (keys on entitlementId, checks nothing else).
CREATE TABLE IF NOT EXISTS usage_ledger (
  entitlement_id  TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  consumed_at     BIGINT NOT NULL,
  capability_ref  TEXT NOT NULL
);

-- ---- scan_requests ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS scan_requests (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  token_id        BIGINT NOT NULL,
  entitlement_id  TEXT NOT NULL,
  requested_at    BIGINT NOT NULL
);

-- ---- scan_executions -------------------------------------------------------
CREATE TABLE IF NOT EXISTS scan_executions (
  id              TEXT PRIMARY KEY,
  request_id      TEXT NOT NULL,
  status          TEXT NOT NULL,
  started_at      BIGINT NOT NULL,
  finished_at     BIGINT,
  report_ref      TEXT,
  failure_reason  TEXT
);

-- ---- monitoring_sessions ---------------------------------------------------
CREATE TABLE IF NOT EXISTS monitoring_sessions (
  id                          TEXT PRIMARY KEY,
  user_id                     TEXT NOT NULL,
  token_id                    BIGINT NOT NULL,
  chain                       TEXT NOT NULL,
  started_at                  BIGINT NOT NULL,
  expires_at                  BIGINT NOT NULL,
  status                      TEXT NOT NULL,
  pricing_version             TEXT NOT NULL,
  entitlement_id              TEXT NOT NULL,
  last_observation_at         BIGINT,
  last_battlefield_state_at   BIGINT,
  last_event_at               BIGINT
);

-- ---- intelligence_snapshots ------------------------------------------------
CREATE TABLE IF NOT EXISTS intelligence_snapshots (
  id              TEXT PRIMARY KEY,
  token_id        BIGINT NOT NULL,
  session_id      TEXT,
  generated_at    BIGINT NOT NULL,
  report          JSONB NOT NULL,
  engine_version  TEXT NOT NULL,
  model_versions  JSONB NOT NULL,
  source          TEXT NOT NULL,
  created_at      BIGINT NOT NULL
);

-- ---- monitoring_observations (append-only observation provenance) ----------
CREATE TABLE IF NOT EXISTS monitoring_observations (
  id               BIGSERIAL PRIMARY KEY,
  session_id       TEXT NOT NULL,
  token_id         BIGINT NOT NULL,
  observed_at      BIGINT NOT NULL,
  persisted_at     BIGINT NOT NULL,
  source           TEXT NOT NULL,
  engine_version   TEXT NOT NULL,
  fingerprint      TEXT NOT NULL,
  persist_reasons  TEXT[] NOT NULL DEFAULT '{}'
);

-- ---- evidence_records ------------------------------------------------------
CREATE TABLE IF NOT EXISTS evidence_records (
  id           BIGSERIAL PRIMARY KEY,
  snapshot_id  TEXT NOT NULL,
  kind         TEXT NOT NULL,
  factor       TEXT NOT NULL,
  magnitude    DOUBLE PRECISION NOT NULL,
  weight       DOUBLE PRECISION NOT NULL,
  note         TEXT,
  ordinal      INTEGER NOT NULL
);

-- ---- events ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id            BIGSERIAL PRIMARY KEY,
  token_id      BIGINT NOT NULL,
  snapshot_id   TEXT,
  session_id    TEXT,
  type          TEXT NOT NULL,
  at            BIGINT NOT NULL,
  severity      TEXT,
  importance    TEXT,
  reasons       TEXT[] NOT NULL DEFAULT '{}',
  before_state  TEXT,
  after_state   TEXT
);

-- ---- signal_transitions ----------------------------------------------------
CREATE TABLE IF NOT EXISTS signal_transitions (
  id               BIGSERIAL PRIMARY KEY,
  token_id         BIGINT NOT NULL,
  session_id       TEXT,
  signal_identity  TEXT NOT NULL,
  from_phase       TEXT,
  to_phase         TEXT NOT NULL,
  at               BIGINT NOT NULL,
  reasons          TEXT[] NOT NULL DEFAULT '{}',
  UNIQUE (signal_identity, at, to_phase)
);

-- ---- alerts ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alerts (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  session_id  TEXT,
  token_id    BIGINT NOT NULL,
  reason      TEXT NOT NULL,
  at          BIGINT NOT NULL,
  detail      TEXT NOT NULL,
  created_at  BIGINT NOT NULL
);

-- ---- helpful indexes for the hot read paths --------------------------------
CREATE INDEX IF NOT EXISTS idx_monitoring_sessions_user   ON monitoring_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_monitoring_sessions_status ON monitoring_sessions(status);
CREATE INDEX IF NOT EXISTS idx_alerts_user                ON alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_entitlements_user          ON entitlements(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_ledger_user          ON usage_ledger(user_id);
