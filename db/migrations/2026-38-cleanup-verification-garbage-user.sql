-- 2026-38-cleanup-verification-garbage-user.sql
-- One-time cleanup: delete the garbage admin user created during production
-- verification (admin-set-password with invalid ADMIN_EMAIL = 'Ymargsed964346!').
--
-- SAFETY: This migration targets ONLY the exact immutable user ID and asserts
-- ALL expected characteristics before deleting. If ANY predicate does not match,
-- the migration ABORTS (via RAISE EXCEPTION) and deletes NOTHING.
--
-- FK SAFETY: Checks all business-data references before deleting. Only
-- refresh_tokens (session tokens) are deleted first. If any business-data
-- reference exists, the migration ABORTS and deletes NOTHING.
--
-- After successful application, this file should be removed from the
-- migrations directory so it does not execute in other environments.

DO $$
DECLARE
  v_user_id CONSTANT UUID := 'f4f6a9f6-bf3e-4d0d-84b0-a836290223b1';
  v_expected_email CONSTANT TEXT := 'Ymargsed964346!';
  v_expected_role CONSTANT TEXT := 'admin';
  v_expected_created_at CONSTANT TIMESTAMPTZ := '2026-09-14T06:34:10.248Z';

  v_actual_email TEXT;
  v_actual_role TEXT;
  v_actual_google_sub TEXT;
  v_actual_created_at TIMESTAMPTZ;
  v_prod_refs INTEGER := 0;
  v_count INTEGER;
  v_deleted_count INTEGER;
BEGIN
  -- Step 1: Assert the row exists and matches ALL expected characteristics
  SELECT email, role, google_sub, created_at
  INTO v_actual_email, v_actual_role, v_actual_google_sub, v_actual_created_at
  FROM users WHERE id = v_user_id;

  IF NOT FOUND THEN
    RAISE NOTICE 'SKIP: User % not found (already deleted)', v_user_id;
    RETURN;
  END IF;

  IF v_actual_email != v_expected_email THEN
    RAISE EXCEPTION 'ABORT: email mismatch. Expected %, got %', v_expected_email, v_actual_email;
  END IF;

  IF v_actual_role != v_expected_role THEN
    RAISE EXCEPTION 'ABORT: role mismatch. Expected %, got %', v_expected_role, v_actual_role;
  END IF;

  IF v_actual_google_sub IS NOT NULL THEN
    RAISE EXCEPTION 'ABORT: google_sub is not NULL (got %)', v_actual_google_sub;
  END IF;

  IF v_actual_created_at != v_expected_created_at THEN
    RAISE EXCEPTION 'ABORT: created_at mismatch. Expected %, got %', v_expected_created_at, v_actual_created_at;
  END IF;

  -- Step 2: Check for business-data references (only tables/columns that exist)
  IF to_regclass('public.deals') IS NOT NULL THEN
    EXECUTE 'SELECT COUNT(*) FROM deals WHERE assigned_rep = $1' INTO v_count USING v_expected_email;
    v_prod_refs := v_prod_refs + v_count;
  END IF;

  IF to_regclass('public.activities') IS NOT NULL THEN
    EXECUTE 'SELECT COUNT(*) FROM activities WHERE author = $1' INTO v_count USING v_expected_email;
    v_prod_refs := v_prod_refs + v_count;
  END IF;

  IF to_regclass('public.tasks') IS NOT NULL THEN
    EXECUTE 'SELECT COUNT(*) FROM tasks WHERE assigned_to = $1' INTO v_count USING v_expected_email;
    v_prod_refs := v_prod_refs + v_count;
  END IF;

  IF to_regclass('public.reminder_leads') IS NOT NULL THEN
    EXECUTE 'SELECT COUNT(*) FROM reminder_leads WHERE assigned_rep = $1' INTO v_count USING v_expected_email;
    v_prod_refs := v_prod_refs + v_count;
  END IF;

  IF to_regclass('public.owners') IS NOT NULL THEN
    EXECUTE 'SELECT COUNT(*) FROM owners WHERE email = $1' INTO v_count USING v_expected_email;
    v_prod_refs := v_prod_refs + v_count;
  END IF;

  IF to_regclass('public.deal_commissions') IS NOT NULL AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'deal_commissions' AND column_name = 'recipient_user_id'
  ) THEN
    EXECUTE 'SELECT COUNT(*) FROM deal_commissions WHERE recipient_user_id = $1' INTO v_count USING v_user_id;
    v_prod_refs := v_prod_refs + v_count;
  END IF;

  IF to_regclass('public.deal_expenses') IS NOT NULL AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'deal_expenses' AND column_name = 'created_by'
  ) THEN
    EXECUTE 'SELECT COUNT(*) FROM deal_expenses WHERE created_by = $1' INTO v_count USING v_expected_email;
    v_prod_refs := v_prod_refs + v_count;
  END IF;

  IF to_regclass('public.leads') IS NOT NULL AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'leads' AND column_name = 'owner_id'
  ) THEN
    EXECUTE 'SELECT COUNT(*) FROM leads WHERE owner_id = $1' INTO v_count USING v_user_id;
    v_prod_refs := v_prod_refs + v_count;
  END IF;

  IF to_regclass('public.appointments') IS NOT NULL AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'appointments' AND column_name = 'owner_id'
  ) THEN
    EXECUTE 'SELECT COUNT(*) FROM appointments WHERE owner_id = $1' INTO v_count USING v_user_id;
    v_prod_refs := v_prod_refs + v_count;
  END IF;

  IF v_prod_refs > 0 THEN
    RAISE EXCEPTION 'ABORT: User has % business-data references. NOT deleted.', v_prod_refs;
  END IF;

  -- Step 3: Delete refresh_tokens (session tokens only)
  DELETE FROM refresh_tokens WHERE user_id = v_user_id;

  -- Step 4: Delete the user and assert exactly ONE row deleted
  DELETE FROM users WHERE id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  IF v_deleted_count != 1 THEN
    RAISE EXCEPTION 'ABORT: Expected 1 row deleted, got %', v_deleted_count;
  END IF;

  RAISE NOTICE 'DELETED: garbage user % (%)', v_expected_email, v_user_id;
END $$;
