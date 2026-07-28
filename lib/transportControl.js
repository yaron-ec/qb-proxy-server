/* eslint-disable no-undef */
/**
 * transportControl — server-authoritative email transport selection.
 *
 * The authoritative transport switch lives HERE (Railway env), not in a
 * frontend build-time flag. Every email request reads the runtime setting
 * at request time; changing it requires no application code change.
 *
 * Resolution order per flow:
 *   1. EMAIL_<FLOW>_TRANSPORT  (per-flow override)
 *   2. EMAIL_TRANSPORT         (global default)
 *   3. 'base44'                (safe default — preserves current behavior)
 *
 * Valid values: 'base44' | 'railway'. Anything else falls back to 'base44'.
 *
 * 'base44' is TEMPORARY migration-compatibility only. The final architecture
 * is complete Base44 disconnection; once a flow is verified on Railway its
 * per-flow flag is set to 'railway' and never moved back.
 *
 * Rules enforced by callers (Approach A — NO browser delegation):
 *   - One logical action invokes exactly ONE transport. Never both.
 *   - In 'base44' mode the Railway route does NOT send and returns 421
 *     Misdirected; the browser calls the existing Base44 function DIRECTLY
 *     (per FLOW_OWNERSHIP in src/lib/emailTransport.js). The browser never
 *     receives `delegate:true` and never performs a Base44 call because
 *     Railway told it to. No duplicate send is possible.
 *   - In 'railway' mode the Railway route sends via EmailService and NEVER
 *     falls back to Base44 on failure.
 *   - Each decision is logged (secret-free).
 */
'use strict';

const VALID = new Set(['base44', 'railway']);

const FLOWS = [
  'GENERIC',
  'INVOICE',
  'MANUAL_REMINDER',
  'SCHEDULED_REMINDER',
  'STATUS_NOTIFICATION',
  'ACTIVITY_NOTIFICATION',
  'NEW_LEAD_NOTIFICATION',
];

function normalize(v) {
  return String(v || '').toLowerCase().trim();
}

/**
 * Resolve the transport for a single flow at request time.
 * @param {string} flow - one of FLOWS
 * @returns {'base44'|'railway'}
 */
function flowTransport(flow) {
  const global = normalize(process.env.EMAIL_TRANSPORT);
  const perFlow = normalize(process.env[`EMAIL_${flow}_TRANSPORT`]);
  const resolved = VALID.has(perFlow) ? perFlow : (VALID.has(global) ? global : 'base44');
  return resolved;
}

/**
 * Log a transport decision (secret-free). Never logs tokens, recipients'
 * PII beyond what the caller passes, or credential material.
 */
function logDecision(flow, transport, user, extra) {
  try {
    console.log(JSON.stringify({
      event: 'transport_decision',
      flow,
      transport,
      user_email: user && user.email ? user.email : null,
      user_role: user && user.role ? user.role : null,
      ts: new Date().toISOString(),
      ...(extra || {}),
    }));
  } catch (_) { /* never let logging throw */ }
}

module.exports = { flowTransport, logDecision, FLOWS };