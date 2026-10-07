/* eslint-disable no-undef */
'use strict';

/**
 * signnowSendControl.int.test.js — REAL-Postgres proof that preparing a
 * SignNow HIC contract from a template NEVER auto-sends it, and that
 * sending is its own separate, explicit, idempotent action.
 *
 * Production defect found in the CRM STABILITY PHASE SignNow audit:
 * crm-frontend/src/components/SignNowPanel.jsx's "Create Contract from
 * Template" button was literally labeled "Create & Send for Signature" and
 * called POST /api/v1/signnow/by-external/:ref/prepare with
 * send_invite: true — meaning EVERY contract created through the CRM was
 * emailed to the customer immediately, with zero opportunity for the user
 * to review or complete remaining template fields first. This directly
 * violated the explicit product requirement that automation must remove
 * duplicate data entry, never the user's final manual control over
 * sending. Fixed by defaulting to send_invite: false (prepare-only) and
 * adding a new, separate POST /documents/:docId/send action that the user
 * triggers explicitly once ready. The same fix was applied to the
 * secondary "Upload PDF" path, which previously sent unconditionally
 * whenever any signer was present.
 *
 * Stubs lib/signnowClient entirely (never calls the real SignNow API).
 * Skipped without TEST_DATABASE_URL.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
const ROOT = path.join(__dirname, '..', '..');

if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
  process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'int-test-secret-int-test-secret-0123456789';
}

let base, server, db, adminToken, leadId, companyConfig, insertedCompanySettingsId;
let sendInviteCalls, createFromTemplateCalls;

async function api(method, url, body, token) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { status: res.status, body: json };
}

async function setSignNowEnabled() {
  const existing = (await db.query('SELECT id, enabled_modules FROM company_settings ORDER BY created_at ASC LIMIT 1')).rows[0];
  const modules = { ...(existing ? existing.enabled_modules : {}), signnow: true };
  if (existing) {
    await db.query('UPDATE company_settings SET enabled_modules = $1 WHERE id = $2', [JSON.stringify(modules), existing.id]);
  } else {
    const ins = await db.query(
      `INSERT INTO company_settings (company_name, enabled_modules) VALUES ('SignNow Send Control Test Co', $1) RETURNING id`,
      [JSON.stringify(modules)]
    );
    insertedCompanySettingsId = ins.rows[0].id;
  }
  companyConfig.invalidate();
}

if (DB_URL) {
  const p = require.resolve(path.join(ROOT, 'lib/signnowClient'));
  require.cache[p] = {
    id: p, filename: p, loaded: true,
    exports: {
      getAuthMethod: () => 'api_key',
      getUserInfo: async () => ({ email: 'account@example-signnow.test' }),
      listTemplates: async () => [{ id: 'tmpl-1', name: 'HIC Template' }],
      createDocumentFromTemplate: async (templateId, name) => {
        createFromTemplateCalls.push({ templateId, name });
        return { id: `doc-${Date.now()}-${createFromTemplateCalls.length}`, document_name: name };
      },
      uploadDocument: async (buf, name) => ({ id: `uploaded-doc-${Date.now()}`, name }),
      sendInvite: async (docId, signers, fromEmail) => {
        sendInviteCalls.push({ docId, signers, fromEmail });
        return { id: docId, result: 'ok' };
      },
      getDocumentStatus: async () => ({ field_invites: [], signatures: [] }),
      downloadSignedPdf: async () => Buffer.from('fake-pdf'),
    },
  };
}

test.before(async () => {
  if (skip) return;
  sendInviteCalls = [];
  createFromTemplateCalls = [];
  delete require.cache[require.resolve(path.join(ROOT, 'db/client'))];
  db = require(path.join(ROOT, 'db/client'));
  companyConfig = require(path.join(ROOT, 'lib/companyConfig'));

  await setSignNowEnabled();

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/signnow', require(path.join(ROOT, 'routes/signnow')));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;

  const { issueAccessToken } = require(path.join(ROOT, 'lib/authService'));
  const stamp = Date.now();
  adminToken = issueAccessToken({ id: '00000000-0000-0000-0000-00000000cc01', email: `admin-signnow-${stamp}@test.example`, role: 'admin' });

  const ownerRes = await db.query(
    `INSERT INTO owners (email, display_name) VALUES ($1, 'SignNow Test Owner') RETURNING id`,
    [`owner-signnow-${stamp}@test.example`]
  );
  const { rows } = await db.query(
    `INSERT INTO leads (first_name, last_name, email, phone, source, status, owner_id)
     VALUES ('Signnow', 'TestLead', $1, '5556667777', 'Referral', 'Sold', $2)
     RETURNING id`,
    [`signnow-lead-${stamp}@test.example`, ownerRes.rows[0].id]
  );
  leadId = rows[0].id;
});

test.after(async () => {
  if (skip) return;
  server.close();
  if (insertedCompanySettingsId) await db.query('DELETE FROM company_settings WHERE id = $1', [insertedCompanySettingsId]);
  await db.pool.end();
});

test('1. preparing a contract from a template NEVER sends by default (send_invite omitted)', { skip }, async () => {
  const r = await api('POST', `/api/v1/signnow/by-external/${leadId}/prepare`, { template_id: 'tmpl-never-sent', template_name: 'HIC Template' }, adminToken);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.document.status, 'pending', 'a prepared document must stay pending, never auto-sent');
  assert.strictEqual(sendInviteCalls.length, 0, 'sendInvite must NEVER be called just because a document was prepared');
});

test('2. explicitly sending a pending document calls sendInvite exactly once and flips status to sent', { skip }, async () => {
  const prep = await api('POST', `/api/v1/signnow/by-external/${leadId}/prepare`, { template_id: 'tmpl-explicit-send', template_name: 'HIC Template', document_name: 'Doc To Send' }, adminToken);
  assert.strictEqual(prep.status, 201, JSON.stringify(prep.body));
  const docId = prep.body.document.document_id;

  const before = sendInviteCalls.length;
  const send = await api('POST', `/api/v1/signnow/documents/${docId}/send`, undefined, adminToken);
  assert.strictEqual(send.status, 200, JSON.stringify(send.body));
  assert.strictEqual(send.body.document.status, 'sent');
  assert.strictEqual(sendInviteCalls.length, before + 1, 'send must call sendInvite exactly once');
  assert.strictEqual(sendInviteCalls[sendInviteCalls.length - 1].docId, docId);

  // Sending an already-sent document again is rejected, not a silent duplicate send.
  const resend = await api('POST', `/api/v1/signnow/documents/${docId}/send`, undefined, adminToken);
  assert.strictEqual(resend.status, 409, JSON.stringify(resend.body));
  assert.strictEqual(sendInviteCalls.length, before + 1, 'resending an already-sent document must NOT call sendInvite again');
});

test('3. an explicit send_invite:true on prepare still works (opt-in one-step flow preserved)', { skip }, async () => {
  const r = await api('POST', `/api/v1/signnow/by-external/${leadId}/prepare`, { template_id: 'tmpl-2', template_name: 'HIC Template', document_name: 'One Step Doc', send_invite: true }, adminToken);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.document.status, 'sent');
});

test('4. uploading a PDF never auto-sends unless send_invite:true is explicitly passed', { skip }, async () => {
  // The upload route does a real fetch(file_url) to retrieve the PDF bytes —
  // point it at a local, in-process HTTP server rather than a real network URL.
  const http = require('http');
  const pdfServer = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(Buffer.from('%PDF-fake')); });
  await new Promise((r) => pdfServer.listen(0, '127.0.0.1', r));
  const pdfUrl = `http://127.0.0.1:${pdfServer.address().port}/x.pdf`;
  try {
    const r = await api('POST', `/api/v1/signnow/by-external/${leadId}/upload`, { file_url: pdfUrl, document_name: 'Uploaded Doc' }, adminToken);
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.document.status, 'pending', 'an uploaded PDF must also stay pending unless explicitly sent');
  } finally {
    pdfServer.close();
  }
});
