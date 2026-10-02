-- 2026-36-restore-lead-sources.sql
-- Restore Lead Sources list in app_settings.value.sources ONLY.
-- Preserves all other fields in the JSON document. Idempotent.
--
-- PRODUCTIZATION GUARD (added after this migration had already applied to
-- EC's production database, so this change has zero effect there — the
-- migration runner never re-executes an already-applied migration): this
-- was a one-time EC-specific DATA REPAIR (EC's real lead-source list had
-- been accidentally lost in production) pushed via the migration pipeline
-- because that was the available deploy mechanism at the time — not a
-- schema change, and not something a brand-new installation's history
-- should replay. Without this guard, EVERY fresh installation running the
-- full migration chain for the first time (scripts/install/bootstrap.js)
-- would silently inherit EC's own named lead sources ("Sharon", "Yair",
-- "Ethan" — real individuals, not generic categories) into its own
-- app_settings, in direct violation of the single-tenant-per-deployment
-- product model. Guarded on `owners` already having at least one row:
-- true for EC (an operating business with real staff already in the table
-- by the time the original data loss happened) and false for a truly
-- fresh database (bootstrap.js's ensureFirstAdmin/ensureCompanySettings
-- run AFTER all migrations, so a fresh DB has zero owners at this point).
DO $$
DECLARE
  v_current JSONB;
  v_sources JSONB := '["Sharon","Yair","Yelp","Instagram / Facebook","Referral","Repeat customer","Ethan","Website","Other"]'::jsonb;
BEGIN
  IF (SELECT COUNT(*) FROM owners) = 0 THEN
    RETURN; -- fresh installation — never seed EC's own named data here
  END IF;

  SELECT value INTO v_current FROM app_settings WHERE key = 'app_lists';
  IF v_current IS NULL THEN v_current := '{}'::jsonb; END IF;

  -- Set ONLY sources; every other field preserved as-is
  v_current := jsonb_set(v_current, '{sources}', v_sources, true);

  INSERT INTO app_settings (key, value, type, updated_at)
  VALUES ('app_lists', v_current, 'json', NOW())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
END $$;
