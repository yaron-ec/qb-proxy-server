-- =====================================================================
-- 2026-68-sms-outbound-notification-categories.sql — EC business-policy
-- DATA backfill (not a schema change): two new notification categories were
-- added to lib/notificationPreferences.js CATEGORIES (sms_sent,
-- sms_delivery_failure — outbound customer-SMS accepted-for-sending and
-- delivery-failure alerts, November 2026). A (user_email, category) pair
-- with no row here defaults to ENABLED (2026-54-notification-preferences.sql's
-- backward-compatible default) — so without this migration, a brand-new
-- category would silently START reaching michelle@ecconstructiongroup.com,
-- even though her existing, approved policy restricts her to exactly ONE
-- category (new_lead). 2026-62-michelle-single-category-notifications.sql's
-- own header comment explicitly calls this out: "a category added there
-- later needs its own row here if Michelle should also be excluded from
-- it." This migration is that follow-up row, for these two new categories
-- only — it does not touch any existing row, and does not change her
-- existing policy, only extends its same intent to the two categories that
-- didn't exist when 2026-62 was written.
--
-- Idempotent (ON CONFLICT DO NOTHING) and additive-only — safe to re-run.
-- =====================================================================

INSERT INTO notification_preferences (user_email, category, enabled)
VALUES
  ('michelle@ecconstructiongroup.com', 'sms_sent', false),
  ('michelle@ecconstructiongroup.com', 'sms_delivery_failure', false)
ON CONFLICT (user_email, category) DO NOTHING;
