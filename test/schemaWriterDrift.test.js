/* eslint-disable no-undef */
'use strict';

/**
 * schemaWriterDrift.test.js — systemic CI drift guard against the defect
 * class found repeatedly in this codebase: a hand-written INSERT/UPDATE
 * referencing a column that was never migrated, or a dynamically-built
 * column list that lists the same column twice. Three confirmed real
 * production incidents of exactly this class, found in one audit pass:
 *
 *   1. routes/leadAttachments.js — 'uploaded_by' appeared in both a
 *      hardcoded INSERT prefix AND a generic FIELDS loop, so EVERY real
 *      attachment upload failed with "column uploaded_by specified more
 *      than once" (fixed; see test/integration/leadAttachments.int.test.js).
 *   2. routes/mergeLeads.js — referenced leads.duplicate_merged/
 *      last_merge_date/merge_count, none of which were ever migrated, so
 *      the entire Lead Merge feature rolled back and 500'd on every use
 *      (fixed by db/migrations/2026-52-leads-merge-tracking.sql; see
 *      test/integration/mergeLeads.int.test.js).
 *   3. lib/crmRepository.js — referenced activities.timestamp, which has
 *      never existed (only created_at), so REMINDER_SENT activity logging
 *      silently failed on every reminder (fixed; see
 *      test/integration/crmRepositoryActivity.int.test.js).
 *
 * This is a pure static-analysis guard (no DB connection) so it always
 * runs in CI, independent of TEST_DATABASE_URL. It does two things:
 *
 *   A. Builds a canonical table->columns map from db/migrations/*.sql
 *      (CREATE TABLE / ALTER TABLE ADD|DROP|RENAME COLUMN / RENAME TO /
 *      DROP TABLE) PLUS every ensureColumns('table', [[col, type], ...])
 *      call site repo-wide (db/client.js#ensureColumns is the sanctioned
 *      way to add columns outside the migration system — see CLAUDE.md).
 *
 *   B. Scans every INSERT INTO table (cols...) and UPDATE table SET ...
 *      statement in routes/, lib/, scripts/, db/, server.js and flags:
 *        - the same column listed twice (DUP)
 *        - a column not present in the canonical map (UNKNOWN)
 *
 * Known, accepted limitation: several routes build their column list
 * dynamically at runtime (e.g. a `FIELDS` array joined into the SQL
 * string), which this regex-based static scan cannot resolve — those are
 * classified DYNAMIC_SKIPPED and must be reviewed by hand (grep for
 * `FIELDS = [` in routes/ and check it doesn't overlap any hardcoded
 * column also present in the same INSERT/UPDATE's fixed prefix — exactly
 * incident #1 above). This guard still covers every literal, static
 * INSERT/UPDATE in the codebase, which is the majority.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MIGR_DIR = path.join(ROOT, 'db/migrations');

function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function buildSchema() {
  const schema = {};
  function ensureTable(t) { if (!schema[t]) schema[t] = new Set(); return schema[t]; }

  const files = fs.readdirSync(MIGR_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const raw = fs.readFileSync(path.join(MIGR_DIR, f), 'utf8');
    const sql = stripComments(raw);

    const createRe = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?"?(\w+)"?\s*\(/gi;
    let m;
    while ((m = createRe.exec(sql))) {
      const table = m[1].toLowerCase();
      let depth = 0, i = m.index + m[0].length - 1, start = i;
      for (; i < sql.length; i++) {
        if (sql[i] === '(') depth++;
        else if (sql[i] === ')') { depth--; if (depth === 0) break; }
      }
      const body = sql.slice(start + 1, i);
      const parts = [];
      let d2 = 0, cur = '';
      for (const ch of body) {
        if (ch === '(') d2++;
        if (ch === ')') d2--;
        if (ch === ',' && d2 === 0) { parts.push(cur); cur = ''; }
        else cur += ch;
      }
      if (cur.trim()) parts.push(cur);
      const set = ensureTable(table);
      for (const part of parts) {
        const trimmed = part.trim();
        const upper = trimmed.toUpperCase();
        if (/^(PRIMARY KEY|FOREIGN KEY|UNIQUE|CHECK|CONSTRAINT|EXCLUDE)\b/.test(upper)) continue;
        const colM = trimmed.match(/^"?(\w+)"?\s+/);
        if (colM) set.add(colM[1].toLowerCase());
      }
    }

    // Multi-clause ALTER TABLE t ADD COLUMN a ..., ADD COLUMN b ...;
    const alterStmtRe = /ALTER TABLE\s+(?:IF EXISTS\s+)?"?(\w+)"?\s+([\s\S]*?);/gi;
    while ((m = alterStmtRe.exec(sql))) {
      const table = m[1].toLowerCase();
      const clauseBody = m[2];
      const set = ensureTable(table);
      const addRe = /ADD COLUMN\s+(?:IF NOT EXISTS\s+)?"?(\w+)"?/gi;
      let am;
      while ((am = addRe.exec(clauseBody))) set.add(am[1].toLowerCase());
    }

    const renameRe = /ALTER TABLE\s+"?(\w+)"?\s+RENAME COLUMN\s+"?(\w+)"?\s+TO\s+"?(\w+)"?/gi;
    while ((m = renameRe.exec(sql))) {
      const set = ensureTable(m[1].toLowerCase());
      set.delete(m[2].toLowerCase());
      set.add(m[3].toLowerCase());
    }

    const dropRe = /ALTER TABLE\s+"?(\w+)"?\s+DROP COLUMN\s+(?:IF EXISTS\s+)?"?(\w+)"?/gi;
    while ((m = dropRe.exec(sql))) ensureTable(m[1].toLowerCase()).delete(m[2].toLowerCase());

    const renameTableRe = /ALTER TABLE\s+"?(\w+)"?\s+RENAME TO\s+"?(\w+)"?/gi;
    while ((m = renameTableRe.exec(sql))) {
      const oldT = m[1].toLowerCase(), newT = m[2].toLowerCase();
      if (schema[oldT]) { schema[newT] = schema[oldT]; delete schema[oldT]; }
    }

    const dropTableRe = /DROP TABLE\s+(?:IF EXISTS\s+)?"?(\w+)"?/gi;
    while ((m = dropTableRe.exec(sql))) delete schema[m[1].toLowerCase()];
  }

  // Merge ensureColumns('table', [['col', type], ...]) call sites — the
  // sanctioned out-of-migration way to add columns (db/client.js#ensureColumns).
  const ecFiles = execSync(`grep -rl "ensureColumns(" --include="*.js" routes lib scripts server.js db`, { cwd: ROOT, maxBuffer: 50 * 1024 * 1024 })
    .toString().trim().split('\n').filter(Boolean);
  for (const f of ecFiles) {
    const content = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const re = /ensureColumns\(\s*['"](\w+)['"]\s*,\s*\[([\s\S]*?)\]\s*\)/g;
    let m;
    while ((m = re.exec(content))) {
      const table = m[1].toLowerCase();
      const body = m[2];
      const colRe = /\[\s*['"](\w+)['"]/g;
      let cm;
      const set = schema[table] || (schema[table] = new Set());
      while ((cm = colRe.exec(body))) set.add(cm[1].toLowerCase());
    }
  }

  return schema;
}

function isDynamicNoise(c) {
  return !c || /[^a-z0-9_]/.test(c);
}

function findInserts(content) {
  const results = [];
  const re = /INSERT INTO\s+"?(\w+)"?\s*\(([\s\S]*?)\)\s*VALUES/gi;
  let m;
  while ((m = re.exec(content))) {
    const table = m[1].toLowerCase();
    const cols = m[2].split(',').map((s) => s.trim().replace(/^"|"$/g, '').toLowerCase()).filter(Boolean);
    results.push({ table, cols, index: m.index });
  }
  return results;
}

function findUpdates(content) {
  const results = [];
  const re = /UPDATE\s+"?(\w+)"?\s+SET\s+([\s\S]*?)\s+WHERE/gi;
  let m;
  while ((m = re.exec(content))) {
    const table = m[1].toLowerCase();
    const setRaw = m[2];
    const parts = [];
    let d = 0, cur = '';
    for (const ch of setRaw) {
      if (ch === '(') d++;
      if (ch === ')') d--;
      if (ch === ',' && d === 0) { parts.push(cur); cur = ''; }
      else cur += ch;
    }
    if (cur.trim()) parts.push(cur);
    const cols = [];
    for (const p of parts) {
      const cm = p.trim().match(/^"?(\w+)"?\s*=/);
      if (cm) cols.push(cm[1].toLowerCase());
    }
    results.push({ table, cols, index: m.index });
  }
  return results;
}

function scan(schema) {
  const issues = [];
  const files = execSync(`grep -rlE "INSERT INTO|UPDATE " --include="*.js" routes lib scripts server.js db`, { cwd: ROOT, maxBuffer: 50 * 1024 * 1024 })
    .toString().trim().split('\n').filter(Boolean);

  for (const f of files) {
    const content = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const lineOf = (idx) => content.slice(0, idx).split('\n').length;

    for (const { table, cols, index } of findInserts(content)) {
      if (!schema[table]) continue;
      if (cols.some(isDynamicNoise)) continue; // dynamic column list — needs manual review
      const seen = new Map();
      for (const c of cols) seen.set(c, (seen.get(c) || 0) + 1);
      const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([c]) => c);
      const unknown = cols.filter((c) => !schema[table].has(c));
      if (dupes.length) issues.push({ type: 'DUP_INSERT_COLUMN', file: f, line: lineOf(index), table, cols: dupes });
      if (unknown.length) issues.push({ type: 'UNKNOWN_INSERT_COLUMN', file: f, line: lineOf(index), table, cols: unknown });
    }
    for (const { table, cols, index } of findUpdates(content)) {
      if (!schema[table]) continue;
      if (cols.some(isDynamicNoise)) continue;
      const seen = new Map();
      for (const c of cols) seen.set(c, (seen.get(c) || 0) + 1);
      const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([c]) => c);
      const unknown = cols.filter((c) => !schema[table].has(c));
      if (dupes.length) issues.push({ type: 'DUP_UPDATE_COLUMN', file: f, line: lineOf(index), table, cols: dupes });
      if (unknown.length) issues.push({ type: 'UNKNOWN_UPDATE_COLUMN', file: f, line: lineOf(index), table, cols: unknown });
    }
  }
  return issues;
}

test('no static INSERT/UPDATE statement references a duplicate or nonexistent column vs the canonical migration-derived schema', () => {
  const schema = buildSchema();
  assert.ok(Object.keys(schema).length > 30, 'sanity check: schema map should contain most CRM tables');

  const issues = scan(schema);
  if (issues.length > 0) {
    const report = issues.map((i) => `  ${i.type} ${i.file}:${i.line} table=${i.table} cols=${i.cols.join(',')}`).join('\n');
    assert.fail(`Schema writer drift detected (${issues.length} issue(s)):\n${report}\n\nEach of these is either a duplicate column in one INSERT/UPDATE's column list, or a column that is not in any db/migrations/*.sql file or ensureColumns() call. See this file's header comment for the defect class and real past incidents.`);
  }
});
