'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path');
const gmailRoute = fs.readFileSync(path.join(__dirname,'..','routes','gmail.js'),'utf8');
test('gmail read routes use the server-side gmailSender (no browser token path)', () => {
  assert.ok(/require\(['"]\.\.\/lib\/gmailSender['"]\)/.test(gmailRoute), 'must require server-side gmailSender');
});
test('gmail read routes never return raw access/refresh tokens to the browser', () => {
  assert.ok(!/res\(.*access_token|res\(.*refresh_token|\.send\(.*refreshToken/i.test(gmailRoute), 'token leakage pattern found');
});
