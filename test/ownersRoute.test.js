/* eslint-disable no-undef */
'use strict';

/**
 * ownersRoute.test.js — GET /api/v1/owners (list) + PATCH /api/v1/owners/:id
 * (admin-only edit).
 *
 * PATCH is new: until this route existed there was NO application path to
 * fix a stale owners.email value (e.g. a legacy personal address preserved
 * from the original Base44 migration, still used as Reply-To on CRM-sent
 * email) — only a direct DB edit. Covers: admin-only gating, email
 * validation, partial updates, unique-email conflict, 404, and that this
 * never touches the `users`/authentication table.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const rbacPath = require.resolve('../lib/rbac');
delete require.cache[rbacPath];
require.cache[rbacPath] = { id: rbacPath, filename: rbacPath, loaded: true, exports: {
  requireAuth: (req, res, next) => {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer admin') && !auth.startsWith('Bearer nonadmin')) return res.status(401).json({ error: 'unauthorized' });
    req.user = auth.startsWith('Bearer nonadmin')
      ? { sub: 'u2', email: 'rep@ecconstructiongroup.com', role: 'sales_rep' }
      : { sub: 'u1', email: 'yaron@ecconstructiongroup.com', role: 'admin' };
    next();
  },
  requireRole: (...roles) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'not authenticated' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'forbidden: insufficient role' });
    next();
  },
} };

let owners;
function reset() {
  owners = [
    { id: 'o1', email: 'yaron.ecrenewables@gmail.com', display_name: 'Yaron Drilevich', is_active: true },
    { id: 'o2', email: 'michelle@ecconstructiongroup.com', display_name: 'Michelle Roitman Drilevich', is_active: true },
  ];
}
reset();

async function mockQuery(sql, params = []) {
  const s = String(sql);
  if (/^\s*SELECT id, email, display_name, is_active\s+FROM owners/i.test(s)) {
    return { rows: owners.filter(o => o.is_active) };
  }
  if (/^\s*UPDATE owners SET/i.test(s)) {
    const id = params[params.length - 1];
    const o = owners.find(x => x.id === id);
    if (!o) return { rows: [] };
    // Reconstruct which fields were set from the SQL text order (email first, then display_name — matches the route's own construction order).
    const setsEmail = /email = \$/.test(s);
    const setsName = /display_name = \$/.test(s);
    let i = 0;
    if (setsEmail) {
      const newEmail = params[i++];
      if (owners.some(x => x.id !== id && x.email === newEmail)) {
        const err = new Error('duplicate key value violates unique constraint "owners_email_key"');
        err.code = '23505';
        throw err;
      }
      o.email = newEmail;
    }
    if (setsName) { o.display_name = params[i++]; }
    return { rows: [{ id: o.id, email: o.email, display_name: o.display_name, is_active: o.is_active }] };
  }
  throw new Error('mockQuery: unrecognized query: ' + s);
}
const dbPath = require.resolve('../db/client');
delete require.cache[dbPath];
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query: mockQuery, pool: {} } };

delete require.cache[require.resolve('../routes/owners')];
const ownersRouter = require('../routes/owners');

function startServer() {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/owners', ownersRouter);
    const server = app.listen(0, () => resolve(server));
  });
}
function req(server, method, pathStr, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const data = body ? JSON.stringify(body) : undefined;
    const r = http.request({ port, path: pathStr, method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let out = ''; res.on('data', c => out += c); res.on('end', () => {
        let parsed; try { parsed = JSON.parse(out); } catch { parsed = out; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

test('GET /api/v1/owners: any authenticated user can list active owners', async () => {
  reset();
  const s = await startServer();
  try {
    const r = await req(s, 'GET', '/api/v1/owners', { headers: { Authorization: 'Bearer nonadmin' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.items.length, 2);
  } finally { s.close(); }
});

test('PATCH: 401 with no auth', async () => {
  reset();
  const s = await startServer();
  try {
    const r = await req(s, 'PATCH', '/api/v1/owners/o1', { body: { email: 'x@ecconstructiongroup.com' } });
    assert.strictEqual(r.status, 401);
  } finally { s.close(); }
});

test('PATCH: 403 for a non-admin — editing Reply-To data is admin-only', async () => {
  reset();
  const s = await startServer();
  try {
    const r = await req(s, 'PATCH', '/api/v1/owners/o1', { headers: { Authorization: 'Bearer nonadmin' }, body: { email: 'x@ecconstructiongroup.com' } });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(owners[0].email, 'yaron.ecrenewables@gmail.com', 'no mutation must occur');
  } finally { s.close(); }
});

test('PATCH: admin fixes the stale legacy Reply-To email to the canonical company address', async () => {
  reset();
  const s = await startServer();
  try {
    const r = await req(s, 'PATCH', '/api/v1/owners/o1', { headers: { Authorization: 'Bearer admin' }, body: { email: 'yaron@ecconstructiongroup.com' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.owner.email, 'yaron@ecconstructiongroup.com');
    assert.strictEqual(r.body.owner.display_name, 'Yaron Drilevich', 'display_name untouched when not supplied');
    assert.strictEqual(owners[0].email, 'yaron@ecconstructiongroup.com');
  } finally { s.close(); }
});

test('PATCH: rejects an invalid email', async () => {
  reset();
  const s = await startServer();
  try {
    const r = await req(s, 'PATCH', '/api/v1/owners/o1', { headers: { Authorization: 'Bearer admin' }, body: { email: 'not-an-email' } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(owners[0].email, 'yaron.ecrenewables@gmail.com', 'no mutation on validation failure');
  } finally { s.close(); }
});

test('PATCH: rejects an empty body (neither field supplied)', async () => {
  reset();
  const s = await startServer();
  try {
    const r = await req(s, 'PATCH', '/api/v1/owners/o1', { headers: { Authorization: 'Bearer admin' }, body: {} });
    assert.strictEqual(r.status, 400);
  } finally { s.close(); }
});

test('PATCH: 404 for an unknown owner id', async () => {
  reset();
  const s = await startServer();
  try {
    const r = await req(s, 'PATCH', '/api/v1/owners/does-not-exist', { headers: { Authorization: 'Bearer admin' }, body: { email: 'x@ecconstructiongroup.com' } });
    assert.strictEqual(r.status, 404);
  } finally { s.close(); }
});

test('PATCH: 409 when the new email collides with another owner (unique constraint)', async () => {
  reset();
  const s = await startServer();
  try {
    const r = await req(s, 'PATCH', '/api/v1/owners/o1', { headers: { Authorization: 'Bearer admin' }, body: { email: 'michelle@ecconstructiongroup.com' } });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(owners[0].email, 'yaron.ecrenewables@gmail.com', 'no partial mutation on conflict');
  } finally { s.close(); }
});

test('PATCH: can update display_name only, leaving email untouched', async () => {
  reset();
  const s = await startServer();
  try {
    const r = await req(s, 'PATCH', '/api/v1/owners/o1', { headers: { Authorization: 'Bearer admin' }, body: { display_name: 'Yaron D.' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(owners[0].email, 'yaron.ecrenewables@gmail.com');
    assert.strictEqual(owners[0].display_name, 'Yaron D.');
  } finally { s.close(); }
});

test('this route never reads or writes the users/authentication table — only `owners`', () => {
  const src = require('fs').readFileSync(require.resolve('../routes/owners'), 'utf8');
  assert.ok(!/FROM users|UPDATE users|INSERT INTO users/i.test(src), 'owners.js must never touch the users/auth table');
});
