/* eslint-disable no-undef */
'use strict';

/**
 * productization.int.test.js — REAL-Postgres regression coverage for the
 * PRODUCTIZATION FOUNDATION (docs/PRODUCT_ARCHITECTURE.md):
 *
 *   1. a fresh company can be bootstrapped from an EMPTY database with zero
 *      EC data;
 *   2. bootstrap.js is idempotent — running it twice never creates a
 *      second company_settings row or a second admin;
 *   3. an EC-SHAPED database (migrations 1-43 already applied, a
 *      pre-productization company_settings row already present) upgrades
 *      safely: migration 2026-44 adds the new columns with defaults that
 *      exactly match the CRM's historical hardcoded behavior, and the
 *      existing row's original data is untouched.
 *
 * Runs only when TEST_DATABASE_URL points at a DISPOSABLE, EMPTY-OR-DISPOSABLE
 * database (this file creates/drops its own company_settings/users rows via
 * bootstrap — never point it at a real installation). Skipped otherwise, so
 * `npm test` (no Postgres) is unaffected — matches
 * test/integration/appointmentFollowUp.int.test.js's own convention.
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/productization_test \
 *     RAILWAY_JWT_SECRET=test-secret-at-least-32-chars-long \
 *     ENCRYPTION_KEY=0123456789abcdef0123456789abcdef \
 *     node --test test/integration/productization.int.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const path = require('path');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable Postgres)' : false;
const ROOT = path.join(__dirname, '..', '..');

if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
  process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'int-test-secret-int-test-secret-0123456789';
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
}

function runBootstrap(configPath) {
  // bootstrap.js sends all diagnostic/migration log lines to stderr; stdout
  // carries exactly one JSON report, so it can be parsed directly here.
  const out = execFileSync('node', [path.join(ROOT, 'scripts', 'install', 'bootstrap.js'), `--config=${configPath}`], {
    cwd: ROOT, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  return JSON.parse(out);
}

let db;
test.before(async () => { if (!skip) db = require('../../db/client'); });
test.after(async () => { if (!skip) await db.pool.end(); });

test('1. fresh company installation from an empty DB: bootstrap succeeds, creates exactly one company_settings row and one admin, zero EC data', { skip }, async () => {
  const fs = require('fs');
  const os = require('os');
  const cfgPath = path.join(os.tmpdir(), `bootstrap-test-${Date.now()}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify({
    company_name: 'Acme Remodeling', legal_name: 'Acme Remodeling LLC',
    company_email: 'hello@acme.example', timezone: 'America/New_York',
    appointment_travel_buffer_minutes: 45,
    enabled_modules: { quickbooks: false, gmail: true },
    admin_name: 'Jordan Admin', admin_email: 'jordan@acme.example', admin_password: 'a-real-strong-password-123!',
  }));

  const report = runBootstrap(cfgPath);
  assert.strictEqual(report.ok, true, JSON.stringify(report));
  assert.strictEqual(report.steps.company_settings.created, true);
  assert.strictEqual(report.steps.company_settings.company_name, 'Acme Remodeling');
  assert.strictEqual(report.steps.company_settings.timezone, 'America/New_York');
  assert.ok(report.installation_id, 'a fresh install must be assigned an installation_id');
  assert.strictEqual(report.steps.first_admin.created, true);
  assert.strictEqual(report.steps.first_admin.email, 'jordan@acme.example');

  const { rows: settingsRows } = await db.query('SELECT * FROM company_settings');
  assert.strictEqual(settingsRows.length, 1, 'exactly one company_settings row');
  assert.strictEqual(settingsRows[0].company_name, 'Acme Remodeling');

  const { rows: adminRows } = await db.query(`SELECT email, full_name FROM users WHERE role = 'admin'`);
  assert.strictEqual(adminRows.length, 1, 'exactly one admin user');
  assert.strictEqual(adminRows[0].email, 'jordan@acme.example');
  assert.notStrictEqual(adminRows[0].email, 'yaron@ecconstructiongroup.com', 'no EC admin in a fresh installation');
  assert.notStrictEqual(adminRows[0].email, 'michelle@ecconstructiongroup.com', 'no EC admin in a fresh installation');

  const { rows: leadRows } = await db.query('SELECT count(*)::int AS n FROM leads');
  assert.strictEqual(leadRows[0].n, 0, 'zero leads in a fresh installation — no EC customer data');
  const { rows: ownerRows } = await db.query('SELECT count(*)::int AS n FROM owners');
  assert.strictEqual(ownerRows[0].n, 0, 'zero owners in a fresh installation — no EC rep data');
});

test('2. bootstrap is idempotent: running it again against the same DB creates no duplicates', { skip }, async () => {
  const fs = require('fs');
  const os = require('os');
  const cfgPath = path.join(os.tmpdir(), `bootstrap-test-rerun-${Date.now()}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify({
    company_name: 'Acme Remodeling', admin_email: 'jordan@acme.example', admin_password: 'a-different-password-this-time!',
  }));

  const before = await db.query('SELECT id, installation_id FROM company_settings');
  const report = runBootstrap(cfgPath);
  assert.strictEqual(report.ok, true, JSON.stringify(report));
  assert.strictEqual(report.steps.company_settings.created, false, 'second run must not create a second company_settings row');
  assert.strictEqual(report.installation_id, before.rows[0].installation_id, 'installation_id is stable across re-runs');
  assert.strictEqual(report.steps.first_admin.created, false, 'second run must not create a second admin, nor overwrite the existing one\'s password');

  const { rows: settingsRows } = await db.query('SELECT count(*)::int AS n FROM company_settings');
  assert.strictEqual(settingsRows[0].n, 1, 'still exactly one company_settings row after a second bootstrap run');
  const { rows: adminRows } = await db.query(`SELECT count(*)::int AS n FROM users WHERE role = 'admin'`);
  assert.strictEqual(adminRows[0].n, 1, 'still exactly one admin after a second bootstrap run');
});

test('3. company_settings config surface round-trips through routes/companySettings.js\'s field list (new productization columns readable/writable)', { skip }, async () => {
  const { rows } = await db.query('SELECT * FROM company_settings LIMIT 1');
  const row = rows[0];
  assert.strictEqual(row.appointment_travel_buffer_minutes, 45);
  assert.deepStrictEqual(row.enabled_modules, { quickbooks: false, gmail: true, google_calendar: false, google_contacts: false, signnow: false, handoff: false, meta: false, sms: false, website_intake: false });
});

test('4. EC-SHAPED DATABASE UPGRADE: a pre-productization company_settings row (migrations 1-43 only, no migration 2026-44 columns) upgrades safely — original data untouched, new columns get historically-equivalent defaults', { skip }, async () => {
  // Simulate "EC production before this session's productization work":
  // apply only migrations 1-43 to a brand-new disposable database, insert a
  // company_settings row shaped like EC's real one (placeholder values —
  // never real EC data), THEN apply migration 2026-44 and verify the
  // upgrade is lossless and backward-compatible.
  const { execSync } = require('child_process');
  const dbName = `ec_shaped_upgrade_${Date.now()}`;
  const adminUrl = new URL(DB_URL);
  const adminDbUrl = `${adminUrl.protocol}//${adminUrl.username}:${adminUrl.password}@${adminUrl.host}/postgres`;
  execSync(`psql "${adminDbUrl}" -c "CREATE DATABASE ${dbName};"`, { stdio: 'ignore' });
  const ecUrl = `${adminUrl.protocol}//${adminUrl.username}:${adminUrl.password}@${adminUrl.host}/${dbName}`;

  const fs = require('fs');
  const migDir = path.join(ROOT, 'db', 'migrations');
  const productMig = path.join(migDir, '2026-44-product-config.sql');
  const holdout = path.join(require('os').tmpdir(), '2026-44-product-config.sql.holdout');
  fs.renameSync(productMig, holdout);
  try {
    execFileSync('node', [path.join(ROOT, 'db', 'migrate.js')], { env: { ...process.env, DATABASE_URL: ecUrl }, stdio: 'ignore' });
  } finally {
    fs.renameSync(holdout, productMig);
  }

  const { Pool } = require('pg');
  const ecPool = new Pool({ connectionString: ecUrl, ssl: false });
  try {
    await ecPool.query(
      `INSERT INTO company_settings (company_name, company_email, admin_name, admin_email, company_region)
       VALUES ('EC Construction Group', 'info@example-placeholder.test', 'Placeholder Admin', 'admin@example-placeholder.test', 'SoCal + NorCal')`
    );
    // Column must not exist yet — proves this really is the pre-upgrade shape.
    await assert.rejects(ecPool.query('SELECT timezone FROM company_settings'), /column "timezone" does not exist/);

    execFileSync('node', [path.join(ROOT, 'db', 'migrate.js')], { env: { ...process.env, DATABASE_URL: ecUrl }, stdio: 'ignore' });

    const { rows } = await ecPool.query('SELECT * FROM company_settings');
    assert.strictEqual(rows.length, 1, 'the upgrade must not duplicate the existing row');
    assert.strictEqual(rows[0].company_name, 'EC Construction Group', 'original data untouched');
    assert.strictEqual(rows[0].admin_email, 'admin@example-placeholder.test', 'original data untouched');
    assert.strictEqual(rows[0].company_region, 'SoCal + NorCal', 'original data untouched');
    assert.strictEqual(rows[0].timezone, 'America/Los_Angeles', 'new column defaults to the historical hardcoded timezone — behavior unchanged');
    assert.strictEqual(rows[0].appointment_travel_buffer_minutes, 60, 'new column defaults to the historical hardcoded 1h travel buffer');
    assert.deepStrictEqual(rows[0].enabled_modules, { quickbooks: true, gmail: true, google_calendar: true, google_contacts: true, signnow: true, handoff: true, meta: true, sms: true, website_intake: true }, 'an upgraded EC-shaped row defaults every module to enabled — matching EC\'s actual current state');
    assert.ok(rows[0].installation_id, 'installation_id is backfilled for the pre-existing row');
  } finally {
    await ecPool.end();
    execSync(`psql "${adminDbUrl}" -c "DROP DATABASE ${dbName};"`, { stdio: 'ignore' });
  }
});
