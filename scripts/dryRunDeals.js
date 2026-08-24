#!/usr/bin/env node
/* eslint-disable no-undef */
'use strict';
/**
 * Stage 2 Deals CRUD — Dry-Run Validator (REAL isolated PostgreSQL). CORRECTED.
 *
 * Validates the 2026-11-crm-deals migration (Railway-native: deals.lead_id UUID
 * FK → leads(id), Base44 IDs as legacy metadata) and the dealModel migration
 * resolution logic against a REAL, isolated, NON-PRODUCTION PostgreSQL instance
 * (Railway project: nurturing-success ONLY).
 *
 * Tests:
 *   A. Base44 Deal legacy lead id resolves through leads.external_ref
 *   B. inserted Deal stores the Railway Lead UUID (lead_id), not the legacy id
 *   C. unresolved legacy Lead is rejected/reported (no insert, no invented lead)
 *   D. FK prevents a Deal from pointing to a nonexistent Railway Lead
 *   E. multiple Deals can belong to the same Railway Lead
 *   F. legacy_base44_id is unique and does NOT determine ownership
 *   G. invalid stage rejected by CHECK constraint
 *   H. invalid payment_status rejected by CHECK constraint
 *   I. update partial + updated_at trigger fires
 *   J. RBAC pure checks (canAccessDeal / canWriteDeal — target business rules)
 *   K. list scoping SQL: sales_rep sees own deals only (assigned_rep/created_by)
 *
 * ISOLATION: each test runs inside its own SAVEPOINT and rolls back. The
 * migration (DDL) is applied once before any savepoint and persists across
 * tests. Idempotency: re-run the migration, expect zero errors.
 *
 * SAFETY:
 *   - Requires TEST_DATABASE_URL. Refuses without it.
 *   - NEVER falls back to DATABASE_URL or any production variable.
 *   - Aborts if TEST_DATABASE_URL matches DATABASE_URL or looks production-only.
 *   - Refuses if the URL references disciplined-heart.
 *   - Runs the ENTIRE dry run inside a single transaction and ROLLBACKs.
 *     Zero persistent changes. Test DB left pristine and reusable.
 *
 * USAGE (from src/proxy-server/):
 *   TEST_DATABASE_URL=postgres://user:pass@host:5432/testdb \
 *     node scripts/dryRunDeals.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const model = require('../lib/dealModel');

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  console.error('FATAL: TEST_DATABASE_URL not set. Refusing to run.');
  console.error('       Requires an isolated NON-PRODUCTION PostgreSQL instance.');
  process.exit(2);
}
const PROD_DB = process.env.DATABASE_URL || '';
function normalizeUrl(u) { return String(u || '').replace(/\?.*$/, '').trim().toLowerCase(); }
if (PROD_DB && normalizeUrl(TEST_DB) === normalizeUrl(PROD_DB)) {
  console.error('FATAL: TEST_DATABASE_URL matches DATABASE_URL (production). Refusing.');
  process.exit(2);
}
if (/disciplined-heart/i.test(TEST_DB)) {
  console.error('FATAL: TEST_DATABASE_URL references disciplined-heart. Refusing.');
  process.exit(2);
}
if (/prod|production/i.test(TEST_DB) && !/test|staging|dev|dry|sandbox|nurturing/i.test(TEST_DB)) {
  console.error('FATAL: TEST_DATABASE_URL appears to reference a production database.');
  process.exit(2);
}

let pg;
try { pg = require('pg'); } catch (e) {
  console.error('FATAL: `pg` not installed. Run from src/proxy-server/ directory.');
  process.exit(2);
}

function splitSql(sql) {
  const lines = sql.split('\n').filter((l) => !l.trim().startsWith('--'));
  const clean = lines.join('\n');
  const out = []; let buf = ''; let inDollar = false; let inQuote = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '$' && clean[i + 1] === '$' && !inQuote) { inDollar = !inDollar; buf += '$$'; i++; continue; }
    if (ch === "'" && !inDollar) inQuote = !inQuote;
    buf += ch;
    if (ch === ';' && !inDollar && !inQuote) { const t = buf.trim().replace(/;$/, '').trim(); if (t) out.push(t); buf = ''; }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}
function preview(s, n = 80) { const c = s.replace(/\s+/g, ' ').trim(); return c.length > n ? c.slice(0, n) + '…' : c; }

async function run() {
  const report = {
    timestamp: new Date().toISOString(),
    testDatabaseUrl: TEST_DB.replace(/:[^:@/]+@/, ':***@'),
    migrationFile: 'db/migrations/2026-11-crm-deals.sql',
    pgVersion: null,
    migration: { statements: [], errors: [] },
    tests: {},
    idempotency: null,
    overallPass: false,
    summary: {},
  };

  const pool = new pg.Pool({ connectionString: TEST_DB });
  const client = await pool.connect();
  const db = { query: (t, p) => client.query(t, p) };

  async function withTest(name, fn) {
    await client.query(`SAVEPOINT ${name}`);
    try { await fn(); }
    finally { await client.query(`ROLLBACK TO SAVEPOINT ${name}`); }
  }

  try {
    const v = await client.query('SHOW server_version');
    report.pgVersion = v.rows[0].server_version;

    await client.query('BEGIN');

    // ── Minimal leads stub so the deals FK (lead_id → leads.id) can be created.
    // IF NOT EXISTS: a no-op if the real leads table is already present.
    await client.query(`CREATE TABLE IF NOT EXISTS leads (id UUID PRIMARY KEY, external_ref TEXT UNIQUE)`);

    // ── Apply migration (persists across all test savepoints) ──
    const migrationPath = path.join(__dirname, '..', 'db', 'migrations', '2026-11-crm-deals.sql');
    const statements = splitSql(fs.readFileSync(migrationPath, 'utf8'));
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      const t0 = performance.now();
      try {
        await client.query(stmt);
        report.migration.statements.push({ index: i + 1, ok: true, ms: +(performance.now() - t0).toFixed(3), preview: preview(stmt) });
      } catch (e) {
        report.migration.statements.push({ index: i + 1, ok: false, ms: +(performance.now() - t0).toFixed(3), preview: preview(stmt), error: e.message });
        report.migration.errors.push({ index: i + 1, error: e.message });
      }
    }

    const admin = { role: 'admin', email: 'admin@ecconstructiongroup.com', id: 'admin-1' };
    const rep = { role: 'sales_rep', email: 'yaron@ecconstructiongroup.com', full_name: 'Yaron Drilevich', id: 'rep-1' };
    const manager = { role: 'manager', email: 'mgr@ecconstructiongroup.com', id: 'mgr-1' };
    const office = { role: 'office', email: 'off@ecconstructiongroup.com', id: 'off-1' };

    // Seed a Railway Lead with a known external_ref (Base44 Lead ObjectId).
    async function seedLead(externalRef) {
      const r = await client.query(`INSERT INTO leads (id, external_ref) VALUES (gen_random_uuid(), $1) RETURNING id`, [externalRef]);
      return r.rows[0].id;
    }

    // ── Test A: Base44 Deal legacy lead id resolves through leads.external_ref ──
    await withTest('A', async () => {
      const leadId = await seedLead('b44lead-joann');
      const b44Deal = { id: 'b44deal-001', lead_id: 'b44lead-joann', name: 'Joann Gregg', amount: 4724, stage: 'Sold / Estimate Approved', assigned_rep: 'Yaron Drilevich' };
      const plan = await model.migrateDealFromBase44(db, b44Deal);
      let inserted = null;
      if (plan.status === 'migrated') {
        const cols = Object.keys(plan.dealPayload);
        const vals = cols.map((_, i) => `$${i + 1}`);
        const ins = await client.query(`INSERT INTO deals (${cols.join(',')}) VALUES (${vals.join(',')}) RETURNING *`, cols.map((c) => plan.dealPayload[c]));
        inserted = model.serializeDeal(ins.rows[0]);
      }
      report.tests.A = {
        scenario: 'Base44 Deal legacy lead id resolves through leads.external_ref',
        planStatus: plan.status, railwayLeadId: plan.railwayLeadId,
        pass: plan.status === 'migrated' && plan.railwayLeadId === leadId
          && !!inserted && inserted.lead_id === leadId && inserted.legacy_base44_id === 'b44deal-001',
      };
    });

    // ── Test B: inserted Deal stores the Railway Lead UUID (not the legacy id) ──
    await withTest('B', async () => {
      const leadId = await seedLead('b44lead-b');
      const b44Deal = { id: 'b44deal-b', lead_id: 'b44lead-b', name: 'B Deal', amount: 1000 };
      const plan = await model.migrateDealFromBase44(db, b44Deal);
      const cols = Object.keys(plan.dealPayload);
      const vals = cols.map((_, i) => `$${i + 1}`);
      const ins = await client.query(`INSERT INTO deals (${cols.join(',')}) VALUES (${vals.join(',')}) RETURNING *`, cols.map((c) => plan.dealPayload[c]));
      const d = model.serializeDeal(ins.rows[0]);
      report.tests.B = {
        scenario: 'inserted Deal stores Railway Lead UUID; legacy id is metadata',
        leadIdInRow: d.lead_id, legacyLeadIdInRow: d.legacy_base44_lead_id,
        pass: d.lead_id === leadId && d.lead_id !== 'b44lead-b'
          && d.legacy_base44_lead_id === 'b44lead-b' && d.legacy_base44_id === 'b44deal-b',
      };
    });

    // ── Test C: unresolved legacy Lead is rejected/reported (no insert) ──
    await withTest('C', async () => {
      const b44Deal = { id: 'b44deal-c', lead_id: 'b44lead-NOWHERE', name: 'C Deal', amount: 500 };
      const plan = await model.migrateDealFromBase44(db, b44Deal);
      // Caller must NOT insert when unresolved. Count deals with this legacy id.
      const count = await client.query(`SELECT COUNT(*)::int AS n FROM deals WHERE legacy_base44_id = $1`, ['b44deal-c']);
      report.tests.C = {
        scenario: 'unresolved legacy Lead reported, not inserted, no invented lead',
        planStatus: plan.status, reason: plan.reason, dealCount: count.rows[0].n,
        pass: plan.status === 'unresolved' && plan.reason === 'railway_lead_not_found_by_external_ref' && count.rows[0].n === 0,
      };
    });

    // ── Test D: FK prevents Deal pointing to a nonexistent Railway Lead ──
    await withTest('D', async () => {
      const fakeUuid = '11111111-1111-4111-8111-111111111111';
      let fkRejected = false;
      try {
        await client.query(`INSERT INTO deals (lead_id, name) VALUES ($1,$2)`, [fakeUuid, 'Ghost Lead Deal']);
      } catch (e) { fkRejected = e.code === '23503' || /foreign key/i.test(e.message); }
      report.tests.D = { scenario: 'FK rejects nonexistent Railway Lead', pass: fkRejected };
    });

    // ── Test E: multiple Deals can belong to the same Railway Lead ──
    await withTest('E', async () => {
      const leadId = await seedLead('b44lead-multi');
      await client.query(`INSERT INTO deals (lead_id, name, amount, legacy_base44_id) VALUES ($1,$2,$3,$4)`, [leadId, 'Job 1', 4724, 'b44-e1']);
      await client.query(`INSERT INTO deals (lead_id, name, amount, legacy_base44_id) VALUES ($1,$2,$3,$4)`, [leadId, 'Job 2', 4869, 'b44-e2']);
      await client.query(`INSERT INTO deals (lead_id, name, amount) VALUES ($1,$2,$3)`, [leadId, 'Job 3 (native)', 16500]);
      const deals = await client.query(`SELECT * FROM deals WHERE lead_id = $1 ORDER BY name`, [leadId]);
      report.tests.E = {
        scenario: 'multiple Deals belong to the same Railway Lead',
        count: deals.rows.length,
        pass: deals.rows.length === 3 && deals.rows.every((r) => r.lead_id === leadId),
      };
    });

    // ── Test F: legacy_base44_id is unique and does NOT determine ownership ──
    await withTest('F', async () => {
      const lead1 = await seedLead('b44lead-f1');
      const lead2 = await seedLead('b44lead-f2');
      await client.query(`INSERT INTO deals (lead_id, name, legacy_base44_id) VALUES ($1,$2,$3)`, [lead1, 'F-A', 'b44-dup']);
      let dupRejected = false;
      try {
        await client.query(`INSERT INTO deals (lead_id, name, legacy_base44_id) VALUES ($1,$2,$3)`, [lead2, 'F-B', 'b44-dup']);
      } catch (e) { dupRejected = e.code === '23505' || /unique/i.test(e.message); }
      // Ownership is via lead_id (UUID), not legacy_base44_id: two different leads,
      // same legacy id must still be rejected because legacy_base44_id is unique.
      const ownByLead = await client.query(`SELECT lead_id FROM deals WHERE legacy_base44_id = $1`, ['b44-dup']);
      report.tests.F = {
        scenario: 'legacy_base44_id unique; ownership is lead_id UUID not legacy id',
        dupRejected, ownerIsLead1: ownByLead.rows[0] && ownByLead.rows[0].lead_id === lead1,
        pass: dupRejected && ownByLead.rows[0].lead_id === lead1,
      };
    });

    // ── Test G: invalid stage rejected by CHECK ──
    await withTest('G', async () => {
      const leadId = await seedLead('b44lead-g');
      let rejected = false;
      try { await client.query(`INSERT INTO deals (lead_id, name, stage) VALUES ($1,$2,$3)`, [leadId, 'X', 'Bogus Stage']); }
      catch (e) { rejected = /check constraint/i.test(e.message); }
      report.tests.G = { scenario: 'invalid stage rejected by CHECK', pass: rejected };
    });

    // ── Test H: invalid payment_status rejected ──
    await withTest('H', async () => {
      const leadId = await seedLead('b44lead-h');
      let rejected = false;
      try { await client.query(`INSERT INTO deals (lead_id, name, payment_status) VALUES ($1,$2,$3)`, [leadId, 'X', 'bogus']); }
      catch (e) { rejected = /check constraint/i.test(e.message); }
      report.tests.H = { scenario: 'invalid payment_status rejected', pass: rejected };
    });

    // ── Test I: update partial + updated_at trigger ──
    await withTest('I', async () => {
      const leadId = await seedLead('b44lead-i');
      const ins = await client.query(`INSERT INTO deals (lead_id, name, amount) VALUES ($1,$2,$3) RETURNING *`, [leadId, 'Update Me', 1000]);
      const origUpdatedAt = ins.rows[0].updated_at;
      await new Promise((r) => setTimeout(r, 20));
      await client.query(`UPDATE deals SET amount=$2 WHERE id=$1`, [ins.rows[0].id, 2000]);
      const sel = await client.query(`SELECT * FROM deals WHERE id=$1`, [ins.rows[0].id]);
      const d = model.serializeDeal(sel.rows[0]);
      report.tests.I = {
        scenario: 'update partial + updated_at trigger fires',
        pass: d.amount === 2000 && new Date(d.updated_date) > new Date(origUpdatedAt),
      };
    });

    // ── Test J: RBAC pure (target business rules) ──
    await withTest('J', async () => {
      const deal = { assigned_rep: 'yaron@ecconstructiongroup.com', created_by: 'yaron@ecconstructiongroup.com' };
      const other = { assigned_rep: 'michelle@ecconstructiongroup.com', created_by: 'michelle@ecconstructiongroup.com' };
      report.tests.J = {
        scenario: 'RBAC pure checks (target business rules)',
        pass:
          model.canAccessDeal(admin, deal) && model.canAccessDeal(manager, deal)
          && !model.canAccessDeal(office, deal)
          && model.canAccessDeal(rep, deal) && !model.canAccessDeal(rep, other)
          && model.canWriteDeal(rep, deal, 'update') && !model.canWriteDeal(rep, other, 'update')
          && model.canWriteDeal(manager, deal, 'update')   // manager CAN update (target rule)
          && model.canWriteDeal(admin, deal, 'update')
          && model.canWriteDeal(admin, deal, 'delete')
          && !model.canWriteDeal(manager, deal, 'delete')  // delete ADMIN ONLY
          && !model.canWriteDeal(rep, deal, 'delete')     // delete ADMIN ONLY
          && !model.canWriteDeal(office, deal, 'delete'),
      };
    });

    // ── Test K: list scoping SQL (sales_rep sees own only) ──
    await withTest('K', async () => {
      const leadId = await seedLead('b44lead-k');
      await client.query(`INSERT INTO deals (lead_id, name, assigned_rep, created_by) VALUES ($1,$2,$3,$4)`, [leadId, 'Yaron Deal', 'yaron@ecconstructiongroup.com', 'yaron@ecconstructiongroup.com']);
      await client.query(`INSERT INTO deals (lead_id, name, assigned_rep, created_by) VALUES ($1,$2,$3,$4)`, [leadId, 'Michelle Deal', 'michelle@ecconstructiongroup.com', 'michelle@ecconstructiongroup.com']);
      const cands = model.repMatchCandidates(rep);
      const scoped = await client.query(`SELECT * FROM deals WHERE (lower(assigned_rep) = ANY($1::text[]) OR created_by = $2)`, [cands, rep.email]);
      report.tests.K = {
        scenario: 'list scoping: rep sees own deals only',
        scopedCount: scoped.rows.length,
        pass: scoped.rows.length === 1 && scoped.rows[0].assigned_rep === 'yaron@ecconstructiongroup.com',
      };
    });

    // ── Idempotency: re-run migration, expect zero errors ──
    let idemErrors = 0; const idemDetails = [];
    for (const stmt of statements) {
      try { await client.query(stmt); } catch (e) { idemErrors++; idemDetails.push({ preview: preview(stmt), error: e.message }); }
    }
    report.idempotency = { ok: idemErrors === 0, errorsOnRerun: idemErrors, details: idemDetails };

    await client.query('ROLLBACK');
    report.summary.rollback = 'success — zero persistent changes';

    const testPasses = Object.values(report.tests).map((t) => t.pass);
    report.overallPass = !!(
      report.migration.errors.length === 0 &&
      report.idempotency.ok &&
      report.idempotency.errorsOnRerun === 0 &&
      testPasses.every(Boolean) &&
      report.summary.rollback === 'success — zero persistent changes'
    );
    report.summary.testsPassed = testPasses.filter(Boolean).length;
    report.summary.testsTotal = testPasses.length;
  } catch (e) {
    report.migration.errors.push({ fatal: true, error: e.message, stack: e.stack });
    try { await client.query('ROLLBACK'); } catch (_) {}
  } finally {
    client.release();
    await pool.end();
  }
  return report;
}

run()
  .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.overallPass ? 0 : 1); })
  .catch((e) => { console.error('DRY RUN CRASH:', e); process.exit(1); });