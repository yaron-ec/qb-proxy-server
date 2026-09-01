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
async function listEligibleLeadsPostgresProd() {
  const db = require('../db/client');
  const { rows } = await db.query(
    `SELECT id, first_name, last_name, email, phone, property_address, city,
            project_type, follow_up_date, follow_up_time, follow_up_type,
            appointment_date, appointment_time, assigned_rep, assigned_rep_name,
            assigned_rep_email, assigned_rep_phone, budget_range,
            notes, customer_reminders_disabled, crm_created_date
     FROM reminder_leads ORDER BY crm_created_date DESC`
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
  await db.query(
    `INSERT INTO activities (lead_id, type, timestamp, content, author, source)
     VALUES ($1, 'note', NOW(), $2, 'System', 'manual')`,
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