-- 2026-34-cleanup-garbage-admins.sql — Remove garbage/test admin accounts
--
-- Deletes test/garbage admin accounts verified to have NO production data
-- dependencies (no leads, deals, activities, tasks, or owner references).
-- Refresh tokens (session tokens) are deleted first, then the user row.
--
-- Accounts deleted:
--   admin@test.com
--   test@example.com
--   test-runtime-probe@ecconstructiongroup.com
--   Ymargsed964346!
--
-- Safety: For each account, checks production data dependencies BEFORE delete.
--   If any production data reference is found, the account is SKIPped.
--   Refresh tokens are NOT counted as production data (they are session tokens).
--
-- Idempotent: safe to re-run (no-op if user already deleted).

DO $$
DECLARE
  test_email TEXT;
  test_user_id UUID;
  prod_refs INTEGER;
  test_emails TEXT[] := ARRAY[
    'admin@test.com',
    'test@example.com',
    'test-runtime-probe@ecconstructiongroup.com',
    'Ymargsed964346!'
  ];
BEGIN
  FOREACH test_email IN ARRAY test_emails LOOP
    SELECT id INTO test_user_id FROM users WHERE email = test_email;
    IF test_user_id IS NULL THEN
      RAISE NOTICE 'SKIP: % not found (already deleted)', test_email;
      CONTINUE;
    END IF;

    -- Check production data dependencies (NOT refresh_tokens — those are session tokens)
    SELECT COUNT(*) INTO prod_refs FROM (
      SELECT 1 FROM deals WHERE assigned_rep = test_email
      UNION ALL
      SELECT 1 FROM activities WHERE author = test_email
      UNION ALL
      SELECT 1 FROM tasks WHERE assigned_to = test_email
      UNION ALL
      SELECT 1 FROM reminder_leads WHERE assigned_rep = test_email
      UNION ALL
      SELECT 1 FROM owners WHERE email = test_email
    ) sub;

    IF prod_refs > 0 THEN
      RAISE NOTICE 'SKIP: % has % production data dependencies — NOT deleted', test_email, prod_refs;
      CONTINUE;
    END IF;

    -- Safe to delete: refresh tokens first, then user
    DELETE FROM refresh_tokens WHERE user_id = test_user_id;
    DELETE FROM users WHERE id = test_user_id;
    RAISE NOTICE 'DELETED: % (id=%)', test_email, test_user_id;
  END LOOP;
END $$;
