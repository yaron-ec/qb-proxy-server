/* eslint-disable no-undef */
/**
 * systemInfo.test.js — GET /api/v1/system/info (CRM STABILITY PHASE,
 * System Health UI-consistency + real-integration-audit pass).
 *
 * Route wiring is tested here with lib/systemHealthChecks's own
 * getIntegrationHealth() stubbed out — the per-integration evidence logic
 * (credential_present, live_check branches, deriveState) is covered in
 * depth by test/systemHealthChecks.test.js (unit) and
 * test/integration/systemInfo.int.test.js (real Postgres). This file only
 * proves the ROUTE correctly:
 *   1. Requires auth (401 with no bearer token).
 *   2. Requires admin role (403 for a non-admin token).
 *   3. Returns a 200 with installation/schema/version info preserved.
 *   4. Plumbs ?verify=1 through to getIntegrationHealth({ verify: true })
 *      and sets the top-level `verified` flag accordingly.
 *   5. Rate-limits the ?verify=1 path specifically (10/min).
 *   6. Never leaks a secret value.
 *
 * Run: node --test test/systemInfo.test.js
 */
'use strict';

process.env.RAILWAY_JWT_SECRET = 'test-jwt-secret-at-least-32-chars-long!!';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');

const { issueAccessToken } = require('../lib/authService');

// ── Mock db/client (schema_migrations only) + installationIdentity BEFORE
// requiring the route. ───────────────────────────────────────────────────
const dbClientPath = require.resolve('../db/client');
require.cache[dbClientPath] = {
  id: dbClientPath, filename: dbClientPath, loaded: true,
  exports: {
    query: async (sql) => {
      if (/FROM schema_migrations/i.test(sql)) {
        return { rows: [{ n: 44, last_applied_at: new Date().toISOString() }] };
      }
      throw new Error('unexpected query in systemInfo.test.js mock: ' + sql);
    },
    pool: {},
  },
};

const installIdentityPath = require.resolve('../lib/installationIdentity');
require.cache[installIdentityPath] = {
  id: installIdentityPath, filename: installIdentityPath, loaded: true,
  exports: {
    identify: async () => ({ installationId: 'test-installation-id', companyName: 'Test Co', configured: true }),
    requireInstallationConfirmation: () => {},
  },
};

// ── Mock lib/systemHealthChecks — the route's only integration-health
// dependency after the rewrite. Records the `verify` flag it was called
// with so tests can assert the route actually plumbs ?verify=1 through. ──
let lastVerifyCall = null;
let healthFixture = {
  quickbooks: {
    module_enabled: true, flag_enforced: true, state: 'CONNECTED',
    credential_source: 'database', missing_env: [], supports_live_check: true,
    live_check: null, recency: null,
  },
  meta: {
    module_enabled: false, flag_enforced: true, state: 'DISABLED',
    credential_source: 'none', missing_env: ['META_APP_SECRET'], supports_live_check: false,
    live_check: null, recency: null,
  },
};
const systemHealthChecksPath = require.resolve('../lib/systemHealthChecks');
require.cache[systemHealthChecksPath] = {
  id: systemHealthChecksPath, filename: systemHealthChecksPath, loaded: true,
  exports: {
    getIntegrationHealth: async ({ verify }) => { lastVerifyCall = verify; return healthFixture; },
  },
};

const systemInfoRouter = require('../routes/systemInfo');

function buildApp() {
  const app = express();
  app.use('/api/v1/system', systemInfoRouter);
  return app;
}

async function withServer(fn) {
  const server = http.createServer(buildApp());
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    return await fn(`http://localhost:${port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const adminToken = issueAccessToken({ id: 'admin-1', email: 'admin@test.example', role: 'admin', full_name: 'Test Admin' });
const repToken = issueAccessToken({ id: 'rep-1', email: 'rep@test.example', role: 'sales_rep', full_name: 'Test Rep' });

describe('GET /api/v1/system/info', () => {
  test('rejects requests with no bearer token (401)', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/system/info`);
      assert.strictEqual(res.status, 401);
    });
  });

  test('rejects a non-admin token (403)', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/system/info`, { headers: { Authorization: `Bearer ${repToken}` } });
      assert.strictEqual(res.status, 403);
    });
  });

  test('returns 200 with the documented shape for an admin token, preserving installation/schema/version info', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/system/info`, { headers: { Authorization: `Bearer ${adminToken}` } });
      assert.strictEqual(res.status, 200);
      const body = await res.json();

      assert.strictEqual(typeof body.product_version, 'string');
      assert.strictEqual(body.installation.company_name, 'Test Co');
      assert.strictEqual(body.installation.installation_id, 'test-installation-id');
      assert.strictEqual(body.schema.migrations_applied, 44);
      assert.ok(body.generated_at);
      assert.ok(body.integrations);
      assert.ok('build_commit' in body, 'response must include build_commit, even if null when git is unavailable');
    });
  });

  test('passes through getIntegrationHealth\'s result verbatim, per-module', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/system/info`, { headers: { Authorization: `Bearer ${adminToken}` } });
      const body = await res.json();
      assert.strictEqual(body.integrations.quickbooks.state, 'CONNECTED');
      assert.strictEqual(body.integrations.meta.state, 'DISABLED');
      assert.deepStrictEqual(body.integrations.meta.missing_env, ['META_APP_SECRET']);
    });
  });

  test('default GET (no ?verify=1) calls getIntegrationHealth with verify:false and sets verified:false', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/system/info`, { headers: { Authorization: `Bearer ${adminToken}` } });
      const body = await res.json();
      assert.strictEqual(lastVerifyCall, false);
      assert.strictEqual(body.verified, false);
    });
  });

  test('?verify=1 calls getIntegrationHealth with verify:true and sets verified:true', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/system/info?verify=1`, { headers: { Authorization: `Bearer ${adminToken}` } });
      const body = await res.json();
      assert.strictEqual(lastVerifyCall, true);
      assert.strictEqual(body.verified, true);
    });
  });

  test('never leaks a secret value (encrypted_payload, raw env values, refresh tokens)', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/system/info`, { headers: { Authorization: `Bearer ${adminToken}` } });
      const raw = await res.text();
      assert.ok(!/encrypted_payload/i.test(raw));
      assert.ok(!raw.includes('test-jwt-secret'));
    });
  });
});

describe('GET /api/v1/system/info?verify=1 — rate limited (live outbound calls)', () => {
  test('the 11th ?verify=1 request within the window is rate-limited (429); the plain path is unaffected', async () => {
    await withServer(async (base) => {
      let saw429 = false;
      for (let i = 0; i < 12; i++) {
        const res = await fetch(`${base}/api/v1/system/info?verify=1`, { headers: { Authorization: `Bearer ${adminToken}` } });
        if (res.status === 429) { saw429 = true; break; }
      }
      assert.ok(saw429, 'expected a 429 within 12 rapid ?verify=1 requests');

      const plain = await fetch(`${base}/api/v1/system/info`, { headers: { Authorization: `Bearer ${adminToken}` } });
      assert.strictEqual(plain.status, 200, 'the non-verify path must remain unaffected by the verify-path limiter being exhausted');
    });
  });
});
