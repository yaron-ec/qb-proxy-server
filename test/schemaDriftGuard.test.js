/* eslint-disable no-undef */
'use strict';

/**
 * schemaDriftGuard.test.js — PRODUCTIZATION Phase I systemic drift guard.
 *
 * CLAUDE.md's "No DDL at runtime" rule: db/schema.sql is executed ONLY by
 * db/migrate.js at deploy time; a request/worker path must never run
 * CREATE TABLE / ALTER TABLE / DROP TABLE / CREATE INDEX / DROP INDEX
 * directly — db/client.js#ensureColumns (a catalog check first, so it's a
 * true no-op once the column exists) is the one sanctioned exception. Under
 * the productized single-tenant-per-deployment model this matters even
 * more: every new installation runs the exact same request/worker code
 * against its own freshly-migrated database, so a DDL statement buried in a
 * hot path is a startup/concurrency risk for every company, not just EC.
 *
 * Auditing the live request/worker tree (lib/, routes/, server.js,
 * reminderWorker.js — NOT scripts/, which are offline operator tooling, not
 * a request/worker path) originally found FOUR pre-existing files that
 * already violated this rule: server.js (integration_credentials
 * self-repair on startup), routes/routing.js and routes/routingDiagnostic.js
 * (both ran raw CREATE TABLE/CREATE INDEX for lead_geocodes on every
 * request — unmemoized), and lib/googleContactsOutbox.js (creates
 * google_contacts_outbox).
 *
 * routes/routing.js and routes/routingDiagnostic.js were fixed in the
 * CRM STABILITY PHASE DB/schema-writer audit: the lead_geocodes table now
 * has its own migration (db/migrations/2026-53-lead-geocodes-table.sql) and
 * both routes delegate to lib/addressPipeline.js's memoized
 * ensureGeocodeTable()/ensureAddressColumns() helpers instead of running
 * DDL inline per-request. KNOWN_OFFENDERS shrunk accordingly, per this
 * test's own instruction below.
 *
 * server.js and lib/googleContactsOutbox.js remain known, tracked,
 * out-of-scope debt — fixing them needs its own dedicated pass (each
 * touches live startup/worker behavior).
 *
 * This guard does NOT re-litigate that existing debt — it freezes the
 * CURRENT set of offending files as a known baseline and fails only if a
 * NEW file starts running raw DDL outside db/client.js#ensureColumns, so
 * the debt can shrink but never silently grows during future work
 * (productization or otherwise).
 */
const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Pre-existing, tracked, out-of-scope-for-this-pass offenders (see header).
const KNOWN_OFFENDERS = new Set([
  'server.js',
  'lib/googleContactsOutbox.js',
]);

const DDL_PATTERN = /\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX)\b/i;

function walk(rel, out) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) return;
  for (const ent of fs.readdirSync(full, { withFileTypes: true })) {
    const r = path.join(rel, ent.name);
    if (ent.isDirectory()) {
      if (['node_modules', 'dist', '.git'].includes(ent.name)) continue;
      walk(r, out);
      continue;
    }
    if (ent.name.endsWith('.js')) out.push(r);
  }
}

test('no NEW request/worker-path file runs raw DDL outside db/client.js#ensureColumns', () => {
  const files = [];
  ['lib', 'routes'].forEach((d) => walk(d, files));
  files.push('server.js', 'reminderWorker.js');

  const offenders = [];
  for (const rel of files) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) continue;
    const src = fs.readFileSync(full, 'utf8');
    if (DDL_PATTERN.test(src)) offenders.push(rel.split(path.sep).join('/'));
  }

  const newOffenders = offenders.filter((f) => !KNOWN_OFFENDERS.has(f));
  assert.deepStrictEqual(
    newOffenders,
    [],
    `New runtime-DDL file(s) found outside the known baseline — move to a migration or db/client.js#ensureColumns: ${newOffenders.join(', ')}`
  );

  // The known set should never silently grow either — if one of these is
  // genuinely fixed (moved to a migration), shrink KNOWN_OFFENDERS above
  // rather than leaving a stale entry that no longer matches reality.
  for (const known of KNOWN_OFFENDERS) {
    assert.ok(offenders.includes(known), `${known} was removed from KNOWN_OFFENDERS's baseline but no longer contains DDL — update this test's comment/baseline to reflect the fix`);
  }
});
