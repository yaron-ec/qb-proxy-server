/* eslint-disable no-undef */
'use strict';

/**
 * notificationPreferenceCoverage.test.js — structural guard (CRM STABILITY
 * PHASE, completion pass, Section C3): "Add a structural guard that
 * prevents new staff notification call sites from bypassing the
 * preference layer unnoticed."
 *
 * lib/notificationRecipients.js#getAllStaffRecipients() returns this
 * installation's flat staff broadcast list. Every live request/worker-path
 * file that calls it must ALSO call
 * lib/notificationPreferences.js#filterRecipientsForCategory() somewhere in
 * the same file — i.e. it must narrow the broadcast by a category before
 * using it — unless the file is in the narrow, documented EXCEPTIONS set
 * below (a single-recipient "whoever owns this" notification, e.g.
 * getPrimaryRecipient(), is not a broadcast and is out of scope entirely;
 * it never calls getAllStaffRecipients() to begin with, so it is never
 * caught by this guard).
 *
 * This is a per-FILE heuristic, not a per-call-site proof — it cannot see
 * whether a *specific* getAllStaffRecipients() call within a file with
 * multiple call sites is the one that got filtered. That is an accepted,
 * documented limitation: its job is to catch a brand new file adding an
 * unfiltered broadcast call that nobody reviewed, not to re-prove every
 * line of already-reviewed files one more time.
 *
 * Skipped without TEST_DATABASE_URL is NOT required — this is pure static
 * source analysis, no DB needed.
 */
const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Files that are allowed to call getAllStaffRecipients() without ever
// calling filterRecipientsForCategory() in the same file, with the
// specific, reviewed reason documented inline at each call site too.
const EXCEPTIONS = new Set([
  // lib/notificationRecipients.js itself (defines getAllStaffRecipients,
  // does not call it) and lib/notificationPreferences.js (defines the
  // filter, only referenced in a comment) are structurally exempt — they
  // are the two ends of the mechanism this guard checks, not a call site.
  'lib/notificationRecipients.js',
  'lib/notificationPreferences.js',
]);

function walk(rel, out) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) return;
  for (const ent of fs.readdirSync(full, { withFileTypes: true })) {
    const r = path.join(rel, ent.name);
    if (ent.isDirectory()) {
      if (['node_modules', 'dist', '.git'].includes(ent.name)) continue;
      walk(r, out);
      continue;
    }
    if (ent.name.endsWith('.js')) out.push(r);
  }
}

test('every file calling getAllStaffRecipients() also narrows via filterRecipientsForCategory()', () => {
  const files = [];
  ['lib', 'routes'].forEach((d) => walk(d, files));
  files.push('server.js', 'reminderWorker.js');

  const offenders = [];
  for (const rel of files) {
    const norm = rel.split(path.sep).join('/');
    if (EXCEPTIONS.has(norm)) continue;
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) continue;
    const src = fs.readFileSync(full, 'utf8');
    const callsBroadcast = /getAllStaffRecipients\s*\(/.test(src);
    const callsFilter = /filterRecipientsForCategory\s*\(/.test(src);
    if (callsBroadcast && !callsFilter) offenders.push(norm);
  }

  assert.deepStrictEqual(
    offenders,
    [],
    `File(s) call getAllStaffRecipients() (a staff broadcast) without ever narrowing via notificationPreferences.filterRecipientsForCategory() in the same file: ${offenders.join(', ')}. ` +
    `Either wire it through a CATEGORIES.* value, or — if it is genuinely not a per-category business notification (e.g. a single manually-triggered admin diagnostic) — add it to this test's EXCEPTIONS set with a documented reason.`
  );
});
