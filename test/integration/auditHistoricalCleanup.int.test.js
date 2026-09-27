/* eslint-disable no-undef */
'use strict';

/**
 * auditHistoricalCleanup.int.test.js — REAL-Postgres proof of the historical
 * appointment/follow-up cleanup (scripts/auditAppointmentFollowUp.js).
 * Skipped without TEST_DATABASE_URL.
 *
 * Seeds the exact historical shapes found in production (incl. a replica of
 * the Charles Carlson lead) and runs the real script as a separate process:
 * report → apply → idempotent re-run → revert → re-apply. Proves that ONLY the
 * provenance-proven artifacts change, that everything else is untouched, and
 * that every change is recorded and reversible.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
const ROOT = path.join(__dirname, '..', '..');
const SINCE = '2099-01-01';
if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
}

let db, ownerId, typeId;
const RUN = `h${Date.now().toString(36)}`;
const ids = {};

function audit(extra = []) {
  const out = execFileSync(process.execPath, ['scripts/auditAppointmentFollowUp.js', '--json', `--since=${SINCE}`, ...extra],
    { cwd: ROOT, env: { ...process.env, DATABASE_URL: DB_URL }, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  return JSON.parse(out.slice(out.indexOf('{')));
}
const host = () => new URL(DB_URL).hostname;

async function lead(key, fu, extRef) {
  const r = await db.query(
    `INSERT INTO leads (first_name, last_name, owner_id, status, external_ref, created_at,
                        follow_up_date, follow_up_time, follow_up_type, follow_up_notes, follow_up_status)
     VALUES ($1, $2, $3, 'Lost', $4, '2099-06-01', $5, $6, $7, $8, $9) RETURNING id`,
    [key, RUN, ownerId, extRef || null, fu.date || null, fu.time || null, fu.type || null, fu.notes || null, fu.status || null]);
  ids[key] = r.rows[0].id;
  return r.rows[0].id;
}
async function appt(leadId, { start, minutes = 60, buffered, type = 'General Meeting', key, createdEventAt, googleId, status = 'scheduled' }) {
  const t = typeId[type];
  const r = await db.query(
    `INSERT INTO appointments (lead_id, owner_id, appointment_type_id, start_at, end_at, timezone, busy_range, status,
                               idempotency_key, calendar_sync_status, override_conflict, google_event_id)
     VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz + make_interval(mins => $5), 'America/Los_Angeles',
             CASE WHEN $6 THEN tstzrange($4::timestamptz - interval '1 hour', $4::timestamptz + make_interval(mins => $5) + interval '1 hour', '[)')
                  ELSE tstzrange($4::timestamptz, $4::timestamptz + make_interval(mins => $5), '[)') END,
             $9, $7, 'pending', true, $8) RETURNING id`,
    [leadId, ownerId, t, start, minutes, !!buffered, key || `${RUN}-${Math.random()}`, googleId || null, status]);
  if (createdEventAt) {
    await db.query(`INSERT INTO appointment_events (appointment_id, actor, action, new_values, created_at) VALUES ($1, 'booking', 'created', '{}', $2)`,
      [r.rows[0].id, createdEventAt]);
  }
  return r.rows[0].id;
}
const leadRow = async (k) => (await db.query(`SELECT follow_up_date, follow_up_time, follow_up_type, follow_up_status, follow_up_notes FROM leads WHERE id = $1`, [ids[k]])).rows[0];
const rangeOf = async (id) => (await db.query(`SELECT lower(busy_range) = start_at AS unbuffered FROM appointments WHERE id = $1`, [id])).rows[0].unbuffered;

test.before(async () => {
  if (skip) return;
  db = require(path.join(ROOT, 'db/client'));
  await db.query(`INSERT INTO owners (email, display_name) VALUES ('ethan.test@ecconstructiongroup.com', 'Ethan Test') ON CONFLICT DO NOTHING`);
  ownerId = (await db.query(`SELECT id FROM owners WHERE email = 'ethan.test@ecconstructiongroup.com'`)).rows[0].id;
  typeId = Object.fromEntries((await db.query(`SELECT name, id FROM appointment_types`)).rows.map(r => [r.name, r.id]));
  // Isolate from earlier runs of this file: everything else seeded under SINCE is ours.
  await db.query(`UPDATE leads SET created_at = '2090-01-01' WHERE created_at >= $1`, [SINCE]);
  await db.query(`UPDATE appointments SET idempotency_key = 'old-' || idempotency_key WHERE idempotency_key LIKE 'migration:appt:%'`);

  // 1. Charles Carlson replica: Base44 follow-up Meeting 2025-06-03 (no time → 00:00); migration built the
  //    appointment from it (General Meeting, -07:00, unbuffered → reads 'Phone Call').
  const c = await lead('charles', { date: '2025-06-03', time: '00:00', type: 'Meeting', status: 'pending' }, `b44-charles-${RUN}`);
  ids.charlesAppt = await appt(c, { start: '2025-06-03T00:00:00-07:00', type: 'General Meeting', key: `migration:appt:b44-charles-${RUN}` });
  // 2. Winter migration row: fixed -07:00 lands 1h off Pacific (PST) → different_time, still the migration source.
  const w = await lead('winter', { date: '2025-01-15', time: '10:00 AM', type: 'Meeting' }, `b44-winter-${RUN}`);
  ids.winterAppt = await appt(w, { start: '2025-01-15T10:00:00-07:00', type: 'General Meeting', key: `migration:appt:b44-winter-${RUN}` });
  // 3. Migration Phone Call follow-up → Consultation row (kind Phone Call) → exact MIRROR.
  const p = await lead('migPhone', { date: '2025-05-01', time: '14:00', type: 'Phone Call' }, `b44-phone-${RUN}`);
  ids.migPhoneAppt = await appt(p, { start: '2025-05-01T14:00:00-07:00', type: 'Consultation', key: `migration:appt:b44-phone-${RUN}` });
  // 4. Pre-separation booking mirror (buffered Meeting, booked before 2516ff8).
  const b = await lead('preMirror', { date: '2026-08-10', time: '16:00', type: 'Meeting' });
  await appt(b, { start: '2026-08-10T16:00:00-07:00', buffered: true, type: 'Consultation', createdEventAt: '2026-08-01T10:00:00Z' });
  // 5. Pre-separation Phone Call booking + hard-coded 'Meeting' follow-up.
  const pc = await lead('prePhone', { date: '2026-08-11', time: '09:30', type: 'Meeting' });
  await appt(pc, { start: '2026-08-11T09:30:00-07:00', buffered: false, type: 'Consultation', createdEventAt: '2026-08-02T10:00:00Z' });
  // 6. Post-separation exact match — could be user-entered → never auto-cleared.
  const u = await lead('postMirror', { date: '2026-10-20', time: '11:00', type: 'Meeting' });
  await appt(u, { start: '2026-10-20T11:00:00-07:00', buffered: true, type: 'Consultation', createdEventAt: '2026-09-26T10:00:00Z' });
  // 7. Genuinely different next step.
  const d = await lead('realNext', { date: '2026-10-25', time: '10:00', type: 'Phone Call' });
  await appt(d, { start: '2026-10-20T15:00:00-07:00', buffered: true, type: 'Consultation', createdEventAt: '2026-09-26T11:00:00Z' });
  // 8. Migration source but the user annotated the follow-up → untouched.
  const n = await lead('noted', { date: '2025-03-03', time: '13:00', type: 'Meeting', notes: 'Customer asked to bring samples' }, `b44-noted-${RUN}`);
  ids.notedAppt = await appt(n, { start: '2025-03-03T13:00:00-07:00', type: 'General Meeting', key: `migration:appt:b44-noted-${RUN}` });
  // 9. Future migrated Meeting (no follow-up) → kind reported unsafe, never changed.
  const f = await lead('future', {}, `b44-future-${RUN}`);
  ids.futureAppt = await appt(f, { start: '2031-02-02T10:00:00-07:00', type: 'General Meeting', key: `migration:appt:b44-future-${RUN}` });
  // 10. Legitimate follow-up without appointment.
  await lead('fuOnly', { date: '2026-11-01', time: '10:00', type: 'Meeting' });
  // 11. Orphaned type.
  await lead('orphan', { type: 'Meeting' });
  // 12. Past migrated Meeting already on Google → kind reported unsafe.
  const g = await lead('onGoogle', {}, `b44-google-${RUN}`);
  ids.googleAppt = await appt(g, { start: '2025-02-02T10:00:00-07:00', type: 'General Meeting', key: `migration:appt:b44-google-${RUN}`, googleId: 'evt123' });
});

test.after(async () => { if (!skip) await db.pool.end(); });

let applyRun;
test('H1. report-only classifies every historical shape by provenance and changes nothing', { skip }, async () => {
  const before = await leadRow('charles');
  const r = audit();
  assert.strictEqual(r.mode, 'report-only');
  const sub = Object.fromEntries(r.records.filter(x => x.lead_id && x.follow_up).map(x => [x.name.split(' ')[0], [x.sub, x.apply]]));
  assert.deepStrictEqual(sub.charles, ['DIV_MIGRATION_SOURCE', true]);
  assert.deepStrictEqual(sub.winter, ['DIV_MIGRATION_SOURCE', true]);
  assert.deepStrictEqual(sub.migPhone, ['MIRROR', true]);
  assert.deepStrictEqual(sub.preMirror, ['MIRROR', true]);
  assert.deepStrictEqual(sub.prePhone, ['DIV_PRE_SEPARATION_MIRROR', true]);
  assert.deepStrictEqual(sub.postMirror, ['MIRROR_UNPROVEN', false]);
  assert.deepStrictEqual(sub.realNext, ['DIV_OTHER', false]);
  assert.deepStrictEqual(sub.noted, ['DIV_MIGRATION_SOURCE', false], 'annotated follow-up is never cleared');
  assert.deepStrictEqual(sub.fuOnly, ['FOLLOWUP_ONLY', false]);
  assert.deepStrictEqual(sub.orphan, ['ORPHANED_TYPE', true]);
  const kinds = Object.fromEntries(r.records.filter(x => x.appointment_id).map(x => [x.appointment_id, [x.sub, x.apply]]));
  assert.deepStrictEqual(kinds[ids.charlesAppt], ['MIGRATED_KIND', true]);
  assert.deepStrictEqual(kinds[ids.winterAppt], ['MIGRATED_KIND', true]);
  assert.deepStrictEqual(kinds[ids.futureAppt], ['MIGRATED_KIND_UNSAFE', false]);
  assert.deepStrictEqual(kinds[ids.googleAppt], ['MIGRATED_KIND_UNSAFE', false]);
  assert.strictEqual(kinds[ids.migPhoneAppt], undefined, "Consultation rows are never re-kinded");
  assert.ok(r.backup.length >= 8 && r.revert_sql.length === r.backup.length, 'before-image backup + revert SQL for every candidate');
  assert.deepStrictEqual(await leadRow('charles'), before, 'report-only wrote nothing');
});

test('H2. --apply requires the matching --confirm-host', { skip }, () => {
  assert.throws(() => audit(['--apply', '--confirm-host=wrong-host']), /Command failed/);
});

test('H3. --apply changes ONLY the proven artifacts; Charles no longer has a false Meeting follow-up', { skip }, async () => {
  const r = audit(['--apply', `--confirm-host=${host()}`]);
  applyRun = r.run_id;
  assert.ok(applyRun);
  assert.ok(!Object.keys(r.applied).some(k => k.endsWith(':error')), JSON.stringify(r.applied));
  for (const k of ['charles', 'winter', 'migPhone', 'preMirror', 'prePhone']) {
    const l = await leadRow(k);
    assert.deepStrictEqual([l.follow_up_date, l.follow_up_type, l.follow_up_time], [null, null, null], `${k} follow-up cleared`);
  }
  assert.strictEqual((await leadRow('orphan')).follow_up_type, null);
  // Untouched.
  assert.strictEqual((await leadRow('postMirror')).follow_up_type, 'Meeting');
  assert.strictEqual((await leadRow('realNext')).follow_up_type, 'Phone Call');
  assert.strictEqual((await leadRow('noted')).follow_up_notes, 'Customer asked to bring samples');
  assert.strictEqual((await leadRow('fuOnly')).follow_up_type, 'Meeting');
  // Kind fixed only for past, never-synced migration Meetings.
  assert.strictEqual(await rangeOf(ids.charlesAppt), false, 'Charles appointment now carries the Meeting buffer');
  assert.strictEqual(await rangeOf(ids.futureAppt), true, 'future migrated appointment untouched');
  assert.strictEqual(await rangeOf(ids.googleAppt), true, 'Google-synced appointment untouched');
  assert.strictEqual(await rangeOf(ids.notedAppt), false, 'past migration meeting re-kinded even though its follow-up was kept');
  // Appointments themselves never deleted/cancelled/moved.
  const a = (await db.query(`SELECT status, start_at FROM appointments WHERE id = $1`, [ids.charlesAppt])).rows[0];
  assert.strictEqual(a.status, 'scheduled');
  assert.strictEqual(new Date(a.start_at).toISOString(), '2025-06-03T07:00:00.000Z');
  // Evidence recorded.
  const ev = (await db.query(`SELECT count(*)::int n FROM appointment_events WHERE actor = $1`, [`audit:appointment-followup:${applyRun}`])).rows[0].n;
  assert.ok(ev >= 7, `evidence rows: ${ev}`);
  // What Lead Detail now shows for Charles: an appointment (Meeting, history kept), no overdue follow-up.
  const { serializeAppointment } = require(path.join(ROOT, 'lib/booking/appointmentView'));
  const row = (await db.query(`SELECT * FROM appointments WHERE id = $1`, [ids.charlesAppt])).rows[0];
  const s = serializeAppointment(row);
  assert.deepStrictEqual([s.date, s.time, s.kind], ['2025-06-03', '00:00', 'Meeting']);
});

test('H4. idempotent: a second --apply finds nothing left to change', { skip }, () => {
  const r = audit(['--apply', `--confirm-host=${host()}`]);
  assert.deepStrictEqual(r.apply_candidates, {});
  assert.deepStrictEqual(r.applied, {});
});

test('H5. --revert restores exactly the previous values; re-apply is clean again', { skip }, async () => {
  const out = execFileSync(process.execPath, ['scripts/auditAppointmentFollowUp.js', `--revert=${applyRun}`, `--confirm-host=${host()}`],
    { cwd: ROOT, env: { ...process.env, DATABASE_URL: DB_URL } }).toString();
  const rv = JSON.parse(out.slice(out.indexOf('{')));
  assert.ok(rv.results.length >= 7 && rv.results.every(x => x.result === 'reverted'), JSON.stringify(rv.results));
  assert.deepStrictEqual(await leadRow('charles'),
    { follow_up_date: '2025-06-03', follow_up_time: '00:00', follow_up_type: 'Meeting', follow_up_status: 'pending', follow_up_notes: null });
  assert.strictEqual((await leadRow('winter')).follow_up_time, '10:00 AM');
  assert.strictEqual((await leadRow('orphan')).follow_up_type, 'Meeting');
  assert.strictEqual(await rangeOf(ids.charlesAppt), true, 'busy_range restored');
  const again = audit(['--apply', `--confirm-host=${host()}`]);
  assert.ok(!Object.keys(again.applied).some(k => k.endsWith(':error')));
  assert.deepStrictEqual((await leadRow('charles')).follow_up_type, null);
});
