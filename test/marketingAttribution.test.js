/* eslint-disable no-undef */
'use strict';
/**
 * Pure-logic coverage for Growth Engine Phase 1: channel classification,
 * website attribution mapping (v1 + v2 payloads), canonical lead statuses,
 * versioned qualification, the source-mapping data file, and the receiver's
 * ordering guarantee (attribution recorded before any side effect).
 * Real-Postgres behavior: test/integration/marketingAttribution.int.test.js.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const { classifyTouch, CLASSIFIER_VERSION } = require('../lib/marketing/channelClassifier');
const { mapWebsiteAttribution, normalizeTouch } = require('../lib/marketing/websiteAttribution');
const { canonicalLeadStatus, CANONICAL_LEAD_STATUSES, LEAD_STATUS } = require('../lib/leadStatus');
const { evaluateQualification } = require('../lib/marketing/qualification');
const { loadFile } = require('../scripts/marketing/applySourceMappings');
const { mapWebsiteLead } = require('../lib/websiteLeadIntake');

const ROOT = path.resolve(__dirname, '..');
const NOW = Date.parse('2026-10-01T12:00:00Z');
const at = (d) => new Date(NOW - d * 86400e3).toISOString();

// ── Channel classification ────────────────────────────────────────────────
const C = (t) => classifyTouch(t).channel_code;
test('classifier: Google Ads from gclid / gbraid / wbraid / gad_source / google+cpc', () => {
  assert.strictEqual(C({ gclid: 'x' }), 'google_ads');
  assert.strictEqual(C({ gbraid: 'x' }), 'google_ads');
  assert.strictEqual(C({ wbraid: 'x' }), 'google_ads');
  assert.strictEqual(C({ gad_source: '1' }), 'google_ads');
  assert.strictEqual(C({ utm_source: 'google', utm_medium: 'cpc' }), 'google_ads');
  const c = classifyTouch({ gclid: 'x' });
  assert.deepStrictEqual([c.source, c.medium, c.classifier_version], ['google', 'cpc', CLASSIFIER_VERSION]);
});
test('classifier: Google referrer without tagging is "organic or Business Profile" — never guessed as either', () => {
  assert.strictEqual(C({ referrer: 'https://www.google.com/' }), 'google_organic_or_gbp');
  assert.strictEqual(C({ referrer: 'https://www.google.co.uk/' }), 'google_organic_or_gbp');
  assert.strictEqual(C({ utm_source: 'google', utm_medium: 'organic' }), 'google_organic_or_gbp');
});
test('classifier: Business Profile and Local Services Ads only when explicitly tagged', () => {
  assert.strictEqual(C({ utm_source: 'gbp', utm_medium: 'organic', referrer: 'https://www.google.com/' }), 'google_business_profile');
  assert.strictEqual(C({ utm_source: 'google', utm_medium: 'gmb' }), 'google_business_profile');
  assert.strictEqual(C({ utm_source: 'lsa' }), 'local_services_ads');
});
test('classifier: other engines → Organic Search; Microsoft; Meta; referral; direct; offline; partner; other', () => {
  assert.strictEqual(C({ referrer: 'https://www.bing.com/search' }), 'organic_search');
  assert.strictEqual(C({ referrer: 'https://duckduckgo.com/' }), 'organic_search');
  assert.strictEqual(C({ msclkid: 'x' }), 'microsoft_ads');
  assert.strictEqual(C({ utm_source: 'bing', utm_medium: 'cpc' }), 'microsoft_ads');
  assert.strictEqual(C({ fbclid: 'x' }), 'meta');
  assert.strictEqual(C({ referrer: 'https://l.facebook.com/' }), 'meta');
  assert.strictEqual(C({ utm_source: 'instagram', utm_medium: 'paid_social' }), 'meta');
  assert.strictEqual(C({ referrer: 'https://www.houzz.com/pro/x' }), 'referral');
  assert.strictEqual(C({ landing_page: '/' }), 'direct');
  assert.strictEqual(C({}), 'direct');
  assert.strictEqual(C({ utm_medium: 'print', utm_campaign: 'mailer' }), 'offline');
  assert.strictEqual(C({ utm_source: 'acme', utm_medium: 'partner' }), 'partner');
  assert.strictEqual(C({ utm_source: 'newsletter', utm_medium: 'email' }), 'other');
  assert.strictEqual(C({ utm_source: 'tiktok', utm_medium: 'cpc' }), 'other', 'unknown paid source is not guessed');
});
test('classifier: every code it can return exists in the migration taxonomy', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'db/migrations/2026-48-marketing-attribution.sql'), 'utf8');
  const src = fs.readFileSync(path.join(ROOT, 'lib/marketing/channelClassifier.js'), 'utf8');
  const codes = new Set([...src.matchAll(/out\('([a-z_]+)'/g)].map((m) => m[1]));
  assert.ok(codes.size >= 10);
  for (const c of codes) assert.ok(sql.includes(`('${c}',`), `channel ${c} seeded`);
});

// ── Website attribution mapping ───────────────────────────────────────────
const ads = { landing_page: '/services/kitchen-remodeling', utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'k', gclid: 'G1', captured_at: at(10) };
const direct = { landing_page: '/', captured_at: at(0) };
test('mapping v2: paid first + last, Direct conversion (return visit in a new session)', () => {
  const m = mapWebsiteAttribution({ attribution: { v: 2, first_touch: ads, last_touch: ads, conversion_touch: direct } }, { now: NOW });
  assert.strictEqual(m.touches.first.channel_code, 'google_ads');
  assert.strictEqual(m.touches.last.gclid, 'G1');
  assert.strictEqual(m.touches.first.content_hash, m.touches.last.content_hash, 'same touch → same identity');
  assert.strictEqual(m.touches.conversion.channel_code, 'direct');
  assert.strictEqual(m.inquiry.payload_version, 2);
});
test('mapping v2: a Direct "last touch" is never kept as last meaningful touch', () => {
  const m = mapWebsiteAttribution({ attribution: { v: 2, first_touch: direct, last_touch: direct, conversion_touch: direct } }, { now: NOW });
  assert.strictEqual(m.touches.last, null);
  assert.strictEqual(m.touches.conversion.channel_code, 'direct');
});
test('mapping v1 (older website build): session landing becomes conversion; meaningful first touch becomes last', () => {
  const m = mapWebsiteAttribution({ attribution: { first_touch: ads, last_touch: direct } }, { now: NOW });
  assert.strictEqual(m.touches.conversion.channel_code, 'direct');
  assert.strictEqual(m.touches.last.gclid, 'G1');
  assert.strictEqual(m.inquiry.payload_version, 1);
});
test('mapping: no attribution → all null, inquiry still described', () => {
  const m = mapWebsiteAttribution({ id: 'w1', consent_sms: true }, { now: NOW });
  assert.deepStrictEqual(m.touches, { first: null, last: null, conversion: null });
  assert.strictEqual(m.inquiry.website_lead_id, 'w1');
  assert.strictEqual(m.inquiry.consent_sms, true);
  assert.strictEqual(m.inquiry.payload_version, 0);
});
test('mapping: values are re-validated, never repaired; query strings never stored', () => {
  const t = normalizeTouch({
    landing_page: 'https://evil.example/?email=a@b.c', referrer: 'https://www.google.com/search?q=private',
    gclid: 'has spaces', wbraid: 'ok_1', gad_campaignid: '12;DROP', utm_source: 'x'.repeat(500),
    unknown_param: 'dropped', captured_at: '2999-01-01T00:00:00Z',
  }, { nowMs: NOW, fallbackAt: new Date(NOW).toISOString() });
  assert.strictEqual(t.landing_page, undefined);
  assert.strictEqual(t.referrer, 'https://www.google.com/search');
  assert.strictEqual(t.gclid, undefined);
  assert.strictEqual(t.wbraid, 'ok_1');
  assert.strictEqual(t.gad_campaignid, undefined);
  assert.strictEqual(t.utm_source.length, 200);
  assert.strictEqual(t.unknown_param, undefined);
  assert.strictEqual(t.occurred_at, new Date(NOW).toISOString(), 'future browser time replaced by submission time');
  assert.strictEqual(t.occurred_at_source, 'submission');
  assert.strictEqual(t.keyword, undefined, 'keyword never inferred');
});
test('mapping: campaign / campaign_id only from explicit evidence', () => {
  const t = normalizeTouch({ landing_page: '/', utm_campaign: 'c', utm_id: 'u1', gad_campaignid: '987', captured_at: at(1) }, { nowMs: NOW });
  assert.strictEqual(t.campaign, 'c');
  assert.strictEqual(t.campaign_id, '987', 'Google campaign id preferred');
  const u = normalizeTouch({ landing_page: '/', utm_id: 'u1', captured_at: at(1) }, { nowMs: NOW });
  assert.strictEqual(u.campaign_id, 'u1');
  assert.strictEqual(u.campaign, null);
});
test('mapping: consent + form + page preserved; invalid form id dropped', () => {
  const m = mapWebsiteAttribution({ consent_sms: false, consent_email: true, consent_gpc: true, form_id: 'inline:kitchen-remodeling', page_url: 'https://ecconstructiongroup.com/contact?x=1', attribution: { conversion_page: '/contact?q=1' } }, { now: NOW });
  assert.deepStrictEqual([m.inquiry.consent_sms, m.inquiry.consent_email, m.inquiry.consent_gpc], [false, true, true]);
  assert.strictEqual(m.inquiry.form_id, 'inline:kitchen-remodeling');
  assert.strictEqual(m.inquiry.page_url, 'https://ecconstructiongroup.com/contact');
  assert.strictEqual(m.inquiry.conversion_page, '/contact');
  assert.strictEqual(mapWebsiteAttribution({ form_id: '<script>' }, { now: NOW }).inquiry.form_id, null);
});
test('mapWebsiteLead: attribution is returned beside the lead, never inside the lead row', () => {
  const m = mapWebsiteLead({ first_name: 'A', email: 'a@example.org', attribution: { v: 2, first_touch: ads } });
  assert.ok(m.ok);
  assert.strictEqual(m.lead.attribution, undefined);
  assert.strictEqual(m.attribution.touches.first.gclid, 'G1');
});

// ── Canonical lead status ─────────────────────────────────────────────────
test('leadStatus: canonical spelling for every known variant; unknown values kept; empty → null', () => {
  assert.strictEqual(canonicalLeadStatus('Appointment Scheduled'), 'Appointment scheduled');
  assert.strictEqual(canonicalLeadStatus('  appointment   SCHEDULED '), 'Appointment scheduled');
  assert.strictEqual(canonicalLeadStatus('proposal sent'), 'Proposal Sent');
  assert.strictEqual(canonicalLeadStatus('dnq'), 'DNQ');
  assert.strictEqual(canonicalLeadStatus('new'), 'New');
  assert.strictEqual(canonicalLeadStatus('Some Custom Status'), 'Some Custom Status');
  assert.strictEqual(canonicalLeadStatus(''), null);
  assert.strictEqual(canonicalLeadStatus(null), null);
  assert.strictEqual(canonicalLeadStatus(undefined), undefined);
});
test('leadStatus: the canonical list matches the CRM UI vocabulary (Kanban / Lead Detail / Settings / Reports)', () => {
  const ui = fs.readFileSync(path.join(ROOT, 'crm-frontend/src/pages/LeadDetailModern.jsx'), 'utf8');
  const list = ui.match(/const STATUSES = \[([^\]]+)\]/)[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1));
  assert.deepStrictEqual([...list].sort(), [...CANONICAL_LEAD_STATUSES].sort());
  for (const f of ['crm-frontend/src/pages/Reports.jsx', 'crm-frontend/src/components/FollowUpsWidget.jsx', 'crm-frontend/src/pages/KanbanBoard.jsx', 'routes/cronJobs.js']) {
    assert.ok(fs.readFileSync(path.join(ROOT, f), 'utf8').includes(`${LEAD_STATUS.APPOINTMENT_SCHEDULED}`), `${f} reads the canonical spelling`);
  }
});
test('leadStatus: no writer stores the non-canonical "Appointment Scheduled" any more', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/booking/bookingService.js'), 'utf8');
  assert.ok(!/'Appointment Scheduled'/.test(src));
  assert.ok(src.includes('LEAD_STATUS.APPOINTMENT_SCHEDULED'));
  const leads = fs.readFileSync(path.join(ROOT, 'routes/leads.js'), 'utf8');
  assert.ok(leads.includes('status: canonicalLeadStatus(row.status)'), 'serializer reads canonical');
  assert.ok((leads.match(/canonicalLeadStatus\(body/g) || []).length >= 2, 'create + update canonicalize input');
});

// ── Qualification ─────────────────────────────────────────────────────────
const ALL = { usable_contact: true, service_offered: true, in_service_area: true, not_dnq: true, not_spam: true, not_duplicate: true };
test('qualification v1: outcome is derived (all criteria true → qualified), never supplied', () => {
  assert.strictEqual(evaluateQualification(ALL).outcome, 'qualified');
  assert.strictEqual(evaluateQualification({ ...ALL, in_service_area: false }).outcome, 'not_qualified');
  assert.strictEqual(evaluateQualification({ ...ALL, outcome: 'qualified', not_spam: false }).outcome, 'not_qualified');
});
test('qualification v1: every criterion must be an explicit boolean; unknown versions refused', () => {
  assert.strictEqual(evaluateQualification({ usable_contact: true }).ok, false);
  assert.strictEqual(evaluateQualification({ ...ALL, not_dnq: 'yes' }).ok, false);
  assert.strictEqual(evaluateQualification(ALL, 'v9').ok, false);
  assert.strictEqual(evaluateQualification(null).ok, false);
});
test('qualification is not a lead status', () => {
  assert.ok(!CANONICAL_LEAD_STATUSES.some((s) => /qualif/i.test(s)));
  const src = fs.readFileSync(path.join(ROOT, 'routes/leadQualification.js'), 'utf8');
  assert.ok(!/UPDATE\s+leads/i.test(src), 'qualification never writes the lead row');
});

// ── Source mapping data (people are providers, never channels) ────────────
test('EC source-mapping file: valid, people are providers, nothing installation-specific in code', () => {
  const data = loadFile(path.join(ROOT, 'docs/marketing/ec-source-mappings.json'));
  assert.deepStrictEqual(data.errors, []);
  const people = ['Yair', 'Sharon', 'Ethan'];
  for (const p of people) {
    const m = data.mappings.find((x) => x.raw_source === p);
    assert.ok(m && m.provider === p, `${p} kept as provider`);
  }
  assert.strictEqual(data.mappings.find((x) => x.raw_source === 'Yair').channel, 'referral', 'decision: channel Referral, provider Yair');
  for (const f of ['lib/marketing/channelClassifier.js', 'lib/marketing/websiteAttribution.js', 'lib/marketing/attributionStore.js', 'lib/marketing/qualification.js', 'scripts/marketing/applySourceMappings.js', 'db/migrations/2026-48-marketing-attribution.sql']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const p of people) assert.ok(!new RegExp(`\\b${p}\\b`).test(src), `${f} does not hardcode ${p}`);
  }
});
test('source-mapping loader rejects undeclared providers and missing channels', () => {
  const tmp = path.join(require('os').tmpdir(), `map-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ providers: [], mappings: [{ raw_source: 'X', channel: 'referral', provider: 'Nobody' }, { raw_source: 'Y' }] }));
  const r = loadFile(tmp);
  assert.strictEqual(r.errors.length, 2);
  fs.unlinkSync(tmp);
});

// ── Receiver ordering (unit, fake DB) ─────────────────────────────────────
test('receiver: attribution is recorded BEFORE notes/alerts; if it fails, the delivery fails (retryable) with no side effects', async () => {
  const express = require('express');
  const { createWebsiteLeadsRouter } = require('../routes/websiteLeads');
  const calls = [];
  const receipts = new Map();
  const query = async (sql, params) => {
    if (/INSERT INTO website_lead_receipts/.test(sql)) { if (receipts.has(params[0])) return { rows: [] }; receipts.set(params[0], {}); return { rows: [{ external_ref: params[0] }] }; }
    if (/DELETE FROM website_lead_receipts/.test(sql)) { receipts.delete(params[0]); calls.push('claim_released'); return { rows: [] }; }
    if (/INSERT INTO activities/.test(sql)) { calls.push('note'); return { rows: [] }; }
    if (/UPDATE leads SET message/.test(sql)) { calls.push('lead_update'); return { rows: [] }; }
    if (/SELECT \* FROM leads/.test(sql)) return { rows: [{ id: 'L1' }] };
    if (/UPDATE website_lead_receipts/.test(sql)) { calls.push('receipt_done'); return { rows: [] }; }
    return { rows: [] };
  };
  let fail = true;
  const router = createWebsiteLeadsRouter({
    query, pool: {}, getSecret: () => 's', crmPublicUrl: () => '', log: { log() {}, warn() {}, error() {} },
    createBooking: async () => ({ lead: { id: 'L1', external_ref: 'ec-website-lead-w1' } }),
    BookingError: class extends Error {}, ownerEmail: async () => 'o@x.test', ownerDisplayName: () => 'Owner',
    websiteDomain: async () => 'ecconstructiongroup.com',
    sendNewLeadAlert: async () => { calls.push('alert'); }, enqueueContactSync: async () => { calls.push('contacts'); },
    recordInquiry: async (_pool, p) => { calls.push(`record:${p.action}:${p.attribution.touches.first ? p.attribution.touches.first.channel_code : 'none'}`); if (fail) throw new Error('db down'); },
  });
  const app = express(); app.use(express.json()); app.use('/r', router);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}/r`;
  const body = { id: 'w1', first_name: 'A', last_name: 'B', email: 'a@example.org', attribution: { v: 2, first_touch: ads } };
  const post = () => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': 's', 'idempotency-key': 'ec-website-lead-w1' }, body: JSON.stringify(body) });
  try {
    const r1 = await post();
    assert.strictEqual(r1.status, 500);
    assert.deepStrictEqual(calls, ['record:created:google_ads', 'claim_released'], 'no note, alert or contacts before attribution is safely stored');
    calls.length = 0; fail = false;
    const r2 = await post();
    assert.strictEqual(r2.status, 201);
    assert.strictEqual(calls[0], 'record:created:google_ads');
    assert.ok(calls.indexOf('alert') > 0 && calls.indexOf('note') > 0);
  } finally { server.close(); }
});
