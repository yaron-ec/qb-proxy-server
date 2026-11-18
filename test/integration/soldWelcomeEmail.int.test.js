/* eslint-disable no-undef */
'use strict';

/**
 * soldWelcomeEmail.int.test.js — REAL-Postgres proof of the Sold-customer
 * welcome email's actual SQL (the UNIQUE(lead_id) + ON CONFLICT ... WHERE
 * status IS DISTINCT FROM 'sent' upsert in lib/soldWelcomeEmail.js, applied
 * by db/migrations/2026-76-sold-welcome-email.sql) — the thing a DB-stubbed
 * unit test (test/soldWelcomeEmail.test.js) cannot verify on its own.
 *
 * lib/emailService.js is stubbed (no live Gmail network calls), but every
 * other piece — the real migrated schema, the real leads/activities/owners
 * tables, the real upsert SQL — runs against a real, disposable Postgres
 * instance.
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
}

function stubModule(relPath, exportsObj) {
  const p = require.resolve(path.join(ROOT, relPath));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}

let db, soldWelcomeEmail;
let sentEmails = [];
let forceFail = false;
const RUN = `swe${Date.now().toString(36)}`;

async function makeOwner({ email } = {}) {
  const r = await db.query(
    `INSERT INTO owners (display_name, email) VALUES ($1, $2) RETURNING id`,
    [`Rep ${RUN}`, email === undefined ? `rep-${RUN}-${Math.random().toString(36).slice(2, 8)}@ecconstructiongroup.com` : email]
  );
  return r.rows[0].id;
}

// leads.owner_id is NOT NULL in this schema, so a lead always has SOME
// owner row — a lead with "no assigned rep" in practice is represented by
// that owner row itself having no email on file (owners.email is
// nullable), which is what resolveLeadWithOwner's `if (lead.owner_email)`
// branch actually tests.
let defaultOwnerId;
async function makeLead({ email, ownerId } = {}) {
  const resolvedOwnerId = ownerId || defaultOwnerId;
  const r = await db.query(
    `INSERT INTO leads (first_name, last_name, owner_id, status, phone, email, created_at)
     VALUES ('Jacqueline', $1, $2, 'Appointment scheduled', $3, $4, '2099-01-01') RETURNING id`,
    [RUN, resolvedOwnerId, `310${Math.floor(1000000 + Math.random() * 8999999)}`, email]
  );
  return r.rows[0].id;
}

test.before(async () => {
  if (skip) return;
  db = require(path.join(ROOT, 'db/client'));
  stubModule('lib/emailService', {
    send: async (msg) => {
      if (forceFail) throw new Error('simulated send failure');
      sentEmails.push(msg);
      return { ok: true, gmailMessageId: `m${sentEmails.length}`, idempotent: false };
    },
    defaultSender: () => 'yaron@ecconstructiongroup.com',
  });
  delete require.cache[require.resolve(path.join(ROOT, 'lib/soldWelcomeEmail'))];
  soldWelcomeEmail = require(path.join(ROOT, 'lib/soldWelcomeEmail'));
  defaultOwnerId = await makeOwner();

  // A fresh disposable DB has zero company_settings rows (unlike a real
  // deployment, where one always exists) — company_settings is this
  // codebase's unscoped singleton (see CLAUDE.md "Database safety"), so
  // seed exactly one, using the column's own real default
  // notification_recipients (michelle 'to' / yaron 'cc') so the
  // Michelle-exclusion assertion below exercises real, representative data.
  const { rows: existing } = await db.query(`SELECT id FROM company_settings LIMIT 1`);
  if (!existing.length) {
    await db.query(`INSERT INTO company_settings (company_name) VALUES ($1)`, [`Test Co ${RUN}`]);
  }
});

test.beforeEach(() => { sentEmails = []; forceFail = false; });

test('sendWelcomeEmailForLead: real send against a real lead row — creates exactly one sold_welcome_emails row, status sent, activity note, owner notified', { skip }, async () => {
  const ownerId = await makeOwner();
  const leadId = await makeLead({ email: `jacqueline-${RUN}@example.com`, ownerId });
  const { rows: [lead] } = await db.query(`SELECT * FROM leads WHERE id = $1`, [leadId]);

  const res = await soldWelcomeEmail.sendWelcomeEmailForLead(lead, { triggeredBy: 'test' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.sent, true);

  const { rows } = await db.query(`SELECT * FROM sold_welcome_emails WHERE lead_id = $1`, [leadId]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].status, 'sent');
  assert.strictEqual(rows[0].recipient_email, `jacqueline-${RUN}@example.com`);
  assert.ok(rows[0].gmail_message_id);
  assert.ok(rows[0].sent_at);
  assert.ok(rows[0].owner_notified_at, 'owner_notified_at should be set once the owner-notify email succeeds');

  const { rows: activities } = await db.query(`SELECT * FROM activities WHERE lead_id = $1 ORDER BY created_at DESC`, [leadId]);
  assert.ok(activities.some((a) => a.content.includes('Welcome email sent to')));

  // Two sends happened: the welcome email itself + the owner notification.
  assert.strictEqual(sentEmails.length, 2);
  assert.strictEqual(sentEmails[0].subject, 'Welcome to the EC Construction Group Family!');
  assert.strictEqual(sentEmails[0].to, `jacqueline-${RUN}@example.com`);
  assert.strictEqual(sentEmails[0].idempotencyKey, `sold-welcome:${leadId}`);
});

test('sendWelcomeEmailForLead: UNIQUE(lead_id) real constraint — a second call for the SAME lead never creates a second row, never re-sends', { skip }, async () => {
  const leadId = await makeLead({ email: `once-${RUN}@example.com` });
  const { rows: [lead] } = await db.query(`SELECT * FROM leads WHERE id = $1`, [leadId]);

  const res1 = await soldWelcomeEmail.sendWelcomeEmailForLead(lead);
  assert.strictEqual(res1.sent, true);
  const countAfterFirst = sentEmails.filter((m) => m.to === `once-${RUN}@example.com`).length;
  assert.strictEqual(countAfterFirst, 1);

  // Simulate "reopened and returned to Sold" — call again for the same lead.
  const res2 = await soldWelcomeEmail.sendWelcomeEmailForLead(lead);
  assert.strictEqual(res2.alreadySent, true);
  const countAfterSecond = sentEmails.filter((m) => m.to === `once-${RUN}@example.com`).length;
  assert.strictEqual(countAfterSecond, 1, 'the welcome email must never be sent a second time for the same lead');

  const { rows } = await db.query(`SELECT * FROM sold_welcome_emails WHERE lead_id = $1`, [leadId]);
  assert.strictEqual(rows.length, 1, 'exactly one row must exist — the UNIQUE(lead_id) constraint, not application logic alone, guarantees this');
});

test('sendWelcomeEmailForLead: missing email -> real skipped_no_email row, no send attempted; later re-entry WITH a valid email now sends (not a terminal skip)', { skip }, async () => {
  const leadId = await makeLead({ email: null });
  const { rows: [lead] } = await db.query(`SELECT * FROM leads WHERE id = $1`, [leadId]);

  const res1 = await soldWelcomeEmail.sendWelcomeEmailForLead(lead);
  assert.strictEqual(res1.skipped, 'no_email');
  // The welcome email itself must never be sent — the owner-notify email
  // explaining the skip is a separate, expected send (requirement #10).
  assert.strictEqual(sentEmails.filter((m) => m.subject === 'Welcome to the EC Construction Group Family!').length, 0);
  assert.ok(sentEmails.some((m) => m.subject && m.subject.includes('Welcome email NOT sent')));

  const { rows: row1 } = await db.query(`SELECT * FROM sold_welcome_emails WHERE lead_id = $1`, [leadId]);
  assert.strictEqual(row1[0].status, 'skipped_no_email');

  // Email added later, lead re-enters Sold — this is a genuine first real
  // opportunity to welcome them, so it DOES send (unlike a 'sent' row).
  await db.query(`UPDATE leads SET email = $2 WHERE id = $1`, [leadId, `added-later-${RUN}@example.com`]);
  const { rows: [leadNow] } = await db.query(`SELECT * FROM leads WHERE id = $1`, [leadId]);
  const res2 = await soldWelcomeEmail.sendWelcomeEmailForLead(leadNow);
  assert.strictEqual(res2.sent, true);
  assert.strictEqual(sentEmails.filter((m) => m.to === `added-later-${RUN}@example.com`).length, 1);

  const { rows: row2 } = await db.query(`SELECT * FROM sold_welcome_emails WHERE lead_id = $1`, [leadId]);
  assert.strictEqual(row2.length, 1, 'still exactly one row for the lead — the upsert updated it in place');
  assert.strictEqual(row2[0].status, 'sent');
});

test('sendWelcomeEmailForLead: a real send failure records status failed with the error, and a later retry after the failure succeeds', { skip }, async () => {
  const leadId = await makeLead({ email: `retry-${RUN}@example.com` });
  const { rows: [lead] } = await db.query(`SELECT * FROM leads WHERE id = $1`, [leadId]);

  forceFail = true;
  const res1 = await soldWelcomeEmail.sendWelcomeEmailForLead(lead);
  assert.strictEqual(res1.failed, true);
  const { rows: row1 } = await db.query(`SELECT * FROM sold_welcome_emails WHERE lead_id = $1`, [leadId]);
  assert.strictEqual(row1[0].status, 'failed');
  assert.match(row1[0].error_message, /simulated send failure/);

  forceFail = false;
  const res2 = await soldWelcomeEmail.sendWelcomeEmailForLead(lead);
  assert.strictEqual(res2.sent, true);
  const { rows: row2 } = await db.query(`SELECT * FROM sold_welcome_emails WHERE lead_id = $1`, [leadId]);
  assert.strictEqual(row2.length, 1);
  assert.strictEqual(row2[0].status, 'sent');
});

test('sendWelcomeEmailForLead: owner has no email on file -> falls back to the real staff ACTIVITY broadcast (Michelle correctly excluded by her real seeded single-category policy)', { skip }, async () => {
  const ownerNoEmailId = await makeOwner({ email: null });
  const leadId = await makeLead({ email: `noowner-${RUN}@example.com`, ownerId: ownerNoEmailId });
  const { rows: [lead] } = await db.query(`SELECT * FROM leads WHERE id = $1`, [leadId]);

  const res = await soldWelcomeEmail.sendWelcomeEmailForLead(lead);
  assert.strictEqual(res.sent, true);

  const notifyEmails = sentEmails.filter((m) => m.subject && m.subject.startsWith('Welcome email sent'));
  assert.ok(notifyEmails.length >= 1, 'expected at least one staff-broadcast notify email');
  const recipients = notifyEmails.map((m) => m.to);
  assert.ok(!recipients.includes('michelle@ecconstructiongroup.com'), "Michelle's real seeded single-category policy must exclude her from this broadcast");
});

test('isEnteringSoldStatus + handleLeadEnteringSold: feature gate is a real no-op end to end against the real DB (no row ever created while disabled)', { skip }, async () => {
  delete process.env.SOLD_WELCOME_EMAIL_ENABLED;
  const leadId = await makeLead({ email: `gated-${RUN}@example.com` });
  const { rows: [lead] } = await db.query(`SELECT * FROM leads WHERE id = $1`, [leadId]);

  const res = await soldWelcomeEmail.handleLeadEnteringSold(lead);
  assert.strictEqual(res.sent, false);
  assert.strictEqual(res.reason, 'feature_disabled');

  const { rows } = await db.query(`SELECT * FROM sold_welcome_emails WHERE lead_id = $1`, [leadId]);
  assert.strictEqual(rows.length, 0, 'no audit row should ever be created while the automatic trigger is disabled');
  assert.strictEqual(sentEmails.length, 0);
});
