-- =====================================================================
-- R1A CRM Core Migration — 2026-09
--
-- Adds CRM fields to the existing `leads` table, creates `activities`
-- and `settings` tables for the Railway CRM frontend foundation.
--
-- REUSE-FIRST: extends existing tables; does NOT recreate the Base44
-- entity model. Idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
--
-- DO NOT RUN IN PRODUCTION until approved. This file is the exact
-- migration that would be applied via: node db/migrate.js
-- =====================================================================

-- ---------------------------------------------------------------------
-- leads: CRM field expansion (existing table already has identity,
-- owner_id, status, project_type, budget_range, source, notes, etc.)
-- Add only the fields the CRM frontend needs that are not yet present.
-- ---------------------------------------------------------------------

ALTER TABLE leads ADD COLUMN IF NOT EXISTS message TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_new_intake_lead BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS customer_reminders_disabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS photo_urls TEXT[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE leads ADD COLUMN IF NOT EXISTS crm_created_date TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS record_type TEXT NOT NULL DEFAULT 'Lead'
  CHECK (record_type IN ('Lead','Vendor','Subcontractor','Supplier','Employee','Applicant','Contact'));
ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_date TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_time TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_type TEXT
  CHECK (follow_up_type IS NULL OR follow_up_type IN ('Phone Call','Meeting'));
ALTER TABLE leads ADD COLUMN IF NOT EXISTS meeting_stage TEXT
  CHECK (meeting_stage IS NULL OR meeting_stage IN ('First Meeting','Second Meeting','Third Meeting'));

-- Indexes for CRM list filtering
CREATE INDEX IF NOT EXISTS leads_status_idx ON leads (status);
CREATE INDEX IF NOT EXISTS leads_record_type_idx ON leads (record_type);
CREATE INDEX IF NOT EXISTS leads_crm_created_date_idx ON leads (crm_created_date DESC);
CREATE INDEX IF NOT EXISTS leads_follow_up_date_idx ON leads (follow_up_date) WHERE follow_up_date IS NOT NULL;

-- ---------------------------------------------------------------------
-- activities — CRM activity history (replaces Base44 Activity entity).
-- Minimal: lead-scoped, typed, with author + source + JSONB metadata.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activities (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('note','call','email','meeting','task')),
  content     TEXT NOT NULL,
  author      TEXT,
  source      TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('hubspot','gmail','calendar','manual')),
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS activities_lead_idx ON activities (lead_id, created_at DESC);

CREATE OR REPLACE FUNCTION activities_touch_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS activities_set_updated_at ON activities;
CREATE TRIGGER activities_set_updated_at BEFORE UPDATE ON activities
  FOR EACH ROW EXECUTE FUNCTION activities_touch_updated_at();

-- ---------------------------------------------------------------------
-- settings — singleton CRM settings row (replaces Base44 Settings entity).
-- app_lists holds project types, sources, budgets, etc. as JSONB.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  id              INTEGER PRIMARY KEY DEFAULT 1,
  company_name    TEXT,
  company_email   TEXT,
  company_phone   TEXT,
  company_address TEXT,
  company_city    TEXT,
  company_state   TEXT,
  company_zip     TEXT,
  company_website TEXT,
  admin_name      TEXT,
  admin_email     TEXT,
  app_lists       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION settings_touch_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS settings_set_updated_at ON settings;
CREATE TRIGGER settings_set_updated_at BEFORE UPDATE ON settings
  FOR EACH ROW EXECUTE FUNCTION settings_touch_updated_at();