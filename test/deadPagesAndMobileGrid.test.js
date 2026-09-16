/* eslint-disable no-undef */
'use strict';

/**
 * deadPagesAndMobileGrid.test.js — regression guard for two further findings
 * during the CRM-wide visual/UX pass, beyond the initial /automations,
 * /estimates, /my-day route audit:
 *
 * 1. A full cross-check of every file in crm-frontend/src/pages/ against
 *    App.jsx's imports found FIVE more completely unreferenced page files:
 *      - pages/Leads.jsx (superseded by the routed pages/LeadsModern.jsx)
 *      - pages/Estimates.jsx (superseded by the already-removed
 *        EstimatesModern.jsx/HandoffEstimatesPanel — same broken-endpoint
 *        pattern as that removal)
 *      - pages/NonLeadsReview.jsx (no replacement found — genuinely
 *        abandoned, zero references anywhere)
 *      - pages/OAuthConsent.jsx — confirmed Base44-era dead code: calls
 *        `/api/apps/${appParams.appId}/mcp/consent-info`, a Base44 platform
 *        endpoint with no Railway backend equivalent. Violates the Base44
 *        prohibition even setting aside being unreferenced.
 *      - components/AuthLayout.jsx — used exclusively by the removed
 *        OAuthConsent.jsx (Login.jsx, the real auth screen, does not use it).
 *    All five removed after confirming zero import references anywhere in
 *    src/ and no React.lazy()/dynamic-import reference.
 *
 *    NOT removed: 11 further unreferenced page files (Contacts, DNQLeads,
 *    DealsDataDiagnostic, DuplicateFinder, HandoffReview, LeadBreakdown,
 *    ManagementDashboard, OverdueLeads, PermissionDiagnostics, ProjectDetail,
 *    Projects, ProjectsModern, QBExecutiveDashboard, RepDashboard,
 *    SalesRepScoreboard, ValidationReport) — unlike the five removed above,
 *    these call REAL, working Railway API endpoints (/api/v1/leads,
 *    /api/v1/deals, /api/v1/handoff-estimates, /api/v1/auth/me). They are
 *    functional, not broken — likely real product features that were built
 *    and never wired into navigation. Deciding which to adopt, merge with
 *    an existing page, or intentionally archive requires a product decision
 *    beyond a visual/UX pass's authority (see the pass's own final report).
 *    This test only guards that they still exist (not silently deleted by
 *    a future change without that decision being made).
 *
 * 2. pages/Integrations.jsx had a `grid-cols-5` sync-stats row with no
 *    responsive breakpoint — five columns on a phone-width screen. Fixed to
 *    `grid-cols-3 sm:grid-cols-5`.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const frontendSrc = path.resolve(__dirname, '..', 'crm-frontend', 'src');

test('the five confirmed-dead/Base44 page files are removed', () => {
  for (const rel of [
    'pages/Leads.jsx',
    'pages/Estimates.jsx',
    'pages/NonLeadsReview.jsx',
    'pages/OAuthConsent.jsx',
    'components/AuthLayout.jsx',
  ]) {
    assert.ok(!fs.existsSync(path.join(frontendSrc, rel)), rel + ' must be removed');
  }
});

test('the 16 unreferenced-but-functional pages found during the audit still exist (not silently deleted without a product decision)', () => {
  const pending = [
    'Contacts', 'DNQLeads', 'DealsDataDiagnostic', 'DuplicateFinder', 'HandoffReview',
    'LeadBreakdown', 'ManagementDashboard', 'OverdueLeads', 'PermissionDiagnostics',
    'ProjectDetail', 'Projects', 'ProjectsModern', 'QBExecutiveDashboard', 'RepDashboard',
    'SalesRepScoreboard', 'ValidationReport',
  ];
  for (const name of pending) {
    assert.ok(fs.existsSync(path.join(frontendSrc, 'pages', `${name}.jsx`)), `pages/${name}.jsx should still exist pending a product decision`);
  }
});

test('no source file imports any of the five removed files', () => {
  function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.(jsx?|mjs)$/.test(entry.name)) out.push(full);
    }
    return out;
  }
  const removedNames = ['Leads', 'Estimates', 'NonLeadsReview', 'OAuthConsent', 'AuthLayout'];
  const offenders = [];
  for (const file of walk(frontendSrc)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const name of removedNames) {
      const re = new RegExp(`from\\s+["'][^"']*/${name}["']`);
      if (re.test(src)) offenders.push(`${path.relative(frontendSrc, file)} -> ${name}`);
    }
  }
  assert.deepStrictEqual(offenders, []);
});

test('Integrations.jsx sync-stats grid has a mobile-safe column count', () => {
  const src = fs.readFileSync(path.join(frontendSrc, 'pages', 'Integrations.jsx'), 'utf8');
  assert.ok(src.includes('grid-cols-3 sm:grid-cols-5'), 'expected the 5-stat grid to collapse to 3 columns below sm breakpoint');
  assert.ok(!/className="grid grid-cols-5 gap-2"/.test(src), 'must not have a bare grid-cols-5 with no responsive breakpoint');
});
