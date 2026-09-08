-- 2026-33-normalize-reminder-claims.sql
-- Normalize historical reminder_claims marked "sent" with no Gmail message IDs
-- and no associated email_send_logs to "skipped_no_recipient".
--
-- This corrects the semantic issue where claims were marked "sent" even though
-- no emails were actually delivered (customer email null + notifyStaff=false).
-- Only normalizes rows where the evidence is unambiguous:
--   status = 'sent' AND gmail_message_ids = '[]'::jsonb
-- Rows with actual Gmail message IDs are NOT touched.

UPDATE reminder_claims
SET status = 'skipped_no_recipient'
WHERE status = 'sent'
  AND (gmail_message_ids IS NULL OR gmail_message_ids = '[]'::jsonb);
