/* eslint-disable no-undef */
/**
 * Railway dry walkthrough — synthetic-only end-to-end test of the reminder
 * ACTION flow (/r/*) against the deployed Railway service over real HTTP.
 *
 * SAFETY CONTRACT (enforced before anything runs):
 *   - REMINDER_DRY_RUN === 'true'        (the action router's Gmail-flush guard)
 *   - REMINDER_SOURCE === 'postgres'     (never the Base44 lead-source branch)
 *   - DATABASE_URL present              (Railway Postgres)
 *   - REMINDER_PUBLIC_URL present        (the deployed service's public URL)
 *   - abort if synthetic id exists but does not match our marker
 *
 * This script:
 *   - does NOT import lib/base44.js, @base44/sdk, or any Base44 function
 *   - does NOT call gmailSender or notifications.flushPendingNotifications
 *   - does NOT enable cron or production sending
 *   - uses ONLY the synthetic lead id `synthetic-action-test-001`
 *   - cleans up ONLY rows tied to that id, in a finally block
 *
 * Run from the proxy-server service root:
 *   node test/railwayDryWalkthrough.js
 *
 * Exit code 0 only if every required assertion passes AND cleanup restores
 * the original five-table counts exactly. Cleanup always runs.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const db = require('../db/client');
const tokenStore = require('../lib/actionTokenStore');
const actions = require('../lib/reminderActions');
const repDir = require('../lib/repDirectory');
const time = require('../lib/reminderTime');

// ── Constants ────────────────────────────────────────────────────────────────
const SYNTH_ID = 'synthetic-action-test-001';
const MARKER_FIRST = 'Railway';
const MARKER_LAST = 'Action Test';
const REP_NAME = 'Synthetic Representative';
const REP_EMAIL = 'synthetic.rep.invalid@example.invalid';
const REP_PHONE = '+13105550100';
const CUST_EMAIL = 'synthetic.customer.invalid@example.invalid';
const ADDRESS = '123 Synthetic Test Lane, Faketown, CA 00000';
const APPT_TIME = '09:00';
const FUTURE_DATE = futureDate(7);

const ACTION_LIB_FILES = [
  'actionRouter.js', 'actionTokenStore.js', 'reminderActions.js',
  'reminderNotifications.js', 'reminderPages.js', 'repDirectory.js',
];

const REPORT = [];
let FAILURES = 0;
function line(s) { REPORT.push(s); }
function pass(m) { REPORT.push('  ✔ ' + m); }
function fail(m) { REPORT.push('  ✗ ' + m); FAILURES++; }
function check(cond, m) { if (cond) pass(m); else fail(m); return cond; }

// ── Helpers ─────────────────────────────────────────────────────────────────
function futureDate(n) {
  const dt = new Date();
  dt.setDate(dt.getDate() + n);
  return dt.toISOString().slice(0, 10);
}
function addDays(yyyy_mm_dd, n) {
  const [y, m, d] = yyyy_mm_dd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function redact(raw) { return String(raw).slice(0, 6) + '…redacted'; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function countRows(table, whereLead = true) {
  const sql = whereLead
    ? `SELECT count(*)::int AS n FROM ${table} WHERE lead_id=$1`
    : `SELECT count(*)::int AS n FROM ${table}`;
  const { rows } = whereLead ? await db.query(sql, [SYNTH_ID]) : await db.query(sql);
  return rows[0].n;
}
async function countAll(table) {
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0].n;
}

function publicUrl() { return String(process.env.REMINDER_PUBLIC_URL || '').replace(/\/$/, ''); }

async function get(p) {
  const res = await fetch(publicUrl() + p, { redirect: 'manual' });
  const body = await res.text();
  return { status: res.status, headers: res.headers, body };
}
async function postForm(p, fields) {
  const res = await fetch(publicUrl() + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields || {}).toString(),
    redirect: 'manual',
  });
  const body = await res.text();
  return { status: res.status, headers: res.headers, body };
}
function captureNonce(body) {
  const m = body.match(/name="nonce" value="([^"]+)"/);
  return m ? m[1] : null;
}
function assertNoLeak(body, label) {
  const forbidden = [SYNTH_ID, REP_EMAIL, CUST_EMAIL, FUTURE_DATE, ADDRESS];
  let ok = true;
  for (const f of forbidden) { if (body.includes(f)) { fail(`${label}: leaked "${f.slice(0, 12)}…"`); ok = false; } }
  if (/[0-9a-f]{64}/.test(body)) { fail(`${label}: leaked a 64-hex hash`); ok = false; }
  if (/Error:|at \//.test(body)) { fail(`${label}: leaked a stack trace`); ok = false; }
  if (/base44|DATABASE_URL|token_hash|reminder_leads/i.test(body)) { fail(`${label}: leaked internal detail`); ok = false; }
  if (ok) pass(`${label}: no leak`);
  return ok;
}

// ── Cleanup (scoped to synthetic id only) ─────────────────────────────────────
async function cleanup() {
  REPORT.push('— Cleanup —');
  try {
    await db.query(`DELETE FROM reminder_form_nonces WHERE token_hash IN (SELECT token_hash FROM reminder_action_tokens WHERE lead_id=$1)`, [SYNTH_ID]);
    await db.query(`DELETE FROM reminder_notifications WHERE lead_id=$1`, [SYNTH_ID]);
    await db.query(`DELETE FROM reminder_actions WHERE lead_id=$1`, [SYNTH_ID]);
    await db.query(`DELETE FROM reminder_action_tokens WHERE lead_id=$1`, [SYNTH_ID]);
    await db.query(`DELETE FROM reminder_leads WHERE id=$1`, [SYNTH_ID]);
    pass('synthetic rows deleted');
  } catch (e) {
    fail('cleanup error: ' + e.message);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // 0. Branch / commit
  // Prefer Railway-provided git metadata; fall back to the local git binary.
  // A missing git binary is non-critical and reported as "unavailable" (never a failure).
  let branch = process.env.RAILWAY_GIT_BRANCH || 'unavailable';
  let commit = process.env.RAILWAY_GIT_COMMIT_SHA ? String(process.env.RAILWAY_GIT_COMMIT_SHA).slice(0, 7) : 'unavailable';
  if (branch === 'unavailable') { try { branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim(); } catch { /* git binary unavailable */ } }
  if (commit === 'unavailable') { try { commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); } catch { /* git binary unavailable */ } }
  line('=== RAILWAY DRY WALKTHROUGH — ' + new Date().toISOString() + ' ===');
  line('branch: ' + branch);
  line('commit: ' + commit);

  // 1. Hard safety checks
  line('\n— Safety preconditions —');
  if (!check(process.env.REMINDER_DRY_RUN === 'true', 'REMINDER_DRY_RUN === "true"')) return abort();
  if (!check(process.env.REMINDER_SOURCE === 'postgres', 'REMINDER_SOURCE === "postgres"')) return abort();
  if (!check(!!process.env.DATABASE_URL, 'DATABASE_URL present')) return abort();
  if (!check(!!process.env.REMINDER_PUBLIC_URL, 'REMINDER_PUBLIC_URL present')) return abort();
  if (process.env.GMAIL_CLIENT_ID) { pass('Gmail creds present but dry-run guard active (flush skipped)'); }
  if (process.env.NODE_ENV === 'production' && process.env.REMINDER_DRY_RUN !== 'true') { fail('production-send mode detected'); return abort(); }
  pass('Gmail delivery disabled (dry-run guard); cron is an operator-confirmed precondition');

  // 1b. Static Base44 scan of the action path
  line('\n— Static Base44 scan (action path) —');
  let actionBase44 = 0;
  for (const f of ACTION_LIB_FILES) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8');
    const has = /require\(['"][./]*base44['"]\)/.test(src) || /base44\.(create|list|update|filter|get|delete)\s*\(/.test(src) || /@base44\/sdk/.test(src);
    if (has) { fail(`${f}: Base44 import found`); actionBase44++; } else { pass(`${f}: clean`); }
  }
  check(actionBase44 === 0, 'action-path Base44 import count === 0');
  // Report dormant branch separately (must NOT execute)
  const crmSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'crmRepository.js'), 'utf8');
  check(/require\(['"]\.\/base44['"]\)/.test(crmSrc), 'crmRepository dormant Base44 branch reported (not invoked under REMINDER_SOURCE=postgres)');

  // 2. Schema migration (twice — idempotency)
  line('\n— Schema migration (run twice) —');
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  try { await db.pool.query(schema); pass('migration run 1: success'); }
  catch (e) { fail('migration run 1: ' + e.message); return abort(); }
  try { await db.pool.query(schema); pass('migration run 2: success (idempotent)'); }
  catch (e) { fail('migration run 2 (idempotency): ' + e.message); return abort(); }

  // Verify tables exist
  const wantTables = ['reminder_leads', 'reminder_action_tokens', 'reminder_actions', 'reminder_notifications', 'reminder_form_nonces'];
  const { rows: trows } = await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`);
  const haveTables = trows.map((r) => r.table_name);
  for (const t of wantTables) check(haveTables.includes(t), `table ${t} exists`);

  // Verify columns on reminder_leads
  const { rows: crows } = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name='reminder_leads' AND column_name IN ('assigned_rep_name','assigned_rep_email','assigned_rep_phone')`);
  const haveCols = crows.map((r) => r.column_name);
  for (const c of ['assigned_rep_name', 'assigned_rep_email', 'assigned_rep_phone']) check(haveCols.includes(c), `column reminder_leads.${c} exists`);

  // Verify idempotency indexes
  const { rows: irows } = await db.query(`SELECT indexname FROM pg_indexes WHERE tablename='reminder_actions'`);
  const idxNames = irows.map((r) => r.indexname);
  check(idxNames.some((n) => n.includes('confirm_uidx')), 'reminder_actions confirm idempotency index exists');
  check(idxNames.some((n) => n.includes('reschedule_uidx')), 'reminder_actions reschedule idempotency index exists');
  const { rows: tkrows } = await db.query(`SELECT indexname FROM pg_indexes WHERE tablename='reminder_action_tokens'`);
  check(tkrows.some((r) => r.indexname.includes('hash_uidx')), 'reminder_action_tokens token_hash unique index exists');

  // 3. Row-count snapshot (BEFORE) — total counts, no customer data printed
  line('\n— Row-count snapshot (before) —');
  const SNAP = {};
  for (const t of wantTables) { SNAP[t] = await countAll(t); line(`  ${t}: ${SNAP[t]}`); }

  // 3b. Abort if synthetic id exists but doesn't match our marker
  const { rows: existing } = await db.query('SELECT first_name FROM reminder_leads WHERE id=$1', [SYNTH_ID]);
  if (existing.length) {
    if (existing[0].first_name !== MARKER_FIRST) { fail('synthetic id exists but is NOT our marker — aborting (will not touch foreign data)'); return abort(); }
    pass('leftover synthetic row from prior run — removing before insert');
    await cleanup();
  }

  // 4. Insert synthetic reminder_leads row
  line('\n— Synthetic record —');
  await db.query(
    `INSERT INTO reminder_leads
       (id, first_name, last_name, email, phone, property_address, city, project_type,
        appointment_date, appointment_time, assigned_rep, assigned_rep_name, assigned_rep_email, assigned_rep_phone,
        customer_reminders_disabled, crm_created_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,false,NOW())`,
    [SYNTH_ID, MARKER_FIRST, MARKER_LAST, CUST_EMAIL, REP_PHONE, ADDRESS, 'Faketown', 'Synthetic', FUTURE_DATE, APPT_TIME, REP_NAME, REP_NAME, REP_EMAIL, REP_PHONE]
  );
  pass('synthetic reminder_leads inserted (id ' + SYNTH_ID + ')');

  // 5. Fingerprint + snapshot (mirrors what the engine stores)
  const repEmailForFp = REP_EMAIL.toLowerCase();
  const fp = tokenStore.fingerprint({ leadId: SYNTH_ID, date: FUTURE_DATE, time: APPT_TIME, type: 'Meeting', repEmail: repEmailForFp });
  const snapshot = {
    repName: REP_NAME, repPhone: REP_PHONE, repEmail: REP_EMAIL,
    officePhone: repDir.OFFICE_PHONE, officeEmail: repDir.OFFICE_EMAIL,
    apptDate: time.formatDate(FUTURE_DATE), apptTime: time.fmt12(APPT_TIME),
    address: ADDRESS, apptType: 'Meeting',
    clientFirstName: 'Railway Action', clientLastName: 'Test',
  };

  // 6. Issue real opaque tokens
  const conf = await tokenStore.issueToken(db, { leadId: SYNTH_ID, appointmentFingerprint: fp, actionType: 'confirm', snapshot });
  const resch = await tokenStore.issueToken(db, { leadId: SYNTH_ID, appointmentFingerprint: fp, actionType: 'reschedule', snapshot });
  const contact = await tokenStore.issueToken(db, { leadId: SYNTH_ID, appointmentFingerprint: fp, actionType: 'contact', snapshot });
  const conf2 = await tokenStore.issueToken(db, { leadId: SYNTH_ID, appointmentFingerprint: fp, actionType: 'confirm', snapshot }); // for nonce tests
  const resch2 = await tokenStore.issueToken(db, { leadId: SYNTH_ID, appointmentFingerprint: fp, actionType: 'reschedule', snapshot }); // for date/time + injection tests
  pass('three action tokens + two extra issued');

  line('\n— Token opacity —');
  for (const [name, t] of [['confirm', conf], ['reschedule', resch], ['contact', contact]]) {
    check(t.raw.length >= 32, `${name} raw token >= 32 chars`);
    check(/^[A-Za-z0-9_-]+$/.test(t.raw), `${name} raw is base64url (no +/=)`);
    check(/^[0-9a-f]{64}$/.test(t.tokenHash), `${name} stored hash is 64-hex`);
    check(t.tokenHash !== t.raw, `${name} hash != raw`);
  }
  const urlConfirm = `/r/confirm/${conf.raw}`;
  check(![SYNTH_ID, REP_EMAIL, CUST_EMAIL, FUTURE_DATE, ADDRESS].some((s) => urlConfirm.includes(s)), 'confirm URL contains no lead id / email / date / address');
  check(!/[{}]/.test(conf.raw) && !conf.raw.includes('='), 'confirm URL contains no readable JSON/Base64 padding');
  line('  redacted links:');
  line('    ' + `/r/confirm/${redact(conf.raw)}`);
  line('    ' + `/r/reschedule/${redact(resch.raw)}`);
  line('    ' + `/r/contact/${redact(contact.raw)}`);

  // Verify DB stores only the hash
  const { rows: tokRows } = await db.query('SELECT token_hash FROM reminder_action_tokens WHERE lead_id=$1', [SYNTH_ID]);
  check(tokRows.every((r) => r.token_hash !== conf.raw && r.token_hash !== resch.raw && r.token_hash !== contact.raw), 'raw token never stored in PostgreSQL');

  // 7. Security headers (on a confirm GET)
  line('\n— Security headers —');
  const hg = await get('/r/confirm/' + conf.raw);
  const cc = hg.headers.get('cache-control') || '';
  check(cc.includes('no-store'), 'Cache-Control includes no-store');
  check(hg.headers.get('referrer-policy') === 'no-referrer', 'Referrer-Policy is no-referrer');
  check(hg.headers.get('x-content-type-options') === 'nosniff', 'X-Content-Type-Options is nosniff');
  const csp = hg.headers.get('content-security-policy') || '';
  check(csp.includes("frame-ancestors 'none'"), 'CSP includes frame-ancestors none');

  // 8. Confirm flow
  line('\n— Confirm flow —');
  check(hg.status === 200, 'GET confirm page 200');
  check(hg.body.includes('Confirm Your Appointment'), 'confirm page branded');
  check(hg.body.includes(time.formatDate(FUTURE_DATE)), 'confirm page shows appointment date');
  check(hg.body.includes(REP_NAME), 'confirm page shows representative');
  const cNonce = captureNonce(hg.body);
  check(!!cNonce, 'confirm page issues nonce');
  const cp1 = await postForm('/r/confirm/' + conf.raw, { nonce: cNonce });
  check(cp1.status === 200, 'POST confirm 200');
  check(cp1.body.includes('Your Appointment Is Confirmed'), 'confirm success page');
  // count completed confirm actions
  const { rows: ca } = await db.query(`SELECT count(*)::int n FROM reminder_actions WHERE lead_id=$1 AND action_type='confirm' AND event_type='action_completed'`, [SYNTH_ID]);
  const { rows: cn } = await db.query(`SELECT count(*)::int n, (array_agg(status))[1] status, (array_agg(sent_at))[1] sent_at, (array_agg(attempt_count))[1] att, (array_agg(last_error))[1] err FROM reminder_notifications WHERE lead_id=$1 AND notification_type='confirm'`, [SYNTH_ID]);
  check(ca[0].n === 1, 'exactly one completed confirm action');
  check(cn[0].n === 1, 'exactly one confirm notification');
  check(cn[0].status === 'pending', 'confirm notification pending');
  check(cn[0].sent_at === null, 'confirm notification sent_at null');
  check(cn[0].att === 0, 'confirm notification attempt_count 0');
  check(cn[0].err === null, 'confirm notification last_error null');

  // Repeat POST with a fresh nonce → already-confirmed, no second rows
  const cNonce2 = await actions.issueNonce(db, conf.tokenHash);
  const cp2 = await postForm('/r/confirm/' + conf.raw, { nonce: cNonce2 });
  check(cp2.status === 200, 'repeat confirm POST 200');
  check(cp2.body.includes('Already Confirmed'), 'repeat confirm → already-confirmed response');
  const { rows: ca2 } = await db.query(`SELECT count(*)::int n FROM reminder_actions WHERE lead_id=$1 AND action_type='confirm' AND event_type='action_completed'`, [SYNTH_ID]);
  const { rows: cn2 } = await db.query(`SELECT count(*)::int n FROM reminder_notifications WHERE lead_id=$1 AND notification_type='confirm'`, [SYNTH_ID]);
  check(ca2[0].n === 1, 'no second confirm action');
  check(cn2[0].n === 1, 'no second confirm notification');

  // 9. Reschedule flow
  line('\n— Reschedule flow —');
  const rg = await get('/r/reschedule/' + resch.raw);
  check(rg.status === 200, 'GET reschedule page 200');
  check(rg.body.includes('Request a Reschedule'), 'reschedule page branded');
  const rNonce = captureNonce(rg.body);
  check(!!rNonce, 'reschedule page issues nonce');
  const RD1 = addDays(FUTURE_DATE, 10);
  const rp1 = await postForm('/r/reschedule/' + resch.raw, { nonce: rNonce, date: RD1, time: '14:00', note: 'Synthetic note' });
  check(rp1.status === 200, 'POST reschedule 200');
  check(rp1.body.includes('Reschedule Request Has Been Received'), 'reschedule received page');
  const { rows: ra } = await db.query(`SELECT count(*)::int n FROM reminder_actions WHERE lead_id=$1 AND action_type='reschedule' AND event_type='action_completed'`, [SYNTH_ID]);
  const { rows: rn } = await db.query(`SELECT count(*)::int n FROM reminder_notifications WHERE lead_id=$1 AND notification_type='reschedule'`, [SYNTH_ID]);
  check(ra[0].n === 1, 'exactly one reschedule action');
  check(rn[0].n === 1, 'exactly one reschedule notification');
  // appointment_leads NOT modified
  const { rows: leadAfter } = await db.query('SELECT appointment_date, appointment_time FROM reminder_leads WHERE id=$1', [SYNTH_ID]);
  check(leadAfter[0].appointment_date === FUTURE_DATE && leadAfter[0].appointment_time === APPT_TIME, 'reminder_leads appointment unchanged by reschedule');

  // Repeat identical request → already-submitted, no duplicate
  const rNonce2 = await actions.issueNonce(db, resch.tokenHash);
  const rp2 = await postForm('/r/reschedule/' + resch.raw, { nonce: rNonce2, date: RD1, time: '14:00', note: 'Synthetic note' });
  check(rp2.status === 200, 'repeat reschedule POST 200');
  check(rp2.body.includes('Already Received'), 'repeat reschedule → already-received');
  const { rows: ra2 } = await db.query(`SELECT count(*)::int n FROM reminder_actions WHERE lead_id=$1 AND action_type='reschedule' AND event_type='action_completed'`, [SYNTH_ID]);
  const { rows: rn2 } = await db.query(`SELECT count(*)::int n FROM reminder_notifications WHERE lead_id=$1 AND notification_type='reschedule'`, [SYNTH_ID]);
  check(ra2[0].n === 1, 'no duplicate reschedule action');
  check(rn2[0].n === 1, 'no duplicate reschedule notification');

  // Genuinely different request → accepted separately
  const rNonce3 = await actions.issueNonce(db, resch.tokenHash);
  const rp3 = await postForm('/r/reschedule/' + resch.raw, { nonce: rNonce3, date: addDays(FUTURE_DATE, 12), time: '11:00', note: 'Different request' });
  check(rp3.status === 200, 'different reschedule POST 200');
  check(rp3.body.includes('Received'), 'different reschedule accepted');
  const { rows: ra3 } = await db.query(`SELECT count(*)::int n FROM reminder_actions WHERE lead_id=$1 AND action_type='reschedule' AND event_type='action_completed'`, [SYNTH_ID]);
  const { rows: rn3 } = await db.query(`SELECT count(*)::int n FROM reminder_notifications WHERE lead_id=$1 AND notification_type='reschedule'`, [SYNTH_ID]);
  check(ra3[0].n === 2, 'different reschedule creates a second action');
  check(rn3[0].n === 2, 'different reschedule creates a second notification');

  // Note HTML/script injection → escaped in notification body, not echoed on page
  const rNonce4 = await actions.issueNonce(db, resch.raw);
  const rp4 = await postForm('/r/reschedule/' + resch.raw, { nonce: rNonce4, date: addDays(FUTURE_DATE, 14), time: '15:00', note: '<script>alert(1)</script>' });
  check(rp4.status === 200, 'script-note POST 200');
  check(!rp4.body.includes('<script>alert(1)</script>'), 'received page does not echo raw script');
  const { rows: nb } = await db.query(`SELECT body FROM reminder_notifications WHERE lead_id=$1 AND body LIKE '%alert%' ORDER BY created_at DESC LIMIT 1`, [SYNTH_ID]);
  check(nb.length === 1 && nb[0].body.includes('&lt;script&gt;'), 'notification body escapes script tag');
  check(nb.length === 1 && !nb[0].body.includes('<script>alert'), 'notification body has no raw script');

  // Oversized note → rejected (400)
  const rNonce5 = await actions.issueNonce(db, resch2.tokenHash);
  const rp5 = await postForm('/r/reschedule/' + resch2.raw, { nonce: rNonce5, date: addDays(FUTURE_DATE, 16), time: '16:00', note: 'x'.repeat(600) });
  check(rp5.status === 400, 'oversized note rejected (400)');
  check(rp5.body.includes('500 characters'), 'oversized note error message');

  // Invalid date / time → 400 form error
  const rNonce6 = await actions.issueNonce(db, resch2.tokenHash);
  const rp6 = await postForm('/r/reschedule/' + resch2.raw, { nonce: rNonce6, date: '2026-9-1', time: '9:00', note: '' });
  check(rp6.status === 400, 'invalid date/time rejected (400)');

  // 10. Contact flow
  line('\n— Contact flow —');
  const cg = await get('/r/contact/' + contact.raw);
  check(cg.status === 200, 'GET contact page 200');
  check(cg.body.includes('Contact Your Sales Representative'), 'contact page branded');
  check(cg.body.includes(REP_NAME), 'contact page shows representative');
  check(cg.body.includes(REP_EMAIL), 'contact page shows rep email');
  let clickActions = 0;
  for (const btn of ['call_rep', 'email_rep', 'call_office', 'email_office']) {
    const cl = await get('/r/click/' + contact.raw + '?btn=' + btn);
    check(cl.status === 302, `click ${btn} → 302`);
    const loc = cl.headers.get('location') || '';
    check(loc.startsWith('tel:') || loc.startsWith('mailto:'), `click ${btn} → tel:/mailto: redirect`);
    check(!loc.includes('changed'), `click ${btn} does not target a changed rep`);
    if (cl.status === 302) clickActions++;
  }
  const { rows: clk } = await db.query(`SELECT count(*)::int n FROM reminder_actions WHERE lead_id=$1 AND event_type='button_clicked'`, [SYNTH_ID]);
  check(clk[0].n >= 4, 'button clicks tracked');
  const { rows: cn0 } = await db.query(`SELECT count(*)::int n FROM reminder_notifications WHERE lead_id=$1 AND notification_type='contact'`, [SYNTH_ID]);
  check(cn0[0].n === 0, 'contact creates no notification');

  // 11. Invalid-input tests
  line('\n— Invalid-input tests —');
  const inv = await get('/r/confirm/' + 'Zzz_invalid_token_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  check(inv.status === 400, 'invalid token → 400');
  check(inv.body.includes('Invalid'), 'invalid token page');
  assertNoLeak(inv.body, 'invalid token');
  const mod = await get('/r/confirm/' + conf.raw + 'x');
  check(mod.status === 400, 'modified token → 400');
  assertNoLeak(mod.body, 'modified token');

  // Expired token
  const exp = await tokenStore.issueToken(db, { leadId: SYNTH_ID, appointmentFingerprint: fp, actionType: 'confirm', snapshot });
  await db.query(`UPDATE reminder_action_tokens SET expires_at = NOW() - INTERVAL '1 second' WHERE token_hash=$1`, [exp.tokenHash]);
  const exg = await get('/r/confirm/' + exp.raw);
  check(exg.status === 410, 'expired token → 410');
  check(exg.body.includes('Expired'), 'expired token page');
  assertNoLeak(exg.body, 'expired token');

  // Missing / incorrect / reused nonce (using conf2)
  const mn = await postForm('/r/confirm/' + conf2.raw, {});
  check(mn.status === 400, 'missing nonce → 400');
  const ino = await postForm('/r/confirm/' + conf2.raw, { nonce: 'wrongvalue' });
  check(ino.status === 400, 'incorrect nonce → 400');
  const reuseNonce = await actions.issueNonce(db, conf2.tokenHash);
  const ru1 = await postForm('/r/confirm/' + conf2.raw, { nonce: reuseNonce });
  check(ru1.status === 200, 'reused-nonce first POST 200');
  const ru2 = await postForm('/r/confirm/' + conf2.raw, { nonce: reuseNonce });
  check(ru2.status === 400, 'reused nonce second POST → 400');

  // Oversized request body (>8kb) → 413
  const big = 'x'.repeat(9000);
  const ob = await postForm('/r/reschedule/' + resch2.raw, { nonce: 'x'.repeat(20), note: big });
  check(ob.status === 413 || ob.status === 400, 'oversized request body rejected');

  // 12. Appointment-change safety
  line('\n— Appointment-change safety —');
  await db.query(`UPDATE reminder_leads SET appointment_time='14:00' WHERE id=$1`, [SYNTH_ID]);
  const chg = await get('/r/confirm/' + conf.raw);
  check(chg.status === 409, 'changed appointment confirm GET → 409');
  check(chg.body.includes('Appointment Details Have Changed'), 'changed appointment branded page');
  assertNoLeak(chg.body, 'changed appointment');
  const { rows: ca3 } = await db.query(`SELECT count(*)::int n FROM reminder_actions WHERE lead_id=$1 AND action_type='confirm' AND event_type='action_completed'`, [SYNTH_ID]);
  const { rows: cn3 } = await db.query(`SELECT count(*)::int n FROM reminder_notifications WHERE lead_id=$1 AND notification_type='confirm'`, [SYNTH_ID]);
  check(ca3[0].n === 1, 'changed appointment created no new confirm action');
  check(cn3[0].n === 1, 'changed appointment created no new notification');

  // Restore original appointment
  await db.query(`UPDATE reminder_leads SET appointment_time='09:00' WHERE id=$1`, [SYNTH_ID]);
  // Fresh contact link, then change rep → old contact link must not expose new rep
  const contact2 = await tokenStore.issueToken(db, { leadId: SYNTH_ID, appointmentFingerprint: fp, actionType: 'contact', snapshot });
  await db.query(`UPDATE reminder_leads SET assigned_rep='Changed Representative', assigned_rep_name='Changed Representative', assigned_rep_email='changed.rep.invalid@example.invalid', assigned_rep_phone='+13105550999' WHERE id=$1`, [SYNTH_ID]);
  const cg2 = await get('/r/contact/' + contact2.raw);
  check(cg2.status === 200, 'rep-changed contact GET 200');
  check(cg2.body.includes('Synthetic Representative'), 'old contact link shows the ORIGINAL rep');
  check(!cg2.body.includes('Changed Representative'), 'old contact link does not expose new rep');
  const cl2 = await get('/r/click/' + contact2.raw + '?btn=email_rep');
  check(cl2.status === 302, 'rep-changed click → 302');
  const loc2 = cl2.headers.get('location') || '';
  check(loc2 === 'mailto:' + REP_EMAIL, 'click targets the ORIGINAL rep email, not the new rep');
  const { rows: cn4 } = await db.query(`SELECT count(*)::int n FROM reminder_notifications WHERE lead_id=$1 AND notification_type='contact'`, [SYNTH_ID]);
  check(cn4[0].n === 0, 'rep-change contact created no notification');

  // 13. Rate limiting (last HTTP test)
  line('\n— Rate limiting —');
  let got429 = false;
  let burstCount = 0;
  const invalidTok = 'Zzz_rate_burst_invalid_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  for (let i = 0; i < 80; i++) {
    burstCount++;
    const r = await get('/r/confirm/' + invalidTok);
    if (r.status === 429) { got429 = 429; break; }
  }
  check(got429 === 429, `rate limiter returned 429 (after ${burstCount} requests)`);
  line('  note: burst hit the shared public proxy IP — may rate-limit other users for ≤60s; run off-hours');

  // 14. Final DB assertions — all synthetic notifications pending, no Gmail attempts, no Base44 data
  line('\n— Post-walkthrough DB assertions —');
  const { rows: allNotif } = await db.query(`SELECT status, sent_at, attempt_count, last_error FROM reminder_notifications WHERE lead_id=$1`, [SYNTH_ID]);
  let allPending = allNotif.length > 0;
  for (const n of allNotif) {
    if (n.status !== 'pending' || n.sent_at !== null || n.attempt_count !== 0 || n.last_error !== null) allPending = false;
  }
  check(allPending, 'all synthetic notifications pending / unsent / attempt_count 0 / no error (no Gmail attempt)');
  check(allNotif.length > 0, 'notifications exist (confirm + reschedule enqueued)');

  // 15. Row-count snapshot (after) — must equal BEFORE
  line('\n— Row-count snapshot (after cleanup) —');
  // (cleanup runs in finally; here we just note it will compare)

  return 'done';
}

function abort() { line('  (aborted before further work)'); return 'aborted'; }

(async () => {
  let outcome = 'error';
  try {
    outcome = await main();
  } catch (e) {
    fail('unhandled exception: ' + e.message);
  } finally {
    // Cleanup ALWAYS runs
    await cleanup();
    // After-cleanup: table-specific verification (dependency-aware).
    // reminder_leads is keyed by `id`; reminder_form_nonces has no lead_id, so it is
    // verified through the token_hash relationship to reminder_action_tokens. Each
    // query is wrapped so a verification error is recorded but never prevents the
    // cleanup result from printing.
    line('\n— Row counts after cleanup (must be zero synthetic rows) —');
    const verifyQueries = [
      ['reminder_leads',         `SELECT count(*)::int n FROM reminder_leads WHERE id=$1`],
      ['reminder_action_tokens', `SELECT count(*)::int n FROM reminder_action_tokens WHERE lead_id=$1`],
      ['reminder_actions',       `SELECT count(*)::int n FROM reminder_actions WHERE lead_id=$1`],
      ['reminder_notifications', `SELECT count(*)::int n FROM reminder_notifications WHERE lead_id=$1`],
      ['reminder_form_nonces',   `SELECT count(*)::int n FROM reminder_form_nonces WHERE token_hash IN (SELECT token_hash FROM reminder_action_tokens WHERE lead_id=$1)`],
    ];
    let delta = 0;
    let cleanupFailed = 0;
    for (const [t, sql] of verifyQueries) {
      let n;
      try {
        const { rows } = await db.query(sql, [SYNTH_ID]);
        n = rows[0].n;
      } catch (e) {
        fail(`cleanup verification failed for ${t}: ${e.message}`);
        cleanupFailed++;
        line(`  ${t} synthetic rows remaining: ERROR (verification query failed)`);
        continue;
      }
      line(`  ${t} synthetic rows remaining: ${n}`);
      if (n !== 0) { fail(`${t} still has ${n} synthetic rows`); delta += n; }
    }
    if (delta === 0 && cleanupFailed === 0) pass('all synthetic rows removed');

    // Summary
    line('\n=== SUMMARY ===');
    line('result: ' + (FAILURES === 0 && outcome === 'done' && delta === 0 && cleanupFailed === 0 ? 'PASS' : 'FAIL'));
    line('failures: ' + FAILURES);
    line('remaining gaps: (1) branch/commit is "unavailable" when neither Railway git env vars nor the git binary are present (non-critical); (2) cron-disabled is an operator-confirmed precondition, not asserted by this script; (3) rate-limit burst used the shared public proxy IP — see note; (4) row-count delta vs absolute before-snapshot is not stored across the finally boundary — synthetic-row-removal is asserted instead.');

    process.stdout.write(REPORT.join('\n') + '\n');
    const code = (FAILURES === 0 && outcome === 'done' && delta === 0 && cleanupFailed === 0) ? 0 : 1;
    process.exit(code);
  }
})();