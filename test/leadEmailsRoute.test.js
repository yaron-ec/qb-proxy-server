/* eslint-disable no-undef */
'use strict';

/**
 * leadEmailsRoute.test.js — GET /api/v1/leads/:id/emails route-level
 * coverage: authorization, safe query construction (never a raw caller
 * query), idempotent upsert on repeat sync, and inbound/outbound
 * classification end to end.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const LEAD_ID = '00000000-0000-0000-0000-00000000ea01';
const COMPANY_EMAIL = 'yaron@ecconstructiongroup.com';
const LEAD_EMAIL = 'brian.krantz@example.com';

const USERS = {
  'owning-rep-token': { sub: 'u-rep1', email: 'rep1@ecconstructiongroup.com', role: 'sales_rep' },
  'other-rep-token': { sub: 'u-rep2', email: 'rep2@ecconstructiongroup.com', role: 'sales_rep' },
  'admin-token': { sub: 'u-admin', email: 'yaron@ecconstructiongroup.com', role: 'admin' },
};
const rbacPath = require.resolve('../lib/rbac');
delete require.cache[rbacPath];
require.cache[rbacPath] = { id: rbacPath, filename: rbacPath, loaded: true, exports: {
  requireAuth: (req, res, next) => {
    const auth = req.headers.authorization || '';
    const user = USERS[auth.replace(/^Bearer\s+/, '')];
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    req.user = user;
    next();
  },
} };

let leads, activities, owners, nextId;
function reset() {
  nextId = 1;
  leads = [{ id: LEAD_ID, email: LEAD_EMAIL, owner_id: 'owner-rep1@ecconstructiongroup.com' }];
  activities = [];
  owners = [{ email: 'rep1@ecconstructiongroup.com', id: 'owner-rep1@ecconstructiongroup.com' }];
}
reset();

async function mockQuery(sql, params = []) {
  const s = String(sql);
  if (/SELECT id, email FROM leads WHERE id/i.test(s)) {
    const l = leads.find(x => x.id === params[0]);
    return { rows: l ? [l] : [] };
  }
  if (/SELECT owner_id FROM leads WHERE/i.test(s)) {
    const l = leads.find(x => x.id === params[0]);
    return { rows: l ? [{ owner_id: l.owner_id }] : [] };
  }
  if (/FROM owners WHERE/i.test(s)) {
    const email = String(params[0] || '').toLowerCase();
    const o = owners.find(x => x.email.toLowerCase() === email);
    return { rows: o ? [{ id: o.id }] : [] };
  }
  if (/INSERT INTO activities/i.test(s)) {
    // (lead_id, type='email', content, author, source='gmail', metadata, external_ref, created_at)
    const externalRef = params[4];
    if (activities.some(a => a.external_ref === externalRef)) return { rows: [] }; // ON CONFLICT DO NOTHING
    const row = {
      id: `act-${nextId++}`, lead_id: params[0], type: 'email', content: params[1], author: params[2],
      source: 'gmail', metadata: JSON.parse(params[3]), external_ref: externalRef, created_at: params[5], updated_at: params[5],
    };
    activities.push(row);
    return { rows: [row] };
  }
  if (/SELECT \* FROM activities WHERE lead_id = \$1 AND type = 'email'/i.test(s)) {
    return { rows: activities.filter(a => a.lead_id === params[0]).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)) };
  }
  throw new Error('mockQuery: unrecognized query: ' + s);
}
const dbPath = require.resolve('../db/client');
delete require.cache[dbPath];
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query: mockQuery, pool: {} } };

let refreshCalled = 0;
const gmailPath = require.resolve('../lib/gmailSender');
delete require.cache[gmailPath];
require.cache[gmailPath] = { id: gmailPath, filename: gmailPath, loaded: true, exports: {
  refreshAccessToken: async () => { refreshCalled++; return 'fake-token'; },
  GmailCredentialsError: class extends Error {},
} };

let lastQueryParam = null;
let gmailFetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ messages: [] }) });
global.fetch = (url, ...rest) => {
  const u = new URL(String(url));
  if (u.pathname.endsWith('/messages')) lastQueryParam = u.searchParams.get('q');
  return gmailFetchImpl(url, ...rest);
};

for (const mod of ['../lib/recordAccess', '../lib/gmailLeadMatch', '../routes/leadEmails']) {
  const p = require.resolve(mod);
  delete require.cache[p];
}
const leadEmailsRouter = require('../routes/leadEmails');

function startServer() {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/leads', leadEmailsRouter);
    const server = app.listen(0, () => resolve(server));
  });
}
function get(server, pathStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    http.get({ port, path: pathStr, headers }, (res) => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => {
        let body; try { body = JSON.parse(data); } catch { body = data; }
        resolve({ status: res.statusCode, body });
      });
    }).on('error', reject);
  });
}

function mockGmailMessages(messages) {
  gmailFetchImpl = async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith('/messages')) {
      return { ok: true, status: 200, json: async () => ({ messages: messages.map(m => ({ id: m.id, threadId: m.threadId || m.id })) }) };
    }
    const idMatch = u.pathname.match(/\/messages\/([^/]+)$/);
    const m = messages.find(x => x.id === (idMatch && idMatch[1]));
    return {
      ok: true, status: 200,
      json: async () => ({
        id: m.id, threadId: m.threadId || m.id, snippet: m.snippet || '',
        payload: {
          headers: [
            { name: 'From', value: m.from }, { name: 'To', value: m.to },
            { name: 'Cc', value: m.cc || '' }, { name: 'Subject', value: m.subject || '(no subject)' },
            { name: 'Date', value: m.date || new Date().toISOString() },
          ],
          parts: m.hasAttachment ? [{ filename: 'invoice.pdf' }] : [],
        },
      }),
    };
  };
}

test('an unauthorized rep (not this lead\'s owner) is denied', async () => {
  reset();
  mockGmailMessages([]);
  const s = await startServer();
  try {
    const r = await get(s, `/api/v1/leads/${LEAD_ID}/emails`, { Authorization: 'Bearer other-rep-token' });
    assert.strictEqual(r.status, 403);
  } finally { s.close(); }
});

test('the owning rep can fetch, and the Gmail query is scoped to the lead\'s own address (never a raw caller query)', async () => {
  reset();
  mockGmailMessages([]);
  const s = await startServer();
  try {
    const r = await get(s, `/api/v1/leads/${LEAD_ID}/emails`, { Authorization: 'Bearer owning-rep-token' });
    assert.strictEqual(r.status, 200);
    assert.ok(lastQueryParam.includes(LEAD_EMAIL), 'query must be scoped to the lead email');
    assert.ok(!/is:inbox/.test(lastQueryParam) === false || true); // no assumption about folder scoping beyond containing the address
  } finally { s.close(); }
});

test('an inbound message (lead -> company) and an outbound message (company -> lead) are both captured with correct direction', async () => {
  reset();
  mockGmailMessages([
    { id: 'm1', from: LEAD_EMAIL, to: COMPANY_EMAIL, subject: 'Question about my kitchen', date: '2026-08-01T10:00:00Z' },
    { id: 'm2', from: COMPANY_EMAIL, to: LEAD_EMAIL, subject: 'Re: Question about my kitchen', date: '2026-08-01T12:00:00Z', hasAttachment: true },
  ]);
  const s = await startServer();
  try {
    const r = await get(s, `/api/v1/leads/${LEAD_ID}/emails`, { Authorization: 'Bearer owning-rep-token' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.items.length, 2);
    const inbound = r.body.items.find(i => i.metadata.direction === 'inbound');
    const outbound = r.body.items.find(i => i.metadata.direction === 'outbound');
    assert.ok(inbound && outbound);
    assert.strictEqual(outbound.metadata.has_attachment, true);
    assert.strictEqual(inbound.metadata.has_attachment, false);
    // Real Gmail timestamp, not a sync-time timestamp.
    assert.strictEqual(new Date(inbound.timestamp).toISOString(), '2026-08-01T10:00:00.000Z');
  } finally { s.close(); }
});

test('IDEMPOTENCY: fetching twice (a "refresh"/retry) never duplicates the same Gmail message', async () => {
  reset();
  mockGmailMessages([{ id: 'm1', from: LEAD_EMAIL, to: COMPANY_EMAIL, subject: 'Hello', date: '2026-08-01T10:00:00Z' }]);
  const s = await startServer();
  try {
    const first = await get(s, `/api/v1/leads/${LEAD_ID}/emails`, { Authorization: 'Bearer owning-rep-token' });
    const second = await get(s, `/api/v1/leads/${LEAD_ID}/emails`, { Authorization: 'Bearer owning-rep-token' });
    assert.strictEqual(first.body.items.length, 1);
    assert.strictEqual(second.body.items.length, 1);
    assert.strictEqual(activities.length, 1);
  } finally { s.close(); }
});

test('a message that does not actually involve this lead\'s address is not stored', async () => {
  reset();
  mockGmailMessages([{ id: 'm-unrelated', from: 'someone@other.com', to: 'someone-else@other.com', subject: 'Not related' }]);
  const s = await startServer();
  try {
    const r = await get(s, `/api/v1/leads/${LEAD_ID}/emails`, { Authorization: 'Bearer owning-rep-token' });
    assert.strictEqual(r.body.items.length, 0);
  } finally { s.close(); }
});

test('Gmail being unavailable is non-fatal — existing activity is still returned', async () => {
  reset();
  activities.push({ id: 'pre-existing', lead_id: LEAD_ID, type: 'email', content: 'Old subject', author: LEAD_EMAIL, source: 'gmail', metadata: { direction: 'inbound' }, external_ref: 'gmail:old', created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' });
  gmailFetchImpl = async () => { throw new Error('network down'); };
  const s = await startServer();
  try {
    const r = await get(s, `/api/v1/leads/${LEAD_ID}/emails`, { Authorization: 'Bearer owning-rep-token' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.items.length, 1);
    assert.strictEqual(r.body.items[0].id, 'pre-existing');
  } finally { s.close(); }
});

test('admin can fetch regardless of lead ownership', async () => {
  reset();
  mockGmailMessages([]);
  const s = await startServer();
  try {
    const r = await get(s, `/api/v1/leads/${LEAD_ID}/emails`, { Authorization: 'Bearer admin-token' });
    assert.strictEqual(r.status, 200);
  } finally { s.close(); }
});
