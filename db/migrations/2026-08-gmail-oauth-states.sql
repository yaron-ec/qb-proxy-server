-- =====================================================================
-- gmail_oauth_states — temporary OAuth state store for the one-time
-- Gmail OAuth authorization flow (lib/gmailOAuthRouter.js).
--
-- Stores ONLY the SHA-256 hash of the state (never the raw state).
-- States expire in 10 minutes and are single-use (used_at is set on claim).
--
-- This table is separate from email_send_claims and reminder_claims.
-- It holds no tokens, no credentials, and no customer data.
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