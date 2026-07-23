/* eslint-disable no-undef */
/**
 * CRM repository — the ONLY module in the reminder system that may touch
 * Base44. Everything else (scheduler, claims, Gmail, health, alerts) is
 * Railway-only and imports nothing Base44-specific. If EC Construction
 * Group later replaces Base44, only this file is re-implemented; the rest
 * of the worker is untouched.
 *
 * Lead source is selected by TWO environment variables:
 *
 *   REMINDER_SOURCE
 *     'base44'   (legacy production) — read live CRM leads via lib/base44.js.
 *     'postgres'  (production)        — read leads from the reminder_leads
 *                                      table (fed by POST /api/reminders/leads/upsert).
 *
 *   REMINDER_TEST_MODE   (only meaningful with REMINDER_SOURCE=postgres)
 *     'true'             — read SYNTHETIC leads from the test_leads table
 *                          instead of reminder_leads. Intended for isolated
 *                          end-to-end engine tests with zero real customer
 *                          data. In this mode lib/base44.js is NEVER imported
 *                          and no Base44 credential is required. The engine
 *                          also forces dry-run in this mode, so no email is
 *                          ever sent for synthetic data.
 *
 * Production (REMINDER_SOURCE=postgres, test mode off) reads reminder_leads
 * ONLY. Test mode reads test_leads ONLY. The two tables are never mixed.
 *
 * lib/base44.js is require()'d lazily inside the base44 branch only, so any
 * process running with REMINDER_SOURCE=postgres (production or test) never
 * loads the Base44 module at all.
 *
 * Two methods:
 *   listEligibleLeads()              — read leads (no filtering here; the
 *                                       engine filters in memory to mirror
 *                                       the Base44 function exactly).
 *   writeReminderSentActivity(...)   — write the REMINDER_SENT Activity row
 *                                       AFTER a reminder was delivered. Active
 *                                       ONLY in base44 mode; a no-op for every
 *                                       postgres mode (production has no Base44
 *                                       dependency by design).
 */
'use strict';

const SOURCE = (process.env.REMINDER_SOURCE || 'base44').toLowerCase();
const TEST_MODE = (process.env.REMINDER_TEST_MODE || 'false').toLowerCase() === 'true';

const IS_BASE44 = SOURCE === 'base44';
const IS_POSTGRES = SOURCE === 'postgres';
const IS_POSTGRES_PROD = IS_POSTGRES && !TEST_MODE;   // production: reminder_leads
const IS_POSTGRES_TEST = IS_POSTGRES && TEST_MODE;   // isolated tests: test_leads

// NOTE: lib/base44.js is intentionally NOT required at module load. It is
// require()'d lazily below, so postgres mode never imports it.

async function listEligibleLeadsBase44() {
  const b44 = require('./base44'); // lazy import — only in base44 mode
  if (!b44.isConfigured()) {
    throw new Error('BASE44_APP_ID / BASE44_API_KEY not configured — cannot read CRM leads');
  }
  const leads = await b44.list('Lead', '-created_date', 5000, 0);
  return Array.isArray(leads) ? leads : [];
}

// Production: read from reminder_leads (fed by the upsert endpoint / importer).
// Columns mirror exactly what the reminder engine reads — nothing more.
async function listEligibleLeadsPostgresProd() {
  const db = require('../db/client'); // lazy import — only in postgres mode
  const { rows } = await db.query(
    `SELECT id, first_name, last_name, email, phone, property_address, city,
            project_type, follow_up_date, follow_up_time, follow_up_type,
            appointment_date, appointment_time, assigned_rep, budget_range,
            notes, customer_reminders_disabled, crm_created_date
     FROM reminder_leads ORDER BY crm_created_date DESC`
  );
  return rows;
}

// Isolated test path: read from test_leads (seeded by db/seedTestLeads.js).
// Selected ONLY when REMINDER_TEST_MODE=true; never used in production.
async function listEligibleLeadsPostgresTest() {
  const db = require('../db/client'); // lazy import — only in postgres test mode
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
  if (IS_POSTGRES_TEST) return listEligibleLeadsPostgresTest();
  if (IS_POSTGRES_PROD) return listEligibleLeadsPostgresProd();
  return listEligibleLeadsBase44();
}

// Write the legacy REMINDER_SENT:{reminder_key} Activity note for CRM
// timeline visibility + backward compatibility with the Base44 system.
// The content key is deterministic, so a re-insert is harmless and the
// engine dedupes via the Postgres claim, not via this row.
// No-op for EVERY postgres mode (production has no Base44 dependency by
// design; test mode never reaches this call). The engine only invokes this
// in the real-send path, which dry-run can never reach, but the guard
// enforces the zero-Base44 contract regardless.
async function writeReminderSentActivity({ leadId, reminderKey }) {
  if (IS_POSTGRES) return false; // production + test: never touch Base44
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

module.exports = {
  listEligibleLeads,
  writeReminderSentActivity,
  // Env interpreters — the engine imports these so it never re-parses the env
  // and can never disagree with this module about which table is in use.
  getSource: () => SOURCE,
  isTestMode: () => TEST_MODE,
  isPostgresProd: () => IS_POSTGRES_PROD,
  isPostgresTest: () => IS_POSTGRES_TEST,
};