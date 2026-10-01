/* eslint-disable no-undef */
'use strict';

/**
 * schemaDriftFixes.int.test.js — REAL-Postgres proof that the former writes
 * to nonexistent leads columns are gone and the canonical data is used:
 *
 *   D1. QuickBooks customer sync failure now records qb_last_sync_result =
 *       'error' (+ qb_last_sync_at). Before, the UPDATE also set a missing
 *       qb_last_error column, Postgres rejected the whole statement, the catch
 *       swallowed it and the lead kept showing its previous 'success'.
 *   D2. POST /handoff/sync-projects is report-only: it returns the matches and
 *       writes nothing to leads (it used to attempt handoff_project_id /
 *       handoff_project_number, which never existed).
 *   D3. The generic data-access helper rejects the old phantom columns — the
 *       exact failure the removed Base44-era writes always hit — and accepts the
 *       canonical ones.
 *
 * Runs only with TEST_DATABASE_URL (a disposable, migrated database).
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable Postgres)' : false;
const ROOT = path.join(__dirname, '..', '..');
if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
  process.env.PROXY_SECRET = 'int-test-proxy-secret';
}

let db;
const RUN = `d${Date.now().toString(36)}`;
let ownerId;

async function newLead(extra = {}) {
  const r = await db.query(
    `INSERT INTO leads (first_name, last_name, phone, email, owner_id, qb_customer_id, qb_last_sync_result)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    ['Drift', `${RUN}${Math.random().toString(36).slice(2, 7)}`, extra.phone || null, extra.email || null, ownerId,
      extra.qb_customer_id || null, extra.qb_last_sync_result || null]);
  return r.rows[0];
}

test.before(async () => {
  if (skip) return;
  execFileSync(process.execPath, ['db/migrate.js'], { cwd: ROOT, env: process.env, stdio: 'ignore' });
  db = require(path.join(ROOT, 'db/client'));
  await db.query(`INSERT INTO owners (email, display_name) VALUES ('drift.owner@example.test', 'Drift Owner') ON CONFLICT DO NOTHING`);
  ownerId = (await db.query(`SELECT id FROM owners WHERE email = 'drift.owner@example.test'`)).rows[0].id;
});

test.after(async () => { if (!skip) await db.pool.end(); });

test('D1. a failed QuickBooks customer sync records qb_last_sync_result = error on the lead (previously swallowed)', { skip }, async () => {
  const qbCustomer = `QB${RUN}`;
  const lead = await newLead({ qb_customer_id: qbCustomer, qb_last_sync_result: 'success' });
  const mgrPath = require.resolve(path.join(ROOT, 'lib/qbTokenManager'));
  const real = require(mgrPath);
  require.cache[mgrPath].exports = {
    ...real,
    getValidTokens: async () => ({ access_token: 'x', realm_id: 'r1' }),
    qbApiRequest: async () => { throw new Error('QB query failed 500: boom'); },
  };
  const syncPath = require.resolve(path.join(ROOT, 'lib/qbInboundSync'));
  delete require.cache[syncPath];
  try {
    const { syncCustomerFinancials } = require(syncPath);
    const r = await syncCustomerFinancials(qbCustomer);
    assert.strictEqual(r.synced, false);
    assert.match(r.error, /boom/, 'the error detail is returned to the caller');
    const after = (await db.query('SELECT qb_last_sync_result, qb_last_sync_at FROM leads WHERE id = $1', [lead.id])).rows[0];
    assert.strictEqual(after.qb_last_sync_result, 'error');
    assert.ok(after.qb_last_sync_at);
  } finally {
    require.cache[mgrPath].exports = real;
    delete require.cache[syncPath];
  }
});

test('D2. /handoff/sync-projects is report-only: returns matches, writes nothing to leads', { skip }, async () => {
  const express = require('express');
  const phone = `+1424${String(Date.now()).slice(-7)}`;
  const lead = await newLead({ phone, email: `drift.${RUN}@example.test` });
  const before = (await db.query('SELECT * FROM leads WHERE id = $1', [lead.id])).rows[0];
  const rda = require(path.join(ROOT, 'lib/railwayDataAccess'));
  const writes = [];
  const spy = { ...rda, update: async (...a) => { writes.push(a); return rda.update(...a); }, create: async (...a) => { writes.push(a); return rda.create(...a); } };
  const handoffClient = {
    getApiKey: async () => 'hnd_test',
    fetchProjects: async () => [{ id: 'proj-1', number: 'P-1', clientPhone: phone }],
    matchProjectToLead: (proj, l) => ({ match: l.id === lead.id, method: 'name_phone' }),
  };
  const app = express();
  app.use(express.json());
  require(path.join(ROOT, 'routes/handoffSync'))(app, (req, res, next) => next(), spy, handoffClient);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/handoff/sync-projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const body = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(body));
    assert.strictEqual(body.stats.report_only, true);
    assert.strictEqual(body.stats.matched >= 1, true);
    assert.ok(body.matches.some((m) => m.lead_id === lead.id && m.project_number === 'P-1'));
    assert.strictEqual(body.stats.updated, undefined, 'no misleading "updated" count');
    assert.deepStrictEqual(writes, [], 'no write through the data-access helper');
    const after = (await db.query('SELECT * FROM leads WHERE id = $1', [lead.id])).rows[0];
    assert.deepStrictEqual(after, before, 'lead row unchanged');
  } finally { server.close(); }
});

test('D3. the data-access helper rejects the removed phantom columns and accepts canonical ones', { skip }, async () => {
  const rda = require(path.join(ROOT, 'lib/railwayDataAccess'));
  const lead = await newLead();
  for (const col of ['handoff_estimate_status', 'appointment_date', 'handoff_project_id', 'handoff_project_number', 'qb_last_error']) {
    await assert.rejects(rda.update('Lead', lead.id, { [col]: 'x' }), /does not exist/, `${col} does not exist`);
  }
  const ok = await rda.update('Lead', lead.id, { qb_last_sync_result: 'error' });
  assert.strictEqual(ok.qb_last_sync_result, 'error');
});
