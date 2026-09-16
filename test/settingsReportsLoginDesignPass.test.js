/* eslint-disable no-undef */
'use strict';

/**
 * settingsReportsLoginDesignPass.test.js — regression coverage for Reports,
 * Settings, Login, and the named mobile-table fixes made during the
 * page-level design pass.
 *
 * Reports.jsx: the error state was bare red text with no icon or retry
 * button (inconsistent with LeadsModern.jsx's error state) — fixed to match.
 * StatCard values now use tabular-nums for aligned digits. Three of four
 * data tables (Sales by Rep, Leads by Source, Project Type breakdown) had
 * no overflow-x-auto wrapper — fixed; the fourth (Leads by Owner) already
 * had one.
 *
 * Settings.jsx: the mobile dropdown nav was a single flat list of every
 * settings page, while the desktop sidebar was already grouped into
 * product areas (General, Integrations, CRM Configuration, Notifications,
 * E-Signature, Call Center, Admin Tools, Account) — the desktop grouping
 * was already good; the mobile nav just didn't match it. Fixed to group
 * identically.
 *
 * Login.jsx: replaced a generic Lock icon with the actual company logo
 * asset (same one used in the app sidebar), so the login screen carries
 * the same brand identity as the product itself.
 *
 * AppointmentReminderPanel.jsx's <table style="..."> is an HTML EMAIL body
 * template string, not rendered React UI — correctly left untouched (this
 * test explicitly documents why it was excluded from the table-mobile
 * sweep, so a future pass doesn't "fix" it into a broken JSX table).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const frontendSrc = path.resolve(__dirname, '..', 'crm-frontend', 'src');

function read(rel) {
  return fs.readFileSync(path.join(frontendSrc, rel), 'utf8');
}

test('Reports.jsx: error state has an icon, message, and retry button (not bare text)', () => {
  const src = read('pages/Reports.jsx');
  assert.ok(src.includes('Could not load reports'));
  assert.ok(src.includes('onClick={load}'), 'retry must call the same load function');
  assert.ok(src.includes('<AlertCircle'));
});

test('Reports.jsx: StatCard values use tabular-nums', () => {
  const src = read('pages/Reports.jsx');
  assert.ok(src.includes('text-2xl font-black text-slate-900 tabular-nums'));
});

test('Reports.jsx: all four data tables are wrapped for horizontal scroll on mobile', () => {
  const src = read('pages/Reports.jsx');
  const overflowWraps = (src.match(/overflow-x-auto/g) || []).length;
  assert.ok(overflowWraps >= 4, `expected at least 4 overflow-x-auto wrappers, found ${overflowWraps}`);
});

test('OwnerDirectoryTab.jsx: table is wrapped for horizontal scroll on mobile', () => {
  const src = read('components/OwnerDirectoryTab.jsx');
  assert.ok(src.includes('<div className="overflow-x-auto">'));
});

test('AppointmentReminderPanel.jsx: the email-template table is untouched (not a UI table)', () => {
  const src = read('components/AppointmentReminderPanel.jsx');
  assert.ok(src.includes('const body = `<html>'), 'must still be an HTML email template string');
  assert.ok(src.includes('<table style="background:#f4f6fa'), 'the raw email HTML table markup must be unchanged');
});

test('Settings.jsx: mobile dropdown nav is grouped identically to the desktop sidebar', () => {
  const src = read('pages/Settings.jsx');
  const mobileNavSection = src.slice(src.indexOf('Mobile dropdown nav'), src.indexOf('Main layout: sidebar'));
  assert.ok(mobileNavSection.includes('NAV_SECTIONS.filter'), 'mobile nav must iterate NAV_SECTIONS by group, not a flat list');
  assert.ok(mobileNavSection.includes('{group}'), 'mobile nav must render group headers');
});

test('Login.jsx: uses the real company logo asset instead of a generic lock icon', () => {
  const src = read('pages/Login.jsx');
  assert.ok(src.includes('src="/logo-dark.jpg"'), 'must use the same brand asset as the app sidebar');
  assert.ok(!src.includes('Lock'), 'the generic Lock icon import/usage must be removed');
});
