#!/usr/bin/env node
/* eslint-disable no-undef */
'use strict';

/**
 * provisionCompany.js — the supported, end-to-end operator entry point for
 * installing a NEW company on this CRM product (PRODUCTIZATION — Company
 * Provisioning System; see docs/INSTALL_NEW_COMPANY.md for the full operator
 * workflow this implements).
 *
 * Usage:
 *   npm run provision-company -- --config=./my-company.json
 *   npm run provision-company -- --config=./my-company.json --validate-only
 *   npm run provision-company -- --config=./my-company.json --generate-secrets --out=./provisioning-output/acme
 *
 * WHAT THIS DOES, IN ORDER (never skips ahead on failure):
 *   1. Load + validate the config file against
 *      scripts/install/companyConfigContract.js's FULL contract (identity,
 *      branding, admin, business, modules, infra). Fails clearly with every
 *      problem listed at once — NO database connection is attempted until
 *      validation passes. This step alone is `--validate-only`.
 *   2. Compute, from the config's OWN frontend_url/backend_url, the exact
 *      OAuth/webhook callback URL each enabled module needs registered with
 *      its provider, and which secret env vars are present/missing in THIS
 *      process's environment (informational — secrets live on the Railway
 *      deployment, not in company.json, and are never required to be set in
 *      the environment that runs this script).
 *   3. If not --validate-only: requires DATABASE_URL to be set (to the NEW
 *      company's OWN, otherwise-empty-or-matching database — see "Database
 *      safety" below), then delegates the actual schema/data provisioning to
 *      scripts/install/bootstrap.js (run as a subprocess so there is exactly
 *      ONE implementation of "create company_settings / first admin /
 *      app_lists / owner_starting_locations", never a second copy here).
 *   4. Runs a handful of direct-DB post-provision health checks (point 13 in
 *      the Phase B spec) — confirms the row this run expected actually
 *      exists with the right shape, never trusts bootstrap.js's own exit
 *      code alone.
 *   5. Writes a deployment env-variable manifest and an onboarding checklist
 *      (callback URLs, which secrets/OAuth steps remain) to --out (default:
 *      ./provisioning-output/<company_slug>/<timestamp>/) — gitignored, NEVER
 *      printed with real secret VALUES, NEVER written into the repository.
 *   6. Prints ONE final JSON installation report to stdout (same convention
 *      as bootstrap.js) with a REDACTED config (admin_password and every
 *      secretEnvVar value stripped).
 *
 * DATABASE SAFETY: before any write, requires
 * lib/installationIdentity.js#requireInstallationConfirmation to resolve —
 * using the config's OWN company_name as the confirmation value (the only
 * two fields requireInstallationConfirmation ever matches against are
 * installation_id and company_name — not company_slug). On a truly fresh
 * database (nothing provisioned yet) any non-empty value is accepted (see
 * installationIdentity.js's own doc comment), so having company_name in
 * your config file IS the deliberate opt-in. On a REPEAT run against the
 * SAME, already-provisioned installation, company_name still matches (that
 * is what makes idempotent re-runs work without extra flags). On a database
 * that already holds A DIFFERENT company's data (e.g. a mistyped
 * DATABASE_URL pointed at EC's own production database, or another
 * company's), this company's name will not match that database's real
 * installation_id/company_name, and this script refuses to proceed —
 * turning a classic copy-paste accident into a clear, safe failure instead
 * of silent data corruption.
 *
 * IDEMPOTENCY: every DB-side step (bootstrap.js's ensureCompanySettings /
 * ensureFirstAdmin / ensureAppLists / ensureOwnerStartingLocation) already
 * checks "does this already exist" before writing — re-running this script
 * against the same database is always safe and reports what already existed
 * instead of erroring or duplicating. Re-running NEVER rotates
 * RAILWAY_JWT_SECRET/ENCRYPTION_KEY or any other secret — --generate-secrets
 * only ever writes a freshly SUGGESTED value to the (gitignored, local) --out
 * manifest file for the operator to review and apply manually; it never
 * touches a live deployment or an existing secret.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const contract = require('./companyConfigContract');

const args = process.argv.slice(2);
const flagValue = (name) => {
  const f = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!f) return null;
  return f.includes('=') ? f.split('=').slice(1).join('=') : true;
};
const hasFlag = (name) => args.includes(`--${name}`);

function redactConfig(cfg) {
  const redacted = { ...cfg };
  for (const spec of contract.FIELD_SPECS) {
    if (spec.secret && redacted[spec.key] !== undefined) redacted[spec.key] = '<redacted>';
  }
  return redacted;
}

function loadConfigFile(configPath) {
  if (!configPath) {
    throw new Error('Usage: npm run provision-company -- --config=<path-to-company.json> [--validate-only] [--generate-secrets] [--out=<dir>]');
  }
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) throw new Error(`Config file not found: ${resolved}`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (e) {
    throw new Error(`Config file is not valid JSON: ${e.message}`);
  }
  return raw;
}

function defaultOutDir(cfg) {
  const slug = (cfg.company_slug || 'company').replace(/[^a-z0-9-]/gi, '-');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(ROOT, 'provisioning-output', slug, stamp);
}

function generateSecret() {
  return crypto.randomBytes(32).toString('hex');
}

/** Builds the full onboarding checklist: callback URLs + secret/OAuth status per enabled module. */
function buildOnboardingChecklist(cfg) {
  const callbacks = contract.computeCallbackUrls(cfg);
  const enabled = cfg.enabled_modules || {};
  const checklist = [];
  for (const key of contract.MODULE_KEYS) {
    if (enabled[key] !== true) continue;
    const info = callbacks[key];
    const missingEnv = info.secret_env_vars.filter((v) => !process.env[v]);
    checklist.push({
      module: key,
      label: info.label,
      requires_human_authorization: info.oauth_required,
      provider: info.provider,
      instructions: info.note,
      callback_or_webhook_url: info.callback_url,
      callback_env_var: info.callback_env_var,
      required_secret_env_vars: info.secret_env_vars,
      missing_in_current_environment: missingEnv,
    });
  }
  return checklist;
}

/** Writes the gitignored, local-only deployment artifacts. Never committed, never logged with real secret values beyond what --generate-secrets explicitly produces for THIS file only. */
function writeArtifacts(outDir, cfg, checklist, generatedSecrets) {
  fs.mkdirSync(outDir, { recursive: true });

  const envLines = [
    '# Generated by scripts/install/provisionCompany.js — DO NOT COMMIT.',
    '# Review every value before pasting into Railway\'s environment variables UI.',
    '',
    '# --- Required core env vars ---',
    `DATABASE_URL=                      # Railway sets this automatically when Postgres is attached`,
    `RAILWAY_JWT_SECRET=${generatedSecrets.RAILWAY_JWT_SECRET || '                     # generate with: openssl rand -hex 32 — NEVER reuse another installation\'s value'}`,
    `ENCRYPTION_KEY=${generatedSecrets.ENCRYPTION_KEY || '                           # generate with: openssl rand -hex 32 — NEVER reuse another installation\'s value'}`,
    `CRM_PUBLIC_URL=${cfg.frontend_url || ''}`,
    '',
  ];
  for (const item of checklist) {
    envLines.push(`# --- ${item.label} (module: ${item.module}) ---`);
    if (item.callback_or_webhook_url) {
      envLines.push(`#   Callback/webhook URL to register with ${item.provider}: ${item.callback_or_webhook_url}`);
    }
    envLines.push(`#   ${item.instructions}`);
    for (const envVar of item.required_secret_env_vars) {
      envLines.push(`${envVar}=`);
    }
    envLines.push('');
  }
  fs.writeFileSync(path.join(outDir, 'env.manifest.txt'), envLines.join('\n'), { mode: 0o600 });

  const checklistMd = [
    `# Onboarding checklist — ${cfg.company_name || '(unnamed)'}`,
    '',
    checklist.length === 0
      ? 'No optional modules enabled — nothing further required to reach a usable core CRM.'
      : 'For each enabled module below, complete the human authorization step, then set its env vars on the Railway deployment.',
    '',
    ...checklist.flatMap((item) => [
      `## ${item.label}`,
      `- Requires human authorization: ${item.requires_human_authorization ? 'YES' : 'no'}`,
      item.provider ? `- Provider: ${item.provider}` : null,
      item.callback_or_webhook_url ? `- Callback/webhook URL: \`${item.callback_or_webhook_url}\`` : null,
      `- ${item.instructions}`,
      `- Required env vars: ${item.required_secret_env_vars.join(', ')}`,
      item.missing_in_current_environment.length ? `- NOT YET SET in this process's environment: ${item.missing_in_current_environment.join(', ')}` : '- All required env vars are present in this process\'s environment.',
    ].filter(Boolean).concat('')),
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'ONBOARDING_CHECKLIST.md'), checklistMd);

  return { env_manifest: path.join(outDir, 'env.manifest.txt'), checklist_doc: path.join(outDir, 'ONBOARDING_CHECKLIST.md') };
}

/** Direct-DB post-provision health checks — never trusts bootstrap.js's exit code alone. */
async function runHealthChecks(db, cfg) {
  const checks = {};
  const { rows: settingsRows } = await db.query('SELECT * FROM company_settings ORDER BY created_at ASC LIMIT 1');
  const settings = settingsRows[0] || null;
  checks.company_settings_row_exists = !!settings;
  checks.company_name_matches = !!settings && settings.company_name === cfg.company_name;
  checks.installation_id_present = !!settings?.installation_id;

  const { rows: adminRows } = await db.query(`SELECT id, email, role FROM users WHERE role = 'admin'`);
  checks.admin_count = adminRows.length;
  checks.configured_admin_present = adminRows.some((u) => u.email?.toLowerCase() === (cfg.admin_email || '').toLowerCase());

  const { rows: migRows } = await db.query('SELECT count(*)::int AS n FROM schema_migrations');
  checks.migrations_applied = migRows[0].n;
  checks.migrations_ok = migRows[0].n > 0;

  if (cfg.enabled_modules && settings) {
    const dbModules = settings.enabled_modules || {};
    checks.enabled_modules_match = contract.MODULE_KEYS.every((k) => (cfg.enabled_modules[k] === true) === (dbModules[k] === true));
  }

  checks.ok = checks.company_settings_row_exists && checks.company_name_matches && checks.migrations_ok && adminRows.length >= 1;
  return checks;
}

async function main() {
  const report = { ok: false, timestamp: new Date().toISOString(), contract_version: contract.CONTRACT_VERSION, phase: 'validate' };

  // ── Step 1: load + validate — NO database connection yet ──────────────────
  let cfg;
  try {
    cfg = loadConfigFile(flagValue('config'));
  } catch (e) {
    report.error = e.message;
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const validation = contract.validateConfig(cfg);
  report.validation = validation;
  report.config = redactConfig(cfg);
  if (!validation.ok) {
    report.error = 'Config failed validation — see validation.errors. No database or deployment action was taken.';
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  // ── Step 2: compute the onboarding checklist (callback URLs, secrets) ─────
  const checklist = buildOnboardingChecklist(cfg);
  report.onboarding_checklist = checklist;

  if (hasFlag('validate-only')) {
    report.phase = 'validate-only';
    report.ok = true;
    report.note = 'Config is valid. No database connection was attempted (--validate-only). Re-run without this flag once DATABASE_URL is set to the new company\'s own database.';
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }

  // ── Step 3: provision the database (delegates to bootstrap.js) ────────────
  if (!process.env.DATABASE_URL) {
    report.error = 'DATABASE_URL is not set. Point it at this company\'s OWN, otherwise-empty PostgreSQL database, or pass --validate-only to check the config without provisioning anything.';
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const { requireInstallationConfirmation } = require('../../lib/installationIdentity');
  try {
    // The config's own company_name IS the deliberate opt-in — see this
    // file's header comment for why that's a safe, sufficient confirmation.
    // Must be company_name (not company_slug): requireInstallationConfirmation
    // only ever matches against installation_id/company_name, so using
    // company_name here is also what makes a REPEAT run against the SAME,
    // already-provisioned installation keep matching (idempotency) — a
    // mismatch (different company_name already in that database) still
    // fails safely, exactly like a fresh/unconfigured database still accepts
    // any non-empty value.
    await requireInstallationConfirmation([`--confirm-installation=${cfg.company_name}`], { log: console.error });
  } catch (e) {
    report.phase = 'database-confirmation';
    report.error = `Refusing to provision: ${e.message}`;
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const configPathAbs = path.resolve(flagValue('config'));
  report.phase = 'bootstrap';
  let bootstrapReport = null;
  try {
    const out = execFileSync('node', [path.join(ROOT, 'scripts', 'install', 'bootstrap.js'), `--config=${configPathAbs}`], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', process.stderr],
    });
    // bootstrap.js's JSON report is pretty-printed (multi-line) and is the
    // ONLY thing it writes to stdout (its human-readable log lines all go to
    // stderr, which we pass through separately above) — parse stdout as one
    // whole JSON document, never just its last line.
    bootstrapReport = JSON.parse(out.toString('utf8'));
  } catch (e) {
    report.error = `bootstrap.js failed: ${e.message}`;
    if (e.stdout) {
      try { bootstrapReport = JSON.parse(e.stdout.toString('utf8')); } catch (_) { /* ignore */ }
    }
    report.bootstrap = bootstrapReport;
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  report.bootstrap = bootstrapReport;
  if (!bootstrapReport?.ok) {
    report.error = 'bootstrap.js reported failure — see report.bootstrap.error.';
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  // ── Step 4: post-provision health checks (never trust exit code alone) ────
  report.phase = 'health-check';
  const db = require('../../db/client');
  let health;
  try {
    health = await runHealthChecks(db, cfg);
  } catch (e) {
    report.error = `Post-provision health checks failed: ${e.message}`;
    console.log(JSON.stringify(report, null, 2));
    await db.pool.end();
    process.exit(1);
  }
  report.health_checks = health;

  // ── Step 5: write local, gitignored deployment artifacts ──────────────────
  report.phase = 'artifacts';
  const outDir = flagValue('out') ? path.resolve(flagValue('out')) : defaultOutDir(cfg);
  const generatedSecrets = {};
  if (hasFlag('generate-secrets')) {
    if (!process.env.RAILWAY_JWT_SECRET) generatedSecrets.RAILWAY_JWT_SECRET = generateSecret();
    if (!process.env.ENCRYPTION_KEY) generatedSecrets.ENCRYPTION_KEY = generateSecret();
  }
  const artifacts = writeArtifacts(outDir, cfg, checklist, generatedSecrets);
  report.artifacts = { ...artifacts, secrets_generated: Object.keys(generatedSecrets) };

  report.phase = 'complete';
  report.ok = health.ok;
  if (!health.ok) report.error = 'Provisioning completed but one or more post-provision health checks failed — see health_checks.';

  console.log(JSON.stringify(report, null, 2));
  await db.pool.end();
  process.exit(report.ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => { console.error('[provisionCompany] FATAL:', e.message); process.exit(1); });
}

module.exports = { loadConfigFile, buildOnboardingChecklist, writeArtifacts, runHealthChecks, redactConfig, defaultOutDir };
