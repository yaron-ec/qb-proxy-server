/* eslint-disable no-undef */
'use strict';

/**
 * rateLimit.test.js — pure unit coverage for lib/rateLimit.js's sliding
 * per-IP window, written as part of the November 2026 CRM hardening pass
 * that wired this middleware onto the three previously-uncapped webhook
 * routes (routes/metaWebhook.js, routes/sms.js's webhookRouter,
 * routes/qbWebhook.js). No real HTTP server needed — fake req/res objects,
 * same convention as other pure-unit middleware tests in this suite.
 */
const test = require('node:test');
const assert = require('node:assert');
const { rateLimit } = require('../lib/rateLimit');

function fakeReq(ip) {
  return { ip, socket: { remoteAddress: ip } };
}
function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('allows requests under the max within the window', () => {
  const limiter = rateLimit({ windowMs: 60000, max: 3 });
  const req = fakeReq('1.2.3.4');
  for (let i = 0; i < 3; i++) {
    const res = fakeRes();
    let nextCalled = false;
    limiter(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true, `request ${i + 1} should pass`);
    assert.strictEqual(res.statusCode, null);
  }
});

test('rejects the request that exceeds max with 429, without ever calling next()', () => {
  const limiter = rateLimit({ windowMs: 60000, max: 3 });
  const req = fakeReq('5.6.7.8');
  for (let i = 0; i < 3; i++) limiter(req, fakeRes(), () => {});
  const res = fakeRes();
  let nextCalled = false;
  limiter(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 429);
  assert.strictEqual(res.body.error, 'rate_limited');
});

test('tracks each IP independently — one IP exceeding the cap never affects another', () => {
  const limiter = rateLimit({ windowMs: 60000, max: 2 });
  const reqA = fakeReq('10.0.0.1');
  const reqB = fakeReq('10.0.0.2');
  limiter(reqA, fakeRes(), () => {});
  limiter(reqA, fakeRes(), () => {});
  const resA3 = fakeRes();
  let nextA = false;
  limiter(reqA, resA3, () => { nextA = true; });
  assert.strictEqual(nextA, false, 'IP A should now be capped');

  const resB = fakeRes();
  let nextB = false;
  limiter(reqB, resB, () => { nextB = true; });
  assert.strictEqual(nextB, true, 'IP B must be unaffected by IP A\'s cap');
});

test('resets the count once the window elapses', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const limiter = rateLimit({ windowMs: 1000, max: 1 });
  const req = fakeReq('9.9.9.9');
  limiter(req, fakeRes(), () => {});
  const res2 = fakeRes();
  let next2 = false;
  limiter(req, res2, () => { next2 = true; });
  assert.strictEqual(next2, false, 'second request within the window must be capped');

  t.mock.timers.tick(1001);
  const res3 = fakeRes();
  let next3 = false;
  limiter(req, res3, () => { next3 = true; });
  assert.strictEqual(next3, true, 'a request after the window elapses must pass again');
  t.mock.timers.reset();
});

test('default config (no args) is generous enough for ordinary low-volume traffic without crashing', () => {
  const limiter = rateLimit();
  const req = fakeReq('192.168.1.1');
  let nextCalled = false;
  limiter(req, fakeRes(), () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
});

test('falls back to a stable key when req.ip is absent (never throws)', () => {
  const limiter = rateLimit({ windowMs: 60000, max: 2 });
  const req = { socket: { remoteAddress: '203.0.113.5' } };
  let nextCalled = false;
  assert.doesNotThrow(() => limiter(req, fakeRes(), () => { nextCalled = true; }));
  assert.strictEqual(nextCalled, true);
});
