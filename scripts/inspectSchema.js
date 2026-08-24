/* eslint-disable no-undef */
/**
 * inspectSchema.js — READ-ONLY production schema inspection.
 *
 * Compares actual production PostgreSQL schema against the expected migrations:
 *   - 2026-13-lead-contact-fields.sql
 *   - 2026-14-crm-remaining-tables.sql
 *
 * Reports every required object as:
 *   EXISTS + MATCHES | EXISTS + DIFFERENT | MISSING
 *
 * Checks: tables, columns, indexes, constraints, unique keys.
 *
 * NO WRITES. NO DDL. NO ALTERS. READ-ONLY.
 *
 * Usage: node scripts/inspectSchema.js
 * Requires: DATABASE_URL (Railway Postgres)
 */
'use strict';

const db = require('../db/client');

// Expected tables from migration 2026-14
const EXPECTED_TABLES = [
  'tasks', 'invoices', 'deal_expenses', 'deal_expense_payments',
  'deal_commissions', 'deal_loan_payments', 'properties',
  'lead_attachments', 'company_settings', 'handoff_estimates',
  'lead_submissions', 'user_allowlist', 'access_requests',
  'contacts', 'sync_cursors',
];

// Expected columns on leads table (from 2026-13 + 2026-09)
const EXPECTED_LEADS_COLUMNS = [
  'id', 'external_ref', 'first_name', 'last_name', 'email', 'phone',
  'property_address', 'city', 'state', 'zip', 'project_type',
  'budget_range', 'start_timeframe', 'source', 'referral_name',
  'owner_id', 'status', 'notes', 'message', 'lead_score',
  'is_new_intake_lead', 'customer_reminders_disabled', 'photo_urls',
  'record_type', 'follow_up_date', 'follow_up_time', 'follow_up_type',
  'meeting_stage', 'crm_created_date', 'reviewed_at',
  'created_at', 'updated_at',
];

// Expected columns for each table from 2026-14
const EXPECTED_COLUMNS = {
  tasks: ['id', 'external_ref', 'lead_id', 'deal_id', 'title', 'description', 'status', 'priority', 'assigned_to', 'due_date', 'completed_at', 'created_by', 'created_at', 'updated_at'],
  invoices: ['id', 'external_ref', 'lead_id', 'deal_id', 'invoice_number', 'amount', 'description', 'payment_stage', 'due_date', 'status', 'qb_invoice_id', 'qb_invoice_number', 'qb_status', 'qb_invoice_url', 'qb_pdf_url', 'qb_pdf_status', 'qb_pdf_generated_at', 'qb_pdf_retry_count', 'payment_received', 'payment_status', 'payment_method', 'payment_date', 'notes', 'synced_to_qb', 'qb_sync_error', 'qb_last_sync_at', 'email_sent_date', 'email_recipients', 'email_delivery_status', 'email_error', 'email_resend_count', 'created_at', 'updated_at'],
  deal_expenses: ['id', 'external_ref', 'deal_id', 'lead_id', 'expense_date', 'vendor_name', 'vendor_id', 'category', 'subcategory', 'description', 'amount', 'payment_status', 'payment_method', 'check_or_reference_number', 'quickbooks_transaction_id', 'quickbooks_sync_status', 'receipt_url', 'receipt_key', 'receipt_filename', 'receipt_mime_type', 'notes', 'include_in_profit_calculation', 'amount_paid', 'amount_remaining', 'created_by', 'updated_by', 'created_at', 'updated_at'],
  deal_expense_payments: ['id', 'external_ref', 'deal_id', 'expense_id', 'payment_date', 'amount', 'payment_method', 'reference_number', 'receipt_url', 'receipt_key', 'receipt_filename', 'notes', 'created_by', 'updated_by', 'created_at', 'updated_at'],
  deal_commissions: ['id', 'external_ref', 'deal_id', 'lead_id', 'recipient_user_id', 'recipient_name', 'commission_type', 'commission_percentage', 'commission_fixed_amount', 'calculation_base', 'custom_base_amount', 'calculated_amount', 'paid_amount', 'status', 'paid_date', 'notes', 'receipt_url', 'created_by', 'updated_by', 'created_at', 'updated_at'],
  deal_loan_payments: ['id', 'external_ref', 'deal_id', 'lead_id', 'payment_date', 'lender_name', 'loan_account_name', 'total_payment_amount', 'principal_amount', 'interest_amount', 'fee_amount', 'other_cost_amount', 'reference_number', 'receipt_url', 'receipt_key', 'receipt_filename', 'notes', 'created_by', 'updated_by', 'created_at', 'updated_at'],
  properties: ['id', 'external_ref', 'lead_id', 'address', 'city', 'state', 'zip', 'property_type', 'square_footage', 'lot_size', 'year_built', 'bedrooms', 'bathrooms', 'notes', 'created_at', 'updated_at'],
  lead_attachments: ['id', 'external_ref', 'lead_id', 'file_name', 'file_url', 'file_type', 'file_size', 'storage_key', 'uploaded_by', 'uploaded_at', 'qb_invoice_id', 'qb_invoice_number', 'invoice_amount', 'invoice_date', 'due_date', 'balance_due', 'created_at', 'updated_at'],
  company_settings: ['id', 'company_name', 'company_logo_url', 'company_email', 'company_phone', 'company_address', 'company_city', 'company_state', 'company_zip', 'admin_name', 'admin_email', 'company_website', 'crm_activity_notifications_enabled', 'created_at', 'updated_at'],
  handoff_estimates: ['id', 'external_ref', 'handoff_estimate_id', 'handoff_estimate_number', 'qb_estimate_id', 'qb_estimate_number', 'lead_id', 'customer_name', 'customer_phone', 'customer_email', 'estimate_amount', 'estimate_status', 'estimate_date', 'document_url', 'document_title', 'pdf_url', 'pdf_status', 'pdf_retry_count', 'pdf_fetched_at', 'qb_app_url', 'last_synced_at', 'source', 'sync_source', 'match_status', 'match_method', 'raw_payload', 'created_at', 'updated_at'],
  lead_submissions: ['id', 'external_ref', 'lead_id', 'submitted_at', 'source', 'form_type', 'project_type', 'message', 'assigned_rep_at_time', 'lead_status_at_time', 'submission_number', 'was_reactivation', 'previous_status', 'created_at', 'updated_at'],
  user_allowlist: ['id', 'email', 'name', 'role', 'enabled', 'notes', 'created_at', 'updated_at'],
  access_requests: ['id', 'external_ref', 'email', 'name', 'reason', 'status', 'reviewed_by', 'reviewed_at', 'created_at', 'updated_at'],
  contacts: ['id', 'external_ref', 'first_name', 'last_name', 'email', 'phone', 'company', 'record_type', 'notes', 'created_at', 'updated_at'],
  sync_cursors: ['id', 'integration', 'last_successful_sync_at', 'last_cursor', 'last_record_id', 'last_updated_timestamp', 'total_synced', 'last_sync_summary', 'is_full_sync_in_progress', 'created_at', 'updated_at'],
};

// Expected indexes from 2026-14
const EXPECTED_INDEXES = {
  tasks: ['idx_tasks_lead_id', 'idx_tasks_status', 'idx_tasks_due_date'],
  invoices: ['idx_invoices_lead_id', 'idx_invoices_deal_id', 'idx_invoices_status'],
  deal_expenses: ['idx_deal_expenses_deal_id', 'idx_deal_expenses_category'],
  deal_expense_payments: ['idx_deal_expense_payments_expense_id'],
  deal_commissions: ['idx_deal_commissions_deal_id'],
  deal_loan_payments: ['idx_deal_loan_payments_deal_id'],
  properties: ['idx_properties_lead_id'],
  lead_attachments: ['idx_lead_attachments_lead_id'],
  handoff_estimates: ['idx_handoff_estimates_lead_id', 'idx_handoff_estimates_match_status', 'idx_handoff_estimates_qb_id'],
  lead_submissions: ['idx_lead_submissions_lead_id'],
};

// Expected unique constraints
const EXPECTED_UNIQUE = {
  sync_cursors: ['integration'],
  user_allowlist: ['email'],
};

async function getExistingTables() {
  const { rows } = await db.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  return new Set(rows.map(r => r.table_name));
}

async function getTableColumns(tableName) {
  const { rows } = await db.query(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [tableName]);
  return rows;
}

async function getTableIndexes(tableName) {
  const { rows } = await db.query(`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = $1
    ORDER BY indexname
  `, [tableName]);
  return rows.map(r => r.indexname);
}

async function getTableConstraints(tableName) {
  const { rows } = await db.query(`
    SELECT conname, contype
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE t.relname = $1 AND t.relnamespace = 'public'::regnamespace
    ORDER BY conname
  `, [tableName]);
  return rows;
}

async function inspect() {
  console.log('[schema] Inspecting production PostgreSQL schema (READ-ONLY)...\n');

  const existingTables = await getExistingTables();
  const results = {
    tables: {},
    leads_columns: {},
    summary: { exists_matches: 0, exists_different: 0, missing: 0 },
    minimal_delta: [],
  };

  // Check leads table columns (from 2026-13)
  if (existingTables.has('leads')) {
    const actualCols = await getTableColumns('leads');
    const actualColNames = new Set(actualCols.map(c => c.column_name));
    for (const expectedCol of EXPECTED_LEADS_COLUMNS) {
      if (actualColNames.has(expectedCol)) {
        results.leads_columns[expectedCol] = 'EXISTS + MATCHES';
        results.summary.exists_matches++;
      } else {
        results.leads_columns[expectedCol] = 'MISSING';
        results.summary.missing++;
        results.minimal_delta.push(`ALTER TABLE leads ADD COLUMN ${expectedCol} TEXT;`);
      }
    }
  } else {
    console.log('[schema] WARNING: leads table does not exist!');
    for (const col of EXPECTED_LEADS_COLUMNS) {
      results.leads_columns[col] = 'TABLE MISSING';
      results.summary.missing++;
    }
  }

  // Check each expected table from 2026-14
  for (const tableName of EXPECTED_TABLES) {
    const tableResult = { status: '', columns: {}, indexes: {}, constraints: {} };

    if (!existingTables.has(tableName)) {
      tableResult.status = 'MISSING';
      results.summary.missing++;
      results.minimal_delta.push(`CREATE TABLE ${tableName} (...); -- see migration 2026-14`);
      results.tables[tableName] = tableResult;
      continue;
    }

    // Check columns
    const actualCols = await getTableColumns(tableName);
    const actualColNames = new Set(actualCols.map(c => c.column_name));
    const expectedCols = EXPECTED_COLUMNS[tableName] || [];
    let allColsMatch = true;

    for (const expectedCol of expectedCols) {
      if (actualColNames.has(expectedCol)) {
        tableResult.columns[expectedCol] = 'EXISTS';
      } else {
        tableResult.columns[expectedCol] = 'MISSING';
        allColsMatch = false;
        results.minimal_delta.push(`ALTER TABLE ${tableName} ADD COLUMN ${expectedCol} TEXT;`);
      }
    }

    // Check indexes
    const actualIndexes = await getTableIndexes(tableName);
    const actualIndexSet = new Set(actualIndexes);
    const expectedIndexes = EXPECTED_INDEXES[tableName] || [];
    for (const idx of expectedIndexes) {
      if (actualIndexSet.has(idx)) {
        tableResult.indexes[idx] = 'EXISTS';
      } else {
        tableResult.indexes[idx] = 'MISSING';
        allColsMatch = false;
        results.minimal_delta.push(`CREATE INDEX ${idx} ON ${tableName}(...);`);
      }
    }

    // Check unique constraints
    const constraints = await getTableConstraints(tableName);
    const uniqueConstraints = constraints.filter(c => c.contype === 'u').map(c => c.conname);
    const expectedUnique = EXPECTED_UNIQUE[tableName] || [];
    for (const u of expectedUnique) {
      const hasIt = constraints.some(c => c.contype === 'u' && c.conname.includes(u));
      tableResult.constraints[u] = hasIt ? 'EXISTS' : 'MISSING';
      if (!hasIt) allColsMatch = false;
    }

    // Check external_ref unique constraint
    const hasExternalRefUnique = constraints.some(c => c.contype === 'u' && c.conname.includes('external_ref'));
    if (expectedCols.includes('external_ref')) {
      tableResult.constraints['external_ref_unique'] = hasExternalRefUnique ? 'EXISTS' : 'MISSING';
      if (!hasExternalRefUnique) allColsMatch = false;
    }

    tableResult.status = allColsMatch ? 'EXISTS + MATCHES' : 'EXISTS + DIFFERENT';
    if (allColsMatch) results.summary.exists_matches++;
    else results.summary.exists_different++;

    results.tables[tableName] = tableResult;
  }

  // ── REPORT ──────────────────────────────────────────────────────────────────
  console.log('========== SCHEMA INSPECTION REPORT ==========\n');
  console.log(`Summary: ${results.summary.exists_matches} EXISTS+MATCH, ${results.summary.exists_different} EXISTS+DIFFERENT, ${results.summary.missing} MISSING\n`);

  console.log('--- Leads Table Columns ---');
  for (const [col, status] of Object.entries(results.leads_columns)) {
    if (status !== 'EXISTS + MATCHES') console.log(`  [${status}] leads.${col}`);
  }

  console.log('\n--- Tables from 2026-14 ---');
  for (const [table, info] of Object.entries(results.tables)) {
    console.log(`  [${info.status}] ${table}`);
    if (info.status !== 'EXISTS + MATCHES') {
      for (const [col, status] of Object.entries(info.columns)) {
        if (status === 'MISSING') console.log(`    [MISSING] column: ${col}`);
      }
      for (const [idx, status] of Object.entries(info.indexes)) {
        if (status === 'MISSING') console.log(`    [MISSING] index: ${idx}`);
      }
      for (const [con, status] of Object.entries(info.constraints)) {
        if (status === 'MISSING') console.log(`    [MISSING] constraint: ${con}`);
      }
    }
  }

  console.log('\n--- Minimal Schema Delta Required ---');
  if (results.minimal_delta.length === 0) {
    console.log('  (none — schema is up to date)');
  } else {
    for (const d of results.minimal_delta) {
      console.log(`  ${d}`);
    }
  }

  console.log('\n========== END REPORT ==========\n');

  // Write full report to file
  const fs = require('fs');
  const path = require('path');
  const reportPath = path.join(__dirname, '..', '..', 'schema_inspection_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`[schema] Full report written to: ${reportPath}`);

  return results;
}

inspect().catch(e => {
  console.error('[schema] FATAL:', e.message);
  process.exit(1);
});