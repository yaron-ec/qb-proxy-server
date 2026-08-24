/* eslint-disable no-undef */
/**
 * transportControl — server-authoritative email transport selection.
 *
 * Railway is the SOLE email transport. Base44 is fully decommissioned.
 * The transport resolution is retained for configuration granularity
 * (per-flow overrides) but always resolves to 'railway'.
 *
 * Resolution order per flow:
 *   1. EMAIL_<FLOW>_TRANSPORT  (per-flow override, ignored — railway only)
 *   2. EMAIL_TRANSPORT         (global, ignored — railway only)
 *   3. 'railway'               (the only valid transport)
 */
'use strict';

const FLOWS = [
  'GENERIC',
  'INVOICE',
  'MANUAL_REMINDER',
  'SCHEDULED_REMINDER',
  'STATUS_NOTIFICATION',
  'ACTIVITY_NOTIFICATION',
  'NEW_LEAD_NOTIFICATION',
  'PHONE_CALL_REMINDER',
  'TASK_REMINDER',
];

/**
 * Resolve the transport for a single flow at request time.
 * Always returns 'railway' — Base44 is fully decommissioned.
 * @param {string} flow - one of FLOWS
 * @returns {'railway'}
 */
function flowTransport(flow) {
  return 'railway';
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