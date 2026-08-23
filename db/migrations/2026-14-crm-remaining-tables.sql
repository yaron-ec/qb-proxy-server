-- =====================================================================
-- 2026-14-crm-remaining-tables.sql — Missing CRM tables for Base44 exit
--
-- Creates tables for: tasks, invoices, deal_expenses, deal_expense_payments,
-- deal_commissions, deal_loan_payments, properties, lead_attachments,
-- company_settings, handoff_estimates.
--
-- Each table uses:
--   * UUID primary key (Railway-native)
--   * external_ref TEXT UNIQUE — Base44 entity ID for migration mapping
--   * created_at, updated_at TIMESTAMPTZ
--
-- PREREQUISITE: leads(id UUID), deals(id UUID) from prior migrations.
-- Idempotent (IF NOT EXISTS). Apply via: node db/migrate.js
-- =====================================================================

-- ── Tasks ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_ref TEXT UNIQUE,
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  deal_id UUID REFERENCES deals(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  priority TEXT NOT NULL DEFAULT 'medium',
  assigned_to TEXT,
  due_date DATE,
  completed_at TIMESTAMPTZ,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tasks_lead_id ON tasks(lead_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);

-- ── Invoices ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_ref TEXT UNIQUE,
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
  invoice_number TEXT,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  description TEXT,
  payment_stage TEXT DEFAULT 'custom',
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'draft',
  qb_invoice_id TEXT,
  qb_invoice_number TEXT,
  qb_status TEXT,
  qb_invoice_url TEXT,
  qb_pdf_url TEXT,
  qb_pdf_status TEXT DEFAULT 'pending',
  qb_pdf_generated_at TIMESTAMPTZ,
  qb_pdf_retry_count INTEGER DEFAULT 0,
  payment_received NUMERIC(12,2) DEFAULT 0,
  payment_status TEXT DEFAULT 'unpaid',
  payment_method TEXT,
  payment_date DATE,
  notes TEXT,
  synced_to_qb BOOLEAN DEFAULT false,
  qb_sync_error TEXT,
  qb_last_sync_at TIMESTAMPTZ,
  email_sent_date TIMESTAMPTZ,
  email_recipients JSONB DEFAULT '[]'::jsonb,
  email_delivery_status TEXT DEFAULT 'pending',
  email_error TEXT,
  email_resend_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_invoices_lead_id ON invoices(lead_id);
CREATE INDEX IF NOT EXISTS idx_invoices_deal_id ON invoices(deal_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);

-- ── Deal Expenses ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deal_expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_ref TEXT UNIQUE,
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  expense_date DATE,
  vendor_name TEXT NOT NULL,
  vendor_id TEXT,
  category TEXT DEFAULT 'Other',
  subcategory TEXT,
  description TEXT,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  payment_status TEXT DEFAULT 'Unpaid',
  payment_method TEXT,
  check_or_reference_number TEXT,
  quickbooks_transaction_id TEXT,
  quickbooks_sync_status TEXT DEFAULT 'not_synced',
  receipt_url TEXT,
  receipt_key TEXT,
  receipt_filename TEXT,
  receipt_mime_type TEXT,
  notes TEXT,
  include_in_profit_calculation BOOLEAN DEFAULT true,
  amount_paid NUMERIC(12,2) DEFAULT 0,
  amount_remaining NUMERIC(12,2) DEFAULT 0,
  created_by TEXT,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_deal_expenses_deal_id ON deal_expenses(deal_id);
CREATE INDEX IF NOT EXISTS idx_deal_expenses_category ON deal_expenses(category);

-- ── Deal Expense Payments ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deal_expense_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_ref TEXT UNIQUE,
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  expense_id UUID NOT NULL REFERENCES deal_expenses(id) ON DELETE CASCADE,
  payment_date DATE,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  payment_method TEXT,
  reference_number TEXT,
  receipt_url TEXT,
  receipt_key TEXT,
  receipt_filename TEXT,
  notes TEXT,
  created_by TEXT,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_deal_expense_payments_expense_id ON deal_expense_payments(expense_id);

-- ── Deal Commissions ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deal_commissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_ref TEXT UNIQUE,
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  recipient_user_id TEXT,
  recipient_name TEXT NOT NULL,
  commission_type TEXT DEFAULT 'percentage',
  commission_percentage NUMERIC(5,2) DEFAULT 0,
  commission_fixed_amount NUMERIC(12,2) DEFAULT 0,
  calculation_base TEXT DEFAULT 'total_contract',
  custom_base_amount NUMERIC(12,2) DEFAULT 0,
  calculated_amount NUMERIC(12,2) DEFAULT 0,
  paid_amount NUMERIC(12,2) DEFAULT 0,
  status TEXT DEFAULT 'Estimated',
  paid_date DATE,
  notes TEXT,
  receipt_url TEXT,
  created_by TEXT,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_deal_commissions_deal_id ON deal_commissions(deal_id);

-- ── Deal Loan Payments ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deal_loan_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_ref TEXT UNIQUE,
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  payment_date DATE NOT NULL,
  lender_name TEXT,
  loan_account_name TEXT,
  total_payment_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  principal_amount NUMERIC(12,2) DEFAULT 0,
  interest_amount NUMERIC(12,2) DEFAULT 0,
  fee_amount NUMERIC(12,2) DEFAULT 0,
  other_cost_amount NUMERIC(12,2) DEFAULT 0,
  reference_number TEXT,
  receipt_url TEXT,
  receipt_key TEXT,
  receipt_filename TEXT,
  notes TEXT,
  created_by TEXT,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_deal_loan_payments_deal_id ON deal_loan_payments(deal_id);

-- ── Properties ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_ref TEXT UNIQUE,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  property_type TEXT,
  square_footage INTEGER,
  lot_size TEXT,
  year_built INTEGER,
  bedrooms INTEGER,
  bathrooms NUMERIC(3,1),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_properties_lead_id ON properties(lead_id);

-- ── Lead Attachments ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lead_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_ref TEXT UNIQUE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  file_name TEXT,
  file_url TEXT NOT NULL,
  file_type TEXT,
  file_size BIGINT,
  storage_key TEXT,
  uploaded_by TEXT,
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  qb_invoice_id TEXT,
  qb_invoice_number TEXT,
  invoice_amount NUMERIC(12,2),
  invoice_date DATE,
  due_date DATE,
  balance_due NUMERIC(12,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lead_attachments_lead_id ON lead_attachments(lead_id);

-- ── Company Settings (singleton) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS company_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name TEXT NOT NULL,
  company_logo_url TEXT,
  company_email TEXT,
  company_phone TEXT,
  company_address TEXT,
  company_city TEXT,
  company_state TEXT,
  company_zip TEXT,
  admin_name TEXT,
  admin_email TEXT,
  company_website TEXT,
  crm_activity_notifications_enabled BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Handoff Estimates ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS handoff_estimates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_ref TEXT UNIQUE,
  handoff_estimate_id TEXT,
  handoff_estimate_number TEXT,
  qb_estimate_id TEXT,
  qb_estimate_number TEXT,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT,
  customer_email TEXT,
  estimate_amount NUMERIC(12,2),
  estimate_status TEXT,
  estimate_date DATE,
  document_url TEXT,
  document_title TEXT,
  pdf_url TEXT,
  pdf_status TEXT DEFAULT 'pending',
  pdf_retry_count INTEGER DEFAULT 0,
  pdf_fetched_at TIMESTAMPTZ,
  qb_app_url TEXT,
  last_synced_at TIMESTAMPTZ,
  source TEXT DEFAULT 'Handoff',
  sync_source TEXT DEFAULT 'Handoff',
  match_status TEXT NOT NULL DEFAULT 'unmatched',
  match_method TEXT,
  raw_payload TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_handoff_estimates_lead_id ON handoff_estimates(lead_id);
CREATE INDEX IF NOT EXISTS idx_handoff_estimates_match_status ON handoff_estimates(match_status);
CREATE INDEX IF NOT EXISTS idx_handoff_estimates_qb_id ON handoff_estimates(qb_estimate_id);

-- ── Lead Submissions ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lead_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_ref TEXT UNIQUE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  submitted_at TIMESTAMPTZ NOT NULL,
  source TEXT,
  form_type TEXT,
  project_type TEXT,
  message TEXT,
  assigned_rep_at_time TEXT,
  lead_status_at_time TEXT,
  submission_number INTEGER DEFAULT 1,
  was_reactivation BOOLEAN DEFAULT false,
  previous_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lead_submissions_lead_id ON lead_submissions(lead_id);

-- ── User Allowlist ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_allowlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  role TEXT DEFAULT 'sales_rep',
  enabled BOOLEAN DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Access Requests ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS access_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_ref TEXT UNIQUE,
  email TEXT NOT NULL,
  name TEXT,
  reason TEXT,
  status TEXT DEFAULT 'pending',
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Contacts (non-lead records) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_ref TEXT UNIQUE,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  company TEXT,
  record_type TEXT NOT NULL DEFAULT 'Contact',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Sync Cursors (for integration sync state) ────────────────────────
CREATE TABLE IF NOT EXISTS sync_cursors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration TEXT NOT NULL UNIQUE,
  last_successful_sync_at TIMESTAMPTZ,
  last_cursor TEXT,
  last_record_id TEXT,
  last_updated_timestamp TIMESTAMPTZ,
  total_synced INTEGER DEFAULT 0,
  last_sync_summary JSONB,
  is_full_sync_in_progress BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Updated_at triggers for all new tables ───────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'tasks', 'invoices', 'deal_expenses', 'deal_expense_payments',
    'deal_commissions', 'deal_loan_payments', 'properties',
    'lead_attachments', 'company_settings', 'handoff_estimates',
    'lead_submissions', 'user_allowlist', 'access_requests',
    'contacts', 'sync_cursors'
  ])
  LOOP
    EXECUTE format($f$
      DROP TRIGGER IF EXISTS update_%I_updated_at ON %I;
      CREATE TRIGGER update_%I_updated_at
        BEFORE UPDATE ON %I
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    $f$, tbl, tbl, tbl, tbl);
  END LOOP;
END $$;