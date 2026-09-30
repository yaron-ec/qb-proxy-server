/* eslint-disable no-undef */
'use strict';

/**
 * leadDiagnostic.int.test.js — REAL-Postgres proof of the safe, read-only
 * production diagnostic mechanism (routes/systemHealth.js#GET
 * /lead-diagnostic/:id, lib/leadDiagnostic.js), built specifically to answer
 * "what is this ONE lead's actual Follow-Up/Appointment state" without a
 * DB credential ever leaving the server and without any mutation path.
 *
 * Proves, through the real HTTP route + real database, not mocks:
 *   - no token -> 401; a non-admin (sales_rep) token -> 403; admin -> 200
 *   - the response reports the lead's real canonical follow-up, its real
 *     appointment (booked through the real bookingService, exactly like
 *     production), and classifies an Appointment + a different-dated
 *     Meeting Follow-Up as DIV_OTHER / would_auto_apply=false
 *   - calling the endpoint any number of times never changes the
 *     underlying lead/appointment/follow-up row (genuinely read-only)
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

let base, server, db, adminToken, repToken;

async function api(method, p, body, tok) {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(tok === null ? {} : { authorization: 'Bearer ' + (tok !== undefined ? tok : adminToken) }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { status: res.status, body: json };
}

test.before(async () => {
  if (skip) return;
  const express = require('express');
  db = require(path.join(ROOT, 'db/client'));
  const { issueAccessToken } = require(path.join(ROOT, 'lib/authService'));
  adminToken = issueAccessToken({ id: '00000000-0000-0000-0000-0000000000a1', email: 'admin@test.example', role: 'admin' });
  repToken = issueAccessToken({ id: '00000000-0000-0000-0000-0000000000b2', email: 'rep@test.example', role: 'sales_rep' });
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/v1/leads', require(path.join(ROOT, 'routes/leads')));
  app.use('/api/public/capture', require(path.join(ROOT, 'routes/publicCapture')));
  app.use('/api/v1/system', require(path.join(ROOT, 'routes/systemHealth')));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (skip) return;
  server.close();
  await db.pool.end();
});

test('GET /lead-diagnostic/:id requires admin (or CI OIDC): 401 without token, 403 for sales_rep, 200 for admin', { skip }, async () => {
  const create = await api('POST', '/api/public/capture', {
    first_name: 'Diag', last_name: `Test${Date.now()}`, phone: `${300000000 + Math.floor(Math.random() * 90000000)}`,
    project_type: 'Kitchen', source: 'Referral', assigned_rep: 'Diagnostic Owner',
  }, null);
  assert.strictEqual(create.status, 201, JSON.stringify(create.body));
  const leadId = create.body.lead.id;

  assert.strictEqual((await api('GET', `/api/v1/system/lead-diagnostic/${leadId}`, undefined, null)).status, 401);
  assert.strictEqual((await api('GET', `/api/v1/system/lead-diagnostic/${leadId}`, undefined, repToken)).status, 403);
  const ok = await api('GET', `/api/v1/system/lead-diagnostic/${leadId}`, undefined, adminToken);
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.strictEqual(ok.body.lead.id, leadId);
});

test('invalid id shape -> 400; a well-formed but nonexistent id -> 404', { skip }, async () => {
  const bad = await api('GET', '/api/v1/system/lead-diagnostic/not-a-uuid', undefined, adminToken);
  assert.strictEqual(bad.status, 400);
  const missing = await api('GET', '/api/v1/system/lead-diagnostic/00000000-0000-0000-0000-000000000000', undefined, adminToken);
  assert.strictEqual(missing.status, 404);
});

test('reports the real canonical Follow-Up + real Appointment, and classifies a different-dated pair as DIV_OTHER (never would_auto_apply)', { skip }, async () => {
  const create = await api('POST', '/api/public/capture', {
    first_name: 'Divergent', last_name: `Lead${Date.now()}`, phone: `${400000000 + Math.floor(Math.random() * 90000000)}`,
    project_type: 'Bathroom', source: 'Referral', assigned_rep: 'Diagnostic Owner',
  }, null);
  const leadId = create.body.lead.id;

  // Book a real Appointment on one date...
  const apptDay = new Date(Date.now() + 300 * 86400000).toISOString().slice(0, 10);
  const apptRes = await api('PUT', `/api/v1/leads/${leadId}/appointment`, { appointment_date: apptDay, appointment_time: '18:00', appointment_type: 'Meeting' }, adminToken);
  assert.strictEqual(apptRes.status, 200, JSON.stringify(apptRes.body));

  // ...and set an independent Follow-Up on a LATER, different date — exactly
  // the shape reported for a real production lead (Appointment Sep 29,
  // Follow-Up Oct 1).
  const followUpDay = new Date(Date.now() + 302 * 86400000).toISOString().slice(0, 10);
  const fuRes = await api('PUT', `/api/v1/leads/${leadId}/follow-up`, { follow_up_date: followUpDay, follow_up_time: '12:00', follow_up_type: 'Meeting', follow_up_status: 'pending' }, adminToken);
  assert.strictEqual(fuRes.status, 200, JSON.stringify(fuRes.body));

  const diag = await api('GET', `/api/v1/system/lead-diagnostic/${leadId}`, undefined, adminToken);
  assert.strictEqual(diag.status, 200, JSON.stringify(diag.body));
  assert.strictEqual(diag.body.canonical_follow_up.date, followUpDay, 'Follow-Up Date is reported exactly as stored — the Appointment never overwrote it');
  assert.strictEqual(diag.body.canonical_follow_up.time, '12:00');
  assert.strictEqual(diag.body.canonical_follow_up.type, 'Meeting');
  assert.strictEqual(diag.body.appointments.length, 1, 'the real Appointment is reported, kept independently');
  assert.strictEqual(diag.body.appointments[0].date, apptDay);
  assert.strictEqual(diag.body.appointments[0].status, 'scheduled');
  assert.ok(diag.body.appointments[0].events.length >= 1, 'appointment_events history is included');
  assert.strictEqual(diag.body.classification.class, 'DIVERGENT');
  assert.strictEqual(diag.body.classification.sub, 'DIV_OTHER');
  assert.strictEqual(diag.body.classification.would_auto_apply, false, 'an independent, different-dated Follow-Up is never something the diagnostic (or the audit tool) would auto-clear');
  assert.strictEqual(diag.body.classification.reason, 'different_date');

  // Genuinely read-only: calling it again changes nothing in the database.
  const before = (await db.query('SELECT follow_up_date, follow_up_time, follow_up_type FROM leads WHERE id = $1', [leadId])).rows[0];
  await api('GET', `/api/v1/system/lead-diagnostic/${leadId}`, undefined, adminToken);
  await api('GET', `/api/v1/system/lead-diagnostic/${leadId}`, undefined, adminToken);
  const after = (await db.query('SELECT follow_up_date, follow_up_time, follow_up_type FROM leads WHERE id = $1', [leadId])).rows[0];
  assert.deepStrictEqual(after, before, 'repeated diagnostic calls never mutate the lead');
  const apptCountBefore = (await db.query('SELECT count(*)::int AS n FROM appointments WHERE lead_id = $1', [leadId])).rows[0].n;
  assert.strictEqual(apptCountBefore, 1, 'no appointment was created/altered by the diagnostic calls');
});
