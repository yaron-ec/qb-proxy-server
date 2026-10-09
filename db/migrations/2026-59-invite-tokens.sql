-- Invite/activation tokens for users (PRODUCTIZATION — Company Provisioning
-- System, multi-company onboarding). A user created with no password (a
-- brand-new company's first admin, created by scripts/install/bootstrap.js
-- without admin_password; or an employee invited via
-- POST /api/v1/auth/invite) gets an invite token here instead. Only the
-- SHA-256 hash is ever stored — the raw token is emailed once and never
-- persisted — same pattern as refresh_tokens' token_hash.
--
-- A user with password_hash IS NULL cannot log in via
-- authService#authenticatePassword (it checks `!user.password_hash` first),
-- so an un-activated invite is already safely unable to sign in before this
-- migration adds anything; these columns only add the ability to safely
-- SET a password via a single-use, expiring link
-- (POST /api/v1/auth/accept-invite).
ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_token_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_expires_at TIMESTAMPTZ;

-- Fast lookup by token hash during accept-invite (a public, unauthenticated
-- endpoint called at most once per real invite — index keeps that single
-- query cheap regardless of table size).
CREATE INDEX IF NOT EXISTS users_invite_token_hash_idx ON users (invite_token_hash) WHERE invite_token_hash IS NOT NULL;
