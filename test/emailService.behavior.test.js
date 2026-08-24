#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * test/emailService.behavior.test.js
 *
 * Validates lib/emailService.js behavior (Phase 8) with MOCKED db + gmailSender
 * injected via require.cache — NO PostgreSQL, NO real Gmail, NO network.
 *
 * Covers:
 *   - sender forced to yaron@ecconstructiongroup.com (fromAddress passed through)
 *   - To (single + multiple) coercion
 *   - CC + Reply-To + headers passthrough to gmailSender
 *   - HTML content passthrough
 *   - attachment passthrough
 *   - idempotent duplicate suppression (second call same key => no re-send)
 *   - concurrent duplicate suppression (processing claim => no send)
 *   - retry after transient Gmail failure (3 attempts)
 *   - NO retry after permanent GmailCredentialsError (1 attempt, claim failed)
 *   - failed claim recovery (failed -> re-claim, re-send)
 *   - no Base44 invocation (emailService requires neither base44 nor @base44/sdk)
 *
 * NOTE: attachment MIME/size rejection lives in routes/emails.js (route-level
 * validation), not EmailService. Those are validated separately.
 *
 * Run: node test/emailService.behavior.test.js
 */
'use strict';

const assert = require('assert');
const path = require('path');

const results = [];
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { results.push({ name, ok: true }); console.log('  \u2713 ' + name); })
    .catch((e) => { results.push({ name, ok: false, err: e.message }); console.error('  \u2717 ' + name + ' \u2014 ' + e.message); });
}
function summarize() {
  const p = results.filter(r => r.ok).length, f = results.filter(r => !r.ok).length;
  console.log('\n[emailService.behavior] ' + p + ' passed, ' + f + ' failed');
  return f === 0 ? 0 : 1;
}

// ── Mocks injected into require.cache BEFORE requiring emailService ──────────
class MockGmailCredentialsError extends Error {
  constructor(m) { super(m); this.name = 'GmailCredentialsError'; this.errorType = 'gmail_credentials'; }
}

function makeGmailMock({ failTimes = 0, credentialError = false, messageId = 'msg-1' } = {}) {
  const calls = { refresh: 0, send: 0, lastOpts: null };
  return {
    calls,
    refreshAccessToken: async () => { calls.refresh++; return 'tok'; },
    sendEmail: async (accessToken, opts) => {
      calls.send++; calls.lastOpts = opts;
      if (credentialError) throw new MockGmailCredentialsError('Gmail credentials error: refresh token revoked (invalidGrant)');
      if (failTimes > 0) { failTimes--; throw new Error('Gmail send 503: transient'); }
      return { id: messageId };
    },
    GmailCredentialsError: MockGmailCredentialsError,
  };
}

function makeDbMock() {
  const claimState = {}; // idempotencyKey -> {id, status, messageId}
  const calls = { inserts: 0, updates: 0 };
  return {
    calls, claimState,
    ensureSchema: async () => {},
    query: async (sql, params) => {
      const s = String(sql);
      if (s.startsWith('INSERT INTO email_send_claims')) {
        calls.inserts++;
        const key = params[0];
        if (claimState[key]) return { rows: [] }; // ON CONFLICT DO NOTHING
        const id = 'claim-' + calls.inserts;
        claimState[key] = { id, status: 'processing', messageId: null };
        return { rows: [{ id, status: 'processing', gmail_message_id: null }] };
      }
      if (s.startsWith('SELECT id, status, gmail_message_id, last_error FROM email_send_claims')) {
        const key = params[0];
        const row = claimState[key];
        return { rows: row ? [{ id: row.id, status: row.status, gmail_message_id: row.messageId, last_error: null }] : [] };
      }
      if (s.startsWith('UPDATE email_send_claims SET status=\'sent\'')) {
        calls.updates++;
        const id = params[0];
        for (const k of Object.keys(claimState)) {
          if (claimState[k].id === id) { claimState[k].status = 'sent'; claimState[k].messageId = params[1]; }
        }
        return { rows: [] };
      }
      if (s.startsWith('UPDATE email_send_claims SET status=\'failed\'')) {
        const id = params[0];
        for (const k of Object.keys(claimState)) {
          if (claimState[k].id === id) { claimState[k].status = 'failed'; }
        }
        return { rows: [] };
      }
      if (s.startsWith('UPDATE email_send_claims SET status=\'processing\', updated_at=NOW(), attempts=attempts+1')) {
        const id = params[0];
        let stolen = false;
        for (const k of Object.keys(claimState)) {
          if (claimState[k].id === id && claimState[k].status === 'failed') { claimState[k].status = 'processing'; stolen = true; break; }
        }
        return { rows: stolen ? [{ id }] : [] };
      }
      if (s.startsWith('INSERT INTO email_send_logs') || s.startsWith('UPDATE email_send_claims SET metadata')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

function installMocks(dbMock, gmailMock) {
  const dbPath = path.resolve(__dirname, '../db/client.js');
  const gmailPath = path.resolve(__dirname, '../lib/gmailSender.js');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbMock, paths: [], children: [], parent: null };
  require.cache[gmailPath] = { id: gmailPath, filename: gmailPath, loaded: true, exports: gmailMock, paths: [], children: [], parent: null };
}
function clearMocks() {
  delete require.cache[path.resolve(__dirname, '../db/client.js')];
  delete require.cache[path.resolve(__dirname, '../lib/gmailSender.js')];
  delete require.cache[path.resolve(__dirname, '../lib/emailService.js')];
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
  console.log('\n[emailService.behavior] mocked suite');

  await test('sender forced to yaron@ecconstructiongroup.com (fromAddress passed through)', async () => {
    clearMocks();
    const db = makeDbMock(); const gm = makeGmailMock();
    installMocks(db, gm);
    const es = require('../lib/emailService');
    await es.send({ to: 'a@x.com', subject: 's', htmlBody: '<b>h</b>', idempotencyKey: 'k1', fromAddress: 'yaron@ecconstructiongroup.com', fromName: 'EC Construction Group' });
    assert.strictEqual(gm.calls.lastOpts.fromAddress, 'yaron@ecconstructiongroup.com');
    assert.strictEqual(gm.calls.lastOpts.fromName, 'EC Construction Group');
  });

  await test('default sender is yaron@ecconstructiongroup.com when fromAddress omitted', async () => {
    clearMocks();
    const db = makeDbMock(); const gm = makeGmailMock();
    installMocks(db, gm);
    const es = require('../lib/emailService');
    await es.send({ to: 'a@x.com', subject: 's', htmlBody: '<b>h</b>', idempotencyKey: 'k2' });
    assert.strictEqual(gm.calls.lastOpts.fromAddress, 'yaron@ecconstructiongroup.com');
  });

  await test('single To recipient passed to gmailSender', async () => {
    clearMocks(); const db = makeDbMock(); const gm = makeGmailMock(); installMocks(db, gm);
    const es = require('../lib/emailService');
    await es.send({ to: 'one@x.com', subject: 's', htmlBody: 'h', idempotencyKey: 'k3' });
    assert.strictEqual(gm.calls.lastOpts.to, 'one@x.com');
  });

  await test('multiple To recipients coerced to comma-separated string', async () => {
    clearMocks(); const db = makeDbMock(); const gm = makeGmailMock(); installMocks(db, gm);
    const es = require('../lib/emailService');
    await es.send({ to: ['one@x.com', 'two@x.com'], subject: 's', htmlBody: 'h', idempotencyKey: 'k4' });
    assert.strictEqual(gm.calls.lastOpts.to, 'one@x.com, two@x.com');
  });

  await test('CC recipients passed through', async () => {
    clearMocks(); const db = makeDbMock(); const gm = makeGmailMock(); installMocks(db, gm);
    const es = require('../lib/emailService');
    await es.send({ to: 'a@x.com', cc: ['c1@x.com', 'c2@x.com'], subject: 's', htmlBody: 'h', idempotencyKey: 'k5' });
    assert.deepStrictEqual(gm.calls.lastOpts.cc, ['c1@x.com', 'c2@x.com']);
  });

  await test('Reply-To preserved', async () => {
    clearMocks(); const db = makeDbMock(); const gm = makeGmailMock(); installMocks(db, gm);
    const es = require('../lib/emailService');
    await es.send({ to: 'a@x.com', replyTo: 'rep@x.com', subject: 's', htmlBody: 'h', idempotencyKey: 'k6' });
    assert.strictEqual(gm.calls.lastOpts.replyTo, 'rep@x.com');
  });

  await test('HTML content + headers passed through', async () => {
    clearMocks(); const db = makeDbMock(); const gm = makeGmailMock(); installMocks(db, gm);
    const es = require('../lib/emailService');
    const h = { 'Message-ID': '<x@y>', 'In-Reply-To': '<t@y>' };
    await es.send({ to: 'a@x.com', subject: 's', htmlBody: '<i>html</i>', idempotencyKey: 'k7', headers: h });
    assert.strictEqual(gm.calls.lastOpts.htmlBody, '<i>html</i>');
    assert.deepStrictEqual(gm.calls.lastOpts.headers, h);
  });

  await test('attachment passthrough to gmailSender', async () => {
    clearMocks(); const db = makeDbMock(); const gm = makeGmailMock(); installMocks(db, gm);
    const es = require('../lib/emailService');
    const att = [{ filename: 'inv.pdf', contentType: 'application/pdf', contentBase64: 'AAAA' }];
    await es.send({ to: 'a@x.com', subject: 's', htmlBody: 'h', idempotencyKey: 'k8', attachments: att });
    assert.deepStrictEqual(gm.calls.lastOpts.attachments, att);
  });

  await test('idempotent duplicate suppression (second call same key => no re-send)', async () => {
    clearMocks(); const db = makeDbMock(); const gm = makeGmailMock(); installMocks(db, gm);
    const es = require('../lib/emailService');
    const r1 = await es.send({ to: 'a@x.com', subject: 's', htmlBody: 'h', idempotencyKey: 'idem-1' });
    assert.strictEqual(gm.calls.send, 1);
    assert.strictEqual(r1.idempotent, false);
    const r2 = await es.send({ to: 'a@x.com', subject: 's', htmlBody: 'h', idempotencyKey: 'idem-1' });
    assert.strictEqual(gm.calls.send, 1, 'no second send on duplicate key');
    assert.strictEqual(r2.idempotent, true);
    assert.strictEqual(r2.gmailMessageId, r1.gmailMessageId);
  });

  await test('concurrent duplicate suppression (processing claim => no send)', async () => {
    clearMocks();
    const db = makeDbMock(); const gm = makeGmailMock();
    gm.sendEmail = async () => { gm.calls.send++; await sleep(30); return { id: 'msg-slow' }; };
    installMocks(db, gm);
    const es = require('../lib/emailService');
    const p1 = es.send({ to: 'a@x.com', subject: 's', htmlBody: 'h', idempotencyKey: 'conc-1' });
    await sleep(5);
    const r2 = await es.send({ to: 'a@x.com', subject: 's', htmlBody: 'h', idempotencyKey: 'conc-1' });
    assert.strictEqual(r2.ok, false, 'concurrent processing => no send');
    await p1;
    assert.strictEqual(gm.calls.send, 1, 'only one send for concurrent pair');
  });

  await test('retry after transient Gmail failure (3 attempts then success)', async () => {
    clearMocks(); const db = makeDbMock(); const gm = makeGmailMock({ failTimes: 2 }); installMocks(db, gm);
    const es = require('../lib/emailService');
    const r = await es.send({ to: 'a@x.com', subject: 's', htmlBody: 'h', idempotencyKey: 'retry-1' });
    assert.strictEqual(gm.calls.send, 3, 'retried until success');
    assert.strictEqual(r.ok, true);
  });

  await test('NO retry after permanent GmailCredentialsError (1 attempt)', async () => {
    clearMocks(); const db = makeDbMock(); const gm = makeGmailMock({ credentialError: true }); installMocks(db, gm);
    const es = require('../lib/emailService');
    let threw = false;
    try { await es.send({ to: 'a@x.com', subject: 's', htmlBody: 'h', idempotencyKey: 'perm-1' }); }
    catch (e) { threw = true; assert.ok(/credentials/i.test(e.message)); }
    assert.ok(threw, 'credential error threw');
    assert.strictEqual(gm.calls.send, 1, 'no retry on credential error');
  });

  await test('failed claim recovery (failed -> re-claim -> re-send)', async () => {
    clearMocks();
    const db = makeDbMock(); const gm = makeGmailMock({ credentialError: true });
    installMocks(db, gm);
    const es = require('../lib/emailService');
    try { await es.send({ to: 'a@x.com', subject: 's', htmlBody: 'h', idempotencyKey: 'rec-1' }); } catch (_) {}
    assert.strictEqual(db.claimState['rec-1'].status, 'failed');
    clearMocks();
    const db2 = makeDbMock(); const gm2 = makeGmailMock();
    db2.claimState = db.claimState; // preserve failed claim across re-require
    installMocks(db2, gm2);
    const es2 = require('../lib/emailService');
    const r = await es2.send({ to: 'a@x.com', subject: 's', htmlBody: 'h', idempotencyKey: 'rec-1' });
    assert.strictEqual(r.ok, true, 'recovered after failure');
    assert.strictEqual(gm2.calls.send, 1);
  });

  await test('no Base44 invocation (emailService requires neither base44 nor @base44/sdk)', async () => {
    clearMocks(); const db = makeDbMock(); const gm = makeGmailMock(); installMocks(db, gm);
    require('../lib/emailService');
    const loaded = Object.keys(require.cache).map(p => p.replace(/\\/g, '/'));
    const base44Loaded = loaded.some(p => /\/base44\//.test(p) || /@base44\/sdk/.test(p));
    assert.ok(!base44Loaded, 'emailService did not load any Base44 module');
  });

  return summarize();
}

run().then((code) => process.exit(code)).catch((e) => { console.error('FATAL', e); process.exit(1); });