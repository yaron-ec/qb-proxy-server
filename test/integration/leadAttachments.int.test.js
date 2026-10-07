/* eslint-disable no-undef */
'use strict';

/**
 * leadAttachments.int.test.js — REAL-Postgres regression proof for a
 * production defect: every real attachment upload through
 * crm-frontend/src/components/AttachmentsPanel.jsx (the ONLY frontend path
 * that creates a lead_attachments row — see routes/leadAttachments.js's own
 * header) failed with Postgres error "column 'uploaded_by' specified more
 * than once", reported live for three JPEGs (IMG_2122/2123/2124.jpeg) but
 * in fact affecting 100% of uploads, since the frontend unconditionally
 * sends `uploaded_by: 'user'` in every create() call.
 *
 * ROOT CAUSE: routes/leadAttachments.js's POST handler hardcoded
 * `cols = ['uploaded_by', 'uploaded_at']` (uploaded_by is always
 * server-derived from req.user.email, never client-supplied) AND included
 * 'uploaded_by' in the generic FIELDS array it loops over to append any
 * other body key the client sent — so whenever the request body included
 * uploaded_by (always, from this app's own frontend), the INSERT's column
 * list got 'uploaded_by' twice. FIX: removed 'uploaded_by' from FIELDS —
 * it is now exclusively server-authoritative, which also closes a latent
 * spoofing hole (a client could previously overwrite who uploaded a file
 * via PUT).
 *
 * No existing test file covered this route AT ALL before this one.
 *
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

let base, server, db, adminToken, repToken, leadId, repOwnerId, deletedKeys, adminEmail, repEmail;

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

// Mirrors exactly what crm-frontend/src/components/AttachmentsPanel.jsx's
// handleFileChange() sends after a (stubbed, in this test) successful
// upload to R2/S3 via /api/files/upload — this route itself never touches
// storage directly, so no real R2/S3 call is needed to test it.
function frontendUploadBody(overrides = {}) {
  return {
    lead_id: leadId,
    file_name: 'IMG_2122.jpeg',
    file_url: 'https://cdn.example.com/uploads/2026/10/123-IMG_2122.jpeg',
    file_type: 'image/jpeg',
    file_size: 2048576,
    storage_key: 'uploads/2026/10/123-IMG_2122.jpeg',
    uploaded_by: 'user', // the exact field the real frontend always sends
    uploaded_at: new Date().toISOString(),
    ...overrides,
  };
}

if (DB_URL) {
  const p = require.resolve(path.join(ROOT, 'lib/r2Client'));
  require.cache[p] = {
    id: p, filename: p, loaded: true,
    exports: {
      isConfigured: () => true,
      deleteObject: async (key) => { deletedKeys.push(key); return { success: true }; },
      uploadBuffer: async () => { throw new Error('not used by this test'); },
      getSignedDownloadUrl: async () => 'https://signed.example.com/fake',
    },
  };
}

test.before(async () => {
  if (skip) return;
  deletedKeys = [];
  delete require.cache[require.resolve(path.join(ROOT, 'db/client'))];
  db = require(path.join(ROOT, 'db/client'));

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/leads', require(path.join(ROOT, 'routes/leads')));
  app.use('/api/v1/lead-attachments', require(path.join(ROOT, 'routes/leadAttachments')));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;

  const { issueAccessToken } = require(path.join(ROOT, 'lib/authService'));
  // Unique per-run suffix — this file shares qbproxy_test with every other
  // *.int.test.js file, and a plain '@test.example' email can already exist
  // from an unrelated fixture (owners.email is UNIQUE).
  const stamp = Date.now();
  adminEmail = `admin-attach-${stamp}@test.example`;
  repEmail = `rep-attach-${stamp}@test.example`;
  adminToken = issueAccessToken({ id: '00000000-0000-0000-0000-00000000aa01', email: adminEmail, role: 'admin' });

  const ownerRes = await db.query(`INSERT INTO owners (email, display_name) VALUES ($1, 'Test Rep') RETURNING id`, [repEmail]);
  repOwnerId = ownerRes.rows[0].id;
  repToken = issueAccessToken({ id: '00000000-0000-0000-0000-00000000aa02', email: repEmail, role: 'sales_rep' });

  const { rows } = await db.query(
    `INSERT INTO leads (first_name, last_name, email, phone, source, status, owner_id)
     VALUES ('Attach', 'TestLead', $1, '5551234567', 'Referral', 'New', $2)
     RETURNING id`,
    [`attach-lead-${stamp}@test.example`, repOwnerId]
  );
  leadId = rows[0].id;
});

test.after(async () => {
  if (skip) return;
  server.close();
  await db.pool.end();
});

test('1. one JPEG upload (the exact production shape) succeeds — regression for "uploaded_by specified more than once"', { skip }, async () => {
  const r = await api('POST', '/api/v1/lead-attachments', frontendUploadBody(), adminToken);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.attachment.file_name, 'IMG_2122.jpeg');
  assert.strictEqual(r.body.attachment.uploaded_by, adminEmail, 'uploaded_by must be the AUTHENTICATED user, server-derived — never the client-supplied literal "user"');
});

test('2. THREE JPEGs uploaded in sequence (the exact reported production failure — IMG_2122/2123/2124) all succeed', { skip }, async () => {
  const names = ['IMG_2122.jpeg', 'IMG_2123.jpeg', 'IMG_2124.jpeg'];
  const created = [];
  for (const name of names) {
    const r = await api('POST', '/api/v1/lead-attachments', frontendUploadBody({
      file_name: name,
      file_url: `https://cdn.example.com/uploads/2026/10/${name}`,
      storage_key: `uploads/2026/10/${name}`,
    }), adminToken);
    assert.strictEqual(r.status, 201, `${name}: ${JSON.stringify(r.body)}`);
    created.push(r.body.attachment);
  }
  assert.strictEqual(created.length, 3);
  assert.deepStrictEqual(created.map((a) => a.file_name).sort(), names.sort());
});

test('3. a PDF document upload succeeds (not just images)', { skip }, async () => {
  const r = await api('POST', '/api/v1/lead-attachments', frontendUploadBody({
    file_name: 'estimate.pdf', file_type: 'application/pdf',
    file_url: 'https://cdn.example.com/uploads/2026/10/estimate.pdf',
    storage_key: 'uploads/2026/10/estimate.pdf',
  }), adminToken);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.attachment.file_type, 'application/pdf');
});

test('4. correct lead association + reload/list reflects every uploaded file', { skip }, async () => {
  const r = await api('GET', `/api/v1/lead-attachments?lead_id=${leadId}`, undefined, adminToken);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.items.length >= 5, `expected at least 5 attachments (3 JPEGs + 1 repeat + 1 PDF), got ${r.body.items.length}`);
  assert.ok(r.body.items.every((a) => a.lead_id === leadId));
});

test('5. a client cannot spoof uploaded_by via POST OR PUT — it always reflects the real authenticated uploader', { skip }, async () => {
  const create = await api('POST', '/api/v1/lead-attachments', frontendUploadBody({
    file_name: 'spoof-test.jpeg', uploaded_by: 'someone-else@attacker.example',
    file_url: 'https://cdn.example.com/uploads/2026/10/spoof-test.jpeg',
    storage_key: 'uploads/2026/10/spoof-test.jpeg',
  }), adminToken);
  assert.strictEqual(create.status, 201, JSON.stringify(create.body));
  assert.strictEqual(create.body.attachment.uploaded_by, adminEmail);

  const update = await api('PUT', `/api/v1/lead-attachments/${create.body.attachment.id}`, { uploaded_by: 'someone-else@attacker.example', file_name: 'renamed.jpeg' }, adminToken);
  assert.strictEqual(update.status, 200, JSON.stringify(update.body));
  assert.strictEqual(update.body.attachment.uploaded_by, adminEmail, 'PUT must never let a client overwrite uploaded_by');
  assert.strictEqual(update.body.attachment.file_name, 'renamed.jpeg', 'PUT must still update legitimate fields');
});

test('6. permissions: a sales_rep CAN upload/view their own lead\'s attachments', { skip }, async () => {
  const r = await api('POST', '/api/v1/lead-attachments', frontendUploadBody({
    file_name: 'rep-upload.jpeg',
    file_url: 'https://cdn.example.com/uploads/2026/10/rep-upload.jpeg',
    storage_key: 'uploads/2026/10/rep-upload.jpeg',
  }), repToken);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.attachment.uploaded_by, repEmail);

  const list = await api('GET', `/api/v1/lead-attachments?lead_id=${leadId}`, undefined, repToken);
  assert.strictEqual(list.status, 200);
  assert.ok(list.body.items.length > 0);
});

test('7. permissions: a sales_rep CANNOT upload to a lead owned by a different rep', { skip }, async () => {
  const stamp = Date.now();
  const { rows } = await db.query(
    `INSERT INTO owners (email, display_name) VALUES ($1, 'Other Rep') RETURNING id`,
    [`other-rep-${stamp}@test.example`]
  );
  const otherOwnerId = rows[0].id;
  const other = await db.query(
    `INSERT INTO leads (first_name, last_name, email, phone, source, status, owner_id)
     VALUES ('Other', 'Lead', $1, '5559876543', 'Referral', 'New', $2) RETURNING id`,
    [`other-lead-${stamp}@test.example`, otherOwnerId]
  );
  const r = await api('POST', '/api/v1/lead-attachments', frontendUploadBody({ lead_id: other.rows[0].id }), repToken);
  assert.strictEqual(r.status, 403, JSON.stringify(r.body));
});

test('8. missing file_url is rejected with 400, no DB row created (partial-failure safety)', { skip }, async () => {
  const before = await db.query('SELECT count(*)::int n FROM lead_attachments WHERE lead_id = $1', [leadId]);
  const r = await api('POST', '/api/v1/lead-attachments', { lead_id: leadId, file_name: 'broken.jpeg' }, adminToken);
  assert.strictEqual(r.status, 400, JSON.stringify(r.body));
  const after = await db.query('SELECT count(*)::int n FROM lead_attachments WHERE lead_id = $1', [leadId]);
  assert.strictEqual(after.rows[0].n, before.rows[0].n, 'a rejected upload must never create a partial/orphan row');
});

test('9. delete: removes the DB row and calls R2 deleteObject with the stored key (best-effort, never blocks the DB delete)', { skip }, async () => {
  const create = await api('POST', '/api/v1/lead-attachments', frontendUploadBody({
    file_name: 'to-delete.jpeg',
    file_url: 'https://cdn.example.com/uploads/2026/10/to-delete.jpeg',
    storage_key: 'uploads/2026/10/to-delete.jpeg',
  }), adminToken);
  assert.strictEqual(create.status, 201);
  const id = create.body.attachment.id;

  const del = await api('DELETE', `/api/v1/lead-attachments/${id}`, undefined, adminToken);
  assert.strictEqual(del.status, 200, JSON.stringify(del.body));
  assert.ok(deletedKeys.includes('uploads/2026/10/to-delete.jpeg'), 'R2 deleteObject must be called with the attachment\'s own storage_key');

  const check = await db.query('SELECT 1 FROM lead_attachments WHERE id = $1', [id]);
  assert.strictEqual(check.rows.length, 0);

  const getAfterDelete = await api('GET', `/api/v1/lead-attachments/${id}`, undefined, adminToken);
  assert.strictEqual(getAfterDelete.status, 404);
});

test('10. metadata round-trips exactly: file_size, file_type, storage_key, qb_invoice_* financial fields', { skip }, async () => {
  const r = await api('POST', '/api/v1/lead-attachments', frontendUploadBody({
    file_name: 'invoice-123.pdf', file_type: 'invoice', file_size: 999,
    storage_key: 'uploads/2026/10/invoice-123.pdf',
    file_url: 'https://cdn.example.com/uploads/2026/10/invoice-123.pdf',
    qb_invoice_id: 'QB-1', qb_invoice_number: '1001', invoice_amount: 500.5, balance_due: 125.25,
  }), adminToken);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const a = r.body.attachment;
  assert.strictEqual(a.file_size, 999);
  assert.strictEqual(a.storage_key, 'uploads/2026/10/invoice-123.pdf');
  assert.strictEqual(a.qb_invoice_number, '1001');
  assert.strictEqual(a.invoice_amount, 500.5);
  assert.strictEqual(a.balance_due, 125.25);
});
