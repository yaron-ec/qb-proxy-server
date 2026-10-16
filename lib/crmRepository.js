/* eslint-disable no-undef */
/**
 * CRM repository — Railway Postgres data access for the reminder system.
 *
 * Lead source is selected by ONE environment variable:
 *
 *   REMINDER_TEST_MODE
 *     'true'  — read SYNTHETIC leads from the test_leads table (isolated
 *               end-to-end engine tests with zero real customer data).
 *               The engine also forces dry-run in this mode, so no email
 *               is ever sent for synthetic data.
 *     'false' (default) — read leads from the reminder_leads table
 *               (fed by POST /api/reminders/leads/upsert).
 *
 * Production reads reminder_leads ONLY. Test mode reads test_leads ONLY.
 * The two tables are never mixed. No Base44 dependency.
 *
 * Two methods:
 *   listEligibleLeads()              — read leads (no filtering here; the
 *                                       engine filters in memory).
 *   writeReminderSentActivity(...)   — write the REMINDER_SENT Activity row
 *                                       to the Railway activities table.
 */
'use strict';

const TEST_MODE = (process.env.REMINDER_TEST_MODE || 'false').toLowerCase() === 'true';

// Production: read from reminder_leads (fed by the upsert endpoint / importer).
//
// Safety net (TERMINAL LOST BUG FIX): reminder_leads is a projection — the
// canonical lead-write paths (routes/leads.js) are responsible for clearing
// it the moment a lead enters any terminal-lost status (see
// lib/leadStatus.js#TERMINAL_LOST_STATUSES / #isEnteringTerminalLostStatus),
// but a lead that was ALREADY terminal-lost before that fix shipped (or
// before it was generalized beyond the single 'Closed Lost' literal — see
// lib/leadStatus.js's header for the 'Lost'-vs-'Closed Lost' root-cause
// note) may still carry a stale projection (an appointment/follow-up this
// query would otherwise still see). This LEFT JOIN back to the canonical
// `leads` row excludes every status in TERMINAL_LOST_STATUSES, regardless
// of what reminder_leads itself still holds — belt-and-suspenders against
// both stale pre-fix data and any future projection bug, never a
// replacement for keeping the projection itself correct. Fails OPEN (keeps
// the row) when no matching lead is found at all, e.g. an orphaned/legacy
// reminder_leads row — never silently drops a real reminder over a join
// that can't resolve, matching this codebase's existing "fail open on
// ambiguity" philosophy (lib/notificationPreferences.js). reminder_leads.id
// = lead.external_ref if set, else lead.id
// (lib/reminderProjection.js#reminderIdFor) — the COALESCE below is the
// exact inverse of that mapping.
async function listEligibleLeadsPostgresProd() {
  const db = require('../db/client');
  const { TERMINAL_LOST_STATUSES } = require('./leadStatus');
  const { rows } = await db.query(
    `SELECT rl.id, rl.first_name, rl.last_name, rl.email, rl.phone, rl.property_address, rl.city,
            rl.project_type, rl.follow_up_date, rl.follow_up_time, rl.follow_up_type,
            rl.appointment_date, rl.appointment_time, rl.assigned_rep, rl.assigned_rep_name,
            rl.assigned_rep_email, rl.assigned_rep_phone, rl.budget_range,
            rl.notes, rl.customer_reminders_disabled, rl.crm_created_date,
            to_jsonb(rl) ->> 'appointment_type' AS appointment_type
     FROM reminder_leads rl
     LEFT JOIN leads lx ON COALESCE(lx.external_ref, lx.id::text) = rl.id
     WHERE lx.status IS NULL OR NOT (lx.status = ANY($1::text[]))
     ORDER BY rl.crm_created_date DESC`,
    [TERMINAL_LOST_STATUSES]
  );
  return rows;
}

// Isolated test path: read from test_leads (seeded by db/seedTestLeads.js).
async function listEligibleLeadsPostgresTest() {
  const db = require('../db/client');
  const { rows } = await db.query(
    `SELECT id, first_name, last_name, email, phone, property_address, city,
            project_type, follow_up_date, follow_up_time, follow_up_type,
            appointment_date, appointment_time, assigned_rep, assigned_rep_name,
            assigned_rep_email, assigned_rep_phone, budget_range,
            notes, customer_reminders_disabled, crm_created_date
     FROM test_leads ORDER BY crm_created_date DESC`
  );
  return rows;
}

async function listEligibleLeads() {
  if (TEST_MODE) return listEligibleLeadsPostgresTest();
  return listEligibleLeadsPostgresProd();
}

// Write the REMINDER_SENT Activity row to the Railway activities table for
// CRM timeline visibility. The content key is deterministic, so a re-insert
// is harmless and the engine dedupes via the Postgres claim, not via this row.
async function writeReminderSentActivity({ leadId, reminderKey }) {
  const db = require('../db/client');
  // activities has no 'timestamp' column (only created_at, which already
  // defaults to NOW()) — this previously failed on every call with "column
  // timestamp does not exist", silently discarded after 10 retries by
  // reminderEngine.js's flushActivityQueue, so REMINDER_SENT never actually
  // appeared on the CRM timeline.
  await db.query(
    `INSERT INTO activities (lead_id, type, content, author, source)
     VALUES ($1, 'note', $2, 'System', 'manual')`,
    [leadId, `REMINDER_SENT:${reminderKey}`]
  );
  return true;
}

module.exports = {
  getSource: () => 'postgres',
  listEligibleLeads,
  writeReminderSentActivity,
  isTestMode: () => TEST_MODE,
};