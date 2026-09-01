/* eslint-disable no-undef */
/**
 * backfillReminderLeadsFromRailway.js
 *
 * Railway-native backfill: reconciles reminder_leads with the canonical Railway
 * leads table. No Base44 dependency. Idempotent.
 *
 * Source of truth: Railway `leads` table.
 * Derived projection: `reminder_leads` table (read by the reminder engine).
 *
 * Reconciliation logic:
 *   1. For every canonical lead with a follow-up/appointment date:
 *      - Upsert into reminder_leads using id = external_ref || id.
 *      - Legacy leads (external_ref NOT NULL) → use external_ref as the id.
 *      - Railway-native leads (external_ref NULL) → use the Railway UUID (id).
 *   2. For every canonical lead with NO dates:
 *      - Clear appointment fields in reminder_leads (if a row exists).
 *   3. For every reminder_leads row whose id no longer matches any canonical
 *      lead (by external_ref OR by Railway UUID):
 *      - Delete it (stale orphan cleanup).
 *
 * This does NOT send emails. Does NOT create reminder claims. Does NOT modify
 * canonical lead business data. Does NOT touch already-sent idempotency keys.
 *
 * Usage:
 *   node scripts/backfillReminderLeadsFromRailway.js           (apply)
 *   node scripts/backfillReminderLeadsFromRailway.js --dry-run (report only)
 *
 * Requires: DATABASE_URL on the Railway service.
 */
'use strict';

const db = require('../db/client');
const { validateAndNormalizeLead, upsertLead } = require('../lib/leadIngest');
const { syncLeadToReminders, reminderIdFor } = require('../lib/reminderProjection');

const isDryRun = process.argv.includes('--dry-run');

async function backfill() {
  console.log(`[backfill] Starting Railway-native reminder_leads reconciliation...${isDryRun ? ' (DRY RUN)' : ''}`);

  await db.ensureSchema();

  // ── 1. Read ALL canonical leads (source of truth) ──────────────────────
  const { rows: allLeads } = await db.query(
    `SELECT l.id, l.external_ref, l.first_name, l.last_name, l.email, l.phone,
            l.property_address, l.city, l.project_type, l.follow_up_date,
            l.follow_up_time, l.follow_up_type, l.appointment_date,
            l.appointment_time, l.assigned_rep, l.budget_range, l.notes,
            l.customer_reminders_disabled, l.crm_created_date, l.created_at,
            o.display_name AS owner_display_name, o.email AS owner_email
     FROM leads l LEFT JOIN owners o ON o.id = l.owner_id
     ORDER BY l.created_at DESC`
  );
  console.log(`[backfill] Found ${allLeads.length} canonical leads`);

  // ── 2. Read current reminder_leads (to detect orphans) ──────────────────
  const { rows: existingReminders } = await db.query(
    'SELECT id, follow_up_date, appointment_date FROM reminder_leads'
  );
  const existingIds = new Set(existingReminders.map(r => r.id));
  console.log(`[backfill] reminder_leads currently has ${existingIds.size} rows`);

  // Build a set of all canonical reminder ids (external_ref || id)
  const canonicalIds = new Set();
  for (const lead of allLeads) {
    const rid = reminderIdFor(lead);
    if (rid) canonicalIds.add(rid);
  }

  // ── 3. Process each canonical lead ─────────────────────────────────────
  let upserted = 0, cleared = 0, skipped = 0, errors = 0;
  const stats = { legacy: 0, native: 0 };

  for (const lead of allLeads) {
    const rid = reminderIdFor(lead);
    if (!rid) { skipped++; continue; }

    if (lead.external_ref) stats.legacy++;
    else stats.native++;

    const hasDates = lead.follow_up_date || lead.appointment_date;

    if (hasDates) {
      try {
        await syncLeadToReminders(db, lead);
        upserted++;
      } catch (e) {
        console.error(`[backfill] ERROR upserting ${rid}: ${e.message}`);
        errors++;
      }
    } else {
      // No dates — clear if a row exists (idempotent no-op if not)
      if (existingIds.has(rid)) {
        try {
          await syncLeadToReminders(db, lead);
          cleared++;
        } catch (e) {
          console.error(`[backfill] ERROR clearing ${rid}: ${e.message}`);
          errors++;
        }
      }
    }
  }

  // ── 4. Orphan cleanup: delete reminder_leads rows with no canonical lead ─
  const orphanIds = [];
  for (const rid of existingIds) {
    if (!canonicalIds.has(rid)) orphanIds.push(rid);
  }
  console.log(`[backfill] Found ${orphanIds.length} orphan reminder_leads rows (no matching canonical lead)`);

  let orphanDeleted = 0;
  if (!isDryRun && orphanIds.length > 0) {
    for (const rid of orphanIds) {
      try {
        await db.query('DELETE FROM reminder_leads WHERE id = $1', [rid]);
        orphanDeleted++;
      } catch (e) {
        console.error(`[backfill] ERROR deleting orphan ${rid}: ${e.message}`);
        errors++;
      }
    }
  }

  // ── 5. Verify final state ───────────────────────────────────────────────
  const { rows: countRows } = await db.query('SELECT COUNT(*) as count FROM reminder_leads');
  const finalCount = parseInt(countRows[0].count, 10);

  const summary = {
    canonicalLeads: allLeads.length,
    legacyLeads: stats.legacy,
    nativeLeads: stats.native,
    upserted,
    cleared,
    skipped,
    orphansFound: orphanIds.length,
    orphansDeleted: isDryRun ? 0 : orphanDeleted,
    errors,
    reminderLeadsFinal: finalCount,
    dryRun: isDryRun,
  };

  console.log('[backfill] DONE:', JSON.stringify(summary, null, 2));
  return summary;
}

if (require.main === module) {
  backfill().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { backfill };