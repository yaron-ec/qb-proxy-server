-- =====================================================================
-- 2026-23-leads-qb-customer-id.sql — Add canonical QB identity columns to leads
--
-- This migration adds the canonical QuickBooks customer identity column
-- to the leads table. leads.qb_customer_id is the SINGLE source of truth
-- for the Lead <-> QuickBooks Customer mapping (1:1 cardinality).
--
-- COLUMNS ADDED (3 — all read AND written by runtime routes/leadQB.js):
--   1. qb_customer_id      TEXT           — canonical QB customer identity
--   2. qb_last_sync_at     TIMESTAMPTZ    — written by sync endpoint (line 225)
--   3. qb_last_sync_result TEXT           — written by sync endpoint (line 225)
--
-- COLUMNS NOT ADDED (10 — read-only legacy fields, NOT written by runtime):
--   qb_invoice_id, qb_invoice_number, qb_invoice_amount, qb_invoice_status,
--   qb_invoice_url, qb_deposit_amount, qb_payment_received, qb_balance_due,
--   qb_payment_status, qb_last_error
--
--   These fields are read by leadQB.js (lines 95-106) for UI display but are
--   NOT written by any Railway runtime code. The Railway QB sync writes to
--   qb_invoices_cache + qb_invoice_sale_map instead. They have near-zero
--   non-null data in Base44 (0-9 records). If the UI needs them, a separate
--   migration can add them later. They are NOT required for the canonical
--   QB identity mapping that is the sole purpose of this migration.
--
-- Idempotent (IF NOT EXISTS). Apply via: node db/migrate.js
-- =====================================================================

-- 1. qb_customer_id — canonical QB customer identity (read + written by runtime)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS qb_customer_id TEXT;

-- 2. qb_last_sync_at — written by sync endpoint (leadQB.js line 225)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS qb_last_sync_at TIMESTAMPTZ;

-- 3. qb_last_sync_result — written by sync endpoint (leadQB.js line 225)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS qb_last_sync_result TEXT;

-- Index for fast QB customer ID lookups (used by Priority 0 matching)
CREATE INDEX IF NOT EXISTS idx_leads_qb_customer_id ON leads(qb_customer_id)
  WHERE qb_customer_id IS NOT NULL AND qb_customer_id != '';

-- Verify the column was added
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'qb_customer_id'
  ) THEN
    RAISE EXCEPTION 'qb_customer_id column was not added to leads table';
  END IF;
  RAISE NOTICE 'leads.qb_customer_id column verified ✅';
END $$;