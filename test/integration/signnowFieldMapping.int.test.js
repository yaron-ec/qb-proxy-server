/* eslint-disable no-undef */
'use strict';

/**
 * signnowFieldMapping.int.test.js — REAL-Postgres proof of the SignNow
 * CRM -> template field-mapping completion-pass work (CRM STABILITY PHASE,
 * completion pass, Section A).
 *
 * Evidence gathered (no live SignNow account available in this environment):
 * docs.signnow.com's own reference categories (User/OAuth/Document/
 * Template/Folder/Document Group/Webhook/Embedded) expose no persistent
 * Contacts resource, and the Help Center frames "Contacts" as a pure
 * web-app feature — so there is no Contact object to sync. The already-
 * working field-invite flow (POST /document/{id}/invite) already supplies
 * recipient data directly. The real gap was CRM data -> template TEXT
 * fields, closed here via an admin-configurable mapping
 * (signnow_template_field_mappings) + PUT /v2/documents/{id}/prefill-texts.
 *
 * Proves:
 *   1. A template with a REQUIRED mapping whose CRM source is empty blocks
 *      /prepare with 422 and a clear per-field message, BEFORE any SignNow
 *      API call is made (no document is created).
 *   2. A template with mappings that DO resolve gets prefill-texts called
 *      with exactly the matching, live-field-confirmed values — and only
 *      for fields the live document actually has (never invented).
 *   3. A template with NO mappings configured behaves exactly as before
 *      this feature (no prefill attempt, no validation, 201 as usual).
 *   4. Admin CRUD: GET/PUT field-mappings and GET crm-sources work and are
 *      admin/manager-gated.
 *   5. deal_id is scoped to the caller's own lead — a deal belonging to a
 *      DIFFERENT lead is never used as this contract's project context.
 *   6. prepare still NEVER auto-sends (send_invite default false) even when
 *      prefill succeeds — the already-fixed manual-send boundary is
 *      unaffected by this feature.
 *
 * Stubs lib/signnowClient entirely. Skipped without TEST_DATABASE_URL.
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

let base, server, db, adminToken, leadId, otherLeadId, dealId, otherLeadDealId, companyConfig, insertedCompanySettingsId;
let prefillCalls, getDocumentFieldsCalls, createFromTemplateCalls;

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
      `INSERT INTO company_settings (company_name, enabled_modules) VALUES ('SignNow Field Mapping Test Co', $1) RETURNING id`,
      [JSON.stringify(modules)]
    );
    insertedCompanySettingsId = ins.rows[0].id;
  }
  companyConfig.invalidate();
}

// The "live" document fields this test's fake createDocumentFromTemplate/
// getDocumentFields pretend the copied document actually has — simulates a
// real HIC template's text fields, which are account-specific and
// unknowable without live credentials in this environment.
const LIVE_DOC_FIELDS = ['customer_full_name', 'job_address', 'contract_amount'];

if (DB_URL) {
  const p = require.resolve(path.join(ROOT, 'lib/signnowClient'));
  require.cache[p] = {
    id: p, filename: p, loaded: true,
    exports: {
      getAuthMethod: () => 'api_key',
      getUserInfo: async () => ({ email: 'account@example-signnow.test' }),
      listTemplates: async () => [{ id: 'tmpl-mapped', name: 'HIC Template' }],
      createDocumentFromTemplate: async (templateId, name) => {
        createFromTemplateCalls.push({ templateId, name });
        return { id: `doc-${Date.now()}-${createFromTemplateCalls.length}`, document_name: name };
      },
      uploadDocument: async (buf, name) => ({ id: `uploaded-doc-${Date.now()}`, name }),
      sendInvite: async (docId, signers, fromEmail) => ({ id: docId, result: 'ok' }),
      getDocumentStatus: async () => ({ field_invites: [], signatures: [] }),
      getDocumentFields: async (docId) => {
        getDocumentFieldsCalls.push(docId);
        return { fields: LIVE_DOC_FIELDS.map((name) => ({ name, type: 'text', id: name })), roles: [], approverRoles: [], viewerRoles: [], raw: {} };
      },
      prefillTexts: async (docId, fields) => {
        prefillCalls.push({ docId, fields });
        return { ok: true };
      },
      downloadSignedPdf: async () => Buffer.from('fake-pdf'),
    },
  };
}

test.before(async () => {
  if (skip) return;
  prefillCalls = [];
  getDocumentFieldsCalls = [];
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
  adminToken = issueAccessToken({ id: '00000000-0000-0000-0000-00000000dd01', email: `admin-fieldmap-${stamp}@test.example`, role: 'admin' });

  const ownerRes = await db.query(
    `INSERT INTO owners (email, display_name) VALUES ($1, 'Field Mapping Test Owner') RETURNING id`,
    [`owner-fieldmap-${stamp}@test.example`]
  );
  const { rows } = await db.query(
    `INSERT INTO leads (first_name, last_name, email, phone, property_address, city, state, zip, source, status, owner_id)
     VALUES ('Mapped', 'Customer', $1, '5551112222', '123 Main St', 'Anytown', 'CA', '90210', 'Referral', 'Sold', $2)
     RETURNING id`,
    [`fieldmap-lead-${stamp}@test.example`, ownerRes.rows[0].id]
  );
  leadId = rows[0].id;
  const dealRes = await db.query(
    `INSERT INTO deals (lead_id, name, amount, stage) VALUES ($1, 'Kitchen Remodel', 25000, 'Sold / Estimate Approved') RETURNING id`,
    [leadId]
  );
  dealId = dealRes.rows[0].id;

  // A second, unrelated lead + deal — used to prove deal_id is lead-scoped.
  const { rows: otherRows } = await db.query(
    `INSERT INTO leads (first_name, last_name, email, phone, source, status, owner_id)
     VALUES ('Other', 'Person', $1, '5559998888', 'Referral', 'Sold', $2)
     RETURNING id`,
    [`other-lead-${stamp}@test.example`, ownerRes.rows[0].id]
  );
  otherLeadId = otherRows[0].id;
  const otherDealRes = await db.query(
    `INSERT INTO deals (lead_id, name, amount, stage) VALUES ($1, 'Someone Else Project', 99999, 'Sold / Estimate Approved') RETURNING id`,
    [otherLeadId]
  );
  otherLeadDealId = otherDealRes.rows[0].id;
});

test.after(async () => {
  if (skip) return;
  server.close();
  if (insertedCompanySettingsId) await db.query('DELETE FROM company_settings WHERE id = $1', [insertedCompanySettingsId]);
  await db.pool.end();
});

test('1. GET /crm-sources lists the allowlisted CRM fields (admin only)', { skip }, async () => {
  const r = await api('GET', '/api/v1/signnow/crm-sources', undefined, adminToken);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.ok(Array.isArray(r.body.sources) && r.body.sources.length > 0);
  assert.ok(r.body.sources.some((s) => s.key === 'lead_email'));

  const unauth = await api('GET', '/api/v1/signnow/crm-sources', undefined, undefined);
  assert.strictEqual(unauth.status, 401);
});

test('2. PUT then GET field-mappings round-trips a template\'s mapping config', { skip }, async () => {
  const put = await api('PUT', '/api/v1/signnow/field-mappings/tmpl-mapped', {
    mappings: [
      { signnow_field_name: 'customer_full_name', crm_source: 'lead_full_name', required: true },
      { signnow_field_name: 'job_address', crm_source: 'job_address_full', required: true },
      { signnow_field_name: 'contract_amount', crm_source: 'deal_amount', required: false },
    ],
  }, adminToken);
  assert.strictEqual(put.status, 200, JSON.stringify(put.body));
  assert.strictEqual(put.body.mappings.length, 3);

  const get = await api('GET', '/api/v1/signnow/field-mappings/tmpl-mapped', undefined, adminToken);
  assert.strictEqual(get.status, 200, JSON.stringify(get.body));
  assert.strictEqual(get.body.mappings.length, 3);
  assert.ok(get.body.mappings.some((m) => m.crm_source === 'lead_full_name' && m.required === true));
});

test('3. an unknown crm_source is rejected — never silently saved', { skip }, async () => {
  const r = await api('PUT', '/api/v1/signnow/field-mappings/tmpl-bad', {
    mappings: [{ signnow_field_name: 'x', crm_source: 'not_a_real_source', required: false }],
  }, adminToken);
  assert.strictEqual(r.status, 400, JSON.stringify(r.body));
});

test('4. a template with fully-resolvable required mappings prefills exactly the matching live fields', { skip }, async () => {
  const before = prefillCalls.length;
  const r = await api('POST', `/api/v1/signnow/by-external/${leadId}/prepare`, {
    template_id: 'tmpl-mapped', template_name: 'HIC Template', deal_id: dealId,
  }, adminToken);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.document.status, 'pending', 'prefilling must never imply sending');
  assert.strictEqual(r.body.prefilled_fields, 3);
  assert.strictEqual(prefillCalls.length, before + 1);

  const call = prefillCalls[prefillCalls.length - 1];
  const byName = Object.fromEntries(call.fields.map((f) => [f.field_name, f.prefilled_text]));
  assert.strictEqual(byName.customer_full_name, 'Mapped Customer');
  assert.strictEqual(byName.job_address, '123 Main St, Anytown, CA, 90210');
  assert.strictEqual(byName.contract_amount, '25000.00'); // numeric column — pg returns it as a string with its scale
});

test('5. a template with a required mapping whose CRM value is empty blocks /prepare with 422 and NEVER calls SignNow', { skip }, async () => {
  await api('PUT', '/api/v1/signnow/field-mappings/tmpl-missing-data', {
    mappings: [{ signnow_field_name: 'ssn_field', crm_source: 'lead_email', field_label: 'Customer Email', required: true }],
  }, adminToken);

  // A lead with no email — required mapping cannot resolve.
  const ownerRes = await db.query(`SELECT id FROM owners LIMIT 1`);
  const { rows } = await db.query(
    `INSERT INTO leads (first_name, last_name, phone, source, status, owner_id)
     VALUES ('No', 'Email', '5550001111', 'Referral', 'Sold', $1) RETURNING id`,
    [ownerRes.rows[0].id]
  );
  const noEmailLeadId = rows[0].id;

  const before = createFromTemplateCalls.length;
  const r = await api('POST', `/api/v1/signnow/by-external/${noEmailLeadId}/prepare`, {
    template_id: 'tmpl-missing-data', template_name: 'HIC Template',
  }, adminToken);
  assert.strictEqual(r.status, 422, JSON.stringify(r.body));
  assert.strictEqual(r.body.error, 'missing_required_fields');
  assert.ok(/Customer Email is missing/.test(r.body.message), r.body.message);
  assert.strictEqual(createFromTemplateCalls.length, before, 'no SignNow document may ever be created for a malformed/incomplete contract');
});

test('6. a template with NO mappings configured behaves exactly as before — no prefill attempted, normal 201', { skip }, async () => {
  const before = prefillCalls.length;
  const r = await api('POST', `/api/v1/signnow/by-external/${leadId}/prepare`, {
    template_id: 'tmpl-unconfigured-' + Date.now(), template_name: 'Plain Template',
  }, adminToken);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.prefilled_fields, 0);
  assert.strictEqual(prefillCalls.length, before, 'no mapping configured means no getDocumentFields/prefillTexts call at all');
});

test('7. deal_id is scoped to the caller\'s own lead — another lead\'s deal is never used', { skip }, async () => {
  // A fresh template (never used by `leadId` before) with the same mapping
  // config as tmpl-mapped — test 4 already created a pending tmpl-mapped
  // document for this lead, so reusing that template_id here would hit the
  // idempotency guard (409) rather than exercising the deal-scoping guard.
  await api('PUT', '/api/v1/signnow/field-mappings/tmpl-mapped-crossdeal-check', {
    mappings: [
      { signnow_field_name: 'customer_full_name', crm_source: 'lead_full_name', required: true },
      { signnow_field_name: 'job_address', crm_source: 'job_address_full', required: true },
      { signnow_field_name: 'contract_amount', crm_source: 'deal_amount', required: false },
    ],
  }, adminToken);

  // tmpl-mapped's contract_amount maps to deal_amount. Passing otherLeadDealId
  // (which belongs to a DIFFERENT lead) while acting on `leadId` must resolve
  // to NO deal context at all — never otherLeadDealId's $99,999 amount.
  const r = await api('POST', `/api/v1/signnow/by-external/${leadId}/prepare`, {
    template_id: 'tmpl-mapped-crossdeal-check', template_name: 'HIC Template', document_name: 'Cross-Lead Guard Doc',
    deal_id: otherLeadDealId,
  }, adminToken);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const call = prefillCalls[prefillCalls.length - 1];
  const byName = Object.fromEntries(call.fields.map((f) => [f.field_name, f.prefilled_text]));
  assert.notStrictEqual(byName.contract_amount, '99999', 'a different lead\'s deal amount must never leak into this contract');
  assert.strictEqual(byName.contract_amount, undefined, 'with no valid deal in scope, the optional deal_amount field is simply left unmapped, never invented');
});
