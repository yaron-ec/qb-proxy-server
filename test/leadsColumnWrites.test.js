/* eslint-disable no-undef */
'use strict';
/**
 * Schema-drift guard for the leads table.
 *
 * Phase 0 (Growth Engine) found production code writing leads columns that no
 * migration ever created — the SignNow "Sold" update (signed_contract_date,
 * signed_contract_document_id, sold_date, sold_by_source) and the duplicate
 * merge (duplicate_merged, last_merge_date, merge_count). Postgres rejects the
 * whole statement, so those features silently never worked.
 *
 * This test collects every column the schema defines for `leads`
 * (CREATE TABLE in db/schema.sql + migrations, every ALTER TABLE … ADD COLUMN,
 * and runtime ensureColumns('leads', …) lists) and fails if any
 * `UPDATE leads SET col = …` or `INSERT INTO leads (col, …)` in the code
 * targets a column outside that set.
 *
 * KNOWN_PRE_EXISTING lists drift found by this guard in integrations that are
 * explicitly out of scope for the change that introduced it (QuickBooks /
 * Handoff — not to be modified in Growth Engine Phase 1). Both writes are
 * already wrapped in a swallowed catch; they are reported, not fixed here.
 * Remove an entry when its code is fixed — the guard then protects it too.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const KNOWN_PRE_EXISTING = {
  'lib/qbInboundSync.js': ['qb_last_error'],
  'routes/leadQB.js': ['handoff_estimate_status'],
};

function schemaColumns() {
  const cols = new Set();
  const sqlFiles = [path.join(ROOT, 'db/schema.sql'), ...fs.readdirSync(path.join(ROOT, 'db/migrations')).map((f) => path.join(ROOT, 'db/migrations', f))];
  for (const f of sqlFiles) {
    const s = fs.readFileSync(f, 'utf8');
    for (const m of s.matchAll(/CREATE TABLE IF NOT EXISTS leads\s*\(([\s\S]*?)\n\s*\);/g)) {
      for (const line of m[1].split('\n')) {
        const c = (line.trim().match(/^([a-z_][a-z0-9_]*)\s+[A-Z]/) || [])[1];
        if (c && !['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK'].includes(c.toUpperCase())) cols.add(c);
      }
    }
    for (const m of s.matchAll(/ALTER TABLE leads ADD COLUMN(?: IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/gi)) cols.add(m[1]);
  }
  const js = execSync('git ls-files "*.js"', { cwd: ROOT }).toString().split('\n').filter((f) => f && !f.startsWith('test/') && !f.startsWith('crm-frontend/'));
  for (const f of js) {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of s.matchAll(/ensureColumns\(\s*'leads'\s*,\s*\[([\s\S]*?)\]\s*\)/g)) {
      for (const c of m[1].matchAll(/\[\s*'([a-z_][a-z0-9_]*)'/g)) cols.add(c[1]);
    }
  }
  return { cols, js };
}

function codeWrites(js) {
  const writes = [];
  for (const f of js) {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of s.matchAll(/UPDATE\s+leads\s+SET\s+([\s\S]*?)\s+WHERE/gi)) {
      for (const part of m[1].split(/,(?![^(]*\))/)) {
        const c = (part.trim().match(/^([a-z_][a-z0-9_]*)\s*=/) || [])[1];
        if (c) writes.push({ file: f, col: c });
      }
    }
    for (const m of s.matchAll(/INSERT\s+INTO\s+leads\s*\(([^)]*)\)/gi)) {
      for (const c of m[1].split(',').map((x) => x.trim())) if (/^[a-z_][a-z0-9_]*$/.test(c)) writes.push({ file: f, col: c });
    }
  }
  return writes;
}

test('every leads column written by the code exists in the schema (migrations / schema.sql / ensureColumns)', () => {
  const { cols, js } = schemaColumns();
  assert.ok(cols.has('first_name') && cols.has('status') && cols.has('first_touch_id') && cols.has('merged_into_lead_id'), 'schema parser sanity');
  const missing = codeWrites(js).filter((w) => !cols.has(w.col) && !(KNOWN_PRE_EXISTING[w.file] || []).includes(w.col));
  assert.deepStrictEqual(missing, [], `code writes leads columns that do not exist: ${JSON.stringify(missing)}`);
});

test('the Phase 0 phantom columns are gone from SignNow and merge, and stay gone', () => {
  const { js } = schemaColumns();
  const w = codeWrites(js);
  for (const c of ['signed_contract_date', 'signed_contract_document_id', 'sold_date', 'sold_by_source', 'duplicate_merged', 'last_merge_date', 'merge_count']) {
    assert.ok(!w.some((x) => x.col === c), `${c} is not written to leads`);
  }
});

test('known pre-existing drift entries are still real (remove them once fixed)', () => {
  const { cols, js } = schemaColumns();
  const w = codeWrites(js);
  for (const [file, list] of Object.entries(KNOWN_PRE_EXISTING)) {
    for (const col of list) {
      assert.ok(!cols.has(col), `${col} now exists — remove it from KNOWN_PRE_EXISTING`);
      assert.ok(w.some((x) => x.file === file && x.col === col), `${file} no longer writes ${col} — remove it from KNOWN_PRE_EXISTING`);
    }
  }
});
