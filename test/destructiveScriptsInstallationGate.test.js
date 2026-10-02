/* eslint-disable no-undef */
'use strict';

/**
 * destructiveScriptsInstallationGate.test.js — PRODUCTIZATION / backup-
 * restore safety. scripts/auditAppointmentFollowUp.js already required
 * --confirm-host before any --apply/--revert/--promote write. Two other
 * destructive scripts (gated by a bare APPLY=1 env var) had no equivalent
 * safety check at all: scripts/revertLegacyPhoneCallConversion.js and
 * scripts/auditPhoneCallCalendarArtifacts.js. Under the productized
 * single-tenant-per-deployment model (every company has its own database),
 * a script written/tested against one installation must not be able to run
 * destructively against another by accident. Both now call
 * lib/installationIdentity.js#requireInstallationConfirmation before any
 * APPLY=1 write path runs.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

for (const file of ['revertLegacyPhoneCallConversion.js', 'auditPhoneCallCalendarArtifacts.js']) {
  test(`scripts/${file} requires installation confirmation before any APPLY=1 write`, () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', file), 'utf8');
    assert.match(src, /require\(['"]\.\.\/lib\/installationIdentity['"]\)/, 'must import lib/installationIdentity');
    assert.match(src, /if \(apply\) await requireInstallationConfirmation\(process\.argv\.slice\(2\)\);/,
      'must call requireInstallationConfirmation before proceeding when apply is true');
  });
}
