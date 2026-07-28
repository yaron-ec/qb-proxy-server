'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path');
const src = fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
const MAIN_MARKERS = ['/health','/auth/connect','/auth/status','/auth/callback','/auth/disconnect','/company','/customers','/customers/search','/estimates','/estimates/:id/pdf','/invoices','/invoices/:id/pdf','/qb/health','/api/files','/remind','/sync/qb-estimates','/sync/qb-estimate-pdfs','/internal/email/send','/diag/base44-config','/diag/base44-gateway','/diag/sdk-test','/api/v1/auth','/api/v1/emails'];
test('every main route group is preserved in server.js', () => {
  const missing = MAIN_MARKERS.filter(m => !src.includes(m));
  assert.deepEqual(missing, [], 'main routes missing: '+missing.join(', '));
});
test('POST /remind is preserved', () => { assert.ok(/app\.post\(['"]\/remind['"]/.test(src), 'POST /remind removed'); });
test('/diag/* diagnostic routes are preserved', () => { assert.ok(src.includes('/diag/'), '/diag/* removed'); });
test('only the approved new gmail read route is added', () => { assert.ok(src.includes('/api/v1/gmail'), 'gmail read mount missing'); });
test('no calendar/signnow/handoff/contacts/lead-capture routes were added', () => {
  for (const bad of ['/calendar','/signnow','/handoff','/contacts','/leads/submit-capture']) {
    assert.ok(!src.includes(bad), 'unrelated route added: '+bad);
  }
});
