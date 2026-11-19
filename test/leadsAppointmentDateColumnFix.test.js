/* eslint-disable no-undef */
'use strict';

/**
 * leadsAppointmentDateColumnFix.test.js — November 2026 P0 outage follow-up,
 * item 6 ("Fix the separate leads.appointment_date schema mismatch").
 *
 * Root cause (confirmed directly in production Postgres logs during the
 * outage window, reproduced via direct code read — not guessed):
 * server.js#runQbEstimateSyncInner's matched/newly-imported-estimate branch
 * built `leadUpdate.appointment_date = ...` and passed it to
 * `rda.update('Lead', matchedLead.id, leadUpdate)` — but `leads` has no
 * `appointment_date` column (that concept lives on `appointments`, or on
 * `reminder_leads` as a projection lib/reminderProjection.js maintains
 * independently). Every such call failed with "column \"appointment_date\"
 * of relation \"leads\" does not exist" and was silently swallowed by a
 * bare `.catch(() => {})`, for every matched/newly-imported QB estimate,
 * always — this was never a transient, outage-specific failure.
 *
 * source-level, since server.js has top-level side effects and isn't
 * directly requirable in a unit test (same convention already used by
 * test/qbEstimateSyncManualMatch.test.js / test/qbGetCompanyWiring.test.js).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

function serverSource() {
  return fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
}

test('runQbEstimateSyncInner never again builds leadUpdate.appointment_date (the exact invalid column)', () => {
  const src = serverSource();
  assert.doesNotMatch(src, /leadUpdate\.appointment_date/, 'leadUpdate must never reference appointment_date — leads has no such column');
});

test('the follow_up_date backfill (a real leads column) is unchanged and still present', () => {
  const src = serverSource();
  assert.match(src, /if \(qbEst\.TxnDate && !matchedLead\.follow_up_date\) leadUpdate\.follow_up_date = toDateStr\(qbEst\.TxnDate\);/, 'the valid follow_up_date backfill must survive the fix unchanged');
});

test('the surrounding rda.update(\'Lead\', ...) call site for this backfill is unchanged otherwise (still conditional, still swallows its own error)', () => {
  const src = serverSource();
  const idx = src.indexOf('const leadUpdate = {};');
  assert.ok(idx > -1, 'the leadUpdate block must still exist');
  const snippet = src.slice(idx, idx + 400);
  assert.match(snippet, /if \(Object\.keys\(leadUpdate\)\.length > 0\) \{/);
  assert.match(snippet, /await rda\.update\('Lead', matchedLead\.id, leadUpdate\)\.catch\(\(\) => \{\}\);/);
});
