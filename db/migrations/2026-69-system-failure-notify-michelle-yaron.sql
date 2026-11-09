-- =====================================================================
-- 2026-69-system-failure-notify-michelle-yaron.sql — EC business-policy
-- DATA change (not a schema change): explicit product decision — a
-- critical system failure or recovery alert must reach BOTH
-- michelle@ecconstructiongroup.com and yaron@ecconstructiongroup.com,
-- email only (see lib/monitoring/alertDispatcher.js's staff-broadcast path,
-- which already routes every monitoring alert — warning/critical/info —
-- through notificationRecipients.getAllStaffRecipients() narrowed by
-- notificationPreferences.filterRecipientsForCategory(...,
-- CATEGORIES.SYSTEM_FAILURE). This migration is a scoped, explicit
-- EXCEPTION to Michelle's general single-category (new_lead-only) policy —
-- approved for this one category only, nothing else about that policy
-- changes.
--
-- Michelle currently has an EXISTING disabling row for this exact category
-- (('michelle@ecconstructiongroup.com', 'system_failure', false), inserted
-- by 2026-62-michelle-single-category-notifications.sql, already applied).
-- Per this codebase's own migration convention (CLAUDE.md: never edit an
-- already-applied migration — db/migrate.js never re-executes a filename
-- it has already recorded in schema_migrations), this MUST be a new,
-- separate migration that flips the existing row rather than an edit to
-- 2026-62 itself, which would silently never apply anywhere 2026-62 has
-- already run. ON CONFLICT ... DO UPDATE (not DO NOTHING) is required here
-- specifically because the row to change for Michelle already exists —
-- a plain idempotent insert would never update it.
--
-- Yaron has no existing notification_preferences row for ANY category —
-- under 2026-54-notification-preferences.sql's backward-compatible
-- default ("a (user_email, category) pair with no row is ENABLED"), he
-- already receives system_failure alerts today with zero rows at all.
-- This migration adds an explicit, durable enabled:true row for him
-- anyway so the approved decision is self-documenting in the data itself
-- (not merely an implicit default), matching the explicit nature of
-- Michelle's row below; functionally a no-op for him either way, since
-- notificationPreferences.js#filterRecipientsForCategory only ever queries
-- for enabled=false rows to EXCLUDE someone.
--
-- Does not touch any other category for either address, Michelle's other
-- 12 disabling rows from 2026-62, either user's role/permissions, or the
-- alert dedup mechanism (lib/monitoring/crashLoopDetector.js's
-- shouldAlert — unchanged by this migration). No SMS of any kind is
-- involved here — this is purely the existing email staff-broadcast path.
--
-- Idempotent and safe to re-run.
-- =====================================================================

INSERT INTO notification_preferences (user_email, category, enabled)
VALUES
  ('michelle@ecconstructiongroup.com', 'system_failure', true),
  ('yaron@ecconstructiongroup.com', 'system_failure', true)
ON CONFLICT (user_email, category) DO UPDATE SET enabled = true, updated_at = NOW();
