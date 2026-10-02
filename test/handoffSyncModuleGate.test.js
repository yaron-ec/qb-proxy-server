/* eslint-disable no-undef */
/**
 * handoffSyncModuleGate.test.js — regression coverage for a found-in-audit
 * defect: routes/handoffSync.js (registerHandoffSyncRoutes, mounted directly
 * on `app` in server.js) had NO lib/moduleGate.js#requireModuleEnabled gate
 * on any of its 8 routes, unlike every sibling integration route
 * (routes/handoffEstimates.js, routes/signnow.js, routes/leadQB.js all gate
 * on their own module). An installation with enabled_modules.handoff=false
 * still had every Handoff sync/auth endpoint fully live.
 *
 * FIX: every route now runs through a local `gate` middleware that calls
 * requireModuleEnabled('handoff') — except /handoff/auth/status, which is
 * deliberately exempt (mirrors routes/signnow.js's own /status carve-out)
 * so the Settings UI can still show connection state while the module is
 * toggled off.
 */
'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const companyConfigPath = require.resolve('../lib/companyConfig');
const moduleGatePath = require.resolve('../lib/moduleGate');
const handoffSyncPath = require.resolve('../routes/handoffSync');

function mockIsModuleEnabled(impl) {
  require.cache[companyConfigPath] = {
    id: companyConfigPath, filename: companyConfigPath, loaded: true,
    exports: { isModuleEnabled: impl },
  };
  delete require.cache[moduleGatePath];
  delete require.cache[handoffSyncPath];
}

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

// Captures every app.post(path, ...middlewares) call so we can run the
// exact middleware chain registerHandoffSyncRoutes wires up, without
// standing up a real HTTP server.
function fakeApp() {
  const routes = {};
  return {
    post(path, ...handlers) { routes[path] = handlers; },
    get(path, ...handlers) { routes[path] = handlers; },
    routes,
  };
}

async function runChain(handlers, req, res) {
  let i = 0;
  const next = async (err) => {
    if (err) throw err;
    const h = handlers[i++];
    if (!h) return;
    await h(req, res, next);
  };
  await next();
}

describe('routes/handoffSync.js module gating', () => {
  afterEach(() => {
    delete require.cache[companyConfigPath];
    delete require.cache[moduleGatePath];
    delete require.cache[handoffSyncPath];
  });

  test('REGRESSION: every sync/auth route 404s with module_disabled when the handoff module is disabled, except /handoff/auth/status', async () => {
    mockIsModuleEnabled(async () => false);
    const registerHandoffSyncRoutes = require('../routes/handoffSync');
    const app = fakeApp();
    const requireProxySecret = (req, res, next) => next();
    registerHandoffSyncRoutes(app, requireProxySecret, {}, {});

    const gatedPaths = [
      '/handoff/sync-estimates-for-lead',
      '/handoff/sync-all',
      '/handoff/sync-projects',
      '/handoff/sync-contacts',
      '/handoff/auth/diagnose',
      '/handoff/auth/store-key',
      '/handoff/auth/disconnect',
    ];
    for (const p of gatedPaths) {
      assert.ok(app.routes[p], `route ${p} was registered`);
      const res = fakeRes();
      await runChain(app.routes[p], { path: p, body: {} }, res);
      assert.strictEqual(res.statusCode, 404, `${p} should 404 when handoff module is disabled`);
      assert.strictEqual(res.body && res.body.error, 'module_disabled', `${p} should report module_disabled`);
    }
  });

  test('/handoff/auth/status is exempt from the module gate (Settings UI must see connection state even when disabled)', async () => {
    mockIsModuleEnabled(async () => false);
    const registerHandoffSyncRoutes = require('../routes/handoffSync');
    const app = fakeApp();
    const requireProxySecret = (req, res, next) => next();
    registerHandoffSyncRoutes(app, requireProxySecret, {
      // Minimal rda/handoffClient stand-ins so the real handler body can run
      // past the gate without throwing.
    }, {});

    assert.ok(app.routes['/handoff/auth/status'], '/handoff/auth/status was registered');
    const res = fakeRes();
    await runChain(app.routes['/handoff/auth/status'], { path: '/handoff/auth/status', body: {} }, res);
    // It must NOT have been blocked by the gate (no 404 module_disabled) —
    // whatever it actually returns is the real handler's business, not ours.
    assert.notStrictEqual(res.statusCode, 404);
  });

  test('enabled handoff module: a gated route reaches past the gate (does not 404 module_disabled)', async () => {
    mockIsModuleEnabled(async () => true);
    const registerHandoffSyncRoutes = require('../routes/handoffSync');
    const app = fakeApp();
    const requireProxySecret = (req, res, next) => next();
    // isConfigured: false makes the real handler short-circuit cleanly (503)
    // immediately after the gate, instead of reaching further into
    // handoffClient calls this test isn't set up to mock.
    registerHandoffSyncRoutes(app, requireProxySecret, { isConfigured: () => false }, {});

    const res = fakeRes();
    await runChain(app.routes['/handoff/sync-all'], { path: '/handoff/sync-all', body: {} }, res);
    assert.notStrictEqual(res.statusCode, 404);
    assert.strictEqual(res.statusCode, 503);
  });
});
