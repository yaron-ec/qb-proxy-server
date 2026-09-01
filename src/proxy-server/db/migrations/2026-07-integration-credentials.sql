-- =====================================================================
-- integration_credentials — reusable encrypted credential-management table.
--
-- Long-term credential store for the Railway backend + future Admin UI.
-- Supports QuickBooks now and Gmail, Google Calendar, Google Contacts,
-- SignNow, Handoff, Microsoft 365, Slack, Dropbox, and future integrations
-- without another schema redesign.
--
-- One logical credential per:
--   (provider, credential_type, environment, account_identifier)
--
-- `provider`, `credential_type`, `environment`, `status` are all free-form
-- TEXT validated at the application layer — NO database enums, so adding a
-- new provider or credential_type NEVER requires a schema migration.
--
-- `encrypted_payload` is the full JSON payload encrypted with ENCRYPTION_KEY
-- (AES-256-CBC, version:iv:cipher hex). Plaintext secrets (access/refresh
-- tokens, client secrets, private keys, service-account JSON, passwords, API
-- keys, OAuth ID tokens) are NEVER stored in any other column — only here,
-- encrypted.
--
-- `key_version` records which encryption key version encrypted the payload.
-- It is stored BOTH as a queryable column AND embedded in the encrypted blob
-- (self-describing). On load the stored key_version is checked against the
-- application's known key versions; unknown versions are rejected with a
-- clear error — never silently guessed. This enables future key rotation
-- without downtime or immediate re-encryption of every stored credential.
--
-- `status`, `expires_at`, `last_used_at`, `last_error_at` are non-secret
-- operational fields exposed without decryption, enabling monitoring queries
-- such as:
--   SELECT * FROM integration_credentials
--   WHERE status = 'connected' AND expires_at IS NOT NULL AND expires_at < NOW();
--   SELECT * FROM integration_credentials
--   WHERE last_error_at IS NOT NULL AND last_error_at > NOW() - INTERVAL '1 hour';
--
-- `last_error_message` stores a SHORT sanitized operational message (max 255
-- chars, single line). It MUST NEVER contain access/refresh tokens, auth
-- codes, request/response bodies, client secrets, encryption keys, or stack
-- traces. It is NOT exposed through any health endpoint.
--
-- Applied by: `npm run migrate` (db/migrate.js runs db/migrations/*.sql).
-- NOT auto-run at server startup. Idempotent — safe to re-run.
-- =====================================================================

CREATE TABLE IF NOT EXISTS integration_credentials (
  id                  BIGSERIAL    PRIMARY KEY,
  provider            TEXT         NOT NULL,
  credential_type     TEXT         NOT NULL,
  environment         TEXT         NOT NULL,
  account_identifier  TEXT         NOT NULL,
  display_name        TEXT,
  status              TEXT         NOT NULL DEFAULT 'connected',
  expires_at          TIMESTAMPTZ,
  encrypted_payload   TEXT         NOT NULL,
  key_version         INTEGER      NOT NULL DEFAULT 1,
  connected_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  refreshed_at        TIMESTAMPTZ,
  last_used_at        TIMESTAMPTZ,
  last_error_at       TIMESTAMPTZ,
  last_error_message  TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (provider, credential_type, environment, account_identifier)
);

-- Additive columns for already-migrated environments (idempotent re-run).
-- Safe: ADD COLUMN IF NOT EXISTS is a no-op once the column exists.
ALTER TABLE integration_credentials ADD COLUMN IF NOT EXISTS key_version        INTEGER      NOT NULL DEFAULT 1;
ALTER TABLE integration_credentials ADD COLUMN IF NOT EXISTS last_used_at       TIMESTAMPTZ;
ALTER TABLE integration_credentials ADD COLUMN IF NOT EXISTS last_error_at      TIMESTAMPTZ;
ALTER TABLE integration_credentials ADD COLUMN IF NOT EXISTS last_error_message TEXT;

-- Active-credential lookup by provider + capability + environment.
CREATE INDEX IF NOT EXISTS idx_integration_credentials_pce
  ON integration_credentials (provider, credential_type, environment);

-- Operational monitoring by status (e.g. connected / expired / revoked).
CREATE INDEX IF NOT EXISTS idx_integration_credentials_status
  ON integration_credentials (status);

-- Expiration monitoring (expiring-soon / already-expired queries).
CREATE INDEX IF NOT EXISTS idx_integration_credentials_expires
  ON integration_credentials (expires_at);

-- Recent-failure monitoring (credentials with errors in the last hour).
CREATE INDEX IF NOT EXISTS idx_integration_credentials_last_error
  ON integration_credentials (last_error_at);

-- Keep updated_at honest on every UPDATE (refresh / re-save / status change /
-- markUsed / markError). last_used_at and last_error_at are set explicitly by
-- the application; this trigger only maintains updated_at.
CREATE OR REPLACE FUNCTION integration_credentials_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_integration_credentials_touch ON integration_credentials;
CREATE TRIGGER trg_integration_credentials_touch
  BEFORE UPDATE ON integration_credentials
  FOR EACH ROW EXECUTE FUNCTION integration_credentials_touch_updated_at();