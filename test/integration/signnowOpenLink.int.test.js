/* eslint-disable no-undef */
'use strict';

/**
 * signnowOpenLink.int.test.js — REAL-Postgres proof of the fix for a real
 * production defect: Lead Detail → Contracts & Signatures → "Open in
 * SignNow" on a PENDING HIC contract opened
 * `https://app.signnow.com/document/{documentId}` and SignNow returned a
 * 404 "Page wasn't found", even though the document was genuinely created
 * successfully.
 *
 * ROOT CAUSE: SignNowPanel.jsx hand-constructed a plain `<a href>` straight
 * to a HARDCODED PRODUCTION web-app host (`app.signnow.com`), regardless of
 * which SignNow environment the configured credentials actually belong to.
 * SignNow runs two entirely separate environments, each with its own web
 * app (confirmed via SignNow's own official SDK resource tables):
 *   api.signnow.com      <-> app.signnow.com       (production)
 *   api-eval.signnow.com <-> app-eval.signnow.com  (sandbox/eval)
 * A document created under Eval/Sandbox credentials (e.g. a Development
 * application's API key, which lib/signnowClient.js's own
 * getEffectiveApiBase() auto-detects/routes to api-eval.signnow.com) simply
 * does not exist at app.signnow.com — SignNow returns a clean 404 there,
 * indistinguishable from a genuinely deleted document, an invalid id, or a
 * cross-account authorization mismatch UNLESS the application itself
 * verifies the document server-side first.
 *
 * FIX: GET /api/v1/signnow/documents/:docId/open-link never hands back a
 * URL without first proving (via a real authenticated call against THIS
 * account's own actual API base) that the document still exists. For a
 * document that has not yet been sent for signing, it uses SignNow's
 * official embedded-editor link (POST /v2/documents/{id}/embedded-editor)
 * — no separate SignNow browser login needed at all. For anything already
 * sent/signed/completed (where embedded-editor's own precondition forbids
 * it), it falls back to a plain web link built from the ACCOUNT'S ACTUAL
 * environment (lib/signnowClient.js#getWebAppBase), never a hardcoded host.
 *
 * Existing PENDING contracts are recoverable WITHOUT re-creating anything:
 * their stored document_id is unchanged and still valid — only the LINK
 * construction was wrong, never the document itself, so this fix alone
 * makes every existing pending contract immediately openable again (test 7
 * proves the fix works against a document identical in shape to one
 * created before this fix shipped).
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
let embeddedEditorCalls, webAppBaseCalls, liveDocuments, forceWebAppBase, createFromTemplateCalls;

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
    const ins = await db.query(`INSERT INTO company_settings (company_name, enabled_modules) VALUES ('SignNow Open-Link Test Co', $1) RETURNING id`, [JSON.stringify(modules)]);
    insertedCompanySettingsId = ins.rows[0].id;
  }
  companyConfig.invalidate();
}

// `liveDocuments` maps a document_id to what the FAKE SignNow API says that
// document's live state is (or 'not_found'/'not_configured' sentinels) —
// lets each test simulate a different real-world SignNow condition without
// ever calling the real API.
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
        const id = `doc-${Date.now()}-${createFromTemplateCalls.length}`;
        liveDocuments.set(id, { field_invites: [], signatures: [] }); // freshly copied = never sent
        return { id, document_name: name };
      },
      uploadDocument: async () => ({ id: `uploaded-${Date.now()}` }),
      sendInvite: async (docId) => ({ id: docId, result: 'ok' }),
      getDocumentStatus: async (docId) => {
        const state = liveDocuments.get(docId);
        if (state === 'not_found' || state === undefined) {
          const err = new Error('SignNow get document failed 404: not found');
          err.status = 404;
          err.code = 'SIGNNOW_DOCUMENT_NOT_FOUND';
          throw err;
        }
        if (state === 'not_configured') {
          const err = new Error('SignNow not configured');
          err.code = 'SIGNNOW_NOT_CONFIGURED';
          throw err;
        }
        return state;
      },
      getEmbeddedEditorLink: async (docId) => {
        embeddedEditorCalls.push(docId);
        const state = liveDocuments.get(docId);
        if (state?.forceEmbeddedEditorFailure) throw new Error('SignNow embedded-editor link failed 409: document already sent');
        return `https://app.signnow.com/webapp/editor/${docId}?access_token=fake-short-lived-token`;
      },
      getWebAppBase: async () => {
        webAppBaseCalls.push(1);
        return forceWebAppBase;
      },
      downloadSignedPdf: async () => Buffer.from('fake-pdf'),
    },
  };
}

test.before(async () => {
  if (skip) return;
  embeddedEditorCalls = [];
  webAppBaseCalls = [];
  createFromTemplateCalls = [];
  liveDocuments = new Map();
  forceWebAppBase = 'https://app.signnow.com'; // default: production

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
  adminToken = issueAccessToken({ id: '00000000-0000-0000-0000-00000000bb01', email: `admin-openlink-${stamp}@test.example`, role: 'admin' });

  const ownerRes = await db.query(`INSERT INTO owners (email, display_name) VALUES ($1, 'Open-Link Test Owner') RETURNING id`, [`owner-openlink-${stamp}@test.example`]);
  const { rows } = await db.query(
    `INSERT INTO leads (first_name, last_name, email, phone, source, status, owner_id)
     VALUES ('OpenLink', 'TestLead', $1, '5554443333', 'Referral', 'Sold', $2) RETURNING id`,
    [`openlink-lead-${stamp}@test.example`, ownerRes.rows[0].id]
  );
  leadId = rows[0].id;
});

test.after(async () => {
  if (skip) return;
  server.close();
  if (insertedCompanySettingsId) await db.query('DELETE FROM company_settings WHERE id = $1', [insertedCompanySettingsId]);
  await db.pool.end();
});

async function insertDoc(docId, status, stamp) {
  await db.query(
    `INSERT INTO signnow_documents (lead_id, document_id, document_name, status, signers, created_by)
     VALUES ($1, $2, $3, $4, '[]'::jsonb, 'tester')`,
    [leadId, docId, `Doc ${stamp}`, status]
  );
}

test('1. a not-yet-sent PENDING document gets a working embedded-editor link, never the raw web URL', { skip }, async () => {
  const docId = `doc-pending-${Date.now()}`;
  liveDocuments.set(docId, { field_invites: [], signatures: [] });
  await insertDoc(docId, 'pending', 1);

  const before = embeddedEditorCalls.length;
  const r = await api('GET', `/api/v1/signnow/documents/${docId}/open-link`, undefined, adminToken);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.mode, 'editor');
  assert.ok(r.body.url.includes(docId), 'the returned URL must reference this exact document');
  assert.strictEqual(embeddedEditorCalls.length, before + 1);
});

test('2. a document already SENT (has field_invites) never attempts embedded-editor — gets the environment-correct view link instead', { skip }, async () => {
  const docId = `doc-sent-${Date.now()}`;
  liveDocuments.set(docId, { field_invites: [{ email: 'customer@example.com', status: 'pending' }], signatures: [] });
  await insertDoc(docId, 'sent', 2);

  const before = embeddedEditorCalls.length;
  const r = await api('GET', `/api/v1/signnow/documents/${docId}/open-link`, undefined, adminToken);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.mode, 'view');
  assert.strictEqual(r.body.url, `https://app.signnow.com/document/${docId}`);
  assert.strictEqual(embeddedEditorCalls.length, before, 'embedded-editor must NEVER be attempted on an already-sent document — its own precondition forbids it');
});

test('3. the THIS IS THE BUG — sandbox/eval credentials must produce an app-eval.signnow.com link, never a hardcoded app.signnow.com one', { skip }, async () => {
  forceWebAppBase = 'https://app-eval.signnow.com';
  try {
    const docId = `doc-eval-sent-${Date.now()}`;
    liveDocuments.set(docId, { field_invites: [{ email: 'c@example.com', status: 'pending' }], signatures: [] });
    await insertDoc(docId, 'sent', 3);

    const r = await api('GET', `/api/v1/signnow/documents/${docId}/open-link`, undefined, adminToken);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.url, `https://app-eval.signnow.com/document/${docId}`, 'a sandbox/eval account must NEVER get a production app.signnow.com link — that is exactly the production 404 defect');
  } finally {
    forceWebAppBase = 'https://app.signnow.com';
  }
});

test('4. a document with no CRM record at all returns 404 not_found, never a dead link', { skip }, async () => {
  const r = await api('GET', `/api/v1/signnow/documents/totally-unknown-doc-id/open-link`, undefined, adminToken);
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.error, 'not_found');
});

test('5. a document that exists in our DB but SignNow itself cannot find (deleted / wrong account) is reported as a SPECIFIC, honest error — never a URL the user then 404s on', { skip }, async () => {
  const docId = `doc-deleted-${Date.now()}`;
  liveDocuments.set(docId, 'not_found'); // simulates: deleted in SignNow, OR created under different credentials than are now configured
  await insertDoc(docId, 'pending', 5);

  const r = await api('GET', `/api/v1/signnow/documents/${docId}/open-link`, undefined, adminToken);
  assert.strictEqual(r.status, 404, JSON.stringify(r.body));
  assert.strictEqual(r.body.error, 'signnow_document_not_found');
  assert.ok(/deleted|different credentials|invalid/.test(r.body.message), r.body.message);
});

test('6. embedded-editor failing on a technically-pending document falls back to a working view link instead of a hard error', { skip }, async () => {
  const docId = `doc-fallback-${Date.now()}`;
  liveDocuments.set(docId, { field_invites: [], signatures: [], forceEmbeddedEditorFailure: true });
  await insertDoc(docId, 'pending', 6);

  const r = await api('GET', `/api/v1/signnow/documents/${docId}/open-link`, undefined, adminToken);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.mode, 'view');
  assert.strictEqual(r.body.url, `https://app.signnow.com/document/${docId}`);
});

test('7. EXISTING pre-fix PENDING contracts are immediately recoverable — no re-creation needed, same stored document_id now opens', { skip }, async () => {
  // Simulates a document that was created and stored BEFORE this fix
  // shipped: its document_id and DB row are completely ordinary, created
  // the exact same way /prepare has always created them. The only thing
  // that was ever broken was the link construction, not the document.
  const docId = `doc-legacy-pending-${Date.now()}`;
  liveDocuments.set(docId, { field_invites: [], signatures: [] });
  await insertDoc(docId, 'pending', 7);

  const r = await api('GET', `/api/v1/signnow/documents/${docId}/open-link`, undefined, adminToken);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.mode, 'editor');
});

test('8. full workflow: Prepare -> Open (editor) -> Review -> explicit Send -> re-Open (view) now uses the correct environment host throughout', { skip }, async () => {
  const prep = await api('POST', `/api/v1/signnow/by-external/${leadId}/prepare`, { template_id: 'tmpl-workflow', template_name: 'HIC Template', document_name: 'Workflow Doc' }, adminToken);
  assert.strictEqual(prep.status, 201, JSON.stringify(prep.body));
  const docId = prep.body.document.document_id;
  assert.strictEqual(prep.body.document.status, 'pending', 'prepare must never auto-send — unchanged from PR #17/#18');

  // Open for review BEFORE sending — must be the pre-send embedded editor.
  const openBeforeSend = await api('GET', `/api/v1/signnow/documents/${docId}/open-link`, undefined, adminToken);
  assert.strictEqual(openBeforeSend.status, 200, JSON.stringify(openBeforeSend.body));
  assert.strictEqual(openBeforeSend.body.mode, 'editor', 'the document must be genuinely openable for review before it is ever sent');

  // Explicit manual send.
  const send = await api('POST', `/api/v1/signnow/documents/${docId}/send`, undefined, adminToken);
  assert.strictEqual(send.status, 200, JSON.stringify(send.body));

  // SignNow now reports this document as sent (simulate the live state change).
  liveDocuments.set(docId, { field_invites: [{ email: 'customer@example.com', status: 'pending' }], signatures: [] });

  const openAfterSend = await api('GET', `/api/v1/signnow/documents/${docId}/open-link`, undefined, adminToken);
  assert.strictEqual(openAfterSend.status, 200, JSON.stringify(openAfterSend.body));
  assert.strictEqual(openAfterSend.body.mode, 'view', 'once sent, embedded-editor is no longer attempted — its own documented precondition forbids it');
  assert.strictEqual(openAfterSend.body.url, `https://app.signnow.com/document/${docId}`);
});

test('9. SIGNNOW_NOT_CONFIGURED is reported as 501, never a generic 500 or a dead link', { skip }, async () => {
  const docId = `doc-not-configured-${Date.now()}`;
  liveDocuments.set(docId, 'not_configured');
  await insertDoc(docId, 'pending', 9);

  const r = await api('GET', `/api/v1/signnow/documents/${docId}/open-link`, undefined, adminToken);
  assert.strictEqual(r.status, 501, JSON.stringify(r.body));
  assert.strictEqual(r.body.error, 'signnow_not_configured');
});
