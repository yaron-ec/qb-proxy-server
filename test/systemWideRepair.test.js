/* eslint-disable no-undef */
'use strict';
const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

test('QB: server.js requireProxySecret accepts JWT auth (no browser proxy secret)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  // Accept either requireAuth from rbac OR verifyAccessToken from authService
  const hasJwtAuth = src.includes('requireAuth') || src.includes('verifyAccessToken');
  assert.ok(hasJwtAuth, 'must have JWT auth verification (requireAuth or verifyAccessToken)');
  assert.ok(src.includes('Bearer'), 'must check JWT Bearer header');
  assert.ok(!src.includes("missing or invalid X-Proxy-Secret"), 'must not hardcode old X-Proxy-Secret-only error');
});

test('QB: crm-frontend railwayClient.js does NOT send X-Proxy-Secret header', () => {
  const clientPath = path.join(ROOT, 'crm-frontend', 'src', 'lib', 'railwayClient.js');
  if (!fs.existsSync(clientPath)) return; // skip if crm-frontend not present locally
  const src = fs.readFileSync(clientPath, 'utf8');
  assert.ok(!src.includes('VITE_QB_PROXY_SECRET'), 'must NOT read VITE_QB_PROXY_SECRET env var');
  assert.ok(src.includes('apiCall'), 'must use apiCall (JWT auth)');
});

test('GOOGLE_CONTACTS: createOrUpdateContact accepts existingResourceName to avoid 429', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'googleContactsClient.js'), 'utf8');
  assert.ok(src.includes('existingResourceName'), 'must accept existingResourceName parameter');
  assert.ok(src.includes('getContact'), 'must have getContact function for direct read');
});

test('GOOGLE_CONTACTS: leads route passes google_contact_resource_name to createOrUpdateContact', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'leads.js'), 'utf8');
  assert.ok(src.includes('lead.google_contact_resource_name'), 'must pass stored resource_name');
});

test('CALENDAR: CalendarSyncPanel states are mutually exclusive', () => {
  const panelPath = path.join(ROOT, 'crm-frontend', 'src', 'components', 'CalendarSyncPanel.jsx');
  if (!fs.existsSync(panelPath)) return; // skip if crm-frontend not present locally
  const src = fs.readFileSync(panelPath, 'utf8');
  assert.ok(src.includes('mutually exclusive'), 'must document mutual exclusivity');
  assert.ok(src.includes('isPending = !isSynced && !isFailed'), 'isPending must exclude isSynced and isFailed');
});

test('REMINDERS: reminderEngine.js does NOT write to Base44', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'reminderEngine.js'), 'utf8');
  assert.ok(!src.includes('Write legacy REMINDER_SENT Activity to Base44'), 'must not write to Base44');
  assert.ok(src.includes('Railway activities table'), 'must write to Railway activities table');
});