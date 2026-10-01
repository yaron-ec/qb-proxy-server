/* eslint-disable no-undef */
'use strict';
/**
 * Schema-drift guard for the leads table — EVERY backend writer.
 *
 * Phase 0 (Growth Engine) found production code writing leads columns that no
 * migration ever created: the SignNow "Sold" update (signed_contract_date,
 * signed_contract_document_id, sold_date, sold_by_source), the duplicate merge
 * (duplicate_merged, last_merge_date, merge_count), the QuickBooks sync error
 * status (qb_last_error), and Base44-era Handoff/QB writes through the generic
 * data-access helper (handoff_estimate_status, appointment_date,
 * handoff_project_id, handoff_project_number). Postgres rejects the whole
 * statement, every one of those writes was wrapped in a swallowed catch, so the
 * features silently never worked.
 *
 * Schema = CREATE TABLE leads (db/schema.sql + migrations) + every
 * ALTER TABLE leads ADD COLUMN + runtime ensureColumns('leads', …).
 *
 * Writers checked (all backend JS outside test/ and crm-frontend/):
 *   1. literal SQL:   UPDATE leads SET col = …  /  INSERT INTO leads (col, …)
 *   2. dynamic SQL:   `UPDATE leads SET ${…}` / `INSERT INTO leads (${…})` —
 *      every such site must be listed in DYNAMIC_SITES (reviewed), and the
 *      columns its builder can emit (push('col = …'), the field-list constants
 *      it iterates, inline [...] column lists, allFields.x = …) must all exist;
 *   3. generic entity writers: <anything>.update('Lead', …) / .create('Lead', …)
 *      (lib/railwayDataAccess) — object-literal keys, or the keys assigned to
 *      the variable passed, must exist; an unanalyzable payload fails.
 * There are NO allow-listed exceptions: any write to a column that does not
 * exist fails this test.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// Every reviewed dynamic leads-SQL site (file → number of sites). A new site
// fails until it is reviewed here and its column sources are covered below.
const DYNAMIC_SITES = {
  'routes/leads.js': 4, // by-external PUT (UPDATE + upsert INSERT), follow-up/stage PUT, PUT /:id
  'routes/routing.js': 1, // address reconciliation
  'routes/routingDiagnostic.js': 1, // address reconciliation
  'lib/marketing/attributionStore.js': 2, // touch pointers (inquiry + merge)
};
// Field-list constants that feed dynamic leads SQL.
const FIELD_LIST_CONSTANTS = ['UPDATABLE_FIELDS', 'CONTACT_FIELDS', 'CRM_FIELDS', 'FOLLOW_UP_FIELDS', 'ADDRESS_COLS'];

const backendFiles = () => execSync('git ls-files "*.js"', { cwd: ROOT }).toString().split('\n')
  .filter((f) => f && !f.startsWith('test/') && !f.startsWith('crm-frontend/') && !f.includes('node_modules') && fs.existsSync(path.join(ROOT, f)));
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const IDENT = /^[a-z_][a-z0-9_]*$/;

function schemaColumns() {
  const cols = new Set();
  const sqlFiles = [path.join(ROOT, 'db/schema.sql'), ...fs.readdirSync(path.join(ROOT, 'db/migrations')).map((f) => path.join(ROOT, 'db/migrations', f))];
  for (const f of sqlFiles) {
    const s = fs.readFileSync(f, 'utf8');
    for (const m of s.matchAll(/CREATE TABLE IF NOT EXISTS leads\s*\(([\s\S]*?)\n\s*\);/g)) {
      for (const line of m[1].split('\n')) {
        const c = (line.trim().match(/^([a-z_][a-z0-9_]*)\s+[A-Z]/) || [])[1];
        if (c && !['constraint', 'primary', 'unique', 'check'].includes(c)) cols.add(c);
      }
    }
    for (const m of s.matchAll(/ALTER TABLE leads ADD COLUMN(?: IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/gi)) cols.add(m[1]);
  }
  for (const f of backendFiles()) {
    for (const m of read(f).matchAll(/ensureColumns\(\s*'leads'\s*,\s*\[([\s\S]*?)\]\s*\)/g)) {
      for (const c of m[1].matchAll(/\[\s*'([a-z_][a-z0-9_]*)'/g)) cols.add(c[1]);
    }
  }
  return cols;
}

function literalWrites() {
  const out = [];
  for (const f of backendFiles()) {
    const s = read(f);
    for (const m of s.matchAll(/UPDATE\s+leads\s+SET\s+([\s\S]*?)\s+WHERE/gi)) {
      if (m[1].trimStart().startsWith('${')) continue; // dynamic — checked separately
      for (const part of m[1].split(/,(?![^(]*\))/)) {
        const c = (part.trim().match(/^([a-z_][a-z0-9_]*)\s*=/) || [])[1];
        if (c) out.push({ file: f, col: c, via: 'UPDATE' });
      }
    }
    for (const m of s.matchAll(/INSERT\s+INTO\s+leads\s*\(([^)]*)\)/gi)) {
      for (const c of m[1].split(',').map((x) => x.trim())) if (IDENT.test(c)) out.push({ file: f, col: c, via: 'INSERT' });
    }
  }
  return out;
}

function dynamicSites() {
  const sites = {};
  for (const f of backendFiles()) {
    const s = read(f);
    const n = (s.match(/UPDATE leads SET \$\{/g) || []).length + (s.match(/INSERT INTO leads \(\$\{/g) || []).length;
    if (n) sites[f] = n;
  }
  return sites;
}

function dynamicColumns() {
  const out = [];
  for (const f of Object.keys(DYNAMIC_SITES)) {
    const s = read(f);
    // push('col = …') / push(`col = …`) builders
    for (const m of s.matchAll(/\.push\(\s*[`'"]([a-z_][a-z0-9_]*)\s*=/g)) out.push({ file: f, col: m[1], via: 'push' });
    // field-list constants defined in this file
    for (const name of FIELD_LIST_CONSTANTS) {
      const def = s.match(new RegExp(`const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
      if (def) for (const c of def[1].matchAll(/'([a-z_][a-z0-9_]*)'/g)) out.push({ file: f, col: c[1], via: name });
    }
    // inline column lists iterated into the SET clause: for (const col of [ ... ])
    for (const m of s.matchAll(/for \(const col of \[([\s\S]*?)\]\)/g)) {
      for (const c of m[1].matchAll(/'([a-z_][a-z0-9_]*)'/g)) out.push({ file: f, col: c[1], via: 'inline-list' });
    }
    // explicit single-column assignments into the dynamic field map
    for (const m of s.matchAll(/allFields\.([a-z_][a-z0-9_]*)\s*=/g)) out.push({ file: f, col: m[1], via: 'allFields' });
  }
  // FOLLOW_UP_FIELDS is imported by routes/leads.js from lib/followUp.js.
  const fu = read('lib/followUp.js').match(/const FOLLOW_UP_FIELDS\s*=\s*\[([\s\S]*?)\]/);
  for (const c of fu[1].matchAll(/'([a-z_][a-z0-9_]*)'/g)) out.push({ file: 'lib/followUp.js', col: c[1], via: 'FOLLOW_UP_FIELDS' });
  return out;
}

function entityHelperWrites() {
  const out = [];
  const unanalyzable = [];
  for (const f of backendFiles()) {
    const s = read(f);
    const lines = s.split('\n');
    for (const m of s.matchAll(/\.(update|create)\(\s*'Lead'\s*,/g)) {
      const at = s.slice(0, m.index).split('\n').length - 1;
      const rest = s.slice(m.index + m[0].length);
      const args = m[1] === 'update' ? rest.replace(/^[^,]*,\s*/, '') : rest.trimStart();
      if (args.startsWith('{')) {
        const body = args.slice(1, args.indexOf('}'));
        for (const k of body.matchAll(/(?:^|,)\s*([a-z_][a-z0-9_]*)\s*:/g)) out.push({ file: f, col: k[1], via: `${m[1]}('Lead') line ${at + 1}` });
      } else {
        const v = (args.match(/^([A-Za-z_$][\w$]*)/) || [])[1];
        const win = lines.slice(Math.max(0, at - 40), at).join('\n');
        const keys = v ? [...win.matchAll(new RegExp(`\\b${v}\\.([a-z_][a-z0-9_]*)\\s*=`, 'g'))].map((x) => x[1]) : [];
        if (!keys.length) unanalyzable.push(`${f}:${at + 1}`);
        for (const k of keys) out.push({ file: f, col: k, via: `${m[1]}('Lead') line ${at + 1}` });
      }
    }
  }
  return { out, unanalyzable };
}

test('schema parser sees the real leads table', () => {
  const cols = schemaColumns();
  for (const c of ['id', 'first_name', 'status', 'owner_id', 'qb_last_sync_result', 'first_touch_id', 'merged_into_lead_id', 'property_lat']) {
    assert.ok(cols.has(c), `parser missed ${c}`);
  }
});

test('1. literal SQL writes to leads only use existing columns', () => {
  const cols = schemaColumns();
  const missing = literalWrites().filter((w) => !cols.has(w.col));
  assert.deepStrictEqual(missing, [], JSON.stringify(missing));
});

test('2. every dynamic leads-SQL site is reviewed, and every column it can emit exists', () => {
  assert.deepStrictEqual(dynamicSites(), DYNAMIC_SITES, 'a dynamic UPDATE/INSERT on leads was added or removed — review it and update DYNAMIC_SITES and its column sources');
  const cols = schemaColumns();
  const dyn = dynamicColumns();
  assert.ok(dyn.length > 40, 'column sources were extracted');
  const missing = dyn.filter((w) => !cols.has(w.col));
  assert.deepStrictEqual(missing, [], JSON.stringify(missing));
});

test('3. generic entity writes to Lead (lib/railwayDataAccess) only use existing columns; none is unanalyzable', () => {
  const cols = schemaColumns();
  const { out, unanalyzable } = entityHelperWrites();
  assert.deepStrictEqual(unanalyzable, [], `cannot determine the columns written at ${unanalyzable.join(', ')}`);
  const missing = out.filter((w) => !cols.has(w.col));
  assert.deepStrictEqual(missing, [], JSON.stringify(missing));
});

test('the Phase 0 phantom columns are gone from every writer and stay gone', () => {
  const all = [...literalWrites(), ...dynamicColumns(), ...entityHelperWrites().out];
  for (const c of ['signed_contract_date', 'signed_contract_document_id', 'sold_date', 'sold_by_source', 'duplicate_merged', 'last_merge_date',
    'merge_count', 'qb_last_error', 'handoff_estimate_status', 'appointment_date', 'handoff_project_id', 'handoff_project_number']) {
    assert.ok(!all.some((x) => x.col === c), `${c} is written to leads: ${JSON.stringify(all.filter((x) => x.col === c))}`);
  }
});

test('the guard really detects drift (self-test against the pre-fix writers)', () => {
  const cols = schemaColumns();
  const before = [
    "await query('UPDATE leads SET qb_last_sync_at = NOW(), qb_last_sync_result = $1, qb_last_error = $2, updated_at = NOW() WHERE qb_customer_id = $3', []);",
    "await query('UPDATE leads SET handoff_estimate_status = $1, updated_at = NOW() WHERE id = $2', []);",
  ].join('\n');
  const found = [...before.matchAll(/UPDATE\s+leads\s+SET\s+([\s\S]*?)\s+WHERE/gi)].flatMap((m) => m[1].split(',').map((p) => p.trim().split(/\s*=/)[0]));
  assert.deepStrictEqual(found.filter((c) => !cols.has(c)), ['qb_last_error', 'handoff_estimate_status']);
});
