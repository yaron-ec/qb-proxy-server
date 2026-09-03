-- 2026-30-app-settings-kv.sql
-- Create a proper key-value app_settings table for storing app-level settings
-- (job types, Handoff bearer tokens, integration config, etc.)
--
-- ROOT CAUSE: The existing `settings` table is a SINGLE-ROW company profile
-- table (id=1, company_name, app_lists, etc.) -- NOT a key-value store.
-- The /api/v1/settings route and handoffSync auth routes expected a KV table
-- with key/value/type columns, which never existed. This migration creates
-- the missing table and migrates any existing app_lists data.

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  type TEXT NOT NULL DEFAULT 'json',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Migrate app_lists from the single-row settings table to app_settings
-- (only if app_lists has real data, not just the default empty '{}')
INSERT INTO app_settings (key, value, type)
SELECT 'app_lists', app_lists, 'json'
FROM settings
WHERE app_lists IS NOT NULL
  AND app_lists != '{}'::jsonb
ON CONFLICT (key) DO NOTHING;

-- updated_at trigger
CREATE OR REPLACE FUNCTION app_settings_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_settings_set_updated_at ON app_settings;
CREATE TRIGGER app_settings_set_updated_at
  BEFORE UPDATE ON app_settings
  FOR EACH ROW
  EXECUTE FUNCTION app_settings_touch_updated_at();