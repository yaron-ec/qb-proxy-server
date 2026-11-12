-- November 2026 CRM hardening pass: routes/signnowWebhook.js's own header
-- comment already named `document.fieldinvite.decline` as a real SignNow
-- webhook event type, but no branch ever handled it — a declined signature
-- silently fell through to "Ignoring non-completion event", leaving the
-- CRM's signnow_documents row stuck at whatever status it already had, with
-- no record anywhere that the customer actually declined to sign.
--
-- 2026-16-signnow-and-submissions.sql's original signnow_documents_status_check
-- only allowed ('pending','sent','viewed','signed','completed','voided',
-- 'error') — 'declined' was never a reachable value. This is the same class
-- of fix as 2026-65-sms-messages-status-check-widen.sql: forward-only,
-- additive, no data rewrite. Existing rows keep their current status values
-- (all already within the old allow-list); this only widens what a FUTURE
-- write may store.
ALTER TABLE signnow_documents DROP CONSTRAINT IF EXISTS signnow_documents_status_check;
ALTER TABLE signnow_documents ADD CONSTRAINT signnow_documents_status_check
  CHECK (status IN ('pending', 'sent', 'viewed', 'signed', 'completed', 'voided', 'error', 'declined'));
