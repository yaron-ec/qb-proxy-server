/* eslint-disable no-undef */
'use strict';

/**
 * estimateFollowupEligibility.test.js — pure unit coverage (no DB) for
 * lib/estimateFollowupEligibility.js, the one place eligibility for the
 * automated 14-day estimate follow-up sequence is decided. db/client is
 * stubbed with a routed fake queryFn so every branch (lead status, email
 * validity, suppression, competing sequence, estimate status) can be
 * driven directly without a live Postgres.
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

function freshModule() {
  delete require.cache[require.resolve('../lib/estimateFollowupEligibility')];
  return require('../lib/estimateFollowupEligibility');
}

const DEFAULT_LEAD = {
  id: 'lead-1', first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com',
  status: 'Appointment scheduled', owner_id: 'owner-1', customer_reminders_disabled: false, project_type: 'Roofing',
};
const DEFAULT_ESTIMATE = { id: 'est-1', lead_id: 'lead-1', estimate_status: 'Pending', qb_estimate_id: 'QBE-1', customer_email: 'jane@example.com' };

function makeDb({ lead = DEFAULT_LEAD, estimate = DEFAULT_ESTIMATE, suppressed = false, liveSequences = [], liveSequencesForEstimate = [] } = {}) {
  return {
    query: async (sql, params) => {
      if (/FROM leads WHERE id = \$1/.test(sql)) return { rows: lead ? [lead] : [] };
      if (/FROM estimate_followup_suppressions/.test(sql)) return { rows: suppressed ? [{ x: 1 }] : [] };
      if (/FROM estimate_followup_sequences\s+WHERE qb_estimate_id/.test(sql)) return { rows: liveSequencesForEstimate.map((id) => ({ id })) };
      if (/FROM estimate_followup_sequences\s+WHERE lead_id/.test(sql)) return { rows: liveSequences.map((id) => ({ id })) };
      if (/FROM handoff_estimates WHERE id = \$1/.test(sql)) return { rows: estimate ? [estimate] : [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test('isValidEmail: accepts a normal address, rejects missing/malformed ones', () => {
  const restore = stub('../db/client', makeDb());
  try {
    const m = freshModule();
    assert.strictEqual(m.isValidEmail('jane@example.com'), true);
    assert.strictEqual(m.isValidEmail(''), false);
    assert.strictEqual(m.isValidEmail(null), false);
    assert.strictEqual(m.isValidEmail('not-an-email'), false);
    assert.strictEqual(m.isValidEmail('missing@tld'), false);
  } finally { restore(); }
});

test('DISQUALIFYING_LEAD_STATUSES includes every TERMINAL_LOST_STATUSES value plus Sold', () => {
  const restore = stub('../db/client', makeDb());
  try {
    const m = freshModule();
    const { TERMINAL_LOST_STATUSES } = require('../lib/leadStatus');
    for (const s of TERMINAL_LOST_STATUSES) assert.ok(m.DISQUALIFYING_LEAD_STATUSES.has(s), `missing ${s}`);
    assert.ok(m.DISQUALIFYING_LEAD_STATUSES.has('Sold'));
  } finally { restore(); }
});

test('checkEligibilityForEnrollment: eligible lead + Pending estimate -> eligible, zero reasons', async () => {
  const restore = stub('../db/client', makeDb());
  try {
    const m = freshModule();
    const result = await m.checkEligibilityForEnrollment({ leadId: 'lead-1', handoffEstimateId: 'est-1' });
    assert.strictEqual(result.eligible, true);
    assert.deepStrictEqual(result.reasons, []);
  } finally { restore(); }
});

test('checkEligibilityForEnrollment: lead not found -> not eligible, single reason, null lead/estimate', async () => {
  const restore = stub('../db/client', makeDb({ lead: null }));
  try {
    const m = freshModule();
    const result = await m.checkEligibilityForEnrollment({ leadId: 'nope', handoffEstimateId: 'est-1' });
    assert.strictEqual(result.eligible, false);
    assert.deepStrictEqual(result.reasons, ['lead_not_found']);
    assert.strictEqual(result.lead, null);
  } finally { restore(); }
});

for (const status of ['Lost', 'Closed Lost', 'DNQ', 'Cancelled', 'Sold']) {
  test(`checkEligibilityForEnrollment: disqualifying lead status "${status}" is rejected`, async () => {
    const restore = stub('../db/client', makeDb({ lead: { ...DEFAULT_LEAD, status } }));
    try {
      const m = freshModule();
      const result = await m.checkEligibilityForEnrollment({ leadId: 'lead-1', handoffEstimateId: 'est-1' });
      assert.strictEqual(result.eligible, false);
      assert.ok(result.reasons.some((r) => r.startsWith('lead_status_disqualifying')), JSON.stringify(result.reasons));
    } finally { restore(); }
  });
}

test('checkEligibilityForEnrollment: invalid/missing email is rejected', async () => {
  const restore = stub('../db/client', makeDb({ lead: { ...DEFAULT_LEAD, email: null } }));
  try {
    const m = freshModule();
    const result = await m.checkEligibilityForEnrollment({ leadId: 'lead-1', handoffEstimateId: 'est-1' });
    assert.strictEqual(result.eligible, false);
    assert.ok(result.reasons.includes('lead_email_invalid_or_missing'));
  } finally { restore(); }
});

test('checkEligibilityForEnrollment: customer_reminders_disabled is rejected', async () => {
  const restore = stub('../db/client', makeDb({ lead: { ...DEFAULT_LEAD, customer_reminders_disabled: true } }));
  try {
    const m = freshModule();
    const result = await m.checkEligibilityForEnrollment({ leadId: 'lead-1', handoffEstimateId: 'est-1' });
    assert.strictEqual(result.eligible, false);
    assert.ok(result.reasons.includes('customer_reminders_disabled'));
  } finally { restore(); }
});

test('checkEligibilityForEnrollment: a suppressed (unsubscribed) email is rejected even with every other field valid', async () => {
  const restore = stub('../db/client', makeDb({ suppressed: true }));
  try {
    const m = freshModule();
    const result = await m.checkEligibilityForEnrollment({ leadId: 'lead-1', handoffEstimateId: 'est-1' });
    assert.strictEqual(result.eligible, false);
    assert.ok(result.reasons.includes('email_suppressed_unsubscribed'));
  } finally { restore(); }
});

test('checkEligibilityForEnrollment: a competing active/paused sequence on the same lead is rejected', async () => {
  const restore = stub('../db/client', makeDb({ liveSequences: ['other-seq'] }));
  try {
    const m = freshModule();
    const result = await m.checkEligibilityForEnrollment({ leadId: 'lead-1', handoffEstimateId: 'est-1' });
    assert.strictEqual(result.eligible, false);
    assert.ok(result.reasons.includes('competing_sequence_already_active'));
  } finally { restore(); }
});

test('hasLiveSequenceForEstimate: returns false for a null/undefined qb_estimate_id without querying', async () => {
  const restore = stub('../db/client', { query: async () => { throw new Error('must not query when qb_estimate_id is falsy'); } });
  try {
    const m = freshModule();
    assert.strictEqual(await m.hasLiveSequenceForEstimate(null), false);
    assert.strictEqual(await m.hasLiveSequenceForEstimate(undefined), false);
  } finally { restore(); }
});

test('checkEligibilityForEnrollment: a DIFFERENT lead\'s live sequence for the SAME real qb_estimate_id is rejected (HNDF-EST-10260 cross-lead fix)', async () => {
  const restore = stub('../db/client', makeDb({ liveSequencesForEstimate: ['some-other-sequence-on-a-different-lead'] }));
  try {
    const m = freshModule();
    const result = await m.checkEligibilityForEnrollment({ leadId: 'lead-1', handoffEstimateId: 'est-1' });
    assert.strictEqual(result.eligible, false);
    assert.ok(result.reasons.includes('competing_sequence_for_same_estimate'), JSON.stringify(result.reasons));
  } finally { restore(); }
});

test('checkEligibilityForEnrollment: no estimate specified at all is rejected', async () => {
  const restore = stub('../db/client', makeDb());
  try {
    const m = freshModule();
    const result = await m.checkEligibilityForEnrollment({ leadId: 'lead-1', handoffEstimateId: null });
    assert.strictEqual(result.eligible, false);
    assert.ok(result.reasons.includes('no_estimate_specified'));
  } finally { restore(); }
});

test('checkEligibilityForEnrollment: estimate not found is rejected', async () => {
  const restore = stub('../db/client', makeDb({ estimate: null }));
  try {
    const m = freshModule();
    const result = await m.checkEligibilityForEnrollment({ leadId: 'lead-1', handoffEstimateId: 'ghost' });
    assert.strictEqual(result.eligible, false);
    assert.ok(result.reasons.includes('estimate_not_found'));
  } finally { restore(); }
});

test('checkEligibilityForEnrollment: estimate linked to a DIFFERENT lead is rejected (never silently re-attributed)', async () => {
  const restore = stub('../db/client', makeDb({ estimate: { ...DEFAULT_ESTIMATE, lead_id: 'some-other-lead' } }));
  try {
    const m = freshModule();
    const result = await m.checkEligibilityForEnrollment({ leadId: 'lead-1', handoffEstimateId: 'est-1' });
    assert.strictEqual(result.eligible, false);
    assert.ok(result.reasons.includes('estimate_not_linked_to_this_lead'));
  } finally { restore(); }
});

for (const status of ['Accepted', 'Closed', 'Rejected', 'Voided']) {
  test(`checkEligibilityForEnrollment: estimate status "${status}" (not Pending) is rejected`, async () => {
    const restore = stub('../db/client', makeDb({ estimate: { ...DEFAULT_ESTIMATE, estimate_status: status } }));
    try {
      const m = freshModule();
      const result = await m.checkEligibilityForEnrollment({ leadId: 'lead-1', handoffEstimateId: 'est-1' });
      assert.strictEqual(result.eligible, false);
      assert.ok(result.reasons.some((r) => r === `estimate_not_pending:${status}`));
    } finally { restore(); }
  });
}

test('checkEligibilityForEnrollment: multiple simultaneous disqualifications are ALL reported, not just the first', async () => {
  const restore = stub('../db/client', makeDb({ lead: { ...DEFAULT_LEAD, status: 'Lost', email: null } }));
  try {
    const m = freshModule();
    const result = await m.checkEligibilityForEnrollment({ leadId: 'lead-1', handoffEstimateId: 'est-1' });
    assert.strictEqual(result.eligible, false);
    assert.ok(result.reasons.some((r) => r.startsWith('lead_status_disqualifying')));
    assert.ok(result.reasons.includes('lead_email_invalid_or_missing'));
  } finally { restore(); }
});

// ── checkEligibilityForSend — the fresh re-check before every send ────────
test('checkEligibilityForSend: eligible sequence -> eligible:true, reason:null, lead attached', async () => {
  const restore = stub('../db/client', makeDb());
  try {
    const m = freshModule();
    const result = await m.checkEligibilityForSend({ lead_id: 'lead-1', handoff_estimate_id: 'est-1' });
    assert.strictEqual(result.eligible, true);
    assert.strictEqual(result.reason, null);
    assert.strictEqual(result.lead.id, 'lead-1');
  } finally { restore(); }
});

test('checkEligibilityForSend: lead not found', async () => {
  const restore = stub('../db/client', makeDb({ lead: null }));
  try {
    const m = freshModule();
    const result = await m.checkEligibilityForSend({ lead_id: 'gone', handoff_estimate_id: 'est-1' });
    assert.strictEqual(result.eligible, false);
    assert.strictEqual(result.reason, 'lead_not_found');
  } finally { restore(); }
});

test('checkEligibilityForSend: lead became terminal-lost since enrollment -> stop reason surfaced', async () => {
  const restore = stub('../db/client', makeDb({ lead: { ...DEFAULT_LEAD, status: 'Sold' } }));
  try {
    const m = freshModule();
    const result = await m.checkEligibilityForSend({ lead_id: 'lead-1', handoff_estimate_id: 'est-1' });
    assert.strictEqual(result.eligible, false);
    assert.match(result.reason, /^lead_status_disqualifying:Sold$/);
  } finally { restore(); }
});

test('checkEligibilityForSend: estimate no longer Pending (accepted/voided/declined since enrollment) -> stopped', async () => {
  const restore = stub('../db/client', makeDb({ estimate: { ...DEFAULT_ESTIMATE, estimate_status: 'Accepted' } }));
  try {
    const m = freshModule();
    const result = await m.checkEligibilityForSend({ lead_id: 'lead-1', handoff_estimate_id: 'est-1' });
    assert.strictEqual(result.eligible, false);
    assert.strictEqual(result.reason, 'estimate_not_pending:Accepted');
  } finally { restore(); }
});

test('checkEligibilityForSend: sequence with no handoff_estimate_id at all is never eligible', async () => {
  const restore = stub('../db/client', makeDb());
  try {
    const m = freshModule();
    const result = await m.checkEligibilityForSend({ lead_id: 'lead-1', handoff_estimate_id: null });
    assert.strictEqual(result.eligible, false);
    assert.strictEqual(result.reason, 'estimate_not_found');
  } finally { restore(); }
});

test('checkEligibilityForSend: email suppressed since enrollment -> stopped', async () => {
  const restore = stub('../db/client', makeDb({ suppressed: true }));
  try {
    const m = freshModule();
    const result = await m.checkEligibilityForSend({ lead_id: 'lead-1', handoff_estimate_id: 'est-1' });
    assert.strictEqual(result.eligible, false);
    assert.strictEqual(result.reason, 'email_suppressed_unsubscribed');
  } finally { restore(); }
});
