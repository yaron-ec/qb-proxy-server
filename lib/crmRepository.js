/* eslint-disable no-undef */
/**
 * CRM repository — the ONLY module in the reminder system that touches
 * Base44. Everything else (scheduler, claims, Gmail, health, alerts) is
 * Railway-only and imports nothing Base44-specific. If EC Construction
 * Group later replaces Base44, only this file is re-implemented; the rest
 * of the worker is untouched.
 *
 * Uses the existing service-role Base44 REST gateway (lib/base44.js) —
 * the same one the QB sync uses. No Base44 SDK, no Base44 credits.
 *
 * Two methods:
 *   listEligibleLeads()              — read Lead records (no filtering done
 *                                       here; the engine filters in memory to
 *                                       mirror the Base44 function exactly).
 *   writeReminderSentActivity(...)   — write the REMINDER_SENT Activity row
 *                                       AFTER a reminder was delivered. This
 *                                       is for CRM visibility only — it is
 *                                       never the send gate.
 */
'use strict';

const b44 = require('./base44');

async function listEligibleLeads() {
  if (!b44.isConfigured()) {
    throw new Error('BASE44_APP_ID / BASE44_API_KEY not configured — cannot read CRM leads');
  }
  const leads = await b44.list('Lead', '-created_date', 5000, 0);
  return Array.isArray(leads) ? leads : [];
}

// Write the legacy REMINDER_SENT:{reminder_key} Activity note for CRM
// timeline visibility + backward compatibility with the Base44 system.
// The content key is deterministic, so a re-insert is harmless and the
// engine dedupes via the Postgres claim, not via this row.
async function writeReminderSentActivity({ leadId, reminderKey }) {
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