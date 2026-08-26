#!/usr/bin/env node
/* eslint-disable no-undef */
'use strict';
/**
 * auditPropertyCoverage2.js — Phase 2: check settings table schema + leads QB columns
 */
const { query } = require('../db/client');

async function main() {
  const report = {};

  // ── 1. Settings table schema ─────────────────────────────────────────────
  try {
    const { rows: colRows } = await query(`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'settings' ORDER BY ordinal_position
    `);
    report.settingsColumns = colRows;

    // Get all rows
    const { rows: settingsRows } = await query('SELECT * FROM settings LIMIT 50');
    report.settingsRows = settingsRows;
    report.settingsCount = settingsRows.length;
  } catch (e) {
    report.settingsError = e.message;
  }

  // ── 2. Leads table QB-related columns ─────────────────────────────────────
  try {
    const { rows: qbCols } = await query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'leads' AND (column_name LIKE '%qb%' OR column_name LIKE '%quickbook%')
      ORDER BY column_name
    `);
    report.leadsQbColumns = qbCols.map(r => r.column_name);

    // Count leads with QB customer ID
    if (qbCols.some(c => c.column_name === 'qb_customer_id')) {
      const { rows: cntRows } = await query(`SELECT COUNT(*) as cnt FROM leads WHERE qb_customer_id IS NOT NULL AND qb_customer_id != ''`);
      report.leadsWithQbCustomerId = parseInt(cntRows[0].cnt, 10);
    }
  } catch (e) {
    report.leadsQbError = e.message;
  }

  // ── 3. Check all tables that might store QB mappings ──────────────────────
  try {
    const { rows: tableRows } = await query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND (table_name LIKE '%qb%' OR table_name LIKE '%match%' OR table_name LIKE '%mapping%')
      ORDER BY table_name
    `);
    report.qbRelatedTables = tableRows.map(r => r.table_name);
  } catch (e) {
    report.qbTablesError = e.message;
  }

  // ── 4. Check SignNow credential store ─────────────────────────────────────
  try {
    const { rows: snRows } = await query(`
      SELECT provider, credential_type, environment, status, account_identifier, created_at, updated_at
      FROM integration_credentials
      WHERE provider = 'signnow' OR credential_type = 'signnow'
    `);
    report.signnowCredentials = snRows;
  } catch (e) {
    report.signnowError = e.message;
  }

  // ── 5. Check Handoff credential store ─────────────────────────────────────
  try {
    const { rows: hfRows } = await query(`
      SELECT provider, credential_type, environment, status, account_identifier, created_at, updated_at
      FROM integration_credentials
      WHERE provider = 'handoff' OR credential_type = 'handoff' OR provider = '1build' OR provider = 'cement'
    `);
    report.handoffCredentials = hfRows;
  } catch (e) {
    report.handoffError = e.message;
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});