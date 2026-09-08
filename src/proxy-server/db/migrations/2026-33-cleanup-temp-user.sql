-- 2026-33-cleanup-temp-user.sql — Remove temporary acceptance-test user
--
-- Safely deletes the temp user created during LIVE acceptance testing.
-- The only FK reference is refresh_tokens.user_id, which is deleted first.
-- Idempotent: safe to re-run (no-op if user already deleted).

-- Delete refresh tokens for the temp user (only FK reference)
DELETE FROM refresh_tokens
WHERE user_id = (SELECT id FROM users WHERE email = 'live-acceptance-test@ecconstructiongroup.com');

-- Delete the temp user
DELETE FROM users
WHERE email = 'live-acceptance-test@ecconstructiongroup.com';
