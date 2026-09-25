/* eslint-disable no-undef */
/**
 * Website → CRM lead intake (routes/websiteLeads.js + lib/websiteLeadIntake.js).
 * Runs the real Express router against an in-memory fake of the few SQL
 * statements it issues and a fake bookingService — no database, no network.
 */
'use strict';
const { test } = require('node:test');
const assert = require('assert');
const express = require('express');
const { createWebsiteLeadsRouter } = require('../routes/websiteLeads');
const { mapWebsiteLead, externalRefFor, secretMatches, isTestLead } = require('../lib/websiteLeadIntake');

const SECRET = 'test-secret-0123456789abcdef';

class BookingError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}

function fakeWorld({ secret = SECRET, bookingMode = 'create', failBooking = false } = {}) {
  const db = { leads: new Map(), receipts: new Map(), activities: [], seq: 0 };
  const calls = { booking: [], alerts: 0, contacts: 0, deleted: [] };
  const newLead = (fields) => {
    const id = `00000000-0000-4000-8000-${String(++db.seq).padStart(12, '0')}`;
    const row = { id, status: 'New', sms_consent: null, ...fields };
    db.leads.set(id, row);
    return row;
  };
  const existing = newLead({ external_ref: 'legacy-1', first_name: 'Dana', last_name: 'Cole', email: 'dana@x.com', phone: '3105550100' });

  async function query(sql, p = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('INSERT INTO website_lead_receipts')) {
      if (db.receipts.has(p[0])) return { rows: [] };
      db.receipts.set(p[0], { external_ref: p[0], is_test: p[1], lead_id: null, action: null, completed_at: null, received_at: new Date() });
      return { rows: [{ external_ref: p[0] }] };
    }
    if (s.startsWith('SELECT * FROM website_lead_receipts')) return { rows: db.receipts.has(p[0]) ? [db.receipts.get(p[0])] : [] };
    if (s.startsWith('UPDATE website_lead_receipts SET received_at')) {
      const r = db.receipts.get(p[0]);
      if (r && !r.completed_at && r.received_at < new Date(Date.now() - Number(p[1]) * 1000)) { r.received_at = new Date(); return { rows: [{ external_ref: p[0] }] }; }
      return { rows: [] };
    }
    if (s.startsWith('UPDATE website_lead_receipts SET lead_id')) {
      Object.assign(db.receipts.get(p[2]), { lead_id: p[0], action: p[1], completed_at: new Date() });
      return { rows: [] };
    }
    if (s.startsWith('DELETE FROM website_lead_receipts')) {
      const r = db.receipts.get(p[0]);
      if (r && (!s.includes('completed_at IS NULL') || !r.completed_at)) db.receipts.delete(p[0]);
      return { rows: [] };
    }
    if (s.startsWith('INSERT INTO activities')) { db.activities.push({ lead_id: p[0], type: 'note', content: p[1], author: 'Website' }); return { rows: [] }; }
    if (s.startsWith('SELECT type, content, author FROM activities')) return { rows: db.activities.filter((a) => a.lead_id === p[0]) };
    if (s.startsWith('UPDATE leads SET message')) {
      Object.assign(db.leads.get(p[7]), { message: p[0], photo_urls: p[1], is_new_intake_lead: true, crm_created_date: p[2] || 'NOW', sms_consent: p[3], sms_consent_at: p[4], sms_consent_disclosure_version: p[5], sms_consent_source: p[6] });
      return { rows: [] };
    }
    if (s.startsWith('UPDATE leads SET sms_consent = true')) {
      const l = db.leads.get(p[3]);
      if (l.sms_consent !== true) Object.assign(l, { sms_consent: true, sms_consent_at: p[0], sms_consent_disclosure_version: p[1], sms_consent_source: p[2] });
      return { rows: [] };
    }
    if (s.startsWith('SELECT * FROM leads WHERE id')) return { rows: db.leads.has(p[0]) ? [db.leads.get(p[0])] : [] };
    throw new Error(`unexpected SQL: ${s}`);
  }

  async function createBooking(input) {
    calls.booking.push(input);
    if (failBooking) throw new Error('db down');
    const byRef = [...db.leads.values()].find((l) => l.external_ref === input.external_ref);
    if (byRef) return { idempotent: true, lead: byRef, appointment: null };
    if (bookingMode === 'match') return { idempotent: true, lead: existing, appointment: null };
    if (bookingMode === 'duplicate' && !input.force_new_lead) throw new BookingError(409, 'potential_duplicate', 'dup', { candidates: [{ id: existing.id }] });
    const { idempotency_key: _k, owner_email: _o, owner_display_name: _d, actor: _a, force_new_lead: _f, ...fields } = input;
    return { idempotent: false, lead: newLead(fields), appointment: null };
  }

  const pool = {
    connect: async () => ({
      query: async (sql, p = []) => {
        if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
        if (sql.startsWith('DELETE FROM leads')) { db.leads.delete(p[0]); calls.deleted.push(p[0]); return { rows: [] }; }
        return query(sql, p);
      },
      release() {},
    }),
  };

  const router = createWebsiteLeadsRouter({
    query, pool, createBooking, BookingError,
    ownerEmail: () => 'rep@example.org', ownerDisplayName: () => 'Rep',
    sendNewLeadAlert: async () => { calls.alerts++; },
    enqueueContactSync: async () => { calls.contacts++; },
    removeFromReminders: async () => {}, cleanupLeadTextRefs: async () => {}, cancelAppointmentsForLeadDelete: async () => {},
    getSecret: () => secret,
    log: { log() {}, warn() {}, error() {} },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/v1/website-leads', router);
  return { app, db, calls, existing };
}

async function withServer(app, fn) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/website-leads`;
  try { return await fn(base); } finally { server.close(); }
}

const post = (base, body, { secret = SECRET, key } = {}) => fetch(base, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(secret ? { 'x-webhook-secret': secret } : {}), ...(key ? { 'idempotency-key': key } : {}) },
  body: JSON.stringify(body),
});

// The exact shape the website's server/lib/leads.js crmPayload() sends.
const websiteLead = (over = {}) => ({
  id: 'abc123', created_date: new Date(Date.now() - 60e3).toISOString(), updated_date: new Date().toISOString(),
  full_name: 'Maria Lopez Garcia', email: 'Maria@Example.org', phone: '(310) 555-0199', city: 'Encino', zip: '91316',
  project_type: 'Kitchen Remodeling', property_type: 'Single-family', budget_range: '$50k-$100k', timeline: '1-3 months',
  message: 'Full kitchen remodel', source: 'Website', status: 'New Lead',
  consent_sms: true, consent_sms_timestamp: new Date(Date.now() - 60e3).toISOString(), consent_sms_disclosure_version: 'sms-consent-v1-2026-09',
  ...over,
});

test('fails closed without the secret configured; rejects a wrong secret; status leaks nothing', async () => {
  await withServer(fakeWorld({ secret: '' }).app, async (base) => {
    assert.strictEqual((await post(base, websiteLead())).status, 503);
    assert.deepStrictEqual(await (await fetch(base)).json(), { service: 'website-leads', configured: false });
  });
  const w = fakeWorld();
  await withServer(w.app, async (base) => {
    assert.strictEqual((await post(base, websiteLead(), { secret: 'wrong' })).status, 401);
    assert.strictEqual((await post(base, websiteLead(), { secret: null })).status, 401);
    assert.deepStrictEqual(await (await fetch(base)).json(), { service: 'website-leads', configured: true });
  });
  assert.strictEqual(w.calls.booking.length, 0, 'nothing written without a valid secret');
});

test('new website lead: normalized fields, SMS consent, note, internal alert, contacts sync', async () => {
  const w = fakeWorld();
  await withServer(w.app, async (base) => {
    const r = await post(base, websiteLead(), { key: 'ec-website-lead-abc123' });
    assert.strictEqual(r.status, 201);
    const body = await r.json();
    assert.strictEqual(body.action, 'created');
    const lead = w.db.leads.get(body.id);
    assert.strictEqual(lead.external_ref, 'ec-website-lead-abc123');
    assert.strictEqual(lead.first_name, 'Maria');
    assert.strictEqual(lead.last_name, 'Lopez Garcia');
    assert.strictEqual(lead.email, 'maria@example.org');
    assert.strictEqual(lead.phone, '(310) 555-0199');
    assert.strictEqual(lead.source, 'Website');
    assert.strictEqual(lead.start_timeframe, '1-3 months');
    assert.strictEqual(lead.zip, '91316');
    assert.strictEqual(lead.sms_consent, true);
    assert.strictEqual(lead.sms_consent_disclosure_version, 'sms-consent-v1-2026-09');
    assert.strictEqual(lead.sms_consent_source, 'website');
    assert.ok(lead.sms_consent_at);
    assert.strictEqual(lead.message, 'Full kitchen remodel');
    assert.match(lead.notes, /Website lead ID: abc123/);
    assert.match(lead.notes, /Property type: Single-family/);
    assert.strictEqual(w.db.activities.filter((a) => a.lead_id === body.id).length, 1);
    assert.strictEqual(w.calls.alerts, 1);
    assert.strictEqual(w.calls.contacts, 1);
    assert.ok(w.db.receipts.get('ec-website-lead-abc123').completed_at);
  });
});

test('a retried delivery never creates a second lead, note or alert', async () => {
  const w = fakeWorld();
  await withServer(w.app, async (base) => {
    const a = await (await post(base, websiteLead(), { key: 'ec-website-lead-abc123' })).json();
    const r2 = await post(base, websiteLead(), { key: 'ec-website-lead-abc123' });
    assert.strictEqual(r2.status, 200);
    const b = await r2.json();
    assert.strictEqual(b.id, a.id);
    assert.strictEqual(b.duplicate_delivery, true);
  });
  assert.strictEqual(w.calls.booking.length, 1);
  assert.strictEqual(w.calls.alerts, 1);
  assert.strictEqual(w.db.leads.size, 2); // pre-existing + one
});

test('without Idempotency-Key the website lead id (or a content hash) still dedupes', async () => {
  assert.strictEqual(externalRefFor(undefined, { id: 'xyz' }), 'ec-website-lead-xyz');
  assert.strictEqual(externalRefFor('ec-website-lead-q1', { id: 'other' }), 'ec-website-lead-q1');
  const h1 = externalRefFor(undefined, { full_name: 'A B', phone: '1', created_date: 't' });
  assert.strictEqual(h1, externalRefFor('not-a-valid-key', { full_name: 'A B', phone: '1', created_date: 't' }));
  assert.match(h1, /^ec-website-lead-h-[0-9a-f]{32}$/);
});

test('unchecked SMS box stores no consent', async () => {
  const w = fakeWorld();
  await withServer(w.app, async (base) => {
    const b = await (await post(base, websiteLead({ id: 'n1', consent_sms: false }), { key: 'ec-website-lead-n1' })).json();
    const lead = w.db.leads.get(b.id);
    assert.strictEqual(lead.sms_consent, false);
    assert.strictEqual(lead.sms_consent_at, null);
    assert.strictEqual(lead.sms_consent_disclosure_version, null);
  });
  // A truthy non-boolean is not consent either.
  assert.strictEqual(mapWebsiteLead(websiteLead({ consent_sms: 'true' })).lead.sms_consent, false);
});

test('existing customer: no new lead — inquiry note on that lead, consent recorded, no alert', async () => {
  const w = fakeWorld({ bookingMode: 'match' });
  await withServer(w.app, async (base) => {
    const r = await post(base, websiteLead({ id: 'm1' }), { key: 'ec-website-lead-m1' });
    assert.strictEqual(r.status, 200);
    const b = await r.json();
    assert.strictEqual(b.action, 'matched_existing');
    assert.strictEqual(b.id, w.existing.id);
  });
  assert.strictEqual(w.db.leads.size, 1);
  assert.match(w.db.activities[0].content, /Repeat inquiry from the website form/);
  assert.strictEqual(w.existing.sms_consent, true);
  assert.strictEqual(w.calls.alerts, 0);
});

test('same phone/email with a different name: lead is created (never dropped) and flagged', async () => {
  const w = fakeWorld({ bookingMode: 'duplicate' });
  await withServer(w.app, async (base) => {
    const b = await (await post(base, websiteLead({ id: 'd1' }), { key: 'ec-website-lead-d1' })).json();
    assert.strictEqual(b.action, 'created_possible_duplicate');
    assert.notStrictEqual(b.id, w.existing.id);
    assert.ok(w.db.activities.some((a) => a.lead_id === b.id && a.content.includes(w.existing.id)));
  });
  assert.strictEqual(w.calls.booking.length, 2);
  assert.strictEqual(w.calls.booking[1].force_new_lead, true);
});

test('a concurrent duplicate delivery gets 409 (retried later), not a second lead', async () => {
  const w = fakeWorld();
  w.db.receipts.set('ec-website-lead-c1', { external_ref: 'ec-website-lead-c1', is_test: false, completed_at: null, received_at: new Date() });
  await withServer(w.app, async (base) => {
    assert.strictEqual((await post(base, websiteLead({ id: 'c1' }), { key: 'ec-website-lead-c1' })).status, 409);
  });
  assert.strictEqual(w.calls.booking.length, 0);
});

test('a failed write releases the claim so the website retry can succeed', async () => {
  const w = fakeWorld({ failBooking: true });
  await withServer(w.app, async (base) => {
    assert.strictEqual((await post(base, websiteLead({ id: 'f1' }), { key: 'ec-website-lead-f1' })).status, 500);
  });
  assert.strictEqual(w.db.receipts.has('ec-website-lead-f1'), false);
});

test('invalid payloads are rejected; garbage contact data is never stored', async () => {
  const w = fakeWorld();
  await withServer(w.app, async (base) => {
    assert.strictEqual((await post(base, { message: 'no contact' })).status, 400);
    assert.strictEqual((await post(base, [1, 2])).status, 400);
  });
  const m = mapWebsiteLead({ first_name: 'A', email: 'not-an-email', phone: '12', photo_url: 'http://insecure/x.jpg' });
  assert.strictEqual(m.lead.email, null);
  assert.strictEqual(m.lead.phone, null);
  assert.deepStrictEqual(m.lead.photo_urls, []);
  assert.strictEqual(secretMatches('abc', 'abc'), true);
  assert.strictEqual(secretMatches('abd', 'abc'), false);
  assert.strictEqual(secretMatches(undefined, 'abc'), false);
  assert.strictEqual(secretMatches('abc', ''), false);
});

test('controlled test lead: no alert/contacts; cleanup returns what was stored and deletes it; real leads cannot be deleted', async () => {
  const w = fakeWorld();
  const testLead = websiteLead({ id: 't1', full_name: 'E2E-TEST Website', email: 'e2e-test+t1@example.com' });
  assert.strictEqual(isTestLead(mapWebsiteLead(testLead).lead), true);
  assert.strictEqual(isTestLead(mapWebsiteLead(websiteLead()).lead), false);
  await withServer(w.app, async (base) => {
    const b = await (await post(base, testLead, { key: 'ec-website-lead-t1' })).json();
    assert.strictEqual(w.calls.alerts, 0);
    assert.strictEqual(w.calls.contacts, 0);
    const del = (ref, secret = SECRET) => fetch(`${base}/test/${ref}`, { method: 'DELETE', headers: { 'x-webhook-secret': secret } });
    assert.strictEqual((await del('ec-website-lead-t1', 'wrong')).status, 401);
    const r = await del('ec-website-lead-t1');
    assert.strictEqual(r.status, 200);
    const out = await r.json();
    assert.strictEqual(out.lead.id, b.id);
    assert.strictEqual(out.lead.sms_consent, true);
    assert.strictEqual(out.lead.source, 'Website');
    assert.strictEqual(out.activities.length, 1);
    assert.deepStrictEqual(w.calls.deleted, [b.id]);
    assert.strictEqual(w.db.receipts.has('ec-website-lead-t1'), false);

    await post(base, websiteLead({ id: 'real1' }), { key: 'ec-website-lead-real1' });
    assert.strictEqual((await del('ec-website-lead-real1')).status, 403);
    assert.strictEqual((await del('ec-website-lead-missing')).status, 404);
  });
});
