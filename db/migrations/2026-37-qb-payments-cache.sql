-- 2026-37-qb-payments-cache.sql
-- QB payments cache + payment allocations: read-only mirror of QuickBooks.
-- Populated by the QB inbound sync engine (lib/qbInboundSync.js).
-- QuickBooks is authoritative for amounts; the cache is refreshed on every sync.
-- Idempotent: ON CONFLICT DO UPDATE — safe to re-run.

CREATE TABLE IF NOT EXISTS qb_payments_cache (
  qb_payment_id    TEXT NOT NULL,
  qb_doc_number    TEXT,
  qb_customer_id   TEXT NOT NULL,
  total_amt        NUMERIC(12,2) DEFAULT 0,
  unapplied_amt    NUMERIC(12,2) DEFAULT 0,
  txn_date         DATE,
  method           TEXT,
  voided           BOOLEAN NOT NULL DEFAULT FALSE,
  last_synced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (qb_payment_id)
);

CREATE INDEX IF NOT EXISTS qb_payments_cache_cust_idx ON qb_payments_cache (qb_customer_id);

-- Payment → Invoice allocation (one row per Payment.LinkedTxn entry)
CREATE TABLE IF NOT EXISTS qb_payment_allocations (
  qb_payment_id    TEXT NOT NULL,
  qb_invoice_id    TEXT NOT NULL,
  allocation_amt   NUMERIC(12,2) DEFAULT 0,
  last_synced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (qb_payment_id, qb_invoice_id)
);

CREATE INDEX IF NOT EXISTS qb_payment_allocations_inv_idx ON qb_payment_allocations (qb_invoice_id);
