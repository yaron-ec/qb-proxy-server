/* eslint-disable no-undef */
'use strict';

/**
 * platformProvisioning.test.js — unit coverage for lib/platformProvisioning.js
 * (PRODUCTIZATION — Company Provisioning System, multi-company onboarding
 * workflow). This module's core invariant is ISOLATION: every function
 * opens its OWN ad-hoc pg.Pool against the target company's database and
 * ALWAYS closes it (finally), never touching this process's own global
 * db.pool. These tests mock `pg`, db/migrate.js and scripts/install/
 * bootstrap.js in require.cache — no live Postgres needed, and no risk of
 * ever touching a real database by accident.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

function mockPg(queryHandler) {
  let ended = false;
  let endCallCount = 0;
  class FakePool {
    constructor(opts) { this.opts = opts; }
    async connect() {
      return { query: (text, params) => queryHandler(text, params), release: () => {} };
    }
    async query(text, params) { return queryHandler(text, params); }
    async end() { ended = true; endCallCount += 1; }
  }
  const pgPath = require.resolve('pg');
  delete require.cache[pgPath];
  require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: FakePool } };
  return { wasEnded: () => ended, endCallCount: () => endCallCount };
}

function mockMigrate(runMigrationsOn) {
  const p = require.resolve('../db/migrate');
  delete require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: { runMigrationsOn, runMigrations: () => {} } };
}

function mockBootstrap(overrides) {
  const p = require.resolve('../scripts/install/bootstrap');
  delete require.cache[p];
  require.cache[p] = {
    id: p, filename: p, loaded: true,
    exports: {
      ensureCompanySettings: async () => ({ created: true, row: { installation_id: 'inst-1', company_name: 'Acme' } }),
      ensureFirstAdmin: async () => ({ created: true, user: { email: 'owner@acme.example' }, inviteToken: 'raw-invite-token' }),
      ensureAppLists: async () => ({ created: true }),
      ensureOwnerStartingLocation: async () => ({ created: true }),
      ...overrides,
    },
  };
}

function freshPlatformProvisioning() {
  const p = require.resolve('../lib/platformProvisioning');
  delete require.cache[p];
  return require('../lib/platformProvisioning');
}

test('provisionCompanyDatabase: runs migrations + bootstrap steps against the TARGET pool only, reports ok, and always closes the pool', async () => {
  const cfg = { company_name: 'Acme', admin_email: 'owner@acme.example' };
  let migrationsCalledWithClient = false;
  const pg = mockPg(async (sql) => {
    const s = String(sql);
    if (/SELECT \* FROM company_settings/i.test(s)) return { rows: [{ company_name: 'Acme', installation_id: 'inst-1' }] };
    if (/SELECT id, email, role FROM users WHERE role = 'admin'/i.test(s)) return { rows: [{ id: 'u1', email: 'owner@acme.example', role: 'admin' }] };
    if (/SELECT count\(\*\)::int AS n FROM schema_migrations/i.test(s)) return { rows: [{ n: 42 }] };
    throw new Error('unexpected health-check query: ' + s);
  });
  mockMigrate(async (client) => { migrationsCalledWithClient = !!client; });
  mockBootstrap({});

  const platformProvisioning = freshPlatformProvisioning();
  const report = await platformProvisioning.provisionCompanyDatabase({ databaseUrl: 'postgres://fake-target/db', cfg });

  assert.strictEqual(migrationsCalledWithClient, true, 'migrations must run against the ad-hoc client, not the global pool');
  assert.strictEqual(report.ok, true);
  assert.strictEqual(report.health_checks.company_settings_row_exists, true);
  assert.strictEqual(report.health_checks.company_name_matches, true);
  assert.strictEqual(report.health_checks.migrations_ok, true);
  assert.strictEqual(report.first_admin.email, 'owner@acme.example');
  assert.strictEqual(report.first_admin.invite_token, 'raw-invite-token', 'a pending admin must return its raw invite token to send the owner invite email');
  assert.strictEqual(pg.wasEnded(), true, 'the ad-hoc pool must always be closed');
});

test('provisionCompanyDatabase: reports NOT ok when the configured admin email is missing from the target DB post-provision', async () => {
  const cfg = { company_name: 'Acme', admin_email: 'owner@acme.example' };
  mockPg(async (sql) => {
    const s = String(sql);
    if (/SELECT \* FROM company_settings/i.test(s)) return { rows: [{ company_name: 'Acme', installation_id: 'inst-1' }] };
    if (/SELECT id, email, role FROM users WHERE role = 'admin'/i.test(s)) return { rows: [] }; // no admin found
    if (/SELECT count\(\*\)::int AS n FROM schema_migrations/i.test(s)) return { rows: [{ n: 42 }] };
    throw new Error('unexpected health-check query: ' + s);
  });
  mockMigrate(async () => {});
  mockBootstrap({});

  const platformProvisioning = freshPlatformProvisioning();
  const report = await platformProvisioning.provisionCompanyDatabase({ databaseUrl: 'postgres://fake-target/db', cfg });
  assert.strictEqual(report.ok, false);
  assert.strictEqual(report.health_checks.admin_count, 0);
});

test('provisionCompanyDatabase: closes the pool even when a step throws (no leaked connection on partial failure)', async () => {
  const cfg = { company_name: 'Acme', admin_email: 'owner@acme.example' };
  const pg = mockPg(async () => { throw new Error('should not reach health checks'); });
  mockMigrate(async () => { throw new Error('migration boom'); });
  mockBootstrap({});

  const platformProvisioning = freshPlatformProvisioning();
  await assert.rejects(
    () => platformProvisioning.provisionCompanyDatabase({ databaseUrl: 'postgres://fake-target/db', cfg }),
    /migration boom/
  );
  assert.strictEqual(pg.wasEnded(), true, 'pool must be closed even when migrations fail partway through');
});

test('regenerateInviteOnTarget: issues a fresh token only for a still-pending (password-less) user, and closes its pool', async () => {
  const pg = mockPg(async (sql, params) => {
    const s = String(sql);
    if (/^\s*UPDATE users SET invite_token_hash/i.test(s)) {
      return { rows: [{ id: 'u1', email: params[2], full_name: 'Owner' }] };
    }
    throw new Error('unexpected query: ' + s);
  });
  const platformProvisioning = freshPlatformProvisioning();
  const result = await platformProvisioning.regenerateInviteOnTarget({ databaseUrl: 'postgres://fake-target/db', email: 'owner@acme.example' });
  assert.ok(result.rawToken, 'must return a new raw token for the invite email');
  assert.strictEqual(result.user.email, 'owner@acme.example');
  assert.strictEqual(pg.wasEnded(), true);
});

test('regenerateInviteOnTarget: returns null when the owner already activated (has a real password) — never re-invites an active account', async () => {
  mockPg(async () => ({ rows: [] })); // UPDATE...WHERE password_hash IS NULL matched nothing
  const platformProvisioning = freshPlatformProvisioning();
  const result = await platformProvisioning.regenerateInviteOnTarget({ databaseUrl: 'postgres://fake-target/db', email: 'owner@acme.example' });
  assert.strictEqual(result, null);
});

test('setCompanyUsersStatus: rejects an invalid status value before ever opening a pool', async () => {
  const platformProvisioning = freshPlatformProvisioning();
  await assert.rejects(() => platformProvisioning.setCompanyUsersStatus({ databaseUrl: 'postgres://fake-target/db', status: 'bogus' }), /invalid status/);
});

test('setCompanyUsersStatus: suspend flips every user on the TARGET db to disabled and reports the row count', async () => {
  const pg = mockPg(async (sql, params) => {
    const s = String(sql);
    if (/^\s*UPDATE users SET status/i.test(s)) {
      assert.strictEqual(params[0], 'disabled');
      return { rowCount: 3 };
    }
    throw new Error('unexpected query: ' + s);
  });
  const platformProvisioning = freshPlatformProvisioning();
  const result = await platformProvisioning.setCompanyUsersStatus({ databaseUrl: 'postgres://fake-target/db', status: 'disabled' });
  assert.strictEqual(result.updated_users, 3);
  assert.strictEqual(pg.wasEnded(), true);
});

test('probeCompanyDatabase: returns counts only (never business record contents), and reachable=false on connection failure instead of throwing', async () => {
  mockPg(async () => { throw new Error('ECONNREFUSED'); });
  const platformProvisioning = freshPlatformProvisioning();
  const probe = await platformProvisioning.probeCompanyDatabase({ databaseUrl: 'postgres://unreachable/db' });
  assert.strictEqual(probe.reachable, false);
  assert.ok(probe.error);
});

test('probeCompanyDatabase: reachable probe reports company_name/user_count/lead_count as plain numbers/strings, no row contents', async () => {
  mockPg(async (sql) => {
    const s = String(sql);
    if (/^SELECT 1$/i.test(s)) return { rows: [{ '?column?': 1 }] };
    if (/SELECT company_name, installation_id FROM company_settings/i.test(s)) return { rows: [{ company_name: 'Acme', installation_id: 'inst-1' }] };
    if (/FROM users/i.test(s)) return { rows: [{ n: 5, pending: 2 }] };
    if (/FROM leads/i.test(s)) return { rows: [{ n: 0 }] };
    throw new Error('unexpected query: ' + s);
  });
  const platformProvisioning = freshPlatformProvisioning();
  const probe = await platformProvisioning.probeCompanyDatabase({ databaseUrl: 'postgres://fake-target/db' });
  assert.strictEqual(probe.reachable, true);
  assert.strictEqual(probe.company_name, 'Acme');
  assert.strictEqual(probe.user_count, 5);
  assert.strictEqual(probe.pending_user_count, 2);
  assert.strictEqual(probe.lead_count, 0, 'a brand-new company must start with zero leads');
});
