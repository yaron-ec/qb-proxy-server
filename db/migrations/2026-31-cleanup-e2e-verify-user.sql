-- 2026-31-cleanup-e2e-verify-user.sql
-- Cleanup: delete the temporary e2e-verify@test.com user created during
-- end-to-end acceptance testing. This user was used to obtain a JWT for
-- API testing and is no longer needed in production.
DELETE FROM users WHERE email = 'e2e-verify@test.com';