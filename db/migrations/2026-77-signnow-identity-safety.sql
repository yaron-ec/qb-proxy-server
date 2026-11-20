-- November 2026 production incident fix: preparing a Notice of Completion
-- for Ali & Mohemmed Lalani displayed a PRIOR customer's (Joann D Gregg)
-- name, address, completion date and job description instead. Root cause
-- (lib/signnowFieldMapping.js#findIdentityRisks's own header has the full
-- analysis): the SignNow TEMPLATE was most likely created via SignNow's own
-- "Make Template from Document" feature from an already-filled document, so
-- every copy inherits that prior customer's text as a field's starting
-- value — invisible to this codebase because nothing here ever read a
-- field's current VALUE before this fix, only its name.
--
-- This migration is purely additive (forward-only, no data rewrite,
-- existing rows get NULL/unaffected defaults) — same convention as
-- 2026-65-sms-messages-status-check-widen.sql / 2026-73-signnow-declined-status.sql.
--
-- `unverified_fields` (JSONB, NULL = clean) stores the exact field-level
-- risks lib/signnowFieldMapping.js#findIdentityRisks found the last time
-- this document's live fields were checked (at /prepare time, and again on
-- /documents/:docId/reverify). routes/signnow.js's POST /documents/:docId/send
-- refuses to send (422) while this is non-empty — a document whose fields
-- might still carry another customer's data can never be emailed to a
-- signer until an admin has fixed the fields in SignNow and re-verified, or
-- the mapping config has been corrected and the document re-prepared.
ALTER TABLE signnow_documents ADD COLUMN IF NOT EXISTS unverified_fields JSONB;
ALTER TABLE signnow_documents ADD COLUMN IF NOT EXISTS identity_verified_at TIMESTAMPTZ;
ALTER TABLE signnow_documents ADD COLUMN IF NOT EXISTS identity_verified_by TEXT;

-- 'needs_review' is a new, non-terminal status value this fix can set at
-- /prepare time when a brand-new document already has identity risks —
-- still counts as "non-terminal" for the existing idempotency check in
-- /prepare (`status NOT IN ('completed','voided','error')`), so it still
-- correctly blocks a duplicate /prepare for the same lead+template.
ALTER TABLE signnow_documents DROP CONSTRAINT IF EXISTS signnow_documents_status_check;
ALTER TABLE signnow_documents ADD CONSTRAINT signnow_documents_status_check
  CHECK (status IN ('pending', 'sent', 'viewed', 'signed', 'completed', 'voided', 'error', 'declined', 'needs_review'));
