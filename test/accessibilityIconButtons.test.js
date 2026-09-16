/* eslint-disable no-undef */
'use strict';

/**
 * accessibilityIconButtons.test.js — regression guard for the code-level
 * accessibility pass performed during the CRM-wide visual/UX design pass.
 *
 * FINDING: a scan for <button> elements rendering only a lucide icon (no
 * visible text) found 12 such buttons across the app with no aria-label —
 * a screen reader announces these as unlabeled "button", giving no
 * indication of what they do (close, cancel, clear search, remove item).
 * All 12 were fixed with a contextually specific aria-label. This test
 * guards each one plus the dead pages/LeadDetail.jsx removal found during
 * the same pass (a legacy, fully unreferenced duplicate of the routed
 * pages/LeadDetailModern.jsx — 1082 lines of dead weight).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const frontendSrc = path.resolve(__dirname, '..', 'crm-frontend', 'src');

function readFile(rel) {
  return fs.readFileSync(path.join(frontendSrc, rel), 'utf8');
}

const FIXED_ICON_BUTTONS = [
  ['components/UnmatchedEstimatesPanel.jsx', 'onClick={() => setSelectedLead(null)} aria-label="Close"'],
  ['components/FollowUpScheduler.jsx', 'onClick={() => setEditing(false)} aria-label="Cancel edit"'],
  ['components/properties/PropertyDetailPanel.jsx', 'onClick={onClose} aria-label="Close"'],
  ['components/properties/PropertyModal.jsx', 'onClick={onClose} aria-label="Close"'],
  ['components/UsersTab.jsx', 'onClick={onClose} aria-label="Close"'],
  ['components/UnsyncedLeadsPanel.jsx', "onClick={() => setSearch('')} aria-label=\"Clear search\""],
  ['pages/Settings.jsx', 'onClick={() => removeStatus(status)} aria-label={`Remove ${status}`}'],
  ['pages/Settings.jsx', 'onClick={() => removeProjectType(type)} aria-label={`Remove ${type}`}'],
  ['pages/Settings.jsx', 'onClick={() => removeSource(source)} aria-label={`Remove ${source}`}'],
  ['pages/Settings.jsx', 'onClick={() => removeContactOwner(owner)} aria-label={`Remove ${owner}`}'],
  ['pages/LeadCapture.jsx', 'onClick={() => removeFile(i)} aria-label="Remove file"'],
];

for (const [file, snippet] of FIXED_ICON_BUTTONS) {
  test(`${file}: icon-only button has an aria-label (${snippet.slice(0, 50)}...)`, () => {
    const src = readFile(file);
    assert.ok(src.includes(snippet), `expected to find: ${snippet}`);
  });
}

test('financials modals: the bare "✕" close buttons have aria-label="Close"', () => {
  for (const file of ['components/financials/CommissionSection.jsx', 'components/financials/LoanPaymentsSection.jsx', 'components/financials/ExpensesSection.jsx']) {
    const src = readFile(file);
    const matches = src.match(/<button onClick=\{onClose\}[^>]*>✕<\/button>/g) || [];
    assert.ok(matches.length > 0, file + ': expected at least one ✕ close button');
    for (const m of matches) {
      assert.ok(m.includes('aria-label="Close"'), file + ': ' + m + ' is missing aria-label');
    }
  }
});

test('the dead legacy pages/LeadDetail.jsx (unreferenced duplicate of LeadDetailModern.jsx) is removed', () => {
  assert.ok(!fs.existsSync(path.join(frontendSrc, 'pages', 'LeadDetail.jsx')));
  assert.ok(fs.existsSync(path.join(frontendSrc, 'pages', 'LeadDetailModern.jsx')), 'the real, routed page must still exist');
});

test('no source file still imports the removed pages/LeadDetail.jsx', () => {
  function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.(jsx?|mjs)$/.test(entry.name)) out.push(full);
    }
    return out;
  }
  const offenders = [];
  for (const file of walk(frontendSrc)) {
    const src = fs.readFileSync(file, 'utf8');
    if (/from\s+["'][^"']*\/LeadDetail["']/.test(src)) offenders.push(path.relative(frontendSrc, file));
  }
  assert.deepStrictEqual(offenders, []);
});
