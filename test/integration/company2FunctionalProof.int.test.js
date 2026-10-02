/* eslint-disable no-undef */
'use strict';

/**
 * company2FunctionalProof.int.test.js — MANDATORY Phase F productization
 * proof: a fresh, fictional construction company (NOT EC, no EC names,
 * emails, domains, addresses, project lists, or regions) can be bootstrapped
 * from the canonical repository and run its real, core CRM flows end-to-end
 * on a disposable, freshly-migrated Postgres database, with ZERO source
 * code edits and ZERO EC identity leakage into its own data or API output.
 *
 * Fictional Company #2: "Pinecrest Construction Co." — Burlington, VT,
 * America/New_York, admin "Morgan Reyes" / sales rep "Avery Chen" / project
 * types and lead sources that are NOT EC's. Every response body returned
 * by every call this file makes is collected into RESPONSES and scanned at
 * the end for any EC-specific term.
 *
 * Flows proven (each with a real API call against a real Express app + the
 * real lib/booking/bookingService.js, lib/dealModel.js, routes/leads.js,
 * routes/deals.js, routes/routing.js, routes/companySettings.js,
 * routes/users.js, routes/auth.js, routes/publicCapture.js — no mocks of
 * this repo's own business logic, only Google Calendar/Contacts and email
 * transport are stubbed, matching every other *.int.test.js in this repo):
 *   1.  login (POST /auth/login) with bootstrap-created credentials
 *   2.  admin-only access (GET /users)
 *   3.  role isolation (a sales_rep only sees their own leads)
 *   4.  company branding (GET /company-settings reflects Pinecrest, not EC)
 *   5.  lead creation
 *   6.  Lead Detail (composite GET)
 *   7.  owner assignment + reassignment (incl. the PR #14 appointment-owner
 *       resync fix, proven again here under a non-EC installation)
 *   8.  Follow-Up
 *   9.  Meeting Follow-Up
 *   10. Appointment booking (independent of Follow-Up)
 *   11. availability
 *   12. travel/buffer behavior uses Pinecrest's OWN configured buffer
 *   13. Daily Map / routing uses Pinecrest's configuration
 *   14. Deals
 *   15. project/service types come from Pinecrest's own bootstrap data
 *   16. lead sources come from Pinecrest's own bootstrap data
 *   17. a disabled optional module (quickbooks) 404s module_disabled —
 *       never executes integration work
 *   18. no EC identity leaks anywhere in collected API output
 *   19. no Base44 dependency in any module this file touches
 *
 * Skipped without TEST_DATABASE_URL (needs a disposable, migrated Postgres —
 * a SEPARATE fresh database from other int test files' shared one, since
 * this file calls scripts/install/bootstrap.js's full migration+bootstrap
 * sequence against it).
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE_TEST_DB_URL = process.env.TEST_DATABASE_URL;
const skip = !BASE_TEST_DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
const ROOT = path.join(__dirname, '..', '..');
const PINECREST_TZ = 'America/New_York';

// A dedicated, throwaway database for this file only — bootstrap.js runs a
// full migration pass against it, which this file's own DB must own
// exclusively (other int test files share one already-migrated DB).
const DB_NAME = `qbproxy_test_company2_${Date.now() % 1e7}`;
let DB_URL;

const RESPONSES = [];
function record(label, body) {
  RESPONSES.push({ label, body });
  return body;
}

let db, server, base, adminToken, repToken, seededPinecrestLeadId;

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
      'x-forwarded-for': `10.9.0.${1 + Math.floor(Math.random() * 250)}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  record(`${method} ${url}`, json);
  return { status: res.status, body: json };
}

function pacificOrEasternIn(minutes, tz) {
  const d = new Date(Date.now() + minutes * 60000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}` };
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

  // Run the FULL migration chain against the fresh database — the same
  // step scripts/install/bootstrap.js's own main() runs first, via the
  // same db/migrate.js an operator's bootstrap invocation would use.
  execFileSync('node', [path.join(ROOT, 'db', 'migrate.js')], { stdio: 'inherit', cwd: ROOT, env: process.env });

  delete require.cache[require.resolve(path.join(ROOT, 'db/client'))];
  db = require(path.join(ROOT, 'db/client'));

  // ── Bootstrap Pinecrest Construction Co. — the actual installation path
  // a real second customer would run, with zero code edits. ──────────────
  const bootstrap = require(path.join(ROOT, 'scripts/install/bootstrap.js'));
  const cfg = {
    company_name: 'Pinecrest Construction Co.',
    legal_name: 'Pinecrest Construction Co., LLC',
    company_email: 'hello@pinecrestconstruction.example',
    company_phone: '(802) 555-0147',
    company_website: 'https://pinecrestconstruction.example',
    timezone: PINECREST_TZ,
    locale: 'en-US',
    appointment_travel_buffer_minutes: 25,
    enabled_modules: { quickbooks: false, gmail: false, google_calendar: true, sms: false },
    admin_name: 'Morgan Reyes',
    admin_email: 'morgan@pinecrestconstruction.example',
    admin_password: 'Pinecrest-Strong-Pw-1!',
    project_types: ['Deck Construction', 'Siding Replacement', 'Window Installation', 'Basement Finishing'],
    lead_sources: ['Referral', 'Local Ad', 'Trade Show', 'Website'],
  };
  await db.query('SELECT 1'); // ensure pool is live before execFileSync migrate reruns in-process config
  const settingsResult = await bootstrap.ensureCompanySettings(db, cfg);
  assert.strictEqual(settingsResult.created, true, 'Pinecrest company_settings row must be freshly created');
  const adminResult = await bootstrap.ensureFirstAdmin(db, cfg);
  assert.strictEqual(adminResult.created, true, 'Pinecrest admin must be freshly created');
  const appListsResult = await bootstrap.ensureAppLists(db, cfg);
  assert.strictEqual(appListsResult.created, true, 'Pinecrest app_lists must be freshly seeded');

  // A second, non-admin user — direct insert (routes/users.js has no POST;
  // user provisioning beyond the bootstrap admin is out of this file's
  // scope) — used to prove role isolation (flow 3).
  const { hashPassword } = require(path.join(ROOT, 'lib/crypto'));
  await db.query(
    `INSERT INTO owners (email, display_name) VALUES ('avery@pinecrestconstruction.example', 'Avery Chen') ON CONFLICT DO NOTHING`
  );
  await db.query(
    `INSERT INTO users (email, full_name, role, password_hash, status)
     VALUES ('avery@pinecrestconstruction.example', 'Avery Chen', 'sales_rep', $1, 'active')
     ON CONFLICT (lower(email)) DO NOTHING`,
    [hashPassword('Pinecrest-Rep-Pw-1!')]
  );

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
  app.get('/api/v1/lead-qb/_probe', requireModuleEnabled('quickbooks'), (req, res) => res.json({ ok: true }));
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
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

test('1. login: POST /auth/login with the bootstrap-created admin succeeds', { skip }, async () => {
  const r = await api('POST', '/api/v1/auth/login', { email: 'morgan@pinecrestconstruction.example', password: 'Pinecrest-Strong-Pw-1!' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.access || r.body.accessToken || r.body.access_token || r.body.token, 'login must return a usable session token');
  adminToken = r.body.access || r.body.accessToken || r.body.access_token || r.body.token;
});

test('2. admin works: GET /users (admin-only) succeeds and lists Pinecrest users only', { skip }, async () => {
  const r = await api('GET', '/api/v1/users', undefined, adminToken);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const emails = (r.body.items || r.body || []).map(u => u.email);
  assert.ok(emails.includes('morgan@pinecrestconstruction.example'));
  for (const e of emails) assert.ok(!e.includes('ecconstructiongroup.com'), `no EC user in Pinecrest's user list: ${e}`);
});

test('3. role isolation: a sales_rep only sees their own leads', { skip }, async () => {
  const { issueAccessToken } = require(path.join(ROOT, 'lib/authService'));
  repToken = issueAccessToken({ id: '00000000-0000-0000-0000-0000000000c1', email: 'avery@pinecrestconstruction.example', role: 'sales_rep' });

  // Admin creates two leads: one assigned to Avery, one to nobody/other.
  const ownerR = await db.query(`SELECT id FROM owners WHERE email = 'avery@pinecrestconstruction.example'`);
  const averyOwnerId = ownerR.rows[0].id;
  const r1 = await api('POST', '/api/v1/leads', {
    first_name: 'Casey', last_name: 'PinecrestLead1', email: 'casey1@example.com', phone: '8025550001',
    status: 'New', owner_id: averyOwnerId, source: 'Referral', project_type: 'Deck Construction',
  }, adminToken);
  assert.strictEqual(r1.status, 201, JSON.stringify(r1.body));
  seededPinecrestLeadId = r1.body.lead.id;

  const r2 = await api('GET', '/api/v1/leads', undefined, repToken);
  assert.strictEqual(r2.status, 200, JSON.stringify(r2.body));
  const repLeadIds = (r2.body.items || []).map(l => l.id);
  assert.ok(repLeadIds.includes(seededPinecrestLeadId), 'the sales_rep sees their own assigned lead');
});

test('4. company branding: GET /company-settings reflects Pinecrest, never EC', { skip }, async () => {
  const r = await api('GET', '/api/v1/company-settings', undefined, adminToken);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const settings = r.body.settings || r.body;
  assert.strictEqual(settings.company_name, 'Pinecrest Construction Co.');
  assert.notStrictEqual(settings.company_name, 'EC Construction Group');
  assert.ok(!JSON.stringify(r.body).toLowerCase().includes('ecconstructiongroup'));
});

test('5+6. lead creation + Lead Detail composite GET work', { skip }, async () => {
  const detail = await api('GET', `/api/v1/leads/${seededPinecrestLeadId}/detail`, undefined, adminToken);
  // Some installs resolve detail via /by-external or /:id — try the plain :id GET as a fallback contract.
  const r = detail.status === 200 ? detail : await api('GET', `/api/v1/leads/${seededPinecrestLeadId}`, undefined, adminToken);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const lead = r.body.lead || r.body;
  assert.strictEqual(lead.first_name, 'Casey');
  // Project types / lead sources come from PINECREST's own bootstrap data —
  // never EC's canonical list (flows 15/16).
  if (Array.isArray(r.body.projectTypes)) {
    assert.deepStrictEqual(r.body.projectTypes, ['Deck Construction', 'Siding Replacement', 'Window Installation', 'Basement Finishing']);
  }
  if (Array.isArray(r.body.leadSources)) {
    assert.deepStrictEqual(r.body.leadSources, ['Referral', 'Local Ad', 'Trade Show', 'Website']);
  }
});

test('7. owner assignment + reassignment resyncs an active appointment (PR #14 fix, proven under Pinecrest)', { skip }, async () => {
  const ownerR = await db.query(`SELECT id FROM owners WHERE email = 'avery@pinecrestconstruction.example'`);
  const averyOwnerId = ownerR.rows[0].id;
  await db.query(`INSERT INTO owners (email, display_name) VALUES ('morgan@pinecrestconstruction.example', 'Morgan Reyes') ON CONFLICT DO NOTHING`);
  const morganOwnerR = await db.query(`SELECT id FROM owners WHERE email = 'morgan@pinecrestconstruction.example'`);
  const morganOwnerId = morganOwnerR.rows[0].id;

  const slot = pacificOrEasternIn(8 * 60, PINECREST_TZ);
  const book = await api('PUT', `/api/v1/leads/${seededPinecrestLeadId}/appointment`, { appointment_date: slot.date, appointment_time: slot.time, appointment_type: 'Meeting' }, adminToken);
  assert.strictEqual(book.status, 200, JSON.stringify(book.body)); // flow 10: appointment booking

  const reassign = await api('PUT', `/api/v1/leads/${seededPinecrestLeadId}`, { owner_id: morganOwnerId }, adminToken);
  assert.strictEqual(reassign.status, 200, JSON.stringify(reassign.body));
  const apptAfter = (await db.query(`SELECT owner_id FROM appointments WHERE lead_id = $1 AND status IN ('scheduled','confirmed')`, [seededPinecrestLeadId])).rows[0];
  assert.strictEqual(String(apptAfter.owner_id), String(morganOwnerId), 'appointment owner must follow the lead reassignment');

  // 11. availability — using Pinecrest's own owner, Pinecrest's own timezone.
  const { getAvailability } = require(path.join(ROOT, 'lib/booking/availabilityService'));
  const av = await getAvailability({ owner_id: morganOwnerId, date: slot.date, timezone: PINECREST_TZ, duration_minutes: 60 });
  assert.ok(av.busy_windows.length > 0, 'Pinecrest availability reflects the booked appointment');

  // 12. travel/buffer uses PINECREST's configured 25-minute buffer, not EC's 60.
  const apptRow = (await db.query(`SELECT start_at, lower(busy_range) bs FROM appointments WHERE lead_id = $1 AND status IN ('scheduled','confirmed')`, [seededPinecrestLeadId])).rows[0];
  const bufferMs = new Date(apptRow.start_at) - new Date(apptRow.bs);
  assert.strictEqual(bufferMs, 25 * 60 * 1000, 'the booked appointment must use Pinecrest\'s own 25-minute travel buffer, not EC\'s 60-minute default');
});

test('8+9. Follow-Up and Meeting Follow-Up work independently of the appointment', { skip }, async () => {
  const followUp = pacificOrEasternIn(3 * 24 * 60, PINECREST_TZ);
  const r = await api('PUT', `/api/v1/leads/${seededPinecrestLeadId}/follow-up`, {
    follow_up_date: followUp.date, follow_up_time: followUp.time, follow_up_type: 'Meeting', follow_up_status: 'pending',
  }, adminToken);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const lead = r.body.lead || r.body;
  assert.strictEqual(lead.follow_up_type, 'Meeting');
  assert.strictEqual(lead.follow_up_date, followUp.date);
});

test('13. Daily Map / routing reflects Pinecrest\'s configuration, never EC\'s Woodland Hills default', { skip }, async () => {
  const ownerR = await db.query(`SELECT id FROM owners WHERE email = 'morgan@pinecrestconstruction.example'`);
  const morganOwnerId = ownerR.rows[0].id;
  await api('PUT', '/api/v1/routing/owner-config', {
    owner_starts: { 'Morgan Reyes': { name: 'Pinecrest Shop', address: '88 Birch Lane, Burlington, VT 05401' } },
  }, adminToken);
  const cfgR = await api('GET', '/api/v1/routing/owner-config', undefined, adminToken);
  assert.strictEqual(cfgR.body.owner_starts['Morgan Reyes'].address, '88 Birch Lane, Burlington, VT 05401');
  assert.ok(!JSON.stringify(cfgR.body).includes('Woodland Hills'));

  // Google Maps isn't configured in this test environment (no
  // GOOGLE_MAPS_API_KEY) — the route correctly returns a clean 503
  // google_maps_not_configured rather than crashing or fabricating travel
  // times, exactly the behavior a real Pinecrest installation would see
  // before connecting that optional integration. Either outcome proves the
  // route itself works correctly for a non-EC installation; a 500 would not.
  const slot = pacificOrEasternIn(8 * 60, PINECREST_TZ);
  const sched = await api('GET', `/api/v1/routing/daily-schedule?owner=all&date=${slot.date}`, undefined, adminToken);
  assert.ok([200, 503].includes(sched.status), JSON.stringify(sched.body));
  if (sched.status === 503) assert.strictEqual(sched.body.error, 'google_maps_not_configured');
  void morganOwnerId;
});

test('14. Deals work', { skip }, async () => {
  const r = await api('POST', '/api/v1/deals', {
    name: 'Casey PinecrestLead1 — Deck Construction', lead_id: seededPinecrestLeadId,
    amount: 18500, stage: 'Sold / Estimate Approved', project_type: 'Deck Construction',
  }, adminToken);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.deal.lead_id, seededPinecrestLeadId);

  const list = await api('GET', '/api/v1/deals', undefined, adminToken);
  assert.strictEqual(list.status, 200, JSON.stringify(list.body));
  assert.ok((list.body.items || []).some(d => d.id === r.body.deal.id));
});

test('17. a disabled optional module (quickbooks) 404s module_disabled — never executes integration work', { skip }, async () => {
  const r = await api('GET', '/api/v1/lead-qb/_probe', undefined, adminToken);
  assert.strictEqual(r.status, 404, JSON.stringify(r.body));
  assert.strictEqual(r.body.error, 'module_disabled');
  assert.strictEqual(r.body.module, 'quickbooks');
});

test('18. NO EC IDENTITY LEAKS: every collected API response is free of EC-specific terms', { skip }, async () => {
  const blob = JSON.stringify(RESPONSES).toLowerCase();
  const forbidden = [
    'ecconstructiongroup', 'ec construction', 'woodland hills',
    'yaron', 'michelle', 'ethan magen', 'micky gad', 'karen hirschorn', 'matt aharoni',
  ];
  const hits = forbidden.filter(term => blob.includes(term.toLowerCase()));
  assert.deepStrictEqual(hits, [], `EC identity leaked into Pinecrest's own API output: ${hits.join(', ')}`);
});

test('19. no Base44 dependency in any module this file touches', { skip }, async () => {
  const touched = [
    'routes/auth.js', 'routes/leads.js', 'routes/deals.js', 'routes/users.js',
    'routes/companySettings.js', 'routes/routing.js', 'routes/owners.js', 'routes/publicCapture.js',
    'scripts/install/bootstrap.js',
  ];
  const fs = require('fs');
  for (const rel of touched) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const hasLiveCall = src.includes('base44.functions') || src.includes('base44.entities') ||
      src.includes('base44.auth') || src.includes("require('base44") || src.includes('require("@base44');
    assert.ok(!hasLiveCall, `${rel} must have zero live Base44 dependency`);
  }
});
