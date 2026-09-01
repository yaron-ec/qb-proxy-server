-- =====================================================================
-- 2026-18-crm-estimates.sql — CRM-native estimates table for Base44 exit
--
-- Creates the `estimates` table for CRM-native estimates with line items,
-- QuickBooks estimate linkage, and lead/deal relationships.
--
-- This was previously a GAP (Railway had no estimates table). The Base44
-- Estimate entity has 191 production records that must be migrated.
--
-- Each table uses:
--   * UUID primary key (Railway-native)
--   * external_ref TEXT UNIQUE — Base44 entity ID for migration mapping
--   * created_at, updated_at TIMESTAMPTZ
--
-- PREREQUISITE: leads(id UUID) from prior migrations.
-- Idempotent (IF NOT EXISTS). Apply via: node db/migrate.js
-- =====================================================================

-- ── Estimates (CRM-native) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS estimates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_ref TEXT UNIQUE,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  project_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Draft',
  line_items JSONB DEFAULT '[]'::jsonb,
  subtotal NUMERIC(12,2) DEFAULT 0,
  markup_pct NUMERIC(5,2) DEFAULT 0,
  total NUMERIC(12,2) DEFAULT 0,
  deposit_amount NUMERIC(12,2) DEFAULT 0,
  notes TEXT,
  valid_until DATE,
  qb_estimate_id TEXT,
  qb_estimate_number TEXT,
  qb_status TEXT,
  qb_estimate_date DATE,
  qb_last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_estimates_lead_id ON estimates(lead_id);
CREATE INDEX IF NOT EXISTS idx_estimates_status ON estimates(status);
CREATE INDEX IF NOT EXISTS idx_estimates_qb_estimate_id ON estimates(qb_estimate_id);

-- ── Updated_at trigger for estimates ─────────────────────────────────
DO $$
BEGIN
  EXECUTE format($f$
    DROP TRIGGER IF EXISTS update_%I_updated_at ON %I;
    CREATE TRIGGER update_%I_updated_at
      BEFORE UPDATE ON %I
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  $f$, 'estimates', 'estimates', 'estimates', 'estimates');
END $$;