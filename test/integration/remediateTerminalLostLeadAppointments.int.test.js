/* eslint-disable no-undef */
'use strict';

/**
 * remediateTerminalLostLeadAppointments.int.test.js — REAL-Postgres proof of
 * scripts/remediateTerminalLostLeadAppointments.js: the one-time (re-runnable)
 * backfill for leads that were ALREADY in a terminal-lost status (Lost/Closed
 * Lost/DNQ/Cancelled) before the Closed-Lost transition handler existed, or
 * before it was generalized beyond the single 'Closed Lost' literal (the
 * production bug: lead "Rita Wilcher" was 'Lost', not 'Closed Lost') — and
 * therefore still carry a stale active appointment and/or a stale follow-up.
 *
 * Seeds historical rows directly via SQL (bypassing the API, since the
 * script's whole purpose is to repair data the live write paths never
 * touched), then runs the real script as a separate process: report-only,
 * then --apply, then an idempotent re-run. Skipped without TEST_DATABASE_URL.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
const ROOT = path.join(__dirname, '..', '..');
const SINCE = '2098-01-01';
if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
}

let db, ownerId, typeId, googleModulesState;
const RUN = `r${Date.now().toString(36)}`;

function runScript(extra = []) {
  const out = execFileSync(process.execPath, ['scripts/remediateTerminalLostLeadAppointments.js', '--json', `--since=${SINCE}`, ...extra],
    { cwd: ROOT, env: { ...process.env, DATABASE_URL: DB_URL }, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  return JSON.parse(out.slice(out.indexOf('{')));
}
const host = () => new URL(DB_URL).hostname;

async function lead(key, status, fu) {
  const r = await db.query(
    `INSERT INTO leads (first_name, last_name, owner_id, status, created_at,
                         follow_up_date, follow_up_time, follow_up_type, follow_up_notes, follow_up_status)
     VALUES ($1, $2, $3, $4, '2099-06-01', $5, $6, $7, $8, $9) RETURNING id`,
    [key, RUN, ownerId, status,
     (fu && fu.date) || null, (fu && fu.time) || null, (fu && fu.type) || null, (fu && fu.notes) || null, (fu && fu.status) || null]
  );
  return r.rows[0].id;
}
async function appt(leadId, { start = '2099-07-01T18:00:00Z', status = 'scheduled', type = 'General Meeting' } = {}) {
  const t = typeId[type];
  const r = await db.query(
    `INSERT INTO appointments (lead_id, owner_id, appointment_type_id, start_at, end_at, timezone, busy_range, status,
                                idempotency_key, calendar_sync_status, version)
     VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz + interval '1 hour', 'America/Los_Angeles',
             tstzrange($4::timestamptz - interval '1 hour', $4::timestamptz + interval '2 hour', '[)'),
             $5, $6, 'synced', 1) RETURNING id, version`,
    [leadId, ownerId, t, start, status, `${RUN}-${leadId}-${Math.random()}`]
  );
  return r.rows[0];
}
const leadRow = async (id) => (await db.query(
  `SELECT status, follow_up_date, follow_up_time, follow_up_type, follow_up_notes, follow_up_status FROM leads WHERE id = $1`, [id]
)).rows[0];
const apptRow = async (id) => (await db.query(`SELECT status, version FROM appointments WHERE id = $1`, [id])).rows[0];
const activitiesOf = async (leadId) => (await db.query(`SELECT content FROM activities WHERE lead_id = $1 ORDER BY created_at`, [leadId])).rows;
const reminderRowOf = async (leadId) => (await db.query(`SELECT * FROM reminder_leads WHERE id = $1`, [leadId])).rows[0];

test.before(async () => {
  if (skip) return;
  db = require(path.join(ROOT, 'db/client'));
  googleModulesState = await require('./ensureGoogleModulesEnabled').ensureGoogleModulesEnabled(db);
  await db.query(`INSERT INTO owners (email, display_name) VALUES ('remediate.test@ecconstructiongroup.com', 'Remediate Test') ON CONFLICT DO NOTHING`);
  ownerId = (await db.query(`SELECT id FROM owners WHERE email = 'remediate.test@ecconstructiongroup.com'`)).rows[0].id;
  typeId = Object.fromEntries((await db.query(`SELECT name, id FROM appointment_types`)).rows.map(r => [r.name, r.id]));
});
test.after(async () => {
  if (skip) return;
  await require('./ensureGoogleModulesEnabled').restoreGoogleModules(db, googleModulesState);
  await db.pool.end();
});

test('report-only mode (no --apply) never changes anything, and lists exactly the leads that need remediation', { skip }, async () => {
  const lostWithAppt = await lead(`lost-appt-${RUN}`, 'Lost');
  const a = await appt(lostWithAppt);
  const closedLostWithFollowUp = await lead(`cl-fu-${RUN}`, 'Closed Lost', { date: '2099-08-01', time: '10:00', type: 'Phone Call', status: 'pending' });
  const soldWithAppt = await lead(`sold-${RUN}`, 'Sold');
  await appt(soldWithAppt);

  const report = runScript();
  assert.strictEqual(report.mode, 'report-only');
  const ids = report.records.map(r => r.lead_id);
  assert.ok(ids.includes(lostWithAppt), "a 'Lost' lead with an active appointment is reported");
  assert.ok(ids.includes(closedLostWithFollowUp), "a 'Closed Lost' lead with a stale follow-up is reported");
  assert.ok(!ids.includes(soldWithAppt), "a 'Sold' lead (positive outcome) is NEVER reported, even with an active appointment");

  // Nothing changed.
  assert.strictEqual((await apptRow(a.id)).status, 'scheduled');
  const fu = await leadRow(closedLostWithFollowUp);
  assert.strictEqual(fu.follow_up_date.toISOString ? fu.follow_up_date.toISOString().slice(0, 10) : fu.follow_up_date, '2099-08-01');
});

test('--apply without --confirm-host refuses and changes nothing', { skip }, async () => {
  const lostWithAppt = await lead(`refuse-${RUN}`, 'Lost');
  const a = await appt(lostWithAppt);
  assert.throws(() => runScript(['--apply']), /confirm-host/);
  assert.strictEqual((await apptRow(a.id)).status, 'scheduled', 'refused apply must not touch the appointment');
});

test("--apply cancels the active appointment for 'Lost' (the real-world Rita Wilcher case) through the canonical bookingService path", { skip }, async () => {
  const leadId = await lead(`apply-lost-${RUN}`, 'Lost');
  const a = await appt(leadId);

  const report = runScript(['--apply', `--confirm-host=${host()}`]);
  assert.strictEqual(report.mode, 'apply');
  const rec = report.records.find(r => r.lead_id === leadId);
  assert.ok(rec, 'the lead appears in the apply report');
  assert.deepStrictEqual(rec.apply_result.cancelled, [a.id]);
  assert.deepStrictEqual(rec.apply_result.failures, []);

  const after = await apptRow(a.id);
  assert.strictEqual(after.status, 'cancelled', 'appointment is cancelled via the real cancellation path (version bumped by bookingService)');
  assert.strictEqual(after.version, 2, 'version was bumped by bookingService.cancelAppointment, proving the canonical path ran (not a raw UPDATE)');

  const acts = await activitiesOf(leadId);
  assert.ok(acts.some(x => /Terminal-lost remediation/.test(x.content) && /cancelled/.test(x.content)), 'audit note recorded');

  const rl = await reminderRowOf(leadId);
  assert.ok(!rl || rl.appointment_date === null, 'reminder_leads projection cleared after remediation');
});

test("--apply clears a stale follow-up for 'DNQ' and 'Cancelled' leads (the other TERMINAL_LOST_STATUSES values)", { skip }, async () => {
  const dnqId = await lead(`apply-dnq-${RUN}`, 'DNQ', { date: '2099-09-01', time: '09:00', type: 'Email', status: 'pending' });
  const cancelledId = await lead(`apply-cancelled-${RUN}`, 'Cancelled', { date: '2099-09-02', time: '11:00', type: 'Text', status: 'pending' });

  const report = runScript(['--apply', `--confirm-host=${host()}`]);
  for (const leadId of [dnqId, cancelledId]) {
    const rec = report.records.find(r => r.lead_id === leadId);
    assert.ok(rec, `lead ${leadId} appears in the apply report`);
    assert.strictEqual(rec.apply_result.cleared_follow_up, true);
    const row = await leadRow(leadId);
    assert.deepStrictEqual(
      [row.follow_up_date, row.follow_up_time, row.follow_up_type, row.follow_up_notes, row.follow_up_status],
      [null, null, null, null, null],
      'the whole follow-up is force-cleared, matching the live transition handler exactly'
    );
  }
});

test('a genuinely completed appointment on a terminal-lost lead is NEVER touched by --apply', { skip }, async () => {
  const leadId = await lead(`completed-${RUN}`, 'Lost');
  const a = await appt(leadId, { status: 'completed' });

  const report = runScript(['--apply', `--confirm-host=${host()}`]);
  // Not reported at all — the lead has no active appointment and no follow-up.
  assert.ok(!report.records.some(r => r.lead_id === leadId), 'a lead whose only appointment is already completed is never flagged');

  const after = await apptRow(a.id);
  assert.strictEqual(after.status, 'completed', 'completed appointment is preserved exactly as history');
  assert.strictEqual(after.version, 1, 'no version bump — truly untouched');
});

test('idempotent re-run: after a successful --apply, running again finds nothing left to do for the same leads', { skip }, async () => {
  const leadId = await lead(`idempotent-${RUN}`, 'Closed Lost');
  await appt(leadId);

  const first = runScript(['--apply', `--confirm-host=${host()}`]);
  assert.ok(first.records.some(r => r.lead_id === leadId));

  const second = runScript(['--apply', `--confirm-host=${host()}`]);
  assert.ok(!second.records.some(r => r.lead_id === leadId), 'second run finds nothing for this lead — no duplicate cancel attempt, no duplicate audit note');

  const acts = await activitiesOf(leadId);
  assert.strictEqual(acts.filter(a => /Terminal-lost remediation/.test(a.content)).length, 1, 'exactly one remediation note, not one per run');
});
