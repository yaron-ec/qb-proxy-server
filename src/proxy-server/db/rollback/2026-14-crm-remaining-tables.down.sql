-- Rollback for 2026-14-crm-remaining-tables.sql
-- Drops all tables created by the forward migration.
-- CAUTION: This will lose all data in these tables. Run only if needed.

DROP TABLE IF EXISTS sync_cursors CASCADE;
DROP TABLE IF EXISTS contacts CASCADE;
DROP TABLE IF EXISTS access_requests CASCADE;
DROP TABLE IF EXISTS user_allowlist CASCADE;
DROP TABLE IF EXISTS lead_submissions CASCADE;
DROP TABLE IF EXISTS handoff_estimates CASCADE;
DROP TABLE IF EXISTS company_settings CASCADE;
DROP TABLE IF EXISTS lead_attachments CASCADE;
DROP TABLE IF EXISTS properties CASCADE;
DROP TABLE IF EXISTS deal_loan_payments CASCADE;
DROP TABLE IF EXISTS deal_commissions CASCADE;
DROP TABLE IF EXISTS deal_expense_payments CASCADE;
DROP TABLE IF EXISTS deal_expenses CASCADE;
DROP TABLE IF EXISTS invoices CASCADE;
DROP TABLE IF EXISTS tasks CASCADE;

DROP FUNCTION IF EXISTS update_updated_at_column() CASCADE;