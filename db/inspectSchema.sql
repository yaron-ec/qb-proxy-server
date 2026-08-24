-- READ-ONLY SCHEMA INSPECTION SCRIPT
-- Run against production Railway Postgres. No writes, no migrations.
-- Determines whether every required table, column, index, and constraint exists.

-- ── TABLES ──────────────────────────────────────────────────────────────────
SELECT table_name, 
       (SELECT count(*) FROM information_schema.columns WHERE table_name = t.table_name) as column_count
FROM information_schema.tables t
WHERE table_schema = 'public' 
  AND table_type = 'BASE TABLE'
  AND table_name IN (
    'leads', 'activities', 'deals', 'appointments', 'appointment_types', 'owners',
    'signnow_documents', 'lead_submissions', 'invoices', 'lead_attachments',
    'handoff_estimates', 'tasks', 'properties', 'company_settings', 'sync_cursors',
    'deal_expenses', 'deal_expense_payments', 'deal_commissions', 'deal_loan_payments',
    'user_allowlist', 'access_requests', 'contacts', 'users', 'refresh_tokens',
    'integration_credentials', 'gmail_oauth_states', 'reminder_leads', 'reminder_claims',
    'reminder_runs', 'calendar_outbox', 'qb_invoice_sale_map', 'qb_invoices_cache',
    'email_send_logs', 'settings'
  )
ORDER BY table_name;

-- ── COLUMNS for leads table ─────────────────────────────────────────────────
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'leads'
ORDER BY ordinal_position;

-- ── COLUMNS for users table ──────────────────────────────────────────────────
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'users'
ORDER BY ordinal_position;

-- ── COLUMNS for signnow_documents ───────────────────────────────────────────
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'signnow_documents'
ORDER BY ordinal_position;

-- ── COLUMNS for lead_submissions ────────────────────────────────────────────
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'lead_submissions'
ORDER BY ordinal_position;

-- ── INDEXES ─────────────────────────────────────────────────────────────────
SELECT indexname, tablename 
FROM pg_indexes 
WHERE schemaname = 'public' 
  AND tablename IN ('leads', 'signnow_documents', 'lead_submissions', 'invoices', 'deal_expenses')
ORDER BY tablename, indexname;

-- ── CONSTRAINTS ─────────────────────────────────────────────────────────────
SELECT conname, contype, conrelid::regclass as table_name
FROM pg_constraint 
WHERE connamespace = 'public'::regnamespace
  AND conrelid::regclass::text IN ('leads', 'users', 'signnow_documents', 'lead_submissions')
ORDER BY conname;

-- ── ROW COUNTS (lightweight) ────────────────────────────────────────────────
SELECT 'leads' as tbl, count(*) as cnt FROM leads
UNION ALL SELECT 'activities', count(*) FROM activities
UNION ALL SELECT 'deals', count(*) FROM deals
UNION ALL SELECT 'appointments', count(*) FROM appointments
UNION ALL SELECT 'owners', count(*) FROM owners
UNION ALL SELECT 'signnow_documents', count(*) FROM signnow_documents
UNION ALL SELECT 'lead_submissions', count(*) FROM lead_submissions
UNION ALL SELECT 'invoices', count(*) FROM invoices
UNION ALL SELECT 'tasks', count(*) FROM tasks
UNION ALL SELECT 'users', count(*) FROM users;
