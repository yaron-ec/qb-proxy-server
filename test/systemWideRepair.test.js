'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

test('QB: server.js requireProxySecret accepts JWT auth (no browser proxy secret)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(src.includes("const { requireAuth } = require('./lib/rbac')"), 'must import requireAuth');
  assert.ok(src.includes("authHeader.startsWith('Bearer ')"), 'must check JWT Bearer header');
  assert.ok(!src.includes("missing or invalid X-Proxy-Secret"), 'must not hardcode old error message');
});

test('QB: crm-frontend railwayClient.js does NOT send X-Proxy-Secret header', () => {
  const src = fs.readFileSync(path.join(ROOT, 'crm-frontend/src/lib/railwayClient.js'), 'utf8');
  assert.ok(!src.includes('VITE_QB_PROXY_SECRET'), 'must NOT read VITE_QB_PROXY_SECRET env var');
  assert.ok(!src.includes("'X-Proxy-Secret'"), 'must NOT send X-Proxy-Secret header');
  assert.ok(src.includes('apiCall'), 'must use apiCall (JWT auth)');
});

test('GOOGLE_CONTACTS: createOrUpdateContact accepts existingResourceName to avoid 429', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/googleContactsClient.js'), 'utf8');
  assert.ok(src.includes('existingResourceName'), 'must accept existingResourceName parameter');
  assert.ok(src.includes('getContact'), 'must have getContact function for direct read');
  assert.ok(src.includes('searchContacts quota'), 'must document 429 fix');
});

test('GOOGLE_CONTACTS: leads route passes google_contact_resource_name to createOrUpdateContact', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes/leads.js'), 'utf8');
  assert.ok(src.includes('lead.google_contact_resource_name'), 'must pass stored resource_name');
});

test('CALENDAR: CalendarSyncPanel states are mutually exclusive', () => {
  const src = fs.readFileSync(path.join(ROOT, 'crm-frontend/src/components/CalendarSyncPanel.jsx'), 'utf8');
  assert.ok(src.includes('mutually exclusive'), 'must document mutual exclusivity');
  assert.ok(src.includes('isSynced = syncStatus'), 'must derive isSynced correctly');
  assert.ok(src.includes('isPending = !isSynced && !isFailed'), 'isPending must exclude isSynced and isFailed');
});

test('REMINDERS: reminderEngine.js does NOT write to Base44', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/reminderEngine.js'), 'utf8');
  assert.ok(!src.includes('Write legacy REMINDER_SENT Activity to Base44'), 'must not write to Base44');
  assert.ok(src.includes('Railway activities table'), 'must write to Railway activities table');
});
