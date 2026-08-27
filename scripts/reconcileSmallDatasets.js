/* eslint-disable no-undef */
'use strict';
/**
 * reconcileSmallDatasets.js — READ-ONLY production reconciliation of the
 * permanently-written SmallDatasets state (UserAllowlist, CompanySettings,
 * SyncCursor, LeadAttachment, DealExpense) against the Base44 source.
 *
 * STRICTLY READ-ONLY: executes ONLY SELECT queries. No BEGIN/COMMIT, no
 * INSERT/UPDATE/DELETE, no writes of any kind. Safe to run at any time.
 *
 * Compares per-entity:
 *   1. Base44 source count vs Railway count
 *   2. Natural-key presence (every Base44 record has a Railway row; no extras)
 *   3. Field-level comparison (every migrated field, with the SAME defaults
 *      the migration applies, so "expected" == "actual" on a clean run)
 *   4. FK resolution (lead_attachments.lead_id, deal_expenses.deal_id/lead_id)
 *   5. Identity checks (UserAllowlist: Simon present, Shlomi absent, etc.)
 *   6. Off-domain SyncCursor preservation
 *
 * Cross-system summary: matched / mismatched / missing / unexpected-extra
 * across all 48 source records (4+1+5+7+31).
 *
 * Environment: DATABASE_URL, WORKER_SECRET (for migrationReader fetches).
 */
const { query } = require('../db/client');
const { fetchBase44Entity } = require('./migrationHelpers');

// ── Normalization helpers ───────────────────────────────────────────────────
// Normalize a value the same way the migration writes it, so expected == actual.
function norm(v) {
  if (v === null || v === undefined) return null;
  return v;
}
function num(v) {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}
function boolStrictTrue(v) { return v === true; }          // === true
function boolNotFalse(v) { return v !== false; }            // !== false
function dateOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
// Compare two normalized values for equality (handles numbers, strings, booleans, null, dates-as-iso)
function eq(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b);
  return String(a) === String(b);
}

// ── Per-entity field specs: [railwayColumn, base44Field, normalizer] ─────────
// normalizer(item) => expected value for that column.
const UA_FIELDS = [
  ['email', (i) => i.email],
  ['name', (i) => norm(i.name)],
  ['role', (i) => i.role || 'sales_rep'],
  ['enabled', (i) => boolNotFalse(i.enabled)],
  ['notes', (i) => norm(i.notes)],
];
const CS_FIELDS = [
  ['company_name', (i) => i.company_name || 'EC Construction Group'],
  ['company_logo_url', (i) => norm(i.company_logo_url)],
  ['company_email', (i) => norm(i.company_email)],
  ['company_phone', (i) => norm(i.company_phone)],
  ['company_address', (i) => norm(i.company_address)],
  ['company_city', (i) => norm(i.company_city)],
  ['company_state', (i) => norm(i.company_state)],
  ['company_zip', (i) => norm(i.company_zip)],
  ['admin_name', (i) => norm(i.admin_name)],
  ['admin_email', (i) => norm(i.admin_email)],
  ['company_website', (i) => norm(i.company_website)],
  ['crm_activity_notifications_enabled', (i) => boolStrictTrue(i.crm_activity_notifications_enabled)],
];
const SC_FIELDS = [
  ['integration', (i) => i.integration],
  ['last_successful_sync_at', (i) => dateOrNull(i.last_successful_sync_at)],
  ['last_cursor', (i) => norm(i.last_cursor)],
  ['last_record_id', (i) => norm(i.last_record_id)],
  ['last_updated_timestamp', (i) => dateOrNull(i.last_updated_timestamp)],
  ['total_synced', (i) => num(i.total_synced)],
  ['last_sync_summary', (i) => i.last_sync_summary ? JSON.stringify(i.last_sync_summary) : null],
  ['is_full_sync_in_progress', (i) => boolStrictTrue(i.is_full_sync_in_progress)],
];
const LA_FIELDS = [
  ['external_ref', (i) => String(i.id)],
  ['file_name', (i) => norm(i.file_name)],
  ['file_url', (i) => i.file_url],
  ['file_type', (i) => norm(i.file_type)],
  ['file_size', (i) => i.file_size !== null && i.file_size !== undefined ? num(i.file_size) : null],
  ['storage_key', (i) => norm(i.storage_key)],
  ['uploaded_by', (i) => norm(i.uploaded_by)],
  ['uploaded_at', (i) => dateOrNull(i.uploaded_at)],
  ['qb_invoice_id', (i) => norm(i.qb_invoice_id)],
  ['qb_invoice_number', (i) => norm(i.qb_invoice_number)],
  ['invoice_amount', (i) => i.invoice_amount !== null && i.invoice_amount !== undefined ? num(i.invoice_amount) : null],
  ['invoice_date', (i) => dateOrNull(i.invoice_date)],
  ['due_date', (i) => dateOrNull(i.due_date)],
  ['balance_due', (i) => i.balance_due !== null && i.balance_due !== undefined ? num(i.balance_due) : null],
];
const DE_FIELDS = [
  ['external_ref', (i) => String(i.id)],
  ['expense_date', (i) => dateOrNull(i.expense_date)],
  ['vendor_name', (i) => i.vendor_name || 'Unknown'],
  ['vendor_id', (i) => norm(i.vendor_id)],
  ['category', (i) => i.category || 'Other'],
  ['subcategory', (i) => norm(i.subcategory)],
  ['description', (i) => norm(i.description)],
  ['amount', (i) => num(i.amount)],
  ['payment_status', (i) => i.payment_status || 'Unpaid'],
  ['payment_method', (i) => norm(i.payment_method)],
  ['check_or_reference_number', (i) => norm(i.check_or_reference_number)],
  ['quickbooks_transaction_id', (i) => norm(i.quickbooks_transaction_id)],
  ['quickbooks_sync_status', (i) => i.quickbooks_sync_status || 'not_synced'],
  ['receipt_url', (i) => norm(i.receipt_url)],
  ['receipt_key', (i) => norm(i.receipt_key)],
  ['receipt_filename', (i) => norm(i.receipt_filename)],
  ['receipt_mime_type', (i) => norm(i.receipt_mime_type)],
  ['notes', (i) => norm(i.notes)],
  ['include_in_profit_calculation', (i) => boolNotFalse(i.include_in_profit_calculation)],
  ['amount_paid', (i) => num(i.amount_paid)],
  ['amount_remaining', (i) => num(i.amount_remaining)],
  ['created_by', (i) => norm(i.created_by)],
  ['updated_by', (i) => norm(i.updated_by)],
];

// ── Generic per-entity reconciler ───────────────────────────────────────────
// Returns { matched, mismatched, missing, extra, mismatches[], missingKeys[], extraKeys[], fkIssues[] }
function reconcileEntity(name, b44Items, railwayRows, keyCol, keyFn, fields, fkCheck) {
  const result = { matched: 0, mismatched: 0, missing: 0, extra: 0, mismatches: [], missingKeys: [], extraKeys: [], fkIssues: [] };
  const railwayByKey = {};
  for (const r of railwayRows) railwayByKey[String(r[keyCol])] = r;
  const b44Keys = new Set();
  for (const item of b44Items) {
    const k = String(keyFn(item));
    b44Keys.add(k);
    const row = railwayByKey[k];
    if (!row) {
      result.missing++;
      result.missingKeys.push(k);
      continue;
    }
    // FK check (optional)
    if (fkCheck) {
      const fkIssue = fkCheck(row, item);
      if (fkIssue) result.fkIssues.push(fkIssue);
    }
    // Field comparison
    let fieldMismatch = null;
    for (const [col, normFn] of fields) {
      const expected = normFn(item);
      let actual = row[col];
      // Normalize date columns to ISO for comparison
      if (actual instanceof Date) actual = actual.toISOString();
      if (!eq(expected, actual)) {
        if (!fieldMismatch) fieldMismatch = { key: k, fields: [] };
        fieldMismatch.fields.push({ col, expected: String(expected), actual: String(actual) });
      }
    }
    if (fieldMismatch) {
      result.mismatched++;
      result.mismatches.push(fieldMismatch);
    } else {
      result.matched++;
    }
  }
  // Extras: Railway rows whose key is not in Base44
  for (const k of Object.keys(railwayByKey)) {
    if (!b44Keys.has(k)) {
      result.extra++;
      result.extraKeys.push(k);
    }
  }
  return result;
}

async function reconcile() {
  console.log('=== SMALL DATASETS READ-ONLY RECONCILIATION ===\n');
  const report = {};
  let totalMatched = 0, totalMismatched = 0, totalMissing = 0, totalExtra = 0;
  let totalSource = 0, totalRailway = 0;
  let clean = true;

  // ── Fetch Base44 source ────────────────────────────────────────────────────
  const [uaItems, csItems, scItems, laItems, deItems, b44Leads, b44Deals] = await Promise.all([
    fetchBase44Entity('UserAllowlist'),
    fetchBase44Entity('CompanySettings'),
    fetchBase44Entity('SyncCursor'),
    fetchBase44Entity('LeadAttachment'),
    fetchBase44Entity('DealExpense'),
    fetchBase44Entity('Lead'),
    fetchBase44Entity('Deal'),
  ]);
  console.log(`Base44 source: UA=${uaItems.length}, CS=${csItems.length}, SC=${scItems.length}, LA=${laItems.length}, DE=${deItems.length}`);
  totalSource = uaItems.length + csItems.length + scItems.length + laItems.length + deItems.length;

  // ── Fetch Railway rows ─────────────────────────────────────────────────────
  const [uaRows, csRows, scRows, laRows, deRows, leadRows, dealRows] = await Promise.all([
    query('SELECT * FROM user_allowlist'),
    query('SELECT * FROM company_settings'),
    query('SELECT * FROM sync_cursors'),
    query('SELECT * FROM lead_attachments'),
    query('SELECT * FROM deal_expenses'),
    query('SELECT id, external_ref FROM leads WHERE external_ref IS NOT NULL'),
    query('SELECT id, legacy_base44_id FROM deals WHERE legacy_base44_id IS NOT NULL'),
  ]);
  totalRailway = uaRows.rows.length + csRows.rows.length + scRows.rows.length + laRows.rows.length + deRows.rows.length;
  console.log(`Railway:       UA=${uaRows.rows.length}, CS=${csRows.rows.length}, SC=${scRows.rows.length}, LA=${laRows.rows.length}, DE=${deRows.rows.length}`);
  console.log(`FK targets:     leads=${leadRows.rows.length}, deals=${dealRows.rows.length}\n`);

  // FK caches
  const leadCache = {}; for (const r of leadRows.rows) leadCache[String(r.external_ref)] = r.id;
  const dealCache = {}; for (const r of dealRows.rows) dealCache[String(r.legacy_base44_id)] = r.id;

  // ── 1. UserAllowlist ───────────────────────────────────────────────────────
  console.log('=== UserAllowlist ===');
  {
    const emails = uaRows.rows.map(r => r.email);
    const emailCounts = {}; for (const e of emails) emailCounts[e] = (emailCounts[e] || 0) + 1;
    const dupEmails = Object.keys(emailCounts).filter(e => emailCounts[e] > 1);
    const simon = uaRows.rows.find(r => r.email === 'office@tsvisionbuilders.com');
    const shlomiByName = uaRows.rows.find(r => (r.name || '').toLowerCase().includes('shlomi'));
    const shlomiByEmail = uaRows.rows.find(r => (r.email || '').toLowerCase().includes('shlomi'));
    const yaron = uaRows.rows.find(r => (r.email || '').toLowerCase().includes('yaron') || (r.name || '').toLowerCase().includes('yaron'));
    const michelle = uaRows.rows.find(r => (r.email || '').toLowerCase().includes('michelle') || (r.name || '').toLowerCase().includes('michelle'));
    const ethan = uaRows.rows.find(r => (r.email || '').toLowerCase().includes('ethan') || (r.name || '').toLowerCase().includes('ethan'));
    console.log(`  count: ${uaRows.rows.length} (expected ${uaItems.length})`);
    console.log(`  unique emails: ${new Set(emails).size}/${emails.length} ${dupEmails.length === 0 ? '✅' : '❌ dup: ' + JSON.stringify(dupEmails)}`);
    console.log(`  Simon (office@tsvisionbuilders.com) present: ${simon ? '✅' : '❌'} ${simon ? `(role=${simon.role})` : ''}`);
    console.log(`  Shlomi absent: ${!shlomiByName && !shlomiByEmail ? '✅' : '❌ FOUND: ' + JSON.stringify(shlomiByName || shlomiByEmail)}`);
    console.log(`  Yaron present: ${yaron ? '✅' : '❌'} ${yaron ? `(role=${yaron.role})` : ''}`);
    console.log(`  Michelle present: ${michelle ? '✅' : '❌'} ${michelle ? `(role=${michelle.role})` : ''}`);
    console.log(`  Ethan present: ${ethan ? '✅' : '❌'} ${ethan ? `(role=${ethan.role})` : ''}`);
    const r = reconcileEntity('UserAllowlist', uaItems, uaRows.rows, 'email', (i) => i.email, UA_FIELDS);
    report.UserAllowlist = r;
    console.log(`  matched=${r.matched}, mismatched=${r.mismatched}, missing=${r.missing}, extra=${r.extra}`);
    if (r.mismatches.length) for (const m of r.mismatches.slice(0, 5)) console.log(`    MISMATCH ${m.key}: ${JSON.stringify(m.fields)}`);
    if (r.missingKeys.length) console.log(`    MISSING: ${JSON.stringify(r.missingKeys)}`);
    if (r.extraKeys.length) console.log(`    EXTRA: ${JSON.stringify(r.extraKeys)}`);
    totalMatched += r.matched; totalMismatched += r.mismatched; totalMissing += r.missing; totalExtra += r.extra;
  }

  // ── 2. CompanySettings ─────────────────────────────────────────────────────
  console.log('\n=== CompanySettings ===');
  {
    console.log(`  count: ${csRows.rows.length} (expected ${csItems.length}, singleton)`);
    const r = reconcileEntity('CompanySettings', csItems, csRows.rows, 'company_name', (i) => i.company_name || 'EC Construction Group', CS_FIELDS);
    report.CompanySettings = r;
    console.log(`  matched=${r.matched}, mismatched=${r.mismatched}, missing=${r.missing}, extra=${r.extra}`);
    if (r.mismatches.length) for (const m of r.mismatches) console.log(`    MISMATCH ${m.key}: ${JSON.stringify(m.fields)}`);
    if (r.missingKeys.length) console.log(`    MISSING: ${JSON.stringify(r.missingKeys)}`);
    if (r.extraKeys.length) console.log(`    EXTRA: ${JSON.stringify(r.extraKeys)}`);
    totalMatched += r.matched; totalMismatched += r.mismatched; totalMissing += r.missing; totalExtra += r.extra;
  }

  // ── 3. SyncCursor ──────────────────────────────────────────────────────────
  console.log('\n=== SyncCursor ===');
  {
    const offDomain = scRows.rows.find(r => r.integration === 'user_email_yaron.ecrenewables@gmail.com');
    console.log(`  count: ${scRows.rows.length} (expected ${scItems.length})`);
    console.log(`  off-domain cursor 'user_email_yaron.ecrenewables@gmail.com' preserved: ${offDomain ? '✅' : '❌'}`);
    const r = reconcileEntity('SyncCursor', scItems, scRows.rows, 'integration', (i) => i.integration, SC_FIELDS);
    report.SyncCursor = r;
    console.log(`  matched=${r.matched}, mismatched=${r.mismatched}, missing=${r.missing}, extra=${r.extra}`);
    if (r.mismatches.length) for (const m of r.mismatches.slice(0, 5)) console.log(`    MISMATCH ${m.key}: ${JSON.stringify(m.fields)}`);
    if (r.missingKeys.length) console.log(`    MISSING: ${JSON.stringify(r.missingKeys)}`);
    if (r.extraKeys.length) console.log(`    EXTRA: ${JSON.stringify(r.extraKeys)}`);
    totalMatched += r.matched; totalMismatched += r.mismatched; totalMissing += r.missing; totalExtra += r.extra;
  }

  // ── 4. LeadAttachment ──────────────────────────────────────────────────────
  console.log('\n=== LeadAttachment ===');
  {
    const extRefs = laRows.rows.map(r => String(r.external_ref));
    const dupRefs = extRefs.filter((e, i, a) => a.indexOf(e) !== i);
    console.log(`  count: ${laRows.rows.length} (expected ${laItems.length})`);
    console.log(`  unique external_ref: ${new Set(extRefs).size}/${extRefs.length} ${dupRefs.length === 0 ? '✅' : '❌ dup: ' + JSON.stringify(dupRefs)}`);
    // FK check
    const fkCheck = (row) => {
      if (!row.lead_id) return { key: row.external_ref, issue: 'null lead_id' };
      const exists = leadRows.rows.some(l => l.id === row.lead_id);
      if (!exists) return { key: row.external_ref, issue: `lead_id ${row.lead_id} not in leads` };
      return null;
    };
    const r = reconcileEntity('LeadAttachment', laItems, laRows.rows, 'external_ref', (i) => String(i.id), LA_FIELDS, fkCheck);
    report.LeadAttachment = r;
    console.log(`  matched=${r.matched}, mismatched=${r.mismatched}, missing=${r.missing}, extra=${r.extra}`);
    console.log(`  FK issues: ${r.fkIssues.length} ${r.fkIssues.length === 0 ? '✅' : '❌'}`);
    if (r.fkIssues.length) for (const f of r.fkIssues.slice(0, 5)) console.log(`    FK ISSUE ${f.key}: ${f.issue}`);
    if (r.mismatches.length) for (const m of r.mismatches.slice(0, 5)) console.log(`    MISMATCH ${m.key}: ${JSON.stringify(m.fields)}`);
    if (r.missingKeys.length) console.log(`    MISSING: ${JSON.stringify(r.missingKeys)}`);
    if (r.extraKeys.length) console.log(`    EXTRA: ${JSON.stringify(r.extraKeys)}`);
    totalMatched += r.matched; totalMismatched += r.mismatched; totalMissing += r.missing; totalExtra += r.extra;
  }

  // ── 5. DealExpense ─────────────────────────────────────────────────────────
  console.log('\n=== DealExpense ===');
  {
    const extRefs = deRows.rows.map(r => String(r.external_ref));
    const dupRefs = extRefs.filter((e, i, a) => a.indexOf(e) !== i);
    console.log(`  count: ${deRows.rows.length} (expected ${deItems.length})`);
    console.log(`  unique external_ref: ${new Set(extRefs).size}/${extRefs.length} ${dupRefs.length === 0 ? '✅' : '❌ dup: ' + JSON.stringify(dupRefs)}`);
    const fkCheck = (row) => {
      if (!row.deal_id) return { key: row.external_ref, issue: 'null deal_id' };
      const dealExists = dealRows.rows.some(d => d.id === row.deal_id);
      if (!dealExists) return { key: row.external_ref, issue: `deal_id ${row.deal_id} not in deals` };
      if (row.lead_id) {
        const leadExists = leadRows.rows.some(l => l.id === row.lead_id);
        if (!leadExists) return { key: row.external_ref, issue: `lead_id ${row.lead_id} not in leads` };
      }
      return null;
    };
    const r = reconcileEntity('DealExpense', deItems, deRows.rows, 'external_ref', (i) => String(i.id), DE_FIELDS, fkCheck);
    report.DealExpense = r;
    console.log(`  matched=${r.matched}, mismatched=${r.mismatched}, missing=${r.missing}, extra=${r.extra}`);
    console.log(`  FK issues: ${r.fkIssues.length} ${r.fkIssues.length === 0 ? '✅' : '❌'}`);
    if (r.fkIssues.length) for (const f of r.fkIssues.slice(0, 5)) console.log(`    FK ISSUE ${f.key}: ${f.issue}`);
    if (r.mismatches.length) for (const m of r.mismatches.slice(0, 5)) console.log(`    MISMATCH ${m.key}: ${JSON.stringify(m.fields)}`);
    if (r.missingKeys.length) console.log(`    MISSING: ${JSON.stringify(r.missingKeys)}`);
    if (r.extraKeys.length) console.log(`    EXTRA: ${JSON.stringify(r.extraKeys)}`);
    totalMatched += r.matched; totalMismatched += r.mismatched; totalMissing += r.missing; totalExtra += r.extra;
  }

  // ── Cross-system reconciliation ────────────────────────────────────────────
  console.log('\n=== CROSS-SYSTEM RECONCILIATION ===');
  console.log(`  Base44 source total:  ${totalSource}`);
  console.log(`  Railway total:        ${totalRailway}`);
  console.log(`  matched:              ${totalMatched}`);
  console.log(`  mismatched:           ${totalMismatched}`);
  console.log(`  missing (in B44, not Railway): ${totalMissing}`);
  console.log(`  unexpected extra (in Railway, not B44): ${totalExtra}`);
  const expectedMatched = 48;
  const ok = (totalMatched === expectedMatched && totalMismatched === 0 && totalMissing === 0 && totalExtra === 0);
  console.log(`\n  EXPECTED: matched=${expectedMatched}, mismatched=0, missing=0, extra=0`);
  console.log(`  ${ok ? '✅ RECONCILIATION CLEAN — 100% match' : '❌ RECONCILIATION FAILED — see above'}`);

  // ── Final verdict ──────────────────────────────────────────────────────────
  console.log('\n=== FINAL VERDICT ===');
  console.log(`  SmallDatasets permanent state: ${ok ? 'CLEAN — accept as COMPLETE' : 'NOT CLEAN — investigate'}`);
  process.exit(ok ? 0 : 1);
}

reconcile().catch(e => {
  console.error('[reconcile-small] FATAL:', e);
  process.exit(1);
});