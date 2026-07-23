/* eslint-disable no-undef */
/**
 * One-time importer for existing eligible leads into reminder_leads.
 *
 * Usage:
 *   node db/importLeads.js <leads.json>
 *
 * <leads.json> is a JSON ARRAY of lead objects, each with the same shape as the
 * body of POST /api/reminders/leads/upsert (see lib/leadIngest.js for fields).
 *
 * Contract:
 *   - idempotent by external lead id (re-running yields the same rows)
 *   - updates existing rows by external lead id (no duplicates)
 *   - reports inserted / updated / skipped / invalid counts
 *   - logs NO customer PII (only row index + lead id on error)
 *   - does NOT call Base44 (no permanent Base44 API key required)
 *   - does NOT call Gmail
 *   - does NOT create reminder claims
 *   - does NOT send reminders during import
 *
 * Exit code: 0 on success (even with some invalid rows), 1 if any row failed.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./client');
const { validateAndNormalizeLead, upsertLead } = require('../lib/leadIngest');

(async () => {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node db/importLeads.js <leads.json>');
    process.exit(1);
  }

  let raw;
  try {
    raw = fs.readFileSync(path.resolve(file), 'utf8');
  } catch (e) {
    console.error(`[import] cannot read ${file}: ${e.message}`);
    process.exit(1);
  }

  let arr;
  try {
    arr = JSON.parse(raw);
  } catch (e) {
    console.error(`[import] invalid JSON: ${e.message}`);
    process.exit(1);
  }
  if (!Array.isArray(arr)) {
    console.error('[import] top-level JSON must be an array of lead objects');
    process.exit(1);
  }

  await db.ensureSchema();

  const stats = { total: arr.length, inserted: 0, updated: 0, skipped: 0, invalid: 0, errors: [] };

  for (let i = 0; i < arr.length; i++) {
    const v = validateAndNormalizeLead(arr[i]);
    if (!v.ok) {
      stats.invalid++;
      stats.errors.push(`row ${i}: ${v.errors.join('; ')}`);
      continue;
    }
    // Rows with no usable appointment date would be skipped by the engine anyway;
    // count them as skipped rather than inserting dead rows.
    const hasAppt = v.lead.follow_up_date || v.lead.appointment_date;
    if (!hasAppt) {
      stats.skipped++;
      continue;
    }
    try {
      const r = await upsertLead(db, v.lead);
      if (r.action === 'created') stats.inserted++;
      else stats.updated++;
    } catch (e) {
      stats.invalid++;
      stats.errors.push(`row ${i} (id=${v.lead.id}): ${e.message}`);
    }
  }

  console.log(
    `[import] done: total=${stats.total} inserted=${stats.inserted} updated=${stats.updated} skipped=${stats.skipped} invalid=${stats.invalid}`
  );
  if (stats.errors.length) {
    console.error(`[import] ${stats.errors.length} row error(s) — no PII logged`);
  }
  process.exit(stats.invalid > 0 ? 1 : 0);
})();