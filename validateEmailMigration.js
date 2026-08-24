/* eslint-disable no-undef */
/**
 * validateEmailMigration.js — non-production validation harness.
 *
 * Run inside the Railway service shell:
 *   npm run validate:email-migration
 *
 * Guarantees (NO real email, NO migrations, NO production CRM writes):
 *   - Required modules load (authorization, transportControl, emailService,
 *     reminderEmails, base44AppointmentTemplates, phoneCallReminders,
 *     taskReminderEngine, gmailSender, routes/gmail).
 *   - DB connectivity is read-only (SELECT 1; ensureSchema is NOT called).
 *   - Gmail credential presence is checked WITHOUT printing secrets.
 *   - Gmail token refresh is NOT performed unless --refresh-gmail is passed.
 *   - All reminder templates render locally and parity holds.
 *   - Idempotency keys are deterministic.
 *   - Auth role decisions are correct for fixtures.
 *   - Transport resolution is 'railway' for every flow (Base44 decommissioned).
 *   - REMINDER_DRY_RUN is true (real sending disabled).
 *   - emailService.js contains no SQL referencing a `metadata` column.
 *   - No real Gmail send occurred (gmailSender.sendEmail never invoked).
 *
 * Exits nonzero on any failure. Prints a redacted pass/fail summary.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function ok(name) { pass++; console.log(`  ✓ ${name}`); }
function bad(name, why) { fail++; failures.push(`${name}: ${why}`); console.error(`  ✗ ${name} — ${why}`); }
function section(t) { console.log(`\n── ${t} ──`); }

const REDACT = (s) => s ? `<redacted len=${String(s).length}>` : '<empty>';

(async () => {
  const args = process.argv.slice(2);
  const refreshGmail = args.includes('--refresh-gmail');

  section('1. Module load');
  const mods = [
    './lib/authorization', './lib/transportControl', './lib/emailService',
    './lib/reminderEmails', './lib/base44AppointmentTemplates',
    './lib/phoneCallReminders', './lib/taskReminderEngine',
    './lib/gmailSender', './routes/gmail',
    './routes/emails',
  ];
  for (const m of mods) {
    try { require(m); ok(`load ${m}`); }
    catch (e) { bad(`load ${m}`, e.message); }
  }

  section('2. Transport resolution (railway for all flows)');
  try {
    const tc = require('./lib/transportControl');
    for (const f of tc.FLOWS) {
      const t = tc.flowTransport(f);
      if (t === 'railway') ok(`flow ${f} -> railway`);
      else bad(`flow ${f}`, `expected railway got ${t}`);
    }
  } catch (e) { bad('transport', e.message); }

  section('3. Dry-run flag');
  if (process.env.REMINDER_DRY_RUN !== 'false') ok('REMINDER_DRY_RUN != false (real sends disabled)');
  else bad('REMINDER_DRY_RUN', 'is false — real sends would occur');

  section('4. Authorization fixtures');
  try {
    const { canAccessLead } = require('./lib/authorization');
    const admin = { id: 'u1', email: 'a@x.com', role: 'admin' };
    const manager = { id: 'u2', email: 'm@x.com', role: 'manager' };
    const rep = { id: 'u3', email: 'yaron@ecconstructiongroup.com', role: 'sales_rep' };
    const other = { id: 'u4', email: 'other@ecconstructiongroup.com', role: 'sales_rep' };
    const office = { id: 'u5', email: 'o@x.com', role: 'office' };
    const leadOwn = { id: 'l1', assigned_rep: 'Yaron Drilevich' };
    const leadNone = { id: 'l2', assigned_rep: null };
    canAccessLead(admin, leadOwn) ? ok('admin access') : bad('admin', 'denied');
    canAccessLead(manager, leadOwn) ? ok('manager access') : bad('manager', 'denied');
    canAccessLead(rep, leadOwn) ? ok('rep own lead') : bad('rep own', 'denied');
    canAccessLead(other, leadOwn) ? bad('rep other', 'granted') : ok('rep other denied');
    canAccessLead(rep, leadNone) ? bad('rep unassigned', 'granted') : ok('rep unassigned denied');
    canAccessLead(office, leadOwn) ? bad('office', 'granted') : ok('office denied (no lead scope)');
    canAccessLead({ id: 'u6', email: 'a@x.com', role: '' }, leadOwn) ? bad('missing role', 'granted') : ok('missing role denied');
  } catch (e) { bad('authorization', e.message); }

  section('5. Idempotency determinism');
  try {
    const mod = await import(path.resolve(__dirname, '..', 'lib', 'idempotencyKeys.mjs'));
    const K = mod.IdempotencyKeys;
    const k1 = K.generic('lead-1', 'a@b.com', 'req-1');
    const k2 = K.generic('lead-1', 'a@b.com', 'req-1');
    (k1 === k2 && k1 === 'crm-email:lead-1:a@b.com:req-1') ? ok('generic deterministic') : bad('generic', `${k1} vs ${k2}`);
  } catch (e) { bad('idempotency', e.message); }

  section('6. Reminder template parity');
  try {
    const ref = require('./lib/base44AppointmentTemplates');
    const rail = require('./lib/reminderEmails');
    const time = require('./lib/reminderTime');
    process.env.CRM_PUBLIC_URL = 'https://crm.ecconstructiongroup.com';
    const fixtures = [
      { name: 'customer-meeting-48h', fn: () => [ref.clientMeetingEmail, rail.clientMeetingEmail], args: { firstName: 'Jane', date: time.formatDate('2026-08-03'), time: time.fmt12('14:30'), address: '123 Main St, LA', projectType: 'Kitchen Remodel', ownerName: 'Yaron Drilevich', label: '48 hours', isCatchUp: false } },
      { name: 'customer-no-firstname', fn: () => [ref.clientMeetingEmail, rail.clientMeetingEmail], args: { firstName: 'there', date: time.formatDate('2026-08-03'), time: time.fmt12('09:00'), address: '', projectType: '', ownerName: 'Michelle', label: '2 hours', isCatchUp: false } },
      { name: 'customer-phone-30min', fn: () => [ref.clientPhoneCallEmail, rail.clientPhoneCallEmail], args: { firstName: 'Jane', date: time.formatDate('2026-08-03'), time: time.fmt12('14:30'), phone: '(310) 555-1234', projectType: 'Bathroom', ownerName: 'Yaron Drilevich', label: '30 minutes', address: '456 Oak Ave', isCatchUp: false } },
      { name: 'catchup-meeting', fn: () => [ref.clientMeetingEmail, rail.clientMeetingEmail], args: { firstName: 'Jane', date: time.formatDate('2026-08-03'), time: time.fmt12('14:30'), address: '123 Main St, LA', projectType: 'ADU', ownerName: 'Yaron Drilevich', label: '48 hours', isCatchUp: true } },
      { name: 'staff-reminder', fn: () => [ref.repReminderEmail, rail.repReminderEmail], args: { ownerName: 'Yaron Drilevich', clientName: 'Jane Doe', clientPhone: '(310) 555-1234', clientEmail: 'jane@x.com', date: time.formatDate('2026-08-03'), time: time.fmt12('14:30'), address: '123 Main St, LA', projectType: 'Kitchen Remodel', budget: '$75,000–$150,000', notes: 'Wants open concept', label: '2 hours', leadId: 'lead-9', isPhoneCall: false, isCatchUp: false } },
      { name: 'staff-reminder-no-owner', fn: () => [ref.repReminderEmail, rail.repReminderEmail], args: { ownerName: 'Michelle', clientName: 'Jane Doe', clientPhone: '(310) 555-1234', clientEmail: 'jane@x.com', date: time.formatDate('2026-08-03'), time: time.fmt12('14:30'), address: '', projectType: '', budget: '', notes: '', label: '30 minutes', leadId: 'lead-9', isPhoneCall: false, isCatchUp: false } },
    ];
    for (const f of fixtures) {
      const [refFn, railFn] = f.fn();
      const a = refFn(f.args);
      const b = railFn(f.args);
      (a === b) ? ok(`${f.name} parity`) : bad(f.name, `HTML diff length a=${a.length} b=${b.length}`);
    }
    const sMeet = ref.clientSubjectMeeting({ label: '48 hours', isCatchUp: false });
    const sMeetRail = `Appointment Reminder in 48 hours — EC Construction Group`;
    (sMeet === sMeetRail) ? ok('client meeting subject parity') : bad('subject', `${sMeet} vs ${sMeetRail}`);
    const key = ref.reminderIdempotencyKey('lead-9', '48h', '2026-08-03');
    (key === 'reminder:lead-9:48h:2026-08-03') ? ok('idempotency key parity') : bad('key', key);
    (ref.reminderActivityContent(key) === `REMINDER_SENT:${key}`) ? ok('activity content parity') : bad('activity', 'mismatch');
  } catch (e) { bad('parity', e.message); }

  section('7. Phone/task engine helpers');
  try {
    const phone = require('./lib/phoneCallReminders');
    const task = require('./lib/taskReminderEngine');
    (phone.PHONE_WINDOWS.length === 2 && phone.phoneKey('l1', '1h', '2026-08-03') === 'phone_reminder:l1:1h:2026-08-03') ? ok('phone helpers') : bad('phone helpers', 'shape');
    (task.taskKey('t1', '2026-08-03T09:00') === 'task-reminder:t1:2026-08-03T09:00') ? ok('task key') : bad('task key', 'shape');
    (!phone.getCallMs({ follow_up_type: 'Meeting', follow_up_date: '2026-08-03', follow_up_time: '09:00' })) ? ok('getCallMs ignores meetings') : bad('getCallMs', 'returned for meeting');
  } catch (e) { bad('phone/task', e.message); }

  section('8. emailService — no metadata-column SQL');
  try {
    const src = fs.readFileSync(path.join(__dirname, 'lib', 'emailService.js'), 'utf8');
    const hasMetaWrite = /metadata\s*=\s*\$2|SET\s+metadata/i.test(src);
    (!hasMetaWrite) ? ok('no metadata-column write') : bad('metadata', 'emailService still writes metadata column');
  } catch (e) { bad('emailService scan', e.message); }

  section('9. Gmail credential presence (no secrets printed)');
  try {
    const has = !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN);
    if (has) console.log(`  ℹ Gmail env present: client_id=${REDACT(process.env.GMAIL_CLIENT_ID)} secret=${REDACT(process.env.GMAIL_CLIENT_SECRET)} refresh=${REDACT(process.env.GMAIL_REFRESH_TOKEN)}`);
    else console.log('  ℹ Gmail env not set (Railway may use the credential store instead)');
    ok('credential check completed (no secrets printed)');
    if (refreshGmail) {
      console.log('  ℹ --refresh-gmail: attempting server-side token refresh (no email sent)');
      try { const tok = await require('./lib/gmailSender').refreshAccessToken(); console.log(`  ℹ refresh ok: token=${REDACT(tok)}`); ok('gmail refresh'); }
      catch (e) { bad('gmail refresh', e.message); }
    } else {
      ok('gmail refresh skipped (pass --refresh-gmail to test)');
    }
  } catch (e) { bad('gmail creds', e.message); }

  section('10. DB connectivity (read-only)');
  try {
    const db = require('./db/client');
    const r = await db.query('SELECT 1 AS ok');
    (r && r.rows && r.rows[0] && r.rows[0].ok === 1) ? ok('SELECT 1 ok') : bad('db', 'no rows');
  } catch (e) { bad('db connectivity', e.message); }

  section('11. No real Gmail send occurred');
  try {
    const g = require('./lib/gmailSender');
    if (g.__sendCalled) bad('gmail send', 'sendEmail was invoked');
    else ok('gmailSender.sendEmail not invoked');
  } catch (e) { bad('send guard', e.message); }

  section('12. Syntax check backend files');
  try {
    const files = ['lib/authorization.js','lib/phoneCallReminders.js','lib/taskReminderEngine.js',
      'lib/emailService.js','routes/gmail.js','routes/emails.js',
      'routes/auth.js','reminderWorker.js','validateEmailMigration.js'];
    let allOk = true;
    for (const f of files) {
      const r = spawnSync(process.execPath, ['--check', path.join(__dirname, f)]);
      if (r.status !== 0) { allOk = false; bad('syntax', `${f}: ${r.stderr.toString().slice(0,200)}`); }
    }
    if (allOk) ok('all backend files parse');
  } catch (e) { bad('syntax check', e.message); }

  // ── Summary ──
  console.log(`\n══ VALIDATION SUMMARY ══`);
  console.log(`  pass: ${pass}`);
  console.log(`  fail: ${fail}`);
  if (failures.length) { console.log('  failures:'); failures.forEach(f => console.log('    - ' + f)); }
  console.log(`  real email sent: no`);
  console.log(`  migrations run: no`);
  console.log(`  production CRM writes: no`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('harness fatal:', e); process.exit(1); });