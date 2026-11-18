/* eslint-disable no-undef */
'use strict';

/**
 * soldWelcomeEmail.test.js — pure/DB-stubbed unit coverage for
 * lib/soldWelcomeEmail.js (the automated "Welcome to the EC Construction
 * Group Family!" email sent when a lead's status enters 'Sold',
 * November 2026). See test/integration/soldWelcomeEmail.int.test.js for
 * real-Postgres coverage of the actual INSERT ... ON CONFLICT upsert.
 */
const test = require('node:test');
const assert = require('node:assert');

let queryImpl = async () => { throw new Error('unexpected query in test'); };
const dbPath = require.resolve('../db/client');
delete require.cache[dbPath];
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query: (...a) => queryImpl(...a) } };

delete require.cache[require.resolve('../lib/soldWelcomeEmail')];
const soldWelcomeEmail = require('../lib/soldWelcomeEmail');

function stub(modPath, exportsObj) {
  const p = require.resolve(modPath);
  const prev = require.cache[p];
  delete require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
  return () => { if (prev) require.cache[p] = prev; else delete require.cache[p]; };
}

function leadRow(overrides = {}) {
  return { id: 'lead-1', first_name: 'Jacqueline', last_name: 'Smith', email: 'jacqueline@example.com', status: 'Sold', ...overrides };
}

// ── isEnteringSoldStatus ─────────────────────────────────────────────────

test('isEnteringSoldStatus: fires only on the actual edge into Sold', () => {
  assert.strictEqual(soldWelcomeEmail.isEnteringSoldStatus('Appointment scheduled', 'Sold'), true);
  assert.strictEqual(soldWelcomeEmail.isEnteringSoldStatus(null, 'Sold'), true);
});

test('isEnteringSoldStatus: does not fire for a no-op edit while already Sold', () => {
  assert.strictEqual(soldWelcomeEmail.isEnteringSoldStatus('Sold', 'Sold'), false);
});

test('isEnteringSoldStatus: does not fire when leaving Sold', () => {
  assert.strictEqual(soldWelcomeEmail.isEnteringSoldStatus('Sold', 'Lost'), false);
});

test('isEnteringSoldStatus: does not fire for any other status pair', () => {
  assert.strictEqual(soldWelcomeEmail.isEnteringSoldStatus('Lost', 'DNQ'), false);
  assert.strictEqual(soldWelcomeEmail.isEnteringSoldStatus('New', 'Appointment scheduled'), false);
});

// ── isValidEmail ──────────────────────────────────────────────────────────

test('isValidEmail: accepts a plausible address, rejects missing/garbage', () => {
  assert.strictEqual(soldWelcomeEmail.isValidEmail('a@b.com'), true);
  assert.strictEqual(soldWelcomeEmail.isValidEmail(''), false);
  assert.strictEqual(soldWelcomeEmail.isValidEmail(null), false);
  assert.strictEqual(soldWelcomeEmail.isValidEmail('not-an-email'), false);
  assert.strictEqual(soldWelcomeEmail.isValidEmail('a@b'), false);
});

// ── autoTriggerEnabled ────────────────────────────────────────────────────

test('autoTriggerEnabled: off by default', () => {
  delete process.env.SOLD_WELCOME_EMAIL_ENABLED;
  assert.strictEqual(soldWelcomeEmail.autoTriggerEnabled(), false);
});

test('autoTriggerEnabled: true only for the exact string "true"', () => {
  process.env.SOLD_WELCOME_EMAIL_ENABLED = 'true';
  assert.strictEqual(soldWelcomeEmail.autoTriggerEnabled(), true);
  process.env.SOLD_WELCOME_EMAIL_ENABLED = 'yes';
  assert.strictEqual(soldWelcomeEmail.autoTriggerEnabled(), false);
  delete process.env.SOLD_WELCOME_EMAIL_ENABLED;
});

// ── handleLeadEnteringSold (automatic trigger) ───────────────────────────

test('handleLeadEnteringSold: feature disabled by default -> no-op, no DB/email calls at all', async () => {
  delete process.env.SOLD_WELCOME_EMAIL_ENABLED;
  queryImpl = async () => { throw new Error('must not query when feature disabled'); };
  const res = await soldWelcomeEmail.handleLeadEnteringSold(leadRow());
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.sent, false);
  assert.strictEqual(res.reason, 'feature_disabled');
});

// ── sendWelcomeEmailForLead: missing/invalid email (requirement #10) ────

test('sendWelcomeEmailForLead: no email on file -> records skipped_no_email, logs activity, notifies owner', async () => {
  const calls = [];
  queryImpl = async (sql, params) => {
    calls.push(sql);
    if (sql.includes('SELECT * FROM sold_welcome_emails')) return { rows: [] };
    if (sql.includes('INSERT INTO sold_welcome_emails')) {
      assert.strictEqual(params[2], 'skipped_no_email');
      return { rows: [{ id: 'rec-1', lead_id: params[0], status: 'skipped_no_email' }] };
    }
    if (sql.includes('INSERT INTO activities')) {
      assert.match(params[1], /no customer email address on file/);
      return { rows: [] };
    }
    if (sql.includes('LEFT JOIN owners')) return { rows: [{ id: 'lead-1', first_name: 'Jacqueline', owner_email: 'rep@ecconstructiongroup.com', owner_name: 'Rep' }] };
    throw new Error('unexpected query: ' + sql);
  };
  let sentTo = null;
  const restoreEmail = stub('../lib/emailService', {
    send: async ({ to }) => { sentTo = to; return { gmailMessageId: 'g1' }; },
    defaultSender: () => 'yaron@ecconstructiongroup.com',
  });
  try {
    const res = await soldWelcomeEmail.sendWelcomeEmailForLead(leadRow({ email: null }), { triggeredBy: 'cron' });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.skipped, 'no_email');
    assert.strictEqual(sentTo, 'rep@ecconstructiongroup.com');
  } finally { restoreEmail(); }
});

test('sendWelcomeEmailForLead: invalid email format -> records skipped_invalid_email, never attempts a send', async () => {
  queryImpl = async (sql, params) => {
    if (sql.includes('SELECT * FROM sold_welcome_emails')) return { rows: [] };
    if (sql.includes('INSERT INTO sold_welcome_emails')) {
      assert.strictEqual(params[2], 'skipped_invalid_email');
      return { rows: [{ id: 'rec-1', status: 'skipped_invalid_email' }] };
    }
    if (sql.includes('INSERT INTO activities')) return { rows: [] };
    if (sql.includes('LEFT JOIN owners')) return { rows: [{ id: 'lead-1', owner_email: null }] };
    throw new Error('unexpected query: ' + sql);
  };
  const restoreEmail = stub('../lib/emailService', {
    send: async () => { throw new Error('must never be called for an invalid email'); },
    defaultSender: () => 'yaron@ecconstructiongroup.com',
  });
  // No owner -> falls back to staff broadcast; stub both to a no-recipients
  // result so this test stays focused on "never sends the welcome email itself".
  const restoreRecipients = stub('../lib/notificationRecipients', { getAllStaffRecipients: async () => [] });
  const restorePrefs = stub('../lib/notificationPreferences', { CATEGORIES: { ACTIVITY: 'activity' }, filterRecipientsForCategory: async () => [] });
  try {
    const res = await soldWelcomeEmail.sendWelcomeEmailForLead(leadRow({ email: 'not-an-email' }));
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.skipped, 'invalid_email');
  } finally { restoreEmail(); restoreRecipients(); restorePrefs(); }
});

// ── sendWelcomeEmailForLead: successful send (requirements #2,#3,#4,#5,#8) ─

test('sendWelcomeEmailForLead: valid email -> sends the real template, correct fixed idempotency key, records sent + gmail id, notifies owner', async () => {
  let insertedFields = null;
  queryImpl = async (sql, params) => {
    if (sql.includes('SELECT * FROM sold_welcome_emails')) return { rows: [] };
    if (sql.includes('INSERT INTO sold_welcome_emails')) { insertedFields = params; return { rows: [{ id: 'rec-1', status: 'sent' }] }; }
    if (sql.includes('INSERT INTO activities')) return { rows: [] };
    if (sql.includes('LEFT JOIN owners')) return { rows: [{ id: 'lead-1', owner_email: 'rep@ecconstructiongroup.com' }] };
    if (sql.includes('UPDATE sold_welcome_emails SET owner_notified_at')) return { rows: [] };
    throw new Error('unexpected query: ' + sql);
  };
  let sendArgs = null;
  const restoreEmail = stub('../lib/emailService', {
    // The welcome email itself AND the owner-notify step both go through
    // this same stub — distinguish by subject so the owner-notify call
    // (fired after the welcome email, per the module's own sequencing)
    // never overwrites the captured welcome-email args.
    send: async (args) => {
      if (args.subject === 'Welcome to the EC Construction Group Family!') sendArgs = args;
      return { gmailMessageId: 'GMAIL-MSG-1', idempotent: false };
    },
    defaultSender: () => 'yaron@ecconstructiongroup.com',
  });
  try {
    const res = await soldWelcomeEmail.sendWelcomeEmailForLead(leadRow(), { triggeredBy: 'auto_sold_transition' });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.sent, true);
    assert.strictEqual(res.gmailMessageId, 'GMAIL-MSG-1');
    // requirement #7 — fixed per-lead idempotency key, never per-call.
    assert.strictEqual(sendArgs.idempotencyKey, 'sold-welcome:lead-1');
    assert.strictEqual(sendArgs.to, 'jacqueline@example.com');
    assert.strictEqual(sendArgs.subject, 'Welcome to the EC Construction Group Family!');
    assert.match(sendArgs.htmlBody, /Jacqueline/);
    assert.match(sendArgs.textBody, /Jacqueline/);
    assert.strictEqual(sendArgs.replyTo, 'yaron@ecconstructiongroup.com');
    // requirement #8 — audit record carries recipient/subject/body/key.
    assert.strictEqual(insertedFields[1], 'jacqueline@example.com');
    assert.strictEqual(insertedFields[2], 'sent');
    assert.strictEqual(insertedFields[5], 'sold-welcome:lead-1');
    assert.strictEqual(insertedFields[6], 'GMAIL-MSG-1');
  } finally { restoreEmail(); }
});

// ── sendWelcomeEmailForLead: already sent -> never resends (requirement #7) ─

test('sendWelcomeEmailForLead: a lead whose record already shows sent is a pure no-op — no email send, no DB write', async () => {
  queryImpl = async (sql) => {
    if (sql.includes('SELECT * FROM sold_welcome_emails')) return { rows: [{ id: 'rec-1', lead_id: 'lead-1', status: 'sent', gmail_message_id: 'GMAIL-MSG-1' }] };
    throw new Error('must not issue any further query once already sent: ' + sql);
  };
  const restoreEmail = stub('../lib/emailService', { send: async () => { throw new Error('must never send again'); } });
  try {
    const res = await soldWelcomeEmail.sendWelcomeEmailForLead(leadRow());
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.alreadySent, true);
    assert.strictEqual(res.record.status, 'sent');
  } finally { restoreEmail(); }
});

// ── sendWelcomeEmailForLead: retry/failure visibility (requirements #8,#11) ─

test('sendWelcomeEmailForLead: a send failure (after emailService\'s own bounded retries) is recorded as failed and the owner is notified of the failure', async () => {
  let insertedStatus = null;
  queryImpl = async (sql, params) => {
    if (sql.includes('SELECT * FROM sold_welcome_emails')) return { rows: [] };
    if (sql.includes('INSERT INTO sold_welcome_emails')) { insertedStatus = params[2]; return { rows: [{ id: 'rec-1', status: 'failed' }] }; }
    if (sql.includes('INSERT INTO activities')) {
      assert.match(params[1], /FAILED/);
      return { rows: [] };
    }
    if (sql.includes('LEFT JOIN owners')) return { rows: [{ id: 'lead-1', owner_email: 'rep@ecconstructiongroup.com' }] };
    throw new Error('unexpected query: ' + sql);
  };
  let failureNotifySubject = null;
  const restoreEmail = stub('../lib/emailService', {
    send: async ({ to, subject }) => {
      if (subject && subject.startsWith('Welcome email FAILED')) { failureNotifySubject = subject; return { gmailMessageId: 'g2' }; }
      throw new Error('Gmail down after retries');
    },
    defaultSender: () => 'yaron@ecconstructiongroup.com',
  });
  try {
    const res = await soldWelcomeEmail.sendWelcomeEmailForLead(leadRow());
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.failed, true);
    assert.strictEqual(insertedStatus, 'failed');
    assert.match(failureNotifySubject, /Jacqueline/);
  } finally { restoreEmail(); }
});

// ── never throws ──────────────────────────────────────────────────────────

test('sendWelcomeEmailForLead: never throws even when the owner-lookup query itself fails', async () => {
  queryImpl = async (sql) => {
    if (sql.includes('SELECT * FROM sold_welcome_emails')) return { rows: [] };
    if (sql.includes('INSERT INTO sold_welcome_emails')) return { rows: [{ id: 'rec-1', status: 'sent' }] };
    if (sql.includes('INSERT INTO activities')) return { rows: [] };
    if (sql.includes('LEFT JOIN owners')) throw new Error('db down');
    throw new Error('unexpected query: ' + sql);
  };
  const restoreEmail = stub('../lib/emailService', {
    send: async () => ({ gmailMessageId: 'g1', idempotent: false }),
    defaultSender: () => 'yaron@ecconstructiongroup.com',
  });
  try {
    const res = await soldWelcomeEmail.sendWelcomeEmailForLead(leadRow());
    assert.strictEqual(res.ok, true); // the send itself still succeeded; only the owner-notify step failed (non-fatal)
  } finally { restoreEmail(); }
});

// ── source-level wiring (routes/leads.js) ────────────────────────────────

test('source-level: routes/leads.js wires isEnteringSoldStatus + handleLeadEnteringSold on BOTH write paths (PUT /:id and PUT /by-external/:externalRef)', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../routes/leads.js'), 'utf8');
  const occurrences = (re) => (source.match(re) || []).length;
  assert.strictEqual(occurrences(/isEnteringSoldStatus\(/g), 2, 'expected the edge check on both write paths');
  assert.strictEqual(occurrences(/handleLeadEnteringSold\(/g), 2, 'expected the automatic trigger call on both write paths');
  assert.ok(source.includes("require('../lib/soldWelcomeEmail')"));
});
