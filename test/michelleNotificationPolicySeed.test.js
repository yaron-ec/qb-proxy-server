/* eslint-disable no-undef */
'use strict';

/**
 * michelleNotificationPolicySeed.test.js — static check across
 * db/migrations/*.sql: EC's business policy is
 * "michelle@ecconstructiongroup.com receives exactly one CRM-generated
 * email category — a genuinely new lead." The policy is expressed as DATA
 * (one disabling row per non-new-lead category, never touching
 * permissions/roles) rather than a code-level hardcoded check.
 *
 * db/migrations/2026-62-michelle-single-category-notifications.sql seeded
 * the original category set. db/migrate.js never re-executes a migration
 * filename that already has a schema_migrations row ("A file that already
 * has a schema_migrations row [is] skipped entirely — no re-execution"),
 * so a category added to lib/notificationPreferences.js#CATEGORIES AFTER
 * 2026-62 was first applied in production can only safely get Michelle's
 * matching disabling row from a NEW, separate, additive migration (e.g.
 * 2026-68-sms-outbound-notification-categories.sql for sms_sent/
 * sms_delivery_failure) — editing 2026-62.sql directly would silently
 * never apply anywhere it had already run. This test therefore aggregates
 * Michelle's disabling rows across EVERY migration file, not just 2026-62,
 * and verifies the combined set stays in exact sync with CATEGORIES — a
 * category added there later with no matching disabling row in ANY
 * migration would silently re-enable Michelle for it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');
const MIGRATION_PATH = path.join(MIGRATIONS_DIR, '2026-62-michelle-single-category-notifications.sql');

function readAllMichelleRows() {
  const rowRe = /\('michelle@ecconstructiongroup\.com',\s*'([a-z_]+)',\s*(true|false)\)/gi;
  const rows = new Map();
  for (const file of fs.readdirSync(MIGRATIONS_DIR)) {
    if (!file.endsWith('.sql')) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    let m;
    while ((m = rowRe.exec(sql))) rows.set(m[1], m[2].toLowerCase() === 'true');
  }
  return rows;
}

test('2026-62 migration file exists and targets notification_preferences', () => {
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  assert.ok(/INSERT INTO notification_preferences/i.test(sql));
  assert.ok(/ON CONFLICT \(user_email, category\) DO NOTHING/i.test(sql), 'must be idempotent/re-runnable');
});

test('every non-NEW_LEAD category has a disabling row for michelle@ecconstructiongroup.com SOMEWHERE across all migrations, and NEW_LEAD has none', () => {
  const prefs = require('../lib/notificationPreferences');
  const rows = readAllMichelleRows();

  for (const category of Object.values(prefs.CATEGORIES)) {
    if (category === prefs.CATEGORIES.NEW_LEAD) {
      assert.ok(!rows.has(category), 'NEW_LEAD must have NO row — absence means enabled, per notificationPreferences.js\'s backward-compatible default');
    } else {
      assert.ok(rows.has(category), `category "${category}" is missing a disabling row for Michelle in any migration — she would be re-enabled for it`);
      assert.strictEqual(rows.get(category), false, `category "${category}" must be disabled (false) for Michelle`);
    }
  }

  // No stray rows for a category that no longer exists.
  for (const category of rows.keys()) {
    assert.ok(Object.values(prefs.CATEGORIES).includes(category), `a migration disables unknown category "${category}" — stale row?`);
  }
});

test('migration never touches users/roles/permissions tables (policy is notification-only, never access)', () => {
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  assert.ok(!/UPDATE\s+users/i.test(sql));
  assert.ok(!/protected_admin_emails/i.test(sql));
  assert.ok(!/role\s*=/i.test(sql));
});
