/* eslint-disable no-undef */
'use strict';

/**
 * estimateFollowupStatusStopHttp.int.test.js — REAL-Postgres proof that
 * the estimate follow-up sequence is stopped IMMEDIATELY (not merely on
 * the next scheduled tick's pre-send re-check — see
 * estimateFollowupSequence.int.test.js's own "auto-stop: lead becomes
 * terminal-lost mid-sequence" test for that second, independent layer)
 * when a lead's status changes to Sold, Lost, or DNQ, through BOTH real
 * HTTP write paths (PUT /:id and PUT /by-external/:externalRef) —
 * routes/leads.js#isEnteringDisqualifyingStatus wiring.
 *
 * 'Sold' is the genuinely new case this file proves: it was never wired
 * into lib/estimateFollowupEngine.js#stopActiveSequencesForLead before
 * this pass (only the pre-existing terminal-lost hook — Lost/DNQ/Cancelled/
 * Closed Lost — called it), so a sold lead's sequence would previously
 * have stayed 'active' indefinitely with no cancelled steps and no audit
 * trail, even though the next send would still have been correctly
 * refused by the separate pre-send eligibility re-check.
 *
 * Only email transport and Google Calendar are faked; everything else is
 * real. Skipped without TEST_DATABASE_URL.
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

function stubModule(relPath, exportsObj) {
  const p = require.resolve(path.join(ROOT, relPath));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}
if (DB_URL) {
  const gPath = require.resolve(path.join(ROOT, 'lib/booking/googleCalendarClient'));
  require.cache[gPath] = {
    id: gPath, filename: gPath, loaded: true,
    exports: {
      getAccessToken: async () => 'fake-token',
      createOrUpdateEvent: async () => ({ id: 'fake' }),
      updateEvent: async (_t, _c, id) => ({ id }),
      cancelEvent: async () => ({ ok: true }),
      getEvent: async () => ({ exists: false, reason: 'missing' }),
      listByExt: async () => [],
      listEvents: async () => [],
    },
  };
  stubModule('lib/captureAlerts', { sendNewLeadAlert: async () => {}, ALERT_RECIPIENTS: [] });
  class GmailCredentialsError extends Error {}
  stubModule('lib/gmailSender', { GmailCredentialsError, refreshAccessToken: async () => 'fake-token' });
  stubModule('lib/emailService', { send: async () => ({ ok: true, gmailMessageId: 'm' + Math.random() }) });
}

let db, engine, ownerId, server, base, googleModulesState;
const RUN = `efs${Date.now().toString(36)}`;

function token(role, email) {
  const { issueAccessToken } = require(path.join(ROOT, 'lib/authService'));
  return issueAccessToken({ id: '00000000-0000-0000-0000-00000000009a', email, role, full_name: 'Test User' });
}
async function api(method, path_, body) {
  const res = await fetch(base + path_, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token('admin', 'yaron@ecconstructiongroup.com'), 'x-forwarded-for': `10.8.0.${1 + Math.floor(Math.random() * 250)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { status: res.status, body: json };
}
const rows = async (sql, p) => (await db.query(sql, p)).rows;

async function makeLead({ status = 'Appointment scheduled', email } = {}) {
  const r = await rows(
    `INSERT INTO leads (first_name, last_name, owner_id, status, phone, email, created_at)
     VALUES ('Jane', $1, $2, $3, $4, $5, '2099-01-01') RETURNING id, external_ref`,
    [RUN, ownerId, status, `310${Math.floor(1000000 + Math.random() * 8999999)}`, email || `${RUN}.${Math.random().toString(36).slice(2, 8)}@example.com`]
  );
  return r[0];
}
async function makeEstimate(leadId) {
  const r = await rows(
    `INSERT INTO handoff_estimates (lead_id, customer_name, estimate_status, qb_estimate_number, qb_estimate_id)
     VALUES ($1, 'Jane Test', 'Pending', $2, $3) RETURNING id`,
    [leadId, `EST-${RUN}-${Math.random().toString(36).slice(2, 8)}`, `QBID-${Math.random().toString(36).slice(2, 10)}`]
  );
  return r[0].id;
}
async function enrollLead(leadId) {
  const estimateId = await makeEstimate(leadId);
  const { sequence } = await engine.confirmEstimateSent({ leadId, handoffEstimateId: estimateId, confirmedBy: 'rep@example.com' });
  return sequence;
}
async function sequenceRow(sequenceId) {
  return (await rows('SELECT * FROM estimate_followup_sequences WHERE id = $1', [sequenceId]))[0];
}
async function pendingStepCount(sequenceId) {
  return Number((await rows(`SELECT COUNT(*) as cnt FROM estimate_followup_steps WHERE sequence_id = $1 AND status = 'pending'`, [sequenceId]))[0].cnt);
}
async function activitiesOf(leadId) {
  return rows('SELECT content, author FROM activities WHERE lead_id = $1 ORDER BY created_at', [leadId]);
}

test.before(async () => {
  if (skip) return;
  const express = require('express');
  db = require(path.join(ROOT, 'db/client'));
  engine = require(path.join(ROOT, 'lib/estimateFollowupEngine'));
  googleModulesState = await require('./ensureGoogleModulesEnabled').ensureGoogleModulesEnabled(db);
  require(path.join(ROOT, 'lib/companyConfig')).invalidate();
  await db.query(`INSERT INTO company_settings (company_name, company_address, company_city, company_state, company_zip) SELECT 'EC Construction Group', '5108 Serrania Ave', 'Woodland Hills', 'CA', '91364-3305' WHERE NOT EXISTS (SELECT 1 FROM company_settings)`);
  await db.query(`INSERT INTO owners (email, display_name, is_active) VALUES ($1, 'Owner Test', true) ON CONFLICT DO NOTHING`, [`${RUN}.owner@example.com`]);
  ownerId = (await rows(`SELECT id FROM owners WHERE email = $1`, [`${RUN}.owner@example.com`]))[0].id;
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/v1/leads', require(path.join(ROOT, 'routes/leads')));
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (skip) return;
  server.close();
  await require('./ensureGoogleModulesEnabled').restoreGoogleModules(db, googleModulesState);
  require(path.join(ROOT, 'lib/companyConfig')).invalidate();
  await db.pool.end();
});

test('PUT /:id — entering Sold immediately stops the active sequence, cancels pending steps, and records the reason/actor/timestamp', { skip }, async () => {
  const lead = await makeLead();
  const sequence = await enrollLead(lead.id);
  assert.strictEqual(await pendingStepCount(sequence.id), 6);

  const r = await api('PUT', `/api/v1/leads/${lead.id}`, { status: 'Sold' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));

  const after = await sequenceRow(sequence.id);
  assert.strictEqual(after.status, 'stopped');
  assert.strictEqual(after.stopped_reason, 'lead_status_Sold');
  assert.strictEqual(after.stopped_by, 'system:lead_status_change');
  assert.ok(after.stopped_at, 'stopped_at timestamp recorded');
  assert.strictEqual(await pendingStepCount(sequence.id), 0, 'all pending steps cancelled');

  const acts = await activitiesOf(lead.id);
  assert.ok(acts.some(a => /Estimate follow-up stopped: lead_status_Sold/.test(a.content)), 'activity history records the stop reason');
});

test('PUT /:id — entering DNQ immediately stops the active sequence', { skip }, async () => {
  const lead = await makeLead();
  const sequence = await enrollLead(lead.id);

  const r = await api('PUT', `/api/v1/leads/${lead.id}`, { status: 'DNQ' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));

  const after = await sequenceRow(sequence.id);
  assert.strictEqual(after.status, 'stopped');
  assert.strictEqual(after.stopped_reason, 'lead_status_DNQ');
  assert.strictEqual(await pendingStepCount(sequence.id), 0);
});

test('PUT /by-external/:externalRef — entering Lost immediately stops the active sequence (the other write path)', { skip }, async () => {
  const lead = await makeLead();
  const sequence = await enrollLead(lead.id);

  // leadIdWhere() resolves a UUID identifier against id OR external_ref, so
  // passing the real id here exercises this route's own write path for a
  // lead with no external_ref set (true of every lead these fixtures create).
  const r = await api('PUT', `/api/v1/leads/by-external/${lead.id}`, { status: 'Lost' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));

  const after = await sequenceRow(sequence.id);
  assert.strictEqual(after.status, 'stopped');
  assert.strictEqual(after.stopped_reason, 'lead_status_Lost');
  assert.strictEqual(await pendingStepCount(sequence.id), 0);
});

test('PUT /by-external/:externalRef — entering Sold also stops the sequence (not just PUT /:id)', { skip }, async () => {
  const lead = await makeLead();
  const sequence = await enrollLead(lead.id);

  const r = await api('PUT', `/api/v1/leads/by-external/${lead.id}`, { status: 'Sold' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));

  const after = await sequenceRow(sequence.id);
  assert.strictEqual(after.status, 'stopped');
  assert.strictEqual(after.stopped_reason, 'lead_status_Sold');
});

test('an edit that leaves an already-Sold lead Sold does not re-fire or re-log the stop', { skip }, async () => {
  const lead = await makeLead({ status: 'Sold' });
  // No live sequence exists for an already-Sold lead (can't enroll one —
  // proven by the next test), so there is nothing to stop; this test
  // proves the edge-detection itself never misfires on a no-op status
  // write, by checking no stray "Estimate follow-up stopped" note appears.
  const r = await api('PUT', `/api/v1/leads/${lead.id}`, { notes: 'just a note update' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const acts = await activitiesOf(lead.id);
  assert.ok(!acts.some(a => /Estimate follow-up stopped/.test(a.content)));
});

test('cannot enroll a lead already marked Sold, Lost, or DNQ', { skip }, async () => {
  for (const status of ['Sold', 'Lost', 'DNQ']) {
    const lead = await makeLead({ status });
    const estimateId = await makeEstimate(lead.id);
    await assert.rejects(
      () => engine.confirmEstimateSent({ leadId: lead.id, handoffEstimateId: estimateId, confirmedBy: 'rep@example.com' }),
      (e) => e.reasons && e.reasons.some(r => r.startsWith('lead_status_disqualifying')),
      `expected enrollment to be rejected for a lead already ${status}`
    );
  }
});

test('an unrelated lead\'s own active sequence is completely unaffected by another lead\'s status change', { skip }, async () => {
  const leadA = await makeLead();
  const seqA = await enrollLead(leadA.id);
  const leadB = await makeLead();
  const seqB = await enrollLead(leadB.id);

  const r = await api('PUT', `/api/v1/leads/${leadA.id}`, { status: 'Sold' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));

  assert.strictEqual((await sequenceRow(seqA.id)).status, 'stopped');
  assert.strictEqual((await sequenceRow(seqB.id)).status, 'active', 'lead B\'s sequence must be completely untouched');
  assert.strictEqual(await pendingStepCount(seqB.id), 6);
});

test('a lead with no active sequence changing to Sold is a safe no-op (no error, no stray activity)', { skip }, async () => {
  const lead = await makeLead();
  const r = await api('PUT', `/api/v1/leads/${lead.id}`, { status: 'Sold' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const acts = await activitiesOf(lead.id);
  assert.ok(!acts.some(a => /Estimate follow-up stopped/.test(a.content)));
});

test('a stopped sequence is never automatically resumed if the lead status later changes away from Sold', { skip }, async () => {
  const lead = await makeLead();
  const sequence = await enrollLead(lead.id);
  await api('PUT', `/api/v1/leads/${lead.id}`, { status: 'Sold' });
  assert.strictEqual((await sequenceRow(sequence.id)).status, 'stopped');

  // Reopen the lead (status moves away from Sold) — must never resurrect
  // the sequence; only an explicit new confirmEstimateSent would.
  const r = await api('PUT', `/api/v1/leads/${lead.id}`, { status: 'New' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual((await sequenceRow(sequence.id)).status, 'stopped', 'still stopped, never auto-resumed');
});
