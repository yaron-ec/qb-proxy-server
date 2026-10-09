/* eslint-disable no-undef */
'use strict';

/**
 * authServiceInvite.test.js — unit coverage for lib/authService.js's
 * invite/activation pair (PRODUCTIZATION — Company Provisioning System,
 * multi-company onboarding workflow): createPendingUser() and
 * acceptInvite(). Mocks db/client.js the same way test/securityIsolation.js
 * does (a fake module in require.cache) — no live Postgres needed.
 */
process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'test-only-jwt-secret-at-least-32-chars-long';

const test = require('node:test');
const assert = require('node:assert');

function mockDb(handlers) {
  const dbPath = require.resolve('../db/client');
  delete require.cache[dbPath];
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: { query: handlers, pool: {} },
  };
  delete require.cache[require.resolve('../lib/authService')];
  return require('../lib/authService');
}

test('createPendingUser: inserts a password-less user and returns the raw token (never persisted in plaintext)', async () => {
  let inserted = null;
  const auth = mockDb(async (sql, params) => {
    const s = String(sql);
    if (/^\s*INSERT INTO users/i.test(s)) {
      inserted = { email: params[0], full_name: params[1], role: params[2], tokenHash: params[3], expiresAt: params[4] };
      return { rows: [{ id: 'u1', email: params[0], full_name: params[1], role: params[2], status: 'active' }] };
    }
    throw new Error('unexpected query: ' + s);
  });

  const result = await auth.createPendingUser({ email: 'Jordan@Acme.example', full_name: 'Jordan Admin', role: 'admin' });
  assert.strictEqual(result.user.email, 'Jordan@Acme.example');
  assert.ok(result.rawToken && result.rawToken.length === 64, 'expects a 32-byte hex token');
  assert.ok(inserted.tokenHash && inserted.tokenHash !== result.rawToken, 'only the HASH is persisted, never the raw token');
  assert.strictEqual(inserted.email, 'Jordan@Acme.example');
  assert.ok(new Date(result.expiresAt).getTime() > Date.now(), 'invite must expire in the future');
});

test('createPendingUser: resending (email already pending, no password) overwrites the token — this IS "resend invite"', async () => {
  const auth = mockDb(async (sql, params) => {
    const s = String(sql);
    if (/^\s*INSERT INTO users/i.test(s)) {
      // Simulate ON CONFLICT ... WHERE password_hash IS NULL succeeding (re-issue).
      return { rows: [{ id: 'u1', email: params[0], full_name: params[1], role: params[2], status: 'active' }] };
    }
    throw new Error('unexpected query: ' + s);
  });
  const result = await auth.createPendingUser({ email: 'repeat@acme.example', role: 'user' });
  assert.strictEqual(result.user.email, 'repeat@acme.example');
});

test('createPendingUser: refuses (already_active) when the email already has a real password', async () => {
  const auth = mockDb(async (sql, params) => {
    const s = String(sql);
    if (/^\s*INSERT INTO users/i.test(s)) return { rows: [] }; // ON CONFLICT...WHERE password_hash IS NULL excluded this row
    if (/^\s*SELECT \* FROM users WHERE lower\(email\)/i.test(s)) {
      return { rows: [{ id: 'u2', email: params[0], password_hash: 'scrypt:...' }] };
    }
    throw new Error('unexpected query: ' + s);
  });
  await assert.rejects(
    () => auth.createPendingUser({ email: 'active@acme.example' }),
    (e) => e.code === 'already_active'
  );
});

test('acceptInvite: valid token sets a password hash and clears the invite columns (single-use)', async () => {
  let updateParams = null;
  const auth = mockDb(async (sql, params) => {
    const s = String(sql);
    if (/^\s*SELECT \* FROM users WHERE invite_token_hash/i.test(s)) {
      return { rows: [{ id: 'u1', email: 'jordan@acme.example', invite_token_hash: params[0] }] };
    }
    if (/^\s*UPDATE users SET password_hash/i.test(s)) {
      updateParams = params;
      return { rows: [{ id: 'u1', email: 'jordan@acme.example', password_hash: params[0] }] };
    }
    throw new Error('unexpected query: ' + s);
  });
  const user = await auth.acceptInvite('a-raw-token-value', 'a-brand-new-password-123');
  assert.strictEqual(user.id, 'u1');
  assert.ok(updateParams[0].startsWith('scrypt:'), 'password must be hashed, never stored raw');
  assert.strictEqual(updateParams[0].includes('a-brand-new-password-123'), false);
});

test('acceptInvite: invalid/expired/already-used token returns null (no user, no crash)', async () => {
  const auth = mockDb(async (sql) => {
    const s = String(sql);
    if (/^\s*SELECT \* FROM users WHERE invite_token_hash/i.test(s)) return { rows: [] };
    throw new Error('unexpected query: ' + s);
  });
  const user = await auth.acceptInvite('does-not-exist', 'whatever-password-123');
  assert.strictEqual(user, null);
});

test('INVITE_TTL_DAYS is exported and matches scripts/install/bootstrap.js\'s PENDING_INVITE_TTL_DAYS (kept in sync manually)', () => {
  const dbPath = require.resolve('../db/client');
  delete require.cache[dbPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query: async () => ({ rows: [] }), pool: {} } };
  delete require.cache[require.resolve('../lib/authService')];
  const auth = require('../lib/authService');
  assert.strictEqual(auth.INVITE_TTL_DAYS, 7);
});
