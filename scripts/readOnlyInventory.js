/* eslint-disable no-undef */
/**
 * read-only-inventory.js — Count Base44 entities vs Railway tables.
 *
 * Run on Railway: node scripts/read-only-inventory.js
 *
 * Reads counts from:
 *   - Base44 REST API (BASE44_APP_ID, BASE44_API_KEY)
 *   - Railway Postgres (DATABASE_URL)
 *
 * Outputs a comparison table showing which entities need migration
 * and the gap between Base44 and Railway.
 *
 * READ-ONLY: does not write anything. Safe to run anytime.
 */
'use strict';

const { query } = require('../db/client');

const BASE44_API_URL = process.env.BASE44_API_URL || 'https://api.base44.com';
const BASE44_APP_ID = process.env.BASE44_APP_ID;
const BASE44_API_KEY = process.env.BASE44_API_KEY;

if (!BASE44_APP_ID || !BASE44_API_KEY) {
  console.error('[inventory] BASE44_APP_ID and BASE44_API_KEY required');
  process.exit(1);
}

async function countBase44Entity(entityName) {
  try {
    const url = `${BASE44_API_URL}/entities/${entityName}?limit=1`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${BASE44_API_KEY}`, 'X-App-ID': BASE44_APP_ID },
    });
    if (!res.ok) {
      console.warn(`[inventory] Base44 ${entityName}: HTTP ${res.status}`);
      return -1;
    }
    const data = await res.json();
    // Base44 returns an array; we need the total count
    // The API doesn't return a total count directly, so we fetch with a large limit
    const countUrl = `${BASE44_API_URL}/entities/${entityName}?limit=5000`;
    const countRes = await fetch(countUrl, {
      headers: { 'Authorization': `Bearer ${BASE44_API_KEY}`, 'X-App-ID': BASE44_APP_ID },
    });
    const countData = await countRes.json();
    return Array.isArray(countData) ? countData.length : (countData.total || 0);
  } catch (e) {
    console.warn(`[inventory] Base44 ${entityName} error: ${e.message}`);
    return -1;
  }
}

async function countRailwayTable(tableName) {
  try {
    const { rows } = await query(`SELECT COUNT(*) as cnt FROM ${tableName}`);
    return parseInt(rows[0].cnt, 10);
  } catch (e) {
    return -1; // table doesn't exist
  }
}

const BASE44_ENTITIES = [
  'Lead', 'Activity', 'Deal', 'DealExpense', 'DealExpensePayment', 'DealCommission',
  'DealLoanPayment', 'Invoice', 'Task', 'Property', 'LeadAttachment',
  'CompanySettings', 'HandoffEstimate', 'SyncCursor', 'LeadSubmission',
  'UserAllowlist', 'AccessRequest', 'Contact', 'Estimate', 'Project',
  'SignNowDocument', 'SignNowTemplate', 'QBConnection', 'QBLeadMatchMapping',
  'QBSyncJob', 'QBSyncLog', 'SmsLog', 'SmsReminder', 'CalendarSyncQueue',
  'HandoffSyncQueue', 'HubSpotSyncJob', 'IntegrationSyncLog', 'SyncReport',
  'SyncState', 'SyncJob', 'Automation', 'AutomationRun', 'LeadHealthScore',
  'DealHealthScore', 'HandoffEstimateSeedIds', 'Settings',
];

const RAILWAY_TABLES = {
  'Lead': 'leads',
  'Activity': 'activities',
  'Deal': 'deals',
  'DealExpense': 'deal_expenses',
  'DealExpensePayment': 'deal_expense_payments',
  'DealCommission': 'deal_commissions',
  'DealLoanPayment': 'deal_loan_payments',
  'Invoice': 'invoices',
  'Task': 'tasks',
  'Property': 'properties',
  'LeadAttachment': 'lead_attachments',
  'CompanySettings': 'company_settings',
  'HandoffEstimate': 'handoff_estimates',
  'SyncCursor': 'sync_cursors',
  'LeadSubmission': 'lead_submissions',
  'UserAllowlist': 'user_allowlist',
  'AccessRequest': 'access_requests',
  'Contact': 'contacts',
  'Estimate': 'estimates',
  'Project': 'projects',
  'SignNowDocument': 'signnow_documents',
  'SignNowTemplate': 'signnow_templates',
  'QBConnection': 'integration_credentials',
  'SmsLog': 'sms_logs',
  'SmsReminder': 'reminder_claims',
  'CalendarSyncQueue': 'calendar_outbox',
  'Settings': 'settings',
};

async function main() {
  console.log('\n=== BASE44 vs RAILWAY INVENTORY ===\n');
  console.log('Entity                       | Base44 | Railway | Gap  | Status');
  console.log('-----------------------------|--------|---------|------|-------');

  const results = [];

  for (const entity of BASE44_ENTITIES) {
    const base44Count = await countBase44Entity(entity);
    const railwayTable = RAILWAY_TABLES[entity];
    const railwayCount = railwayTable ? await countRailwayTable(railwayTable) : -1;

    const gap = base44Count > 0 ? base44Count - Math.max(0, railwayCount) : 0;
    let status = 'OK';
    if (base44Count > 0 && railwayCount === -1) status = 'TABLE_MISSING';
    else if (base44Count > 0 && railwayCount === 0) status = 'NEEDS_MIGRATION';
    else if (gap > 0) status = `GAP(${gap})`;
    else if (base44Count === -1) status = 'B44_ERROR';

    const pad = (s, n) => String(s).padEnd(n);
    console.log(`${pad(entity, 29)}| ${pad(base44Count, 7)}| ${pad(railwayCount, 8)}| ${pad(gap, 5)}| ${status}`);

    results.push({ entity, base44Count, railwayCount, gap, status });
  }

  console.log('\n=== SUMMARY ===');
  const needsMigration = results.filter(r => r.status === 'NEEDS_MIGRATION' || r.gap > 0);
  const tableMissing = results.filter(r => r.status === 'TABLE_MISSING');
  console.log(`Entities needing migration: ${needsMigration.length}`);
  console.log(`Tables missing: ${tableMissing.length}`);
  if (tableMissing.length > 0) {
    console.log('Missing tables for:', tableMissing.map(r => r.entity).join(', '));
  }

  // Output JSON for programmatic use
  const fs = require('fs');
  fs.writeFileSync('/tmp/base44-inventory.json', JSON.stringify(results, null, 2));
  console.log('\nDetailed JSON: /tmp/base44-inventory.json');

  process.exit(0);
}

main().catch(e => {
  console.error('[inventory] fatal:', e);
  process.exit(1);
});