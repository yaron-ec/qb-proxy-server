#!/usr/bin/env node
/* eslint-disable no-undef */
'use strict';
/**
 * auditPropertyCoverage.js — Prove destination coverage for all 133 Base44
 * Property records before excluding them.
 *
 * Queries Railway tables:
 *   1. integration_credentials — for qb_tokens, signnow_tokens, handoff_bearer_token
 *   2. settings                 — for 16 UI/integration config keys
 *   3. company_settings         — for any overlapping config
 *   4. qb_lead_match_mappings    — for 114 qb_customer_<leadId> mappings
 *
 * Outputs JSON to stdout. No secret values are printed.
 */
const { query } = require('../db/client');

async function main() {
  const report = { credentials: {}, settings: {}, companySettings: {}, qbMappings: {} };

  // ── 1. CREDENTIALS: integration_credentials ──────────────────────────────
  try {
    const { rows: creds } = await query(`
      SELECT provider, credential_type, environment, account_identifier,
             status, expires_at, connected_at, refreshed_at, last_used_at,
             last_error_at, created_at, updated_at
      FROM integration_credentials
      ORDER BY provider, credential_type, environment
    `);
    report.credentials.tableExists = true;
    report.credentials.records = creds.map(c => ({
      provider: c.provider,
      credential_type: c.credential_type,
      environment: c.environment,
      account_identifier: c.account_identifier,
      status: c.status,
      expires_at: c.expires_at,
      connected_at: c.connected_at,
      refreshed_at: c.refreshed_at,
      last_used_at: c.last_used_at,
      last_error_at: c.last_error_at,
      created_at: c.created_at,
      updated_at: c.updated_at,
    }));
    report.credentials.count = creds.length;

    // Check specific providers
    report.credentials.hasQuickBooks = creds.some(c => c.provider === 'intuit' && c.credential_type === 'quickbooks');
    report.credentials.hasSignNow = creds.some(c => c.provider === 'signnow' || c.credential_type === 'signnow');
    report.credentials.hasHandoff = creds.some(c => c.provider === 'handoff' || c.credential_type === 'handoff');
  } catch (e) {
    report.credentials.tableExists = false;
    report.credentials.error = e.message;
  }

  // ── 2. SETTINGS: settings table ──────────────────────────────────────────
  try {
    const { rows: settingsRows } = await query('SELECT app_lists, updated_at FROM settings WHERE id = 1');
    report.settings.tableExists = true;
    const appLists = (settingsRows[0] && settingsRows[0].app_lists) || {};
    const settingKeys = Object.keys(appLists);
    report.settings.records = settingKeys.map(k => ({ key: k, value: appLists[k] }));
    report.settings.count = settingKeys.length;
    report.settings.keys = settingKeys;
  } catch (e) {
    report.settings.tableExists = false;
    report.settings.error = e.message;
  }

  // ── 3. COMPANY_SETTINGS ──────────────────────────────────────────────────
  try {
    const { rows: csRows } = await query('SELECT * FROM company_settings LIMIT 5');
    report.companySettings.tableExists = true;
    report.companySettings.count = csRows.length;
    if (csRows[0]) {
      report.companySettings.keys = Object.keys(csRows[0]).filter(k => !['id', 'created_at', 'updated_at'].includes(k));
      report.companySettings.sample = csRows[0];
    }
  } catch (e) {
    report.companySettings.tableExists = false;
    report.companySettings.error = e.message;
  }

  // ── 4. QB_LEAD_MATCH_MAPPINGS ─────────────────────────────────────────────
  try {
    const { rows: mapRows } = await query('SELECT COUNT(*) as cnt FROM qb_lead_match_mappings');
    report.qbMappings.tableExists = true;
    report.qbMappings.count = parseInt(mapRows[0].cnt, 10);
  } catch (e) {
    report.qbMappings.tableExists = false;
    report.qbMappings.error = e.message;
  }

  // ── 5. Check if leads table has qb_customer_id column ─────────────────────
  try {
    const { rows: colRows } = await query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'leads' AND column_name = 'qb_customer_id'
    `);
    report.leadsHasQbCustomerId = colRows.length > 0;

    if (colRows.length > 0) {
      const { rows: leadQbRows } = await query(`
        SELECT COUNT(*) as total,
               COUNT(qb_customer_id) as with_qb_customer_id
        FROM leads
        WHERE qb_customer_id IS NOT NULL AND qb_customer_id != ''
      `);
      report.leadsWithQbCustomerId = {
        total: parseInt(leadQbRows[0].total, 10),
        withQbCustomerId: parseInt(leadQbRows[0].with_qb_customer_id, 10),
      };
    }
  } catch (e) {
    report.leadsHasQbCustomerId = false;
    report.leadsQbError = e.message;
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});