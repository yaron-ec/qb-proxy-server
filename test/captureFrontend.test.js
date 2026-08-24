/* eslint-disable no-undef */
/**
 * captureFrontend.test.js — static check that /capture no longer makes runtime
 * calls to Base44 checkCalendarConflicts or submitLeadCapture. Greps the
 * LeadCapture page + capture client source for forbidden tokens.
 *
 * Run: node src/proxy-server/test/captureFrontend.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

let failed = 0;
function assert(cond, msg) {
  if (!cond) { failed++; console.log(`  ✗ ${msg}`); }
  else console.log(`  ✓ ${msg}`);
}

const capturePage = fs.readFileSync(
  path.join(__dirname, '..', '..', 'pages', 'LeadCapture.jsx'), 'utf8'
);
const captureClient = fs.readFileSync(
  path.join(__dirname, '..', '..', 'lib', 'captureRailwayClient.js'), 'utf8'
);

// M: no runtime calls to Base44 from the capture flow — zero Base44 dependency.
assert(!/checkCalendarConflicts/.test(capturePage), 'LeadCapture.jsx has no checkCalendarConflicts reference');
assert(!/submitLeadCapture/.test(capturePage), 'LeadCapture.jsx has no submitLeadCapture reference');
assert(!/base44\.functions\.invoke/.test(capturePage), 'LeadCapture.jsx has no base44.functions.invoke calls');
assert(!/from\s+["']@\/api\/base44Client["']/.test(capturePage), 'LeadCapture.jsx has no base44 SDK import');
assert(!/base44\.entities/.test(capturePage), 'LeadCapture.jsx has no base44 entity reads');
assert(!/base44\.auth/.test(capturePage), 'LeadCapture.jsx has no base44 auth calls');
assert(!/Settings\.filter/.test(capturePage), 'LeadCapture.jsx has no Base44 Settings config read');

// The capture client must call the Railway public endpoints.
assert(/\/api\/public\/capture\/availability/.test(captureClient), 'captureRailwayClient calls GET /api/public/capture/availability');
assert(/\/api\/public\/capture/.test(captureClient), 'captureRailwayClient calls POST /api/public/capture');
assert(!/X-Proxy-Secret/.test(captureClient), 'capture client sends no proxy secret (public endpoint)');

// CaptureSlotGrid still preserved.
const slotGrid = fs.readFileSync(
  path.join(__dirname, '..', '..', 'components', 'CaptureSlotGrid.jsx'), 'utf8'
);
assert(/blockedSlots/.test(slotGrid), 'CaptureSlotGrid.jsx preserved (uses blockedSlots prop)');

if (failed > 0) { console.error(`\nFAIL: ${failed} assertion(s)`); process.exit(1); }
console.log('\nPASS: frontend /capture has no Base44 runtime calls (checkCalendarConflicts, submitLeadCapture)');
process.exit(0);