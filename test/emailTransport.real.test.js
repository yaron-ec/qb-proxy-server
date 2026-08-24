/* eslint-disable no-undef */
/**
 * emailTransport.real.test.js — REAL transport tests.
 *
 * These tests bundle the ACTUAL src/lib/emailTransport.js with esbuild
 * (resolving @/ aliases), mock only fetch + localStorage + base44, and
 * exercise the real transport code path:
 *
 *   emailTransport.sendGenericEmail()
 *     → railwayApi.apiCall('/api/v1/emails/send', { body })
 *       → fetch('https://test.railway.app/api/v1/emails/send', {
 *           headers: { Authorization: 'Bearer <jwt>' }  ← NO X-Proxy-Secret
 *         })
 *
 * No duplicate transport logic. No mock-only tests. The real code runs.
 */
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const Module = require('module');

// ── Mock globals ────────────────────────────────────────────────────────────
let _fetchImpl = null;
const _storage = new Map();

global.fetch = (...args) => _fetchImpl(...args);
global.localStorage = {
  getItem: (k) => _storage.get(k) || null,
  setItem: (k, v) => _storage.set(k, String(v)),
  removeItem: (k) => _storage.delete(k),
  clear: () => _storage.clear(),
};

function setFetch(impl) { _fetchImpl = impl; }
function resetStorage() { _storage.clear(); }
function setJwtTokens(access, refresh) {
  if (access) _storage.set('railway_access_token', access);
  if (refresh) _storage.set('railway_refresh_token', refresh);
}

// ── Mock base44 and appParams (external modules) ────────────────────────────
let _base44Called = false;
const mockBase44 = {
  entities: {
    Invoice: { get: async () => { throw new Error('UNEXPECTED Invoice.get'); } },
    Lead: { get: async () => { throw new Error('UNEXPECTED Lead.get'); } },
    Activity: { create: async () => ({ id: 'act1' }) },
    LeadAttachment: { create: async () => ({ id: 'att1' }) },
  },
  functions: {
    invoke: async (name) => {
      _base44Called = true;
      throw new Error(`UNEXPECTED base44.functions.invoke('${name}')`);
    },
  },
  auth: { me: async () => ({ id: 'u1', email: 'test@ecconstructiongroup.com' }) },
};

const mockAppParams = { token: 'base44-token-mock', appId: 'app1' };

const mockModules = {
  '@/api/base44Client': { base44: mockBase44 },
  '@/lib/app-params': { appParams: mockAppParams },
};

// ── Module hook: intercept @/ imports, mock base44 + appParams ──────────────
const originalLoad = Module._load;
Module._load = function (request, parent, ...args) {
  if (mockModules[request]) return mockModules[request];
  if (request.startsWith('@/')) {
    return originalLoad.call(this, path.resolve(__dirname, '../../..', request.slice(2)), parent, ...args);
  }
  return originalLoad.call(this, request, parent, ...args);
};

// ── Build the REAL transport module with esbuild ────────────────────────────
async function buildTransport() {
  let esbuild;
  try { esbuild = require('esbuild'); } catch { throw new Error('esbuild not available — npm install esbuild'); }
  const srcRoot = path.resolve(__dirname, '../../..', 'src');
  // Plugin: mark base44 + appParams as external (mocked via Module hook),
  // resolve all other @/ imports to src/, and support .mjs extensions.
  const transportPlugin = {
    name: 'transport-mocks',
    setup(build) {
      build.onResolve({ filter: /^@\/api\/base44Client$/ }, (args) => ({ path: args.path, external: true }));
      build.onResolve({ filter: /^@\/lib\/app-params$/ }, (args) => ({ path: args.path, external: true }));
      build.onResolve({ filter: /^@\// }, (args) => {
        const basePath = path.resolve(srcRoot, args.path.slice(2));
        for (const ext of ['.mjs', '.js', '.jsx']) {
          if (fs.existsSync(basePath + ext)) return { path: basePath + ext };
        }
        return { path: basePath };
      });
    },
  };
  const result = await esbuild.build({
    entryPoints: [path.resolve(__dirname, '../../lib/emailTransport.js')],
    bundle: true,
    format: 'cjs',
    write: false,
    resolveExtensions: ['.mjs', '.js', '.jsx', '.ts', '.tsx'],
    plugins: [transportPlugin],
    define: {
      'import.meta.env.VITE_RAILWAY_API_URL': '"https://test.railway.app"',
      'import.meta.env.VITE_QB_PROXY_URL': '"https://test.railway.app"',
      'import.meta.env.VITE_QB_PROXY_SECRET': '""',
    },
  });
  const tmpFile = path.join(__dirname, '.emailTransport.bundled.cjs');
  fs.writeFileSync(tmpFile, result.outputFiles[0].text);
  delete require.cache[tmpFile];
  return require(tmpFile);
}

// ── Fetch mock helpers ───────────────────────────────────────────────────────
function mockResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function emailOkResponse(gmailMessageId, idempotent) {
  return mockResponse(200, {
    ok: true,
    gmailMessageId: gmailMessageId || 'msg-123',
    idempotent: !!idempotent,
    claimId: 1,
    deliveryStatus: 'sent',
  });
}

function emailErrorResponse(status, message) {
  return mockResponse(status, { error: message || `Railway error ${status}` });
}

// ── Tests ───────────────────────────────────────────────────────────────────

async function testSuccessfulJwtSend() {
  resetStorage();
  setJwtTokens('valid-jwt', 'valid-refresh');
  let calls = [];
  setFetch(async (url, opts) => {
    calls.push({ url, opts });
    return emailOkResponse('gmail-1', false);
  });

  const transport = await buildTransport();
  const result = await transport.sendGenericEmail({
    to: 'customer@example.com', subject: 'Test', htmlBody: '<p>Body</p>',
    leadId: 'lead1', clientRequestId: 'req1',
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(calls.length, 1, 'Should call fetch exactly once');
  assert.strictEqual(calls[0].url, 'https://test.railway.app/api/v1/emails/send');
  assert.strictEqual(calls[0].opts.method, 'POST');
  assert.strictEqual(calls[0].opts.headers['Authorization'], 'Bearer valid-jwt');
  assert.strictEqual(calls[0].opts.headers['X-Proxy-Secret'], undefined, 'No X-Proxy-Secret');
  assert.ok(calls[0].opts.body, 'Body must be present');
  const body = JSON.parse(calls[0].opts.body);
  assert.deepStrictEqual(body.to, ['customer@example.com']);
  assert.strictEqual(body.subject, 'Test');
  assert.strictEqual(body.htmlBody, '<p>Body</p>');
  assert.ok(body.idempotencyKey, 'idempotencyKey required');
  assert.strictEqual(body.metadata.template_key, 'generic');
  console.log('  ✓ successful JWT-authenticated send');
}

async function testJwtMissingProvisionsViaMigrate() {
  resetStorage();
  let calls = [];
  setFetch(async (url, opts) => {
    calls.push({ url, opts });
    if (url.includes('/api/v1/auth/migrate')) {
      return mockResponse(200, { access: 'new-jwt', refresh: 'new-refresh', user: { id: 'u1' } });
    }
    return emailOkResponse('gmail-2', false);
  });

  const transport = await buildTransport();
  const result = await transport.sendGenericEmail({
    to: 'customer@example.com', subject: 'Test', htmlBody: '<p>Body</p>',
    leadId: 'lead1', clientRequestId: 'req1',
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(calls.length, 2, 'Should call migrate then send');
  assert.ok(calls[0].url.includes('/api/v1/auth/migrate'), 'First call should be migrate');
  assert.ok(calls[1].url.includes('/api/v1/emails/send'), 'Second call should be send');
  assert.strictEqual(calls[1].opts.headers['Authorization'], 'Bearer new-jwt');
  assert.strictEqual(_storage.get('railway_access_token'), 'new-jwt');
  console.log('  ✓ JWT missing — provisions via migrateFromBase44');
}

async function testJwtExpiredRefreshSucceeds() {
  resetStorage();
  setJwtTokens('expired-jwt', 'valid-refresh');
  let calls = [];
  setFetch(async (url, opts) => {
    calls.push({ url, opts });
    if (url.includes('/api/v1/auth/refresh')) {
      return mockResponse(200, { access: 'refreshed-jwt', refresh: 'new-refresh' });
    }
    // First email send returns 401, second (after refresh) returns 200
    if (calls.filter(c => c.url.includes('/api/v1/emails/send')).length === 1) {
      return emailErrorResponse(401, 'token expired');
    }
    return emailOkResponse('gmail-3', false);
  });

  const transport = await buildTransport();
  const result = await transport.sendGenericEmail({
    to: 'customer@example.com', subject: 'Test', htmlBody: '<p>Body</p>',
    leadId: 'lead1', clientRequestId: 'req1',
  });

  assert.strictEqual(result.ok, true);
  assert.ok(calls.some(c => c.url.includes('/api/v1/auth/refresh')), 'Should call refresh');
  assert.strictEqual(_storage.get('railway_access_token'), 'refreshed-jwt');
  console.log('  ✓ JWT expired — refresh succeeds and send retries');
}

async function testJwtRefreshFailure() {
  resetStorage();
  setJwtTokens('expired-jwt', 'invalid-refresh');
  setFetch(async (url) => {
    if (url.includes('/api/v1/auth/refresh')) {
      return emailErrorResponse(401, 'invalid refresh token');
    }
    return emailErrorResponse(401, 'token expired');
  });

  const transport = await buildTransport();
  try {
    await transport.sendGenericEmail({
      to: 'customer@example.com', subject: 'Test', htmlBody: '<p>Body</p>',
      leadId: 'lead1', clientRequestId: 'req1',
    });
    assert.fail('Should have thrown');
  } catch (e) {
    assert.ok(e.message.includes('invalid refresh token') || e.message.includes('Railway API 401'));
    assert.ok(!_storage.get('railway_access_token'), 'Tokens should be cleared');
  }
  console.log('  ✓ JWT refresh failure — throws and clears tokens');
}

async function testRailway400() {
  resetStorage();
  setJwtTokens('valid-jwt', 'valid-refresh');
  setFetch(async () => emailErrorResponse(400, 'to, subject, htmlBody, idempotencyKey required'));

  const transport = await buildTransport();
  try {
    await transport.sendGenericEmail({
      to: 'customer@example.com', subject: 'Test', htmlBody: '<p>Body</p>',
      leadId: 'lead1', clientRequestId: 'req1',
    });
    assert.fail('Should have thrown');
  } catch (e) {
    assert.strictEqual(e.status, 400);
    assert.ok(e.message.includes('required'));
  }
  console.log('  ✓ Railway 400 throws');
}

async function testRailway401() {
  resetStorage();
  setJwtTokens('valid-jwt', 'valid-refresh');
  // Both send and refresh return 401
  setFetch(async () => emailErrorResponse(401, 'Unauthorized'));

  const transport = await buildTransport();
  try {
    await transport.sendGenericEmail({
      to: 'customer@example.com', subject: 'Test', htmlBody: '<p>Body</p>',
      leadId: 'lead1', clientRequestId: 'req1',
    });
    assert.fail('Should have thrown');
  } catch (e) {
    assert.strictEqual(e.status, 401);
  }
  console.log('  ✓ Railway 401 throws');
}

async function testRailway500() {
  resetStorage();
  setJwtTokens('valid-jwt', 'valid-refresh');
  setFetch(async () => emailErrorResponse(500, 'EmailService.send failed'));

  const transport = await buildTransport();
  try {
    await transport.sendGenericEmail({
      to: 'customer@example.com', subject: 'Test', htmlBody: '<p>Body</p>',
      leadId: 'lead1', clientRequestId: 'req1',
    });
    assert.fail('Should have thrown');
  } catch (e) {
    assert.strictEqual(e.status, 500);
    assert.ok(e.message.includes('failed'));
  }
  console.log('  ✓ Railway 500 throws');
}

async function testTimeoutNetworkError() {
  resetStorage();
  setJwtTokens('valid-jwt', 'valid-refresh');
  setFetch(async () => { throw new TypeError('Failed to fetch (timeout)'); });

  const transport = await buildTransport();
  try {
    await transport.sendGenericEmail({
      to: 'customer@example.com', subject: 'Test', htmlBody: '<p>Body</p>',
      leadId: 'lead1', clientRequestId: 'req1',
    });
    assert.fail('Should have thrown');
  } catch (e) {
    assert.ok(e.message.includes('fetch') || e.message.includes('timeout'));
  }
  console.log('  ✓ timeout/network error throws');
}

async function testIdempotentDuplicateResponse() {
  resetStorage();
  setJwtTokens('valid-jwt', 'valid-refresh');
  setFetch(async () => emailOkResponse('original-msg', true));

  const transport = await buildTransport();
  const result = await transport.sendGenericEmail({
    to: 'customer@example.com', subject: 'Test', htmlBody: '<p>Body</p>',
    leadId: 'lead1', clientRequestId: 'req1',
  });

  assert.strictEqual(result.idempotent, true);
  assert.strictEqual(result.gmailMessageId, 'original-msg');
  console.log('  ✓ idempotent duplicate response returns original result');
}

async function testNoBase44Fallback() {
  resetStorage();
  setJwtTokens('valid-jwt', 'valid-refresh');
  _base44Called = false;
  setFetch(async () => emailErrorResponse(500, 'Railway server error'));

  const transport = await buildTransport();
  try {
    await transport.sendGenericEmail({
      to: 'customer@example.com', subject: 'Test', htmlBody: '<p>Body</p>',
      leadId: 'lead1', clientRequestId: 'req1',
    });
  } catch (e) { /* expected */ }

  assert.strictEqual(_base44Called, false, 'Base44 must NOT be called as fallback');
  console.log('  ✓ no Base44 fallback after Railway error');
}

async function testRecipientPreservation() {
  resetStorage();
  setJwtTokens('valid-jwt', 'valid-refresh');
  let calls = [];
  setFetch(async (url, opts) => { calls.push({ url, opts }); return emailOkResponse(); });

  const transport = await buildTransport();
  await transport.sendGenericEmail({
    to: 'customer@example.com', subject: 'Test', htmlBody: '<p>Body</p>',
    leadId: 'lead1', clientRequestId: 'req1',
  });

  const body = JSON.parse(calls[0].opts.body);
  assert.deepStrictEqual(body.to, ['customer@example.com']);
  console.log('  ✓ recipient preserved');
}

async function testSubjectPreservation() {
  resetStorage();
  setJwtTokens('valid-jwt', 'valid-refresh');
  let calls = [];
  setFetch(async (url, opts) => { calls.push({ url, opts }); return emailOkResponse(); });

  const transport = await buildTransport();
  await transport.sendGenericEmail({
    to: 'customer@example.com', subject: 'Invoice #123 — EC Construction Group',
    htmlBody: '<p>Body</p>', leadId: 'lead1', clientRequestId: 'req1',
  });

  const body = JSON.parse(calls[0].opts.body);
  assert.strictEqual(body.subject, 'Invoice #123 — EC Construction Group');
  console.log('  ✓ subject preserved');
}

async function testBodyPreservation() {
  resetStorage();
  setJwtTokens('valid-jwt', 'valid-refresh');
  let calls = [];
  setFetch(async (url, opts) => { calls.push({ url, opts }); return emailOkResponse(); });

  const transport = await buildTransport();
  const htmlBody = '<html><body><h1>Test</h1><p>Full HTML body</p></body></html>';
  await transport.sendGenericEmail({
    to: 'customer@example.com', subject: 'Test', htmlBody,
    leadId: 'lead1', clientRequestId: 'req1',
  });

  const body = JSON.parse(calls[0].opts.body);
  assert.strictEqual(body.htmlBody, htmlBody);
  console.log('  ✓ htmlBody preserved');
}

async function testCcPreservation() {
  resetStorage();
  setJwtTokens('valid-jwt', 'valid-refresh');
  let calls = [];
  setFetch(async (url, opts) => { calls.push({ url, opts }); return emailOkResponse(); });

  const transport = await buildTransport();
  await transport.sendGenericEmail({
    to: 'customer@example.com', cc: ['office@example.com', 'rep@example.com'],
    subject: 'Test', htmlBody: '<p>Body</p>',
    leadId: 'lead1', clientRequestId: 'req1',
  });

  const body = JSON.parse(calls[0].opts.body);
  assert.deepStrictEqual(body.cc, ['office@example.com', 'rep@example.com']);
  console.log('  ✓ CC preserved');
}

async function testReplyToPreservation() {
  resetStorage();
  setJwtTokens('valid-jwt', 'valid-refresh');
  let calls = [];
  setFetch(async (url, opts) => { calls.push({ url, opts }); return emailOkResponse(); });

  const transport = await buildTransport();
  await transport.sendGenericEmail({
    to: 'customer@example.com', replyTo: 'rep@ecconstructiongroup.com',
    subject: 'Test', htmlBody: '<p>Body</p>',
    leadId: 'lead1', clientRequestId: 'req1',
  });

  const body = JSON.parse(calls[0].opts.body);
  assert.strictEqual(body.replyTo, 'rep@ecconstructiongroup.com');
  console.log('  ✓ replyTo preserved');
}

async function testAttachmentPreservation() {
  resetStorage();
  setJwtTokens('valid-jwt', 'valid-refresh');
  let calls = [];
  setFetch(async (url, opts) => { calls.push({ url, opts }); return emailOkResponse(); });

  const transport = await buildTransport();
  const attachment = {
    filename: 'invoice.pdf', contentType: 'application/pdf', contentBase64: 'JVBERi0xLjQK',
  };
  await transport.sendGenericEmail({
    to: 'customer@example.com', subject: 'Test', htmlBody: '<p>Body</p>',
    attachments: [attachment], leadId: 'lead1', clientRequestId: 'req1',
  });

  const body = JSON.parse(calls[0].opts.body);
  assert.ok(body.attachments, 'Attachments must be present');
  assert.strictEqual(body.attachments.length, 1);
  assert.strictEqual(body.attachments[0].filename, 'invoice.pdf');
  assert.strictEqual(body.attachments[0].contentType, 'application/pdf');
  assert.strictEqual(body.attachments[0].contentBase64, 'JVBERi0xLjQK');
  console.log('  ✓ attachment preserved');
}

async function testSenderServerEnforced() {
  resetStorage();
  setJwtTokens('valid-jwt', 'valid-refresh');
  let calls = [];
  setFetch(async (url, opts) => { calls.push({ url, opts }); return emailOkResponse(); });

  const transport = await buildTransport();
  await transport.sendGenericEmail({
    to: 'customer@example.com', subject: 'Test', htmlBody: '<p>Body</p>',
    leadId: 'lead1', clientRequestId: 'req1',
  });

  const body = JSON.parse(calls[0].opts.body);
  assert.strictEqual(body.fromAddress, undefined, 'Transport must not set fromAddress — server enforces sender');
  assert.strictEqual(body.fromName, undefined, 'Transport must not set fromName — server uses default');
  console.log('  ✓ sender remains server-enforced (no fromAddress/fromName in body)');
}

async function testNoProxySecretHeader() {
  resetStorage();
  setJwtTokens('valid-jwt', 'valid-refresh');
  let calls = [];
  setFetch(async (url, opts) => { calls.push({ url, opts }); return emailOkResponse(); });

  const transport = await buildTransport();
  await transport.sendGenericEmail({
    to: 'customer@example.com', subject: 'Test', htmlBody: '<p>Body</p>',
    leadId: 'lead1', clientRequestId: 'req1',
  });

  assert.strictEqual(calls[0].opts.headers['X-Proxy-Secret'], undefined, 'No X-Proxy-Secret header');
  assert.strictEqual(calls[0].opts.headers['x-proxy-secret'], undefined, 'No x-proxy-secret (lowercase)');
  console.log('  ✓ no X-Proxy-Secret header in request');
}

async function testNoViteProxySecretUse() {
  // Read the bundled transport source and verify VITE_QB_PROXY_SECRET is not referenced
  const transport = await buildTransport();
  const bundledPath = path.join(__dirname, '.emailTransport.bundled.cjs');
  const bundled = fs.readFileSync(bundledPath, 'utf8');
  assert.ok(!bundled.includes('VITE_QB_PROXY_SECRET'), 'Bundled code must not reference VITE_QB_PROXY_SECRET');
  assert.ok(!bundled.includes('X-Proxy-Secret'), 'Bundled code must not reference X-Proxy-Secret');
  assert.ok(!bundled.includes('PROXY_SECRET'), 'Bundled code must not reference PROXY_SECRET');
  assert.ok(!bundled.includes('/internal/email/send'), 'Bundled code must not call /internal/email/send');
  assert.ok(bundled.includes('/api/v1/emails/send'), 'Bundled code must call /api/v1/emails/send');
  // Verify transport object has the expected functions
  assert.ok(typeof transport.sendGenericEmail === 'function');
  assert.ok(typeof transport.sendTestEmail === 'function');
  console.log('  ✓ no VITE_QB_PROXY_SECRET or X-Proxy-Secret in bundled code');
}

async function testIdempotencyKeyFormat() {
  resetStorage();
  setJwtTokens('valid-jwt', 'valid-refresh');
  let calls = [];
  setFetch(async (url, opts) => { calls.push({ url, opts }); return emailOkResponse(); });

  const transport = await buildTransport();
  await transport.sendGenericEmail({
    to: 'customer@example.com', subject: 'Test', htmlBody: '<p>Body</p>',
    leadId: 'lead1', clientRequestId: 'req-stable',
  });

  const body = JSON.parse(calls[0].opts.body);
  assert.strictEqual(body.idempotencyKey, 'crm-email:lead1:customer@example.com:req-stable');

  // Same inputs → same key
  resetStorage(); setJwtTokens('valid-jwt', 'valid-refresh'); calls = [];
  setFetch(async (url, opts) => { calls.push({ url, opts }); return emailOkResponse(); });
  await transport.sendGenericEmail({
    to: 'customer@example.com', subject: 'Test', htmlBody: '<p>Body</p>',
    leadId: 'lead1', clientRequestId: 'req-stable',
  });
  const body2 = JSON.parse(calls[0].opts.body);
  assert.strictEqual(body2.idempotencyKey, body.idempotencyKey, 'Same inputs must produce same key');
  console.log('  ✓ idempotency key is deterministic and stable');
}

async function testTestEmailStableNonce() {
  resetStorage();
  setJwtTokens('valid-jwt', 'valid-refresh');
  let calls = [];
  setFetch(async (url, opts) => { calls.push({ url, opts }); return emailOkResponse(); });

  const transport = await buildTransport();
  // TestReminderPanel now passes lead.id as nonce (no Date.now())
  await transport.sendTestEmail('yaron@ecconstructiongroup.com', 'lead123');

  const body = JSON.parse(calls[0].opts.body);
  assert.strictEqual(body.idempotencyKey, 'test-email:yaron@ecconstructiongroup.com:lead123');
  assert.ok(!body.idempotencyKey.includes('Date.now'), 'Key must not contain Date.now()');
  console.log('  ✓ test email nonce is stable (no Date.now)');
}

// ── Runner ──────────────────────────────────────────────────────────────────

async function runAll() {
  console.log('\n── emailTransport REAL integration tests (JWT auth) ──\n');

  const tests = [
    testSuccessfulJwtSend,
    testJwtMissingProvisionsViaMigrate,
    testJwtExpiredRefreshSucceeds,
    testJwtRefreshFailure,
    testRailway400,
    testRailway401,
    testRailway500,
    testTimeoutNetworkError,
    testIdempotentDuplicateResponse,
    testNoBase44Fallback,
    testRecipientPreservation,
    testSubjectPreservation,
    testBodyPreservation,
    testCcPreservation,
    testReplyToPreservation,
    testAttachmentPreservation,
    testSenderServerEnforced,
    testNoProxySecretHeader,
    testNoViteProxySecretUse,
    testIdempotencyKeyFormat,
    testTestEmailStableNonce,
  ];

  let passed = 0, failed = 0;
  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (e) {
      console.error(`  ✗ ${test.name}: ${e.message}`);
      failed++;
    }
  }

  // Cleanup
  try { fs.unlinkSync(path.join(__dirname, '.emailTransport.bundled.cjs')); } catch {}

  console.log(`\n── Results: ${passed} passed, ${failed} failed ──\n`);
  if (failed > 0) process.exit(1);
}

if (require.main === module) {
  runAll().catch(e => { console.error('Test runner error:', e); process.exit(1); });
}

module.exports = { runAll };