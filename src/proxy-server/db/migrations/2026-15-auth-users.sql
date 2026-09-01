-- =====================================================================
-- 2026-15-auth-users.sql — Railway auth users/roles schema verification
--
-- Ensures the users and refresh_tokens tables have all columns required
-- by lib/authService.js. Idempotent (ADD COLUMN IF NOT EXISTS).
--
-- PREREQUISITE: db/schema.sql (which creates the initial users + refresh_tokens
-- tables). This migration only adds any missing columns.
-- =====================================================================

-- ── Users table — ensure all required columns exist ─────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Ensure email is unique (case-insensitive). Uses a unique INDEX on the
-- expression lower(email) — PostgreSQL does NOT allow function expressions
-- inside a table-level UNIQUE constraint. schema.sql already creates
-- users_email_uidx; this is a no-op if that index already exists.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email));

-- ── Refresh tokens table — ensure all required columns exist ────────────────
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS token_hash TEXT NOT NULL;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS user_id UUID NOT NULL;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS rotated_from TEXT;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Ensure token_hash is unique. schema.sql already creates refresh_tokens_hash_uidx;
-- this is a no-op if that index already exists.
CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_token_hash_key ON refresh_tokens (token_hash);

-- ── Indexes for auth performance ────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email));
CREATE INDEX IF NOT EXISTS idx_users_google_sub ON users (google_sub) WHERE google_sub IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens (expires_at) WHERE revoked_at IS NULL;

-- ── updated_at trigger for users ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_users_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_users_updated_at();