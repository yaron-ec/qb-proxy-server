-- =====================================================================
-- 2026-10-qb-invoice-sale-map.sql
-- Sale-level QuickBooks invoice ownership (Railway-owned, canonical).
--
-- Establishes the durable relationship:
--   Sale (crm_sale_id)  →  QB Invoice (qb_invoice_id)
--
-- This is the canonical source of truth for WHICH JOB a QB invoice belongs to.
--   qb_customer_id  = WHO the customer is
--   crm_sale_id    = WHICH JOB the invoice belongs to
-- These are NOT interchangeable. A single customer may have many jobs; a job
-- may have many invoices; an invoice belongs to exactly ONE job.
--
-- Also introduces qb_invoices_cache: a read-only mirror of QB invoice
-- financials (total/balance/paid/voided) so sale-scoped financials can be
-- computed from durable local data without live QB calls. Populated by the
-- QB sync worker. QuickBooks remains the source of truth for amounts; the
-- cache is refreshed on every sync.
--
-- FINANCIAL RULE (enforced by application layer, not SQL):
--   sale.total     = Deal.amount (passed in; never derived from customer)
--   sale.invoiced   = SUM(active invoices mapped to crm_sale_id).total_amt
--   sale.paid       = SUM(active invoices mapped to crm_sale_id).paid
--   sale.balance    = sale.total - sale.paid
--   sale.payment_status = unpaid | partial | paid  (per sale, independently)
--
-- No customer-level aggregation is ever used for an individual Sale.
-- No amount/date/project-name disambiguation is ever used for ownership.
--
-- IDEMPOTENT: uses IF NOT EXISTS / CREATE OR REPLACE. Safe to re-run.
-- STANDALONE: no FK dependencies on leads/deals tables (crm_*_id are TEXT,
--            accepting Base44 MongoDB ObjectId 24-char hex strings).
-- =====================================================================

-- 1. qb_invoice_sale_map — canonical sale→invoice ownership
CREATE TABLE IF NOT EXISTS qb_invoice_sale_map (
  qb_invoice_id     TEXT NOT NULL,
  qb_doc_number     TEXT,
  crm_sale_id       TEXT NOT NULL,
  crm_lead_id       TEXT NOT NULL,
  qb_customer_id    TEXT NOT NULL,
  mapping_method    TEXT NOT NULL DEFAULT 'crm_created'
                    CHECK (mapping_method IN ('crm_created','manual','backfill','legacy_adopted')),
  voided            BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (qb_invoice_id)
);

CREATE INDEX IF NOT EXISTS qb_invoice_sale_map_sale_idx  ON qb_invoice_sale_map (crm_sale_id);
CREATE INDEX IF NOT EXISTS qb_invoice_sale_map_lead_idx  ON qb_invoice_sale_map (crm_lead_id);
CREATE INDEX IF NOT EXISTS qb_invoice_sale_map_cust_idx ON qb_invoice_sale_map (qb_customer_id);

CREATE OR REPLACE FUNCTION qb_invoice_sale_map_touch_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS qb_invoice_sale_map_set_updated_at ON qb_invoice_sale_map;
CREATE TRIGGER qb_invoice_sale_map_set_updated_at
  BEFORE UPDATE ON qb_invoice_sale_map
  FOR EACH ROW EXECUTE FUNCTION qb_invoice_sale_map_touch_updated_at();

-- 2. qb_invoices_cache — read-only mirror of QB invoice financials
CREATE TABLE IF NOT EXISTS qb_invoices_cache (
  qb_invoice_id     TEXT NOT NULL,
  qb_doc_number     TEXT,
  qb_customer_id    TEXT NOT NULL,
  total_amt         NUMERIC(14,2) NOT NULL DEFAULT 0,
  balance           NUMERIC(14,2) NOT NULL DEFAULT 0,
  paid              NUMERIC(14,2) NOT NULL DEFAULT 0,
  txn_status        TEXT,
  voided            BOOLEAN NOT NULL DEFAULT FALSE,
  txn_date          DATE,
  last_synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (qb_invoice_id)
);

CREATE INDEX IF NOT EXISTS qb_invoices_cache_cust_idx ON qb_invoices_cache (qb_customer_id);

CREATE OR REPLACE FUNCTION qb_invoices_cache_touch_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS qb_invoices_cache_set_updated_at ON qb_invoices_cache;
CREATE TRIGGER qb_invoices_cache_set_updated_at
  BEFORE UPDATE ON qb_invoices_cache
  FOR EACH ROW EXECUTE FUNCTION qb_invoices_cache_touch_updated_at();