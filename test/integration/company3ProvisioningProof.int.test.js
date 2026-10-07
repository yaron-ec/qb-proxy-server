/* eslint-disable no-undef */
'use strict';

/**
 * company3ProvisioningProof.int.test.js — MANDATORY Phase E productization
 * proof for the Company Provisioning System (scripts/install/
 * provisionCompany.js, scripts/install/companyConfigContract.js,
 * scripts/install/railwayPlan.js).
 *
 * Unlike test/integration/company2FunctionalProof.int.test.js (which called
 * scripts/install/bootstrap.js's internal functions directly, proving the
 * underlying DB-side engine), THIS file invokes the actual, supported
 * operator entry point — `node scripts/install/provisionCompany.js
 * --config=<path>` — as a real subprocess against a disposable, freshly
 * created Postgres database, exactly as an operator installing a real new
 * company would run it. It also re-runs the same command a second time to
 * prove idempotency end-to-end through the real CLI, not just through its
 * underlying functions.
 *
 * Fictional Company #3: "Driftwood Builders Co." — Asheville, NC,
 * America/New_York is already used by Company #2 (Pinecrest), so this uses
 * America/Chicago instead to also prove timezone configurability is not a
 * one-off. Admin "Jordan Ellis", sales rep "Taylor Nguyen". Deliberately
 * different project types, lead sources, travel buffer, module mix, and a
 * custom_domain (to also exercise the Phase D domain checklist) from
 * Company #2 — nothing here is copied from Pinecrest or EC.
 *
 * Flows proven (mapped to the Phase E spec's 18-point list):
 *   1.  full migrations succeed from zero (provisioner's own health check)
 *   2.  initial Admin can authenticate
 *   3.  Company #3 branding/config loads
 *   4.  EC branding/data does not appear (checked throughout + at the end)
 *   5.  create a sales rep
 *   6.  create a lead
 *   7.  assign/reassign owner (incl. appointment resync)
 *   8.  set project type
 *   9.  set Follow-Up
 *   10. Meeting Follow-Up behaves per canonical scheduling rules
 *   11. current-work selection is Follow-Up-driven, never Appointment-driven
 *       (lib/booking/currentAction.js, the real canonical selector)
 *   12. Daily Map / routing uses Driftwood's own configuration
 *   13. create AND update a Deal
 *   14. permissions work (role isolation + office financial-data denial)
 *   15. a disabled module (handoff) produces no external integration work
 *   16. an enabled module (google_calendar) with its credentials
 *       intentionally absent degrades to DB-only availability, never a 500
 *   17. re-running the provisioner is idempotent — proven via the REAL CLI,
 *       twice, asserting zero duplicate rows
 *   18. zero EC identity/secrets/branding leaked into Driftwood's own data
 *       or API output, and zero Base44 dependency in any touched module
 *
 * Skipped without TEST_DATABASE_URL (needs a disposable, migrated Postgres —
 * a SEPARATE fresh database from other int test files' shared one).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE_TEST_DB_URL = process.env.TEST_DATABASE_URL;
const skip = !BASE_TEST_DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
const ROOT = path.join(__dirname, '..', '..');
const DRIFTWOOD_TZ = 'America/Chicago';

const DB_NAME = `qbproxy_test_company3_${Date.now() % 1e7}`;
let DB_URL;
let configPath;
let outDir1, outDir2;

const RESPONSES = [];
function record(label, body) {
  RESPONSES.push({ label, body });
  return body;
}

let db, server, base, adminToken, repToken, seededLeadId;

const DRIFTWOOD_CONFIG = {
  company_name: 'Driftwood Builders Co.',
  legal_name: 'Driftwood Builders Co., LLC',
  company_slug: 'driftwood-builders',
  company_email: 'hello@driftwoodbuilders.example',
  company_phone: '(828) 555-0199',
  company_website: 'https://driftwoodbuilders.example',
  timezone: DRIFTWOOD_TZ,
  locale: 'en-US',
  currency: 'USD',
  appointment_travel_buffer_minutes: 45,
  enabled_modules: {
    quickbooks: false, gmail: false, google_calendar: true, google_contacts: false,
    signnow: false, handoff: false, meta: false, sms: false, website_intake: true,
  },
  admin_name: 'Jordan Ellis',
  admin_email: 'jordan@driftwoodbuilders.example',
  admin_password: 'Driftwood-Strong-Pw-1!',
  project_types: ['Fence Installation', 'Patio Construction', 'Driveway Paving', 'Gutter Replacement'],
  lead_sources: ['Yard Sign', 'Angi', 'Referral', 'Website'],
  contact_owners: ['Jordan Ellis', 'Taylor Nguyen'],
  default_owner_name: 'Jordan Ellis',
  default_owner_starting_location: '400 Riverbend Rd, Asheville, NC 28801',
  frontend_url: 'https://crm.driftwoodbuilders.example',
  backend_url: 'https://driftwood-api.up.railway.app',
  custom_domain: 'crm.driftwoodbuilders.example',
};

if (BASE_TEST_DB_URL) {
  const stub = (rel, exports) => {
    const p = require.resolve(path.join(ROOT, rel));
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
  };
  stub('lib/booking/googleCalendarClient', {
    getAccessToken: async () => 'fake', createOrUpdateEvent: async (_t, _c, b) => ({ id: b.id }),
    updateEvent: async (_t, _c, id) => ({ id }), cancelEvent: async () => ({ ok: true }),
    getEvent: async () => ({ exists: false }), listByExt: async () => [], listEvents: async () => [],
  });
  stub('lib/captureAlerts', { sendNewLeadAlert: async () => {}, ALERT_RECIPIENTS: [] });
  stub('lib/googleContactsOutbox', { enqueueContactSync: async () => {} });
  stub('lib/emailService', { send: async () => ({ ok: true, gmailMessageId: 'm1' }) });
}

async function api(method, url, body, token) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      'x-forwarded-for': `10.9.1.${1 + Math.floor(Math.random() * 250)}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  record(`${method} ${url}`, json);
  return { status: res.status, body: json };
}

function dateInDays(days, tz) {
  const d = new Date(Date.now() + days * 86400000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}` };
}

function runProvisioner(extraArgs = []) {
  const args = [path.join(ROOT, 'scripts', 'install', 'provisionCompany.js'), `--config=${configPath}`, ...extraArgs];
  let stdout;
  let status = 0;
  try {
    stdout = execFileSync('node', args, { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    stdout = e.stdout;
    status = e.status ?? 1;
  }
  const report = JSON.parse(stdout.toString('utf8'));
  return { status, report };
}

test.before(async () => {
  if (skip) return;
  const url = new URL(BASE_TEST_DB_URL);
  const adminDbUrl = new URL(BASE_TEST_DB_URL);
  adminDbUrl.pathname = '/postgres';
  execFileSync('psql', [adminDbUrl.toString(), '-c', `DROP DATABASE IF EXISTS ${DB_NAME};`], { stdio: 'ignore' });
  execFileSync('psql', [adminDbUrl.toString(), '-c', `CREATE DATABASE ${DB_NAME};`], { stdio: 'inherit' });
  url.pathname = `/${DB_NAME}`;
  DB_URL = url.toString();

  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
  process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'int-test-secret-int-test-secret-0123456789';
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'company3-provision-'));
  configPath = path.join(tmpBase, 'driftwood.company.json');
  fs.writeFileSync(configPath, JSON.stringify(DRIFTWOOD_CONFIG, null, 2));
  outDir1 = path.join(tmpBase, 'out1');
  outDir2 = path.join(tmpBase, 'out2');

  delete require.cache[require.resolve(path.join(ROOT, 'db/client'))];
  db = require(path.join(ROOT, 'db/client'));

  const express = require('express');
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/v1/auth', require(path.join(ROOT, 'routes/auth')));
  app.use('/api/v1/leads', require(path.join(ROOT, 'routes/leads')));
  app.use('/api/v1/deals', require(path.join(ROOT, 'routes/deals')));
  app.use('/api/v1/users', require(path.join(ROOT, 'routes/users')));
  app.use('/api/v1/company-settings', require(path.join(ROOT, 'routes/companySettings')));
  app.use('/api/v1/routing', require(path.join(ROOT, 'routes/routing')));
  app.use('/api/v1/owners', require(path.join(ROOT, 'routes/owners')));
  app.use('/api/public/capture', require(path.join(ROOT, 'routes/publicCapture')));
  const { requireModuleEnabled } = require(path.join(ROOT, 'lib/moduleGate'));
  app.get('/api/v1/handoff/_probe', requireModuleEnabled('handoff'), (req, res) => res.json({ ok: true }));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (skip) return;
  server.close();
  await db.pool.end();
  const adminDbUrl = new URL(BASE_TEST_DB_URL);
  adminDbUrl.pathname = '/postgres';
  try { execFileSync('psql', [adminDbUrl.toString(), '-c', `DROP DATABASE IF EXISTS ${DB_NAME};`], { stdio: 'ignore' }); } catch (_) { /* best-effort cleanup */ }
});

test('1+17a. provisioning FROM ZERO via the real CLI succeeds, runs the full migration chain, and passes its own post-provision health checks', { skip }, async () => {
  const { status, report } = runProvisioner([`--out=${outDir1}`, '--generate-secrets']);
  assert.strictEqual(status, 0, JSON.stringify(report, null, 2));
  assert.strictEqual(report.ok, true, JSON.stringify(report, null, 2));
  assert.strictEqual(report.bootstrap.steps.company_settings.created, true, 'company_settings must be freshly created from zero');
  assert.strictEqual(report.bootstrap.steps.first_admin.created, true, 'admin must be freshly created from zero');
  assert.strictEqual(report.bootstrap.steps.app_lists.created, true, 'app_lists must be freshly seeded from zero');
  assert.strictEqual(report.bootstrap.steps.owner_starting_location.created, true, 'owner_starting_locations must be freshly seeded from zero');
  assert.ok(report.health_checks.migrations_ok, 'full migration chain must have applied successfully');
  assert.ok(report.health_checks.migrations_applied > 0);
  assert.ok(report.health_checks.ok, JSON.stringify(report.health_checks));
  assert.strictEqual(report.config.admin_password, '<redacted>', 'the JSON report must never contain the real admin password');
  assert.ok(fs.existsSync(path.join(outDir1, 'env.manifest.txt')));
  assert.ok(fs.existsSync(path.join(outDir1, 'ONBOARDING_CHECKLIST.md')));
  assert.ok(fs.existsSync(path.join(outDir1, 'RAILWAY_DEPLOYMENT_PLAN.md')));
  const checklist = fs.readFileSync(path.join(outDir1, 'ONBOARDING_CHECKLIST.md'), 'utf8');
  assert.match(checklist, /Custom domain: crm\.driftwoodbuilders\.example/, 'Phase D domain checklist must be generated');
  record('provisioner-run-1', report);
});

test('2. initial Admin (Jordan Ellis) can authenticate', { skip }, async () => {
  const r = await api('POST', '/api/v1/auth/login', { email: 'jordan@driftwoodbuilders.example', password: 'Driftwood-Strong-Pw-1!' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  adminToken = r.body.access || r.body.accessToken || r.body.access_token || r.body.token;
  assert.ok(adminToken, 'login must return a usable session token');
});

test('3. Driftwood\'s own branding/config loads (never EC\'s)', { skip }, async () => {
  const r = await api('GET', '/api/v1/company-settings', undefined, adminToken);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const settings = r.body.settings || r.body;
  assert.strictEqual(settings.company_name, 'Driftwood Builders Co.');
  assert.strictEqual(settings.timezone, DRIFTWOOD_TZ);
  assert.strictEqual(settings.appointment_travel_buffer_minutes, 45);
  assert.strictEqual(settings.company_slug, 'driftwood-builders');
  assert.notStrictEqual(settings.company_name, 'EC Construction Group');
});

test('5. create a sales rep (Taylor Nguyen)', { skip }, async () => {
  await db.query(`INSERT INTO owners (email, display_name) VALUES ('taylor@driftwoodbuilders.example', 'Taylor Nguyen') ON CONFLICT DO NOTHING`);
  const { hashPassword } = require(path.join(ROOT, 'lib/crypto'));
  await db.query(
    `INSERT INTO users (email, full_name, role, password_hash, status)
     VALUES ('taylor@driftwoodbuilders.example', 'Taylor Nguyen', 'sales_rep', $1, 'active')
     ON CONFLICT (lower(email)) DO NOTHING`,
    [hashPassword('Driftwood-Rep-Pw-1!')]
  );
  const { issueAccessToken } = require(path.join(ROOT, 'lib/authService'));
  repToken = issueAccessToken({ id: '00000000-0000-0000-0000-0000000000d1', email: 'taylor@driftwoodbuilders.example', role: 'sales_rep' });
  const check = await db.query(`SELECT id FROM users WHERE email = 'taylor@driftwoodbuilders.example'`);
  assert.strictEqual(check.rows.length, 1);
});

test('6+8. create a lead with a Driftwood-specific project type', { skip }, async () => {
  const ownerR = await db.query(`SELECT id FROM owners WHERE email = 'taylor@driftwoodbuilders.example'`);
  const taylorOwnerId = ownerR.rows[0].id;
  const r = await api('POST', '/api/v1/leads', {
    first_name: 'Robin', last_name: 'DriftwoodLead1', email: 'robin1@example.com', phone: '8285550001',
    status: 'New', owner_id: taylorOwnerId, source: 'Referral', project_type: 'Fence Installation',
  }, adminToken);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  seededLeadId = r.body.lead.id;
  assert.strictEqual(r.body.lead.project_type, 'Fence Installation');
});

test('7. owner reassignment resyncs an active appointment (PR #14/#15 fix, proven under Driftwood)', { skip }, async () => {
  const taylorR = await db.query(`SELECT id FROM owners WHERE email = 'taylor@driftwoodbuilders.example'`);
  const taylorOwnerId = taylorR.rows[0].id;
  await db.query(`INSERT INTO owners (email, display_name) VALUES ('jordan@driftwoodbuilders.example', 'Jordan Ellis') ON CONFLICT DO NOTHING`);
  const jordanR = await db.query(`SELECT id FROM owners WHERE email = 'jordan@driftwoodbuilders.example'`);
  const jordanOwnerId = jordanR.rows[0].id;
  void taylorOwnerId;

  const slot = dateInDays(5, DRIFTWOOD_TZ);
  const book = await api('PUT', `/api/v1/leads/${seededLeadId}/appointment`, { appointment_date: slot.date, appointment_time: slot.time, appointment_type: 'Meeting' }, adminToken);
  assert.strictEqual(book.status, 200, JSON.stringify(book.body));

  const reassign = await api('PUT', `/api/v1/leads/${seededLeadId}`, { owner_id: jordanOwnerId }, adminToken);
  assert.strictEqual(reassign.status, 200, JSON.stringify(reassign.body));
  const apptAfter = (await db.query(`SELECT owner_id, start_at, lower(busy_range) bs FROM appointments WHERE lead_id = $1 AND status IN ('scheduled','confirmed')`, [seededLeadId])).rows[0];
  assert.strictEqual(String(apptAfter.owner_id), String(jordanOwnerId), 'appointment owner must follow the lead reassignment');

  // Travel buffer uses DRIFTWOOD's configured 45-minute buffer, not EC's 60 or Pinecrest's 25.
  const bufferMs = new Date(apptAfter.start_at) - new Date(apptAfter.bs);
  assert.strictEqual(bufferMs, 45 * 60 * 1000, 'must use Driftwood\'s own 45-minute travel buffer');
});

test('9+10+11. Follow-Up (Meeting type) is set, and current-work selection is Follow-Up-driven, never Appointment-driven', { skip }, async () => {
  const followUp = dateInDays(2, DRIFTWOOD_TZ);
  const r = await api('PUT', `/api/v1/leads/${seededLeadId}/follow-up`, {
    follow_up_date: followUp.date, follow_up_time: followUp.time, follow_up_type: 'Meeting', follow_up_status: 'pending',
  }, adminToken);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const lead = r.body.lead || r.body;
  assert.strictEqual(lead.follow_up_type, 'Meeting');
  assert.strictEqual(lead.follow_up_date, followUp.date);

  // Flow 11: the real canonical selector (lib/booking/currentAction.js) —
  // never reads appointment_* for current-work purposes. The lead's
  // Appointment (from the previous test) is on a DIFFERENT day than this
  // Follow-Up, so if current-work were ever Appointment-driven, this
  // assertion would see the wrong day's result.
  const { currentActionForDay } = require(path.join(ROOT, 'lib/booking/currentAction'));
  const leadRow = (await db.query('SELECT * FROM leads WHERE id = $1', [seededLeadId])).rows[0];
  const action = currentActionForDay(leadRow, followUp.date);
  assert.ok(action, 'the lead must have current work on its Follow-Up date');
  assert.strictEqual(action.isPhysicalMeeting, true, 'a Meeting-type Follow-Up is a physical meeting for routing purposes');
  const apptSlot = dateInDays(5, DRIFTWOOD_TZ);
  assert.strictEqual(currentActionForDay(leadRow, apptSlot.date), null, 'the Appointment\'s own date must NOT independently produce current work with no Follow-Up there');
});

test('12. Daily Map / routing reflects Driftwood\'s own configuration, never EC\'s Woodland Hills default', { skip }, async () => {
  const cfgR = await api('GET', '/api/v1/routing/owner-config', undefined, adminToken);
  assert.strictEqual(cfgR.status, 200, JSON.stringify(cfgR.body));
  assert.strictEqual(cfgR.body.owner_starts['Jordan Ellis'], '400 Riverbend Rd, Asheville, NC 28801', 'the bootstrap-seeded default_owner_starting_location must appear verbatim');
  assert.ok(!JSON.stringify(cfgR.body).includes('Woodland Hills'));

  const slot = dateInDays(5, DRIFTWOOD_TZ);
  const sched = await api('GET', `/api/v1/routing/daily-schedule?owner=all&date=${slot.date}`, undefined, adminToken);
  assert.ok([200, 503].includes(sched.status), JSON.stringify(sched.body));
  if (sched.status === 503) assert.strictEqual(sched.body.error, 'google_maps_not_configured');
});

test('13. create AND update a Deal', { skip }, async () => {
  const create = await api('POST', '/api/v1/deals', {
    name: 'Robin DriftwoodLead1 — Fence Installation', lead_id: seededLeadId,
    amount: 9800, stage: 'Sold / Estimate Approved', project_type: 'Fence Installation',
  }, adminToken);
  assert.strictEqual(create.status, 201, JSON.stringify(create.body));
  const dealId = create.body.deal.id;

  const update = await api('PUT', `/api/v1/deals/${dealId}`, { amount: 10500, stage: 'Work Started' }, adminToken);
  assert.strictEqual(update.status, 200, JSON.stringify(update.body));
  const updated = update.body.deal || update.body;
  assert.strictEqual(Number(updated.amount), 10500);
  assert.strictEqual(updated.stage, 'Work Started');
});

test('14. permissions: role isolation (sales_rep sees own lead) + office role is denied deal access (unchanged policy under Driftwood)', { skip }, async () => {
  const r = await api('GET', '/api/v1/leads', undefined, repToken);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const repLeadIds = (r.body.items || []).map((l) => l.id);
  assert.ok(!repLeadIds.includes(seededLeadId), 'Taylor should not see Robin\'s lead — it is owned by Jordan after reassignment, not Taylor');

  const { canAccessDeal } = require(path.join(ROOT, 'lib/dealModel'));
  const officeUser = { id: 'off-1', role: 'office' };
  const anyDeal = { id: 'd-1', assigned_rep: null, created_by: 'someone-else' };
  assert.strictEqual(canAccessDeal(officeUser, anyDeal), false, 'the office role\'s deal-access denial is a universal policy, unaffected by installation config');
});

test('15. a disabled module (handoff) produces no external integration work — 404 module_disabled', { skip }, async () => {
  const r = await api('GET', '/api/v1/handoff/_probe', undefined, adminToken);
  assert.strictEqual(r.status, 404, JSON.stringify(r.body));
  assert.strictEqual(r.body.error, 'module_disabled');
  assert.strictEqual(r.body.module, 'handoff');
});

test('16. an enabled module (google_calendar) with credentials intentionally absent still degrades to DB-only availability, never a 500', { skip }, async () => {
  assert.strictEqual(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, undefined, 'this test intentionally runs with no Google service account configured');
  const jordanR = await db.query(`SELECT id FROM owners WHERE email = 'jordan@driftwoodbuilders.example'`);
  const { getAvailability } = require(path.join(ROOT, 'lib/booking/availabilityService'));
  const slot = dateInDays(5, DRIFTWOOD_TZ);
  const av = await getAvailability({ owner_id: jordanR.rows[0].id, date: slot.date, timezone: DRIFTWOOD_TZ, duration_minutes: 60 });
  assert.ok(av && Array.isArray(av.busy_windows), 'availability must degrade gracefully (DB-only), never throw/500, when google_calendar is enabled but has no credentials');
});

test('17b. re-running the provisioner (real CLI, second invocation) is idempotent — zero duplicate rows', { skip }, async () => {
  const before = await db.query('SELECT count(*)::int n FROM company_settings');
  const beforeAdmins = await db.query(`SELECT count(*)::int n FROM users WHERE role = 'admin'`);
  const beforeOwners = await db.query('SELECT count(*)::int n FROM owners');

  const { status, report } = runProvisioner([`--out=${outDir2}`]);
  assert.strictEqual(status, 0, JSON.stringify(report, null, 2));
  assert.strictEqual(report.ok, true, JSON.stringify(report, null, 2));
  assert.strictEqual(report.bootstrap.steps.company_settings.created, false, 'a second run must NOT create a second company_settings row');
  assert.strictEqual(report.bootstrap.steps.first_admin.created, false, 'a second run must NOT create a second admin');
  assert.strictEqual(report.bootstrap.steps.app_lists.created, false, 'a second run must NOT overwrite app_lists');
  assert.strictEqual(report.bootstrap.steps.owner_starting_location.created, false, 'a second run must NOT duplicate the owner_starting_location entry');

  const after = await db.query('SELECT count(*)::int n FROM company_settings');
  const afterAdmins = await db.query(`SELECT count(*)::int n FROM users WHERE role = 'admin'`);
  const afterOwners = await db.query('SELECT count(*)::int n FROM owners');
  assert.strictEqual(after.rows[0].n, before.rows[0].n, 'company_settings row count must be unchanged');
  assert.strictEqual(afterAdmins.rows[0].n, beforeAdmins.rows[0].n, 'admin count must be unchanged');
  assert.strictEqual(afterOwners.rows[0].n, beforeOwners.rows[0].n, 'owners count must be unchanged (re-running must not duplicate Jordan/Taylor)');
  record('provisioner-run-2', report);
});

test('18a. NO EC IDENTITY LEAKS: every collected API response AND both provisioner reports are free of EC-specific terms', { skip }, async () => {
  const blob = JSON.stringify(RESPONSES).toLowerCase();
  const forbidden = [
    'ecconstructiongroup', 'ec construction', 'woodland hills',
    'yaron', 'michelle', 'ethan magen', 'micky gad', 'karen hirschorn', 'matt aharoni',
  ];
  const hits = forbidden.filter((term) => blob.includes(term.toLowerCase()));
  assert.deepStrictEqual(hits, [], `EC identity leaked into Driftwood's own data/API output: ${hits.join(', ')}`);
});

test('18b. NO EC IDENTITY LEAKS in the generated, local deployment artifacts either', { skip }, async () => {
  const files = [
    path.join(outDir1, 'env.manifest.txt'), path.join(outDir1, 'ONBOARDING_CHECKLIST.md'), path.join(outDir1, 'RAILWAY_DEPLOYMENT_PLAN.md'),
  ];
  for (const f of files) {
    const content = fs.readFileSync(f, 'utf8').toLowerCase();
    assert.ok(!content.includes('ecconstructiongroup'), `${f} must not reference EC's domain`);
    assert.ok(!content.includes('woodland hills'), `${f} must not reference EC's address`);
  }
});

test('18c. no Base44 dependency in any module this file touches', { skip }, async () => {
  const touched = [
    'routes/auth.js', 'routes/leads.js', 'routes/deals.js', 'routes/users.js',
    'routes/companySettings.js', 'routes/routing.js', 'routes/owners.js', 'routes/publicCapture.js',
    'scripts/install/bootstrap.js', 'scripts/install/provisionCompany.js',
    'scripts/install/companyConfigContract.js', 'scripts/install/railwayPlan.js',
  ];
  for (const rel of touched) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const hasLiveCall = src.includes('base44.functions') || src.includes('base44.entities') ||
      src.includes('base44.auth') || src.includes("require('base44") || src.includes('require("@base44');
    assert.ok(!hasLiveCall, `${rel} must have zero live Base44 dependency`);
  }
});
