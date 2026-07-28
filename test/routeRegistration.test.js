'use strict';
/**
 * Static route-registration test — asserts server.js source contains every
 * required production route group. Does NOT start the server (no listen, no
 * DB, no deps). Run: npm test
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const REQUIRED_MARKERS = [
  '/health',
  '/auth/connect', '/auth/status', '/auth/callback', '/auth/disconnect',
  '/company',
  '/customers',
  '/estimates',
  '/invoices',
  '/qb/health',
  '/api/files',
  '/api/v1/auth',
  '/api/v1/emails',
  '/api/v1/gmail',
  '/reminders'
];

test('server.js registers all required production route groups', () => {
  const missing = REQUIRED_MARKERS.filter(m => !src.includes(m));
  assert.deepEqual(missing, [], `server.js missing route markers: ${missing.join(', ')}`);
});

test('server.js mounts routes/auth, routes/emails, routes/gmail', () => {
  assert.ok(/require\(['"]\.\/routes\/auth['"]\)/.test(src), 'routes/auth not mounted');
  assert.ok(/require\(['"]\.\/routes\/emails['"]\)/.test(src), 'routes/emails not mounted');
  assert.ok(/require\(['"]\.\/routes\/gmail['"]\)/.test(src), 'routes/gmail not mounted');
});
