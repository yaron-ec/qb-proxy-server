-- =====================================================================
-- 2026-46-product-config.sql
--
-- PRODUCTIZATION FOUNDATION (Phase 1: productized single-tenant-per-
-- deployment model — one company per database, NOT shared multi-tenancy).
--
-- Extends the existing company_settings singleton (already the correct
-- per-installation config surface under this model — see
-- routes/companySettings.js) with the fields the CRM's business logic
-- currently hardcodes per-file (timezone, buffer/travel minutes, legal
-- identity, branding, enabled modules), plus a stable installation
-- identity used by destructive maintenance tooling to confirm which
-- database it is talking to before mutating data (see
-- lib/installationIdentity.js).
--
-- This migration is purely ADDITIVE:
--   - every new column is nullable or has a default equal to today's
--     hardcoded behavior, so an existing (EC) row keeps working exactly
--     as before until an admin explicitly changes a value;
--   - no existing column, table, or row is modified or removed;
--   - installation_id is backfilled for any existing singleton row so
--     upgrading an EC-shaped database never leaves it null.
--
-- Idempotent (IF NOT EXISTS / conditional backfill). Safe to re-run.
-- Applied via: node db/migrate.js
-- =====================================================================

-- ── Legal / brand identity (distinct from the display company_name) ────────
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS legal_name TEXT;
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS dba TEXT;
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS favicon_url TEXT;
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS brand_primary_color TEXT;

-- ── Locale / scheduling defaults ────────────────────────────────────────────
-- Default matches the CRM's current hardcoded fallback (America/Los_Angeles,
-- used throughout lib/booking/*, lib/reminderTime.js, etc.) so an existing
-- installation's effective behavior is unchanged until this is set explicitly
-- to something else on a fresh, non-EC install.
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles';
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'en-US';

-- Per-day open/close business hours, used only as a configuration surface
-- today (not yet wired into availability logic — see
-- lib/booking/availabilityService.js, which currently derives working hours
-- from appointment_types/owner schedules). NULL = "not configured", existing
-- behavior unchanged.
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS business_hours JSONB;

-- Matches lib/booking/bookingService.js's current hardcoded 60-minute
-- before/after travel buffer for a real Meeting appointment. Phone Call
-- appointments are unaffected (they are always skip_travel=true regardless
-- of this value — see CLAUDE.md's Phone Call non-blocking invariant).
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS appointment_travel_buffer_minutes INTEGER NOT NULL DEFAULT 60;

-- ── Module enablement (per-installation optional integrations/features) ────
-- Keys mirror the integrations documented in CLAUDE.md's Integration map
-- (quickbooks, gmail, google_calendar, signnow, handoff, meta, sms,
-- website_intake). true = enabled. Defaults to an object with every key
-- true, which is EC's actual current state (every one of these is live in
-- production today) — so an upgraded EC row's effective behavior is
-- unchanged. A brand-new installation's bootstrap explicitly writes only
-- the modules it configures, defaulting the rest to false.
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS enabled_modules JSONB NOT NULL DEFAULT
  '{"quickbooks": true, "gmail": true, "google_calendar": true, "google_contacts": true, "signnow": true, "handoff": true, "meta": true, "sms": true, "website_intake": true}'::jsonb;

-- ── Installation identity ───────────────────────────────────────────────────
-- A stable, immutable-once-set identifier for THIS database, independent of
-- the human-editable company_name. Used by lib/installationIdentity.js as a
-- safety gate for destructive maintenance/migration/restore tooling: a
-- script can require --confirm-installation=<installation_id> before
-- touching data, so it is structurally impossible to point a script built
-- for one company's database at another's by mistake (e.g. a copy-pasted
-- command, or a wrong DATABASE_URL in a shared terminal).
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS installation_id UUID DEFAULT gen_random_uuid();

-- Backfill: any existing singleton row (e.g. EC's) gets a stable id now,
-- generated once. A fresh installation's bootstrap sets this explicitly at
-- creation time instead of relying on this backfill.
UPDATE company_settings SET installation_id = gen_random_uuid() WHERE installation_id IS NULL;
