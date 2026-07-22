/* eslint-disable no-undef */
/**
 * CRM repository — the ONLY module in the reminder system that may touch
 * Base44. Everything else (scheduler, claims, Gmail, health, alerts) is
 * Railway-only and imports nothing Base44-specific. If EC Construction
 * Group later replaces Base44, only this file is re-implemented; the rest
 * of the worker is untouched.
 *
 * Lead source is selected by REMINDER_SOURCE:
 *   'base44'  (DEFAULT, production) — read live CRM leads via lib/base44.js.
 *   'postgres' (dry-run / test only) — read SYNTHETIC leads from the
 *                                     test_leads table. In this mode
 *                                     lib/base44.js is NEVER imported and no
 *                                     Base44 credential is required.
 *
 * lib/base44.js is require()'d lazily inside the base44 branch only, so a
 * process running in 'postgres' mode never loads the Base44 module at all.
 *
 * Two methods:
 *   listEligibleLeads()              — read leads (no filtering here; the
 *                                       engine filters in memory to mirror
 *                                       the Base44 function exactly).
 *   writeReminderSentActivity(...)   — write the REMINDER_SENT Activity row
 *                                       AFTER a reminder was delivered (Base44
 *                                       mode only). Production-irrelevant in
 *                                       dry-run, which never reaches this call.
 */
'use strict';

const SOURCE = (process.env.REMINDER_SOURCE || 'base44').toLowerCase();
const IS_POSTGRES = SOURCE === 'postgres';

// NOTE: lib/base44.js is intentionally NOT required at module load. It is
// require()'d lazily below, so postgres/test mode never imports it.

async function listEligibleLeadsBase44() {
  const b44 = require('./base44'); // lazy import — only in base44 mode
  if (!b44.isConfigured()) {
    throw new Error('BASE44_APP_ID / BASE44_API_KEY not configured — cannot read CRM leads');
  }
  const leads = await b44.list('Lead', '-created_date', 5000, 0);
  return Array.isArray(leads) ? leads : [];
}

async function listEligibleLeadsPostgres() {
  const db = require('../db/client'); // lazy import — only in postgres mode
  const { rows } = await db.query(
    `SELECT id, first_name, last_name, email, phone, property_address, city,
            project_type, follow_up_date, follow_up_time, follow_up_type,
            appointment_date, appointment_time, assigned_rep, budget_range,
            notes, customer_reminders_disabled, crm_created_date
     FROM test_leads ORDER BY crm_created_date DESC`
  );
  return rows;
}

async function listEligibleLeads() {
  if (IS_POSTGRES) return listEligibleLeadsPostgres();
  return listEligibleLeadsBase44();
}

// Write the legacy REMINDER_SENT:{reminder_key} Activity note for CRM
// timeline visibility + backward compatibility with the Base44 system.
// The content key is deterministic, so a re-insert is harmless and the
// engine dedupes via the Postgres claim, not via this row.
// In postgres/test mode this is a no-op (no Base44 dependency by design).
// The engine only invokes this in the real-send path, which dry-run can
// never reach, but the guard enforces the zero-Base44 contract regardless.
async function writeReminderSentActivity({ leadId, reminderKey }) {
  if (IS_POSTGRES) return false;
  const b44 = require('./base44'); // lazy import — only in base44 mode
  await b44.create('Activity', {
    lead_id: leadId,
    type: 'note',
    timestamp: new Date().toISOString(),
    content: `REMINDER_SENT:${reminderKey}`,
    author: 'System',
    source: 'manual',
  });
  return true;
}

module.exports = { listEligibleLeads, writeReminderSentActivity };