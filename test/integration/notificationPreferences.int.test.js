/* eslint-disable no-undef */
'use strict';

/**
 * notificationPreferences.int.test.js — REAL-Postgres proof of the generic,
 * per-user notification category preference system (CRM STABILITY PHASE,
 * Section H).
 *
 * Before this system existed, every staff-facing notification went
 * unconditionally to the SAME flat company_settings.notification_recipients
 * list regardless of category (new lead, appointment, contract signed,
 * etc.) — there was no way to give one staff member a narrower subset
 * (e.g. "New Lead notifications only") without affecting every other
 * category for every other recipient too.
 *
 * Proves:
 *   - a (user, category) pair with no row is ENABLED by default (backward
 *     compatible — applying this feature never silently goes quiet for
 *     anyone until an admin explicitly opts someone out)
 *   - explicitly disabling a category for a user removes them from that
 *     category's filtered recipient list, but leaves every other
 *     candidate (and every other category for that same user) untouched
 *   - the admin API (GET/PUT /api/v1/notification-preferences) round-trips
 *     correctly and is admin-only
 *   - an unknown category fails OPEN (delivers) rather than silently
 *     dropping a real notification over a typo
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
  process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'int-test-secret-int-test-secret-0123456789';
}

let base, server, db, notificationPreferences, adminToken, repToken, userA, userB;

async function api(method, url, body, token) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { status: res.status, body: json };
}

test.before(async () => {
  if (skip) return;
  delete require.cache[require.resolve(path.join(ROOT, 'db/client'))];
  db = require(path.join(ROOT, 'db/client'));
  notificationPreferences = require(path.join(ROOT, 'lib/notificationPreferences'));

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/notification-preferences', require(path.join(ROOT, 'routes/notificationPreferences')));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;

  const { issueAccessToken } = require(path.join(ROOT, 'lib/authService'));
  const stamp = Date.now();
  adminToken = issueAccessToken({ id: '00000000-0000-0000-0000-00000000dd01', email: `admin-notifprefs-${stamp}@test.example`, role: 'admin' });
  repToken = issueAccessToken({ id: '00000000-0000-0000-0000-00000000dd02', email: `rep-notifprefs-${stamp}@test.example`, role: 'sales_rep' });
  userA = `staffA-${stamp}@test.example`;
  userB = `staffB-${stamp}@test.example`;
});

test.after(async () => {
  if (skip) return;
  server.close();
  await db.query('DELETE FROM notification_preferences WHERE user_email LIKE $1', [`%${userA.split('@')[1]}%`]).catch(() => {});
  await db.pool.end();
});

test('1. a user/category with no row is ENABLED by default (backward compatible)', { skip }, async () => {
  const candidates = [userA, userB];
  const filtered = await notificationPreferences.filterRecipientsForCategory(candidates, notificationPreferences.CATEGORIES.NEW_LEAD);
  assert.deepStrictEqual(filtered.sort(), candidates.sort());
});

test('2. disabling a category for one user removes only them from that category, leaves other categories/users untouched', { skip }, async () => {
  await notificationPreferences.setPreference(userA, notificationPreferences.CATEGORIES.APPOINTMENT, false);

  const appointmentFiltered = await notificationPreferences.filterRecipientsForCategory([userA, userB], notificationPreferences.CATEGORIES.APPOINTMENT);
  assert.deepStrictEqual(appointmentFiltered, [userB], 'userA must be excluded from APPOINTMENT');

  const newLeadFiltered = await notificationPreferences.filterRecipientsForCategory([userA, userB], notificationPreferences.CATEGORIES.NEW_LEAD);
  assert.deepStrictEqual(newLeadFiltered.sort(), [userA, userB].sort(), 'userA must still receive NEW_LEAD — disabling one category must never affect another');

  const userBStillIn = await notificationPreferences.filterRecipientsForCategory([userA, userB], notificationPreferences.CATEGORIES.APPOINTMENT);
  assert.ok(userBStillIn.includes(userB), 'userB must be unaffected by userA\'s preference change');
});

test('3. re-enabling restores the user to that category\'s recipient list', { skip }, async () => {
  await notificationPreferences.setPreference(userA, notificationPreferences.CATEGORIES.APPOINTMENT, true);
  const filtered = await notificationPreferences.filterRecipientsForCategory([userA, userB], notificationPreferences.CATEGORIES.APPOINTMENT);
  assert.deepStrictEqual(filtered.sort(), [userA, userB].sort());
});

test('4. an unknown category fails OPEN (delivers to all candidates) rather than silently dropping a notification', { skip }, async () => {
  const filtered = await notificationPreferences.filterRecipientsForCategory([userA, userB], 'not_a_real_category');
  assert.deepStrictEqual(filtered.sort(), [userA, userB].sort());
});

test('5. admin API: GET/PUT round-trip, and the matrix endpoint reflects the change', { skip }, async () => {
  const put = await api('PUT', `/api/v1/notification-preferences/${encodeURIComponent(userB)}`, { category: 'contract_signed', enabled: false }, adminToken);
  assert.strictEqual(put.status, 200, JSON.stringify(put.body));
  const row = put.body.preferences.find((p) => p.category === 'contract_signed');
  assert.strictEqual(row.enabled, false);

  const get = await api('GET', `/api/v1/notification-preferences/${encodeURIComponent(userB)}`, undefined, adminToken);
  assert.strictEqual(get.status, 200);
  const gotRow = get.body.preferences.find((p) => p.category === 'contract_signed');
  assert.strictEqual(gotRow.enabled, false);
  // Every other category stays at its default-enabled state.
  const otherRow = get.body.preferences.find((p) => p.category === 'new_lead');
  assert.strictEqual(otherRow.enabled, true);

  const matrix = await api('GET', '/api/v1/notification-preferences', undefined, adminToken);
  assert.strictEqual(matrix.status, 200);
  assert.ok(matrix.body.overrides.some((o) => o.user_email === userB.toLowerCase() && o.category === 'contract_signed' && o.enabled === false));
});

test('6. admin API is admin-only — a sales_rep is rejected', { skip }, async () => {
  const r = await api('GET', '/api/v1/notification-preferences', undefined, repToken);
  assert.strictEqual(r.status, 403, JSON.stringify(r.body));
});

test('7. PUT validates category and enabled', { skip }, async () => {
  const badCategory = await api('PUT', `/api/v1/notification-preferences/${encodeURIComponent(userA)}`, { category: 'nonsense', enabled: true }, adminToken);
  assert.strictEqual(badCategory.status, 400);

  const missingEnabled = await api('PUT', `/api/v1/notification-preferences/${encodeURIComponent(userA)}`, { category: 'new_lead' }, adminToken);
  assert.strictEqual(missingEnabled.status, 400);
});
