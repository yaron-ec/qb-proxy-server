/* eslint-disable no-undef */
'use strict';

/**
 * auditCalendarAttendeeOmissionsLiveVerify.int.test.js — REAL-Postgres proof
 * of scripts/auditCalendarAttendeeOmissions.js's --verify-live mode: the
 * ground-truth check against Google's live Calendar API, added after a
 * production run of the DB-only mode reported omission_count=0 while the
 * Michelle missing-calendar-events incident was still visibly ongoing.
 *
 * The DB-only mode can only ever prove "the last thing we wrote to our own
 * database says everyone is invited" — it cannot prove that write was ever
 * delivered to Google, or that Google's live event still reflects it. This
 * file proves --verify-live correctly distinguishes three real-world cases
 * by calling the (faked) live Google Calendar API directly: an event whose
 * live attendees are missing a staff member despite our own DB being
 * "clean", an event that no longer exists on Google at all, and a correctly
 * synced event (never reported). Skipped without TEST_DATABASE_URL.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
const ROOT = path.join(__dirname, '..', '..');
const MICHELLE = 'michelle@ecconstructiongroup.com';
const YARON = 'yaron@ecconstructiongroup.com';

if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
}

// Fake Google Calendar: a map of eventId -> live event resource (or absent = 404).
const google = { events: new Map() };
let auditScript, db, ownerId, typeId, notifRecipientsState;
const RUN = `live${Date.now().toString(36)}`;

test.before(async () => {
  if (skip) return;
  // Inject the fake BEFORE requiring anything that resolves googleCalendarClient.
  const gPath = require.resolve(path.join(ROOT, 'lib/booking/googleCalendarClient'));
  require.cache[gPath] = {
    id: gPath, filename: gPath, loaded: true,
    exports: {
      getAccessToken: async () => 'fake-token',
      getEvent: async (_t, _cal, eventId) => {
        const ev = google.events.get(eventId);
        return ev ? { exists: true, event: ev } : { exists: false, reason: 'missing' };
      },
      createOrUpdateEvent: async () => { throw new Error('verify-live must never write'); },
      updateEvent: async () => { throw new Error('verify-live must never write'); },
      cancelEvent: async () => { throw new Error('verify-live must never write'); },
      listByExt: async () => [],
      listEvents: async () => [],
    },
  };

  db = require(path.join(ROOT, 'db/client'));
  auditScript = require(path.join(ROOT, 'scripts/auditCalendarAttendeeOmissions'));
  await db.query(`INSERT INTO owners (email, display_name) VALUES ('${RUN}.owner@ecconstructiongroup.com', 'Live Verify Owner') ON CONFLICT DO NOTHING`);
  ownerId = (await db.query(`SELECT id FROM owners WHERE email = $1`, [`${RUN}.owner@ecconstructiongroup.com`])).rows[0].id;
  typeId = Object.fromEntries((await db.query(`SELECT name, id FROM appointment_types`)).rows.map((r) => [r.name, r.id]));

  const existing = (await db.query('SELECT id, notification_recipients FROM company_settings ORDER BY created_at ASC LIMIT 1')).rows[0];
  if (existing) {
    const nr = existing.notification_recipients || { to: [], cc: [] };
    const hasMichelle = (nr.to || []).includes(MICHELLE) || (nr.cc || []).includes(MICHELLE);
    if (!hasMichelle) {
      notifRecipientsState = { id: existing.id, previous: nr };
      await db.query('UPDATE company_settings SET notification_recipients = $1 WHERE id = $2',
        [JSON.stringify({ to: nr.to || [YARON], cc: Array.from(new Set([...(nr.cc || []), MICHELLE])) }), existing.id]);
    }
  } else {
    // No row exists yet in this disposable DB — insert a placeholder and
    // delete it again in test.after (never leave it behind: a leaked
    // "Integration Test Co ..." row becomes the ORDER BY created_at ASC
    // LIMIT 1 winner for every OTHER integration test file sharing this
    // same database for the rest of the suite run — see
    // ensureGoogleModulesEnabled.js's own header for this exact failure mode).
    const ins = await db.query(
      `INSERT INTO company_settings (company_name, notification_recipients) VALUES ($1, $2) RETURNING id`,
      [`Integration Test Co ${Date.now()}`, JSON.stringify({ to: [YARON], cc: [MICHELLE] })]
    );
    notifRecipientsState = { insertedId: ins.rows[0].id };
  }
  require('../../lib/companyConfig').invalidate();
});
test.after(async () => {
  if (skip) return;
  if (notifRecipientsState) {
    if (notifRecipientsState.insertedId) {
      await db.query('DELETE FROM company_settings WHERE id = $1', [notifRecipientsState.insertedId]);
    } else {
      await db.query('UPDATE company_settings SET notification_recipients = $1 WHERE id = $2',
        [JSON.stringify(notifRecipientsState.previous), notifRecipientsState.id]);
    }
  }
  require('../../lib/companyConfig').invalidate();
  await db.pool.end();
});

async function lead(key) {
  const r = await db.query(
    `INSERT INTO leads (first_name, last_name, owner_id, status, created_at) VALUES ($1, $2, $3, 'Appointment scheduled', '2096-01-01') RETURNING id`,
    [key, RUN, ownerId]
  );
  return r.rows[0].id;
}
async function appt(leadId, googleEventId) {
  const t = typeId['General Meeting'];
  const start = '2096-08-01T18:00:00Z';
  const r = await db.query(
    `INSERT INTO appointments (lead_id, owner_id, appointment_type_id, start_at, end_at, timezone, busy_range, status,
                                idempotency_key, calendar_sync_status, version, google_event_id)
     VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz + interval '1 hour', 'America/Los_Angeles',
             tstzrange($4::timestamptz - interval '1 hour', $4::timestamptz + interval '2 hour', '[)'),
             'scheduled', $5, 'synced', 1, $6) RETURNING id`,
    [leadId, ownerId, t, start, `${RUN}-${leadId}`, googleEventId]
  );
  return r.rows[0].id;
}

test('--verify-live reports an appointment whose LIVE Google event is missing a staff attendee, even though nothing in our own DB claims a problem', { skip }, async () => {
  const leadId = await lead(`missing-${RUN}`);
  const eventId = `${RUN}-ev-missing-attendee`;
  const apptId = await appt(leadId, eventId);
  google.events.set(eventId, { id: eventId, status: 'confirmed', attendees: [{ email: YARON, responseStatus: 'accepted' }] }); // michelle absent live

  const result = await auditScript.verifyLiveAttendees({ limit: 1000, delayMs: 0 });
  assert.ok(result.staff.includes(MICHELLE));
  const rec = result.records.find((r) => r.appointment_id === apptId);
  assert.ok(rec, 'flagged by the live check');
  assert.strictEqual(rec.live_status, 'attendee_missing');
  assert.ok(rec.live_missing_staff.includes(MICHELLE));
  assert.deepStrictEqual(rec.live_attendees.map((a) => a.email), [YARON]);
});

test('--verify-live reports an appointment whose event no longer exists on Google at all, distinctly from an attendee omission', { skip }, async () => {
  const leadId = await lead(`gone-${RUN}`);
  const eventId = `${RUN}-ev-deleted`;
  const apptId = await appt(leadId, eventId);
  // Deliberately never added to google.events -> getEvent returns exists:false.

  const result = await auditScript.verifyLiveAttendees({ limit: 1000, delayMs: 0 });
  const rec = result.records.find((r) => r.appointment_id === apptId);
  assert.ok(rec, 'flagged by the live check');
  assert.strictEqual(rec.live_status, 'event_missing');
  assert.deepStrictEqual(rec.live_missing_staff.sort(), result.staff.slice().sort());
});

test('--verify-live never reports an appointment whose live Google event already includes every configured staff member', { skip }, async () => {
  const leadId = await lead(`ok-${RUN}`);
  const eventId = `${RUN}-ev-ok`;
  const apptId = await appt(leadId, eventId);
  google.events.set(eventId, { id: eventId, status: 'confirmed', attendees: [{ email: YARON, responseStatus: 'accepted' }, { email: MICHELLE, responseStatus: 'needsAction' }] });

  const result = await auditScript.verifyLiveAttendees({ limit: 1000, delayMs: 0 });
  assert.ok(!result.records.some((r) => r.appointment_id === apptId), 'a correctly-synced live event is never reported');
});

test('--verify-live makes no write calls under any circumstance (getEvent only)', { skip }, async () => {
  const leadId = await lead(`readonly-${RUN}`);
  const eventId = `${RUN}-ev-readonly-check`;
  await appt(leadId, eventId); // never in google.events -> exercises the event_missing path too
  // The fake client throws if create/update/cancel are ever called; reaching
  // here without throwing across all prior tests already proves this, but
  // assert explicitly that the function completes normally one more time.
  await assert.doesNotReject(() => auditScript.verifyLiveAttendees({ limit: 1000, delayMs: 0 }));
});
