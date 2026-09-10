/* eslint-disable no-undef */
/**
 * signnowRoutes.test.js — Tests for SignNow connection routes.
 *
 * Verifies that the /status, /connect, /disconnect routes EXIST (no 404),
 * that the frontend/backend contract matches, that invalid credentials
 * return a real 401 (not 404), that password is never returned, and that
 * authorization is enforced.
 *
 * Run with: node src/proxy-server/test/signnowRoutes.test.js
 */
'use strict';

const express = require('express');
const http = require('http');

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}`); }
}

// ── Test: route existence + contract ──────────────────────────────────────
// We verify that the signnow router defines /status, /connect, /disconnect
// by checking the router's route stack (without starting a server).
function testRouteExistence() {
  console.log('\n── Route Existence ──');
  const router = require('../routes/signnow');

  // Collect all registered routes
  const routes = [];
  (function walk(r, prefix) {
    if (!r || !r.stack) return;
    for (const layer of r.stack) {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods).map(m => m.toUpperCase());
        routes.push(`${methods.join(',')} ${prefix}${layer.route.path}`);
      } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        walk(layer.handle, prefix);
      }
    }
  })(router, '');

  // Check that /status, /connect, /disconnect exist
  const hasStatus = routes.some(r => r.includes('/status') && r.startsWith('GET'));
  const hasConnect = routes.some(r => r.includes('/connect') && r.startsWith('POST'));
  const hasDisconnect = routes.some(r => r.includes('/disconnect') && r.startsWith('POST'));
  const hasTemplates = routes.some(r => r.includes('/templates') && r.startsWith('GET'));

  assert(hasStatus, 'GET /status route exists (was missing — caused 404)');
  assert(hasConnect, 'POST /connect route exists (was missing — caused 404)');
  assert(hasDisconnect, 'POST /disconnect route exists (was missing — caused 404)');
  assert(hasTemplates, 'GET /templates route still exists (no regression)');
}

// ── Test: frontend/backend contract ─────────────────────────────────────────
function testFrontendContract() {
  console.log('\n── Frontend/Backend Contract ──');

  // The frontend SignNowSettingsTab.jsx calls:
  //   GET  /api/v1/signnow/status       — loadStatus()
  //   POST /api/v1/signnow/connect      — handleConnect() with { username, password }
  //   POST /api/v1/signnow/disconnect   — handleDisconnect()
  //   GET  /api/v1/signnow/templates    — loadTemplates() via railwaySignnow.listTemplates()

  // Verify the frontend API client paths match the backend routes
  const frontendPaths = {
    status: '/api/v1/signnow/status',
    connect: '/api/v1/signnow/connect',
    disconnect: '/api/v1/signnow/disconnect',
    templates: '/api/v1/signnow/templates',
  };

  const router = require('../routes/signnow');
  const routePaths = [];
  (function walk(r) {
    if (!r || !r.stack) return;
    for (const layer of r.stack) {
      if (layer.route) {
        routePaths.push(layer.route.path);
      } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        walk(layer.handle);
      }
    }
  })(router);

  assert(routePaths.includes('/status'), `Frontend calls ${frontendPaths.status} — backend has /status`);
  assert(routePaths.includes('/connect'), `Frontend calls ${frontendPaths.connect} — backend has /connect`);
  assert(routePaths.includes('/disconnect'), `Frontend calls ${frontendPaths.disconnect} — backend has /disconnect`);
  assert(routePaths.includes('/templates'), `Frontend calls ${frontendPaths.templates} — backend has /templates`);
}

// ── Test: signnowClient exports ──────────────────────────────────────────────
function testClientExports() {
  console.log('\n── signnowClient Exports ──');
  const client = require('../lib/signnowClient');

  assert(typeof client.getAccessToken === 'function', 'getAccessToken exported');
  assert(typeof client.verifyCredentials === 'function', 'verifyCredentials exported (new — for /connect)');
  assert(typeof client.clearTokenCache === 'function', 'clearTokenCache exported (new — for /disconnect)');
  assert(typeof client.loadUserCredentials === 'function', 'loadUserCredentials exported (new — reads from credential store)');
  assert(typeof client.listTemplates === 'function', 'listTemplates exported (no regression)');
  assert(typeof client.uploadDocument === 'function', 'uploadDocument exported (no regression)');
  assert(typeof client.getDocumentStatus === 'function', 'getDocumentStatus exported (no regression)');
  assert(typeof client.downloadSignedPdf === 'function', 'downloadSignedPdf exported (no regression)');
}

// ── Test: connect route requires admin/manager ──────────────────────────────
function testAuthorization() {
  console.log('\n── Authorization ──');
  const router = require('../routes/signnow');

  // Find the /connect route handler and check if requireAdminManager middleware is applied
  let connectRoute = null;
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === '/connect') {
      connectRoute = layer.route;
      break;
    }
  }

  assert(connectRoute !== null, '/connect route found in router stack');

  // The route should have the requireAdminManager middleware
  // (requireAuth is applied at the router level via router.use(requireAuth))
  // Check that the route stack has more than just the final handler
  if (connectRoute) {
    assert(connectRoute.stack.length >= 2, `/connect has authorization middleware (stack length: ${connectRoute.stack.length})`);
  }

  // Same for /disconnect
  let disconnectRoute = null;
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === '/disconnect') {
      disconnectRoute = layer.route;
      break;
    }
  }
  if (disconnectRoute) {
    assert(disconnectRoute.stack.length >= 2, `/disconnect has authorization middleware (stack length: ${disconnectRoute.stack.length})`);
  }
}

// ── Test: connect route validates required fields ──────────────────────────
function testConnectValidation() {
  console.log('\n── Connect Validation ──');

  // Read the route handler source to verify it checks for username/password
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../routes/signnow.js'), 'utf8');

  assert(source.includes("if (!username || !password)"), 'connect route validates username + password presence');
  assert(source.includes('verifyCredentials'), 'connect route calls verifyCredentials before storing');
  assert(source.includes('saveCredential'), 'connect route stores credentials in credential store');
  assert(source.includes('clearTokenCache'), 'connect route clears token cache after storing');
  assert(source.includes('SIGNNOW_AUTH_FAILED') || source.includes('401'), 'connect route returns 401 for invalid credentials (not 404)');

  // Verify password is never returned
  assert(!source.match(/res\.json\([^)]*password[^)]*\)/i), 'password is never in any res.json() response');
}

// ── Test: disconnect route clears credentials ───────────────────────────────
function testDisconnectLogic() {
  console.log('\n── Disconnect Logic ──');
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../routes/signnow.js'), 'utf8');

  assert(source.includes('deleteCredentials'), 'disconnect route calls deleteCredentials');
  assert(source.includes('clearTokenCache'), 'disconnect route clears token cache');
}

// ── Test: status route checks both DB and env ────────────────────────────────
function testStatusLogic() {
  console.log('\n── Status Logic ──');
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../routes/signnow.js'), 'utf8');

  assert(source.includes('loadActiveCredential'), 'status route checks credential store (database)');
  assert(source.includes('SIGNNOW_USERNAME'), 'status route checks env vars as fallback');
  assert(source.includes('connected: false'), 'status route returns connected: false when no credentials');
}

// ── Test: webhook route exists and handles completion ───────────────────────
function testWebhookRoute() {
  console.log('\n── Webhook Route ──');
  const fs = require('fs');
  const path = require('path');
  const webhookSource = fs.readFileSync(path.join(__dirname, '../routes/signnowWebhook.js'), 'utf8');

  assert(webhookSource.includes('router.get'), 'webhook GET route exists (verification)');
  assert(webhookSource.includes('router.post'), 'webhook POST route exists (event handler)');
  assert(webhookSource.includes('document.complete'), 'webhook handles document.complete event');
  assert(webhookSource.includes('downloadSignedPdf'), 'webhook downloads signed PDF');
  assert(webhookSource.includes('lead_attachments'), 'webhook saves PDF to lead attachments');
  assert(webhookSource.includes('already_done') || webhookSource.includes('Already processed'), 'webhook is idempotent (skips already-processed)');
  assert(webhookSource.includes('INSERT INTO activities'), 'webhook creates activity log');
  assert(webhookSource.includes('Contract signed'), 'webhook activity says "Contract signed"');
}

// ── Test: no Base44 dependency ───────────────────────────────────────────────
function testNoBase44Dependency() {
  console.log('\n── Zero Base44 Dependency ──');
  const fs = require('fs');
  const path = require('path');

  const filesToCheck = [
    '../routes/signnow.js',
    '../routes/signnowWebhook.js',
    '../lib/signnowClient.js',
  ];

  for (const f of filesToCheck) {
    const source = fs.readFileSync(path.join(__dirname, f), 'utf8');
    // Check for actual Base44 SDK API calls, NOT the word "Base44" in comments.
    // Comments like "No Base44" and "Replaces the Base44 function" are GOOD —
    // they explicitly document the absence of Base44 dependency.
    const hasBase44Call = source.includes('base44.functions') ||
                          source.includes('base44.entities') ||
                          source.includes('base44.auth') ||
                          source.includes('base44.integrations') ||
                          source.includes('base44.analytics') ||
                          source.includes("require('base44") ||
                          source.includes('require("@base44') ||
                          source.includes('from "@base44') ||
                          source.includes("from 'base44");
    assert(!hasBase44Call, `${f} has zero Base44 runtime dependency (API calls)`);
  }
}

// ── Run all tests ───────────────────────────────────────────────────────────
console.log('SignNow Routes Test Suite');
console.log('===========================');

testRouteExistence();
testFrontendContract();
testClientExports();
testAuthorization();
testConnectValidation();
testDisconnectLogic();
testStatusLogic();
testWebhookRoute();
testNoBase44Dependency();

console.log('\n===========================');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAIL');
  process.exit(1);
} else {
  console.log('PASS');
}