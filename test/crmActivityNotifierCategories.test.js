/* eslint-disable no-undef */
'use strict';

/**
 * crmActivityNotifierCategories.test.js — lib/crmActivityNotifier.js must
 * narrow EVERY staff recipient through
 * lib/notificationPreferences.js#filterRecipientsForCategory(), tagged with
 * the right category per action (ACTION_CATEGORIES), so a staff member
 * configured to receive only one category (e.g. "new lead only" — EC's own
 * Michelle policy, seeded by
 * db/migrations/2026-62-michelle-single-category-notifications.sql) never
 * receives any other crmActivityNotifier action.
 *
 * Before this fix, resolveRecipients() called the generic, unfiltered
 * lib/notificationRecipients.js#getRecipients() — every action
 * (lead_updated, appointment_created, deal_created, activity_added, ...)
 * went to the full configured to/cc list regardless of per-category opt-outs.
 */

const test = require('node:test');
const assert = require('node:assert');

function mockModule(path, exports) {
  const p = require.resolve(path);
  delete require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const STAFF = ['michelle@ecconstructiongroup.com', 'yaron@ecconstructiongroup.com'];

// Simulates EC's seeded policy: michelle has disabled every category except
// new_lead (absence of a row = enabled, per notificationPreferences.js's own
// backward-compatible default — new_lead has no disabling row at all).
function michelleOnlyNewLead(candidates, category) {
  if (category === 'new_lead') return candidates;
  return candidates.filter((e) => e.toLowerCase() !== 'michelle@ecconstructiongroup.com');
}

function freshCrmActivityNotifier({ filterImpl = michelleOnlyNewLead, enabled = true } = {}) {
  mockModule('../db/client', {
    query: async (sql) => {
      if (/crm_activity_notifications_enabled/i.test(String(sql))) {
        return { rows: [{ crm_activity_notifications_enabled: enabled }] };
      }
      return { rows: [] };
    },
  });
  mockModule('../lib/notificationRecipients', {
    getAllStaffRecipients: async () => [...STAFF],
    getSenderName: async () => 'EC Construction Group CRM',
    getSenderAddress: async () => 'yaron@ecconstructiongroup.com',
  });
  const realPrefs = require('../lib/notificationPreferences');
  mockModule('../lib/notificationPreferences', {
    CATEGORIES: realPrefs.CATEGORIES,
    filterRecipientsForCategory: async (candidates, category) => filterImpl(candidates, category),
  });
  mockModule('../lib/emailTemplates', { crmActivityEmail: () => '<p>stub</p>' });
  mockModule('../lib/companyConfig', { getTimezone: async () => 'America/Los_Angeles' });

  const sent = [];
  mockModule('../lib/emailService', {
    send: async (opts) => { sent.push(opts); return { ok: true, gmailMessageId: 'msg-' + sent.length }; },
  });

  const p = require.resolve('../lib/crmActivityNotifier');
  delete require.cache[p];
  const mod = require('../lib/crmActivityNotifier');
  return { mod, sent };
}

test('ACTION_CATEGORIES maps every ACTION_LABELS action to a real notificationPreferences category', () => {
  const { mod } = freshCrmActivityNotifier();
  const prefs = require('../lib/notificationPreferences');
  const validCategories = new Set(Object.values(prefs.CATEGORIES));
  for (const action of Object.keys(mod.ACTION_LABELS)) {
    const category = mod.ACTION_CATEGORIES[action];
    assert.ok(category, `action "${action}" has no entry in ACTION_CATEGORIES`);
    assert.ok(validCategories.has(category), `action "${action}" maps to unknown category "${category}"`);
  }
});

test('lead_created (NEW_LEAD) is delivered to Michelle', async () => {
  const { mod, sent } = freshCrmActivityNotifier();
  const result = await mod.notifyCrmActivity({ action: 'lead_created', leadId: 'l1', leadName: 'Jane Doe' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(sent.length, 1);
  const allRecipients = [sent[0].to, ...(sent[0].cc || [])].map((e) => e.toLowerCase());
  assert.ok(allRecipients.includes('michelle@ecconstructiongroup.com'), 'Michelle must receive the new-lead activity notification');
});

const NON_NEW_LEAD_ACTIONS = [
  'lead_updated', 'lead_status_changed', 'contact_info_changed', 'activity_added',
  'appointment_created', 'appointment_rescheduled', 'appointment_cancelled',
  'deal_created', 'deal_updated', 'deal_stage_changed', 'attachment_added', 'estimate_synced',
];

for (const action of NON_NEW_LEAD_ACTIONS) {
  test(`${action} is NEVER delivered to Michelle (to or cc)`, async () => {
    const { mod, sent } = freshCrmActivityNotifier();
    const result = await mod.notifyCrmActivity({ action, leadId: 'l1', leadName: 'Jane Doe' });
    assert.strictEqual(result.ok, true, `expected ${action} to send (to Yaron) — got ${result.error}`);
    assert.strictEqual(sent.length, 1);
    const allRecipients = [sent[0].to, ...(sent[0].cc || [])].map((e) => String(e).toLowerCase());
    assert.ok(!allRecipients.includes('michelle@ecconstructiongroup.com'), `${action} must never reach Michelle`);
    assert.ok(allRecipients.includes('yaron@ecconstructiongroup.com'), `${action} must still reach the other configured staff recipient`);
  });
}

test('an unrecognized action falls back to a non-NEW_LEAD category (never defaults Michelle back in)', async () => {
  const { mod, sent } = freshCrmActivityNotifier();
  const result = await mod.notifyCrmActivity({ action: 'some_future_action', leadId: 'l1', leadName: 'Jane Doe' });
  assert.strictEqual(result.ok, true);
  const allRecipients = [sent[0].to, ...(sent[0].cc || [])].map((e) => String(e).toLowerCase());
  assert.ok(!allRecipients.includes('michelle@ecconstructiongroup.com'));
});

test('no recipient configured at all -> no_recipient_configured, never throws', async () => {
  const { mod } = freshCrmActivityNotifier({ filterImpl: () => [] });
  const result = await mod.notifyCrmActivity({ action: 'lead_updated', leadId: 'l1', leadName: 'Jane Doe' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'no_recipient_configured');
});
