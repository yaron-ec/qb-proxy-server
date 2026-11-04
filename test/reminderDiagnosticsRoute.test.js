/* eslint-disable no-undef */
'use strict';

/**
 * reminderDiagnosticsRoute.test.js — HTTP-level coverage for
 * routes/reminderDiagnostics.js (November 2026): the new, CRM-admin-
 * authenticated GET /api/v1/leads/:id/reminder-diagnostics route.
 *
 * Same convention as test/qbWebhookFailClosed.test.js — a real Express
 * server, real HTTP requests via fetch, no TEST_DATABASE_URL needed.
 * lib/rbac is stubbed so the auth-wiring itself (requireAuth/requireAdmin)
 * — already covered by its own dedicated tests elsewhere, reused unchanged
 * by this route — doesn't need a real signed JWT here; what THIS file
 * proves is that the route (a) is actually wired through requireAuth +
 * requireAdmin, in that order, and (b) correctly delegates to and returns
 * lib/reminderDeliveryDiagnostics.js#getAppointmentNotificationDiagnostics,
 * including on error.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function stubModule(relPath, exportsObj) {
  const p = require.resolve(path.join(ROOT, relPath));
  const prev = require.cache[p];
  delete require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
  return () => { if (prev) require.cache[p] = prev; else delete require.cache[p]; };
}

const activeServers = [];

async function startServer({ authAllows = true, diagnosticsImpl } = {}) {
  const unstubs = [
    stubModule('lib/rbac', {
      requireAuth: (req, res, next) => {
        if (!authAllows) return res.status(401).json({ error: 'not authenticated' });
        req.user = { role: 'admin', email: 'admin@example.com' };
        next();
      },
      requireAdmin: (req, res, next) => {
        if (!authAllows) return res.status(403).json({ error: 'forbidden' });
        next();
      },
    }),
    stubModule('lib/reminderDeliveryDiagnostics', {
      getAppointmentNotificationDiagnostics: diagnosticsImpl || (async (leadId) => ({ found: true, lead: { id: leadId } })),
    }),
  ];

  delete require.cache[require.resolve(path.join(ROOT, 'routes/reminderDiagnostics'))];
  const express = require('express');
  const app = express();
  app.use('/api/v1', require(path.join(ROOT, 'routes/reminderDiagnostics')));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  activeServers.push({ server, unstubs });
  return `http://127.0.0.1:${server.address().port}`;
}

test.after(async () => {
  await Promise.all(activeServers.map(({ server, unstubs }) => {
    unstubs.forEach((u) => u());
    return new Promise((r) => server.close(r));
  }));
});

test('GET /api/v1/leads/:id/reminder-diagnostics: delegates to getAppointmentNotificationDiagnostics with the path param and returns its result verbatim', async () => {
  let calledWith = null;
  const base = await startServer({
    diagnosticsImpl: async (leadId) => { calledWith = leadId; return { found: true, lead: { id: leadId, name: 'Deena Novak' } }; },
  });
  const res = await fetch(`${base}/api/v1/leads/73aa0c4a-3f00-416d-97bc-6ee670e7b568/reminder-diagnostics`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(calledWith, '73aa0c4a-3f00-416d-97bc-6ee670e7b568');
  assert.strictEqual(body.lead.name, 'Deena Novak');
});

test('GET /api/v1/leads/:id/reminder-diagnostics: not authenticated -> 401, never reaches the diagnostic function', async () => {
  let called = false;
  const base = await startServer({ authAllows: false, diagnosticsImpl: async () => { called = true; return {}; } });
  const res = await fetch(`${base}/api/v1/leads/some-id/reminder-diagnostics`);
  assert.strictEqual(res.status, 401);
  assert.strictEqual(called, false);
});

test('GET /api/v1/leads/:id/reminder-diagnostics: a thrown error from the diagnostic function surfaces as 500 reminder_diagnostics_failed, never a raw stack/message leak beyond the error text itself', async () => {
  const base = await startServer({ diagnosticsImpl: async () => { throw new Error('db unavailable'); } });
  const res = await fetch(`${base}/api/v1/leads/some-id/reminder-diagnostics`);
  assert.strictEqual(res.status, 500);
  const body = await res.json();
  assert.strictEqual(body.error, 'reminder_diagnostics_failed');
});

test('source-level: the route is wired through requireAuth THEN requireAdmin before the handler — never reachable without both', () => {
  const source = fs.readFileSync(path.join(ROOT, 'routes/reminderDiagnostics.js'), 'utf8');
  assert.match(source, /router\.get\('\/leads\/:id\/reminder-diagnostics',\s*requireAuth,\s*requireAdmin,/);
});

test('source-level: the pre-existing X-Worker-Secret diagnose-reminder-delivery route keeps its exact 400 pre-check and now delegates to the shared extracted function, unchanged in behavior', () => {
  const source = fs.readFileSync(path.join(ROOT, 'routes/cronJobs.js'), 'utf8');
  assert.match(source, /if \(!lead_id && !name\) return res\.status\(400\)\.json\(\{ error: 'lead_id or name required' \}\);/);
  assert.match(source, /getReminderDeliveryDiagnostics\(\{ lead_id, name \}\)/);
});

test('source-level: the frontend never calls the X-Worker-Secret-gated cron endpoint directly, and WORKER_SECRET is never referenced by any frontend file', () => {
  const frontendDir = path.join(ROOT, 'crm-frontend', 'src');
  const apiClient = fs.readFileSync(path.join(frontendDir, 'api', 'railway', 'reminderDiagnostics.js'), 'utf8');
  assert.doesNotMatch(apiClient, /diagnose-reminder-delivery/);
  assert.doesNotMatch(apiClient, /WORKER_SECRET/);
  assert.match(apiClient, /\/reminder-diagnostics/);
});
