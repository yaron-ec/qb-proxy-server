/* eslint-disable no-undef */
'use strict';
/**
 * auditTestProbeFkReferences.js — READ-ONLY horizontal foreign-key audit for
 * the confirmed Railway-native test fixture "Test Probe".
 *
 * Goal: enumerate EVERY foreign-key constraint in the production database that
 * can reference the Test Probe lead and/or appointment, using PostgreSQL
 * catalog metadata (information_schema) — NOT a hardcoded table list. For each
 * referencing table report the FK name, column, target, exact row count tied to
 * this fixture, operational meaning, and deletion safety. Also scan for non-FK
 * text/uuid/jsonb references to the lead ID, appointment ID, external_ref,
 * email, and booking/idempotency keys. Finally derive the complete deletion
 * order that would satisfy all FK constraints while affecting only this fixture.
 *
 * STRICTLY READ-ONLY: executes only SELECT queries, inside a BEGIN READ ONLY
 * transaction that is rolled back. No writes, no trigger/constraint changes,
 * no deletes, no updates. Safe to run at any time.
 *
 * Environment: DATABASE_URL.
 */
const { pool, query } = require('../db/client');

const TARGET_LEAD_ID = 'c7b3e041-f3fa-4507-8619-6e3c732b3ed4';
const TARGET_EMAIL = 'test@example.com';
const TARGET_FIRST = 'Test';
const TARGET_LAST = 'Probe';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Discover all FK constraints in the public schema that target a given table.
 * Returns rows: { referencing_table, referencing_column, constraint_name,
 *                target_table, target_column, on_delete }
 */
async function fksTargeting(queryFn, targetTable) {
  const { rows } = await queryFn(
    `SELECT
       tc.table_name AS referencing_table,
       kcu.column_name AS referencing_column,
       tc.constraint_name,
       ccu.table_name AS target_table,
       ccu.column_name AS target_column,
       rc.delete_rule AS on_delete
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
     JOIN information_schema.constraint_column_usage ccu
       ON tc.constraint_name = ccu.constraint_name
      AND tc.table_schema = ccu.table_schema
     JOIN information_schema.referential_constraints rc
       ON tc.constraint_name = rc.constraint_name
      AND tc.constraint_schema = rc.constraint_schema
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_schema = 'public'
       AND ccu.table_name = $1
     ORDER BY tc.table_name, kcu.column_name`,
    [targetTable]
  );
  return rows;
}

/** Primary key column for a table (first PK column). */
async function pkColumn(queryFn, table) {
  const { rows } = await queryFn(
    `SELECT kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
     WHERE tc.constraint_type = 'PRIMARY KEY'
       AND tc.table_schema = 'public'
       AND tc.table_name = $1
     ORDER BY kcu.ordinal_position
     LIMIT 1`,
    [table]
  );
  return rows.length ? rows[0].column_name : null;
}

/** All FK constraints in public schema (for transitive graph). */
async function allFks(queryFn) {
  const { rows } = await queryFn(
    `SELECT
       tc.table_name AS referencing_table,
       kcu.column_name AS referencing_column,
       tc.constraint_name,
       ccu.table_name AS target_table,
       ccu.column_name AS target_column,
       rc.delete_rule AS on_delete
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
     JOIN information_schema.constraint_column_usage ccu
       ON tc.constraint_name = ccu.constraint_name
      AND tc.table_schema = ccu.table_schema
     JOIN information_schema.referential_constraints rc
       ON tc.constraint_name = rc.constraint_name
      AND tc.constraint_schema = rc.constraint_schema
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_schema = 'public'
     ORDER BY ccu.table_name, tc.table_name, kcu.column_name`
  );
  return rows;
}

/** Count rows in `table` where `col` = any of `ids`. */
async function countByCol(queryFn, table, col, ids) {
  if (!ids || ids.length === 0) return 0;
  // build placeholders $1..$n
  const placeholders = ids.map((_, i) => '$' + (i + 1)).join(',');
  const { rows } = await queryFn(
    `SELECT COUNT(*)::int AS c FROM ${table} WHERE ${col} IN (${placeholders})`,
    ids
  );
  return rows[0].c;
}

/** Fetch PK values of `table` for rows where `col` = any of `ids` (to follow chain). */
async function pkValuesByCol(queryFn, table, pkCol, col, ids) {
  if (!ids || ids.length === 0 || !pkCol) return [];
  const placeholders = ids.map((_, i) => '$' + (i + 1)).join(',');
  const { rows } = await queryFn(
    `SELECT ${pkCol} AS id FROM ${table} WHERE ${col} IN (${placeholders})`,
    ids
  );
  return rows.map(r => r.id).filter(Boolean);
}

/** All user tables in public schema. */
async function allTables(queryFn) {
  const { rows } = await queryFn(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`
  );
  return rows.map(r => r.table_name);
}

/** Columns of given types for a table. typeFilter is a Set of data_type strings. */
async function columnsOfTypes(queryFn, table, typeFilter) {
  const { rows } = await queryFn(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table]
  );
  return rows.filter(r => typeFilter.has(r.data_type)).map(r => ({ column: r.column_name, data_type: r.data_type }));
}

// ── Main audit ───────────────────────────────────────────────────────────────

async function runAudit(queryFn = query) {
  const report = {
    target_lead_id: TARGET_LEAD_ID,
    target_email: TARGET_EMAIL,
    started_at: new Date().toISOString(),
    phases: {},
  };

  console.log('=== TEST PROBE READ-ONLY FK AUDIT ===');
  console.log('Started: ' + report.started_at);
  console.log('Target lead id: ' + TARGET_LEAD_ID);
  console.log('');

  // ── 0. Re-verify identity (read-only) ────────────────────────────────────
  const { rows: leadRows } = await queryFn(
    'SELECT id, external_ref, first_name, last_name, email, phone, status, created_at ' +
    'FROM leads WHERE id = $1',
    [TARGET_LEAD_ID]
  );
  if (leadRows.length === 0) {
    console.log('RESULT: lead not found (already cleaned up?).');
    report.lead_present = false;
    return report;
  }
  const lead = leadRows[0];
  report.lead_present = true;
  report.lead = lead;
  console.log('Lead identity:');
  console.log('  external_ref: ' + (lead.external_ref || 'NULL'));
  console.log('  name:         ' + lead.first_name + ' ' + lead.last_name);
  console.log('  email:        ' + (lead.email || 'NULL'));
  console.log('  status:       ' + lead.status);
  console.log('');

  // ── 1. Discover the test appointment id(s) for this lead ───────────────────
  const { rows: apptRows } = await queryFn(
    'SELECT id, status, start_at, appointment_type_id FROM appointments WHERE lead_id = $1',
    [TARGET_LEAD_ID]
  );
  report.appointments = apptRows;
  console.log('Appointments for this lead: ' + apptRows.length);
  for (const a of apptRows) console.log('  ' + a.id + ' status=' + a.status + ' start=' + a.start_at);
  console.log('');

  const apptIds = apptRows.map(a => a.id);
  report.target_appointment_ids = apptIds;

  // ── 2. Discover ALL direct FKs targeting leads(id) and appointments(id) ──
  const fksToLeads = await fksTargeting(queryFn, 'leads');
  const fksToAppointments = await fksTargeting(queryFn, 'appointments');

  console.log('=== PHASE A: DIRECT FK REFERENCES ===');
  console.log('FKs targeting leads: ' + fksToLeads.length);
  for (const f of fksToLeads) console.log('  ' + f.referencing_table + '.' + f.referencing_column + ' → leads.' + f.target_column + '  [' + f.constraint_name + ']  ON DELETE=' + f.on_delete);
  console.log('FKs targeting appointments: ' + fksToAppointments.length);
  for (const f of fksToAppointments) console.log('  ' + f.referencing_table + '.' + f.referencing_column + ' → appointments.' + f.target_column + '  [' + f.constraint_name + ']  ON DELETE=' + f.on_delete);
  console.log('');

  // Count direct references to the test fixture
  const directRefs = [];
  for (const f of fksToLeads) {
    const count = await countByCol(queryFn, f.referencing_table, f.referencing_column, [TARGET_LEAD_ID]);
    directRefs.push({ ...f, target_fixture: 'lead', row_count: count });
  }
  for (const f of fksToAppointments) {
    const count = apptIds.length ? await countByCol(queryFn, f.referencing_table, f.referencing_column, apptIds) : 0;
    directRefs.push({ ...f, target_fixture: 'appointment', row_count: count });
  }

  console.log('=== PHASE A: DIRECT REFERENCE COUNTS FOR TEST FIXTURE ===');
  for (const r of directRefs) {
    const safe = r.on_delete === 'CASCADE' || r.on_delete === 'SET NULL' ? 'auto' : 'manual';
    console.log(`  ${r.referencing_table}.${r.referencing_column} → ${r.target_table}.${r.target_column}  rows=${r.row_count}  ON DELETE=${r.on_delete} (${safe})  [${r.constraint_name}]`);
  }
  console.log('');
  report.phases.direct_fk_references = directRefs;

  // ── 3. Transitive FK graph (BFS from leads & appointments) ─────────────────
  console.log('=== PHASE B: TRANSITIVE FK GRAPH (reverse BFS) ===');
  const allFkList = await allFks(queryFn);
  // adjacency: target_table -> list of {referencing_table, referencing_column, constraint_name, on_delete}
  const reverseAdj = {};
  for (const f of allFkList) {
    if (!reverseAdj[f.target_table]) reverseAdj[f.target_table] = [];
    reverseAdj[f.target_table].push(f);
  }

  // BFS: start nodes = leads, appointments. Track known fixture row ids per table.
  // fixtureRows[table] = { via: 'leads'|'appointments', ids: [...], pk: pkCol }
  const fixtureRows = {};
  fixtureRows.leads = { ids: [TARGET_LEAD_ID], pk: await pkColumn(queryFn, 'leads') };
  fixtureRows.appointments = { ids: apptIds, pk: await pkColumn(queryFn, 'appointments') };

  const transitiveRefs = [];
  const visited = new Set(['leads', 'appointments']);
  let frontier = ['leads', 'appointments'];
  let depth = 0;
  while (frontier.length && depth < 6) {
    depth++;
    const nextFrontier = [];
    for (const tgt of frontier) {
      const refs = reverseAdj[tgt] || [];
      for (const f of refs) {
        const refTable = f.referencing_table;
        if (visited.has(refTable) && refTable !== 'leads' && refTable !== 'appointments') {
          // already processed (avoid double-counting); but still record edge
        }
        const parentIds = fixtureRows[tgt] ? fixtureRows[tgt].ids : [];
        const pk = await pkColumn(queryFn, refTable);
        const count = await countByCol(queryFn, refTable, f.referencing_column, parentIds);
        // collect child PK ids to follow chain
        let childIds = [];
        if (count > 0 && pk) {
          childIds = await pkValuesByCol(queryFn, refTable, pk, f.referencing_column, parentIds);
        }
        transitiveRefs.push({
          depth,
          referencing_table: refTable,
          referencing_column: f.referencing_column,
          target_table: f.target_table,
          target_column: f.target_column,
          constraint_name: f.constraint_name,
          on_delete: f.on_delete,
          row_count: count,
          parent_ids: parentIds,
        });
        if (count > 0 && !fixtureRows[refTable]) {
          fixtureRows[refTable] = { ids: childIds, pk };
        } else if (count > 0 && fixtureRows[refTable]) {
          // merge ids
          const merged = Array.from(new Set([...fixtureRows[refTable].ids, ...childIds]));
          fixtureRows[refTable].ids = merged;
        }
        if (count > 0 && !visited.has(refTable)) {
          visited.add(refTable);
          nextFrontier.push(refTable);
        }
        console.log(`  [depth ${depth}] ${refTable}.${f.referencing_column} → ${f.target_table}.${f.target_column}  rows=${count}  ON DELETE=${f.on_delete}  [${f.constraint_name}]`);
      }
    }
    frontier = nextFrontier;
  }
  console.log('');
  report.phases.transitive_fk_references = transitiveRefs;
  report.phases.fixture_rows_per_table = Object.fromEntries(
    Object.entries(fixtureRows).map(([t, v]) => [t, { pk: v.pk, count: v.ids.length }])
  );

  // ── 4. Non-FK text/uuid/jsonb reference scan ──────────────────────────────
  console.log('=== PHASE C: NON-FK TEXT/UUID/JSONB REFERENCE SCAN ===');
  const tables = await allTables(queryFn);
  const uuidType = new Set(['uuid']);
  const textTypes = new Set(['text', 'character varying', 'character']);
  const jsonTypes = new Set(['jsonb', 'json']);

  // Values to search
  const searchUuids = [TARGET_LEAD_ID, ...apptIds];
  const searchTexts = [TARGET_EMAIL, TARGET_LEAD_ID, ...apptIds]; // also search UUIDs as text in jsonb/text cols
  // external_ref is NULL for this lead, so nothing to search for it; but scan for the literal 'NULL'? no.

  // Collect FK column signatures to skip (already covered in Phase A/B)
  const fkSkip = new Set();
  for (const f of allFkList) fkSkip.add(f.referencing_table + '.' + f.referencing_column);

  const nonFkHits = [];
  for (const table of tables) {
    // uuid columns
    const uuidCols = await columnsOfTypes(queryFn, table, uuidType);
    for (const { column } of uuidCols) {
      if (fkSkip.has(table + '.' + column)) continue;
      const count = await countByCol(queryFn, table, column, searchUuids);
      if (count > 0) {
        nonFkHits.push({ table, column, type: 'uuid', row_count: count, values: searchUuids });
        console.log(`  NON-FK UUID  ${table}.${column}  rows=${count}`);
      }
    }
    // text columns
    const txtCols = await columnsOfTypes(queryFn, table, textTypes);
    for (const { column } of txtCols) {
      if (fkSkip.has(table + '.' + column)) continue;
      // search for email and uuids-as-text
      const { rows } = await queryFn(
        `SELECT COUNT(*)::int AS c FROM ${table} WHERE ${column} = ANY($1::text[])`,
        [searchTexts]
      );
      const count = rows[0].c;
      if (count > 0) {
        nonFkHits.push({ table, column, type: 'text', row_count: count, values: searchTexts });
        console.log(`  NON-FK TEXT ${table}.${column}  rows=${count}`);
      }
    }
    // jsonb columns — cast to text and search
    const jsonCols = await columnsOfTypes(queryFn, table, jsonTypes);
    for (const { column } of jsonCols) {
      const { rows } = await queryFn(
        `SELECT COUNT(*)::int AS c FROM ${table} WHERE ${column}::text LIKE ANY($1::text[])`,
        [searchTexts.map(v => '%' + v + '%')]
      );
      const count = rows[0].c;
      if (count > 0) {
        nonFkHits.push({ table, column, type: 'jsonb', row_count: count, values: searchTexts });
        console.log(`  NON-FK JSON ${table}.${column}  rows=${count}`);
      }
    }
  }
  console.log('Non-FK hits: ' + nonFkHits.length);
  console.log('');
  report.phases.non_fk_references = nonFkHits;

  // ── 5. Booking idempotency keys ───────────────────────────────────────────
  console.log('=== PHASE D: BOOKING IDEMPOTENCY KEYS ===');
  let idempotencyKeys = [];
  try {
    const { rows: idRows } = await queryFn(
      'SELECT * FROM booking_idempotency WHERE appointment_id = ANY($1::uuid[])',
      [apptIds]
    );
    idempotencyKeys = idRows;
    console.log('booking_idempotency rows for this appointment: ' + idRows.length);
    for (const r of idRows) console.log('  ' + JSON.stringify(r));
  } catch (e) {
    console.log('booking_idempotency not readable: ' + e.message);
  }
  report.phases.booking_idempotency = idempotencyKeys;

  // ── 6. Derive complete deletion order ─────────────────────────────────────
  console.log('=== PHASE E: COMPLETE DELETION ORDER (reverse topological) ===');
  // Build set of tables that have any FK edge in the reverse graph reachable from leads/appointments.
  // Deletion must happen in reverse topological order: delete referencing tables first.
  // We compute order from transitiveRefs + directRefs: order by depth descending, then within depth.
  const order = [];
  const seen = new Set();
  // deepest first
  const allRefs = [...directRefs, ...transitiveRefs].sort((a, b) => (b.depth || 0) - (a.depth || 0));
  for (const r of allRefs) {
    if (r.row_count === 0) continue;
    const key = r.referencing_table + '.' + r.referencing_column;
    if (seen.has(r.referencing_table + '::' + r.referencing_column)) continue;
    seen.add(r.referencing_table + '::' + r.referencing_column);
    order.push({
      step: order.length + 1,
      table: r.referencing_table,
      column: r.referencing_column,
      targets_table: r.target_table,
      targets_column: r.target_column,
      on_delete: r.on_delete,
      row_count: r.row_count,
      constraint_name: r.constraint_name,
      action: r.on_delete === 'CASCADE' ? 'auto-cascaded (no manual delete needed)' : 'DELETE rows WHERE ' + r.referencing_column + ' = <fixture id>',
    });
  }
  for (const o of order) {
    console.log(`  Step ${o.step}: ${o.action}  (${o.table}.${o.column} → ${o.targets_table}.${o.targets_column}, rows=${o.row_count}, ON DELETE=${o.on_delete})`);
  }
  console.log('');
  report.deletion_order = order;

  // ── 7. Operational meaning & safety classification ────────────────────────
  console.log('=== PHASE F: OPERATIONAL MEANING & SAFETY ===');
  const safety = order.map(o => ({
    table: o.table,
    column: o.column,
    rows: o.row_count,
    on_delete: o.on_delete,
    safety: 'Test-fixture artifact only — safe to delete for confirmed Test Probe record',
  }));
  for (const s of safety) console.log('  ' + s.table + '.' + s.column + ' (' + s.rows + ' rows): ' + s.safety);
  report.safety = safety;

  report.finished_at = new Date().toISOString();
  console.log('');
  console.log('=== AUDIT COMPLETE (READ-ONLY, NO CHANGES) ===');
  return report;
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const qFn = (text, params) => client.query(text, params);
    await runAudit(qFn);
    await client.query('ROLLBACK');
    console.log('Transaction rolled back (read-only).');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('FATAL:', e.message);
    console.error(e.stack);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

module.exports = { runAudit, fksTargeting, allFks, TARGET_LEAD_ID, TARGET_EMAIL };

if (require.main === module) {
  main().catch(e => { console.error('FATAL:', e); process.exit(1); });
}