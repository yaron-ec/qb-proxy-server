/* eslint-disable no-undef */
'use strict';

/**
 * auditExpenseProfitInclusionFlags.int.test.js — real-Postgres proof of the
 * CRM-wide "$0 cost / 100% margin despite real expenses" root-cause fix
 * (see scripts/auditExpenseProfitInclusionFlags.js's own header for the
 * confirmed root cause: 49/51 deal_expenses rows CRM-wide carry
 * include_in_profit_calculation=false, 47 of them from migrated deals).
 *
 * Proves: report mode never writes; a migrated deal's false-flagged
 * expense is the ONLY thing --apply ever corrects; a native deal's
 * false-flagged expense is NEVER auto-corrected, in report OR apply mode;
 * the wrong --confirm-host refuses to write; a correction writes exactly
 * one audit activity note naming the exact dollar amount restored; and a
 * second --apply run is a true no-op (idempotent) on an already-corrected
 * row, while still correctly re-reporting the untouched native row.
 *
 * Skipped without TEST_DATABASE_URL.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'auditExpenseProfitInclusionFlags.js');

let db, migratedLeadId, nativeLeadId, migratedDealId, nativeDealId, migratedExpenseId, nativeExpenseId, ownerId;

function run(args) {
  try {
    const out = execFileSync('node', [SCRIPT, ...args], {
      env: { ...process.env, DATABASE_URL: DB_URL, DATABASE_SSL: 'false' },
      encoding: 'utf8',
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

test.before(async () => {
  if (skip) return;
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
  delete require.cache[require.resolve(path.join(ROOT, 'db/client'))];
  db = require(path.join(ROOT, 'db/client'));

  const stamp = Date.now();
  const ownerRes = await db.query(
    `INSERT INTO owners (email, display_name) VALUES ($1, 'Expense Flag Audit Owner') RETURNING id`,
    [`expense-flag-owner-${stamp}@test.example`]
  );
  ownerId = ownerRes.rows[0].id;

  const migratedLead = await db.query(
    `INSERT INTO leads (first_name, last_name, email, phone, source, status, owner_id)
     VALUES ('Migrated', 'Customer', $1, '5551110000', 'Referral', 'Sold', $2) RETURNING id`,
    [`migrated-${stamp}@test.example`, ownerId]
  );
  migratedLeadId = migratedLead.rows[0].id;

  const nativeLead = await db.query(
    `INSERT INTO leads (first_name, last_name, email, phone, source, status, owner_id)
     VALUES ('Native', 'Customer', $1, '5552220000', 'Referral', 'Sold', $2) RETURNING id`,
    [`native-${stamp}@test.example`, ownerId]
  );
  nativeLeadId = nativeLead.rows[0].id;

  const migratedDeal = await db.query(
    `INSERT INTO deals (lead_id, name, amount, stage, legacy_base44_id) VALUES ($1, 'Migrated Deal', 10000, 'Sold / Estimate Approved', $2) RETURNING id`,
    [migratedLeadId, `base44-${stamp}`]
  );
  migratedDealId = migratedDeal.rows[0].id;

  const nativeDeal = await db.query(
    `INSERT INTO deals (lead_id, name, amount, stage) VALUES ($1, 'Native Deal', 5000, 'Sold / Estimate Approved') RETURNING id`,
    [nativeLeadId]
  );
  nativeDealId = nativeDeal.rows[0].id;

  const migratedExpense = await db.query(
    `INSERT INTO deal_expenses (deal_id, lead_id, vendor_name, category, amount, include_in_profit_calculation)
     VALUES ($1, $2, 'Migrated Vendor', 'Labor', 1000, false) RETURNING id`,
    [migratedDealId, migratedLeadId]
  );
  migratedExpenseId = migratedExpense.rows[0].id;

  const nativeExpense = await db.query(
    `INSERT INTO deal_expenses (deal_id, lead_id, vendor_name, category, amount, include_in_profit_calculation)
     VALUES ($1, $2, 'Native Vendor', 'Materials', 500, false) RETURNING id`,
    [nativeDealId, nativeLeadId]
  );
  nativeExpenseId = nativeExpense.rows[0].id;
});

test.after(async () => {
  if (skip) return;
  await db.query('DELETE FROM activities WHERE lead_id IN ($1, $2)', [migratedLeadId, nativeLeadId]);
  await db.query('DELETE FROM deal_expenses WHERE id IN ($1, $2)', [migratedExpenseId, nativeExpenseId]);
  await db.query('DELETE FROM deals WHERE id IN ($1, $2)', [migratedDealId, nativeDealId]);
  await db.query('DELETE FROM leads WHERE id IN ($1, $2)', [migratedLeadId, nativeLeadId]);
  await db.query('DELETE FROM owners WHERE id = $1', [ownerId]);
  await db.pool.end();
});

test('1. report mode (no --apply) classifies both rows correctly and writes nothing', { skip }, async () => {
  const r = run(['--json']);
  assert.strictEqual(r.code, 0, r.out);
  const parsed = JSON.parse(r.out);
  const migratedIds = parsed.migrated_likely_should_include.map((x) => x.id);
  const nativeIds = parsed.native_needs_human_review.map((x) => x.id);
  assert.ok(migratedIds.includes(migratedExpenseId));
  assert.ok(nativeIds.includes(nativeExpenseId));
  assert.strictEqual(parsed.applied, null);

  const check = await db.query('SELECT include_in_profit_calculation FROM deal_expenses WHERE id = ANY($1)', [[migratedExpenseId, nativeExpenseId]]);
  assert.ok(check.rows.every((row) => row.include_in_profit_calculation === false), 'report mode must never write');
});

test('2. --apply with the WRONG --confirm-host refuses to write', { skip }, async () => {
  const r = run(['--apply', '--confirm-host=definitely-not-the-real-host']);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /Refusing to write/);
  const check = await db.query('SELECT include_in_profit_calculation FROM deal_expenses WHERE id = $1', [migratedExpenseId]);
  assert.strictEqual(check.rows[0].include_in_profit_calculation, false);
});

test('3. --apply with the correct host corrects ONLY the migrated-deal row, never the native-deal row, and writes exactly one audit note', { skip }, async () => {
  const realHost = new URL(DB_URL).host;
  const r = run(['--apply', `--confirm-host=${realHost}`, '--json']);
  assert.strictEqual(r.code, 0, r.out);
  const parsed = JSON.parse(r.out);
  assert.strictEqual(parsed.applied.count, 1);
  assert.strictEqual(parsed.applied.amount, 1000);

  const migratedRow = await db.query('SELECT include_in_profit_calculation FROM deal_expenses WHERE id = $1', [migratedExpenseId]);
  assert.strictEqual(migratedRow.rows[0].include_in_profit_calculation, true, 'the migrated deal\'s expense must now be included');

  const nativeRow = await db.query('SELECT include_in_profit_calculation FROM deal_expenses WHERE id = $1', [nativeExpenseId]);
  assert.strictEqual(nativeRow.rows[0].include_in_profit_calculation, false, 'the native deal\'s expense must NEVER be auto-corrected');

  const activity = await db.query(`SELECT content FROM activities WHERE lead_id = $1 AND author = 'system:auditExpenseProfitInclusionFlags'`, [migratedLeadId]);
  assert.strictEqual(activity.rows.length, 1);
  assert.match(activity.rows[0].content, /\$1000\.00/);
  assert.match(activity.rows[0].content, /Migrated Vendor/);

  const nativeActivity = await db.query(`SELECT content FROM activities WHERE lead_id = $1 AND author = 'system:auditExpenseProfitInclusionFlags'`, [nativeLeadId]);
  assert.strictEqual(nativeActivity.rows.length, 0, 'no audit note is ever written for a row that was never corrected');
});

test('4. a second --apply run is idempotent — zero re-fix, zero duplicate audit notes, native row still untouched and still reported', { skip }, async () => {
  const realHost = new URL(DB_URL).host;
  const r = run(['--apply', `--confirm-host=${realHost}`, '--json']);
  assert.strictEqual(r.code, 0, r.out);
  const parsed = JSON.parse(r.out);
  assert.strictEqual(parsed.applied.count, 0, 'an already-corrected row must never be re-counted as fixed');
  assert.ok(parsed.native_needs_human_review.some((x) => x.id === nativeExpenseId), 'the native row must still be reported as needing review every run');

  const activity = await db.query(`SELECT id FROM activities WHERE lead_id = $1 AND author = 'system:auditExpenseProfitInclusionFlags'`, [migratedLeadId]);
  assert.strictEqual(activity.rows.length, 1, 'no duplicate audit note on a no-op re-run');
});
