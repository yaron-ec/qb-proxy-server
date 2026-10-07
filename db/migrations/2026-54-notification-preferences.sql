-- =====================================================================
-- 2026-54-notification-preferences.sql — Generic per-user notification
-- category preferences (CRM STABILITY PHASE, Section H).
--
-- Before this migration, every staff-facing CRM notification (new lead,
-- appointment, follow-up, reminder, contract signed, system failure, etc.)
-- went unconditionally to EVERY address in company_settings.
-- notification_recipients (lib/notificationRecipients.js#getAllStaffRecipients) —
-- there was no way for one staff member to receive only a subset of
-- notification categories (e.g. "New Lead only") without another staff
-- member also losing notifications, since it was one flat list shared by
-- every category.
--
-- This table lets an admin disable specific categories for a specific
-- user, without touching the global recipient list. Absence of a row for
-- a (user_email, category) pair means ENABLED — this is the deliberate,
-- backward-compatible default so applying this migration never silently
-- stops any notification nobody has explicitly opted out of yet. No rows
-- are seeded by this migration — preferences are admin-configured via
-- POST /api/v1/notification-preferences, never hardcoded to any specific
-- company's staff roster here.
--
-- Startup-safe: additive table only, CREATE TABLE IF NOT EXISTS.
-- =====================================================================

CREATE TABLE IF NOT EXISTS notification_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email TEXT NOT NULL,
  category TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_email, category)
);

CREATE INDEX IF NOT EXISTS notification_preferences_user_idx ON notification_preferences (user_email);
