/* eslint-disable no-undef */
'use strict';

/**
 * marketingAttribution.int.test.js — REAL-Postgres proof of the Growth Engine
 * Phase 1 foundation (migration 2026-48) end to end through the real routes:
 *
 *   website payload → POST /api/v1/website-leads → Postgres
 *     → lead_submissions (per inquiry) + marketing_touches (append-only)
 *     → leads.first/last/conversion_touch_id → lead_attribution_v
 *   status changes (any writer) → lead_status_events → lead_funnel_v
 *   appointments / estimates / Handoff / deals / SignNow → lead_funnel_v
 *   explicit qualification → lead_qualification_events
 *   merge → lineage, nothing lost, nothing duplicated, no DNQ pollution
 *   Phase 0 defects: SignNow → Sold, 'Appointment scheduled' spelling
 *
 * Runs only with TEST_DATABASE_URL (a disposable, migrated database).
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable Postgres)' : false;
const ROOT = path.join(__dirname, '..', '..');
const SECRET = 'int-test-attribution-secret';

if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
  process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'int-test-secret-int-test-secret-0123456789';
  process.env.WEBSITE_LEAD_WEBHOOK_SECRET = SECRET;
}

const alerts = [];
const emails = [];
if (DB_URL) {
  const stub = (rel, exports) => {
    const p = require.resolve(path.join(ROOT, rel));
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
  };
  stub('lib/booking/googleCalendarClient', {
    getAccessToken: async () => 'fake', createOrUpdateEvent: async (_t, _c, b) => ({ id: b.id }),
    updateEvent: async (_t, _c, id) => ({ id }), cancelEvent: async () => ({ ok: true }),
    getEvent: async () => ({ exists: false }), listByExt: async () => [], listEvents: async () => [],
  });
  stub('lib/googleMapsClient', {
    isConfigured: () => false, normalizeAddress: (a, c) => [a, c].filter(Boolean).join(', '),
    geocodeAddress: async () => null, computeRoute: async () => null,
  });
  stub('lib/captureAlerts', { sendNewLeadAlert: async (lead) => { alerts.push(lead.id); }, ALERT_RECIPIENTS: [] });
  stub('lib/signnowClient', {
    getDocumentStatus: async () => ({ signatures: [{ id: 'sig' }], field_invites: [{ status: 'fulfilled' }] }),
    downloadSignedPdf: async () => Buffer.from('%PDF-1.4 test'),
  });
  stub('lib/r2Client', { isConfigured: () => false });
  stub('lib/emailService', { send: async (m) => { emails.push(m.to); return { ok: true }; } });
}

let base, server, db, adminToken, store, mappings;
let ipSeq = 1;
const RUN = `a${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
let seq = 0;

async function http(method, url, body, headers = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.7.${Math.floor(ipSeq / 250) % 250}.${(ipSeq++ % 250) + 1}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { status: res.status, body: json };
}
const admin = (method, url, body) => http(method, url, body, { authorization: 'Bearer ' + adminToken });

const rnd = (lo, n) => lo + Math.floor(Math.random() * n);
const phone = () => `${rnd(200, 800)}${rnd(200, 800)}${String(rnd(0, 10000)).padStart(4, '0')}`;
const ago = (days) => new Date(Date.now() - days * 86400e3).toISOString();

function person() {
  seq++;
  return { first_name: 'Attr', last_name: `${RUN}x${seq}`, email: `attr.${RUN}.${seq}@example.org`, phone: phone() };
}

function payload(who, id, attribution, extra = {}) {
  return {
    id, ...who, full_name: `${who.first_name} ${who.last_name}`,
    project_type: 'Kitchen remodel', message: `inquiry ${id}`, source: 'Website',
    consent_sms: true, consent_sms_timestamp: new Date().toISOString(), consent_sms_disclosure_version: 'sms-consent-v1-2026-09',
    consent_email: false, created_date: new Date().toISOString(),
    page_url: 'https://ecconstructiongroup.com/contact', submission_id: `sub_${id}`, form_id: 'contact',
    attribution, ...extra,
  };
}

function deliver(body) {
  return http('POST', '/api/v1/website-leads', body, { 'x-webhook-secret': SECRET, 'idempotency-key': `ec-website-lead-${body.id}` });
}

async function leadRow(id) { return (await db.query('SELECT * FROM leads WHERE id = $1', [id])).rows[0]; }
async function touch(id) { return id ? (await db.query('SELECT * FROM marketing_touches WHERE id = $1', [id])).rows[0] : null; }
async function touchesOf(leadId) { return (await db.query('SELECT * FROM marketing_touches WHERE lead_id = $1 ORDER BY occurred_at', [leadId])).rows; }
async function subsOf(leadId) { return (await db.query('SELECT * FROM lead_submissions WHERE lead_id = $1 ORDER BY submitted_at, created_at', [leadId])).rows; }
async function statusEvents(leadId) { return (await db.query('SELECT * FROM lead_status_events WHERE lead_id = $1 ORDER BY occurred_at, id', [leadId])).rows; }
async function funnel(leadId) { return (await db.query('SELECT * FROM lead_funnel_v WHERE lead_id = $1', [leadId])).rows[0]; }
async function attribution(leadId) { return (await db.query('SELECT * FROM lead_attribution_v WHERE lead_id = $1', [leadId])).rows[0]; }

const GCLID = 'Cj0KCQjw-test_GCLID.value';
const adsTouch = (daysAgo) => ({ landing_page: '/services/kitchen-remodeling', referrer: 'https://www.google.com/', utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'kitchen-la', utm_content: 'ad-a', utm_term: 'kitchen remodel', gclid: GCLID, gad_source: '1', gad_campaignid: '2233445566', captured_at: ago(daysAgo) });
const sameAds = (daysAgo) => { const t = adsTouch(daysAgo); return { first_touch: t, last_touch: t, conversion_touch: t }; };
const directTouch = (daysAgo) => ({ landing_page: '/', captured_at: ago(daysAgo) });
const organicTouch = (daysAgo) => ({ landing_page: '/locations/pasadena', referrer: 'https://www.google.com/', captured_at: ago(daysAgo) });

test.before(async () => {
  if (skip) return;
  execFileSync(process.execPath, ['db/migrate.js'], { cwd: ROOT, env: process.env, stdio: 'ignore' });
  const express = require('express');
  db = require(path.join(ROOT, 'db/client'));
  store = require(path.join(ROOT, 'lib/marketing/attributionStore'));
  mappings = require(path.join(ROOT, 'scripts/marketing/applySourceMappings'));
  const { issueAccessToken } = require(path.join(ROOT, 'lib/authService'));
  await db.query(`INSERT INTO owners (email, display_name) VALUES ('yaron@ecconstructiongroup.com', 'Yaron Drilevich') ON CONFLICT DO NOTHING`);
  await require(path.join(ROOT, 'lib/googleContactsOutbox')).ensureContactsOutbox(db.pool);
  adminToken = issueAccessToken({ id: '00000000-0000-0000-0000-0000000000a1', email: 'yaron@ecconstructiongroup.com', role: 'admin' });
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/v1/leads', require(path.join(ROOT, 'routes/mergeLeads')));
  app.use('/api/v1/leads', require(path.join(ROOT, 'routes/leadQualification')));
  app.use('/api/v1/leads', require(path.join(ROOT, 'routes/leads')));
  app.use('/api/public/capture', require(path.join(ROOT, 'routes/publicCapture')));
  app.use('/api/v1/website-leads', require(path.join(ROOT, 'routes/websiteLeads')).defaultRouter());
  app.use('/api/v1/signnow-webhook', require(path.join(ROOT, 'routes/signnowWebhook')));
  app.use('/api/v1/system', require(path.join(ROOT, 'routes/systemHealth')));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (skip) return;
  server.close();
  await db.pool.end();
});

// ── Website → CRM: touches, inquiry, pointers ────────────────────────────────
test('M1. paid first touch → return visit in a NEW session → Direct conversion: Google Ads stays first AND last, conversion is Direct; existing intake behavior unchanged', { skip }, async () => {
  const who = person();
  const id = `${RUN}-m1`;
  const ads = adsTouch(10); // the browser keeps ONE stored object for first and last touch
  const r = await deliver(payload(who, id, { v: 2, first_touch: ads, last_touch: ads, conversion_touch: directTouch(0), conversion_page: '/contact' }));
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.action, 'created');
  const lead = await leadRow(r.body.id);

  const first = await touch(lead.first_touch_id);
  const last = await touch(lead.last_touch_id);
  const conv = await touch(lead.conversion_touch_id);
  assert.strictEqual(first.channel_code, 'google_ads');
  assert.strictEqual(lead.first_touch_id, lead.last_touch_id, 'identical first/last touch is stored once');
  assert.strictEqual(last.gclid, GCLID, 'GCLID preserved');
  assert.strictEqual(conv.channel_code, 'direct');
  assert.notStrictEqual(lead.conversion_touch_id, lead.first_touch_id);
  // UTM + Google campaign id preservation; nothing invented.
  assert.strictEqual(first.utm_source, 'google'); assert.strictEqual(first.utm_medium, 'cpc');
  assert.strictEqual(first.utm_campaign, 'kitchen-la'); assert.strictEqual(first.utm_content, 'ad-a'); assert.strictEqual(first.utm_term, 'kitchen remodel');
  assert.strictEqual(first.campaign, 'kitchen-la'); assert.strictEqual(first.campaign_id, '2233445566'); assert.strictEqual(first.gad_source, '1');
  assert.strictEqual(first.keyword, null, 'keyword is never inferred from utm_term');
  assert.strictEqual(first.ad_group, null);
  assert.strictEqual(first.landing_page, '/services/kitchen-remodeling');
  assert.ok(Math.abs(Date.parse(first.occurred_at) - Date.parse(ago(10))) < 60e3, 'touch keeps the click time, not the insert time');
  assert.strictEqual((await touchesOf(lead.id)).length, 2);

  const subs = await subsOf(lead.id);
  assert.strictEqual(subs.length, 1);
  assert.strictEqual(subs[0].external_ref, `ec-website-lead-${id}`);
  assert.strictEqual(subs[0].intake_action, 'created');
  assert.strictEqual(subs[0].origin_system, 'website');
  assert.strictEqual(subs[0].raw_source, 'Website');
  assert.strictEqual(subs[0].form_type, 'contact');
  assert.strictEqual(subs[0].conversion_page, '/contact');
  assert.strictEqual(subs[0].page_url, 'https://ecconstructiongroup.com/contact');
  assert.strictEqual(subs[0].website_lead_id, id);
  assert.strictEqual(subs[0].website_submission_id, `sub_${id}`);
  assert.strictEqual(subs[0].first_touch_id, lead.first_touch_id);
  assert.strictEqual(subs[0].last_touch_id, lead.last_touch_id);
  assert.strictEqual(subs[0].conversion_touch_id, lead.conversion_touch_id);
  assert.strictEqual(subs[0].consent_sms, true);
  assert.strictEqual(subs[0].consent_email, false);

  const a = await attribution(lead.id);
  assert.strictEqual(a.normalized_channel, 'google_ads');
  assert.strictEqual(a.raw_source, 'Website');
  assert.strictEqual(a.gclid, GCLID);
  assert.strictEqual(a.conversion_touch_channel, 'direct');

  // Existing Website → CRM behavior is untouched (additive only).
  assert.strictEqual(lead.source, 'Website');
  assert.strictEqual(lead.status, 'New');
  assert.strictEqual(lead.email, who.email);
  assert.strictEqual(lead.project_type, 'Kitchen remodel');
  assert.strictEqual(lead.external_ref, `ec-website-lead-${id}`);
  assert.strictEqual(lead.sms_consent, true);
  assert.strictEqual(lead.sms_consent_source, 'website');
  assert.strictEqual(lead.follow_up_date, null, 'no accidental Follow-Up');
  assert.strictEqual(Number((await db.query('SELECT count(*) n FROM appointments WHERE lead_id = $1', [lead.id])).rows[0].n), 0, 'no appointment');
  assert.ok(alerts.includes(lead.id), 'new-lead alert still sent once');
  const notes = (await db.query(`SELECT content FROM activities WHERE lead_id = $1`, [lead.id])).rows.map((x) => x.content).join('\n');
  assert.match(notes, /Website inquiry\./);
  assert.match(notes, new RegExp(`Website lead ID: ${id}`));
});

test('M2. organic → paid → conversion: first touch Google organic-or-GBP (never guessed), last meaningful Google Ads', { skip }, async () => {
  const who = person();
  const r = await deliver(payload(who, `${RUN}-m2`, { v: 2, first_touch: organicTouch(20), ...(() => { const t = adsTouch(5); return { last_touch: t, conversion_touch: t }; })(), conversion_page: '/services/kitchen-remodeling' }));
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const lead = await leadRow(r.body.id);
  assert.strictEqual((await touch(lead.first_touch_id)).channel_code, 'google_organic_or_gbp');
  assert.strictEqual((await touch(lead.last_touch_id)).channel_code, 'google_ads');
  assert.strictEqual(lead.last_touch_id, lead.conversion_touch_id);
  assert.strictEqual((await attribution(lead.id)).normalized_channel, 'google_ads');
});

test('M3. direct first visit: Direct first/conversion, no meaningful last touch, channel Direct', { skip }, async () => {
  const who = person();
  const r = await deliver(payload(who, `${RUN}-m3`, { v: 2, first_touch: directTouch(0), conversion_touch: directTouch(0), conversion_page: '/' }));
  assert.strictEqual(r.status, 201);
  const lead = await leadRow(r.body.id);
  assert.strictEqual((await touch(lead.first_touch_id)).channel_code, 'direct');
  assert.strictEqual(lead.last_touch_id, null, 'Direct is never a last meaningful touch');
  assert.strictEqual(lead.conversion_touch_id, lead.first_touch_id);
  assert.strictEqual((await attribution(lead.id)).normalized_channel, 'direct');
});

test('M4. GBRAID / WBRAID / MSCLKID / fbclid preserved; invalid identifiers dropped, never repaired', { skip }, async () => {
  const who = person();
  const t = { landing_page: '/services/pool', gbraid: '0AAAAAgbraid-1', wbraid: 'wbraid.Value_2', captured_at: ago(3) };
  const r = await deliver(payload(who, `${RUN}-m4`, { v: 2, first_touch: t, last_touch: t, conversion_touch: { ...t },
    conversion_page: '/services/pool' }));
  assert.strictEqual(r.status, 201);
  const lead = await leadRow(r.body.id);
  const f = await touch(lead.first_touch_id);
  assert.strictEqual(f.gbraid, '0AAAAAgbraid-1');
  assert.strictEqual(f.wbraid, 'wbraid.Value_2');
  assert.strictEqual(f.channel_code, 'google_ads');

  const who2 = person();
  const bad = { landing_page: 'https://evil.example/x?email=a@b.c', referrer: 'https://www.bing.com/search?q=secret', msclkid: 'ms clk id with spaces', fbclid: 'IwAR_fb', captured_at: '2999-01-01T00:00:00Z' };
  const r2 = await deliver(payload(who2, `${RUN}-m4b`, { v: 2, first_touch: bad, conversion_touch: bad }));
  assert.strictEqual(r2.status, 201);
  const f2 = await touch((await leadRow(r2.body.id)).first_touch_id);
  assert.strictEqual(f2.landing_page, null, 'absolute URL is not a landing path');
  assert.strictEqual(f2.referrer, 'https://www.bing.com/search', 'referrer query string never stored');
  assert.strictEqual(f2.msclkid, null, 'malformed click id dropped');
  assert.strictEqual(f2.fbclid, 'IwAR_fb');
  assert.ok(Date.parse(f2.occurred_at) <= Date.now() + 60e3, 'a future browser timestamp is not trusted');
});

test('M5. duplicate delivery of the same submission: one lead, one inquiry, no duplicate touches', { skip }, async () => {
  const who = person();
  const t = adsTouch(2);
  const body = payload(who, `${RUN}-m5`, { v: 2, first_touch: t, last_touch: t, conversion_touch: t });
  const r1 = await deliver(body);
  const r2 = await deliver(body);
  assert.strictEqual(r1.status, 201);
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.body.duplicate_delivery, true);
  assert.strictEqual(r2.body.id, r1.body.id);
  assert.strictEqual((await subsOf(r1.body.id)).length, 1);
  assert.strictEqual((await touchesOf(r1.body.id)).length, 1);
  // And the store itself is idempotent on the inquiry reference.
  const again = await store.recordWebsiteInquiry(db.pool, { leadId: r1.body.id, externalRef: `ec-website-lead-${RUN}-m5`, action: 'created', attribution: { touches: {}, inquiry: {} } });
  assert.strictEqual(again.duplicate, true);
  assert.strictEqual((await subsOf(r1.body.id)).length, 1);
});

test('M6. same person submits again later from a new campaign: new inquiry on the SAME lead, first touch kept, last meaningful touch advances, history intact', { skip }, async () => {
  const who = person();
  const r1 = await deliver(payload(who, `${RUN}-m6a`, { v: 2, ...sameAds(30) }));
  const lead1 = await leadRow(r1.body.id);
  const metaTouch = { landing_page: '/services/bathroom-remodeling', referrer: 'https://l.facebook.com/', fbclid: 'IwAR_second', utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: 'bath-spring', captured_at: ago(1) };
  const r2 = await deliver(payload(who, `${RUN}-m6b`, { v: 2, first_touch: metaTouch, last_touch: metaTouch, conversion_touch: metaTouch }, { project_type: 'Bathroom remodel' }));
  assert.strictEqual(r2.status, 200, JSON.stringify(r2.body));
  assert.strictEqual(r2.body.action, 'matched_existing');
  assert.strictEqual(r2.body.id, lead1.id);
  const lead2 = await leadRow(lead1.id);
  assert.strictEqual(lead2.first_touch_id, lead1.first_touch_id, 'first touch never overwritten');
  assert.strictEqual(lead2.conversion_touch_id, lead1.conversion_touch_id, 'the lead-creation touch is kept');
  assert.notStrictEqual(lead2.last_touch_id, lead1.last_touch_id);
  assert.strictEqual((await touch(lead2.last_touch_id)).channel_code, 'meta');
  const subs = await subsOf(lead1.id);
  assert.strictEqual(subs.length, 2);
  assert.deepStrictEqual(subs.map((s) => s.intake_action), ['created', 'matched_existing']);
  assert.deepStrictEqual(subs.map((s) => s.submission_number), [1, 2]);
  assert.strictEqual(subs[1].project_type, 'Bathroom remodel');
  assert.strictEqual((await touch(subs[1].first_touch_id)).fbclid, 'IwAR_second');
  assert.strictEqual((await touchesOf(lead1.id)).length, 2, 'the original Google Ads touch still exists');

  // An OLDER meaningful touch arriving later never moves last touch backwards.
  const older = { ...adsTouch(60), utm_campaign: 'old' };
  await deliver(payload(who, `${RUN}-m6c`, { v: 2, first_touch: older, last_touch: older, conversion_touch: directTouch(0) }));
  assert.strictEqual((await leadRow(lead1.id)).last_touch_id, lead2.last_touch_id);
});

test('M7. first touch is immutable except through an explicit, audited correction', { skip }, async () => {
  const who = person();
  const r = await deliver(payload(who, `${RUN}-m7`, { v: 2, first_touch: organicTouch(9), ...(() => { const t = adsTouch(2); return { last_touch: t, conversion_touch: t }; })() }));
  const lead = await leadRow(r.body.id);
  await assert.rejects(db.query('UPDATE leads SET first_touch_id = $1 WHERE id = $2', [lead.last_touch_id, lead.id]), /immutable/);
  await assert.rejects(db.query('UPDATE leads SET first_touch_id = NULL WHERE id = $1', [lead.id]), /immutable/);
  await assert.rejects(store.correctFirstTouch(db.pool, { leadId: lead.id, touchId: lead.last_touch_id }), /actor and reason/);
  await store.correctFirstTouch(db.pool, { leadId: lead.id, touchId: lead.last_touch_id, actor: 'yaron@ecconstructiongroup.com', reason: 'test correction' });
  assert.strictEqual((await leadRow(lead.id)).first_touch_id, lead.last_touch_id);
  const audit = (await db.query(`SELECT * FROM lead_attribution_audit WHERE lead_id = $1 AND action = 'first_touch_correction'`, [lead.id])).rows;
  assert.strictEqual(audit.length, 1);
  assert.strictEqual(audit[0].previous_touch_id, lead.first_touch_id);
  // The correction GUC is transaction-local: the guard is active again.
  await assert.rejects(db.query('UPDATE leads SET first_touch_id = $1 WHERE id = $2', [lead.first_touch_id, lead.id]), /immutable/);
});

test('M8. older website clients (v1 payload) stay attributable: Direct session landing is the conversion, the meaningful first touch is kept', { skip }, async () => {
  const who = person();
  const r = await deliver(payload(who, `${RUN}-m8`, { first_touch: adsTouch(4), last_touch: directTouch(0), conversion_page: '/contact' }));
  assert.strictEqual(r.status, 201);
  const lead = await leadRow(r.body.id);
  assert.strictEqual((await touch(lead.first_touch_id)).gclid, GCLID);
  assert.strictEqual(lead.last_touch_id, lead.first_touch_id);
  assert.strictEqual((await touch(lead.conversion_touch_id)).channel_code, 'direct');

  // And a lead with no attribution at all still works exactly as before.
  const who2 = person();
  const r2 = await deliver(payload(who2, `${RUN}-m8b`, undefined));
  assert.strictEqual(r2.status, 201);
  const l2 = await leadRow(r2.body.id);
  assert.strictEqual(l2.first_touch_id, null);
  assert.strictEqual((await subsOf(l2.id)).length, 1, 'the inquiry is still recorded');
  assert.strictEqual((await attribution(l2.id)).normalized_channel, 'unknown');
});

test('M9. consent preserved per inquiry: SMS consent, email consent and the GPC signal', { skip }, async () => {
  const who = person();
  const r = await deliver(payload(who, `${RUN}-m9`, { v: 2, first_touch: directTouch(0) }, { consent_sms: false, consent_email: true, consent_gpc: true }));
  const lead = await leadRow(r.body.id);
  assert.strictEqual(lead.sms_consent, false);
  const [s] = await subsOf(lead.id);
  assert.strictEqual(s.consent_sms, false);
  assert.strictEqual(s.consent_email, true);
  assert.strictEqual(s.consent_gpc, true);
});

// ── Status history + funnel ──────────────────────────────────────────────────
test('F1. status history: every change recorded once with actor; repeats are no-ops; funnel reads estimate/sold from it', { skip }, async () => {
  const who = person();
  const r = await deliver(payload(who, `${RUN}-f1`, { v: 2, first_touch: adsTouch(3) }));
  const id = r.body.id;
  let ev = await statusEvents(id);
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].from_status, null);
  assert.strictEqual(ev[0].to_status, 'New');
  for (const status of ['Proposal Sent', 'Proposal Sent', 'Sold']) {
    const u = await admin('PUT', `/api/v1/leads/${id}`, { status });
    assert.strictEqual(u.status, 200, JSON.stringify(u.body));
  }
  ev = await statusEvents(id);
  assert.deepStrictEqual(ev.map((e) => e.to_status), ['New', 'Proposal Sent', 'Sold'], 'the repeated status was not recorded twice');
  assert.strictEqual(ev[1].actor, 'yaron@ecconstructiongroup.com');
  assert.strictEqual(ev[1].change_source, 'crm_ui');
  const f = await funnel(id);
  assert.ok(f.lead_created_at);
  assert.ok(f.estimate_at, 'Proposal Sent → estimate stage');
  assert.ok(f.sold_at, 'Sold → sold stage');
  assert.strictEqual(f.qualified_at, null, 'Qualified is never inferred');
});

test('F2. appointment: a lead booked with its first appointment gets the canonical "Appointment scheduled"; funnel appointment stage from the appointments table; stored legacy spelling still reads canonical', { skip }, async () => {
  const pickDay = await require('./freeDays').loadFreeDayPicker(db);
  const day = pickDay();
  const r = await http('POST', '/api/public/capture', {
    first_name: 'Appt', last_name: `${RUN}cap`, phone: phone(), project_type: 'Kitchen', source: 'Referral',
    assigned_rep: 'Yaron Drilevich', appointment_date: day, appointment_time: '10:00',
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const id = r.body.lead.id;
  const row = await leadRow(id);
  assert.strictEqual(row.status, 'Appointment scheduled', 'canonical spelling stored');
  assert.ok((await funnel(id)).appointment_at, 'appointment stage from appointments');
  const lead = (await admin('GET', `/api/v1/leads/${id}`)).body.lead;
  assert.strictEqual(lead.status, 'Appointment scheduled');

  // A row written before the fix keeps its stored value but is served canonically.
  await db.query(`UPDATE leads SET status = 'Appointment Scheduled' WHERE id = $1`, [id]);
  assert.strictEqual((await admin('GET', `/api/v1/leads/${id}`)).body.lead.status, 'Appointment scheduled');
  const list = (await admin('GET', '/api/v1/leads?limit=5000')).body;
  const fromList = list.items.find((l) => l.id === id);
  assert.ok(fromList, 'lead is in the list');
  assert.strictEqual(fromList.status, 'Appointment scheduled', 'list endpoint (Reports/Dashboard/Kanban source) is canonical too');
});

test('F3. estimate + sold stages from the canonical records; weak Handoff matches never count', { skip }, async () => {
  const who = person();
  const id = (await deliver(payload(who, `${RUN}-f3`, { v: 2, first_touch: directTouch(0) }))).body.id;
  await db.query(`INSERT INTO handoff_estimates (lead_id, customer_name, estimate_amount, estimate_date, match_status, match_method) VALUES ($1, 'x', 1000, '2026-01-02', 'matched', 'name_last')`, [id]);
  assert.strictEqual((await funnel(id)).estimate_at, null, 'last-name-only Handoff match is not evidence');
  await db.query(`INSERT INTO estimates (lead_id, title, status, total) VALUES ($1, 'Kitchen', 'Sent', 45000)`, [id]);
  assert.ok((await funnel(id)).estimate_at);
  await db.query(`INSERT INTO deals (lead_id, name, amount, contract_amount, sold_date) VALUES ($1, 'Deal', 44000, 45500, '2026-03-04')`, [id]);
  const f = await funnel(id);
  assert.strictEqual(new Date(f.sold_at).toISOString().slice(0, 10), '2026-03-04');
  assert.strictEqual(Number(f.sold_value), 45500);
});

test('F4. Qualified: explicit, versioned, never a status; incomplete criteria refused; idempotent', { skip }, async () => {
  const who = person();
  const id = (await deliver(payload(who, `${RUN}-f4`, { v: 2, first_touch: directTouch(0) }))).body.id;
  const bad = await admin('POST', `/api/v1/leads/${id}/qualification`, { criteria: { usable_contact: true } });
  assert.strictEqual(bad.status, 400);
  const criteria = { usable_contact: true, service_offered: true, in_service_area: true, not_dnq: true, not_spam: true, not_duplicate: true };
  const key = `qual-${RUN}-f4`;
  const ok = await admin('POST', `/api/v1/leads/${id}/qualification`, { criteria, idempotency_key: key });
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
  assert.strictEqual(ok.body.event.outcome, 'qualified');
  assert.strictEqual(ok.body.event.definition_version, 'v1');
  const again = await admin('POST', `/api/v1/leads/${id}/qualification`, { criteria, idempotency_key: key });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.body.duplicate, true);
  const no = await admin('POST', `/api/v1/leads/${id}/qualification`, { criteria: { ...criteria, in_service_area: false } });
  assert.strictEqual(no.body.event.outcome, 'not_qualified');
  assert.ok((await funnel(id)).qualified_at);
  assert.strictEqual((await leadRow(id)).status, 'New', 'qualification never changes the lead status');
  assert.strictEqual((await admin('GET', `/api/v1/leads/${id}/qualification`)).body.events.length, 2);
});

// ── SignNow → Sold (Phase 0 defect A) ─────────────────────────────────────────
test('S1. SignNow main contract signed → lead Sold (one status event, source signnow), truthful activity, idempotent re-delivery', { skip }, async () => {
  const who = person();
  const id = (await deliver(payload(who, `${RUN}-s1`, { v: 2, first_touch: directTouch(0) }))).body.id;
  const docId = `doc_${RUN}_s1`;
  await db.query(`INSERT INTO signnow_documents (lead_id, document_id, document_name, status) VALUES ($1, $2, 'HIC - Kitchen.pdf', 'sent')`, [id, docId]);
  const r = await http('POST', '/api/v1/signnow-webhook', { event: 'document.complete', document_id: docId });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.processed, true, JSON.stringify(r.body));
  assert.strictEqual((await leadRow(id)).status, 'Sold');
  const doc = (await db.query('SELECT * FROM signnow_documents WHERE document_id = $1', [docId])).rows[0];
  assert.strictEqual(doc.status, 'signed');
  assert.ok(doc.signed_at);
  const sold = (await statusEvents(id)).filter((e) => e.to_status === 'Sold');
  assert.strictEqual(sold.length, 1);
  assert.strictEqual(sold[0].change_source, 'signnow');
  const act = (await db.query(`SELECT content FROM activities WHERE lead_id = $1 AND author = 'SignNow (auto)'`, [id])).rows;
  assert.strictEqual(act.length, 1);
  assert.match(act[0].content, /Lead automatically marked as Sold/);
  assert.ok((await funnel(id)).sold_at);

  // Re-delivery: no second activity, no second status event.
  await http('POST', '/api/v1/signnow-webhook', { event: 'document.complete', document_id: docId });
  assert.strictEqual((await statusEvents(id)).filter((e) => e.to_status === 'Sold').length, 1);
  assert.strictEqual((await db.query(`SELECT count(*) n FROM activities WHERE lead_id = $1 AND author = 'SignNow (auto)'`, [id])).rows[0].n, '1');
});

test('S2. SignNow non-main contract: document signed, lead status untouched, activity does not claim Sold', { skip }, async () => {
  const who = person();
  const id = (await deliver(payload(who, `${RUN}-s2`, { v: 2, first_touch: directTouch(0) }))).body.id;
  const docId = `doc_${RUN}_s2`;
  await db.query(`INSERT INTO signnow_documents (lead_id, document_id, document_name, status) VALUES ($1, $2, 'Change Order 1.pdf', 'sent')`, [id, docId]);
  await http('POST', '/api/v1/signnow-webhook', { event: 'document.complete', document_id: docId });
  assert.strictEqual((await leadRow(id)).status, 'New');
  const act = (await db.query(`SELECT content FROM activities WHERE lead_id = $1 AND author = 'SignNow (auto)'`, [id])).rows;
  assert.strictEqual(act.length, 1);
  assert.doesNotMatch(act[0].content, /Sold/);
});

// ── Merge (lineage, nothing lost, no DNQ pollution) ───────────────────────────
test('G1. merge: survivor keeps its first touch, gains every touch/inquiry/status/qualification event with lineage, click ids kept, merged lead marked (not counted as DNQ), funnel not duplicated', { skip }, async () => {
  const a = person();
  const b = person();
  const ra = await deliver(payload(a, `${RUN}-g1a`, { v: 2, first_touch: organicTouch(40), last_touch: organicTouch(40), conversion_touch: organicTouch(40) }));
  await new Promise((r) => setTimeout(r, 20));
  const rb = await deliver(payload(b, `${RUN}-g1b`, { v: 2, ...sameAds(8) }));
  const keep = await leadRow(ra.body.id);
  const merge = await leadRow(rb.body.id);
  await admin('PUT', `/api/v1/leads/${merge.id}`, { status: 'Proposal Sent' });
  const criteria = { usable_contact: true, service_offered: true, in_service_area: true, not_dnq: true, not_spam: true, not_duplicate: true };
  await admin('POST', `/api/v1/leads/${merge.id}/qualification`, { criteria });
  const beforeEvents = (await statusEvents(keep.id)).length + (await statusEvents(merge.id)).length;

  const m = await admin('POST', '/api/v1/leads/merge', { lead_id_keep: keep.id, lead_id_merge: merge.id });
  assert.strictEqual(m.status, 200, JSON.stringify(m.body));
  assert.strictEqual(m.body.kept_lead_id, keep.id, 'the older lead survives');

  const s = await leadRow(keep.id);
  assert.strictEqual(s.first_touch_id, keep.first_touch_id, 'survivor first touch never overwritten');
  assert.strictEqual((await touch(s.last_touch_id)).channel_code, 'google_ads', 'later meaningful touch from the merged lead becomes last touch');
  const touches = await touchesOf(keep.id);
  assert.strictEqual(touches.length, 2);
  assert.ok(touches.some((t) => t.gclid === GCLID && t.merged_from_lead_id === merge.id), 'GCLID survives the merge with lineage');
  const subs = await subsOf(keep.id);
  assert.strictEqual(subs.length, 2);
  assert.strictEqual(subs.filter((x) => x.merged_from_lead_id === merge.id).length, 1);
  assert.strictEqual((await db.query('SELECT count(*) n FROM lead_qualification_events WHERE lead_id = $1 AND merged_from_lead_id = $2', [keep.id, merge.id])).rows[0].n, '1');
  const audit = (await db.query(`SELECT action FROM lead_attribution_audit WHERE lead_id = $1`, [keep.id])).rows.map((x) => x.action);
  assert.ok(audit.includes('merge_kept_survivor_first_touch'));

  const gone = await leadRow(merge.id);
  assert.strictEqual(gone.merged_into_lead_id, keep.id);
  assert.ok(gone.merged_at);
  assert.strictEqual(gone.status, 'DNQ', 'operational soft-delete unchanged');
  const dnq = (await statusEvents(merge.id)).filter((e) => e.to_status === 'DNQ');
  assert.strictEqual(dnq.length, 1);
  assert.strictEqual(dnq[0].reason, 'merged_duplicate');
  assert.strictEqual(await funnel(merge.id), undefined, 'merged lead leaves the funnel');
  assert.strictEqual(await attribution(merge.id), undefined);
  const f = await funnel(keep.id);
  assert.ok(f.estimate_at, "merged lead's Proposal Sent moved with lineage");
  assert.ok(f.qualified_at);
  const afterEvents = (await statusEvents(keep.id)).length + (await statusEvents(merge.id)).length;
  // Exactly two new events: the survivor taking the more recent status
  // (reason merge_status_resolution) and the merged lead's DNQ — nothing duplicated.
  assert.strictEqual(afterEvents, beforeEvents + 2, 'no duplicated history');
  const resolution = (await statusEvents(keep.id)).filter((e) => e.reason === 'merge_status_resolution');
  assert.strictEqual(resolution.length, 1);
  assert.strictEqual(resolution[0].to_status, 'Proposal Sent');
  assert.strictEqual(resolution[0].change_source, 'merge');

  const again = await admin('POST', '/api/v1/leads/merge', { lead_id_keep: keep.id, lead_id_merge: merge.id });
  assert.strictEqual(again.status, 409);
});

test('G2. merge where the survivor has no attribution adopts the merged lead\'s first touch (audited)', { skip }, async () => {
  const older = await admin('POST', '/api/v1/leads', { first_name: 'Manual', last_name: `${RUN}g2`, phone: phone(), source: 'Referral', assigned_rep: 'Yaron Drilevich' });
  assert.strictEqual(older.status, 201, JSON.stringify(older.body));
  const keepId = older.body.lead ? older.body.lead.id : older.body.id;
  await new Promise((r) => setTimeout(r, 20));
  const rb = await deliver(payload(person(), `${RUN}-g2b`, { v: 2, ...sameAds(6) }));
  const merged = await leadRow(rb.body.id);
  const m = await admin('POST', '/api/v1/leads/merge', { lead_id_keep: keepId, lead_id_merge: merged.id });
  assert.strictEqual(m.status, 200, JSON.stringify(m.body));
  const s = await leadRow(keepId);
  assert.strictEqual(s.first_touch_id, merged.first_touch_id);
  assert.strictEqual(s.conversion_touch_id, merged.conversion_touch_id);
  const audit = (await db.query(`SELECT action FROM lead_attribution_audit WHERE lead_id = $1`, [keepId])).rows.map((x) => x.action);
  assert.ok(audit.includes('merge_adopted_first_touch'));
});

// ── Channel normalization (raw source ≠ channel ≠ provider) ───────────────────
test('N1. legacy raw sources map to channel + provider through data; leads.source is never rewritten; unmapped stays Unknown', { skip }, async () => {
  const r = await admin('POST', '/api/v1/leads', { first_name: 'Prov', last_name: `${RUN}n1`, phone: phone(), source: 'Yair', assigned_rep: 'Yaron Drilevich' });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const id = r.body.lead ? r.body.lead.id : r.body.id;
  const u = await admin('POST', '/api/v1/leads', { first_name: 'Unm', last_name: `${RUN}n1u`, phone: phone(), source: 'Unmapped Label', assigned_rep: 'Yaron Drilevich' });
  const uid = u.body.lead ? u.body.lead.id : u.body.id;
  // The integration database persists between runs: start from "nothing mapped".
  const fileKeys = JSON.parse(require('fs').readFileSync(path.join(ROOT, 'docs/marketing/ec-source-mappings.json'), 'utf8')).mappings.map((x) => x.raw_source.trim().toLowerCase());
  await db.query('DELETE FROM lead_source_mappings WHERE raw_source_key = ANY($1)', [fileKeys]);
  assert.strictEqual((await attribution(id)).normalized_channel, 'unknown');
  const data = mappings.loadFile(path.join(ROOT, 'docs/marketing/ec-source-mappings.json'));
  assert.deepStrictEqual(data.errors, []);
  const dry = await mappings.apply(db.pool, data, { write: false });
  assert.strictEqual(dry.mode, 'REPORT-ONLY');
  assert.strictEqual((await attribution(id)).normalized_channel, 'unknown', 'report-only writes nothing');
  await mappings.apply(db.pool, data, { write: true });
  const a = await attribution(id);
  assert.strictEqual(a.raw_source, 'Yair');
  assert.strictEqual(a.normalized_channel, 'referral');
  assert.strictEqual(a.provider_name, 'Yair');
  assert.strictEqual(a.channel_basis, 'source_mapping');
  assert.strictEqual((await leadRow(id)).source, 'Yair', 'raw source untouched');
  assert.strictEqual((await attribution(uid)).normalized_channel, 'unknown', 'no guess for unmapped values');
  const users = (await db.query(`SELECT count(*) n FROM users WHERE lower(email) LIKE '%yair%'`).catch(() => ({ rows: [{ n: '0' }] }))).rows[0].n;
  assert.strictEqual(users, '0', 'a lead provider is not a CRM user');
  // Re-applying is a no-op.
  const second = await mappings.apply(db.pool, data, { write: true });
  assert.ok(second.mappings.every((x) => x.action === 'unchanged'));
});

// ── Test-lead cleanup + read-only integrity endpoint ──────────────────────────
test('T1. controlled test lead: CRM test evidence includes the stored attribution; cleanup cascades (no orphan touches/inquiries/history)', { skip }, async () => {
  const id = `${RUN}-t1`;
  const who = { first_name: 'E2E-TEST', last_name: RUN, email: `e2e.${RUN}@example.com`, phone: phone() };
  const r = await deliver(payload(who, id, { v: 2, ...(() => { const t = adsTouch(1); return { first_touch: t, last_touch: t }; })(), conversion_touch: directTouch(0), conversion_page: '/contact' }));
  assert.strictEqual(r.status, 201);
  const leadId = r.body.id;
  const del = await http('DELETE', `/api/v1/website-leads/test/ec-website-lead-${id}`, undefined, { 'x-webhook-secret': SECRET });
  assert.strictEqual(del.status, 200, JSON.stringify(del.body));
  const at = del.body.evidence.attribution;
  assert.strictEqual(at.submissions.length, 1);
  assert.strictEqual(at.submissions[0].has_first && at.submissions[0].has_last && at.submissions[0].has_conversion, true);
  assert.ok(at.touches.some((t) => t.is_first && t.gclid === GCLID && t.channel_code === 'google_ads'));
  assert.ok(at.touches.some((t) => t.is_conversion && t.channel_code === 'direct'));
  assert.strictEqual(at.status_events, 1);
  for (const table of ['marketing_touches', 'lead_submissions', 'lead_status_events']) {
    const n = (await db.query(`SELECT count(*) n FROM ${table} WHERE lead_id = $1`, [leadId])).rows[0].n;
    assert.strictEqual(n, '0', `${table} cleaned up`);
  }
});

test('I1. read-only integrity endpoint: aggregates only (no PII / click ids), reports the legacy-column and status-vocabulary state', { skip }, async () => {
  const r = await admin('GET', '/api/v1/system/attribution-integrity');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.schema.legacy_signnow_lead_columns, { signed_contract_date: false, signed_contract_document_id: false, sold_date: false, sold_by_source: false });
  assert.deepStrictEqual(r.body.schema.legacy_merge_lead_columns, { duplicate_merged: false, last_merge_date: false, merge_count: false });
  assert.deepStrictEqual(r.body.schema.legacy_qb_handoff_lead_columns, { qb_last_error: false, handoff_estimate_status: false, appointment_date: false, handoff_project_id: false, handoff_project_number: false });
  assert.ok(Object.values(r.body.schema.attribution_columns).every(Boolean));
  assert.ok(r.body.attribution.touches > 0);
  assert.ok(typeof r.body.signnow_sold.main_contracts_signed === 'number');
  assert.ok(Array.isArray(r.body.lead_status.values));
  const text = JSON.stringify(r.body);
  assert.ok(!text.includes(GCLID), 'no click identifier');
  assert.ok(!/@example\.(org|com)/.test(text), 'no email');
  const noAuth = await http('GET', '/api/v1/system/attribution-integrity');
  assert.strictEqual(noAuth.status, 401);
});
