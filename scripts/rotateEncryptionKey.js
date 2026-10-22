#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * rotateEncryptionKey — re-encrypts every integration_credentials row from
 * one ENCRYPTION_KEY version to another, WITHOUT ever touching the raw
 * secret values in this script, its output, or any log line (only
 * provider/credential_type/environment/account_identifier and key_version
 * numbers are ever printed).
 *
 * Built for the October 2026 Railway security-disclosure response — rotating
 * ENCRYPTION_KEY itself (the key that decrypts every stored QuickBooks/
 * Gmail/SignNow/Handoff OAuth credential) is NOT a simple env-var swap: a
 * naive rotation makes every existing row permanently undecryptable, because
 * lib/integrationCredentialStore.js's decryptPayload() needs the SAME key
 * that encrypted a given row. This script uses the key-versioning mechanism
 * already built into that file (key_version column + per-version key
 * derivation) to migrate rows forward safely, one version at a time.
 *
 * ── Full rotation procedure (coordinated, operator-executed) ────────────────
 *   1. In Railway, ADD a new env var ENCRYPTION_KEY_V2 (a fresh, random
 *      value — e.g. `openssl rand -base64 32`). Do NOT touch the existing
 *      ENCRYPTION_KEY yet.
 *   2. Deploy this code (adds version-2 capability; CURRENT_KEY_VERSION
 *      stays 1 by default — ACTIVE_ENCRYPTION_KEY_VERSION is unset — so
 *      behavior is UNCHANGED for every existing write path).
 *   3. Run this script in REPORT-ONLY mode (no flags) against production to
 *      see how many rows need migration and confirm ENCRYPTION_KEY_V2 can
 *      decrypt-round-trip correctly (the report includes a dry-run
 *      encrypt+decrypt self-check before touching any row).
 *   4. Run with --apply --confirm-host=<db host> to actually re-encrypt
 *      every row currently at a version other than --target-version
 *      (default 2). Each row is individually: decrypted with ITS OWN stored
 *      key_version (old key), re-encrypted with the target version (new
 *      key), round-trip VERIFIED (decrypted again and deep-compared to the
 *      original payload) BEFORE the UPDATE is issued — a verification
 *      failure skips that row and reports it, never writes a corrupted blob.
 *   5. Re-run in report-only mode to confirm 0 rows remain below the target
 *      version.
 *   6. ONLY NOW set ACTIVE_ENCRYPTION_KEY_VERSION=2 in Railway (a config
 *      change, no redeploy of code needed) — new writes (e.g. the next
 *      QuickBooks token refresh) start using version 2 going forward.
 *   7. ONLY once step 5 and step 6 are both confirmed may the OLD
 *      ENCRYPTION_KEY value be considered safe to retire/rotate again later
 *      — removing it before every row is confirmed on version 2 makes any
 *      remaining version-1 row permanently undecryptable. This is the one
 *      irreversible mistake this whole procedure exists to prevent.
 *
 * Rollback: if something goes wrong mid-migration, ENCRYPTION_KEY (v1) is
 * NEVER modified or removed by this script or this procedure until step 7 —
 * every row not yet migrated remains fully readable under the old key the
 * entire time. There is nothing to "roll back": a stopped-partway rotation
 * just means re-running this script later picks up where it left off
 * (already-migrated rows are skipped, matching --target-version is a no-op).
 *
 * ── Safety ───────────────────────────────────────────────────────────────
 * Default mode issues only SELECT. --apply issues UPDATE on
 * encrypted_payload/key_version/updated_at ONLY — never status, never
 * connected_at/refreshed_at/last_used_at/last_error_*, never a DELETE.
 * Requires --confirm-host=<the exact DATABASE_URL host> to apply, same
 * pattern as every other --apply-gated script in this repo.
 *
 *   node scripts/rotateEncryptionKey.js [--target-version=2] [--json]
 *   node scripts/rotateEncryptionKey.js --apply --confirm-host=<host> [--target-version=2]
 */
'use strict';

const { pool } = require('../db/client');
const { encryptPayload, decryptPayload } = require('../lib/integrationCredentialStore');

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const flagVal = (name) => { const f = flag(name); return f && f.includes('=') ? f.split('=').slice(1).join('=') : null; };

async function buildPlan(targetVersion) {
  const { rows } = await pool.query(
    `SELECT id, provider, credential_type, environment, account_identifier, key_version
       FROM integration_credentials
      WHERE key_version IS DISTINCT FROM $1
      ORDER BY provider, credential_type, environment`,
    [targetVersion]
  );
  return rows;
}

async function selfCheck(targetVersion) {
  // Proves the TARGET version's key can round-trip BEFORE touching any real
  // row — never logs the probe value itself.
  const probe = { _rotation_self_check: true, nonce: Math.random().toString(36) };
  const enc = encryptPayload(probe, targetVersion);
  const dec = decryptPayload(enc, targetVersion);
  if (JSON.stringify(dec) !== JSON.stringify(probe)) throw new Error('self-check round-trip mismatch');
  return true;
}

async function rotateOneRow(row, targetVersion) {
  const { rows: current } = await pool.query(
    'SELECT encrypted_payload, key_version FROM integration_credentials WHERE id = $1',
    [row.id]
  );
  if (!current.length) return { id: row.id, skipped: 'row_deleted' };
  const { encrypted_payload, key_version } = current[0];
  if (Number(key_version) === Number(targetVersion)) return { id: row.id, skipped: 'already_at_target' };

  let payload;
  try {
    payload = decryptPayload(encrypted_payload, key_version);
  } catch (e) {
    return { id: row.id, error: `decrypt_failed_old_version_${key_version}: ${e.message}` };
  }

  const reEncrypted = encryptPayload(payload, targetVersion);
  // Verify round-trip under the NEW version before writing anything.
  const verify = decryptPayload(reEncrypted, targetVersion);
  if (JSON.stringify(verify) !== JSON.stringify(payload)) {
    return { id: row.id, error: 'round_trip_verification_failed' };
  }

  await pool.query(
    'UPDATE integration_credentials SET encrypted_payload = $1, key_version = $2, updated_at = NOW() WHERE id = $3 AND key_version = $4',
    [reEncrypted, targetVersion, row.id, key_version]
  );
  return { id: row.id, rotated: true, from_version: key_version, to_version: targetVersion };
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
  const targetVersion = parseInt(flagVal('target-version') || '2', 10);
  const apply = !!flag('apply');
  const confirmHost = flagVal('confirm-host');

  if (apply) {
    const actualHost = new URL(process.env.DATABASE_URL).hostname;
    if (!confirmHost || confirmHost !== actualHost) {
      console.error(`--apply requires --confirm-host=${actualHost} (the exact DATABASE_URL host) to proceed.`);
      process.exit(1);
    }
  }

  await selfCheck(targetVersion);
  const plan = await buildPlan(targetVersion);

  const report = {
    generated_at: new Date().toISOString(),
    mode: apply ? 'apply' : 'report-only',
    target_version: targetVersion,
    self_check: 'passed',
    rows_needing_rotation: plan.length,
    rows: plan.map((r) => ({ provider: r.provider, credential_type: r.credential_type, environment: r.environment, account_identifier: r.account_identifier, current_key_version: r.key_version })),
    results: [],
  };

  if (apply) {
    for (const row of plan) {
      const result = await rotateOneRow(row, targetVersion);
      report.results.push({ provider: row.provider, credential_type: row.credential_type, environment: row.environment, account_identifier: row.account_identifier, ...result });
    }
    report.rotated_count = report.results.filter((r) => r.rotated).length;
    report.error_count = report.results.filter((r) => r.error).length;
  }

  if (flag('json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[rotate-key] mode=${report.mode} target_version=${targetVersion} self_check=passed`);
    console.log(`[rotate-key] rows needing rotation: ${report.rows_needing_rotation}`);
    for (const r of report.rows) console.log(`  ${r.provider}/${r.credential_type}/${r.environment}/${r.account_identifier}: v${r.current_key_version} -> v${targetVersion}`);
    if (apply) {
      console.log(`[rotate-key] rotated: ${report.rotated_count}, errors: ${report.error_count}`);
      for (const r of report.results) if (r.error) console.log(`  ERROR ${r.provider}/${r.credential_type}/${r.environment}/${r.account_identifier}: ${r.error}`);
    }
  }
  await pool.end();
  // Exit 0 even when some rows reported an error — those are visible in the
  // JSON report (results[].error) for the operator to review; a non-fatal
  // per-row issue must never be indistinguishable from the script itself
  // crashing (which still throws/exits 1 via the catch in main.catch below).
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { buildPlan, rotateOneRow, selfCheck };
