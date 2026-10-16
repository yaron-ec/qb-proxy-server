/* eslint-disable no-undef */
'use strict';

/**
 * cronJobsNotifyCrmActivityCategoryFilter.test.js — structural guard:
 * POST /api/v1/cron/notify-crm-activity (routes/cronJobs.js) previously
 * built its recipient list from the raw, unfiltered
 * notificationRecipients.getRecipients() — bypassing
 * lib/notificationPreferences.js entirely (and the
 * test/notificationPreferenceCoverage.test.js guard, which only catches
 * getAllStaffRecipients() callers). It must now narrow through
 * filterRecipientsForCategory(ACTIVITY), consistent with every other staff
 * broadcast in this codebase.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'cronJobs.js'), 'utf8');

test('notify-crm-activity no longer builds its recipient list from the raw, unfiltered getRecipients()', () => {
  const routeStart = SRC.indexOf("router.post('/notify-crm-activity'");
  const routeEnd = SRC.indexOf("router.post('/notify-status-change'");
  assert.ok(routeStart > -1 && routeEnd > routeStart);
  const routeSrc = SRC.slice(routeStart, routeEnd);
  assert.ok(!/notificationRecipients\.getRecipients\(\)/.test(routeSrc), 'must not use the unfiltered getRecipients() directly for this broadcast');
  assert.ok(/getAllStaffRecipients\(\)/.test(routeSrc), 'must build the broadcast candidate list from getAllStaffRecipients()');
  assert.ok(/filterRecipientsForCategory/.test(routeSrc), 'must narrow the broadcast via filterRecipientsForCategory');
  assert.ok(/CATEGORIES\.ACTIVITY/.test(routeSrc), 'must use the ACTIVITY category');
});
