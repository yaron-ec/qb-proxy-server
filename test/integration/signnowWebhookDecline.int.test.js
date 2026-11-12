/* eslint-disable no-undef */
'use strict';

/**
 * signnowWebhookDecline.int.test.js — REAL-Postgres proof of the November
 * 2026 CRM hardening fix to routes/signnowWebhook.js: the
 * `document.fieldinvite.decline` event was already named in this file's own
 * header comment ("invite declined (not a completion)") but had NO handling
 * branch at all — it silently fell into the no-op "Ignoring non-completion
 * event" path, leaving signnow_documents stuck at its prior status with no
 * record anywhere that the signer declined.
 *
 * Fixed: a decline event now sets signnow_documents.status = 'declined'
 * (a new, additive CHECK-constraint value — db/migrations/
 * 2026-73-signnow-declined-status.sql), writes an activities note, and
 * emails staff + the lead owner (reusing the CONTRACT_SIGNED notification
 * category — a decline is exactly as actionable to a rep as a signing).
 *
 * Stubs lib/emailService entirely (never sends a real email). Skipped
 * without TEST_DATABASE_URL.
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

let base, server, db, leadId, ownerEmail, emailCalls;

if (DB_URL) {
  const p = require.resolve(path.join(ROOT, 'lib/emailService'));
  require.cache[p] = {
    id: p, filename: p, loaded: true,
    exports: {
      send: async ({ to, subject }) => { emailCalls.push({ to, subject }); return { ok: true }; },
    },
  };
}

async function postWebhook(body) {
  const res = await fetch(`${base}/api/v1/signnow-webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { status: res.status, body: json };
}

test.before(async () => {
  if (skip) return;
  emailCalls = [];
  delete require.cache[require.resolve(path.join(ROOT, 'db/client'))];
  db = require(path.join(ROOT, 'db/client'));

  const express = require('express');
  const app = express();
  app.use('/api/v1/signnow-webhook', require(path.join(ROOT, 'routes/signnowWebhook')));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;

  const stamp = Date.now();
  ownerEmail = `signnow-decline-owner-${stamp}@test.example`;
  const ownerRes = await db.query(
    `INSERT INTO owners (email, display_name) VALUES ($1, 'Decline Test Owner') RETURNING id`,
    [ownerEmail]
  );
  const leadRes = await db.query(
    `INSERT INTO leads (first_name, last_name, email, phone, source, status, owner_id)
     VALUES ('Decline', 'TestLead', $1, '5551234567', 'Referral', 'Qualified', $2)
     RETURNING id`,
    [`decline-lead-${stamp}@test.example`, ownerRes.rows[0].id]
  );
  leadId = leadRes.rows[0].id;
});

test.after(async () => {
  if (skip) return;
  server.close();
  await db.pool.end();
});

test('document.fieldinvite.decline: sets signnow_documents.status to declined, writes an activity note, and emails the owner', { skip }, async () => {
  const docId = `decline-doc-${Date.now()}`;
  await db.query(
    `INSERT INTO signnow_documents (lead_id, document_id, document_name, status)
     VALUES ($1, $2, 'HIC Contract', 'sent')`,
    [leadId, docId]
  );
  emailCalls.length = 0;

  const res = await postWebhook({ event: 'document.fieldinvite.decline', document_id: docId });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.processed, true);
  assert.strictEqual(res.body.declined, true);

  const doc = (await db.query('SELECT status FROM signnow_documents WHERE document_id = $1', [docId])).rows[0];
  assert.strictEqual(doc.status, 'declined');

  const activity = (await db.query(
    `SELECT content FROM activities WHERE lead_id = $1 AND content ILIKE '%declined%' ORDER BY created_at DESC LIMIT 1`,
    [leadId]
  )).rows[0];
  assert.ok(activity, 'a decline activity note must be recorded');
  assert.ok(activity.content.includes('HIC Contract'));

  assert.ok(emailCalls.some((c) => c.to === ownerEmail), 'the lead owner must be notified of the decline');
  assert.ok(emailCalls.every((c) => c.subject.includes('Declined')));
});

test('document.fieldinvite.decline: idempotent — a redelivered decline for an already-declined doc is a no-op, never a second activity/email', { skip }, async () => {
  const docId = `decline-doc-redeliver-${Date.now()}`;
  await db.query(
    `INSERT INTO signnow_documents (lead_id, document_id, document_name, status)
     VALUES ($1, $2, 'HIC Contract 2', 'declined')`,
    [leadId, docId]
  );
  emailCalls.length = 0;

  const res = await postWebhook({ event: 'document.fieldinvite.decline', document_id: docId });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.processed, false);
  assert.strictEqual(res.body.reason, 'already_declined');
  assert.strictEqual(emailCalls.length, 0, 'an already-declined doc must never trigger a second notification');
});

test('document.fieldinvite.decline: an unknown document_id is acknowledged but not processed, never throws', { skip }, async () => {
  const res = await postWebhook({ event: 'document.fieldinvite.decline', document_id: 'does-not-exist-at-all' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.processed, false);
  assert.strictEqual(res.body.reason, 'no_crm_record');
});

test('a completion event (document.complete) is unaffected by the new decline branch', { skip }, async () => {
  const docId = `complete-doc-${Date.now()}`;
  await db.query(
    `INSERT INTO signnow_documents (lead_id, document_id, document_name, status)
     VALUES ($1, $2, 'Other Document', 'sent')`,
    [leadId, docId]
  );
  // No real SignNow API configured in this test, so the completion path's
  // own getDocumentStatus call throws/returns not-configured — this test
  // only proves the decline branch is never mistakenly entered for a
  // genuine completion-shaped event, not the full completion flow (that is
  // covered by test/integration/signnowSendControl.int.test.js and friends).
  const res = await postWebhook({ event: 'document.complete', document_id: docId });
  assert.notStrictEqual(res.body.declined, true);
});
