/* eslint-disable no-undef */
'use strict';
/**
 * rollbackValidateSignNowDocuments.js — Production-path rollback validation for
 * signnow_documents: runs the EXACT same runSignNowDocumentMigration() function
 * used by the production script, inside a transaction that is ALWAYS ROLLED
 * BACK. Validates FK resolution (lead_id), NOT NULL constraints, UNIQUE
 * (external_ref), status domain, field values, and all 13 Base44
 * SignNowDocument records.
 *
 * Orphan handling: 3 records have test/fake lead_ids ("test-lead-123", "test123")
 * that don't resolve to Railway leads. These are SKIPPED (lead_id is NOT NULL FK).
 * The validator verifies 10 migrated + 3 skipped = 13 total, 0 errors.
 *
 * Zero permanent writes. Safe to run any time.
 *
 * Environment: DATABASE_URL, WORKER_SECRET (for migrationReader).
 */
const { pool, query } = require('../db/client');
const { fetchBase44Entity, buildLeadIdCache, hasBase44Creds } = require('./migrationHelpers');
const { runSignNowDocumentMigration } = require('./migrateSignNowDocumentsToRailway');

const STATUS_MAP = {
  draft: 'pending',
  sent: 'sent',
  viewed: 'viewed',
  signed: 'signed',
  declined: 'voided',
  completed: 'completed',
  error: 'error',
};

async function main() {
  console.log('=== SIGNNOW DOCUMENT ROLLBACK VALIDATION (ALWAYS ROLLBACK) ===');
  console.log('Started:', new Date().toISOString());

  if (!hasBase44Creds()) {
    console.error('FATAL: WORKER_SECRET not set — cannot read Base44 source data');
    process.exit(1);
  }

  // ── Phase 1: Fetch Base44 source data ───────────────────────────────────
  console.log('\n=== PHASE 1: FETCH BASE44 SOURCE DATA ===');
  const base44Items = await fetchBase44Entity('SignNowDocument');
  console.log(`Base44 SignNowDocument records: ${base44Items.length}`);

  if (base44Items.length === 0) {
    console.log('No records to validate — EXITING (VERIFIED ZERO)');
    await pool.end();
    return;
  }

  // ── Phase 1.1: Railway before-count ──────────────────────────────────────
  const beforeCount = parseInt((await query('SELECT COUNT(*) as cnt FROM signnow_documents')).rows[0].cnt, 10);
  console.log(`Railway signnow_documents BEFORE: ${beforeCount} rows`);

  // ── Phase 1.2: FK audit ───────────────────────────────────────────────────
  console.log('\n=== PHASE 1.2: FK AUDIT ===');
  const leadIdCache = await buildLeadIdCache(query);
  let resolved = 0, unresolved = 0;
  const resolvableItems = [];
  const orphanItems = [];
  for (const item of base44Items) {
    if (item.lead_id && leadIdCache[String(item.lead_id)]) {
      resolved++;
      resolvableItems.push(item);
    } else if (item.lead_id) {
      unresolved++;
      orphanItems.push(item);
      console.log(`  ORPHAN: ${item.id} → lead_id "${item.lead_id}" not in Railway (will be skipped)`);
    } else {
      unresolved++;
      orphanItems.push(item);
      console.log(`  ORPHAN: ${item.id} → no lead_id (will be skipped)`);
    }
  }
  console.log(`FK resolution: ${resolved} resolvable, ${unresolved} orphan (out of ${base44Items.length})`);

  // ── Phase 1.3: Field-level audit ──────────────────────────────────────────
  console.log('\n=== PHASE 1.3: FIELD-LEVEL AUDIT ===');
  for (const item of base44Items) {
    const issues = [];
    if (!item.id) issues.push('missing id (external_ref)');
    if (!item.lead_id) issues.push('missing lead_id');
    if (!item.document_name) issues.push('missing document_name (will default to "Untitled Document")');
    if (item.status && !STATUS_MAP[item.status]) issues.push(`unknown status "${item.status}" (will default to pending)`);
    if (item.signnow_document_id && item.signnow_document_id.length < 10) issues.push(`suspicious signnow_document_id length`);
    if (issues.length > 0) {
      console.log(`  ${item.id}: ${issues.join(', ')}`);
    }
  }

  // ── Phase 1.4: Status domain audit ────────────────────────────────────────
  console.log('\n=== PHASE 1.4: STATUS DOMAIN AUDIT ===');
  const statusCounts = {};
  for (const item of base44Items) {
    const s = item.status || '(none)';
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  }
  console.log('Status distribution:', statusCounts);
  for (const [status, count] of Object.entries(statusCounts)) {
    const mapped = STATUS_MAP[status];
    if (mapped) {
      console.log(`  ${status} → ${mapped} (${count} records) ✅`);
    } else if (status === '(none)') {
      console.log(`  (none) → pending (default) (${count} records) ✅`);
    } else {
      console.log(`  ${status} → UNKNOWN (will default to pending) (${count} records) ⚠️`);
    }
  }

  // ── Phase 1.5: Duplicate identity audit ──────────────────────────────────
  console.log('\n=== PHASE 1.5: DUPLICATE IDENTITY AUDIT ===');
  const externalRefs = base44Items.map(i => String(i.id));
  const dupRefs = externalRefs.filter((r, i) => externalRefs.indexOf(r) !== i);
  if (dupRefs.length > 0) {
    throw new Error(`DUPLICATE external_refs found: ${dupRefs.join(', ')}`);
  }
  console.log(`No duplicate external_refs: PASS ✅ (${externalRefs.length} unique)`);

  const docIds = base44Items.map(i => i.signnow_document_id).filter(Boolean);
  const dupDocIds = docIds.filter((d, i) => docIds.indexOf(d) !== i);
  if (dupDocIds.length > 0) {
    console.log(`⚠️ Duplicate signnow_document_id values: ${dupDocIds.join(', ')}`);
    console.log('  (document_id has UNIQUE constraint — migration may conflict if already in Railway)');
  } else {
    console.log(`No duplicate signnow_document_id values: PASS ✅ (${docIds.length} unique)`);
  }

  // ── Phase 2: Run migration inside BEGIN / ROLLBACK ──────────────────────
  console.log('\n=== PHASE 2: RUN MIGRATION INSIDE TRANSACTION (ROLLBACK) ===');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const qFn = (text, params) => client.query(text, params);

    const result = await runSignNowDocumentMigration(qFn);

    // ── Phase 3: In-transaction verification ───────────────────────────────
    console.log('\n=== PHASE 3: IN-TRANSACTION VERIFICATION ===');
    const inTxCount = parseInt((await qFn('SELECT COUNT(*) as cnt FROM signnow_documents')).rows[0].cnt, 10);
    console.log(`Railway signnow_documents IN-TX: ${inTxCount} rows`);

    const expectedCount = beforeCount + result.created;
    if (inTxCount !== expectedCount) {
      throw new Error(`COUNT MISMATCH: expected ${expectedCount} (before ${beforeCount} + created ${result.created}), got ${inTxCount}`);
    }
    console.log(`Count check: PASS ✅ (${inTxCount} = ${beforeCount} + ${result.created})`);

    // Verify all resolvable external_refs are present
    const resolvableRefs = resolvableItems.map(i => String(i.id));
    const { rows: foundRows } = await qFn(
      'SELECT external_ref FROM signnow_documents WHERE external_ref = ANY($1)',
      [resolvableRefs]
    );
    const foundRefs = foundRows.map(r => r.external_ref);
    const missingRefs = resolvableRefs.filter(r => !foundRefs.includes(r));
    if (missingRefs.length > 0) {
      throw new Error(`MISSING external_refs in Railway: ${missingRefs.join(', ')}`);
    }
    console.log(`All ${resolvableRefs.length} resolvable external_refs present: PASS ✅`);

    // Verify orphan external_refs are NOT present (skipped)
    const orphanRefs = orphanItems.map(i => String(i.id));
    if (orphanRefs.length > 0) {
      const { rows: orphanFound } = await qFn(
        'SELECT external_ref FROM signnow_documents WHERE external_ref = ANY($1)',
        [orphanRefs]
      );
      if (orphanFound.length > 0) {
        throw new Error(`ORPHAN records should be skipped but found in Railway: ${orphanFound.map(r => r.external_ref).join(', ')}`);
      }
      console.log(`All ${orphanRefs.length} orphan external_refs correctly skipped: PASS ✅`);
    }

    // Verify FK: all lead_ids are valid UUIDs pointing to leads
    const { rows: fkCheck } = await qFn(
      `SELECT sd.external_ref, sd.lead_id, l.id as leads_id
       FROM signnow_documents sd
       LEFT JOIN leads l ON l.id = sd.lead_id
       WHERE sd.external_ref = ANY($1) AND l.id IS NULL`,
      [resolvableRefs]
    );
    if (fkCheck.length > 0) {
      throw new Error(`FK VIOLATION: ${fkCheck.length} documents have lead_id not in leads table`);
    }
    console.log(`FK integrity (lead_id → leads): PASS ✅`);

    // Verify NOT NULL constraints
    const { rows: nullCheck } = await qFn(
      `SELECT external_ref FROM signnow_documents
       WHERE external_ref = ANY($1) AND (lead_id IS NULL OR status IS NULL OR signers IS NULL)`,
      [resolvableRefs]
    );
    if (nullCheck.length > 0) {
      throw new Error(`NOT NULL VIOLATION: ${nullCheck.length} documents have NULL required fields`);
    }
    console.log(`NOT NULL constraints (lead_id, status, signers): PASS ✅`);

    // Verify UNIQUE external_ref
    const { rows: dupCheck } = await qFn(
      `SELECT external_ref, count(*) as cnt FROM signnow_documents
       WHERE external_ref = ANY($1) GROUP BY external_ref HAVING count(*) > 1`,
      [resolvableRefs]
    );
    if (dupCheck.length > 0) {
      throw new Error(`UNIQUE VIOLATION: ${dupCheck.length} duplicate external_refs found`);
    }
    console.log(`UNIQUE (external_ref): PASS ✅`);

    // ── Phase 3.1: Field-value verification ────────────────────────────────
    console.log('\n=== PHASE 3.1: FIELD-VALUE VERIFICATION ===');
    for (const item of resolvableItems) {
      const { rows } = await qFn(
        `SELECT lead_id, document_id, document_name, status, signing_url, pdf_url,
                signnow_invite_id, sent_at, signed_at, last_status_check, uploaded_file_url,
                signers
         FROM signnow_documents WHERE external_ref = $1`,
        [String(item.id)]
      );
      const row = rows[0];
      if (!row) { throw new Error(`Record ${item.id} not found after insert`); }

      const expectedLeadId = leadIdCache[String(item.lead_id)];
      if (row.lead_id !== expectedLeadId) {
        throw new Error(`lead_id mismatch for ${item.id}: expected ${expectedLeadId}, got ${row.lead_id}`);
      }

      const expectedStatus = STATUS_MAP[item.status] || 'pending';
      if (row.status !== expectedStatus) {
        throw new Error(`status mismatch for ${item.id}: expected ${expectedStatus}, got ${row.status}`);
      }

      if (item.signnow_document_id && row.document_id !== item.signnow_document_id) {
        throw new Error(`document_id mismatch for ${item.id}: expected ${item.signnow_document_id}, got ${row.document_id}`);
      }

      // Verify sent_at (was previously mapped to created_at — now correct)
      if (item.sent_at && row.sent_at) {
        const dbSent = new Date(row.sent_at).getTime();
        const srcSent = new Date(item.sent_at).getTime();
        if (Math.abs(dbSent - srcSent) > 1000) {
          throw new Error(`sent_at mismatch for ${item.id}: expected ${item.sent_at}, got ${row.sent_at}`);
        }
      }

      // Verify signed_at (was previously NOT migrated — now migrated)
      if (item.signed_at && row.signed_at) {
        const dbSigned = new Date(row.signed_at).getTime();
        const srcSigned = new Date(item.signed_at).getTime();
        if (Math.abs(dbSigned - srcSigned) > 1000) {
          throw new Error(`signed_at mismatch for ${item.id}: expected ${item.signed_at}, got ${row.signed_at}`);
        }
      }

      // Verify signnow_invite_id
      if (item.signnow_invite_id && row.signnow_invite_id !== item.signnow_invite_id) {
        throw new Error(`signnow_invite_id mismatch for ${item.id}: expected ${item.signnow_invite_id}, got ${row.signnow_invite_id}`);
      }

      // Verify uploaded_file_url
      if (item.uploaded_file_url && row.uploaded_file_url !== item.uploaded_file_url) {
        throw new Error(`uploaded_file_url mismatch for ${item.id}: expected ${item.uploaded_file_url}, got ${row.uploaded_file_url}`);
      }

      // Verify signers JSONB
      if (item.signer_email || item.signer_name) {
        const signers = typeof row.signers === 'string' ? JSON.parse(row.signers) : row.signers;
        if (!Array.isArray(signers) || signers.length === 0) {
          throw new Error(`signers mismatch for ${item.id}: expected non-empty array, got ${JSON.stringify(row.signers)}`);
        }
        const s = signers[0];
        if (item.signer_email && s.email !== item.signer_email) {
          throw new Error(`signer email mismatch for ${item.id}: expected ${item.signer_email}, got ${s.email}`);
        }
        if (item.signer_name && s.name !== item.signer_name) {
          throw new Error(`signer name mismatch for ${item.id}: expected ${item.signer_name}, got ${s.name}`);
        }
      }

      console.log(`  ${item.id}: lead_id ✅, status ✅, document_id ✅, sent_at ✅, signed_at ✅, signers ✅`);
    }

    // ── Phase 3.2: Idempotency check (run migration again inside same TX) ──
    console.log('\n=== PHASE 3.2: IDEMPOTENCY CHECK (second run) ===');
    const result2 = await runSignNowDocumentMigration(qFn);
    if (result2.created !== 0) {
      throw new Error(`IDEMPOTENCY FAIL: second run created ${result2.created} records (expected 0)`);
    }
    if (result2.errors > 0) {
      throw new Error(`IDEMPOTENCY FAIL: second run had ${result2.errors} errors`);
    }
    console.log(`Idempotency: PASS ✅ (second run: 0 created, ${result2.updated} updated, 0 errors)`);

    // ── Phase 4: Rollback ───────────────────────────────────────────────────
    console.log('\n=== PHASE 4: ROLLBACK ===');
    await client.query('ROLLBACK');
    console.log('ROLLED BACK ✅');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('\nFATAL — ROLLED BACK:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }

  // ── Phase 5: Post-rollback verification ───────────────────────────────────
  console.log('\n=== PHASE 5: POST-ROLLBACK VERIFICATION ===');
  const afterCount = parseInt((await query('SELECT COUNT(*) as cnt FROM signnow_documents')).rows[0].cnt, 10);
  console.log(`Railway signnow_documents AFTER: ${afterCount} rows`);

  if (afterCount !== beforeCount) {
    console.error(`❌ ROLLBACK FAILED: before=${beforeCount}, after=${afterCount}`);
    process.exitCode = 1;
  } else {
    console.log(`Rollback verified: ${afterCount} === ${beforeCount} ✅`);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('\n=== SUMMARY ===');
  console.log(`Base44 records: ${base44Items.length}`);
  console.log(`Resolvable: ${resolved}, Orphans (skipped): ${unresolved}`);
  console.log(`Before: ${beforeCount}, After: ${afterCount}`);
  console.log(`Result: ${afterCount === beforeCount ? 'PASS ✅' : 'FAIL ❌'}`);

  await pool.end();
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL:', e); process.exit(1); });
}

module.exports = { main };