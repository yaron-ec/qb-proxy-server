#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * scripts/install/bootstrap.js — idempotent installation bootstrap for a
 * NEW company/installation of this CRM product
 * (PRODUCTIZATION FOUNDATION — see docs/PRODUCT_ARCHITECTURE.md and
 * docs/NEW_COMPANY_INSTALL.md).
 *
 * Runs entirely against DATABASE_URL from the environment. Never talks to
 * any other installation's database, never reads/writes EC-specific data,
 * and contains zero hardcoded company facts — every value it writes comes
 * from its own config input (a JSON file or environment variables) or from
 * lib/companyConfig.js's PRODUCT_DEFAULTS (last-resort fallbacks, not
 * company-specific data).
 *
 * IDEMPOTENT: running this twice against the same database never creates a
 * second company_settings row, a second admin user, or duplicate anything.
 * A second run reports the existing state instead of erroring.
 *
 * Usage:
 *   node scripts/install/bootstrap.js --config=./company.json
 *   # or, with no --config, every value below is read from env vars
 *
 * company.json shape (all top-level keys optional except company_name and
 * admin_email/admin_password for a genuinely fresh install):
 *   {
 *     "company_name": "Acme Remodeling",
 *     "legal_name": "Acme Remodeling LLC",
 *     "dba": null,
 *     "company_email": "hello@acme.example",
 *     "company_phone": "(555) 555-0100",
 *     "company_website": "https://acme.example",
 *     "timezone": "America/New_York",
 *     "locale": "en-US",
 *     "appointment_travel_buffer_minutes": 60,
 *     "business_hours": { "start": "08:30", "end": "18:30" },
 *     "brand_primary_color": "#f59e0b",
 *     "enabled_modules": { "quickbooks": false, "gmail": true, ... },
 *     "admin_name": "Jordan Admin",
 *     "admin_email": "jordan@acme.example",
 *     "admin_password": "set-a-real-password-here"
 *   }
 *
 * Equivalent environment variables (used only for keys company.json omits):
 *   COMPANY_NAME, COMPANY_LEGAL_NAME, COMPANY_DBA, COMPANY_EMAIL,
 *   COMPANY_PHONE, COMPANY_WEBSITE, COMPANY_TIMEZONE, COMPANY_LOCALE,
 *   APPOINTMENT_TRAVEL_BUFFER_MINUTES, BOOTSTRAP_ADMIN_NAME,
 *   BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD
 *
 * Exit code: 0 on success (including "already bootstrapped, nothing to do");
 * 1 on any validation/connectivity failure. Prints a JSON install report to
 * stdout as its last line either way.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

const args = process.argv.slice(2);
const flagValue = (name) => {
  const f = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!f) return null;
  return f.includes('=') ? f.split('=').slice(1).join('=') : null;
};

function loadConfig() {
  const configPath = flagValue('config');
  const fromFile = configPath ? JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf8')) : {};
  const env = process.env;
  return {
    company_name: fromFile.company_name ?? env.COMPANY_NAME ?? null,
    legal_name: fromFile.legal_name ?? env.COMPANY_LEGAL_NAME ?? null,
    dba: fromFile.dba ?? env.COMPANY_DBA ?? null,
    company_email: fromFile.company_email ?? env.COMPANY_EMAIL ?? null,
    company_phone: fromFile.company_phone ?? env.COMPANY_PHONE ?? null,
    company_website: fromFile.company_website ?? env.COMPANY_WEBSITE ?? null,
    timezone: fromFile.timezone ?? env.COMPANY_TIMEZONE ?? null,
    locale: fromFile.locale ?? env.COMPANY_LOCALE ?? null,
    appointment_travel_buffer_minutes: fromFile.appointment_travel_buffer_minutes ?? (env.APPOINTMENT_TRAVEL_BUFFER_MINUTES ? Number(env.APPOINTMENT_TRAVEL_BUFFER_MINUTES) : null),
    business_hours: fromFile.business_hours ?? null,
    brand_primary_color: fromFile.brand_primary_color ?? env.COMPANY_BRAND_PRIMARY_COLOR ?? null,
    enabled_modules: fromFile.enabled_modules ?? null,
    notification_recipients: fromFile.notification_recipients ?? null,
    email_from_name: fromFile.email_from_name ?? env.COMPANY_EMAIL_FROM_NAME ?? null,
    default_owner_email: fromFile.default_owner_email ?? env.COMPANY_DEFAULT_OWNER_EMAIL ?? null,
    default_owner_name: fromFile.default_owner_name ?? env.COMPANY_DEFAULT_OWNER_NAME ?? null,
    admin_name: fromFile.admin_name ?? env.BOOTSTRAP_ADMIN_NAME ?? null,
    admin_email: fromFile.admin_email ?? env.BOOTSTRAP_ADMIN_EMAIL ?? null,
    admin_password: fromFile.admin_password ?? env.BOOTSTRAP_ADMIN_PASSWORD ?? null,
  };
}

// ── Required environment variables for a functioning core CRM (no optional
// integration is required — see docs/INTEGRATIONS_SETUP.md) ────────────────
const REQUIRED_ENV = ['DATABASE_URL', 'RAILWAY_JWT_SECRET', 'ENCRYPTION_KEY'];
// Optional-but-recommended: presence is reported, absence never fails bootstrap.
const OPTIONAL_INTEGRATION_ENV = {
  quickbooks: ['QB_CLIENT_ID', 'QB_CLIENT_SECRET', 'QB_REDIRECT_URI'],
  gmail: ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET'],
  google_calendar: ['GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_SERVICE_ACCOUNT_KEY'],
  signnow: ['SIGNNOW_CLIENT_ID', 'SIGNNOW_CLIENT_SECRET'],
  handoff: ['HANDOFF_API_KEY'],
  meta: ['META_APP_SECRET'],
  sms: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
  website_intake: ['WEBSITE_LEAD_WEBHOOK_SECRET'],
};

function validateRequiredEnv() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  return { ok: missing.length === 0, missing };
}

function integrationEnvStatus() {
  const out = {};
  for (const [mod, keys] of Object.entries(OPTIONAL_INTEGRATION_ENV)) {
    const present = keys.filter((k) => !!process.env[k]);
    out[mod] = { configured: present.length === keys.length, present, missing: keys.filter((k) => !process.env[k]) };
  }
  return out;
}

function runMigrations() {
  // Migration log lines go to OUR stderr (still visible to an operator /
  // CI log), never our stdout — stdout is reserved for exactly one JSON
  // report line at the very end, so a caller (or the integration test
  // suite) can reliably parse this script's result without scraping
  // human-readable log noise out of it first.
  execFileSync('node', [path.join(ROOT, 'db', 'migrate.js')], { stdio: ['ignore', process.stderr, process.stderr], cwd: ROOT, env: process.env });
}

async function ensureCompanySettings(db, cfg) {
  const existing = await db.query('SELECT * FROM company_settings ORDER BY created_at ASC LIMIT 1');
  if (existing.rows[0]) {
    return { created: false, row: existing.rows[0] };
  }
  if (!cfg.company_name) {
    throw new Error('No company_settings row exists yet and no company_name was provided (via --config or COMPANY_NAME) — cannot bootstrap.');
  }
  const cols = ['company_name'];
  const vals = [cfg.company_name];
  const optional = [
    ['legal_name', cfg.legal_name], ['dba', cfg.dba], ['company_email', cfg.company_email],
    ['company_phone', cfg.company_phone], ['company_website', cfg.company_website],
    ['admin_name', cfg.admin_name], ['admin_email', cfg.admin_email],
  ];
  for (const [col, val] of optional) if (val != null) { cols.push(col); vals.push(val); }
  if (cfg.timezone) { cols.push('timezone'); vals.push(cfg.timezone); }
  if (cfg.locale) { cols.push('locale'); vals.push(cfg.locale); }
  if (Number.isFinite(cfg.appointment_travel_buffer_minutes)) { cols.push('appointment_travel_buffer_minutes'); vals.push(cfg.appointment_travel_buffer_minutes); }
  if (cfg.business_hours && typeof cfg.business_hours.start === 'string' && typeof cfg.business_hours.end === 'string') {
    cols.push('business_hours'); vals.push(JSON.stringify(cfg.business_hours));
  }
  if (cfg.brand_primary_color) { cols.push('brand_primary_color'); vals.push(cfg.brand_primary_color); }
  let modulesJson = null;
  if (cfg.enabled_modules) {
    const MODULE_KEYS = ['quickbooks', 'gmail', 'google_calendar', 'google_contacts', 'signnow', 'handoff', 'meta', 'sms', 'website_intake'];
    const clean = {};
    for (const k of MODULE_KEYS) clean[k] = cfg.enabled_modules[k] === true;
    modulesJson = JSON.stringify(clean);
    cols.push('enabled_modules');
    vals.push(modulesJson);
  }
  const jsonbCols = new Set(['enabled_modules', 'notification_recipients']);

  // Notification routing (PRODUCTIZATION PHASE 2): a fresh installation NEVER
  // inherits the column default's EC addresses (see
  // db/migrations/2026-47-notification-config.sql) — it explicitly writes
  // its own admin as the sole recipient unless company.json overrides this.
  const notifTo = Array.isArray(cfg.notification_recipients?.to) ? cfg.notification_recipients.to
    : (cfg.admin_email ? [cfg.admin_email] : []);
  const notifCc = Array.isArray(cfg.notification_recipients?.cc) ? cfg.notification_recipients.cc : [];
  cols.push('notification_recipients');
  vals.push(JSON.stringify({ to: notifTo, cc: notifCc }));

  cols.push('email_from_name');
  vals.push(cfg.email_from_name || (cfg.company_name ? `${cfg.company_name} CRM` : 'CRM'));

  // Default owner routing fallback: a fresh installation's own admin, never
  // 'Yaron Drilevich' / yaron@ecconstructiongroup.com (both columns are
  // NOT NULL, with that EC-shaped literal as their own upgrade-preserving
  // column DEFAULT — see migration 2026-47 — so simply omitting the column
  // here would silently resurrect EC's identity for a fresh install; never
  // do that). admin_name is documented optional (ensureFirstAdmin itself
  // defers admin creation gracefully when admin_email/admin_password are
  // absent too) — 'Admin' is a neutral placeholder, matching the same
  // never-EC-never-null discipline email_from_name already uses above.
  cols.push('default_owner_name');
  vals.push(cfg.default_owner_name || cfg.admin_name || 'Admin');
  const defaultOwnerEmail = cfg.default_owner_email || cfg.admin_email || cfg.company_email || null;
  if (!defaultOwnerEmail) {
    throw new Error('No default_owner_email, admin_email, or company_email provided — at least one contact email is required to bootstrap a new installation.');
  }
  cols.push('default_owner_email');
  vals.push(defaultOwnerEmail);

  // A fresh installation protects no admin beyond the generic "cannot
  // delete the last remaining admin" rule (routes/users.js) — never
  // EC's Yaron/Michelle emails (see migration 2026-45's column default,
  // which this explicit empty array intentionally overrides).
  cols.push('protected_admin_emails');
  vals.push(JSON.stringify([]));
  jsonbCols.add('protected_admin_emails');

  const placeholders = cols.map((c, i) => (jsonbCols.has(c) ? `$${i + 1}::jsonb` : `$${i + 1}`));
  const { rows } = await db.query(
    `INSERT INTO company_settings (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
    vals
  );
  return { created: true, row: rows[0] };
}

async function ensureFirstAdmin(db, cfg) {
  const { rows: anyAdmins } = await db.query(`SELECT id, email FROM users WHERE role = 'admin' LIMIT 1`);
  if (anyAdmins[0]) {
    return { created: false, user: anyAdmins[0] };
  }
  if (!cfg.admin_email || !cfg.admin_password) {
    return { created: false, user: null, reason: 'no admin exists yet and admin_email/admin_password were not provided — create one via POST /api/v1/auth/register-first-admin or the API once deployed' };
  }
  const { hashPassword } = require('../../lib/crypto');
  const hash = hashPassword(cfg.admin_password);
  const { rows } = await db.query(
    `INSERT INTO users (email, full_name, role, password_hash, status)
     VALUES (lower($1), $2, 'admin', $3, 'active')
     ON CONFLICT (lower(email)) DO NOTHING
     RETURNING id, email, full_name, role`,
    [cfg.admin_email, cfg.admin_name || null, hash]
  );
  if (rows[0]) return { created: true, user: rows[0] };
  // A concurrent bootstrap (or a non-admin user with this email already
  // existed) — re-read rather than silently claiming success.
  const { rows: reread } = await db.query('SELECT id, email, full_name, role FROM users WHERE lower(email) = lower($1)', [cfg.admin_email]);
  return { created: false, user: reread[0] || null, reason: reread[0] ? 'a user with this email already existed (not promoted — bootstrap never changes an existing user\'s role)' : 'insert raced and re-read found nothing (unexpected)' };
}

async function main() {
  const report = { ok: false, steps: {}, timestamp: new Date().toISOString() };

  const envCheck = validateRequiredEnv();
  report.steps.env = envCheck;
  if (!envCheck.ok) {
    report.error = `Missing required environment variables: ${envCheck.missing.join(', ')}`;
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  console.error('[bootstrap] running migrations...');
  try {
    runMigrations();
    report.steps.migrations = { ok: true };
  } catch (e) {
    report.steps.migrations = { ok: false, error: e.message };
    report.error = 'Migrations failed — see output above.';
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const db = require('../../db/client');
  const cfg = loadConfig();
  try {
    const settingsResult = await ensureCompanySettings(db, cfg);
    report.steps.company_settings = {
      created: settingsResult.created,
      company_name: settingsResult.row.company_name,
      installation_id: settingsResult.row.installation_id,
      timezone: settingsResult.row.timezone,
    };

    const adminResult = await ensureFirstAdmin(db, cfg);
    report.steps.first_admin = {
      created: adminResult.created,
      email: adminResult.user?.email || null,
      reason: adminResult.reason || (adminResult.created ? 'created' : 'already existed'),
    };

    report.steps.integrations = integrationEnvStatus();

    const { rows: migCount } = await db.query('SELECT count(*)::int AS n FROM schema_migrations');
    report.steps.schema = { migrations_applied: migCount[0].n };

    report.installation_id = settingsResult.row.installation_id;
    report.ok = true;
  } catch (e) {
    report.error = e.message;
    console.log(JSON.stringify(report, null, 2));
    await db.pool.end();
    process.exit(1);
  }

  console.log(JSON.stringify(report, null, 2));
  await db.pool.end();
  process.exit(report.ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => { console.error('[bootstrap] FAILED:', e.message); process.exit(1); });
}

module.exports = { loadConfig, validateRequiredEnv, integrationEnvStatus, ensureCompanySettings, ensureFirstAdmin };
