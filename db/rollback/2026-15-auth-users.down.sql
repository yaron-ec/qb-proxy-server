-- Rollback for 2026-15-auth-users.sql
-- Does NOT drop the users or refresh_tokens tables (they are owned by schema.sql).
-- Only removes objects added by 2026-15.

DROP TRIGGER IF EXISTS update_users_updated_at ON users;
DROP FUNCTION IF EXISTS update_users_updated_at();

DROP INDEX IF EXISTS idx_refresh_tokens_expires;
DROP INDEX IF EXISTS idx_refresh_tokens_user_id;
DROP INDEX IF EXISTS idx_users_google_sub;
DROP INDEX IF EXISTS idx_users_email_lower;

-- Do NOT drop constraints or columns — they may have been created by schema.sql
-- and dropping them would break auth. This rollback is intentionally minimal.