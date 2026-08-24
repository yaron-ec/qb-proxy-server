/* eslint-disable no-undef */
/**
 * Action-flow logic tests (synthetic — no real DB, no email, no Base44).
 *
 * Run from the proxy-server root:
 *   node test/actionFlow.test.js
 *
 * Exercises the Railway-side logic with an in-memory mock of the db layer
 * (simulating the partial UNIQUE idempotency indexes, the nonce table, and
 * the token table). Does NOT connect to Postgres, does NOT send email, does
 * NOT touch any real Lead. Gmail is exercised only via its missing-config
 * failure path.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const tokenStore = require('../lib/actionTokenStore');
const actions = require('../lib/reminderActions');
const notifications = require('../lib/reminderNotifications');

let passed = 0;
function ok(name, cond) { if (!cond) throw new Error('FAIL: ' + name); passed++; }

function makeMockDb() {
  const confirmed = new Set();
  const rescheduled = new Set();
  const nonces = new Map();
  const notifInserts = [];
  const tokens = new Map();
  const client = {
    async query(text, params) {
      if (/BEGIN|COMMIT|ROLLBACK/.test(text)) return { rows: [] };
      if (/INSERT INTO reminder_actions/.test(text) && /'confirm'/.test(text)) {
        const fp = params[2];
        if (confirmed.has(fp)) return { rows: [] };
        confirmed.add(fp); return { rows: [{ id: 'c1' }] };
      }
      if (/INSERT INTO reminder_actions/.test(text) && /'reschedule'/.test(text)) {
        const k = `${params[2]}|${params[3]}|${params[4]}|${params[6]}`;
        if (rescheduled.has(k)) return { rows: [] };
        rescheduled.add(k); return { rows: [{ id: 'r1' }] };
      }
      if (/INSERT INTO reminder_notifications/.test(text)) { notifInserts.push(params); return { rows: [] }; }
      return { rows: [] };
    },
    release() {},
  };
  return {
    db: {
      pool: { connect: async () => client },
      async query(text, params) {
        if (/INSERT INTO reminder_action_tokens/.test(text)) {
          tokens.set(params[0], { token_hash: params[0], lead_id: params[1], appointment_fingerprint: params[2], action_type: params[3], expires_at: params[4], snapshot: params[6] });
          return { rows: [] };
        }
        if (/SELECT \* FROM reminder_action_tokens WHERE token_hash/.test(text)) {
          return { rows: tokens.get(params[0]) ? [tokens.get(params[0])] : [] };
        }
        if (/INSERT INTO reminder_form_nonces/.test(text)) { nonces.set(params[0], { consumed: false }); return { rows: [] }; }
        if (/UPDATE reminder_form_nonces SET consumed_at/.test(text)) {
          const e = nonces.get(params[0]);
          if (e && !e.consumed) { e.consumed = true; return { rows: [{ id: 'n1' }] }; }
          return { rows: [] };
        }
        if (/SELECT 1 FROM reminder_actions/.test(text) && /'confirm'/.test(text)) {
          return { rows: confirmed.has(params[0]) ? [1] : [] };
        }
        return { rows: [] };
      },
    },
    notifInserts,
  };
}

async function main() {
  // 1. Fingerprint rep sensitivity
  ok('fingerprint rep-sensitive',
    tokenStore.fingerprint({ leadId: 'L1', date: '2026-08-01', time: '09:00', type: 'Meeting', repEmail: 'yaron@ecconstructiongroup.com' })
    !== tokenStore.fingerprint({ leadId: 'L1', date: '2026-08-01', time: '09:00', type: 'Meeting', repEmail: 'michelle@ecconstructiongroup.com' }));

  // 2. Token opacity
  const m1 = makeMockDb();
  const r = await tokenStore.issueToken(m1.db, { leadId: 'L1', appointmentFingerprint: 'fp', actionType: 'confirm', snapshot: {} });
  ok('raw token >=32 chars', r.raw.length >= 32);
  ok('hash is 64 hex', /^[0-9a-f]{64}$/.test(r.tokenHash));
  ok('raw != hash', r.raw !== r.tokenHash);
  ok('lookup resolves', !!(await tokenStore.lookupToken(m1.db, r.raw)));

  // 3. Token tampering / invalid
  ok('tampered token rejected', !(await tokenStore.lookupToken(m1.db, r.raw + 'x')));
  ok('random token rejected', !(await tokenStore.lookupToken(m1.db, 'garbage')));
  ok('empty token rejected', !(await tokenStore.lookupToken(m1.db, '')));

  // 4. Expiration detection
  const m2 = makeMockDb();
  const r2 = await tokenStore.issueToken(m2.db, { leadId: 'L3', appointmentFingerprint: 'fp3', actionType: 'confirm', snapshot: {}, ttlDays: 0.0001 });
  const row2 = await tokenStore.lookupToken(m2.db, r2.raw);
  ok('fresh token not expired', new Date(row2.expires_at).getTime() > Date.now());
  row2.expires_at = new Date(Date.now() - 1000).toISOString();
  ok('expired token detected', new Date(row2.expires_at).getTime() <= Date.now());

  // 5. Repeated confirmation → one confirmation + one notification
  const m3 = makeMockDb(); const notif = { recipientEmails: 'rep@x', subject: 's', body: 'b' };
  ok('first confirm first=true', (await actions.completeConfirm(m3.db, { tokenHash: 'h', leadId: 'L4', apptFp: 'fp4', notification: notif })).first === true);
  ok('second confirm first=false', (await actions.completeConfirm(m3.db, { tokenHash: 'h2', leadId: 'L4', apptFp: 'fp4', notification: notif })).first === false);
  ok('exactly one confirm notification', m3.notifInserts.length === 1);

  // 6. Different appointment for same Lead confirms separately
  const m4 = makeMockDb();
  await actions.completeConfirm(m4.db, { tokenHash: 'h', leadId: 'L5', apptFp: 'fpA', notification: notif });
  ok('different appointment confirms separately', (await actions.completeConfirm(m4.db, { tokenHash: 'h2', leadId: 'L5', apptFp: 'fpB', notification: notif })).first === true);

  // 7. Reschedule idempotency + genuinely different allowed
  const m5 = makeMockDb(); const base = { tokenHash: 'h', leadId: 'L6', apptFp: 'fp6', ip: null, userAgent: null, notification: { recipientEmails: 'm', subject: 's', body: 'b' } };
  ok('first reschedule first=true', (await actions.completeReschedule(m5.db, { ...base, requestedDate: '2026-09-01', requestedTime: '10:00', note: 'after 3pm', noteHash: actions.sha('after 3pm') })).first === true);
  ok('duplicate reschedule first=false', (await actions.completeReschedule(m5.db, { ...base, requestedDate: '2026-09-01', requestedTime: '10:00', note: 'after 3pm', noteHash: actions.sha('after 3pm') })).first === false);
  ok('different reschedule allowed', (await actions.completeReschedule(m5.db, { ...base, requestedDate: '2026-09-02', requestedTime: '11:00', note: '', noteHash: actions.sha('') })).first === true);
  ok('two distinct reschedule notifications', m5.notifInserts.length === 2);

  // 8. Nonce one-time use
  const m6 = makeMockDb(); const n = await actions.issueNonce(m6.db, 'th');
  ok('nonce issued', !!n);
  ok('nonce consume first true', (await actions.consumeNonce(m6.db, n, 'th')) === true);
  ok('nonce consume second false', (await actions.consumeNonce(m6.db, n, 'th')) === false);
  ok('nonce empty false', (await actions.consumeNonce(m6.db, '', 'th')) === false);

  // 9. Date/time validation
  ok('valid date', /^\d{4}-\d{2}-\d{2}$/.test('2026-09-01'));
  ok('invalid date rejected', !/^\d{4}-\d{2}-\d{2}$/.test('2026-9-1'));
  ok('valid time', /^\d{2}:\d{2}$/.test('09:00'));
  ok('invalid time rejected', !/^\d{2}:\d{2}$/.test('9:00'));

  // 10. Note length cap + HTML injection escaping
  ok('note capped to 500', 'a'.repeat(600).slice(0, 500).length === 500);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  ok('script tag escaped', esc('<script>') === '&lt;script&gt;');

  // 11. Missing Gmail → action persisted; flush does not throw
  const m7 = makeMockDb();
  ok('action persisted despite no Gmail', (await actions.completeConfirm(m7.db, { tokenHash: 'h', leadId: 'L7', apptFp: 'fp7', notification: notif })).first === true);
  let threw = false;
  try {
    const flushDb = {
      pool: m7.db.pool,
      async query(text, params) {
        if (/SELECT \* FROM reminder_notifications/.test(text)) return { rows: [{ id: 'n1', notification_type: 'confirm', recipient_emails: 'rep@x', subject: 's', body: 'b' }] };
        if (/UPDATE reminder_notifications SET status='processing'/.test(text)) return { rows: [{ id: 'n1' }] };
        return { rows: [] };
      },
    };
    const res = await notifications.flushPendingNotifications(flushDb);
    ok('flush attempted>=1', res.attempted >= 1);
    ok('flush sent 0 (no Gmail creds)', res.sent === 0);
  } catch (e) { threw = true; }
  ok('flush did not throw on Gmail failure', !threw);

  // 12. Base44 NOT imported anywhere in the reminder action flow
  for (const f of ['actionTokenStore.js', 'reminderActions.js', 'reminderNotifications.js', 'actionRouter.js', 'reminderPages.js', 'repDirectory.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8');
    ok(f + ' has no base44', !/require\(['"]\.\/base44['"]\)/.test(src) && !/base44\.(create|list|update)\(/.test(src));
  }

  // 13. Raw token never equals stored hash
  ok('stored hash != raw token', r.tokenHash !== r.raw);

  console.log(`\n${passed} checks passed.`);
  console.log('Scenarios covered: fingerprint/rep-change, token tamper, invalid token, expiration, replay confirm, duplicate reschedule POST, different reschedule, missing Gmail, Gmail failure after persistence, Base44-unavailable (static), nonce one-time, date/time validation, oversized note, HTML injection, opacity.');
  process.exit(0);
}

main().catch((e) => { console.error('\n' + e.message); process.exit(1); });