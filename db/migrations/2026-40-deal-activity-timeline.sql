-- =====================================================================
-- 2026-40: Deal Activity Timeline — additive schema support
--
-- The Deal Activity tab becomes a real chronological project-history
-- timeline (Sale -> Contract -> Execution -> Financial/Document events ->
-- Completion -> Closeout). Per the architecture audit, almost every event
-- is DERIVED at read time from data that already exists (deals.sold_date,
-- deals.work_start_date, deals.deposit_paid_date/progress_payment_paid_date/
-- final_payment_paid_date, signnow_documents, and the activities rows
-- FinancialsTab already logs via logActivity with metadata.deal_id). This
-- migration adds only the two genuinely missing, provably-safe pieces:
--
--   1. deals.completed_at / deals.completed_by — there was no reliable
--      timestamp for "when did this project reach Job Completed." Using
--      deals.updated_at would be wrong (it reflects the MOST RECENT edit,
--      not the completion moment). Set exactly once, automatically, the
--      first time stage transitions to 'Job Completed' (see routes/deals.js)
--      — never overwritten afterward, so it stays a true historical fact
--      even if the deal is edited again later or briefly reopened.
--
--   2. lead_attachments.deal_id / lead_attachments.attachment_kind — the
--      Completion Form must be associated with a SPECIFIC deal/project
--      (a lead can have multiple deals/projects), but lead_attachments is
--      lead-scoped only today with no way to distinguish a Completion Form
--      from any other upload. Both columns are nullable/additive: existing
--      rows keep deal_id=NULL, attachment_kind=NULL (still lead-level
--      uploads exactly as they behave today via the Documents tab). New
--      Completion Form uploads from Deal Detail set both explicitly.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS). Never
-- rewrites or drops existing data. Applies automatically via the normal
-- db/migrate.js startup path (Dockerfile: node db/migrate.js && node server.js).
-- =====================================================================

ALTER TABLE deals ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS completed_by TEXT;

ALTER TABLE lead_attachments ADD COLUMN IF NOT EXISTS deal_id UUID REFERENCES deals(id) ON DELETE SET NULL;
ALTER TABLE lead_attachments ADD COLUMN IF NOT EXISTS attachment_kind TEXT;

CREATE INDEX IF NOT EXISTS lead_attachments_deal_idx ON lead_attachments (deal_id) WHERE deal_id IS NOT NULL;
