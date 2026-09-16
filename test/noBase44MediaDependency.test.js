/* eslint-disable no-undef */
/**
 * noBase44MediaDependency.test.js — regression guard.
 *
 * Root cause found while repairing this repo's test infrastructure: three
 * files still referenced a live media.base44.com URL as the logo image for
 * customer-facing content, despite Base44 being fully retired everywhere
 * else in the production request path:
 *
 *   - lib/reminderEmails.js  — appointment reminder emails sent to real
 *     customers (LOGO_URL hardcoded to media.base44.com/images/public/...)
 *   - lib/reminderPages.js   — the customer-facing confirm/reschedule action
 *     pages those emails link to (same hardcoded URL)
 *   - lib/actionRouter.js    — the CSP header serving those pages allowlisted
 *     img-src https://media.base44.com specifically to permit that URL
 *
 * If Base44's media hosting is ever fully decommissioned, every reminder
 * email (past and future) and action page would show a broken image. Fixed
 * to serve the logo from the CRM's own public origin
 * (${CRM_PUBLIC_URL}/email-logo.png), matching the pattern already used
 * correctly by lib/emailTemplates.js.
 *
 * This test is a permanent guard against the same class of regression —
 * any new hardcoded base44.com/base44.app URL in a production lib/routes
 * file, or a stale CSP allowlist entry for it, should fail this test.
 */
'use strict';

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function readFile(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('lib/reminderEmails.js logo URL is not a Base44 media URL', () => {
  const src = readFile('lib/reminderEmails.js');
  // Check the executable assignment specifically (not the substring, which
  // legitimately appears in this file's own explanatory comment above it).
  assert.ok(!/LOGO_URL\s*=\s*['"]https?:\/\/media\.base44\.com/.test(src), 'LOGO_URL must not be assigned a live media.base44.com URL');
  assert.ok(/LOGO_URL\s*=\s*`\$\{CRM_PUBLIC_URL\}\/email-logo\.png`/.test(src), 'LOGO_URL must be derived from CRM_PUBLIC_URL');
});

test('lib/reminderPages.js logo URL is not a Base44 media URL', () => {
  const src = readFile('lib/reminderPages.js');
  assert.ok(!/LOGO_URL\s*=\s*['"]https?:\/\/media\.base44\.com/.test(src), 'LOGO_URL must not be assigned a live media.base44.com URL');
  assert.ok(/LOGO_URL\s*=\s*`\$\{CRM_PUBLIC_URL\}\/email-logo\.png`/.test(src), 'LOGO_URL must be derived from CRM_PUBLIC_URL');
});

test('lib/actionRouter.js CSP img-src does not allowlist Base44', () => {
  const src = readFile('lib/actionRouter.js');
  assert.ok(!/img-src https:\/\/media\.base44\.com/.test(src), 'CSP img-src must not allowlist media.base44.com');
  assert.ok(/img-src \$\{CRM_PUBLIC_ORIGIN\}/.test(src), 'CSP img-src must allow the CRM\'s own public origin');
});

test('repo-wide: no executable file references a live base44.com/base44.app URL', () => {
  // Scan lib/, routes/, and the frontend source for any executable (non-
  // comment-only) reference. This is a coarse heuristic — it flags the
  // literal domain string anywhere in these trees; comments explaining
  // history (like this file's own header) are expected to mention the
  // string and are not themselves a violation, so this check only fails on
  // an ACTUAL URL pattern (https://...base44...) rather than the bare word.
  const dirs = ['lib', 'routes'];
  const offenders = [];
  for (const dir of dirs) {
    const full = path.join(ROOT, dir);
    for (const file of fs.readdirSync(full)) {
      if (!file.endsWith('.js')) continue;
      const filePath = path.join(full, file);
      const src = fs.readFileSync(filePath, 'utf8');
      const matches = src.match(/https?:\/\/[a-zA-Z0-9.-]*base44\.(com|app)[^\s'"`]*/g) || [];
      for (const m of matches) {
        // Allow the string only inside a line that is itself a comment
        // explaining the removal (contains "Previously" or "must not" or
        // starts with // or * after trimming) — everything else is a live
        // reference and fails.
        const lineStart = src.lastIndexOf('\n', src.indexOf(m)) + 1;
        const lineEnd = src.indexOf('\n', src.indexOf(m));
        const line = src.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
        const isExplanatoryComment = /^(\/\/|\*)/.test(line) && /(previously|removed|must not|stale)/i.test(line);
        if (!isExplanatoryComment) offenders.push(`${dir}/${file}: ${m}`);
      }
    }
  }
  assert.strictEqual(offenders.length, 0, `Found live base44.com/base44.app URL reference(s):\n${offenders.join('\n')}`);
});
