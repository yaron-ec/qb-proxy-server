-- =====================================================================
-- 2026-62-michelle-single-category-notifications.sql — EC business-policy
-- DATA backfill (not a schema change): michelle@ecconstructiongroup.com
-- receives exactly ONE CRM-generated email category — a genuinely new lead
-- (notification_preferences.category = 'new_lead', which has NO row here
-- and is therefore left enabled, matching the table's backward-compatible
-- "absence = enabled" default from 2026-54-notification-preferences.sql).
--
-- Every other category this installation currently sends is explicitly
-- disabled for her here: appointment, follow_up, reminder, overdue,
-- estimate, invoice_payment, contract_signed, sold, system_failure,
-- status_change, lead_update, activity, deal (lib/notificationPreferences.js
-- CATEGORIES — keep this list in sync with that file; a category added
-- there later needs its own row here if Michelle should also be excluded
-- from it).
--
-- This is EC's own specific business policy, not a platform default — it is
-- seeded as DATA in this migration (the same pattern 2026-47 used to
-- backfill EC's historical notification_recipients), never as a hardcoded
-- email-address check in application code. A second company's installation
-- never runs this migration against its own database, so it is never
-- affected. Does not touch Michelle's user role/permissions in any way —
-- purely a row in notification_preferences, the same table/mechanism an
-- admin could use via POST /api/v1/notification-preferences.
--
-- Idempotent (ON CONFLICT DO NOTHING) and additive-only — safe to re-run.
-- =====================================================================

INSERT INTO notification_preferences (user_email, category, enabled)
VALUES
  ('michelle@ecconstructiongroup.com', 'appointment', false),
  ('michelle@ecconstructiongroup.com', 'follow_up', false),
  ('michelle@ecconstructiongroup.com', 'reminder', false),
  ('michelle@ecconstructiongroup.com', 'overdue', false),
  ('michelle@ecconstructiongroup.com', 'estimate', false),
  ('michelle@ecconstructiongroup.com', 'invoice_payment', false),
  ('michelle@ecconstructiongroup.com', 'contract_signed', false),
  ('michelle@ecconstructiongroup.com', 'sold', false),
  ('michelle@ecconstructiongroup.com', 'system_failure', false),
  ('michelle@ecconstructiongroup.com', 'status_change', false),
  ('michelle@ecconstructiongroup.com', 'lead_update', false),
  ('michelle@ecconstructiongroup.com', 'activity', false),
  ('michelle@ecconstructiongroup.com', 'deal', false)
ON CONFLICT (user_email, category) DO NOTHING;
