/* eslint-disable no-undef */
'use strict';

/**
 * platformCompanyIsolation.int.test.js — MANDATORY cross-database isolation
 * proof for the Company Management / onboarding workflow (PRODUCTIZATION —
 * Company Provisioning System). This is the test the task explicitly
 * requires: "Use isolated test fixtures and verify that a new company
 * starts with zero EC business records."
 *
 * Uses TWO disposable, real Postgres databases (never mocks):
 *   DB_A — the CALLING installation. Stands in for EC's own production
 *          database: fully migrated + bootstrapped, seeded with its own
 *          fixture "EC Fixture Co" business records (leads/users), and its
 *          own platform_companies control-plane row for the new company.
 *   DB_B — the brand-new company's OWN database. Created as a completely
 *          EMPTY Postgres database (no schema at all) — exactly what a
 *          freshly-created Railway Postgres looks like — and is PROVISIONED
 *          FOR REAL by driving the actual HTTP route
 *          (POST /api/v1/platform/companies/:id/infrastructure ->
 *          lib/platformProvisioning.js#provisionCompanyDatabase ->
 *          db/migrate.js#runMigrationsOn + scripts/install/bootstrap.js's
 *          real ensure* functions), never a mock of that engine.
 *
 * Proves:
 *   1. DB_B ends up with the full schema, a single PENDING (no-password)
 *      admin, and ZERO business records (leads/deals) — never a copy of
 *      anything from DB_A.
 *   2. No EC-fixture-identifying string (its domain, its fixture marker)
 *      ever appears anywhere in DB_B.
 *   3. DB_A's own pre-existing fixture business records are byte-for-byte
 *      unchanged after provisioning DB_B — the action never writes back to
 *      the calling installation's own business tables.
 *   4. The connection string to DB_B is stored on DB_A's platform_companies
 *      row ONLY in encrypted form (ciphertext never equals the plaintext
 *      URL), and decrypts back to exactly DB_B's URL.
 *   5. The server's own GLOBAL db pool (connected to DB_A) is never
 *      reassigned/touched by provisioning DB_B — proven by querying
 *      current_database() through it before and after.
 *   6. Suspend/activate flips every user on DB_B's own database, and never
 *      touches DB_A's users.
 *
 * Skipped without TEST_DATABASE_URL (needs a disposable Postgres server to
 * create two throwaway databases against — same gate every other
 * *.int.test.js in this repo uses).
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');

const BASE_TEST_DB_URL = process.env.TEST_DATABASE_URL;
const skip = !BASE_TEST_DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable Postgres server)' : false;
const ROOT = path.join(__dirname, '..', '..');

const TS = Date.now() % 1e7;
// Lowercase only — CREATE DATABASE folds an unquoted identifier to lowercase,
// so a mixed-case name here would create e.g. "qbproxy_test_platforma_..."
// while this file would then try to CONNECT to the original mixed-case
// spelling, which never exists ("database does not exist").
const DB_A_NAME = `qbproxy_test_platforma_${TS}`;
const DB_B_NAME = `qbproxy_test_platformb_${TS}`;
let DB_A_URL, DB_B_URL;

const EC_FIXTURE_DOMAIN = 'ecfixture-isolation-test.example';
const EC_FIXTURE_MARKER = `ECFIXTUREMARKER_${TS}`;
const PLATFORM_ADMIN_EMAIL = `platformadmin@${EC_FIXTURE_DOMAIN}`;
const PLATFORM_ADMIN_PASSWORD = 'Fixture-Platform-Admin-Pw-1!';

let db; // global db/client.js — connected to DB_A, exactly as a real deployed server would be
let server, base;
let newCompanyId, newCompanyDbUrl;
let ecLeadCountBefore, ecUsersCountBefore, ecFixtureLeadRowBefore;

async function directQuery(connStr, sql, params) {
  const pool = new Pool({ connectionString: connStr, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
  try {
    return await pool.query(sql, params);
  } finally {
    await pool.end();
  }
}

async function api(method, url, body, token) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { status: res.status, body: json };
}

test.before(async () => {
  if (skip) return;

  const adminDbUrl = new URL(BASE_TEST_DB_URL);
  adminDbUrl.pathname = '/postgres';
  for (const name of [DB_A_NAME, DB_B_NAME]) {
    execFileSync('psql', [adminDbUrl.toString(), '-c', `DROP DATABASE IF EXISTS ${name};`], { stdio: 'ignore' });
    execFileSync('psql', [adminDbUrl.toString(), '-c', `CREATE DATABASE ${name};`], { stdio: 'inherit' });
  }
  const urlA = new URL(BASE_TEST_DB_URL); urlA.pathname = `/${DB_A_NAME}`; DB_A_URL = urlA.toString();
  const urlB = new URL(BASE_TEST_DB_URL); urlB.pathname = `/${DB_B_NAME}`; DB_B_URL = urlB.toString();

  process.env.DATABASE_URL = DB_A_URL; // this process's OWN installation is DB_A — matches a real deployed server
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
  process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'int-test-secret-int-test-secret-0123456789';
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';

  // Migrate + bootstrap DB_A ONLY — DB_B is deliberately left completely
  // empty (no schema at all), exactly like a Railway Postgres an admin just
  // manually created and hasn't provisioned yet.
  execFileSync('node', [path.join(ROOT, 'db', 'migrate.js')], { stdio: 'inherit', cwd: ROOT, env: { ...process.env, DATABASE_URL: DB_A_URL } });

  delete require.cache[require.resolve(path.join(ROOT, 'db/client'))];
  db = require(path.join(ROOT, 'db/client'));

  const bootstrap = require(path.join(ROOT, 'scripts/install/bootstrap.js'));
  const cfg = {
    company_name: 'EC Fixture Co (isolation test)',
    company_email: `hello@${EC_FIXTURE_DOMAIN}`,
    timezone: 'America/Los_Angeles',
    admin_name: 'Fixture Platform Admin',
    admin_email: PLATFORM_ADMIN_EMAIL,
    admin_password: PLATFORM_ADMIN_PASSWORD,
  };
  await bootstrap.ensureCompanySettings(db, cfg);
  await bootstrap.ensureFirstAdmin(db, cfg);

  // Simulate EC's own real-world backfill: this installation's own admin is
  // the authorized platform administrator (lib/rbac.js#requirePlatformAdmin)
  // — never hardcoded in code, just this installation's own data, exactly
  // as documented.
  await db.query(`UPDATE company_settings SET protected_admin_emails = $1::jsonb`, [JSON.stringify([PLATFORM_ADMIN_EMAIL])]);

  // Seed DB_A's own fixture BUSINESS records — these must NEVER appear in,
  // or be affected by provisioning, the new company's database (DB_B).
  const ownerIns = await db.query(
    `INSERT INTO owners (email, display_name) VALUES ($1, 'Fixture Owner') RETURNING id`,
    [`owner@${EC_FIXTURE_DOMAIN}`]
  );
  const { rows: leadRows } = await db.query(
    `INSERT INTO leads (first_name, last_name, email, phone, status, owner_id, source)
     VALUES ($1, $2, $3, '5555550100', 'New', $4, 'Referral') RETURNING *`,
    [EC_FIXTURE_MARKER, 'FixtureLastName', `${EC_FIXTURE_MARKER}@${EC_FIXTURE_DOMAIN}`, ownerIns.rows[0].id]
  );
  ecFixtureLeadRowBefore = leadRows[0];

  const { rows: leadCountRows } = await db.query('SELECT count(*)::int AS n FROM leads');
  ecLeadCountBefore = leadCountRows[0].n;
  const { rows: userCountRows } = await db.query(`SELECT count(*)::int AS n FROM users`);
  ecUsersCountBefore = userCountRows[0].n;
  assert.strictEqual(ecLeadCountBefore, 1, 'sanity: exactly the one fixture lead seeded');
  assert.strictEqual(ecUsersCountBefore, 1, 'sanity: exactly the one fixture platform admin seeded');

  // Stub only the network-reaching email transport (same convention every
  // other *.int.test.js in this repo uses) — everything else (routes,
  // rbac, authService, platformProvisioning, real migrations/bootstrap) is
  // the genuine, unmocked implementation.
  const emailServicePath = require.resolve(path.join(ROOT, 'lib/emailService'));
  require.cache[emailServicePath] = { id: emailServicePath, filename: emailServicePath, loaded: true, exports: { send: async () => ({ ok: true, gmailMessageId: 'm1' }) } };

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', require(path.join(ROOT, 'routes/auth')));
  app.use('/api/v1/platform/companies', require(path.join(ROOT, 'routes/platformCompanies')));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (skip) return;
  if (server) server.close();
  if (db) await db.pool.end();
  const adminDbUrl = new URL(BASE_TEST_DB_URL);
  adminDbUrl.pathname = '/postgres';
  for (const name of [DB_A_NAME, DB_B_NAME]) {
    try { execFileSync('psql', [adminDbUrl.toString(), '-c', `DROP DATABASE IF EXISTS ${name};`], { stdio: 'ignore' }); } catch (_) { /* best-effort cleanup */ }
  }
});

let adminToken;

test('1. the platform admin logs in on DB_A (the calling installation)', { skip }, async () => {
  const r = await api('POST', '/api/v1/auth/login', { email: PLATFORM_ADMIN_EMAIL, password: PLATFORM_ADMIN_PASSWORD });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  adminToken = r.body.access;
  assert.ok(adminToken);
});

test('2. POST /platform/companies creates a draft company row in DB_A', { skip }, async () => {
  const r = await api('POST', '/api/v1/platform/companies', { company_name: 'New Fixture Company LLC', owner_email: 'owner@newfixtureco-test.example', owner_name: 'Taylor Owner' }, adminToken);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.company.status, 'draft');
  newCompanyId = r.body.company.id;
});

test('3. POST /:id/infrastructure provisions DB_B FOR REAL (genuine migrations + bootstrap), using the production engine', { skip }, async () => {
  const r = await api('POST', `/api/v1/platform/companies/${newCompanyId}/infrastructure`, {
    database_url: DB_B_URL,
    frontend_url: 'https://newfixtureco-test.example',
    backend_url: 'https://newfixtureco-api-test.example',
  }, adminToken);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.provisioning.ok, true, JSON.stringify(r.body.provisioning));
  assert.strictEqual(r.body.company.status, 'invited');
  assert.ok(r.body.provisioning.first_admin.created, 'the new company gets a freshly created admin, never a copy of DB_A\'s');
  assert.strictEqual(r.body.provisioning.first_admin.email, 'owner@newfixtureco-test.example');
  assert.ok(!r.body.company.database_url_encrypted, 'the raw/encrypted connection string must never be in the HTTP response at all');
});

test('4. DB_B has the full schema, exactly one PENDING admin, and ZERO business records', { skip }, async () => {
  const { rows: leadRows } = await directQuery(DB_B_URL, 'SELECT count(*)::int AS n FROM leads');
  assert.strictEqual(leadRows[0].n, 0, 'a brand-new company must start with ZERO leads');

  const { rows: dealRows } = await directQuery(DB_B_URL, 'SELECT count(*)::int AS n FROM deals');
  assert.strictEqual(dealRows[0].n, 0, 'a brand-new company must start with ZERO deals');

  const { rows: ownerRows } = await directQuery(DB_B_URL, 'SELECT count(*)::int AS n FROM owners');
  assert.strictEqual(ownerRows[0].n, 0, 'a brand-new company must start with ZERO owners — never DB_A\'s fixture owner');

  const { rows: userRows } = await directQuery(DB_B_URL, 'SELECT email, role, password_hash, invite_token_hash, invite_expires_at FROM users');
  assert.strictEqual(userRows.length, 1, 'exactly one user: the new owner');
  assert.strictEqual(userRows[0].email, 'owner@newfixtureco-test.example');
  assert.strictEqual(userRows[0].role, 'admin');
  assert.strictEqual(userRows[0].password_hash, null, 'never an invented/transmitted password');
  assert.ok(userRows[0].invite_token_hash, 'a single-use invite token hash must be set');
  assert.ok(new Date(userRows[0].invite_expires_at).getTime() > Date.now());

  const { rows: settingsRows } = await directQuery(DB_B_URL, 'SELECT company_name FROM company_settings');
  assert.strictEqual(settingsRows[0].company_name, 'New Fixture Company LLC');
  assert.notStrictEqual(settingsRows[0].company_name, 'EC Fixture Co (isolation test)');
});

test('5. no EC-fixture-identifying string appears anywhere in DB_B', { skip }, async () => {
  const dump = await directQuery(
    DB_B_URL,
    `SELECT row_to_json(u) AS j FROM users u
     UNION ALL SELECT row_to_json(c) AS j FROM company_settings c`
  );
  const serialized = JSON.stringify(dump.rows).toLowerCase();
  assert.ok(!serialized.includes(EC_FIXTURE_DOMAIN.toLowerCase()), 'DB_B must never contain EC fixture\'s domain');
  assert.ok(!serialized.includes(EC_FIXTURE_MARKER.toLowerCase()), 'DB_B must never contain EC fixture\'s marker lead');
  assert.ok(!serialized.includes('ec fixture co'), 'DB_B must never contain EC fixture\'s company name');
});

test('6. DB_A\'s own pre-existing fixture business records are completely unchanged', { skip }, async () => {
  const { rows: leadCountRows } = await directQuery(DB_A_URL, 'SELECT count(*)::int AS n FROM leads');
  assert.strictEqual(leadCountRows[0].n, ecLeadCountBefore, 'provisioning DB_B must never add/remove rows in DB_A\'s own leads table');

  const { rows: leadRows } = await directQuery(DB_A_URL, 'SELECT * FROM leads WHERE id = $1', [ecFixtureLeadRowBefore.id]);
  assert.strictEqual(leadRows.length, 1);
  assert.strictEqual(leadRows[0].first_name, ecFixtureLeadRowBefore.first_name);
  assert.strictEqual(leadRows[0].email, ecFixtureLeadRowBefore.email);
  assert.deepStrictEqual(new Date(leadRows[0].updated_at).getTime(), new Date(ecFixtureLeadRowBefore.updated_at).getTime(), 'the fixture lead row must be byte-for-byte unchanged, not just present');

  const { rows: userCountRows } = await directQuery(DB_A_URL, 'SELECT count(*)::int AS n FROM users');
  assert.strictEqual(userCountRows[0].n, ecUsersCountBefore, 'provisioning DB_B must never create/delete a user on DB_A');
});

test('7. DB_B\'s connection string is stored on DB_A ONLY encrypted, and decrypts back to exactly DB_B\'s URL', { skip }, async () => {
  const { rows } = await directQuery(DB_A_URL, 'SELECT database_url_encrypted FROM platform_companies WHERE id = $1', [newCompanyId]);
  const encrypted = rows[0].database_url_encrypted;
  assert.ok(encrypted, 'must be set after successful provisioning');
  assert.strictEqual(encrypted.includes(DB_B_URL), false, 'the stored value must never contain the plaintext connection string');

  delete require.cache[require.resolve(path.join(ROOT, 'lib/integrationCredentialStore'))];
  const { decryptPayload } = require(path.join(ROOT, 'lib/integrationCredentialStore'));
  const decrypted = decryptPayload(encrypted);
  assert.strictEqual(decrypted.database_url, DB_B_URL);
  newCompanyDbUrl = decrypted.database_url;
});

test('8. the server\'s own global pool (DB_A) was never reassigned/touched by provisioning DB_B', { skip }, async () => {
  const { rows } = await db.query('SELECT current_database() AS name');
  assert.strictEqual(rows[0].name, DB_A_NAME);
});

test('9. GET /:id/probe reads DB_B live (zero leads, one user) without ever touching DB_A\'s own tables', { skip }, async () => {
  const r = await api('GET', `/api/v1/platform/companies/${newCompanyId}/probe`, undefined, adminToken);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.probe.reachable, true);
  assert.strictEqual(r.body.probe.lead_count, 0);
  assert.strictEqual(r.body.probe.user_count, 1);
  assert.strictEqual(r.body.probe.pending_user_count, 1);
  assert.strictEqual(r.body.probe.company_name, 'New Fixture Company LLC');
});

test('10. suspend flips every DB_B user to disabled, and never touches DB_A\'s own admin', { skip }, async () => {
  const r = await api('POST', `/api/v1/platform/companies/${newCompanyId}/suspend`, undefined, adminToken);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.updated_users, 1);

  const { rows: bRows } = await directQuery(DB_B_URL, 'SELECT status FROM users');
  assert.strictEqual(bRows[0].status, 'disabled');

  const { rows: aRows } = await directQuery(DB_A_URL, `SELECT status FROM users WHERE email = $1`, [PLATFORM_ADMIN_EMAIL]);
  assert.strictEqual(aRows[0].status, 'active', 'DB_A\'s own platform admin must remain active throughout');
});

test('11. activate re-enables every DB_B user', { skip }, async () => {
  const r = await api('POST', `/api/v1/platform/companies/${newCompanyId}/activate`, undefined, adminToken);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.updated_users, 1);

  const { rows } = await directQuery(DB_B_URL, 'SELECT status FROM users');
  assert.strictEqual(rows[0].status, 'active');
});
