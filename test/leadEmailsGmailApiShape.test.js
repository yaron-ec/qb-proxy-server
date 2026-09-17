/* eslint-disable no-undef */
'use strict';

/**
 * leadEmailsGmailApiShape.test.js — regression coverage using a REALISTIC
 * Gmail API response shape, not the simplified always-returns-all-headers
 * mock in test/leadEmailsRoute.test.js.
 *
 * Production defect found after gmail.readonly authorization succeeded:
 * Brian Krantz's real historical correspondence still never appeared.
 * Root cause: routes/leadEmails.js's gmailFetch() serialized the
 * `metadataHeaders` array param with url.searchParams.set(), which joins an
 * array into ONE comma-separated string ("From,To,Cc,Subject,Date"). The
 * real Gmail API treats `metadataHeaders` as a REPEATABLE parameter — one
 * query-string entry per header name — and a single joined value doesn't
 * match any real header name, so Gmail's `format=metadata` response comes
 * back with ZERO headers for every message. From/To/Cc all read as empty
 * strings, messageInvolvesLead() correctly (and silently) rejects every
 * message, and nothing is ever stored — with gmail_status still 'ok'
 * because the HTTP calls themselves succeeded. The prior test suite never
 * caught this because its mock built `payload.headers` directly instead of
 * filtering by the actual request's query parameters, so it could not
 * distinguish correct from broken request construction.
 *
 * This mock instead behaves like the real API: it reads the ACTUAL
 * querystring (via URLSearchParams.getAll, which is how a real repeated
 * param is read) and only returns headers whose name was actually
 * requested — reproducing the exact failure mode a real regression would
 * hit, and proving the fix (url.searchParams.append per array item).
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const LEAD_ID = '00000000-0000-0000-0000-00000000ea02';
const COMPANY_EMAIL = 'yaron@ecconstructiongroup.com';
const LEAD_EMAIL = 'Brian.Krantz1@gmail.com'; // mixed-case, as a human would type it

const rbacPath = require.resolve('../lib/rbac');
delete require.cache[rbacPath];
require.cache[rbacPath] = { id: rbacPath, filename: rbacPath, loaded: true, exports: {
  requireAuth: (req, res, next) => { req.user = { sub: 'u-admin', email: COMPANY_EMAIL, role: 'admin' }; next(); },
} };

let leads, activities, nextId;
function reset() {
  nextId = 1;
  leads = [{ id: LEAD_ID, email: LEAD_EMAIL }];
  activities = [];
}
reset();

async function mockQuery(sql, params = []) {
  const s = String(sql);
  if (/SELECT id, email FROM leads WHERE id/i.test(s)) {
    const l = leads.find(x => x.id === params[0]);
    return { rows: l ? [l] : [] };
  }
  if (/INSERT INTO activities/i.test(s)) {
    const externalRef = params[4];
    if (activities.some(a => a.external_ref === externalRef)) return { rows: [] };
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

const gmailPath = require.resolve('../lib/gmailSender');
delete require.cache[gmailPath];
require.cache[gmailPath] = { id: gmailPath, filename: gmailPath, loaded: true, exports: {
  refreshAccessToken: async () => 'fake-token',
  GmailCredentialsError: class extends Error {},
} };

// ── A REALISTIC Gmail API double ────────────────────────────────────────────
// messagesByPage: array of pages, each an array of message defs. Each
// message def: { id, threadId, from, to, cc, subject, date }.
function installRealisticGmailApi(messagesByPage) {
  const allMessages = messagesByPage.flat();
  global.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith('/messages')) {
      const pageToken = u.searchParams.get('pageToken');
      const pageIndex = pageToken ? Number(pageToken) : 0;
      const page = messagesByPage[pageIndex] || [];
      const nextPageToken = pageIndex + 1 < messagesByPage.length ? String(pageIndex + 1) : undefined;
      return {
        ok: true, status: 200,
        json: async () => ({ messages: page.map(m => ({ id: m.id, threadId: m.threadId || m.id })), nextPageToken }),
      };
    }
    const idMatch = u.pathname.match(/\/messages\/([^/]+)$/);
    if (idMatch) {
      const m = allMessages.find(x => x.id === idMatch[1]);
      if (!m) return { ok: false, status: 404, text: async () => 'not found' };
      const format = u.searchParams.get('format');
      // Realistic repeated-param read — exactly how a real querystring with
      // metadataHeaders=From&metadataHeaders=To&... would be read back.
      const requested = u.searchParams.getAll('metadataHeaders');
      const allHeaders = [
        { name: 'From', value: m.from }, { name: 'To', value: m.to },
        { name: 'Cc', value: m.cc || '' }, { name: 'Subject', value: m.subject || '(no subject)' },
        { name: 'Date', value: m.date },
      ];
      const headers = format === 'metadata' ? allHeaders.filter(h => requested.includes(h.name)) : allHeaders;
      return {
        ok: true, status: 200,
        json: async () => ({ id: m.id, threadId: m.threadId || m.id, snippet: m.subject || '', payload: { headers, parts: [] } }),
      };
    }
    return { ok: false, status: 404, text: async () => 'not found' };
  };
}

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
function get(server, pathStr) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    http.get({ port, path: pathStr, headers: { Authorization: 'Bearer x' } }, (res) => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => {
        let body; try { body = JSON.parse(data); } catch { body = data; }
        resolve({ status: res.statusCode, body });
      });
    }).on('error', reject);
  });
}

test('REGRESSION: against a realistic Gmail API (metadataHeaders must be a repeated param), real correspondence is found and matched — not silently discarded', async () => {
  reset();
  installRealisticGmailApi([[
    { id: 'm1', from: LEAD_EMAIL, to: COMPANY_EMAIL, subject: 'Kitchen remodel question', date: '2026-08-01T10:00:00Z' },
    { id: 'm2', from: COMPANY_EMAIL, to: LEAD_EMAIL, subject: 'Re: Kitchen remodel question', date: '2026-08-01T12:00:00Z' },
  ]]);
  const s = await startServer();
  try {
    const r = await get(s, `/api/v1/leads/${LEAD_ID}/emails`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.gmail_status, 'ok');
    assert.strictEqual(r.body.gmail_messages_found, 2, 'the list call must find both messages');
    assert.strictEqual(r.body.gmail_messages_matched, 2, 'both messages must survive header-based matching — this is exactly what the metadataHeaders bug broke (matched would be 0)');
    assert.strictEqual(r.body.items.length, 2);
  } finally { s.close(); delete global.fetch; }
});

test('CC match: lead only Cc\'d (not To) still matches and is captured', async () => {
  reset();
  installRealisticGmailApi([[
    { id: 'm-cc', from: 'someone-else@ecconstructiongroup.com', to: 'coworker@ecconstructiongroup.com', cc: LEAD_EMAIL, subject: 'Looping you in', date: '2026-08-02T09:00:00Z' },
  ]]);
  const s = await startServer();
  try {
    const r = await get(s, `/api/v1/leads/${LEAD_ID}/emails`);
    assert.strictEqual(r.body.gmail_messages_matched, 1);
    assert.strictEqual(r.body.items.length, 1);
  } finally { s.close(); delete global.fetch; }
});

test('mixed-case address in the header still matches the lead\'s stored (also mixed-case) email', async () => {
  reset();
  installRealisticGmailApi([[
    { id: 'm-case', from: 'BRIAN.KRANTZ1@GMAIL.COM', to: COMPANY_EMAIL.toUpperCase(), subject: 'Case test', date: '2026-08-03T09:00:00Z' },
  ]]);
  const s = await startServer();
  try {
    const r = await get(s, `/api/v1/leads/${LEAD_ID}/emails`);
    assert.strictEqual(r.body.gmail_messages_matched, 1);
  } finally { s.close(); delete global.fetch; }
});

test('PAGINATION: a lead with more than one page of Gmail results gets messages from every page, not just the first', async () => {
  reset();
  const page0 = Array.from({ length: 50 }, (_, i) => ({ id: `p0-${i}`, from: LEAD_EMAIL, to: COMPANY_EMAIL, subject: `Msg ${i}`, date: `2026-01-01T00:${String(i).padStart(2, '0')}:00Z` }));
  const page1 = [{ id: 'p1-0', from: COMPANY_EMAIL, to: LEAD_EMAIL, subject: 'Older message on page 2', date: '2025-12-01T00:00:00Z' }];
  installRealisticGmailApi([page0, page1]);
  const s = await startServer();
  try {
    const r = await get(s, `/api/v1/leads/${LEAD_ID}/emails`);
    assert.strictEqual(r.body.gmail_messages_found, 51, 'both pages worth of messages must be fetched');
    assert.strictEqual(r.body.items.length, 51);
    assert.ok(r.body.items.some(i => i.content === 'Older message on page 2'), 'the second page\'s message must be present, not truncated at the first page');
  } finally { s.close(); delete global.fetch; }
});

test('an unrelated message (neither From/To/Cc involves the lead) is excluded even under the realistic API shape', async () => {
  reset();
  installRealisticGmailApi([[
    { id: 'm-unrelated', from: 'nobody@example.com', to: 'nobody-else@example.com', subject: 'Not related', date: '2026-08-04T09:00:00Z' },
  ]]);
  const s = await startServer();
  try {
    const r = await get(s, `/api/v1/leads/${LEAD_ID}/emails`);
    assert.strictEqual(r.body.gmail_messages_found, 1, 'Gmail search still returned it (a defense-in-depth check, not the primary filter)');
    assert.strictEqual(r.body.gmail_messages_matched, 0);
    assert.strictEqual(r.body.items.length, 0);
  } finally { s.close(); delete global.fetch; }
});

test('diagnostics: gmail_query is exposed and scoped to only this lead\'s own address', async () => {
  reset();
  installRealisticGmailApi([[]]);
  const s = await startServer();
  try {
    const r = await get(s, `/api/v1/leads/${LEAD_ID}/emails`);
    assert.ok(r.body.gmail_query.includes(LEAD_EMAIL));
    assert.strictEqual(r.body.gmail_messages_found, 0);
    assert.strictEqual(r.body.gmail_messages_matched, 0);
  } finally { s.close(); delete global.fetch; }
});
