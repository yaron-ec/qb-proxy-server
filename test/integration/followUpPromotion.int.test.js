/* eslint-disable no-undef */
'use strict';

/**
 * followUpPromotion.int.test.js — REAL-Postgres regression test for
 * POST /api/v1/leads/:id/promote-follow-up-to-appointment
 * (lib/booking/bookingService.js#promoteFollowUpToAppointment).
 *
 * The Barry Jacobson pattern: a lead has a stale, never-closed-out active
 * appointment from long ago, and a customer's genuinely NEW real appointment
 * was recorded via Follow-Up / Next Update -> Meeting instead of through the
 * canonical Appointment editor. Promoting must:
 *   - mark the old appointment 'completed' (kept as history, never deleted);
 *   - create ONE new canonical appointment from the follow-up's date/time/kind,
 *     through the same booking service every other appointment uses (so
 *     conflict checks, travel buffer, and the Google Calendar outbox all
 *     apply identically — this is not a special/parallel code path);
 *   - clear the follow-up fields that mirrored it;
 *   - never touch a genuinely independent follow-up (different action, not
 *     the same appointment) when asked not to.
 *
 * Runs only when TEST_DATABASE_URL points at a DISPOSABLE, migrated Postgres
 * (same harness as meetingFollowUp.int.test.js); skipped otherwise.
 */
const test = require('node:test');
const assert = require('node:assert');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;

if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
  process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'int-test-secret-int-test-secret-0123456789';
}

const google = { events: new Map(), createCalls: 0 };
if (DB_URL) {
  const gPath = require.resolve('../../lib/booking/googleCalendarClient');
  require.cache[gPath] = {
    id: gPath, filename: gPath, loaded: true,
    exports: {
      getAccessToken: async () => 'fake-token',
      createOrUpdateEvent: async (_t, _cal, body) => {
        google.createCalls++;
        const existed = google.events.has(body.id) && google.events.get(body.id).status !== 'cancelled';
        google.events.set(body.id, { ...body, status: 'confirmed' });
        return { id: body.id, alreadyExisted: existed };
      },
      updateEvent: async (_t, _cal, id, body) => { google.events.set(id, { ...body, id, status: 'confirmed' }); return { id }; },
      cancelEvent: async (_t, _cal, id) => { const e = google.events.get(id); if (e) e.status = 'cancelled'; return { ok: true, alreadyGone: !e }; },
      getEvent: async (_t, _cal, id) => { const e = google.events.get(id); return e && e.status !== 'cancelled' ? { exists: true } : { exists: false, reason: 'missing' }; },
      listByExt: async () => [],
      listEvents: async () => [],
    },
  };
  const mPath = require.resolve('../../lib/googleMapsClient');
  require.cache[mPath] = {
    id: mPath, filename: mPath, loaded: true,
    exports: {
      isConfigured: () => true,
      normalizeAddress: (a, c) => [a, c].filter(Boolean).join(', '),
      geocodeAddress: async () => null,
      computeRoute: async () => null,
    },
  };
}

let base, server, db, token, outbox, ownerId, appointmentTypeId;
const ADMIN = { id: '00000000-0000-0000-0000-0000000000a2', email: 'admin@test.example', role: 'admin' };
const REP = { id: '00000000-0000-0000-0000-0000000000a3', email: 'rep@test.example', role: 'sales_rep' };
let ipSeq = 5000;

async function api(method, path, body, tok) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `10.2.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`,
      ...(tok === null ? {} : { authorization: 'Bearer ' + (tok || token) }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { status: res.status, body: json };
}

let seq = 0;
const rnd = (lo, n) => lo + Math.floor(Math.random() * n);
const randomPhone = () => `${rnd(200, 800)}${rnd(200, 800)}${String(rnd(0, 10000)).padStart(4, '0')}`;
function capturePayload(extra) {
  seq++;
  return {
    first_name: 'Promo', last_name: `Test${seq}${Date.now() % 100000}`,
    phone: randomPhone(),
    project_type: 'Kitchen', source: 'Referral', assigned_rep: 'Promotion Tester',
    property_address: '123 Main St', city: 'Los Angeles',
    ...extra,
  };
}

let pickDay;
async function drainOutbox() {
  for (let i = 0; i < 20; i++) {
    const r = await outbox.claimAndProcess(db.pool, 'int-test-worker', { batchSize: 50 });
    if (!r.claimed) return;
  }
}
async function getLead(id) {
  const r = await api('GET', `/api/v1/leads/${id}`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return r.body.lead;
}

test.before(async () => {
  if (skip) return;
  const express = require('express');
  db = require('../../db/client');
  pickDay = await require('./freeDays').loadFreeDayPicker(db);
  outbox = require('../../lib/booking/calendarOutbox');
  const { issueAccessToken } = require('../../lib/authService');
  await db.query(`INSERT INTO owners (email, display_name) VALUES ('rep@test.example', 'Promotion Tester') ON CONFLICT DO NOTHING`);
  ownerId = (await db.query(`SELECT id FROM owners WHERE email = 'rep@test.example' ORDER BY created_at ASC LIMIT 1`)).rows[0].id;
  appointmentTypeId = (await db.query(`SELECT id FROM appointment_types WHERE is_active = true ORDER BY (name = 'Consultation') DESC, name LIMIT 1`)).rows[0].id;
  token = issueAccessToken(ADMIN);
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/v1/leads', require('../../routes/leads'));
  app.use('/api/public/capture', require('../../routes/publicCapture'));
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  await drainOutbox();
});

test.after(async () => {
  if (skip) return;
  server.close();
  await db.pool.end();
});

// Insert a stale, never-closed-out 'scheduled' appointment directly (the
// booking API only accepts future dates) — reproduces Barry's exact
// real-world state: an old active appointment nobody ever marked done.
async function insertStaleAppointment(leadId, pastIso) {
  const start = new Date(pastIso);
  const end = new Date(start.getTime() + 60 * 60000);
  const r = await db.query(
    `INSERT INTO appointments (lead_id, owner_id, appointment_type_id, start_at, end_at, timezone, busy_range, status, idempotency_key, calendar_sync_status)
     VALUES ($1,$2,$3,$4,$5,'America/Los_Angeles', tstzrange($4,$5,'[)'), 'scheduled', $6, 'pending') RETURNING *`,
    [leadId, ownerId, appointmentTypeId, start.toISOString(), end.toISOString(), `stale-test:${leadId}:${Date.now()}`]
  );
  return r.rows[0];
}

let leadId, day;

test('P1. promote: a stale old appointment + a Meeting follow-up representing the SAME real booking -> one canonical Appointment, old kept as history', { skip }, async () => {
  const create = await api('POST', '/api/public/capture', capturePayload({}), null);
  assert.strictEqual(create.status, 201, JSON.stringify(create.body));
  leadId = create.body.lead.id;

  const old = await insertStaleAppointment(leadId, '2024-12-11T18:00:00.000Z');

  day = pickDay();
  const fu = await api('PUT', `/api/v1/leads/${leadId}/follow-up`, {
    follow_up_date: day, follow_up_time: '14:00', follow_up_type: 'Meeting', follow_up_status: 'pending',
  });
  assert.strictEqual(fu.status, 200, JSON.stringify(fu.body));

  const promote = await api('POST', `/api/v1/leads/${leadId}/promote-follow-up-to-appointment`, {});
  assert.strictEqual(promote.status, 200, JSON.stringify(promote.body));
  assert.strictEqual(promote.body.superseded_appointment_id, old.id);

  await drainOutbox();

  // Old appointment: kept, now 'completed' — history, not deleted.
  const oldRow = (await db.query('SELECT status FROM appointments WHERE id = $1', [old.id])).rows[0];
  assert.strictEqual(oldRow.status, 'completed', 'the stale old appointment is superseded, never deleted');

  // Exactly one ACTIVE appointment for this lead, and it's the new one.
  const active = (await db.query(`SELECT * FROM appointments WHERE lead_id = $1 AND status IN ('scheduled','confirmed')`, [leadId])).rows;
  assert.strictEqual(active.length, 1, 'exactly one active appointment after promotion');
  assert.strictEqual(active[0].start_at.toISOString().slice(0, 10), day);

  // The lead's follow-up mirror is cleared — it now IS the appointment, not a separate entity.
  const lead = await getLead(leadId);
  assert.strictEqual(lead.follow_up_date, null);
  assert.strictEqual(lead.follow_up_type, null);
  assert.strictEqual(lead.appointment_date, day);
  assert.strictEqual(lead.appointment_time, '14:00');
  assert.strictEqual(lead.appointment_type, 'Meeting');

  // A real Google Calendar event was created for the NEW appointment through
  // the exact same outbox every other appointment uses.
  const apptIds = new Set((await db.query('SELECT id FROM appointments WHERE lead_id = $1', [leadId])).rows.map(r => r.id));
  const liveEvents = [...google.events.values()].filter(e => apptIds.has(e.extendedProperties?.private?.ec_appointment_id) && e.status !== 'cancelled');
  assert.ok(liveEvents.some(e => e.extendedProperties.private.ec_appointment_id === active[0].id), 'the new appointment has a live Google Calendar event');

  // An audit trail exists: an activity note documenting the promotion.
  const notes = (await db.query(`SELECT content FROM activities WHERE lead_id = $1 AND content ILIKE '%Promoted Follow-Up%'`, [leadId])).rows;
  assert.strictEqual(notes.length, 1, 'exactly one audit activity note for the promotion');
});

test('P2. promote respects travel buffer/conflict rules exactly like a normal Meeting booking', { skip }, async () => {
  const create = await api('POST', '/api/public/capture', capturePayload({}), null);
  leadId = create.body.lead.id;
  day = pickDay();

  await api('PUT', `/api/v1/leads/${leadId}/follow-up`, { follow_up_date: day, follow_up_time: '10:00', follow_up_type: 'Meeting', follow_up_status: 'pending' });
  const promote = await api('POST', `/api/v1/leads/${leadId}/promote-follow-up-to-appointment`, {});
  assert.strictEqual(promote.status, 200, JSON.stringify(promote.body));
  await drainOutbox();

  // A second lead trying to book inside the 1h travel buffer around 10:00 Meeting must conflict.
  const other = await api('POST', '/api/public/capture', capturePayload({ appointment_date: day, appointment_time: '10:30', assigned_rep: 'Promotion Tester' }), null);
  assert.strictEqual(other.status, 409, 'the promoted Meeting reserves its real travel buffer, exactly like a normally-booked Meeting');
});

test('P3. a Phone Call follow-up can NEVER be promoted — a Phone Call is never an appointment (canonical rule)', { skip }, async () => {
  const create = await api('POST', '/api/public/capture', capturePayload({}), null);
  leadId = create.body.lead.id;
  day = pickDay();

  await api('PUT', `/api/v1/leads/${leadId}/follow-up`, { follow_up_date: day, follow_up_time: '15:00', follow_up_type: 'Phone Call', follow_up_status: 'pending' });
  const promote = await api('POST', `/api/v1/leads/${leadId}/promote-follow-up-to-appointment`, {});
  assert.strictEqual(promote.status, 422, JSON.stringify(promote.body));
  assert.strictEqual(promote.body.error, 'phone_call_is_follow_up');

  // The Phone Call follow-up is completely untouched by the rejected attempt.
  const lead = await getLead(leadId);
  assert.strictEqual(lead.follow_up_type, 'Phone Call');
  assert.strictEqual(lead.follow_up_date, day);
  assert.strictEqual(lead.appointment_date, null, 'no appointment was created for a rejected Phone Call promotion');
});

test('P4. a lead with no dated Meeting/Phone-Call follow-up cannot be "promoted" (nothing to promote)', { skip }, async () => {
  const create = await api('POST', '/api/public/capture', capturePayload({}), null);
  leadId = create.body.lead.id;
  const promote = await api('POST', `/api/v1/leads/${leadId}/promote-follow-up-to-appointment`, {});
  assert.strictEqual(promote.status, 400);
  assert.strictEqual(promote.body.error, 'no_promotable_follow_up');
});

test('P5. a genuinely independent follow-up is never touched by promoting a DIFFERENT lead — isolation', { skip }, async () => {
  const leadA = (await api('POST', '/api/public/capture', capturePayload({}), null)).body.lead.id;
  const leadB = (await api('POST', '/api/public/capture', capturePayload({}), null)).body.lead.id;
  const dayA = pickDay();
  const dayB = pickDay();

  await api('PUT', `/api/v1/leads/${leadA}/follow-up`, { follow_up_date: dayA, follow_up_time: '09:00', follow_up_type: 'Meeting', follow_up_status: 'pending' });
  await api('PUT', `/api/v1/leads/${leadB}/follow-up`, { follow_up_date: dayB, follow_up_time: '09:00', follow_up_type: 'Meeting', follow_up_status: 'pending' });

  const promote = await api('POST', `/api/v1/leads/${leadA}/promote-follow-up-to-appointment`, {});
  assert.strictEqual(promote.status, 200, JSON.stringify(promote.body));

  const leadBAfter = await getLead(leadB);
  assert.strictEqual(leadBAfter.follow_up_date, dayB, 'an unrelated lead\'s follow-up is completely untouched by promoting a different lead');
  assert.strictEqual(leadBAfter.appointment_date, null);
});

test('P6. only admin/manager may promote — a sales_rep is forbidden', { skip }, async () => {
  const create = await api('POST', '/api/public/capture', capturePayload({}), null);
  leadId = create.body.lead.id;
  day = pickDay();
  await api('PUT', `/api/v1/leads/${leadId}/follow-up`, { follow_up_date: day, follow_up_time: '09:00', follow_up_type: 'Meeting', follow_up_status: 'pending' });

  const { issueAccessToken } = require('../../lib/authService');
  const repToken = issueAccessToken(REP);
  const promote = await api('POST', `/api/v1/leads/${leadId}/promote-follow-up-to-appointment`, {}, repToken);
  assert.strictEqual(promote.status, 403);
});

test('P7. promote resolves the installation\'s configured timezone (PRODUCTIZATION), not a hardcoded Pacific literal', { skip }, async () => {
  const companyConfig = require('../../lib/companyConfig');
  // company_settings is a singleton read via `ORDER BY created_at ASC LIMIT 1`
  // (see lib/companyConfig.js) — mutate whichever row is actually the
  // effective one (insert the very first row if none exists yet) so this
  // test is correct regardless of what other files in an aggregate run have
  // already seeded.
  const existing = (await db.query('SELECT id, timezone FROM company_settings ORDER BY created_at ASC LIMIT 1')).rows[0];
  let insertedId = null;
  if (existing) {
    await db.query('UPDATE company_settings SET timezone = $1 WHERE id = $2', ['America/New_York', existing.id]);
  } else {
    const ins = await db.query(
      `INSERT INTO company_settings (company_name, timezone) VALUES ('TZ Test Co', 'America/New_York') RETURNING id`
    );
    insertedId = ins.rows[0].id;
  }
  companyConfig.invalidate();
  try {
    const create = await api('POST', '/api/public/capture', capturePayload({}), null);
    leadId = create.body.lead.id;
    day = pickDay();
    await api('PUT', `/api/v1/leads/${leadId}/follow-up`, { follow_up_date: day, follow_up_time: '11:00', follow_up_type: 'Meeting', follow_up_status: 'pending' });

    const promote = await api('POST', `/api/v1/leads/${leadId}/promote-follow-up-to-appointment`, {});
    assert.strictEqual(promote.status, 200, JSON.stringify(promote.body));

    const active = (await db.query(`SELECT start_at FROM appointments WHERE lead_id = $1 AND status IN ('scheduled','confirmed')`, [leadId])).rows[0];
    // 11:00 America/New_York (EDT, UTC-4) -> 15:00 UTC. Had this stayed hardcoded
    // to Pacific (UTC-7), it would be 18:00 UTC instead — a materially different instant.
    assert.strictEqual(active.start_at.toISOString().slice(11, 16), '15:00',
      'promote used the installation\'s configured Eastern timezone, not a hardcoded Pacific literal');
  } finally {
    if (insertedId) await db.query('DELETE FROM company_settings WHERE id = $1', [insertedId]);
    else await db.query('UPDATE company_settings SET timezone = $1 WHERE id = $2', [existing.timezone, existing.id]);
    companyConfig.invalidate();
  }
});
