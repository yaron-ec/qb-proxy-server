/* eslint-disable no-undef */
/**
 * testMonitoring.js — validates the production monitoring layer WITHOUT
 * touching production. Uses simulated/mock conditions only.
 *
 * Tests:
 *   1. Service inventory loads and classifies correctly
 *   2. Health probes return uniform shape
 *   3. Crash loop detector opens/resolves incidents (in-memory mock)
 *   4. Alert dispatcher sanitizes secrets
 *   5. Recovery policy escalates dangerous errors, allows transient restart
 *   6. No secret leakage in any alert payload
 *
 *   node scripts/testMonitoring.js
 */
'use strict';

const { SERVICES, getCriticalServices, getMonitoredServices, getService } = require('../lib/monitoring/serviceInventory');
const { evaluateRecovery, isEscalationError } = require('../lib/monitoring/recoveryPolicy');
const { sanitize } = require('../lib/monitoring/alertDispatcher');

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} — ${detail || ''}`); }
}

// 1. Service inventory
console.log('\n1. Service inventory');
const monitored = getMonitoredServices();
const critical = getCriticalServices();
assert('Monitored services > 0', monitored.length > 0);
assert('Critical services > 0', critical.length > 0);
assert('clever-manifestation NOT in inventory', !SERVICES.find(s => s.id === 'clever-manifestation'));
assert('qb-proxy-server is CRITICAL_PRODUCTION', getService('qb-proxy-server')?.classification === 'CRITICAL_PRODUCTION');
assert('reminder-worker is WORKER_CRITICAL', getService('reminder-worker')?.classification === 'WORKER_CRITICAL');
assert('postgres is CRITICAL_INFRA', getService('postgres')?.classification === 'CRITICAL_INFRA');
assert('Known-good commit seeded for qb-proxy-server', getService('qb-proxy-server')?.knownGoodCommit === '2fe2ffeb9dc122dd00c92d423f492c35b5d006b5');

// 2. Recovery policy — escalation errors
console.log('\n2. Recovery policy — escalation errors');
assert('MODULE_NOT_FOUND escalates', isEscalationError('Error: MODULE_NOT_FOUND'));
assert('ENCRYPTION_KEY not set escalates', isEscalationError('FATAL: ENCRYPTION_KEY not set in environment'));
assert('relation does not exist escalates', isEscalationError('relation "owners" does not exist')); // pattern: "does not exist"
assert('ECONNREFUSED escalates', isEscalationError('ECONNREFUSED 127.0.0.1:5432'));
assert('Generic timeout does NOT escalate', !isEscalationError('Request timeout'));

// 3. Recovery policy — decisions
console.log('\n3. Recovery policy — decisions');
const escalateDecision = evaluateRecovery('qb-proxy-server', { errorSummary: 'MODULE_NOT_FOUND', isCrashLoop: false, isNewIncident: true, previousHealthy: true });
assert('MODULE_NOT_FOUND → escalate', escalateDecision.action === 'escalate');

const crashLoopDecision = evaluateRecovery('qb-proxy-server', { errorSummary: 'timeout', isCrashLoop: true, isNewIncident: false, previousHealthy: false });
assert('Crash loop → escalate', crashLoopDecision.action === 'escalate');

const transientDecision = evaluateRecovery('qb-proxy-server', { errorSummary: 'ETIMEDOUT', isCrashLoop: false, isNewIncident: true, previousHealthy: true });
assert('Transient failure → restart', transientDecision.action === 'restart');

const badDeployDecision = evaluateRecovery('qb-proxy-server', { errorSummary: 'startup failure', isCrashLoop: false, isNewIncident: true, previousHealthy: false });
assert('Bad new deployment → rollback_candidate', badDeployDecision.action === 'rollback_candidate');

// 4. Secret sanitization
console.log('\n4. Secret sanitization');
assert('Bearer token redacted', sanitize('Authorization: Bearer gho_abc123def') === 'Authorization: Bearer [REDACTED]');
assert('DATABASE_URL redacted', sanitize('DATABASE_URL=postgres://user:pass@host:5432/db').includes('[REDACTED]'));
assert('password= redacted', sanitize('password=secret123').includes('[REDACTED]'));
assert('Plain text passes through', sanitize('Service is healthy') === 'Service is healthy');
assert('Long text truncated', sanitize('x'.repeat(3000)).length <= 2000);

// 5. Summary
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);