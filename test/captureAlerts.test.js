/* eslint-disable no-undef */
'use strict';

/**
 * captureAlerts.test.js — lib/captureAlerts.js#sendNewLeadAlert, the New
 * Lead notification email. This file previously had ZERO test coverage,
 * which is exactly how the November 2026 production incident shipped
 * undetected: when CRM_PUBLIC_URL was unset in production, the "Open Lead
 * in CRM" button in this email opened http:///leads/<id> — scheme present,
 * host EMPTY — because the lead link was built from a caller-supplied
 * `crmPublicUrl` argument with no fallback of its own. Fixed by building
 * the link exclusively through lib/crmUrl.js (always a valid absolute URL)
 * regardless of CRM_PUBLIC_URL's presence or correctness.
 */
const test = require('node:test');
const assert = require('node:assert');

function stub(modPath, exportsObj) {
  const p = require.resolve(modPath);
  const prev = require.cache[p];
  delete require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
  return () => { if (prev) require.cache[p] = prev; else delete require.cache[p]; };
}

function freshCaptureAlerts() {
  delete require.cache[require.resolve('../lib/captureAlerts')];
  delete require.cache[require.resolve('../lib/crmUrl')];
  return require('../lib/captureAlerts');
}

const LEAD = { id: '774d31bd-1134-4319-8298-5810dbe196a5', first_name: 'Jane', last_name: 'Doe', city: 'Los Angeles', created_at: '2026-11-01T00:00:00Z' };

function setupStubs({ sentTo = [], recipients = ['yaron@ecconstructiongroup.com'] } = {}) {
  const restoreEmail = stub('../lib/emailService', {
    send: async ({ to, htmlBody, subject }) => { sentTo.push({ to, htmlBody, subject }); return { ok: true, gmailMessageId: 'm1' }; },
  });
  const restoreRecipients = stub('../lib/notificationRecipients', { getAllStaffRecipients: async () => recipients });
  const restorePrefs = stub('../lib/notificationPreferences', {
    CATEGORIES: { NEW_LEAD: 'new_lead' },
    filterRecipientsForCategory: async (list) => list,
  });
  const restoreCompanyConfig = stub('../lib/companyConfig', { getTimezone: async () => 'America/Los_Angeles' });
  return () => { restoreEmail(); restoreRecipients(); restorePrefs(); restoreCompanyConfig(); };
}

test('sendNewLeadAlert: CRM_PUBLIC_URL unset in production -> the email still contains a valid absolute HTTPS lead link, never a relative path', async () => {
  delete process.env.CRM_PUBLIC_URL;
  const sentTo = [];
  const restoreStubs = setupStubs({ sentTo });
  const captureAlerts = freshCaptureAlerts();
  try {
    await captureAlerts.sendNewLeadAlert(LEAD);
    assert.strictEqual(sentTo.length, 1);
    const { htmlBody } = sentTo[0];
    assert.match(htmlBody, /href="https:\/\/crm\.ecconstructiongroup\.com\/leads\/774d31bd-1134-4319-8298-5810dbe196a5"/);
    // The exact reported production incident shape must never appear.
    assert.doesNotMatch(htmlBody, /href="http:\/\/\//);
    assert.doesNotMatch(htmlBody, /href="\/leads\//, 'must never be a bare relative path');
  } finally { restoreStubs(); }
});

test('sendNewLeadAlert: a deprecated second argument (the old unsafe caller-supplied crmPublicUrl) is ignored entirely', async () => {
  delete process.env.CRM_PUBLIC_URL;
  const sentTo = [];
  const restoreStubs = setupStubs({ sentTo });
  const captureAlerts = freshCaptureAlerts();
  try {
    // Exactly the old call shape (routes/websiteLeads.js etc. used to pass
    // '' here) — must have zero effect now.
    await captureAlerts.sendNewLeadAlert(LEAD, '');
    assert.match(sentTo[0].htmlBody, /href="https:\/\/crm\.ecconstructiongroup\.com\/leads\//);
  } finally { restoreStubs(); }
});

test('sendNewLeadAlert: CRM_PUBLIC_URL correctly configured -> that host is used', async () => {
  process.env.CRM_PUBLIC_URL = 'https://crm.ecconstructiongroup.com';
  const sentTo = [];
  const restoreStubs = setupStubs({ sentTo });
  const captureAlerts = freshCaptureAlerts();
  try {
    await captureAlerts.sendNewLeadAlert(LEAD);
    assert.match(sentTo[0].htmlBody, /href="https:\/\/crm\.ecconstructiongroup\.com\/leads\/774d31bd-1134-4319-8298-5810dbe196a5"/);
  } finally { restoreStubs(); delete process.env.CRM_PUBLIC_URL; }
});

test('sendNewLeadAlert: no lead or no lead.id -> no-op, never sends an email with a broken/empty link', async () => {
  const sentTo = [];
  const restoreStubs = setupStubs({ sentTo });
  const captureAlerts = freshCaptureAlerts();
  try {
    await captureAlerts.sendNewLeadAlert(null);
    await captureAlerts.sendNewLeadAlert({ first_name: 'No Id' });
    assert.strictEqual(sentTo.length, 0);
  } finally { restoreStubs(); }
});
