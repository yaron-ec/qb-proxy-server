#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * auditSignnowPendingDocuments — find every non-terminal SignNow document
 * (pending / sent / viewed / needs_review) that was created BEFORE the
 * November 2026 identity-safety fix (lib/signnowFieldMapping.js#findIdentityRisks)
 * existed, and run the exact same live check against it now.
 *
 * READ-ONLY. Calls only signnowClient.getDocumentFields (a GET) — never
 * prefills, sends, voids, or deletes anything. Needs live SignNow
 * credentials configured on whichever Railway service runs this (the
 * backend's own SIGNNOW_API_KEY / stored password-grant credential) — this
 * cannot be run from an environment with no SignNow account access.
 *
 *   node scripts/auditSignnowPendingDocuments.js [--json]
 *
 * For each document this prints: lead name, document name, template id,
 * current DB status, and — for every live field — whether it's mapped, its
 * current value, and whether it now carries a risk per findIdentityRisks
 * (the SAME function routes/signnow.js's /prepare and /send routes use).
 * A document the live check can no longer reach (deleted in SignNow,
 * credential mismatch, etc.) is reported as check_failed, never silently
 * skipped and never treated as clean.
 *
 * This NEVER writes signnow_documents.unverified_fields itself — a document
 * already created before this fix has no unverified_fields value computed
 * at creation time to update defensively; the one, deliberate way to put a
 * pre-existing document under the same live block this fix gives every NEW
 * document is POST /api/v1/signnow/documents/:docId/reverify (admin/manager,
 * same endpoint an admin uses to clear a flag) — this script's purpose is
 * to tell an operator WHICH documents need that call, not to call it
 * automatically on their behalf.
 */
'use strict';

const db = require('../db/client');
const signnowClient = require('../lib/signnowClient');
const fieldMapping = require('../lib/signnowFieldMapping');

const asJson = process.argv.includes('--json');

async function main() {
  const { rows: docs } = await db.query(
    `SELECT sd.*, l.first_name, l.last_name
     FROM signnow_documents sd
     JOIN leads l ON l.id = sd.lead_id
     WHERE sd.status IN ('pending', 'sent', 'viewed', 'needs_review')
     ORDER BY sd.created_at ASC`
  );

  const results = [];
  for (const doc of docs) {
    const entry = {
      id: doc.id,
      document_id: doc.document_id,
      document_name: doc.document_name,
      template_id: doc.template_id,
      db_status: doc.status,
      lead_name: `${doc.first_name || ''} ${doc.last_name || ''}`.trim(),
      created_at: doc.created_at,
    };
    try {
      const mappings = doc.template_id ? await fieldMapping.getMappingsForTemplate(doc.template_id) : [];
      const lead = { first_name: doc.first_name, last_name: doc.last_name }; // only identity fields needed for this report
      const { resolved } = fieldMapping.resolveMappingValues(mappings, { lead, deal: null });
      const live = await signnowClient.getDocumentFields(doc.document_id);
      const risks = fieldMapping.findIdentityRisks(mappings, resolved, live.fields);
      entry.live_field_count = live.fields.length;
      entry.identity_risks = risks;
      entry.classification = risks.length > 0 ? 'NEEDS_REVIEW' : 'CLEAN';
    } catch (e) {
      entry.classification = 'CHECK_FAILED';
      entry.error = e.message;
    }
    results.push(entry);
  }

  const counts = results.reduce((acc, r) => {
    acc[r.classification] = (acc[r.classification] || 0) + 1;
    return acc;
  }, {});

  if (asJson) {
    console.log(JSON.stringify({ total: results.length, counts, results }, null, 2));
  } else {
    console.log(`SignNow pending-document identity audit — ${results.length} document(s) checked.`);
    console.log('Counts:', counts);
    for (const r of results) {
      console.log(`\n[${r.classification}] ${r.document_name || '(untitled)'} — lead: ${r.lead_name} — db status: ${r.db_status}`);
      if (r.classification === 'NEEDS_REVIEW') {
        for (const risk of r.identity_risks) {
          console.log(`    - field "${risk.field_name}" (${risk.kind}): currently "${risk.current}"${risk.expected ? ` — expected "${risk.expected}"` : ' — no CRM mapping for this field'}`);
        }
        console.log(`    -> Open in SignNow, fix/clear these fields, then POST /api/v1/signnow/documents/${r.document_id}/reverify.`);
      } else if (r.classification === 'CHECK_FAILED') {
        console.log(`    error: ${r.error}`);
      }
    }
  }

  await db.pool.end();
}

main().catch((e) => {
  console.error('[auditSignnowPendingDocuments] fatal:', e.message);
  process.exit(1);
});
