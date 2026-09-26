/* eslint-disable no-undef */
'use strict';

/**
 * leadIntakeConcurrency.int.test.js — REAL-Postgres concurrency regression for
 * lead intake (public capture / CRM New Lead, website → CRM receiver, admin
 * create). Runs only with TEST_DATABASE_URL (a disposable database); skipped
 * otherwise.
 *
 * PRODUCTION DEFECT reproduced here: PostgreSQL "deadlock detected" →
 * "Submission failed" (HTTP 500) on simultaneous submissions. Root cause: every
 * process re-executed db/schema.sql (60+ ALTER TABLE / CREATE INDEX) on first
 * use — including the reminder worker, a cron that starts a fresh process every
 * 15 minutes — and ALTER TABLE takes an AccessExclusiveLock even when "IF NOT
 * EXISTS" makes it a no-op. Cycle observed in the Postgres log:
 *   DDL session:     holds reminder_leads → waits AccessExclusiveLock(owners)
 *   intake tx:       holds owners (owner resolution) → waits RowExclusiveLock(reminder_leads)
 *                    (the reminder projection INSERT)
 * Also covered: same-person / same-idempotency-key submissions racing past
 * duplicate detection (nothing to SELECT … FOR UPDATE yet) and the owners.email
 * UNIQUE race on a brand-new owner.
 *
 * Everything is fired genuinely in parallel (Promise.all over HTTP, a pool large
 * enough for real overlap, plus separate worker-like processes calling
 * ensureSchema() at the same moment). Nothing here is serialized.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable Postgres)' : false;
const ROOT = path.join(__dirname, '..', '..');
const SECRET = 'int-test-website-secret';

if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
  process.env.DB_POOL_MAX = '25';
  process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'int-test-secret-int-test-secret-0123456789';
  process.env.WEBSITE_LEAD_WEBHOOK_SECRET = SECRET;
}

// ── Fakes at the external boundaries (Google Calendar / Maps, alert email) ───
const alerts = [];
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
}

let base, server, db, adminToken;
let ipSeq = 1;
const RUN = `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

async function http(method, url, body, headers = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `10.9.${Math.floor(ipSeq / 250) % 250}.${(ipSeq++ % 250) + 1}`,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { status: res.status, body: json };
}

let phoneSeq = 0;
function uniquePhone() {
  phoneSeq++;
  return `424${String((Date.now() % 1e5) * 13 + phoneSeq * 104729).slice(-7).padStart(7, '0')}`;
}

// A burst of worker-like processes whose first act is ensureSchema() — exactly
// what the reminder worker cron does every 15 minutes in production.
function workerTick() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e',
      "require('./db/client').ensureSchema().then(()=>process.exit(0),e=>{console.error('ensureSchema:',e.message);process.exit(1)})"],
    { cwd: ROOT, env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', d => { err += d; });
    child.on('exit', code => resolve({ code, err }));
  });
}

async function deadlockCount() {
  // pg_stat counters are flushed asynchronously; wait for the flush window.
  await new Promise(r => setTimeout(r, 1200));
  await db.query('SELECT pg_stat_clear_snapshot()');
  return Number((await db.query('SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()')).rows[0].deadlocks);
}

async function leadsByLast(last) {
  return (await db.query('SELECT * FROM leads WHERE last_name = $1 ORDER BY created_at', [last])).rows;
}

async function sideEffects(leadIds) {
  const q = async (sql) => Number((await db.query(sql, [leadIds])).rows[0].n);
  return {
    appointments: await q('SELECT count(*) n FROM appointments WHERE lead_id = ANY($1::uuid[])'),
    outbox: await q('SELECT count(*) n FROM calendar_outbox o JOIN appointments a ON a.id = o.appointment_id WHERE a.lead_id = ANY($1::uuid[])'),
    followUps: await q('SELECT count(*) n FROM leads WHERE id = ANY($1::uuid[]) AND follow_up_date IS NOT NULL'),
    reminderClaims: await q(`SELECT count(*) n FROM reminder_claims WHERE lead_id IN (SELECT COALESCE(external_ref, id::text) FROM leads WHERE id = ANY($1::uuid[]))`),
    contacts: await q('SELECT count(*) n FROM google_contacts_outbox WHERE lead_id = ANY($1::uuid[])'),
  };
}

test.before(async () => {
  if (skip) return;
  // Deploy-time step (API start command): migrations + base schema, which
  // records the base-schema checksum so runtime ensureSchema() is a SELECT.
  execFileSync(process.execPath, ['db/migrate.js'], { cwd: ROOT, env: process.env, stdio: 'ignore' });
  const express = require('express');
  db = require(path.join(ROOT, 'db/client'));
  const { issueAccessToken } = require(path.join(ROOT, 'lib/authService'));
  await db.query(`INSERT INTO owners (email, display_name) VALUES ('yaron@ecconstructiongroup.com', 'Yaron Drilevich') ON CONFLICT DO NOTHING`);
  // Created by the calendar/contacts outbox worker at its startup in production.
  await require(path.join(ROOT, 'lib/googleContactsOutbox')).ensureContactsOutbox(db.pool);
  adminToken = issueAccessToken({ id: '00000000-0000-0000-0000-0000000000a1', email: 'yaron@ecconstructiongroup.com', role: 'admin' });
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/v1/leads', require(path.join(ROOT, 'routes/leads')));
  app.use('/api/public/capture', require(path.join(ROOT, 'routes/publicCapture')));
  app.use('/api/v1/website-leads', require(path.join(ROOT, 'routes/websiteLeads')).defaultRouter());
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (skip) return;
  server.close();
  await db.pool.end();
});

test('C0. runtime ensureSchema() takes no DDL locks once the base schema is recorded', { skip }, async () => {
  const r = await db.query(`SELECT checksum FROM schema_migrations WHERE filename = '__base_schema__'`);
  assert.ok(r.rows[0] && r.rows[0].checksum, 'db/migrate.js records the base-schema checksum');
  const ticks = await Promise.all(Array.from({ length: 4 }, workerTick));
  assert.deepStrictEqual(ticks.map(t => t.code), [0, 0, 0, 0], ticks.map(t => t.err).join('\n'));
});

test('C1. unique leads submitted simultaneously (capture + website + admin) while worker ticks run ensureSchema', { skip }, async () => {
  const before = await deadlockCount();
  const last = `Uniq${RUN}`;
  const capture = Array.from({ length: 10 }, (_, i) => http('POST', '/api/public/capture', {
    first_name: `Cap${i}`, last_name: last, phone: uniquePhone(), email: `cap${i}.${RUN}@example.com`,
    project_type: 'Kitchen', source: 'Referral', assigned_rep: 'Yaron Drilevich', message: `hello ${i}`,
  }));
  const website = Array.from({ length: 8 }, (_, i) => http('POST', '/api/v1/website-leads', {
    id: `${RUN}-u${i}`, full_name: `Web${i} ${last}`, email: `web${i}.${RUN}@example.com`, phone: uniquePhone(),
    message: `site ${i}`, consent_sms: i % 2 === 0, consent_sms_disclosure_version: 'sms-consent-v1-2026-09',
  }, { 'x-webhook-secret': SECRET, 'idempotency-key': `ec-website-lead-${RUN}-u${i}` }));
  const admin = Array.from({ length: 6 }, (_, i) => http('POST', '/api/v1/leads', {
    first_name: `Adm${i}`, last_name: last, phone: uniquePhone(), email: `adm${i}.${RUN}@example.com`,
    assigned_rep: 'Yaron Drilevich', source: 'Referral',
  }, { authorization: 'Bearer ' + adminToken }));
  const [results, ticks] = await Promise.all([
    Promise.all([...capture, ...website, ...admin]),
    Promise.all(Array.from({ length: 3 }, workerTick)),
  ]);

  assert.deepStrictEqual(results.filter(r => r.status !== 201).map(r => [r.status, r.body]), [], 'every unique submission succeeds');
  assert.deepStrictEqual(ticks.map(t => t.code), [0, 0, 0], ticks.map(t => t.err).join('\n'));
  const leads = await leadsByLast(last);
  assert.strictEqual(leads.length, 24, 'no lost and no duplicated lead');
  assert.strictEqual(new Set(leads.map(l => l.phone)).size, 24);

  // No partial records: every post-commit step completed for every lead.
  const web = leads.filter(l => l.first_name.startsWith('Web'));
  assert.ok(web.every(l => l.is_new_intake_lead === true && l.source === 'Website'));
  for (const l of web) {
    const i = Number(l.first_name.slice(3));
    assert.strictEqual(l.sms_consent, i % 2 === 0, 'SMS consent attached to the correct lead');
    assert.strictEqual(l.email, `web${i}.${RUN}@example.com`);
  }
  const receipts = (await db.query(`SELECT * FROM website_lead_receipts WHERE external_ref LIKE $1`, [`ec-website-lead-${RUN}-u%`])).rows;
  assert.strictEqual(receipts.length, 8, 'exactly one receipt per delivery');
  assert.ok(receipts.every(r => r.completed_at && r.action === 'created'));
  assert.strictEqual(new Set(receipts.map(r => r.lead_id)).size, 8);
  const cap = leads.filter(l => l.first_name.startsWith('Cap'));
  assert.ok(cap.every(l => l.record_type === 'Lead' && l.is_new_intake_lead === true));

  // Notes on the right lead, and no orphan activities.
  const acts = (await db.query('SELECT a.lead_id, a.content FROM activities a WHERE a.lead_id = ANY($1::uuid[])', [leads.map(l => l.id)])).rows;
  for (const l of cap) {
    const i = l.first_name.slice(3);
    assert.ok(acts.some(a => a.lead_id === l.id && a.content === `hello ${i}`), `capture note on ${l.first_name}`);
  }
  for (const l of web) {
    const i = l.first_name.slice(3);
    assert.ok(acts.some(a => a.lead_id === l.id && a.content.includes(`Message: site ${i}`)), `website note on ${l.first_name}`);
  }
  const orphans = await db.query('SELECT count(*)::int n FROM activities a LEFT JOIN leads l ON l.id = a.lead_id WHERE a.lead_id IS NOT NULL AND l.id IS NULL');
  assert.strictEqual(orphans.rows[0].n, 0);

  // Nothing appointment-shaped was invented.
  const fx = await sideEffects(leads.map(l => l.id));
  assert.deepStrictEqual({ ...fx, contacts: undefined }, { appointments: 0, outbox: 0, followUps: 0, reminderClaims: 0, contacts: undefined });
  assert.strictEqual(fx.contacts, 24, 'one Google Contacts sync per new lead, none extra');
  assert.strictEqual(await deadlockCount() - before, 0, 'zero PostgreSQL deadlocks');
});

test('C2. the same website delivery arriving simultaneously produces exactly one lead', { skip }, async () => {
  const before = await deadlockCount();
  const ref = `ec-website-lead-${RUN}-same`;
  const body = {
    id: `${RUN}-same`, full_name: `Replay ${RUN}`, email: `replay.${RUN}@example.com`, phone: uniquePhone(),
    message: 'only once', consent_sms: true, consent_sms_disclosure_version: 'sms-consent-v1-2026-09',
  };
  const alertsBefore = alerts.length;
  const results = await Promise.all(Array.from({ length: 10 }, () =>
    http('POST', '/api/v1/website-leads', body, { 'x-webhook-secret': SECRET, 'idempotency-key': ref })));
  assert.deepStrictEqual(results.filter(r => r.status >= 500), [], 'no 500');
  // Designed contract: one creates; a concurrent duplicate is 409 in_progress (the
  // website retries it) or, once completed, 200 duplicate_delivery.
  assert.strictEqual(results.filter(r => r.status === 201).length, 1);
  assert.ok(results.every(r => r.status === 201 || (r.status === 409 && r.body.error === 'in_progress') || (r.status === 200 && r.body.duplicate_delivery)));
  const replay = await http('POST', '/api/v1/website-leads', body, { 'x-webhook-secret': SECRET, 'idempotency-key': ref });
  assert.strictEqual(replay.status, 200);
  assert.strictEqual(replay.body.duplicate_delivery, true);

  const leads = await leadsByLast(RUN);
  const mine = leads.filter(l => l.first_name === 'Replay');
  assert.strictEqual(mine.length, 1, 'idempotent replay → exactly one lead');
  assert.strictEqual(mine[0].sms_consent, true);
  const receipts = (await db.query('SELECT * FROM website_lead_receipts WHERE external_ref = $1', [ref])).rows;
  assert.strictEqual(receipts.length, 1);
  assert.strictEqual(receipts[0].lead_id, mine[0].id);
  const notes = (await db.query(`SELECT count(*)::int n FROM activities WHERE lead_id = $1 AND content LIKE '%Message: only once%'`, [mine[0].id])).rows[0].n;
  assert.strictEqual(notes, 1, 'the inquiry note is written once');
  assert.strictEqual(alerts.length - alertsBefore, 1, 'one new-lead alert');
  const fx = await sideEffects([mine[0].id]);
  assert.deepStrictEqual(fx, { appointments: 0, outbox: 0, followUps: 0, reminderClaims: 0, contacts: 1 });
  assert.strictEqual(await deadlockCount() - before, 0);
});

test('C3. the same public-capture booking submitted simultaneously → one lead, one appointment, idempotent replays', { skip }, async () => {
  const before = await deadlockCount();
  const day = new Date(Date.UTC(2034, 0, 3 + Math.floor(Math.random() * 3000) * 3)).toISOString().slice(0, 10);
  const body = {
    first_name: 'Booker', last_name: `Same${RUN}`, phone: uniquePhone(), email: `booker.${RUN}@example.com`,
    project_type: 'Kitchen', source: 'Referral', assigned_rep: 'Yaron Drilevich',
    appointment_date: day, appointment_time: '10:00',
  };
  const results = await Promise.all(Array.from({ length: 8 }, () => http('POST', '/api/public/capture', body)));
  assert.deepStrictEqual(results.filter(r => r.status >= 500), [], JSON.stringify(results.map(r => r.body)));
  assert.strictEqual(results.filter(r => r.status === 201).length, 1);
  assert.ok(results.every(r => r.status === 201 || (r.status === 200 && r.body.idempotent === true)),
    JSON.stringify(results.map(r => [r.status, r.body && r.body.error])));
  const leads = await leadsByLast(`Same${RUN}`);
  assert.strictEqual(leads.length, 1);
  const fx = await sideEffects([leads[0].id]);
  assert.strictEqual(fx.appointments, 1, 'exactly the one requested appointment');
  assert.strictEqual(fx.outbox, 2, 'one main + one travel calendar job for that appointment only');
  assert.strictEqual(fx.followUps, 0);
  assert.strictEqual(await deadlockCount() - before, 0);
});

test('C4. same person via different deliveries / paths at once → one lead; notes and SMS consent on it', { skip }, async () => {
  const before = await deadlockCount();
  const phone = uniquePhone();
  const email = `same.person.${RUN}@example.com`;
  const last = `Person${RUN}`;
  const website = Array.from({ length: 5 }, (_, i) => http('POST', '/api/v1/website-leads', {
    id: `${RUN}-p${i}`, first_name: 'Dana', last_name: last, email, phone, message: `inquiry ${i}`,
    consent_sms: true, consent_sms_disclosure_version: 'sms-consent-v1-2026-09',
  }, { 'x-webhook-secret': SECRET, 'idempotency-key': `ec-website-lead-${RUN}-p${i}` }));
  const capture = Array.from({ length: 3 }, () => http('POST', '/api/public/capture', {
    first_name: 'Dana', last_name: last, phone, email, project_type: 'Kitchen', source: 'Referral', assigned_rep: 'Yaron Drilevich',
  }));
  const results = await Promise.all([...website, ...capture]);
  assert.deepStrictEqual(results.filter(r => r.status >= 500), [], JSON.stringify(results.map(r => r.body)));
  const leads = await leadsByLast(last);
  assert.strictEqual(leads.length, 1, 'duplicate protection holds under concurrency');
  const lead = leads[0];
  assert.strictEqual(lead.sms_consent, true, 'consent recorded on the one lead');
  const w = results.slice(0, 5);
  assert.strictEqual(w.filter(r => r.status === 201).length + results.slice(5).filter(r => r.status === 201).length, 1, 'exactly one creation');
  assert.ok(w.every(r => r.body.id === lead.id), 'every website delivery resolved to that lead');
  const receipts = (await db.query(`SELECT * FROM website_lead_receipts WHERE external_ref LIKE $1`, [`ec-website-lead-${RUN}-p%`])).rows;
  assert.strictEqual(receipts.length, 5);
  assert.ok(receipts.every(r => r.completed_at && r.lead_id === lead.id));
  const notes = (await db.query(`SELECT content FROM activities WHERE lead_id = $1`, [lead.id])).rows.map(r => r.content).join('\n');
  for (let i = 0; i < 5; i++) assert.ok(notes.includes(`inquiry ${i}`), `inquiry ${i} kept on the lead`);
  const fx = await sideEffects([lead.id]);
  assert.deepStrictEqual(fx, { appointments: 0, outbox: 0, followUps: 0, reminderClaims: 0, contacts: 1 });
  assert.strictEqual(await deadlockCount() - before, 0);
});

test('C5. same phone, different names at once → one lead + potential-duplicate review (never merged, never duplicated)', { skip }, async () => {
  const phone = uniquePhone();
  const last = `Twin${RUN}`;
  const results = await Promise.all(['Ann', 'Bob', 'Cy', 'Di'].map(first => http('POST', '/api/public/capture', {
    first_name: first, last_name: last, phone, project_type: 'Kitchen', source: 'Referral', assigned_rep: 'Yaron Drilevich',
  })));
  assert.deepStrictEqual(results.filter(r => r.status >= 500), []);
  assert.strictEqual(results.filter(r => r.status === 201).length, 1);
  assert.strictEqual(results.filter(r => r.status === 409 && r.body.error === 'potential_duplicate').length, 3);
  assert.strictEqual((await leadsByLast(last)).length, 1);
});

test('C6. admin create of the same email at once → exactly one lead, the rest 409 duplicate_email', { skip }, async () => {
  const email = `admin.same.${RUN}@example.com`;
  const last = `AdminDup${RUN}`;
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => http('POST', '/api/v1/leads', {
    first_name: `A${i}`, last_name: last, email, phone: uniquePhone(), assigned_rep: 'Yaron Drilevich', source: 'Referral',
  }, { authorization: 'Bearer ' + adminToken })));
  assert.deepStrictEqual(results.filter(r => r.status >= 500), []);
  assert.strictEqual(results.filter(r => r.status === 201).length, 1);
  assert.strictEqual(results.filter(r => r.status === 409 && r.body.error === 'duplicate_email').length, 5);
  assert.strictEqual((await leadsByLast(last)).length, 1);
});

test('C7. a brand-new owner used by simultaneous submissions is created once (owners.email UNIQUE race)', { skip }, async () => {
  const ownerEmail = `new.owner.${RUN}@ecconstructiongroup.com`;
  const { createBooking } = require(path.join(ROOT, 'lib/booking/bookingService'));
  const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => createBooking({
    idempotency_key: `owner-race-${RUN}-${i}`, owner_email: ownerEmail, owner_display_name: 'New Owner',
    first_name: `Own${i}`, last_name: `OwnerRace${RUN}`, phone: uniquePhone(), actor: 'test',
  })));
  assert.deepStrictEqual(results.filter(r => r.status === 'rejected').map(r => r.reason && r.reason.message), []);
  const owners = (await db.query('SELECT id FROM owners WHERE lower(email) = lower($1)', [ownerEmail])).rows;
  assert.strictEqual(owners.length, 1);
  assert.strictEqual((await leadsByLast(`OwnerRace${RUN}`)).filter(l => l.owner_id === owners[0].id).length, 6);
});

test('C8. the exact logged cycle: an intake tx holding owners + a worker tick\'s ensureSchema() → no deadlock', { skip }, async () => {
  // Intake transaction A has read owners (owner resolution) and is about to
  // write reminder_leads (the reminder projection) — the production lock state.
  const a = await db.pool.connect();
  let child;
  try {
    await a.query('BEGIN');
    await a.query('SELECT id FROM owners LIMIT 1');
    // A worker process starts (cron tick) and runs ensureSchema(). Before the
    // fix this re-ran schema.sql: it locked reminder_leads, then queued for an
    // AccessExclusiveLock on owners behind A.
    child = workerTick();
    const deadline = Date.now() + 8000;
    let ddlWaiting = false;
    let exited = false;
    child.then(() => { exited = true; });
    while (!exited && Date.now() < deadline) {
      const w = await db.query(
        `SELECT 1 FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
          WHERE c.relname = 'owners' AND l.mode = 'AccessExclusiveLock' AND NOT l.granted`);
      if (w.rows.length) { ddlWaiting = true; break; }
      await new Promise(r => setTimeout(r, 50));
    }
    assert.strictEqual(ddlWaiting, false, 'a worker tick must never queue DDL on owners behind live intake');
    // A now writes reminder_leads. With DDL holding it this is the deadlock.
    await a.query('UPDATE reminder_leads SET notes = notes WHERE false');
    await a.query('COMMIT');
  } catch (e) {
    await a.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    a.release();
  }
  const tick = await child;
  assert.strictEqual(tick.code, 0, tick.err);
});
