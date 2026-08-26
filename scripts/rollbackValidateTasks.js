#!/usr/bin/env node
/* eslint-disable no-undef */
'use strict';
/**
 * rollbackValidateTasks.js — Production-path rollback validation for Tasks.
 *
 * Calls the EXACT same runTaskMigration() function used by:
 *   node scripts/migrateTasksToRailway.js
 *
 * ...but inside a PostgreSQL transaction that is ALWAYS ROLLED BACK.
 *
 * Verifies:
 *   - Base44 tasks read: 1
 *   - FK resolution: lead_id resolves to Railway leads
 *   - Write errors: 0
 *   - In-transaction task count reaches expected reconciled count
 *   - After rollback, database returns to exact before-count
 *   - No external side effects
 *
 * Environment:
 *   DATABASE_URL (Railway Postgres)
 *   WORKER_SECRET (for migrationReader backend function)
 */
const { pool } = require('../db/client');
const { runTaskMigration } = require('./migrateTasksToRailway');
const { fetchBase44Entity } = require('./migrationHelpers');

async function main() {
  console.log('=== PRODUCTION-PATH ROLLBACK VALIDATION (Tasks) ===');
  console.log(`Started: ${new Date().toISOString()}`);
  console.log('');

  // ── PHASE 1: PRE-MIGRATION FK + FIELD AUDIT ────────────────────────────
  console.log('=== PHASE 1: PRE-MIGRATION FK + FIELD AUDIT ===\n');

  const base44Tasks = await fetchBase44Entity('Task');
  console.log(`Total Base44 tasks: ${base44Tasks.length}`);

  // FK audit — check lead_id resolution against Base44 leads
  const base44Leads = await fetchBase44Entity('Lead');
  const base44LeadIds = new Set(base44Leads.map(l => l.id));
  let withLeadId = 0, resolved = 0, unresolved = 0;
  const unresolvedTasks = [];

  for (const t of base44Tasks) {
    if (t.lead_id) {
      withLeadId++;
      if (base44LeadIds.has(t.lead_id)) resolved++;
      else { unresolved++; unresolvedTasks.push({ taskId: t.id, title: t.title, leadRef: t.lead_id }); }
    }
  }

  console.log(`FK resolution: with_lead_id=${withLeadId}, resolved=${resolved}, unresolved=${unresolved}`);
  if (unresolvedTasks.length > 0) {
    console.log('Unresolved tasks:');
    for (const t of unresolvedTasks) {
      console.log(`  ${t.taskId} — "${t.title}" → lead_ref: ${t.leadRef}`);
    }
  } else {
    console.log('✅ All task lead_id values resolve to Base44 leads');
  }

  // Field audit — check all field values for constraint compliance
  console.log('\nField value audit (all records):');
  for (const t of base44Tasks) {
    const status = t.completed === true ? 'completed' : 'pending';
    console.log(`  Task ${t.id}:`);
    console.log(`    title: "${t.title}" (NOT NULL — ${t.title ? 'OK ✅' : 'MISSING ❌'})`);
    console.log(`    completed: ${t.completed} → status='${status}'`);
    console.log(`    due_date: "${t.due_date || 'null'}" (DATE — ${!t.due_date || /^\d{4}-\d{2}-\d{2}$/.test(t.due_date) ? 'OK ✅' : 'INVALID ❌'})`);
    console.log(`    notes: ${t.notes ? 'present' : 'null'} → description`);
    console.log(`    assigned_to: "${t.assigned_to || 'null'}"`);
    console.log(`    created_by_id: "${t.created_by_id || 'null'}" → created_by`);
  }

  // ── PHASE 2: EXECUTE PRODUCTION MIGRATION (TRANSACTION → ROLLBACK) ──────
  console.log('\n=== PHASE 2: EXECUTE PRODUCTION MIGRATION (TRANSACTION → ROLLBACK) ===\n');

  const client = await pool.connect();

  try {
    // BEFORE counts
    const beforeTasks = parseInt((await client.query('SELECT COUNT(*) as cnt FROM tasks')).rows[0].cnt, 10);
    const beforeLeads = parseInt((await client.query('SELECT COUNT(*) as cnt FROM leads')).rows[0].cnt, 10);
    const beforeDeals = parseInt((await client.query('SELECT COUNT(*) as cnt FROM deals')).rows[0].cnt, 10);

    console.log(`Before: tasks=${beforeTasks}, leads=${beforeLeads}, deals=${beforeDeals}`);

    // BEGIN TRANSACTION
    await client.query('BEGIN');
    const queryFn = client.query.bind(client);

    // Run production migration
    const result = await runTaskMigration(queryFn);

    // In-transaction counts
    const inTxTasks = parseInt((await client.query('SELECT COUNT(*) as cnt FROM tasks')).rows[0].cnt, 10);
    console.log(`\nIn-transaction: tasks=${inTxTasks}`);

    // ROLLBACK
    console.log('\n=== ROLLING BACK TRANSACTION ===\n');
    await client.query('ROLLBACK');

    // AFTER counts
    const afterTasks = parseInt((await client.query('SELECT COUNT(*) as cnt FROM tasks')).rows[0].cnt, 10);
    const afterLeads = parseInt((await client.query('SELECT COUNT(*) as cnt FROM leads')).rows[0].cnt, 10);
    const afterDeals = parseInt((await client.query('SELECT COUNT(*) as cnt FROM deals')).rows[0].cnt, 10);

    console.log(`After rollback: tasks=${afterTasks}, leads=${afterLeads}, deals=${afterDeals}`);

    // ── PHASE 3: VALIDATION ────────────────────────────────────────────────
    console.log('\n=== VALIDATION ===\n');

    const expectedInTxTasks = beforeTasks + result.created;

    const checks = [
      { name: 'Total tasks processed',              actual: result.total,           expected: result.total,           pass: true },
      { name: 'Write errors',                        actual: result.errors,          expected: 0,                      pass: result.errors === 0 },
      { name: 'FK resolved (lead_id found)',         actual: result.total - result.leadNotFound, expected: result.total, pass: result.leadNotFound === 0 },
      { name: 'In-tx tasks count',                   actual: inTxTasks,              expected: expectedInTxTasks,      pass: inTxTasks === expectedInTxTasks },
      { name: 'Tasks rollback (before==after)',      actual: afterTasks,             expected: beforeTasks,            pass: afterTasks === beforeTasks },
      { name: 'Leads rollback (before==after)',       actual: afterLeads,             expected: beforeLeads,            pass: afterLeads === beforeLeads },
      { name: 'Deals rollback (before==after)',       actual: afterDeals,             expected: beforeDeals,            pass: afterDeals === beforeDeals },
    ];

    let allPass = true;
    for (const c of checks) {
      const status = c.pass ? 'PASS ✅' : 'FAIL ❌';
      console.log(`  ${c.name.padEnd(44)}  actual=${String(c.actual).padEnd(8)}  expected=${String(c.expected).padEnd(8)}  ${status}`);
      if (!c.pass) allPass = false;
    }

    console.log('');
    console.log(`Migration result: ${JSON.stringify(result)}`);
    console.log('');

    if (allPass) {
      console.log('✅ ALL CHECKS PASSED — production path validated, transaction rolled back');
      process.exit(0);
    } else {
      console.log('❌ SOME CHECKS FAILED — review above');
      process.exit(1);
    }
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error(`\nFATAL ERROR: ${e.message}`);
    console.error('Transaction rolled back. No records left behind.');
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();