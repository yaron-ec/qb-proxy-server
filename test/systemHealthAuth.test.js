/* eslint-disable no-undef */
'use strict';

/**
 * systemHealthAuth.test.js — the admin System Health endpoints accept only a
 * CRM admin JWT or the verification workflow's GitHub OIDC token (signature,
 * issuer, audience, expiry, repository, visibility and workflow all checked).
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'unit-test-secret-unit-test-secret-0123456789';
const { verifyGithubOidc, requireAdminOrVerificationWorkflow, CI_REPOSITORY, OIDC_ISSUER, OIDC_AUDIENCE } = require('../lib/systemHealthAuth');
const { issueAccessToken } = require('../lib/authService');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }];
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;

function sign(claims, { key = privateKey, kid = 'k1', alg = 'RS256' } = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${enc({ alg, kid, typ: 'JWT' })}.${enc(claims)}`;
  return `${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), key).toString('base64url')}`;
}
const now = Math.floor(Date.now() / 1000);
const good = {
  iss: OIDC_ISSUER, aud: OIDC_AUDIENCE, exp: now + 300, nbf: now - 10, run_id: '1',
  repository: CI_REPOSITORY, repository_visibility: 'private',
  workflow_ref: `${CI_REPOSITORY}/.github/workflows/final-verify.yml@refs/heads/main`,
};

test('a valid verification-workflow OIDC token is accepted', async () => {
  const c = await verifyGithubOidc(sign(good), { jwks });
  assert.strictEqual(c.repository, CI_REPOSITORY);
});

test('every OIDC condition is enforced', async () => {
  const bad = {
    signature: [good, { key: other }],
    unknown_kid: [good, { kid: 'nope' }],
    alg: [good, { alg: 'HS256' }],
    iss: [{ ...good, iss: 'https://evil.example' }],
    aud: [{ ...good, aud: 'something-else' }],
    expired: [{ ...good, exp: now - 1 }],
    repository: [{ ...good, repository: 'someone/else', workflow_ref: 'someone/else/.github/workflows/final-verify.yml@x' }],
    public_repo: [{ ...good, repository_visibility: 'public' }],
    workflow: [{ ...good, workflow_ref: `${CI_REPOSITORY}/.github/workflows/other.yml@refs/heads/main` }],
  };
  for (const [name, [claims, opts]] of Object.entries(bad)) {
    await assert.rejects(verifyGithubOidc(sign(claims, opts || {}), { jwks }), undefined, name);
  }
});

async function run(authorization) {
  const mw = requireAdminOrVerificationWorkflow({ jwks });
  const req = { headers: authorization ? { authorization } : {} };
  let status = 200; let nextCalled = false;
  const res = { status(s) { status = s; return this; }, json() { return this; } };
  await mw(req, res, () => { nextCalled = true; });
  return { status: nextCalled ? 200 : status, user: req.user };
}

test('middleware: admin JWT ok; non-admin 403; missing/invalid 401; workflow OIDC ok as system_health only', async () => {
  assert.strictEqual((await run()).status, 401);
  assert.strictEqual((await run('Bearer garbage')).status, 401);
  const admin = issueAccessToken({ id: '00000000-0000-0000-0000-0000000000a1', email: 'a@example.com', role: 'admin' });
  assert.strictEqual((await run(`Bearer ${admin}`)).status, 200);
  const rep = issueAccessToken({ id: '00000000-0000-0000-0000-0000000000a2', email: 'r@example.com', role: 'sales_rep' });
  assert.strictEqual((await run(`Bearer ${rep}`)).status, 403);
  const ok = await run(`Bearer ${sign(good)}`);
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.user.role, 'system_health');
  assert.strictEqual((await run(`Bearer ${sign({ ...good, repository_visibility: 'public' })}`)).status, 401);
});

test('the system_health identity is honoured nowhere else: rbac requireAuth rejects an OIDC token', () => {
  const { requireAuth } = require('../lib/rbac');
  let status = null;
  requireAuth({ headers: { authorization: `Bearer ${sign(good)}` } }, { status(s) { status = s; return this; }, json() { return this; } }, () => { status = 200; });
  assert.strictEqual(status, 401);
});

test('the public unauthenticated integrity route is gone; the admin System Health router is mounted', () => {
  const src = require('fs').readFileSync(require.resolve('../server.js'), 'utf8');
  assert.doesNotMatch(src, /\/api\/public\/phone-call-integrity/);
  assert.ok(!require('fs').existsSync(require('path').join(__dirname, '../routes/phoneCallIntegrity.js')));
  assert.match(src, /app\.use\('\/api\/v1\/system', require\('\.\/routes\/systemHealth'\)\)/);
});
