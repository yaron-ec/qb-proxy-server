/* eslint-disable no-undef */
'use strict';

/**
 * michelleNotificationPolicySeed.test.js — static check on
 * db/migrations/2026-62-michelle-single-category-notifications.sql: EC's
 * business policy is "michelle@ecconstructiongroup.com receives exactly one
 * CRM-generated email category — a genuinely new lead." The migration
 * expresses this as DATA (one disabling row per non-new-lead category,
 * never touching permissions/roles) rather than a code-level hardcoded
 * check, so this test verifies the migration's row set stays in exact sync
 * with lib/notificationPreferences.js#CATEGORIES — a category added there
 * later without a matching disabling row here would silently re-enable
 * Michelle for it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const MIGRATION_PATH = path.join(__dirname, '..', 'db', 'migrations', '2026-62-michelle-single-category-notifications.sql');

test('migration file exists and targets notification_preferences', () => {
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  assert.ok(/INSERT INTO notification_preferences/i.test(sql));
  assert.ok(/ON CONFLICT \(user_email, category\) DO NOTHING/i.test(sql), 'must be idempotent/re-runnable');
});

test('every non-NEW_LEAD category has a disabling row for michelle@ecconstructiongroup.com, and NEW_LEAD has none', () => {
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const prefs = require('../lib/notificationPreferences');
  const rowRe = /\('michelle@ecconstructiongroup\.com',\s*'([a-z_]+)',\s*(true|false)\)/gi;
  const rows = new Map();
  let m;
  while ((m = rowRe.exec(sql))) rows.set(m[1], m[2].toLowerCase() === 'true');

  for (const category of Object.values(prefs.CATEGORIES)) {
    if (category === prefs.CATEGORIES.NEW_LEAD) {
      assert.ok(!rows.has(category), 'NEW_LEAD must have NO row — absence means enabled, per notificationPreferences.js\'s backward-compatible default');
    } else {
      assert.ok(rows.has(category), `category "${category}" is missing a disabling row for Michelle — she would be re-enabled for it`);
      assert.strictEqual(rows.get(category), false, `category "${category}" must be disabled (false) for Michelle`);
    }
  }

  // No stray rows for a category that no longer exists.
  for (const category of rows.keys()) {
    assert.ok(Object.values(prefs.CATEGORIES).includes(category), `migration disables unknown category "${category}" — stale row?`);
  }
});

test('migration never touches users/roles/permissions tables (policy is notification-only, never access)', () => {
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  assert.ok(!/UPDATE\s+users/i.test(sql));
  assert.ok(!/protected_admin_emails/i.test(sql));
  assert.ok(!/role\s*=/i.test(sql));
});
