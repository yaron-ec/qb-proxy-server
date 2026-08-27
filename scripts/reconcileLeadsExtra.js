/* eslint-disable no-undef */
'use strict';
/**
 * reconcileLeadsExtra.js — READ-ONLY reconciliation: identifies Railway leads
 * that have NO Base44 counterpart (the +1 diff between Base44 1067 and Railway 1068).
 *
 * For each Railway-only lead, reports:
 *   - identity (Railway id, external_ref, name, email, phone, status, owner, created_at)
 *   - whether it matches a Base44 lead by normalized email / phone / full name
 *   - dependency counts across all migrated/dependent Railway tables
 *
 * Confirms the 1067 Base44 leads map 1:1 to 1067 Railway records (by external_ref)
 * with zero missing and zero duplicate source mappings.
 *
 * READ-ONLY: executes SELECT queries only. No writes, no transactions, no deletes.
 *
 * Environment: DATABASE_URL, BASE44_APP_ID, BASE44_API_KEY (via migrationHelpers).
 */
const { pool } = require('../db/client');
const { fetchBase44Entity } = require('./migrationHelpers');

// Dependency tables that reference leads.id (lead_id FK column).
// Each is queried with a parameterized SELECT COUNT(*).
const DEP_TABLES = [
  { table: 'appointments', col: 'lead_id' },
  { table: 'activities', col: 'lead_id' },
  { table: 'deals', col: 'lead_id' },
  { table: 'tasks', col: 'lead_id' },
  { table: 'estimates', col: 'lead_id' },
  { table: 'invoices', col: 'lead_id' },
  { table: 'lead_attachments', col: 'lead_id' },
  { table: 'deal_expenses', col: 'lead_id' },
  { table: 'lead_submissions', col: 'lead_id' },
  { table: 'handoff_estimates', col: 'lead_id' },
];

function normEmail(e) { return e ? String(e).toLowerCase().trim() : ''; }
function normPhone(p) { return p ? String(p).replace(/\D/g, '') : ''; }
function normName(fn, ln) { return ((fn || '') + ' ' + (ln || '')).trim().toLowerCase(); }

async function reconcile() {
  console.log('=== LEADS EXTRA-RECORD RECONCILIATION (READ-ONLY) ===');
  console.log('Started: ' + new Date().toISOString() + '\n');

  // ── 1. Fetch all Base44 leads ──────────────────────────────────────────
  const b44Leads = await fetchBase44Entity('Lead');
  const b44ById = {};
  for (const l of b44Leads) b44ById[String(l.id)] = l;
  console.log('Base44 leads fetched: ' + b44Leads.length);

  // ── 2. Fetch all Railway leads ─────────────────────────────────────────
  const { rows: railLeads } = await pool.query(
    'SELECT l.id, l.external_ref, l.first_name, l.last_name, l.email, l.phone, ' +
    'l.status, l.owner_id, o.display_name AS owner_name, l.created_at, l.updated_at ' +
    'FROM leads l LEFT JOIN owners o ON o.id = l.owner_id ORDER BY l.created_at DESC'
  );
  console.log('Railway leads fetched: ' + railLeads.length + '\n');

  // ── 3. Classify ────────────────────────────────────────────────────────
  const railByExt = {};
  for (const r of railLeads) {
    if (r.external_ref) railByExt[String(r.external_ref)] = r;
  }

  const matched = [];
  const base44Only = [];
  const railwayOnly = [];

  for (const b of b44Leads) {
    if (railByExt[String(b.id)]) matched.push(b);
    else base44Only.push(b);
  }
  for (const r of railLeads) {
    if (!r.external_ref || !b44ById[String(r.external_ref)]) railwayOnly.push(r);
  }

  // Duplicate external_ref check in Railway
  const extRefs = railLeads.map(r => r.external_ref).filter(Boolean);
  const extCounts = {};
  for (const e of extRefs) extCounts[e] = (extCounts[e] || 0) + 1;
  const dupExt = Object.keys(extCounts).filter(e => extCounts[e] > 1);

  console.log('=== CLASSIFICATION ===');
  console.log('Matched (external_ref in Base44):  ' + matched.length);
  console.log('Base44-only (not in Railway):     ' + base44Only.length);
  console.log('Railway-only (no Base44 match):   ' + railwayOnly.length);
  console.log('Duplicate external_refs in Railway: ' + dupExt.length);
  console.log('');

  // ── 4. 1:1 mapping confirmation ────────────────────────────────────────
  const oneToOne = base44Only.length === 0 && dupExt.length === 0 && matched.length === b44Leads.length;
  console.log('=== 1:1 MAPPING CONFIRMATION ===');
  console.log('Base44 → Railway matched: ' + matched.length + ' / ' + b44Leads.length);
  console.log('Missing in Railway (Base44-only): ' + base44Only.length);
  console.log('Duplicate source mappings (dup external_ref): ' + dupExt.length);
  console.log('1:1 mapping: ' + (oneToOne ? 'CONFIRMED ✅' : 'CHECK NEEDED ❌'));
  console.log('');

  // ── 5. For each Railway-only lead: identity + Base44 match + dependencies ──
  console.log('=== RAILWAY-ONLY LEADS DETAIL ===');
  for (const extra of railwayOnly) {
    const email = normEmail(extra.email);
    const phone = normPhone(extra.phone);
    const fullName = normName(extra.first_name, extra.last_name);

    let b44ByEmail = null, b44ByPhone = null, b44ByName = null;
    for (const b of b44Leads) {
      if (email && normEmail(b.email) === email) b44ByEmail = b44ByEmail || b;
      if (phone && normPhone(b.phone) === phone && phone.length >= 10) b44ByPhone = b44ByPhone || b;
      if (fullName && normName(b.first_name, b.last_name) === fullName && fullName.length >= 3) b44ByName = b44ByName || b;
    }

    const deps = {};
    for (const d of DEP_TABLES) {
      try {
        const { rows } = await pool.query(
          'SELECT COUNT(*)::int AS c FROM ' + d.table + ' WHERE ' + d.col + ' = $1',
          [extra.id]
        );
        deps[d.table] = rows[0].c;
      } catch (e) {
        deps[d.table] = 'TABLE/MISSING (' + e.message.slice(0, 60) + ')';
      }
    }

    const totalDeps = Object.values(deps).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);

    console.log('');
    console.log('--- Railway ID: ' + extra.id);
    console.log('  external_ref:     ' + (extra.external_ref || 'NULL'));
    console.log('  name:             ' + ((extra.first_name || '') + ' ' + (extra.last_name || '')).trim());
    console.log('  email:            ' + (extra.email || 'NULL'));
    console.log('  phone:            ' + (extra.phone || 'NULL'));
    console.log('  status:           ' + (extra.status || 'NULL'));
    console.log('  owner_name:       ' + (extra.owner_name || 'NULL'));
    console.log('  owner_id:         ' + (extra.owner_id || 'NULL'));
    console.log('  created_at:       ' + (extra.created_at || 'NULL'));
    console.log('  Base44 match by email: ' + (b44ByEmail ? b44ByEmail.id + ' (' + (b44ByEmail.first_name||'') + ' ' + (b44ByEmail.last_name||'') + ')' : 'NONE'));
    console.log('  Base44 match by phone: ' + (b44ByPhone ? b44ByPhone.id + ' (' + (b44ByPhone.first_name||'') + ' ' + (b44ByPhone.last_name||'') + ')' : 'NONE'));
    console.log('  Base44 match by name:  ' + (b44ByName ? b44ByName.id + ' (' + (b44ByName.first_name||'') + ' ' + (b44ByName.last_name||'') + ')' : 'NONE'));
    console.log('  Dependencies (total=' + totalDeps + '):');
    for (const t of DEP_TABLES) {
      console.log('    ' + t.table + ': ' + deps[t.table]);
    }
  }

  // ── 6. Disposition classification ───────────────────────────────────────
  console.log('\n=== DISPOSITION CLASSIFICATION ===');
  for (const extra of railwayOnly) {
    const hasExt = !!extra.external_ref;
    const totalDeps = Object.values(extra._deps || {}).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
    let classification;
    if (hasExt) {
      classification = 'ORPHAN (external_ref set but no Base44 record found — stale/deleted Base44 source)';
    } else if (totalDeps > 0) {
      classification = 'RAILWAY-NATIVE WITH DEPENDENCIES (created directly in Railway, has child records)';
    } else {
      classification = 'RAILWAY-NATIVE ORPHAN (created directly in Railway, no child records)';
    }
    console.log('  ' + extra.id + ' → ' + classification);
  }

  console.log('\n=== RECONCILIATION COMPLETE (READ-ONLY, NO WRITES) ===');
}

async function main() {
  await reconcile();
  await pool.end();
  process.exit(0);
}

module.exports = { reconcile, DEP_TABLES };

if (require.main === module) {
  main().catch(e => { console.error('FATAL:', e); process.exit(1); });
}