/* eslint-disable no-undef */
'use strict';

/**
 * completionFormWorkflow.test.js — end-to-end route-level coverage for the
 * Completion Form upload workflow (Deal Activity → Upload Completion Form),
 * using safe in-memory fixtures (no real files, no live DB, no live R2).
 *
 * Verifies, per the task's explicit workflow checklist:
 *   - file type allowlist enforced server-side (PDF/JPG/JPEG/PNG only)
 *   - upload creates a lead_attachments row associated with the SAME deal
 *   - the Completion Form event appears in GET /:id/timeline with the
 *     correct upload date/uploader
 *   - re-fetching the timeline (a "refresh") never duplicates the event
 *   - multiple completion documents are each preserved, not overwritten
 *   - the SAME row is visible through routes/leadAttachments.js (the
 *     Documents tab's own data source) — one canonical document, not a
 *     second storage system
 *   - a sales_rep who is not assigned to the deal/lead is denied (403) on
 *     both the timeline and the leadAttachments views — the authorization
 *     fix already added to leadAttachments must not be weakened here.
 *
 * Follows this repo's established route-test pattern (require.cache
 * substitution for rbac + db/client, a real http server) — see
 * test/gmailReadRoutes.test.js and test/recordAccessAuthorization.test.js.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

// ── Mock rbac: a Bearer token maps directly to a user fixture ──────────────
const USERS = {
  'admin-token': { sub: 'u-admin', email: 'yaron@ecconstructiongroup.com', role: 'admin' },
  'owning-rep-token': { sub: 'u-rep1', email: 'rep1@ecconstructiongroup.com', role: 'sales_rep' },
  'other-rep-token': { sub: 'u-rep2', email: 'rep2@ecconstructiongroup.com', role: 'sales_rep' },
};
const rbacPath = require.resolve('../lib/rbac');
delete require.cache[rbacPath];
require.cache[rbacPath] = {
  id: rbacPath, filename: rbacPath, loaded: true, exports: {
    requireAuth: (req, res, next) => {
      const auth = req.headers.authorization || '';
      const token = auth.replace(/^Bearer\s+/, '');
      const user = USERS[token];
      if (!user) return res.status(401).json({ error: 'unauthorized' });
      req.user = user;
      next();
    },
  },
};

// ── Mock db/client: in-memory tables covering every query both routes run ──
let deals, leadAttachments, signnowDocuments, activities, nextId;

function reset() {
  nextId = 1;
  deals = [
    { id: '00000000-0000-0000-0000-000000000d01', lead_id: '00000000-0000-0000-0000-00000000ea01', assigned_rep: 'rep1@ecconstructiongroup.com', created_by: null, stage: 'Sold / Estimate Approved', sold_date: '2026-08-23', created_at: '2026-08-23T00:00:00.000Z', amount: '50000', work_start_date: null, deposit_paid: '0', deposit_paid_date: null, progress_payment_paid: '0', progress_payment_paid_date: null, final_payment_paid: '0', final_payment_paid_date: null, completed_at: null, completed_by: null, close_date: null },
  ];
  leadAttachments = [];
  signnowDocuments = [];
  activities = [];
}
reset();

async function mockQuery(sql, params = []) {
  const s = String(sql);

  if (/SELECT id, assigned_rep, created_by, lead_id FROM deals WHERE id/i.test(s)) {
    const d = deals.find(x => x.id === params[0]);
    return { rows: d ? [d] : [] };
  }
  if (/SELECT \* FROM deals WHERE id/i.test(s)) {
    const d = deals.find(x => x.id === params[0]);
    return { rows: d ? [d] : [] };
  }
  if (/SELECT \* FROM signnow_documents WHERE lead_id/i.test(s)) {
    return { rows: signnowDocuments.filter(d => d.lead_id === params[0]) };
  }
  if (/FROM owners WHERE/i.test(s)) {
    // recordAccess.js#resolveOwnerScope: a sales_rep's canonical owner-id
    // lookup. Every sales_rep fixture here is a matching, active owner.
    const email = String(params[0] || '').toLowerCase();
    return { rows: [{ id: `owner-${email}` }] };
  }
  if (/SELECT owner_id FROM leads WHERE/i.test(s)) {
    // recordAccess.js#getLeadOwnerId — leads owner_id keyed to the deal's
    // own assigned_rep so checkLeadScope agrees with checkDealScope for the
    // same fixture (the owning rep owns the lead too).
    const d = deals.find(x => x.lead_id === params[0]);
    return { rows: d ? [{ owner_id: `owner-${String(d.assigned_rep || '').toLowerCase()}` }] : [] };
  }
  if (/SELECT \* FROM lead_attachments WHERE lead_id = \$1 AND deal_id = \$2 AND attachment_kind = 'completion_form'/i.test(s)) {
    return { rows: leadAttachments.filter(a => a.lead_id === params[0] && a.deal_id === params[1] && a.attachment_kind === 'completion_form') };
  }
  if (/SELECT \* FROM activities WHERE lead_id/i.test(s)) {
    return { rows: activities.filter(a => a.lead_id === params[0]) };
  }
  if (/INSERT INTO lead_attachments/i.test(s)) {
    // routes/dealTimeline.js: (lead_id, deal_id, attachment_kind, file_name, file_url, file_type, file_size, storage_key, uploaded_by, uploaded_at)
    const row = {
      id: `att-${nextId++}`,
      lead_id: params[0], deal_id: params[1], attachment_kind: 'completion_form',
      file_name: params[2], file_url: params[3], file_type: params[4], file_size: params[5], storage_key: params[6],
      uploaded_by: params[7], uploaded_at: new Date().toISOString(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      external_ref: null, qb_invoice_id: null, qb_invoice_number: null, invoice_amount: 0, invoice_date: null, due_date: null, balance_due: 0,
    };
    leadAttachments.push(row);
    return { rows: [row] };
  }
  // routes/leadAttachments.js list query — dynamic WHERE clause (lead_id, optional deal_id).
  if (/SELECT \* FROM lead_attachments WHERE/i.test(s) && /ORDER BY created_at DESC LIMIT/i.test(s)) {
    let rows = leadAttachments.filter(a => a.lead_id === params[0]);
    if (/deal_id = \$2/i.test(s)) rows = rows.filter(a => a.deal_id === params[1]);
    return { rows };
  }
  throw new Error('mockQuery: unrecognized query: ' + s);
}

const dbPath = require.resolve('../db/client');
delete require.cache[dbPath];
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query: mockQuery, pool: {} } };

// Force fresh requires of everything downstream of the mocks.
for (const mod of ['../lib/recordAccess', '../lib/dealModel', '../lib/dealTimeline', '../routes/dealTimeline', '../routes/leadAttachments']) {
  const p = require.resolve(mod);
  delete require.cache[p];
}
const dealTimelineRouter = require('../routes/dealTimeline');
const leadAttachmentsRouter = require('../routes/leadAttachments');

function startServer() {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/deals', dealTimelineRouter);
    app.use('/api/v1/lead-attachments', leadAttachmentsRouter);
    const server = app.listen(0, () => resolve(server));
  });
}

function request(server, method, pathStr, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { port, path: pathStr, method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (res) => {
        let raw = ''; res.on('data', c => raw += c); res.on('end', () => {
          let parsed; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('unsupported file type is rejected with 400, never reaches storage', async () => {
  reset();
  const s = await startServer();
  try {
    const r = await request(s, 'POST', '/api/v1/deals/00000000-0000-0000-0000-000000000d01/completion-form', {
      token: 'owning-rep-token',
      body: { file_url: 'https://r2/x.exe', file_name: 'x.exe', file_type: 'application/x-msdownload', file_size: 100 },
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(leadAttachments.length, 0);
  } finally { s.close(); }
});

test('PDF and PNG completion forms are both accepted', async () => {
  reset();
  const s = await startServer();
  try {
    const pdf = await request(s, 'POST', '/api/v1/deals/00000000-0000-0000-0000-000000000d01/completion-form', {
      token: 'owning-rep-token',
      body: { file_url: 'https://r2/completion.pdf', file_name: 'completion.pdf', file_type: 'application/pdf', file_size: 1024 },
    });
    assert.strictEqual(pdf.status, 201);
    const png = await request(s, 'POST', '/api/v1/deals/00000000-0000-0000-0000-000000000d01/completion-form', {
      token: 'owning-rep-token',
      body: { file_url: 'https://r2/completion.png', file_name: 'completion.png', file_type: 'image/png', file_size: 2048 },
    });
    assert.strictEqual(png.status, 201);
    assert.strictEqual(leadAttachments.length, 2);
  } finally { s.close(); }
});

test('a completion form upload is associated with the SAME deal and lead, and appears as a Completion Form Uploaded event with correct uploader', async () => {
  reset();
  const s = await startServer();
  try {
    const upload = await request(s, 'POST', '/api/v1/deals/00000000-0000-0000-0000-000000000d01/completion-form', {
      token: 'owning-rep-token',
      body: { file_url: 'https://r2/completion.pdf', file_name: 'completion.pdf', file_type: 'application/pdf', file_size: 1024 },
    });
    assert.strictEqual(upload.status, 201);
    assert.strictEqual(upload.body.attachment.deal_id, '00000000-0000-0000-0000-000000000d01');
    assert.strictEqual(upload.body.attachment.lead_id, '00000000-0000-0000-0000-00000000ea01');
    assert.strictEqual(upload.body.attachment.uploaded_by, 'rep1@ecconstructiongroup.com');

    const timeline = await request(s, 'GET', '/api/v1/deals/00000000-0000-0000-0000-000000000d01/timeline', { token: 'owning-rep-token' });
    assert.strictEqual(timeline.status, 200);
    const docEvent = timeline.body.events.find(e => e.category === 'document');
    assert.ok(docEvent, 'expected a Completion Form Uploaded event');
    assert.strictEqual(docEvent.by, 'rep1@ecconstructiongroup.com');
    assert.strictEqual(docEvent.document.fileName, 'completion.pdf');
  } finally { s.close(); }
});

test('refreshing the timeline (repeated GET) never duplicates the completion-form event', async () => {
  reset();
  const s = await startServer();
  try {
    await request(s, 'POST', '/api/v1/deals/00000000-0000-0000-0000-000000000d01/completion-form', {
      token: 'owning-rep-token',
      body: { file_url: 'https://r2/completion.pdf', file_name: 'completion.pdf', file_type: 'application/pdf', file_size: 1024 },
    });
    const first = await request(s, 'GET', '/api/v1/deals/00000000-0000-0000-0000-000000000d01/timeline', { token: 'owning-rep-token' });
    const second = await request(s, 'GET', '/api/v1/deals/00000000-0000-0000-0000-000000000d01/timeline', { token: 'owning-rep-token' });
    assert.deepStrictEqual(first.body, second.body);
    assert.strictEqual(first.body.events.filter(e => e.category === 'document').length, 1);
  } finally { s.close(); }
});

test('multiple completion documents (e.g. a closeout form AND a separate inspection sign-off) are each preserved as distinct events', async () => {
  reset();
  const s = await startServer();
  try {
    await request(s, 'POST', '/api/v1/deals/00000000-0000-0000-0000-000000000d01/completion-form', {
      token: 'owning-rep-token',
      body: { file_url: 'https://r2/closeout.pdf', file_name: 'closeout.pdf', file_type: 'application/pdf', file_size: 1024 },
    });
    await request(s, 'POST', '/api/v1/deals/00000000-0000-0000-0000-000000000d01/completion-form', {
      token: 'owning-rep-token',
      body: { file_url: 'https://r2/inspection.jpg', file_name: 'inspection.jpg', file_type: 'image/jpeg', file_size: 2048 },
    });
    const timeline = await request(s, 'GET', '/api/v1/deals/00000000-0000-0000-0000-000000000d01/timeline', { token: 'owning-rep-token' });
    const docEvents = timeline.body.events.filter(e => e.category === 'document');
    assert.strictEqual(docEvents.length, 2);
    const names = docEvents.map(e => e.document.fileName).sort();
    assert.deepStrictEqual(names, ['closeout.pdf', 'inspection.jpg']);
  } finally { s.close(); }
});

test('the SAME uploaded completion form is visible through routes/leadAttachments.js — one canonical document, no duplicate storage', async () => {
  reset();
  const s = await startServer();
  try {
    const upload = await request(s, 'POST', '/api/v1/deals/00000000-0000-0000-0000-000000000d01/completion-form', {
      token: 'owning-rep-token',
      body: { file_url: 'https://r2/completion.pdf', file_name: 'completion.pdf', file_type: 'application/pdf', file_size: 1024 },
    });
    const attachmentId = upload.body.attachment.id;

    // Documents tab's own data source: lead-scoped list, no deal_id filter.
    const docsView = await request(s, 'GET', '/api/v1/lead-attachments?lead_id=00000000-0000-0000-0000-00000000ea01', { token: 'owning-rep-token' });
    assert.strictEqual(docsView.status, 200);
    const found = docsView.body.items.find(a => a.id === attachmentId);
    assert.ok(found, 'the completion form must appear in the lead-level Documents view too');
    assert.strictEqual(found.file_url, 'https://r2/completion.pdf');
  } finally { s.close(); }
});

test('a sales_rep NOT assigned to this deal is denied (403) on both the timeline and the lead-attachments list', async () => {
  reset();
  const s = await startServer();
  try {
    await request(s, 'POST', '/api/v1/deals/00000000-0000-0000-0000-000000000d01/completion-form', {
      token: 'owning-rep-token',
      body: { file_url: 'https://r2/completion.pdf', file_name: 'completion.pdf', file_type: 'application/pdf', file_size: 1024 },
    });

    const timelineDenied = await request(s, 'GET', '/api/v1/deals/00000000-0000-0000-0000-000000000d01/timeline', { token: 'other-rep-token' });
    assert.strictEqual(timelineDenied.status, 403);

    const uploadDenied = await request(s, 'POST', '/api/v1/deals/00000000-0000-0000-0000-000000000d01/completion-form', {
      token: 'other-rep-token',
      body: { file_url: 'https://r2/sneaky.pdf', file_name: 'sneaky.pdf', file_type: 'application/pdf', file_size: 1024 },
    });
    assert.strictEqual(uploadDenied.status, 403);

    // routes/leadAttachments.js's P0 data-isolation convention: an
    // unauthorized list returns an EMPTY result, not a 403 — verify it does
    // NOT leak the other rep's attachment rather than requiring a specific
    // status code.
    const listDenied = await request(s, 'GET', '/api/v1/lead-attachments?lead_id=00000000-0000-0000-0000-00000000ea01', { token: 'other-rep-token' });
    assert.strictEqual((listDenied.body.items || []).length, 0);
  } finally { s.close(); }
});

test('admin can view and upload regardless of assigned_rep', async () => {
  reset();
  const s = await startServer();
  try {
    const upload = await request(s, 'POST', '/api/v1/deals/00000000-0000-0000-0000-000000000d01/completion-form', {
      token: 'admin-token',
      body: { file_url: 'https://r2/completion.pdf', file_name: 'completion.pdf', file_type: 'application/pdf', file_size: 1024 },
    });
    assert.strictEqual(upload.status, 201);
    const timeline = await request(s, 'GET', '/api/v1/deals/00000000-0000-0000-0000-000000000d01/timeline', { token: 'admin-token' });
    assert.strictEqual(timeline.status, 200);
  } finally { s.close(); }
});
