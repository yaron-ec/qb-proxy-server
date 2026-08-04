-- =====================================================================
-- Phase 1 — Railway Email Service + Railway Authentication
-- Idempotent migration. Safe to re-run. (Also appended to db/schema.sql
-- so ensureSchema() applies it automatically; this file exists for an
-- explicit, reviewable migration run via `npm run reminders:migrate`.)
-- =====================================================================

-- ---------------------------------------------------------------------
-- email_send_claims — idempotency gate for every ad-hoc email send.
-- UNIQUE idempotency_key guarantees at-most-once delivery across
-- retries, crashes, and duplicate API calls.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_send_claims (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key   TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','sent','failed')),
  recipient         TEXT,
  subject           TEXT,
  gmail_message_id  TEXT,
  last_error        TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at           TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS email_send_claims_key_uidx
  ON email_send_claims (idempotency_key);

-- ---------------------------------------------------------------------
-- email_send_logs — immutable per-recipient delivery audit trail.
-- One row per actual Gmail API attempt (a claim may produce several
-- during retries). Used for delivery tracking + diagnostics.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_send_logs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id          UUID REFERENCES email_send_claims(id) ON DELETE CASCADE,
  idempotency_key   TEXT NOT NULL,
  role              TEXT,                          -- customer|staff|internal|test|...
  recipient         TEXT NOT NULL,
  cc                TEXT[],
  reply_to          TEXT,
  sender            TEXT,
  subject           TEXT,
  gmail_message_id  TEXT,
  status            TEXT NOT NULL CHECK (status IN ('sent','failed')),
  error             TEXT,
  attempts          INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS email_send_logs_claim_idx ON email_send_logs (claim_id);
CREATE INDEX IF NOT EXISTS email_send_logs_created_idx ON email_send_logs (created_at);

-- =====================================================================
-- Railway-owned authentication (PERMANENT — replaces Base44 auth).
-- =====================================================================

-- ---------------------------------------------------------------------
-- users — Railway is the identity + authorization source of truth.
--   password_hash  NULLABLE: NULL for SSO-only (Google OIDC) accounts.
--   google_sub     Google OIDC subject identifier (for SSO users).
-- Seeded once from Base44 User via the TEMPORARY /api/v1/auth/migrate
-- bridge, then authoritative. No Base44 dependency after Stage 9.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL,
  full_name     TEXT,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','manager','sales_rep','office','user')),
  password_hash TEXT,                            -- scrypt:N:r:p:saltHex:hashHex (NULL = SSO only)
  google_sub    TEXT,                            -- Google OIDC subject (NULL = password user)
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_uidx ON users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_uidx ON users (google_sub) WHERE google_sub IS NOT NULL;

-- ---------------------------------------------------------------------
-- refresh_tokens — rotating, revocable refresh sessions.
-- Only SHA-256(token) is stored; the raw token is returned to the client
-- once at issue/rotate time and never logged.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   TEXT NOT NULL,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   TIMESTAMPTZ NOT NULL,
  issued_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_from TEXT,                              -- token_hash this rotated from (audit)
  revoked_at   TIMESTAMPTZ,                       -- NULL = active
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_hash_uidx ON refresh_tokens (token_hash);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_active_idx ON refresh_tokens (expires_at) WHERE revoked_at IS NULL;

-- =====================================================================
-- gmail_oauth_states — temporary OAuth state store for the one-time
-- Gmail OAuth authorization flow (lib/gmailOAuthRouter.js).
--
-- Stores ONLY the SHA-256 hash of the state (never the raw state).
-- States expire in 10 minutes and are single-use (used_at is set on claim).
-- =====================================================================

CREATE TABLE IF NOT EXISTS gmail_oauth_states (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash      TEXT NOT NULL,
  expected_email  TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS gmail_oauth_states_hash_uidx
  ON gmail_oauth_states (state_hash);

CREATE INDEX IF NOT EXISTS gmail_oauth_states_expires_idx
  ON gmail_oauth_states (expires_at)
  WHERE used_at IS NULL;