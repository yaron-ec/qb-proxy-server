/* eslint-disable no-undef */
/**
 * systemInfo.test.js — GET /api/v1/system/info (Phase J/H productization).
 *
 * Covers:
 *   1. Requires auth (401 with no bearer token).
 *   2. Requires admin role (403 for a non-admin token).
 *   3. Admin token gets a 200 with the documented response shape.
 *   4. integration_credentials rows are correctly mapped by the REAL
 *      (provider, credential_type) pairs each integration actually writes
 *      (provider='intuit'/credential_type='quickbooks' for QuickBooks,
 *      provider='google'/credential_type='gmail' for Gmail) — not by
 *      module key, which was the bug caught before this route shipped.
 *   5. A module with no integration_credentials row at all (handoff — env
 *      or app_settings only) falls back to env-presence state.
 *   6. No secret value (encrypted_payload, raw env var value) ever appears
 *      in the response.
 *
 * Run: node --test test/systemInfo.test.js
 */
'use strict';

process.env.RAILWAY_JWT_SECRET = 'test-jwt-secret-at-least-32-chars-long!!';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');

const { issueAccessToken } = require('../lib/authService');

// ── Mock db/client BEFORE requiring the route ───────────────────────────────
const credRows = [
  {
    provider: 'intuit', credential_type: 'quickbooks',
    status: 'connected', expires_at: null,
    last_error_at: null, last_error_message: null,
    refreshed_at: new Date().toISOString(), last_used_at: new Date().toISOString(),
  },
  {
    provider: 'google', credential_type: 'gmail',
    status: 'connected', expires_at: new Date(Date.now() - 60000).toISOString(), // expired
    last_error_at: null, last_error_message: null,
    refreshed_at: null, last_used_at: new Date().toISOString(),
  },
];

function mockQuery(sql) {
  if (/FROM schema_migrations/i.test(sql)) {
    return Promise.resolve({ rows: [{ n: 44, last_applied_at: new Date().toISOString() }] });
  }
  if (/FROM integration_credentials/i.test(sql)) {
    return Promise.resolve({ rows: credRows });
  }
  return Promise.resolve({ rows: [] });
}

const dbClientPath = require.resolve('../db/client');
require.cache[dbClientPath] = {
  id: dbClientPath, filename: dbClientPath, loaded: true,
  exports: { query: mockQuery, pool: {} },
};

const installIdentityPath = require.resolve('../lib/installationIdentity');
require.cache[installIdentityPath] = {
  id: installIdentityPath, filename: installIdentityPath, loaded: true,
  exports: {
    identify: async () => ({ installationId: 'test-installation-id', companyName: 'Test Co', configured: true }),
    requireInstallationConfirmation: () => {},
  },
};

const bootstrapPath = require.resolve('../scripts/install/bootstrap');
require.cache[bootstrapPath] = {
  id: bootstrapPath, filename: bootstrapPath, loaded: true,
  exports: {
    integrationEnvStatus: () => ({
      quickbooks: { configured: true, present: ['QB_CLIENT_ID', 'QB_CLIENT_SECRET', 'QB_REDIRECT_URI'], missing: [] },
      gmail: { configured: true, present: ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET'], missing: [] },
      google_calendar: { configured: false, present: [], missing: ['GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_SERVICE_ACCOUNT_KEY'] },
      signnow: { configured: false, present: [], missing: ['SIGNNOW_CLIENT_ID', 'SIGNNOW_CLIENT_SECRET'] },
      handoff: { configured: true, present: ['HANDOFF_API_KEY'], missing: [] },
      meta: { configured: false, present: [], missing: ['META_APP_SECRET'] },
      sms: { configured: false, present: [], missing: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'] },
      website_intake: { configured: true, present: ['WEBSITE_LEAD_WEBHOOK_SECRET'], missing: [] },
    }),
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

  test('returns 200 with the documented shape for an admin token', async () => {
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
    });
  });

  test('maps QuickBooks (provider=intuit/credential_type=quickbooks) to CONNECTED', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/system/info`, { headers: { Authorization: `Bearer ${adminToken}` } });
      const body = await res.json();
      assert.strictEqual(body.integrations.quickbooks.connection.state, 'CONNECTED');
    });
  });

  test('maps Gmail (provider=google/credential_type=gmail, expired) to RECONNECT_REQUIRED', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/system/info`, { headers: { Authorization: `Bearer ${adminToken}` } });
      const body = await res.json();
      assert.strictEqual(body.integrations.gmail.connection.state, 'RECONNECT_REQUIRED');
    });
  });

  test('a module with no integration_credentials row (handoff) falls back to env-presence CONFIGURED', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/system/info`, { headers: { Authorization: `Bearer ${adminToken}` } });
      const body = await res.json();
      assert.strictEqual(body.integrations.handoff.env_configured, true);
      assert.strictEqual(body.integrations.handoff.connection.state, 'CONFIGURED');
    });
  });

  test('an unconfigured module with no row reports NOT_CONFIGURED', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/system/info`, { headers: { Authorization: `Bearer ${adminToken}` } });
      const body = await res.json();
      assert.strictEqual(body.integrations.meta.env_configured, false);
      assert.strictEqual(body.integrations.meta.connection.state, 'NOT_CONFIGURED');
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
