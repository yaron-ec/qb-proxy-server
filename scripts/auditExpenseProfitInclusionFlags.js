#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * auditExpenseProfitInclusionFlags — the confirmed, CRM-wide root cause
 * behind "a project with real recorded expenses shows Total Costs: $0 /
 * Expected Profit: 100% margin" (CRM repair item 2, found while
 * investigating Ali & Mohemmed Lalani's reconciliation, item 5).
 *
 * ROOT CAUSE (confirmed via direct Postgres query, not guessed):
 * `crm-frontend/src/lib/financialCalc.js#classifyVendorExpenses` correctly
 * excludes any deal_expenses row where `include_in_profit_calculation` is
 * `false` — that is working as designed. The DATA, not the code, is wrong:
 * 49 of 51 deal_expenses rows CRM-wide ($54,181.39) carry
 * `include_in_profit_calculation = false`, even though the column's own
 * schema default (2026-14-crm-remaining-tables.sql) is `true`, and the live
 * create/update code in routes/dealExpenses.js only ever writes a value a
 * caller explicitly sent — confirmed to leave the column at its DB default
 * (true) whenever a request omits it. 47 of those 49 false rows
 * ($51,281.39) belong to deals with a `legacy_base44_id` — i.e. imported
 * from the Base44 migration, where this flag was most likely defaulted to
 * false across the board rather than deliberately set per row. The
 * remaining 2 false rows ($2,900.00) belong to NATIVELY CREATED deals (no
 * legacy_base44_id) — these were created through the live UI, where a
 * human must have explicitly unchecked "Include in profit calculation" for
 * a real reason this script cannot know — they are NEVER auto-corrected.
 *
 * READ-ONLY BY DEFAULT.
 *   node scripts/auditExpenseProfitInclusionFlags.js [--json]
 *   node scripts/auditExpenseProfitInclusionFlags.js --apply --confirm-host=<db host> [--json]
 *
 * `--apply` flips ONLY the migrated-deal rows (MIGRATED_LIKELY_SHOULD_INCLUDE)
 * from false to true — never the native-deal rows
 * (NATIVE_NEEDS_HUMAN_REVIEW), which always require a human decision and
 * are reported, never corrected, by this script. Each flip writes one
 * `activities` audit note on the expense's lead naming the correction,
 * the old/new count, and the dollar amount restored to profit
 * calculation — nothing else about the row (amount, vendor, category,
 * payment status, receipt) is ever touched. Idempotent: a row already
 * `true` is simply not re-flipped on a later run.
 */
'use strict';

const db = require('../db/client');

const asJson = process.argv.includes('--json');
const apply = process.argv.includes('--apply');
const confirmHostArg = process.argv.find((a) => a.startsWith('--confirm-host='));
const confirmHost = confirmHostArg ? confirmHostArg.split('=')[1] : null;

async function main() {
  if (apply) {
    const realHost = (() => {
      try { return new URL(process.env.DATABASE_URL).host; } catch { return null; }
    })();
    if (!confirmHost || !realHost || confirmHost !== realHost) {
      console.error(`[auditExpenseProfitInclusionFlags] --apply requires --confirm-host=<the real DATABASE_URL host> (got "${confirmHost}", expected "${realHost}"). Refusing to write.`);
      process.exit(1);
    }
  }

  const { rows } = await db.query(
    `SELECT de.id, de.deal_id, de.lead_id, de.vendor_name, de.category, de.amount,
            de.include_in_profit_calculation, d.name AS deal_name, d.legacy_base44_id IS NOT NULL AS is_migrated,
            l.first_name, l.last_name
     FROM deal_expenses de
     JOIN deals d ON d.id = de.deal_id
     LEFT JOIN leads l ON l.id = de.lead_id
     WHERE de.include_in_profit_calculation = false
     ORDER BY d.name, de.expense_date`
  );

  const classified = rows.map((r) => ({
    ...r,
    classification: r.is_migrated ? 'MIGRATED_LIKELY_SHOULD_INCLUDE' : 'NATIVE_NEEDS_HUMAN_REVIEW',
  }));

  const toFix = classified.filter((r) => r.classification === 'MIGRATED_LIKELY_SHOULD_INCLUDE');
  const needsReview = classified.filter((r) => r.classification === 'NATIVE_NEEDS_HUMAN_REVIEW');

  const byDeal = {};
  for (const r of classified) {
    byDeal[r.deal_id] = byDeal[r.deal_id] || { deal_name: r.deal_name, rows: [] };
    byDeal[r.deal_id].rows.push(r);
  }

  const summary = {
    total_excluded_rows: classified.length,
    total_excluded_amount: classified.reduce((s, r) => s + Number(r.amount), 0),
    migrated_likely_should_include: { count: toFix.length, amount: toFix.reduce((s, r) => s + Number(r.amount), 0) },
    native_needs_human_review: { count: needsReview.length, amount: needsReview.reduce((s, r) => s + Number(r.amount), 0) },
    affected_deals: Object.keys(byDeal).length,
    apply_mode: apply,
  };

  let fixed = 0;
  let fixedAmount = 0;
  if (apply) {
    for (const r of toFix) {
      const upd = await db.query(
        `UPDATE deal_expenses SET include_in_profit_calculation = true, updated_at = NOW()
         WHERE id = $1 AND include_in_profit_calculation = false RETURNING id`,
        [r.id]
      );
      if (upd.rows.length === 0) continue; // already corrected by an earlier run — idempotent, not a re-count
      fixed++;
      fixedAmount += Number(r.amount);
      if (r.lead_id) {
        try {
          await db.query(
            `INSERT INTO activities (lead_id, type, content, author, source, created_at)
             VALUES ($1, 'note', $2, 'system:auditExpenseProfitInclusionFlags', 'manual', NOW())`,
            [r.lead_id, `🔧 Profit-calculation correction: expense "${r.vendor_name}" ($${Number(r.amount).toFixed(2)}, ${r.category}) was excluded from this project's profit calculation by a data issue from the original migration — corrected to be included. No amount, vendor, or payment data was changed.`]
          );
        } catch (e) {
          console.warn(`[auditExpenseProfitInclusionFlags] activity log failed for lead ${r.lead_id}:`, e.message);
        }
      }
    }
  }

  const output = {
    summary,
    applied: apply ? { count: fixed, amount: fixedAmount } : null,
    migrated_likely_should_include: toFix.map(({ id, deal_name, vendor_name, category, amount }) => ({ id, deal_name, vendor_name, category, amount })),
    native_needs_human_review: needsReview.map(({ id, deal_name, vendor_name, category, amount, first_name, last_name }) => ({ id, deal_name, lead_name: `${first_name || ''} ${last_name || ''}`.trim(), vendor_name, category, amount })),
  };

  if (asJson) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`Expense profit-inclusion flag audit — ${summary.total_excluded_rows} excluded row(s) across ${summary.affected_deals} deal(s), totaling $${summary.total_excluded_amount.toFixed(2)} hidden from profit calculations.`);
    console.log(`  Migrated deals (likely should include): ${summary.migrated_likely_should_include.count} rows, $${summary.migrated_likely_should_include.amount.toFixed(2)}`);
    console.log(`  Native deals (needs human review, never auto-corrected): ${summary.native_needs_human_review.count} rows, $${summary.native_needs_human_review.amount.toFixed(2)}`);
    if (apply) {
      console.log(`  APPLIED: corrected ${fixed} row(s), restoring $${fixedAmount.toFixed(2)} to profit calculations.`);
    } else {
      console.log('  (report-only — re-run with --apply --confirm-host=<db host> to correct the migrated-deal rows)');
    }
    if (needsReview.length > 0) {
      console.log('\n  Rows needing human review (never auto-corrected):');
      for (const r of needsReview) {
        console.log(`    - ${r.deal_name}: "${r.vendor_name}" ($${Number(r.amount).toFixed(2)}, ${r.category})`);
      }
    }
  }

  await db.pool.end();
}

main().catch((e) => {
  console.error('[auditExpenseProfitInclusionFlags] fatal:', e.message);
  process.exit(1);
});
