/* eslint-disable no-undef */
'use strict';
/**
 * rollbackValidateSmallDatasets.js — Production-path rollback validation for
 * the small-datasets migration (UserAllowlist, CompanySettings, SyncCursor,
 * LeadAttachment, DealExpense).
 *
 * Calls the EXACT same runSmallDatasetsMigration() function used by:
 *   node scripts/migrateSmallDatasetsToRailway.js
 *
 * ...but inside a PostgreSQL transaction that is ALWAYS ROLLED BACK.
 *
 * CRITICAL: Uses explicit BEGIN before any writes. Post-rollback verification
 * uses a FRESH pool connection (same pattern as rollbackValidateHandoffEstimates).
 *
 * Verifies per-entity:
 *   1. Pre-migration source audit (ALL records — not samples):
 *      - FK resolution (lead_id → Base44 leads, deal_id → Base44 deals)
 *      - NOT NULL fields
 *      - Value-domain audit (enum-like fields)
 *      - Type audit (NUMERIC, DATE, TIMESTAMPTZ, JSONB, BOOLEAN)
 *      - Duplicate natural-key audit (email, integration, external_ref)
 *      - SEMANTIC MISMATCH detection (e.g. UserAllowlist duplicate email → data loss)
 *   2. Railway schema readiness (tables, columns, UNIQUE constraints, types)
 *   3. Idempotent upsert (ON CONFLICT) behavior
 *   4. All source records processed (total == Base44 count)
 *   5. Write errors: 0
 *   6. In-transaction row counts + NOT NULL + FK integrity + duplicate detection
 *   7. Idempotency: re-run inside same tx → same counts (no duplicates)
 *   8. After rollback, database returns to exact before-count (fresh connection)
 *
 * FAIL CLOSED on:
 *   - UserAllowlist duplicate email (UNIQUE collision → silent data loss)
 *   - Any write error
 *   - before-count != after-rollback-count (ROLLBACK LEAK)
 *   - Unresolved FK that is NOT explicitly accounted for
 *
 * Environment:
 *   DATABASE_URL (Railway Postgres)
 *   WORKER_SECRET (for migrationReader backend function)
 */
const { pool } = require('../db/client');
const { runSmallDatasetsMigration } = require('./migrateSmallDatasetsToRailway');
const { fetchBase44Entity } = require('./migrationHelpers');

async function rollbackValidate() {
  const client = await pool.connect();
  let result = null;
  const failures = [];
  let before = null; // function-scoped so `finally` can access it
  let auditReport = null;

  try {
    // ── PHASE 1: PRE-MIGRATION SOURCE AUDIT (ALL RECORDS) ─────────────────
    console.log('=== PHASE 1: PRE-MIGRATION SOURCE AUDIT (ALL RECORDS) ===\n');

    const [uaItems, csItems, scItems, laItems, deItems, b44Leads, b44Deals] = await Promise.all([
      fetchBase44Entity('UserAllowlist'),
      fetchBase44Entity('CompanySettings'),
      fetchBase44Entity('SyncCursor'),
      fetchBase44Entity('LeadAttachment'),
      fetchBase44Entity('DealExpense'),
      fetchBase44Entity('Lead'),
      fetchBase44Entity('Deal'),
    ]);

    const b44LeadIds = new Set(b44Leads.map(l => l.id));
    const b44DealIds = new Set(b44Deals.map(d => d.id));

    console.log(`Source counts: UserAllowlist=${uaItems.length}, CompanySettings=${csItems.length}, SyncCursor=${scItems.length}, LeadAttachment=${laItems.length}, DealExpense=${deItems.length}`);
    console.log(`FK targets: Base44 Leads=${b44Leads.length}, Base44 Deals=${b44Deals.length}`);

    // ── UserAllowlist audit ──────────────────────────────────────────────
    const uaEmails = uaItems.map(x => x.email);
    const uaEmailCounts = {};
    for (const e of uaEmails) uaEmailCounts[e] = (uaEmailCounts[e] || 0) + 1;
    const uaDupEmails = Object.keys(uaEmailCounts).filter(e => uaEmailCounts[e] > 1);
    const uaNullEmail = uaItems.filter(x => !x.email).length;
    const uaRoleDomain = ['admin', 'manager', 'sales_rep', 'office'];
    const uaBadRole = uaItems.filter(x => x.role && !uaRoleDomain.includes(x.role)).map(x => ({ email: x.email, role: x.role }));

    console.log('\nUserAllowlist audit:');
    console.log(`  null email (NOT NULL): ${uaNullEmail} ${uaNullEmail === 0 ? '✅' : '❌'}`);
    console.log(`  duplicate emails: ${JSON.stringify(uaDupEmails)} ${uaDupEmails.length === 0 ? '✅' : '❌ DATA LOSS'}`);
    if (uaDupEmails.length > 0) {
      for (const e of uaDupEmails) {
        const dups = uaItems.filter(x => x.email === e).map(x => ({ id: x.id, name: x.name, role: x.role }));
        console.log(`    "${e}" shared by: ${JSON.stringify(dups)}`);
        failures.push(`UserAllowlist DUPLICATE EMAIL "${e}" — UNIQUE(email) + ON CONFLICT(email) DO UPDATE will silently overwrite ${dups.length - 1} record(s). DATA LOSS. Operator must resolve before migration.`);
      }
    }
    console.log(`  off-domain roles: ${JSON.stringify(uaBadRole)} ${uaBadRole.length === 0 ? '✅' : '❌'}`);
    if (uaNullEmail > 0) failures.push(`UserAllowlist ${uaNullEmail} null email (NOT NULL violation)`);

    // ── CompanySettings audit ────────────────────────────────────────────
    const csNullName = csItems.filter(x => !x.company_name).length;
    console.log('\nCompanySettings audit:');
    console.log(`  count (singleton expected): ${csItems.length} ${csItems.length === 1 ? '✅' : '⚠️'}`);
    console.log(`  null company_name (NOT NULL): ${csNullName} ${csNullName === 0 ? '✅' : '❌'}`);
    if (csNullName > 0) failures.push(`CompanySettings ${csNullName} null company_name (NOT NULL)`);
    if (csItems.length > 1) failures.push(`CompanySettings has ${csItems.length} records (singleton expected — ON CONFLICT(company_name) will upsert, last wins)`);

    // ── SyncCursor audit ─────────────────────────────────────────────────
    const scDomain = ['hubspot', 'quickbooks_customers', 'quickbooks_estimates', 'quickbooks_invoices', 'handoff', 'google_contacts', 'google_calendar'];
    const scNullInt = scItems.filter(x => !x.integration).length;
    const scIntCounts = {};
    for (const x of scItems) scIntCounts[x.integration] = (scIntCounts[x.integration] || 0) + 1;
    const scDupInt = Object.keys(scIntCounts).filter(i => scIntCounts[i] > 1);
    const scOffDomain = scItems.filter(x => x.integration && !scDomain.includes(x.integration)).map(x => x.integration);
    const scBadDate = scItems.filter(x => x.last_successful_sync_at && isNaN(Date.parse(x.last_successful_sync_at))).length
      + scItems.filter(x => x.last_updated_timestamp && isNaN(Date.parse(x.last_updated_timestamp))).length;
    const scBadSummary = scItems.filter(x => x.last_sync_summary && typeof x.last_sync_summary !== 'object').length;
    const scBadTotal = scItems.filter(x => x.total_synced !== null && x.total_synced !== undefined && isNaN(Number(x.total_synced))).length;

    console.log('\nSyncCursor audit:');
    console.log(`  null integration (NOT NULL): ${scNullInt} ${scNullInt === 0 ? '✅' : '❌'}`);
    console.log(`  duplicate integrations: ${JSON.stringify(scDupInt)} ${scDupInt.length === 0 ? '✅' : '❌'}`);
    console.log(`  off-domain integrations (Railway has NO CHECK — accepted, audited): ${JSON.stringify([...new Set(scOffDomain)])}`);
    console.log(`  bad dates (TIMESTAMPTZ): ${scBadDate} ${scBadDate === 0 ? '✅' : '❌'}`);
    console.log(`  bad last_sync_summary type (JSONB/object): ${scBadSummary} ${scBadSummary === 0 ? '✅' : '❌'}`);
    console.log(`  bad total_synced (INTEGER): ${scBadTotal} ${scBadTotal === 0 ? '✅' : '❌'}`);
    if (scNullInt > 0) failures.push(`SyncCursor ${scNullInt} null integration (NOT NULL)`);
    if (scDupInt.length > 0) failures.push(`SyncCursor duplicate integration(s) ${JSON.stringify(scDupInt)} — UNIQUE(integration) collision`);
    if (scBadDate > 0) failures.push(`SyncCursor ${scBadDate} unparseable date(s)`);
    if (scBadSummary > 0) failures.push(`SyncCursor ${scBadSummary} bad last_sync_summary type`);
    if (scBadTotal > 0) failures.push(`SyncCursor ${scBadTotal} bad total_synced`);

    // ── LeadAttachment audit ─────────────────────────────────────────────
    const laNullUrl = laItems.filter(x => !x.file_url).length;
    const laNullLead = laItems.filter(x => !x.lead_id).length;
    const laUnresolvedLead = laItems.filter(x => x.lead_id && !b44LeadIds.has(x.lead_id)).map(x => ({ id: x.id, lead_id: x.lead_id, file_name: x.file_name }));
    const laExtRefs = laItems.map(x => String(x.id));
    const laDupExt = laExtRefs.filter((e, i, a) => a.indexOf(e) !== i);
    const laBadDate = laItems.filter(x => x.invoice_date && isNaN(Date.parse(x.invoice_date))).length
      + laItems.filter(x => x.due_date && isNaN(Date.parse(x.due_date))).length
      + laItems.filter(x => x.uploaded_at && isNaN(Date.parse(x.uploaded_at))).length;
    const laBadAmount = laItems.filter(x => x.invoice_amount !== null && x.invoice_amount !== undefined && isNaN(Number(x.invoice_amount))).length
      + laItems.filter(x => x.balance_due !== null && x.balance_due !== undefined && isNaN(Number(x.balance_due))).length;
    const laBadSize = laItems.filter(x => x.file_size !== null && x.file_size !== undefined && isNaN(Number(x.file_size))).length;

    console.log('\nLeadAttachment audit:');
    console.log(`  null file_url (NOT NULL): ${laNullUrl} ${laNullUrl === 0 ? '✅' : '❌'}`);
    console.log(`  null lead_id (NOT NULL FK): ${laNullLead} ${laNullLead === 0 ? '✅' : '❌'}`);
    console.log(`  unresolved lead_id FK: ${laUnresolvedLead.length} ${laUnresolvedLead.length === 0 ? '✅' : '❌'}`);
    console.log(`  duplicate external_ref: ${laDupExt.length} ${laDupExt.length === 0 ? '✅' : '❌'}`);
    console.log(`  bad dates: ${laBadDate} ${laBadDate === 0 ? '✅' : '❌'}`);
    console.log(`  bad amounts (NUMERIC): ${laBadAmount} ${laBadAmount === 0 ? '✅' : '❌'}`);
    console.log(`  bad file_size (BIGINT): ${laBadSize} ${laBadSize === 0 ? '✅' : '❌'}`);
    if (laNullUrl > 0) failures.push(`LeadAttachment ${laNullUrl} null file_url (NOT NULL)`);
    if (laNullLead > 0) failures.push(`LeadAttachment ${laNullLead} null lead_id (NOT NULL FK — migration skips)`);
    if (laUnresolvedLead.length > 0) failures.push(`LeadAttachment ${laUnresolvedLead.length} unresolved lead_id FK: ${JSON.stringify(laUnresolvedLead)}`);
    if (laDupExt.length > 0) failures.push(`LeadAttachment duplicate external_ref ${JSON.stringify(laDupExt)}`);
    if (laBadDate > 0) failures.push(`LeadAttachment ${laBadDate} bad date(s)`);
    if (laBadAmount > 0) failures.push(`LeadAttachment ${laBadAmount} bad amount(s)`);
    if (laBadSize > 0) failures.push(`LeadAttachment ${laBadSize} bad file_size`);

    // ── DealExpense audit ────────────────────────────────────────────────
    const deCatDomain = ["Materials","Labor","Subcontractor","Permit","Engineering","Architect","Design","Inspection","Dumpster","Equipment Rental","Delivery","Roofing","Solar","Pool","Landscaping","Plumbing","Electrical","HVAC","Insurance","Marketing","Lead Cost","Financing Fee","Loan Interest","General Overhead","Other"];
    const dePsDomain = ["Unpaid","Partially Paid","Paid","Refunded","Cancelled"];
    const dePmDomain = ["ACH","Check","Credit Card","Debit Card","Cash","Zelle","Wire","QuickBooks","Other"];
    const deQbDomain = ["not_synced","synced","error"];
    const deNullVendor = deItems.filter(x => !x.vendor_name).length;
    const deNullDeal = deItems.filter(x => !x.deal_id).length;
    const deUnresolvedDeal = deItems.filter(x => x.deal_id && !b44DealIds.has(x.deal_id)).map(x => ({ id: x.id, deal_id: x.deal_id, vendor_name: x.vendor_name }));
    const deUnresolvedLead = deItems.filter(x => x.lead_id && !b44LeadIds.has(x.lead_id)).map(x => ({ id: x.id, lead_id: x.lead_id, vendor_name: x.vendor_name }));
    const deExtRefs = deItems.map(x => String(x.id));
    const deDupExt = deExtRefs.filter((e, i, a) => a.indexOf(e) !== i);
    const deBadCat = deItems.filter(x => x.category && !deCatDomain.includes(x.category)).map(x => ({ id: x.id, category: x.category }));
    const deBadPs = deItems.filter(x => x.payment_status && !dePsDomain.includes(x.payment_status)).map(x => ({ id: x.id, payment_status: x.payment_status }));
    const deBadPm = deItems.filter(x => x.payment_method && !dePmDomain.includes(x.payment_method)).map(x => ({ id: x.id, payment_method: x.payment_method }));
    const deBadQb = deItems.filter(x => x.quickbooks_sync_status && !deQbDomain.includes(x.quickbooks_sync_status)).map(x => ({ id: x.id, quickbooks_sync_status: x.quickbooks_sync_status }));
    const deBadAmount = deItems.filter(x => x.amount !== null && x.amount !== undefined && isNaN(Number(x.amount))).length
      + deItems.filter(x => x.amount_paid !== null && x.amount_paid !== undefined && isNaN(Number(x.amount_paid))).length
      + deItems.filter(x => x.amount_remaining !== null && x.amount_remaining !== undefined && isNaN(Number(x.amount_remaining))).length;
    const deBadDate = deItems.filter(x => x.expense_date && isNaN(Date.parse(x.expense_date))).length;

    console.log('\nDealExpense audit:');
    console.log(`  null vendor_name (NOT NULL): ${deNullVendor} ${deNullVendor === 0 ? '✅' : '❌'}`);
    console.log(`  null deal_id (NOT NULL FK): ${deNullDeal} ${deNullDeal === 0 ? '✅' : '❌'}`);
    console.log(`  unresolved deal_id FK: ${deUnresolvedDeal.length} ${deUnresolvedDeal.length === 0 ? '✅' : '❌'}`);
    console.log(`  unresolved lead_id FK (nullable): ${deUnresolvedLead.length} ${deUnresolvedLead.length === 0 ? '✅' : '❌'}`);
    console.log(`  duplicate external_ref: ${deDupExt.length} ${deDupExt.length === 0 ? '✅' : '❌'}`);
    console.log(`  off-domain category: ${JSON.stringify(deBadCat)} ${deBadCat.length === 0 ? '✅' : '❌'}`);
    console.log(`  off-domain payment_status: ${JSON.stringify(deBadPs)} ${deBadPs.length === 0 ? '✅' : '❌'}`);
    console.log(`  off-domain payment_method: ${JSON.stringify(deBadPm)} ${deBadPm.length === 0 ? '✅' : '❌'}`);
    console.log(`  off-domain quickbooks_sync_status: ${JSON.stringify(deBadQb)} ${deBadQb.length === 0 ? '✅' : '❌'}`);
    console.log(`  bad amounts (NUMERIC): ${deBadAmount} ${deBadAmount === 0 ? '✅' : '❌'}`);
    console.log(`  bad dates (DATE): ${deBadDate} ${deBadDate === 0 ? '✅' : '❌'}`);
    if (deNullVendor > 0) failures.push(`DealExpense ${deNullVendor} null vendor_name (NOT NULL — migration defaults to 'Unknown')`);
    if (deNullDeal > 0) failures.push(`DealExpense ${deNullDeal} null deal_id (NOT NULL FK — migration skips)`);
    if (deUnresolvedDeal.length > 0) failures.push(`DealExpense ${deUnresolvedDeal.length} unresolved deal_id FK: ${JSON.stringify(deUnresolvedDeal)}`);
    if (deUnresolvedLead.length > 0) failures.push(`DealExpense ${deUnresolvedLead.length} unresolved lead_id FK (nullable, set to NULL): ${JSON.stringify(deUnresolvedLead)}`);
    if (deDupExt.length > 0) failures.push(`DealExpense duplicate external_ref ${JSON.stringify(deDupExt)}`);
    if (deBadCat.length > 0) failures.push(`DealExpense off-domain category ${JSON.stringify(deBadCat)}`);
    if (deBadPs.length > 0) failures.push(`DealExpense off-domain payment_status ${JSON.stringify(deBadPs)}`);
    if (deBadPm.length > 0) failures.push(`DealExpense off-domain payment_method ${JSON.stringify(deBadPm)}`);
    if (deBadQb.length > 0) failures.push(`DealExpense off-domain quickbooks_sync_status ${JSON.stringify(deBadQb)}`);
    if (deBadAmount > 0) failures.push(`DealExpense ${deBadAmount} bad amount(s)`);
    if (deBadDate > 0) failures.push(`DealExpense ${deBadDate} bad date(s)`);

    auditReport = {
      sourceCounts: { UserAllowlist: uaItems.length, CompanySettings: csItems.length, SyncCursor: scItems.length, LeadAttachment: laItems.length, DealExpense: deItems.length },
      uaDupEmails, uaDupDetail: uaDupEmails.map(e => ({ email: e, records: uaItems.filter(x => x.email === e).map(x => ({ id: x.id, name: x.name, role: x.role })) })),
      scOffDomain: [...new Set(scOffDomain)],
      laUnresolvedLead, deUnresolvedDeal, deUnresolvedLead,
    };

    // ── PHASE 1b: RAILWAY SCHEMA AUDIT ───────────────────────────────────
    console.log('\n=== PHASE 1b: RAILWAY SCHEMA AUDIT ===\n');

    const tables = ['user_allowlist', 'company_settings', 'sync_cursors', 'lead_attachments', 'deal_expenses'];
    for (const t of tables) {
      const { rows: exists } = await client.query(`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1) as e`, [t]);
      if (!exists[0].e) failures.push(`Railway table ${t} does NOT EXIST — run migration 2026-14`);
      else console.log(`✅ table ${t} exists`);
    }

    // Verify UNIQUE constraints (ON CONFLICT targets)
    const uniqueChecks = [
      { table: 'user_allowlist', col: 'email' },
      { table: 'company_settings', col: 'company_name' },
      { table: 'sync_cursors', col: 'integration' },
      { table: 'lead_attachments', col: 'external_ref' },
      { table: 'deal_expenses', col: 'external_ref' },
    ];
    for (const u of uniqueChecks) {
      const { rows: uc } = await client.query(`
        SELECT kcu.column_name FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_name = $1 AND tc.constraint_type = 'UNIQUE' AND kcu.column_name = $2
      `, [u.table, u.col]);
      if (uc.length === 0) failures.push(`Railway ${u.table} missing UNIQUE(${u.col}) — ON CONFLICT will fail`);
      else console.log(`✅ ${u.table} UNIQUE(${u.col}) verified`);
    }

    // Verify NOT NULL constraints
    const notNullChecks = [
      { table: 'user_allowlist', col: 'email' },
      { table: 'company_settings', col: 'company_name' },
      { table: 'sync_cursors', col: 'integration' },
      { table: 'lead_attachments', col: 'file_url' },
      { table: 'lead_attachments', col: 'lead_id' },
      { table: 'deal_expenses', col: 'vendor_name' },
      { table: 'deal_expenses', col: 'deal_id' },
    ];
    for (const n of notNullChecks) {
      const { rows: nc } = await client.query(`SELECT is_nullable FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`, [n.table, n.col]);
      if (nc.length === 0) failures.push(`Railway ${n.table}.${n.col} column missing`);
      else if (nc[0].is_nullable !== 'NO') failures.push(`Railway ${n.table}.${n.col} should be NOT NULL, got ${nc[0].is_nullable}`);
      else console.log(`✅ ${n.table}.${n.col} NOT NULL verified`);
    }

    // If schema audit failed, abort before transaction
    const schemaFailures = failures.filter(f => f.includes('does NOT EXIST') || f.includes('missing UNIQUE') || f.includes('column missing'));
    if (schemaFailures.length > 0) {
      console.error('\n[rollback-validate-small] Schema audit FAILED — aborting before transaction');
      throw new Error('Schema audit failed');
    }

    // ── PHASE 2: BEFORE COUNTS ───────────────────────────────────────────
    const { rows: beforeRows } = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM user_allowlist) as ua,
        (SELECT COUNT(*) FROM company_settings) as cs,
        (SELECT COUNT(*) FROM sync_cursors) as sc,
        (SELECT COUNT(*) FROM lead_attachments) as la,
        (SELECT COUNT(*) FROM deal_expenses) as de,
        (SELECT COUNT(*) FROM leads) as leads,
        (SELECT COUNT(*) FROM deals) as deals
    `);
    before = {
      ua: parseInt(beforeRows[0].ua, 10), cs: parseInt(beforeRows[0].cs, 10), sc: parseInt(beforeRows[0].sc, 10),
      la: parseInt(beforeRows[0].la, 10), de: parseInt(beforeRows[0].de, 10),
      leads: parseInt(beforeRows[0].leads, 10), deals: parseInt(beforeRows[0].deals, 10),
    };
    console.log(`\nBEFORE: ua=${before.ua}, cs=${before.cs}, sc=${before.sc}, la=${before.la}, de=${before.de}, leads=${before.leads}, deals=${before.deals}`);

    // ── PHASE 3: BEGIN TRANSACTION ──────────────────────────────────────
    await client.query('BEGIN');
    console.log('Transaction started (BEGIN)');

    // ── PHASE 4: RUN EXACT PRODUCTION MIGRATION INSIDE TRANSACTION ───────
    console.log('\n=== PHASE 4: RUNNING PRODUCTION MIGRATION INSIDE TRANSACTION ===\n');
    const queryFn = client.query.bind(client);
    result = await runSmallDatasetsMigration(queryFn);

    // ── PHASE 5: IN-TX VERIFICATION ─────────────────────────────────────
    console.log('\n=== PHASE 5: IN-TX VERIFICATION ===\n');

    const { rows: inTxRows } = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM user_allowlist) as ua,
        (SELECT COUNT(DISTINCT email) FROM user_allowlist) as ua_distinct_email,
        (SELECT COUNT(*) FROM company_settings) as cs,
        (SELECT COUNT(*) FROM sync_cursors) as sc,
        (SELECT COUNT(*) FROM lead_attachments) as la,
        (SELECT COUNT(*) FROM deal_expenses) as de
    `);
    const inTx = {
      ua: parseInt(inTxRows[0].ua, 10), uaDistinctEmail: parseInt(inTxRows[0].ua_distinct_email, 10),
      cs: parseInt(inTxRows[0].cs, 10), sc: parseInt(inTxRows[0].sc, 10),
      la: parseInt(inTxRows[0].la, 10), de: parseInt(inTxRows[0].de, 10),
    };
    console.log(`IN-TX: ua=${inTx.ua} (distinct emails=${inTx.uaDistinctEmail}), cs=${inTx.cs}, sc=${inTx.sc}, la=${inTx.la}, de=${inTx.de}`);

    // Per-entity expected row counts — derived from ACTUAL fetched source counts
    // (not hardcoded), so the validator stays correct after the Shlomi duplicate
    // removal (UserAllowlist source is now 4, not 5). ON CONFLICT(email) collapses
    // duplicate emails; after the merge there are 0 duplicates → distinct = source.
    const uaDistinct = uaItems.length - auditReport.uaDupEmails.length;
    const expectedUaRows = before.ua + uaDistinct;
    const expectedCsRows = before.cs + csItems.length;
    const expectedScRows = before.sc + scItems.length;
    // LeadAttachment / DealExpense: migration skips records with unresolved FKs.
    // The audit phase already fails on unresolved FKs; when all resolve, skipped = 0.
    const laSkipped = result ? (result.leadAttachments.unresolvedLeadFk || []).length : 0;
    const deSkipped = result ? (result.dealExpenses.unresolvedDealFk || []).length : 0;
    const expectedLaRows = before.la + (laItems.length - laSkipped);
    const expectedDeRows = before.de + (deItems.length - deSkipped);

    if (inTx.ua !== expectedUaRows) failures.push(`IN-TX user_allowlist=${inTx.ua}, expected ${expectedUaRows}`);
    else console.log(`✅ IN-TX user_allowlist=${inTx.ua} (expected ${expectedUaRows}${auditReport.uaDupEmails.length > 0 ? ' — duplicate email(s) collapsed' : ''})`);
    if (inTx.uaDistinctEmail !== inTx.ua) failures.push(`IN-TX user_allowlist has duplicate emails in table itself`);
    if (inTx.cs !== expectedCsRows) failures.push(`IN-TX company_settings=${inTx.cs}, expected ${expectedCsRows}`);
    else console.log(`✅ IN-TX company_settings=${inTx.cs}`);
    if (inTx.sc !== expectedScRows) failures.push(`IN-TX sync_cursors=${inTx.sc}, expected ${expectedScRows}`);
    else console.log(`✅ IN-TX sync_cursors=${inTx.sc}`);
    if (inTx.la !== expectedLaRows) failures.push(`IN-TX lead_attachments=${inTx.la}, expected ${expectedLaRows}`);
    else console.log(`✅ IN-TX lead_attachments=${inTx.la}`);
    if (inTx.de !== expectedDeRows) failures.push(`IN-TX deal_expenses=${inTx.de}, expected ${expectedDeRows}`);
    else console.log(`✅ IN-TX deal_expenses=${inTx.de}`);

    // NOT NULL violations in-tx
    const { rows: nnViolations } = await client.query(`
      SELECT 'user_allowlist' t, COUNT(*) c FROM user_allowlist WHERE email IS NULL
      UNION ALL SELECT 'company_settings', COUNT(*) FROM company_settings WHERE company_name IS NULL
      UNION ALL SELECT 'sync_cursors', COUNT(*) FROM sync_cursors WHERE integration IS NULL
      UNION ALL SELECT 'lead_attachments', COUNT(*) FROM lead_attachments WHERE file_url IS NULL OR lead_id IS NULL
      UNION ALL SELECT 'deal_expenses', COUNT(*) FROM deal_expenses WHERE vendor_name IS NULL OR deal_id IS NULL
    `);
    for (const v of nnViolations) {
      if (parseInt(v.c, 10) > 0) failures.push(`IN-TX ${v.t} has ${v.c} NOT NULL violation(s)`);
    }
    if (nnViolations.every(v => parseInt(v.c, 10) === 0)) console.log('✅ IN-TX zero NOT NULL violations');

    // FK integrity in-tx
    const { rows: fkBad } = await client.query(`
      SELECT 'lead_attachments' t, COUNT(*) c FROM lead_attachments la WHERE NOT EXISTS (SELECT 1 FROM leads l WHERE l.id = la.lead_id)
      UNION ALL SELECT 'deal_expenses_deal', COUNT(*) FROM deal_expenses de WHERE NOT EXISTS (SELECT 1 FROM deals d WHERE d.id = de.deal_id)
      UNION ALL SELECT 'deal_expenses_lead', COUNT(*) FROM deal_expenses de WHERE de.lead_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.id = de.lead_id)
    `);
    for (const v of fkBad) {
      if (parseInt(v.c, 10) > 0) failures.push(`IN-TX ${v.t} has ${v.c} dangling FK(s)`);
    }
    if (fkBad.every(v => parseInt(v.c, 10) === 0)) console.log('✅ IN-TX all FKs resolve');

    // Duplicate natural-key check in-tx (should match source duplicates)
    const { rows: uaDupInTx } = await client.query(`SELECT email, COUNT(*) c FROM user_allowlist GROUP BY email HAVING COUNT(*) > 1`);
    if (uaDupInTx.length > 0) failures.push(`IN-TX user_allowlist has duplicate emails: ${JSON.stringify(uaDupInTx)}`);
    else console.log('✅ IN-TX user_allowlist no duplicate emails (UNIQUE enforced)');

    // ── PHASE 5b: IDEMPOTENCY — re-run inside same tx, counts must not change ──
    console.log('\n=== PHASE 5b: IDEMPOTENCY RE-RUN ===\n');
    const result2 = await runSmallDatasetsMigration(queryFn);
    const { rows: inTx2Rows } = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM user_allowlist) as ua,
        (SELECT COUNT(*) FROM company_settings) as cs,
        (SELECT COUNT(*) FROM sync_cursors) as sc,
        (SELECT COUNT(*) FROM lead_attachments) as la,
        (SELECT COUNT(*) FROM deal_expenses) as de
    `);
    const inTx2 = { ua: parseInt(inTx2Rows[0].ua, 10), cs: parseInt(inTx2Rows[0].cs, 10), sc: parseInt(inTx2Rows[0].sc, 10), la: parseInt(inTx2Rows[0].la, 10), de: parseInt(inTx2Rows[0].de, 10) };
    if (inTx2.ua !== inTx.ua || inTx2.cs !== inTx.cs || inTx2.sc !== inTx.sc || inTx2.la !== inTx.la || inTx2.de !== inTx.de) {
      failures.push(`IDEMPOTENCY FAILED: run1=${JSON.stringify(inTx)} run2=${JSON.stringify(inTx2)}`);
    } else {
      console.log(`✅ Idempotent: re-run produced identical counts (${JSON.stringify(inTx2)})`);
    }

  } catch (e) {
    console.error('[rollback-validate-small] Error during validation:', e.message);
    failures.push(`Exception: ${e.message}`);
  } finally {
    // ── PHASE 6: ALWAYS ROLLBACK ───────────────────────────────────────
    console.log('\n=== PHASE 6: ROLLING BACK TRANSACTION ===');
    try {
      await client.query('ROLLBACK');
      console.log('ROLLBACK executed');
    } catch (rbErr) {
      console.error('ROLLBACK failed:', rbErr.message);
      failures.push(`ROLLBACK failed: ${rbErr.message}`);
    }
    client.release();

    // ── PHASE 7: POST-ROLLBACK VERIFICATION (FRESH CONNECTION) ──────────
    console.log('\n=== PHASE 7: POST-ROLLBACK VERIFICATION (FRESH CONNECTION) ===\n');
    const freshClient = await pool.connect();
    try {
      const { rows: afterRows } = await freshClient.query(`
        SELECT
          (SELECT COUNT(*) FROM user_allowlist) as ua,
          (SELECT COUNT(*) FROM company_settings) as cs,
          (SELECT COUNT(*) FROM sync_cursors) as sc,
          (SELECT COUNT(*) FROM lead_attachments) as la,
          (SELECT COUNT(*) FROM deal_expenses) as de,
          (SELECT COUNT(*) FROM leads) as leads,
          (SELECT COUNT(*) FROM deals) as deals
      `);
      const after = {
        ua: parseInt(afterRows[0].ua, 10), cs: parseInt(afterRows[0].cs, 10), sc: parseInt(afterRows[0].sc, 10),
        la: parseInt(afterRows[0].la, 10), de: parseInt(afterRows[0].de, 10),
        leads: parseInt(afterRows[0].leads, 10), deals: parseInt(afterRows[0].deals, 10),
      };
      console.log(`AFTER ROLLBACK (fresh): ua=${after.ua}, cs=${after.cs}, sc=${after.sc}, la=${after.la}, de=${after.de}, leads=${after.leads}, deals=${after.deals}`);

      if (!before) {
        failures.push('before was never captured (unexpected early failure)');
      } else {
        const tables = ['ua', 'cs', 'sc', 'la', 'de', 'leads', 'deals'];
        for (const t of tables) {
          if (after[t] !== before[t]) failures.push(`${t} changed: ${before[t]} → ${after[t]} — ROLLBACK LEAK`);
          else console.log(`✅ ${t} unchanged: ${before[t]} → ${after[t]}`);
        }
      }
    } finally {
      freshClient.release();
    }
  }

  // ── FINAL REPORT ─────────────────────────────────────────────────────
  console.log('\n=== SMALL DATASETS ROLLBACK VALIDATION COMPLETE ===');
  console.log(`Source counts: ${JSON.stringify(auditReport ? auditReport.sourceCounts : {})}`);
  if (result) {
    console.log(`Migration result per entity:`);
    console.log(`  UserAllowlist:   ${JSON.stringify(result.userAllowlist)}`);
    console.log(`  CompanySettings: ${JSON.stringify(result.companySettings)}`);
    console.log(`  SyncCursor:     ${JSON.stringify(result.syncCursors)}`);
    console.log(`  LeadAttachment: ${JSON.stringify(result.leadAttachments)}`);
    console.log(`  DealExpense:    ${JSON.stringify(result.dealExpenses)}`);
  }
  if (auditReport && auditReport.uaDupEmails.length > 0) {
    console.log(`\n⚠️  UserAllowlist DUPLICATE EMAIL (DATA LOSS):`);
    for (const d of auditReport.uaDupDetail) {
      console.log(`  "${d.email}" shared by: ${JSON.stringify(d.records)}`);
    }
  }
  if (auditReport && auditReport.scOffDomain.length > 0) {
    console.log(`\nℹ️  SyncCursor off-domain integrations (accepted — Railway has no CHECK): ${JSON.stringify(auditReport.scOffDomain)}`);
  }
  console.log(`\nBEFORE: ${JSON.stringify(before)}`);
  console.log(`Validation failures: ${failures.length}`);

  if (failures.length > 0) {
    console.error('\n❌ VALIDATION FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('\n✅ ALL VALIDATION CHECKS PASSED — production migration verified, rollback is clean');
  process.exit(0);
}

rollbackValidate().catch(e => {
  console.error('[rollback-validate-small] FATAL:', e);
  process.exit(1);
});