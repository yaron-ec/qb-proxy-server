-- =====================================================================
-- Stage 2: Railway-native Sales (Deal) model — 2026-11  (CORRECTED)
--
-- Creates the canonical `deals` table. This is the durable, Railway-native
-- home for Sale/Job records once the CRM exits Base44.
--
-- KEY DESIGN RULES (Railway-native — Base44 IDs are migration metadata ONLY):
--   * deals.id                   UUID PRIMARY KEY (Railway-native)
--   * deals.lead_id              UUID NOT NULL REFERENCES leads(id)
--                                — the CANONICAL Deal→Lead relationship. A
--                                  Deal ALWAYS points to a real Railway Lead.
--                                  This is NEVER a Base44 ObjectId.
--   * deals.legacy_base44_id     TEXT — the Base44 Deal ObjectId, stored as
--                                  MIGRATION METADATA ONLY (unique where
--                                  present). NOT the ownership key; NOT
--                                  required for normal CRUD.
--   * deals.legacy_base44_lead_id TEXT — the Base44 Lead ObjectId captured at
--                                  migration time, METADATA ONLY. Never used as
--                                  a FK. Useful for audit/reconciliation.
--
-- MIGRATION RESOLUTION (Base44 → Railway):
--   Base44 Deal.lead_id  (Base44 Lead ObjectId)
--     → resolve Railway Lead via leads.external_ref = <Base44 Lead ObjectId>
--     → insert deals.lead_id = resolved Railway leads.id (UUID)
--   If the Railway Lead cannot be resolved, the Deal is REPORTED UNRESOLVED.
--   No Deal row is inserted. No Lead is invented. The legacy ObjectId is NEVER
--   stored as deals.lead_id. (See lib/dealModel.js migrateDealFromBase44.)
--
-- SALE FINANCIALS TRANSITION (qb_invoice_sale_map, 2026-10 — NOT broken here):
--   The validated qb_invoice_sale_map.crm_sale_id is TEXT and currently holds
--   Base44 Deal IDs for legacy invoices. That contract is UNCHANGED by this
--   migration. The transition is explicitly:
--     1. NOW (legacy):   crm_sale_id = Base44 Deal ObjectId (TEXT)
--     2. AFTER Railway Deals go live: NEW invoices use crm_sale_id = deals.id
--        (Railway UUID). Legacy invoices keep their Base44 Deal ID.
--     3. SEPARATE validated step (future): rewrite qb_invoice_sale_map.crm_sale_id
--        from Base44 Deal ID → deals.legacy_base44_id → deals.id (UUID).
--   During the transition window, sale-scoped financial resolution must handle
--   BOTH formats safely: a legacy crm_sale_id joins deals.legacy_base44_id; a
--   UUID crm_sale_id joins deals.id. (qb_invoice_sale_map itself is NOT altered
--   in this stage — that is a separately validated step.)
--
-- PREREQUISITE: leads(id UUID, external_ref TEXT UNIQUE) from
--   2026-08-crm-booking-core.sql. The FK below requires the leads table.
--
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE). DO NOT RUN IN PRODUCTION
-- until explicitly approved. Apply via: node db/migrate.js
-- =====================================================================

CREATE TABLE IF NOT EXISTS deals (
  id                                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id                           UUID NOT NULL REFERENCES leads(id),
  legacy_base44_id                  TEXT,
  legacy_base44_lead_id             TEXT,
  name                              TEXT NOT NULL,
  amount                            NUMERIC(14,2),
  stage                             TEXT NOT NULL DEFAULT 'Sold / Estimate Approved'
      CHECK (stage IN (
        'Sold / Estimate Approved','Deposit Due','Deposit Paid','Work Scheduled',
        'Work Started','Progress Payment Due','Progress Payment Paid',
        'Final Payment Due','Final Payment Paid','Job Completed'
      )),
  pipeline                          TEXT NOT NULL DEFAULT 'Default Pipeline',
  close_date                        DATE,
  sold_date                         TIMESTAMPTZ,
  work_start_date                   DATE,
  work_end_date                     DATE,
  description                       TEXT,
  notes                             TEXT,
  project_type                      TEXT,
  property_address                  TEXT,
  assigned_rep                      TEXT,
  deposit_amount                    NUMERIC(14,2) NOT NULL DEFAULT 0,
  deposit_paid                      NUMERIC(14,2) NOT NULL DEFAULT 0,
  deposit_paid_date                 DATE,
  progress_payment_amount           NUMERIC(14,2) NOT NULL DEFAULT 0,
  progress_payment_paid             NUMERIC(14,2) NOT NULL DEFAULT 0,
  progress_payment_paid_date        DATE,
  final_payment_amount              NUMERIC(14,2) NOT NULL DEFAULT 0,
  final_payment_paid                NUMERIC(14,2) NOT NULL DEFAULT 0,
  final_payment_paid_date           DATE,
  contract_amount                   NUMERIC(14,2),
  total_paid                        NUMERIC(14,2) NOT NULL DEFAULT 0,
  balance_due                       NUMERIC(14,2) NOT NULL DEFAULT 0,
  paid_percentage                   NUMERIC(5,2)  NOT NULL DEFAULT 0,
  payment_status                    TEXT NOT NULL DEFAULT 'unpaid'
      CHECK (payment_status IN ('unpaid','partial','paid')),
  stage_override                    BOOLEAN NOT NULL DEFAULT FALSE,
  financial_change_orders_amount   NUMERIC(14,2) NOT NULL DEFAULT 0,
  financial_manual_revenue_adjustment NUMERIC(14,2) NOT NULL DEFAULT 0,
  financial_revenue_source          TEXT NOT NULL DEFAULT 'quickbooks'
      CHECK (financial_revenue_source IN ('quickbooks','manual')),
  financial_other_costs_amount      NUMERIC(14,2) NOT NULL DEFAULT 0,
  lead_cost_type                    TEXT NOT NULL DEFAULT 'percentage'
      CHECK (lead_cost_type IN ('percentage','fixed')),
  lead_cost_percentage              NUMERIC(5,2)  NOT NULL DEFAULT 0,
  lead_cost_fixed_amount            NUMERIC(14,2) NOT NULL DEFAULT 0,
  lead_cost_calculation_base        TEXT NOT NULL DEFAULT 'total_contract'
      CHECK (lead_cost_calculation_base IN (
        'total_contract','payments_received','gross_profit_before_lead_cost','custom'
      )),
  lead_cost_custom_base_amount      NUMERIC(14,2) NOT NULL DEFAULT 0,
  lead_cost_amount                  NUMERIC(14,2) NOT NULL DEFAULT 0,
  lead_cost_notes                   TEXT,
  company_share_amount              NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_by                        TEXT,
  updated_by                        TEXT,
  created_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- legacy_base44_id = Base44 Deal ObjectId. Unique where present: one Base44
-- Deal maps to at most one Railway Deal. NULL for deals created natively.
CREATE UNIQUE INDEX IF NOT EXISTS deals_legacy_base44_id_idx
  ON deals (legacy_base44_id) WHERE legacy_base44_id IS NOT NULL;

-- Canonical relationship index (UUID FK).
CREATE INDEX IF NOT EXISTS deals_lead_id_idx      ON deals (lead_id);
-- Legacy lead-id metadata index (reconciliation queries only; NOT ownership).
CREATE INDEX IF NOT EXISTS deals_legacy_base44_lead_id_idx
  ON deals (legacy_base44_lead_id) WHERE legacy_base44_lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS deals_stage_idx        ON deals (stage);
CREATE INDEX IF NOT EXISTS deals_assigned_rep_idx ON deals (lower(assigned_rep)) WHERE assigned_rep IS NOT NULL;
CREATE INDEX IF NOT EXISTS deals_sold_date_idx    ON deals (sold_date DESC);
CREATE INDEX IF NOT EXISTS deals_created_by_idx   ON deals (created_by);
CREATE INDEX IF NOT EXISTS deals_created_at_idx   ON deals (created_at DESC);

CREATE OR REPLACE FUNCTION deals_touch_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS deals_set_updated_at ON deals;
CREATE TRIGGER deals_set_updated_at BEFORE UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION deals_touch_updated_at();