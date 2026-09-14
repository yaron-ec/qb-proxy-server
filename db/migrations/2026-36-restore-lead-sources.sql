-- 2026-36-restore-lead-sources.sql
-- Restore Lead Sources list in app_settings.value.sources ONLY.
-- Preserves all other fields in the JSON document. Idempotent.

DO $$
DECLARE
  v_current JSONB;
  v_sources JSONB := '["Sharon","Yair","Yelp","Instagram / Facebook","Referral","Repeat customer","Ethan","Website","Other"]'::jsonb;
BEGIN
  SELECT value INTO v_current FROM app_settings WHERE key = 'app_lists';
  IF v_current IS NULL THEN v_current := '{}'::jsonb; END IF;

  -- Set ONLY sources; every other field preserved as-is
  v_current := jsonb_set(v_current, '{sources}', v_sources, true);

  INSERT INTO app_settings (key, value, type, updated_at)
  VALUES ('app_lists', v_current, 'json', NOW())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
END $$;
