/* eslint-disable no-undef */
'use strict';

/**
 * mergeLeads.int.test.js — REAL-Postgres regression proof for a production
 * defect: routes/mergeLeads.js POST /api/v1/leads/merge NEVER actually
 * completed a merge. Its final statement (soft-deleting the merged-away
 * lead) sets duplicate_merged/last_merge_date/merge_count, three columns
 * that were never added by any migration — so that UPDATE threw "column
 * duplicate_merged does not exist", which rolled back the ENTIRE
 * transaction (including every already-reassigned activity/task/deal/
 * invoice/appointment/estimate) and returned a 500 to the admin, on every
 * single use.
 *
 * test/mergeLeads.test.js (unit) only asserted these fields appear in the
 * route's SOURCE TEXT (`src.includes('duplicate_merged = true')`), never
 * against a real Postgres instance — exactly the "targeted test green,
 * real workflow broken" failure mode this suite exists to close. Fixed by
 * db/migrations/2026-52-leads-merge-tracking.sql.
 *
 * Skipped without TEST_DATABASE_URL.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
const ROOT = path.join(__dirname, '..', '..');

if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
  process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'int-test-secret-int-test-secret-0123456789';
}

let base, server, db, adminToken, ownerId;

async function api(method, url, body, token) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { status: res.status, body: json };
}

test.before(async () => {
  if (skip) return;
  delete require.cache[require.resolve(path.join(ROOT, 'db/client'))];
  db = require(path.join(ROOT, 'db/client'));

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/leads', require(path.join(ROOT, 'routes/mergeLeads')));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;

  const { issueAccessToken } = require(path.join(ROOT, 'lib/authService'));
  const stamp = Date.now();
  const adminEmail = `admin-merge-${stamp}@test.example`;
  adminToken = issueAccessToken({ id: '00000000-0000-0000-0000-00000000bb01', email: adminEmail, role: 'admin' });

  const ownerRes = await db.query(`INSERT INTO owners (email, display_name) VALUES ($1, 'Merge Test Owner') RETURNING id`, [`owner-merge-${stamp}@test.example`]);
  ownerId = ownerRes.rows[0].id;
});

test.after(async () => {
  if (skip) return;
  server.close();
  await db.pool.end();
});

async function makeLead({ email, createdDaysAgo, notes }) {
  const { rows } = await db.query(
    `INSERT INTO leads (first_name, last_name, email, phone, source, status, owner_id, notes, crm_created_date, created_at)
     VALUES ('Dup', 'Lead', $1, '5551112222', 'Referral', 'New', $2, $3, NOW() - ($4 || ' days')::interval, NOW() - ($4 || ' days')::interval)
     RETURNING *`,
    [email, ownerId, notes || null, String(createdDaysAgo)]
  );
  return rows[0];
}

test('1. merging two leads actually COMMITS (regression for the never-existed duplicate_merged/last_merge_date/merge_count columns rolling back every merge)', { skip }, async () => {
  const stamp = Date.now();
  const older = await makeLead({ email: `older-${stamp}@test.example`, createdDaysAgo: 10, notes: 'original notes' });
  const newer = await makeLead({ email: `newer-${stamp}@test.example`, createdDaysAgo: 1, notes: 'duplicate entry notes' });

  const r = await api('POST', '/api/v1/leads/merge', { lead_id_keep: newer.id, lead_id_merge: older.id }, adminToken);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.success, true);
  // Oldest lead survives regardless of which id was passed as lead_id_keep.
  assert.strictEqual(r.body.kept_lead_id, older.id);
  assert.strictEqual(r.body.merged_lead_id, newer.id);
});

test('2. the merged-away lead is soft-deleted with duplicate_merged/last_merge_date/merge_count set, not a rolled-back no-op', { skip }, async () => {
  const stamp = Date.now();
  const older = await makeLead({ email: `older2-${stamp}@test.example`, createdDaysAgo: 20 });
  const newer = await makeLead({ email: `newer2-${stamp}@test.example`, createdDaysAgo: 2 });

  const r = await api('POST', '/api/v1/leads/merge', { lead_id_keep: older.id, lead_id_merge: newer.id }, adminToken);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));

  const { rows } = await db.query('SELECT status, duplicate_merged, last_merge_date, merge_count, notes FROM leads WHERE id = $1', [newer.id]);
  const merged = rows[0];
  assert.strictEqual(merged.status, 'DNQ');
  assert.strictEqual(merged.duplicate_merged, true);
  assert.ok(merged.last_merge_date, 'last_merge_date must be set');
  assert.strictEqual(merged.merge_count, 1);
  assert.ok(merged.notes.includes('Merged into lead ID'), 'merged lead notes must record the merge');
});

test('3. a second merge into the same previously-merged lead increments merge_count (COALESCE path)', { skip }, async () => {
  const stamp = Date.now();
  const survivor = await makeLead({ email: `survivor-${stamp}@test.example`, createdDaysAgo: 30 });
  const firstDup = await makeLead({ email: `dup1-${stamp}@test.example`, createdDaysAgo: 5 });
  const secondDup = await makeLead({ email: `dup2-${stamp}@test.example`, createdDaysAgo: 3 });

  const r1 = await api('POST', '/api/v1/leads/merge', { lead_id_keep: survivor.id, lead_id_merge: firstDup.id }, adminToken);
  assert.strictEqual(r1.status, 200, JSON.stringify(r1.body));

  // Now merge secondDup into the SAME survivor (not into firstDup, which is already soft-deleted).
  const r2 = await api('POST', '/api/v1/leads/merge', { lead_id_keep: survivor.id, lead_id_merge: secondDup.id }, adminToken);
  assert.strictEqual(r2.status, 200, JSON.stringify(r2.body));
  assert.strictEqual(r2.body.kept_lead_id, survivor.id);

  // The survivor itself was never merged-away, so its own merge_count stays 0 —
  // it's the two DUPLICATES that each independently carry merge_count=1.
  const { rows } = await db.query('SELECT id, duplicate_merged, merge_count FROM leads WHERE id = ANY($1)', [[firstDup.id, secondDup.id]]);
  for (const row of rows) {
    assert.strictEqual(row.duplicate_merged, true);
    assert.strictEqual(row.merge_count, 1);
  }
});

test('4. child records (activities, tasks) are reassigned to the survivor and a merge-audit activity is written', { skip }, async () => {
  const stamp = Date.now();
  const older = await makeLead({ email: `older4-${stamp}@test.example`, createdDaysAgo: 15 });
  const newer = await makeLead({ email: `newer4-${stamp}@test.example`, createdDaysAgo: 1 });

  await db.query(`INSERT INTO activities (lead_id, type, content, author, source) VALUES ($1, 'note', 'pre-merge note', 'system', 'manual')`, [newer.id]);
  await db.query(`INSERT INTO tasks (lead_id, title, status) VALUES ($1, 'Follow up', 'pending')`, [newer.id]);

  const r = await api('POST', '/api/v1/leads/merge', { lead_id_keep: older.id, lead_id_merge: newer.id }, adminToken);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.stats.activities, 1);
  assert.strictEqual(r.body.stats.tasks, 1);

  const { rows: survivorActivities } = await db.query(
    `SELECT content FROM activities WHERE lead_id = $1 ORDER BY created_at`, [older.id]
  );
  assert.ok(survivorActivities.some((a) => a.content === 'pre-merge note'), 'the reassigned activity must now be on the survivor');
  assert.ok(survivorActivities.some((a) => a.content.includes('Merged lead')), 'a merge-audit activity must be written to the survivor');

  const { rows: survivorTasks } = await db.query('SELECT title FROM tasks WHERE lead_id = $1', [older.id]);
  assert.ok(survivorTasks.some((t) => t.title === 'Follow up'));
});

test('5. invalid/missing ids are rejected with 400, self-merge rejected, nonexistent lead 404s — no partial writes', { skip }, async () => {
  const missing = await api('POST', '/api/v1/leads/merge', {}, adminToken);
  assert.strictEqual(missing.status, 400);

  const bad = await api('POST', '/api/v1/leads/merge', { lead_id_keep: 'not-a-uuid', lead_id_merge: 'also-not' }, adminToken);
  assert.strictEqual(bad.status, 400);

  const stamp = Date.now();
  const lead = await makeLead({ email: `self-${stamp}@test.example`, createdDaysAgo: 1 });
  const self = await api('POST', '/api/v1/leads/merge', { lead_id_keep: lead.id, lead_id_merge: lead.id }, adminToken);
  assert.strictEqual(self.status, 400);

  const notFound = await api('POST', '/api/v1/leads/merge', { lead_id_keep: lead.id, lead_id_merge: '00000000-0000-0000-0000-000000000000' }, adminToken);
  assert.strictEqual(notFound.status, 404);
});
