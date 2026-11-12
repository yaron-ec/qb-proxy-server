/* eslint-disable no-undef */
'use strict';

/**
 * postAppointmentEstimateSync.int.test.js — REAL-Postgres, end-to-end proof
 * of the automatic post-appointment QuickBooks estimate sync scheduler
 * (lib/postAppointmentEstimateSync.js) and its HTTP surface
 * (routes/estimateFollowups.js's postAppointmentSyncs / admin
 * post-appointment-sync-status endpoints).
 *
 * Only the actual QuickBooks network call (lib/leadEstimateSync.js's
 * syncEstimatesForLead, which would otherwise hit QB_PROXY_URL) is faked —
 * everything else (eligibility/completion-signal derivation, enqueueing,
 * claim/lease atomicity, real enrollment via
 * lib/estimateFollowupEngine.js#enroll, retry-schedule advancement,
 * window expiry, stuck-row recovery, concurrent-worker claim safety, and
 * the HTTP surface) runs for real against a disposable, migrated Postgres
 * instance. Skipped without TEST_DATABASE_URL.
 *
 * Covers (mapped to the feature spec's required test scenarios):
 *   - 3h-after-end scheduling for an eligible completed appointment
 *   - never triggers for a cancelled/rescheduled/no-show appointment, a
 *     legacy Phone-Call-kind appointment row, or one that hasn't happened yet
 *   - idempotent enqueue (re-running never creates a duplicate schedule row)
 *   - no estimate found -> retries on the 24h/48h/... schedule
 *   - estimate found but delivery unverified -> keeps retrying, never
 *     treated as a stop condition
 *   - delivery confirmed (EmailSent) -> real enrollment via
 *     lib/estimateFollowupEngine.js#enroll, schedule row completes
 *   - lead becomes ineligible mid-search -> stops, never calls QuickBooks
 *     again for that row
 *   - the 7-day search window expiring with nothing found -> expires
 *   - a worker crash mid-attempt (stuck 'processing') is reaped and retried
 *   - two concurrent ticks never both process the same due row
 *   - the per-lead HTTP surface and the admin overdue/error monitoring surface
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

let db, sync, engine, ownerId, typeId;
const RUN = `paes${Date.now().toString(36)}`;

// Controlled per-call fake of the actual QuickBooks network boundary. Each
// test sets `fakeSyncQueue[leadId]` to a function returning the result for
// that lead's next syncEstimatesForLead call.
const fakeSyncHandlers = {};

test.before(async () => {
  if (skip) return;
  db = require(path.join(ROOT, 'db/client'));

  stubModule('lib/leadEstimateSync', {
    syncEstimatesForLead: async (lead) => {
      const handler = fakeSyncHandlers[lead.id];
      if (!handler) return { success: true, synced_estimate_ids: [] };
      return handler();
    },
  });

  sync = require(path.join(ROOT, 'lib/postAppointmentEstimateSync'));
  engine = require(path.join(ROOT, 'lib/estimateFollowupEngine'));

  await db.query(`INSERT INTO owners (email, display_name) VALUES ($1, 'PAES Test Owner') ON CONFLICT DO NOTHING`, [`${RUN}.owner@ecconstructiongroup.com`]);
  ownerId = (await db.query(`SELECT id FROM owners WHERE email = $1`, [`${RUN}.owner@ecconstructiongroup.com`])).rows[0].id;
  typeId = Object.fromEntries((await db.query(`SELECT name, id FROM appointment_types`)).rows.map((r) => [r.name, r.id]));
});

test.after(async () => {
  if (skip) return;
  // appointments rows are never physically deleted in this codebase (a DB
  // trigger enforces it — "use status = 'cancelled'" — see CLAUDE.md's
  // "appointments are NEVER physically deleted" rule), so this file leaves
  // its RUN-scoped fixtures in place, matching the established convention
  // of every other integration test that creates appointments (e.g.
  // test/integration/auditUnsyncedActiveAppointments.int.test.js). The one
  // thing that DOES matter is never colliding with another file's own
  // cleanup query — this file uses a RUN-scoped customer_name (never the
  // bare 'Jane Test' literal several other files' cleanup queries match
  // broadly) specifically so a leftover handoff_estimates row here is
  // never caught in, and never blocks, an unrelated file's DELETE.
  await db.pool.end();
});

async function makeLead({ status = 'Appointment scheduled', email } = {}) {
  const r = await db.query(
    `INSERT INTO leads (first_name, last_name, owner_id, status, email, created_at)
     VALUES ('Jane', $1, $2, $3, $4, '2098-01-01') RETURNING id`,
    [RUN, ownerId, status, email || `${RUN}.${Math.random().toString(36).slice(2, 8)}@test.com`]
  );
  return r.rows[0].id;
}

// kind: 'meeting' (buffered busy_range, a real Site Visit) or 'phone_call'
// (legacy unbuffered row — never eligible, same signal
// lib/booking/appointmentKind.js#isPhoneCallAppointment already uses
// everywhere else in this codebase).
async function makeAppointment(leadId, { kind = 'meeting', status = 'scheduled', endAt } = {}) {
  const t = typeId['General Meeting'];
  const end = endAt || new Date(Date.now() - 4 * 3600 * 1000).toISOString(); // 4h ago by default
  const bufferClause = kind === 'meeting'
    ? `tstzrange($4::timestamptz - interval '2 hour', $4::timestamptz, '[)')`
    : `tstzrange($4::timestamptz - interval '1 hour', $4::timestamptz, '[)')`;
  const r = await db.query(
    `INSERT INTO appointments (lead_id, owner_id, appointment_type_id, start_at, end_at, timezone, busy_range, status,
                                idempotency_key, calendar_sync_status, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4::timestamptz - interval '1 hour', $4::timestamptz, 'America/Los_Angeles',
             ${bufferClause}, $5, $6, 'pending', 1, NOW(), NOW()) RETURNING id`,
    [leadId, ownerId, t, end, status, `${RUN}-${leadId}-${Math.random().toString(36).slice(2, 8)}`]
  );
  return r.rows[0].id;
}

async function scheduleRowFor(appointmentId) {
  const { rows } = await db.query(`SELECT * FROM post_appointment_estimate_syncs WHERE appointment_id = $1`, [appointmentId]);
  return rows[0] || null;
}

test('enqueueEligibleAppointments: a real Meeting whose end time has passed gets a schedule row due 3h after it ended', { skip }, async () => {
  const leadId = await makeLead();
  const endAt = new Date(Date.now() - 4 * 3600 * 1000);
  const apptId = await makeAppointment(leadId, { kind: 'meeting', endAt: endAt.toISOString() });

  await sync.enqueueEligibleAppointments();

  const row = await scheduleRowFor(apptId);
  assert.ok(row, 'expected a schedule row to be created');
  assert.strictEqual(row.status, 'pending');
  assert.strictEqual(row.attempt_number, 0);
  const expectedNext = new Date(endAt.getTime() + 3 * 3600 * 1000);
  assert.ok(Math.abs(new Date(row.next_attempt_at).getTime() - expectedNext.getTime()) < 5000, 'next_attempt_at should be ~3h after end_at');
});

test('enqueueEligibleAppointments: idempotent — a second run never creates a duplicate row', { skip }, async () => {
  const leadId = await makeLead();
  const apptId = await makeAppointment(leadId, { kind: 'meeting' });

  await sync.enqueueEligibleAppointments();
  await sync.enqueueEligibleAppointments();
  await sync.enqueueEligibleAppointments();

  const { rows } = await db.query(`SELECT id FROM post_appointment_estimate_syncs WHERE appointment_id = $1`, [apptId]);
  assert.strictEqual(rows.length, 1);
});

test('enqueueEligibleAppointments: never schedules a legacy Phone-Call-kind appointment row', { skip }, async () => {
  const leadId = await makeLead();
  const apptId = await makeAppointment(leadId, { kind: 'phone_call' });

  await sync.enqueueEligibleAppointments();

  const row = await scheduleRowFor(apptId);
  assert.strictEqual(row, null);
});

test('enqueueEligibleAppointments: never schedules a cancelled, rescheduled, or no-show appointment', { skip }, async () => {
  const leadId1 = await makeLead(), leadId2 = await makeLead(), leadId3 = await makeLead();
  const a1 = await makeAppointment(leadId1, { kind: 'meeting', status: 'cancelled' });
  const a2 = await makeAppointment(leadId2, { kind: 'meeting', status: 'rescheduled' });
  const a3 = await makeAppointment(leadId3, { kind: 'meeting', status: 'no_show' });

  await sync.enqueueEligibleAppointments();

  assert.strictEqual(await scheduleRowFor(a1), null);
  assert.strictEqual(await scheduleRowFor(a2), null);
  assert.strictEqual(await scheduleRowFor(a3), null);
});

test('enqueueEligibleAppointments: never schedules an appointment that has not happened yet', { skip }, async () => {
  const leadId = await makeLead();
  const futureEnd = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const apptId = await makeAppointment(leadId, { kind: 'meeting', endAt: futureEnd });

  await sync.enqueueEligibleAppointments();

  assert.strictEqual(await scheduleRowFor(apptId), null);
});

test('enqueueEligibleAppointments: DOES schedule a completed appointment (status=completed is also eligible)', { skip }, async () => {
  const leadId = await makeLead();
  const apptId = await makeAppointment(leadId, { kind: 'meeting', status: 'completed' });

  await sync.enqueueEligibleAppointments();

  assert.ok(await scheduleRowFor(apptId));
});

test('full tick: no estimate found -> stays pending and advances to the next (24h) retry offset', { skip }, async () => {
  const leadId = await makeLead();
  const apptId = await makeAppointment(leadId, { kind: 'meeting' });
  fakeSyncHandlers[leadId] = () => ({ success: true, synced_estimate_ids: [] });

  await sync.processPostAppointmentEstimateSyncs({ triggeredBy: 'test' });

  const row = await scheduleRowFor(apptId);
  assert.strictEqual(row.status, 'pending');
  assert.strictEqual(row.attempt_number, 1); // advanced from 0 -> index 1 (24h)
  assert.strictEqual(row.last_result, 'not_found');
});

test('full tick: estimate found but EmailStatus not yet EmailSent -> found_unverified, keeps retrying (never a stop condition)', { skip }, async () => {
  const leadId = await makeLead();
  const apptId = await makeAppointment(leadId, { kind: 'meeting' });
  const estRes = await db.query(
    `INSERT INTO handoff_estimates (lead_id, customer_name, estimate_status, qb_estimate_number, qb_estimate_id, qb_email_status)
     VALUES ($1, $2, 'Pending', $3, $4, 'NeedToSend') RETURNING id`,
    [leadId, `${RUN}-Jane Test`, `EST-${RUN}-1`, `QBID-${RUN}-1`]
  );
  const estimateId = estRes.rows[0].id;
  fakeSyncHandlers[leadId] = () => ({ success: true, synced_estimate_ids: [estimateId] });

  await sync.processPostAppointmentEstimateSyncs({ triggeredBy: 'test' });

  const row = await scheduleRowFor(apptId);
  assert.strictEqual(row.status, 'pending');
  assert.strictEqual(row.last_result, 'found_unverified');
  assert.strictEqual(row.handoff_estimate_id, estimateId);
});

test('full tick: EmailSent confirmed -> real enrollment via estimateFollowupEngine.enroll, schedule row completes', { skip }, async () => {
  const leadId = await makeLead({ email: `${RUN}.enroll@test.com` });
  const apptId = await makeAppointment(leadId, { kind: 'meeting' });
  const estRes = await db.query(
    `INSERT INTO handoff_estimates (lead_id, customer_name, estimate_status, qb_estimate_number, qb_estimate_id, qb_email_status, qb_email_delivery_time)
     VALUES ($1, $2, 'Pending', $3, $4, 'EmailSent', NOW()) RETURNING id`,
    [leadId, `${RUN}-Jane Test`, `EST-${RUN}-2`, `QBID-${RUN}-2`]
  );
  const estimateId = estRes.rows[0].id;
  fakeSyncHandlers[leadId] = () => ({ success: true, synced_estimate_ids: [estimateId] });

  await sync.processPostAppointmentEstimateSyncs({ triggeredBy: 'test' });

  const row = await scheduleRowFor(apptId);
  assert.strictEqual(row.status, 'completed');
  assert.strictEqual(row.last_result, 'found_verified_enrolled');
  assert.strictEqual(row.handoff_estimate_id, estimateId);

  const sequence = await engine.getSequenceForLead(leadId);
  assert.ok(sequence, 'expected a real estimate_followup_sequences row to exist');
  assert.strictEqual(sequence.enrollment_method, 'auto_post_appointment_sync');
  assert.strictEqual(sequence.handoff_estimate_id, estimateId);
});

test('full tick: a lead that becomes terminal-lost mid-search stops immediately and never calls QuickBooks', { skip }, async () => {
  const leadId = await makeLead({ status: 'Lost' });
  const apptId = await makeAppointment(leadId, { kind: 'meeting' });
  let called = false;
  fakeSyncHandlers[leadId] = () => { called = true; return { success: true, synced_estimate_ids: [] }; };

  await sync.processPostAppointmentEstimateSyncs({ triggeredBy: 'test' });

  const row = await scheduleRowFor(apptId);
  assert.strictEqual(row.status, 'stopped');
  assert.strictEqual(row.last_result, 'lead_ineligible');
  assert.strictEqual(called, false, 'must never call QuickBooks for an already-ineligible lead');
});

test('full tick: the 7-day search window expires once the last retry offset has been exhausted with nothing found', { skip }, async () => {
  const leadId = await makeLead();
  const apptId = await makeAppointment(leadId, { kind: 'meeting' });
  fakeSyncHandlers[leadId] = () => ({ success: true, synced_estimate_ids: [] });

  // Enqueue first, so the row actually exists before fast-forwarding it.
  await sync.enqueueEligibleAppointments();

  // Fast-forward this row to the LAST retry offset (index 7 = 168h) by
  // writing attempt_number/next_attempt_at directly — the same state the
  // row would reach naturally after 8 real ticks, without waiting 7 days.
  await db.query(
    `UPDATE post_appointment_estimate_syncs SET attempt_number = 7, next_attempt_at = NOW() - interval '1 minute' WHERE appointment_id = $1`,
    [apptId]
  );

  await sync.processPostAppointmentEstimateSyncs({ triggeredBy: 'test' });

  const row = await scheduleRowFor(apptId);
  assert.strictEqual(row.status, 'expired');
});

test('reapStuckProcessingRows: a row stuck in processing beyond the timeout is recovered back to pending', { skip }, async () => {
  const leadId = await makeLead();
  const apptId = await makeAppointment(leadId, { kind: 'meeting' });
  await sync.enqueueEligibleAppointments();
  // The table's own touch_updated_at trigger forces updated_at=NOW() on
  // every UPDATE — disabled just for this one backdating statement so the
  // test can simulate a crash that happened an hour ago.
  await db.query(`ALTER TABLE post_appointment_estimate_syncs DISABLE TRIGGER post_appointment_estimate_syncs_set_updated_at`);
  await db.query(
    `UPDATE post_appointment_estimate_syncs SET status = 'processing', updated_at = NOW() - interval '1 hour' WHERE appointment_id = $1`,
    [apptId]
  );
  await db.query(`ALTER TABLE post_appointment_estimate_syncs ENABLE TRIGGER post_appointment_estimate_syncs_set_updated_at`);

  const reaped = await sync.reapStuckProcessingRows();
  assert.ok(reaped >= 1);

  const row = await scheduleRowFor(apptId);
  assert.strictEqual(row.status, 'pending');
});

test('concurrency: two overlapping ticks never both process the same due row', { skip }, async () => {
  const leadId = await makeLead();
  const apptId = await makeAppointment(leadId, { kind: 'meeting' });
  let callCount = 0;
  fakeSyncHandlers[leadId] = () => { callCount++; return { success: true, synced_estimate_ids: [] }; };

  await Promise.all([
    sync.processPostAppointmentEstimateSyncs({ triggeredBy: 'test-a' }),
    sync.processPostAppointmentEstimateSyncs({ triggeredBy: 'test-b' }),
  ]);

  assert.strictEqual(callCount, 1, 'the lead-scoped sync must be attempted exactly once, never twice for the same due row');
  const row = await scheduleRowFor(apptId);
  assert.strictEqual(row.attempt_number, 1);
});

test('HTTP: GET /leads/:id/estimate-followup includes postAppointmentSyncs for the lead', { skip }, async () => {
  const leadId = await makeLead();
  const apptId = await makeAppointment(leadId, { kind: 'meeting' });
  await sync.enqueueEligibleAppointments();

  const router = require(path.join(ROOT, 'routes/estimateFollowups'));
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/v1', router);

  const { issueAccessToken } = require(path.join(ROOT, 'lib/authService'));
  const adminToken = issueAccessToken({ id: '00000000-0000-0000-0000-000000000098', email: `${RUN}.admin2@test.com`, role: 'admin', full_name: 'Admin' });

  const http = require('http');
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const res = await new Promise((resolve, reject) => {
      http.get({ host: 'localhost', port, path: `/api/v1/leads/${leadId}/estimate-followup`, headers: { Authorization: `Bearer ${adminToken}` } }, (r) => {
        let body = '';
        r.on('data', (c) => body += c);
        r.on('end', () => resolve({ status: r.statusCode, json: JSON.parse(body) }));
      }).on('error', reject);
    });
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.json.postAppointmentSyncs));
    assert.strictEqual(res.json.postAppointmentSyncs.length, 1);
    assert.strictEqual(res.json.postAppointmentSyncs[0].appointment.id, apptId);
  } finally {
    server.close();
  }
});

test('HTTP: admin post-appointment-sync-status surfaces overdue rows', { skip }, async () => {
  const leadId = await makeLead();
  const apptId = await makeAppointment(leadId, { kind: 'meeting' });
  await sync.enqueueEligibleAppointments();
  await db.query(
    `UPDATE post_appointment_estimate_syncs SET next_attempt_at = NOW() - interval '3 hours' WHERE appointment_id = $1`,
    [apptId]
  );

  const router = require(path.join(ROOT, 'routes/estimateFollowups'));
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/v1', router);

  const { issueAccessToken } = require(path.join(ROOT, 'lib/authService'));
  const adminToken = issueAccessToken({ id: '00000000-0000-0000-0000-000000000099', email: `${RUN}.admin@test.com`, role: 'admin', full_name: 'Admin' });

  const http = require('http');
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const res = await new Promise((resolve, reject) => {
      http.get({ host: 'localhost', port, path: '/api/v1/estimate-followups/admin/post-appointment-sync-status', headers: { Authorization: `Bearer ${adminToken}` } }, (r) => {
        let body = '';
        r.on('data', (c) => body += c);
        r.on('end', () => resolve({ status: r.statusCode, json: JSON.parse(body) }));
      }).on('error', reject);
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.json.counts);
    assert.ok(Array.isArray(res.json.overdue));
    assert.ok(res.json.overdue.some((r) => r.leadId === leadId));
  } finally {
    server.close();
  }
});
